// No-limit hold'em table state. Everything here is plain JSON so it can live in the shared blob.
// Hand phases: 'bet' (someone must act), 'deal' (street finished, next card waits), 'done'.
import { cardLabel, describeScore, evaluate, shuffle } from './cards.js';
import { PRESETS, ADV_DEFAULTS, decide } from './bots.js';

const STREET_NAMES = ['Preflop', 'Flop', 'Turn', 'River'];
export const streetName = (i) => STREET_NAMES[i] ?? 'Showdown';
const UNDO_LIMIT = 30;

export const uid = () => Math.random().toString(36).slice(2, 10);

export function newPlayer(name, preset, buyIn) {
  return {
    id: uid(), name, preset, profile: { ...PRESETS[preset].profile },
    stack: buyIn, bought: buyIn, out: false,
    stats: { hands: 0, vpip: 0, pfr: 0, wins: 0, biggest: 0 },
  };
}

export function createTable() {
  const settings = { sb: 1, bb: 2, buyIn: 200, autoRebuy: true };
  const seed = [['Ana', 'tag'], ['Ben', 'fish'], ['Cleo', 'maniac'], ['Dev', 'nit']];
  return {
    v: 1, rev: 0, settings,
    players: seed.map(([n, p]) => newPlayer(n, p, settings.buyIn)),
    dealerId: null, handNo: 0, hand: null, undo: [], history: [],
  };
}

// A player's full profile. Players saved before a trait existed get it from their preset.
export const fullProfile = (p) => ({ ...(PRESETS[p?.preset]?.profile || ADV_DEFAULTS), ...(p?.profile || PRESETS.fish.profile) });

export const profilesFor = (state) =>
  state.hand ? state.hand.seats.map((s) => fullProfile(state.players.find((p) => p.id === s.pid))) : [];

const log = (h, text, kind = 'act') => { if (h.log) h.log.push({ kind, text }); };
const potTotal = (h) => h.seats.reduce((a, s) => a + s.total, 0);
export { potTotal };

function put(h, seat, amount) {
  const amt = Math.min(amount, seat.stack);
  seat.stack -= amt;
  seat.bet += amt;
  seat.total += amt;
  if (seat.stack === 0) seat.allIn = true;
  return amt;
}

// Moves the finished (or abandoned) hand's chips back onto the players.
export function commitHand(state) {
  const h = state.hand;
  if (!h || h.committed) return;
  const done = h.phase === 'done';
  for (const s of h.seats) {
    const p = state.players.find((x) => x.id === s.pid);
    if (!p) continue;
    p.stack = done ? s.stack : s.start;
    if (!done) continue;
    p.stats.hands++;
    if (s.vpip) p.stats.vpip++;
    if (s.pfr) p.stats.pfr++;
    if (s.won > s.total) p.stats.wins++;
    p.stats.biggest = Math.max(p.stats.biggest, s.won - s.total);
    // A big loss sets a player on tilt for a few hands (only matters if they tilt).
    if (s.total - s.won >= 25 * h.bb) p.tiltLeft = 5;
    else if (p.tiltLeft > 0) p.tiltLeft--;
  }
  if (done && h.result) {
    state.history.unshift({ no: h.no, text: h.result.summary });
    state.history.length = Math.min(state.history.length, 40);
  }
  h.committed = true;
}

