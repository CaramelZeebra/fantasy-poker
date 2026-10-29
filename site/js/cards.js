// Cards are ints 0..51: rank = c >> 2 (0 = deuce .. 12 = ace), suit = c & 3.

export const RANKS = '23456789TJQKA';
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
export const CATEGORY_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush',
];
const RANK_WORDS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURALS = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

export const rankOf = (c) => c >> 2;
export const suitOf = (c) => c & 3;
export const cardLabel = (c) => RANKS[c >> 2] + SUIT_SYMBOLS[c & 3];

// STRAIGHT_HIGH[rankMask] = top rank of the best straight in the mask, or -1.
const STRAIGHT_HIGH = new Int8Array(8192).fill(-1);
for (let m = 0; m < 8192; m++) {
  for (let top = 12; top >= 4; top--) {
    const w = 0x1f << (top - 4);
    if ((m & w) === w) { STRAIGHT_HIGH[m] = top; break; }
  }
  if (STRAIGHT_HIGH[m] < 0 && (m & 0x100f) === 0x100f) STRAIGHT_HIGH[m] = 3; // wheel
}
export const straightHigh = (mask) => STRAIGHT_HIGH[mask];

function topBits(mask, n, shift) {
  let out = 0;
  for (let r = 12; r >= 0 && n > 0; r--) {
    if (mask & (1 << r)) { out |= r << shift; shift -= 4; n--; }
  }
  return out;
}

const cnt = new Uint8Array(13);
const suitMask = new Int32Array(4);
const suitCnt = new Uint8Array(4);

// Scores any 1..7 card hand; higher is better. Category lives in bits 20+.
export function evaluate(cards) {
  cnt.fill(0);
  suitMask.fill(0);
  suitCnt.fill(0);
  let all = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = c >> 2, s = c & 3;
    cnt[r]++;
    suitMask[s] |= 1 << r;
    suitCnt[s]++;
    all |= 1 << r;
  }
  // With at most 7 cards a flush can't coexist with quads or a full house.
  for (let s = 0; s < 4; s++) {
    if (suitCnt[s] >= 5) {
      const sh = STRAIGHT_HIGH[suitMask[s]];
      if (sh >= 0) return (8 << 20) | (sh << 16);
      return (5 << 20) | topBits(suitMask[s], 5, 16);
    }
  }
  let quad = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = cnt[r];
    if (n === 4) quad = r;
    else if (n === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (n === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  if (quad >= 0) return (7 << 20) | (quad << 16) | topBits(all & ~(1 << quad), 1, 12);
  if (t1 >= 0 && (t2 >= 0 || p1 >= 0)) return (6 << 20) | (t1 << 16) | (Math.max(t2, p1) << 12);
  const sh = STRAIGHT_HIGH[all];
  if (sh >= 0) return (4 << 20) | (sh << 16);
  if (t1 >= 0) return (3 << 20) | (t1 << 16) | topBits(all & ~(1 << t1), 2, 12);
  if (p2 >= 0) return (2 << 20) | (p1 << 16) | (p2 << 12) | topBits(all & ~(1 << p1) & ~(1 << p2), 1, 8);
  if (p1 >= 0) return (1 << 20) | (p1 << 16) | topBits(all & ~(1 << p1), 3, 12);
  return topBits(all, 5, 16);
}

export const categoryOf = (score) => score >> 20;

export function describeScore(score) {
  const cat = score >> 20;
  const r1 = (score >> 16) & 15, r2 = (score >> 12) & 15;
  switch (cat) {
    case 0: return `${RANK_WORDS[r1]} high`;
    case 1: return `Pair of ${RANK_PLURALS[r1]}`;
    case 2: return `Two pair, ${RANK_PLURALS[r1]} and ${RANK_PLURALS[r2]}`;
    case 3: return `Three ${RANK_PLURALS[r1]}`;
    case 4: return `${RANK_WORDS[r1]}-high straight`;
    case 5: return `${RANK_WORDS[r1]}-high flush`;
    case 6: return `${RANK_PLURALS[r1]} full of ${RANK_PLURALS[r2]}`;
    case 7: return `Four ${RANK_PLURALS[r1]}`;
    default: return r1 === 12 ? 'Royal flush' : `${RANK_WORDS[r1]}-high straight flush`;
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rnd = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Cards not in `used` (any iterable of card ints).
export function remainingDeck(used) {
  const taken = new Uint8Array(52);
  for (const c of used) taken[c] = 1;
  const out = [];
  for (let c = 0; c < 52; c++) if (!taken[c]) out.push(c);
  return out;
}
