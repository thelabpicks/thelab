# The Lab (formerly Fourth & Goal Analytics)

A local-first NFL anytime-touchdown research app. It ranks every eligible QB, RB, WR and TE for the week using transparent opportunity evidence, explores all 32 defenses, keeps an auditable Top 3 shortlist with immutable pregame locks, and shows a chronologically correct walk-forward backtest. Probabilities appear only after a model has beaten baselines on unseen weeks.

This is football research, not betting advice. No pick is guaranteed.

- **Backend:** Python 3.11+, FastAPI, SQLite, pandas, scikit-learn. The importer is a separate CLI worker (`python -m engine.cli`) that the API runs as a background subprocess.
- **Frontend:** React 18 + TypeScript + Vite, Tailwind with shadcn-style components, TanStack Table and Query, Recharts, lucide icons. Dark and light themes.

## Open it without a terminal

1. Install Python 3.10+ once from https://www.python.org/downloads/ (free). Node is not needed: the built interface is included.
2. Unzip the folder and double-click **Start Fourth & Goal.command** (Mac) or **Start Fourth & Goal (Windows).bat**.
   On a Mac, the first time macOS may say it is from an unidentified developer: right-click the file, choose **Open**, then **Open** again.
3. The first launch sets up a private environment and downloads the nflverse data (a few minutes). Your browser then opens http://127.0.0.1:8765.
   Later launches refresh this season's files and open in under a minute. Keep the small window open while you use the app; close it to stop.

## Free hosted website (no install at all)

The same interface can run as a free, read-only website that rebuilds itself from fresh nflverse data.

- `.github/workflows/publish-site.yml` runs Tuesday, Thursday, Saturday and Sunday mornings (and on demand from the **Actions** tab). It downloads the data, runs the import, walk-forward validation and predictions, runs the tests, pre-renders every page's data (`python -m engine.export_static`), builds the interface with `VITE_STATIC=1` and publishes it to GitHub Pages. If any step fails, nothing is published and the previous site stays up.
- One-time setup on a **public** GitHub repository: Settings → Pages → Source: **GitHub Actions**, then run the workflow once from the Actions tab. The site appears at `https://<user>.github.io/<repo>/`. GitHub Pages on a private repository needs a paid plan; for a private repo, deploy the same `frontend/dist` folder to Cloudflare Pages instead.
- On the website, filtering, sorting, paging and Top 3 exclude-and-replace run in the browser on the published numbers. Locked selections are saved in that browser only (append-only) and export to CSV. Data import is desktop-only. Player pages are published for the latest week.
- Local preview: `cd backend && python -m engine.export_static && cd ../frontend && VITE_STATIC=1 npm run build && cp -r ../site-data dist/data && npx vite preview`.

## Running on its own

Everything runs on GitHub Actions with no one at the keyboard:

- **Collect NBA data** (09:00, 16:00, 22:30 UTC), **Collect college football data** (15:00 UTC) and **Refresh data and publish site** (after each of those, plus the NFL schedule above) refresh the data, refit the models, freeze picks before each game, grade them after the final and publish.
- **Daily report and health check** (`.github/workflows/lab-ops.yml`, 11:40 UTC) posts the morning's model report as a comment on the pinned **Daily model report** issue, so GitHub emails it and pushes it to the GitHub app. It also checks that every workflow succeeded in the last 30 hours, that The Lab's picks and the report were written, that the site answers and that the odds key works. Anything wrong goes on one **The Lab needs attention** issue, which closes itself once the next check passes. It also switches every schedule back on daily, since GitHub turns scheduled workflows off after 60 days without activity.
- When a source is late the next run catches up: NBA box scores that are not posted by morning grade on the 16:00 run, college finals cfbfastR has not posted yet are taken from ESPN's scoreboard, and a failed run leaves the last good pages up.
- New seasons start by date: college football and the NFL on September 1 (the NFL keeps last season until nflverse posts the new one), the NBA on October 25. To pin a season instead, add a repository variable `NFL_SEASON`, `CFB_SEASON` or `NBA_SEASON` (Settings → Secrets and variables → Actions → Variables).

