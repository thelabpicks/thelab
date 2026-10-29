/* Writes the Game Simulations page's inputs (run by the "Refresh data and publish site" workflow on every publish):

     LAB_DATA=../site-data SIMS_DIR=../pick-archive/sims npx vite-node scripts/game-sims.ts

   Takes the newest NFL week of pregame sims frozen on the nfl-data branch and today's NBA slate, and writes
   LAB_DATA/sims/games.json (src/lib/gamesims.ts). A sport whose files are missing is left empty; the page says so. */
import fs from "node:fs";
import path from "node:path";
import type { Slate } from "../src/lib/nba";
import { nbaSimGames, nflSimGames, simPicks, type FrozenWeek, type SimGames } from "../src/lib/gamesims";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const SIMS = path.resolve(process.env.SIMS_DIR || "../data/sims");

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

// newest frozen week: file names are {season}-wNN.json, so the last one in sorted order
const weekFile = fs.existsSync(SIMS) ? fs.readdirSync(SIMS).filter((f) => /^\d{4}-w\d{2}\.json$/.test(f)).sort().at(-1) : undefined;
const held: SimGames["held"] = [];
const fixed: SimGames["fixed"] = [];
const nfl = nflSimGames(weekFile ? readJson<FrozenWeek>(path.join(SIMS, weekFile)) : null, held, fixed);
const nba = nbaSimGames(readJson<Slate>(path.join(DATA, "nba", "slate.json")), held, fixed);
// The Lab's picks (written by scripts/lab-picks.ts earlier in the same run): each game's replay agrees with them
const out: SimGames = { generated_at: new Date().toISOString(), held, fixed, picks: simPicks(readJson(path.join(DATA, "lab", "board.json")), nfl, nba), nfl, nba };
fs.mkdirSync(path.join(DATA, "sims"), { recursive: true });
fs.writeFileSync(path.join(DATA, "sims", "games.json"), JSON.stringify(out));
// a game that failed a check was corrected and checked again; one that still fails stays off the page until a later
// run's fresh data passes
for (const f of fixed) console.log(`::notice::Game sim corrected (${f.sport} ${f.game}): ${f.fixes.join("; ")}`);
for (const h of held) console.log(`::warning::Game sim held back (${h.sport} ${h.game}): ${h.reasons.join("; ")}`);
console.log(`game sims: NFL ${out.nfl.season ?? "-"} week ${out.nfl.week ?? "-"} ${out.nfl.games.length} games, NBA ${out.nba.date ?? "-"} ${out.nba.games.length} games`);
