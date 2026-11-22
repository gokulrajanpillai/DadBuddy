// Web Push, with Node's own crypto (no extra dependencies).
// - VAPID (RFC 8292): the home server signs each request, so push services know it's the same sender
// - Message encryption (RFC 8291, aes128gcm): only the phone can read a reminder. Apple's or Google's
//   push service only ever sees ciphertext and the length of the message.

import crypto from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s), 'base64url');

// Push services a phone's browser may hand us. The server only ever sends to these, so a
// subscription can't be used to make the home PC call some other address.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome, Edge on Android, Samsung Internet
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^[a-z0-9-]+\.push\.apple\.com$/,         // Safari on iPhone and Mac
  /^[a-z0-9-]+\.notify\.windows\.com$/,     // Edge on Windows
];
export function isPushEndpoint(endpoint, extraPrefix = '') {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  if (extraPrefix && endpoint.startsWith(extraPrefix)) return true; // tests only (PUSH_TEST_ENDPOINT)
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// The server's VAPID key pair, made once and kept in data/push/vapid.json (private: never commit it).
export function loadVapid(dir) {
  const file = path.join(dir, 'vapid.json');
  if (!existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ jwk: privateKey.export({ format: 'jwk' }) }, null, 2), { mode: 0o600 });
  }
  const { jwk } = JSON.parse(readFileSync(file, 'utf8'));
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  // Uncompressed P-256 point: 0x04 || x || y. Phones pass this as applicationServerKey.
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  return { privateKey, publicKey };
}

// "vapid t=<signed JWT>, k=<public key>" for one push service (the JWT's audience).
export function vapidAuth(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// RFC 8291 encryption. `salt` and `asKeys` are only passed in by the tests (to reproduce the RFC's example).
export function encrypt(plaintext, keys, { salt = crypto.randomBytes(16), asKeys } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const auth = unb64u(keys.auth);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error('Bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  if (asKeys) ecdh.setPrivateKey(unb64u(asKeys.private));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Send one message. Resolves with the push service's HTTP status (201 = accepted;
// 404/410 = the phone has unsubscribed, so forget it).
export async function sendPush(sub, message, { vapid, subject, topic, ttl = 3600 }) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuth(sub.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'high',
      ...(topic ? { Topic: topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
    },
    body: encrypt(JSON.stringify(message), { p256dh: sub.p256dh, auth: sub.auth }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer().catch(() => {});
  return res.status;
}
