'use strict';
/* global evaluate, feedSessions, sleepMsIn, ageInDays, ageLabel, POO_COLOURS, POO_BY_ID, BabyRules, Store */

// ------------------------------------------------------------ constants & helpers

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const BREAST = ['left', 'right'];
const KINDS = [
  ['feed', 'Feed'], ['nappy', 'Nappy'], ['sleep', 'Sleep'],
  ['temp', 'Temp'], ['weight', 'Weight'], ['vitd', 'Vitamin D'],
];
const SUBTYPES = {
  feed: [['left', 'Left'], ['right', 'Right'], ['expressed', 'Expressed'], ['formula', 'Formula']],
  nappy: [['wet', 'Wet'], ['dirty', 'Dirty'], ['both', 'Both']],
  sleep: [['sleep', 'Sleep']], temp: [['armpit', 'Armpit']], weight: [['weight', 'Weight']], vitd: [['drops', 'Drops']],
};
const LABEL = {
  left: 'Left breast', right: 'Right breast', expressed: 'Expressed milk', formula: 'Formula',
  wet: 'Wet nappy', dirty: 'Dirty nappy', both: 'Wet and dirty nappy',
  sleep: 'Sleep', armpit: 'Temperature', weight: 'Weight', drops: 'Vitamin D drops',
};
const ICON = {
  left: 'i-breast', right: 'i-breast', expressed: 'i-bottle', formula: 'i-bottle',
  wet: 'i-drop', dirty: 'i-nappy', both: 'i-nappy', sleep: 'i-moon', armpit: 'i-thermo', weight: 'i-scale', drops: 'i-sun',
};
const GROUP = { feed: 'feed', nappy: 'nappy', sleep: 'sleep', temp: 'health', weight: 'health', vitd: 'health' };
const WHO_NAME = { mum: 'Mum', dad: 'Dad' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
const isBreast = (e) => e.kind === 'feed' && BREAST.includes(e.subtype);
const isTimer = (e) => isBreast(e) || e.kind === 'sleep';
const isRunning = (e) => isTimer(e) && e.end_at == null;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : null);
const storage = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const shortDayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const fmtTime = (t) => timeFmt.format(t);

function fmtDur(ms, short = false) {
  if (ms == null || !isFinite(ms)) return '—';
  const totalMin = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h === 0) return short ? `${m}m` : `${m} min`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
const fmtAgo = (t) => (Date.now() - t < MIN ? 'Just now' : `${fmtDur(Date.now() - t, true)} ago`);
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
function dayLabel(t) {
  const today = startOfDay(Date.now()), d = startOfDay(t);
  if (d === today) return 'Today';
  if (d === addDays(today, -1)) return 'Yesterday';
  return dayFmt.format(t);
}
function toLocalInput(t) {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * MIN).toISOString().slice(0, 16);
}

// ------------------------------------------------------------ state & API

const state = {
  who: null,
  profile: { babyName: 'Baby', dob: null, birthWeightKg: null },
  events: [],
  days: 30,
  view: 'today',
  filter: 'all',
  sync: { home: false, pending: 0, lastSyncAt: null },
};
const STALE_MS = 15 * MIN; // after this, say that the other phone's entries may be missing

