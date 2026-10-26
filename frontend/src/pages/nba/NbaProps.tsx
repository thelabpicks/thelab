import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Search } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import {
  NBA_MARKETS, bestOffer, bookName, edgeOf, fmtPrice, leanOf, marketLabel, nbaReasons, nbaTier, useNba,
  type MarketReport, type NbaConfidence, type NbaRow, type Slate,
} from "@/lib/nba";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, Input, LoadingBlock, Segmented, Select, TableWrap, Td, TeamBadge, Th } from "@/components/ui";
import { TierBadge } from "@/components/shared";
import { Headshot, NbaSignals, NotPublished, ScoreSplit } from "./shared";

const LINES_KEY = "fg-nba-lines-v1";
type Show = "all" | "under" | "over";
function loadLines(): Record<string, string> { try { return JSON.parse(localStorage.getItem(LINES_KEY) || "{}"); } catch { return {}; } }

export default function NbaProps() {
  const [sp, setSp] = useSearchParams();
  const market = sp.get("market") || "points";
  const [search, setSearch] = React.useState("");
  const [show, setShow] = React.useState<Show>("all");
  const [open, setOpen] = React.useState<string | null>(null);
  const [lines, setLines] = React.useState<Record<string, string>>(loadLines);
  React.useEffect(() => { try { localStorage.setItem(LINES_KEY, JSON.stringify(lines)); } catch { /* storage unavailable */ } }, [lines]);
  const slate = useNba<Slate>("slate.json");
  const priced = !!slate.data?.odds.props_priced;
  const markets = useNba<{ markets: MarketReport[] }>("markets.json");
  const conf = useNba<NbaConfidence>("confidence.json");
  const m = markets.data?.markets.find((x) => x.market === market);
  const key = (r: NbaRow) => `${slate.data?.date}-${market}-${r.player_id}`;

  const view = (slate.data?.rows ?? []).filter((r) => r.market === market && (!search || r.player_name.toLowerCase().includes(search.toLowerCase())))
    .map((r) => {
      const typed = lines[key(r)];
      const line = typed ? Number(typed) : r.line;
      const lean = Number.isFinite(line) ? leanOf(r, line) : null;
      const edge = line === r.line ? edgeOf(r, lean) : null;
      const offer = lean && line === r.line ? bestOffer(r, lean.side) : null;
      return { r, typed, line, lean, edge, offer, tier: nbaTier(conf.data, lean?.p) };
    })
    .filter((v) => show === "all" || v.lean?.side === show)
    .sort((a, b) => Number(a.r.out) - Number(b.r.out) || (b.lean?.p ?? -1) - (a.lean?.p ?? -1));

  if (slate.isError) return <NotPublished error={slate.error} />;
  return (
    <div className="space-y-5">
      <PageTitle kicker={slate.data?.date ? `NBA · ${new Date(slate.data.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}` : "NBA"} title="Player props">
        <Select aria-label="Market" value={market} onChange={(e) => { const n = new URLSearchParams(sp); n.set("market", e.target.value); setSp(n, { replace: true }); setOpen(null); }} className="w-48">
          {NBA_MARKETS.map((x) => {
            const mm = markets.data?.markets.find((y) => y.market === x.market);
            return <option key={x.market} value={x.market}>{x.label}{mm ? (mm.validated ? " ✓" : " (research)") : ""}</option>;
          })}
        </Select>
      </PageTitle>

      {m && (
        <Card className={m.validated ? "border-accent/30" : "border-warn/40"}>
          <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{m.label}</span>
              {m.validated ? <Badge tone="accent">Validated</Badge> : <Badge tone="warn">Research only</Badge>}
            </div>
            <div><span className="text-muted">Strong leans (6.0+) hit </span><b>{pct(m.lean_hit_rate, 0)}</b><span className="text-muted"> of {m.lean_n.toLocaleString()} unseen games</span></div>
            <div><span className="text-muted">Typical miss </span><b>{num(m.mae, 1)}</b><span className="text-muted"> vs {num(m.baseline_mae, 1)} for his average</span></div>
            {!m.validated && <div className="text-muted">Over/under scores stay hidden until it passes every check.</div>}
          </CardBody>
        </Card>
      )}

      {slate.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {slate.data && (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-3 sm:p-4">
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
              <Input aria-label="Search players" placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>
            <Segmented size="sm" label="Show" value={show} onChange={setShow}
              options={[{ value: "all", label: "All" }, { value: "under", label: "Unders" }, { value: "over", label: "Overs" }]} />
            <span className="text-sm text-muted">{view.length} players · strongest first · {slate.data.odds.props_priced ? "book lines" : "usual lines (book prop lines need a paid odds plan)"}</span>
          </div>
          <TableWrap>
            <table className="w-full">
              <thead><tr>
                <Th>Player</Th><Th>Opp</Th><Th className="text-right">Proj</Th><Th className="text-right" title="80% of outcomes should land here">Range</Th>
                <Th title={priced ? "Book line; type any line to rescore" : "His usual line (median of his last 10 games); type any line to rescore"}>Line</Th>
                <Th title="Under and over out of 10; they add to 10">Under · Over</Th><Th>Lean</Th>{priced && <Th>Best price</Th>}<Th />
              </tr></thead>
              <tbody>
                {view.map(({ r, typed, line, lean, edge, offer, tier }) => (
                  <React.Fragment key={r.player_id}>
                    <tr className={cn("border-b border-line/60 hover:bg-raised/50", r.out && "opacity-50")}>
                      <Td className="w-[1%]">
                        <div className="flex w-[220px] items-center gap-2">
                          <Headshot src={r.headshot} name={r.player_name} />
                          <TeamBadge team={r.team} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1">
                              <Link to={`/nba/players/${r.player_id}`} className="truncate font-medium underline decoration-muted/60 decoration-dotted underline-offset-4 hover:text-accent">{r.player_name}</Link>
                              <NbaSignals edge={edge} due={r.due} />
                            </div>
                            {/* the full injury note is in the row's details; here it stays on one line so the column keeps its width */}
                            {r.injury && <div title={r.injury_note ?? undefined} className={cn("truncate text-[11px]", r.out ? "text-danger" : "text-warn")}>{r.injury}{r.injury_note ? ` · ${r.injury_note}` : ""}</div>}
                          </div>
                        </div>
                      </Td>
                      <Td className="text-muted">{r.home ? "vs" : "@"} {r.opp}</Td>
                      <Td className="text-right font-semibold">{num(r.mean, 1)}</Td>
                      <Td className="text-right text-muted">{num(r.q10, 0)}–{num(r.q90, 0)}</Td>
                      <Td>
                        <Input aria-label={`Line for ${r.player_name}`} inputMode="decimal" placeholder={String(r.line)} value={typed ?? ""}
                          onChange={(e) => setLines({ ...lines, [key(r)]: e.target.value })} className="h-8 w-20" />
                      </Td>
                      <Td>{lean ? <ScoreSplit over={lean.over} /> : <span className="text-xs text-muted">hidden</span>}</Td>
                      <Td>{lean ? <div className="flex items-center gap-1.5 whitespace-nowrap"><span className="font-semibold">{lean.side === "under" ? "Under" : "Over"} {line}</span>{!r.out && <TierBadge tier={tier} compact />}</div> : <span className="text-muted">—</span>}</Td>
                      {priced && <Td className="whitespace-nowrap">{offer ? <span>{fmtPrice(offer.price)} <span className="text-xs text-muted">{bookName(offer.book)}</span></span> : <span className="text-muted">—</span>}</Td>}
                      <Td><button aria-expanded={open === r.player_id} aria-label="Show why" onClick={() => setOpen(open === r.player_id ? null : r.player_id)} className="rounded p-1 text-muted hover:bg-raised">
                        <ChevronDown className={cn("h-4 w-4 transition", open === r.player_id && "rotate-180")} /></button></Td>
                    </tr>
                    {open === r.player_id && (
                      <tr className="border-b border-line bg-raised/30"><td colSpan={priced ? 9 : 8} className="whitespace-normal px-4 py-3 text-sm">
                        {r.injury && <p className={cn("mb-2", r.out ? "text-danger" : "text-warn")}>{r.injury}{r.injury_note ? `: ${r.injury_note}` : ""}</p>}
                        {lean && (<>
                          <div className="font-semibold">Why it leans {lean.side} {line}</div>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">{nbaReasons({ ...r, line }, lean).map((t) => <li key={t}>{t}</li>)}</ul>
                        </>)}
                        {!!r.recent.length && <p className="mt-2 text-xs text-muted">Last {r.recent.length} games, newest first: {r.recent.map((v, i) => `${num(v, 0)} (${num(r.recent_minutes[i], 0)} min)`).join(", ")}</p>}
                        <p className="mt-1 text-xs text-muted">{marketLabel(market)} chances come from games before today only. Typed lines are saved in this browser.</p>
                      </td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}
