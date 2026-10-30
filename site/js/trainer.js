// Coaching: when you override a bot, nudge its traits so that in this exact spot it would
// lean toward what you chose. It's a small, numerical back-propagation: estimate how likely
// the bot is to pick your action, see which traits move that likelihood (by trying each one
// a little higher and lower), and step the traits that way. A lesson aims for a modest shift
// (about GAIN more likely to do what you chose here), so a player drifts toward your view over
// several lessons instead of swinging on one.
import { decide, TRAITS, ADVANCED } from './bots.js';
import { mulberry32 } from './cards.js';

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
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const SAMPLES = 240;
const GAIN = 0.2;    // how much more likely, per lesson, to make the choice you made
const STEP = 0.025;  // largest move per round, as a share of the trait's range
const ROUNDS = 6;
const TOTAL = 0.08;  // most any one trait can move in a single lesson, as a share of its range

// How often this profile picks `target` here. The same random stream every time, so two
// profiles are compared on identical luck and small differences show up cleanly.
function likelihood(v, profile, target) {
  const rnd = mulberry32(0xc0ac4);
  let hit = 0;
  for (let i = 0; i < SAMPLES; i++) if (decide(v, profile, rnd).a === target) hit++;
  return hit / SAMPLES;
}

export function coach(v, profile, target, lesson = 'auto') {
  const keys = (LESSONS[lesson] || LESSONS.auto).keys.filter((k) => spec(k) && typeof profile[k] === 'number');
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
      // Probe close first; if the decision doesn't budge, look further out to find which
      // way this trait pushes. (Far from the tipping point, small nudges change nothing.)
      let grad = 0;
      for (const reach of [0.08, 0.25, 0.6]) {
        const up = clamp(cur[k] + reach * span, min, max), down = clamp(cur[k] - reach * span, min, max);
        if (up === down) break;
        grad = (likelihood(v, { ...cur, [k]: up }, target) - likelihood(v, { ...cur, [k]: down }, target)) / ((up - down) / span);
        if (Math.abs(grad) >= 0.05) break;
      }
      if (Math.abs(grad) < 0.05) continue;
      // Don't let any one trait run further than TOTAL in a single lesson.
      const room = TOTAL * span - Math.abs(cur[k] - profile[k]) * (Math.sign(cur[k] - profile[k]) === Math.sign(grad) ? 1 : -1);
      if (room <= 0.001 * span) continue;
      let m = clamp(grad * 0.1, -STEP, STEP) * span;
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
