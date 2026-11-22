// DadBuddy: a small web app for the home network.
// - HTTPS on HTTPS_PORT (default 443) with a home certificate (see certs.js), so phones can
//   install it and use it offline; HTTP on PORT (default 80) for the phone setup page
// - SQLite storage in ./data/baby.db (node:sqlite, no native deps)
// - Offline-first sync: phones keep their own copy and push/pull changes when they're home
// - mDNS responder so devices on the LAN can open baby.local
// - Server-sent events so every open phone pulls changes when someone logs something
// - Reminders (feeds, nappy checks, Mum's medicines, vitamin D) as encrypted Web Push notifications

import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import makeMdns from 'multicast-dns';
import { ensureCerts } from './certs.js';
import { isPushEndpoint, loadVapid, sendPush, unb64u } from './push.js';
import { cleanPrefs, dueReminders } from './reminders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 80);
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? 443); // 0 turns HTTPS off
const MDNS_HOST = `${(process.env.MDNS_NAME || 'baby').toLowerCase()}.local`;
const PC_HOST = `${os.hostname().toLowerCase()}.local`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const PUSH_DIR = path.join(DATA_DIR, 'push');
// Push services ask senders for a contact (RFC 8292). The project page, never anyone's email.
const PUSH_CONTACT = process.env.PUSH_CONTACT || 'https://github.com/gokulrajanpillai/DadBuddy';
const PUSH_TEST_ENDPOINT = process.env.PUSH_TEST_ENDPOINT || ''; // tests only: a local fake push service
const REMINDER_EVERY_MS = Number(process.env.REMINDER_EVERY_MS || 30_000);

// Rules shared with the phones (public/*.js), loaded into this process.
function loadShared(file) {
  const mod = { exports: {} };
  new Function('module', readFileSync(path.join(PUBLIC_DIR, file), 'utf8'))(mod);
  return mod.exports;
}
const R = loadShared('rules.js');
const MEDS = loadShared('meds.js');
const GUIDANCE = loadShared('guidance.js');

// ---------------------------------------------------------------- database

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'baby.db'));
db.exec('PRAGMA journal_mode = WAL;');

