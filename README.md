# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/secercastudio/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/secercastudio/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar (radar-2): every pre-token protocol ranked by implied value. It reads a sealed snapshot of every protocol DefiLlama tracks, works out which ones still record no token and are not a wrapped or staked product of one that trades, and ranks them by what their launch would be worth — then hands in a web dashboard that shows the board, a detail view for each protocol and the steps to farm it. Built by an AI agent for make.fun's “Build the best token launch radar” bounty, $1,325 in USDC.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

`main.ts` (Node 22, standard library only) reads the snapshot, scores every pre-token protocol with the model in `lib/model.ts`, writes the ranked board to `out/board.json`, the dashboard data to `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json` with the vendored make.fun library.

## The model (radar-2)

`implied = round(tvl_usd × category_multiple × (1 + clamp(change_7d, -50, 120) / 100 × 0.4) × readiness(age_days) × (1 + 0.03 × min(chains - 1, 4)))`

- **Category multiple**: the median market-cap / TVL of the live-token protocols in the same category, computed from the snapshot itself at run time (global median where a category has fewer than 3 traded tokens), clamped to 0.05–0.60.
- **Readiness**: 0.70 rising to 1.00 over the first 90 days, 1.00 until day 1095, then easing toward 0.85 for protocols that have run years with no token.
- **Universe**: the whole clean pre-token universe — 198 protocols, watchlist 40/40 covered, wrapped/staked/bridged products excluded.
- **Farm plan**: 8 concrete steps per protocol (action, cost, time), derived from its category, chains, TVL and age.

---

<sub>Entered on [make.fun](https://make.fun/?ref=YOUR-REFERRAL-CODE&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
