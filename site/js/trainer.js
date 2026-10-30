// Coaching: when you override a bot, nudge its traits so that in this exact spot it would
// lean toward what you chose. It's a small, numerical back-propagation: estimate how likely
// the bot is to pick your action, see which traits move that likelihood (by trying each one
// a little higher and lower), and step the traits that way. A lesson aims for a modest shift
// (about GAIN more likely to do what you chose here), so a player drifts toward your view over
// several lessons instead of swinging on one.
import { decide, TRAITS, ADVANCED, handCode, drawOuts } from './bots.js';
import { mulberry32, evaluate, describeScore } from './cards.js';

// What the lesson is about decides which traits are allowed to move.
export const LESSONS = {
  auto: { label: 'Work it out', short: 'anything', keys: ['loose', 'aggr', 'bluff', 'chase', 'callReq', 'hero', 'posAware', 'threeBet', 'cbet', 'barrel', 'checkRaise', 'sticky', 'scare'] },
  hands: { label: 'Which hands to play', short: 'hand choice', keys: ['loose', 'posAware', 'limp', 'threeBet'] },
  bets: { label: 'How much to trust bets', short: 'trusting bets', keys: ['callReq', 'hero', 'reads', 'sticky'] },
  bluff: { label: 'Bluffing', short: 'bluffing', keys: ['bluff'] },
  draws: { label: 'Chasing draws', short: 'draws', keys: ['chase'] },
  aggro: { label: 'Betting & raising', short: 'aggression', keys: ['aggr', 'cbet', 'barrel', 'checkRaise', 'slowplay'] },
  fear: { label: 'Scary boards', short: 'scary boards', keys: ['scare'] },
};

