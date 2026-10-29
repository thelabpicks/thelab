/* Grades each game simulation against the real final, after every NBA and NFL game (scripts/sim-grades.ts, run by the
   "Refresh data and publish site" workflow). A game is frozen as it stood at tip-off or kickoff: each team's projected
   points (what the sims center on), the book's line, and every player's projected line. After the game it is graded on
   the final ESPN box score: winner, each team's points, the total, and every player's stats. The grades go into the
   daily report and the Sims page's track record. The projections themselves come from the models, which refit on
   every graded game; these grades show where the sims' inputs ran high or low. */
import type { SimGames } from "./gamesims";

export type Sport = "nba" | "nfl";
const NBA_STATS = ["pts", "reb", "ast", "tpm"] as const;
const NFL_STATS = ["pass_yards", "pass_tds", "interceptions", "rush_yards", "receptions", "rec_yards"] as const;
type Stat = (typeof NBA_STATS)[number] | (typeof NFL_STATS)[number];
export const STAT_LABEL: Record<Stat, string> = {
  pts: "points", reb: "rebounds", ast: "assists", tpm: "threes", pass_yards: "passing yards", pass_tds: "passing TDs",
  interceptions: "interceptions", rush_yards: "rushing yards", receptions: "receptions", rec_yards: "receiving yards",
};

/** A game as the sims saw it at the start. proj: each team's projected points; book: the book's points for each team
 *  (NBA total and spread split; NFL: the implied totals the sims are tuned to, so the same as proj). */
export type FrozenSim = {
  key: string; sport: Sport; espn_id?: string; start: string; away: string; home: string;
  proj: Record<string, number>; book: Record<string, number> | null;
  players: { team: string; name: string; stats: Partial<Record<Stat, number>> }[];
};
export type PlayerGrade = { team: string; name: string; stat: Stat; proj: number; actual: number };
export type SimGrade = {
  key: string; sport: Sport; start: string; away: string; home: string; espn_id: string;
  final: Record<string, number>; proj: Record<string, number>; book: Record<string, number> | null;
  winner_right: boolean; players: PlayerGrade[]; graded_at: string;
};
export type SimArchive = { frozen: Record<string, FrozenSim>; grades: SimGrade[]; given_up?: string[] };

const r1 = (x: number) => Math.round(x * 10) / 10;
const date = (iso: string) => iso.slice(0, 10);

/** Keeps each game's latest inputs until it starts (a pinned replay keeps the inputs that were posted). */
export function freezeSims(sims: SimGames, frozen: Record<string, FrozenSim>, now = new Date()) {
  const keep = (f: FrozenSim) => { if (Date.parse(f.start) > now.getTime()) frozen[f.key] = f; };
  for (const g of sims.nba.games) {
    const ps = (t: string) => (sims.nba.players[t] ?? []).filter((p) => !p.bench);
    const total = (t: string) => r1((sims.nba.players[t] ?? []).reduce((s, p) => s + p.pts, 0));
    const hi = (g.total + g.spread) / 2, lo = (g.total - g.spread) / 2;
    keep({
      key: `nba-${date(g.start)}-${g.away}-${g.home}`.toLowerCase(), sport: "nba", espn_id: g.espn_id, start: g.start, away: g.away, home: g.home,
      proj: { [g.away]: total(g.away), [g.home]: total(g.home) },
      book: { [g.away]: g.fav === g.away ? hi : lo, [g.home]: g.fav === g.home ? hi : lo },
      players: [g.away, g.home].flatMap((t) => ps(t).map((p) => ({ team: t, name: p.name, stats: { pts: p.pts, reb: p.reb, ast: p.ast, tpm: p.tpm } }))),
    });
  }
  for (const g of sims.nfl.games) {
    if (!g.kickoff) continue;
    const implied = { [g.away]: g.teams[g.away].implied, [g.home]: g.teams[g.home].implied };
    keep({
      key: `nfl-${date(g.kickoff)}-${g.away}-${g.home}`.toLowerCase(), sport: "nfl", start: g.kickoff, away: g.away, home: g.home,
      proj: implied, book: implied,
      players: [g.away, g.home].flatMap((t) => g.teams[t].players.map((p) => ({ team: t, name: p.name,
        stats: Object.fromEntries(NFL_STATS.filter((k) => p[k] != null).map((k) => [k, p[k]!])) }))),
    });
  }
}

/** nflverse team abbreviations that ESPN spells differently. */
const ESPN_NFL: Record<string, string> = { LA: "LAR", WAS: "WSH" };
export const espnTeam = (sport: Sport, t: string) => (sport === "nfl" ? ESPN_NFL[t] ?? t : t);

