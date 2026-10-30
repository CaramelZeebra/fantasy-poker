import { POLL_MS } from './config.js';
import { makeStore, ConflictError } from './store.js';
import {
  createTable, startHand, step, profilesFor, potTotal, legal, applyAction,
  pushUndo, swapCard, newPlayer, streetName,
} from './engine.js';
import { PRESETS, TRAITS, presetInfo, preflopTop } from './bots.js';
import { RANKS, SUIT_SYMBOLS, SUIT_NAMES, cardLabel, describeScore, evaluate } from './cards.js';
import { morph } from './morph.js';
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
};
const avatars = new Set();
let store, state = null;

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

function setSync(kind, text) {
  $('#sync').className = `sync ${kind}`;
  $('#sync-text').textContent = text;
}
const syncOk = () => setSync(store.label === 'online' ? 'ok' : 'local', store.label === 'online' ? 'Live' : 'Local only');

async function lostRace() {
  dirty = false;
  toast('Someone else moved first — synced to their version.');
  const s = await store.load().catch(() => null);
  if (s) { state = s; render(); }
}

const flush = () => net(async () => {
  while (dirty) {
    dirty = false;
    try {
      await store.save(state);
      syncOk();
    } catch (e) {
      if (e instanceof ConflictError) return lostRace();
      dirty = true;
      setSync('err', 'Offline — will retry');
      return;
    }
  }
});

