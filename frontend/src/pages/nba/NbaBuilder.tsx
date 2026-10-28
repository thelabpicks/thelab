import * as React from "react";
import { Link } from "react-router-dom";
import { Dices, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { cn, num, pct } from "@/lib/format";
import { NBA_MARKETS, bestOffer, fmtPrice, leanOf, marketLabel, onDraftKings, overAt, starsOf, suggestable, useNba, type NbaCorrelation, type NbaRow, type Slate } from "@/lib/nba";
import { simulate, toAmerican, toDecimal, type SimLeg } from "@/lib/sim";
import { PageTitle } from "@/components/Layout";
import { Button, Card, CardBody, CardHeader, Input, LoadingBlock, Notice, Select, TeamBadge } from "@/components/ui";
import { NotPublished } from "./shared";

const SLIP_KEY = "fg-nba-slip-v1";
type SlipItem = { player_id: string; market: string; side: "over" | "under"; line: number };
type Leg = SimLeg & { name: string; label: string; line: number; row: NbaRow };

function loadSlip(): { date?: string; items: SlipItem[] } { try { return JSON.parse(localStorage.getItem(SLIP_KEY) || "") ?? { items: [] }; } catch { return { items: [] }; } }

function toLeg(r: NbaRow, side: "over" | "under", line: number): Leg | null {
  const over = overAt(r, line);
  if (over == null) return null;
  return { id: `${r.market}:${r.player_id}`, market: r.market, player_id: r.player_id, team: r.team, position: r.pos, game_id: String(r.game_id),
    p: side === "over" ? over : 1 - over, side, name: r.player_name, label: marketLabel(r.market), line, row: r };
}

export default function NbaBuilder() {
  const slate = useNba<Slate>("slate.json");
  const cor = useNba<NbaCorrelation>("correlation.json");
  const [slip, setSlip] = React.useState(loadSlip);
  const [search, setSearch] = React.useState("");
  const [market, setMarket] = React.useState("points");
  const [odds, setOdds] = React.useState("");
  const [note, setNote] = React.useState<string | null>(null);
  const date = slate.data?.date ?? undefined;
  // A slip from an earlier slate is cleared: its games are over.
  const items = slip.date === date ? slip.items : [];
  React.useEffect(() => { try { localStorage.setItem(SLIP_KEY, JSON.stringify({ date, items })); } catch { /* storage unavailable */ } }, [date, items]);
  const rows = slate.data?.rows ?? [];
  const find = (i: SlipItem) => rows.find((r) => r.player_id === i.player_id && r.market === i.market);
  const legs = items.map((i) => { const r = find(i); return r ? toLeg(r, i.side, i.line) : null; }).filter((l): l is Leg => !!l);
  const use = !!cor.data?.use_correlation;
  const sim = React.useMemo(() => simulate(legs, cor.data?.buckets ?? {}, use), [JSON.stringify(items), cor.data, date]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: SlipItem[]) => setSlip({ date, items: next });
  const add = (r: NbaRow, side: "over" | "under") => set([...items.filter((i) => !(i.player_id === r.player_id && i.market === r.market)), { player_id: r.player_id, market: r.market, side, line: r.line }]);
  const dec = toDecimal(odds);

  // Stars at lines DraftKings posts, as everywhere the site suggests picks (nba.ts suggestable); a search still finds anyone.
  const stars = React.useMemo(() => starsOf(rows), [rows]);
  const choices = rows.filter((r) => r.market === market && !r.out && r.dist
    && (search ? r.player_name.toLowerCase().includes(search.toLowerCase()) : suggestable(r, stars)))
    .map((r) => ({ r, lean: leanOf(r)! })).sort((a, b) => b.lean.p - a.lean.p).slice(0, search ? 30 : 12);

  const suggest = (n: number) => {
    const pool = rows.filter((r) => r.dist && suggestable(r, stars)).map((r) => ({ r, lean: leanOf(r)! }))
      .filter((x) => x.lean.p >= 0.6).sort((a, b) => b.lean.p - a.lean.p);
    const used = new Set<number>(); const pick: SlipItem[] = [];
    for (const x of pool) {
      if (used.has(x.r.game_id)) continue;
      used.add(x.r.game_id); pick.push({ player_id: x.r.player_id, market: x.r.market, side: x.lean.side, line: x.r.line });
      if (pick.length === n) break;
    }
    // never swap the slip for fewer legs than asked: say why instead
    if (pick.length < n) { setNote(`Not enough stars with a DraftKings line and a 6.0+ lean in different games today for a ${n}-leg parlay.`); return; }
    setNote(null);
    set(pick);
  };

  if (slate.isError) return <NotPublished error={slate.error} />;
  if (!slate.data) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  return (
    <div className="space-y-5">
      <PageTitle kicker="NBA" title="Parlay builder">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => suggest(2)}><Sparkles className="h-4 w-4" />Best 2-leg</Button>
          <Button variant="outline" size="sm" onClick={() => suggest(3)}><Sparkles className="h-4 w-4" />Best 3-leg</Button>
        </div>
      </PageTitle>
      {note && <Notice tone="info">{note}</Notice>}
      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Add legs" subtitle={search ? "Every player matching your search; tap a side to add it" : "Stars at DraftKings lines, strongest leans first; search to add anyone"} />
          <div className="flex flex-wrap gap-2 border-b border-line p-3">
            <Select aria-label="Market" value={market} onChange={(e) => setMarket(e.target.value)} className="w-44">
              {NBA_MARKETS.map((m) => <option key={m.market} value={m.market}>{m.label}</option>)}
            </Select>
            <div className="relative min-w-[180px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
              <Input placeholder="Search players" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label="Search players" />
            </div>
          </div>
          <div className="divide-y divide-line/60">
            {choices.map(({ r, lean }) => (
              <div key={r.player_id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <TeamBadge team={r.team} />
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{r.player_name}</div><div className="text-xs text-muted">{r.home ? "vs" : "@"} {r.opp} · proj {num(r.mean, 1)}{onDraftKings(r) ? "" : " · no DraftKings line"}</div></div>
                {(["over", "under"] as const).map((s) => {
                  const p = s === "over" ? lean.over : 1 - lean.over;
                  return (
                    <button key={s} onClick={() => add(r, s)} className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                      lean.side === s ? "border-accent/40 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg")}>
                      <Plus className="h-3 w-3" />{s === "over" ? "O" : "U"} {r.line} · {(p * 10).toFixed(1)}
                    </button>
                  );
                })}
              </div>
            ))}
            {!choices.length && <p className="p-4 text-sm text-muted">{search ? "No validated players match." : slate.data.odds.props_priced
              ? "No star has a DraftKings line in this market today. Try another market or search for a player."
              : "Star legs appear once DraftKings posts player props, about 10 AM Eastern. Search to add a player now."}</p>}
          </div>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader title={`Your slip (${legs.length})`} icon={<Dices className="h-4 w-4" />} />
            <div className="divide-y divide-line/60">
              {legs.map((l, i) => {
                const offer = bestOffer(l.row, l.side as "over" | "under", l.line);
                const dk = l.row.offers.find((o) => o.book === "draftkings" && o.side === l.side && o.line === l.line);
                return (
                  <div key={l.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <Link to={`/nba/players/${l.player_id}`} className="font-medium hover:text-accent">{l.name}</Link>
                      <div className="text-xs text-muted">{l.side === "over" ? "Over" : "Under"} {l.line} {l.label}{dk ? ` · DraftKings ${fmtPrice(dk.price)}` : offer ? ` · ${fmtPrice(offer.price)}` : " · no book line"}</div>
                    </div>
                    <span className="tabular-nums">{pct(l.p, 0)}</span>
                    <button aria-label="Remove" onClick={() => set(items.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                  </div>
                );
              })}
              {!legs.length && <p className="p-4 text-sm text-muted">Add legs on the left or tap Best 3-leg.</p>}
            </div>
          </Card>
          {legs.length > 0 && (
            <Card><CardBody className="space-y-3 text-sm">
              <div className="flex items-end justify-between">
                <div><div className="label">Chance all hit</div><div className="font-display text-3xl font-semibold">{pct(sim.joint, 1)}</div></div>
                <div className="text-right text-xs text-muted">Fair odds {toAmerican(1 / Math.max(sim.joint, 1e-6))}<br />Multiplying: {pct(sim.independent, 1)}</div>
              </div>
              <p className="text-xs text-muted">{sim.draws.toLocaleString()} simulated games. {use ? "Legs in the same game move together the way they did in past games (checked on unseen months)." : "Legs are treated as independent: the same-game links did not beat that on unseen months."}</p>
              <div>
                <div className="label mb-1">Legs that hit</div>
                <div className="flex items-end gap-1">
                  {sim.hits.map((h, k) => (
                    <div key={k} className="flex flex-1 flex-col items-center gap-1">
                      <div className="w-full rounded-t bg-accent/70" style={{ height: `${Math.max(2, h * 80)}px` }} title={pct(h, 1)} />
                      <span className="text-[10px] text-muted">{k}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input value={odds} onChange={(e) => setOdds(e.target.value)} placeholder="Parlay price, e.g. +450" className="h-8" aria-label="Parlay price" />
                {dec && <span className={cn("whitespace-nowrap text-sm font-semibold", sim.joint * dec - 1 > 0 ? "text-accent" : "text-danger")}>
                  {sim.joint * dec - 1 > 0 ? "+" : ""}{num((sim.joint * dec - 1) * 100, 0)}% expected</span>}
              </div>
              <Button variant="outline" size="sm" onClick={() => set([])}>Clear slip</Button>
            </CardBody></Card>
          )}
          {!use && cor.data && <Notice tone="info">Same-game correlation is off for NBA until it passes its check.</Notice>}
        </div>
      </div>
    </div>
  );
}
