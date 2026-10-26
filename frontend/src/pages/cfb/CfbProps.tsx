import * as React from "react";
import { Link } from "react-router-dom";
import { num, pct } from "@/lib/format";
import { bookName, fmtPrice, useCfb, type Props, type Week } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice, Segmented } from "@/components/ui";
import { NotPublished, RatingMeter } from "./shared";

const MK = [{ value: "all", label: "All" }, { value: "pass_yds", label: "Pass yds" }, { value: "rush_yds", label: "Rush yds" },
  { value: "rec_yds", label: "Rec yds" }, { value: "receptions", label: "Catches" }];

export default function CfbProps() {
  const p = useCfb<Props>("props.json");
  const w = useCfb<Week>("week.json");
  const [mk, setMk] = React.useState("all");
  if (p.isError) return <NotPublished error={p.error} />;
  const games = new Map((w.data?.games ?? []).map((g) => [g.game_id, g]));
  const rows = (p.data?.rows ?? []).filter((r) => mk === "all" || r.market === mk);
  const byGame = new Map<number, typeof rows>();
  for (const r of rows) byGame.set(r.game_id, [...(byGame.get(r.game_id) ?? []), r]);
  return (
    <div className="space-y-5">
      <PageTitle kicker="College football" title="Player props">
        <Segmented size="sm" label="Market" value={mk} onChange={setMk} options={MK} />
      </PageTitle>
      <Notice title="Big games only">
        Books post college props for the marquee games, so this page covers this week's featured matchups. {p.data?.backtest.note}
        {" "}A prop is a pick only at a line a book posted and only in a tier that held up in testing.
      </Notice>
      {!p.data && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {p.data && !rows.length && <Card><CardBody className="text-sm text-muted">No featured games with player history this week.</CardBody></Card>}
      {[...byGame.entries()].map(([gid, rs]) => {
        const g = games.get(gid);
        return (
          <Card key={gid}>
            <CardHeader title={g ? `${g.away} at ${g.home}` : "Game"} subtitle={g ? `Model ${g.away} ${num(g.model.away, 0)}, ${g.home} ${num(g.model.home, 0)}` : undefined} />
            <div className="divide-y divide-line/60">
              {rs.slice(0, 24).map((r) => {
                const t = p.data!.backtest.markets[r.market]?.tiers.find((x) => x.tier === r.tier);
                return (
                  <div key={`${r.player_id}-${r.market}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium"><Link to={`/cfb/players/${r.player_id}`} className="underline decoration-muted/60 decoration-dotted underline-offset-4 hover:text-accent">{r.player}</Link> <span className="text-xs text-muted">{r.team}</span></div>
                      <div className="text-xs text-muted">projects {num(r.mean, 1)} · last {r.recent.slice(0, 5).join(", ")}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-semibold">{r.side === "over" ? "Over" : "Under"} {r.line} {r.label.toLowerCase()}</div>
                      <div className="flex items-center justify-end gap-1 text-xs text-muted">
                        <RatingMeter size="sm" score={r.score} p={r.p} fair={r.fair_p} ev={r.ev} proven={r.proven} />
                        {r.proven && <Badge tone="ok">Proven</Badge>}
                        <span title={t ? `${t.tier}: ${pct(t.rate, 0)} of ${t.n.toLocaleString()} at usual lines in testing` : ""}>
                          {r.line_source === "book" ? `book${r.best ? ` ${fmtPrice(r.best.price)} ${bookName(r.best.book)}` : ""}` : "usual line"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
