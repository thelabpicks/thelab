import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Dices, MessageCircleQuestion } from "lucide-react";
import { pct } from "@/lib/format";
import { dayOf, fmtPrice, kick, useCfb, type Backtest, type CfbGame, type CfbStatus, type Week } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, Input, LoadingBlock } from "@/components/ui";
import { LeanRow, Matchup, MatchupRow, NotPublished, RatingKey, roiText } from "./shared";

export default function CfbHome() {
  const week = useCfb<Week>("week.json");
  const bt = useCfb<Backtest>("backtest.json");
  const status = useCfb<CfbStatus>("status.json");
  const nav = useNavigate();
  const [q, setQ] = React.useState("");
  const [allPicks, setAllPicks] = React.useState(false);
  if (week.isError) return <NotPublished error={week.error} />;
  const w = week.data;
  const games = (w?.games ?? []).filter((g) => g.featured);
  // each game's single highest-rated bet, only where it reaches 7 (picks arrive sorted by rating)
  const top = (w?.picks ?? []).filter((p, i, all) => p.score >= 7 && p.proven && all.findIndex((x) => x.game_id === p.game_id) === i);
  const byDay = new Map<string, CfbGame[]>();
  for (const g of games) byDay.set(dayOf(g.date), [...(byDay.get(dayOf(g.date)) ?? []), g]);
  return (
    <div className="space-y-5">
      <PageTitle kicker={w?.games[0] ? `College football ${status.data?.season ?? ""} · Week ${w.games[0].week}` : "College football"} title="This week">
        <Link to="/cfb/parlay"><Button variant="primary"><Dices className="h-4 w-4" />Build a parlay</Button></Link>
      </PageTitle>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/cfb/ask?q=${encodeURIComponent(q.trim())}`); }} className="relative">
        <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask: best totals this week, Alabama spread, top 10 teams…" className="pl-9" aria-label="Ask a question" />
      </form>
      {week.isLoading && <Card><LoadingBlock rows={5} className="p-5" /></Card>}

      {w && (
        <Card>
          <CardHeader title="Top picks" subtitle="Each game's best bet, when it rates 7 or better: the band that beat the books in testing."
            action={top.length > 6 ? <button type="button" className="text-sm text-accent hover:underline" onClick={() => setAllPicks((v) => !v)}>{allPicks ? "Show fewer" : `All ${top.length}`}</button> : undefined} />
          <RatingKey className="border-b border-line px-4 py-2" />
          <div className="divide-y divide-line/60">
            {top.slice(0, allPicks ? undefined : 6).map((p) => (
              <LeanRow key={`${p.game_id}-${p.market}-${p.team ?? ""}`} m={p} bt={bt.data} to={`/cfb/game/${p.game_id}`} simple
                sub={<>{p.away} at {p.home} · {kick(p.date)}</>} />
            ))}
          </div>
          {!top.length && <CardBody className="text-sm text-muted">No bet rates 7+ yet. Picks appear as books post lines (ESPN daily, every sportsbook Tuesday and Saturday).</CardBody>}
        </Card>
      )}

      {w && <UpsetWatch games={w.games} bt={bt.data} />}


      {w && (
        <Card>
          <CardHeader title="Featured games" subtitle="Ranked matchups: the simulation's spread, over/under and moneyline picks, each rated out of 10."
            action={<Link to="/cfb/games" className="text-sm text-accent hover:underline">All {w.games.length} games</Link>} />
          {[...byDay.entries()].map(([day, gs]) => (
            <div key={day}>
              <div className="label bg-raised/50 px-4 py-1.5">{day}</div>
              <div className="divide-y divide-line/60">{gs.map((g) => <MatchupRow key={g.game_id} g={g} />)}</div>
            </div>
          ))}
          {!games.length && <CardBody className="text-sm text-muted">No featured games this week. <Link to="/cfb/games" className="text-accent hover:underline">See every game</Link>.</CardBody>}
        </Card>
      )}
      {status.data && (
        <Card><CardBody className="text-xs text-muted">
          Built from {status.data.history.games.toLocaleString()} games since {status.data.history.first_season} ({status.data.history.lined_games.toLocaleString()} with closing lines).
          Ratings are refit before every week and the last two seasons count most. Latest final {status.data.history.last_game_date}.
          {" "}<Link to="/cfb/how" className="text-accent hover:underline">How it works</Link>
        </CardBody></Card>
      )}
    </div>
  );
}

/** Underdogs the model gives a real chance, best first. "Upset pick" only when the proven moneyline value tier backs the dog. */
function UpsetWatch({ games, bt }: { games: CfbGame[]; bt?: Backtest }) {
  const dogs = games.filter((g) => g.upset && (g.upset.pick || g.upset.p >= 0.3))
    .sort((a, b) => Number(b.upset!.pick) - Number(a.upset!.pick) || b.upset!.p - a.upset!.p).slice(0, 5);
  const vb = bt?.upsets?.value_bets;
  return (
    <Card>
      <CardHeader title="Upset watch"
        subtitle={vb ? `Underdogs most likely to win outright. "Upset pick" = the price pays more than the sims say it should (${roiText(vb.roi)} per bet in testing).`
          : "Underdogs with the best chance to win outright, from 5,000 simulated games."} />
      <div className="divide-y divide-line/60">
        {dogs.map((g) => {
          const u = g.upset!;
          const edge = u.market == null ? null : u.p - u.market;
          return (
            <Link key={g.game_id} to={`/cfb/game/${g.game_id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-raised/50">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{u.team} to win{u.price != null ? ` ${fmtPrice(u.price)}` : ""}</div>
                <div className="text-xs text-muted"><Matchup g={g} /> · {kick(g.date)}</div>
              </div>
              <div className="text-right">
                <div><b className="text-base">{pct(u.p, 0)}</b> <span className="text-xs text-muted">model</span></div>
                <div className="flex items-center justify-end gap-1 text-xs text-muted">
                  {u.market != null && <span>market {pct(u.market, 0)}{edge != null && edge > 0 ? ` (+${(edge * 100).toFixed(0)})` : ""}</span>}
                  {u.pick && <Badge tone="ok" title="The proven moneyline value tier is on this underdog">Upset pick</Badge>}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {!dogs.length && <CardBody className="text-sm text-muted">No underdog has a 30%+ chance this week, or lines are not posted yet.</CardBody>}
    </Card>
  );
}
