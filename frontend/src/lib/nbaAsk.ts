/* NBA Ask: plain-English questions answered only from the published files (slate, confidence, markets, record, Due
   study, correlation). It never invents a number: every chance is read from a published distribution, every parlay
   is simulated with the published same-game links, and every claim about accuracy quotes the published backtest.
   Any question gets an answer: when nothing specific is recognised it says what it read and shows tonight's
   strongest leans. */
import { MIN_LINE, NBA_MARKETS, bestOffer, bookName, edgeOf, leanOf, marketLabel, overAt, starsOf, suggestable, type MarketReport, type NbaGame, type NbaConfidence, type NbaDue,
  type NbaRecord, type NbaRow, type NbaStatus, type Slate } from "./nba";
import type { Buckets, SimLeg } from "./sim";
import { simulate } from "./sim";
import { tidy, type Section } from "./writeup";

export type AskItem = { row: NbaRow; side: "over" | "under"; line: number; p: number; note?: string };
export type AskAnswer = {
  title: string; text?: string; items: AskItem[]; bullets?: string[]; sections?: Section[];
  parlay?: { joint: number; independent: number; draws: number };
  suggestions?: string[];
};
export type AskContext = { conf?: NbaConfidence; markets?: { markets: MarketReport[] }; record?: NbaRecord; due?: NbaDue; status?: NbaStatus };

// ---------------------------------------------------------------------------- vocabulary
const MARKET_WORDS: [RegExp, string][] = [
  [/\b(pra|p\s*\+\s*r\s*\+\s*a|pts\s*\+\s*reb\s*\+\s*ast|points,? rebounds,? (and|&|\+) assists|points rebounds assists|combined stats?)\b/, "pra"],
  [/\b(threes?|3s|3-?pointers?|three-?pointers?|3pm|3pt|triples?|from (deep|downtown|three)|treys?)\b/, "threes"],
  [/\b(rebounds?|boards?|reb|rebs|rebounding|rebounder)\b/, "rebounds"],
  [/\b(assists?|dimes?|ast|asts|passing|passer|playmak\w*|dish\w*)\b/, "assists"],
  [/\b(points?|pts|scor\w*|buckets|bucket|drop \d+|put up \d+)\b/, "points"],
];
const TEAM_WORDS: Record<string, string> = {
  hawks: "ATL", atlanta: "ATL", celtics: "BOS", boston: "BOS", nets: "BKN", brooklyn: "BKN", hornets: "CHA", charlotte: "CHA",
  bulls: "CHI", chicago: "CHI", cavaliers: "CLE", cavs: "CLE", cleveland: "CLE", mavericks: "DAL", mavs: "DAL", dallas: "DAL",
  nuggets: "DEN", denver: "DEN", pistons: "DET", detroit: "DET", warriors: "GS", dubs: "GS", "golden state": "GS", rockets: "HOU",
  houston: "HOU", pacers: "IND", indiana: "IND", clippers: "LAC", clips: "LAC", lakers: "LAL", grizzlies: "MEM", grizz: "MEM",
  memphis: "MEM", heat: "MIA", miami: "MIA", bucks: "MIL", milwaukee: "MIL", timberwolves: "MIN", wolves: "MIN", minnesota: "MIN",
  pelicans: "NO", pels: "NO", "new orleans": "NO", knicks: "NY", "new york": "NY", thunder: "OKC", okc: "OKC", "oklahoma city": "OKC",
  magic: "ORL", orlando: "ORL", "76ers": "PHI", sixers: "PHI", philly: "PHI", philadelphia: "PHI", suns: "PHX", phoenix: "PHX",
  "trail blazers": "POR", blazers: "POR", portland: "POR", kings: "SAC", sacramento: "SAC", spurs: "SA", "san antonio": "SA",
  raptors: "TOR", raps: "TOR", toronto: "TOR", jazz: "UTAH", utah: "UTAH", wizards: "WSH", washington: "WSH",
};
const NICKNAMES: Record<string, string> = {
  sga: "shai gilgeous-alexander", shai: "shai gilgeous-alexander", bron: "lebron james", "king james": "lebron james",
  joker: "nikola jokic", jokic: "nikola jokic", giannis: "giannis antetokounmpo", "greek freak": "giannis antetokounmpo",
  kat: "karl-anthony towns", "the brow": "anthony davis", jjj: "jaren jackson jr.", wemby: "victor wembanyama",
  "spida": "donovan mitchell", "the beard": "james harden", "chef curry": "stephen curry", steph: "stephen curry", dame: "damian lillard",
  "jdub": "jalen williams", "j dub": "jalen williams", "chet": "chet holmgren", "cp3": "chris paul", "pg13": "paul george",
  "embiid": "joel embiid", "the process": "joel embiid", kcp: "kentavious caldwell-pope", "jt": "jayson tatum", "dlo": "d'angelo russell", "ad": "anthony davis", "jb": "jaylen brown", "jimmy buckets": "jimmy butler", "ant": "anthony edwards", "ant man": "anthony edwards", "kd": "kevin durant",
};
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const POS: [RegExp, string][] = [[/\b(guards?|point guards?|pgs?|shooting guards?)\b/, "G"], [/\b(forwards?|wings?)\b/, "F"], [/\b(centers?|bigs?|big men|bigmen)\b/, "C"]];

export const plain = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmt = (x: number, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
const pctS = (p: number | null) => (p == null ? "—" : `${Math.round(p * 100)}%`);
const score = (p: number) => (p * 10).toFixed(1);
const sideWord = (s: "over" | "under") => (s === "over" ? "Over" : "Under");

function marketsOf(q: string): string[] {
  const found: string[] = [];
  let rest = q;
  for (const [re, m] of MARKET_WORDS) if (re.test(rest)) { found.push(m); if (m === "pra") rest = rest.replace(re, " "); }
  return found;
}
function teamsOf(q: string): string[] {
  const out: string[] = [];
  for (const [w, t] of Object.entries(TEAM_WORDS)) if (new RegExp(`\\b${w}\\b`).test(q) && !out.includes(t)) out.push(t);
  for (const t of ["atl", "bos", "bkn", "cha", "chi", "cle", "dal", "den", "det", "hou", "ind", "lac", "lal", "mem", "mia", "mil", "nyk", "phi", "phx", "por", "sac", "tor", "wsh"]) {
    const code = ({ nyk: "NY" } as Record<string, string>)[t] ?? t.toUpperCase();
    if (new RegExp(`\\b${t}\\b`).test(q) && !out.includes(code)) out.push(code);
  }
  return out;
}
function countOf(q: string, fallback: number): number {
  const m = q.match(/\b(\d+)[- ]?(leg|legs|picks?|players?|bets?|plays?|props?|guys|names|man|team)\b/) || q.match(/\btop (\d+)\b/) || q.match(/\b(\d+)[- ]?(best|strongest|safest)\b/);
  const w = q.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)[- ]?(leg|legs|picks?|players?|bets?|plays?|props?|best|guys)\b/)
    || q.match(/\btop (one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b/);
  return Math.max(1, Math.min(25, Number(m?.[1]) || (w ? WORD_NUM[w[1]] : 0) || fallback));
}
/** "25 points", "score 30", "25+", "at least 8", "over 7.5": the number the question asks about, and whether it's a line. */
function numberOf(question: string): { value: number; isLine: boolean; side?: "over" | "under" } | null {
  // counts ("3-leg", "top 5", "last 10 games") are not thresholds
  const q = question.replace(/\b\d+[- ]?(leg|legs|picks?|players?|bets?|plays?|props?|guys|names|games?)\b/g, " ").replace(/\b(top|last|past) \d+\b/g, " ");
  const line = q.match(/\b(over|under|o|u)\s*(\d+(?:\.5)?)\b/);
  if (line) return { value: Number(line[2]), isLine: true, side: line[1].startsWith("o") ? "over" : "under" };
  const half = q.match(/\b(\d+\.5)\b/);
  if (half) return { value: Number(half[1]), isLine: true };
  const m = q.match(/\b(\d+)\s*\+/) || q.match(/\b(?:at least|atleast|more than|over|reach|hit|get|score|scores|drop|put up|have|record|grab|dish|make|hits?)\s+(\d+)\b/)
    || q.match(/\b(\d+)\s*(?:or more|plus|points?|pts|rebounds?|boards|assists?|dimes|threes?|3s|pra)\b/);
  if (m) {
    const v = Number(m[1]);
    if (v >= 1 && v <= 80) {
      const lessThan = new RegExp(`\\b(less than|fewer than|under|below)\\s+${v}\\b`).test(q);
      return lessThan ? { value: v - 0.5, isLine: true, side: "under" } : { value: v, isLine: false };
    }
  }
  return null;
}
function positionOf(q: string): string | null {
  for (const [re, p] of POS) if (re.test(q)) return p;
  return null;
}

