/* Previous weeks, the same page for every sport: each past game with what the model predicted in every market and a
   green check or red X for whether it hit, like the Top 10 results card. Each sport's page turns its own published
   results into PrevPeriod lists; nothing here is graded in the browser. */
import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { History } from "lucide-react";
import { cn, pct } from "@/lib/format";
import { Card, CardBody, CardHeader, EmptyState, Select, Segmented, Switch } from "@/components/ui";

export type PrevResult = "won" | "lost" | "push" | "void" | null;
export type PrevPick = {
  key: string; market: string; bet: string; result: PrevResult;
  /** Heading of the pick's box in the boxes layout ("Spread", "Over/under"). */
  box?: string;
  /** What the model said beyond the side: its projection, chance, rating. */
  detail?: string; chance?: number; actual?: string; extra?: React.ReactNode;
  /** The sport's own "best" mark (rated 7+, featured) for the Only-best switch. */
  strong?: boolean;
  /** Left out unless the viewer asks (lines no book would post). */
  hidden?: boolean;
};
export type PrevGame = { id: string; title: string; when?: string; score?: string; sub?: string; picks: PrevPick[] };
export type PrevPeriod = { key: string; label: string; games: PrevGame[] };

type Show = "all" | "won" | "lost";
type Tally = { won: number; lost: number; push: number; n: number; rate: number | null };

export function tally(ps: PrevPick[]): Tally {
  const won = ps.filter((p) => p.result === "won").length;
  const lost = ps.filter((p) => p.result === "lost").length;
  const push = ps.filter((p) => p.result === "push").length;
  return { won, lost, push, n: won + lost, rate: won + lost ? won / (won + lost) : null };
}
export const recText = (t: Tally) => (t.n || t.push ? `${t.won}-${t.lost}${t.push ? `-${t.push}` : ""}` : "–");

/** A big hit / miss mark: the same one the Top 10 results card uses. */
export function ResultMark({ r }: { r: PrevResult }) {
  const [txt, cls] = r === "won" ? ["✓", "bg-ok/15 text-ok"] : r === "lost" ? ["✗", "bg-danger/15 text-danger"]
    : r === "push" ? ["P", "bg-raised text-muted"] : r === "void" ? ["–", "bg-raised text-muted"] : ["…", "bg-raised text-muted"];
  const label = r ? { won: "Hit", lost: "Miss", push: "Push", void: "Void (did not play)" }[r] : "Pending";
  return <span title={label} aria-label={label} className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", cls)}>{txt}</span>;
}

const ALL = "__all";