const pollOnce = () => net(async () => {
  if (dirty) return;
  const s = await store.poll();
  if (s && dirty) return lostRace(); // they wrote while we were mid-click
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
function mutate(fn) {
  if (!state) return false;
  const draft = structuredClone(state);
  if (fn(draft) === false) return false;
  draft.rev = (draft.rev || 0) + 1;
  draft.updatedAt = Date.now();
  state = draft;
  dirty = true;
  render();
  flush();
  return true;
}

// ---------- actions ----------

const act = {
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
    mutate((d) => {
      if (!d.hand || d.hand.phase !== 'bet') return false;
      pushUndo(d);
      applyAction(d.hand, { a, to });
    });
  },
};

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

function avatarHtml(p) {
  const key = p?.preset in PRESETS ? p.preset : 'custom';
  if (key === 'custom' && p?.emoji) return `<div class="avatar emoji" aria-hidden="true">${esc(p.emoji)}</div>`;
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
  const last = st.allIn && !st.folded && h?.phase !== 'done' ? 'All-in' : st.last || '';
  const made = madeHand(h, st);
  return `<div class="${cls.join(' ')}" data-key="seat-${st.pid}" style="--x:${x}%;--y:${y}%">
    <div class="seat-head">
      ${avatarHtml(p)}
      <div class="who">
        <div class="name">${esc(st.name)}${dealer ? '<span class="dealer" title="Dealer button">D</span>' : ''}</div>
        <div class="type" title="${esc(info.desc)}">${esc(info.emoji)} ${esc(info.name)}</div>
      </div>
    </div>
    <div class="hole">${cards}</div>
    ${h ? `<div class="made">${esc(made)}</div>` : ''}
    <div class="money-row">
      <span class="stack" ${moneyNum(st.stack)}>${money(st.stack)}</span>
      ${st.bet > 0 ? `<span class="bet" data-key="bet" ${moneyNum(st.bet)}>${money(st.bet)}</span>` : ''}
      ${tags.map((t) => `<span class="tag" data-key="tag-${t}">${t}</span>`).join('')}
    </div>
    <div class="last-wrap"><div class="last" data-key="last-${esc(last)}">${esc(last)}</div></div>
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

function renderControls(s) {
  const h = s.hand;
  const dis = ui.auto ? 'disabled' : '';
  const nextLabel = !h || h.phase === 'done' ? (h ? 'Next hand' : 'Deal first hand')
    : h.phase === 'deal' ? `Deal the ${['flop', 'turn', 'river'][h.street]}`
    : `${esc(h.seats[h.toAct].name)} acts`;
  const live = h && h.phase !== 'done';
  let html = `<div class="row main">
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
      <span class="muted">Or decide for <b>${esc(L.seat.name)}</b>:</span>
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
    </div>`;
  }
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
  return `<ol class="log">${h.log.map((l) => `<li class="${l.kind}">${esc(l.text)}</li>`).join('')}</ol>`;
}

function moneyPanel(s) {
  const live = new Map((s.hand && !s.hand.committed ? s.hand.seats : []).map((st) => [st.pid, st]));
  const rows = s.players.map((p) => {
    const st = live.get(p.id);
    const stack = st ? st.stack + (s.hand.phase === 'done' ? 0 : st.total) : p.stack;
    return { p, stack, net: stack - p.bought };
  }).sort((a, b) => b.net - a.net);
  const per = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return `<table class="grid money">
    <tr><th>Player</th><th>Stack</th><th>Bought in</th><th>Net</th><th title="Voluntarily put money in pot">VPIP</th><th title="Preflop raise">PFR</th><th>Won</th></tr>
    ${rows.map(({ p, stack, net }) => `<tr class="${p.out ? 'folded' : ''}" data-key="m${p.id}">
      <td title="${esc(infoOf(p).desc)}">${esc(infoOf(p).emoji)} ${esc(p.name)}</td><td ${moneyNum(stack)}>${money(stack)}</td><td>${money(p.bought)}</td>
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
  dlg.onclose = () => {
    const to = dlg.returnValue;
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

function openEditor() {
  if (!state) return;
  const inHand = new Set(state.hand && state.hand.phase !== 'done' ? state.hand.seats.map((s) => s.pid) : []);
  const ed = {
    settings: { ...state.settings },
    players: state.players.map((p) => ({ ...p, profile: { ...p.profile }, rebuy: 0 })),
    reset: false,
  };
  const dlg = $('#editor');

  const traitRow = (p, t) => `<label class="trait">
    <span class="t-label">${t.label} <b>${t.key === 'callReq' ? `${p.profile[t.key].toFixed(2)}× pot odds` : Math.round(p.profile[t.key] * 100)}</b></span>
    <input type="range" data-trait="${t.key}" min="${t.min}" max="${t.max}" step="${t.step}" value="${p.profile[t.key]}">
    <span class="t-ends"><span>${t.lo}</span><span>${t.hi}</span></span></label>`;

  const playerRow = (p, i) => `<div class="ed-player" data-i="${i}">
    <div class="ed-main">
      ${avatarHtml(p)}
      <input class="name-in" data-f="name" value="${esc(p.name)}" maxlength="16" aria-label="Name">
      <select data-f="preset" aria-label="Personality">
        ${Object.entries(PRESETS).map(([k, v]) => `<option value="${k}" ${p.preset === k ? 'selected' : ''}>${v.emoji} ${v.name}</option>`).join('')}
        <option value="custom" ${p.preset in PRESETS ? '' : 'selected'}>${esc(p.emoji || '🎛️')} Custom</option>
      </select>
      <button type="button" class="btn small ghost" data-x="tune">Tune ▾</button>
      <span class="ed-money">${money(p.stack + p.rebuy)} <span class="muted">· in for ${money(p.bought + p.rebuy)}</span></span>
      <button type="button" class="btn small" data-x="rebuy" title="Add one buy-in to this player's stack">+ Buy-in</button>
      <label class="check"><input type="checkbox" data-f="out" ${p.out ? 'checked' : ''}> Sit out</label>
      <button type="button" class="btn small ghost danger" data-x="remove" ${inHand.has(p.id) ? 'disabled title="In the current hand"' : ''} aria-label="Remove">✕</button>
    </div>
    <div class="tune" ${p.open ? '' : 'hidden'}>
      <div class="identity">
        <label class="id-emoji">Emoji <input data-f="emoji" value="${esc(p.emoji || '')}" placeholder="${presetInfo(p.preset).emoji}" maxlength="8"></label>
        <label class="id-label">Label <input data-f="label" value="${esc(p.label || '')}" placeholder="${esc(presetInfo(p.preset).name)}" maxlength="24"></label>
        <label class="id-tag">Tagline <input data-f="tagline" value="${esc(p.tagline || '')}" placeholder="${esc(presetInfo(p.preset).desc)}" maxlength="90"></label>
        <div class="emoji-picks">${EMOJI_PICKS.map((em) => `<button type="button" class="pick${p.emoji === em ? ' on' : ''}" data-x="emoji" data-v="${em}">${em}</button>`).join('')}</div>
      </div>
      ${TRAITS.map((t) => traitRow(p, t)).join('')}
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
      </div>
      <h3>Players <span class="muted">${ed.players.length}/9</span></h3>
      <div class="ed-players">${ed.players.map(playerRow).join('')}</div>
      <button type="button" class="btn" data-x="add" ${ed.players.length >= 9 ? 'disabled' : ''}>+ Add player</button>
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
        p.emoji = p.label = p.tagline = ''; // a preset brings its own identity
      }
      p.open = true;
      draw();
    }
    if (el.dataset.trait) {
      p.profile[el.dataset.trait] = +el.value;
      p.preset = 'custom';
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
    if (x === 'emoji') p.emoji = p.emoji === e.target.dataset.v ? '' : e.target.dataset.v;
    if (x === 'rebuy') p.rebuy += ed.settings.buyIn;
    if (x === 'remove') ed.players.splice(+row.dataset.i, 1);
    if (x === 'add' && ed.players.length < 9) {
      const used = new Set(ed.players.map((q) => q.name));
      const name = ['Gus', 'Hana', 'Ivo', 'Jade', 'Kai', 'Lena', 'Milo', 'Nora', 'Omar', 'Pia'].find((nm) => !used.has(nm)) || 'Player';
      ed.players.push({ ...newPlayer(name, pick(Object.keys(PRESETS)), ed.settings.buyIn), rebuy: 0, isNew: true, open: true });
    }
    if (x === 'reset') ed.reset = !ed.reset;
    draw();
  };
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    const S = ed.settings;
    if (S.bb < S.sb) S.bb = S.sb;
    if (ed.players.filter((p) => !p.out).length < 2) toast('Heads up: fewer than two players are seated.');
    mutate((d) => {
      d.settings = S;
      const byId = new Map(d.players.map((p) => [p.id, p]));
      const keep = [];
      for (const e of ed.players) {
        const cur = byId.get(e.id);
        if (!cur && !e.isNew) continue; // removed by someone else meanwhile
        const p = cur || newPlayer(e.name, 'fish', 0);
        if (!cur) { p.id = e.id; p.stack = 0; p.bought = 0; }
        Object.assign(p, {
          name: e.name.trim() || 'Player', preset: e.preset, profile: e.profile, out: e.out,
          emoji: (e.emoji || '').trim(), label: (e.label || '').trim(), tagline: (e.tagline || '').trim(),
        });
        p.stack += e.rebuy + (cur ? 0 : e.stack);
        p.bought += e.rebuy + (cur ? 0 : e.bought);
        keep.push(p);
      }
      // Players still sitting in an unfinished hand can't vanish mid-hand.
      const live = d.hand && d.hand.phase !== 'done' ? d.hand.seats.map((st) => st.pid) : [];
      for (const pid of live) if (!keep.some((p) => p.id === pid) && byId.get(pid)) keep.push(byId.get(pid));
      d.players = keep;
      if (d.hand) for (const st of d.hand.seats) { const p = byId.get(st.pid); if (p) st.name = p.name; }
      if (ed.reset) {
        for (const p of d.players) {
          p.stack = S.buyIn; p.bought = S.buyIn;
          p.stats = { hands: 0, vpip: 0, pfr: 0, wins: 0, biggest: 0 };
        }
        d.history = [];
        d.hand = null;
        d.undo = [];
      }
    });
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
  if (e.target.id === 'speed') { ui.speed = +e.target.value; lsSet('speed', ui.speed); }
});
$('#table').addEventListener('click', (e) => {
  const c = e.target.closest('[data-card]');
  if (c && !ui.auto) openPicker(+c.dataset.card);
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
