/* Builds and grades each game's Sim Parlay (src/lib/simparlay.ts), run by the "Refresh data and publish site" workflow
   after the game sims are written and graded:

     LAB_DATA=../site-data SIM_ARCHIVE=../pick-archive/gamesims npx vite-node scripts/sim-parlays.ts

   A posted game that has not started gets its parlay once, from the same posted inputs and the same 5,000 seeded runs
   the page plays (public/sim-engine.js), and keeps it: like the sim, it never changes after it posts. Once the game's
   sim is graded (scripts/sim-grades.ts, from ESPN's box score) the parlay is graded from those same stats. The archive
   is kept in SIM_ARCHIVE/parlays.json on the nfl-data branch; LAB_DATA/sims/parlays.json has today's parlays, recent
   results and the record for the page. */
import fs from "node:fs";
import path from "node:path";
import type { SimGames } from "../src/lib/gamesims";
import type { SimArchive } from "../src/lib/simgrades";
import { chooseLegs, fairPrice, gradeParlay, legCandidates, NBA_MIN_MINUTES, parlayRecord, type SimParlay, type SimPlayer } from "../src/lib/simparlay";
import { loadEngine, runBoxes } from "./simengine";

const DATA = path.resolve(process.env.LAB_DATA || "../site-data");
const ARCHIVE = path.resolve(process.env.SIM_ARCHIVE || "../data/gamesims");
const FILE = path.join(ARCHIVE, "parlays.json");
const RUNS = 5000, HOUR = 3600e3;

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}

const now = new Date();
const store = readJson<{ parlays: SimParlay[] }>(FILE) ?? { parlays: [] };
const have = new Set(store.parlays.map((p) => p.key));
const sims = readJson<SimGames>(path.join(DATA, "sims", "games.json"));
const engine = loadEngine();
const day = (iso: string) => iso.slice(0, 10);
let built = 0;

function save(key: string, sport: SimParlay["sport"], away: string, home: string, start: string, G: unknown, players: SimPlayer[]) {
  const boxes = runBoxes(engine, G, RUNS);
  const pick = chooseLegs(legCandidates(sport, players, boxes), RUNS);
  if (!pick) { console.log(`sim parlay: none for ${key} (fewer than 3 legs qualify)`); return; }
  store.parlays.push({ key, sport, game: `${away} at ${home}`, start, built_at: now.toISOString(), runs: RUNS, ...pick, fair: fairPrice(pick.chance) });
  have.add(key);
  built++;
}

for (const g of sims?.nba.games ?? []) {
  const key = `nba-${day(g.start)}-${g.away}-${g.home}`.toLowerCase();
  if (have.has(key) || Date.parse(g.start) <= now.getTime()) continue;
  const players = { [g.away]: sims!.nba.players[g.away], [g.home]: sims!.nba.players[g.home] };
  if (!players[g.away] || !players[g.home]) continue;
  // players sure to play a full role: the sims' rotation players with real minutes (the engine's box keys are list positions)
  const sp = [g.away, g.home].flatMap((t, ti) => players[t].map((p, i) => ({ p, i }))
    .filter(({ p }) => !p.bench && p.min >= NBA_MIN_MINUTES).map(({ p, i }) => ({ ti, team: t, name: p.name, key: String(i) })));
  save(key, "nba", g.away, g.home, g.start, engine.nba(g, players), sp);
}
for (const g of sims?.nfl.games ?? []) {
  if (!g.kickoff) continue;
  const key = `nfl-${day(g.kickoff)}-${g.away}-${g.home}`.toLowerCase();
  if (have.has(key) || Date.parse(g.kickoff) <= now.getTime()) continue;
  const sp = [g.away, g.home].flatMap((t, ti) => g.teams[t].players.map((p) => ({ ti, team: t, name: p.name, key: p.id })));
  save(key, "nfl", g.away, g.home, g.kickoff, engine.nfl(g), sp);
}

// grade from the game's sim grade: the same ESPN box score, every frozen player's real stats
const archive = readJson<SimArchive>(path.join(ARCHIVE, "archive.json"));
const grades = new Map((archive?.grades ?? []).map((g) => [g.key, g]));
let graded = 0;
for (const p of store.parlays) {
  if (p.graded_at) continue;
  const g = grades.get(p.key);
  if (!g) {
    // the sim was never graded (no ESPN final after 3 days): the parlay is dropped with it
    if (now.getTime() - Date.parse(p.start) > 96 * HOUR) { p.hit = null; p.graded_at = now.toISOString(); console.log(`::warning::Sim parlay not graded (${p.key}): no final`); }
    continue;
  }
  gradeParlay(p, g, now);
  graded++;
}

fs.mkdirSync(ARCHIVE, { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(store));
// the page: parlays of games shown now, graded ones from the last 30 days, and the season record
const shown = new Set([
  ...(sims?.nba.games ?? []).map((g) => `nba-${day(g.start)}-${g.away}-${g.home}`.toLowerCase()),
  ...(sims?.nfl.games ?? []).filter((g) => g.kickoff).map((g) => `nfl-${day(g.kickoff!)}-${g.away}-${g.home}`.toLowerCase()),
]);
const out = {
  generated_at: now.toISOString(),
  games: store.parlays.filter((p) => shown.has(p.key)),
  recent: store.parlays.filter((p) => p.graded_at && p.hit != null && now.getTime() - Date.parse(p.start) < 30 * 24 * HOUR)
    .sort((a, b) => b.start.localeCompare(a.start)),
  record: { nba: parlayRecord(store.parlays, "nba"), nfl: parlayRecord(store.parlays, "nfl") },
};
fs.mkdirSync(path.join(DATA, "sims"), { recursive: true });
fs.writeFileSync(path.join(DATA, "sims", "parlays.json"), JSON.stringify(out));
for (const sp of ["nba", "nfl"] as const) {
  const r = out.record[sp];
  if (r.won + r.lost) console.log(`sim parlays ${sp}: ${r.won}-${r.lost}, legs ${r.legs_hit}/${r.legs}`);
}
console.log(`sim parlays: ${built} built, ${graded} graded this run, ${out.games.length} on the page`);
