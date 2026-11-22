'use strict';
// NHS-based checks and alerts. Pure functions over the event log, so they're easy to test.
// Every rule names its source page; see REVIEW.md for the review dates.

const NHS = {
  firstDays: 'https://www.nhs.uk/baby/breastfeeding-and-bottle-feeding/breastfeeding/the-first-few-days/',
  enoughMilk: 'https://www.nhs.uk/baby/breastfeeding-and-bottle-feeding/breastfeeding-problems/enough-milk/',
  bottle: 'https://www.nhs.uk/baby/breastfeeding-and-bottle-feeding/bottle-feeding/advice/',
  fever: 'https://www.nhs.uk/conditions/fever-in-children/',
  urgent: 'https://www.nhs.uk/baby/health/when-to-get-urgent-medical-help-for-babies-and-children-under-5/',
  jaundice: 'https://www.nhs.uk/conditions/jaundice-newborn/',
  dehydration: 'https://www.nhs.uk/conditions/dehydration/',
  sleep: 'https://www.nhs.uk/baby/caring-for-a-newborn/helping-your-baby-to-sleep/',
  vitamins: 'https://www.nhs.uk/conditions/baby/weaning-and-feeding/vitamins-for-children/',
};

const G_MIN = 60_000, G_HOUR = 60 * G_MIN, G_DAY = 24 * G_HOUR;
const FEED_SESSION_GAP = 30 * G_MIN;

const POO_COLOURS = [
  { id: 'meconium', label: 'Meconium', desc: 'Black-green, sticky', hex: '#2f2b1c' },
  { id: 'green', label: 'Green', desc: '', hex: '#6f7f2c' },
  { id: 'yellow', label: 'Yellow', desc: 'Mustard, seedy', hex: '#d8a62a' },
  { id: 'brown', label: 'Brown', desc: '', hex: '#87572a' },
  { id: 'pale', label: 'Pale', desc: 'White, chalky or creamy', hex: '#ece6cf', flag: true },
  { id: 'red', label: 'Red', desc: 'Or streaks of blood', hex: '#b3261e', flag: true },
  { id: 'black', label: 'Black', desc: 'After the first few days', hex: '#141414', flag: true },
];
const POO_BY_ID = Object.fromEntries(POO_COLOURS.map((p) => [p.id, p]));

const gStartOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Age in whole days (0 on the day of birth), from a YYYY-MM-DD date of birth.
function ageInDays(dob, now = Date.now()) {
  if (!dob) return null;
  const [y, m, d] = dob.split('-').map(Number);
  const birth = new Date(y, m - 1, d).getTime();
  return Math.round((gStartOfDay(now) - birth) / G_DAY);
}