## Quick start (developers)

```bash
# 1. Backend
cd backend
pip install -r requirements.txt
python -m engine.cli all --download   # downloads the nflverse CSVs into data/raw/, imports, builds, validates, predicts (~1-2 min)
uvicorn main:app --reload             # http://127.0.0.1:8000  (API docs at /docs)

# 2. Frontend (second terminal)
cd frontend
npm install
npm run dev                           # http://localhost:5173 (proxies /api to :8000)
```

Or run both with `./dev.sh` from the repo root. For a single-origin build: `cd frontend && npm run build`, then the API serves `frontend/dist` at http://127.0.0.1:8000.

**Offline / manual files:** put the CSVs in `data/raw/` with the local names shown on the Data & Sync page (`pbp_2026.csv`, `stats_2026.csv`, `roster_2026.csv`, ...) and run `python -m engine.cli all` without `--download`. You can also trigger the import from the Data & Sync page.

Environment variables: `FG_DATA_DIR` (default `./data`), `FG_DB`, `FG_RAW_DIR`, `FG_ADMIN_TOKEN` (require a token for `POST /api/data/refresh` if you ever share the server), `FG_CORS`.

## Checks

```bash
cd backend && python -m pytest -q          # 17 tests: parser invariants, synthetic end-to-end, correlation maths, odds-feed parsing
cd backend && python -m engine.cli smoke-test
cd frontend && npm run typecheck && npm test && npm run build
```

## Pages

| Route | Page |
|---|---|
| `/` | Weekly overview: Top Three watchlist, model/data status, matchup strip with market-implied totals, scoring-area volume leaders, defense vulnerabilities, walk-forward performance |
| `/top10` | The Lab's top 10: the strongest proven picks across NFL, college football and NBA, ranked 1 to 10 with a write-up each. Built on every site refresh by `frontend/scripts/lab-picks.ts`; a pick on the list when its game starts is frozen and graded after the final (state kept in `lab/` on the nfl-data branch) |
| `/rankings` | All eligible players. Server-side sort, filter, paging; column toggles; pin up to 3; CSV export; expandable "why ranked here"; card layout on mobile |
| `/props` | Player props (passing, rushing, receiving): projection, 10–90% range, and for validated markets the chance of going over a line you type |
| `/trends` | Who is scoring this season: which pregame metrics separated scorers, where TDs start, leaders, generous defenses |
| `/builder` | Parlay builder: anytime-TD and validated prop legs, each book's price with the best one highlighted (filled from the odds feed when configured), 40,000-run simulation with same-game correlation, legs-hit distribution, expected return at the best price, CSV export; plus a game simulator showing the most likely scoring pairs |
| `/parlay` | Top 3 builder: evidence rules, exclude and replace, pinned legs, manual American/decimal odds with implied probability, independence product clearly marked simplistic, immutable locks with later grading, CSV export |
| `/defenses`, `/defenses/:team` | All 32 defenses by position (season / last 6 / last 3), xTD allowed, red-zone drive TD rate, pace faced, two-team compare, every TD allowed |
| `/players/:id` | Identity and game, weekly inside-5/10 carries and red-zone targets chart with xTD, field-position split, game log, scoring-chance ledger (misses labelled as missed opportunities, end-zone target proxy labelled as a proxy), opponent history |
| `/backtest` | Walk-forward metrics vs baselines, promotion gate checklist, calibration plot + table, weekly top-3 hits, per position/season, frozen weekly picks |
| `/data` | Source files with rows, SHA-256, import and file timestamps, quality gates, background import with live log, `build_status.json`, licensing and method limits |
| `/settings` | Theme |

Season and week live in the URL (`?season=2026&week=7`) so every view is linkable, and switching weeks is cached by TanStack Query.

## How the numbers are made

