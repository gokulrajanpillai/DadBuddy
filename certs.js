// Home HTTPS: a small certificate authority that lives in data/certs and can only vouch for
// home addresses (baby.local, this PC's .local name, localhost and private IP ranges).
// Phones install ca.crt once; the server certificate is re-issued from it whenever the
// LAN IP changes or it gets close to expiry, so phones never need anything reinstalled.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { X509Certificate, randomBytes } from 'node:crypto';
import path from 'node:path';

const OPENSSL_CANDIDATES = [
  process.env.OPENSSL,
  'openssl',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
].filter(Boolean);

let opensslPath;
export function findOpenssl() {
  if (opensslPath !== undefined) return opensslPath;
  opensslPath = null;
  for (const c of OPENSSL_CANDIDATES) {
    try {
      execFileSync(c, ['version'], { stdio: 'pipe', windowsHide: true });
      opensslPath = c;
      break;
    } catch {}
  }
  return opensslPath;
}

const openssl = (args, cwd) => execFileSync(findOpenssl(), args, { cwd, stdio: 'pipe', windowsHide: true });

const CA_DAYS = 3650;
const LEAF_DAYS = 825; // Apple's limit for certificates from a locally installed CA
const RENEW_BEFORE_MS = 30 * 86_400_000;

function caConfig(names) {
  const dns = names.map((n, i) => `permitted;DNS.${i} = ${n}`).join('\n');
  return `[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca
[dn]
CN = DadBuddy home certificate
O = DadBuddy
[v3_ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, @nc
[nc]
${dns}
permitted;IP.0 = 192.168.0.0/255.255.0.0
permitted;IP.1 = 10.0.0.0/255.0.0.0
permitted;IP.2 = 172.16.0.0/255.240.0.0
permitted;IP.3 = 127.0.0.0/255.0.0.0
`;
}

function leafConfig(names, ips) {
  return `[req]
prompt = no
distinguished_name = dn
[dn]
CN = ${names[0]}
[v3_leaf]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
subjectAltName = @san
[san]
${names.map((n, i) => `DNS.${i} = ${n}`).join('\n')}
${ips.map((ip, i) => `IP.${i} = ${ip}`).join('\n')}
`;
}

// names: DNS names to cover (first is the main one). ip: current LAN IP (may be null).
// Returns { key, cert, caCertPath, created, renewed } or null when OpenSSL isn't available.
export function ensureCerts(dir, names, ip) {
  if (!findOpenssl()) return null;
  mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  let created = false, renewed = false;

  if (!existsSync(f('ca.key')) || !existsSync(f('ca.crt'))) {
    writeFileSync(f('ca.cnf'), caConfig(names));
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS),
      '-keyout', 'ca.key', '-out', 'ca.crt', '-config', 'ca.cnf'], dir);
    writeFileSync(f('ca-names.json'), JSON.stringify(names));
    created = true;
  }

  const ca = new X509Certificate(readFileSync(f('ca.crt')));
  const ips = [ip, '127.0.0.1'].filter(Boolean);
  let needLeaf = created || !existsSync(f('server.key')) || !existsSync(f('server.crt'));
  if (!needLeaf) {
    const leaf = new X509Certificate(readFileSync(f('server.crt')));
    const san = leaf.subjectAltName || '';
    needLeaf =
      !leaf.checkIssued(ca) ||
      Date.parse(leaf.validTo) - Date.now() < RENEW_BEFORE_MS ||
      names.some((n) => !san.includes(`DNS:${n}`)) ||
      ips.some((a) => !san.includes(`IP Address:${a}`));
  }
  if (needLeaf) {
    writeFileSync(f('server.cnf'), leafConfig(names, ips));
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', 'server.key', '-out', 'server.csr',
      '-config', 'server.cnf'], dir);
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-sha256',
      '-set_serial', `0x${randomBytes(12).toString('hex')}`, '-days', String(LEAF_DAYS),
      '-extfile', 'server.cnf', '-extensions', 'v3_leaf', '-out', 'server.crt'], dir);
    renewed = !created;
  }

  // Names the CA was made for; a new MDNS_NAME or PC name needs a new CA (and reinstalling it on phones).
  let caNames = [];
  try { caNames = JSON.parse(readFileSync(f('ca-names.json'), 'utf8')); } catch {}
  const uncovered = names.filter((n) => !caNames.includes(n));

  return {
    key: readFileSync(f('server.key')),
    cert: readFileSync(f('server.crt')),
    caCertPath: f('ca.crt'),
    created,
    renewed,
    uncovered,
  };
}
