/* A player's props this week, every validated market on one card: line, projection, lean out of 10, tier, recent hit
   rates at that line and, on tap, the full ladder of playable lines. Same numbers as the Player props page. */
import * as React from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import { estimatedLine, underReasons, overReasons, type PropRow } from "@/lib/ask";
import { tierFor, useConfidence } from "@/lib/confidence";
import { feedLine, type Feed } from "@/lib/feed";
import { cn, num, pct } from "@/lib/format";
import { playable } from "@/lib/hitrates";
import { pOver } from "@/lib/props";
import { TierBadge } from "@/components/shared";
import { Card, CardBody, CardHeader, TableWrap, Td, Th } from "@/components/ui";
import { LineLadder, Outlook } from "@/pages/Props";

type MarketMeta = { market: string; label: string; validated: boolean };

/** His validated markets this week with the line in play (book line, else his usual or projected line), strongest lean first. */
export function usePlayerPropRows(playerId: string, season: number, week: number, feed: Feed) {
  const markets = useQuery({ queryKey: ["props-markets"], queryFn: () => api.get<{ markets: MarketMeta[] }>("/props/markets") });
  const validated = (markets.data?.markets ?? []).filter((m) => m.validated);
  const props = useQueries({ queries: validated.map((m) => ({ queryKey: ["props", season, week, m.market],
    queryFn: () => api.get<{ rows: PropRow[] }>("/props", { season, week, market: m.market }) })) });
  const rows = validated.flatMap((m, i) => {
    const r = props[i]?.data?.rows.find((x) => x.player_id === playerId && x.dist);
    if (!r) return [];
    const book = feedLine(feed, m.market, playerId);
    const est = estimatedLine(r, m.market);
    const line = book ?? est.line;
    const over = pOver(r.dist!, line);
    const lean = over >= 0.5 ? "over" as const : "under" as const;
    const leanP = Math.max(over, 1 - over);
    const rec = (r.recent ?? []).slice(0, 8);
    const hits = rec.filter((g) => (lean === "over" ? g.value > line : g.value < line)).length;
    const reasons = (lean === "under" ? underReasons : overReasons)(r, m.market, m.label, line);
    return [{ m, r, line, source: book != null ? "book" : est.kind, over, lean, leanP, hits, games: rec.length, reasons }];
  }).sort((a, b) => b.leanP - a.leanP);
  return { rows, loading: markets.isLoading || props.some((p) => p.isLoading) };
}

export function PlayerProps({ playerId, season, week, feed }: { playerId: string; season: number; week: number; feed: Feed }) {
  const conf = useConfidence();
  const [open, setOpen] = React.useState<string | null>(null);
  const { rows, loading } = usePlayerPropRows(playerId, season, week, feed);
  if (loading) return null;
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader title={`Props this week`} subtitle="Every validated market: the line, our projection, which side we lean and how strongly (out of 10), and how often he cleared it lately. Tap a row for every line." />
      <TableWrap>
        <table className="w-full"><thead><tr><Th>Market</Th><Th className="text-right">Line</Th><Th className="text-right">Proj.</Th><Th>Lean</Th>
          <Th className="text-right">Under · Over</Th><Th className="text-right">Last 8 at line</Th><Th /></tr></thead>
          <tbody>{rows.map((x) => (
            <React.Fragment key={x.m.market}>
              <tr className="cursor-pointer border-b border-line/60 hover:bg-raised/40" onClick={() => setOpen(open === x.m.market ? null : x.m.market)}>
                <Td className="font-medium">{x.m.label}</Td>
                <Td className="text-right">{x.line}<div className="text-[10px] text-muted">{x.source === "book" ? "book line" : x.source === "projected" ? "projected line" : "usual line"}</div></Td>
                <Td className="text-right">{num(x.r.median, 1)}</Td>
                <Td><span className="mr-1.5 font-semibold">{x.lean === "over" ? "Over" : "Under"}</span><TierBadge compact tier={tierFor(conf.data, "props", x.leanP)} /></Td>
                <Td className="whitespace-nowrap text-right"><span className={cn(x.lean === "under" && "font-semibold text-accent")}>{num((1 - x.over) * 10, 1)}</span>
                  <span className="text-muted"> · </span><span className={cn(x.lean === "over" && "font-semibold text-accent")}>{num(x.over * 10, 1)}</span></Td>
                <Td className="text-right">{x.games ? `${x.hits}/${x.games} (${pct(x.hits / x.games, 0)})` : "—"}</Td>
                <Td><ChevronDown className={cn("h-4 w-4 text-muted transition", open === x.m.market && "rotate-180")} /></Td>
              </tr>
              {open === x.m.market && (
                <tr className="border-b border-line bg-raised/30"><td colSpan={7} className="px-4 py-3">
                  <div className="sticky left-4 max-w-[calc(100vw-5rem)] sm:max-w-none">
                    <Outlook r={x.r as never} digits={1} />
                    {!!x.reasons.length && <ul className="mb-3 list-disc space-y-0.5 pl-5 text-sm text-muted">{x.reasons.map((t) => <li key={t}>{t}</li>)}</ul>}
                    <LineLadder r={x.r as never} line={x.line} pl={playable(feed, x.m.market, x.r)} />
                    {!!x.r.recent?.length && <p className="text-xs text-muted">Last {x.r.recent.length} games, newest first: {x.r.recent.map((g) => `${num(g.value, 0)} vs ${g.opponent}`).join(", ")}</p>}
                  </div>
                </td></tr>)}
            </React.Fragment>))}</tbody></table>
      </TableWrap>
      <CardBody className="pt-2 text-xs text-muted">Lines are the main book line once prices load (Saturday); before that, his usual line, or this week's projection when his recent games came in a different role.</CardBody>
    </Card>
  );
}
