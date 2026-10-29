import * as React from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { PageTitle } from "@/components/Layout";
import { Card, CardBody } from "@/components/ui";

/** Game Simulations: every game played 5,000 times with The Lab's projections, and the most typical run replayed on a
 *  court or field. The player is its own page (public/sim-player.html, data/sims/games.json) shown here in a frame;
 *  it reports which game is open, so each game has its own link (/sims/nfl-car-gb, /nba/sims/nba-mem-por). */
export default function Sims({ sport }: { sport: "nfl" | "nba" | "cfb" }) {
  const { game } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const frame = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(900);
  const want = game ?? sport;
  // the frame loads once per sport; later route changes (back/forward, menu) move it by its hash
  const src = React.useMemo(() => `${import.meta.env.BASE_URL}sim-player.html#${want}`, [sport]);

  React.useEffect(() => {
    const w = frame.current?.contentWindow;
    try { if (w && w.location.hash.slice(1) !== want) w.location.hash = want; } catch { /* not loaded yet */ }
  }, [want]);

  React.useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.lab !== "sims") return;
      if (typeof e.data.height === "number") setHeight(Math.max(400, Math.ceil(e.data.height)));
      if (typeof e.data.route === "string" && e.data.route !== loc.pathname) nav(e.data.route);
      if (e.data.top) window.scrollTo({ top: 0 });
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [loc.pathname, nav]);

  if (sport === "cfb") {
    return (
      <div className="space-y-4">
        <PageTitle kicker="College football" title="Game Simulations" />
        <Card><CardBody className="text-sm text-muted">
          Game simulations are live for the NFL and NBA. College football is next: it needs player projections for every team, which the college model does not make yet.
        </CardBody></Card>
      </div>
    );
  }
  return (
    <div>
      {!game && (
        <PageTitle kicker={sport === "nba" ? "NBA" : "NFL"} title="Game Simulations">
          <span className="max-w-md text-sm text-muted">Every game played 5,000 times with our projections. Watch the most typical one, start to finish.</span>
        </PageTitle>
      )}
      <iframe ref={frame} key={sport} src={src} title="Game simulation" className="block w-full border-0" style={{ height }} />
    </div>
  );
}
