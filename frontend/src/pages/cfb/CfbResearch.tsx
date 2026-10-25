import { pct } from "@/lib/format";
import { MARKET_LABEL, useCfb, type Backtest, type CfbMarket, type CfbRecord, type CfbStatus, type Findings, type RatingReport, type ReportCard, type Upsets } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice } from "@/components/ui";
import { NotPublished, RatingMeter, TierLine, roiText } from "./shared";

const ORDER: CfbMarket[] = ["total", "spread", "moneyline", "team_total"];

export default function CfbResearch() {
  const bt = useCfb<Backtest>("backtest.json");
  const f = useCfb<Findings>("findings.json");
  const rec = useCfb<CfbRecord>("record.json");
  const status = useCfb<CfbStatus>("status.json");
  if (bt.isError) return <NotPublished error={bt.error} />;
  const b = bt.data;
  return (
    <div className="space-y-5">
      <PageTitle kicker="College football" title="Track record" />
      {!b && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {b && (
        <Notice title="The short version">
          Over {b.games.toLocaleString()} games ({b.first_season}-{b.last_season}), each played 5,000 times by the model as it stood before that week:
          game totals beat the price, and so did underdog moneylines priced well below the model's chance; closing spreads did not. A pick needs a tier that hit at least {pct(b.break_even, 1)} (the -110 break-even)
          over the whole test and did not lose over {b.recent_seasons.join(" and ")}.
        </Notice>
      )}

      <Card>
        <CardHeader title="Live record" subtitle="Every game's leans are frozen on game day before kickoff and graded at the frozen line." />
        <CardBody className="text-sm">
          {!rec.data ? <LoadingBlock rows={2} /> : rec.data.picks === 0 ? <span className="text-muted">{rec.data.empty_reason}</span> : (
            <>
              <div>Suggested picks: <b>{rec.data.suggested?.hits}-{(rec.data.suggested?.n ?? 0) - (rec.data.suggested?.hits ?? 0)}</b> ({pct(rec.data.suggested?.rate, 1)}) over {rec.data.games} games since {rec.data.first_date}.</div>
              <table className="mt-3 w-full text-sm">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Market</th><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th><th className="text-right font-medium">Hit</th></tr></thead>
                <tbody>{rec.data.by_market_tier?.map((r) => (
                  <tr key={`${r.market}-${r.tier}`} className="border-t border-line/60"><td className="py-1">{MARKET_LABEL[r.market]}</td><td>{r.tier ?? "–"}</td>
                    <td className="text-right tabular-nums">{r.n}</td><td className="text-right tabular-nums">{r.market === "moneyline" ? roiText(r.roi) : pct(r.rate, 1)}</td></tr>
                ))}</tbody>
              </table>
            </>
          )}
        </CardBody>
      </Card>

      {rec.data?.report_card && <ReportCardView c={rec.data.report_card} />}

      {b && ORDER.map((m) => {
        const r = b.markets[m];
        const money = m === "moneyline";
        return (
          <Card key={m}>
            <CardHeader title={<>{r.label} {r.proven ? <Badge tone="ok">Proven tier</Badge> : <Badge tone="warn">No proven tier</Badge>}</>}
              subtitle={money ? `Return per $1 at the closing moneyline, prices ${r.price_range?.[0]} to +${r.price_range?.[1]}, betting the side with the better expected return.`
                : m === "team_total" ? "Graded at the implied team total (half the total minus half the spread): old team-total lines were never archived, so these never become picks unless a book posts the line."
                : `Graded at the closing ${m === "total" ? "total" : "spread"}, pushes left out.`} />
            <CardBody className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th>
                  <th className="text-right font-medium">{money ? "Return" : "Hit"}</th><th className="text-right font-medium">Last 2 seasons</th><th className="text-right font-medium" /></tr></thead>
                <tbody>{r.tiers.map((t) => <TierLine key={t.tier} t={t} money={money} />)}</tbody>
              </table>
              {m === "total" && r.by_side && (
                <p className="mt-3 text-xs text-muted">Strong tier by side: overs {pct(r.by_side.over?.find((t) => t.tier === "Strong")?.rate, 1)}, unders {pct(r.by_side.under?.find((t) => t.tier === "Strong")?.rate, 1)}.
                  {" "}Seasons (Strong tier): {r.by_season.map((s) => `${s.season} ${pct(s.rate, 0)}`).join(", ")}.</p>
              )}
            </CardBody>
          </Card>
        );
      })}

      {b?.opening_totals && (
        <Card>
          <CardHeader title="Bet totals early" subtitle="The same total leans graded at the opening line (the book's first number of the week) instead of the close." />
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Tier</th><th className="text-right font-medium">Leans</th><th className="text-right font-medium">Hit</th><th className="text-right font-medium">Last 2 seasons</th><th /></tr></thead>
              <tbody>{b.opening_totals.tiers.map((t) => <TierLine key={t.tier} t={t} />)}</tbody>
            </table>
            <p className="mt-3 text-xs text-muted">Closing totals moved toward the model's side often enough that the edge is biggest early. The collector buys lines on Tuesday for this reason.</p>
          </CardBody>
        </Card>
      )}

      {b?.rating && <RatingResearch r={b.rating} />}

      {b?.upsets && <UpsetResearch u={b.upsets} />}

      {status.data?.checks && (
        <Card>
          <CardHeader title="Data checks" subtitle="Run every morning before the model: missing games, and sources cross-checked against each other." />
          <div className="divide-y divide-line/60">
            {status.data.checks.map((c) => (
              <div key={c.check} className="flex items-center gap-3 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">{c.check}</div>
                <div className="tabular-nums">{c.value}</div>
                {c.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="warn">Check</Badge>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {f.data && (
        <Card>
          <CardHeader title="Patterns in closing lines" subtitle="Each measured in two separate eras. A pattern counts only if it beat the -110 break-even (or made money, for moneylines) in both." />
          <CardBody className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Pattern</th><th className="text-left font-medium">Side</th><th className="text-right font-medium">2014-21</th><th className="text-right font-medium">2022-26</th><th /></tr></thead>
              <tbody>{f.data.rules.map((r) => (
                <tr key={r.pattern} className="border-t border-line/60">
                  <td className="py-1.5 pr-3">{r.pattern}</td><td className="pr-3 text-muted">{r.side}</td>
                  {r.eras.map((e) => <td key={e.era} className="text-right tabular-nums">{r.market === "moneyline" ? roiText(e.roi) : pct(e.rate, 1)} <span className="text-xs text-muted">({e.n.toLocaleString()})</span></td>)}
                  <td className="pl-2 text-right">{r.holds ? <Badge tone="ok">Holds</Badge> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="How it works" />
        <CardBody className="space-y-2 text-sm text-muted">
          <p><b className="text-fg">Data.</b> Every FBS game since 2010 with final scores and closing spreads, totals and moneylines from many books (cfbfastR / CollegeFootballData.com), ESPN team and player box scores, ESPN's daily scoreboard lines and sportsbook prices from The Odds API.</p>
          <p><b className="text-fg">Ratings.</b> Before every week, opponent-adjusted ratings for points, yards per play, plays (pace), turnovers and, from play-by-play with garbage time removed, EPA per play, success rate and explosive-play rate are refit on earlier games only. A game's weight halves every {b?.model.ratings_half_life_days ?? 120} days, so last season still counts in September and fades as new games come in.</p>
          <p><b className="text-fg">Game model.</b> The ratings and the posted line become an expected margin and total, refit every week on games the model never saw; a season's weight halves every {b?.model.recency_half_life_seasons ?? 2} seasons, so the last two count most.</p>
          <p><b className="text-fg">Simulation.</b> Each game is played {b?.model.sims.toLocaleString() ?? "5,000"} times with real misses from recent seasons (both teams' errors together, so scores stay realistic). Every chance on the site is the share of those games: cover, over, team total, win.</p>
          <p><b className="text-fg">Lab rating.</b> Each lean's simulated chance is checked against how often leans with that much edge over the market really won (recent seasons count most), then priced at the best odds on offer. The rating is where that expected return ranks among every past lean, out of 10. Leans from markets or tiers that did not beat the price in testing stop at 6.9.</p>
          <p><b className="text-fg">Picks.</b> Only tiers that beat the price in the backtest are suggested; every game's leans are frozen before kickoff and graded afterwards.</p>
          <p><b className="text-fg">Learning from results.</b> After every game the frozen projection is compared with the final and with the book's line, and the game is simulated again from what each offense actually did. The gap between the two simulations shows which inputs were off; every result then joins the next week's refit.</p>
          <p>Football research, not betting advice. No pick is guaranteed.</p>
        </CardBody>
      </Card>
    </div>
  );
}

const pts = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));

function ReportCardView({ c }: { c: ReportCard }) {
  return (
    <Card>
      <CardHeader title="Report card" subtitle="After the games: how far the frozen projections were from the finals, next to how far the book's line was (average miss in points; lower is better)." />
      <CardBody className="space-y-4 text-sm">
        {!c.games ? <span className="text-muted">{c.note}</span> : (
          <>
            <table className="w-full">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">{c.games} games</th><th className="text-right font-medium">Model miss</th><th className="text-right font-medium">Line miss</th></tr></thead>
              <tbody>
                <tr className="border-t border-line/60"><td className="py-1">Margin</td><td className="text-right tabular-nums">{pts(c.margin?.model_mae)}</td><td className="text-right tabular-nums">{pts(c.margin?.line_mae)}</td></tr>
                <tr className="border-t border-line/60"><td className="py-1">Total</td><td className="text-right tabular-nums">{pts(c.total?.model_mae)}</td><td className="text-right tabular-nums">{pts(c.total?.line_mae)}</td></tr>
              </tbody>
            </table>
            {c.resim && (
              <div>
                <div className="font-medium">Post-game re-simulation</div>
                <p className="text-xs text-muted">Each game played 5,000 times again from what the offenses actually did (plays, yards, turnovers, EPA, success, explosives).
                  Totals: inputs off by {pts(c.resim.total_input_miss)} points on average; {pts(c.resim.total_rest_miss)} more came from things no input explains (red zone, special teams, bounces).
                  Margins: {pts(c.resim.margin_input_miss)} and {pts(c.resim.margin_rest_miss)}.</p>
                <div className="overflow-x-auto"><table className="mt-2 w-full">
                  <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Game</th><th className="text-right font-medium">Pregame total</th><th className="text-right font-medium">Post-game sim</th><th className="text-right font-medium">Final</th></tr></thead>
                  <tbody>{c.resim.games_list.map((x) => (
                    <tr key={x.label + x.date} className="border-t border-line/60"><td className="py-1 pr-3">{x.label}</td>
                      <td className="text-right tabular-nums">{pts(x.model_total)}</td><td className="text-right tabular-nums">{pts(x.post_total)}</td><td className="text-right tabular-nums">{x.total}</td></tr>
                  ))}</tbody>
                </table></div>
              </div>
            )}
            {!!c.inputs?.length && (
              <div className="overflow-x-auto">
                <div className="font-medium">Which inputs were skewed</div>
                <table className="mt-1 w-full">
                  <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Input</th><th className="text-right font-medium">Bias (actual − expected)</th><th className="text-right font-medium">Average miss</th></tr></thead>
                  <tbody>{c.inputs.map((x) => {
                    const d = x.input.includes("rate") ? 3 : x.input.includes("EPA") ? 3 : x.input.includes("Pace") ? 1 : 2;
                    return <tr key={x.input} className="border-t border-line/60"><td className="py-1">{x.input}</td>
                      <td className="text-right tabular-nums">{x.bias >= 0 ? "+" : ""}{x.bias.toFixed(d)}</td><td className="text-right tabular-nums">{x.mae.toFixed(d)}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            )}
            {!!c.upsets?.length && (
              <div className="overflow-x-auto">
                <div className="font-medium">Upsets: what the model saw, and what decided them</div>
                <p className="text-xs text-muted">Underdogs of 2.5+ points that won. "Model edge" is how many points closer than the line the model had the dog before kickoff; the rest is what the dog did better in the game.</p>
                <table className="mt-1 w-full">
                  <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Upset</th><th className="text-right font-medium">Line</th><th className="text-right font-medium">Model edge</th><th className="text-right font-medium">Dog's rating</th><th className="pl-3 text-left font-medium">Dog was better at</th></tr></thead>
                  <tbody>{c.upsets.map((u) => {
                    const better = Object.entries(u.edges).filter(([, v]) => v > 0).map(([k]) => k.replace(/^(Won the |Better |More )/, "")).join(", ");
                    return (
                      <tr key={u.label + u.date} className="border-t border-line/60 align-top"><td className="py-1 pr-3">{u.dog} <span className="text-muted">({u.label})</span></td>
                        <td className="text-right tabular-nums">+{u.line}</td>
                        <td className={`text-right tabular-nums ${u.model_edge > 0 ? "text-ok" : ""}`}>{u.model_edge > 0 ? "+" : ""}{u.model_edge.toFixed(1)}</td>
                        <td className="text-right tabular-nums">{u.rated != null ? u.rated.toFixed(1) : "–"}</td>
                        <td className="pl-3 text-xs">{better || "none of these: a bounce or special teams"}</td></tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
            {!!c.props?.length && (
              <div className="overflow-x-auto">
                <div className="font-medium">Player props</div>
                <table className="mt-1 w-full">
                  <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Prop</th><th className="text-right font-medium">Graded</th><th className="text-right font-medium">Model miss</th><th className="text-right font-medium">Line miss</th><th className="text-right font-medium">Hit</th></tr></thead>
                  <tbody>{c.props.map((x) => (
                    <tr key={x.market} className="border-t border-line/60"><td className="py-1">{x.label}</td><td className="text-right tabular-nums">{x.n}</td>
                      <td className="text-right tabular-nums">{pts(x.model_mae)}</td><td className="text-right tabular-nums">{pts(x.line_mae)}</td><td className="text-right tabular-nums">{pct(x.hit, 0)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function UpsetResearch({ u }: { u: Upsets }) {
  const vb = u.value_bets;
  return (
    <Card>
      <CardHeader title="Finding upsets" subtitle={`${u.dogs.toLocaleString()} underdogs in the test won ${pct(u.dog_win_rate, 1)} of the time. Does the model know which ones?`} />
      <CardBody className="space-y-4 text-sm">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Model's dog win chance</th><th className="text-right font-medium">Dogs</th><th className="text-right font-medium">Model said</th><th className="text-right font-medium">Market said</th><th className="text-right font-medium">Actually won</th></tr></thead>
            <tbody>{u.calibration.map((x) => (
              <tr key={x.lo} className="border-t border-line/60"><td className="py-1">{pct(x.lo, 0)}–{pct(x.hi, 0)}</td><td className="text-right tabular-nums">{x.n.toLocaleString()}</td>
                <td className="text-right tabular-nums">{pct(x.model, 1)}</td><td className="text-right tabular-nums">{pct(x.market, 1)}</td><td className="text-right tabular-nums font-medium">{pct(x.actual, 1)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        {!!u.drivers?.rows.length && (
          <div>
            <div className="font-medium">What decides upsets</div>
            <p className="text-xs text-muted">{u.drivers.games.toLocaleString()} games with a favorite of {u.drivers.min_line}+ points; the underdog won {u.drivers.upsets.toLocaleString()}.
              How often the underdog was ahead in each part of the game:</p>
            <table className="mt-1 w-full">
              <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Underdog…</th><th className="text-right font-medium">When it won</th><th className="text-right font-medium">When it lost</th></tr></thead>
              <tbody>{u.drivers.rows.map((x) => (
                <tr key={x.driver} className="border-t border-line/60"><td className="py-1">{x.driver}</td><td className="text-right tabular-nums font-medium">{pct(x.upsets, 0)}</td><td className="text-right tabular-nums">{pct(x.others, 0)}</td></tr>
              ))}</tbody>
            </table>
            <p className="mt-1 text-xs text-muted">Turnovers and play-by-play efficiency decide most upsets, and turnovers are mostly luck before kickoff.
              We also tested rest days, bye weeks, line moves, Elo ratings, recent form against the spread and season stat edges as pregame upset signals: none predicted upsets better than the spread already does, so none were added.</p>
          </div>
        )}
        {vb && (
          <>
            <p className="text-muted">Betting the moneyline only when the model's win chance beats the price by a clear margin ({Math.round(vb.dog_share * 100)}% of those bets were on underdogs):
              <b className="text-fg"> {roiText(vb.roi)} per bet</b> over {vb.n.toLocaleString()} bets, {pct(vb.win, 1)} won. Chance the edge is real rather than luck: {pct(vb.p_profit, 0)};
              90% range {roiText(vb.roi_ci90[0])} to {roiText(vb.roi_ci90[1])}. Expect losing seasons.</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <table className="w-full">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Season</th><th className="text-right font-medium">Bets</th><th className="text-right font-medium">Return</th></tr></thead>
                <tbody>{vb.by_season.map((x) => <tr key={x.season} className="border-t border-line/60"><td className="py-1">{x.season}</td><td className="text-right tabular-nums">{x.n}</td><td className={`text-right tabular-nums ${x.roi < 0 ? "text-danger" : ""}`}>{roiText(x.roi)}</td></tr>)}</tbody>
              </table>
              <table className="w-full">
                <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Price</th><th className="text-right font-medium">Bets</th><th className="text-right font-medium">Won</th><th className="text-right font-medium">Return</th></tr></thead>
                <tbody>{vb.by_price.map((x) => <tr key={x.band} className="border-t border-line/60"><td className="py-1">{x.band}</td><td className="text-right tabular-nums">{x.n}</td><td className="text-right tabular-nums">{pct(x.win, 0)}</td><td className="text-right tabular-nums">{roiText(x.roi)}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function RatingResearch({ r }: { r: RatingReport }) {
  const by = (lo: number) => Object.entries(r.by_market).map(([m, rows]) => ({ m, b: rows.find((x) => x.lo === lo) }));
  return (
    <Card>
      <CardHeader title="Does the rating work?" subtitle={`Every lean since ${r.first_season + 0}, each season rated with calibrations from earlier seasons only, graded at the closing price.`} />
      <CardBody className="space-y-3 text-sm">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead><tr className="text-xs text-muted"><th className="text-left font-medium">Rating</th><th className="text-right font-medium">Leans</th><th className="text-right font-medium">Won</th>
              <th className="text-right font-medium">Return per $1</th><th className="text-right font-medium">{r.recent_seasons.join(" and ")}</th></tr></thead>
            <tbody>{r.bands.map((b) => (
              <tr key={b.lo} className="border-t border-line/60">
                <td className="py-1.5"><RatingMeter size="sm" score={b.lo === 0 ? 4.9 : b.lo} /> <span className="text-xs text-muted">{b.lo === 0 ? "under 5" : b.hi >= 10 ? `${b.lo}+` : `${b.lo} to ${b.hi}`}</span></td>
                <td className="text-right tabular-nums">{b.n.toLocaleString()}</td><td className="text-right tabular-nums">{pct(b.win, 1)}</td>
                <td className={`text-right tabular-nums ${(b.roi ?? 0) > 0 ? "text-ok" : ""}`}>{roiText(b.roi)}</td>
                <td className="text-right tabular-nums text-muted">{roiText(b.recent_roi)} <span className="text-xs">({b.recent_n.toLocaleString()})</span></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="text-xs text-muted">Leans rated 7 or better made money; under 7 they lost about the books' cut. Inside 7 to 10 a higher number means a bigger
          calculated edge, but 7s, 8s and 9s did about the same in testing, so treat 7+ as one group. By market, 9+: {by(9).map(({ m, b }) => `${MARKET_LABEL[m as CfbMarket] ?? m} ${roiText(b?.roi)}`).join(", ")}.</p>
      </CardBody>
    </Card>
  );
}
