// Reminders: Web Push encryption (RFC 8291 example), VAPID signing, which reminders are due,
// and the whole path from a logged feed to an encrypted message at a (local, fake) push service.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, vapidAuth, loadVapid, isPushEndpoint, unb64u, b64u } from '../push.js';
import { dueReminders, cleanPrefs, WINDOW } from '../reminders.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = (file) => {
  const mod = { exports: {} };
  new Function('module', readFileSync(path.join(root, 'public', file), 'utf8'))(mod);
  return mod.exports;
};
const { feedSessions, evaluate } = shared('guidance.js');
const { medStatus } = shared('meds.js');

// RFC 8291, section 5 and appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// What a phone does with a message: the receiving side of RFC 8291.
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(unb64u(uaPrivate));
  const secret = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, unb64u(auth), info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record padding delimiter');
  return plain.subarray(0, plain.length - 1).toString();
}

test('encryption reproduces the RFC 8291 example byte for byte', () => {
  const out = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, { salt: unb64u(RFC.salt), asKeys: { private: RFC.asPrivate } });
  assert.equal(b64u(out), RFC.result);
  assert.equal(decrypt(out, RFC.uaPrivate, RFC.auth), RFC.plaintext);
  assert.throws(() => encrypt('x', { p256dh: 'AAAA', auth: RFC.auth }), /Bad subscription keys/);
});

test('VAPID: a signed token the push service can check with our public key', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  try {
    const v = loadVapid(dir);
    assert.deepEqual(loadVapid(dir).publicKey, v.publicKey, 'the key pair is kept');
    const now = Date.UTC(2026, 10, 22, 12);
    const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc', v, 'https://example.org/project', now);
    const [, t, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, v.publicKey);
    const [h, c, sig] = t.split('.');
    const claims = JSON.parse(unb64u(c).toString());
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'https://example.org/project' });
    const raw = unb64u(k);
    const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(sig)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only real push services are accepted as endpoints', () => {
  for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/QH', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-par02p.notify.windows.com/w/?token=x'])
    assert.ok(isPushEndpoint(ok), ok);
  for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/fcm.googleapis.com', 'https://192.168.1.1/', 'https://push.apple.com.evil.example/', 42, ''])
    assert.ok(!isPushEndpoint(bad), String(bad));
  assert.ok(isPushEndpoint('http://127.0.0.1:9/x', 'http://127.0.0.1:9/'), 'test prefix only when configured');
});

// ---------------------------------------------------------------- which reminders are due

const H = 3600_000;
const NOW = new Date(2026, 10, 22, 14, 0).getTime();
const fmtTime = (t) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(t);
let n = 0;
const ev = (kind, subtype, hoursAgo, extra = {}) => ({ uid: `u-${++n}`, kind, subtype, start_at: NOW - hoursAgo * H, end_at: null, amount_ml: null, ...extra });
const ctx = (events, prefs, extra = {}) => ({
  events, meds: [], profile: { babyName: 'Ada', dob: null }, prefs: cleanPrefs(prefs, 'dad'), now: NOW, fmtTime, babyName: 'Ada',
  feedSessions, evaluate, medStatus, ...extra,
});
const keys = (r) => r.map((x) => x.key.split(':')[0]);

test('cleanPrefs: defaults, and Mum gets her medicine reminders by default', () => {
  assert.equal(cleanPrefs({}, 'mum').meds.on, true);
  assert.equal(cleanPrefs({}, 'dad').meds.on, false);
  const p = cleanPrefs({ feed: { on: true, hours: 99 }, vitd: { on: 'yes', at: '7pm' } }, 'dad');
  assert.deepEqual(p.feed, { on: true, hours: 3 }, 'unknown hours fall back to 3');
  assert.deepEqual(p.vitd, { on: false, at: '10:00' });
});

test('feed reminder: after the chosen hours, not during a feed, not when stale', () => {
  const feed = ev('feed', 'left', 3.2, { end_at: NOW - 3 * H });
  const r = dueReminders(ctx([feed], { feed: { on: true, hours: 3 } }));
  assert.deepEqual(keys(r), ['feed']);
  assert.match(r[0].title, /3 hours since Ada's last feed/);
  assert.equal(r[0].key, `feed:${feed.uid}:3`, 'one reminder per last feed');
  assert.deepEqual(dueReminders(ctx([feed], { feed: { on: true, hours: 4 } })), [], 'not yet');
  assert.deepEqual(dueReminders(ctx([feed, ev('feed', 'right', 0.1)], { feed: { on: true, hours: 3 } })), [], 'feeding now');
  const old = ev('feed', 'formula', 3 + WINDOW / H + 0.5, { amount_ml: 90 });
  assert.deepEqual(dueReminders(ctx([old], { feed: { on: true, hours: 3 } })), [], 'more than 2 hours overdue: skipped');
  assert.deepEqual(dueReminders(ctx([feed], { feed: { on: false, hours: 3 } })), [], 'off');
});

test('nappy, medicine and vitamin D reminders', () => {
  const nappy = ev('nappy', 'wet', 3.5);
  assert.deepEqual(keys(dueReminders(ctx([nappy], { nappy: { on: true, hours: 3 } }))), ['nappy']);

  const para = { id: 'med-para-1', name: 'Paracetamol', dose: '2 × 500mg', schedule: 'gap', every_h: 4, max_day: 4, times: [], remind: true, active: true };
  const quiet = { ...para, id: 'med-quiet-1', name: 'Iron', remind: false };
  const doses = [ev('med', 'dose', 4.5, { med: para.id }), ev('med', 'dose', 4.5, { med: quiet.id })];
  const r = dueReminders(ctx(doses, { meds: { on: true } }, { meds: [para, quiet] }));
  assert.deepEqual(r.map((x) => x.tag), [`med-${para.id}`], 'only medicines set to remind');
  assert.match(r[0].title, /Mum can take Paracetamol again/);
  assert.deepEqual(dueReminders(ctx(doses, { meds: { on: false } }, { meds: [para] })), [], 'this phone turned medicine reminders off');

  // Vitamin D at 13:00, not given today (14:00 now): due. Given already, or not chosen: nothing.
  assert.deepEqual(keys(dueReminders(ctx([], { vitd: { on: true, at: '13:00' } }))), ['vitd']);
  assert.deepEqual(dueReminders(ctx([ev('vitd', 'drops', 1)], { vitd: { on: true, at: '13:00' } })), []);
  assert.deepEqual(dueReminders(ctx([], { vitd: { on: true, at: '15:00' } })), []);
});

// ---------------------------------------------------------------- end to end

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'dadbuddy-push-'));
const received = [];
let proc, port, fake, fakeBase, log = '';
const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

