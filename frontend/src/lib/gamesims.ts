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
/** A game left off the page because its inputs failed a sanity check even after repairs (logged by the publish run). */
export type HeldGame = { sport: "nfl" | "nba"; game: string; reasons: string[] };
/** A game whose inputs failed a check and were corrected, then passed every check (logged by the publish run). */
export type FixedGame = { sport: "nfl" | "nba"; game: string; fixes: string[] };
/** A pick The Lab has out on a simulated game (top 10 or pick of the day): the replay shown for that game must land on
 *  the pick's side, so a follower never sees the sim contradict the pick. game: the NFL game id or "AWAY at HOME". */
export type SimPick = { sport: "nfl" | "nba"; game: string; who: string; player_id?: string; market: string; side: string; line: number | null };
/** A replay already posted (a clip on X): its inputs and run stay fixed until `until`, so the site keeps playing the game
 *  followers saw even when a later refresh re-freezes the projections. Kept in scripts/sim-pins.json. */
export type SimPin = { key: string; sport: "nfl"; seed: number; until: string; note?: string; game: NflSimGame };
export type SimGames = {
  generated_at: string;
  pins?: SimPin[];
  picks: SimPick[];
  held: HeldGame[];
  fixed: FixedGame[];
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

/** Scales a player's passing line to `k` times its volume (attempts, completions, yards, touchdowns, interceptions). */
function scalePassing(p: NflSimPlayer, k: number) {
  for (const s of ["attempts", "completions", "pass_yards", "pass_tds", "interceptions"] as const) if (p[s] != null) p[s] = r2(p[s]! * k);
}

/** Corrects what a failed check can be corrected from (the game is checked again after): a projection past the extreme
 *  caps is cut to the cap, a quarterback's volume outside 20-50 attempts (but within 12-60) is pulled to the nearest
 *  end with his yards in proportion, and receivers' yards are re-pinned to the quarterback's passing yards when the two
 *  disagree by up to 2.5x. An implied total outside 10-40 is bad data and is not guessed at. Returns what was changed. */
export function repairNfl(g: NflSimGame): string[] {
  const fixes: string[] = [];
  for (const [t, v] of Object.entries(g.teams)) {
    for (const p of v.players) {
      if ((p.pass_yards ?? 0) > 400) { fixes.push(`${t} ${p.name} passing yards ${p.pass_yards} capped at 400`); scalePassing(p, 400 / p.pass_yards!); }
      for (const s of ["rush_yards", "rec_yards"] as const) {
        if ((p[s] ?? 0) > 160) { fixes.push(`${t} ${p.name} ${s.replace("_", " ")} ${p[s]} capped at 160`); p[s] = 160; }
      }
    }
    const qb = v.players.find((p) => (p.attempts ?? 0) > 5)!;
    const att = qb.attempts ?? 0;
    if ((att < 20 && att >= 12) || (att > 50 && att <= 60)) {
      const to = att < 20 ? 20 : 50;
      fixes.push(`${t} QB ${qb.name} attempts ${att} set to ${to}`);
      scalePassing(qb, to / att);
    }
    const rec = v.players.reduce((s, p) => s + (p.rec_yards ?? 0), 0);
    const k = qb.pass_yards && rec ? qb.pass_yards / rec : 1;
    if (Math.abs(k - 1) > 0.3 && k >= 0.4 && k <= 2.5) {
      fixes.push(`${t} receiving yards ${Math.round(rec)} re-pinned to ${Math.round(qb.pass_yards!)} passing yards`);
      for (const p of v.players) if (p.rec_yards) p.rec_yards = r2(Math.min(160, p.rec_yards * k));
    }
  }
  return fixes;
}

/** Corrects a failed NBA game's inputs (checked again after): a player past 44 minutes is cut to 44 with his stats in
 *  proportion. Returns what was changed. */
export function repairNba(g: NbaSimGame, players: SimGames["nba"]["players"]): string[] {
  const fixes: string[] = [];
  [g.away, g.home].forEach((t) => {
    const ps = players[t].map((p) => {
      if (p.min <= 44) return p;
      const k = 44 / p.min;
      fixes.push(`${t} ${p.name} minutes ${p.min} cut to 44`);
      return { ...p, min: 44, pts: r2(p.pts * k), reb: r2(p.reb * k), ast: r2(p.ast * k), tpm: r2(p.tpm * k) };
    });
    // Points that miss the book's number are not bent to it: the replay plays our projections, the same ones the picks
    // use, and a gap past 15% means a projection or the rotation is off, so the game waits for corrected inputs.
    players[t] = ps;
  });
  return fixes;
}

export function nflSimGames(week: FrozenWeek | null, held: HeldGame[] = [], fixed: FixedGame[] = []): SimGames["nfl"] {
  if (!week) return { season: null, week: null, games: [] };
  const games: NflSimGame[] = [];
  for (const [id, g] of Object.entries(week.games)) {
    const [, , away, home] = id.split("_");
    if (!away || !home || !g.teams[away] || !g.teams[home]) continue;
    const a = nflTeam(g.teams[away]), h = nflTeam(g.teams[home]);
    if (!a || !h) { held.push({ sport: "nfl", game: id, reasons: ["missing a passer, ball carriers, targets or implied total"] }); continue; }
    const game: NflSimGame = { id, away, home, kickoff: g.kickoff, teams: { [away]: a, [home]: h } };
    let bad = nflChecks(game);
    if (bad.length) {
      // a failed check is corrected and checked again; only a game that still fails is held back
      const fixes = repairNfl(game);
      bad = nflChecks(game);
      if (bad.length) { held.push({ sport: "nfl", game: id, reasons: fixes.length ? [...bad, `still failing after: ${fixes.join("; ")}`] : bad }); continue; }
      fixed.push({ sport: "nfl", game: id, fixes });
    }
    games.push(game);
  }
  games.sort((x, y) => (x.kickoff ?? "").localeCompare(y.kickoff ?? "") || x.id.localeCompare(y.id));
  return { season: week.season, week: week.week, games };
}

export function nbaSimGames(slate: Slate | null, held: HeldGame[] = [], fixed: FixedGame[] = []): SimGames["nba"] {
  if (!slate) return { date: null, games: [], players: {} };
  const by = new Map<string, Map<string, NbaSimPlayer & { usual: number }>>();
  const add = (team: string, id: string, name: string) => {
    const t = by.get(team) ?? new Map<string, NbaSimPlayer & { usual: number }>();
    by.set(team, t);
    const p = t.get(id) ?? { name, min: 0, usual: 0, pts: 0, reb: 0, ast: 0, tpm: 0 };
    t.set(id, p);
    return p;
  };
  if (slate.rotation?.length) {
    // the whole rotation, from the same projections the picks use
    for (const r of slate.rotation) {
      const p = add(r.team, r.player_id, r.player_name);
      p.usual = r.minutes ?? 0; p.min = r.minutes_expected ?? p.usual;
      p.pts = r.pts ?? 0; p.reb = r.reb ?? 0; p.ast = r.ast ?? 0; p.tpm = r.tpm ?? 0;
    }
  } else {
    for (const r of slate.rows) {
      if (r.out) continue;
      const p = add(r.team, r.player_id, r.player_name);
      p.usual = r.evidence?.minutes ?? 0;
      p.min = r.evidence?.minutes_expected ?? p.usual;
      const k = ({ points: "pts", rebounds: "reb", assists: "ast", threes: "tpm" } as const)[r.market as "points"];
      if (k) p[k] = r.mean;
    }
  }
  // Projections are his line when he plays his usual minutes; expected minutes also count the games he sat by the
  // coach's decision, and his expected line shrinks with them (a benched player keeps none of last season's minutes).
  for (const t of by.values()) for (const p of t.values()) {
    const k = p.usual > 0 ? Math.min(1, p.min / p.usual) : 1;
    p.min = Math.round(p.min * 10) / 10;
    for (const s of ["pts", "reb", "ast", "tpm"] as const) p[s] = r2(p[s] * k);
  }
  const players: SimGames["nba"]["players"] = {};
  const projected: Record<string, number> = {};
  for (const [team, m] of by) {
    const list = [...m.values()].filter((p) => p.min >= 4 && p.pts > 0).sort((a, b) => b.min - a.min)
      .map(({ usual: _, ...p }) => p);
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
    let bad = nbaChecks(game, players, projected);
    if (bad.length) {
      const fixes = repairNba(game, players);
      bad = nbaChecks(game, players, projected);
      if (bad.length) { held.push({ sport: "nba", game: key, reasons: fixes.length ? [...bad, `still failing after: ${fixes.join("; ")}`] : bad }); continue; }
      fixed.push({ sport: "nba", game: key, fixes });
    }
    games.push(game);
  }
  games.sort((x, y) => x.start.localeCompare(y.start) || x.home.localeCompare(y.home));
  const playing = new Set(games.flatMap((g) => [g.home, g.away]));
  return { date: slate.date, games, players: Object.fromEntries(Object.entries(players).filter(([t]) => playing.has(t))) };
}

type BoardPick = { sport: string; game_id: string; kickoff: string; matchup: string; who: string; player_id?: string; market: string;
  side: string; line: number | null; withdrawn?: boolean };
type Board = { board?: BoardPick[]; recent?: BoardPick[]; daily?: { picks?: BoardPick[]; recent?: BoardPick[] } };

/** The live picks (top 10, frozen picks of started games, picks of the day) on the games this page replays. */
export function simPicks(board: Board | null, nfl: SimGames["nfl"], nba: SimGames["nba"]): SimPick[] {
  if (!board) return [];
  const all = [...(board.board ?? []), ...(board.recent ?? []), ...(board.daily?.picks ?? []), ...(board.daily?.recent ?? [])];
  const nflIds = new Set(nfl.games.map((g) => g.id));
  // an NBA matchup repeats across a season: a pick belongs to tonight's game only if it tips within 12 hours of it
  const nbaStart = new Map(nba.games.map((g) => [`${g.away} at ${g.home}`, Date.parse(g.start)]));
  const out = new Map<string, SimPick>();
  for (const p of all) {
    if (p.withdrawn || !p.who || (p.sport !== "nfl" && p.sport !== "nba")) continue;
    const game = p.sport === "nfl" ? p.game_id : p.matchup;
    if (p.sport === "nfl" ? !nflIds.has(game) : Math.abs((nbaStart.get(game) ?? NaN) - Date.parse(p.kickoff)) > 12 * 3600e3 || !nbaStart.has(game)) continue;
    out.set(`${game}|${p.who}|${p.market}`, { sport: p.sport, game, who: p.who, player_id: p.player_id, market: p.market, side: p.side, line: p.line });
  }
  return [...out.values()];
}

/** Puts each live pin's posted inputs in place of the game's refreshed ones; returns the pins still in force. */
export function applyPins(pins: SimPin[], nfl: SimGames["nfl"], now = new Date()): SimPin[] {
  const live = pins.filter((p) => Date.parse(p.until) > now.getTime() && nfl.games.some((g) => g.id === p.game.id));
  for (const p of live) nfl.games = nfl.games.map((g) => (g.id === p.game.id ? p.game : g));
  return live;
}
