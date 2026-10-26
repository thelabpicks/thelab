import { pct } from "@/lib/format";
import { PageTitle } from "@/components/Layout";
import { useLiveRecord, type LiveRecord } from "@/components/LiveRecord";
import { Card, EmptyState, LoadingBlock } from "@/components/ui";
import { PreviousWeeks, type PrevPeriod } from "@/components/PreviousWeeks";

const words = (m: string) => m.replace(/_/g, " ");
const kick = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });

function periods(d: LiveRecord): PrevPeriod[] {
  return (d.previous_weeks ?? []).map((w) => ({
    key: `${w.season}-${w.week}`, label: `Week ${w.week}`,
    games: w.games.map((g) => ({
      id: g.game_id, title: g.home && g.away ? `${g.away} at ${g.home}` : g.game_id, when: g.kickoff ? kick(g.kickoff) : undefined,
      score: g.score[0] != null && g.score[1] != null ? `${g.away} ${g.score[1]}, ${g.home} ${g.score[0]}` : undefined,
      picks: g.picks.map(([pid, name, team, market, side, line, chance, median, actual, result, featured]) => {
        const td = market === "td";
        return {
          key: `${pid}-${market}`, market, chance, strong: featured,
          bet: td ? `${name} anytime TD` : `${name} ${side} ${line} ${words(market)}`,
          result: result == null ? "void" : result ? "won" : "lost",
          detail: `${team}${median != null ? ` · projected ${median}` : ""} · ${td ? "scores" : side} ${pct(chance, 0)}`,
          actual: result == null ? "Did not play" : td ? (actual ? "Scored" : "No TD") : `Had ${actual}`,
        };
      }),
    })),
  }));
}

/** Every graded NFL pick, week by week and game by game, with a check or an X. */
export default function Previous() {
  const q = useLiveRecord();
  if (q.isError) return <Card><EmptyState title="Previous weeks are not published yet">Results publish after each game window.</EmptyState></Card>;
  if (!q.data) return <Card><LoadingBlock rows={8} className="p-5" /></Card>;
  const labels = new Map((q.data.by_market ?? []).map((m) => [m.market, m.label]));
  const label = (m: string) => labels.get(m) ?? (m === "td" ? "Anytime TD" : words(m));
  const ps = periods(q.data);
  const markets = [...new Set(ps.flatMap((p) => p.games.flatMap((g) => g.picks.map((x) => x.market))))].map((m) => ({ market: m, label: label(m) }));
  return (
    <div className="space-y-5">
      <PageTitle kicker="NFL" title="Previous weeks" />
      <PreviousWeeks layout="list" periods={ps} markets={markets} chanceSteps={[0, 0.55, 0.6, 0.7]} strongLabel="Only featured picks"
        note={<>Every pick the site showed, saved before kickoff and graded from the box score, likeliest first in each game. ✓ hit, ✗ miss, – did not play. Prop lines are the books' main lines.</>} />
    </div>
  );
}