const EVENTS_DDL = `
  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT    NOT NULL,          -- feed | nappy | sleep | temp | weight | vitd | med
    subtype    TEXT    NOT NULL,
    start_at   INTEGER NOT NULL,          -- epoch ms
    end_at     INTEGER,                   -- epoch ms; NULL on a breastfeed/sleep = timer running
    amount_ml  INTEGER,                   -- expressed / formula feeds
    value      REAL,                      -- temperature (C) or weight (kg)
    poo        TEXT,                      -- poo colour on dirty nappies
    pee        TEXT,                      -- 'dark' when pee was dark yellow / brown
    note       TEXT,
    by         TEXT    NOT NULL CHECK (by IN ('mum','dad')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasEvents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (!hasEvents) {
    db.exec(EVENTS_DDL);
  } else if (version < 2) {
    // v1 -> v2: 'diaper' becomes 'nappy', 'bottle' becomes 'expressed', new columns.
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE events RENAME TO events_v1');
      db.exec(EVENTS_DDL);
      db.exec(`INSERT INTO events (id, kind, subtype, start_at, end_at, amount_ml, note, by, created_at, updated_at)
               SELECT id,
                      CASE kind WHEN 'diaper' THEN 'nappy' ELSE kind END,
                      CASE subtype WHEN 'bottle' THEN 'expressed' ELSE subtype END,
                      start_at, end_at, amount_ml, note, by, created_at, updated_at
               FROM events_v1`);
      db.exec('DROP TABLE events_v1');
      db.exec('COMMIT');
      console.log('Migrated database to v2');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const backup = () => {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const file = path.join(DATA_DIR, 'backups', `baby-v${version}-${stamp}.db`);
    mkdirSync(path.dirname(file), { recursive: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`Backed up database to ${file}`);
  };
  if (version < 3) {
    // v2 -> v3, for offline sync: uid = id made on the phone, rev = change counter,
    // deleted_at = tombstone so the other phone hears about deletions.
    if (hasEvents) backup();
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE events ADD COLUMN uid TEXT');
      db.exec('ALTER TABLE events ADD COLUMN rev INTEGER');
      db.exec('ALTER TABLE events ADD COLUMN deleted_at INTEGER');
      const set = db.prepare('UPDATE events SET uid = ?, rev = id WHERE id = ?');
      for (const { id } of db.prepare('SELECT id FROM events').all()) set.run(randomUUID(), id);
      db.exec('COMMIT');
      if (hasEvents) console.log('Migrated database to v3');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  if (version < 4) {
    // v3 -> v4: Mum's medicines. A dose is an event (kind 'med') pointing at its medicine.
    if (hasEvents && version >= 3) backup();
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE events ADD COLUMN med TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS meds (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        dose       TEXT NOT NULL DEFAULT '',
        schedule   TEXT NOT NULL CHECK (schedule IN ('gap','times')),
        every_h    REAL,                       -- gap: hours to leave between doses
        max_day    INTEGER,                    -- most doses in any 24 hours
        times      TEXT NOT NULL DEFAULT '[]', -- times: JSON list of "HH:MM"
        remind     INTEGER NOT NULL DEFAULT 0,
        active     INTEGER NOT NULL DEFAULT 1, -- stopped medicines stay, so old doses keep their name
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
      db.exec('COMMIT');
      if (hasEvents) console.log('Migrated database to v4');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uid ON events (uid)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_rev ON events (rev)');
  // Phones that want reminders, and which reminders each has already been sent.
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    who        TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    prefs      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE TABLE IF NOT EXISTS push_sent (endpoint TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (endpoint, key))');
  db.exec('PRAGMA user_version = 4');
}
migrate();

const { WHO, FIELDS, MAX_TIMER_H } = R;
const UID_RE = /^[A-Za-z0-9-]{8,64}$/;

const q = {
  byUid: db.prepare('SELECT * FROM events WHERE uid = ?'),
  since: db.prepare('SELECT * FROM events WHERE rev > ? ORDER BY rev LIMIT ?'),
  maxRev: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM events'),
  live: db.prepare('SELECT * FROM events WHERE deleted_at IS NULL ORDER BY start_at'),
  running: db.prepare(`SELECT * FROM events WHERE deleted_at IS NULL AND end_at IS NULL
                        AND ((kind = 'feed' AND subtype IN ('left','right')) OR kind = 'sleep') ORDER BY start_at`),
  insert: db.prepare(`INSERT INTO events (uid, kind, subtype, start_at, end_at, amount_ml, value, poo, pee, note, med, by, created_at, updated_at, rev)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  update: db.prepare(`UPDATE events SET kind = ?, subtype = ?, start_at = ?, end_at = ?, amount_ml = ?, value = ?, poo = ?, pee = ?,
                      note = ?, med = ?, updated_at = ?, rev = ? WHERE uid = ?`),
  meds: db.prepare('SELECT * FROM meds ORDER BY active DESC, created_at'),
  recent: db.prepare('SELECT * FROM events WHERE deleted_at IS NULL AND start_at > ? ORDER BY start_at'),
  subs: db.prepare('SELECT * FROM push_subs'),
  subByEndpoint: db.prepare('SELECT * FROM push_subs WHERE endpoint = ?'),
  subUpsert: db.prepare(`INSERT INTO push_subs (endpoint, who, p256dh, auth, prefs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(endpoint) DO UPDATE SET who = excluded.who, p256dh = excluded.p256dh, auth = excluded.auth,
                         prefs = excluded.prefs, updated_at = excluded.updated_at`),
  subDelete: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  sentHas: db.prepare('SELECT 1 FROM push_sent WHERE endpoint = ? AND key = ?'),
  sentAdd: db.prepare('INSERT OR IGNORE INTO push_sent (endpoint, key, at) VALUES (?, ?, ?)'),
  sentPrune: db.prepare('DELETE FROM push_sent WHERE at < ?'),
  medById: db.prepare('SELECT * FROM meds WHERE id = ?'),
  medInsert: db.prepare(`INSERT INTO meds (id, name, dose, schedule, every_h, max_day, times, remind, active, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  medUpdate: db.prepare(`UPDATE meds SET name = ?, dose = ?, schedule = ?, every_h = ?, max_day = ?, times = ?, remind = ?, active = ?,
                         updated_at = ? WHERE id = ?`),
  endTimer: db.prepare('UPDATE events SET end_at = ?, updated_at = ?, rev = ? WHERE uid = ?'),
  tombstone: db.prepare('UPDATE events SET deleted_at = ?, updated_at = ?, rev = ? WHERE uid = ?'),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
};
const nextRev = () => q.maxRev.get().rev + 1;

function profile() {
  const get = (k) => q.getSetting.get(k)?.value ?? null;
  const bw = get('birth_weight_kg');
  return { babyName: get('baby_name') ?? 'Baby', dob: get('dob'), birthWeightKg: bw == null ? null : Number(bw) };
}

function meds() {
  return q.meds.all().map((m) => ({ ...m, times: JSON.parse(m.times), remind: !!m.remind, active: !!m.active }));
}

// What phones see: everything but the internal row id.
const toClient = ({ id, ...row }) => (void id, row);
const fieldsOf = (row) => Object.fromEntries(FIELDS.map((k) => [k, row[k]]));

// ---------------------------------------------------------------- sync

// Apply one change from a phone. Ops are idempotent (replaying one is harmless) and
// last-write-wins by the phone's updated_at. A deleted uid stays deleted.
function applyOp(op, who, now) {
  const uid = op && typeof op.uid === 'string' && UID_RE.test(op.uid) ? op.uid : null;
  if (!uid) return { uid: typeof op?.uid === 'string' ? op.uid : null, ok: false, error: 'Missing or invalid uid' };
  const stamp = Number.isSafeInteger(op.updated_at) && op.updated_at > 0 ? Math.min(op.updated_at, now) : now;
  const existing = q.byUid.get(uid);

  if (op.op === 'delete') {
    if (existing && !existing.deleted_at) {
      q.tombstone.run(now, stamp, nextRev(), uid);
      return { uid, ok: true, changed: true };
    }
    return { uid, ok: true };
  }

  if (op.op !== 'upsert') return { uid, ok: false, error: 'op must be upsert or delete' };
  if (existing?.deleted_at) return { uid, ok: true, ignored: 'deleted' };
  if (existing && existing.updated_at >= stamp) return { uid, ok: true, ignored: 'stale' }; // older, or a replay

  const e = R.normalise(R.pick(op, existing ? fieldsOf(existing) : { start_at: now, end_at: null }));
  const err = R.validateEvent(e, now);
  if (err) return { uid, ok: false, error: err, current: existing ? toClient(existing) : null };

  if (existing) {
    q.update.run(e.kind, e.subtype, e.start_at, e.end_at, e.amount_ml, e.value, e.poo, e.pee, e.note, e.med, stamp, nextRev(), uid);
  } else {
    const by = WHO.includes(op.by) ? op.by : who;
    const created = Number.isSafeInteger(op.created_at) && op.created_at > 0 ? Math.min(op.created_at, now) : stamp;
    q.insert.run(uid, e.kind, e.subtype, e.start_at, e.end_at, e.amount_ml, e.value, e.poo, e.pee, e.note, e.med, by, created, stamp, nextRev());
  }
  return { uid, ok: true, changed: true };
}

// Two phones can start a feed or a sleep while apart. Only one timer can really be running
// (in the app, starting one ends the other), so keep the newest and end each older one
// when the next one started.
function reconcileTimers(now) {
  const running = q.running.all();
  for (let i = 0; i < running.length - 1; i++) {
    const older = running[i], next = running[i + 1];
    const cap = older.start_at + (MAX_TIMER_H[older.kind] || 6) * 3600_000;
    q.endTimer.run(Math.max(older.start_at, Math.min(next.start_at, cap)), now, nextRev(), older.uid);
  }
  return Math.max(0, running.length - 1);
}

function inTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------- reminders (Web Push)

let vapid = null;
try {
  vapid = loadVapid(PUSH_DIR);
} catch (err) {
  console.error('Reminders are off: could not create the push keys.', err.message);
}
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtTime = (t) => timeFmt.format(t);

async function deliver(sub, message) {
  const status = await sendPush(sub, message, { vapid, subject: PUSH_CONTACT, topic: message.tag });
  if (status === 404 || status === 410) {
    q.subDelete.run(sub.endpoint); // the phone unsubscribed or was reset
    console.log(`Reminders: a ${sub.who === 'mum' ? "Mum's" : "Dad's"} phone has unsubscribed; removed it`);
  } else if (status >= 400) {
    console.warn(`Reminders: the push service answered ${status}`);
  }
  return status;
}

let checking = false;
async function runReminders(now = Date.now()) {
  if (!vapid || checking) return;
  const subs = q.subs.all();
  if (!subs.length) return;
  checking = true;
  try {
    const events = q.recent.all(now - 3 * 86_400_000);
    const ctx = {
      events, meds: meds(), profile: profile(), now, fmtTime, babyName: profile().babyName,
      feedSessions: GUIDANCE.feedSessions, evaluate: GUIDANCE.evaluate, medStatus: MEDS.medStatus,
    };
    for (const sub of subs) {
      for (const r of dueReminders({ ...ctx, prefs: JSON.parse(sub.prefs) })) {
        if (q.sentHas.get(sub.endpoint, r.key)) continue;
        try {
          await deliver(sub, { title: r.title, body: r.body, tag: r.tag, url: '/' });
          q.sentAdd.run(sub.endpoint, r.key, now);
        } catch (err) {
          console.warn('Reminders: could not reach the push service (is this PC online?)', err.message); // tried again next round
        }
      }
    }
    q.sentPrune.run(now - 7 * 86_400_000);
  } finally {
    checking = false;
  }
}
setInterval(() => runReminders().catch((err) => console.error('Reminders:', err)), REMINDER_EVERY_MS).unref();

function parseSubscription(b) {
  const sub = b && b.subscription;
  const endpoint = sub?.endpoint, p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
  if (!isPushEndpoint(endpoint, PUSH_TEST_ENDPOINT)) throw new HttpError(400, "That isn't a push service DadBuddy knows");
  if (typeof p256dh !== 'string' || unb64u(p256dh).length !== 65 || typeof auth !== 'string' || unb64u(auth).length !== 16)
    throw new HttpError(400, 'Invalid subscription keys');
  return { endpoint, p256dh, auth };
}

// ---------------------------------------------------------------- live updates (SSE)

const streams = new Set();
function broadcast() {
  for (const res of streams) res.write('data: changed\n\n');
}
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 25_000).unref();

// ---------------------------------------------------------------- http helpers

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.crt': 'application/x-x509-ca-cert',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function whoIs(req) {
  const who = cookies(req).who;
  return WHO.includes(who) ? who : null;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req, limit = 10_000) {
  // Requiring a JSON content type means a cross-site page cannot submit this
  // without a CORS preflight, which this server never approves.
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON only');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new HttpError(413, 'body too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ---------------------------------------------------------------- API

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/me' && m === 'GET') return send(res, 200, { who: whoIs(req), ...profile() });

  if (p === '/api/login' && m === 'POST') {
    const { who } = await readJson(req);
    if (!WHO.includes(who)) throw new HttpError(400, 'who must be mum or dad');
    return send(res, 200, { who }, {
      'Set-Cookie': `who=${who}; Path=/; Max-Age=${60 * 60 * 24 * 365 * 2}; SameSite=Strict; HttpOnly`,
    });
  }

  if (p === '/api/logout' && m === 'POST') {
    return send(res, 200, { who: null }, { 'Set-Cookie': 'who=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly' });
  }

  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  // Everything below needs someone to be signed in.
  const who = whoIs(req);
  if (!who) throw new HttpError(401, 'Choose Mum or Dad first');

  if (p === '/api/sync' && m === 'GET') {
    const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
    const limit = 2000;
    const rows = q.since.all(since, limit);
    const more = rows.length === limit;
    const rev = more ? rows[rows.length - 1].rev : Math.max(since, q.maxRev.get().rev);
    return send(res, 200, { rev, more, profile: profile(), meds: meds(), events: rows.map(toClient) });
  }

  if (p === '/api/sync' && m === 'POST') {
    const { ops } = await readJson(req, 1_000_000);
    if (!Array.isArray(ops) || ops.length > 2000) throw new HttpError(400, 'ops must be a list of up to 2000 changes');
    const now = Date.now();
    const { results, changed } = inTransaction(() => {
      const results = ops.map((op) => applyOp(op, who, now));
      const changed = results.some((r) => r.changed) + reconcileTimers(now);
      return { results, changed };
    });
    if (changed) broadcast();
    return send(res, 200, { results, rev: q.maxRev.get().rev });
  }

  if (p === '/api/settings' && m === 'POST') {
    const b = await readJson(req);
    if ('babyName' in b) {
      const name = String(b.babyName ?? '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'Name cannot be empty');
      q.setSetting.run('baby_name', name);
    }
    if ('dob' in b) {
      if (b.dob == null || b.dob === '') q.delSetting.run('dob');
      else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.dob) || isNaN(Date.parse(b.dob))) throw new HttpError(400, 'Date of birth must be YYYY-MM-DD');
        if (Date.parse(b.dob) > Date.now() + 86_400_000) throw new HttpError(400, 'Date of birth cannot be in the future');
        q.setSetting.run('dob', b.dob);
      }
    }
    if ('birthWeightKg' in b) {
      const w = num(b.birthWeightKg);
      if (w == null) q.delSetting.run('birth_weight_kg');
      else if (!(w >= 0.4 && w <= 8)) throw new HttpError(400, 'Birth weight must be between 0.4 and 8 kg');
      else q.setSetting.run('birth_weight_kg', String(Math.round(w * 1000) / 1000));
    }
    broadcast();
    return send(res, 200, profile());
  }

  // Reminders: each phone subscribes with its own choices.
  if (p === '/api/push' && m === 'GET') {
    if (!vapid) throw new HttpError(503, 'Reminders are off on the home computer');
    const endpoint = url.searchParams.get('endpoint');
    const sub = endpoint ? q.subByEndpoint.get(endpoint) : null;
    return send(res, 200, { publicKey: vapid.publicKey, subscribed: !!sub, prefs: sub ? JSON.parse(sub.prefs) : cleanPrefs({}, who) });
  }
  if (p === '/api/push/subscribe' && m === 'POST') {
    if (!vapid) throw new HttpError(503, 'Reminders are off on the home computer');
    const b = await readJson(req);
    const sub = parseSubscription(b);
    const prefs = cleanPrefs(b.prefs, who);
    const now = Date.now();
    q.subUpsert.run(sub.endpoint, who, sub.p256dh, sub.auth, JSON.stringify(prefs), now, now);
    setTimeout(() => runReminders().catch(() => {}), 1000);
    return send(res, 200, { subscribed: true, prefs });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const { endpoint } = await readJson(req);
    if (typeof endpoint === 'string') q.subDelete.run(endpoint);
    return send(res, 200, { subscribed: false });
  }
  if (p === '/api/push/test' && m === 'POST') {
    const { endpoint } = await readJson(req);
    const sub = typeof endpoint === 'string' ? q.subByEndpoint.get(endpoint) : null;
    if (!sub || !vapid) throw new HttpError(404, 'Turn on reminders on this phone first');
    let status;
    try {
      status = await deliver(sub, { title: 'DadBuddy reminders are on', body: 'This is how a reminder will look on this phone.', tag: 'test', url: '/' });
    } catch {
      throw new HttpError(502, "The home computer couldn't reach the push service. Is it online?");
    }
    if (status >= 400) throw new HttpError(502, `The push service refused the message (${status})`);
    return send(res, 200, { sent: true });
  }

  // Mum's medicines: added and changed at home (like the baby profile), so both phones agree.
  if (p === '/api/meds' && m === 'POST') {
    const b = await readJson(req);
    const med = MEDS.cleanMed(b);
    const err = MEDS.validateMed(med);
    if (err) throw new HttpError(400, err);
    const now = Date.now();
    const id = b.id == null ? randomUUID() : String(b.id);
    if (!MEDS.ID_RE.test(id)) throw new HttpError(400, 'Invalid medicine id');
    const args = [med.name, med.dose, med.schedule, med.every_h, med.max_day, JSON.stringify(med.times), +med.remind, +med.active];
    if (q.medById.get(id)) q.medUpdate.run(...args, now, id);
    else q.medInsert.run(id, ...args, now, now);
    broadcast();
    return send(res, 200, { id, meds: meds() });
  }

  if (p === '/api/export.csv' && m === 'GET') {
    const rows = q.live.all();
    const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const iso = (v) => (v == null ? '' : new Date(v).toISOString());
    const medName = new Map(meds().map((x) => [x.id, x.name]));
    const lines = ['uid,kind,subtype,start,end,amount_ml,value,poo,pee,medicine,note,by'];
    for (const r of rows)
      lines.push(
        [r.uid, r.kind, r.subtype, iso(r.start_at), iso(r.end_at), r.amount_ml, r.value, r.poo, r.pee, medName.get(r.med) ?? null, r.note, r.by]
          .map(esc)
          .join(',')
      );
    return send(res, 200, lines.join('\n'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="baby-log.csv"',
    });
  }

  throw new HttpError(404, 'not found');
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/setup') rel = '/setup.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'forbidden');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'not found');
  }
}

let tls = null; // { key, cert, caCertPath } once the home certificate exists
let httpsServer = null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The name the phone used, if it's one of ours (never redirect to a host we don't own).
function ownHost(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return [MDNS_HOST, PC_HOST, mdnsIp, ...LOCAL_HOSTS].includes(host) ? host : MDNS_HOST;
}

async function handle(req, res, secure) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    // Lets the setup page (on http) check whether this phone trusts the https certificate yet.
    if (p === '/api/ping') {
      const httpsPort = httpsServer?.listening ? HTTPS_PORT : null;
      return send(res, 200, { ok: true, secure, httpsPort }, { 'Access-Control-Allow-Origin': '*' });
    }
    if (p === '/baby-log-ca.crt' && tls && req.method === 'GET') {
      return send(res, 200, await readFile(tls.caCertPath), {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="baby-log-ca.crt"',
      });
    }
    // On phones, plain HTTP only hosts the setup page; the app itself is served over HTTPS
    // (needed to install it and use it offline). The PC itself can keep using http://localhost.
    const host = ownHost(req);
    if (!secure && httpsServer && !LOCAL_HOSTS.has(host) && p !== '/setup') {
      const target = p === '/' ? '/setup' : `https://${host}${HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`}${p}${url.search}`;
      return send(res, 302, 'Moved', { Location: target });
    }
    if (p.startsWith('/api/')) await api(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else send(res, 405, 'method not allowed');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
  }
}

