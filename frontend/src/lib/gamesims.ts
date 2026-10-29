/* Inputs for the Game Simulations page (public/sim-player.html): each upcoming NFL and NBA game with the projections
   its play-by-play replay is built from. Written to site-data/sims/games.json by scripts/game-sims.ts on every publish.

   NFL: the week's pregame sims frozen by engine/simreview.py (nfl-data branch, sims/{season}-wNN.json): each team's
   implied total and every player's projected volume and yards. NBA: today's slate (site-data/nba/slate.json): the book
   total and spread, and each player's projected minutes, points, rebounds, assists and threes. */
import type { Slate } from "./nba";

type Summary = { mean: number };
export type FrozenWeek = {
  season: number; week: number; updated_at?: string;
  games: Record<string, { game_id: string; kickoff: string | null; teams: Record<string, {
    inputs: { player_id: string; player_name: string; position: string; team_implied_total: number | null; status?: string | null }[];
    players: Record<string, Record<string, Summary>>;
  }> }>;
};

const NFL_STATS = ["targets", "receptions", "rec_yards", "carries", "rush_yards", "attempts", "completions", "pass_yards", "pass_tds", "interceptions"] as const;
export type NflSimPlayer = { id: string; name: string; pos: string } & Partial<Record<(typeof NFL_STATS)[number], number>>;
export type NflSimGame = { id: string; away: string; home: string; kickoff: string | null; teams: Record<string, { implied: number; players: NflSimPlayer[] }> };
export type NbaSimPlayer = { name: string; min: number; pts: number; reb: number; ast: number; tpm: number; bench?: true };
export type NbaSimGame = { away: string; home: string; start: string; total: number; fav: string; spread: number };
/** A game left off the page because its inputs failed a sanity check (shown nowhere, logged by the publish run). */
export type HeldGame = { sport: "nfl" | "nba"; game: string; reasons: string[] };
export type SimGames = {
  generated_at: string;
  held: HeldGame[];
  nfl: { season: number | null; week: number | null; games: NflSimGame[] };
  nba: { date: string | null; games: NbaSimGame[]; players: Record<string, NbaSimPlayer[]> };
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const OUT = /^(out|ir|injured reserve|pup|suspended|doubtful)/i;

/** A team can be replayed only with a passer, some ball carriers, some targets and an implied total. */
function nflTeam(t: FrozenWeek["games"][string]["teams"][string]): NflSimGame["teams"][string] | null {
  const info = new Map(t.inputs.map((i) => [i.player_id, i]));
  const implied = t.inputs.find((i) => i.team_implied_total != null)?.team_implied_total;
  if (implied == null) return null;
  const players: NflSimPlayer[] = [];
  for (const [id, stats] of Object.entries(t.players)) {
    const i = info.get(id);
    if (!i || OUT.test(i.status ?? "")) continue;
    const p: NflSimPlayer = { id, name: i.player_name, pos: i.position };
    for (const k of NFL_STATS) if (stats[k]) p[k] = r2(stats[k].mean);
    if (p.pos === "QB" && !p.attempts) continue;   // backup quarterbacks with no projected passes
    players.push(p);
  }
  players.sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));
  const qb = players.find((p) => (p.attempts ?? 0) > 5);
  if (!qb || !players.some((p) => (p.carries ?? 0) > 0.3) || !players.some((p) => (p.targets ?? 0) > 0.3)) return null;
  return { implied, players: players.filter((p) => p === qb || p.pos !== "QB" || (p.carries ?? 0) > 0.3) };
}

