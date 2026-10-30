// Player personalities and the decision model the simulated players use.
// Bots only "know" their own hole cards and the board, like real players.
import { describeScore, evaluate, mulberry32, remainingDeck, straightHigh } from './cards.js';

export const TRAITS = [
  { key: 'loose', label: 'Hands played', min: 0, max: 1, step: 0.01, lo: 'Only premiums', hi: 'Any two cards' },
  { key: 'aggr', label: 'Aggression', min: 0, max: 1, step: 0.01, lo: 'Check / call', hi: 'Bets & raises' },
  { key: 'bluff', label: 'Bluff frequency', min: 0, max: 1, step: 0.01, lo: 'Never bluffs', hi: 'Bluffs constantly' },
  { key: 'chase', label: 'Chases draws', min: 0, max: 1, step: 0.01, lo: 'Gives up draws', hi: 'Chases every draw' },
  { key: 'callReq', label: 'Odds needed to call', min: 0.3, max: 1.6, step: 0.05, lo: 'Ignores pot odds', hi: 'Needs a big edge' },
  { key: 'hero', label: 'Hero-call tendency', min: 0, max: 1, step: 0.01, lo: 'Believes every bet', hi: 'Calls down light' },
];

export const PRESETS = {
  fish: {
    name: 'Fish', emoji: '🐟', desc: 'Plays almost every hand, calls too much, barely raises.',
    adv: { anySuited: true, anyAce: true, sticky: 0.6, reads: 0.1, limp: 0.6 },
    profile: { loose: 0.88, aggr: 0.18, bluff: 0.08, chase: 0.9, callReq: 0.45, hero: 0.7 },
  },
  station: {
    name: 'Calling station', emoji: '📞', desc: 'Never folds a pair. Never raises either.',
    adv: { sticky: 0.9, reads: 0, limp: 0.8, cbet: 0.3 },
    profile: { loose: 0.7, aggr: 0.06, bluff: 0.03, chase: 0.8, callReq: 0.4, hero: 0.95 },
  },
  nit: {
    name: 'Nit', emoji: '🪨', desc: 'Waits for aces. Folds to pressure.',
    adv: { anyPair: true, scare: 0.6, reads: 0.5, cbet: 0.6, barrel: 0.3 },
    profile: { loose: 0.1, aggr: 0.4, bluff: 0.03, chase: 0.1, callReq: 1.35, hero: 0.05 },
  },
  tag: {
    name: 'TAG regular', emoji: '🎯', desc: 'Tight, aggressive, solid fundamentals.',
    adv: { cbet: 0.7, posAware: 0.75, reads: 0.8, threeBet: 0.6 },
    profile: { loose: 0.22, aggr: 0.75, bluff: 0.25, chase: 0.3, callReq: 1.0, hero: 0.3 },
  },
  lag: {
    name: 'LAG', emoji: '🔥', desc: 'Wide and relentless. Puts you to tough decisions.',
    adv: { cbet: 0.8, barrel: 0.7, posAware: 0.85, reads: 0.75, checkRaise: 0.25, bully: 0.5 },
    profile: { loose: 0.42, aggr: 0.88, bluff: 0.45, chase: 0.45, callReq: 0.9, hero: 0.4 },
  },
  maniac: {
    name: 'Maniac', emoji: '🤪', desc: 'Raises any two cards. Pure chaos.',
    adv: { anyFace: true, anyConn: true, barrel: 0.85, sizing: 0.8, reads: 0.3, tilt: 0.7, heater: 0.6 },
    profile: { loose: 0.85, aggr: 1, bluff: 0.75, chase: 0.6, callReq: 0.6, hero: 0.6 },
  },
  grinder: {
    name: 'Pot-odds grinder', emoji: '🧮', desc: 'Calls exactly when the math says so.',
    adv: { posAware: 0.7, reads: 0.65, shove: 0.4 },
    profile: { loose: 0.26, aggr: 0.5, bluff: 0.15, chase: 0.12, callReq: 1.0, hero: 0.2 },
  },
  hero: {
    name: 'Hero caller', emoji: '🦸', desc: '"I think you\'re bluffing." Usually wrong.',
    adv: { sticky: 0.5, reads: 0.3, rivalry: 0.4 },
    profile: { loose: 0.35, aggr: 0.45, bluff: 0.2, chase: 0.4, callReq: 0.8, hero: 1 },
  },
};

export const presetInfo = (key) =>
  PRESETS[key] || { name: 'Custom', emoji: '🎛️', desc: 'Hand-tuned personality.' };

// ---------- advanced tweaks ----------
// Optional extras on top of the six core traits. Every default reproduces the core behaviour,
// so a profile without these keys plays exactly as before. Reads use what friends know about
// each other's habits (their personality), never the cards they hold.

