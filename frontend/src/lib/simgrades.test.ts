import { describe, expect, it } from "vitest";
import type { SimGames } from "./gamesims";
import { findEvent, freezeSims, gradeLine, gradeSim, parseBox, summarize, type FrozenSim } from "./simgrades";

const sims = {
  nba: { date: "2026-10-29", games: [{ away: "CLE", home: "ATL", start: "2026-10-30T00:00Z", total: 239.5, fav: "CLE", spread: 1.5, espn_id: "401" }],
    players: { CLE: [{ name: "Donovan Mitchell", min: 35, pts: 25.7, reb: 4.9, ast: 4.2, tpm: 2.6 }, { name: "CLE reserves", min: 10, pts: 4, reb: 2, ast: 1, tpm: 0.4, bench: true }],
      ATL: [{ name: "Jalen Johnson", min: 34, pts: 20.1, reb: 9.5, ast: 5.1, tpm: 1.2 }] } },
  nfl: { season: 2026, week: 8, games: [{ id: "2026_08_LA_SF", away: "LA", home: "SF", kickoff: "2026-11-02T21:25:00Z",
    teams: { LA: { implied: 24, players: [{ id: "x", name: "Matthew Stafford", pos: "QB", attempts: 35, pass_yards: 265, pass_tds: 1.8, interceptions: 0.7 }] },
      SF: { implied: 23, players: [{ id: "y", name: "Christian McCaffrey", pos: "RB", carries: 18, rush_yards: 80, receptions: 4, rec_yards: 35 }] } } }] },
} as unknown as SimGames;

const nbaSummary = {
  header: { competitions: [{ status: { type: { completed: true } }, competitors: [{ team: { abbreviation: "ATL" }, score: "112" }, { team: { abbreviation: "CLE" }, score: "119" }] }] },
  boxscore: { players: [
    { team: { abbreviation: "CLE" }, statistics: [{ labels: ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST"], athletes: [{ athlete: { displayName: "Donovan Mitchell" }, stats: ["36", "31", "11-20", "4-9", "5-6", "5", "6"] }] }] },
    { team: { abbreviation: "ATL" }, statistics: [{ labels: ["MIN", "PTS", "FG", "3PT", "FT", "REB", "AST"], athletes: [{ athlete: { displayName: "Jalen Johnson" }, stats: ["35", "18", "7-15", "1-3", "3-4", "11", "6"] }, { athlete: { displayName: "DNP Guy" }, stats: [] }] }] },
  ] },
};

describe("game sim grades", () => {
  it("freezes games that have not started, without reserves lines, and keeps the last version before the start", () => {
    const frozen: Record<string, FrozenSim> = {};
    freezeSims(sims, frozen, new Date("2026-10-29T20:00:00Z"));
    expect(Object.keys(frozen)).toEqual(["nba-2026-10-30-cle-atl", "nfl-2026-11-02-la-sf"]);
    const nba = frozen["nba-2026-10-30-cle-atl"];
    expect(nba.proj).toEqual({ CLE: 29.7, ATL: 20.1 });
    expect(nba.book).toEqual({ CLE: 120.5, ATL: 119 });
    expect(nba.players.map((p) => p.name)).toEqual(["Donovan Mitchell", "Jalen Johnson"]);
    // after tip-off the frozen version stays as it was
    const later = { ...sims, nba: { ...sims.nba, players: { ...sims.nba.players, ATL: [] } } } as SimGames;
    freezeSims(later, frozen, new Date("2026-10-30T01:00:00Z"));
    expect(frozen["nba-2026-10-30-cle-atl"].proj.ATL).toBe(20.1);
  });

  it("grades a game on ESPN's box score: winner, points and each player's stats", () => {
    const frozen: Record<string, FrozenSim> = {};
    freezeSims(sims, frozen, new Date("2026-10-29T20:00:00Z"));
    const box = parseBox("nba", nbaSummary)!;
    expect(box.players.get("CLE|donovan mitchell")).toEqual({ pts: 31, reb: 5, ast: 6, tpm: 4 });
    const g = gradeSim(frozen["nba-2026-10-30-cle-atl"], "401", box);
    expect(g.final).toEqual({ CLE: 119, ATL: 112 });
    expect(g.winner_right).toBe(true);
    expect(g.players.filter((p) => p.name === "Jalen Johnson").map((p) => `${p.stat} ${p.proj}->${p.actual}`)).toEqual(["pts 20.1->18", "reb 9.5->11", "ast 5.1->6", "tpm 1.2->1"]);
    expect(gradeLine(g)).toBe("CLE 119-112 ATL (sims CLE 30-20 ATL, winner ✓)");
    const s = summarize([g], "nba")!;
    expect(s).toMatchObject({ games: 1, winners: 1, book_miss: 4.3 });
    expect(s.stats.find((x) => x.stat === "pts")).toMatchObject({ n: 2, miss: 3.7, bias: 1.6 });
    expect(parseBox("nba", { header: { competitions: [{ status: { type: { completed: false } } }] } })).toBeNull();
  });

  it("reads NFL box scores by category and finds the game on ESPN's scoreboard (LA is LAR there)", () => {
    const frozen: Record<string, FrozenSim> = {};
    freezeSims(sims, frozen, new Date("2026-10-29T20:00:00Z"));
    const f = frozen["nfl-2026-11-02-la-sf"];
    expect(findEvent(f, { events: [{ id: 9, competitions: [{ competitors: [{ team: { abbreviation: "SF" } }, { team: { abbreviation: "LAR" } }] }] }] })).toBe("9");
    const box = parseBox("nfl", {
      header: { competitions: [{ status: { type: { completed: true } }, competitors: [{ team: { abbreviation: "LAR" }, score: "27" }, { team: { abbreviation: "SF" }, score: "20" }] }] },
      boxscore: { players: [
        { team: { abbreviation: "LAR" }, statistics: [{ name: "passing", labels: ["C/ATT", "YDS", "AVG", "TD", "INT"], athletes: [{ athlete: { displayName: "Matthew Stafford" }, stats: ["24/36", "301", "8.4", "3", "0"] }] }] },
        { team: { abbreviation: "SF" }, statistics: [
          { name: "rushing", labels: ["CAR", "YDS", "AVG", "TD"], athletes: [{ athlete: { displayName: "Christian McCaffrey" }, stats: ["17", "64", "3.8", "1"] }] },
          { name: "receiving", labels: ["REC", "YDS", "AVG", "TD"], athletes: [{ athlete: { displayName: "Christian McCaffrey" }, stats: ["5", "41", "8.2", "0"] }] }] },
      ] },
    })!;
    const g = gradeSim(f, "9", box);
    expect(g.final).toEqual({ LA: 27, SF: 20 });
    expect(g.winner_right).toBe(true);
    expect(g.players.map((p) => `${p.stat} ${p.actual}`)).toEqual(["pass_yards 301", "pass_tds 3", "interceptions 0", "rush_yards 64", "receptions 5", "rec_yards 41"]);
  });
});
