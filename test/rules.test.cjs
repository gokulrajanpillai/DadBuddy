// Shared entry rules (public/rules.js), used by phones offline and by the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '../public/rules.js'), 'utf8'))(mod);
const R = mod.exports;
const NOW = Date.UTC(2026, 10, 21, 14, 0);

test('normalise drops fields that do not fit the entry', () => {
  const e = R.normalise({ kind: 'nappy', subtype: 'wet', start_at: NOW, end_at: NOW, amount_ml: 90, poo: 'yellow', pee: 'dark', note: '  ' });
  assert.equal(e.end_at, null);
  assert.equal(e.amount_ml, null);
  assert.equal(e.poo, null);
  assert.equal(e.pee, 'dark');
  assert.equal(e.note, null);
  const f = R.normalise({ kind: 'feed', subtype: 'left', start_at: NOW, amount_ml: 60 });
  assert.equal(f.amount_ml, null);
  assert.equal(f.end_at, null);
});

test('pick coerces numbers and keeps the base for missing fields', () => {
  const base = { kind: 'temp', subtype: 'armpit', start_at: NOW, value: 37 };
  const e = R.pick({ value: '38.4', start_at: String(NOW - 1000) }, base);
  assert.equal(e.value, 38.4);
  assert.equal(e.start_at, NOW - 1000);
  assert.equal(e.kind, 'temp');
  assert.equal(R.pick({ value: '' }).value, null);
});

test('validateEvent: the same limits the server always had', () => {
  const ok = { kind: 'feed', subtype: 'formula', start_at: NOW - 60_000, end_at: null, amount_ml: 90 };
  assert.equal(R.validateEvent(R.normalise(ok), NOW), null);
  assert.match(R.validateEvent({ ...ok, start_at: NOW + 6 * 60_000 }, NOW), /future/);
  assert.match(R.validateEvent({ ...ok, amount_ml: 900 }, NOW), /0–500/);
  assert.match(R.validateEvent({ kind: 'temp', subtype: 'armpit', start_at: NOW, value: 50 }, NOW), /30 and 45/);
  assert.match(R.validateEvent({ kind: 'sleep', subtype: 'sleep', start_at: NOW - 17 * 3600_000, end_at: NOW }, NOW), /16 hours/);
  assert.equal(R.validateEvent({ kind: 'sleep', subtype: 'sleep', start_at: NOW - 15 * 3600_000, end_at: NOW }, NOW), null);
  assert.match(R.validateEvent({ kind: 'nappy', subtype: 'dirty', start_at: NOW, poo: 'purple' }, NOW), /poo must be/);
  assert.match(R.validateEvent({ kind: 'nappy', subtype: 'soggy', start_at: NOW }, NOW), /subtype/);
});

test('isTimer: breastfeeds and sleeps only', () => {
  assert.equal(R.isTimer({ kind: 'feed', subtype: 'left' }), true);
  assert.equal(R.isTimer({ kind: 'feed', subtype: 'formula' }), false);
  assert.equal(R.isTimer({ kind: 'sleep', subtype: 'sleep' }), true);
});

test("a dose of Mum's medicine must say which medicine", () => {
  const ok = R.normalise({ kind: 'med', subtype: 'dose', start_at: NOW, med: 'med-0001-abcd', value: 3 });
  assert.equal(ok.value, null);
  assert.equal(R.validateEvent(ok, NOW), null);
  assert.match(R.validateEvent(R.normalise({ kind: 'med', subtype: 'dose', start_at: NOW }), NOW), /which medicine/);
  assert.equal(R.normalise({ kind: 'nappy', subtype: 'wet', start_at: NOW, med: 'med-0001-abcd' }).med, null, 'only doses keep a medicine');
});