const server = http.createServer((req, res) => handle(req, res, false));

// ---------------------------------------------------------------- mDNS (baby.local)

const VIRTUAL_IFACE = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Tailscale|ZeroTier|docker|Loopback/i;

// The LAN address: the one the OS would use for its default route.
// (UDP connect sends no packets; it just asks the routing table.)
function defaultRouteAddress() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.on('error', () => {
      s.close();
      resolve(null);
    });
    s.connect(53, '1.1.1.1', () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
}

function fallbackAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

async function lanAddress() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const a = await defaultRouteAddress();
  return a && a !== '0.0.0.0' && !a.startsWith('100.') ? a : fallbackAddress();
}

let mdns = null;
let mdnsIp = null;

function startMdns(ip) {
  if (mdns) mdns.destroy();
  mdnsIp = ip;
  mdns = makeMdns({ interface: ip, bind: '0.0.0.0', reuseAddr: true });
  const answer = () => [{ name: MDNS_HOST, type: 'A', ttl: 120, flush: true, data: mdnsIp }];

  mdns.on('error', (err) => console.error(`mDNS error (${err.code}): ${MDNS_HOST} will not resolve.`, err.message));
  mdns.on('warning', () => {});
  mdns.on('query', (query, rinfo) => {
    const asked = query.questions.some(
      (qq) => qq.name.toLowerCase() === MDNS_HOST && (qq.type === 'A' || qq.type === 'ANY')
    );
    if (!asked) return;
    if (rinfo.port !== 5353) {
      // "Legacy" one-shot query: reply straight to the asker, echoing id + question.
      mdns.respond({ id: query.id, questions: query.questions, answers: answer() }, rinfo);
    } else {
      mdns.respond({ answers: answer() });
    }
  });
  mdns.on('ready', () => mdns.respond({ answers: answer() })); // announce
}