/** Checks that keep a game with broken inputs off the page: a replay is only as good as what goes into it. */
export function nflChecks(g: NflSimGame): string[] {
  const bad: string[] = [];
  for (const [t, v] of Object.entries(g.teams)) {
    const qb = v.players.find((p) => (p.attempts ?? 0) > 5)!;
    const rec = v.players.reduce((s, p) => s + (p.rec_yards ?? 0), 0);
    if (v.implied < 10 || v.implied > 40) bad.push(`${t} implied total ${v.implied} outside 10-40`);
    if ((qb.attempts ?? 0) < 20 || (qb.attempts ?? 0) > 50) bad.push(`${t} QB ${qb.name} projected for ${qb.attempts} attempts`);
    if (qb.pass_yards && Math.abs(rec / qb.pass_yards - 1) > 0.3) bad.push(`${t} receiving yards ${Math.round(rec)} vs passing yards ${Math.round(qb.pass_yards)}`);
    for (const p of v.players) {
      if ((p.pass_yards ?? 0) > 400 || (p.rush_yards ?? 0) > 160 || (p.rec_yards ?? 0) > 160) bad.push(`${t} ${p.name} has an extreme projection`);
    }
  }
  return bad;
}

/** Book total and spread split into each team's expected points (away, home). */
export const nbaTargets = (g: NbaSimGame) => {
  const hi = (g.total + g.spread) / 2, lo = (g.total - g.spread) / 2;
  return g.fav === g.home ? [lo, hi] : [hi, lo];
};

/** The most minutes a reserves line may cover: past this the projections are missing real rotation players. */
const MAX_RESERVE_MINUTES = 48;
/** Per-minute production of a typical end-of-rotation player, for the minutes no projected player covers. */
const BENCH_RATE = { pts: 0.42, reb: 0.18, ast: 0.09, tpm: 0.04 };

/** Fits a team's projections into 240 minutes. Each player's projected minutes are his minutes when he plays, so a
 *  team's sum usually runs past 240 (Memphis once summed to 329): the deep bench is who sits. Players keep their
 *  projected minutes in order, most first, until 240 are used; the last one in gets what is left, and his counting
 *  stats shrink with his minutes. Players left under 4 minutes are dropped. A team whose projected players come up
 *  short (rookies and new signings have too little history to project) gets one "reserves" line for the rest, at a
 *  typical bench player's rate, so no projected player is stretched past his own minutes to fill the gap. */
export function fitRotation(list: NbaSimPlayer[], team = ""): NbaSimPlayer[] {
  let left = 240;
  const out: NbaSimPlayer[] = [];
  for (const p of [...list].sort((a, b) => b.min - a.min)) {
    const m = Math.min(p.min, left);
    if (m < 4) break;
    const k = m / p.min;
    out.push({ name: p.name, min: r2(m), pts: r2(p.pts * k), reb: r2(p.reb * k), ast: r2(p.ast * k), tpm: r2(p.tpm * k) });
    left -= m;
  }
  if (left >= 4 && left <= MAX_RESERVE_MINUTES) {
    out.push({ name: `${team} reserves`.trim(), min: r2(left), pts: r2(left * BENCH_RATE.pts), reb: r2(left * BENCH_RATE.reb),
      ast: r2(left * BENCH_RATE.ast), tpm: r2(left * BENCH_RATE.tpm), bench: true });
  }
  return out;
}

export function nbaChecks(g: NbaSimGame, players: SimGames["nba"]["players"], projectedMinutes: Record<string, number> = {}): string[] {
  const bad: string[] = [];
  const target = nbaTargets(g);
  [g.away, g.home].forEach((t, i) => {
    const ps = players[t];
    const min = projectedMinutes[t] ?? ps.reduce((s, p) => s + p.min, 0), pts = ps.reduce((s, p) => s + p.pts, 0);
    // more than a reserves line can cover means rotation players are missing from the projections
    if (min < 240 - MAX_RESERVE_MINUTES) bad.push(`${t} projected minutes add up to only ${Math.round(min)} of 240`);
    if (pts / target[i] < 0.85 || pts / target[i] > 1.15) bad.push(`${t} projected points add up to ${Math.round(pts)} vs ${target[i].toFixed(1)} from the book`);
    for (const p of ps) if (p.pts > 45 || p.reb > 20 || p.ast > 16 || p.min > 44) bad.push(`${t} ${p.name} has an extreme projection`);
  });
  if (g.total < 180 || g.total > 270 || g.spread > 25) bad.push(`book line looks wrong: total ${g.total}, spread ${g.spread}`);
  return bad;
}

