/* Optional AI mode for the Ask page. The visitor's own Anthropic API key stays in this browser (localStorage) and is
   sent only to api.anthropic.com. Claude answers only through tools that run the site's own answer functions, so
   every number it quotes comes from the published data. */
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema.mjs";
import {
  answerMatchup, answerWhyPicks, answerAny, answerDefense, answerDue, answerGames, answerGlossary, answerHitRates, answerLadder, answerLeaders, answerWhy, answerGame, answerInjuries, answerJson, answerParlay, answerPerGame, answerPlayer, answerPlayerLine, answerPriceCheck, answerProps, answerRecord, answerSleepers, answerTop,
  answerUnders, answerValue, gameLabel, parse, type AskData, type Filters,
} from "@/lib/ask";
import { WRITEUP_RULES, runAi, type AiTurn } from "@/lib/aiRunner";


const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const POSITION = { type: "string", enum: ["QB", "RB", "WR", "TE"], description: "Only this position" } as const;
const TEAMS = { type: "array", items: { type: "string" }, description: "Team codes such as CHI, NE, DET, LA (Rams), LAC, LV, JAX, WAS" } as const;
const DAY = { type: "string", enum: DAYS, description: "Only games on this weekday" } as const;
const SIDE = { type: "string", enum: ["over", "under"] } as const;

function filters(i: { position?: string; teams?: string[]; day?: string; include_questionable?: boolean }): Filters {
  return { position: i.position, teams: i.teams?.map((t) => t.toUpperCase()), day: i.day ? DAYS.indexOf(i.day) : undefined, safe: i.include_questionable ? false : undefined };
}
const out = (x: unknown) => JSON.stringify(x);