// Returns an error string, or null after dealing a new hand into state.hand.
export function startHand(state) {
  commitHand(state);
  const { sb, bb, buyIn, autoRebuy } = state.settings;
  const rebuys = [];
  for (const p of state.players) {
    if (!p.out && p.stack <= 0 && autoRebuy) {
      p.stack += buyIn;
      p.bought += buyIn;
      rebuys.push(p.name);
    }
  }
  const live = state.players.filter((p) => !p.out && p.stack > 0);
  if (live.length < 2) return 'Need at least two players with chips.';

  // Button moves to the next live player after the previous button.
  const order = state.players;
  let prev = order.findIndex((p) => p.id === state.dealerId);
  let btnPlayer = null;
  for (let j = 1; j <= order.length; j++) {
    const p = order[(prev + j + order.length) % order.length];
    if (!p.out && p.stack > 0) { btnPlayer = p; break; }
  }
  state.dealerId = btnPlayer.id;
  state.handNo++;

  const deck = shuffle([...Array(52).keys()]);
  const seats = live.map((p) => ({
    pid: p.id, name: p.name, hole: [deck.pop(), deck.pop()],
    stack: p.stack, start: p.stack, bet: 0, total: 0,
    folded: false, allIn: false, acted: false, last: '', vpip: false, pfr: false, won: 0,
    tilted: (p.tiltLeft || 0) > 0, net: (p.stack - p.bought) / buyIn, checkedOn: -1,
  }));
  const n = seats.length;
  const btn = seats.findIndex((s) => s.pid === btnPlayer.id);
  const sbI = n === 2 ? btn : (btn + 1) % n;
  const bbI = (sbI + 1) % n;
  const h = {
    no: state.handNo, seats, btn, sbI, bbI, bb, board5: deck.splice(0, 5), shown: 0,
    street: 0, phase: 'bet', toAct: -1, aggressor: -1, initiative: -1, curBet: 0, minRaise: bb, raises: 0,
    log: [], result: null, odds: null, committed: false,
  };
  for (const name of rebuys) log(h, `${name} rebuys for ${buyIn}`, 'info');
  log(h, `Hand #${h.no} — ${seats[btn].name} has the button`, 'street');
  put(h, seats[sbI], sb);
  seats[sbI].last = `SB ${seats[sbI].bet}`;
  put(h, seats[bbI], bb);
  seats[bbI].last = `BB ${seats[bbI].bet}`;
  log(h, `${seats[sbI].name} posts ${seats[sbI].bet}, ${seats[bbI].name} posts ${seats[bbI].bet}`, 'info');
  h.curBet = Math.max(seats[sbI].bet, seats[bbI].bet, bb);
  h.toAct = bbI;
  state.hand = h;
  state.undo = [];
  advance(h, bbI);
  return null;
}

function nextToAct(h, from) {
  const n = h.seats.length;
  for (let j = 1; j <= n; j++) {
    const i = (from + j) % n;
    const s = h.seats[i];
    if (!s.folded && !s.allIn && (!s.acted || s.bet < h.curBet)) return i;
  }
  return -1;
}

// After seat `from` acted: find who's next or close the betting round.
function advance(h, from) {
  const live = h.seats.filter((s) => !s.folded);
  if (live.length === 1) return winUncontested(h, live[0]);
  const canAct = live.filter((s) => !s.allIn);
  let next = nextToAct(h, from);
  if (canAct.length === 0 || (canAct.length === 1 && canAct[0].bet >= h.curBet)) next = -1;
  if (next >= 0) { h.toAct = next; h.phase = 'bet'; return; }
  h.toAct = -1;
  if (h.street === 3) return showdown(h);
  h.phase = 'deal';
}

export function legal(h) {
  const s = h.seats[h.toAct];
  const toCall = Math.min(h.curBet - s.bet, s.stack);
  const others = h.seats.some((o) => o !== s && !o.folded && !o.allIn);
  const maxTo = s.bet + s.stack;
  return {
    seat: s, toCall, maxTo,
    canRaise: s.stack > toCall && others,
    minRaiseTo: Math.min(maxTo, h.curBet + h.minRaise),
  };
}

export function botAction(h, profiles) {
  const i = h.toAct;
  const s = h.seats[i];
  const L = legal(h);
  const n = h.seats.length;
  const dist = (i - h.btn + n) % n;
  const pos = dist === 0 ? 1 : dist <= 2 ? 0.3 : (dist - 2) / Math.max(1, n - 2);
  const opps = h.seats.map((o, j) => j).filter((j) => j !== i && !h.seats[j].folded);
  const avgOppStack = opps.reduce((a, j) => a + h.seats[j].stack + h.seats[j].bet, 0) / Math.max(1, opps.length);
  return decide({
    street: h.street, hole: s.hole, board: h.board5.slice(0, h.shown),
    pot: potTotal(h), toCall: L.toCall, curBet: h.curBet, myBet: s.bet, stack: s.stack,
    minRaiseTo: L.minRaiseTo, bb: h.bb, nOpp: opps.length,
    raises: h.raises, pos, canRaise: L.canRaise,
    opps: opps.map((j) => profiles[j]), oppPids: opps.map((j) => h.seats[j].pid),
    aggrProfile: h.aggressor >= 0 && h.aggressor !== i ? profiles[h.aggressor] : null,
    aggrPid: h.aggressor >= 0 ? h.seats[h.aggressor].pid : null,
    initiative: h.initiative === i, checked: s.checkedOn === h.street,
    tilted: !!s.tilted, net: s.net || 0, stackRatio: (s.stack + s.bet) / Math.max(1, avgOppStack),
  }, profiles[i]);
}