export function PreviousWeeks({ periods, markets, note, layout, noun = "week", strongLabel, hiddenLabel, chanceSteps, perGame = 8 }: {
  periods: PrevPeriod[]; markets: { market: string; label: string }[]; note?: React.ReactNode;
  /** boxes: one labeled box per market inside each game (game lines). list: one row per pick (player props). */
  layout: "boxes" | "list"; noun?: "week" | "day"; strongLabel?: string; hiddenLabel?: string; chanceSteps?: number[]; perGame?: number;
}) {
  // the week (or day) lives in the address (?p=), so the header's week picker can open this page on it
  const [params, setParams] = useSearchParams();
  const asked = params.get("p");
  const period = asked === ALL || periods.some((p) => p.key === asked) ? asked! : periods[0]?.key ?? ALL;
  const setPeriod = (k: string) => setParams((q) => { q.set("p", k); return q; }, { replace: true });
  const [market, setMarket] = React.useState(ALL);
  const [show, setShow] = React.useState<Show>("all");
  const [strong, setStrong] = React.useState(false);
  const [withHidden, setWithHidden] = React.useState(false);
  const [minChance, setMinChance] = React.useState(0);

  if (!periods.length) return <Card><EmptyState icon={<History className="h-5 w-5" />} title="No finished games yet">{note}</EmptyState></Card>;

  // what counts toward the records: every filter but hit / miss (that one only trims the list)
  const counts = (p: PrevPick) => (withHidden || !p.hidden) && (!strong || p.strong) && (p.chance == null || p.chance >= minChance);
  const inPeriod = period === ALL ? periods : periods.filter((p) => p.key === period);
  const picksOf = (ps: PrevPeriod[]) => ps.flatMap((p) => p.games.flatMap((g) => g.picks)).filter(counts);
  const shown = picksOf(inPeriod);
  const season = picksOf(periods);
  const total = tally(market === ALL ? shown : shown.filter((p) => p.market === market));
  const keep = (p: PrevPick) => counts(p) && (market === ALL || p.market === market) && (show === "all" || p.result === show);
  const nounCap = noun === "day" ? "Day" : "Week";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<History className="h-4 w-4 text-accent" />} title={`How the model did${period === ALL ? `, every ${noun}` : `, ${inPeriod[0]?.label}`}`}
          subtitle={note} />
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="prev-period">{nounCap}</label>
            <Select id="prev-period" value={period} onChange={(e) => setPeriod(e.target.value)} className="h-8 w-auto text-xs">
              {periods.map((p) => <option key={p.key} value={p.key}>{p.label} · {recText(tally(picksOf([p])))}</option>)}
              <option value={ALL}>Every {noun} · {recText(tally(season))}</option>
            </Select>
            <label className="sr-only" htmlFor="prev-market">Bet type</label>
            <Select id="prev-market" value={market} onChange={(e) => setMarket(e.target.value)} className="h-8 w-auto text-xs">
              <option value={ALL}>Every bet type</option>
              {markets.map((m) => <option key={m.market} value={m.market}>{m.label}</option>)}
            </Select>
            <Segmented size="sm" label="Show" value={show} onChange={setShow}
              options={[{ value: "all", label: "All" }, { value: "won", label: "✓ Hits" }, { value: "lost", label: "✗ Misses" }]} />
            {chanceSteps && (
              <Segmented size="sm" label="Model's chance" value={minChance} onChange={setMinChance}
                options={chanceSteps.map((c) => ({ value: c, label: c ? `${Math.round(c * 100)}%+` : "Any chance" }))} />
            )}
          </div>
          {(strongLabel || hiddenLabel) && (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {strongLabel && <Switch id="prev-strong" checked={strong} onChange={setStrong} label={strongLabel} />}
              {hiddenLabel && <Switch id="prev-hidden" checked={withHidden} onChange={setWithHidden} label={hiddenLabel} />}
            </div>
          )}
          <div className="font-display text-xl font-bold">
            {recText(total)}{total.rate != null && <span className="ml-1.5 text-sm font-semibold text-muted">{pct(total.rate, 1)}</span>}
            <span className="ml-2 text-xs font-normal text-muted">{market === ALL ? "every bet type" : markets.find((m) => m.market === market)?.label}</span>
          </div>
        </CardBody>
        {/* one box per bet type: this period's record, the season's under it */}
        <div className="grid grid-cols-2 gap-2 border-t border-line p-3 sm:grid-cols-3 lg:grid-cols-5">
          {markets.map((m) => {
            const t = tally(shown.filter((p) => p.market === m.market));
            const s = tally(season.filter((p) => p.market === m.market));
            if (!t.n && !t.push && !s.n) return null;
            return (
              <button key={m.market} type="button" onClick={() => setMarket(market === m.market ? ALL : m.market)}
                className={cn("rounded-lg border px-3 py-2 text-left transition-colors", market === m.market ? "border-accent bg-accent/5" : "border-line bg-raised/30 hover:bg-raised/60")}>
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{m.label}</div>
                <div className="text-[17px] font-bold tabular-nums">{recText(t)}{t.rate != null && <span className="ml-1 text-xs font-semibold text-muted">{pct(t.rate, 0)}</span>}</div>
                {period !== ALL && <div className="text-[11px] text-muted">Every {noun}: {recText(s)}{s.rate != null ? ` · ${pct(s.rate, 0)}` : ""}</div>}
              </button>
            );
          })}
        </div>
      </Card>

      {inPeriod.map((p) => {
        const games = p.games.map((g) => ({ g, picks: g.picks.filter(keep) })).filter((x) => x.picks.length);
        return (
          <Card key={p.key}>
            <div className="flex items-center justify-between bg-raised/40 px-4 py-2 text-sm font-semibold sm:px-5">
              <span>{p.label}</span><span className="text-xs text-muted">{recText(tally(picksOf([p])))} · {p.games.length} games</span>
            </div>
            {!games.length && <CardBody className="text-sm text-muted">Nothing matches these filters.</CardBody>}
            <div className="divide-y divide-line">
              {games.map(({ g, picks }) => <GameBlock key={g.id} g={g} picks={picks} layout={layout} perGame={perGame} />)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function GameBlock({ g, picks, layout, perGame }: { g: PrevGame; picks: PrevPick[]; layout: "boxes" | "list"; perGame: number }) {
  const [all, setAll] = React.useState(false);
  const t = tally(picks);
  const rows = layout === "list" && !all ? picks.slice(0, perGame) : picks;
  return (
    <div className="space-y-2.5 px-4 py-3.5 text-sm sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <div className="font-semibold">{g.title}</div>
        <div className="text-xs text-muted">{g.when ? `${g.when} · ` : ""}{recText(t)}</div>
      </div>
      {(g.score || g.sub) && (
        <div className="text-xs text-muted">{g.score && <>Final: <span className="font-medium text-fg">{g.score}</span></>}{g.score && g.sub ? " · " : ""}{g.sub}</div>
      )}
      {layout === "boxes" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {picks.map((p) => (
            <div key={p.key} className={cn("rounded-lg border px-3 py-2", p.result === "won" ? "border-ok/50 bg-ok/5" : p.result === "lost" ? "border-danger/40 bg-danger/5" : "border-line bg-raised/30")}>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{p.box ?? p.market}</div>
              <div className="mt-1 flex items-center gap-2.5">
                <ResultMark r={p.result} />
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold leading-snug">{p.bet}</div>
                  {p.detail && <div className="text-xs text-muted">{p.detail}</div>}
                  {p.actual && <div className="text-xs">{p.actual}</div>}
                </div>
              </div>
              {p.extra && <div className="mt-1.5">{p.extra}</div>}
            </div>
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-line/60 rounded-lg border border-line">
          {rows.map((p) => (
            <li key={p.key} className="flex items-center gap-3 px-3 py-2">
              <ResultMark r={p.result} />
              <div className="min-w-0 flex-1">
                <div className="font-medium leading-snug">{p.bet}</div>
                {p.detail && <div className="truncate text-xs text-muted">{p.detail}</div>}
              </div>
              {p.actual && <span className="shrink-0 text-right text-xs tabular-nums">{p.actual}</span>}
            </li>
          ))}
          {picks.length > rows.length && (
            <li><button type="button" onClick={() => setAll(true)} className="w-full px-3 py-2 text-left text-xs font-medium text-accent hover:bg-raised/40">
              Show all {picks.length} picks</button></li>
          )}
        </ul>
      )}
    </div>
  );
}
