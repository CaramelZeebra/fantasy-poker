// Plays a saved lineup and flags decisions no sane friend would make, with the bot's reason.
//   node tests/audit.mjs table.json [hands] [examples per kind]
const base = 'file:///Users/elias/code/fantasy-poker/site/js';
const { createTable, startHand, step, profilesFor, botAction, botView, legal } = await import(base + '/engine.js');
const { preflopTop, drawOuts, handCode } = await import(base + '/bots.js');
const { evaluate, describeScore, cardLabel } = await import(base + '/cards.js');
const { readFileSync } = await import('node:fs');
const blob = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const HANDS = +(process.argv[3] || 100);
const st = createTable();
st.settings = { ...st.settings, ...blob.settings };
st.players = blob.players.map((p) => ({ ...structuredClone(p), stack: 200, bought: 200, out: false, tiltLeft: 0 }));
const flags = {};
const flag = (k, msg) => (flags[k] ||= []).push(msg);
let decisions = 0;
const bb = () => st.settings.bb || 2;
for (let n = 0; n < HANDS; n++) {
  for (const p of st.players) if (p.stack < 40) { p.stack += 200; p.bought += 200; }
  if (startHand(st)) break;
  const h = st.hand, pr = profilesFor(st);
  let g = 0;
  while (h.phase !== 'done' && g++ < 500) {
    if (h.phase !== 'bet') { step(h, pr); continue; }
    const i = h.toAct, s = h.seats[i], v = botView(h, pr, true);
    const d = botAction(h, pr, true);
    decisions++;
    const board = v.board, pre = v.street === 0;
    const score = pre ? 0 : evaluate([...v.hole, ...board]);
    const cat = score >> 20, boardCat = pre ? 0 : evaluate(board) >> 20;
    const top = preflopTop(v.hole);
    const outs = pre ? 0 : drawOuts(v.hole, board);
    const pot = v.pot, potOdds = v.toCall / (pot + v.toCall);
    const allIn = d.a === 'raise' && d.to >= v.myBet + v.stack;
    const desc = `#${h.no} ${['pre', 'flop', 'turn', 'river'][v.street]} ${s.name} ${v.hole.map(cardLabel).join('')} ${board.map(cardLabel).join('')} pot ${pot} toCall ${v.toCall} stack ${v.stack} raises ${v.raises} opps ${v.nOpp}` +
      `\n      → ${d.a}${d.to ? ' ' + d.to : ''} [${d.tag || ''}] ${d.why}`;
    const usesHole = cat > boardCat;
    const commitFrac = v.toCall / Math.max(1, v.stack + 0);
    if (pre) {
      if (d.a === 'raise' && v.raises >= 2 && top > 0.15 && d.tag !== 'bluff' && d.tag !== 'lucky') flag('pre: re-raises a 3-bet+ with a weak hand', desc);
      if (d.a === 'raise' && v.raises >= 3 && top > 0.06) flag('pre: 5-bets with a non-premium', desc);
      if (d.a === 'call' && v.raises >= 2 && top > 0.35 && v.toCall > 8 * bb()) flag('pre: calls a big re-raise with trash', desc);
      if (allIn && v.stack > 40 * bb() && top > 0.1) flag('pre: shoves deep with a mediocre hand', desc);
      if (d.a === 'call' && commitFrac > 0.5 && top > 0.2) flag('pre: calls off half the stack with a mediocre hand', desc);
    } else {
      if (d.a === 'fold' && usesHole && cat >= 4 && v.toCall <= pot) flag('post: folds a straight or better to a normal bet', desc);
      if (d.a === 'fold' && usesHole && cat >= 3 && v.toCall <= pot * 0.5) flag('post: folds trips/set to a small bet', desc);
      if (d.a === 'fold' && usesHole && cat >= 1 && potOdds < 0.15) flag('post: folds a pair+ getting great odds', desc);
      if (d.a === 'raise' && (d.tag === 'value') && (!usesHole || cat < 1)) flag('post: "value" bet with nothing of its own', desc);
      if (d.a === 'raise' && v.toCall > 0 && d.tag === 'value' && cat <= 1) flag('post: value-raises a bet with one pair', desc);
      if (d.a === 'call' && v.street === 3 && !usesHole && v.toCall >= pot * 0.4) flag('post: calls a big river bet with no hand at all', desc);
      if (d.a === 'call' && commitFrac > 0.5 && !usesHole && outs < 8) flag('post: calls off half the stack with nothing', desc);
      if (allIn && v.stack > 30 * bb() && d.tag !== 'bluff' && d.tag !== 'semi' && (cat < 2 || !usesHole)) flag('post: shoves deep for "value" with one pair or less', desc);
      if (d.a === 'raise' && d.tag === 'bluff' && v.nOpp >= 3) flag('post: bluffs into 3+ players', desc);
      if (d.a === 'raise' && v.street === 3 && v.toCall === 0 && d.tag !== 'bluff' && d.tag !== 'value') flag('post: river bet for no clear reason', desc);
      if ((d.a === 'check' || d.a === 'call') && v.street === 3 && usesHole && cat >= 5 && v.toCall === 0 && v.inPos) flag('silly: checks a flush+ back on the river', desc);
    }
    step(h, pr, d);
  }
}
console.log(`${HANDS} hands, ${decisions} decisions\n`);
for (const [k, list] of Object.entries(flags).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(list.length).padStart(4)}  ${k}`);
  for (const m of list.slice(0, +(process.argv[4] || 3))) console.log('    ' + m);
}
