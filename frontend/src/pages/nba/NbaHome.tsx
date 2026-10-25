import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Dices, MessageCircleQuestion } from "lucide-react";
import { num, pct } from "@/lib/format";
import { MIN_LINE, edgeOf, leanOf, marketLabel, nbaTier, score10, useNba, type NbaConfidence, type NbaStatus, type Slate } from "@/lib/nba";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, Input, LoadingBlock, Notice, TeamBadge } from "@/components/ui";
import { TierBadge } from "@/components/shared";
import { Headshot, NbaSignals, NotPublished } from "./shared";

const tip = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });

export default function NbaHome() {
  const slate = useNba<Slate>("slate.json");
  const status = useNba<NbaStatus>("status.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const nav = useNavigate();
  const [q, setQ] = React.useState("");
  if (slate.isError) return <NotPublished error={slate.error} />;
  const d = slate.data;
  const picks = (d?.rows ?? []).filter((r) => !r.out && r.evidence.minutes_long >= 20 && r.line >= MIN_LINE)
    .map((r) => ({ r, lean: leanOf(r) })).filter((x) => x.lean && x.lean.p >= 0.6)
    .map((x) => ({ ...x, edge: edgeOf(x.r, x.lean), tier: nbaTier(conf.data, x.lean!.p) }))
    .sort((a, b) => b.lean!.p - a.lean!.p).slice(0, 12);
  const strong = conf.data?.props?.tiers.find((t) => t.tier === "Strong");
  return (
    <div className="space-y-5">
      <PageTitle kicker={status.data ? `NBA ${status.data.season_label}` : "NBA"} title={d?.date ? new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) : "Today"}>
        <Link to="/nba/builder"><Button variant="primary"><Dices className="h-4 w-4" />Build a parlay</Button></Link>
      </PageTitle>
      <form onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/nba/ask?q=${encodeURIComponent(q.trim())}`); }} className="relative">
        <MessageCircleQuestion className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask: best unders tonight, will Brunson score 25, 3-leg parlay…" className="pl-9" aria-label="Ask a question" />
      </form>
      {slate.isLoading && <Card><LoadingBlock rows={5} className="p-5" /></Card>}
      {d && !d.games.length && <Notice title="No games scheduled">The next slate appears here the morning of game day.</Notice>}
      {d && !!d.games.length && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {d.games.map((g) => (
            <div key={g.game_id} className="min-w-[150px] rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              <div className="flex items-center gap-1.5"><TeamBadge team={g.away} /><span className="text-muted">@</span><TeamBadge team={g.home} /></div>
              <div className="mt-1 text-xs text-muted">{tip(g.time)}{g.total ? ` · O/U ${g.total}` : ""}{g.home_spread != null ? ` · ${g.home} ${g.home_spread > 0 ? "+" : ""}${g.home_spread}` : ""}</div>
            </div>
          ))}
        </div>
      )}
      {d && !!picks.length && (
        <Card>
          <CardHeader title="Strongest leans today" subtitle={strong?.rate != null ? `Leans of 6.5+ out of 10 hit ${pct(strong.rate, 0)} of ${strong.n.toLocaleString()} unseen games in testing` : "Players averaging 20+ minutes, at the line shown"} />
          <div className="divide-y divide-line/60">
            {picks.map(({ r, lean, edge, tier }) => (
              <Link key={`${r.player_id}-${r.market}`} to={`/nba/players/${r.player_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-raised/50">
                <Headshot src={r.headshot} name={r.player_name} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1 font-medium"><span className="truncate">{r.player_name}</span><NbaSignals edge={edge} due={r.due} /></div>
                  <div className="text-xs text-muted">{r.team} {r.home ? "vs" : "@"} {r.opp} · projects {num(r.mean, 1)} {marketLabel(r.market).toLowerCase()}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold">{lean!.side === "over" ? "Over" : "Under"} {r.line} {marketLabel(r.market)}</div>
                  <div className="flex items-center justify-end gap-1.5 text-xs text-muted"><span className="font-bold text-fg">{score10(lean!.p)}</span>/10 <TierBadge tier={tier} compact /></div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
      {d && d.games.length > 0 && !picks.length && <Notice title="No strong leans yet">No validated lean reaches 6.0 out of 10 today. See all players on the props page.</Notice>}
      {status.data && (
        <Card><CardBody className="text-xs text-muted">
          Built from {status.data.history.games.toLocaleString()} games since {status.data.history.first_season - 1}-{String(status.data.history.first_season).slice(2)} (the last two seasons count most; a game's weight halves every {status.data.recency_half_life_seasons} seasons).
          Latest box score {status.data.history.last_game_date}{status.data.injuries_as_of ? `, injury report ${status.data.injuries_as_of}` : ""}. Players listed Out are shown faded and never picked.
          {" "}<Link to="/nba/how" className="text-accent hover:underline">How it works</Link>
        </CardBody></Card>
      )}
    </div>
  );
}
