// Two views of "who wins":
//  eq   — pure showdown equity: everyone still in sees all five cards.
//  win  — realistic: play the rest of the hand out with each player's personality,
//         so folds, bluffs and bad calls are part of the number.
import { evaluate, remainingDeck, shuffle } from './cards.js';
import { dealNext, botAction, applyAction } from './engine.js';

function knownCards(h) {
  const out = h.board5.slice(0, h.shown);
  for (const s of h.seats) out.push(...s.hole);
  return out;
}

export function showdownEquity(h) {
  const live = h.seats.map((s, i) => i).filter((i) => !h.seats[i].folded);
  const eq = h.seats.map(() => 0);
  const board = h.board5.slice(0, h.shown);
  const deck = remainingDeck(knownCards(h));
  const need = 5 - board.length;
  const hands = live.map((i) => [...h.seats[i].hole, ...board]);
  const base = hands[0].length;
  let total = 0;
  const score = (extra) => {
    let best = -1, winners = [];
    live.forEach((seat, k) => {
      const cards = hands[k];
      cards.length = base;
      cards.push(...extra);
      const s = evaluate(cards);
      if (s > best) { best = s; winners = [seat]; } else if (s === best) winners.push(seat);
    });
    for (const w of winners) eq[w] += 1 / winners.length;
    total++;
  };
  if (need === 0) score([]);
  else if (need === 1) for (const a of deck) score([a]);
  else if (need === 2) {
    for (let x = 0; x < deck.length; x++) for (let y = x + 1; y < deck.length; y++) score([deck[x], deck[y]]);
  } else {
    for (let it = 0; it < 6000; it++) {
      for (let j = 0; j < need; j++) {
        const k = j + ((Math.random() * (deck.length - j)) | 0);
        const t = deck[j]; deck[j] = deck[k]; deck[k] = t;
      }
      score(deck.slice(0, need));
    }
  }
  return eq.map((v) => v / total);
}

export function realisticOdds(h, profiles, iters = 400) {
  const n = h.seats.length;
  const win = new Array(n).fill(0);
  const fold = new Array(n).fill(0);
  const deck = remainingDeck(knownCards(h));
  for (let it = 0; it < iters; it++) {
    shuffle(deck);
    const sim = {
      ...h, log: null, odds: null,
      seats: h.seats.map((s) => ({ ...s })),
      board5: [...h.board5.slice(0, h.shown), ...deck.slice(0, 5 - h.shown)],
    };
    let guard = 0;
    while (sim.phase !== 'done' && guard++ < 300) {
      if (sim.phase === 'deal') dealNext(sim);
      else applyAction(sim, botAction(sim, profiles));
    }
    if (!sim.result) continue;
    const w = sim.result.mainWinners;
    for (const i of w) win[i] += 1 / w.length;
    sim.seats.forEach((s, i) => { if (s.folded && !h.seats[i].folded) fold[i]++; });
  }
  return { win: win.map((v) => v / iters), fold: fold.map((v) => v / iters) };
}

export function computeOdds(h, profiles) {
  if (!h || h.phase === 'done') return null;
  const t0 = Date.now();
  const eq = showdownEquity(h);
  const canAct = h.seats.filter((s) => !s.folded && !s.allIn).length;
  // Once nobody can bet any more, realistic odds are just equity.
  const real = h.phase === 'bet' || canAct >= 2 ? realisticOdds(h, profiles, h.street === 0 ? 300 : 400) : { win: eq, fold: eq.map(() => 0) };
  return { eq, win: real.win, fold: real.fold, ms: Date.now() - t0 };
}