1. **Import (idempotent).** Each file is hashed; an unchanged file is skipped. A changed file is imported in one transaction (delete season + insert + `sources` row), so a failed import leaves the previous data and status intact.
2. **Play xTD.** Run/pass by yards-to-goal bucket (and end-zone proxy for passes), smoothed toward the family rate. Rates for season S are learned only from seasons before S.
3. **Ledger.** `player_game` joins box scores (zero-TD games included), play-by-play opportunity counts and snap counts. Participation = box-score row, offensive snaps, or a counted play. A roster row alone is not participation. Passing TDs never count as anytime TDs.
4. **Pregame features.** For week N, every feature uses games before N only: weighted last-8-game usage, xTD share, red-zone volume, snap share, shrunk TD-game rate, market-implied team total, and opponent position TDs/xTD allowed recomputed at that week's cutoff.
5. **Models.** `fg-structural-1` (team TD expectation from the implied total, times shrunk player xTD share, times opponent adjustment, Poisson link, isotonic calibration), `fg-logit-1` (logistic regression) and `fg-gbm-1` (gradient boosting). Baselines: position rate, shrunk player TD rate, opportunity volume (rank only).
6. **Walk-forward + gate.** Each test week is predicted from models fit only on earlier player-games. A candidate is promoted only if, on unseen weeks, it beats both probability baselines on Brier and log loss, the week-bootstrap 95% CI of the log-loss gain excludes zero, ECE ≤ 0.025, there are ≥ 2,000 test rows and ≥ 10 weeks, and it is not worse than the baseline on the latest season. The simplest passing model within 0.001 log loss of the best wins. If none pass, the API returns `p_model: null` everywhere and the UI shows research scores (percentiles) instead.

### Result of the current run (real nflverse data, 2018–2026, imported 2026-10-22)

Test weeks: 2021 W1 through 2026 W6 (96 weeks, 34,538 player-games). Every week is predicted only from games before it.

| Model | Brier | Log loss | AUC | ECE |
|---|---|---|---|---|
| **fg-logit-1 (promoted)** | 0.1222 | 0.3933 | 0.749 | 0.005 |
| fg-gbm-1 | 0.1221 | 0.3931 | 0.749 | 0.004 |
| fg-structural-1 | 0.1255 | 0.4056 | 0.719 | 0.003 |
| Baseline: shrunk player rate | 0.1275 | 0.4142 | 0.699 | 0.014 |
| Baseline: position rate | 0.1367 | 0.4436 | 0.577 | 0.009 |

By position the model matches reality (RB 21.2% predicted vs 22.6% scored, WR 16.3% vs 16.6%, TE 11.6% vs 11.7%), so the run of RBs at the top reflects how touchdowns are distributed, not a bias. With the top-end correction, the 829 test predictions of 50% or more averaged 52.8% and 52.0% scored.

### Recent seasons count more, and the top end is checked

