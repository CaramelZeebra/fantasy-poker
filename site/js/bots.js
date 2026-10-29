// Player personalities and the decision model the simulated players use.
// Bots only "know" their own hole cards and the board, like real players.
import { evaluate, mulberry32, remainingDeck, straightHigh } from './cards.js';

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
    profile: { loose: 0.88, aggr: 0.18, bluff: 0.08, chase: 0.9, callReq: 0.45, hero: 0.7 },
  },
  station: {
    name: 'Calling station', emoji: '📞', desc: 'Never folds a pair. Never raises either.',
    profile: { loose: 0.7, aggr: 0.06, bluff: 0.03, chase: 0.8, callReq: 0.4, hero: 0.95 },
  },
  nit: {
    name: 'Nit', emoji: '🪨', desc: 'Waits for aces. Folds to pressure.',
    profile: { loose: 0.1, aggr: 0.4, bluff: 0.03, chase: 0.1, callReq: 1.35, hero: 0.05 },
  },
  tag: {
    name: 'TAG regular', emoji: '🎯', desc: 'Tight, aggressive, solid fundamentals.',
    profile: { loose: 0.22, aggr: 0.75, bluff: 0.25, chase: 0.3, callReq: 1.0, hero: 0.3 },
  },
  lag: {
    name: 'LAG', emoji: '🔥', desc: 'Wide and relentless. Puts you to tough decisions.',
    profile: { loose: 0.42, aggr: 0.88, bluff: 0.45, chase: 0.45, callReq: 0.9, hero: 0.4 },
  },
  maniac: {
    name: 'Maniac', emoji: '🤪', desc: 'Raises any two cards. Pure chaos.',
    profile: { loose: 0.85, aggr: 1, bluff: 0.75, chase: 0.6, callReq: 0.6, hero: 0.6 },
  },
  grinder: {
    name: 'Pot-odds grinder', emoji: '🧮', desc: 'Calls exactly when the math says so.',
    profile: { loose: 0.26, aggr: 0.5, bluff: 0.15, chase: 0.12, callReq: 1.0, hero: 0.2 },
  },
  hero: {
    name: 'Hero caller', emoji: '🦸', desc: '"I think you\'re bluffing." Usually wrong.',
    profile: { loose: 0.35, aggr: 0.45, bluff: 0.2, chase: 0.4, callReq: 0.8, hero: 1 },
  },
};

export const presetInfo = (key) =>
  PRESETS[key] || { name: 'Custom', emoji: '🎛️', desc: 'Hand-tuned personality.' };

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

/**
 * v: { street, hole, board, pot, toCall, curBet, myBet, stack, minRaiseTo, bb,
 *      nOpp, raises, pos (0 early .. 1 button), canRaise,
 *      readBluff (how bluffy the last bettor is known to be, 0..1) }
 * returns { a: 'fold'|'check'|'call'|'raise', to? }
 */
export function decide(v, p, rnd = Math.random) {
  const allInTo = v.myBet + v.stack;
  const free = v.toCall <= 0;
  const fold = () => (free ? { a: 'check' } : { a: 'fold' });
  const call = () => (free ? { a: 'check' } : { a: 'call' });
  const raise = (to) => {
    if (!v.canRaise) return call();
    to = Math.max(Math.round(to), v.minRaiseTo);
    // Commit when the raise would leave too little behind.
    if (to >= allInTo * 0.7) to = allInTo;
    return { a: 'raise', to: Math.min(to, allInTo) };
  };

  if (v.street === 0) {
    const top = preflopTop(v.hole);
    let range = (0.06 + 0.86 * p.loose) * (0.8 + 0.4 * v.pos);
    range = clamp(range, 0.03, 1);
    if (v.raises === 0) {
      const raiseRange = range * (0.02 + 0.6 * Math.pow(p.aggr, 1.5));
      const limpers = Math.max(0, Math.round((v.pot - v.bb * 1.5) / v.bb));
      const open = () => raise(v.bb * (2.2 + 1.3 * p.aggr + rnd() * 0.5) + limpers * v.bb);
      if (top <= raiseRange) return p.aggr > 0.95 && rnd() < 0.08 ? raise(allInTo) : open();
      if (top <= range) return p.aggr > 0.6 && rnd() < p.aggr - 0.4 ? open() : call();
      if (rnd() < p.bluff * 0.12 * (0.5 + v.pos)) return open();
      return fold();
    }
    const strictness = clamp((p.callReq - 0.3) / 1.3, 0, 1);
    let cont = range * Math.pow(0.3 + 0.45 * (1 - strictness), v.raises) * (1 + 0.3 * p.hero);
    const commit = v.toCall / Math.max(1, v.stack);
    if (commit > 0.25) cont *= 1 - 0.6 * Math.min(1, commit) * Math.min(1, p.callReq);
    // Tiny price to see a flop: almost everyone continues.
    const potOdds = v.toCall / (v.pot + v.toCall);
    if (potOdds < 0.2 + 0.15 * p.loose) cont = Math.max(cont, range * (0.6 + 0.3 * p.loose));
    const reraise = cont * (0.15 + 0.45 * p.aggr);
    if (top <= reraise && v.raises < 4) return raise(v.curBet * (2.6 + rnd() * 0.6));
    if (top <= cont) return call();
    if (v.raises < 3 && rnd() < p.bluff * 0.06) return raise(v.curBet * 3);
    return fold();
  }

  // Postflop.
  const k = clamp(v.nOpp, 1, 3);
  const E = perceivedEquity(v.hole, v.board, k);
  const H = Math.pow(E, 1 / k); // heads-up-equivalent strength
  const outs = drawOuts(v.hole, v.board);
  const potBefore = Math.max(1, v.pot - v.toCall);

  if (free) {
    if (H > 0.9 && rnd() < (1 - p.aggr) * 0.4) return { a: 'check' }; // slowplay
    if (H > 0.68 - 0.12 * p.aggr && rnd() < 0.35 + 0.65 * p.aggr) {
      let frac = 0.4 + 0.45 * p.aggr * rnd();
      if (rnd() < p.aggr * 0.12) frac += 0.7; // overbet
      return raise(v.pot * frac);
    }
    if (outs >= 8 && v.street < 3 && rnd() < p.aggr * 0.35 + p.bluff * 0.35) return raise(v.pot * (0.45 + 0.3 * rnd()));
    if (rnd() < (p.bluff * 0.32) / Math.sqrt(v.nOpp)) return raise(v.pot * (0.4 + 0.35 * rnd()));
    return { a: 'check' };
  }

  const potOdds = v.toCall / (v.pot + v.toCall);
  const need = potOdds * p.callReq;
  const size = Math.min(1.5, v.toCall / potBefore);
  // Respect bets less from players known to bluff a lot.
  const discount = (1 - p.hero) * 0.22 * size * (1 + 0.4 * (v.raises - 1)) * (1 - 0.7 * (v.readBluff || 0));
  const drawBoost = v.street < 3 ? p.chase * (Math.min(outs, 12) / 12) * 0.22 : 0;
  const eff = E * (1 - discount) + drawBoost;

  if (H > 0.85 && v.raises < 4 && rnd() < p.aggr * 0.8) return raise(v.curBet * (2.5 + rnd() * 0.7));
  if (eff >= need) return call();
  const mine = evaluate([...v.hole, ...v.board]) >> 20;
  const boardOnly = evaluate(v.board) >> 20;
  if (mine > boardOnly && rnd() < p.hero * 0.35) return call(); // "you're bluffing"
  if (v.raises < 3 && rnd() < p.bluff * 0.07) return raise(v.curBet * 2.8);
  return fold();
}