function tools(d: AskData) {
  const markets = Object.keys(d.props);
  const MARKET = { type: "string", enum: markets, description: "Prop market" } as const;
  return [
    betaTool({
      name: "list_games", description: "This week's games with kickoff day and time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => {
        const m = new Map<string, { game: string; day: string | null; kickoff: string | null }>();
        for (const r of d.td) if (r.game_id && !m.has(r.game_id)) m.set(r.game_id, { game: gameLabel(r.game_id), day: r.gameday ?? null, kickoff: r.gametime ?? null });
        return out({ season: d.season, week: d.week, games: [...m.values()], prices_loaded: !!d.feed.at, prices_as_of: d.feed.at });
      },
    }),
    betaTool({
      name: "top_td_scorers", description: "Players most likely to score an anytime TD this week, with validated chance, confidence tier and best sportsbook price. Leaves out Questionable/Doubtful players unless include_questionable.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 40 }, position: POSITION, teams: TEAMS, day: DAY, include_questionable: { type: "boolean" } }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerTop(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "safest_any_market", description: "The most likely bets across EVERY market (anytime TD and all player props, likelier side), one per player, highest chance first. Use for 'safest pick', 'any prop', 'best bets' questions that do not name a market. Props use book lines when loaded, else the player's usual line (flagged).",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 25 }, exclude_td: { type: "boolean", description: "Leave out anytime TD bets" }, position: POSITION, teams: TEAMS, day: DAY, include_questionable: { type: "boolean" } }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerAny(d, i.limit, filters(i), i.exclude_td))),
    }),
    betaTool({
      name: "best_per_game", description: "The single most likely leg in each game (anytime TD by default, a prop market, or 'any' for the best leg across all markets, 'any-props' for all markets except TD), plus how likely several of them hit together.",
      inputSchema: { type: "object", properties: { market: { type: "string", enum: ["td", "any", "any-props", ...markets] }, position: POSITION, day: DAY }, additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerPerGame(d, i.market ?? "td", filters(i)))),
    }),
    betaTool({
      name: "prop_picks", description: "Most likely over/under sides for a prop market at the line most books offer. If no lines are loaded, returns projections (median and 80% range) instead.",
      inputSchema: { type: "object", properties: { market: MARKET, side: SIDE, limit: { type: "integer", minimum: 1, maximum: 30 }, position: POSITION, teams: TEAMS, day: DAY }, required: ["market", "limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerProps(d, i.market, i.limit, filters(i), i.side))),
    }),
    betaTool({
      name: "value_bets", description: "Legs where our chance beats the chance implied by the best US sportsbook price by at least 3 points, widest edge first.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30 }, markets: { type: "array", items: { type: "string", enum: ["td", ...markets] } }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerValue(d, i.limit, filters(i), i.markets))),
    }),
    betaTool({
      name: "build_parlay", description: "Builds a parlay with 40,000 correlated simulations: either the most likely combination, or (value=true) only legs that beat the best price, combined for the highest expected return. market 'any' (the default) draws from every market: anytime TD and every prop; use 'td' only when the visitor asks for touchdowns.",
      inputSchema: { type: "object", properties: { legs: { type: "integer", minimum: 2, maximum: 8 }, market: { type: "string", enum: ["any", "td", ...markets] }, value: { type: "boolean" }, same_game: { type: "boolean", description: "Allow several legs from one game" }, position: POSITION, teams: TEAMS, day: DAY }, required: ["legs"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerParlay(d, i.legs, filters(i), { market: i.market, value: i.value, sameGame: i.same_game }))),
    }),
    betaTool({
      name: "player_lookup", description: "Every validated chance for one or more players this week (anytime TD and props).",
      inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 } }, required: ["names"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.names.join(" and ")).players;
        return ids.length ? out(answerJson(answerPlayer(d, ids))) : out({ error: "No player with that name has chances this week." });
      },
    }),
    betaTool({
      name: "explain_pick", description: "Why the model leans the way it does on one player: the line, projection and range, his recent games against the line, season/last-3/typical averages, the opponent's defense against his position, his role (targets, share, snaps), game script (implied points), the factors supporting the lean and the factors working against it, plus the tier's past hit rate. Use for any 'why' or 'explain' question.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "Player name" }, market: { type: "string", enum: ["td", ...markets], description: "Leave out to explain his strongest lean" }, side: SIDE }, required: ["name"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.name).players;
        return ids.length ? out(answerJson(answerWhy(d, ids, i.market, i.side)))
          : out({ error: "No player with that name has chances this week." });
      },
    }),
    betaTool({
      name: "game_matchup", description: "Why one team is favored and how a game sets up: the betting line's implied points for each team (the site does not model NFL spreads), each defense's points, TDs and expected TDs allowed, red-zone TD rate, TDs allowed by position vs league, scheme rates (blitz, pressure, man/zone, box counts, top coverage shell) vs league, the injury report, the most likely TD scorers and strongest prop sides. Use for 'why is X favored', 'who wins', 'break down X vs Y', 'preview'.",
      inputSchema: { type: "object", properties: { teams: TEAMS }, required: ["teams"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerMatchup(d, i.teams.map((t) => t.toUpperCase())))),
    }),
    betaTool({
      name: "explain_top_picks", description: "The strongest proven picks this week across every market, each with the factors for it, the factors against it, its key numbers and its tier's record on unseen weeks. Use for 'why these picks', 'explain your best bets', 'how confident are you in your picks'.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 5 }, exclude_td: { type: "boolean" }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerWhyPicks(d, i.limit, filters(i), i.exclude_td))),
    }),
    betaTool({
      name: "hit_rates", description: "Player props where he cleared the line in at least `threshold` of his last `window` games (e.g. 1.0 = 100%), at the highest line that holds (lowest for unders), with this week's model chance beside each. Use for hit-rate, 'every game', streak and 'hasn't missed' questions.",
      inputSchema: { type: "object", properties: { threshold: { type: "number", minimum: 0.5, maximum: 1 }, window: { type: "integer", enum: [5, 8, 16] }, side: SIDE,
        markets: { type: "array", items: { type: "string", enum: markets } }, limit: { type: "integer", minimum: 1, maximum: 40 }, position: POSITION, teams: TEAMS, day: DAY },
        required: ["threshold", "limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerHitRates(d, i.limit, filters(i), { threshold: i.threshold, window: i.window, side: i.side, markets: i.markets }))),
    }),
    betaTool({
      name: "player_line_ladder", description: "Every line for one player in one market: this week's model over/under chance and how often he cleared each line in his last 5 and last N games (alt lines). Use for 'how often has X gone over Y' questions.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, market: MARKET, window: { type: "integer", enum: [5, 8, 16] } }, required: ["name"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.name).players;
        return ids.length ? out(answerJson(answerLadder(d, ids, i.market, i.window ?? 8))) : out({ error: "No player with that name has props this week." });
      },
    }),
    betaTool({
      name: "defense_matchups", description: "Each defense's touchdowns allowed to a position vs league average (from games before this week) and who they face this week. toughest=true sorts the stingiest first.",
      inputSchema: { type: "object", properties: { position: POSITION, toughest: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 32 } }, required: ["position"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerDefense(d, i.position, !!i.toughest, i.limit ?? 10))),
    }),
    betaTool({
      name: "game_totals", description: "This week's games ranked by projected total points (from the spread and total), with each team's implied points.",
      inputSchema: { type: "object", properties: { lowest_first: { type: "boolean" }, day: DAY }, additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerGames(d, filters(i), !!i.lowest_first))),
    }),
    betaTool({
      name: "projection_leaders", description: "Players with the highest (or lowest) projection in a prop market this week, with the 80% range and last-3 average.",
      inputSchema: { type: "object", properties: { market: MARKET, lowest: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 30 }, position: POSITION, teams: TEAMS, day: DAY }, required: ["market"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerLeaders(d, i.market, i.limit ?? 10, filters(i), !!i.lowest))),
    }),
    betaTool({
      name: "explain_term", description: "Plain definitions of the site's terms: tiers, edge, xTD, due, usual line, scores out of 10, walk-forward testing, hit rate, simulations, projection and range.",
      inputSchema: { type: "object", properties: { term: { type: "string" } }, required: ["term"], additionalProperties: false } as const,
      run: async (i) => out(answerGlossary(i.term.toLowerCase()) ?? { error: "Not a term the site defines." }),
    }),
    betaTool({
      name: "game_breakdown", description: "Most likely TD scorers and strongest prop sides in the game involving the given team(s).",
      inputSchema: { type: "object", properties: { teams: TEAMS }, required: ["teams"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerGame(d, i.teams.map((t) => t.toUpperCase()), {}))),
    }),
    betaTool({
      name: "unders", description: "Players most likely to fall short of a line (unders), with the matchup and form reasons behind each: opponent defense vs the position, recent games, role, team scoring outlook. Uses the book line when loaded, else the player's usual line.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 30 }, markets: { type: "array", items: { type: "string", enum: markets } }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerUnders(d, i.limit, filters(i), i.markets))),
    }),
    betaTool({
      name: "longshot_td", description: "TD picks with a 20-35% chance (bigger payouts), ranked by edge over the best price when prices are loaded.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, position: POSITION, teams: TEAMS }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerSleepers(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "due_for_td", description: "Players who have scored at least 1.5 fewer TDs this season than their carries and targets predicted (expected TDs), with how such players have scored in the past. Their chance already includes that opportunity.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 20 }, position: POSITION, teams: TEAMS, day: DAY }, required: ["limit"], additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerDue(d, i.limit, filters(i)))),
    }),
    betaTool({
      name: "injury_report", description: "Skill players on this week's official injury report with their TD chance.",
      inputSchema: { type: "object", properties: { teams: TEAMS }, additionalProperties: false } as const,
      run: async (i) => out(answerJson(answerInjuries(d, filters(i)))),
    }),
    betaTool({
      name: "player_line", description: "One player's chance at an exact line in one prop market ('Will Puka go over 6.5 receptions?', 'Goff 2+ passing TDs' = pass_tds over 1.5, 'Mahomes 250 passing yards' = over 249.5), with his recent games against that line and whether the books post it.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, market: MARKET, line: { type: "number", description: "A half-point line, e.g. 6.5" }, side: SIDE }, required: ["name", "market", "line"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.name).players;
        return ids.length ? out(answerJson(answerPlayerLine(d, ids.slice(0, 1), i.market, i.side ?? "over", i.line))) : out({ error: "No player with that name has numbers this week." });
      },
    }),
    betaTool({
      name: "price_check", description: "Is a bet worth it at a given American price? Compares our chance with the chance the price implies and gives our fair price. Use for 'is X a good bet at -160', 'Gibbs at -330 worth it', or when the visitor lists their own slip prices. market defaults to anytime TD.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, price: { type: "integer", description: "American odds, e.g. -160 or 250" }, market: { type: "string", enum: ["td", ...markets] }, line: { type: "number" }, side: SIDE }, required: ["name", "price"], additionalProperties: false } as const,
      run: async (i) => {
        const ids = parse(d, i.name).players;
        return ids.length ? out(answerJson(answerPriceCheck(d, ids.slice(0, 1), i.price, i.market ?? "td", i.side, i.line))) : out({ error: "No player with that name has numbers this week." });
      },
    }),
    betaTool({
      name: "model_record", description: "How often past picks in each confidence tier actually hit on unseen weeks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
      run: async () => out(answerJson(answerRecord(d))),
    }),
  ];
}

