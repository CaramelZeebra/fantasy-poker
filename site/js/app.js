import { POLL_MS } from './config.js';
import { makeStore, ConflictError } from './store.js';
import {
  createTable, startHand, step, profilesFor, potTotal, legal, applyAction,
  pushUndo, swapCard, newPlayer, streetName, fullProfile, assignHues, botView,
} from './engine.js';
import { PRESETS, TRAITS, ADVANCED, ADV_DEFAULTS, HAND_GRID, advChanged, presetInfo, preflopTop } from './bots.js';
import { RANKS, SUIT_SYMBOLS, SUIT_NAMES, cardLabel, describeScore, evaluate } from './cards.js';
import { morph } from './morph.js';
import { coach, LESSONS } from './trainer.js';
import { computeOdds as computeOddsHere } from './odds.js';

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${Math.round(n).toLocaleString()}`;
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + money(Math.abs(n));
const pct = (x) => (x == null ? '—' : x >= 0.995 && x < 1 ? '>99%' : x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`);
const lsGet = (k, d) => { try { return localStorage.getItem(`fp:${k}`) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(`fp:${k}`, v); } catch { /* private mode */ } };

const ui = {
  tab: lsGet('tab', 'odds'),
  speed: +lsGet('speed', 900),
  auto: false,
  raiseKey: null,
  raiseTo: 0,
  odds: { key: undefined },
  prevOdds: null,
  trail: { no: null, rows: {} },
  teach: lsGet('teach', 'off'),
  narrOpen: lsGet('narr', '0') === '1',
  teachNote: '',
  whys: ({ 1: 'full', 0: 'off' })[lsGet('whys', 'full')] || lsGet('whys', 'full'), // off | short | full
};
const avatars = new Set();
let store, state = null;

