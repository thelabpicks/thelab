import * as React from "react";
import { Link } from "react-router-dom";
import { Plus, Sparkles, X } from "lucide-react";
import { cn, pct } from "@/lib/format";
import { MARKET_LABEL, bookName, fmtPrice, kick, useCfb, type CfbMarket, type Props, type Sims, type Week } from "@/lib/cfb";
import { americanOf, lineLegs, priceParlay, propLegs, suggest, type Leg } from "@/lib/cfbParlay";
import { PageTitle } from "@/components/Layout";
import { Badge, Button, Card, CardBody, CardHeader, Input, LoadingBlock, Notice, Segmented, Stat } from "@/components/ui";
import { NotPublished, RatingMeter, roiText } from "./shared";

const KINDS = [{ value: "all", label: "All" }, { value: "spread", label: "Spreads" }, { value: "total", label: "Totals" },
  { value: "team_total", label: "Team totals" }, { value: "moneyline", label: "Moneylines" }, { value: "prop", label: "Props" }];

export default function CfbParlay() {
  const week = useCfb<Week>("week.json");
  const props = useCfb<Props>("props.json");
  const sims = useCfb<Sims>("sims.json");
  const [kind, setKind] = React.useState("all");
  const [min, setMin] = React.useState<"0" | "5" | "7">("5");
  const [find, setFind] = React.useState("");
  const [slip, setSlip] = React.useState<string[]>([]);
  const games = week.data?.games ?? [];
  const legs = React.useMemo(() => [...lineLegs(games), ...propLegs(props.data?.rows ?? [], games)], [games, props.data]);
  const byId = React.useMemo(() => new Map(legs.map((l) => [l.id, l])), [legs]);
  if (week.isError) return <NotPublished error={week.error} />;
  if (!week.data) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;

  const chosen = slip.map((id) => byId.get(id)).filter((l): l is Leg => !!l);
  const priced = chosen.length ? priceParlay(chosen, sims.data) : null;
  const kicks = new Map(games.map((g) => [g.game_id, g.date]));
  const shown = legs
    .filter((l) => kind === "all" || (kind === "prop" ? l.kind === "prop" : l.market === kind))
    .filter((l) => l.score >= Number(min))
    .filter((l) => !find || `${l.label} ${l.sub}`.toLowerCase().includes(find.toLowerCase()))
    .sort((a, b) => b.score - a.score);
  const toggle = (id: string) => setSlip((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const nProps = legs.filter((l) => l.kind === "prop").length;

  return (
    <div className="space-y-5">
      <PageTitle kicker="College football" title="Parlay builder" />
      <Notice title="How legs are scored">
        Each leg shows its Lab rating out of 10: the 5,000-game simulation, checked against how similar leans really did, at the best price on offer.
        Green (7+) is the band that beat the books in testing. Legs from the same game are priced together from that game's simulations.
        {" "}Every extra leg multiplies the books' cut, so a parlay of good legs is still a long shot.
      </Notice>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" onClick={() => setSlip(suggest(legs, 2).map((l) => l.id))}><Sparkles className="h-3.5 w-3.5" />Best 2-leg</Button>
        <Button size="sm" variant="outline" onClick={() => setSlip(suggest(legs, 3).map((l) => l.id))}>Best 3-leg</Button>
        <Button size="sm" variant="outline" onClick={() => setSlip(suggest(legs, 4).map((l) => l.id))}>Best 4-leg</Button>
        {!!slip.length && <Button size="sm" variant="ghost" onClick={() => setSlip([])}>Clear</Button>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <Card className="min-w-0">
          <CardHeader title="Legs" subtitle={`${legs.length} legs this week: the side the model likes in every market with a posted line${nProps ? `, plus ${nProps} player props at book lines` : ". No book has posted player props for these games yet"}.`} />
          <div className="space-y-2 border-b border-line p-3">
            <div className="overflow-x-auto"><Segmented size="sm" label="Market" value={kind} onChange={setKind} options={KINDS} /></div>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented size="sm" label="Minimum rating" value={min} onChange={setMin} options={[{ value: "0", label: "Any" }, { value: "5", label: "5+" }, { value: "7", label: "7+" }]} />
              <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a team or player" aria-label="Find a team or player" className="h-8 max-w-56" />
            </div>
          </div>
          <div className="divide-y divide-line/60">
            {shown.slice(0, 80).map((l) => {
              const on = slip.includes(l.id);
              return (
                <button key={l.id} type="button" onClick={() => toggle(l.id)} aria-pressed={on}
                  className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-raised/50", on && "bg-accent/10")}>
                  <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border", on ? "border-accent bg-accent text-accent-fg" : "border-line text-muted")}>
                    {on ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{l.label}</div>
                    <div className="truncate text-xs text-muted">
                      {l.kind === "prop" ? "Player prop" : MARKET_LABEL[l.market as CfbMarket]} · {fmtPrice(l.price)}{l.book ? ` ${bookName(l.book)}` : ""} · {l.sub}
                      {kicks.get(l.game_id) ? ` · ${kick(kicks.get(l.game_id)!)}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <RatingMeter size="sm" score={l.score} p={l.p} fair={l.fair} ev={l.ev ?? undefined} proven={l.proven} />
                    <div className="mt-0.5 text-[11px] text-muted">{pct(l.fair, 0)} to hit{l.proven ? "" : " · not proven"}</div>
                  </div>
                </button>
              );
            })}
            {!shown.length && <CardBody className="text-sm text-muted">No legs match. Lower the minimum rating or pick another market.</CardBody>}
          </div>
        </Card>

        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card>
            <CardHeader title={`Your parlay${chosen.length ? ` · ${chosen.length} leg${chosen.length > 1 ? "s" : ""}` : ""}`} />
            {!chosen.length && <CardBody className="text-sm text-muted">Tap legs to add them, or use Best 2-leg.</CardBody>}
            {!!chosen.length && priced && (
              <>
                <div className="divide-y divide-line/60">
                  {chosen.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{l.label}</div>
                        <div className="truncate text-xs text-muted">{fmtPrice(l.price)} · {l.sub}</div>
                      </div>
                      <RatingMeter size="sm" score={l.score} p={l.p} fair={l.fair} ev={l.ev ?? undefined} proven={l.proven} />
                      <button type="button" onClick={() => toggle(l.id)} className="text-muted hover:text-fg" aria-label={`Remove ${l.label}`}><X className="h-4 w-4" /></button>
                    </div>
                  ))}
                </div>
                <CardBody className="space-y-3 border-t border-line">
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="Chance all hit" value={pct(priced.chance, priced.chance < 0.1 ? 1 : 0)} sub={`fair odds ${americanOf(1 / Math.max(priced.chance, 1e-4))}`} />
                    <Stat label="Pays" value={americanOf(priced.decimal)} sub={`$10 returns $${(10 * priced.decimal).toFixed(2)}`} />
                  </div>
                  <EdgeBar ev={priced.ev} />
                  {chosen.length >= 3 && <p className="text-xs text-muted">Expected return compounds every leg's edge, and any error in it, so it grows fast with more legs.</p>}
                  {priced.groups.map((g) => (
                    <p key={g.game_id} className="text-xs text-muted">
                      Same game ({g.legs} legs): the simulations say these hit together {g.lift >= 1 ? `${((g.lift - 1) * 100).toFixed(0)}% more` : `${((1 - g.lift) * 100).toFixed(0)}% less`} often than if they were unrelated
                      {g.lift < 0.97 ? ", so they partly work against each other." : g.lift > 1.03 ? ". Books often price same-game parlays to take that away." : "."}
                    </p>
                  ))}
                  {chosen.some((l) => !l.proven) && <p className="text-xs text-warn">Includes legs from markets or tiers that did not beat the price in testing.</p>}
                  <p className="text-xs text-muted">Weakest leg: <b className="text-fg">{chosen.reduce((a, b) => (b.score < a.score ? b : a)).label}</b> ({chosen.reduce((a, b) => (b.score < a.score ? b : a)).score.toFixed(1)}/10).
                    Payout uses each leg's best listed price; a book's own parlay price can differ.</p>
                </CardBody>
              </>
            )}
          </Card>
          <Card><CardBody className="text-xs text-muted">Ratings and the backtest behind them: <Link to="/cfb/record" className="text-accent hover:underline">Track record</Link>. Football research, not betting advice.</CardBody></Card>
        </div>
      </div>
    </div>
  );
}

/** Expected return per $1 as a bar centered on break-even: green to the right, red to the left. */
function EdgeBar({ ev }: { ev: number }) {
  const w = Math.min(50, Math.abs(ev) * 250);
  return (
    <div>
      <div className="flex items-center justify-between text-xs"><span className="text-muted">Expected return per $1</span>
        <Badge tone={ev > 0 ? "ok" : "warn"}>{roiText(ev)}</Badge></div>
      <div className="relative mt-1.5 h-2 rounded-full bg-line">
        <span className="absolute inset-y-0 left-1/2 w-px bg-fg/40" />
        <span className={cn("absolute inset-y-0 rounded-full", ev > 0 ? "left-1/2 bg-ok" : "bg-danger")} style={ev > 0 ? { width: `${w}%` } : { right: "50%", width: `${w}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted"><span>books ahead</span><span>break-even</span><span>you ahead</span></div>
    </div>
  );
}
