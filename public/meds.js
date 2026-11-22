'use strict';
// Mum's medicines: what counts as a valid medicine, and when the next dose is due.
// Shared by the phones (showing "next dose from 14:20") and the home server (sending reminders).

const BabyMeds = (() => {
  const M_MIN = 60_000, M_HOUR = 60 * M_MIN, M_DAY = 24 * M_HOUR;
  const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  // A set-time dose counts if it's taken from 2 hours before its time onwards.
  const EARLY = 2 * M_HOUR;
  // A missed set-time dose stops showing as "due" (and stops reminding) 6 hours after its time.
  const LATE = 6 * M_HOUR;

  // Starting points, from nhs.uk (read 22 November 2026). The form says to follow the
  // prescription or leaflet if it differs; Mum can change every field.
  const PRESETS = [
    {
      id: 'paracetamol', name: 'Paracetamol', dose: '1 or 2 × 500mg tablets', schedule: 'gap', every_h: 4, max_day: 4,
      note: 'NHS: leave at least 4 hours between doses and take no more than 8 × 500mg tablets in 24 hours. Paracetamol is usually the best painkiller to take while breastfeeding.',
      link: 'https://www.nhs.uk/medicines/paracetamol-for-adults/',
    },
    {
      id: 'ibuprofen', name: 'Ibuprofen', dose: '1 or 2 × 200mg tablets', schedule: 'gap', every_h: 4, max_day: 3,
      note: 'NHS: up to 3 times a day, at least 4 hours apart, no more than 6 × 200mg tablets in 24 hours. If you\'re breastfeeding, check with a pharmacist or doctor before taking ibuprofen.',
      link: 'https://www.nhs.uk/medicines/ibuprofen-for-adults/',
    },
    {
      id: 'vitamin-d', name: 'Vitamin D', dose: '10 micrograms', schedule: 'times', times: ['09:00'], max_day: 1,
      note: 'The NHS advises everyone, including breastfeeding women, to consider a daily 10 microgram vitamin D supplement, especially in autumn and winter.',
      link: 'https://www.nhs.uk/conditions/vitamins-and-minerals/vitamin-d/',
    },
  ];

  const blank = (v) => v === null || v === undefined || v === '';

  // Coerce untrusted input into a medicine record (without id or timestamps).
  function cleanMed(src) {
    const schedule = src.schedule === 'times' ? 'times' : 'gap';
    const times = Array.isArray(src.times) ? [...new Set(src.times.map(String))].sort() : [];
    return {
      name: String(src.name ?? '').trim().slice(0, 40),
      dose: String(src.dose ?? '').trim().slice(0, 40),
      schedule,
      every_h: schedule === 'gap' && !blank(src.every_h) ? Number(src.every_h) : null,
      max_day: blank(src.max_day) ? null : Number(src.max_day),
      times: schedule === 'times' ? times : [],
      remind: !!src.remind,
      active: src.active === undefined ? true : !!src.active,
    };
  }

  // Returns an error message, or null when the medicine is fine.
  function validateMed(m) {
    if (!m.name) return 'Give the medicine a name';
    if (m.schedule === 'gap') {
      if (m.every_h == null) return 'Enter the hours to leave between doses';
      if (!(m.every_h >= 0.5 && m.every_h <= 72)) return 'Hours between doses must be from 0.5 to 72';
    } else {
      if (!m.times.length) return 'Add at least one time';
      if (m.times.length > 6) return 'Up to 6 times a day';
      if (!m.times.every((t) => TIME_RE.test(t))) return 'Times must look like 08:00';
    }
    if (m.max_day != null && !(Number.isInteger(m.max_day) && m.max_day >= 1 && m.max_day <= 24))
      return 'Most doses in 24 hours must be a whole number from 1 to 24';
    return null;
  }

  // "HH:MM" on the day containing t, as epoch ms (local time).
  function at(t, hhmm) {
    const d = new Date(t);
    const [h, m] = hhmm.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // The set-time slots from yesterday to tomorrow, oldest first.
  function slotsAround(med, now) {
    const out = [];
    for (const dayShift of [-1, 0, 1]) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayShift);
      for (const t of med.times) out.push(at(d.getTime(), t));
    }
    return out.sort((a, b) => a - b);
  }

  // Where a medicine stands right now, from its doses (events with kind 'med').
  //   last: last dose time · count24: doses in the last 24 hours
  //   nextAt: when the next dose is allowed (gap) or scheduled (times); null = any time
  //   dueAt: when a reminder should fire (null = nothing to remind about)
  //   tooSoon / atMax: why logging a dose now deserves a second look
  function medStatus(med, doses, now = Date.now()) {
    const mine = doses.filter((d) => d.med === med.id && !d.deleted_at && d.start_at <= now).sort((a, b) => a.start_at - b.start_at);
    const last = mine.length ? mine[mine.length - 1].start_at : null;
    const window24 = mine.filter((d) => d.start_at > now - M_DAY);
    const count24 = window24.length;
    const atMax = med.max_day != null && count24 >= med.max_day;
    // With the 24-hour limit reached, the next dose is allowed once the oldest one in the window drops out.
    const maxFreeAt = atMax ? window24[window24.length - med.max_day].start_at + M_DAY : null;
    const st = { last, count24, atMax, tooSoon: false, nextAt: null, dueAt: null, slot: null };

    if (med.schedule === 'gap') {
      const gapAt = last != null ? last + med.every_h * M_HOUR : null;
      st.tooSoon = gapAt != null && now < gapAt;
      const next = Math.max(gapAt ?? 0, maxFreeAt ?? 0) || null;
      st.nextAt = next;
      st.dueAt = last != null ? next : null; // a "can take again" reminder only once a dose has been taken
      return st;
    }

    // Set times: a slot is covered by a dose taken from 2 hours before it until 2 hours before the next slot.
    const slots = slotsAround(med, now);
    const covered = (i) => {
      const from = slots[i] - EARLY, to = i + 1 < slots.length ? slots[i + 1] - EARLY : Infinity;
      return mine.some((d) => d.start_at >= from && d.start_at < to);
    };
    for (let i = 0; i < slots.length; i++) {
      if (covered(i)) continue;
      if (slots[i] <= now && now - slots[i] < LATE) { st.slot = slots[i]; st.dueAt = slots[i]; st.nextAt = slots[i]; break; }
      if (slots[i] > now) {
        if (slots[i] - EARLY <= now) st.slot = slots[i]; // within the early window: taking it now counts for this slot
        st.nextAt = slots[i];
        st.dueAt = slots[i];
        break;
      }
    }
    // Taking a set-time dose early (or a dose with no slot to count against) deserves a second look.
    st.tooSoon = st.slot == null && last != null && now - last < EARLY;
    return st;
  }

  return { PRESETS, ID_RE, TIME_RE, cleanMed, validateMed, medStatus };
})();

if (typeof module !== 'undefined') module.exports = BabyMeds;
