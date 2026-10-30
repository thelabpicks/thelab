import * as React from "react";
import { Link } from "react-router-dom";
import { Percent, Search } from "lucide-react";
import { cn, pct } from "@/lib/format";
import { NBA_MARKETS, marketLabel, useNba, type Slate } from "@/lib/nba";
import { FLOOR_MIN_CHANCE, NBA_MILESTONES, floorPicks, lineHitRates, type HitPick } from "@/lib/nbaHitRates";
import { PageTitle } from "@/components/Layout";
import { Card, CardHeader, Input, LoadingBlock, Notice, Segmented, Select, TeamBadge } from "@/components/ui";
import { Headshot, NotPublished } from "./shared";

/** "5/5" with a color: all hit green, most hit amber. */
function Rate({ label, hit }: { label: string; hit: [number, number] }) {
  const r = hit[1] ? hit[0] / hit[1] : 0;
  return (
    <span className={cn("whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs tabular-nums",
      r >= 1 ? "border-accent/40 bg-accent/10 text-fg" : r >= 0.8 ? "border-warn/40 text-fg" : "border-line text-muted")}>
      {label} <b>{hit[0]}/{hit[1]}</b> <span className="text-muted">({Math.round(r * 100)}%)</span>
    </span>
  );
}

export default function NbaHitRates() {
  const slate = useNba<Slate>("slate.json");
  const [view, setView] = React.useState<"floor" | "line">("floor");
  const [threshold, setThreshold] = React.useState(1);
  const [win, setWin] = React.useState<5 | 10>(5);
  const [side, setSide] = React.useState<"over" | "under">("over");
  const [market, setMarket] = React.useState("all");
  const [starsOnly, setStarsOnly] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const floor = view === "floor";
  const picks = React.useMemo(() => {
    const rows = slate.data?.rows ?? [];
    const o = { threshold, window: win, side, market: market === "all" ? undefined : market, starsOnly, search };
    return floor ? floorPicks(rows, o) : lineHitRates(rows, o);
  }, [slate.data, threshold, win, side, market, starsOnly, search, floor]);

  if (slate.isError) return <NotPublished error={slate.error} />;
  const bet = (p: HitPick) => p.milestone != null ? `${p.milestone}+ ${marketLabel(p.row.market)}` : `${p.side === "over" ? "Over" : "Under"} ${p.line} ${marketLabel(p.row.market)}`;
  return (
    <div className="space-y-5">
      <PageTitle kicker={slate.data?.date ? `NBA · ${new Date(slate.data.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}` : "NBA"} title="Hit rates" />
      <Segmented label="View" value={view} onChange={setView} options={[{ value: "floor", label: "Floor picks (X+)" }, { value: "line", label: "DraftKings lines" }]} />
      {floor ? (
        <Notice tone="info" title="Milestones he almost always reaches">
          The highest &ldquo;X+&rdquo; milestone (like 15+ points or 6+ rebounds) that tonight&apos;s model gives {Math.round(FLOOR_MIN_CHANCE * 100)}% or better and that he also
          reached in your chosen share of recent games. The model&apos;s {Math.round(FLOOR_MIN_CHANCE * 100)}%+ calls have hit 91% so far. Books price these steeply, so they suit
          parlay legs more than single bets. A perfect streak alone barely predicts: across two seasons, a 5-for-5 player hit next time about as often as his longer record said.
        </Notice>
      ) : (
        <Notice tone="info" title="DraftKings lines a player keeps clearing">
          Tonight&apos;s DraftKings line where he went over (or under) in your chosen share of recent games, with the model&apos;s chance beside it. Lean on the model&apos;s chance:
          a hot streak by itself is a weak signal.
        </Notice>
      )}
      <Card>
        <CardHeader icon={<Percent className="h-4 w-4 text-accent" />} title={floor ? "Floor picks" : "Hit rates at DraftKings' line"}
          subtitle={slate.data ? `${picks.length} ${floor ? "milestones" : "props"}, highest model chance first` : undefined} />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 sm:px-5">
          <Segmented size="sm" label="Hit rate" value={threshold} onChange={setThreshold} options={[1, 0.9, 0.8, 0.7].map((x) => ({ value: x, label: `${Math.round(x * 100)}%` }))} />
          <Segmented size="sm" label="Games" value={win} onChange={setWin} options={[5, 10].map((x) => ({ value: x as 5 | 10, label: `Last ${x}` }))} />
          {!floor && <Segmented size="sm" label="Side" value={side} onChange={setSide} options={[{ value: "over", label: "Overs" }, { value: "under", label: "Unders" }]} />}
          <Select aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)} className="h-8 w-40 text-xs">
            <option value="all">All markets</option>
            {NBA_MARKETS.filter((m) => !floor || NBA_MILESTONES[m.market]).map((m) => <option key={m.market} value={m.market}>{m.label}</option>)}
          </Select>
          <Segmented size="sm" label="Players" value={starsOnly ? "stars" : "all"} onChange={(v) => setStarsOnly(v === "stars")}
            options={[{ value: "stars", label: "Stars" }, { value: "all", label: "Everyone" }]} />
          <div className="relative w-40">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted" aria-hidden />
            <Input aria-label="Search players" placeholder="Player" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 pl-8 text-xs" />
          </div>
        </div>
        {!slate.data ? <LoadingBlock rows={6} className="p-5" /> : picks.length ? (
          <ul className="divide-y divide-line">
            {picks.map((p) => (
              <li key={`${p.row.market}:${p.row.player_id}`} className="px-4 py-2.5 sm:px-5">
                <div className="flex items-center gap-3">
                  <Headshot src={p.row.headshot} name={p.row.player_name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <TeamBadge team={p.row.team} />
                      <Link to={`/nba/players/${p.row.player_id}`} className="truncate font-medium hover:text-accent">{p.row.player_name}</Link>
                      <span className="shrink-0 text-xs text-muted">{p.row.home ? "vs" : "@"} {p.row.opp}</span>
                    </div>
                    <div className="text-sm font-semibold">{bet(p)}</div>
                  </div>
                  <span className="font-display text-lg font-semibold tabular-nums" title="Tonight's model chance">{pct(p.chance, 0)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[40px]">
                  <Rate label="L5" hit={p.l5} /><Rate label="L10" hit={p.l10} />
                  <span className="text-xs text-muted">Last 10: {p.row.recent.slice(0, 10).map((v) => Math.round(v)).join(", ")}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted">{slate.data.odds.props_priced
            ? `Nothing at a ${Math.round(threshold * 100)}% hit rate over the last ${win} games${starsOnly ? " among stars" : ""}. Try a lower hit rate${starsOnly ? " or everyone" : ""}.`
            : "Hit rates list players DraftKings posts props for, about 10 AM Eastern."}</p>
        )}
      </Card>
    </div>
  );
}