export function applyAction(h, act) {
  const i = h.toAct;
  const s = h.seats[i];
  const L = legal(h);
  let a = act.a;
  if (a === 'fold' && L.toCall <= 0) a = 'check';
  if (a === 'check' && L.toCall > 0) a = 'fold';
  if (a === 'call' && L.toCall <= 0) a = 'check';
  let to = Math.round(act.to || 0);
  if (a === 'raise') {
    if (!L.canRaise || to <= h.curBet) a = L.toCall > 0 ? 'call' : 'check';
    else to = Math.min(L.maxTo, Math.max(to, L.minRaiseTo));
  }
  s.acted = true;
  if (a === 'fold') {
    s.folded = true;
    s.last = 'Fold';
    log(h, `${s.name} folds`);
  } else if (a === 'check') {
    s.last = 'Check';
    s.checkedOn = h.street;
    log(h, `${s.name} checks`);
  } else if (a === 'call') {
    const amt = put(h, s, L.toCall);
    s.last = `Call ${s.bet}`;
    if (h.street === 0) s.vpip = true;
    log(h, `${s.name} calls ${amt}${s.allIn ? ' (all-in)' : ''}`);
  } else {
    const wasBet = h.curBet === 0;
    put(h, s, to - s.bet);
    const inc = s.bet - h.curBet;
    if (inc >= h.minRaise) {
      h.minRaise = inc;
      for (const o of h.seats) if (o !== s) o.acted = false;
    } else {
      // Short all-in: players who still owe chips get to act again.
      for (const o of h.seats) if (o !== s && o.bet < s.bet) o.acted = false;
    }
    h.curBet = Math.max(h.curBet, s.bet);
    h.raises++;
    h.aggressor = i;
    if (h.street === 0) { s.vpip = true; s.pfr = true; }
    s.last = `${wasBet ? 'Bet' : 'Raise'} ${s.bet}`;
    log(h, `${s.name} ${wasBet ? 'bets' : 'raises to'} ${s.bet}${s.allIn ? ' (all-in)' : ''}`);
  }
  advance(h, i);
}

export function dealNext(h) {
  if (h.phase !== 'deal') return;
  h.street++;
  h.shown = h.street === 1 ? 3 : h.street === 2 ? 4 : 5;
  for (const s of h.seats) { s.bet = 0; s.acted = false; if (!s.folded && !s.allIn) s.last = ''; }
  h.curBet = 0;
  h.minRaise = h.bb;
  h.raises = 0;
  h.initiative = h.aggressor;
  h.aggressor = -1;
  const cards = h.street === 1 ? h.board5.slice(0, 3) : [h.board5[h.shown - 1]];
  if (h.log) log(h, `${streetName(h.street)}: ${cards.map(cardLabel).join(' ')}  (pot ${potTotal(h)})`, 'street');
  const canAct = h.seats.filter((s) => !s.folded && !s.allIn);
  if (canAct.length >= 2) {
    h.phase = 'bet';
    h.toAct = nextToAct(h, h.btn);
  } else if (h.street === 3) {
    showdown(h);
  } else {
    h.phase = 'deal';
    h.toAct = -1;
  }
}

// One unit of progress: a single player action, or the next card.
export function step(h, profiles, override) {
  if (h.phase === 'bet') applyAction(h, override || botAction(h, profiles));
  else if (h.phase === 'deal') dealNext(h);
}