export function nflSimGames(week: FrozenWeek | null, held: HeldGame[] = []): SimGames["nfl"] {
  if (!week) return { season: null, week: null, games: [] };
  const games: NflSimGame[] = [];
  for (const [id, g] of Object.entries(week.games)) {
    const [, , away, home] = id.split("_");
    if (!away || !home || !g.teams[away] || !g.teams[home]) continue;
    const a = nflTeam(g.teams[away]), h = nflTeam(g.teams[home]);
    if (!a || !h) { held.push({ sport: "nfl", game: id, reasons: ["missing a passer, ball carriers, targets or implied total"] }); continue; }
    const game: NflSimGame = { id, away, home, kickoff: g.kickoff, teams: { [away]: a, [home]: h } };
    const bad = nflChecks(game);
    if (bad.length) held.push({ sport: "nfl", game: id, reasons: bad });
    else games.push(game);
  }
  games.sort((x, y) => (x.kickoff ?? "").localeCompare(y.kickoff ?? "") || x.id.localeCompare(y.id));
  return { season: week.season, week: week.week, games };
}

export function nbaSimGames(slate: Slate | null, held: HeldGame[] = []): SimGames["nba"] {
  if (!slate) return { date: null, games: [], players: {} };
  const by = new Map<string, Map<string, NbaSimPlayer>>();
  for (const r of slate.rows) {
    if (r.out) continue;
    const team = by.get(r.team) ?? new Map<string, NbaSimPlayer>();
    by.set(r.team, team);
    const p = team.get(r.player_id) ?? { name: r.player_name, min: 0, pts: 0, reb: 0, ast: 0, tpm: 0 };
    team.set(r.player_id, p);
    p.min = Math.max(p.min, Math.round((r.evidence?.minutes ?? 0) * 10) / 10);
    const k = ({ points: "pts", rebounds: "reb", assists: "ast", threes: "tpm" } as const)[r.market as "points"];
    if (k) p[k] = r2(r.mean);
  }
  const players: SimGames["nba"]["players"] = {};
  const projected: Record<string, number> = {};
  for (const [team, m] of by) {
    const list = [...m.values()].filter((p) => p.min >= 4 && p.pts > 0).sort((a, b) => b.min - a.min);
    const total = list.reduce((s, p) => s + p.min, 0);
    const fit = fitRotation(list, team);
    if (fit.filter((p) => !p.bench).length >= 7) { players[team] = fit; projected[team] = total; }
  }
  const games: NbaSimGame[] = [];
  for (const g of slate.games) {
    const key = `${g.away} at ${g.home}`;
    if (g.total == null || g.home_spread == null) { held.push({ sport: "nba", game: key, reasons: ["no book total and spread yet"] }); continue; }
    if (!players[g.home] || !players[g.away]) { held.push({ sport: "nba", game: key, reasons: ["fewer than 7 projected players on a team"] }); continue; }
    // home_spread is the home side's line: negative when the home team is favored
    const game: NbaSimGame = { away: g.away, home: g.home, start: g.time, total: g.total, fav: g.home_spread <= 0 ? g.home : g.away, spread: Math.abs(g.home_spread) };
    const bad = nbaChecks(game, players, projected);
    if (bad.length) held.push({ sport: "nba", game: key, reasons: bad });
    else games.push(game);
  }
  games.sort((x, y) => x.start.localeCompare(y.start) || x.home.localeCompare(y.home));
  const playing = new Set(games.flatMap((g) => [g.home, g.away]));
  return { date: slate.date, games, players: Object.fromEntries(Object.entries(players).filter(([t]) => playing.has(t))) };
}
