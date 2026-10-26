import { NBA_MARKETS, useNba, type NbaPrevious as Prev } from "@/lib/nba";
import { pct } from "@/lib/format";
import { PageTitle } from "@/components/Layout";
import { Card, EmptyState, LoadingBlock } from "@/components/ui";
import { PreviousWeeks, type PrevPeriod } from "@/components/PreviousWeeks";

const short = (m: string) => NBA_MARKETS.find((x) => x.market === m)?.short ?? m;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

/** A usual line far from this game's projection (a role or minutes change) is one no book would post: the same rule
 *  The Lab's top 10 uses. Those leans are left out unless the viewer asks for them. */
const farLine = (line: number, mean: number | null) => mean != null && Math.abs(mean - line) > Math.max(1.5, 0.2 * Math.max(line, mean));

function periods(d: Prev): PrevPeriod[] {
  return d.days.map((x) => ({
    key: x.date, label: day(x.date),
    games: x.games.map((g) => ({
      id: String(g.game_id), title: `${g.away} at ${g.home}`,
      score: g.score[0] != null && g.score[1] != null ? `${g.away} ${g.score[1]}, ${g.home} ${g.score[0]}` : undefined,
      picks: g.picks.map(([pid, name, team, market, side, line, chance, mean, actual, won]) => ({
        key: `${pid}-${market}`, market, bet: `${name} ${side} ${line} ${short(market)}`, result: won ? "won" : "lost", chance,
        detail: `${team} · projected ${mean ?? "–"} · ${side} ${pct(chance, 0)}${x.line_source === "usual" ? " · usual line" : ""}`,
        actual: `Had ${actual}`, hidden: x.line_source === "usual" && farLine(line, mean),
      })),
    })),
  }));
}

/** Every graded lean, day by day and game by game, with a check or an X. */
export default function NbaPrevious() {
  const q = useNba<Prev>("previous.json");
  if (q.isError) return <Card><EmptyState title="Previous days are not published yet">The NBA results publish with the next morning run.</EmptyState></Card>;
  if (!q.data) return <Card><LoadingBlock rows={8} className="p-5" /></Card>;
  return (
    <div className="space-y-5">
      <PageTitle kicker="NBA" title="Previous weeks" />
      <PreviousWeeks layout="list" noun="day" periods={periods(q.data)} markets={NBA_MARKETS.map(({ market, label }) => ({ market, label }))}
        chanceSteps={[0, 0.55, 0.6, 0.7]} hiddenLabel="Include usual lines far from his projection"
        note={<>Every lean the model made, likeliest first in each game, not only the top picks. ✓ hit, ✗ miss. {q.data.note}</>} />
    </div>
  );
}