/** The ESPN event of a frozen game in a scoreboard response (by both teams), when it is final. */
export function findEvent(f: FrozenSim, scoreboard: { events?: Espn[] } | null): string | null {
  const want = new Set([espnTeam(f.sport, f.away), espnTeam(f.sport, f.home)]);
  for (const e of scoreboard?.events ?? []) {
    const teams = (e.competitions?.[0]?.competitors ?? []).map((c: Espn) => c.team?.abbreviation);
    if (teams.length === 2 && teams.every((t: string) => want.has(t))) return String(e.id);
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Espn = any;
export const normName = (n: string) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "")
  .split(" ").filter((w) => w && !["jr", "sr", "ii", "iii", "iv", "v"].includes(w)).join(" ");

/** Final score and each player's stats from an ESPN game summary, or null while the game is not final. */
export function parseBox(sport: Sport, summary: Espn): { final: Record<string, number>; players: Map<string, Partial<Record<Stat, number>>> } | null {
  const comp = summary?.header?.competitions?.[0];
  if (!comp?.status?.type?.completed) return null;
  const final: Record<string, number> = {};
  for (const c of comp.competitors ?? []) final[c.team.abbreviation] = Number(c.score);
  const players = new Map<string, Partial<Record<Stat, number>>>();
  const num = (x: string | undefined) => (x == null || x === "" || x === "--" ? 0 : Number(x) || 0);
  // made-attempted ("3-7"): the made part
  const made = (x: string | undefined) => num(x == null ? x : String(x).split(/[-/]/)[0]);
  for (const team of summary?.boxscore?.players ?? []) {
    for (const cat of team.statistics ?? []) {
      const labels: string[] = (cat.labels ?? cat.names ?? []).map((l: string) => l.toUpperCase());
      const at = (a: Espn, l: string) => { const i = labels.indexOf(l); return i < 0 ? undefined : a.stats?.[i]; };
      for (const a of cat.athletes ?? []) {
        if (!a.athlete?.displayName || !a.stats?.length) continue;
        const k = `${team.team.abbreviation}|${normName(a.athlete.displayName)}`;
        const p = players.get(k) ?? {};
        players.set(k, p);
        if (sport === "nba") {
          p.pts = num(at(a, "PTS")); p.reb = num(at(a, "REB")); p.ast = num(at(a, "AST")); p.tpm = made(at(a, "3PT"));
        } else if (cat.name === "passing") {
          p.pass_yards = num(at(a, "YDS")); p.pass_tds = num(at(a, "TD")); p.interceptions = num(at(a, "INT"));
        } else if (cat.name === "rushing") {
          p.rush_yards = num(at(a, "YDS"));
        } else if (cat.name === "receiving") {
          p.receptions = num(at(a, "REC")); p.rec_yards = num(at(a, "YDS"));
        }
      }
    }
  }
  return { final, players };
}

/** Grades a frozen game on its box score. Players who did not appear are left out (a scratch is not a projection miss;
 *  the props grading and the post-game reviews count those). */
export function gradeSim(f: FrozenSim, espnId: string, box: NonNullable<ReturnType<typeof parseBox>>, now = new Date()): SimGrade {
  const team = (t: string) => espnTeam(f.sport, t);
  const final = { [f.away]: box.final[team(f.away)] ?? 0, [f.home]: box.final[team(f.home)] ?? 0 };
  const players: PlayerGrade[] = [];
  for (const p of f.players) {
    const got = box.players.get(`${team(p.team)}|${normName(p.name)}`);
    if (!got) continue;
    for (const [stat, proj] of Object.entries(p.stats) as [Stat, number][]) {
      if (got[stat] != null) players.push({ team: p.team, name: p.name, stat, proj: r1(proj), actual: got[stat]! });
    }
  }
  const sign = (x: number) => Math.sign(x);
  return {
    key: f.key, sport: f.sport, start: f.start, away: f.away, home: f.home, espn_id: espnId, final, proj: f.proj, book: f.book,
    winner_right: sign(f.proj[f.home] - f.proj[f.away]) === sign(final[f.home] - final[f.away]), players, graded_at: now.toISOString(),
  };
}

export type StatSummary = { stat: Stat; label: string; n: number; miss: number; bias: number };
export type SimSummary = {
  sport: Sport; games: number; winners: number; team_miss: number; team_bias: number; book_miss: number | null;
  total_miss: number; total_bias: number; stats: StatSummary[];
};

/** How the sims did over a set of graded games: winners picked, the typical miss and the lean (actual minus projected)
 *  of each team's points and the game total, the book's miss for comparison (NBA), and each player stat's miss and lean. */
export function summarize(grades: SimGrade[], sport: Sport): SimSummary | null {
  const gs = grades.filter((g) => g.sport === sport);
  if (!gs.length) return null;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const teamErr = gs.flatMap((g) => [g.away, g.home].map((t) => g.final[t] - g.proj[t]));
  const bookErr = sport === "nba" ? gs.filter((g) => g.book).flatMap((g) => [g.away, g.home].map((t) => g.final[t] - g.book![t])) : [];
  const totErr = gs.map((g) => g.final[g.away] + g.final[g.home] - g.proj[g.away] - g.proj[g.home]);
  const stats = (sport === "nba" ? NBA_STATS : NFL_STATS).map((stat) => {
    const xs = gs.flatMap((g) => g.players.filter((p) => p.stat === stat).map((p) => p.actual - p.proj));
    return { stat, label: STAT_LABEL[stat], n: xs.length, miss: r1(mean(xs.map(Math.abs))), bias: r1(mean(xs)) };
  }).filter((x) => x.n);
  return {
    sport, games: gs.length, winners: gs.filter((g) => g.winner_right).length,
    team_miss: r1(mean(teamErr.map(Math.abs))), team_bias: r1(mean(teamErr)), book_miss: bookErr.length ? r1(mean(bookErr.map(Math.abs))) : null,
    total_miss: r1(mean(totErr.map(Math.abs))), total_bias: r1(mean(totErr)), stats,
  };
}

/** One line per graded game for the daily report: "CLE 119-112 ATL (sims: CLE 124-110, winner ✓)". */
export function gradeLine(g: SimGrade): string {
  const s = (x: Record<string, number>) => `${g.away} ${Math.round(x[g.away])}-${Math.round(x[g.home])} ${g.home}`;
  const misses = g.players.map((p) => ({ ...p, d: p.actual - p.proj })).filter((p) => Math.abs(p.d) >= Math.max(6, 0.6 * p.proj))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 2)
    .map((p) => `${p.name} ${p.actual} ${STAT_LABEL[p.stat]} (sims ${p.proj})`);
  return `${s(g.final)} (sims ${s(g.proj)}, winner ${g.winner_right ? "✓" : "✗"})${misses.length ? `; biggest misses: ${misses.join(", ")}` : ""}`;
}