type Player = { id: string; name: string; rows: NbaRow[]; shared?: string };
function playersIn(q: string, rows: NbaRow[]): Player[] {
  const byId = new Map<string, Player>();
  for (const r of rows) {
    const p = byId.get(r.player_id) ?? { id: r.player_id, name: r.player_name, rows: [] };
    p.rows.push(r); byId.set(r.player_id, p);
  }
  let text = ` ${q} `;
  for (const [nick, full] of Object.entries(NICKNAMES)) if (new RegExp(`\\b${nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)) text += ` ${plain(full)} `;
  const lastCount = new Map<string, number>(), firstCount = new Map<string, number>();
  for (const p of byId.values()) {
    const parts = plain(p.name).replace(/[^a-z' -]/g, "").split(/[ -]/).filter((w) => !["jr", "sr", "ii", "iii", "iv"].includes(w));
    lastCount.set(parts[parts.length - 1], (lastCount.get(parts[parts.length - 1]) ?? 0) + 1);
    firstCount.set(parts[0], (firstCount.get(parts[0]) ?? 0) + 1);
  }
  const hits: { p: Player; at: number }[] = [];
  for (const p of byId.values()) {
    const full = plain(p.name).replace(/\./g, "");
    const parts = full.replace(/[^a-z' -]/g, "").split(/[ -]/).filter((w) => !["jr", "sr", "ii", "iii", "iv"].includes(w));
    const last = parts[parts.length - 1], first = parts[0];
    let at = text.indexOf(full);
    if (at < 0 && last.length >= 3 && lastCount.get(last) === 1) at = text.search(new RegExp(`\\b${last}\\b`));
    if (at < 0 && first.length >= 4 && firstCount.get(first) === 1 && !TEAM_WORDS[first]) at = text.search(new RegExp(`\\b${first}\\b`));
    // last names that share a team word ("Mitchell" twice) need the first name too
    if (at < 0 && lastCount.get(last)! > 1) at = text.search(new RegExp(`\\b${first}\\b.{0,3}\\b${last}\\b`));
    if (at >= 0) hits.push({ p, at });
  }
  // a last name two players share ("Mitchell", "Brown") with no first name: offer both
  const lastOf = (p: Player) => { const ps = plain(p.name).replace(/\./g, "").replace(/[^a-z' -]/g, "").split(/[ -]/).filter((w) => !["jr", "sr", "ii", "iii", "iv"].includes(w)); return ps[ps.length - 1]; };
  for (const [last, k] of lastCount) {
    if (k < 2 || last.length < 3 || hits.some((h) => lastOf(h.p) === last)) continue;
    const at = text.search(new RegExp(`\\b${last}\\b`));
    if (at >= 0) for (const p of byId.values()) if (lastOf(p) === last) hits.push({ p: { ...p, shared: last }, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.p);
}

// ---------------------------------------------------------------------------- helpers over the slate
const usable = (r: NbaRow) => !r.out && r.dist != null && r.line >= MIN_LINE;
const item = (r: NbaRow, side: "over" | "under", line: number, p: number, note?: string): AskItem => ({ row: r, side, line, p, note });
const leanItem = (r: NbaRow, note?: string): AskItem | null => { const l = leanOf(r); return l ? item(r, l.side, r.line, l.p, note ?? `projects ${fmt(r.mean)}`) : null; };
const recentNote = (r: NbaRow, n = 5) => (r.recent.length ? `last ${Math.min(n, r.recent.length)}: ${r.recent.slice(0, n).map((v) => fmt(v, 0)).join(", ")}` : "no games yet");
const hitRate = (r: NbaRow, line: number, side: "over" | "under", n = 10) => {
  const xs = r.recent.slice(0, n);
  return xs.length ? { hits: xs.filter((v) => (side === "over" ? v > line : v < line)).length, n: xs.length } : null;
};
const gameOf = (slate: Slate, id: number) => slate.games.find((g) => g.game_id === id);
const tip = (iso: string) => { try { return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET"; } catch { return iso; } };

function legsOf(items: AskItem[]): SimLeg[] {
  return items.map((x) => ({ id: `${x.row.market}:${x.row.player_id}:${x.line}`, market: x.row.market, player_id: x.row.player_id, team: x.row.team,
    position: x.row.pos, game_id: String(x.row.game_id), p: x.p, side: x.side }));
}
const tierWord = (c: NbaConfidence | undefined, p: number) => {
  const t = c?.props?.tiers.find((x) => p >= x.lo && p < (x.hi >= 1 ? 1.01 : x.hi));
  return t ? `${t.tier}: such leans hit ${pctS(t.rate)} of ${t.n.toLocaleString()} unseen games` : null;
};

/** Questions asking for reasons, a breakdown or how sure the model is. */
const WHY = /\b(why|reason\w*|explain\w*|because|how come|what makes|break ?down|analy[sz]\w*|case (for|against)|confident|confidence|how sure|trust|rated|rating|score of|thoughts|your take|write ?up|deep dive|justify|based on what|what do you (see|like))\b/;

// ---------------------------------------------------------------------------- the router
export function answer(question: string, slate: Slate, buckets: Buckets = {}, useCorrelation = false, ctx: AskContext = {}): AskAnswer {
  const q = plain(question).replace(/[?!,]/g, " ").replace(/\s+/g, " ").trim();
  const all = slate.rows;
  const rows = all.filter(usable);
  const markets = marketsOf(q);
  const market = markets[0] ?? null;
  const teams = teamsOf(q);
  const pos = positionOf(q);
  const wantUnder = /\bunders?\b|\bfewer\b|\bless than\b|\bbelow\b|\bfade\b|\bwon'?t\b|\bfall short\b/.test(q);
  const wantOver = /\bovers?\b|\bmore than\b|\babove\b|\bexceed\b|\bsmash\b|\bboom\b/.test(q);
  const num = numberOf(q);
  const scoped = rows.filter((r) => (!market || markets.includes(r.market)) && (!teams.length || teams.includes(r.team) || (teams.length === 1 && teams.includes(r.opp)))
    && (!pos || r.pos === pos));
  // suggestions (best, safest, due, hot) name only stars with a DraftKings line; questions naming a player still answer for him
  const stars = starsOf(all);
  const picks = scoped.filter((r) => suggestable(r, stars));
  const leans = (rs: NbaRow[]) => rs.map((r) => ({ r, l: leanOf(r)! })).filter((x) => x.l && (!wantUnder || x.l.side === "under") && (!wantOver || x.l.side === "over"))
    .sort((a, b) => b.l.p - a.l.p);
  const filterWords = [market && marketLabel(market).toLowerCase(), teams.length && teams.join(" / "), pos && { G: "guards", F: "forwards", C: "centers" }[pos]].filter(Boolean).join(", ");

  const who = playersIn(q, all);

  // ---- about the site: accuracy, scoring, signals, updates
  const meta = who.length ? null : metaAnswer(q, slate, ctx, teams.length > 0);
  if (meta) return meta;

  if (!all.length) return { title: "No games on the slate", text: "The next slate is published the morning of game day, before tip-off.", items: [],
    suggestions: ["How accurate is the model?", "How do the scores work?"] };

  // ---- schedule
  if (/\b(games?|schedule|slate|matchups?|who plays|who('?s| is) playing tonight|what('?s| is) on)\b/.test(q) && !teams.length && !who.length && !market && !/\b(best|top|parlay|props?|bets?|picks?|leans?)\b/.test(q)) {
    return { title: `${slate.games.length} game${slate.games.length === 1 ? "" : "s"} on ${slate.date}`, items: [],
      bullets: slate.games.map((g) => `${g.away} @ ${g.home}, ${tip(g.time)}${g.total != null ? `, total ${g.total}` : ""}${g.home_spread != null ? `, ${g.home} ${g.home_spread > 0 ? "+" : ""}${g.home_spread}` : ""}`),
      suggestions: slate.games.map((g) => `${g.away} vs ${g.home} preview`) };
  }

  // ---- injuries, who sits, rest
  if (/\b(injur\w*|hurt|out tonight|who('?s| is) out|ruled out|questionable|doubtful|probable|game[- ]time|gtd|sit\w*|rest\w*|load manage\w*|dnp|status|available|availability|back[- ]to[- ]back|b2b|fatigue|tired)\b/.test(q)
    && !who.length) return injuryAnswer(slate, teams);

  // ---- parlays (players named -> those legs; a game or team -> same-game; otherwise the strongest)
  if (/\b(parlay|parlays|slip|legs?|sgp|same[- ]game|combo|accumulator|acca|multi)\b/.test(q)) {
    return parlayAnswer(q, slate, rows, who, teams, markets, buckets, useCorrelation, wantUnder, wantOver);
  }

  // ---- comparisons: two players named
  if (who.length >= 2 && /\b(or|vs|versus|compare|comparison|better|between|than)\b/.test(q)) {
    const its = who.slice(0, 4).flatMap((p) => p.rows.filter((r) => (!market || r.market === market) && r.dist && !r.out).map((r) => leanItem(r)).filter((x): x is AskItem => !!x));
    its.sort((a, b) => b.p - a.p);
    const best = its[0];
    return { title: `${who.slice(0, 4).map((p) => p.name).join(" vs ")}${market ? `: ${marketLabel(market).toLowerCase()}` : ""}`, items: its,
      text: best ? `The stronger play is ${best.row.player_name} ${best.side} ${best.line} ${marketLabel(best.row.market).toLowerCase()} at ${score(best.p)} out of 10.` : "No validated lines for these players tonight." };
  }

  // ---- a shared last name and nobody else: ask which one
  if (who.length && who.every((p) => p.shared) && new Set(who.map((p) => p.shared)).size === 1) {
    const its = who.flatMap((p) => p.rows.filter((r) => usable(r) && (!market || r.market === market)).map((r) => leanItem(r)!).filter(Boolean)).sort((a, b) => b.p - a.p);
    return { title: `${who.length} players named ${who[0].shared![0].toUpperCase() + who[0].shared!.slice(1)} tonight`, items: its.slice(0, 10),
      text: `Showing both. Add a first name to see one: ${who.map((p) => p.name).join(" or ")}.`,
      suggestions: who.map((p) => `${p.name}${market ? ` ${marketLabel(market).toLowerCase()}` : ""}`) };
  }

  // ---- one player
  if (who.length) return playerAnswer(q, who[0], markets, num, buckets, useCorrelation, ctx, wantOver, wantUnder);

  // ---- a name that isn't on tonight's slate ("Will Brunson score 25?")
  const missing = unknownName(q, teams);
  if (missing) {
    return { title: `${missing} isn't on tonight's slate`, items: [],
      text: `I don't see a player called ${missing} in tonight's games. His team may not play tonight, or he isn't in the rotation.`,
      bullets: slate.games.map((g) => `${g.away} @ ${g.home}, ${tip(g.time)}`),
      suggestions: slate.games.flatMap((g) => [`${g.away} props`, `${g.home} props`]).slice(0, 4) };
  }

  // ---- a game preview: two teams, or "game"/"matchup"/"preview" with a team
  if (teams.length >= 2 || (teams.length === 1 && (/\b(game|matchup|preview|break ?down|tonight|spread|total|win|wins|winner|beat|score|favou?red|favou?rite|fav|underdog|dog|upset|predict\w*|analy[sz]\w*|why|explain|thoughts|take|write ?up|deep dive)\b/.test(q)) && !market)) {
    const g = slate.games.find((x) => teams.every((t) => t === x.home || t === x.away));
    if (g) return gamePreview(slate, g.game_id, buckets, useCorrelation, ctx);
    if (teams.length) return { title: `${teams.join(" / ")} not on tonight's slate`, items: [], bullets: slate.games.map((x) => `${x.away} @ ${x.home}, ${tip(x.time)}`),
      text: "Tonight's games are listed below." };
  }

  // ---- Due
  if (/\b(due|bounce[- ]?back|cold|slump\w*|struggl\w*|regress\w*|buy[- ]low|been bad|under ?perform\w*)\b/.test(q)) {
    const due = picks.filter((r) => r.due).map((r) => leanItem(r, recentNote(r, 4))!).filter(Boolean);
    const study = market ? ctx.due?.markets[market] : undefined;
    return { title: "Due: under his projection 4 games running", items: due.sort((a, b) => b.p - a.p).slice(0, countOf(q, 15)),
      text: due.length ? "The scores already account for the slump. Due is a label, not a boost." : "Nobody qualifies tonight" + (filterWords ? ` (${filterWords})` : "") + ".",
      bullets: study ? [`In testing, due players beat their ${study.label.toLowerCase()} projection ${pctS(study.beat_projection)} of the time vs ${pctS(study.others_beat_projection)} for everyone else (${study.n.toLocaleString()} games).`] : undefined };
  }

  // ---- hot streaks
  if (/\b(hot|streak\w*|on fire|heater|rolling|trending|form)\b/.test(q)) {
    const hot = picks.filter((r) => r.recent.length >= 4 && r.recent.slice(0, 4).every((v) => v > r.line))
      .map((r) => leanItem(r, `last 4 over ${r.line}: ${r.recent.slice(0, 4).map((v) => fmt(v, 0)).join(", ")}`)!).filter(Boolean);
    return { title: "Hot: over tonight's line in each of his last 4", items: hot.sort((a, b) => b.p - a.p).slice(0, countOf(q, 15)),
      text: hot.length ? "A streak is not a reason by itself; the score is the model's chance with the streak already counted." : "Nobody has cleared tonight's line 4 straight." };
  }

  // ---- edges, value, plus money
  if (/\b(edges?|value|\+ ?ev|ev|beat the books?|best price|mispriced|soft lines?|plus money|underdogs?|longshots?|long shots?)\b/.test(q)) {
    if (!slate.odds.props_priced) {
      const big = leans(scoped).map((x) => ({ ...x, gap: Math.abs(x.r.mean - x.r.line) })).sort((a, b) => b.gap - a.gap).slice(0, countOf(q, 10));
      return { title: "Biggest gaps between projection and line", items: big.map((x) => item(x.r, x.l.side, x.r.line, x.l.p, `projects ${fmt(x.r.mean)} vs line ${x.r.line}`)),
        text: "Book prop prices are not loaded on the current odds plan, so Edge can't be measured against a price. These are the largest gaps between the projection and tonight's line." };
    }
    const e = leans(scoped).map((x) => ({ ...x, e: edgeOf(x.r, x.l) })).filter((x) => x.e).sort((a, b) => b.e!.edge - a.e!.edge);
    return { title: "Edges against the best price", items: e.slice(0, countOf(q, 10)).map((x) => item(x.r, x.l.side, x.r.line, x.l.p, `${x.e!.price > 0 ? "+" : ""}${x.e!.price} ${x.e!.book}, +${Math.round(x.e!.edge * 100)} pts`)),
      text: e.length ? undefined : "No lean beats a book price by 3+ points right now." };
  }

  // ---- double-double / triple-double
  if (/\b(double[- ]?double|triple[- ]?double|dd|td)\b/.test(q)) return multiDouble(q, all, teams, buckets, useCorrelation, countOf(q, 10));

  // ---- "who gets 30+", "most likely to hit 10 rebounds"
  if (num && market && !num.isLine) {
    const line = num.value - 0.5;
    const hits = scoped.map((r) => ({ r, p: overAt(r, line) })).filter((x) => x.p != null).sort((a, b) => b.p! - a.p!);
    return { title: `Most likely to get ${num.value}+ ${marketLabel(market).toLowerCase()}`, items: hits.slice(0, countOf(q, 10)).map((x) => {
      const h = hitRate(x.r, line, "over");
      return item(x.r, "over", line, x.p!, `projects ${fmt(x.r.mean)}${h ? `, did it ${h.hits} of last ${h.n}` : ""}`);
    }) };
  }
  if (num && market && num.isLine) {
    const side = num.side ?? (wantUnder ? "under" : "over");
    // players whose own line is near the asked number; a guard's 2.5 rebounds says nothing about "under 8.5"
    const near = scoped.filter((r) => Math.abs(r.line - num.value) <= Math.max(2, num.value * 0.2));
    const hits = (near.length ? near : scoped).map((r) => { const o = overAt(r, num.value); return { r, p: o == null ? null : side === "over" ? o : 1 - o }; })
      .filter((x) => x.p != null).sort((a, b) => b.p! - a.p!);
    return { title: `${sideWord(side)} ${num.value} ${marketLabel(market).toLowerCase()}: best chances`, items: hits.slice(0, countOf(q, 10)).map((x) => item(x.r, side, num.value, x.p!, `projects ${fmt(x.r.mean)}`)) };
  }

  // ---- leaders: "top scorer", "most rebounds", "highest projected"
  if (/\b(most|highest|leaders?|leading|top (scorer|rebounder|passer)|who (will )?(score|scores|lead)|projected|projections?|best (scorer|rebounder|passer|shooter))\b/.test(q)
    && !/\b(safe|safest|lock|confident|likely to hit|strongest|best bets?|picks?)\b/.test(q)) {
    const m = market ?? (/\bshooter\b/.test(q) ? "threes" : /\brebounder\b/.test(q) ? "rebounds" : /\bpasser\b/.test(q) ? "assists" : "points");
    const top = all.filter((r) => r.market === m && !r.out && (!teams.length || teams.includes(r.team)) && (!pos || r.pos === pos)).sort((a, b) => b.mean - a.mean).slice(0, countOf(q, 10));
    return { title: `Highest projected ${marketLabel(m).toLowerCase()} tonight`, items: top.map((r) => { const l = leanOf(r); return item(r, l?.side ?? "over", r.line, l?.p ?? 0.5, `projects ${fmt(r.mean)} (${fmt(r.q10, 0)}-${fmt(r.q90, 0)})`); }) };
  }

  // ---- lowest minutes risk / minutes questions
  if (/\b(minutes?|mins|playing time|role|bench|starters?|starting|rotation)\b/.test(q)) {
    const ms = all.filter((r) => r.market === (market ?? "points") && !r.out && (!teams.length || teams.includes(r.team))).sort((a, b) => b.evidence.minutes - a.evidence.minutes);
    return { title: "Expected minutes (recent average)", items: ms.slice(0, countOf(q, 15)).map((r) => { const l = leanOf(r); return item(r, l?.side ?? "over", r.line, l?.p ?? 0.5,
      `~${fmt(r.evidence.minutes, 0)} min recent, ${fmt(r.evidence.minutes_long, 0)} longer run, starts ${pctS(r.evidence.start_rate)}`); }) };
  }

  // ---- "why are these the picks", "explain your best bet"
  if (WHY.test(q) && /\b(picks?|bets?|plays?|locks?|leans?|best|top|safest|strongest|these|them|your)\b/.test(q)) {
    const pool = leans(picks);
    const top = pool.slice(0, countOf(q, /\b(pick|bet|play|lock|lean)\b(?!s)/.test(q) ? 1 : 3));
    if (top.length) return { title: top.length === 1 ? `Why ${top[0].r.player_name} ${top[0].l.side} ${top[0].r.line} ${marketLabel(top[0].r.market).toLowerCase()} is the top lean` : `Why these are tonight's ${top.length} strongest leans`,
      items: top.map((x) => item(x.r, x.l.side, x.r.line, x.l.p, `projects ${fmt(x.r.mean)}`)),
      text: "Each lean's case, what works against it and how leans like it have done.",
      sections: top.flatMap((x) => (top.length === 1 ? explainRow(x.r, x.l.side, ctx)
        : [{ title: `${x.r.player_name} ${x.l.side} ${x.r.line} ${marketLabel(x.r.market).toLowerCase()}: ${score(x.l.p)}/10`, lines: [...reasons(x.r, x.l.side), ...(tierWord(ctx.conf, x.l.p) ? [`${tierWord(ctx.conf, x.l.p)}.`] : [])] }])),
      suggestions: top.slice(0, 3).map((x) => `Why ${x.r.player_name} ${x.l.side}?`) };
  }

  // ---- safest / locks / confidence
  const safe = /\b(safe\w*|locks?|lock of|sure ?things?|confident|confidence|best bets?|strongest|most likely|highest (chance|probability|score)|guaranteed|bankers?|anchors?)\b/.test(q);
  const n = countOf(q, safe ? 5 : 10);
  const pool = leans(picks);
  if (!pool.length) {
    return { title: "Nothing matches that", text: `I read: ${describe(q, markets, teams, pos, wantOver, wantUnder) || "no market, team or player"}. No validated lean fits${filterWords ? ` (${filterWords})` : ""}. Here are tonight's strongest instead.`,
      items: fallbackItems(rows.filter((r) => suggestable(r, stars))), suggestions: SUGGESTIONS };
  }
  const what = `${wantUnder ? "unders" : wantOver ? "overs" : "leans"}${filterWords ? ` (${filterWords})` : ""}`;
  const items = pool.slice(0, n).map((x) => item(x.r, x.l.side, x.r.line, x.l.p, `projects ${fmt(x.r.mean)}, ${recentNote(x.r)}`));
  const recognised = describe(q, markets, teams, pos, wantOver, wantUnder) || safe || /\b(best|top|picks?|bets?|leans?|plays?|props?|tonight|today|good)\b/.test(q);
  return { title: `${safe ? "Safest" : "Strongest"} ${what} tonight`, items,
    text: recognised ? (items[0] ? tierWord(ctx.conf, items[0].p) ?? undefined : undefined)
      : `I didn't find a player, team or stat in "${question.trim()}", so here are tonight's strongest leans. Try a player's name, a team, a stat or one of the suggestions.`,
    suggestions: recognised ? undefined : SUGGESTIONS };
}