const SYSTEM = `You are the NFL question box on The Lab, a sports analytics site covering NFL, college football and NBA (this box answers NFL touchdowns and player props). Answer the visitor's betting question for the current week using only the tools.

Rules:
- Every chance, price, line, edge, projection and hit rate you mention must come from a tool result in this conversation. Never estimate, round up or add numbers of your own. If the tools do not cover something (weather, news, a market the site does not model), say so plainly.
- Chances are validated model probabilities; "tier" and "tier_past_hit_rate" say how often past picks in that range hit. Prefer higher chances and, when prices are loaded, real edges. Mention injury notes.
- Match the market to the question. Only use TD tools when the visitor asks about touchdowns or scorers. If they say "any prop", "any market", "safest pick" or name no market, use safest_any_market (or best_per_game with market "any" for one per game).
- Suggested picks and parlays come only from confidence tiers that hit 50%+ on unseen weeks; the tools already apply that, so do not pad a list or parlay with weaker legs. If a tool returns fewer legs than asked, say why.
- Prop chances already blend a 5,000-run simulation of each game where it proved more accurate. Mention it when asked how picks are made (explain_term "how picks are made").
- When the visitor names a price ("at -160", "+250", a slip), call price_check for each player and say plainly whether it is value, fair or overpriced. When they name an exact line for a player, call player_line.
- For "why" questions about a player, call explain_pick (and price_check when a price is named); about a team or game, call game_matchup; about the site's picks as a group, call explain_top_picks. Answer from their numbers: what supports the lean, what works against it, the price, the tier's record and how confident the model is. Do not invent factors the tools did not return.
- You can answer a wide range of questions: picks by market, position, team, game or day; parlays; value vs the books; unders; hit rates and streaks; a player's alt-line ladder; defenses and matchups; game totals; projection leaders; due players; injuries; the model's record; and what the site's terms mean. Combine tools for multi-part questions (for example game_totals then best_per_game).
- Call several tools when the question needs it (for example list_games, then best_per_game). Pass filters (position, teams, day) when the question names them.
- For list questions, keep the answer short and scannable: a one-line lead, then a list of picks (player, team, bet, our chance, best price if any), then at most two short caveats. No guarantees; book prices are sharp and no bet is a sure thing.

${WRITEUP_RULES}`;

export type { AiTurn };

export async function askAi(key: string, d: AskData, question: string, history: AiTurn[], onStatus?: (s: string) => void): Promise<string> {
  return runAi(key, `${SYSTEM}\n\nThis is ${d.season} week ${d.week}.`, tools(d), question, history, onStatus);
}