const ALL = [...TRAITS, ...ADVANCED.flatMap((g) => g.items).filter((t) => t.kind === 'range').map((t) => ({ ...t, min: 0, max: 1 }))];
const spec = (k) => ALL.find((t) => t.key === k);
// Reads can move a little faster: it's knowledge about friends, not a change of style.
const TOTALS = { reads: 0.15 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const SAMPLES = 240;
const GAIN = 0.2;    // how much more likely, per lesson, to make the choice you made
const STEP = 0.025;  // largest move per round, as a share of the trait's range
const ROUNDS = 6;
const TOTAL = 0.08;  // most any one trait can move in a single lesson, as a share of its range

// How often this profile picks `target` here. The same random stream every time, so two
// profiles are compared on identical luck and small differences show up cleanly.
// `target` is an action, or a list of them ("anything but folding").
function likelihood(v, profile, target) {
  const rnd = mulberry32(0xc0ac4);
  const want = [].concat(target);
  let hit = 0;
  for (let i = 0; i < SAMPLES; i++) if (want.includes(decide(v, profile, rnd).a)) hit++;
  return hit / SAMPLES;
}

// `lesson` is a LESSONS key, or a reason from reasonsFor(): { keys, dir } where dir says which
// way each key is meant to go ("trust your reads more" only ever raises reads), and `hit`
// optionally widens what counts as success (knowing the raiser plays anything argues for not folding,
// whether that's a call or a raise).
export function coach(v, profile, target, lesson = 'auto') {
  const L = typeof lesson === 'string' ? LESSONS[lesson] || LESSONS.auto : lesson;
  const dir = L.dir || {};
  if (L.hit) target = L.hit;
  const keys = L.keys.filter((k) => spec(k) && typeof profile[k] === 'number');
  const before = likelihood(v, profile, target);
  let cur = { ...profile };
  let now = before;
  const goal = Math.min(0.95, before + GAIN);
  for (let round = 0; round < ROUNDS && now < goal; round++) {
    const moves = {};
    let any = false;
    for (const k of keys) {
      const { min, max } = spec(k);
      const span = max - min;
      const c = cur[k], c0 = profile[k];
      // Probe close first; if the decision doesn't budge, look further out to find which
      // way this trait pushes. (Far from the tipping point, small nudges change nothing.)
      let grad = 0;
      for (const reach of [0.08, 0.25, 0.6]) {
        const up = clamp(c + reach * span, min, max), down = clamp(c - reach * span, min, max);
        if (up === down) break;
        grad = (likelihood(v, { ...cur, [k]: up }, target) - likelihood(v, { ...cur, [k]: down }, target)) / ((up - down) / span);
        if (Math.abs(grad) >= 0.05) break;
      }
      const want = dir[k];
      if (want && Math.abs(grad) >= 0.05 && Math.sign(grad) !== want) continue; // the reason doesn't fit this spot
      // A stated reason is taken on board even when this one decision barely moves:
      // it's something true about how they should play, not just about this hand.
      if (Math.abs(grad) < 0.05) { if (!want || round > 0) continue; grad = want * 0.05; }
      // Don't let any one trait run further than its total in a single lesson.
      const total = TOTALS[k] || TOTAL;
      const room = total * span - Math.abs(c - c0) * (Math.sign(c - c0) === Math.sign(grad) ? 1 : -1);
      if (room <= 0.001 * span) continue;
      let m = clamp(grad * 0.1, -STEP, STEP) * span * (total / TOTAL);
      if (Math.abs(m) < 0.01 * span) m = Math.sign(grad) * 0.01 * span;
      moves[k] = Math.sign(m) * Math.min(Math.abs(m), room);
      any = true;
    }
    if (!any) break;
    const next = { ...cur };
    for (const k in moves) { const { min, max } = spec(k); next[k] = +clamp(cur[k] + moves[k], min, max).toFixed(3); }
    const p = likelihood(v, next, target);
    if (p < now) break; // the nudge didn't help; keep what we had
    cur = next;
    now = p;
  }
  const changes = keys.filter((k) => Math.abs(cur[k] - profile[k]) >= 0.005)
    .map((k) => ({ key: k, label: spec(k).label, from: profile[k], to: cur[k] }));
  return { changes, before, after: now, profile: cur };
}

// ---------- reasons you can give ----------
// What you might say when you overrule a player, worded for this spot: who bet, what they
// hold, the board, the price. Each reason moves only the traits it's about, and only in the
// direction it says. Reasons about a friend's habits are offered only when they're true of
// that friend (everyone knows how everyone plays), and they teach the player to lean on
// those reads more, not to invent new ones.

const RN = '23456789TJQKA';
const RW = { A: 'aces', K: 'kings', Q: 'queens', J: 'jacks', T: '10s' };
export function handName(code) {
  const r = (c) => (c === 'T' ? '10' : c);
  if (code.length === 2) return `pocket ${RW[code[0]] || `${code[0]}s`}`;
  return `${r(code[0])}-${r(code[1])} ${code[2] === 's' ? 'suited' : 'offsuit'}`;
}

export function reasonsFor(v, target, nameOf = () => 'them') {
  const out = [];
  const add = (id, text, dir, hit) => out.push({ id, text, keys: Object.keys(dir), dir, ...(hit && { hit }) });
  const stay = ['call', 'raise'];
  // How a friend really plays, from their personality.
  const habits = (o) => o && {
    loose: o.loose >= 0.45, tight: o.loose <= 0.25,
    bluffs: o.bluff >= 0.35, honest: o.bluff <= 0.12,
    folds: o.hero <= 0.3 && o.callReq >= 1, calls: o.hero >= 0.55 || o.callReq <= 0.7,
  };
  const pre = v.street === 0;
  const facing = v.toCall > 0;
  const B = v.aggrPid && v.aggrName && facing ? v.aggrName : null;
  const bh = habits(v.aggrProfile);
  const code = handCode(v.hole);
  const hand = pre ? handName(code) : describeScore(evaluate([...v.hole, ...v.board])).toLowerCase();
  const outs = pre ? 0 : drawOuts(v.hole, v.board);
  const draw = outs >= 8 && v.street < 3;
  const heads = v.nOpp === 1 ? v.oppPids?.[0] : null;
  const O = heads ? nameOf(heads) : null;
  const oh = heads ? habits(v.opps[0]) : null;
  const big = facing && v.toCall >= 0.6 * Math.max(1, v.pot - v.toCall);
  const scary = !pre && v.board.length >= 3 && (() => {
    const suits = [0, 0, 0, 0]; v.board.forEach((c) => suits[c & 3]++);
    const ranks = v.board.map((c) => c >> 2);
    return Math.max(...suits) >= 3 || new Set(ranks).size < ranks.length;
  })();

  if (facing && target === 'call') {
    if (B) {
      if (bh.loose) add('b-loose', `${B} ${pre ? 'raises' : 'bets'}${big ? ' big' : ''} with loads of hands — ${hand} could easily be good`, { reads: 1 }, stay);
      if (bh.bluffs) add('b-bluff', `${B} bluffs too much to fold here`, { reads: 1, hero: 1 }, stay);
    }
    add('good', `${hand[0].toUpperCase() + hand.slice(1)} is good enough to ${pre ? 'play' : 'call'} here`,
      pre ? { loose: 1, callReq: -1, hero: 1 } : { callReq: -1, hero: 1, sticky: 1 }, stay);
    add('price', `The price is right — ${v.toCall <= v.pot / 3 ? "it's cheap" : 'the pot is big enough'}`, { callReq: -1 });
    if (draw) add('draw', `Worth chasing the draw (${outs} outs)`, { chase: 1 });
    if (scary) add('board', "The board isn't as scary as it looks", { scare: -1 });
  }
  if (facing && target === 'fold') {
    if (B) {
      if (bh.tight) add('b-tight', `${B} only ${pre ? 'raises' : 'bets'}${big ? ' that big' : ''} with a real hand`, { reads: 1 });
      if (bh.honest) add('b-honest', `${B} hardly ever bluffs`, { reads: 1, hero: -1 });
    }
    add('weak', `${hand[0].toUpperCase() + hand.slice(1)} isn't good enough${pre && v.pos < 0.5 ? ` from ${v.posName || 'this seat'}` : ''}`,
      pre ? { loose: -1, callReq: 1, posAware: 1 } : { callReq: 1, hero: -1, sticky: -1 });
    add('price', 'Too expensive for what it is', { callReq: 1 });
    if (draw) add('draw', "Don't chase the draw at this price", { chase: -1 });
    if (scary) add('board', 'Respect the scary board', { scare: 1 });
  }
  if (target === 'raise') {
    add('value', `${hand[0].toUpperCase() + hand.slice(1)} is strong — ${facing ? 'raise' : 'bet'} it for value`,
      pre ? { aggr: 1, limp: -1, threeBet: 1 } : { aggr: 1, slowplay: -1 });
    if (B && bh.folds) add('b-push', `${B} gives up when pushed back`, { reads: 1, bluff: 1 });
    else if (!B && oh?.folds) add('o-fold', `${O} folds too much — take it away`, { reads: 1, bluff: 1 });
    add('bluff', facing ? 'Represent a big hand and push them off it' : 'Nobody wants this pot — have a stab', { bluff: 1 });
    if (draw) add('semi', `Semi-bluff the draw (${outs} outs)`, { chase: 1, aggr: 1 });
    if (!pre && !facing && v.initiative) add('lead', 'Keep the pressure on after raising last street', v.street === 1 ? { cbet: 1 } : { barrel: 1 });
    if (pre && v.raises === 0 && v.pos >= 0.6) add('steal', `Raise to steal from ${v.posName || 'late position'}`, { posAware: 1, loose: 1, bluff: 1 });
  }
  if (!facing && target === 'check') {
    add('slow', `Slow down with ${hand}`, pre ? { aggr: -1 } : { aggr: -1, bluff: -1, ...(v.initiative ? (v.street === 1 ? { cbet: -1 } : { barrel: -1 }) : {}) });
    if (!pre) add('trap', `Trap with ${hand} and let them bet`, v.inPos ? { slowplay: 1 } : { slowplay: 1, checkRaise: 1 });
    if (oh?.calls) add('o-calls', `${O} calls everything — don't bluff them`, { reads: 1, bluff: -1 });
  }
  if (pre && facing && v.raises === 0 && target === 'call') {
    // Limping or completing: playing it, just not raising.
    add('limp', `Just limp ${hand} and see a flop`, { limp: 1, aggr: -1 });
  }
  return out;
}