const NOT_NAMES = new Set(["he", "she", "they", "anyone", "anybody", "someone", "somebody", "any", "the", "a", "an", "it", "this", "that", "there", "i", "we", "you",
  "my", "who", "what", "which", "tonight", "today", "players", "player", "guys", "team", "teams", "game", "games", "he'll", "nobody", "everyone", "all", "both",
  "over", "under", "most", "best", "top", "more", "less", "your", "model", "site", "parlay", "props", "prop", "picks", "pick", "bets", "bet", "line", "lines", "to", "be",
  "points", "rebounds", "assists", "threes", "pra", "double", "triple", "minutes", "hit", "get", "score", "play", "playing", "out", "due", "hot", "cold", "safe", "lock"]);
/** A word in a player's spot that matches nobody tonight: "will brunson score", "brunson props", "how many points will tatum get". */
function unknownName(q: string, teams: string[]): string | null {
  const m = q.match(/\b(?:will|can|does|did|is|should i (?:take|bet|play)|how (?:many|much) \w+ (?:will|does|did))\s+([a-z][a-z'.-]{2,})(?:\s+([a-z][a-z'.-]{2,}))?\s+(?:score|get|have|hit|go|play|drop|record|grab|dish|make|clear|be|over|under|sit|rest|put)\b/)
    || q.match(/^([a-z][a-z'.-]{2,})(?:\s+([a-z][a-z'.-]{2,}))?\s+(?:props?|points|rebounds|assists|threes|pra|stats|over|under|o|u|last|tonight|line|lines|projection|odds)\b/);
  if (!m) return null;
  const words = [m[1], m[2]].filter((w): w is string => !!w && !/^(will|get|score|have|hit|go|play|over|under)$/.test(w));
  if (!words.length || words.some((w) => NOT_NAMES.has(w) || TEAM_WORDS[w] || MARKET_WORDS.some(([re]) => re.test(w))) || teams.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function describe(_q: string, markets: string[], teams: string[], pos: string | null, over: boolean, under: boolean): string {
  return [markets.length && markets.map(marketLabel).join(", "), teams.length && teams.join(", "), pos && { G: "guards", F: "forwards", C: "centers" }[pos], over && "overs", under && "unders"]
    .filter(Boolean).join(" · ");
}
function fallbackItems(rows: NbaRow[]): AskItem[] {
  return rows.filter((r) => r.evidence.minutes_long >= 20).map((r) => leanItem(r)!).filter(Boolean).sort((a, b) => b.p - a.p).slice(0, 5);
}

// ---------------------------------------------------------------------------- one player
function playerAnswer(q: string, p: Player, markets: string[], num: ReturnType<typeof numberOf>, buckets: Buckets, useCor: boolean,
  ctx: AskContext, wantOver: boolean, wantUnder: boolean): AskAnswer {
  const name = p.name;
  const shown = p.rows.filter((r) => r.line >= MIN_LINE);
  const mine = shown.filter((r) => !markets.length || markets.includes(r.market));
  const any = p.rows[0];
  const status = any.injury ? `${any.injury}${any.injury_note ? `: ${any.injury_note}` : ""}` : null;
  if (any.out) return { title: `${name} is listed Out`, text: status ?? undefined, items: [],
    bullets: [`${any.team} ${any.home ? "vs" : "@"} ${any.opp}. Players listed Out are never picked.`],
    suggestions: [`${any.team} props`, `${any.team} injuries`] };

  // status / is he playing
  if (/\b(playing|play tonight|injur\w*|hurt|status|questionable|available|out|sit\w*|rest\w*|healthy)\b/.test(q) && !num && !markets.length) {
    return { title: status ? `${name}: ${any.injury}` : `${name} is not on the injury report`, text: status ?? `Expected to play: about ${fmt(any.evidence.minutes, 0)} minutes lately, starting ${pctS(any.evidence.start_rate)} of games.`,
      items: shown.filter((r) => r.dist).map((r) => leanItem(r)!).filter(Boolean).sort((a, b) => b.p - a.p) };
  }

  // double / triple double for one player
  if (/\b(double[- ]?double|triple[- ]?double|dd|td)\b/.test(q)) return multiDouble(q, p.rows, [], buckets, useCor, 1);

  // a specific line or threshold: "over 22.5", "25 points", "score 30"
  if (num) {
    const m = markets[0] ?? (p.rows.find((r) => r.market === "points") ? "points" : p.rows[0].market);
    const r = p.rows.find((x) => x.market === m);
    if (!r || !r.dist) return { title: `No validated ${marketLabel(m).toLowerCase()} line for ${name}`, items: [] };
    const line = num.isLine ? num.value : num.value - 0.5;
    const over = overAt(r, line)!;
    const side: "over" | "under" = num.side ?? (wantUnder ? "under" : wantOver ? "over" : over >= 0.5 ? "over" : "under");
    const ps = side === "over" ? over : 1 - over;
    const h = hitRate(r, line, side);
    const offer = bestOffer(r, side, line);
    const verdict = ps >= 0.6 ? "a playable side" : ps >= 0.55 ? "a slight lean" : ps >= 0.45 ? "a coin flip" : "the wrong side";
    return {
      title: num.isLine ? `${name} ${side} ${line} ${marketLabel(m).toLowerCase()}: ${score(ps)} out of 10` : `${name}: ${num.value}+ ${marketLabel(m).toLowerCase()}, ${pctS(over)} chance`,
      text: num.isLine ? `That's ${verdict}. He projects ${fmt(r.mean)} (80% range ${fmt(r.q10, 0)}-${fmt(r.q90, 0)}).` : `He projects ${fmt(r.mean)} ${marketLabel(m).toLowerCase()}; 80% of outcomes land between ${fmt(r.q10, 0)} and ${fmt(r.q90, 0)}.`,
      items: [item(r, side, line, ps, `projects ${fmt(r.mean)}`)],
      bullets: [
        h ? `Cleared it (${side} ${line}) in ${h.hits} of his last ${h.n}: ${r.recent.slice(0, h.n).map((v) => fmt(v, 0)).join(", ")}.` : "No games this season yet.",
        `Minutes: ${fmt(r.evidence.minutes, 0)} lately, ${fmt(r.evidence.minutes_long, 0)} over the longer run.`,
        ...(r.evidence.opp_mult != null ? [`${r.opp} allows ${pctS(Math.abs(r.evidence.opp_mult - 1))} ${r.evidence.opp_mult >= 1 ? "more" : "less"} ${marketLabel(m).toLowerCase()} than average to his position.`] : []),
        ...(offer ? [`Best price for the ${side}: ${offer.price > 0 ? "+" : ""}${offer.price} (${offer.book}).`] : []),
        ...(tierWord(ctx.conf, ps) ? [tierWord(ctx.conf, ps)!] : []),
        ...(status ? [`Injury report: ${status}.`] : []),
      ],
    };
  }

  // recent games / log
  if (/\b(last|recent\w*|lately|log|history|averag\w*|trend\w*|form|been doing|so far|this season)\b/.test(q)) {
    const lastN = q.match(/\b(?:last|past|previous) (\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    const n = Math.min(10, lastN ? Number(lastN[1]) || WORD_NUM[lastN[1]] : countOf(q, 5));
    const rs = mine.length ? mine : shown;
    return { title: `${name}: last ${n} games`, items: rs.filter((r) => r.dist).map((r) => leanItem(r)!).filter(Boolean),
      bullets: [
        ...rs.map((r) => { const xs = r.recent.slice(0, n); const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
          return `${marketLabel(r.market)}: ${xs.map((v) => fmt(v, 0)).join(", ") || "none"} (avg ${fmt(avg)}; tonight's line ${r.line}, projects ${fmt(r.mean)})`; }),
        `Minutes: ${any.recent_minutes.slice(0, n).map((v) => fmt(v, 0)).join(", ")}`,
      ] };
  }

  // why
  if (WHY.test(q)) {
    // "why is he under": explain the strongest prop leaning that way
    const cands = (mine.length ? mine : shown).filter((x) => x.dist).map((x) => ({ x, l: leanOf(x) })).filter((c) => c.l && (!wantUnder || c.l.side === "under") && (!wantOver || c.l.side === "over"))
      .sort((a, b) => b.l!.p - a.l!.p);
    const r = cands[0]?.x;
    if (r) { const l = leanOf(r)!; return { title: `Why ${name} leans ${l.side} ${r.line} ${marketLabel(r.market).toLowerCase()}`, items: [item(r, l.side, r.line, l.p)],
      text: `${score(l.p)} out of 10: the model's chance of the ${l.side}, times 10.`, sections: explainRow(r, l.side, ctx),
      suggestions: [`${name} last 10 games`, `${r.team} ${r.home ? "vs" : "@"} ${r.opp} preview`, `${name} all props`] }; }
  }

  // default: every prop, strongest first, with the reasons for the best one
  const its = (mine.length ? mine : shown).filter((r) => r.dist).map((r) => leanItem(r, `projects ${fmt(r.mean)}, ${recentNote(r)}`)!).filter(Boolean).sort((a, b) => b.p - a.p);
  const best = its[0];
  return { title: `${name}${markets.length ? `: ${markets.map((m) => marketLabel(m).toLowerCase()).join(", ")}` : " tonight"}`, items: its,
    text: best ? `Best: ${sideWord(best.side)} ${best.line} ${marketLabel(best.row.market).toLowerCase()}, ${score(best.p)} out of 10.${status ? ` Injury report: ${status}.` : ""}` : "No validated lines for him tonight.",
    bullets: best ? reasons(best.row, best.side) : undefined, suggestions: [`${name} last 5 games`, `Will ${name.split(" ").slice(-1)[0]} get ${Math.ceil((best?.row.mean ?? 10) + 3)} ${best ? marketLabel(best.row.market).toLowerCase() : "points"}?`] };
}

function reasons(r: NbaRow, side: "over" | "under"): string[] {
  const out: string[] = [];
  const m = marketLabel(r.market).toLowerCase();
  out.push(`Projects ${fmt(r.mean)} ${m} against a line of ${r.line} (80% range ${fmt(r.q10, 0)}-${fmt(r.q90, 0)}).`);
  const h = hitRate(r, r.line, side);
  if (h) out.push(`${sideWord(side)} ${r.line} in ${h.hits} of his last ${h.n}: ${r.recent.slice(0, h.n).map((v) => fmt(v, 0)).join(", ")}.`);
  out.push(`About ${fmt(r.evidence.minutes, 0)} minutes lately (${fmt(r.evidence.minutes_long, 0)} longer run), ${fmt(r.evidence.per_min * 36, 1)} ${m} per 36.`);
  if (r.evidence.opp_mult != null && Math.abs(r.evidence.opp_mult - 1) >= 0.03)
    out.push(`${r.opp} gives up ${pctS(Math.abs(r.evidence.opp_mult - 1))} ${r.evidence.opp_mult > 1 ? "more" : "less"} ${m} than average to ${({ G: "guards", F: "forwards", C: "centers" } as Record<string, string>)[r.pos] ?? "his position"}.`);
  if (r.evidence.pace != null && r.evidence.opp_pace != null) {
    const pace = (r.evidence.pace + r.evidence.opp_pace) / 2;
    if (Math.abs(pace - 99.5) >= 1.5) out.push(`Game pace about ${fmt(pace)} possessions, ${pace > 99.5 ? "faster" : "slower"} than average.`);
  }
  if (r.evidence.rest <= 1) out.push("Second night of a back-to-back.");
  if (r.injury) out.push(`Injury report: ${r.injury}${r.injury_note ? `, ${r.injury_note}` : ""}.`);
  if (r.due) out.push("Due: under his projection in each of his last 4 games (already counted in the score).");
  return out;
}

// ---------------------------------------------------------------------------- games, injuries, parlays, doubles
function gamePreview(slate: Slate, gid: number, buckets: Buckets, useCor: boolean, ctx: AskContext = {}): AskAnswer {
  const g = gameOf(slate, gid)!;
  const rs = slate.rows.filter((r) => r.game_id === gid);
  const pts = (t: string) => rs.filter((r) => r.team === t && r.market === "points" && !r.out).reduce((a, r) => a + r.mean, 0);
  const its = rs.filter(usable).filter((r) => r.evidence.minutes_long >= 20).map((r) => leanItem(r)!).filter(Boolean).sort((a, b) => b.p - a.p).slice(0, 8);
  const outs = rs.filter((r) => r.market === "points" && r.injury).map((r) => `${r.player_name} (${r.team}): ${r.injury}`);
  const sgp = its.filter((x, i, a) => a.findIndex((y) => y.row.player_id === x.row.player_id) === i).slice(0, 3);
  const sim = sgp.length >= 2 ? simulate(legsOf(sgp), buckets, useCor) : null;
  return { title: `${g.away} @ ${g.home}, ${tip(g.time)}`, items: its,
    text: g.total != null ? `Book total ${g.total}${g.home_spread != null ? `, ${g.home} ${g.home_spread > 0 ? "+" : ""}${g.home_spread}` : ""}.` : undefined,
    bullets: [
      ...(sim ? [`Strongest same-game ${sgp.length}-leg: ${sgp.map((x) => `${x.row.player_name} ${x.side} ${x.line} ${marketLabel(x.row.market).toLowerCase()}`).join(" + ")}, all hit ${pctS(sim.joint)} in ${sim.draws.toLocaleString()} simulated games.`] : []),
      ...(outs.length ? [] : ["No one in either rotation is on the injury report."]),
    ],
    sections: gameWriteup(slate, g, ctx, pts),
    parlay: sim ? { joint: sim.joint, independent: sim.independent, draws: sim.draws } : undefined,
    suggestions: [`${g.away} props`, `${g.home} props`, `${g.away} ${g.home} parlay`, ...(its[0] ? [`Why ${its[0].row.player_name} ${its[0].side}?`] : [])] };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Why one team is favored: the book's line, what the player projections add up to, rotation, injuries, pace and rest. */
function gameWriteup(slate: Slate, g: NbaGame, ctx: AskContext, pts: (t: string) => number): Section[] {
  const rs = slate.rows.filter((r) => r.game_id === g.game_id);
  const prs = (t: string) => rs.filter((r) => r.team === t && r.market === "points");
  const ph = pts(g.home), pa = pts(g.away);
  const sp = g.home_spread;
  const fav = sp == null || sp === 0 ? (ph >= pa ? g.home : g.away) : sp < 0 ? g.home : g.away;
  const dog = fav === g.home ? g.away : g.home;
  const line: string[] = [];
  if (sp == null) line.push("No book spread is loaded for this game.");
  else line.push(sp === 0 ? "The books have it as a pick'em." : `The books make ${fav} a ${Math.abs(sp)}-point favorite${g.total != null ? ` with a total of ${g.total}` : ""}.`);
  line.push("The Lab does not bet NBA sides or totals; the favorite is the market's call. Below is what our player data says about it.");
  const proj = [`Our player projections add up to ${g.away} ${fmt(pa, 0)} and ${g.home} ${fmt(ph, 0)} points from the main rotation (bench minutes not counted), a gap of ${fmt(Math.abs(ph - pa), 0)} toward ${ph >= pa ? g.home : g.away}.`];
  if (sp != null && sp !== 0) proj.push((ph - pa) * -Math.sign(sp) > 0 ? `That points the same way as the line.` : `That points the other way from the line, so the market sees something the rotation sums do not (bench depth, defense, or news after our run).`);
  const why: string[] = [];
  for (const t of [fav, dog]) {
    const top = prs(t).filter((r) => !r.out).sort((a, b) => b.mean - a.mean).slice(0, 3);
    if (top.length) why.push(`${t}'s top projected scorers: ${top.map((r) => `${r.player_name} ${fmt(r.mean)} (${fmt(r.evidence.minutes, 0)} min)`).join(", ")}.`);
    const out = prs(t).filter((r) => r.out);
    if (out.length) why.push(`${t} is without ${out.map((r) => `${r.player_name} (${fmt(r.evidence.minutes_long, 0)} min, ${fmt(avg(r.recent.slice(0, 10)) ?? 0)} points a game over his last ${Math.min(10, r.recent.length)})`).join(", ")}.`);
    const q = prs(t).filter((r) => r.injury && !r.out);
    if (q.length) why.push(`${t} uncertain: ${q.map((r) => `${r.player_name} ${r.injury}${r.injury_note ? ` (${r.injury_note})` : ""}`).join(", ")}.`);
  }
  const ex = (t: string) => rs.find((r) => r.team === t)?.evidence;
  const eh = ex(g.home), ea = ex(g.away);
  if (eh?.pace != null && ea?.pace != null) why.push(`Pace: ${g.away} ${fmt(ea.pace)} possessions a game, ${g.home} ${fmt(eh.pace)}; this one projects about ${fmt((eh.pace + ea.pace) / 2)}.`);
  const b2b = [g.home, g.away].filter((t) => (ex(t)?.rest ?? 2) <= 1);
  why.push(b2b.length ? `Second night of a back-to-back: ${b2b.join(" and ")}.` : "Neither team is on the second night of a back-to-back.");
  why.push(`${g.home} has home court.`);
  const best = rs.filter(usable).filter((r) => r.evidence.minutes_long >= 20).map((r) => ({ r, l: leanOf(r)! })).filter((x) => x.l).sort((a, b) => b.l.p - a.l.p).slice(0, 4);
  const props = best.map((x) => `${x.r.player_name} ${x.l.side} ${x.r.line} ${marketLabel(x.r.market).toLowerCase()}, ${score(x.l.p)}/10: ${reasons(x.r, x.l.side).slice(0, 2).join(" ")}`);
  const t = best[0] ? tierWord(ctx.conf, best[0].l.p) : null;
  return tidy([
    { title: "The line", lines: line },
    { title: "What our projections add up to", lines: proj },
    { title: `Why ${fav} is favored`, lines: why },
    { title: "Best props in this game", lines: [...props, ...(t ? [`Top lean: ${t}.`] : [])] },
  ]);
}

/** One prop lean in full: the case, the case against, his recent games and how this market has tested. */
export function explainRow(r: NbaRow, side: "over" | "under", ctx: AskContext): Section[] {
  const l = leanOf(r);
  if (!l) return [];
  const p = side === l.side ? l.p : 1 - l.p;
  const m = marketLabel(r.market).toLowerCase();
  const other = side === "over" ? "under" : "over";
  const e = r.evidence;
  const pick = [`${sideWord(side)} ${r.line} ${m}: ${score(p)} out of 10. His projected distribution gives the ${side} ${pctS(p)}, and the score is that chance times 10.`];
  const t = tierWord(ctx.conf, p);
  if (t) pick.push(`${t}.`);
  const bm = ctx.conf?.props?.by_market.find((x) => x.market === r.market);
  if (bm) pick.push(`${bm.label} leans in testing: ${pctS(bm.rate)} of ${bm.n.toLocaleString()} hit${bm.strong_rate != null ? `; the strongest (6.5+) hit ${pctS(bm.strong_rate)} of ${bm.strong_n.toLocaleString()}` : ""}.`);
  const off = bestOffer(r, side);
  if (off) {
    const implied = 1 / (1 + (off.price > 0 ? off.price / 100 : 100 / -off.price));
    pick.push(`Best price ${off.price > 0 ? "+" : ""}${off.price} at ${bookName(off.book)} implies ${pctS(implied)}; our ${pctS(p)} is ${p - implied >= 0.03 ? `an edge of ${Math.round((p - implied) * 100)} points` : p - implied > -0.03 ? "about the same, so no real edge" : `${Math.round((implied - p) * 100)} points short, so the price is too high`}.`);
  } else pick.push(r.line_source === "book" ? "Book line, no price loaded for this side." : `No book line loaded: this is his usual line (median of his last 10 games).`);
  const recent = r.recent.slice(0, 10);
  const games: string[] = [];
  if (recent.length) {
    games.push(`Last ${recent.length}, newest first: ${recent.map((v) => fmt(v, 0)).join(", ")}.`);
    const a5 = avg(recent.slice(0, 5)), a10 = avg(recent);
    games.push(`Averages: ${recent.length > 5 ? `last 5 ${fmt(a5 ?? 0)}, ` : ""}last ${recent.length} ${fmt(a10 ?? 0)}; tonight's projection ${fmt(r.mean)} and the line ${r.line}.`);
    if (r.recent_minutes.length) games.push(`Minutes, last 5: ${r.recent_minutes.slice(0, 5).map((v) => fmt(v, 0)).join(", ")}.`);
  }
  const con: string[] = [`${pctS(1 - p)} of his projected outcomes land on the ${other}; 8 in 10 land between ${fmt(r.q10, 0)} and ${fmt(r.q90, 0)}.`];
  const h = hitRate(r, r.line, other as "over" | "under");
  if (h && h.hits) con.push(`He went ${other} ${r.line} in ${h.hits} of his last ${h.n}.`);
  if (e.opp_mult != null && (side === "over" ? e.opp_mult <= 0.97 : e.opp_mult >= 1.03)) con.push(`${r.opp} ${e.opp_mult < 1 ? "gives up less" : "gives up more"} ${m} than average to his position (${Math.round((e.opp_mult - 1) * 100)}%).`);
  if (e.minutes != null && e.minutes_long != null && (side === "over" ? e.minutes < e.minutes_long - 2 : e.minutes > e.minutes_long + 2)) con.push(`His minutes are ${e.minutes > e.minutes_long ? "up" : "down"} lately (${fmt(e.minutes, 0)} vs ${fmt(e.minutes_long, 0)}).`);
  if (e.pace != null && e.opp_pace != null) { const pace = (e.pace + e.opp_pace) / 2; if (side === "over" ? pace < 98 : pace > 101) con.push(`Game pace about ${fmt(pace)} possessions, ${pace > 99.5 ? "faster" : "slower"} than average.`); }
  if (side === "over" && e.rest <= 1) con.push("Second night of a back-to-back.");
  if (r.injury) con.push(`Injury report: ${r.injury}${r.injury_note ? `, ${r.injury_note}` : ""}.`);
  const tested: string[] = [];
  const mr = ctx.markets?.markets.find((x) => x.market === r.market);
  if (mr) tested.push(`${mr.label} model: ${mr.validated ? "validated" : "research only"} on ${mr.test_rows.toLocaleString()} unseen player-games; typical miss ${fmt(mr.mae)} vs ${fmt(mr.baseline_mae)} for his plain average.`);
  const pc = ctx.record?.projection_check?.find((x) => x.market === r.market);
  if (pc) tested.push(`Live check: projections miss by ${fmt(pc.avg_miss)} on average${pc.last7_n ? `; over the last 7 days they ran ${fmt(Math.abs(pc.last7_bias))} ${pc.last7_bias >= 0 ? "high" : "low"} (${pc.last7_n} games)` : ""}.`);
  const live = ctx.record?.by_market?.find((x) => x.market === r.market);
  if (live?.n) tested.push(`Live record for ${live.label.toLowerCase()} picks: ${pctS(live.rate)} of ${live.n.toLocaleString()}.`);
  return tidy([
    { title: "The pick", lines: pick },
    { title: `Why the model leans ${side}`, lines: reasons(r, side) },
    { title: "His recent games", lines: games },
    { title: "Working against it", lines: con },
    { title: "How this market has tested", lines: tested },
  ]);
}

function injuryAnswer(slate: Slate, teams: string[]): AskAnswer {
  const seen = new Set<string>();
  const list = slate.rows.filter((r) => r.injury && (!teams.length || teams.includes(r.team)) && !seen.has(r.player_id) && seen.add(r.player_id));
  const b2b = [...new Set(slate.rows.filter((r) => r.evidence.rest <= 1 && (!teams.length || teams.includes(r.team))).map((r) => r.team))];
  const out = list.filter((r) => r.out), q = list.filter((r) => !r.out);
  const items = q.flatMap((r) => slate.rows.filter((x) => x.player_id === r.player_id && x.dist && x.market === "points").map((x) => leanItem(x, `${r.injury}${r.injury_note ? `: ${r.injury_note}` : ""}`)!)).filter(Boolean);
  return { title: `Injury report${teams.length ? ` (${teams.join(", ")})` : ""}`, items,
    text: list.length ? `${out.length} out, ${q.length} uncertain. Uncertain players are listed with their points lean; picks skip anyone listed Out.` : "Nobody in tonight's rotations is on the injury report.",
    bullets: [
      ...out.map((r) => `Out: ${r.player_name} (${r.team})${r.injury_note ? `, ${r.injury_note}` : ""}`),
      ...q.map((r) => `${r.injury}: ${r.player_name} (${r.team})${r.injury_note ? `, ${r.injury_note}` : ""}`),
      b2b.length ? `Second night of a back-to-back: ${b2b.join(", ")}. Watch for rest days.` : "No team is on the second night of a back-to-back, so rest days are unlikely.",
    ] };
}

function parlayAnswer(q: string, slate: Slate, rows: NbaRow[], who: Player[], teams: string[], markets: string[], buckets: Buckets, useCor: boolean,
  wantUnder: boolean, wantOver: boolean): AskAnswer {
  const legsFromPlayers = who.map((p) => {
    const rs = p.rows.filter((r) => usable(r) && (!markets.length || markets.includes(r.market)));
    const best = rs.map((r) => leanItem(r)!).filter(Boolean).sort((a, b) => b.p - a.p)[0];
    return best;
  }).filter((x): x is AskItem => !!x);
  if (legsFromPlayers.length >= 2 || (who.length && legsFromPlayers.length)) {
    const extra = legsFromPlayers.length < 2 ? strongest(rows.filter((r) => !who.some((p) => p.id === r.player_id)), 2 - legsFromPlayers.length, true, wantUnder, wantOver) : [];
    const legs = [...legsFromPlayers, ...extra];
    const sim = simulate(legsOf(legs), buckets, useCor);
    return { title: `Parlay: ${legs.map((x) => x.row.player_name).join(" + ")}`, items: legs,
      text: `Each player's strongest validated side${extra.length ? ", plus the strongest other lean" : ""}. ${sim.draws.toLocaleString()} simulated games.`,
      parlay: { joint: sim.joint, independent: sim.independent, draws: sim.draws } };
  }
  const n = countOf(q, /\b(safe|safest|lock)\b/.test(q) ? 2 : 3);
  const game = slate.games.find((g) => teams.length && teams.every((t) => t === g.home || t === g.away));
  const sameGame = /\b(same[- ]game|sgp)\b/.test(q) || !!game;
  let pool = rows.filter((r) => (!markets.length || markets.includes(r.market)) && r.evidence.minutes_long >= 24);
  if (game) pool = pool.filter((r) => r.game_id === game.game_id);
  else if (teams.length) pool = pool.filter((r) => teams.includes(r.team));
  const longshot = /\b(long ?shot|lotto|big payout|longer|plus money|\+\d{3,})\b/.test(q);
  let legs: AskItem[];
  if (sameGame && !game && !teams.length) {
    // best same-game set across tonight's games
    const per = slate.games.map((g) => strongest(pool.filter((r) => r.game_id === g.game_id), n, false, wantUnder, wantOver)).filter((x) => x.length === n);
    legs = per.sort((a, b) => b.reduce((s, x) => s + Math.log(x.p), 0) - a.reduce((s, x) => s + Math.log(x.p), 0))[0] ?? [];
  } else {
    legs = strongest(pool, n, !sameGame, wantUnder, wantOver);
  }
  if (!legs.length) return { title: "Not enough legs for that parlay", items: [], text: "Try fewer legs or drop a filter.", suggestions: ["2-leg parlay", "3-leg parlay"] };
  const sim = simulate(legsOf(legs), buckets, useCor);
  const fair = 1 / Math.max(sim.joint, 1e-6);
  return { title: `${legs.length}-leg ${sameGame ? "same-game " : ""}parlay${game ? ` (${game.away} @ ${game.home})` : ""}`, items: legs,
    text: `${sameGame ? "Strongest validated leans from one game" : legs.length > slate.games.length ? `Strongest validated leans (only ${slate.games.length} game${slate.games.length === 1 ? "" : "s"} tonight, so some legs share a game)` : "Strongest validated leans, one per game"}${markets.length ? `, ${markets.map((m) => marketLabel(m).toLowerCase()).join("/")} only` : ""}; players averaging 24+ minutes.${longshot ? " Every added leg lowers the chance; the model can't find long-shot value without book prices." : ""}`,
    bullets: [`All hit in ${pctS(sim.joint)} of ${sim.draws.toLocaleString()} simulated games (fair odds ${fair >= 2 ? `+${Math.round((fair - 1) * 100)}` : Math.round(-100 / (fair - 1))}). Multiplying the chances gives ${pctS(sim.independent)}.`,
      useCor ? "Legs in the same game move together the way they have in past games." : "Legs are treated as independent: same-game links did not pass their check."],
    parlay: { joint: sim.joint, independent: sim.independent, draws: sim.draws } };
}

function strongest(pool: NbaRow[], n: number, onePerGame: boolean, wantUnder: boolean, wantOver: boolean): AskItem[] {
  const cand = pool.map((r) => ({ r, l: leanOf(r) })).filter((x) => x.l && (!wantUnder || x.l.side === "under") && (!wantOver || x.l.side === "over"))
    .sort((a, b) => b.l!.p - a.l!.p);
  const usedGame = new Set<number>(), usedPlayer = new Set<string>(), out: AskItem[] = [];
  for (const { r, l } of cand) {
    if (usedPlayer.has(r.player_id) || (onePerGame && usedGame.has(r.game_id))) continue;
    usedGame.add(r.game_id); usedPlayer.add(r.player_id);
    out.push(item(r, l!.side, r.line, l!.p));
    if (out.length === n) break;
  }
  // fewer games than legs: finish with the next strongest from games already used (one leg per player)
  if (onePerGame && out.length < n) for (const { r, l } of cand) {
    if (out.length === n) break;
    if (usedPlayer.has(r.player_id)) continue;
    usedPlayer.add(r.player_id);
    out.push(item(r, l!.side, r.line, l!.p));
  }
  return out;
}

function multiDouble(q: string, rows: NbaRow[], teams: string[], buckets: Buckets, useCor: boolean, n: number): AskAnswer {
  const triple = /\btriple|\btd\b/.test(q);
  const cats = triple ? ["points", "rebounds", "assists"] : ["points", "rebounds", "assists"];
  const byPlayer = new Map<string, NbaRow[]>();
  for (const r of rows) if (cats.includes(r.market) && r.dist && !r.out && (!teams.length || teams.includes(r.team))) byPlayer.set(r.player_id, [...(byPlayer.get(r.player_id) ?? []), r]);
  const res: { r: NbaRow; p: number; note: string }[] = [];
  for (const rs of byPlayer.values()) {
    if (rs.length < 3) continue;
    const legs = rs.map((r) => item(r, "over", 9.5, overAt(r, 9.5)!));
    let p: number;
    if (triple) p = simulate(legsOf(legs), buckets, useCor, 20000).joint;
    else {
      // P(at least two of three reach 10) from the same simulation the parlay builder uses
      const pairs = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => simulate(legsOf([legs[a], legs[b]]), buckets, useCor, 20000).joint);
      const all3 = simulate(legsOf(legs), buckets, useCor, 20000).joint;
      p = pairs.reduce((s, x) => s + x, 0) - 2 * all3;
    }
    const pts = rs.find((r) => r.market === "points")!;
    res.push({ r: pts, p, note: rs.map((r) => `${fmt(r.mean)} ${({ points: "pts", rebounds: "reb", assists: "ast" } as Record<string, string>)[r.market]}`).join(", ") });
  }
  res.sort((a, b) => b.p - a.p);
  const top = res.slice(0, rows.length && new Set(rows.map((r) => r.player_id)).size === 1 ? 1 : n);
  return { title: `${triple ? "Triple" : "Double"}-double chances`, items: [],
    text: top.length ? undefined : "No player projects close enough to make it likely.",
    bullets: top.map((x) => `${x.r.player_name} (${x.r.team}): ${pctS(x.p)} (projects ${x.note})`).concat(top.length ? ["From 20,000 simulated games per player, with points, rebounds and assists moving together the way they have in past games."] : []) };
}

// ---------------------------------------------------------------------------- about the site
function metaAnswer(q: string, slate: Slate, ctx: AskContext, hasTeam: boolean): AskAnswer | null {
  const tiers = ctx.conf?.props?.tiers;
  if (/\b(accura\w*|how good|trust|reliable|track record|record|hit rate|win rate|results?|backtest\w*|tested|proven|validat\w*|does it work|how often|roi|profit\w*)\b/.test(q)
    && !/\b(last|recent|tonight|his|player)\b/.test(q)) {
    const mk = ctx.markets?.markets ?? [];
    return { title: "How accurate it is", items: [],
      text: tiers ? `On games the model never saw (walk-forward from ${ctx.conf!.props!.first_season - 1}-${String(ctx.conf!.props!.first_season).slice(2)}), the chances it gives are the chances that happened:` : "The backtest is not loaded.",
      bullets: [
        ...(tiers ?? []).map((t) => `${t.tier} (${score(t.lo)}-${t.hi >= 1 ? "10" : score(t.hi)}): predicted ${pctS(t.avg_chance)}, hit ${pctS(t.rate)} of ${t.n.toLocaleString()}`),
        ...mk.map((m) => `${m.label}: ${m.validated ? "validated" : "research only"}, typical miss ${fmt(m.mae)} vs ${fmt(m.baseline_mae)} for the player's average${m.lean_hit_rate != null ? `, 6.0+ leans hit ${pctS(m.lean_hit_rate)}` : ""}`),
        ctx.record?.picks ? `Live record since ${ctx.record.first_date}: ${ctx.record.picks.toLocaleString()} graded picks${ctx.record.tiers?.length ? `, ${ctx.record.tiers.map((t) => `${t.tier} ${pctS(t.rate)}`).join(", ")}` : ""}.` : "The live record starts with this season's first graded slate.",
      ], suggestions: ["How do the scores work?", "Safest picks tonight"] };
  }
  if (!hasTeam && /\b(how (do|does|is|are)|what (is|are|does)|what'?s|explain|meaning|mean)\b/.test(q)) {
    const topics: [RegExp, string, string[]][] = [
      [/\b(score|scores|out of 10|rating|grade|grading|confidence)\b/, "The scores out of 10", [
        "Each prop gets an Under and an Over score. The score is the model's chance of that side times 10, so the two add up to 10 and the bigger one is the lean.",
        "Bands: Toss-up under 5.5, Lean 5.5-6.0, Solid 6.0-6.5, Strong 6.5 and up.",
        ...(tiers ?? []).map((t) => `${t.tier} hit ${pctS(t.rate)} of ${t.n.toLocaleString()} unseen games.`)]],
      [/\b(due|hourglass)\b/, "Due", [ctx.due?.rule ?? "Under his projection in each of his last 4 games while playing 20+ minutes.",
        "It's a label, not a boost: the model already counts the slump.",
        ...Object.values(ctx.due?.markets ?? {}).map((m) => `${m.label}: due players beat their projection ${pctS(m.beat_projection)} vs ${pctS(m.others_beat_projection)} for others.`)]],
      [/\b(edge|dollar)\b/, "Edge", ["Shown when our chance of the lean beats the chance implied by the best book price by 3+ points.",
        slate.odds.props_priced ? "Book prop prices are loaded today." : "Book prop prices need a paid odds plan, so Edge doesn't show right now."]],
      [/\b(parlay|simulat\w*|correlat\w*|same[- ]game)\b/, "How parlays are simulated", ["Each parlay is played out 40,000 times.",
        "Legs in the same game move together the way they have in past games (teammates, opponents, the same player); legs in different games are independent.",
        "Those same-game links are used only because they beat plain multiplication on months the model never saw."]],
      [/\b(line|lines|usual)\b/, "Lines", ["With book prop prices loaded, the book line is used.",
        "Otherwise it's his usual line: the median of his last 10 games, rounded down to a half point. You can type any line on the props page."]],
      [/\b(model|work|built|projection|predict\w*|data|source)\b/, "How the numbers are made", [
        "Box scores for every game since 2018-19, refreshed every morning, plus the ESPN injury report and rosters.",
        "For each player and stat the model uses only games before tonight: minutes, starts, per-minute rates, shot volume, both teams' pace, what the opponent allows to his position, rest and home/away.",
        "Recent seasons count most: a game's weight halves every 2 seasons.",
        "A team's projected points are checked against what it usually scores, and scaled when its stars add up to too much."]],
      [/\b(strong|solid|lean|toss[- ]?up|tier|tiers)\b/, "The confidence bands", (tiers ?? []).map((t) => `${t.tier}: scores ${score(t.lo)}-${t.hi >= 1 ? "10" : score(t.hi)}, hit ${pctS(t.rate)} in testing.`)],
      [/\b(update|updated|refresh\w*|when)\b/, "When the numbers update", ["Every morning before tip-off: new box scores, injury report, rosters and prices, then the models rerun.",
        `Current slate: ${slate.date ?? "none"}, generated ${slate.generated_at ? new Date(slate.generated_at).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET" : "unknown"}.`]],
    ];
    for (const [re, title, bullets] of topics) if (re.test(q)) return { title, items: [], bullets };
  }
  if (/\b(help|what can (you|i)|examples?|commands?|how to use)\b/.test(q)) {
    return { title: "Things you can ask", items: [], bullets: [
      "Players: \"Brunson props\", \"Will Jokic get 12 rebounds?\", \"Maxey over 25.5 points\", \"Embiid last 5 games\", \"Why is Harden under?\", \"Is Allen playing?\"",
      "Lists: \"Best unders tonight\", \"Safest picks\", \"Who gets 30+ points?\", \"Top rebounders\", \"Guards overs on assists\", \"Hot players\", \"Who is due?\"",
      "Games: \"Cavs vs Sixers preview\", \"Why are the Knicks favored?\", \"Nuggets props\", \"Injury report\", \"What games are on?\"",
      "Reasons: \"Why is Harden under?\", \"Break down Jokic's rebounds\", \"How confident are you in Brunson over 25.5?\", \"Why are these your best picks?\"",
      "Parlays: \"3-leg parlay\", \"Safe 2-leg\", \"Same-game parlay Thunder\", \"Parlay Mitchell and Embiid\", \"Double-double chances\"",
      "About the site: \"How accurate is it?\", \"How do the scores work?\", \"What is Due?\""] };
  }
  return null;
}

export const SUGGESTIONS = ["Safest picks tonight", "Why are these your best picks?", "Best unders", "Strongest overs on points", "3-leg parlay", "Who gets 10+ rebounds?",
  "Who is due?", "Injury report", "Double-double chances", "How accurate is it?", "Help"];
export const ALL_MARKETS = NBA_MARKETS.map((m) => m.market);
