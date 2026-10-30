/* Runs the Game Simulations page's own engine (public/sim-engine.js) in Node, so the site build sees the very same
   seeded games a visitor's browser plays: run i of a game is seed 100000 + i on the page and here. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { NbaSimGame, NbaSimPlayer, NflSimGame } from "../src/lib/gamesims";
import type { RunBox } from "../src/lib/simparlay";

const ENGINE = fs.readFileSync(path.resolve(__dirname, "../public/sim-engine.js"), "utf8");
// the page's own setup (build() in sim-player.html), minus drawing: a game's teams, tuned so the runs center on the projections
const GLUE = `
function __nba(g,players){DATA={nba:{players}};NBA={sport:'nba',runs:5000,teams:[{abbr:g.away},{abbr:g.home}],
  book:{total:g.total,spread:g.spread,fav:g.fav===g.home?1:0,favAbbr:g.fav}};setupNBA();return NBA}
function __nfl(g){NFL={sport:'nfl',runs:5000,src:g,teams:[{abbr:g.away},{abbr:g.home}]};setupNFL();return NFL}
function __run(G,seed){if(G.sport==='nba'){NBA=G;return boxOf(G,simNBA(seed,true))}NFL=G;return boxOf(G,simNFL(seed,true))}
`;

export type Engine = { nba: (g: NbaSimGame, players: Record<string, NbaSimPlayer[]>) => unknown; nfl: (g: NflSimGame) => unknown; run: (G: unknown, seed: number) => RunBox };

export function loadEngine(): Engine {
  const ctx = vm.createContext({ Math, Object, Array, Number, String, JSON });
  vm.runInContext(`let DATA=null;\n${ENGINE}\n${GLUE}`, ctx);
  const call = (f: string, ...a: unknown[]) => (vm.runInContext(f, ctx) as (...x: unknown[]) => unknown)(...a);
  return {
    nba: (g, players) => call("__nba", g, players),
    nfl: (g) => call("__nfl", g),
    run: (G, seed) => call("__run", G, seed) as RunBox,
  };
}

/** Each run's box score for runs 0..n-1 (the page's seeds). */
export function runBoxes(engine: Engine, G: unknown, n = 5000): RunBox[] {
  const out: RunBox[] = [];
  for (let i = 0; i < n; i++) out.push(engine.run(G, 100000 + i));
  return out;
}
