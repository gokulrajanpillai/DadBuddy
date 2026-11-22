// Sync protocol, HTTPS and the v2 -> v3 migration, against a real server on spare ports.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'babylog-test-'));
let proc, base, httpsPort, log = '';

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// A v2 database with one entry, to check the upgrade keeps it.
function makeV2Db() {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'baby.db'));
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, subtype TEXT NOT NULL,
      start_at INTEGER NOT NULL, end_at INTEGER, amount_ml INTEGER, value REAL, poo TEXT, pee TEXT, note TEXT,
      by TEXT NOT NULL CHECK (by IN ('mum','dad')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    PRAGMA user_version = 2;`);
  const t = Date.now() - 3600_000;
  db.prepare("INSERT INTO events (kind, subtype, start_at, by, created_at, updated_at) VALUES ('nappy', 'wet', ?, 'mum', ?, ?)").run(t, t, t);
  db.close();
}

before(async () => {
  makeV2Db();
  const port = await freePort();
  httpsPort = await freePort();
  base = `http://localhost:${port}`;
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HTTPS_PORT: String(httpsPort), DATA_DIR: dataDir, MDNS_NAME: 'synctest' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 20000);
    const onData = (d) => { log += d; if (log.includes('Baby Log running')) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
});

after(() => {
  proc?.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

async function call(method, url, body, who = 'mum') {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(who ? { Cookie: `who=${who}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, headers: res.headers };
}
const push = (ops, who) => call('POST', '/api/sync', { ops }, who);
const pull = (since = 0) => call('GET', `/api/sync?since=${since}`);
const uid = (n) => `test-uid-${n}`;
const MIN = 60_000;

test('migration v2 -> v3 keeps entries, gives them uids and backs up first', async () => {
  assert.match(log, /Migrated database to v3/);
  assert.ok(readdirSync(path.join(dataDir, 'backups')).some((f) => f.startsWith('baby-v2-')));
  const { data } = await pull(0);
  const old = data.events.find((e) => e.kind === 'nappy' && e.by === 'mum');
  assert.ok(old, 'old entry present');
  assert.match(old.uid, /^[0-9a-f-]{36}$/);
  assert.ok(old.rev > 0);
  assert.equal(old.id, undefined, 'internal id is not sent to phones');
});

test('sync needs someone signed in', async () => {
  assert.equal((await pull(0)).status, 200);
  const r = await call('GET', '/api/sync?since=0', null, null);
  assert.equal(r.status, 401);
});

test('upsert is idempotent: replaying an op changes nothing', async () => {
  const now = Date.now();
  const op = { op: 'upsert', uid: uid(1), by: 'dad', kind: 'feed', subtype: 'formula', amount_ml: 90, start_at: now - 5 * MIN, created_at: now, updated_at: now };
  const first = await push([op]);
  assert.deepEqual(first.data.results[0], { uid: uid(1), ok: true, changed: true });
  const rev1 = first.data.rev;
  const again = await push([op]);
  assert.equal(again.data.results[0].ignored, 'stale');
  assert.equal(again.data.rev, rev1, 'no new revision for a replay');
  const row = (await pull(0)).data.events.find((e) => e.uid === uid(1));
  assert.equal(row.by, 'dad', 'by comes from the phone that logged it');
  assert.equal(row.amount_ml, 90);
});

test('last write wins by the phone timestamp', async () => {
  const now = Date.now();
  await push([{ op: 'upsert', uid: uid(2), kind: 'feed', subtype: 'expressed', amount_ml: 60, start_at: now - 9 * MIN, updated_at: now - 3000 }]);
  // A newer edit from one phone…
  await push([{ op: 'upsert', uid: uid(2), kind: 'feed', subtype: 'expressed', amount_ml: 80, start_at: now - 9 * MIN, updated_at: now - 1000 }]);
  // …then an older edit from the other phone arrives late.
  const late = await push([{ op: 'upsert', uid: uid(2), kind: 'feed', subtype: 'expressed', amount_ml: 70, start_at: now - 9 * MIN, updated_at: now - 2000 }]);
  assert.equal(late.data.results[0].ignored, 'stale');
  assert.equal((await pull(0)).data.events.find((e) => e.uid === uid(2)).amount_ml, 80);
});

test('the since cursor only returns newer changes', async () => {
  const { data: before } = await pull(0);
  const now = Date.now();
  await push([{ op: 'upsert', uid: uid(3), kind: 'vitd', subtype: 'drops', start_at: now - MIN, updated_at: now }]);
  const { data } = await pull(before.rev);
  assert.deepEqual(data.events.map((e) => e.uid), [uid(3)]);
  assert.equal(data.more, false);
  assert.ok(data.profile && data.profile.babyName);
});

test('a deleted entry stays deleted and the deletion reaches other phones', async () => {
  const now = Date.now();
  await push([{ op: 'upsert', uid: uid(4), kind: 'nappy', subtype: 'wet', start_at: now - 2 * MIN, updated_at: now - 2000 }]);
  const { data: mid } = await pull(0);
  const del = await push([{ op: 'delete', uid: uid(4), updated_at: now - 1000 }]);
  assert.equal(del.data.results[0].changed, true);
  const tomb = (await pull(mid.rev)).data.events.find((e) => e.uid === uid(4));
  assert.ok(tomb.deleted_at, 'tombstone sent to the other phone');
  const revive = await push([{ op: 'upsert', uid: uid(4), kind: 'nappy', subtype: 'wet', start_at: now - 2 * MIN, updated_at: now }]);
  assert.equal(revive.data.results[0].ignored, 'deleted');
  const csv = await call('GET', '/api/export.csv');
  assert.ok(!csv.data.includes(uid(4)), 'deleted entries are not exported');
});

test('two feeds started on different phones while apart: the older one is ended', async () => {
  const now = Date.now();
  await push([{ op: 'upsert', uid: uid(5), by: 'mum', kind: 'feed', subtype: 'left', start_at: now - 30 * MIN, end_at: null, updated_at: now - 30 * MIN }], 'mum');
  await push([{ op: 'upsert', uid: uid(6), by: 'dad', kind: 'sleep', subtype: 'sleep', start_at: now - 10 * MIN, end_at: null, updated_at: now - 10 * MIN }], 'dad');
  const rows = (await pull(0)).data.events;
  const a = rows.find((e) => e.uid === uid(5)), b = rows.find((e) => e.uid === uid(6));
  assert.equal(a.end_at, now - 10 * MIN, 'older timer ends when the newer one started');
  assert.equal(b.end_at, null, 'newest timer keeps running');
});

test('an invalid change is refused with a reason and the server copy', async () => {
  const now = Date.now();
  await push([{ op: 'upsert', uid: uid(7), kind: 'temp', subtype: 'armpit', value: 37.2, start_at: now - MIN, updated_at: now - 1000 }]);
  const r = await push([
    { op: 'upsert', uid: uid(7), kind: 'temp', subtype: 'armpit', value: 52, start_at: now - MIN, updated_at: now },
    { op: 'upsert', uid: uid(8), kind: 'nappy', subtype: 'wet', start_at: now + 3600_000, updated_at: now },
    { op: 'upsert', uid: 'x', kind: 'nappy', subtype: 'wet', start_at: now },
  ]);
  const [bad, future, noUid] = r.data.results;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /30 and 45/);
  assert.equal(bad.current.value, 37.2);
  assert.match(future.error, /future/);
  assert.equal(future.current, null);
  assert.match(noUid.error, /uid/);
});

test('HTTPS works with the home certificate', async () => {
  const ca = readFileSync(path.join(dataDir, 'certs', 'ca.crt'));
  const body = await new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', servername: 'localhost', port: httpsPort, path: '/api/ping', ca, headers: { Host: 'localhost' } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert.equal(body.secure, true);
});

test('on plain HTTP, phones are sent to setup or HTTPS; the certificate downloads', async () => {
  // fetch() won't send a custom Host header, so use a raw request to act like a phone.
  const port = Number(new URL(base).port);
  const asPhone = (p, host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
  });
  const res = await asPhone('/history', 'synctest.local');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `https://synctest.local:${httpsPort}/history`);
  assert.equal((await asPhone('/', 'synctest.local')).headers.location, '/setup');
  assert.equal((await asPhone('/setup', 'synctest.local')).statusCode, 200);
  const evil = await asPhone('/x', 'evil.example');
  assert.ok(evil.headers.location.startsWith('https://synctest.local'), 'never redirects to a foreign host');
  const cert = await fetch(base + '/baby-log-ca.crt');
  assert.equal(cert.headers.get('content-type'), 'application/x-x509-ca-cert');
  const ping = await (await fetch(base + '/api/ping')).json();
  assert.equal(ping.httpsPort, httpsPort);
});