// Lucky hands as a set of chart codes; an older bare 'K9' means both K9s and K9o.
const favSet = (v) => new Set((v ? v.split(',') : []).flatMap((f) => (f.length === 2 && f[0] !== f[1] ? [`${f}s`, `${f}o`] : [f])));
const EMOJI_PICKS = ['🍺', '🦈', '🐢', '🤡', '👑', '🎩', '🐍', '🧊', '💎', '🌶️', '🎲', '🃏', '🤠', '👻', '🦊', '🐻', '🧠', '💸', '😎', '🥶', '🍀', '🐙'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- odds (in a worker so the page stays smooth) ----------
// Every viewer computes odds for what's on screen; they're never written to the shared blob,
// so a slow calculation can't hold up a click or collide with someone else's move.

let worker = null, reqId = 0;

function oddsKey(s) {
  const h = s.hand;
  if (!h || h.phase === 'done') return null;
  return JSON.stringify([h.no, h.shown, h.phase, h.toAct, h.board5, h.curBet, h.raises, h.aggressor,
    h.seats.map((x) => [x.hole, x.folded, x.allIn, x.stack, x.bet, x.total, x.acted]), profilesFor(s)]);
}

function onOdds(id, odds, done) {
  if (id !== ui.odds.id) return;
  ui.odds.o = odds;
  ui.odds.done = done;
  if (done) recordTrail(ui.odds);
  render();
}

function ensureOdds(s) {
  const key = oddsKey(s);
  if (key === ui.odds.key) return;
  if (ui.odds.o && ui.odds.no === s.hand?.no) ui.prevOdds = { no: ui.odds.no, o: ui.odds.o };
  const id = ++reqId;
  ui.odds = { key, id, no: s.hand?.no, street: s.hand?.street, o: null, done: false };
  if (!key) return;
  const hand = { ...s.hand, log: null, odds: null };
  const profiles = profilesFor(s);
  try {
    if (!worker) {
      worker = new Worker(new URL('./odds-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => onOdds(e.data.id, e.data.odds, e.data.done);
      worker.onerror = () => { worker = false; ui.odds.key = null; render(); };
    }
    if (worker === false) throw new Error('no worker');
    worker.postMessage({ id, hand, profiles });
  } catch {
    setTimeout(() => onOdds(id, { ...computeOddsHere(hand, profiles), n: 400 }, true), 0);
  }
}

// Odds to draw: this situation's (possibly still converging), else the last ones from this
// hand, dimmed, so bars glide to the new values instead of blinking out.
function oddsView(s) {
  const h = s.hand;
  if (!h || h.phase === 'done') return { o: null };
  if (ui.odds.o) return { o: ui.odds.o, pending: !ui.odds.done };
  if (ui.prevOdds?.no === h.no) return { o: ui.prevOdds.o, pending: true, stale: true };
  return { o: null, pending: true };
}

const TRAIL_LABEL = ['PF', 'F', 'T', 'R'];
function recordTrail(r) {
  if (ui.trail.no !== r.no) ui.trail = { no: r.no, rows: {} };
  const label = TRAIL_LABEL[r.street];
  if (label && !ui.trail.rows[label]) ui.trail.rows[label] = r.o.win;
}

// ---------- sync ----------
// Clicks apply instantly to the local copy; a single queue writes the latest state and polls,
// so network round-trips never block the buttons.

let netChain = Promise.resolve();
const net = (fn) => (netChain = netChain.then(fn).catch((e) => console.warn(e)));
let dirty = false;
// Changes made here that the server hasn't confirmed yet, oldest first. Table edits can be
// replayed onto someone else's newer version; game moves can't (both of you pressing "next"
// shouldn't play two steps), so those give way to whoever saved first.
let pending = [];

function setSync(kind, text) {
  $('#sync').className = `sync ${kind}`;
  $('#sync-text').textContent = text;
}
const syncOk = () => setSync(store.label === 'online' ? 'ok' : 'local', store.label === 'online' ? 'Live' : 'Local only');

// Someone else saved first: take their version and replay our table edits on top of it.
function rebaseOnto(theirs) {
  const replay = pending.filter((m) => m.rebase);
  const dropped = pending.length - replay.length;
  pending = [];
  dirty = false;
  state = theirs;
  for (const m of replay) {
    const draft = structuredClone(state);
    if (m.fn(draft) === false) continue;
    draft.rev = (draft.rev || 0) + 1;
    draft.updatedAt = Date.now();
    state = draft;
    pending.push(m);
    dirty = true;
  }
  if (dropped) toast('Someone else moved first — synced to their version.');
  else if (replay.length) toast('Merged your table changes with someone else’s.');
  render();
}

async function lostRace() {
  const s = await store.load().catch(() => null);
  if (s) rebaseOnto(s);
  else { pending = []; dirty = false; }
}

const flush = () => net(async () => {
  while (dirty) {
    dirty = false;
    const sent = pending.length;
    try {
      await store.save(state);
      pending.splice(0, sent);
      syncOk();
    } catch (e) {
      if (e instanceof ConflictError) {
        await lostRace();
        continue; // dirty again if edits were replayed
      }
      dirty = true;
      setSync('err', 'Offline — will retry');
      return;
    }
  }
});

const pollOnce = () => net(async () => {
  if (dirty) return;
  const s = await store.poll();
  if (s && dirty) { rebaseOnto(s); flush(); return; } // they wrote while we were mid-click
  if (s) { state = s; render(); }
  syncOk();
}).catch(() => setSync('err', 'Offline — retrying'));

async function pollLoop() {
  for (;;) {
    await sleep(document.hidden ? POLL_MS * 4 : POLL_MS);
    try {
      if (dirty) await flush(); else await pollOnce();
    } catch {
      setSync('err', 'Offline — retrying');
    }
  }
}

// Apply a change to a copy of the state, show it right away, write it in the background.
// `rebase: true` marks changes that still make sense on top of someone else's newer table.
function mutate(fn, { rebase = false } = {}) {
  if (!state) return false;
  const draft = structuredClone(state);
  if (fn(draft) === false) return false;
  draft.rev = (draft.rev || 0) + 1;
  draft.updatedAt = Date.now();
  state = draft;
  pending.push({ fn, rebase });
  dirty = true;
  render();
  flush();
  return true;
}

// ---------- actions ----------

const act = {
  narr() { ui.narrOpen = !ui.narrOpen; lsSet('narr', ui.narrOpen ? '1' : '0'); render(); },
  next: () => mutate((d) => {
    if (!d.hand || d.hand.phase === 'done') return newHand(d);
    pushUndo(d);
    step(d.hand, profilesFor(d));
  }),
  street: () => mutate((d) => {
    const h = d.hand;
    if (!h || h.phase === 'done') return false;
    pushUndo(d);
    const pr = profilesFor(d);
    if (h.phase === 'deal') return step(h, pr);
    const st = h.street;
    while (h.phase === 'bet' && h.street === st) step(h, pr);
  }),
  async auto() {
    if (ui.auto) { ui.auto = false; render(); return; }
    ui.auto = true;
    render();
    while (ui.auto && state?.hand && state.hand.phase !== 'done') {
      if (!act.next()) break;
      await sleep(ui.speed);
    }
    ui.auto = false;
    render();
  },
  undo: () => mutate((d) => {
    if (!d.undo.length) return false;
    d.hand = JSON.parse(d.undo.pop());
  }),
  newHand: () => {
    const h = state?.hand;
    if (h && h.phase !== 'done' && !confirm('Abandon this hand? Everyone gets their chips back.')) return;
    mutate(newHand);
  },
  forward: () => mutate((d) => {
    for (let k = 0; k < 10; k++) {
      if (newHand(d) === false) return k > 0;
      const pr = profilesFor(d);
      let guard = 0;
      while (d.hand.phase !== 'done' && guard++ < 400) step(d.hand, pr);
    }
  }),
  decide(a) {
    const to = a === 'raise' ? +($('#raise-to')?.value || 0) : 0;
    const lesson = ui.teach !== 'off' && state?.hand?.phase === 'bet' ? teachFor(a) : null;
    mutate((d) => {
      if (!d.hand || d.hand.phase !== 'bet') return false;
      pushUndo(d);
      const i = d.hand.toAct;
      applyAction(d.hand, { a, to, why: lesson ? `Coached: ${lesson.headline}` : 'Your call — decided by hand' });
      if (lesson) d.hand.log.push({ kind: 'coach', text: lesson.logText, seat: i });
    });
    // The lesson itself is a table edit: it merges with whatever else changed meanwhile.
    if (lesson?.changes.length) mutate((d) => applyLesson(d, lesson), { rebase: true });
    if (lesson) toast(lesson.toastText);
    ui.teachNote = '';
  },
};

// ---------- coaching ----------

// Work out what an override should teach the player to act, before the move is made.
function teachFor(a) {
  const h = state.hand, i = h.toAct, st = h.seats[i];
  const pr = profilesFor(state);
  const free = legal(h).toCall <= 0;
  const target = a === 'call' && free ? 'check' : a;
  const { _style, ...profile } = pr[i];
  const r = coach(botView(h, pr), profile, target, ui.teach);
  const verb = { fold: 'fold', check: 'check', call: 'call', raise: free ? 'bet' : 'raise' }[target];
  const note = ui.teachNote.trim();
  const changed = r.changes.map((c) => `${c.label} ${c.to > c.from ? '↑' : '↓'} ${fmtTrait(c.key, c.from)} → ${fmtTrait(c.key, c.to)}`);
  const odds = `${pctWhole(r.before)} → ${pctWhole(r.after)} chance to ${verb} here`;
  const area = LESSONS[ui.teach]?.label.toLowerCase();
  return {
    pid: st.pid,
    changes: r.changes,
    headline: `you'd ${verb}${note ? ` — “${note}”` : ''}`,
    logText: `🎓 ${st.name} coached to ${verb}${note ? ` (“${note}”)` : ''}: ${changed.length ? `${changed.join(', ')} · ${odds}` : `nothing about ${area} would change this — left as is`}`,
    toastText: changed.length ? `${st.name} learned: ${changed.join(', ')} (${odds})` : `Nothing about ${area} would make ${st.name} ${verb} here — no change.`,
  };
}
const pctWhole = (x) => `${Math.round(x * 100)}%`;
const fmtTrait = (k, v) => (k === 'callReq' ? `${v.toFixed(2)}×` : Math.round(v * 100));

// Apply a lesson as relative nudges, so it stacks with other edits made meanwhile.
function applyLesson(d, lesson) {
  const p = d.players.find((q) => q.id === lesson.pid);
  if (!p) return false;
  const prof = fullProfile(p);
  for (const c of lesson.changes) {
    const [lo, hi] = c.key === 'callReq' ? [0.3, 1.6] : [0, 1];
    prof[c.key] = +Math.min(hi, Math.max(lo, prof[c.key] + (c.to - c.from))).toFixed(3);
  }
  p.profile = prof;
  // A coached preset becomes custom but keeps its name, look and blurb.
  if (p.preset in PRESETS) {
    const base = PRESETS[p.preset];
    p.emoji ||= base.emoji; p.label ||= base.name; p.tagline ||= base.desc; p.avatar ||= p.preset;
    p.preset = 'custom';
  }
}

function newHand(d) {
  const err = startHand(d);
  if (err) { toast(err); return false; }
}

// ---------- rendering ----------
// Everything renders to HTML strings and is morphed into place (morph.js), so only what
// changed is touched: cards that were already out don't re-deal, bars and numbers glide.

const playerById = (s, id) => s.players.find((p) => p.id === id);

function infoOf(p) {
  const base = presetInfo(p?.preset);
  return { emoji: p?.emoji || base.emoji, name: p?.label || base.name, desc: p?.tagline || base.desc };
}

function cardHtml(c, { big = false, edit = false, dim = false } = {}) {
  const r = RANKS[c >> 2] === 'T' ? '10' : RANKS[c >> 2];
  return `<button class="card s${c & 3}${big ? ' big' : ''}${dim ? ' dim' : ''}" data-key="c${c}" ${edit ? `data-card="${c}"` : 'disabled'}
    aria-label="${cardLabel(c)}" title="${edit ? 'Click to change this card' : cardLabel(c)}">
    <span class="r">${r}</span><span class="su">${SUIT_SYMBOLS[c & 3]}</span></button>`;
}
const backHtml = (key, big) => `<div class="card back${big ? ' big' : ''}" data-key="${key}"></div>`;

// p.avatar: '' = automatic (preset picture, or a custom player's emoji), 'emoji', or a picture key.
const AVATAR_KEYS = [...Object.keys(PRESETS), 'custom'];
function avatarHtml(p) {
  const custom = !(p?.preset in PRESETS);
  const choice = p?.avatar || '';
  const emoji = p?.emoji || presetInfo(p?.preset).emoji;
  if (choice === 'emoji' || (!choice && custom && p?.emoji)) return `<div class="avatar emoji" aria-hidden="true">${esc(emoji)}</div>`;
  const key = AVATAR_KEYS.includes(choice) ? choice : custom ? 'custom' : p.preset;
  if (avatars.has(key)) return `<img class="avatar" src="assets/avatars/${key}.jpg" alt="">`;
  const initials = (p?.name || '?').trim().slice(0, 2).toUpperCase();
  return `<div class="avatar initials">${esc(initials)}</div>`;
}

const moneyNum = (n) => `data-num="${Math.round(n)}"`;

function madeHand(h, st) {
  if (!h || st.folded || !st.hole) return '';
  if (h.phase === 'done') return '';
  if (h.shown >= 3) return describeScore(evaluate([...st.hole, ...h.board5.slice(0, h.shown)]));
  const [a, b] = st.hole;
  if (a >> 2 === b >> 2) return `Pocket ${RANKS[a >> 2] === 'T' ? '10' : RANKS[a >> 2]}s`;
  return (a & 3) === (b & 3) ? 'Suited' : '';
}

function barsHtml(view, k, folded) {
  const o = view.o;
  const eq = o?.eq?.[k], win = o?.win?.[k];
  const w = (x) => (x == null ? 0 : x * 100).toFixed(1);
  return `<div class="bars${folded ? ' off' : ''}${view.pending ? ' pending' : ''}">
    <div class="bar eq" title="Showdown equity: chance to win if every remaining player sees all five cards">
      <i style="width:${w(eq)}%"></i><span>Equity</span><b>${eq == null || view.stale ? '…' : pct(eq)}</b></div>
    <div class="bar win" title="Realistic win chance: the rest of the hand is simulated with each player's personality (folds, bluffs, bad calls)">
      <i style="width:${w(win)}%"></i><span>Real win</span><b>${win == null || view.stale ? '…' : pct(win)}</b></div>
  </div>`;
}

function seatHtml(s, h, st, k, n, view) {
  const ang = Math.PI / 2 + (k * 2 * Math.PI) / n;
  const x = 50 + 50 * Math.cos(ang);
  const y = 50 + 50 * Math.sin(ang);
  const p = st.player;
  const info = infoOf(p);
  const editable = h && h.phase !== 'done';
  const cls = ['seat'];
  if (h) {
    if (h.phase === 'bet' && h.toAct === k) cls.push('acting');
    if (st.folded) cls.push('folded');
    if (st.allIn && !st.folded) cls.push('allin');
    if (h.phase === 'done' && h.result?.pots.some((pt) => pt.winners.includes(k) && pt.amount > 0) && st.won > st.total) cls.push('winner');
  }
  const dealer = h ? h.btn === k : s.dealerId === st.pid;
  const cards = st.hole
    ? st.hole.map((c) => cardHtml(c, { edit: editable, dim: st.folded })).join('')
    : backHtml('b0') + backHtml('b1');
  const tags = [];
  if (h && h.sbI === k && h.street === 0) tags.push('SB');
  if (h && h.bbI === k && h.street === 0) tags.push('BB');
  if (h && st.tilted && fullProfile(p).tilt > 0) tags.push('😤 Tilted');
  const last = st.allIn && !st.folded && h?.phase !== 'done' ? 'All-in' : st.last || '';
  const made = madeHand(h, st);
  const said = h ? [...(h.says || [])].reverse().find((x) => x.i === k && (h.phase === 'done' || x.at >= h.log.length - 3)) : null;
  return `<div class="${cls.join(' ')}" data-key="seat-${st.pid}" style="--x:${x}%;--y:${y}%">
    ${said ? `<div class="say" data-key="say-${said.at}">${esc(said.text)}</div>` : ''}
    <div class="seat-head">
      ${avatarHtml(p)}
      <div class="who">
        <div class="name">${esc(st.name)}${dealer ? '<span class="dealer" title="Dealer button">D</span>' : ''}</div>
        <div class="type" title="${esc(info.desc)}">${esc(info.emoji)} ${esc(info.name)}</div>
      </div>
    </div>
    <div class="hole">${cards}</div>
    <div class="money-row">
      <span class="stack" ${moneyNum(st.stack)}>${money(st.stack)}</span>
      ${st.bet > 0 ? `<span class="bet" data-key="bet" ${moneyNum(st.bet)}>${money(st.bet)}</span>` : ''}
      ${tags.map((t) => `<span class="tag" data-key="tag-${t}">${t}</span>`).join('')}
    </div>
    <div class="seat-line">
      <div class="last" data-key="last-${esc(last)}" ${st.why ? `title="${esc(st.why)}"` : ''}>${esc(last)}</div>
      ${made ? `<div class="made" title="${esc(made)}">${esc(made)}</div>` : ''}
    </div>
    ${h ? barsHtml(view, k, st.folded || h.phase === 'done') : ''}
  </div>`;
}

function renderTable(s) {
  const h = s.hand;
  const seats = h
    ? h.seats.map((st) => ({ ...st, player: playerById(s, st.pid) }))
    : s.players.filter((p) => !p.out).map((p) => ({ pid: p.id, name: p.name, stack: p.stack, bet: 0, player: p }));
  const view = oddsView(s);
  morph($('#seats'), seats.map((st, k) => seatHtml(s, h, st, k, seats.length, view)).join(''));
  $('#table').dataset.n = seats.length;

  if (!h) {
    morph($('#center'), `<div class="idle" data-key="idle"><div class="logo-word">Fantasy Poker</div>
      <p>${seats.length} players seated · blinds ${money(s.settings.sb)}/${money(s.settings.bb)}</p>
      <p class="hint">Press <kbd>Space</kbd> to deal</p></div>`);
    return;
  }
  const editable = h.phase !== 'done';
  const board = [0, 1, 2, 3, 4].map((i) => (i < h.shown ? cardHtml(h.board5[i], { big: true, edit: editable }) : backHtml(`bk${i}`, true))).join('');
  const label = h.phase === 'done' ? (h.result?.showdown ? 'Showdown' : 'Hand over') : streetName(h.street);
  const pot = potTotal(h);
  morph($('#center'), `
    <div class="street">Hand #${h.no} · ${label}</div>
    <div class="board" data-key="board">${board}</div>
    <div class="pot">Pot <b ${moneyNum(pot)}>${money(pot)}</b></div>
    ${h.phase === 'done' && h.result ? `<div class="result" data-key="result-${h.no}">${esc(h.result.summary)}</div>` : ''}`);
}

// The latest action and the reason behind it, under the table.
function narration(h) {
  if (!h) return '<div class="narration empty"></div>';
  let idx = -1;
  for (let j = h.log.length - 1; j >= 0; j--) if (h.log[j].kind === 'act' || h.log[j].kind === 'result') { idx = j; break; }
  const l = h.log[idx];
  if (!l) return '<div class="narration empty"></div>';
  const more = l.more?.length ? l.more : null;
  return `<div class="narration${ui.narrOpen && more ? ' open' : ''}" data-key="n${h.no}-${idx}">
    <div class="n-head"><b>${esc(l.text)}</b>${l.why ? `<span class="why-inline" title="${esc(l.why)}">${esc(l.why)}</span>` : ''}
      ${more ? `<button class="n-toggle" data-act="narr" aria-expanded="${!!ui.narrOpen}">${ui.narrOpen ? 'Less' : 'Why?'}</button>` : ''}</div>
    ${more && ui.narrOpen ? `<ul class="more">${more.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function renderControls(s) {
  const h = s.hand;
  const dis = ui.auto ? 'disabled' : '';
  const nextLabel = !h || h.phase === 'done' ? (h ? 'Next hand' : 'Deal first hand')
    : h.phase === 'deal' ? `Deal the ${['flop', 'turn', 'river'][h.street]}`
    : `${esc(h.seats[h.toAct].name)} acts`;
  const live = h && h.phase !== 'done';
  let html = narration(h);
  html += `<div class="row main">
    <button class="btn primary big" data-act="next" ${dis} title="Shortcut: Space">▶ ${nextLabel}</button>
    ${live && h.phase === 'bet' ? `<button class="btn" data-act="street" ${dis} title="Shortcut: F">⏭ Finish ${streetName(h.street).toLowerCase()}</button>` : ''}
    ${live ? `<button class="btn ${ui.auto ? 'stop' : ''}" data-act="auto" title="Shortcut: A">${ui.auto ? '■ Stop' : '⏯ Auto-play hand'}</button>` : ''}
    ${!live ? `<button class="btn" data-act="forward" ${dis} title="Play 10 hands instantly">⏩ Sim 10 hands</button>` : ''}
    <button class="btn ghost" data-act="undo" ${dis || !s.undo?.length ? 'disabled' : ''} title="Shortcut: U">↶ Undo</button>
    <span class="spacer"></span>
    ${live ? `<button class="btn ghost small" data-act="newHand" ${dis}>Abandon hand</button>` : ''}
    <label class="speed">Speed <select id="speed">
      ${[[1600, 'Slow'], [900, 'Normal'], [400, 'Fast']].map(([v, l]) => `<option value="${v}" ${ui.speed === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
  </div>`;

  if (live && h.phase === 'bet') {
    const L = legal(h);
    const pot = potTotal(h);
    const key = `${h.no}:${h.log.length}`;
    if (ui.raiseKey !== key) {
      ui.raiseKey = key;
      ui.raiseTo = Math.min(L.maxTo, Math.max(L.minRaiseTo, Math.round(h.curBet + (pot + L.toCall) * 0.66)));
    }
    const size = (f) => Math.min(L.maxTo, Math.max(L.minRaiseTo, Math.round(h.curBet + (pot + L.toCall) * f)));
    html += `<div class="row override">
      <span class="muted">Decide for <b>${esc(L.seat.name)}</b>:</span>
      ${L.toCall > 0 ? `<button class="btn small" data-decide="fold" ${dis}>Fold</button>` : ''}
      <button class="btn small" data-decide="call" ${dis}>${L.toCall > 0 ? `Call ${money(L.toCall)}` : 'Check'}</button>
      ${L.canRaise ? `
        <span class="raise-box">
          <button class="btn small" data-decide="raise" ${dis}>${h.curBet > 0 ? 'Raise to' : 'Bet'}</button>
          <input id="raise-to" type="number" min="${L.minRaiseTo}" max="${L.maxTo}" step="1" value="${ui.raiseTo}">
          <button class="chip-btn" data-size="${size(0.5)}">½ pot</button>
          <button class="chip-btn" data-size="${size(1)}">Pot</button>
          <button class="chip-btn" data-size="${L.maxTo}">All-in</button>
        </span>` : ''}
      <span class="teach">
        <label title="When you decide for a player, nudge their traits toward your choice in spots like this">🎓
          <select id="teach-lesson" aria-label="Teach the player">
            <option value="off" ${ui.teach === 'off' ? 'selected' : ''}>Don't teach</option>
            ${Object.entries(LESSONS).map(([k, l]) => `<option value="${k}" ${ui.teach === k ? 'selected' : ''}>Teach: ${l.short}</option>`).join('')}
          </select></label>
        ${ui.teach !== 'off' ? `<input id="teach-note" placeholder="Why? (optional)" maxlength="80" value="${esc(ui.teachNote)}">` : ''}
      </span>
    </div>`;
  }
  // Keep the row's space between betting rounds so the table above doesn't change size.
  if (!(live && h.phase === 'bet')) html += '<div class="row override placeholder" aria-hidden="true"></div>';
  morph($('#controls'), html);
}

function trailHtml(no, i) {
  if (ui.trail.no !== no) return '';
  const parts = TRAIL_LABEL.filter((l) => ui.trail.rows[l]).map((l) => `${l} ${pct(ui.trail.rows[l][i])}`);
  return parts.length > 1 ? `<div class="trail">${parts.join(' → ')}</div>` : '';
}

function oddsPanel(s) {
  const h = s.hand;
  if (!h) return '<p class="empty">Deal a hand to see everyone\'s odds.</p>';
  if (h.phase === 'done') {
    return `<div class="result-card">${esc(h.result?.summary || '')}</div>
      ${h.result?.showdown ? `<table class="grid"><tr><th>Player</th><th>Hand</th><th>Result</th></tr>
      ${h.seats.map((st, i) => `<tr class="${st.folded ? 'folded' : ''}"><td>${esc(st.name)}${trailHtml(h.no, i)}</td><td>${st.folded ? 'folded' : esc(st.last)}</td>
        <td class="${st.won - st.total > 0 ? 'pos' : st.total > 0 ? 'neg' : ''}">${signed(st.won - st.total)}</td></tr>`).join('')}</table>` : ''}`;
  }
  const { o, pending, stale } = oddsView(s);
  if (!o) return '<p class="empty">Calculating…</p>';
  const winOf = (i) => o.win?.[i] ?? o.eq[i];
  const rows = h.seats.map((st, i) => ({ st, i })).sort((a, b) => (b.st.folded ? -1 : winOf(b.i)) - (a.st.folded ? -1 : winOf(a.i)));
  const val = (x) => (x == null || stale ? '…' : pct(x));
  return `<table class="grid odds ${stale ? 'stale' : ''}">
    <tr><th>Player</th><th>Cards</th><th title="Chance to win if everyone still in sees all five cards">Equity</th>
      <th title="Chance to win with the rest of the hand played out by each personality">Real win</th>
      <th title="Chance this player folds before the hand ends">Folds</th></tr>
    ${rows.map(({ st, i }) => `<tr class="${st.folded ? 'folded' : ''}" data-key="r${st.pid}">
      <td>${esc(st.name)}${trailHtml(h.no, i)}</td>
      <td class="mini-cards">${st.hole.map((c) => `<span class="s${c & 3}">${cardLabel(c)}</span>`).join(' ')}
        <div class="made-mini">${esc(madeHand(h, st))}</div></td>
      <td>${st.folded ? '—' : val(o.eq[i])}</td>
      <td><b>${st.folded ? 'folded' : val(o.win?.[i])}</b></td>
      <td>${st.folded ? '' : val(o.fold?.[i])}</td></tr>`).join('')}
  </table>
  <p class="note"><b>Equity</b> assumes everyone still in goes to showdown. <b>Real win</b> plays the rest of the
  hand out hundreds of times using each player's personality — who'd fold, who'd bluff, who'd call — so a strong hand
  held by a nit facing a maniac can be worth less than its equity.
  <span class="muted">${pending ? 'Running playouts…' : o.n ? `${o.n} playouts · ${o.ms} ms` : ''}</span></p>`;
}

function logPanel(s) {
  const h = s.hand;
  if (!h) return '<p class="empty">No hand yet.</p>';
  const opt = (v, label) => `<option value="${v}" ${ui.whys === v ? 'selected' : ''}>${label}</option>`;
  return `<label class="log-opt">Why they acted <select id="show-whys">${opt('full', 'Full reasoning')}${opt('short', 'One line')}${opt('off', 'Hide')}</select></label>
  <ol class="log">${h.log.map((l) => `<li class="${l.kind}">${esc(l.text)}${ui.whys !== 'off' && l.why ? `<div class="why">${esc(l.why)}</div>` : ''}${ui.whys === 'full' && l.more?.length ? `<ul class="more">${l.more.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>`;
}

// ---------- session graph ----------
// Validated (dark surface, adjacent pairs) categorical order; colour follows the player's seat
// in the player list, so it never changes when someone else is added or busts.
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#95a39b'];
const everyone = (s) => [...s.players, ...(s.bench || [])];
const colorOf = (s, pid) => {
  const all = everyone(s);
  const p = all.find((q) => q.id === pid);
  return SERIES[(p?.hue ?? Math.max(0, all.indexOf(p))) % SERIES.length];
};

function bankrollChart(s) {
  const track = s.track || [];
  if (track.length < 2) return '<p class="empty small">The session graph appears after a couple of hands.</p>';
  const players = everyone(s).filter((p) => track.some((t) => p.id in t.nets));
  const W = 340, H = 190, L = 44, R = 62, T = 10, B = 22;
  const vals = track.flatMap((t) => players.map((p) => t.nets[p.id] ?? 0));
  let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
  if (hi - lo < 10) { hi += 5; lo -= 5; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (i) => L + (i / (track.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const step = niceStep((hi - lo) / 4);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const hiPid = ui.hiPid;
  const lines = players.map((p) => {
    const d = track.map((t, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(t.nets[p.id] ?? 0).toFixed(1)}`).join('');
    const dim = hiPid && hiPid !== p.id ? ' dim' : '';
    return `<path class="line${dim}" d="${d}" stroke="${colorOf(s, p.id)}"/>`;
  }).join('');
  // End labels, nudged apart so names never overlap.
  const ends = players.map((p) => ({ p, v: track.at(-1).nets[p.id] ?? 0 })).sort((a, b) => b.v - a.v)
    .map((e) => ({ ...e, ly: y(e.v) }));
  for (let i = 1; i < ends.length; i++) ends[i].ly = Math.max(ends[i].ly, ends[i - 1].ly + 11);
  const over = ends.length ? ends.at(-1).ly - (H - B + 4) : 0;
  if (over > 0) for (const e of ends) e.ly -= over;
  const labels = ends.map((e) => `<g class="end${hiPid && hiPid !== e.p.id ? ' dim' : ''}">
    <circle cx="${x(track.length - 1)}" cy="${y(e.v)}" r="3" fill="${colorOf(s, e.p.id)}"/>
    <text x="${W - R + 8}" y="${e.ly + 3.5}">${esc(e.p.name)}</text></g>`).join('');
  let hover = '';
  if (ui.hoverIdx != null && ui.hoverIdx < track.length) {
    const i = ui.hoverIdx, t = track[i], hx = x(i);
    const rows = players.map((p) => ({ p, v: t.nets[p.id] ?? 0 })).sort((a, b) => b.v - a.v);
    hover = `<line class="cross" x1="${hx}" x2="${hx}" y1="${T}" y2="${H - B}"/>
      ${rows.map((r) => `<circle class="pt" cx="${hx}" cy="${y(r.v)}" r="4" fill="${colorOf(s, r.p.id)}"/>`).join('')}`;
    ui.tip = { left: Math.min(76, Math.max(24, (hx / W) * 100)), html: `<b>After hand #${t.no}</b>${rows.map((r) => `<div><i style="background:${colorOf(s, r.p.id)}"></i>${esc(r.p.name)}<span class="${r.v > 0 ? 'pos' : r.v < 0 ? 'neg' : ''}">${signed(r.v)}</span></div>`).join('')}` };
  } else ui.tip = null;
  return `<figure class="chart" data-key="chart">
    <figcaption>Net result over the session <span class="muted">· last ${track.length} hands</span></figcaption>
    <div class="chart-box">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Each player's net result after every hand">
        ${ticks.map((v) => `<line class="grid${v === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
          <text class="tick" x="${L - 6}" y="${y(v) + 3.5}">${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString()}</text>`).join('')}
        <text class="tick x" x="${L}" y="${H - 6}">#${track[0].no}</text>
        <text class="tick x end-x" x="${W - R}" y="${H - 6}">#${track.at(-1).no}</text>
        ${lines}${labels}${hover}
        <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" data-n="${track.length}" data-l="${L}" data-w="${W - L - R}" data-vw="${W}"/>
      </svg>
      ${ui.tip ? `<div class="tip" style="left:${ui.tip.left}%">${ui.tip.html}</div>` : ''}
    </div>
  </figure>`;
}

function niceStep(raw) {
  const m = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const f = raw / m;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * m;
}

function moneyPanel(s) {
  const live = new Map((s.hand && !s.hand.committed ? s.hand.seats : []).map((st) => [st.pid, st]));
  const benched = new Set((s.bench || []).map((p) => p.id));
  const rows = everyone(s).map((p) => {
    const st = live.get(p.id);
    const stack = st ? st.stack + (s.hand.phase === 'done' ? 0 : st.total) : p.stack;
    return { p, stack, net: stack - p.bought };
  }).sort((a, b) => b.net - a.net);
  const per = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return `${bankrollChart(s)}<table class="grid money">
    <tr><th>Player</th><th>Stack</th><th>Bought in</th><th>Net</th><th title="Voluntarily put money in pot">VPIP</th><th title="Preflop raise">PFR</th><th>Won</th></tr>
    ${rows.map(({ p, stack, net }) => `<tr class="${p.out || benched.has(p.id) ? 'folded' : ''}${ui.hiPid === p.id ? ' hi' : ''}" data-key="m${p.id}" data-pid="${p.id}">
      <td title="${esc(infoOf(p).desc)}"><i class="swatch" style="background:${colorOf(s, p.id)}"></i>${esc(infoOf(p).emoji)} ${esc(p.name)}${benched.has(p.id) ? ' <span class="tag">bench</span>' : ''}</td><td ${moneyNum(stack)}>${money(stack)}</td><td>${money(p.bought)}</td>
      <td class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}"><b>${signed(net)}</b></td>
      <td>${per(p.stats.vpip, p.stats.hands)}</td><td>${per(p.stats.pfr, p.stats.hands)}</td>
      <td>${p.stats.wins}/${p.stats.hands}</td></tr>`).join('')}
  </table>
  <p class="note">Stacks include chips in the current pot. Busted players ${s.settings.autoRebuy ? 'automatically rebuy' : 'sit out until topped up in Edit table'} for ${money(s.settings.buyIn)}.</p>`;
}

function historyPanel(s) {
  if (!s.history?.length) return '<p class="empty">Finished hands show up here.</p>';
  return `<ol class="history">${s.history.map((x) => `<li><span class="muted">#${x.no}</span> ${esc(x.text)}</li>`).join('')}</ol>`;
}

function renderPanel(s) {
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === ui.tab);
  const f = { odds: oddsPanel, log: logPanel, money: moneyPanel, history: historyPanel }[ui.tab] || oddsPanel;
  const panel = $('#panel');
  const atBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 20;
  if (panel.dataset.tab !== ui.tab) { panel.dataset.tab = ui.tab; panel.innerHTML = ''; }
  morph(panel, f(s));
  if (ui.tab === 'log' && atBottom) panel.scrollTop = panel.scrollHeight;
}

// Batched to one paint per frame: worker progress and clicks can arrive in bursts.
// (The timeout covers windows where the browser throttles animation frames.)
let frameQueued = false;
function render() {
  if (frameQueued) return;
  frameQueued = true;
  const run = () => {
    if (!frameQueued) return;
    frameQueued = false;
    if (!state) return;
    ensureOdds(state);
    renderTable(state);
    renderControls(state);
    renderPanel(state);
  };
  requestAnimationFrame(run);
  setTimeout(run, 60);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- card picker ----------

function openPicker(from) {
  const h = state.hand;
  const visible = new Set([...h.seats.flatMap((s) => s.hole), ...h.board5.slice(0, h.shown)]);
  const dlg = $('#picker');
  dlg.innerHTML = `<form method="dialog" class="picker">
    <h2>Replace ${cardLabel(from)}</h2>
    <p class="muted">Pick any card. If it's already in someone's hand or on the board, the two swap.</p>
    <div class="deck">${[0, 1, 2, 3].map((su) => `<div class="suit-row">${[...Array(13).keys()].reverse().map((r) => {
      const c = r * 4 + su;
      return `<button value="${c}" class="card s${su} ${c === from ? 'current' : visible.has(c) ? 'used' : ''}" aria-label="${RANKS[r]} of ${SUIT_NAMES[su]}">
        <span class="r">${RANKS[r] === 'T' ? '10' : RANKS[r]}</span><span class="su">${SUIT_SYMBOLS[su]}</span></button>`;
    }).join('')}</div>`).join('')}</div>
    <div class="dlg-foot"><button class="btn ghost" value="">Cancel</button></div>
  </form>`;
  // Submit fires reliably (some browsers delay the dialog's close event).
  dlg.onsubmit = (ev) => {
    const to = ev.submitter?.value;
    if (to === '' || to == null || +to === from) return;
    mutate((d) => {
      if (!d.hand || d.hand.phase === 'done') return false;
      pushUndo(d);
      swapCard(d.hand, from, +to);
    });
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- table editor ----------

// ---------- merging table edits ----------

const PLAYER_FIELDS = ['name', 'preset', 'out', 'emoji', 'avatar', 'label', 'tagline'];
const clean = (k, v) => (k === 'name' ? v.trim() || 'Player' : typeof v === 'string' ? v.trim() : v);

// Only what this person changed: settings keys, player fields, single traits, buy-ins, adds, removals.
function editorDiff(orig, ed) {
  const settings = {};
  for (const k in ed.settings) if (ed.settings[k] !== orig.settings[k]) settings[k] = ed.settings[k];
  const before = new Map(orig.players.map((p) => [p.id, p]));
  const players = [], added = [];
  for (const e of ed.players) {
    const o = before.get(e.id);
    if (!o) { added.push(e); continue; }
    const fields = {}, profile = {};
    for (const k of PLAYER_FIELDS) if ((e[k] ?? '') !== (o[k] ?? '')) fields[k] = clean(k, e[k] ?? '');
    for (const k in e.profile) if (e.profile[k] !== o.profile[k]) profile[k] = e.profile[k];
    if (Object.keys(fields).length || Object.keys(profile).length || e.rebuy) players.push({ id: e.id, fields, profile, rebuy: e.rebuy });
  }
  const at = (list, id) => list.some((p) => p.id === id);
  const gone = orig.players.filter((o) => !at(ed.players, o.id));
  const benched = gone.filter((o) => at(ed.bench, o.id)).map((o) => o.id);
  const removed = gone.filter((o) => !at(ed.bench, o.id)).map((o) => o.id);
  const forgotten = orig.bench.filter((o) => !at(ed.bench, o.id) && !at(ed.players, o.id)).map((o) => o.id);
  const order = ed.players.map((p) => p.id);
  if (!Object.keys(settings).length && !players.length && !added.length && !removed.length
    && !benched.length && !forgotten.length && !ed.reset) return null;
  return { settings, players, added, removed, benched, forgotten, order, reset: ed.reset };
}

function applyEdit(d, c) {
  Object.assign(d.settings, c.settings);
  if (d.settings.bb < d.settings.sb) d.settings.bb = d.settings.sb;
  const byId = new Map(d.players.map((p) => [p.id, p]));
  for (const ch of c.players) {
    const p = byId.get(ch.id);
    if (!p) continue; // someone else removed them meanwhile
    Object.assign(p, ch.fields);
    p.profile = { ...fullProfile(p), ...ch.profile };
    p.stack += ch.rebuy;
    p.bought += ch.rebuy;
  }
  d.bench ||= [];
  for (const e of c.added) {
    if (byId.has(e.id)) continue;
    // Back from the bench keeps their chips and stats; otherwise a brand-new player.
    const fromBench = d.bench.find((q) => q.id === e.id);
    const p = fromBench || Object.assign(newPlayer('Player', 'fish', 0), { id: e.id, stack: e.stack, bought: e.bought });
    if (fromBench) d.bench = d.bench.filter((q) => q !== fromBench);
    else if (e.isNew !== true && !fromBench) continue; // deleted from the bench by someone else
    p.profile = e.profile;
    p.stack += e.rebuy;
    p.bought += e.rebuy;
    for (const k of PLAYER_FIELDS) p[k] = clean(k, e[k] ?? '');
    d.players.push(p);
    byId.set(p.id, p);
  }
  // Players still sitting in an unfinished hand can't vanish mid-hand.
  const live = new Set(d.hand && d.hand.phase !== 'done' ? d.hand.seats.map((st) => st.pid) : []);
  for (const id of c.benched) {
    const p = byId.get(id);
    if (p && !live.has(id) && !d.bench.some((q) => q.id === id)) d.bench.unshift(p);
  }
  d.players = d.players.filter((p) => !(c.removed.includes(p.id) || c.benched.includes(p.id)) || live.has(p.id));
  d.bench = d.bench.filter((p) => !c.forgotten.includes(p.id) && !d.players.some((q) => q.id === p.id));
  // Keep this person's ordering for the players they saw; anyone added elsewhere stays at the end.
  const rank = new Map(c.order.map((id, i) => [id, i]));
  d.players.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  if (d.hand) for (const st of d.hand.seats) { const p = byId.get(st.pid); if (p) st.name = p.name; }
  assignHues(d);
  if (c.reset) {
    for (const p of [...d.players, ...d.bench]) {
      p.stack = d.settings.buyIn; p.bought = d.settings.buyIn;
      p.stats = { hands: 0, vpip: 0, pfr: 0, wins: 0, biggest: 0 };
    }
    d.history = [];
    d.track = [];
    d.hand = null;
    d.undo = [];
  }
}

function openEditor() {
  if (!state) return;
  const inHand = new Set(state.hand && state.hand.phase !== 'done' ? state.hand.seats.map((s) => s.pid) : []);
  const ed = {
    settings: { ...state.settings },
    players: state.players.map((p) => ({ ...p, profile: fullProfile(p), rebuy: 0 })),
    bench: (state.bench || []).map((p) => ({ ...p, profile: fullProfile(p), rebuy: 0 })),
    reset: false,
  };
  // What the table looked like when the dialog opened, so Save only sends what you changed.
  const orig = structuredClone({ settings: ed.settings, players: ed.players, bench: ed.bench });
  const dlg = $('#editor');

  const traitRow = (p, t) => `<label class="trait">
    <span class="t-label">${t.label} <b>${t.key === 'callReq' ? `${p.profile[t.key].toFixed(2)}× pot odds` : Math.round(p.profile[t.key] * 100)}</b></span>
    <input type="range" data-trait="${t.key}" min="${t.min}" max="${t.max}" step="${t.step}" value="${p.profile[t.key]}">
    <span class="t-ends"><span>${t.lo}</span><span>${t.hi}</span></span></label>`;

  const advVal = (p, key) => p.profile[key] ?? ADV_DEFAULTS[key];
  const advItem = (p, t) => {
    const v = advVal(p, t.key);
    const changed = v !== ADV_DEFAULTS[t.key] ? ' changed' : '';
    const hint = t.hint ? ` <span class="muted">· ${esc(t.hint)}</span>` : '';
    if (t.kind === 'toggle') {
      return `<label class="adv-toggle${changed}"><input type="checkbox" data-adv="${t.key}" ${v ? 'checked' : ''}> <span>${esc(t.label)}${hint}</span></label>`;
    }
    if (t.kind === 'hands') {
      const picked = favSet(v);
      return `<div class="adv-hands${changed}">
        <span>${esc(t.label)}${hint}</span>
        <div class="hands-summary">
          <span class="${picked.size ? '' : 'muted'}">${picked.size ? [...picked].join(', ') : 'None'}</span>
          <button type="button" class="chip-btn" data-x="favGrid">${p.favOpen ? 'Done' : 'Choose…'}</button>
          ${picked.size ? '<button type="button" class="chip-btn" data-x="favClear">Clear</button>' : ''}
        </div>
        ${p.favOpen ? `<div class="hand-grid" role="group" aria-label="Lucky hands">
          ${HAND_GRID.flat().map((c) => `<button type="button" class="hg ${c.length === 2 ? 'pair' : c[2] === 's' ? 'suited' : 'off'}${picked.has(c) ? ' on' : ''}"
            data-x="fav" data-v="${c}" aria-pressed="${picked.has(c)}" title="${c.length === 2 ? `Pocket ${c[0]}s` : `${c[0]}-${c[1]} ${c[2] === 's' ? 'suited' : 'offsuit'}`}">${c}</button>`).join('')}
        </div>
        <p class="muted hg-key">Top right: suited · bottom left: offsuit · diagonal: pairs</p>` : ''}
      </div>`;
    }
    if (t.kind === 'select' || t.kind === 'player') {
      const opts = t.kind === 'select' ? t.options
        : [['', 'Nobody'], ...ed.players.filter((q) => q.id !== p.id).map((q) => [q.id, q.name])];
      return `<label class="adv-select${changed}"><span>${esc(t.label)}${hint}</span>
        <select data-adv="${t.key}">${opts.map(([val, l]) => `<option value="${esc(val)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    }
    return `<label class="trait${changed}">
      <span class="t-label">${esc(t.label)}${hint} <b>${Math.round(v * 100)}</b></span>
      <input type="range" data-adv="${t.key}" min="0" max="1" step="0.01" value="${v}">
      <span class="t-ends"><span>${esc(t.lo)}</span><span>${esc(t.hi)}</span></span></label>`;
  };
  const advancedHtml = (p) => {
    const n = advChanged(p.profile);
    return `<div class="adv">
      <button type="button" class="adv-head" data-x="adv" aria-expanded="${!!p.advOpen}">
        ${p.advOpen ? '▾' : '▸'} Advanced tweaks <span class="muted">${n ? `${n} set` : 'all default'}</span></button>
      ${p.advOpen ? `<div class="adv-body">
        ${ADVANCED.map((g) => `<div class="adv-group"><h4>${esc(g.group)}</h4>${g.items.map((t) => advItem(p, t)).join('')}</div>`).join('')}
        <div class="adv-foot"><button type="button" class="btn small ghost" data-x="advReset" ${n ? '' : 'disabled'}>Reset advanced to defaults</button></div>
      </div>` : ''}
    </div>`;
  };
  // Tweaking a preset turns it custom, but it keeps its name and emoji unless renamed.
  const toCustom = (p) => {
    if (p.preset in PRESETS) {
      const base = PRESETS[p.preset];
      p.emoji ||= base.emoji;
      p.label ||= base.name;
      p.tagline ||= base.desc;
      p.avatar ||= p.preset; // keep their picture too
    }
    p.preset = 'custom';
  };

  const playerRow = (p, i) => `<div class="ed-player" data-i="${i}">
    <div class="ed-main">
      ${avatarHtml(p)}
      <input class="name-in" data-f="name" value="${esc(p.name)}" maxlength="16" aria-label="Name">
      <select data-f="preset" aria-label="Personality">
        ${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${p.preset === k ? 'selected' : ''}>${v.emoji} ${v.name}</option>`).join('')}
        <option value="custom" ${p.preset in PRESETS ? '' : 'selected'}>${esc(p.emoji || '🎛️')} ${esc(p.label || 'Custom')}</option>
      </select>
      <button type="button" class="btn small ghost" data-x="tune">Tune ▾</button>
      <span class="ed-money">${money(p.stack + p.rebuy)} <span class="muted">· in for ${money(p.bought + p.rebuy)}</span></span>
      <button type="button" class="btn small" data-x="rebuy" title="Add one buy-in to this player's stack">+ Buy-in</button>
      <label class="check"><input type="checkbox" data-f="out" ${p.out ? 'checked' : ''}> Sit out</label>
      <button type="button" class="btn small ghost" data-x="remove" ${inHand.has(p.id) ? 'disabled title="In the current hand"' : `title="${p.isNew ? 'Remove' : 'Move to the bench — keeps their personality, chips and stats'}"`}>${p.isNew ? '✕' : 'Bench'}</button>
    </div>
    <div class="tune" ${p.open ? '' : 'hidden'}>
      <div class="identity">
        <label class="id-emoji">Emoji <input data-f="emoji" value="${esc(p.emoji || '')}" placeholder="${presetInfo(p.preset).emoji}" maxlength="8"></label>
        <label class="id-label">Label <input data-f="label" value="${esc(p.label || '')}" placeholder="${esc(presetInfo(p.preset).name)}" maxlength="24"></label>
        <label class="id-tag">Tagline <input data-f="tagline" value="${esc(p.tagline || '')}" placeholder="${esc(presetInfo(p.preset).desc)}" maxlength="90"></label>
        <div class="avatar-picks" role="group" aria-label="Avatar">
          <span class="muted">Avatar</span>
          <button type="button" class="av-pick${!p.avatar ? ' on' : ''}" data-x="avatar" data-v="" title="Automatic">Auto</button>
          ${AVATAR_KEYS.map((k) => `<button type="button" class="av-pick${p.avatar === k ? ' on' : ''}" data-x="avatar" data-v="${k}"
            title="${k === 'custom' ? 'Mystery player' : esc(PRESETS[k].name)}"><img src="assets/avatars/${k}.jpg" alt=""></button>`).join('')}
          <button type="button" class="av-pick emoji${p.avatar === 'emoji' ? ' on' : ''}" data-x="avatar" data-v="emoji" title="Use the emoji">${esc(p.emoji || presetInfo(p.preset).emoji)}</button>
        </div>
        <div class="emoji-picks">${EMOJI_PICKS.map((em) => `<button type="button" class="pick${p.emoji === em ? ' on' : ''}" data-x="emoji" data-v="${em}">${em}</button>`).join('')}</div>
      </div>
      ${TRAITS.map((t) => traitRow(p, t)).join('')}
      ${advancedHtml(p)}
    </div>
  </div>`;

  const draw = () => {
    const S = ed.settings;
    morph(dlg, `<form method="dialog" class="editor">
      <h2>Table setup</h2>
      <div class="settings">
        <label>Small blind <input type="number" min="1" data-s="sb" value="${S.sb}"></label>
        <label>Big blind <input type="number" min="1" data-s="bb" value="${S.bb}"></label>
        <label>Buy-in <input type="number" min="10" data-s="buyIn" value="${S.buyIn}"></label>
        <label class="check"><input type="checkbox" data-s="autoRebuy" ${S.autoRebuy ? 'checked' : ''}> Auto-rebuy when busted</label>
        <label class="check"><input type="checkbox" data-s="chatter" ${S.chatter !== false ? 'checked' : ''}> Table chatter</label>
      </div>
      <h3>Players <span class="muted">${ed.players.length}/9</span></h3>
      <div class="ed-players">${ed.players.map(playerRow).join('')}</div>
      <button type="button" class="btn" data-x="add" ${ed.players.length >= 9 ? 'disabled' : ''}>+ Add player</button>
      ${ed.bench.length ? `<h3>Bench <span class="muted">· saved players, not at the table</span></h3>
      <div class="bench">${ed.bench.map((p) => `<div class="bench-row" data-id="${p.id}">
        ${avatarHtml(p)}
        <div class="who"><div class="name">${esc(p.name)}</div><div class="type">${esc(infoOf(p).emoji)} ${esc(infoOf(p).name)} · ${money(p.stack)} <span class="muted">(${signed(p.stack - p.bought)})</span></div></div>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-x="unbench" ${ed.players.length >= 9 ? 'disabled title="Table is full"' : ''}>Bring back</button>
        <button type="button" class="btn small ghost danger" data-x="forget" title="Delete for good">✕</button>
      </div>`).join('')}</div>` : ''}
      <div class="dlg-foot">
        <button type="button" class="btn ghost danger" data-x="reset">${ed.reset ? '✓ Bankrolls will reset' : 'Reset bankrolls & stats'}</button>
        <span class="spacer"></span>
        <button class="btn ghost" value="cancel">Cancel</button>
        <button class="btn primary" value="save">Save</button>
      </div>
    </form>`);
  };

  dlg.oninput = (e) => {
    const el = e.target;
    const row = el.closest('.ed-player');
    if (el.dataset.s) {
      ed.settings[el.dataset.s] = el.type === 'checkbox' ? el.checked : Math.max(1, Math.round(+el.value || 1));
      return;
    }
    if (!row) return;
    const p = ed.players[+row.dataset.i];
    if (el.dataset.f === 'name') p.name = el.value.slice(0, 16);
    if (el.dataset.f === 'out') p.out = el.checked;
    if (['emoji', 'label', 'tagline'].includes(el.dataset.f)) {
      p[el.dataset.f] = el.value;
      if (el.dataset.f === 'emoji') draw();
    }
    if (el.dataset.f === 'preset') {
      p.preset = el.value;
      if (PRESETS[el.value]) {
        p.profile = { ...PRESETS[el.value].profile };
        p.emoji = p.label = p.tagline = p.avatar = ''; // a preset brings its own identity
      }
      p.open = true;
      draw();
    }
    if (el.dataset.adv) {
      const t = ADVANCED.flatMap((g) => g.items).find((x) => x.key === el.dataset.adv);
      p.profile[t.key] = t.kind === 'toggle' ? el.checked : t.kind === 'range' ? +el.value : el.value;
      const wasPreset = p.preset in PRESETS;
      toCustom(p);
      if (t.kind === 'range' && !wasPreset) {
        el.closest('.trait').querySelector('b').textContent = Math.round(+el.value * 100);
        el.closest('.trait').classList.toggle('changed', +el.value !== ADV_DEFAULTS[t.key]);
        row.querySelector('.adv-head .muted').textContent = advChanged(p.profile) ? `${advChanged(p.profile)} set` : 'all default';
      } else draw();
      return;
    }
    if (el.dataset.trait) {
      p.profile[el.dataset.trait] = +el.value;
      if (p.preset in PRESETS) { toCustom(p); draw(); }
      const b = el.closest('.trait').querySelector('b');
      b.textContent = el.dataset.trait === 'callReq' ? `${(+el.value).toFixed(2)}× pot odds` : Math.round(+el.value * 100);
      row.querySelector('select').value = 'custom';
    }
  };
  dlg.onclick = (e) => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (!x) return;
    const row = e.target.closest('.ed-player');
    const p = row && ed.players[+row.dataset.i];
    if (x === 'tune') p.open = !p.open;
    if (x === 'adv') p.advOpen = !p.advOpen;
    if (x === 'advReset') Object.assign(p.profile, ADV_DEFAULTS);
    if (x === 'favGrid') p.favOpen = !p.favOpen;
    if (x === 'favClear' || x === 'fav') {
      const picked = favSet(p.profile.fav);
      if (x === 'favClear') picked.clear();
      else if (!picked.delete(e.target.closest('[data-v]').dataset.v)) picked.add(e.target.closest('[data-v]').dataset.v);
      p.profile.fav = [...picked].join(',');
      toCustom(p);
    }
    if (x === 'avatar') p.avatar = e.target.closest('[data-v]').dataset.v;
    if (x === 'emoji') p.emoji = p.emoji === e.target.dataset.v ? '' : e.target.dataset.v;
    if (x === 'rebuy') p.rebuy += ed.settings.buyIn;
    if (x === 'remove') {
      const [gone] = ed.players.splice(+row.dataset.i, 1);
      if (!gone.isNew) ed.bench.unshift({ ...gone, open: false, rebuy: 0 });
    }
    const benchId = e.target.closest('.bench-row')?.dataset.id;
    if (x === 'unbench' && ed.players.length < 9) {
      const k = ed.bench.findIndex((q) => q.id === benchId);
      ed.players.push(...ed.bench.splice(k, 1));
    }
    if (x === 'forget' && confirm('Delete this player for good?')) ed.bench = ed.bench.filter((q) => q.id !== benchId);
    if (x === 'add' && ed.players.length < 9) {
      const used = new Set(ed.players.map((q) => q.name));
      const name = ['Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lena', 'Milo', 'Nora', 'Omar', 'Pia'].find((nm) => !used.has(nm)) || 'Player';
      ed.players.push({ ...newPlayer(name, pick(Object.keys(PRESETS)), ed.settings.buyIn), rebuy: 0, isNew: true, open: true });
    }
    if (x === 'reset') ed.reset = !ed.reset;
    draw();
  };
  dlg.onsubmit = (ev) => {
    if (ev.submitter?.value !== 'save') return;
    const S = ed.settings;
    if (S.bb < S.sb) S.bb = S.sb;
    if (ed.players.filter((p) => !p.out).length < 2) toast('Heads up: fewer than two players are seated.');
    const change = editorDiff(orig, ed);
    if (!change) return;
    // Applied to whatever the latest table is, and re-applied if someone else saved first,
    // so two people editing different things both keep their changes.
    mutate((d) => applyEdit(d, change), { rebase: true });
  };
  draw();
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- wiring ----------

$('#controls').addEventListener('click', (e) => {
  const size = e.target.closest('[data-size]');
  if (size) { ui.raiseTo = +size.dataset.size; $('#raise-to').value = ui.raiseTo; return; }
  const d = e.target.closest('[data-decide]');
  if (d) return act.decide(d.dataset.decide);
  const a = e.target.closest('[data-act]');
  if (a && act[a.dataset.act]) act[a.dataset.act]();
});
$('#controls').addEventListener('input', (e) => {
  if (e.target.id === 'raise-to') ui.raiseTo = +e.target.value;
  if (e.target.id === 'teach-lesson') { ui.teach = e.target.value; lsSet('teach', ui.teach); render(); }
  if (e.target.id === 'teach-note') ui.teachNote = e.target.value;
  if (e.target.id === 'speed') { ui.speed = +e.target.value; lsSet('speed', ui.speed); }
});
$('#table').addEventListener('click', (e) => {
  const c = e.target.closest('[data-card]');
  if (c && !ui.auto) openPicker(+c.dataset.card);
});
$('#panel').addEventListener('pointermove', (e) => {
  const hit = e.target.closest('.hit');
  const row = e.target.closest('tr[data-pid]');
  let idx = null;
  if (hit) {
    const svg = hit.ownerSVGElement.getBoundingClientRect();
    const vx = ((e.clientX - svg.left) / svg.width) * +hit.dataset.vw;
    idx = Math.round(((vx - +hit.dataset.l) / +hit.dataset.w) * (+hit.dataset.n - 1));
    idx = Math.max(0, Math.min(+hit.dataset.n - 1, idx));
  }
  const pid = row ? row.dataset.pid : null;
  if (idx !== ui.hoverIdx || pid !== ui.hiPid) { ui.hoverIdx = idx; ui.hiPid = pid; render(); }
});
$('#panel').addEventListener('pointerleave', () => {
  if (ui.hoverIdx == null && !ui.hiPid) return;
  ui.hoverIdx = null; ui.hiPid = null; render();
});
$('#panel').addEventListener('input', (e) => {
  if (e.target.id !== 'show-whys') return;
  ui.whys = e.target.value;
  lsSet('whys', ui.whys);
  render();
});
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tab]');
  if (!t) return;
  ui.tab = t.dataset.tab;
  lsSet('tab', ui.tab);
  render();
});
$('#edit-table').addEventListener('click', openEditor);
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey) return;
  if (e.key === ' ' || e.key === 'ArrowRight') { e.preventDefault(); if (!ui.auto) act.next(); }
  const k = e.key.toLowerCase();
  if (k === 'u' && !ui.auto) act.undo();
  if (k === 'f' && !ui.auto) act.street();
  if (k === 'a') act.auto();
});
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !store) return;
  pollOnce();
});

for (const key of [...Object.keys(PRESETS), 'custom']) {
  const img = new Image();
  img.onload = () => { avatars.add(key); render(); };
  img.src = `assets/avatars/${key}.jpg`;
}

async function init() {
  store = makeStore();
  try {
    let s = await store.load();
    if (!s) {
      s = createTable();
      try { await store.save(s, { create: true }); } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
        s = await store.load();
      }
    }
    state = s;
    syncOk();
    render();
  } catch (e) {
    setSync('err', `Can't reach table: ${e.message}`);
  }
  pollLoop();
  // The bots' preflop chart takes a moment to build; do it before the first click needs it.
  (window.requestIdleCallback || setTimeout)(() => preflopTop([48, 52 - 8]));
}

init();
