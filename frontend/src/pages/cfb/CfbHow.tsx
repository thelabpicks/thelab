import { Link } from "react-router-dom";
import { pct } from "@/lib/format";
import { useCfb, type Backtest, type CfbStatus } from "@/lib/cfb";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody } from "@/components/ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card><CardBody className="space-y-2 text-sm leading-relaxed"><h2 className="font-semibold text-fg">{title}</h2><div className="space-y-2 text-muted">{children}</div></CardBody></Card>;
}

export default function CfbHow() {
  const st = useCfb<CfbStatus>("status.json");
  const bt = useCfb<Backtest>("backtest.json");
  const h = st.data?.history;
  const b = bt.data;
  return (
    <div className="space-y-4">
      <PageTitle kicker="College football" title="How it works" />
      <Section title="The ratings out of 10">
        <p>Every spread, total and moneyline (and every prop) gets a rating. The simulated chance is checked against how past leans really did, priced at the best odds on offer,
          and ranked against every past lean's expected return. Only <b>7 and up</b> beat the books in testing, so only those become picks; markets that never beat the price stop at 6.9.</p>
        <p>The home page shows each game's single best bet, and only when it rates 7+.</p>
      </Section>
      <Section title="Where the numbers come from">
        <p>Scores, schedules and closing lines for every game since {h?.first_season ?? 2010} ({h ? `${h.games.toLocaleString()} games, ${h.lined_games.toLocaleString()} with closing lines` : "—"}),
          ESPN team and player box scores, play-by-play, the AP poll and each morning's ESPN line, refreshed every day.</p>
        <p><b>Team ratings</b> are refit before every week from earlier games only: opponent-adjusted points, yards per play, pace, turnovers and, from play-by-play with garbage time removed,
          EPA per play, success rate and explosive plays. Recent games count most.</p>
        <p><b>The game model</b> turns the ratings and the posted line into an expected margin and total; the last two seasons count most.</p>
        <p><b>Simulation:</b> each game is played 5,000 times. Every chance (cover, over, team total, win) is the share of those games.</p>
      </Section>
      <Section title="How it is tested">
        <p>Walk-forward: {b ? `${b.games.toLocaleString()} games from ${b.first_season} to ${b.last_season}` : "every game since 2016"}, each simulated with the model as it stood that week.
          A tier becomes a pick only if it hit at least {pct(b?.break_even ?? 0.524, 1)} (the -110 break-even) over the whole test, did not lose over the last two seasons, and every stronger tier passed too.</p>
        <ul className="list-disc pl-5">
          <li><b className="text-fg">Game totals</b> beat the price, most of all at the opening line, so totals are best bet early in the week.</li>
          <li><b className="text-fg">Underdog moneylines</b> beat the price when the model's chance is well above the book's.</li>
          <li><b className="text-fg">Spreads</b> did not beat the closing line, so they are shown as leans, never picks.</li>
          <li><b className="text-fg">Team totals and props</b> are picks only at lines a book actually posts.</li>
        </ul>
        <p>Full results by market and tier are on the <Link to="/cfb/record" className="text-accent hover:underline">track record</Link> page.</p>
      </Section>
      <Section title="Lines">
        <p>Each game uses the sportsbook consensus while it is under 36 hours old, then the day's ESPN line, so it stays current between sportsbook pulls (Tuesday and Saturday). Game pages show every book's prices.</p>
      </Section>
      <Section title="Parlays">
        <p>The parlay builder offers game lines plus props at book-posted lines. Legs from the same game are priced together from that game's simulated scores; legs from different games multiply.</p>
      </Section>
      <Section title="Checking itself">
        <p>Every pick is frozen before kickoff and graded after the game. Each finished game is simulated again from what the offenses actually did, so the gap between the pregame and post-game sims shows which inputs were off. Every final joins the next week's refit.</p>
      </Section>
      <p className="text-xs text-muted">College football research, not betting advice. No pick is guaranteed.</p>
    </div>
  );
}
