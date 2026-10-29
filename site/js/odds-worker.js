import { computeOdds } from './odds.js';

self.onmessage = (e) => {
  const { id, hand, profiles } = e.data;
  self.postMessage({ id, odds: computeOdds(hand, profiles) });
};
