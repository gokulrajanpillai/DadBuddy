'use strict';
// Entry rules shared by the phone (validating before saving offline) and the server
// (validating what phones sync). One copy, so both always agree.

const BabyRules = (() => {
  const SUBTYPES = {
    feed: ['left', 'right', 'expressed', 'formula'],
    nappy: ['wet', 'dirty', 'both'],
    sleep: ['sleep'],
    temp: ['armpit'],
    weight: ['weight'],
    vitd: ['drops'],
  };
  const POO = ['meconium', 'green', 'yellow', 'brown', 'pale', 'red', 'black'];
  const BREAST = ['left', 'right'];
  const WHO = ['mum', 'dad'];
  const FIELDS = ['kind', 'subtype', 'start_at', 'end_at', 'amount_ml', 'value', 'poo', 'pee', 'note'];
  const MAX_TIMER_H = { feed: 6, sleep: 16 };

  const isTimer = (e) => (e.kind === 'feed' && BREAST.includes(e.subtype)) || e.kind === 'sleep';
  const blank = (v) => v === null || v === undefined || v === '';
  const toNum = (v) => (blank(v) ? null : Number(v));

  // Pick the entry fields from untrusted input and coerce their types.
  function pick(src, base = {}) {
    const e = { ...base };
    for (const k of ['kind', 'subtype', 'note', 'poo', 'pee']) if (k in src) e[k] = src[k];
    for (const k of ['start_at', 'end_at', 'amount_ml', 'value']) if (k in src) e[k] = toNum(src[k]);
    return e;
  }

  // Keep only the fields that make sense for the entry's kind.
  function normalise(e) {
    const out = { ...e };
    const keep = {
      amount_ml: e.kind === 'feed' && !BREAST.includes(e.subtype),
      end_at: isTimer(e),
      value: e.kind === 'temp' || e.kind === 'weight',
      poo: e.kind === 'nappy' && e.subtype !== 'wet',
      pee: e.kind === 'nappy' && e.subtype !== 'dirty',
    };
    for (const [k, ok] of Object.entries(keep)) if (!ok || out[k] === undefined) out[k] = ok ? out[k] ?? null : null;
    if (typeof out.value === 'number') out.value = Math.round(out.value * 100) / 100;
    out.note = typeof out.note === 'string' && out.note.trim() ? out.note.trim() : null;
    out.poo = out.poo || null;
    out.pee = out.pee || null;
    return out;
  }

  // Returns an error message, or null when the entry is fine.
  function validateEvent(e, now = Date.now()) {
    if (!SUBTYPES[e.kind]) return `kind must be one of ${Object.keys(SUBTYPES).join(', ')}`;
    if (!SUBTYPES[e.kind].includes(e.subtype)) return `subtype must be one of ${SUBTYPES[e.kind].join(', ')}`;
    if (!Number.isSafeInteger(e.start_at) || e.start_at <= 0) return 'start_at must be epoch milliseconds';
    if (e.start_at > now + 5 * 60_000) return 'The time cannot be in the future';
    if (e.end_at != null) {
      if (!Number.isSafeInteger(e.end_at)) return 'end_at must be epoch milliseconds';
      if (e.end_at < e.start_at) return 'The end must be after the start';
      const maxH = MAX_TIMER_H[e.kind] || 6;
      if (e.end_at - e.start_at > maxH * 3600_000) return `That is longer than ${maxH} hours — check the times`;
    }
    if (e.amount_ml != null && (!Number.isInteger(e.amount_ml) || e.amount_ml < 0 || e.amount_ml > 500))
      return 'Amount must be 0–500 ml';
    if (e.kind === 'temp' && !(typeof e.value === 'number' && e.value >= 30 && e.value <= 45))
      return 'Temperature must be between 30 and 45 °C';
    if (e.kind === 'weight' && !(typeof e.value === 'number' && e.value >= 0.4 && e.value <= 30))
      return 'Weight must be between 0.4 and 30 kg';
    if (e.poo != null && !POO.includes(e.poo)) return `poo must be one of ${POO.join(', ')}`;
    if (e.pee != null && e.pee !== 'dark') return "pee must be 'dark' or empty";
    if (e.note != null && (typeof e.note !== 'string' || e.note.length > 500)) return 'Notes can be up to 500 characters';
    return null;
  }

  return { SUBTYPES, POO, BREAST, WHO, FIELDS, MAX_TIMER_H, isTimer, pick, normalise, validateEvent };
})();

if (typeof module !== 'undefined') module.exports = BabyRules;
