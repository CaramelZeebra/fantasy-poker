const base = new URL('../site/js', import.meta.url).href;
const { evaluate, describeScore } = await import(base + '/cards.js');
const { createTable, startHand, step, profilesFor, newPlayer } = await import(base + '/engine.js');
const { computeOdds } = await import(base + '/odds.js');
const { preflopTop } = await import(base + '/bots.js');
const c = (s) => '23456789TJQKA'.indexOf(s[0]) * 4 + 'shdc'.indexOf(s[1]);
const H = (str) => str.split(' ').map(c);
console.log(describeScore(evaluate(H('As Ks Qs Js Ts 2d 3c'))), '|', describeScore(evaluate(H('Ah 2d 3c 4s 5h 9d Kc'))), '|', describeScore(evaluate(H('Ah Ad Ac Kd Ks 2c 2d'))));
console.log('AA', preflopTop(H('Ah Ad')).toFixed(3), 'AKs', preflopTop(H('Ah Kh')).toFixed(3), '72o', preflopTop(H('7h 2d')).toFixed(3), 'T9s', preflopTop(H('Th 9h')).toFixed(3));
const st = createTable();
st.players.push(newPlayer('Eve', 'station', 200), newPlayer('Fay', 'hero', 200));
const HANDS = +(process.argv[2] || 300), ODDS_HANDS = +(process.argv[3] || 4);
let t = Date.now(), steps = 0, maxOdds = 0, oddsCalls = 0, oddsMs = 0;
for (let hand = 0; hand < HANDS; hand++) {
  const err = startHand(st); if (err) { console.log(err); break; }
  const h = st.hand; const profs = profilesFor(st);
  const chips0 = h.seats.reduce((a, s) => a + s.stack + s.total, 0);
  let g = 0;
  while (h.phase !== 'done' && g++ < 500) {
    if (hand < ODDS_HANDS) {
      const o = computeOdds(h, profs); maxOdds = Math.max(maxOdds, o.ms); oddsCalls++; oddsMs += o.ms;
      const se = o.eq.reduce((a, b) => a + b, 0), sw = o.win.reduce((a, b) => a + b, 0);
      if (Math.abs(se - 1) > 1e-6 || Math.abs(sw - 1) > 0.02) console.log('odds sum', se, sw);
    }
    step(h, profs); steps++;
  }
  const chips1 = h.seats.reduce((a, s) => a + s.stack, 0);
  if (chips0 !== chips1 || h.phase !== 'done') console.log('BUG', hand, chips0, chips1, h.phase);
}
startHand(st);
console.log('hands', HANDS, 'steps', steps, 'ms', Date.now() - t, 'odds max ms', maxOdds, 'avg', (oddsMs / Math.max(1, oddsCalls)).toFixed(0));
for (const p of st.players) console.log(p.name.padEnd(5), p.preset.padEnd(8), 'stack', String(p.stack).padStart(5), 'bought', String(p.bought).padStart(5), 'net', String(p.stack - p.bought).padStart(6), 'vpip', (p.stats.vpip / p.stats.hands * 100).toFixed(0) + '%', 'pfr', (p.stats.pfr / p.stats.hands * 100).toFixed(0) + '%', 'wins', p.stats.wins);
console.log(st.history.slice(0, 4));