function winUncontested(h, winner) {
  const pot = potTotal(h);
  winner.stack += pot;
  winner.won = pot;
  h.phase = 'done';
  h.toAct = -1;
  const summary = `${winner.name} wins ${pot} uncontested`;
  h.result = { showdown: false, mainWinners: [h.seats.indexOf(winner)], pots: [{ amount: pot, winners: [h.seats.indexOf(winner)], desc: '' }], summary };
  log(h, summary, 'result');
}

function showdown(h) {
  h.phase = 'done';
  h.toAct = -1;
  h.shown = 5;
  const n = h.seats.length;
  const board = h.board5;
  const scores = h.seats.map((s) => (s.folded ? -1 : evaluate([...s.hole, ...board])));
  const liveTotals = [...new Set(h.seats.filter((s) => !s.folded).map((s) => s.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const L of liveTotals) {
    let amount = 0;
    for (const s of h.seats) amount += Math.min(s.total, L) - Math.min(s.total, prev);
    const eligible = h.seats.map((s, i) => i).filter((i) => !h.seats[i].folded && h.seats[i].total >= L);
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length) last.amount += amount;
    else pots.push({ amount, eligible });
    prev = L;
  }
  // Dead money from folded players above the top live level.
  const leftover = potTotal(h) - pots.reduce((a, p) => a + p.amount, 0);
  if (leftover > 0) pots[pots.length - 1].amount += leftover;

  const lines = [];
  const outPots = [];
  pots.forEach((p, pi) => {
    const best = Math.max(...p.eligible.map((i) => scores[i]));
    // Odd chips go to the first winner left of the button.
    const winners = p.eligible.filter((i) => scores[i] === best)
      .sort((a, b) => ((a - h.btn - 1 + n) % n) - ((b - h.btn - 1 + n) % n));
    const share = Math.floor(p.amount / winners.length);
    winners.forEach((w, k) => {
      const amt = share + (k === 0 ? p.amount - share * winners.length : 0);
      h.seats[w].stack += amt;
      h.seats[w].won += amt;
    });
    const names = winners.map((w) => h.seats[w].name).join(' & ');
    const desc = describeScore(best);
    if (p.eligible.length === 1) lines.push(`${names} gets ${p.amount} back (uncalled)`);
    else lines.push(`${names} ${winners.length > 1 ? 'split' : 'wins'} ${pi === 0 ? 'the pot' : 'a side pot'} of ${p.amount} with ${desc}`);
    outPots.push({ amount: p.amount, winners, desc });
  });
  for (const s of h.seats) if (!s.folded) s.last = describeScore(scores[h.seats.indexOf(s)]);
  if (h.log) {
    log(h, `Showdown: ${board.map(cardLabel).join(' ')}`, 'street');
    for (const l of lines) log(h, l, 'result');
  }
  const contested = outPots.filter((p, k) => pots[k].eligible.length > 1);
  const sole = contested.every((p) => p.winners.length === 1 && p.winners[0] === contested[0].winners[0]);
  const summary = sole && contested.length > 1
    ? `${h.seats[contested[0].winners[0]].name} wins ${contested.reduce((a, p) => a + p.amount, 0)} with ${contested[0].desc}`
    : lines.filter((l) => !l.includes('uncalled')).join('; ');
  h.result = { showdown: true, mainWinners: outPots[0].winners, pots: outPots, summary };
}

export function pushUndo(state) {
  if (!state.hand) return;
  state.undo.push(JSON.stringify(state.hand));
  if (state.undo.length > UNDO_LIMIT) state.undo.shift();
}

// Swap card `from` with `to` wherever `to` currently sits (another hand, the board, or the deck).
export function swapCard(h, from, to) {
  if (from === to) return;
  const locate = (c) => {
    for (const s of h.seats) { const k = s.hole.indexOf(c); if (k >= 0) return [s.hole, k]; }
    const k = h.board5.indexOf(c);
    return k >= 0 ? [h.board5, k] : null;
  };
  const a = locate(from), b = locate(to);
  if (!a) return;
  a[0][a[1]] = to;
  if (b) b[0][b[1]] = from;
  log(h, `✎ Card changed: ${cardLabel(from)} → ${cardLabel(to)}`, 'info');
}
