// Odds off the main thread. Equity comes back first, then the personality playouts in batches
// so the bars converge live. A newer request cancels the one in progress.
import { showdownEquity, realisticBatch, accOdds, needsPlayouts } from './odds.js';

const BATCH = 60;
let latest = 0;
const breathe = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = (e) => { latest = e.data.id; run(e.data); };

async function run({ id, hand, profiles }) {
  const t0 = Date.now();
  const eq = showdownEquity(hand);
  if (id !== latest) return;
  if (!needsPlayouts(hand)) {
    self.postMessage({ id, odds: { eq, win: eq, fold: eq.map(() => 0), n: 0, ms: Date.now() - t0 }, done: true });
    return;
  }
  const total = hand.street === 0 ? 600 : 800;
  self.postMessage({ id, odds: { eq, win: null, fold: null, n: 0 }, done: false });
  let acc = null;
  while (!acc || acc.n < total) {
    acc = realisticBatch(hand, profiles, BATCH, acc);
    const done = acc.n >= total;
    self.postMessage({ id, odds: { eq, ...accOdds(acc), n: acc.n, ms: Date.now() - t0 }, done });
    if (done) return;
    await breathe();
    if (id !== latest) return;
  }
}