// Talk to the home server. Fails fast (and quietly) when the phone isn't on the home network.
async function net(method, url, body, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
    const isJson = (res.headers.get('content-type') || '').includes('json');
    const data = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (!err.status) err.offline = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Read this phone's copy of the log into state and redraw.
async function load() {
  const all = await Store.allEvents();
  const cutoff = Date.now() - state.days * DAY;
  state.events = all.filter((e) => !e.deleted_at && e.start_at >= cutoff).sort((a, b) => b.start_at - a.start_at);
  state.sync.pending = await Store.outboxCount();
  if (state.who) renderAll();
}

const newUid = () => (crypto.randomUUID ? crypto.randomUUID()
  : [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-'));
const fieldsOf = (e) => Object.fromEntries(BabyRules.FIELDS.map((k) => [k, e[k] ?? null]));
const timerGroup = (e) => (e.kind === 'sleep' ? 'sleep' : 'feed');

// Create (no existing) or change an entry on this phone, then sync when home.
async function saveEvent(fields, existing) {
  const now = Date.now();
  const e = BabyRules.normalise(BabyRules.pick(fields, existing ? fieldsOf(existing) : { start_at: now, end_at: null }));
  const err = BabyRules.validateEvent(e, now);
  if (err) throw new Error(err);
  if (isTimer(e) && e.end_at == null) {
    const other = running(timerGroup(e));
    if (other && other.uid !== existing?.uid) throw new Error('That timer is already running');
  }
  const row = existing
    ? { ...existing, ...e, updated_at: now }
    : { uid: newUid(), ...e, by: state.who, created_at: now, updated_at: now, deleted_at: null, rev: 0 };
  await Store.saveLocal(row, { op: 'upsert', uid: row.uid, by: row.by, created_at: row.created_at, updated_at: now, ...fieldsOf(row) });
  await load();
  sync();
  return row;
}

async function removeEvent(e) {
  const now = Date.now();
  await Store.saveLocal({ ...e, deleted_at: now, updated_at: now }, { op: 'delete', uid: e.uid, updated_at: now });
  await load();
  sync();
}

// ------------------------------------------------------------ sync with the home server
// Push this phone's waiting changes, then pull everything that changed since the last pull.
// Away from home the server can't be reached, so changes simply wait in the outbox.

let syncing = null, syncAgain = false, stream = null;
async function sync() {
  if (!state.who) return;
  if (syncing) { syncAgain = true; return syncing; }
  syncing = (async () => {
    try {
      await pushAndPull();
    } catch (err) {
      if (err.status === 401) {
        try { await net('POST', '/api/login', { who: state.who }); await pushAndPull(); } catch { goneAway(); }
      } else goneAway();
    } finally {
      syncing = null;
      await load();
      if (syncAgain) { syncAgain = false; sync(); }
    }
  })();
  return syncing;
}

async function pushAndPull() {
  for (;;) {
    const batch = await Store.outbox(500);
    if (!batch.length) break;
    const r = await net('POST', '/api/sync', { ops: batch.map((b) => b.op) }, 15000);
    await Store.ack(batch.map((b) => b.seq));
    for (const x of r.results.filter((x) => !x.ok)) {
      await Store.revert(x.uid, x.current);
      toast(`An entry from this phone couldn't be saved: ${x.error}`);
    }
  }
  let since = (await Store.getMeta('rev')) || 0, more = true;
  while (more) {
    const r = await net('GET', `/api/sync?since=${since}`, null, 15000);
    await Store.mergeRemote(r.events, r.rev, r.profile);
    state.profile = r.profile;
    since = r.rev;
    more = r.more;
  }
  state.sync.home = true;
  state.sync.lastSyncAt = Date.now();
  await Store.setMeta('lastSyncAt', state.sync.lastSyncAt);
  openStream();
}

function goneAway() {
  state.sync.home = false;
  if (stream) { stream.close(); stream = null; }
}

// Live updates while at home: the server says "changed" and this phone pulls.
function openStream() {
  if (stream) return;
  stream = new EventSource('/api/stream');
  let t;
  stream.onmessage = () => { clearTimeout(t); t = setTimeout(sync, 150); };
  stream.onerror = () => { goneAway(); renderSyncBar(); };
}

const running = (kind) => state.events.find((e) => isRunning(e) && (kind === 'sleep' ? e.kind === 'sleep' : isBreast(e)));
const byTimeAsc = (list) => [...list].sort((a, b) => a.start_at - b.start_at);

// ------------------------------------------------------------ rendering

function renderAll() {
  renderHeader();
  renderSyncBar();
  renderToday();
  if (state.view === 'trends') renderTrends();
  if (state.view === 'history') renderHistory();
  tick();
}

function renderHeader() {
  const p = state.profile;
  $('#baby-name').textContent = p.babyName;
  $('#baby-age').textContent = p.dob ? ageLabel(ageInDays(p.dob)) : 'Add date of birth';
  document.title = `${p.babyName} · Baby Log`;
  $('#who-chip').innerHTML = `<span class="avatar sm ${state.who}">${WHO_NAME[state.who][0]}</span>${WHO_NAME[state.who]}`;
}

function syncText() {
  const { home, pending, lastSyncAt } = state.sync;
  const last = lastSyncAt ? `last synced ${dayLabel(lastSyncAt) === 'Today' ? fmtTime(lastSyncAt) : `${dateFmt.format(lastSyncAt)} ${fmtTime(lastSyncAt)}`}` : 'not synced yet';
  const waiting = pending ? `${pending} ${pending === 1 ? 'change' : 'changes'} to sync` : '';
  if (home) return { cls: pending ? 'busy' : 'ok', text: pending ? `Syncing ${waiting}…` : 'Synced with home' };
  return { cls: 'away', text: ['Away from home', waiting, last].filter(Boolean).join(' · ') };
}
function renderSyncBar() {
  const bar = $('#sync-bar');
  if (!bar || !state.who) return;
  const { cls, text } = syncText();
  bar.className = `sync-bar ${cls}`;
  $('#sync-text').textContent = text;
  // Shown only when it matters: away, or changes still waiting.
  bar.hidden = cls === 'ok';
}
// Checks and alerts can only see what has reached this phone.
function staleNote() {
  const { home, lastSyncAt } = state.sync;
  if (home && Date.now() - (lastSyncAt || 0) < STALE_MS) return '';
  const since = lastSyncAt ? `since ${fmtTime(lastSyncAt)}${dayLabel(lastSyncAt) === 'Today' ? '' : ` on ${dateFmt.format(lastSyncAt)}`}` : '';
  return `<p class="stale-note">${icon('i-clock')}<span>Entries from the other phone ${since} aren't included until you're both home. Bear this in mind with the checks and alerts below.</span></p>`;
}

function eventMeta(e, gap) {
  const meta = [];
  if (e.kind === 'feed') {
    if (isRunning(e)) meta.push(`<span class="live" data-timer="${e.start_at}"></span> in progress`);
    else if (isBreast(e)) meta.push(fmtDur(e.end_at - e.start_at));
    if (e.amount_ml != null) meta.push(`${e.amount_ml} ml`);
    if (gap != null) meta.push(`${fmtDur(gap, true)} after the last feed`);
  } else if (e.kind === 'nappy') {
    if (e.poo) {
      const p = POO_BY_ID[e.poo];
      meta.push(`<i class="poo-dot" style="background:${p.hex}"></i>${p.label} poo${p.flag ? ' <span class="flag-txt">· check Help</span>' : ''}`);
    }
    if (e.pee === 'dark') meta.push('<span class="flag-txt">Dark pee</span>');
  } else if (e.kind === 'sleep') {
    meta.push(isRunning(e) ? `<span class="live" data-timer="${e.start_at}"></span> asleep now` : fmtDur(e.end_at - e.start_at));
  } else if (e.kind === 'temp') {
    const flag = e.value >= 38 ? ' <span class="flag-txt">· high</span>' : e.value < 36 ? ' <span class="flag-txt">· low</span>' : '';
    meta.push(`${e.value.toFixed(1)}°C${flag}`);
  } else if (e.kind === 'weight') {
    const bw = state.profile.birthWeightKg;
    meta.push(`${e.value.toFixed(2)} kg${bw ? ` · ${e.value >= bw ? '+' : '−'}${Math.round(Math.abs(e.value - bw) * 1000)} g from birth` : ''}`);
  }
  if (e.note) meta.push(esc(e.note));
  return meta;
}

function eventRow(e, gap) {
  const meta = eventMeta(e, gap);
  return `<li class="event" data-id="${e.uid}" role="button" tabindex="0" aria-label="Edit ${LABEL[e.subtype]} at ${fmtTime(e.start_at)}">
    <time>${fmtTime(e.start_at)}</time>
    <span class="kind-ic ${GROUP[e.kind]}">${icon(ICON[e.subtype])}</span>
    <span class="what"><b>${LABEL[e.subtype]}</b>${meta.length ? `<span class="meta">${meta.join(' · ')}</span>` : ''}</span>
    <span class="avatar sm ${e.by}" title="${WHO_NAME[e.by]}">${WHO_NAME[e.by][0]}</span>
  </li>`;
}

function sessionGapsById() {
  const ss = feedSessions(state.events);
  const map = new Map();
  for (let i = 1; i < ss.length; i++) map.set(ss[i].items[0].uid, ss[i].start - ss[i - 1].start);
  return map;
}

function renderToday() {
  const now = Date.now();
  const runFeed = running('feed');
  const runSleep = running('sleep');
  const { checks, alerts } = evaluate(state.events, state.profile, now);

  // ---- Alerts
  const dismissed = new Set(storage.get('dismissedAlerts', []));
  const levelText = { urgent: 'Get help now', soon: 'Get advice today', talk: 'Worth mentioning' };
  const shown = alerts.filter((a) => !dismissed.has(a.key));
  // The "other phone" caveat sits next to what it qualifies: alerts if any, otherwise the checks.
  const stale = staleNote();
  $('#checks-stale').innerHTML = shown.length ? '' : stale;
  $('#alerts').innerHTML = (shown.length ? stale : '') + shown
    .map((a) => `<section class="alert ${a.level}" role="${a.level === 'urgent' ? 'alert' : 'status'}">
      <div class="alert-head">${icon('i-alert')}<div><span class="alert-level">${levelText[a.level]}</span><h3>${esc(a.title)}</h3></div></div>
      <p>${esc(a.body)}</p>
      <div class="alert-actions">
        ${a.actions.map((x) => `<a class="call ${x.urgent ? 'urgent' : ''}" href="${x.href}">${x.label}</a>`).join('')}
        <a class="src-link" href="${a.link}" target="_blank" rel="noopener">NHS advice</a>
        <span class="spacer"></span>
        <button class="text-btn" data-dismiss="${esc(a.key)}">Dismiss</button>
      </div>
    </section>`)
    .join('');

  // ---- Setup prompt
  $('#setup-card').innerHTML = !state.profile.dob && !storage.get('setupLater', false)
    ? `<div class="setup"><p>Add your baby's date of birth so the checks match NHS guidance for their age.</p>
        <span class="row"><button class="mini-btn" data-open="settings">Add</button><button class="text-btn" data-setup-later>Later</button></span></div>`
    : '';

  // ---- Timers
  let timers = '';
  if (runFeed) {
    timers += `<div class="timer feed">
      <div class="timer-label">${icon('i-breast')}Feeding · ${LABEL[runFeed.subtype]}</div>
      <div class="timer-clock" data-timer="${runFeed.start_at}">00:00</div>
      <p class="timer-sub">Started ${fmtTime(runFeed.start_at)} by ${WHO_NAME[runFeed.by]}</p>
      <div class="timer-actions">
        <button data-act="switch">Switch to ${runFeed.subtype === 'left' ? 'right' : 'left'}</button>
        <button class="primary" data-act="stop-feed">Finish feed</button>
        <button class="discard" data-act="discard-feed" aria-label="Discard this feed">${icon('i-x')}</button>
      </div>
    </div>`;
  }
  if (runSleep) {
    timers += `<div class="timer sleep">
      <div class="timer-label">${icon('i-moon')}Asleep</div>
      <div class="timer-clock" data-timer="${runSleep.start_at}">00:00</div>
      <p class="timer-sub">Fell asleep ${fmtTime(runSleep.start_at)} · logged by ${WHO_NAME[runSleep.by]}</p>
      <div class="timer-actions two">
        <button class="primary" data-act="stop-sleep">Woke up</button>
        <button class="discard" data-act="discard-sleep" aria-label="Discard this sleep">${icon('i-x')}</button>
      </div>
      <p class="safe-sleep">Safe sleep: on their back, feet to the foot of a clear, flat cot, in your room. <a href="#help-sleep" data-goto="help">More</a></p>
    </div>`;
  }
  $('#timers').innerHTML = timers;

  // ---- Status: feed
  const ss = feedSessions(state.events, now);
  const lastS = ss[ss.length - 1];
  const feedAgo = $('#last-feed-ago'), feedDetail = $('#last-feed-detail');
  if (runFeed) {
    feedAgo.textContent = 'Now';
    const prev = ss[ss.length - 2];
    feedDetail.textContent = prev ? `${fmtDur(lastS.start - prev.start, true)} after the last feed` : 'Feeding';
  } else if (lastS) {
    feedAgo.innerHTML = `<span data-ago="${lastS.start}"></span>`;
    const sides = [...new Set(lastS.items.map((e) => (isBreast(e) ? (e.subtype === 'left' ? 'L' : 'R') : LABEL[e.subtype])))].join('+');
    const bits = [`${fmtTime(lastS.start)} · ${sides}`];
    if (lastS.breastMs) bits.push(fmtDur(lastS.breastMs, true));
    if (lastS.ml) bits.push(`${lastS.ml} ml`);
    feedDetail.textContent = bits.join(' · ');
  } else {
    feedAgo.textContent = '—';
    feedDetail.textContent = 'Nothing logged yet';
  }

  // ---- Status: nappy
  const nappies = byTimeAsc(state.events.filter((e) => e.kind === 'nappy'));
  const lastN = nappies[nappies.length - 1];
  if (lastN) {
    $('#last-nappy-ago').innerHTML = `<span data-ago="${lastN.start_at}"></span>`;
    $('#last-nappy-detail').textContent = `${fmtTime(lastN.start_at)} · ${{ wet: 'Wet', dirty: 'Dirty', both: 'Wet + dirty' }[lastN.subtype]}`;
  } else {
    $('#last-nappy-ago').textContent = '—';
    $('#last-nappy-detail').textContent = 'Nothing logged yet';
  }

  // ---- Status: sleep
  const sleeps = byTimeAsc(state.events.filter((e) => e.kind === 'sleep'));
  const lastSl = sleeps[sleeps.length - 1];
  if (runSleep) {
    $('#sleep-title').textContent = 'Asleep for';
    $('#sleep-big').innerHTML = `<span data-timer-short="${runSleep.start_at}"></span>`;
    $('#sleep-detail').textContent = `Since ${fmtTime(runSleep.start_at)}`;
  } else if (lastSl) {
    $('#sleep-title').textContent = 'Awake for';
    $('#sleep-big').innerHTML = `<span data-ago-plain="${lastSl.end_at}"></span>`;
    $('#sleep-detail').textContent = `Woke at ${fmtTime(lastSl.end_at)}`;
  } else {
    $('#sleep-title').textContent = 'Sleep';
    $('#sleep-big').textContent = '—';
    $('#sleep-detail').textContent = 'Nothing logged yet';
  }
  $('#sleep-btn-label').textContent = runSleep ? 'Woke up' : 'Sleep';

  // ---- Quick buttons: last side tag, lock breast buttons while feeding
  const lastBreast = byTimeAsc(state.events.filter(isBreast)).pop();
  for (const btn of $$('[data-quick^="feed:"]')) {
    const t = btn.dataset.quick.split(':')[1];
    const tag = $('.tag', btn);
    if (tag) tag.hidden = !(lastBreast && lastBreast.subtype === t && !runFeed);
    btn.disabled = !!runFeed && BREAST.includes(t);
  }

  // ---- Checks
  const stateText = { ok: 'In line with guide', low: 'Below guide', pending: 'Not enough data yet', info: '', todo: '', na: '' };
  const stateIcon = { ok: 'i-check', low: 'i-alert', todo: 'i-sun', info: 'i-dot', pending: 'i-clock', na: 'i-dot' };
  $('#checks').innerHTML = checks
    .map((c) => `<li class="check ${c.status}">
      <span class="ic">${icon(stateIcon[c.status])}</span>
      <div>
        <h4>${esc(c.title)}</h4>
        <p>${esc(c.guide)}${c.status === 'low' ? '. If you\'re worried, talk to your midwife or health visitor.' : ''}</p>
        ${stateText[c.status] ? `<span class="state">${stateText[c.status]}</span>` : ''}
        ${c.id === 'vitd' && c.status === 'todo' ? '<div><button class="mini-btn" data-quick="vitd">Log vitamin D now</button></div>' : ''}
      </div>
      <span class="val ${/^\d+$/.test(c.value) ? '' : 'text'}">${esc(c.value)}</span>
    </li>`)
    .join('');

  // ---- Recent
  const gaps = sessionGapsById();
  const recent = [...state.events].sort((a, b) => b.start_at - a.start_at).slice(0, 8);
  $('#recent').innerHTML = recent.map((e) => eventRow(e, gaps.get(e.uid))).join('');
}

// ------------------------------------------------------------ trends

function dayStats(from, to) {
  const ev = state.events.filter((e) => e.start_at >= from && e.start_at < to);
  const ss = feedSessions(state.events).filter((s) => s.start >= from && s.start < to);
  const allStarts = feedSessions(state.events).map((s) => s.start);
  const gaps = [];
  for (let i = 1; i < allStarts.length; i++) if (allStarts[i] >= from && allStarts[i] < to) gaps.push(allStarts[i] - allStarts[i - 1]);
  return {
    feeds: ss.length,
    avgGap: avg(gaps),
    maxGap: gaps.length ? Math.max(...gaps) : null,
    breastMs: sum(ss.map((s) => s.breastMs)),
    ml: sum(ss.map((s) => s.ml)),
    wet: ev.filter((e) => e.kind === 'nappy' && e.subtype !== 'dirty').length,
    poo: ev.filter((e) => e.kind === 'nappy' && e.subtype !== 'wet').length,
    sleepMs: sleepMsIn(state.events, from, Math.min(to, Date.now())),
  };
}

function renderTrends() {
  const now = Date.now();
  const s = dayStats(now - DAY, now + 1);
  const tiles = [
    ['Feeds', s.feeds, s.breastMs ? `${fmtDur(s.breastMs)} breastfeeding` : ''],
    ['Average time between feeds', fmtDur(s.avgGap), 'start to start'],
    ['Longest time between feeds', fmtDur(s.maxGap), ''],
    ['Expressed + formula', s.ml ? `${s.ml} ml` : '—', ''],
    ['Wet nappies', s.wet, ''],
    ['Poos', s.poo, ''],
    ['Sleep', s.sleepMs ? fmtDur(s.sleepMs) : '—', 'of the last 24 hours'],
  ];
  $('#tiles').innerHTML = tiles
    .map(([l, v, h]) => `<div class="tile"><p class="label">${l}</p><p class="value">${v}</p>${h ? `<p class="hint">${h}</p>` : ''}</div>`)
    .join('');

  renderTimeline(now);

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const from = addDays(startOfDay(now), -i);
    days.push({ from, ...dayStats(from, addDays(from, 1)) });
  }
  const label = (d) => shortDayFmt.format(d.from).slice(0, 2);
  $('#c-feeds').innerHTML = barChart(days, (d) => d.feeds, 'f-feed', label, (d) => `${d.feeds} feeds${d.avgGap ? `, average ${fmtDur(d.avgGap, true)} apart` : ''}`);
  $('#c-wet').innerHTML = barChart(days, (d) => d.wet, 'f-nappy', label, (d) => `${d.wet} wet nappies`);
  $('#c-poo').innerHTML = barChart(days, (d) => d.poo, 'f-nappy', label, (d) => `${d.poo} poos`);
  $('#c-sleep').innerHTML = barChart(days, (d) => Math.round((d.sleepMs / HOUR) * 10) / 10, 'f-sleep', label, (d) => `${fmtDur(d.sleepMs)} sleep logged`, (v) => `${v}h`);

  $('#day-table').innerHTML = `<caption class="sr-only">Daily totals, last 7 days</caption>
    <thead><tr><th>Day</th><th>Feeds</th><th>Avg gap</th><th>ml</th><th>Wet</th><th>Poos</th><th>Sleep</th></tr></thead>
    <tbody>${[...days].reverse().map((d) => `<tr>
      <td>${startOfDay(d.from) === startOfDay(now) ? 'Today' : `${shortDayFmt.format(d.from)} ${new Date(d.from).getDate()}`}</td>
      <td>${d.feeds}</td><td>${d.avgGap ? fmtDur(d.avgGap, true) : '—'}</td><td>${d.ml || '—'}</td>
      <td>${d.wet}</td><td>${d.poo}</td><td>${d.sleepMs ? fmtDur(d.sleepMs, true) : '—'}</td></tr>`).join('')}</tbody>`;

  // Measurements
  const bw = state.profile.birthWeightKg;
  const weights = state.events.filter((e) => e.kind === 'weight').sort((a, b) => b.start_at - a.start_at);
  $('#weights').innerHTML =
    (bw ? `<div class="row-item"><span>Birth weight</span><b>${bw.toFixed(2)} kg</b></div>` : '') +
    (weights.length
      ? weights.map((w) => `<div class="row-item" data-id="${w.uid}"><span>${dateFmt.format(w.start_at)}</span><b>${w.value.toFixed(2)} kg${bw ? ` <span class="muted small">(${w.value >= bw ? '+' : '−'}${Math.round(Math.abs(w.value - bw) * 1000)} g)</span>` : ''}</b></div>`).join('')
      : '<div class="empty">No weights logged in this period. Your health visitor\'s weighings go in the Red Book; you can copy them here too.</div>');
  const temps = state.events.filter((e) => e.kind === 'temp').sort((a, b) => b.start_at - a.start_at).slice(0, 10);
  $('#temps').innerHTML = temps.length
    ? temps.map((t) => `<div class="row-item" data-id="${t.uid}"><span>${dateFmt.format(t.start_at)} ${fmtTime(t.start_at)}</span><b>${t.value.toFixed(1)}°C${t.value >= 38 ? ' <span class="flag-txt">high</span>' : t.value < 36 ? ' <span class="flag-txt">low</span>' : ''}</b></div>`).join('')
    : '<div class="empty">No temperatures logged. Use a digital thermometer under the arm.</div>';
}

function renderTimeline(now) {
  const W = 360, H = 100, from = now - DAY;
  const x = (t) => ((Math.max(t, from) - from) / DAY) * W;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Feeds, sleep and nappies over the last 24 hours">`;
  const firstTick = new Date(from); firstTick.setMinutes(0, 0, 0);
  for (let t = firstTick.getTime() + HOUR; t < now; t += HOUR) {
    const h = new Date(t).getHours();
    if (h % 3) continue;
    svg += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="2" y2="74"/>`;
    svg += `<text x="${x(t)}" y="90" text-anchor="middle">${String(h).padStart(2, '0')}:00</text>`;
  }
  svg += `<line class="axis" x1="0" x2="${W}" y1="74" y2="74"/><line class="now-line" x1="${W}" x2="${W}" y1="0" y2="74"/>`;
  for (const e of state.events) {
    const end = isRunning(e) ? now : e.end_at ?? e.start_at;
    if (end < from) continue;
    const x0 = x(e.start_at);
    const tip = esc(`${fmtTime(e.start_at)} ${LABEL[e.subtype]}${eventMeta(e).length ? ' · ' + eventMeta(e).join(' · ').replace(/<[^>]+>/g, '') : ''}`);
    if (e.kind === 'feed' || e.kind === 'sleep') {
      const w = Math.max(3, x(end) - x0);
      const y = e.kind === 'feed' ? 6 : 30, cls = e.kind === 'feed' ? 'f-feed' : 'f-sleep';
      svg += `<g class="mark" data-tip="${tip}"><rect class="hit" x="${x0 + w / 2 - Math.max(w, 24) / 2}" y="${y - 4}" width="${Math.max(w, 24)}" height="26"/>
        <rect class="${cls}" x="${x0}" y="${y}" width="${w}" height="18" rx="4"/></g>`;
    } else if (e.kind === 'nappy') {
      svg += `<g class="mark" data-tip="${tip}"><circle class="hit" cx="${x0}" cy="61" r="14"/><circle class="dot-nappy" cx="${x0}" cy="61" r="6"/></g>`;
    }
  }
  $('#timeline').innerHTML = svg + '</svg>';
}

function barPath(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceMax(v) {
  if (v <= 4) return 4;
  const step = v <= 10 ? 2 : v <= 20 ? 5 : 10;
  return Math.ceil(v / step) * step;
}
function barChart(days, valueOf, cls, labelOf, tipOf, fmtVal = (v) => v) {
  const W = 170, H = 116, top = 16, base = 92, left = 18;
  const vals = days.map(valueOf);
  const max = niceMax(Math.max(...vals, 1));
  const slot = (W - left) / days.length, bw = Math.min(14, slot * 0.6);
  const y = (v) => base - (v / max) * (base - top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  svg += `<line class="grid" x1="${left}" x2="${W}" y1="${y(max)}" y2="${y(max)}"/><text x="${left - 4}" y="${y(max) + 4}" text-anchor="end">${max}</text>`;
  svg += `<line class="axis" x1="${left}" x2="${W}" y1="${base}" y2="${base}"/>`;
  days.forEach((d, i) => {
    const cx = left + slot * i + slot / 2, v = vals[i], today = i === days.length - 1;
    const tip = esc(`${today ? 'Today' : dayFmt.format(d.from)}: ${tipOf(d)}`);
    svg += `<g class="mark" data-tip="${tip}"><rect class="hit" x="${cx - slot / 2}" y="${top}" width="${slot}" height="${base - top + 18}"/>
      <path class="${cls}" d="${barPath(cx - bw / 2, y(v), bw, base - y(v), 4)}"/></g>`;
    if (today) svg += `<text class="value-label" x="${cx}" y="${y(v) - 5}" text-anchor="middle">${fmtVal(v)}</text>`;
    svg += `<text x="${cx}" y="${base + 16}" text-anchor="middle"${today ? ' class="row-label"' : ''}>${labelOf(d, i)}</text>`;
  });
  return svg + '</svg>';
}

// ------------------------------------------------------------ history

function renderHistory() {
  const gaps = sessionGapsById();
  const f = state.filter;
  const match = (e) => f === 'all' || (f === 'health' ? GROUP[e.kind] === 'health' : e.kind === f);
  const byDay = new Map();
  for (const e of [...state.events].sort((a, b) => b.start_at - a.start_at)) {
    if (!match(e)) continue;
    const k = startOfDay(e.start_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  let html = '';
  for (const [day, list] of byDay) {
    const st = dayStats(day, addDays(day, 1));
    html += `<div class="day-head"><h3>${dayLabel(day)}</h3><span>${st.feeds} feeds · ${st.wet} wet · ${st.poo} poos</span></div>
      <ul class="event-list">${list.map((e) => eventRow(e, gaps.get(e.uid))).join('')}</ul>`;
  }
  $('#history').innerHTML = html || '<p class="footnote">Nothing logged in this period.</p>';
  $('#older').textContent = `Show older (showing the last ${state.days} days)`;
  for (const b of $$('#filters button')) b.classList.toggle('on', b.dataset.filter === f);
}

// Live counters, once a second
function tick() {
  const now = Date.now();
  for (const el of $$('[data-ago]')) el.textContent = fmtAgo(Number(el.dataset.ago));
  for (const el of $$('[data-ago-plain]')) el.textContent = fmtDur(now - Number(el.dataset.agoPlain), true);
  for (const el of $$('[data-timer]')) el.textContent = fmtClock(now - Number(el.dataset.timer));
  for (const el of $$('[data-timer-short]')) {
    const ms = now - Number(el.dataset.timerShort);
    el.textContent = ms < MIN ? 'Just now' : fmtDur(ms, true);
  }
}

// ------------------------------------------------------------ actions

const post = (body) => saveEvent(body);

function undoable(created, msg) {
  toast(msg, 'Undo', async () => {
    const cur = state.events.find((x) => x.uid === created.uid);
    if (cur) await removeEvent(cur);
  });
}

async function startTimer(kind, subtype) {
  const now = Date.now();
  if (running(kind === 'sleep' ? 'sleep' : 'feed')) return toast('That timer is already running');
  const other = kind === 'sleep' ? running('feed') : running('sleep');
  try {
    let note = '';
    if (other) {
      await saveEvent({ end_at: now }, other);
      note = other.kind === 'sleep' ? 'Sleep ended. ' : 'Feed finished. ';
    }
    await post({ kind, subtype, start_at: now, end_at: null });
    toast(`${note}${kind === 'sleep' ? 'Sleep timer started' : `${LABEL[subtype]} timer started`}`);
  } catch (err) {
    toast(err.message);
  }
}

async function timerAction(act) {
  const now = Date.now();
  const ev = act.endsWith('sleep') ? running('sleep') : running('feed');
  if (!ev) return;
  try {
    if (act === 'stop-feed' || act === 'stop-sleep') {
      await saveEvent({ end_at: now }, ev);
      toast(`${ev.kind === 'sleep' ? 'Sleep' : LABEL[ev.subtype]} · ${fmtDur(now - ev.start_at)} saved`);
    } else if (act === 'switch') {
      await saveEvent({ end_at: now }, ev);
      await post({ kind: 'feed', subtype: ev.subtype === 'left' ? 'right' : 'left', start_at: now, end_at: null });
    } else if (act.startsWith('discard')) {
      await removeEvent(ev);
      toast('Timer discarded', 'Undo', () => post({ kind: ev.kind, subtype: ev.subtype, start_at: ev.start_at, end_at: null, note: ev.note }));
    }
  } catch (err) {
    toast(err.message);
  }
}

async function quick(action) {
  const [kind, subtype] = action.split(':');
  try {
    if (kind === 'feed') {
      if (BREAST.includes(subtype)) return startTimer('feed', subtype);
      return openSheet({ kind: 'feed', subtype });
    }
    if (kind === 'nappy') {
      if (subtype === 'wet') return undoable(await post({ kind: 'nappy', subtype: 'wet' }), 'Wet nappy logged');
      return openPooSheet(subtype);
    }
    if (kind === 'sleep') return running('sleep') ? timerAction('stop-sleep') : startTimer('sleep', 'sleep');
    if (kind === 'vitd') return undoable(await post({ kind: 'vitd', subtype: 'drops' }), 'Vitamin D logged');
    if (kind === 'temp') return openSheet({ kind: 'temp', subtype: 'armpit' });
    if (kind === 'weight') return openSheet({ kind: 'weight', subtype: 'weight' });
  } catch (err) {
    toast(err.message);
  }
}

// ------------------------------------------------------------ quick poo colour sheet

const pooSheet = $('#poo-sheet');
let pooSubtype = 'dirty';
$('#poo-quick').innerHTML = POO_COLOURS.map(
  (p) => `<button type="button" class="swatch-btn" data-poo="${p.id}"><i style="background:${p.hex}"></i>${p.label}${p.desc ? `<small>${p.desc}</small>` : ''}${p.flag ? '<span class="flag-mark">Check Help</span>' : ''}</button>`
).join('');

function openPooSheet(subtype) {
  pooSubtype = subtype;
  $('#poo-title').textContent = subtype === 'both' ? 'Wet and dirty: what colour was the poo?' : 'What colour was the poo?';
  $('#poo-pee-field').hidden = subtype !== 'both';
  $('#poo-form').elements.namedItem('pee_dark').checked = false;
  pooSheet.showModal();
}
async function logPoo(colour) {
  const pee = pooSubtype === 'both' && $('#poo-form').elements.namedItem('pee_dark').checked ? 'dark' : null;
  pooSheet.close();
  try {
    const e = await post({ kind: 'nappy', subtype: pooSubtype, poo: colour, pee });
    undoable(e, `${pooSubtype === 'both' ? 'Wet and dirty' : 'Dirty'} nappy logged`);
  } catch (err) {
    toast(err.message);
  }
}
$('#poo-quick').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-poo]');
  if (b) logPoo(b.dataset.poo);
});
$('#poo-skip').addEventListener('click', () => logPoo(null));

// ------------------------------------------------------------ add / edit sheet

const sheet = $('#sheet');
const form = $('#entry-form');
const fe = (n) => form.elements.namedItem(n);
let editing = null;

$('#kind-seg').innerHTML = KINDS.map(([v, l]) => `<label><input type="radio" name="kind" value="${v}"><span>${l}</span></label>`).join('');
$('#poo-swatches').innerHTML =
  `<label class="swatch"><input type="radio" name="poo" value=""><span><i style="background:transparent;border-style:dashed"></i>Not sure</span></label>` +
  POO_COLOURS.map((p) => `<label class="swatch"><input type="radio" name="poo" value="${p.id}"><span><i style="background:${p.hex}"></i>${p.label}${p.desc ? `<small>${p.desc}</small>` : ''}</span></label>`).join('');
$('#amount-chips').innerHTML = [30, 60, 90, 120, 150, 180].map((v) => `<button type="button" class="chip" data-amount="${v}">${v}</button>`).join('');

const radioVal = (name) => (form.querySelector(`input[name="${name}"]:checked`) || {}).value;
function setRadio(name, value) {
  for (const r of form.querySelectorAll(`input[name="${name}"]`)) r.checked = r.value === (value ?? '');
}

function setKind(kind, subtype) {
  setRadio('kind', kind);
  const subs = SUBTYPES[kind];
  $('#subtype-seg').innerHTML = subs.map(([v, l]) => `<label><input type="radio" name="subtype" value="${v}"><span>${l}</span></label>`).join('');
  $('#subtype-seg').hidden = subs.length < 2;
  setRadio('subtype', subtype || subs[0][0]);
  syncFields(true);
}

function lastOf(pred) {
  return [...state.events].filter(pred).sort((a, b) => b.start_at - a.start_at)[0];
}

function syncFields(fresh = false) {
  const kind = radioVal('kind'), sub = radioVal('subtype');
  const breast = kind === 'feed' && BREAST.includes(sub);
  const bottle = kind === 'feed' && !breast;
  const timer = breast || kind === 'sleep';
  const isRun = editing && isRunning(editing) && editing.kind === kind;
  $('#duration-field').hidden = !timer || isRun;
  $('#running-note').hidden = !isRun;
  $('#amount-field').hidden = !bottle;
  $('#poo-field').hidden = !(kind === 'nappy' && sub !== 'wet');
  $('#pee-field').hidden = !(kind === 'nappy' && sub !== 'dirty');
  $('#value-field').hidden = !(kind === 'temp' || kind === 'weight');
  $('#when-label').textContent = kind === 'sleep' ? 'Fell asleep' : breast ? 'Started' : 'When';
  const v = fe('value');
  if (kind === 'temp') {
    $('#value-label').textContent = 'Temperature (°C)';
    $('#value-hint').textContent = 'Use a digital thermometer under the arm. 38°C or more is a high temperature.';
    v.step = '0.1'; v.min = '30'; v.max = '45';
  } else if (kind === 'weight') {
    $('#value-label').textContent = 'Weight (kg)';
    $('#value-hint').textContent = 'For example 3.45. You can copy weighings from the Red Book.';
    v.step = '0.01'; v.min = '0.4'; v.max = '30';
  }
  if (!fresh || editing) return;
  if (bottle) fe('amount').value = lastOf((e) => e.subtype === sub && e.amount_ml != null)?.amount_ml ?? 60;
  if (breast) { fe('dur_h').value = 0; fe('dur_m').value = 15; }
  if (kind === 'sleep') { fe('dur_h').value = 1; fe('dur_m').value = 0; }
  if (kind === 'weight') fe('value').value = lastOf((e) => e.kind === 'weight')?.value ?? '';
  if (kind === 'temp') fe('value').value = '';
}

function openSheet({ event = null, kind = 'feed', subtype } = {}) {
  editing = event;
  form.reset();
  $('#form-error').hidden = true;
  $('#delete-btn').hidden = !event;
  if (event) {
    $('#sheet-title').textContent = `Edit ${LABEL[event.subtype].toLowerCase()}`;
    setKind(event.kind, event.subtype);
    fe('start').value = toLocalInput(event.start_at);
    if (event.end_at != null) {
      const mins = Math.round((event.end_at - event.start_at) / MIN);
      fe('dur_h').value = Math.floor(mins / 60);
      fe('dur_m').value = mins % 60;
    }
    if (event.amount_ml != null) fe('amount').value = event.amount_ml;
    if (event.value != null) fe('value').value = event.value;
    setRadio('poo', event.poo || '');
    fe('pee_dark').checked = event.pee === 'dark';
    fe('note').value = event.note || '';
  } else {
    $('#sheet-title').textContent = 'Add entry';
    fe('start').value = toLocalInput(Date.now());
    setKind(kind, subtype);
    setRadio('poo', '');
  }
  sheet.showModal();
  if (!event && (kind === 'temp' || kind === 'weight')) fe('value').focus();
  else form.querySelector('input:checked')?.focus();
}

form.addEventListener('change', (ev) => {
  if (ev.target.name === 'kind') setKind(ev.target.value);
  else if (ev.target.name === 'subtype') { fe('amount').value = ''; syncFields(true); }
});
$('#amount-chips').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-amount]');
  if (b) fe('amount').value = b.dataset.amount;
});
$('#now-btn').addEventListener('click', () => (fe('start').value = toLocalInput(Date.now())));

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const kind = radioVal('kind'), subtype = radioVal('subtype');
  const start_at = new Date(fe('start').value).getTime();
  if (!isFinite(start_at)) return formError('Choose a date and time');
  const body = { kind, subtype, start_at, note: fe('note').value };
  if (isBreast({ kind, subtype }) || kind === 'sleep') {
    if (editing && isRunning(editing) && editing.kind === kind) body.end_at = null;
    else {
      const mins = (Number(fe('dur_h').value) || 0) * 60 + (Number(fe('dur_m').value) || 0);
      if (!(mins >= 0)) return formError('Enter how long it lasted');
      body.end_at = start_at + Math.round(mins) * MIN;
    }
  }
  if (kind === 'feed' && !BREAST.includes(subtype)) {
    if (fe('amount').value === '') return formError('Enter the amount in ml');
    body.amount_ml = Math.round(Number(fe('amount').value));
  }
  if (kind === 'temp' || kind === 'weight') {
    const raw = fe('value').value.replace(',', '.');
    if (raw === '') return formError(kind === 'temp' ? 'Enter the temperature' : 'Enter the weight');
    body.value = Number(raw);
  }
  if (kind === 'nappy') {
    body.poo = subtype !== 'wet' ? radioVal('poo') || null : null;
    body.pee = subtype !== 'dirty' && fe('pee_dark').checked ? 'dark' : null;
  }
  try {
    if (editing) await saveEvent(body, editing);
    else await post(body);
    sheet.close();
    toast(editing ? 'Updated' : 'Saved');
  } catch (err) {
    formError(err.message);
  }
});

$('#delete-btn').addEventListener('click', async () => {
  const e = editing;
  if (!e) return;
  try {
    await removeEvent(e);
    sheet.close();
    toast('Deleted', 'Undo', () => post(fieldsOf(e)));
  } catch (err) {
    formError(err.message);
  }
});

function formError(msg) {
  const el = $('#form-error');
  el.textContent = msg;
  el.hidden = false;
}

// ------------------------------------------------------------ settings

const settingsDlg = $('#settings');
const sf = (n) => $('#settings-form').elements.namedItem(n);
function openSettings() {
  const p = state.profile;
  sf('name').value = p.babyName;
  sf('dob').value = p.dob || '';
  sf('dob').max = toLocalInput(Date.now()).slice(0, 10);
  sf('bw').value = p.birthWeightKg ?? '';
  for (const r of $$('#theme-seg input')) r.checked = r.value === storedTheme();
  $('#settings-error').hidden = true;
  $('#settings-sync').textContent = syncText().text;
  renderInstall();
  settingsDlg.showModal();
}
$('#settings-form').addEventListener('change', (ev) => {
  if (ev.target.name === 'theme') applyTheme(ev.target.value);
});
$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await net('POST', '/api/settings', {
      babyName: sf('name').value,
      dob: sf('dob').value || null,
      birthWeightKg: sf('bw').value === '' ? null : Number(sf('bw').value.replace(',', '.')),
    });
    state.profile = r;
    await Store.setMeta('profile', r);
    settingsDlg.close();
    sync();
    renderAll();
    toast('Profile saved');
  } catch (err) {
    const el = $('#settings-error');
    el.textContent = err.offline
      ? 'The baby profile can only be changed at home, so both phones stay in step. Connect to your home Wi-Fi and try again.'
      : err.status === 401 ? 'Sign in again (tap your name at the top), then try again.' : err.message;
    el.hidden = false;
  }
});

// ------------------------------------------------------------ toast & tooltip

let toastTimer;
function toast(msg, actionLabel, action) {
  const el = $('#toast'), btn = $('#toast-action');
  $('#toast-msg').textContent = msg;
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = action ? async () => { el.hidden = true; try { await action(); } catch (err) { toast(err.message); } } : null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), actionLabel ? 8000 : 3500);
}

const tip = $('#tip');
function showTip(el, x, y) {
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const pad = 120;
  tip.style.left = `${Math.min(Math.max(x, pad), window.innerWidth - pad)}px`;
  tip.style.top = `${y}px`;
}
document.addEventListener('pointermove', (ev) => {
  if (ev.pointerType !== 'mouse') return;
  const m = ev.target.closest?.('[data-tip]');
  if (m) showTip(m, ev.clientX, ev.clientY);
  else tip.hidden = true;
});
window.addEventListener('scroll', () => (tip.hidden = true), { passive: true });

// ------------------------------------------------------------ navigation, sign in, theme

function setView(view, anchor) {
  state.view = view;
  for (const s of $$('.view')) s.hidden = s.dataset.view !== view;
  for (const b of $$('.tabbar button')) b.classList.toggle('active', b.dataset.tab === view);
  tip.hidden = true;
  renderAll();
  const target = anchor && document.querySelector(anchor);
  if (target) {
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -70);
  } else window.scrollTo(0, 0);
}

function showLogin() {
  state.who = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-baby').textContent = `${state.profile.babyName}'s log`;
}

async function login(who) {
  state.who = who;
  await Store.setMeta('who', who);
  $('#login').hidden = true;
  $('#app').hidden = false;
  await load();
  net('POST', '/api/login', { who }).then(sync, () => {});
}

function storedTheme() {
  try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; }
}
function effectiveTheme(t) {
  if (t !== 'auto') return t;
  const h = new Date().getHours();
  return h >= 21 || h < 7 ? 'night' : null; // null = follow the phone's light/dark setting
}
function applyTheme(t) {
  try { localStorage.setItem('theme', t); } catch {}
  const eff = effectiveTheme(t);
  if (eff) document.documentElement.setAttribute('data-theme', eff);
  else document.documentElement.removeAttribute('data-theme');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name="theme-color"]').setAttribute('content', bg || '#16120f');
}

document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t.closest('a[href^="tel:"], a[target="_blank"]')) return; // let real links work
  if (t.closest('[data-export]')) return exportCsv();
  if (t.closest('[data-install]')) return installApp();
  if (t.closest('#sync-bar')) return toast(state.sync.home ? 'Sending this phone\'s changes to the home server.' : 'Away from home, entries are saved on this phone and sync with the other phone when you\'re back on home Wi-Fi.');
  const who = t.closest('[data-who]');
  if (who) return login(who.dataset.who);
  const q = t.closest('[data-quick]');
  if (q) return quick(q.dataset.quick);
  const act = t.closest('[data-act]');
  if (act) return timerAction(act.dataset.act);
  const close = t.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const dismiss = t.closest('[data-dismiss]');
  if (dismiss) {
    const keys = storage.get('dismissedAlerts', []);
    keys.push(dismiss.dataset.dismiss);
    storage.set('dismissedAlerts', keys.slice(-100));
    return renderToday();
  }
  if (t.closest('[data-setup-later]')) { storage.set('setupLater', true); return renderToday(); }
  if (t.closest('[data-open="settings"]')) return openSettings();
  const go = t.closest('[data-goto]');
  if (go) { ev.preventDefault(); return setView(go.dataset.goto, go.getAttribute('href')); }
  const row = t.closest('.event[data-id], .row-item[data-id]');
  if (row) {
    const e = state.events.find((x) => x.uid === row.dataset.id);
    if (e) return openSheet({ event: e });
  }
  const tab = t.closest('[data-tab]');
  if (tab) return setView(tab.dataset.tab);
  const filter = t.closest('[data-filter]');
  if (filter) { state.filter = filter.dataset.filter; return renderHistory(); }
  const m = t.closest('[data-tip]');
  if (m) showTip(m, ev.clientX, ev.clientY);
  else tip.hidden = true;
});
document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.event[data-id]')) {
    ev.preventDefault();
    ev.target.click();
  }
});
for (const dlg of $$('dialog')) dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });

