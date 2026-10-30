import * as React from "react";
import { Percent } from "lucide-react";
import { FLOOR_MIN_CHANCE, FLOOR_SHORTEST_PRICE, answerFloorPicks, answerHitRates, type Pick } from "@/lib/ask";
import { useLinkSuffix, useSeasonWeek } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody, CardHeader, Input, LoadingBlock, Notice, Segmented, Select } from "@/components/ui";
import { PickList, useAskData } from "./Ask";

const POSITIONS = ["All", "QB", "RB", "WR", "TE"];

export default function HitRatesPage() {
  const { season, week } = useSeasonWeek();
  const suffix = useLinkSuffix();
  const { data } = useAskData(season, week);
  const [threshold, setThreshold] = React.useState(1);
  const [win, setWin] = React.useState(8);
  const [side, setSide] = React.useState<"over" | "under">("over");
  const [market, setMarket] = React.useState("all");
  const [pos, setPos] = React.useState("All");
  const [team, setTeam] = React.useState("");
  const [sort, setSort] = React.useState<"chance" | "hits">("chance");
  const [view, setView] = React.useState<"book" | "floor">("book");
  const floor = view === "floor";
  const a = React.useMemo(() => {
    if (!data) return null;
    const f = { position: pos === "All" ? undefined : pos, teams: team ? [team.toUpperCase()] : undefined };
    const markets = market === "all" ? undefined : [market];
    return floor ? answerFloorPicks(data, 300, f, { threshold, window: win, markets }) : answerHitRates(data, 300, f, { threshold, window: win, side, markets });
  }, [data, threshold, win, side, market, pos, team, floor]);
  // The answer lists the best model chance first; the other sorts re-rank the same picks.
  const hitRate = (p: Pick) => {
    const rec = (p.recent ?? []).slice(0, win);
    return rec.length && p.line != null ? rec.filter((g) => (p.side === "over" ? g.value > p.line! : g.value < p.line!)).length / rec.length : 0;
  };
  const picks = a?.picks && sort !== "chance"
    ? [...a.picks].sort((x, y) => hitRate(y) - hitRate(x) || y.p - x.p)
    : a?.picks;
  return (
    <div className="space-y-5">
      <PageTitle kicker={`${season} · Week ${week}`} title="Hit rates" />
      <Segmented label="View" value={view} onChange={setView} options={[{ value: "book", label: "Book lines" }, { value: "floor", label: "Floor picks (X+)" }]} />
      {floor ? (
        <Notice tone="info" title="Posted lines he keeps clearing">
          The highest over line the books post (shown as &ldquo;X+&rdquo;), priced {FLOOR_SHORTEST_PRICE} or longer, that the model gives {Math.round(FLOOR_MIN_CHANCE * 100)}% or
          better and that he also cleared in your chosen share of recent games. Only lines the books post are listed.
        </Notice>
      ) : (
        <Notice tone="info" title="Find lines a player keeps clearing">
          Pick a hit rate and a stretch of games. Only props the sportsbooks are actually posting this week are listed, at their posted line, with this week's
          model chance beside it. If a player has no posted line, he is left out. A perfect recent record is not a sure thing, so lean on the model's chance and its tier.
        </Notice>
      )}
      <Card>
        <CardHeader icon={<Percent className="h-4 w-4 text-accent" />} title={a?.title ?? "Hit rates"} subtitle={a?.picks ? `${a.picks.length} props, ${sort === "chance" ? "best hit chance first" : "best recent hit rate first"}` : undefined} />
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 sm:px-5">
          <Segmented size="sm" label="Hit rate" value={threshold} onChange={setThreshold} options={[1, 0.9, 0.8, 0.7].map((x) => ({ value: x, label: `${Math.round(x * 100)}%` }))} />
          <Segmented size="sm" label="Games" value={win} onChange={setWin} options={[5, 8, 16].map((x) => ({ value: x, label: `Last ${x}` }))} />
          {!floor && <Segmented size="sm" label="Side" value={side} onChange={setSide} options={[{ value: "over", label: "Overs" }, { value: "under", label: "Unders" }]} />}
          <Select aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)} className="h-8 w-44 text-xs">
            <option value="all">All markets</option>
            {Object.entries(data?.props ?? {}).map(([m, v]) => <option key={m} value={m}>{v.label}</option>)}
          </Select>
          <Segmented size="sm" label="Position" value={pos} onChange={setPos} options={POSITIONS.map((x) => ({ value: x, label: x }))} />
          <Select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as "chance" | "hits")} className="h-8 w-44 text-xs">
            <option value="chance">Sort: best hit chance</option><option value="hits">Sort: recent hit rate</option></Select>
          <Input aria-label="Team" placeholder="Team (e.g. DET)" value={team} onChange={(e) => setTeam(e.target.value.slice(0, 3))} className="h-8 w-32 text-xs" />
        </div>
        {!data ? <LoadingBlock rows={6} className="p-5" /> : picks?.length ? <PickList picks={picks} suffix={suffix} />
          : <CardBody className="text-sm text-muted">{a?.summary ?? "Nothing matches."}</CardBody>}
      </Card>
    </div>
  );
}
