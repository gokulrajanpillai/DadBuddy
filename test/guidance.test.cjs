// Run: node --test test/*.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const sandbox = { module: { exports: {} }, Date, Math, Object, Number, String, Set, Infinity };
vm.runInNewContext(require('node:fs').readFileSync(path.join(__dirname, '../public/guidance.js'), 'utf8'), sandbox);
const { evaluate, ageInDays, ageLabel } = sandbox.module.exports;

const H = 3600_000, D = 24 * H;
const NOW = new Date(2026, 10, 21, 14, 0).getTime(); // 21 Nov 2026 14:00 local
const dobDaysAgo = (n) => {
  const d = new Date(NOW); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let id = 0;
const ev = (kind, subtype, hoursAgo, extra = {}) => {
  const start_at = NOW - hoursAgo * H;
  return { id: ++id, kind, subtype, start_at, end_at: null, amount_ml: null, value: null, poo: null, pee: null, ...extra };
};
const feed = (h, sub = 'left') => ev('feed', sub, h, { end_at: NOW - h * H + 15 * 60_000 });
const check = (r, cid) => r.checks.find((c) => c.id === cid);
const alertKinds = (r) => r.alerts.map((a) => a.key.split('-')[0]);

test('age helpers', () => {
  assert.equal(ageInDays(dobDaysAgo(0), NOW), 0);
  assert.equal(ageInDays(dobDaysAgo(12), NOW), 12);
  assert.equal(ageLabel(12), '12 days old');
  assert.equal(ageLabel(23), '3 weeks 2 days old');
});

test('feeds: 8+ in 24h is in line with the NHS guide for a 10-day-old breastfed baby', () => {
  const events = [ev('feed', 'left', 30, { end_at: NOW - 30 * H + 600_000 })];
  for (let i = 0; i < 9; i++) events.push(feed(1 + i * 2.6));
  const r = evaluate(events, { dob: dobDaysAgo(10) }, NOW);
  assert.equal(check(r, 'feeds').status, 'ok');
  assert.equal(check(r, 'feeds').value, '9');
});

test('feeds: fewer than 8 is "low" only once logging covers 24h', () => {
  const few = [feed(1), feed(4), feed(7)];
  assert.equal(check(evaluate(few, { dob: dobDaysAgo(10) }, NOW), 'feeds').status, 'pending');
  const covered = [...few, feed(30)];
  assert.equal(check(evaluate(covered, { dob: dobDaysAgo(10) }, NOW), 'feeds').status, 'low');
});

test('feeds: switching sides within 30 minutes counts as one feed', () => {
  const events = [
    ev('feed', 'left', 2, { end_at: NOW - 2 * H + 10 * 60_000 }),
    ev('feed', 'right', 2 - 10 / 60, { end_at: NOW - 2 * H + 25 * 60_000 }),
  ];
  assert.equal(check(evaluate(events, { dob: dobDaysAgo(10) }, NOW), 'feeds').value, '1');
});

test('feeds: formula-only babies get responsive-feeding info, not the breastfeeding count guide', () => {
  const events = [ev('feed', 'formula', 1, { amount_ml: 90 }), ev('feed', 'formula', 30, { amount_ml: 90 })];
  assert.equal(check(evaluate(events, { dob: dobDaysAgo(10) }, NOW), 'feeds').status, 'info');
});

test('wet nappies: day 5+ needs 6; first 48h is info only', () => {
  const wets = (n) => Array.from({ length: n }, (_, i) => ev('nappy', 'wet', 1 + i * 3)).concat(ev('nappy', 'wet', 30));
  assert.equal(check(evaluate(wets(6), { dob: dobDaysAgo(6) }, NOW), 'wet').status, 'ok');
  assert.equal(check(evaluate(wets(4), { dob: dobDaysAgo(6) }, NOW), 'wet').status, 'low');
  assert.equal(check(evaluate(wets(2), { dob: dobDaysAgo(1) }, NOW), 'wet').status, 'info');
});

test('poos: from day 4 needs 2 a day', () => {
  const events = [ev('nappy', 'dirty', 2, { poo: 'yellow' }), ev('nappy', 'wet', 30)];
  assert.equal(check(evaluate(events, { dob: dobDaysAgo(5) }, NOW), 'poo').status, 'low');
  events.push(ev('nappy', 'both', 5, { poo: 'yellow' }));
  assert.equal(check(evaluate(events, { dob: dobDaysAgo(5) }, NOW), 'poo').status, 'ok');
});

test('vitamin D: todo, given, or not needed over 500ml formula', () => {
  assert.equal(check(evaluate([feed(1)], { dob: dobDaysAgo(10) }, NOW), 'vitd').status, 'todo');
  assert.equal(check(evaluate([feed(1), ev('vitd', 'drops', 2)], { dob: dobDaysAgo(10) }, NOW), 'vitd').status, 'ok');
  const formula = Array.from({ length: 6 }, (_, i) => ev('feed', 'formula', 1 + i * 3, { amount_ml: 100 }));
  assert.equal(check(evaluate(formula, { dob: dobDaysAgo(10) }, NOW), 'vitd').status, 'na');
});

test('temperature: 38C under 3 months is urgent; 38.5C at 5 months is "soon"; 39C at 4 months urgent; 35.5 urgent', () => {
  const t = (v) => [ev('temp', 'armpit', 0.5, { value: v })];
  assert.equal(evaluate(t(38), { dob: dobDaysAgo(30) }, NOW).alerts[0].level, 'urgent');
  assert.equal(evaluate(t(38.5), { dob: dobDaysAgo(150) }, NOW).alerts[0].level, 'soon');
  assert.equal(evaluate(t(39), { dob: dobDaysAgo(120) }, NOW).alerts[0].level, 'urgent');
  assert.equal(evaluate(t(35.5), { dob: dobDaysAgo(120) }, NOW).alerts[0].level, 'urgent');
  assert.equal(evaluate(t(37.2), { dob: dobDaysAgo(30) }, NOW).alerts.length, 0);
  // unknown age: treated as under 3 months (safest)
  assert.equal(evaluate(t(38), { dob: null }, NOW).alerts[0].level, 'urgent');
  // older than 6 hours: no alert
  assert.equal(evaluate([ev('temp', 'armpit', 7, { value: 38.4 })], { dob: dobDaysAgo(30) }, NOW).alerts.length, 0);
});

test('no wet nappy in 12h raises an urgent alert only once logging covers 12h', () => {
  const recentOnly = [ev('nappy', 'wet', 13)];
  assert.ok(alertKinds(evaluate(recentOnly, { dob: dobDaysAgo(10) }, NOW)).includes('nowet'));
  const fine = [ev('nappy', 'wet', 13), ev('nappy', 'wet', 2)];
  assert.ok(!alertKinds(evaluate(fine, { dob: dobDaysAgo(10) }, NOW)).includes('nowet'));
  const justStarted = [feed(3)];
  assert.ok(!alertKinds(evaluate(justStarted, { dob: dobDaysAgo(10) }, NOW)).includes('nowet'));
});

test('pale poo and dark pee raise "soon" alerts', () => {
  const r = evaluate([ev('nappy', 'both', 3, { poo: 'pale', pee: 'dark' })], { dob: dobDaysAgo(10) }, NOW);
  assert.equal(alertKinds(r).sort().join(','), 'dark,pale');
  assert.ok(r.alerts.every((a) => a.level === 'soon'));
});

test('black poo is expected in the meconium days but flagged after', () => {
  const e = [ev('nappy', 'dirty', 3, { poo: 'black' })];
  assert.ok(!alertKinds(evaluate(e, { dob: dobDaysAgo(1) }, NOW)).includes('rb'));
  assert.ok(alertKinds(evaluate(e, { dob: dobDaysAgo(10) }, NOW)).includes('rb'));
});

test('no poo for 2 days under 8 weeks: talk to midwife/HV/GP', () => {
  const e = [ev('nappy', 'dirty', 50, { poo: 'yellow' }), ev('nappy', 'wet', 1)];
  assert.ok(alertKinds(evaluate(e, { dob: dobDaysAgo(20) }, NOW)).includes('nopoo'));
  assert.ok(!alertKinds(evaluate(e, { dob: dobDaysAgo(70) }, NOW)).includes('nopoo'));
});

test('alerts are ordered urgent first', () => {
  const e = [ev('nappy', 'both', 3, { poo: 'pale' }), ev('temp', 'armpit', 0.2, { value: 38.2 })];
  assert.equal(evaluate(e, { dob: dobDaysAgo(20) }, NOW).alerts[0].level, 'urgent');
});

test('poo check flags a pale poo even when the count is fine', () => {
  const e = [ev('nappy', 'dirty', 2, { poo: 'yellow' }), ev('nappy', 'dirty', 4, { poo: 'pale' }), ev('nappy', 'wet', 30)];
  const c = check(evaluate(e, { dob: dobDaysAgo(10) }, NOW), 'poo');
  assert.equal(c.status, 'low');
  assert.match(c.guide, /pale poo/);
});

test('a normal re-check does not hide an earlier high reading; it does clear a low one', () => {
  const high = [ev('temp', 'armpit', 1, { value: 38.3 }), ev('temp', 'armpit', 0.2, { value: 37.1 })];
  assert.equal(evaluate(high, { dob: dobDaysAgo(30) }, NOW).alerts[0]?.level, 'urgent');
  const low = [ev('temp', 'armpit', 0.3, { value: 35.6 }), ev('temp', 'armpit', 0.1, { value: 36.6 })];
  assert.equal(evaluate(low, { dob: dobDaysAgo(30) }, NOW).alerts.length, 0);
});