$('#add-past').addEventListener('click', () => openSheet({ kind: 'feed', subtype: 'left' }));
$('#older').addEventListener('click', () => { state.days += 30; load(); });
$('#who-chip').addEventListener('click', async () => {
  await Store.setMeta('who', null);
  net('POST', '/api/logout').catch(() => {});
  showLogin();
});
$('#settings-btn').addEventListener('click', openSettings);
$('#profile-btn').addEventListener('click', openSettings);

// ------------------------------------------------------------ boot

function exportCsv() {
  const rows = [...state.events].sort((a, b) => a.start_at - b.start_at);
  const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const iso = (v) => (v == null ? '' : new Date(v).toISOString());
  const lines = ['kind,subtype,start,end,amount_ml,value,poo,pee,note,by'];
  for (const r of rows) lines.push([r.kind, r.subtype, iso(r.start_at), iso(r.end_at), r.amount_ml, r.value, r.poo, r.pee, r.note, r.by].map(cell).join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `baby-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------ install as an app
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (ev) => { ev.preventDefault(); installPrompt = ev; });
window.addEventListener('appinstalled', () => { installPrompt = null; renderInstall(); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function renderInstall() {
  const el = $('#install');
  if (isStandalone()) { el.innerHTML = '<p class="hint">Installed as an app on this phone.</p>'; return; }
  if (installPrompt) { el.innerHTML = '<button type="button" class="ghost-btn small" data-install>Install Baby Log on this phone</button>'; return; }
  el.innerHTML = isIOS()
    ? '<p class="hint">To install: tap the Share button in Safari, then <b>Add to Home Screen</b>.</p>'
    : '<p class="hint">To install: open your browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p>';
}
async function installApp() {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  renderInstall();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', () => sync());
setInterval(tick, 1000);
setInterval(() => { if (!document.hidden) sync(); }, 30_000);
setInterval(() => {
  applyTheme(storedTheme()); // Auto switches to Night light at 21:00
  if (!document.hidden && !document.querySelector('dialog[open]')) renderAll();
}, 60_000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

(async function boot() {
  applyTheme(storedTheme());
  try {
    state.who = await Store.getMeta('who');
    state.profile = (await Store.getMeta('profile')) || state.profile;
    state.sync.lastSyncAt = await Store.getMeta('lastSyncAt');
  } catch {
    toast('This browser is blocking storage, so Baby Log can\'t keep entries on this phone.');
  }
  if (!state.who) {
    showLogin();
    // Best effort: show the baby's name on the sign-in screen.
    net('GET', '/api/me', null, 3000).then((me) => {
      state.profile = { babyName: me.babyName, dob: me.dob, birthWeightKg: me.birthWeightKg };
      if (!state.who) $('#login-baby').textContent = `${state.profile.babyName}'s log`;
    }, () => {});
    return;
  }
  $('#app').hidden = false;
  await load();
  sync();
})();
