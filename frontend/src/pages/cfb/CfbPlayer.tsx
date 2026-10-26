import { Link, useParams } from "react-router-dom";
import { num } from "@/lib/format";
import { bookName, fmtPrice, useCfb, type CfbPlayerPage } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardHeader, LoadingBlock, TableWrap, Td, Th } from "@/components/ui";
import { GameByGame } from "@/components/GameByGame";
import { NotPublished, RatingMeter } from "./shared";

const STATS = [
  { key: "pass_yds", label: "Passing yards", short: "Pass yds" }, { key: "pass_att", label: "Pass attempts", short: "Att" },
  { key: "pass_td", label: "Passing TDs", short: "Pass TD" }, { key: "rush_yds", label: "Rushing yards", short: "Rush yds" },
  { key: "rush_att", label: "Rush attempts", short: "Car" }, { key: "rec_yds", label: "Receiving yards", short: "Rec yds" },
  { key: "receptions", label: "Receptions", short: "Rec" },
] as const;

export default function CfbPlayer() {
  const { id } = useParams();
  const page = useCfb<CfbPlayerPage>(`players/${id}.json`);
  if (page.isError) return <NotPublished error={new Error("Player pages are published for players with a prop this week only.")} />;
  if (!page.data) return <Card><LoadingBlock rows={6} className="p-5" /></Card>;
  const p = page.data;
  const props = [...p.props].sort((a, b) => b.score - a.score);
  // a stat only counts if he plays it: a receiver's one carry is not a rushing log
  const stats = STATS.filter((s) => p.log.some((g) => g[s.key] > 0)).map((s) => {
    const r = p.props.find((x) => x.market === s.key);
    return { ...s, line: r?.line ?? null, lineNote: r ? (r.line_source === "book" ? "This week's book line" : "His usual line (no book line yet)") : undefined };
  });
  return (
    <div className="space-y-5">
      <PageTitle kicker={<Link to="/cfb/props" className="hover:text-accent">College football · Player props</Link>} title={p.player_name}>
        <span className="text-sm text-muted">{p.team}</span>
      </PageTitle>
      {!!props.length && (
        <Card>
          <CardHeader title="This week's props" subtitle={`${props[0].team} ${props[0].opp ? `vs ${props[0].opp}` : ""}`} />
          <TableWrap><table className="w-full text-sm">
            <thead><tr><Th>Market</Th><Th className="text-right">Proj</Th><Th>Line</Th><Th>Lean</Th><Th>Rating</Th><Th>Best price</Th></tr></thead>
            <tbody>{props.map((r) => (
              <tr key={r.market} className="border-b border-line/60">
                <Td className="font-medium">{r.label}</Td><Td className="text-right font-semibold">{num(r.mean, 1)}</Td>
                <Td>{r.line} <span className="text-[10px] text-muted">{r.line_source === "book" ? "book" : "usual"}</span></Td>
                <Td className="whitespace-nowrap font-semibold">{r.side === "over" ? "Over" : "Under"} {r.line}{r.proven && <Badge tone="ok" className="ml-1.5">Proven</Badge>}</Td>
                <Td><RatingMeter size="sm" score={r.score} p={r.p} fair={r.fair_p} ev={r.ev} proven={r.proven} /></Td>
                <Td className="whitespace-nowrap">{r.best ? `${fmtPrice(r.best.price)} ${bookName(r.best.book)}` : <span className="text-muted">—</span>}</Td>
              </tr>))}</tbody>
          </table></TableWrap>
        </Card>
      )}
      <GameByGame initial={props[0]?.market} stats={stats}
        games={[...p.log].reverse().map((g) => ({ id: g.date, when: new Date(`${g.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          opp: `${g.home ? "vs" : "@"} ${g.opp}`, values: Object.fromEntries(STATS.map((s) => [s.key, g[s.key]])) }))} />
    </div>
  );
}
