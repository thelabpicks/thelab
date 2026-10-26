import { fmtLine, fmtPrice, kick, useCfb, type CfbPrevious as Prev, type PrevCfbGame, type PrevLean } from "@/lib/cfb";
import { pct } from "@/lib/format";
import { PageTitle } from "@/components/Layout";
import { Card, LoadingBlock } from "@/components/ui";
import { PreviousWeeks, type PrevPeriod, type PrevPick } from "@/components/PreviousWeeks";
import { NotPublished, RatingMeter } from "./shared";

const MARKETS = [{ market: "spread", label: "Spread" }, { market: "total", label: "Over/under" }, { market: "moneyline", label: "Moneyline" },
  { market: "team_total", label: "Team totals" }];
const BOX: Record<string, string> = { spread: "Spread", total: "Over/under", moneyline: "Moneyline", team_total: "Team total" };

const by = (team: string, n: number) => (n === 0 ? "tie" : `${team} by ${Math.abs(n) % 1 ? Math.abs(n).toFixed(1) : Math.abs(n)}`);

function bet(m: PrevLean): string {
  if (m.market === "spread") return `${m.team} ${fmtLine(m.line!)}`;
  if (m.market === "total") return `${m.side === "over" ? "Over" : "Under"} ${m.line}`;
  if (m.market === "team_total") return `${m.team} ${m.side} ${m.line}`;
  return `${m.team} ${fmtPrice(m.price)}`;
}

/** What the model said for this market, in one short line. */
function said(g: PrevCfbGame, m: PrevLean): string {
  const md = g.model;
  if (!md) return `${m.side === "over" || m.side === "under" ? m.side : "covers"} ${pct(m.p, 0)}`;
  if (m.market === "spread") { const mar = md.home - md.away; return `Sims: ${by(mar >= 0 ? g.home : g.away, mar)} · covers ${pct(m.p, 0)}`; }
  if (m.market === "total") return `Sims: ${(md.home + md.away).toFixed(1)} points · ${m.side} ${pct(m.p, 0)}`;
  if (m.market === "team_total") return `Sims: ${m.team} ${(m.team_side === "home" ? md.home : md.away).toFixed(1)} · ${m.side} ${pct(m.p, 0)}`;
  return `Wins ${pct(m.p, 0)} of sims${m.ev != null ? ` · ${m.ev >= 0 ? "+" : ""}${(m.ev * 100).toFixed(1)}¢ per $1` : ""}`;
}

/** What really happened, in the market's own terms. */
function happened(g: PrevCfbGame, m: PrevLean): string {
  const [h, a] = g.score;
  if (m.market === "spread") return `Final margin: ${by(h >= a ? g.home : g.away, h - a)}`;
  if (m.market === "total") return `Final total: ${h + a}`;
  if (m.market === "team_total") return `${m.team} scored ${m.team_side === "home" ? h : a}`;
  return `${h > a ? g.home : a > h ? g.away : "Nobody"} won`;
}

function periods(d: Prev): PrevPeriod[] {
  const weeks = new Map<string, PrevPeriod>();
  for (const g of [...d.games].reverse()) {
    const key = `${g.season_type}-${g.week}`;
    if (!weeks.has(key)) weeks.set(key, { key, label: g.season_type === "regular" ? `Week ${g.week}` : `Postseason ${g.week}`, games: [] });
    const order = MARKETS.map((m) => m.market);
    const picks: PrevPick[] = [...g.markets].sort((x, y) => order.indexOf(x.market) - order.indexOf(y.market)).map((m, i) => ({
      key: `${g.game_id}-${m.market}-${i}`, market: m.market, box: BOX[m.market], bet: bet(m), result: m.result, chance: m.p,
      detail: said(g, m), actual: happened(g, m), strong: m.score >= 7,
      extra: <RatingMeter size="sm" score={m.score} p={m.p} ev={m.ev} proven={m.proven} />,
    }));
    weeks.get(key)!.games.push({
      id: String(g.game_id), title: `${g.away} at ${g.home}`, when: kick(g.date),
      score: `${g.away} ${g.score[1]}, ${g.home} ${g.score[0]}`,
      sub: `${g.model ? `Sims had ${g.away} ${g.model.away.toFixed(0)}, ${g.home} ${g.model.home.toFixed(0)} · ` : ""}${g.source === "live" ? "frozen before kickoff" : "model as of that week, closing line"}`,
      picks,
    });
  }
  return [...weeks.values()];
}

/** Every finished game this season, week by week: the model's spread, over/under, moneyline and (posted) team total
 *  picks, each with a check or an X. */
export default function CfbPrevious() {
  const q = useCfb<Prev>("previous.json");
  if (q.isError) return <NotPublished error={q.error} />;
  if (!q.data) return <Card><LoadingBlock rows={8} className="p-5" /></Card>;
  return (
    <div className="space-y-5">
      <PageTitle kicker={`College football · ${q.data.season}`} title="Previous weeks" />
      <PreviousWeeks layout="boxes" periods={periods(q.data)} markets={MARKETS} strongLabel="Only bets rated 7+"
        note={<>Every finished game with the model's side in every market, not only the top picks. ✓ hit, ✗ miss, P push. {q.data.note}</>} />
    </div>
  );
}
