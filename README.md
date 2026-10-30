# Fantasy Poker

Watch simulated No-Limit Hold'em hands play out with friends, remotely. Everyone with the link sees
the same table: you pick the players and their personalities, then step through each decision and
card while the odds update.

- **Static site** (`site/`) → GitHub Pages at `poker.eliasro.de`
- **Tiny API** (`worker/`) → a Cloudflare Worker that keeps the table as one JSON blob in a Durable Object
- One shared table, no accounts: everyone who opens poker.eliasro.de sees and drives the same game.

## What it does

- 2–9 players, each with a personality: presets (Fish, Calling station, Nit, TAG, LAG, Maniac,
  Pot-odds grinder, Hero caller) or custom sliders for **hands played, aggression, bluff frequency,
  chasing draws, odds needed to call** (as a multiple of pot odds) and **hero-call tendency**.
  Give anyone their own emoji, label and tagline ("🍺 Drunk uncle — shoves after midnight").
- **Advanced tweaks** per player: hand rules (any suited, any ace, any pair, connectors, high cards,
  a lucky hand they always raise), limping, re-raising, position, short-stack shoving, c-bets and
  barrels, slowplays, check-raises, bet sizing, "can't fold top pair", fear of scary boards, tilt
  after a big loss, scared money, heaters, bullying short stacks, a rival they won't back down from,
  and **reading friends' habits**: a good reader bluffs the folders, value-bets the stations and
  respects a nit's bet. Reads only use what players know about each other's style, never cards.
- Blinds, buy-ins, auto-rebuys; tracks stack, total bought in, net, VPIP/PFR, hands won.
- Two odds per player, updated after every action:
  - **Equity** — chance to win if everyone still in sees all five cards (exact on flop/turn).
  - **Real win** — the rest of the hand is played out hundreds of times by the bots with their
    personalities, so who'd fold, bluff or chase is part of the number. Also shows fold chance.
- Step one action at a time, finish a street, auto-play, or **decide for a player yourself**
  ("what if Ben had called?"). Undo any step. Click any visible card to swap it for another.
- "Sim 10 hands" fast-forwards a session to watch the bankrolls move.
- **Coaching**: when you decide for a player, pick what you disagree about (hand selection, trusting
  bets, bluffing, draws, aggression, scary boards, or "work it out") and their traits are nudged so
  that in spots like this they'd lean toward your choice. Small steps, logged in the hand history.
- **Bench**: take a player off the table without losing them. They keep their personality, look,
  chips and stats, and can be brought back any time from Edit table.
- **Why did they do that?** Every bot action comes with its reasoning in plain words ("needs 25% to
  call, rates it 31%, thinks Cleo bluffs a lot · on tilt"), under the table, in the hand log and on hover.
- **Table chatter**: players talk after all-ins, hero calls, bad beats, steals and rebuys (turn it off
  in Edit table).
- **Session graph** of everyone's net result, hand by hand, in the Bankrolls tab.
- Keyboard: <kbd>Space</kbd>/<kbd>→</kbd> next step, <kbd>F</kbd> finish street, <kbd>A</kbd> auto-play, <kbd>U</kbd> undo.

The bots only know their own cards and the board — like real players. Personalities are heuristics,
not a solver: the fun is in seeing a fish call off with bottom pair while the nit folds the winner.

## Run locally

```bash
npm run serve
```

Open http://localhost:8080. With `API_BASE` empty in `site/js/config.js` it runs in **local mode**:
the table is shared between tabs of the same browser (good for trying it out). Add `?local` to the
URL to force local mode. `npm run sim` plays 300 hands headless and checks that no chips go missing.
`node tests/styles.mjs 20000` prints tracker stats (VPIP/PFR, aggression, showdowns, c-bets, barrels,
check-raises, win rate) for each preset; add `--table table.json` to measure a saved lineup.

## Deploy

### 1. The API (Cloudflare Worker + Durable Object)

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

That prints a URL like `https://fantasy-poker-api.<you>.workers.dev`. Put it in
`site/js/config.js` as `API_BASE`.

If `eliasro.de` uses Cloudflare DNS you can instead uncomment the `routes` line in
`worker/wrangler.toml` to serve it at `https://poker-api.eliasro.de`.

`ALLOWED_ORIGINS` in `wrangler.toml` limits which sites may call the API (localhost is included for
testing). To start completely fresh, use *Reset bankrolls & stats* in Edit table.

Everything runs on Cloudflare's free Workers plan; no payment method needed. Wrangler 4 needs
Node 22+; on older Node use `npx wrangler@3` instead of `npx wrangler`.

Free tier is plenty: each viewer polls about once a second while the tab is visible, and each
step is one write.

### 2. The site (GitHub Pages)

1. Push this repo to GitHub (branch `main`).
2. Repo **Settings → Pages → Source: GitHub Actions**. The `Deploy site` workflow publishes `site/`.
3. Same page, **Custom domain**: `poker.eliasro.de`, then tick *Enforce HTTPS* once it's issued.
4. At your DNS provider add `CNAME poker → <your-github-username>.github.io`.
   (If DNS is on Cloudflare, set that record to *DNS only*, grey cloud, so GitHub can issue the cert.)

### Optional: auto-deploy the Worker

`.github/workflows/worker.yml` can redeploy the Worker from the Actions tab (Run workflow). Add repo
secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers") and
`CLOUDFLARE_ACCOUNT_ID`.

## How syncing works

The table — players, bankrolls, the current hand, its log and undo stack — is one JSON blob.
Whoever clicks a button computes the next state in their browser and shows it straight away, then
writes it in the background with `If-Match: <etag>`. If someone else wrote first, the server answers
412 and the page reloads their version. Table edits (names, personalities, settings, buy-ins)
only send the fields you changed and are replayed on top of the newer version, so two people editing
at once both keep their changes; game moves give way, so two clicks on "next" never play two steps. Odds aren't stored: every viewer works them out in
a Web Worker, equity first and then the personality playouts in batches, so the bars fill in live
without ever blocking the page. Everyone else polls with
`If-None-Match`, so unchanged polls are cheap 304s.

## Files

```
site/index.html, css/style.css
site/js/app.js          UI, controls, editor dialogs
site/js/morph.js        patches the page in place so only what changed moves
site/js/engine.js       hold'em rules: blinds, betting rounds, side pots, showdown
site/js/bots.js         personalities + the decision model
site/js/odds.js         equity + personality-aware playouts (also run in odds-worker.js)
site/js/cards.js        card encoding + 7-card hand evaluator
site/js/store.js        remote (Worker) / local (localStorage) storage
site/js/config.js       API_BASE
worker/src/index.js     GET/PUT /table with ETag concurrency
ASSETS.md               image prompts for optional art
```
