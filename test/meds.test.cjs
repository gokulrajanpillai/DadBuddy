// Mum's medicines (public/meds.js): validation and "when is the next dose due".
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const mod = { exports: {} };
new Function('module', fs.readFileSync(path.join(__dirname, '../public/meds.js'), 'utf8'))(mod);
const M = mod.exports;

const H = 3600_000;
const NOW = new Date(2026, 10, 22, 14, 0).getTime(); // 22 Nov 2026 14:00 local
const at = (h, m = 0, dayShift = 0) => { const d = new Date(NOW); d.setDate(d.getDate() + dayShift); d.setHours(h, m, 0, 0); return d.getTime(); };
const dose = (med, t) => ({ kind: 'med', subtype: 'dose', med, start_at: t });
const para = { id: 'med-para-1', ...M.cleanMed({ name: 'Paracetamol', schedule: 'gap', every_h: 4, max_day: 4 }) };
const vitd = { id: 'med-vitd-1', ...M.cleanMed({ name: 'Vitamin D', schedule: 'times', times: ['09:00'], max_day: 1 }) };
const twice = { id: 'med-iron-1', ...M.cleanMed({ name: 'Iron', schedule: 'times', times: ['20:00', '08:00'] }) };

test('validateMed', () => {
  assert.equal(M.validateMed(M.cleanMed({ name: 'Paracetamol', every_h: 4 })), null);
  assert.match(M.validateMed(M.cleanMed({ name: '  ', every_h: 4 })), /name/);
  assert.match(M.validateMed(M.cleanMed({ name: 'X' })), /hours/);
  assert.match(M.validateMed(M.cleanMed({ name: 'X', every_h: 0.1 })), /0.5 to 72/);
  assert.match(M.validateMed(M.cleanMed({ name: 'X', schedule: 'times' })), /at least one time/);
  assert.match(M.validateMed(M.cleanMed({ name: 'X', schedule: 'times', times: ['25:00'] })), /08:00/);
  assert.match(M.validateMed(M.cleanMed({ name: 'X', every_h: 4, max_day: 2.5 })), /whole number/);
  assert.deepEqual(twice.times, ['08:00', '20:00'], 'times are sorted');
  assert.equal(M.cleanMed({ name: 'X', every_h: 4 }).active, true, 'new medicines are active');
});

test('presets carry their NHS source and pass validation', () => {
  for (const p of M.PRESETS) {
    assert.equal(M.validateMed(M.cleanMed(p)), null, p.name);
    assert.match(p.link, /^https:\/\/www\.nhs\.uk\//);
  }
});

test('every few hours: next dose, too soon, and the 24-hour limit', () => {
  assert.deepEqual(
    { ...M.medStatus(para, [], NOW) },
    { last: null, count24: 0, atMax: false, tooSoon: false, nextAt: null, dueAt: null, slot: null },
    'nothing taken: any time, and nothing to remind about'
  );
  const one = M.medStatus(para, [dose(para.id, NOW - 2 * H)], NOW);
  assert.equal(one.tooSoon, true);
  assert.equal(one.nextAt, NOW + 2 * H);
  assert.equal(one.dueAt, NOW + 2 * H, 'reminder when the gap is up');
  const later = M.medStatus(para, [dose(para.id, NOW - 5 * H)], NOW);
  assert.equal(later.tooSoon, false);
  assert.equal(later.count24, 1);
  // Four doses in 24 hours, the last 4.5h ago: the gap is fine but the limit isn't.
  const four = [20, 14, 9, 4.5].map((h) => dose(para.id, NOW - h * H));
  const max = M.medStatus(para, four, NOW);
  assert.equal(max.atMax, true);
  assert.equal(max.tooSoon, false);
  assert.equal(max.nextAt, NOW - 20 * H + 24 * H, 'allowed again once the oldest dose is 24 hours old');
  // Other medicines' doses and deleted doses don't count.
  const other = M.medStatus(para, [dose('someone-else', NOW - H), { ...dose(para.id, NOW - H), deleted_at: NOW }], NOW);
  assert.equal(other.last, null);
});

test('set times: due, taken, early window and missed doses', () => {
  // 14:00, nothing taken today: the 09:00 dose is 5 hours late, so still due.
  const late = M.medStatus(vitd, [], NOW);
  assert.equal(late.slot, at(9));
  assert.equal(late.dueAt, at(9));
  // Taken at 09:10: next is tomorrow 09:00.
  const taken = M.medStatus(vitd, [dose(vitd.id, at(9, 10))], NOW);
  assert.equal(taken.slot, null);
  assert.equal(taken.nextAt, at(9, 0, 1));
  assert.equal(taken.dueAt, at(9, 0, 1));
  // Taken at 07:30 counts for 09:00 (up to 2 hours early).
  assert.equal(M.medStatus(vitd, [dose(vitd.id, at(7, 30))], NOW).nextAt, at(9, 0, 1));
  // At 16:00 a missed 09:00 dose is 7 hours late: no longer shown as due.
  const missed = M.medStatus(vitd, [], at(16));
  assert.equal(missed.slot, null);
  assert.equal(missed.nextAt, at(9, 0, 1));
  // Twice a day, 19:00: inside the early window for 20:00, so a dose now counts for it.
  const iron = M.medStatus(twice, [dose(twice.id, at(8, 5))], at(19));
  assert.equal(iron.slot, at(20));
  assert.equal(iron.tooSoon, false);
  // Once a day and already taken: a second dose is over the limit.
  assert.equal(M.medStatus(vitd, [dose(vitd.id, at(9, 10))], NOW).atMax, true);
});
