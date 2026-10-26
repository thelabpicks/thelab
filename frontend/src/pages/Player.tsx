import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleDollarSign, Hourglass, Info } from "lucide-react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { cn, kickoff, num, pct } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import type { Reason } from "@/lib/types";
import { Badge, Card, CardBody, CardHeader, ErrorState, LoadingBlock, Notice, PosBadge, Segmented, Stat, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import { ConfidenceBadge, Estimate, Flags, Outcome, ReasonList, SignalIcons } from "@/components/shared";
import { useFeed } from "@/lib/feed";
import { PlayerProps, usePlayerPropRows } from "@/components/PlayerProps";
import { GameByGame, type LogGame, type LogStat } from "@/components/GameByGame";
import { DUE_GAP, dueOf, tdEdge, tdLuck, useDueStudy } from "@/lib/signals";

type Game = { week: number; opponent: string; carries: number; targets: number; receptions: number; rush_tds: number; rec_tds: number; anytime_tds: number;
  goal5_carries: number; goal10_carries: number; rz_carries: number; goal5_targets: number; goal10_targets: number; rz_targets: number; ez_target_proxy: number;
  missed_rz_targets: number; missed_goal5_carries: number; xtd: number | null; offense_snaps: number; offense_pct: number | null; has_box: number; team: string;
  attempts: number | null; completions: number | null; pass_yards: number | null; pass_tds: number | null; interceptions: number | null; rush_yards: number | null; rec_yards: number | null };
type Event = { week: number; game_id: string; play_id: string; offense: string; defense: string; event_type: string; yards_to_goal: number; air_yards: number | null;
  completed: number; td: number; ez_proxy: number; xtd: number | null; description: string; miss_label: string | null; ez_label: string | null };
type PlayerResp = {
  player_id: string; player_name: string; position: string; team: string; headshot_url: string | null; roster_status: string | null; season: number; week: number;
  prediction: null | { rank: number | null; score: number | null; p_model: number | null; calibrated: boolean; model_version: string; eligible: boolean; exclusion: string | null;
    confidence: string; flags: string[]; reasons: Reason[]; features: Record<string, number | string | null>; opponent: string; game_id: string; team: string; outcome: number | null; data_cutoff: string };
  games: Game[]; events: Event[]; field_splits: { zone: string; carries: number; targets: number; tds: number; xtd: number; ez_proxy: number }[];
  usage: { week: number; opp_share: number | null; xtd_share: number | null; team_tds: number | null }[];
  matchup: { defense: string; position: string; games: { week: number; offense: string; touchdowns: number; xtd: number; rz_carries: number; rz_targets: number; goal5_carries: number; goal5_targets: number }[] } | null;
  definitions: Record<string, string>;
};

export default function PlayerPage() {
  const { id = "" } = useParams();
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const [ledgerFilter, setLedgerFilter] = React.useState<"all" | "missed" | "td" | "goal5">("all");
  const q = useQuery({ queryKey: ["player", id, season, week], queryFn: () => api.get<PlayerResp>(`/players/${id}`, { season, week }) });
  const d = q.data;
  const p = d?.prediction;
  const f = p?.features ?? {};
  const chart = (d?.games ?? []).map((g) => ({ week: `W${g.week}`, "Inside-5 carries": g.goal5_carries, "Inside-10 carries": g.goal10_carries, "RZ targets": g.rz_targets, TDs: g.anytime_tds, xTD: g.xtd != null ? +g.xtd.toFixed(2) : null }));
  const events = (d?.events ?? []).filter((e) => ledgerFilter === "all" || (ledgerFilter === "missed" ? !e.td : ledgerFilter === "td" ? e.td : e.yards_to_goal <= 5));
  const feed = useFeed(season, week);
  const qb = d?.position === "QB";
  const tot = (k: keyof Game) => (d?.games ?? []).reduce((a, g) => a + (Number(g[k]) || 0), 0);
  const lines = usePlayerPropRows(id, season, week, feed).rows;
  const log = gameLog(d?.position ?? "", d?.games ?? [], (m) => lines.find((x) => x.m.market === m));

  return (
    <div className="space-y-5">
      <Link to={`/rankings${suffix}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> Rankings</Link>
      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.isLoading && <Card><LoadingBlock rows={8} className="p-4" /></Card>}
      {d && (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            {/* Identity / game */}
            <Card>
              <CardBody className="space-y-4">
                <div className="flex items-center gap-3">
                  {d.headshot_url ? <img src={d.headshot_url} alt="" className="h-16 w-16 rounded-xl bg-raised object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /> : <TeamBadge team={d.team} size="lg" />}
                  <div className="min-w-0">
                    <h1 className="flex items-center gap-1.5 font-display text-2xl font-bold leading-tight tracking-tight">{d.player_name}
                      {p?.eligible && <SignalIcons className="[&_svg]:h-5 [&_svg]:w-5" due={dueOf(f)} edge={p.calibrated ? tdEdge(feed, d.player_id, p.p_model) : null} />}</h1>
                    <div className="mt-1 flex items-center gap-2 text-sm text-muted"><TeamBadge team={d.team} /><PosBadge pos={d.position} />{d.roster_status && <Badge>{d.roster_status}</Badge>}</div>
                  </div>
                </div>
                {p ? (
                  <>
                    <div className="rounded-lg border border-line p-3">
                      <div className="label">Week {week} · vs {p.opponent}</div>
                      <div className="mt-1 text-sm text-muted">{kickoff(String(f.gameday ?? ""), String(f.gametime ?? ""))} · team implied {num(f.team_implied_total)} pts</div>
                      <div className="mt-3 flex items-end justify-between">
                        <Estimate p={p.p_model} score={p.score} calibrated={p.calibrated} size="lg" />
                        <div className="text-right text-sm"><div className="text-muted">Rank</div><div className="font-display text-xl font-semibold">#{p.rank ?? "—"}</div></div>
                      </div>
                      {p.outcome != null && <div className="mt-2 text-sm">Result: <Outcome outcome={p.outcome} participated={1} /></div>}
                    </div>
                    {!p.eligible && <Notice tone="warn" title="Not eligible">{p.exclusion}</Notice>}
                    <div className="flex flex-wrap gap-1.5"><ConfidenceBadge c={p.confidence} /><Badge tone="neutral">{p.model_version}</Badge></div>
                    <Flags flags={p.flags} />
                    <Signals features={f} chance={p.calibrated ? p.p_model : null} playerId={d.player_id} feed={feed} />
                    <p className="text-xs text-muted">Built from data through {p.data_cutoff}. Injury status: {f.report_status ? String(f.report_status) : f.injury_report_published ? "not listed" : "report not yet published"}.</p>
                  </>
                ) : <Notice tone="info">No candidate row for {season} Week {week} (bye, inactive, or no earlier games).</Notice>}
              </CardBody>
            </Card>
            <GameByGame stats={log.stats} games={log.games} initial={log.initial}
              extra={[{ label: "Snap%", value: (g) => pct(d.games.find((x) => `w${x.week}` === g.id)?.offense_pct, 0) }]} />
          </div>

          <PlayerProps playerId={d.player_id} season={season} week={week} feed={feed} />

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
            {/* Opportunity */}
            <div className="space-y-5">
              <Card>
                <CardHeader title="Scoring opportunity by week" subtitle="Field position at the snap; targets count whether or not the pass was caught" />
                <CardBody>
                  <div className="mb-4 grid grid-cols-3 gap-4 sm:grid-cols-6">
                    <Stat label="Games" value={d.games.length} />
                    <Stat label="≤5 carries" value={tot("goal5_carries")} />
                    <Stat label="≤10 carries" value={tot("goal10_carries")} />
                    <Stat label="RZ targets" value={tot("rz_targets")} />
                    <Stat label="TDs" value={tot("anytime_tds")} />
                    <Stat label="xTD" value={num(d.games.reduce((a, g) => a + (g.xtd ?? 0), 0), 1)} hint="Play-based xTD: historical conversion of these opportunities" />
                  </div>
                  {chart.length ? (
                    <div className="h-64" role="img" aria-label="Weekly inside-5 carries, inside-10 carries, red-zone targets and touchdowns, with xTD line. The table below lists the same values.">
                      <ResponsiveContainer>
                        <ComposedChart data={chart} margin={{ left: -20, right: 8, top: 8 }}>
                          <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                          <XAxis dataKey="week" tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                          <YAxis allowDecimals={false} tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--line))", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "rgb(var(--raised))" }} />
                          <Legend wrapperStyle={{ fontSize: 12 }} />
                          <Bar dataKey="Inside-5 carries" fill="rgb(var(--accent))" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="Inside-10 carries" fill="rgb(var(--accent) / 0.45)" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="RZ targets" fill="rgb(var(--info))" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="TDs" fill="rgb(var(--warn))" radius={[3, 3, 0, 0]} />
                          <Line dataKey="xTD" stroke="rgb(var(--fg))" strokeWidth={2} dot={{ r: 3 }} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  ) : <p className="text-sm text-muted">No games this season before Week {week}.</p>}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Field-position split" subtitle="Yards to goal at the snap" />
                <TableWrap>
                  <table className="w-full"><thead><tr><Th>Zone</Th><Th className="text-right">Carries</Th><Th className="text-right">Targets</Th><Th className="text-right" title="End-zone target proxy (air yards ≥ yards to goal)">EZ proxy</Th><Th className="text-right">TDs</Th><Th className="text-right">xTD</Th></tr></thead>
                    <tbody>{d.field_splits.map((s) => <tr key={s.zone}><Td>{s.zone}</Td><Td className="text-right">{s.carries}</Td><Td className="text-right">{s.targets}</Td><Td className="text-right">{s.ez_proxy}</Td><Td className="text-right font-medium">{s.tds}</Td><Td className="text-right">{num(s.xtd, 2)}</Td></tr>)}</tbody>
                  </table>
                </TableWrap>
              </Card>
            </div>

            {/* Why / opponent */}
            <div className="space-y-5">
              <Card>
                <CardHeader title="Why ranked here" />
                <CardBody>
                  {p?.reasons?.length ? <ReasonList reasons={p.reasons} /> : <p className="text-sm text-muted">No pregame features available.</p>}
                  {p && (
                    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line pt-3 text-xs">
                      {[["Carries/g", num(f.carries_pg)], ["Targets/g", num(f.targets_pg)], ["Snap share", pct(f.snap_pct)], ["xTD share", pct(f.xtd_share)],
                        ["Opp. share", pct(f.opp_share)], ["Shrunk TD-game rate", pct(f.anytime_rate_shrunk)], ["Team TD/g", num(f.team_td_pg, 2)], ["Games (season)", num(f.n_games_cur, 0)]].map(([k, v]) => (
                        <React.Fragment key={k}><dt className="text-muted">{k}</dt><dd className={cn("num text-right", v === "—" && "text-muted")}>{v === "—" ? "unavailable" : v}</dd></React.Fragment>
                      ))}
                    </dl>
                  )}
                </CardBody>
              </Card>
              {d.matchup && (
                <Card>
                  <CardHeader title={`${d.matchup.defense} vs ${d.matchup.position}s`} subtitle="Prior games only" action={<Link to={`/defenses/${d.matchup.defense}${suffix}`} className="text-xs text-accent">Defense →</Link>} />
                  <TableWrap>
                    <table className="w-full"><thead><tr><Th>Wk</Th><Th>Off</Th><Th className="text-right">TDs</Th><Th className="text-right">xTD</Th><Th className="text-right">RZ car</Th><Th className="text-right">RZ tgt</Th></tr></thead>
                      <tbody>{d.matchup.games.map((g) => <tr key={g.week}><Td>{g.week}</Td><Td>{g.offense}</Td><Td className="text-right font-medium">{g.touchdowns}</Td><Td className="text-right">{num(g.xtd, 2)}</Td><Td className="text-right">{g.rz_carries}</Td><Td className="text-right">{g.rz_targets}</Td></tr>)}</tbody>
                    </table>
                  </TableWrap>
                </Card>
              )}
            </div>
          </div>

          <Card>
            <CardHeader title="Full game log" subtitle="Box score + play-by-play opportunity counts (zero-TD games included)" />
            <TableWrap>
              <table className="w-full"><thead><tr><Th>Wk</Th><Th>Opp</Th><Th className="text-right">Snap%</Th>{qb && <><Th className="text-right">Cmp/Att</Th><Th className="text-right">Pass yds</Th><Th className="text-right">Pass TD</Th><Th className="text-right">INT</Th></>}<Th className="text-right">Car</Th><Th className="text-right">Rush yds</Th><Th className="text-right">Tgt</Th><Th className="text-right">Rec</Th><Th className="text-right">Rec yds</Th><Th className="text-right">≤5 car</Th><Th className="text-right">≤10 car</Th><Th className="text-right">RZ car</Th><Th className="text-right">≤5 tgt</Th><Th className="text-right">RZ tgt</Th><Th className="text-right">EZ proxy</Th><Th className="text-right" title="Inside-20 targets without a TD; not drops">Missed RZ tgt</Th><Th className="text-right">TDs</Th><Th className="text-right">xTD</Th></tr></thead>
                <tbody>{d.games.map((g) => (
                  <tr key={g.week}><Td>{g.week}</Td><Td>{g.opponent}</Td><Td className="text-right">{pct(g.offense_pct)}</Td>{qb && <><Td className="text-right">{g.completions ?? 0}/{g.attempts ?? 0}</Td><Td className="text-right font-medium">{num(g.pass_yards, 0)}</Td><Td className="text-right">{g.pass_tds ?? 0}</Td><Td className="text-right">{g.interceptions ?? 0}</Td></>}<Td className="text-right">{g.carries}</Td><Td className="text-right font-medium">{num(g.rush_yards, 0)}</Td><Td className="text-right">{g.targets}</Td><Td className="text-right">{g.receptions}</Td><Td className="text-right font-medium">{num(g.rec_yards, 0)}</Td><Td className="text-right">{g.goal5_carries}</Td><Td className="text-right">{g.goal10_carries}</Td><Td className="text-right">{g.rz_carries}</Td><Td className="text-right">{g.goal5_targets}</Td><Td className="text-right">{g.rz_targets}</Td><Td className="text-right">{g.ez_target_proxy}</Td><Td className="text-right">{g.missed_rz_targets}</Td><Td className="text-right font-semibold">{g.anytime_tds}</Td><Td className="text-right">{num(g.xtd, 2)}</Td></tr>))}
                </tbody>
              </table>
            </TableWrap>
          </Card>

          <Card>
            <CardHeader title="Scoring-chance ledger" subtitle="Every rush or target from inside the 20, plus any TD. Misses are opportunities, not drops."
              action={<Segmented size="sm" label="Ledger filter" value={ledgerFilter} onChange={setLedgerFilter} options={[{ value: "all", label: "All" }, { value: "goal5", label: "Inside 5" }, { value: "missed", label: "Missed" }, { value: "td", label: "TDs" }]} />} />
            <TableWrap className="max-h-[480px]">
              <table className="w-full"><thead className="sticky top-0 bg-surface"><tr><Th>Wk</Th><Th>Play</Th><Th>Type</Th><Th className="text-right">Yds to goal</Th><Th className="text-right">Air yds</Th><Th>Result</Th><Th className="text-right">Play xTD</Th><Th>Description</Th></tr></thead>
                <tbody>{events.map((e) => (
                  <tr key={e.game_id + e.play_id + e.event_type}>
                    <Td>{e.week}</Td><Td className="font-mono text-xs text-muted">{e.play_id}</Td>
                    <Td>{e.event_type === "pass" ? "Target" : "Carry"}{e.ez_label && <Badge tone="info" className="ml-1.5" title="air_yards ≥ yards to goal; not a charted ball location">End-zone target proxy</Badge>}</Td>
                    <Td className="text-right">{e.yards_to_goal}</Td><Td className="text-right">{e.air_yards ?? "—"}</Td>
                    <Td>{e.td ? <Badge tone="accent">TD</Badge> : <span className="text-xs text-muted">{e.event_type === "pass" ? (e.completed ? "Caught, no TD" : "Incomplete") : "No TD"} · missed scoring opportunity</span>}</Td>
                    <Td className="text-right">{num(e.xtd, 2)}</Td>
                    <Td className="max-w-[460px] whitespace-normal text-xs text-muted">{e.description}</Td>
                  </tr>))}
                  {!events.length && <tr><Td colSpan={8} className="py-6 text-center text-muted">No plays match.</Td></tr>}
                </tbody>
              </table>
            </TableWrap>
          </Card>
          <div className="grid gap-3 md:grid-cols-3">
            {Object.entries(d.definitions).map(([k, v]) => <div key={k} className="flex gap-2 text-xs text-muted"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{v}</div>)}
          </div>
        </>
      )}
    </div>
  );
}

type PropLine = { line: number; source: string } | undefined;

/** The stats books post for his position, main market first, each at this week's line. */
function gameLog(pos: string, games: Game[], lineOf: (market: string) => PropLine): { stats: LogStat[]; games: LogGame[]; initial: string } {
  const st = (key: string, label: string, short: string, market?: string): LogStat => {
    const l = market ? lineOf(market) : undefined;
    return { key, label, short, line: l?.line ?? null, lineNote: l ? (l.source === "book" ? "This week's book line" : l.source === "projected" ? "Projected line (no book line yet)" : "His usual line (no book line yet)") : undefined };
  };
  const td: LogStat = { key: "td", label: "Touchdowns", short: "TD", line: 0.5, lineNote: "Anytime TD: a game with a rushing or receiving score is a hit" };
  const rushRec = st("rush_rec", "Rush + rec yards", "R+R", "rush_rec_yards");
  const stats = pos === "QB"
    ? [st("pass_yds", "Passing yards", "Pass yds", "pass_yards"), st("cmp", "Completions", "Cmp", "completions"), st("att", "Pass attempts", "Att", "pass_attempts"),
      st("pass_td", "Passing TDs", "Pass TD", "pass_tds"), st("int", "Interceptions", "INT", "interceptions"), st("rush_yds", "Rushing yards", "Rush yds", "rush_yards"),
      st("car", "Rush attempts", "Car", "carries")]
    : pos === "RB"
      ? [st("rush_yds", "Rushing yards", "Rush yds", "rush_yards"), st("car", "Rush attempts", "Car", "carries"), st("rec_yds", "Receiving yards", "Rec yds", "rec_yards"),
        st("rec", "Receptions", "Rec", "receptions"), rushRec, td]
      : [st("rec_yds", "Receiving yards", "Rec yds", "rec_yards"), st("rec", "Receptions", "Rec", "receptions"), st("tgt", "Targets", "Tgt"), rushRec, td];
  return {
    stats, initial: stats[0].key,
    games: games.map((g) => ({ id: `w${g.week}`, when: `W${g.week}`, opp: g.opponent, values: {
      pass_yds: g.pass_yards, cmp: g.completions, att: g.attempts, pass_td: g.pass_tds, int: g.interceptions, rush_yds: g.rush_yards, car: g.carries,
      rec_yds: g.rec_yards, rec: g.receptions, tgt: g.targets, td: g.anytime_tds,
      rush_rec: g.rush_yards == null && g.rec_yards == null ? null : (g.rush_yards ?? 0) + (g.rec_yards ?? 0) } })),
  };
}

function Signals({ features, chance, playerId, feed }: { features: Record<string, unknown>; chance: number | null; playerId: string; feed: ReturnType<typeof useFeed> }) {
  const study = useDueStudy();
  const luck = tdLuck(features);
  const bins = study.data?.bins ?? [];
  const dueBin = bins.find((b) => b.lo >= DUE_GAP);
  const hotBin = bins.find((b) => b.hi <= -DUE_GAP);
  const priced = chance != null ? tdEdge(feed, playerId, chance, -1) : null;
  const edge = priced && priced.edge >= 0.03 ? priced : null;
  const price = (x: number) => (x > 0 ? `+${x}` : String(x));
  const state = !luck ? null : luck.gap >= DUE_GAP ? "due" : luck.gap <= -DUE_GAP ? "hot" : "even";
  return (
    <div className="space-y-3 rounded-lg border border-line p-3 text-sm">
      <div className="label">Signals</div>
      <div className="flex gap-2.5">
        <CircleDollarSign className={cn("mt-0.5 h-4 w-4 shrink-0", edge ? "text-accent" : "text-muted/50")} />
        <div>
          <div className="font-medium">{edge ? `Edge: +${Math.round(edge.edge * 100)} pts vs the book` : "Edge"}</div>
          <div className="text-xs text-muted">{chance == null ? "Shown when a validated chance is available."
            : !priced ? "No sportsbook price loaded for him this week yet. Prices are pulled on Saturday."
              : `Best price ${price(priced.price)} (${priced.book}) implies ${pct(priced.implied, 0)}; our chance is ${pct(chance, 0)}. ${edge
                ? `Expected return about ${priced.ev100 >= 0 ? "+" : "-"}$${Math.abs(Math.round(priced.ev100))} per $100 over many bets like it.` : "Not enough gap to call it an edge (3 points minimum)."}`}</div>
        </div>
      </div>
      <div className="flex gap-2.5">
        <Hourglass className={cn("mt-0.5 h-4 w-4 shrink-0", state === "due" ? "text-warn" : "text-muted/50")} />
        <div>
          <div className="font-medium">{state === "due" ? "Due for a score" : state === "hot" ? "Scoring above his chances" : "TD luck"}</div>
          <div className="text-xs text-muted">{!luck ? "Needs at least 3 games this season."
            : `${luck.actual} TD${luck.actual === 1 ? "" : "s"} on ${num(luck.expected, 1)} expected from his carries and targets in ${luck.games} games. `}
            {state === "due" && dueBin?.hit_rate != null && dueBin.season_td_rate != null && dueBin.avg_chance != null
              && `Players this far behind scored in ${pct(dueBin.hit_rate, 0)} of their next games (${dueBin.n.toLocaleString()} cases), well above their ${pct(dueBin.season_td_rate, 0)} rate so far. The model gave them ${pct(dueBin.avg_chance, 0)}, so his chance already includes the bounce-back.`}
            {state === "hot" && hotBin?.hit_rate != null && hotBin.season_td_rate != null
              && `Players this far ahead scored in ${pct(hotBin.hit_rate, 0)} of their next games, down from ${pct(hotBin.season_td_rate, 0)} so far. His chance already expects some cooling.`}
            {state === "even" && "Scoring about as often as his opportunities predict."}</div>
        </div>
      </div>
    </div>
  );
}
