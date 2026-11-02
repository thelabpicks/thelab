/* Grades each game simulation against the real final (src/lib/simgrades.ts), run by the "Refresh data and publish site"
   workflow after the game simulation inputs are written:

     LAB_DATA=../site-data SIM_ARCHIVE=../pick-archive/gamesims npx vite-node scripts/sim-grades.ts

   Every run freezes the games that have not started yet (the last version before tip-off or kickoff is the one graded)
   and grades every frozen game that ended at least 4 hours ago, from ESPN's box score. The archive (frozen inputs and
   all grades) is kept in SIM_ARCHIVE on the nfl-data branch; LAB_DATA/sims/grades.json has the summaries and recent
   games for the Sims page and the daily report. A game ESPN still has no final for after 3 days is dropped. Nothing
   here stops the site from publishing. */
import fs from "node:fs";
import path from "node:path";
import type { SimGames } from "../src/lib/gamesims";
import { findEvent, freezeSims, gradeSim, parseBox, parseFirst, summarize, type SimArchive, type Sport } from "../src/lib/simgrades";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const ARCHIVE = path.resolve(process.env.SIM_ARCHIVE || "../data/gamesims");
const FILE = path.join(ARCHIVE, "archive.json");
const ESPN = "https://site.api.espn.com/apis/site/v2/sports";
const LEAGUE: Record<Sport, string> = { nba: "basketball/nba", nfl: "football/nfl" };
const HOUR = 3600e3;

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
async function get(url: string) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* retried */ }
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
  }
  return null;
}

const now = new Date();
const archive: SimArchive = readJson<SimArchive>(FILE) ?? { frozen: {}, grades: [] };
const sims = readJson<SimGames>(path.join(DATA, "sims", "games.json"));
if (sims) freezeSims(sims, archive.frozen, now);

const graded = new Set(archive.grades.map((g) => g.key));
const boards = new Map<string, unknown>();
let added = 0;
for (const f of Object.values(archive.frozen)) {
  if (graded.has(f.key) || now.getTime() - Date.parse(f.start) < 4 * HOUR) continue;
  if (now.getTime() - Date.parse(f.start) > 72 * HOUR) {
    console.log(`::warning::Game sim not graded (${f.key}): no ESPN final after 3 days`);
    delete archive.frozen[f.key];
    continue;
  }
  let id = f.espn_id ?? null;
  if (!id) {
    // the ESPN scoreboard of the game's date (US time: an 8:15 pm ET kickoff is the next day in UTC)
    const day = new Date(Date.parse(f.start) - 6 * HOUR).toISOString().slice(0, 10).replace(/-/g, "");
    const bk = `${f.sport}${day}`;
    if (!boards.has(bk)) boards.set(bk, await get(`${ESPN}/${LEAGUE[f.sport]}/scoreboard?dates=${day}`));
    id = findEvent(f, boards.get(bk) as never);
  }
  if (!id) continue;
  const summary = await get(`${ESPN}/${LEAGUE[f.sport]}/summary?event=${id}`);
  const box = parseBox(f.sport, summary);
  if (!box) continue;   // not final yet
  const g = gradeSim(f, id, box, now);
  // who really scored first, for the Ask the sims answers (src/lib/simanswers.ts)
  const first = parseFirst(f.sport, summary);
  if (first) g.first = first;
  else console.log(`::warning::No first ${f.sport === "nba" ? "basket" : "touchdown"} found in ESPN's play-by-play (${f.key})`);
  // no players matched means ESPN's box score changed shape or names: worth a look, the game is still graded on the score
  if (!g.players.length) console.log(`::warning::Game sim graded without player stats (${f.key}): no box score names matched`);
  archive.grades.push(g);
  delete archive.frozen[f.key];
  added++;
}

fs.mkdirSync(ARCHIVE, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(archive));
const recent = (days: number) => archive.grades.filter((g) => now.getTime() - Date.parse(g.start) < days * 24 * HOUR);
const out = {
  generated_at: now.toISOString(),
  season: { nba: summarize(archive.grades, "nba"), nfl: summarize(archive.grades, "nfl") },
  last30: { nba: summarize(recent(30), "nba"), nfl: summarize(recent(30), "nfl") },
  games: [...archive.grades].sort((a, b) => b.start.localeCompare(a.start)).slice(0, 60),
};
fs.mkdirSync(path.join(DATA, "sims"), { recursive: true });
fs.writeFileSync(path.join(DATA, "sims", "grades.json"), JSON.stringify(out));
for (const sp of ["nba", "nfl"] as const) {
  const s = out.season[sp];
  if (s) console.log(`sim grades ${sp}: ${s.games} games, winner ${s.winners}/${s.games}, team points miss ${s.team_miss} (lean ${s.team_bias > 0 ? "+" : ""}${s.team_bias})${s.book_miss != null ? `, book ${s.book_miss}` : ""}`);
}
console.log(`sim grades: ${added} graded this run, ${Object.keys(archive.frozen).length} frozen and waiting`);