function loadTls(ip) {
  if (!HTTPS_PORT) return null;
  try {
    const t = ensureCerts(CERT_DIR, [MDNS_HOST, PC_HOST, 'localhost'], ip);
    if (!t) console.warn('OpenSSL not found, so HTTPS is off. Phones need HTTPS to install the app.');
    else {
      if (t.created) console.log(`Created the home certificate in ${CERT_DIR}`);
      if (t.renewed) console.log('Renewed the HTTPS certificate');
      if (t.uncovered.length) console.warn(`The home certificate doesn't cover ${t.uncovered.join(', ')}. Delete data/certs and reinstall it on phones.`);
    }
    return t;
  } catch (err) {
    console.error('Could not create the HTTPS certificate:', err.message);
    return null;
  }
}

async function refreshMdns() {
  const ip = await lanAddress();
  if (!ip) return console.warn('No LAN address found; mDNS disabled for now.');
  if (ip !== mdnsIp) {
    startMdns(ip);
    console.log(`mDNS: ${MDNS_HOST} -> ${ip}`);
  }
  // Re-issue the server certificate if the IP changed or it's close to expiry.
  if (httpsServer) {
    const t = loadTls(ip);
    if (t?.renewed || t?.created) httpsServer.setSecureContext({ key: t.key, cert: t.cert });
    if (t) tls = t;
  }
}