before(async () => {
  fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.includes('/gone') ? 410 : 201).end();
    });
  });
  const fakePort = await new Promise((resolve) => fake.listen(0, '127.0.0.1', () => resolve(fake.address().port)));
  port = await freePort();
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), HTTPS_PORT: '0', DATA_DIR: dataDir, MDNS_NAME: 'pushtest',
      PUSH_TEST_ENDPOINT: `http://127.0.0.1:${fakePort}/`, REMINDER_EVERY_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 20000);
    const onData = (d) => { log += d; if (log.includes('DadBuddy running')) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
  fakeBase = `http://127.0.0.1:${fakePort}/`;
});

after(() => {
  proc?.kill();
  fake?.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

async function call(method, url, body, who = 'dad') {
  const res = await fetch(`http://localhost:${port}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: `who=${who}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

test('end to end: subscribe, log a feed, receive one encrypted reminder', async () => {
  const sub = (p) => ({ endpoint: fakeBase + p, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } });
  const info = await call('GET', '/api/push');
  assert.equal(info.status, 200);
  assert.equal(unb64u(info.data.publicKey).length, 65);
  assert.equal(info.data.prefs.meds.on, false, "Dad's defaults");

  const foreign = await call('POST', '/api/push/subscribe', { subscription: { ...sub('x'), endpoint: 'https://evil.example/x' }, prefs: {} });
  assert.equal(foreign.status, 400);

  const ok = await call('POST', '/api/push/subscribe', { subscription: sub('phone-1'), prefs: { feed: { on: true, hours: 2 } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.prefs.feed.hours, 2);
  assert.equal((await call('GET', `/api/push?endpoint=${encodeURIComponent(sub('phone-1').endpoint)}`)).data.subscribed, true);

  // A feed that started 2h 10m ago: the feed reminder is due.
  const now = Date.now();
  const start = now - 130 * 60_000;
  await call('POST', '/api/sync', { ops: [{ op: 'upsert', uid: 'push-feed-1', kind: 'feed', subtype: 'formula', amount_ml: 90, start_at: start, updated_at: now }] });
  assert.ok(await waitFor(() => received.length >= 1), `a reminder arrived\n${log}`);
  await new Promise((r) => setTimeout(r, 800)); // a few more rounds: it must not be sent twice
  assert.equal(received.length, 1, 'sent once');

  const msg = received[0];
  assert.equal(msg.url, '/phone-1');
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.equal(msg.headers.topic, 'feed');
  assert.match(msg.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${info.data.publicKey}$`));
  const payload = JSON.parse(decrypt(msg.body, RFC.uaPrivate, RFC.auth));
  assert.equal(payload.tag, 'feed');
  assert.match(payload.title, /2 hours since Baby's last feed/);
  assert.ok(!msg.body.includes(Buffer.from('feed')), 'the push service only sees ciphertext');

  // Test button.
  assert.equal((await call('POST', '/api/push/test', { endpoint: sub('phone-1').endpoint })).status, 200);
  assert.ok(await waitFor(() => received.length === 2));

  // A phone that has gone away (410) is forgotten.
  await call('POST', '/api/push/subscribe', { subscription: sub('gone'), prefs: { feed: { on: true, hours: 2 } } });
  assert.ok(await waitFor(() => received.some((r) => r.url === '/gone')));
  assert.ok(await waitFor(() => /has unsubscribed/.test(log)));
  assert.equal((await call('GET', `/api/push?endpoint=${encodeURIComponent(sub('gone').endpoint)}`)).data.subscribed, false);

  // Turning reminders off.
  await call('POST', '/api/push/unsubscribe', { endpoint: sub('phone-1').endpoint });
  assert.equal((await call('GET', `/api/push?endpoint=${encodeURIComponent(sub('phone-1').endpoint)}`)).data.subscribed, false);
});
