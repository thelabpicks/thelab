# College football

The site's third side: use the **NFL / CFB / NBA** switch in the header. It has the same menu as the NFL and NBA sides
(Picks: This week, Ask, Parlay builder; Research: Player props, All games, Teams; Proof: How it works, Track record),
plus game pages. Player props cover featured games; Teams has power ratings, ATS and over/under records. College football research, not betting advice. No pick is guaranteed.

## Every day, automatically

`.github/workflows/cfb-collect.yml` runs at 15:00 UTC and on demand from the Actions tab:

1. **Collect** (`python -m cfb.collect`): scores and schedules since 2010 and closing spreads, totals and moneylines from
   many books ([cfbfastR-data](https://github.com/sportsdataverse/cfbfastR-data)), this season's lines from the
   cfbfastR play-by-play, ESPN team and player box scores (sportsdataverse-data), the ESPN scoreboard for the coming
   week (ESPN's posted line for every FBS game, free) and the AP poll, and sportsbook prices within budget (below).
2. **Build** (`python -m cfb.pipeline`): weekly ratings, walk-forward game model, the 5,000-game backtest of every
   market, this week's games and picks, props for featured games, frozen picks and the live record (`site-data/cfb/`).
3. **Keep** scoreboards, polls, prices and each game's frozen picks on the `cfb-data` branch.
4. "Refresh data and publish site" then republishes the website with the new numbers.

## The model

* **Ratings**, refit before every week on earlier games only: opponent-adjusted points, yards per play, plays (pace),
  turnovers and, from play-by-play with garbage time removed, EPA per play, success rate and explosive-play rate
  (summarized per game by the collector, `pbp_stats_{year}.csv`), each a ridge solve over every FBS/FCS team; a game's weight halves every 120 days.
* **Game model**: the ratings and the posted line become an expected margin and total (ridge regression refit every
  week; a season's weight halves every two seasons, so the last two count most).
* **Simulation**: each game is played 5,000 times with pairs of real misses from about the last two seasons. Every
  chance (cover, over, team total, win) is the share of those games; score = chance x 10.

## What testing found (2016 on, every game simulated with the model as it stood that week)

* **Game totals** are the market the model beats: the Strong tier (54%+) hit 53.0% at the closing total and about 59%
  at the opening total, so totals are best bet early in the week.
* **Underdog moneylines (upsets)**: the model's underdog win chances match how often dogs really won. Betting the
  moneyline only when the model's chance beats the price by 4+ points (the Value tier, 89% underdogs) returned +4.1%
  per bet over 1,504 bets, profitable in 7 of 9 seasons (2024 lost 19.8%); 90% range -1.8% to +9.8%. The home page's
  Upset watch lists the likeliest upsets and marks the ones in that tier.
* **Spreads**: no tier beat the price at the close, so they are shown as leans, never as picks. Elo, line moves and a
  separate upset model added nothing over the market.
* **Team totals**: tested only at implied lines (old team-total lines were never archived), so they are picks only
  when a book posts the line.
* A tier is a pick only if it beat 52.4% (the -110 break-even) over the whole test, did not lose over the last two
  seasons, and every stronger tier passed too. Props are picks only at book-posted lines.

## Lab rating (out of 10)

Every lean (game lines and props) gets a rating from `cfb/rating.py`: the simulated chance is calibrated on past
results (an isotonic fit, per market, with moneyline underdogs and favorites fit apart, of how much of the simulation's edge over the market's own chance leans really
kept; recent seasons count most), priced at the best odds on offer, and ranked against every past lean's expected
return. Leans from markets or tiers that did not beat the price in testing stop at 6.9. Tested walk-forward (each
season rated with fits from earlier seasons only): 7+ made money (about +1.6% per bet over 10,400 bets), under 7 lost
about the books' cut; 7, 8 and 9 performed about the same. The bands are published in `backtest.json` (`rating`).
Fitting moneyline underdogs and favorites apart (October 2026) raised the 7+ return from +1.1% to +1.6% on unseen
seasons: one shared fit had rated short favorites too high (favorites rated 7+ had lost 6%). Moneylines count as proven
on underdogs only (+100 to +300); favorite value bets returned +1% over 159 bets, too few to call an edge.

"Best picks" (home page and Ask) list each game's single highest-rated bet, and only when it rates 7+.

The **All games** tab (`/cfb/games`) lists every game with the simulation's spread, total and moneyline picks in three
columns, each with its rating and the best book price; the home page shows the featured games the same way.

Lines: each game uses the sportsbook consensus while it is under 36 hours old, then today's ESPN BET line (free,
read every morning), so the line stays current between the Tuesday and Saturday Odds API pulls without spending
more credits. Game pages show every book's spread, total and moneyline from the last pull.
The **Parlay builder** (`/cfb/parlay`) offers those legs plus props at book-posted lines; legs from the same game are
priced together from 1,000 of that game's simulated scores (`sims.json`), other legs multiply.

## Checking itself

* **Data checks** every run (Research page): finished games missing a box score, play-by-play or closing line;
  box-score yards vs play-by-play EPA; ESPN's spread vs the sportsbooks'; games without a line yet; every matchup's
  home and away team against ESPN's schedule; no team listed in two games. The site shows only the current week
  (`this_week`): an eight-day look-ahead alone put next Saturday's games next to today's. Sportsbook feeds that list a
  neutral-site game the other way round are turned to the schedule's home and away before prices are saved.
* **Before the game**: quarterback-change warnings when a team's last passer is not its season leader.
* **After the game**: every frozen projection is compared with the final and with the book's line (props too), and the
  game is simulated 5,000 times again from what each offense actually did (a box-score-to-points model fit on the last
  three seasons). Pregame vs post-game sim = how far the inputs were off; post-game sim vs final = what no input
  explains. Per-input bias (pace, yards per play, turnovers, EPA, success, explosives) shows which inputs are skewed.
  Every final then joins the next week's refit.
* **Upsets** (underdog of 2.5+ points wins): each week's report card lists them with the model's pregame edge, the
  dog's rating and what the dog did better (turnovers, EPA per play, success rate, explosive plays). Over 10,285 games
  since 2016 the dog won the turnover battle in 62% of upsets (20% of other games) and had better EPA per play in 73%.
  Pregame upset signals tested against the spread, season by season out of sample (October 2026): rest days, bye
  weeks, line moves, Elo vs the line, recent form against the spread, and season EPA, success, explosive and turnover
  edges. None improved on the spread alone, so none were added; the model's own edge and home underdogs helped
  slightly and are already in it.
* **Navy and the other option offenses** (October 2026 check): since 2016 the model's average lean toward Navy, Army
  and Air Force was within half a point of the line, and all three covered more often than not, so there is no
  option-offense bias to correct.

## Odds API budget

About 12 credits a week from the shared 500: game lines for every game on Tuesday and Saturday (3 credits each), team
totals for up to 4 featured games and props for the top featured game on Saturday. Nothing is bought below a
200-credit reserve (`CFB_ODDS_RESERVE`), so the NFL Saturday pull is protected. `CFB_PROPS=always|never|auto`.

## Run it locally

```bash
cd backend
python -m cfb.collect
python -m cfb.pipeline        # about a minute
python -m pytest -q tests/test_cfb.py
```