function ageLabel(days) {
  if (days == null) return '';
  if (days < 0) return 'Due soon';
  if (days === 0) return 'Born today';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  if (days < 7 * 13) {
    const w = Math.floor(days / 7), d = days % 7;
    return `${w} week${w === 1 ? '' : 's'}${d ? ` ${d} day${d === 1 ? '' : 's'}` : ''} old`;
  }
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} months old`;
  return `${Math.floor(months / 12)} years old`;
}

const isBreastEv = (e) => e.kind === 'feed' && (e.subtype === 'left' || e.subtype === 'right');
const isTimerEv = (e) => isBreastEv(e) || e.kind === 'sleep';
const isRunningEv = (e) => isTimerEv(e) && e.end_at == null;
const evEnd = (e, now) => (isRunningEv(e) ? now : e.end_at ?? e.start_at);
const isWet = (e) => e.kind === 'nappy' && e.subtype !== 'dirty';
const isPoo = (e) => e.kind === 'nappy' && e.subtype !== 'wet';

// Feeds less than 30 minutes apart (e.g. switching sides, or a top-up) count as one feed.
function feedSessions(events, now = Date.now()) {
  const feeds = events.filter((e) => e.kind === 'feed').sort((a, b) => a.start_at - b.start_at);
  const out = [];
  for (const e of feeds) {
    const last = out[out.length - 1];
    if (last && e.start_at - last.end <= FEED_SESSION_GAP) {
      last.items.push(e);
      last.end = Math.max(last.end, evEnd(e, now));
    } else out.push({ start: e.start_at, end: evEnd(e, now), items: [e] });
  }
  for (const s of out) {
    s.ml = s.items.reduce((a, e) => a + (e.amount_ml || 0), 0);
    s.breastMs = s.items.filter(isBreastEv).reduce((a, e) => a + (evEnd(e, now) - e.start_at), 0);
  }
  return out;
}

// Minutes of sleep that fall inside [from, to).
function sleepMsIn(events, from, to, now = Date.now()) {
  let ms = 0;
  for (const e of events) {
    if (e.kind !== 'sleep') continue;
    const a = Math.max(e.start_at, from), b = Math.min(evEnd(e, now), to);
    if (b > a) ms += b - a;
  }
  return ms;
}

/**
 * Evaluate the log against NHS guidance.
 * Returns { checks: [...], alerts: [...] }.
 *   check: { id, title, value, guide, status: 'ok'|'low'|'info'|'pending'|'todo'|'na', link }
 *   alert: { key, level: 'urgent'|'soon'|'talk', title, body, actions: [{label, href}], link }
 */
function evaluate(events, profile, now = Date.now()) {
  const age = ageInDays(profile.dob, now);
  const known = age != null && age >= 0;
  const earliest = events.reduce((m, e) => Math.min(m, e.start_at), Infinity);
  const covers = (ms) => earliest <= now - ms; // has logging been going for this long?
  const last24 = events.filter((e) => e.start_at > now - G_DAY && e.start_at <= now);
  const checks = [];
  const alerts = [];
  const fmtT = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const pendingText = (h) => `Shows once you've been logging for ${h} hours`;

  // ---------- Feeds in last 24h
  const sessions = feedSessions(events, now).filter((s) => s.start > now - G_DAY);
  const anyBreastMilk = events.some((e) => e.kind === 'feed' && e.subtype !== 'formula' && e.start_at > now - 2 * G_DAY);
  const feedsCheck = { id: 'feeds', title: 'Feeds in the last 24 hours', value: String(sessions.length), link: NHS.firstDays };
  if ((!known || age < 42) && anyBreastMilk) {
    feedsCheck.guide = 'NHS rough guide for the first few weeks: at least 8 to 12, or more';
    feedsCheck.status = !covers(G_DAY) ? 'pending' : sessions.length >= 8 ? 'ok' : 'low';
    if (feedsCheck.status === 'pending') feedsCheck.guide += ` · ${pendingText(24)}`;
  } else {
    feedsCheck.guide = 'Feed responsively, when your baby shows hunger cues';
    feedsCheck.status = 'info';
    feedsCheck.link = NHS.bottle;
  }
  checks.push(feedsCheck);

  // ---------- Wet nappies in last 24h
  const wet24 = last24.filter(isWet).length;
  const wetCheck = { id: 'wet', title: 'Wet nappies in the last 24 hours', value: String(wet24), link: NHS.enoughMilk };
  if (known && age < 2) {
    wetCheck.guide = 'First 48 hours: usually only 2 or 3';
    wetCheck.status = 'info';
  } else if (known && age < 4) {
    wetCheck.guide = 'Rising to at least 6 heavy wet nappies a day from day 5';
    wetCheck.status = 'info';
  } else {
    wetCheck.guide = known ? 'From day 5: at least 6 heavy, wet nappies every 24 hours' : 'Usually about 6 or more a day after the first few days';
    wetCheck.status = !covers(G_DAY) ? 'pending' : wet24 >= 6 ? 'ok' : known ? 'low' : 'info';
    if (wetCheck.status === 'pending') wetCheck.guide += ` · ${pendingText(24)}`;
  }
  checks.push(wetCheck);

  // ---------- Poos in last 24h
  const poo24 = last24.filter(isPoo).length;
  const pooCheck = { id: 'poo', title: 'Poos in the last 24 hours', value: String(poo24), link: NHS.enoughMilk };
  if (known && age >= 3 && age < 42) {
    pooCheck.guide = 'From day 4: at least 2 soft, yellow poos a day, about the size of a £2 coin';
    pooCheck.status = !covers(G_DAY) ? 'pending' : poo24 >= 2 ? 'ok' : 'low';
    if (pooCheck.status === 'pending') pooCheck.guide += ` · ${pendingText(24)}`;
  } else if (known && age < 3) {
    pooCheck.guide = 'First day or two: dark, sticky meconium, then changing to yellow';
    pooCheck.status = 'info';
  } else {
    pooCheck.guide = 'Every baby is different. Note the colour each time';
    pooCheck.status = 'info';
  }
  // A count can look fine while a colour needs attention: say so on the check too.
  const flagged = last24.filter((e) => isPoo(e) && POO_BY_ID[e.poo]?.flag && !(e.poo === 'black' && known && age < 4));
  if (flagged.length) {
    const names = [...new Set(flagged.map((e) => POO_BY_ID[e.poo].label.toLowerCase()))].join(' and ');
    pooCheck.guide += `. Includes ${names} poo: see the advice above`;
    pooCheck.status = 'low';
  }
  checks.push(pooCheck);

  // ---------- Vitamin D (today)
  const formula24 = last24.filter((e) => e.kind === 'feed' && e.subtype === 'formula').reduce((a, e) => a + (e.amount_ml || 0), 0);
  const vitdToday = events.filter((e) => e.kind === 'vitd' && e.start_at >= gStartOfDay(now)).sort((a, b) => b.start_at - a.start_at)[0];
  const vitdCheck = { id: 'vitd', title: 'Vitamin D drops today', link: NHS.vitamins };
  if (formula24 > 500 && !vitdToday) {
    vitdCheck.value = 'Not needed';
    vitdCheck.guide = `${formula24} ml formula in 24 hours. Over 500 ml a day, formula already has enough`;
    vitdCheck.status = 'na';
  } else if (vitdToday) {
    vitdCheck.value = `Given ${fmtT(vitdToday.start_at)}`;
    vitdCheck.guide = 'Breastfed babies: 8.5 to 10 micrograms every day from birth';
    vitdCheck.status = 'ok';
  } else {
    vitdCheck.value = 'Not logged yet';
    vitdCheck.guide = 'Breastfed babies: 8.5 to 10 micrograms every day from birth';
    vitdCheck.status = 'todo';
  }
  checks.push(vitdCheck);

  // ---------- Sleep (information only)
  const slept = sleepMsIn(events, now - G_DAY, now, now);
  if (events.some((e) => e.kind === 'sleep')) {
    const h = Math.floor(slept / G_HOUR), m = Math.round((slept % G_HOUR) / G_MIN);
    checks.push({
      id: 'sleep', title: 'Sleep in the last 24 hours', value: `${h}h ${String(m).padStart(2, '0')}m`,
      guide: 'Newborns sleep about 18 hours in 24, but every baby has their own pattern', status: 'info', link: NHS.sleep,
    });
  }

  // ================= Alerts =================
  const call999 = { label: 'Call 999', href: 'tel:999', urgent: true };
  const call111 = { label: 'Call 111', href: 'tel:111' };

  // Temperature: newest reading in the last 6 hours
  // High readings: use the highest in the last 6h, so a later normal re-check doesn't hide it.
  // Low readings: use the newest, because the NHS says to re-check a low reading.
  const temps = events.filter((e) => e.kind === 'temp').sort((a, b) => b.start_at - a.start_at);
  const recentTemps = temps.filter((x) => x.start_at > now - 6 * G_HOUR);
  const highest = recentTemps.reduce((m, x) => (!m || x.value > m.value ? x : m), null);
  const t = highest && highest.value >= 38 ? highest : recentTemps[0];
  if (t) {
    const ageText = known ? '' : ' Add a date of birth for age-specific advice.';
    if (t.value >= 38 && (!known || age < 91)) {
      alerts.push({
        key: `temp-${t.id}`, level: 'urgent', link: NHS.urgent,
        title: `${t.value.toFixed(1)}°C at ${fmtT(t.start_at)}${known ? ' in a baby under 3 months' : ''}`,
        body: `NHS: 38°C or higher in a baby under 3 months needs medical help straight away. Call 999 or go to A&E (the NHS fever page also says you can call 111).${ageText}`,
        actions: [call999, call111],
      });
    } else if (t.value >= 39 && age < 183) {
      alerts.push({
        key: `temp-${t.id}`, level: 'urgent', link: NHS.urgent,
        title: `${t.value.toFixed(1)}°C at ${fmtT(t.start_at)} at 3–6 months`,
        body: 'NHS: 39°C or higher at 3 to 6 months needs medical help straight away. Call 999 or go to A&E. If they had vaccines in the last 2 days, call 111.',
        actions: [call999, call111],
      });
    } else if (t.value >= 38) {
      alerts.push({
        key: `temp-${t.id}`, level: 'soon', link: NHS.fever,
        title: `High temperature: ${t.value.toFixed(1)}°C at ${fmtT(t.start_at)}`,
        body: 'Keep offering feeds, and don\'t over-wrap them or sponge them down. Call 111 if you\'re worried, if there are other signs of illness, or if it lasts 5 days or more. See Help for the signs that mean you should call 999.',
        actions: [call111],
      });
    } else if (t.value < 36) {
      alerts.push({
        key: `temp-${t.id}`, level: 'urgent', link: NHS.urgent,
        title: `Low temperature: ${t.value.toFixed(1)}°C at ${fmtT(t.start_at)}`,
        body: 'NHS: check it 2 more times within 10 minutes, under the arm. If it stays below 36°C, or they feel cold, clammy or shivery, call 999 or go to A&E.',
        actions: [call999],
      });
    }
  }
  // 38C+ on each of the last 5 days (3 months and over)
  if (known && age >= 91) {
    let days = 0;
    for (let i = 0; i < 5; i++) {
      const from = gStartOfDay(now) - i * G_DAY, to = from + G_DAY;
      if (temps.some((x) => x.value >= 38 && x.start_at >= from && x.start_at < to)) days++;
    }
    if (days === 5) alerts.push({
      key: `fever5-${gStartOfDay(now)}`, level: 'soon', link: NHS.fever,
      title: 'High temperature logged on 5 days in a row',
      body: 'NHS: call 111 if a high temperature lasts 5 days or more.', actions: [call111],
    });
  }

  // No wet nappy in 12h
  const lastWet = events.filter(isWet).reduce((m, e) => Math.max(m, e.start_at), -Infinity);
  if (covers(12 * G_HOUR) && now - lastWet > 12 * G_HOUR && events.some((e) => e.kind === 'nappy' || e.kind === 'feed')) {
    alerts.push({
      key: `nowet-${lastWet}`, level: 'urgent', link: NHS.urgent,
      title: isFinite(lastWet) ? `No wet nappy logged since ${fmtT(lastWet)}` : 'No wet nappy logged in the last 12 hours',
      body: 'If your baby really hasn\'t had a wet nappy in 12 hours, and it isn\'t just that it wasn\'t logged, the NHS lists this as a reason to call 999 or go to A&E.',
      actions: [call999],
    });
  }

  // Pale poo (last 72h)
  const pale = events.find((e) => isPoo(e) && e.poo === 'pale' && e.start_at > now - 3 * G_DAY);
  if (pale) alerts.push({
    key: `pale-${pale.id}`, level: 'soon', link: NHS.jaundice,
    title: `Pale poo logged at ${fmtT(pale.start_at)}`,
    body: 'NHS: pale, creamy or chalky poo needs an urgent GP or midwife appointment, or call 111. Keep the nappy to show them.',
    actions: [call111],
  });

  // Dark pee (last 48h)
  const dark = events.find((e) => isWet(e) && e.pee === 'dark' && e.start_at > now - 2 * G_DAY);
  if (dark) alerts.push({
    key: `dark-${dark.id}`, level: 'soon', link: NHS.jaundice,
    title: `Dark yellow or brown pee logged at ${fmtT(dark.start_at)}`,
    body: 'NHS: this can be a sign of jaundice or dehydration. Get an urgent GP or midwife appointment, or call 111.',
    actions: [call111],
  });

  // Red, or black after the meconium days (last 48h)
  const redBlack = events.find(
    (e) => isPoo(e) && (e.poo === 'red' || (e.poo === 'black' && (!known || age >= 4))) && e.start_at > now - 2 * G_DAY
  );
  if (redBlack) alerts.push({
    key: `rb-${redBlack.id}`, level: 'talk', link: NHS.urgent,
    title: `${redBlack.poo === 'red' ? 'Red' : 'Black'} poo logged at ${fmtT(redBlack.start_at)}`,
    body: 'If you\'re not sure why, or you\'re worried, call NHS 111 for advice.',
    actions: [call111],
  });

  // No poo for 2 days, under 8 weeks
  if (known && age < 56 && age >= 3 && covers(2 * G_DAY)) {
    const lastPoo = events.filter(isPoo).reduce((m, e) => Math.max(m, e.start_at), -Infinity);
    if (now - lastPoo > 2 * G_DAY) alerts.push({
      key: `nopoo-${lastPoo}`, level: 'talk', link: NHS.bottle,
      title: 'No poo logged for 2 days',
      body: 'NHS: if your baby is under 8 weeks and hasn\'t pooed for 2 to 3 days, talk to your midwife, health visitor or GP, especially if they\'re gaining weight slowly.',
      actions: [],
    });
  }

  const order = { urgent: 0, soon: 1, talk: 2 };
  alerts.sort((a, b) => order[a.level] - order[b.level]);
  return { checks, alerts, age };
}

if (typeof module !== 'undefined') module.exports = { evaluate, feedSessions, sleepMsIn, ageInDays, ageLabel, POO_COLOURS };
