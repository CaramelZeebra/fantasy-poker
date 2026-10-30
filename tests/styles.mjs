// How each personality actually plays: thousands of hands, then tracker-style stats.
//   node tests/styles.mjs [hands]                 mixed 6-handed tables of the presets
//   node tests/styles.mjs [hands] --table x.json  the players saved in a table blob
const base = new URL('../site/js', import.meta.url).href;
const { createTable, startHand, step, profilesFor, newPlayer } = await import(base + '/engine.js');
const { PRESETS, drawOuts } = await import(base + '/bots.js');
const { readFileSync } = await import('node:fs');

const HANDS = +(process.argv[2] || 6000);
const tableArg = process.argv.indexOf('--table');
const blob = tableArg > 0 ? JSON.parse(readFileSync(process.argv[tableArg + 1], 'utf8')) : null;

// Lineups: the blob's players (fixed), or random presets reshuffled every 50 hands.
const pool = blob ? blob.players : Object.keys(PRESETS).map((k) => newPlayer(k, k, 200));
const keyOf = (p) => (blob ? p.name : p.preset);
const S = Object.fromEntries(pool.map((p) => [keyOf(p), {
  hands: 0, vpip: 0, pfr: 0, bets: 0, calls: 0, sawFlop: 0, wtsd: 0, wsd: 0, net: 0,
  facing: 0, foldsToBet: 0, checkedTo: 0, betWhenChecked: 0,
  xrChance: 0, xr: 0, cbetChance: 0, cbet: 0, barrelChance: 0, barrel: 0,
  late: 0, lateVpip: 0, early: 0, earlyVpip: 0, drawFacing: 0, drawContinue: 0,
}]));

let st = null;
const fresh = () => {
  st = createTable();
  const lineup = blob ? pool : [...pool].sort(() => Math.random() - 0.5).slice(0, 6);
  st.players = lineup.map((p) => ({ ...structuredClone(p), stack: 200, bought: 200, out: false, tiltLeft: 0 }));
  if (blob) st.settings = { ...st.settings, ...blob.settings };
};
for (let n = 0; n < HANDS; n++) {
  if (n % 50 === 0 || !st) fresh();
  if (startHand(st)) { fresh(); n--; continue; }
  const h = st.hand, pr = profilesFor(st);
  const nm = (i) => keyOf(st.players.find((p) => p.id === h.seats[i].pid));
  const startStacks = h.seats.map((s) => s.stack + s.total);
  const betOn = h.seats.map(() => [false, false, false, false]); // bet/raised on street
  let g = 0;
  while (h.phase !== 'done' && g++ < 500) {
    if (h.phase !== 'bet' || h.street === 0) { step(h, pr); continue; }
    const i = h.toAct, s = h.seats[i], x = S[nm(i)], before = h.log.length;
    const facing = h.curBet > s.bet;
    const checkedEarlier = s.checkedOn === h.street;
    const initiative = h.initiative === i;
    const outs = drawOuts(s.hole, h.board5.slice(0, h.shown));
    step(h, pr);
    const t = h.log[before]?.text || '';
    const raised = / bets | raises /.test(t), called = / calls /.test(t), folded = / folds/.test(t);
    if (raised) { x.bets++; betOn[i][h.street] = true; } else if (called) x.calls++;
    if (facing) {
      x.facing++; if (folded) x.foldsToBet++;
      if (checkedEarlier) { x.xrChance++; if (raised) x.xr++; }
      if (outs >= 8 && h.street < 3) { x.drawFacing++; if (!folded) x.drawContinue++; }
    } else {
      x.checkedTo++; if (raised) x.betWhenChecked++;
      if (initiative && h.street === 1) { x.cbetChance++; if (raised) x.cbet++; }
      if (h.street >= 2 && betOn[i][h.street - 1]) { x.barrelChance++; if (raised) x.barrel++; }
    }
  }
  const showdown = h.result?.showdown;
  const n2 = h.seats.length;
  h.seats.forEach((s, i) => {
    const x = S[nm(i)];
    x.hands++;
    if (s.vpip) x.vpip++;
    if (s.pfr) x.pfr++;
    const dist = (i - h.btn + n2) % n2;
    if (dist === 0 || dist === n2 - 1) { x.late++; if (s.vpip) x.lateVpip++; }
    else if (i !== h.sbI && i !== h.bbI) { x.early++; if (s.vpip) x.earlyVpip++; }
    const flopIdx = h.log.findIndex((l) => l.text.startsWith('Flop'));
    const foldIdx = h.log.findIndex((l) => l.text === `${s.name} folds`);
    if (flopIdx >= 0 && (foldIdx < 0 || foldIdx > flopIdx)) x.sawFlop++;
    if (showdown && !s.folded) { x.wtsd++; if (s.won > s.total) x.wsd++; }
    x.net += s.stack - startStacks[i];
  });
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—').padStart(5);
console.log(`${HANDS} hands${blob ? ' with the saved lineup' : ' at mixed preset tables'}\n`);
console.log('player       VPIP  PFR  late/early  AF   WTSD  W$SD  F2Bet  cbet  barrel  x/r  draws  bb/100');
for (const [k, x] of Object.entries(S)) {
  const af = x.calls ? (x.bets / x.calls).toFixed(1) : '∞';
  console.log(`${k.padEnd(10)} ${pct(x.vpip, x.hands)} ${pct(x.pfr, x.hands)} ${pct(x.lateVpip, x.late)}/${pct(x.earlyVpip, x.early).trim().padEnd(4)} ${af.padStart(4)} ${pct(x.wtsd, x.sawFlop)} ${pct(x.wsd, x.wtsd)}  ${pct(x.foldsToBet, x.facing)} ${pct(x.cbet, x.cbetChance)} ${pct(x.barrel, x.barrelChance)}  ${pct(x.xr, x.xrChance)}  ${pct(x.drawContinue, x.drawFacing)}  ${((x.net / (st?.settings.bb || 2) / x.hands) * 100).toFixed(1).padStart(6)}`);
}