// ---------------------------------------------------------------- start

function listenError(port, optional) {
  return (err) => {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
      console.error(`Cannot listen on port ${port} (${err.code}).`);
      if (optional) return void (httpsServer = null);
      console.error('Set PORT (and HTTPS_PORT) to free ports and retry.');
      process.exit(1);
    }
    throw err;
  };
}

async function start() {
  const ip = await lanAddress();
  tls = loadTls(ip);
  if (tls) {
    httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => handle(req, res, true));
    httpsServer.on('error', listenError(HTTPS_PORT, true));
    await new Promise((resolve) => httpsServer.listen(HTTPS_PORT, '0.0.0.0', resolve).once('error', resolve));
  }
  server.on('error', listenError(PORT, false));
  server.listen(PORT, '0.0.0.0', async () => {
    await refreshMdns();
    setInterval(refreshMdns, 60_000).unref(); // follow DHCP changes
    const s = HTTPS_PORT === 443 ? '' : `:${HTTPS_PORT}`, h = PORT === 80 ? '' : `:${PORT}`;
    console.log('DadBuddy running:');
    if (httpsServer?.listening) {
      console.log(`  https://${MDNS_HOST}${s}   (the app)`);
      console.log(`  http://${MDNS_HOST}${h}/setup   (phone setup: install the home certificate)`);
      if (mdnsIp) console.log(`  https://${mdnsIp}${s}`);
    } else {
      console.log(`  http://${MDNS_HOST}${h}`);
      if (mdnsIp) console.log(`  http://${mdnsIp}${h}`);
    }
    console.log(`  http://localhost${h}   (this PC)`);
  });
}
start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    mdns?.destroy();
    server.close();
    httpsServer?.close();
    db.close();
    process.exit(0);
  });
}
