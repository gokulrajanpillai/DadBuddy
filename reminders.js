// Which reminders are due for one phone, from the log. Pure, so it's easy to test.
// The home server runs this every half minute for each phone with reminders on, and sends
// each reminder once (its `key` changes when something new is logged).

const MIN = 60_000, HOUR = 60 * MIN;
// A reminder that became due longer ago than this is skipped, so turning reminders on
// (or the PC waking up) doesn't send a pile of stale ones.
export const WINDOW = 2 * HOUR;

export const DEFAULT_PREFS = {
  feed: { on: false, hours: 3 },
  nappy: { on: false, hours: 3 },
  meds: { on: false },
  vitd: { on: false, at: '10:00' },
};
const FEED_HOURS = [2, 2.5, 3, 3.5, 4];
const NAPPY_HOURS = [2, 3, 4];

// Coerce untrusted preferences from a phone.
export function cleanPrefs(src = {}, who = 'mum') {
  const d = structuredClone(DEFAULT_PREFS);
  if (who === 'mum') d.meds.on = true;
  const on = (k) => (src[k] && typeof src[k].on === 'boolean' ? src[k].on : d[k].on);
  const pick = (v, list, dflt) => (list.includes(Number(v)) ? Number(v) : dflt);
  return {
    feed: { on: on('feed'), hours: pick(src.feed?.hours, FEED_HOURS, d.feed.hours) },
    nappy: { on: on('nappy'), hours: pick(src.nappy?.hours, NAPPY_HOURS, d.nappy.hours) },
    meds: { on: on('meds') },
    vitd: { on: on('vitd'), at: /^([01]\d|2[0-3]):[0-5]\d$/.test(src.vitd?.at) ? src.vitd.at : d.vitd.at },
  };
}

const fresh = (dueAt, now) => dueAt != null && now >= dueAt && now - dueAt < WINDOW;
const ago = (ms) => {
  const m = Math.round(ms / MIN), h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}m` : ''}` : `${m} min`;
};
const fmtH = (h) => `${h} ${h === 1 ? 'hour' : 'hours'}`;

// ctx: { events (live, not deleted), meds, profile, prefs, now, feedSessions, evaluate, medStatus, fmtTime, babyName }
export function dueReminders(ctx) {
  const { events, meds, prefs, now, fmtTime } = ctx;
  const baby = ctx.babyName && ctx.babyName !== 'Baby' ? ctx.babyName : 'Baby';
  const out = [];

  if (prefs.feed.on) {
    const running = events.some((e) => e.kind === 'feed' && (e.subtype === 'left' || e.subtype === 'right') && e.end_at == null);
    const last = ctx.feedSessions(events, now).pop();
    const dueAt = last && last.start + prefs.feed.hours * HOUR;
    if (last && !running && fresh(dueAt, now)) {
      out.push({
        key: `feed:${last.items[0].uid}:${prefs.feed.hours}`,
        tag: 'feed',
        title: `${fmtH(prefs.feed.hours)} since ${baby}'s last feed`,
        body: `The last feed started at ${fmtTime(last.start)}. Watch for early hunger cues: stirring, rooting, sucking fists.`,
      });
    }
  }

  if (prefs.nappy.on) {
    const last = events.filter((e) => e.kind === 'nappy').sort((a, b) => b.start_at - a.start_at)[0];
    const dueAt = last && last.start_at + prefs.nappy.hours * HOUR;
    if (last && fresh(dueAt, now)) {
      out.push({
        key: `nappy:${last.uid}:${prefs.nappy.hours}`,
        tag: 'nappy',
        title: 'Time for a nappy check',
        body: `The last change was at ${fmtTime(last.start_at)}, ${ago(now - last.start_at)} ago.`,
      });
    }
  }

  if (prefs.meds.on) {
    const doses = events.filter((e) => e.kind === 'med');
    for (const m of meds) {
      if (!m.active || !m.remind) continue;
      const st = ctx.medStatus(m, doses, now);
      if (!fresh(st.dueAt, now)) continue;
      const lastBit = st.last ? `Last dose at ${fmtTime(st.last)}.` : '';
      out.push(m.schedule === 'times'
        ? { key: `med:${m.id}:${st.dueAt}`, tag: `med-${m.id}`, title: `${m.name} is due (${fmtTime(st.dueAt)})`,
            body: [m.dose, lastBit].filter(Boolean).join('. ').replace(/\.\./g, '.') }
        : { key: `med:${m.id}:${st.dueAt}`, tag: `med-${m.id}`, title: `Mum can take ${m.name} again`,
            body: [lastBit, m.dose ? `Dose: ${m.dose}.` : ''].filter(Boolean).join(' ') });
    }
  }

  if (prefs.vitd.on) {
    const [h, mm] = prefs.vitd.at.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    const dueAt = d.getTime();
    // Only when today's check says it's still to do (it knows about formula over 500 ml, and age).
    const check = ctx.evaluate(events, ctx.profile, now).checks.find((c) => c.id === 'vitd');
    if (check?.status === 'todo' && fresh(dueAt, now)) {
      out.push({
        key: `vitd:${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`,
        tag: 'vitd',
        title: `Vitamin D drops for ${baby}`,
        body: 'Not logged yet today.',
      });
    }
  }
  return out;
}