History runs from 2018 (team moves such as OAK→LV are mapped to today's codes). Walk-forward testing covers the last five seasons plus the current one. Two settings were chosen on 2021–2023 and confirmed once on 2024–2026 (`python -m engine.recency`):

* **Recency weighting.** A training game's weight halves every two seasons of age (`models.RECENCY_HALF_LIFE = 2.0`), so last season counts about twice as much as three seasons ago and a game from six seasons ago counts about an eighth. It beat equal weights on the held-out seasons.
* **Top-end correction.** Chances above 50% ran a few points high. Each week, a small logistic correction with a hinge at 50% is fit on all earlier weeks' out-of-sample chances and applied (`models.TOP_END_KNOT`). On 2024–2026 the 50%+ group went from 57.5% predicted / 53.8% observed to 52.9% / 52.2%.

## Player props

`engine/props.py` projects passing yards, attempts, completions, passing TDs, interceptions, rushing yards, rush attempts, receiving yards, receptions and rush + receiving yards with a full predictive distribution (negative binomial for small counts, held-out scaled residuals otherwise). Each market runs the same walk-forward as the TD model and must beat the player-average and position-average baselines on CRPS (week-bootstrap CI), on over/under Brier at a reference line, and be calibrated, before the site shows over/under chances. No historical sportsbook prop lines exist in nflverse, so the reference line is the player's recent median (floor + 0.5).

## Tuning study

`python -m engine.tuning` tests feature settings and extra metrics on 2025 and checks the winner once on the current season's completed weeks; results appear on the Backtest page. The October 2026 run kept the existing settings because the best 2025 setting was worse on 2026.

## Parlays and simulations

`engine/correlation.py` turns every walk-forward prediction (anytime TD from the promoted model, and overs at the reference line for each promoted prop market) into a yes/no event, pairs up events from the same game, and estimates by maximum likelihood how strongly each kind of pair moves together (Gaussian copula; buckets by same player / teammates / opponents, market and position, each shrunk toward its parent). The correlation for test week W is learned only from earlier weeks. It is used only if it beats simply multiplying the chances on unseen weeks.

October 2026 run: 15,899 events, 341,608 same-game pairs, 21 test weeks. Correlated chances beat multiplication on pairs (log-loss gain 0.00033, week-bootstrap 95% CI 0.00004 to 0.00064), were better on 3-leg combos (+0.00068) and on 2026 alone (+0.00075), so the builder uses them. Largest links: a QB's passing-TD over with his WRs scoring (rho about 0.43), a player's receptions over with his own TD (0.35); teammates both scoring is slightly negative (about -0.05). Opponents are close to independent.

The browser repeats the same model (`frontend/src/lib/sim.ts`): 40,000 correlated draws per slip, legs in different games independent.

## Post-game re-simulations

`engine/simreview.py` saves every game's simulation (`engine/gamesim.py`, 5,000 runs) before kickoff: each player's share of targets and carries, catch rate, yards per target and per carry, the team's expected passes and runs, the betting line, the league corrections in use and the simulated range of every stat. Like the pick log, a game's file freezes at kickoff and lives on the `nfl-data` branch (`sims/`). After the final, each frozen game is simulated again with what really happened swapped in one layer at a time (who played, team volume and score, each player's role, then his efficiency); how much each layer cuts the typical miss shows which pregame input was off, market by market, and each input is compared directly (actual minus pregame) per game and over the season. The Backtest page shows it as "Post-game re-sims".

What the review measures feeds the next simulations: team pass and run volume are corrected every update from the last four finished weeks, and catch rate, yards per target and yards per carry get the same kind of correction only where a walk-forward test on the last two seasons (same weeks simulated with and without it, week-bootstrap 90% interval of the log-loss gain above zero) shows it helps. The test reruns every update, so a correction switches on or off as the evidence changes.

## Ask

`/ask` (and the question bar on the home page) answers plain-English questions from the site's own numbers: anytime TD picks, one scorer per game, prop sides at the book line or any line ("QBs who throw for 250"), value against the best price, overpriced bets, parlays (40,000 correlated simulations), a player, a team or game, longshots, the injury report and the model's track record, with position, team, day and count filters. It also answers "why" questions about a pick from its factors, hit-rate questions ("What props have a 100% hit rate?"), every line for one player ("Nacua receptions alt lines"), defense matchups by position, game totals, projection leaders by market, and what a term means. The built-in engine (`frontend/src/lib/ask.ts`) is free and never invents a number. Optionally a visitor can paste their own Anthropic API key (kept only in that browser) to have Claude handle any wording; it can only answer through tools that call the same engine (`frontend/src/lib/askAi.ts`).

## Props: over and under confidence

The Player props page gives every player an Under score and an Over score out of 10 for the line shown (the book line when loaded, otherwise his usual line: recent median rounded down plus 0.5, or a line you type). The score is the model's chance of that side times 10, so the two always add to 10; the bigger one is the lean, labeled with its confidence tier and the past hit rate for that tier. Rows open to show why: opponent defense against the position compared with the league, recent games against the line, role and team scoring outlook. `/backtest/confidence` tracks overs and unders separately (`by_side`) and unders by market (`unders_by_market`); on 96 unseen weeks, unders the model gave 65%+ hit 73.6% (13,023 picks).

## Signals: Edge and Due

Player names carry two symbols. **Edge** ($): the anytime-TD chance beats the chance implied by the best US book price by 3+ points (only once prices are loaded). **Due** (hourglass): at least 1.5 fewer TDs this season than his carries and targets predicted (season expected TDs minus TDs, 3+ games). `engine/due.py` (`python -m engine.due`, served at `/backtest/due`) checks this walk-forward: on the October 2026 run, 1,611 due player-games scored 27.8% of the time, far above their 20.8% season TD rate and close to the 26.5% the model gave; players 1.5+ TDs ahead of expectation scored 32.7%, down from 48.6%. Adding the gap on top of the model's chance lowered accuracy on 80 unseen weeks (log loss +0.00008), so it is not double-counted. Both signals appear on player pages (with the numbers behind them), in rankings and in Ask ("Who is due for a TD?").

## Hit rates

`/hitrates` lists, for each player and market, the highest line he cleared in 100%, 90%, 80% or 70% of his last 5, 8 or 16 games (the lowest for unders), with this week's model chance and tier beside it, filterable by side, market, position and team. Every row on the Player props page also opens a ladder of lines with the model chance and recent hit counts at each (`frontend/src/lib/hitrates.ts`). A perfect recent record is not a forecast, so lists are sorted by the model's chance.

## How it works

`/how` explains the chances, tiers, edge, lines and model inputs in plain language and shows the live ratings: the promoted TD model's accuracy against baselines, the TD and props tier records, overs vs unders, unders by market and the against-the-books record.

## Sportsbook prices (optional)

`engine/odds.py` reads current prices from The Odds API (a licensed feed; scraping sportsbook sites is against their terms) for anytime TD, receptions, receiving yards, rushing yards, passing yards and passing TDs across US books. Add a free key at the-odds-api.com as the repository secret `ODDS_API_KEY`. Each fetch costs about 6 credits per game (about 90-100 a week); the free plan has 500 a month, so the hosted site fetches on the Saturday run and on manual runs only, and keeps the snapshot between runs. Without a key, prices are typed in. Locally: `ODDS_API_KEY=... python -m engine.odds`.

## Data honesty rules enforced in code

- End-zone target = `air_yards >= yardline_100`, always shown as **End-zone target proxy**.
- An incomplete or caught-but-short target is a *missed scoring opportunity*; there is no drop field anywhere.
- Unknown values render as "—"/"unavailable" and sort last; they are never zero-filled into ranks.
- Locks are protected by SQLite triggers that reject UPDATE and DELETE, and are refused after kickoff.

## Engine safeguards

1. Receiver/rusher TD credit requires `td_player_id` to match (a teammate's fumble-recovery TD after a catch is not the receiver's TD).
2. Files are hashed and re-imported only when changed, atomically.
3. Defense splits are recomputed at every historical week's cutoff, never "as of today".
4. `game_id`, drives, offensive play counts, snaps, injuries and schedule lines are kept for red-zone drive rates, pace, participation and implied totals.
5. Season-to-date game counts are not capped by the recency window.

## Known gaps

- **Coverage (man/zone, Cover 1–4):** no charting source is connected; the app says so rather than showing numbers.
- **Injury reports for the upcoming week** are published through the week. For Week 7 only the Thursday game had a report at import time, so most candidates carry an "injury report not yet published" flag. Re-run the import before kickoff.
- **Market lines** come from the nflverse schedule (closing lines for completed games). Backtests therefore use lines slightly later than a midweek decision.
- **Historical archived anytime-TD odds** are not available, so there is no market baseline in the backtest; manually entered odds are informational only.
- Players with snaps but no box-score row count as zero-TD participants; players with neither are treated as did-not-play (void).

Data: nflverse (nflfastR / nflreadr), https://github.com/nflverse/nflverse-data. Review its licence before redistributing data.