// Hand codes as on a range chart: 'AA', 'AKs' (suited), '72o' (offsuit).
const RANKS_HI = 'AKQJT98765432';
export const handCode = (hole) => {
  const [a, b] = hole;
  const hi = Math.max(a >> 2, b >> 2), lo = Math.min(a >> 2, b >> 2);
  const R = '23456789TJQKA';
  return hi === lo ? R[hi] + R[lo] : R[hi] + R[lo] + ((a & 3) === (b & 3) ? 's' : 'o');
};
export const HAND_GRID = [...RANKS_HI].map((r1, i) => [...RANKS_HI].map((r2, j) =>
  (i === j ? r1 + r2 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o')));

export const ADVANCED = [
  { group: 'Starting hands', items: [
    { key: 'anySuited', kind: 'toggle', label: 'Plays any two suited cards' },
    { key: 'anyAce', kind: 'toggle', label: 'Plays any ace' },
    { key: 'anyPair', kind: 'toggle', label: 'Always plays pocket pairs', hint: 'hoping to hit a set' },
    { key: 'anyConn', kind: 'toggle', label: 'Plays any connected cards', hint: '7-6, J-10…' },
    { key: 'anyFace', kind: 'toggle', label: 'Plays any two high cards', hint: '10 or better' },
    { key: 'fav', kind: 'hands', label: 'Lucky hands', hint: 'always raises them' },
    { key: 'limp', kind: 'range', def: 0, label: 'Limps instead of raising', lo: 'Always raises', hi: 'Always limps' },
    { key: 'threeBet', kind: 'range', def: 0.5, label: 'Re-raises before the flop', lo: 'Almost never', hi: 'Constantly' },
    { key: 'posAware', kind: 'range', def: 0.5, label: 'Plays position', lo: 'Ignores seat', hi: 'Lives on the button' },
    { key: 'shove', kind: 'range', def: 0, label: 'Shoves when short-stacked', lo: 'Never', hi: 'Any excuse' },
  ] },
  { group: 'Betting', items: [
    { key: 'cbet', kind: 'range', def: 0.5, label: 'Bets the flop after raising', lo: 'Gives up', hi: 'Every time' },
    { key: 'barrel', kind: 'range', def: 0.5, label: 'Keeps firing on turn & river', lo: 'One and done', hi: 'Triple barrels' },
    { key: 'slowplay', kind: 'range', def: 0.5, label: 'Slowplays big hands', lo: 'Bets them fast', hi: 'Traps' },
    { key: 'checkRaise', kind: 'range', def: 0, label: 'Check-raises', lo: 'Never', hi: 'Loves it' },
    { key: 'sizing', kind: 'range', def: 0.5, label: 'Bet size', lo: 'Small bets', hi: 'Overbets' },
  ] },
  { group: 'Stubbornness', items: [
    { key: 'sticky', kind: 'range', def: 0, label: "Can't fold top pair", lo: 'Folds it', hi: 'Married to it' },
    { key: 'scare', kind: 'range', def: 0, label: 'Scared of scary boards', hint: 'flushes, straights, pairs', lo: 'Unbothered', hi: 'Sees monsters' },
  ] },
  { group: 'Mood', items: [
    { key: 'tilt', kind: 'range', def: 0, label: 'Tilts after a big loss', hint: 'for ~5 hands', lo: 'Ice cold', hi: 'Steaming' },
    { key: 'scared', kind: 'range', def: 0, label: 'Plays scared when losing', lo: 'Unaffected', hi: 'Scared money' },
    { key: 'heater', kind: 'range', def: 0, label: 'Gets cocky when winning', lo: 'Humble', hi: 'On a heater' },
    { key: 'bully', kind: 'range', def: 0, label: 'Bullies shorter stacks', lo: 'Polite', hi: 'Table bully' },
  ] },
  { group: 'Reading friends', items: [
    { key: 'reads', kind: 'range', def: 0.6, label: "Reads others' habits", hint: 'adjusts to who is betting and who folds',
      lo: 'Plays blind', hi: 'Knows everyone' },
    { key: 'rival', kind: 'player', label: 'Rival' },
    { key: 'rivalry', kind: 'range', def: 0, label: 'Grudge against rival', hint: "won't let them push them around", lo: 'Friendly', hi: 'Personal' },
  ] },
];

export const ADV_DEFAULTS = Object.fromEntries(ADVANCED.flatMap((g) => g.items).map((t) =>
  [t.key, t.kind === 'toggle' ? false : t.kind === 'range' ? t.def : '']));

for (const P of Object.values(PRESETS)) P.profile = { ...ADV_DEFAULTS, ...P.adv, ...P.profile };

export const advChanged = (profile) =>
  ADVANCED.flatMap((g) => g.items).filter((t) => (profile?.[t.key] ?? ADV_DEFAULTS[t.key]) !== ADV_DEFAULTS[t.key]).length;

// ---------- preflop hand ranking ----------

const handClass = (a, b) => {
  let r1 = a >> 2, r2 = b >> 2;
  if (r1 < r2) [r1, r2] = [r2, r1];
  if (r1 === r2) return r1 * 13 + r2;
  return (a & 3) === (b & 3) ? r1 * 13 + r2 : r2 * 13 + r1;
};

let PRE_TOP = null; // class -> fraction of hands at least as good (0 = AA, 1 = trash)

function buildPreflop() {
  const rnd = mulberry32(20261029);
  const eq = new Float64Array(169);
  const combos = new Float64Array(169);
  const N = 900;
  const seven = new Array(7), opp = new Array(7);
  for (let r1 = 0; r1 < 13; r1++) {
    for (let r2 = 0; r2 <= r1; r2++) {
      for (const suited of r1 === r2 ? [false] : [false, true]) {
        const a = r1 * 4, b = r2 * 4 + (suited ? 0 : 1);
        const cls = handClass(a, b);
        combos[cls] = r1 === r2 ? 6 : suited ? 4 : 12;
        const deck = remainingDeck([a, b]);
        let score = 0;
        for (let it = 0; it < N; it++) {
          for (let j = 0; j < 7; j++) {
            const k = j + ((rnd() * (deck.length - j)) | 0);
            const t = deck[j]; deck[j] = deck[k]; deck[k] = t;
          }
          seven[0] = a; seven[1] = b; opp[0] = deck[5]; opp[1] = deck[6];
          for (let j = 0; j < 5; j++) seven[j + 2] = opp[j + 2] = deck[j];
          const me = evaluate(seven), them = evaluate(opp);
          score += me > them ? 1 : me === them ? 0.5 : 0;
        }
        eq[cls] = score / N;
      }
    }
  }
  const order = [...Array(169).keys()].sort((x, y) => eq[y] - eq[x]);
  PRE_TOP = new Float64Array(169);
  let cum = 0;
  for (const cls of order) {
    PRE_TOP[cls] = (cum + combos[cls] / 2) / 1326;
    cum += combos[cls];
  }
}

export function preflopTop(hole) {
  if (!PRE_TOP) buildPreflop();
  return PRE_TOP[handClass(hole[0], hole[1])];
}

// ---------- postflop strength as the bot perceives it ----------

const eqCache = new Map();
const SAMPLES = 48;
const hand7 = [], opp7 = [];

// Equity vs `k` random hands, rolling out the rest of the board.
export function perceivedEquity(hole, board, k) {
  const key = `${hole[0]},${hole[1]}|${board.join(',')}|${k}`;
  const hit = eqCache.get(key);
  if (hit !== undefined) return hit;
  const deck = remainingDeck([...hole, ...board]);
  const runout = 5 - board.length;
  const need = runout + 2 * k;
  hand7.length = 0; hand7.push(hole[0], hole[1], ...board);
  const fixed = hand7.length;
  let score = 0;
  for (let it = 0; it < SAMPLES; it++) {
    for (let j = 0; j < need; j++) {
      const x = j + ((Math.random() * (deck.length - j)) | 0);
      const t = deck[j]; deck[j] = deck[x]; deck[x] = t;
    }
    hand7.length = fixed;
    for (let j = 0; j < runout; j++) hand7.push(deck[j]);
    const me = evaluate(hand7);
    let best = 0, ties = 0;
    for (let o = 0; o < k; o++) {
      opp7.length = 0;
      opp7.push(deck[runout + 2 * o], deck[runout + 2 * o + 1]);
      for (let j = 2; j < hand7.length; j++) opp7.push(hand7[j]);
      const s = evaluate(opp7);
      if (s > best) { best = s; ties = 0; }
      if (s === best) ties++;
    }
    if (me > best) score += 1;
    else if (me === best) score += 1 / (ties + 1);
  }
  const v = score / SAMPLES;
  if (eqCache.size > 50000) eqCache.clear();
  eqCache.set(key, v);
  return v;
}

// Rough number of outs to a flush or straight.
export function drawOuts(hole, board) {
  if (board.length < 3 || board.length >= 5) return 0;
  const cards = [...hole, ...board];
  let outs = 0;
  for (let s = 0; s < 4; s++) {
    const n = cards.filter((c) => (c & 3) === s).length;
    if (n === 4 && hole.some((c) => (c & 3) === s)) outs += 9;
  }
  let mask = 0;
  for (const c of cards) mask |= 1 << (c >> 2);
  if (straightHigh(mask) < 0) {
    let ranks = 0;
    for (let r = 0; r < 13; r++) if (!(mask & (1 << r)) && straightHigh(mask | (1 << r)) >= 0) ranks++;
    outs += Math.min(2, ranks) * 4;
  }
  return Math.min(outs, 15);
}

// ---------- the decision ----------

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// What a player "knows" about someone's habits: their real personality, blurred toward an
// average player by how well they read people.
const PRIOR = { loose: 0.4, bluff: 0.25, hero: 0.4, callReq: 1, aggr: 0.5 };
const perceive = (op, reads) => {
  const out = {};
  for (const k in PRIOR) out[k] = PRIOR[k] + ((op?.[k] ?? PRIOR[k]) - PRIOR[k]) * reads;
  return out;
};
// How likely someone is to fold to a bet, judged from habits alone.
const foldiness = (o) => (1 - o.hero) * 0.5 + clamp((o.callReq - 0.3) / 1.3, 0, 1) * 0.3 + (1 - o.loose) * 0.2;
const F0 = foldiness(PRIOR);
// How strong someone's betting range is, judged from habits alone.
const betStrength = (o) => (1 - o.loose) * 0.6 + (1 - o.bluff) * 0.4;
const S0 = betStrength(PRIOR);

// Core traits after mood, stack size and grudges have pushed them around.
function effective(p, v) {
  const q = { ...ADV_DEFAULTS, ...p };
  const bump = (k, d, lo = 0, hi = 1) => { q[k] = clamp(q[k] + d, lo, hi); };
  if (v.tilted && q.tilt > 0) {
    const t = q.tilt;
    bump('loose', 0.5 * t); bump('aggr', 0.3 * t); bump('bluff', 0.3 * t); bump('hero', 0.3 * t);
    bump('callReq', -0.35 * t, 0.3, 1.6);
  }
  if (v.net < 0 && q.scared > 0) {
    const k = q.scared * Math.min(1, -v.net);
    bump('loose', -0.3 * k); bump('aggr', -0.25 * k); bump('bluff', -0.3 * k); bump('callReq', 0.35 * k, 0.3, 1.6);
  }
  if (v.net > 0 && q.heater > 0) {
    const k = q.heater * Math.min(1, v.net);
    bump('loose', 0.2 * k); bump('aggr', 0.25 * k); bump('bluff', 0.3 * k);
  }
  if (q.bully > 0 && v.stackRatio > 1.3) {
    const k = q.bully * Math.min(1, (v.stackRatio - 1) / 2);
    bump('aggr', 0.3 * k); bump('bluff', 0.35 * k);
  }
  if (q.rival && q.rivalry > 0 && v.oppPids?.includes(q.rival)) {
    const r = q.rivalry;
    bump('aggr', 0.2 * r); bump('loose', 0.15 * r);
    if (v.aggrPid === q.rival) { bump('hero', 0.5 * r); bump('callReq', -0.35 * r, 0.3, 1.6); }
  }
  return q;
}

function lovesHand(q, hole) {
  const [a, b] = hole;
  const r1 = a >> 2, r2 = b >> 2, hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const pair = r1 === r2;
  if (q.fav) {
    // Comma-separated codes; a bare 'K9' (older saves) means suited or not.
    const code = handCode(hole);
    if (q.fav.split(',').some((f) => f === code || (f.length === 2 && f === code.slice(0, 2)))) return 'fav';
  }
  return (q.anySuited && (a & 3) === (b & 3)) || (q.anyAce && hi === 12) || (q.anyPair && pair)
    || (q.anyConn && !pair && (hi - lo === 1 || (hi === 12 && lo === 0))) || (q.anyFace && lo >= 8);
}

// 0..1: how frightening the board looks (flush, straight or pair possible).
function boardScare(board) {
  if (board.length < 3) return 0;
  const suits = [0, 0, 0, 0];
  let mask = 0, paired = false;
  for (const c of board) { suits[c & 3]++; if (mask & (1 << (c >> 2))) paired = true; mask |= 1 << (c >> 2); }
  let run = 0;
  for (let lo = -1; lo <= 8; lo++) {
    let n = 0;
    for (let r = lo; r < lo + 5; r++) if (mask & (1 << (r < 0 ? 12 : r))) n++;
    run = Math.max(run, n);
  }
  return clamp((Math.max(...suits) >= 3 ? 0.5 : 0) + (run >= 3 ? 0.35 : 0) + (paired ? 0.3 : 0), 0, 1);
}

/**
 * v: { street, hole, board, pot, toCall, curBet, myBet, stack, minRaiseTo, bb,
 *      nOpp, raises, pos (0 early .. 1 button), canRaise,
 *      opps (profiles of opponents still in), aggrProfile (last bettor's profile),
 *      oppPids, aggrPid, initiative (I was last street's aggressor), checked (I checked this street),
 *      tilted, net (session result in buy-ins), stackRatio (my stack / average opponent's) }
 * returns { a: 'fold'|'check'|'call'|'raise', to? }
 */
export function decide(v, p0, rnd = Math.random) {
  const p = effective(p0, v);
  const allInTo = v.myBet + v.stack;
  const free = v.toCall <= 0;
  // With v.explain set, each decision carries a plain-words reason (`why`). The odds playouts
  // skip it: they make millions of decisions and nobody reads them.
  const X = !!v.explain;
  const P = (x) => `${Math.round(clamp(x, 0, 1) * 100)}%`;
  const mood = X ? moodNotes(p0, p, v) : [];
  const $ = (n) => `$${Math.round(n).toLocaleString()}`;
  // `ctx` collects the longer explanation (the situation, the maths, the reads) as each
  // branch works it out; the headline `why` says what tipped it.
  let ctx = [];
  const out = (act, why, tag) => (X ? { ...act, why, more: [...ctx, ...mood.map((m) => `Mood: ${m}.`)].filter(Boolean), tag } : act);
  const fold = (why) => (free ? out({ a: 'check' }, why && `${why} — but checking is free`) : out({ a: 'fold' }, why));
  const call = (why) => out(free ? { a: 'check' } : { a: 'call' }, why);
  const raise = (to, why, tag) => {
    if (!v.canRaise) return call(why);
    to = Math.max(Math.round(to), v.minRaiseTo);
    // Commit when the raise would leave too little behind.
    if (to >= allInTo * 0.7) to = allInTo;
    return out({ a: 'raise', to: Math.min(to, allInTo) }, why, tag);
  };

  // Habits of the people at the table, as this player sees them.
  const opps = (v.opps || []).map((o) => perceive(o, p.reads));
  const avgFold = opps.length ? opps.reduce((a, o) => a + foldiness(o), 0) / opps.length : F0;
  const bluffMult = clamp(1 + 1.6 * (avgFold - F0), 0.3, 2); // bluff the folders, not the stations
  const bettor = v.aggrProfile ? perceive(v.aggrProfile, p.reads) : null;
  const readBluff = bettor ? bettor.bluff : 0;
  const sizeMult = 0.5 + p.sizing;
  const who = v.aggrName || 'them';
  // What they make of the bettor's habits, in words.
  const personRead = () => {
    if (!X || !v.aggrName || !bettor) return '';
    if (p.reads < 0.3) return `Doesn't really pay attention to how ${who} plays.`;
    const loose = bettor.loose > 0.6 ? 'plays lots of hands' : bettor.loose < 0.25 ? 'only plays good hands' : 'plays a normal range';
    const bl = bettor.bluff > 0.5 ? 'bluffs a lot' : bettor.bluff < 0.12 ? 'almost never bluffs' : 'bluffs sometimes';
    return `Knows ${who} ${loose} and ${bl}${p.reads > 0.8 ? ' (reads people well)' : ''}.`;
  };
  const tableRead = () => (!X || p.reads < 0.3 ? ''
    : bluffMult > 1.25 ? 'reckons this lot folds too much'
    : bluffMult < 0.75 ? "knows they won't fold" : '');
  const bettorRead = () => {
    if (!X || !bettor || p.reads < 0.3) return '';
    const t = betStrength(bettor) - S0;
    return t > 0.12 ? `${who} only plays real hands` : t < -0.15 ? `${who} plays anything` : '';
  };

  if (v.street === 0) {
    const top = preflopTop(v.hole);
    const loves = lovesHand(p, v.hole);
    const code = X ? handCode(v.hole) : '';
    const handTxt = X ? `${code} (top ${Math.max(1, Math.round(top * 100))}% of hands)` : '';
    const spread = 0.8 * p.posAware;
    let range = (0.06 + 0.86 * p.loose) * (1 - spread / 2 + spread * v.pos);
    range = clamp(range, 0.03, 1);
    const plays = X ? `plays the top ${Math.round(range * 100)}%${p.posAware >= 0.6 ? (v.pos >= 0.9 ? ' on the button' : v.pos < 0.35 ? ' from early seats' : '') : ''}` : '';
    const lovesTxt = loves === true ? `${handTxt} — always plays these` : '';
    const bbLeft = v.stack / Math.max(1, v.bb);
    if (X) {
      ctx = [
        `Hand: ${code}, better than ${100 - Math.max(1, Math.round(top * 100))}% of starting hands.`,
        `${p._style || 'This player'} plays about ${P(range)} of hands from ${v.posName || 'here'}${p.posAware >= 0.65 ? ' (pays attention to position)' : p.posAware <= 0.25 ? ' (ignores position)' : ''}.`,
        v.toCall > 0 ? `Costs ${$(v.toCall)} to call into a ${$(v.pot)} pot — ${P(v.toCall / (v.pot + v.toCall))} pot odds.` : 'Nothing more to put in: checking is free.',
        `${$(v.stack)} behind (${Math.round(bbLeft)} big blinds).`,
        loves === true ? 'This hand is on their personal always-play list.' : '',
        loves === 'fav' ? `${code} is their lucky hand.` : '',
      ];
    }

    if (p.shove > 0 && bbLeft < 12 && v.canRaise && v.raises < 3) {
      const shoveRange = clamp(range * (1 + 1.5 * p.shove), 0, 1);
      if ((top <= shoveRange || loves === 'fav') && rnd() < 0.4 + 0.6 * p.shove) {
        return raise(allInTo, `Only ${Math.round(bbLeft)} big blinds left — shove or fold, and ${code} is good enough`, 'shove');
      }
    }
    if (loves === 'fav' && v.raises < 3) return raise(v.raises ? v.curBet * 3 : v.bb * (2.5 + rnd()), `${code}! Their lucky hand — always raises it`, 'lucky');

    if (v.raises === 0) {
      const raiseRange = range * (0.02 + 0.6 * Math.pow(p.aggr, 1.5));
      const limpers = Math.max(0, Math.round((v.pot - v.bb * 1.5) / v.bb));
      const open = (why, tag) => raise(v.bb * (2.2 + 1.3 * p.aggr + rnd() * 0.5) * sizeMult + limpers * v.bb, why, tag);
      if (top <= raiseRange) {
        if (p.aggr > 0.95 && rnd() < 0.08) return raise(allInTo, `${handTxt} and feeling wild — straight all-in`, 'shove');
        return rnd() < p.limp ? call(`${handTxt} is a raising hand, but they like to limp`) : open(`${handTxt} — strong enough to raise`);
      }
      if (top <= range || loves) {
        const why = lovesTxt || `${handTxt}; ${plays}`;
        if (X) ctx.push(`Only raises first in with about the top ${P(raiseRange)}${p.limp > 0.3 ? ', and likes to limp' : ''}.`);
        return p.aggr > 0.6 && rnd() < p.aggr - 0.4 && rnd() >= p.limp ? open(`${why}, and aggressive with it`)
          : call(lovesTxt || `${handTxt}: good enough to play, not to raise`);
      }
      if (rnd() < p.bluff * 0.12 * (0.5 + v.pos) * bluffMult) return open(`Junk (${code}), but raising anyway${v.pos >= 0.9 ? ' to steal the blinds' : ''}${tableRead() ? ` — ${tableRead()}` : ''}`, 'bluff');
      return fold(`${handTxt}; ${plays}`);
    }
    const strictness = clamp((p.callReq - 0.3) / 1.3, 0, 1);
    let cont = range * Math.pow(0.3 + 0.45 * (1 - strictness), v.raises) * (1 + 0.3 * p.hero);
    if (bettor) cont *= clamp(1 - 0.6 * (betStrength(bettor) - S0), 0.6, 1.4); // respect the nit's raise
    const commit = v.toCall / Math.max(1, v.stack);
    if (commit > 0.25) cont *= 1 - 0.6 * Math.min(1, commit) * Math.min(1, p.callReq);
    // Tiny price to see a flop: almost everyone continues.
    const potOdds = v.toCall / (v.pot + v.toCall);
    const cheap = potOdds < 0.2 + 0.15 * p.loose;
    if (cheap) cont = Math.max(cont, range * (0.6 + 0.3 * p.loose));
    const facing = X ? `vs ${v.raises > 1 ? `${v.raises - 1 > 1 ? 'a 4-bet' : 'a re-raise'}` : 'a raise'}${v.aggrName ? ` from ${v.aggrName}` : ''}` : '';
    const contTxt = X ? `continues with the top ${Math.round(cont * 100)}% ${facing}` : '';
    const reraise = cont * (0.15 + 0.45 * p.aggr) * 2 * p.threeBet;
    if (X) {
      ctx.push(
        `Facing ${v.raises === 1 ? 'a raise' : v.raises === 2 ? 'a re-raise' : `${v.raises} raises`}${v.aggrName ? ` from ${v.aggrName}` : ''}: will continue with about the top ${P(cont)} here${commit > 0.25 ? `, tighter because it's ${P(commit)} of their stack` : ''}.`,
        personRead(),
        cheap ? 'The price is small enough that most hands are worth a look.' : '',
        `Re-raises with roughly the top ${P(reraise)}.`,
      );
    }
    if (top <= reraise && v.raises < 4) return raise(v.curBet * (2.6 + rnd() * 0.6), `${handTxt} — too good to just call ${facing}`);
    if (top <= cont) return call([`${handTxt}; ${contTxt}`, cheap && top > range * 0.6 ? 'cheap enough to see a flop' : '', bettorRead()].filter(Boolean).join(', '));
    if (loves && commit < 0.15) return call(`${lovesTxt}, and the price is small`);
    if (v.raises < 3 && rnd() < p.bluff * 0.06 * bluffMult) return raise(v.curBet * 3, `Re-raise bluff with ${code}`, 'bluff');
    return fold([`${handTxt}; only ${contTxt}`, commit > 0.25 ? `would risk ${P(commit)} of their stack` : '', bettorRead()].filter(Boolean).join(', '));
  }

  // Postflop.
  const k = clamp(v.nOpp, 1, 3);
  const E = perceivedEquity(v.hole, v.board, k);
  const H = Math.pow(E, 1 / k); // heads-up-equivalent strength
  const outs = drawOuts(v.hole, v.board);
  const potBefore = Math.max(1, v.pot - v.toCall);
  const mineScore = evaluate([...v.hole, ...v.board]);
  const mine = mineScore >> 20;
  const has = X ? describeScore(mineScore) : '';
  const vsN = v.nOpp > 1 ? `vs ${v.nOpp} players` : '';
  const strength = X ? `${has}, feels like ${P(E)} to win${vsN ? ` ${vsN}` : ''}` : '';
  const drawTxt = X && outs >= 4 && v.street < 3 ? `${outs} outs to improve` : '';
  if (X) {
    ctx = [
      `Has ${has}${(evaluate(v.board) >> 20) === mine && mine > 0 ? ' — but that mostly comes from the board, so everyone has it' : ''}${outs >= 4 && v.street < 3 ? `, plus a draw (${outs} outs)` : ''}.`,
      `Board: ${boardWords(v.board)}.`,
      `Against ${v.nOpp === 1 ? 'one opponent' : `${v.nOpp} opponents`} with unknown cards, reckons this wins about ${P(E)} of the time.`,
      `Position: ${v.posName || 'somewhere'}. ${$(v.stack)} behind, ${$(v.pot)} in the pot.`,
      v.initiative ? 'Was the last one to bet or raise on the previous street, so has the lead.' : '',
    ];
  }

  if (free) {
    if (H > 0.9 && rnd() < (1 - p.aggr) * 0.8 * p.slowplay) return out({ a: 'check' }, `${strength} — slowplaying to trap`, 'trap');
    const valueBar = 0.68 - 0.12 * p.aggr - 0.2 * (F0 - avgFold); // thinner value vs stations
    if (H > valueBar && rnd() < 0.35 + 0.65 * p.aggr) {
      let frac = 0.4 + 0.45 * p.aggr * rnd();
      const over = rnd() < p.aggr * 0.12;
      if (over) frac += 0.7; // overbet
      const thin = valueBar < 0.6 && H < 0.68 ? ' — thin, but the callers will pay' : '';
      return raise(v.pot * frac * sizeMult, `${strength}: betting for value${over ? ', big' : ''}${thin}`, 'value');
    }
    if (v.initiative) {
      const keepGoing = v.street === 1 ? p.cbet : p.barrel;
      if (rnd() < Math.max(0, keepGoing - 0.5) * 1.4 * Math.min(1.5, bluffMult)) {
        return raise(v.pot * (0.33 + 0.3 * rnd()) * sizeMult, `${has}, but led the betting last street, so keeps the pressure on`, H < 0.5 ? 'bluff' : 'value');
      }
      if (keepGoing < 0.5 && rnd() < (0.5 - keepGoing) * 2) return out({ a: 'check' }, `${strength}; gives up after the raise didn't take it`);
    }
    if (outs >= 8 && v.street < 3 && rnd() < (p.aggr * 0.35 + p.bluff * 0.35) * bluffMult) {
      return raise(v.pot * (0.45 + 0.3 * rnd()) * sizeMult, `Semi-bluff: ${has} with ${outs} outs — can win now or hit later`, 'semi');
    }
    if (rnd() < ((p.bluff * 0.32) / Math.sqrt(v.nOpp)) * bluffMult) {
      return raise(v.pot * (0.4 + 0.35 * rnd()) * sizeMult, [`Bluff! ${has}, but betting like it's strong`, tableRead()].filter(Boolean).join(' — '), 'bluff');
    }
    return out({ a: 'check' }, [`${strength}; not worth a bet`, drawTxt].filter(Boolean).join(', '));
  }

  if (v.checked && p.checkRaise > 0 && v.raises < 3) {
    if (H > 0.7 && rnd() < p.checkRaise) return raise(v.curBet * (2.8 + rnd() * 0.6), `Check-raise! ${strength} — checked to set the trap`, 'trap');
    if (rnd() < p.checkRaise * p.bluff * 0.3 * bluffMult) return raise(v.curBet * 3, `Check-raise bluff with ${has}`, 'bluff');
  }

  const potOdds = v.toCall / (v.pot + v.toCall);
  const need = potOdds * p.callReq;
  const size = Math.min(1.5, v.toCall / potBefore);
  // Respect bets less from players known to bluff a lot.
  const discount = (1 - p.hero) * 0.22 * size * (1 + 0.4 * (v.raises - 1)) * (1 - 0.7 * readBluff);
  const drawBoost = v.street < 3 ? p.chase * (Math.min(outs, 12) / 12) * 0.22 : 0;
  // A bet from a tight player means more than one from a maniac.
  // (Equity is measured against random hands; a nit's bet narrows that a lot, a maniac's barely.)
  const rangePow = bettor ? clamp(1 + 3 * (betStrength(bettor) - S0), 0.5, 2.2) : 1;
  const scareLvl = boardScare(v.board);
  const scare = mine >= 4 ? 0 : p.scare * 0.3 * scareLvl;
  const eff = Math.pow(E, rangePow) * (1 - discount) * (1 - scare) + drawBoost;
  if (X) {
    ctx.push(
      `Facing ${$(v.toCall)} into ${$(potBefore)}: pot odds say a call needs ${P(potOdds)} to break even.`,
      `${p._style || 'This player'} wants ${p.callReq >= 1.15 ? 'more than' : p.callReq <= 0.85 ? 'less than' : 'about'} the pot odds (×${p.callReq.toFixed(2)}), so needs ${P(need)}.`,
      discount > 0.02 ? `A bet this size makes them trust their hand ${P(discount)} less.` : '',
      personRead(),
      rangePow > 1.15 ? `Respecting ${who}'s bet drops their estimate to about ${P(Math.pow(E, rangePow))}.`
        : rangePow < 0.85 ? `Against ${who}'s wide betting, their hand is worth more: about ${P(Math.pow(E, rangePow))}.` : '',
      drawBoost > 0.02 ? `Likes chasing: adds ${P(drawBoost)} for the ${outs}-out draw.` : '',
      scare > 0.02 ? `Nervous about the board: knocks off ${P(scare)}.` : '',
      `Overall, rates a call at ${P(eff)} against the ${P(need)} it needs.`,
    );
  }
  const math = X ? [
    `needs ${P(need)} to call, rates it ${P(eff)}`,
    bettorRead(),
    readBluff > 0.4 && p.reads >= 0.3 ? `thinks ${who} bluffs a lot` : '',
    scare > 0.05 ? 'scared of this board' : '',
    drawBoost > 0.05 ? `chasing ${outs} outs` : '',
  ].filter(Boolean).join(', ') : '';

  if (H > 0.85 && v.raises < 4 && rnd() < p.aggr * 0.8) return raise(v.curBet * (2.5 + rnd() * 0.7), `${strength} — raising for value`, 'value');
  if (eff >= need) return call(`${has}: ${math}`);
  if (p.sticky > 0 && topPairPlus(v.hole, v.board, mineScore) && rnd() < p.sticky) return call(`${has} — just can't let it go (${math})`, 'sticky');
  const boardOnly = evaluate(v.board) >> 20;
  if (mine > boardOnly && rnd() < p.hero * 0.35) return call(`Hero call! ${has} and doesn't believe ${who} (${math})`, 'hero');
  if (v.raises < 3 && rnd() < p.bluff * 0.07 * bluffMult) return raise(v.curBet * 2.8, `Raise bluff with ${has} — trying to push ${who} off`, 'bluff');
  return fold(`${has}: ${math}`);
}

// The board's texture in words.
function boardWords(board) {
  const suits = [0, 0, 0, 0];
  let mask = 0, paired = false;
  for (const c of board) { suits[c & 3]++; if (mask & (1 << (c >> 2))) paired = true; mask |= 1 << (c >> 2); }
  let run = 0;
  for (let lo = -1; lo <= 8; lo++) {
    let n = 0;
    for (let r = lo; r < lo + 5; r++) if (mask & (1 << (r < 0 ? 12 : r))) n++;
    run = Math.max(run, n);
  }
  const bits = [];
  const ms = Math.max(...suits);
  if (ms >= 3) bits.push(ms >= 4 ? 'four of one suit' : 'a flush is possible');
  else if (ms === 2 && board.length < 5) bits.push('a flush draw is out there');
  if (run >= 4) bits.push('four to a straight');
  else if (run >= 3) bits.push('straights are possible');
  if (paired) bits.push('paired');
  return bits.length ? bits.join(', ') : 'dry — not much to be scared of';
}

// Why this player isn't quite themselves right now.
function moodNotes(base, p, v) {
  const n = [];
  if (v.tilted && p.tilt > 0) n.push('on tilt after a big loss');
  if (v.net < -0.5 && p.scared > 0.2) n.push('playing scared while down');
  if (v.net > 0.5 && p.heater > 0.2) n.push('feeling cocky while up');
  if (v.stackRatio > 1.6 && p.bully > 0.2) n.push('pushing the short stacks around');
  if (p.rival && p.rivalry > 0.2 && v.oppPids?.includes(p.rival)) n.push(`grudge match with ${v.rivalName || 'their rival'}`);
  return n;
}

// Top pair or better that actually uses a hole card.
function topPairPlus(hole, board, score) {
  const cat = score >> 20;
  if (cat >= 2) return (evaluate(board) >> 20) < cat;
  if (cat !== 1) return false;
  const pairRank = (score >> 16) & 15;
  const topBoard = Math.max(...board.map((c) => c >> 2));
  return pairRank >= topBoard && hole.some((c) => c >> 2 === pairRank);
}
