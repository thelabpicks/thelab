import * as React from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Star, Trophy } from "lucide-react";
import { STATIC } from "@/lib/api";
import { chicago, cn, pct } from "@/lib/format";
import { BET, BOARD_MIN_PRICE, confidenceOf, counts, isBet, LEAN_ONLY_ADVICE, leanOnly, DAILY_MIN_CHANCE, DAILY_MIN_EDGE, LEAN, SPORTS, SURE, SPORT_LABEL, playDate, tally, type DailyPick, type LabBoard, type LabPick, type LabRecord, type Sport } from "@/lib/lab";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice } from "@/components/ui";
import { WriteUp } from "@/components/WriteUp";

const URL = STATIC ? `${import.meta.env.BASE_URL}data/lab/board.json` : "/api/lab/board.json";

async function getBoard(): Promise<LabBoard> {
  const r = await fetch(URL);
  if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error("The Lab's picks are built on each site refresh and are not published yet.");
  return r.json();
}

const when = (iso: string) => `${new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })} CT`;
const price = (p: number | null) => (p == null ? "" : p > 0 ? `+${p}` : String(p));
/** The board is rebuilt several times a day; older than 30 hours means a refresh failed. */
const stale = (iso: string) => Date.now() - new Date(iso).getTime() > 30 * 3600_000;

const n100 = (x: number) => Math.round(x * 100);

/** A sport's picks page and home: its top 10 with picks of the day starred, then results. Kept deliberately plain
 *  (Andrew, 2026-11-17: "people get the picks they will win, not too busy"): Bets first under their real record, Leans
 *  after under theirs, each row only the bet, when, price and chance; reasons open on tap. */
export default function LabPicks({ sport }: { sport: Sport }) {
  const q = useQuery({ queryKey: ["lab-board"], queryFn: getBoard, staleTime: 5 * 60_000 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const b = q.data;
  const board = (b?.board ?? []).filter((p) => p.sport === sport);
  const note = b?.notes?.[sport];
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // only real picks of the day are starred and copied; fill-ins are just more top 10 picks and are not tracked
  const today = (b?.daily?.picks ?? []).filter((d) => d.sport === sport && d.date === b?.daily.today && !d.withdrawn && !d.fill);
  const starred = new Set(today.map((d) => `${d.game_id}|${d.bet}`));
  const tags = b?.record.by_tag?.[sport];
  const bets = board.filter(isBet), leans = board.filter((p) => !isBet(p));
  const row = (p: LabPick) => <PickRow key={p.id} p={p} star={starred.has(`${p.game_id}|${p.bet}`)} open={open.has(p.id)} onToggle={() => toggle(p.id)} />;
  return (
    <div className="space-y-4">
      <PageTitle kicker={b ? `Updated ${chicago(b.generated_at)}` : SPORT_LABEL[sport]} title={`${SPORT_LABEL[sport]} picks`} />
      {b && <RecordLine b={b} sport={sport} />}
      {b && stale(b.generated_at) && <Notice tone="warn" title="These picks haven't refreshed in over a day">
        Last refresh {chicago(b.generated_at)}. Check injury news and your book's line before betting.</Notice>}
      {q.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {q.isError && <Notice title="Not published yet">{(q.error as Error).message}</Notice>}
      {b && !b.sports[sport]?.loaded && <Notice tone="warn" title={`${SPORT_LABEL[sport]} numbers were not available on the last refresh`}>The list comes back with the next refresh.</Notice>}
      {b && b.sports[sport]?.loaded && note && !board.length && <Notice tone="info">{note}</Notice>}

      {!!board.length && (
        <Card className="overflow-hidden">
          <CardHeader title="Top 10" subtitle={<>Likeliest first. <Star className="inline h-3 w-3 -translate-y-px fill-accent text-accent" aria-hidden /> = pick of the day. Tap a pick for why.</>}
            action={b && today.length ? <CopyPicks b={b} sport={sport} ps={today} /> : undefined} />
          {!!bets.length && <GroupHead label="Bets" range={`${n100(BET)}%+`} r={tags?.bet} tone="text-accent" />}
          <ol className="divide-y divide-line/60">{bets.map(row)}</ol>
          {!!leans.length && <GroupHead label="Leans" range={`under ${n100(BET)}%: small bets at most`} r={tags?.lean} tone="text-warn" />}
          <ol className="divide-y divide-line/60">{leans.map(row)}</ol>
        </Card>
      )}

      {b && <RecordCard b={b} sport={sport} />}

      <details className="group rounded-xl border border-line bg-surface text-xs text-muted">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-fg sm:px-5">
          How picks are chosen <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" aria-hidden /></summary>
        <div className="space-y-1.5 px-4 pb-4 sm:px-5">
          <p>Every game is simulated 5,000 times. Each chance at a sportsbook line is then shown as what picks rated that high have really
            hit at book lines, so a 60% pick is one that has won about 6 times in 10. The 10 likeliest make the list, spread one per game and player first.
            Only lines a sportsbook has posted count, priced {BOARD_MIN_PRICE} or longer (a heavier favorite risks too much to win too little).</p>
          <p><b className="text-ok">Top confidence</b> {n100(SURE)}%+ · <b className="text-accent">Bet</b> {n100(BET)}%+ · <b className="text-warn">Lean</b> {n100(LEAN)}–{n100(BET)}%, a small bet at most ·{" "}
            <b className="text-danger">Risky</b> under {n100(LEAN)}%, close to a coin flip.</p>
          <p>Picks of the day (starred) are stricter: {n100(DAILY_MIN_CHANCE)}%+ to hit and at least {n100(DAILY_MIN_EDGE)} points likelier than the book's price says,
            locked when chosen and tracked on their own record. A day with no pick that strong gets none.</p>
          <p>A pick on the list at kickoff is frozen and graded after the final. Records count only book lines with a {n100(BET)}%+ chance at lock; leans under that still show, marked NC (not counted). NFL player props (not anytime touchdowns) are shown as leans and not counted
            for now: since Week 8 the model has not beaten the books' own lines on them, so they return only once a new input does over 3+ weeks. Units assume 1 unit a pick at the locked price.
            Even a 90% pick loses 1 time in 10. Research, not betting advice.</p>
        </div>
      </details>
    </div>
  );
}

/** The Picks of the day tab, the site's front page: today's locks for every sport, their record, and the last results.
 *  Only real picks of the day ({DAILY_MIN_CHANCE}+, beating the book's price); a day without one says so instead of
 *  topping up with weaker picks (Andrew, 2026-11-18: "the picks of the day need to be locks"). */
export function DailyPicks() {
  const q = useQuery({ queryKey: ["lab-board"], queryFn: getBoard, staleTime: 5 * 60_000 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const b = q.data;
  const real = (d: DailyPick) => !d.fill && !d.withdrawn;
  const today = (b?.daily?.picks ?? []).filter((d) => d.date === b?.daily.today && real(d));
  const r = b?.daily?.record;
  // the latest day with graded picks of the day, every sport together
  const graded = (b?.daily?.recent ?? []).filter((d) => real(d) && d.result);
  const last = graded.reduce((m, d) => (d.date > m ? d.date : m), "");
  const lastDay = graded.filter((d) => d.date === last);
  return (
    <div className="space-y-4">
      <PageTitle kicker={b ? `Updated ${chicago(b.generated_at)}` : "The Lab"} title="Picks of the day" />
      <p className="-mt-3 text-sm text-muted">Our strongest picks only: {n100(DAILY_MIN_CHANCE)}%+ to hit at a sportsbook line, and likelier than the book's price says. Locked when posted, graded after the final.</p>
      {r?.n ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
          <span><span className="text-muted">All sports</span> <b>{recText(r)}</b>{r.rate != null && <span className="text-muted"> ({pct(r.rate, 0)})</span>}
            {r.priced > 0 && <b className={cn("ml-1", r.units >= 0 ? "text-ok" : "text-danger")}>{unitsText(r)}</b>}</span>
          {SPORTS.map((sp) => r.by_sport[sp]?.n ? <span key={sp}><span className="text-muted">{SPORT_LABEL[sp]}</span> <b>{recText(r.by_sport[sp])}</b></span> : null)}
        </div>
      ) : null}
      {b && stale(b.generated_at) && <Notice tone="warn" title="These picks haven't refreshed in over a day">
        Last refresh {chicago(b.generated_at)}. Check injury news and your book's line before betting.</Notice>}
      {q.isLoading && <Card><LoadingBlock rows={4} className="p-5" /></Card>}
      {q.isError && <Notice title="Not published yet">{(q.error as Error).message}</Notice>}
      {b && !today.length && (
        <Notice tone="info" title="No locks today">Nothing reached {n100(DAILY_MIN_CHANCE)}% at a sportsbook line yet, so there is no pick of the day.
          Locks post as lines come out. Each sport's top 10 still has today's best picks:{" "}
          <Link to="/nfl" className="text-accent hover:underline">NFL</Link>, <Link to="/cfb" className="text-accent hover:underline">CFB</Link>,{" "}
          <Link to="/nba" className="text-accent hover:underline">NBA</Link>.</Notice>
      )}
      {b && SPORTS.map((sp) => {
        const ps = today.filter((d) => d.sport === sp);
        if (!ps.length) return null;
        return (
          <Card key={sp} className="overflow-hidden">
            <CardHeader title={SPORT_LABEL[sp]} subtitle={<Link to={sp === "nfl" ? "/nfl" : `/${sp}`} className="hover:underline">See the full {SPORT_LABEL[sp]} top 10 →</Link>}
              action={<CopyPicks b={b} sport={sp} ps={ps} />} />
            <ol className="divide-y divide-line/60">
              {ps.map((d) => <PickRow key={d.id} p={{ ...d, rank: d.slot }} star={false} open={open.has(d.id)} onToggle={() => toggle(d.id)} />)}
            </ol>
          </Card>
        );
      })}
      {!!lastDay.length && (
        <Card>
          <CardHeader title="Last results" icon={<Trophy className="h-4 w-4 text-accent" />} subtitle={day(last)}
            action={<span className="text-xs font-semibold text-muted">{recText(tally(lastDay, 0))}</span>} />
          <ul className="divide-y divide-line/60 border-t border-line">
            {lastDay.map((d) => (
              <li key={`${d.id}|${d.bet}`} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                <ResultMark p={d} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium leading-snug">{d.bet}</div>
                  <div className="truncate text-xs text-muted">{SPORT_LABEL[d.sport]}{d.actual ? ` · ${d.actual}` : ""}</div>
                </div>
                <span className="shrink-0 text-xs text-muted">{pct(d.chance, 0)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** One line under the title: the sport's top 10 and picks-of-the-day records. */
function RecordLine({ b, sport }: { b: LabBoard; sport: Sport }) {
  const r = b.record.by_sport[sport], d = b.daily?.record.by_sport[sport];
  if (!r?.n && !d?.n) return null;
  const part = (label: string, x?: LabRecord) => (x?.n ? (
    <span><span className="text-muted">{label}</span> <b>{recText(x)}</b>{x.rate != null && <span className="text-muted"> ({pct(x.rate, 0)})</span>}
      {x.priced > 0 && <b className={cn("ml-1", x.units >= 0 ? "text-ok" : "text-danger")}>{unitsText(x)}</b>}</span>) : null);
  return <div className="-mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">{part("Top 10", r)}{part("Picks of the day", d)}</div>;
}

/** The heading over a group of picks, with how that kind of pick has really done. */
function GroupHead({ label, range, r, tone }: { label: string; range: string; r?: LabRecord; tone: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 bg-raised/40 px-4 py-1.5 text-xs sm:px-5">
      <span><b className={tone}>{label}</b> <span className="text-muted">{range}</span></span>
      {r?.n ? <span className="shrink-0 text-muted">have hit <b className="text-fg">{pct(r.rate!, 0)}</b> ({recText(r)})</span> : null}
    </div>
  );
}

/** Today's picks of the day as text, ready to post. */
function CopyPicks({ b, sport, ps }: { b: LabBoard; sport: Sport; ps: DailyPick[] }) {
  const [copied, setCopied] = React.useState(false);
  const rec = b.daily.record.by_sport[sport];
  return (
    <button type="button" className="whitespace-nowrap text-xs font-semibold text-accent hover:underline"
      onClick={() => navigator.clipboard?.writeText(postText(sport, b.daily.today, ps, rec)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {})}>
      {copied ? "Copied" : "Copy picks of the day"}</button>
  );
}

function PickRow({ p, star, open, onToggle }: { p: LabPick; star: boolean; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised/50 sm:px-5">
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-display text-base font-bold",
          p.rank === 1 ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent")}>{p.rank}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{star && <Star className="mr-1 inline h-3.5 w-3.5 -translate-y-px fill-accent text-accent" aria-label="Pick of the day" />}{p.bet}</div>
          <div className="mt-0.5 text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.price != null ? ` · ${price(p.price)}` : ""}{p.line_source === "usual" ? " · check your book's line" : ""}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-lg font-bold leading-tight">{pct(p.chance, 0)}</div>
          {p.result ? <ResultBadge p={p} /> : <ConfidenceTag p={p} />}
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="border-t border-line/60 bg-bg/30">
          {p.headline && <p className="px-4 pt-3 text-sm sm:px-5">{p.headline}</p>}
          <WriteUp sections={p.sections} />
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs text-muted sm:px-5">
            <span>{[p.book && `${price(p.price)} at ${p.book}`, p.tier && `${p.tier}${p.tier_rate != null ? `: hit ${pct(p.tier_rate, 0)} in testing` : ""}`].filter(Boolean).join(" · ")}</span>
            <Link to={p.link} className="text-accent hover:underline">{p.link.includes("/players/") ? "Game-by-game stats →" : `Open in ${SPORT_LABEL[p.sport]} →`}</Link>
          </div>
        </div>
      )}
    </li>
  );
}

const TONE_CLASS = { ok: "text-ok", accent: "text-accent", warn: "text-warn", danger: "text-danger" } as const;
function ConfidenceTag({ p }: { p: LabPick }) {
  // an NFL prop at 60%+ still reads as a Lean: those markets are leans only for now (lab.ts leanOnly)
  const c = leanOnly(p) && p.chance >= BET ? { label: "Lean", tone: "warn" as const, advice: LEAN_ONLY_ADVICE } : confidenceOf(p.chance);
  return <div className={cn("text-[11px] font-semibold", TONE_CLASS[c.tone])} title={c.advice}>{c.label}</div>;
}

function ResultBadge({ p }: { p: LabPick }) {
  const tone = p.result === "won" ? "ok" : p.result === "lost" ? "danger" : "neutral";
  const label = { won: "Hit", lost: "Miss", push: "Push", void: "Void" }[p.result!];
  return <Badge tone={tone} title={p.actual}>{label}</Badge>;
}

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });

/** The text of one sport's picks of the day, ready to post. */
function postText(sport: Sport, date: string, ps: DailyPick[], r: LabRecord): string {
  const lines = ps.filter((p) => !p.withdrawn).map((p) => `${p.slot}. ${p.bet}${p.price != null ? ` ${price(p.price)}` : ""} (${p.matchup}): ${pct(p.chance, 0)} to hit`);
  return [`The Lab's ${SPORT_LABEL[sport]} picks of the day, ${day(date)}`, ...lines,
    r.n ? `Picks of the day: ${recText(r)}${unitsText(r) ? `, ${unitsText(r)}` : ""} (book lines only, 1 unit a pick)` : "", "21+. Not betting advice."].filter(Boolean).join("\n");
}

const recText = (r: LabRecord) => (r.n ? `${r.won}-${r.lost}${r.push ? `-${r.push}` : ""}` : "–");
const unitsText = (r: LabRecord) => (r.priced ? `${r.units >= 0 ? "+" : "−"}${Math.abs(r.units).toFixed(1)}u` : "");


const RECENT_PICKS = 5;
type Shown = Sport | "all";

/** Graded picks, newest first: every pick that was on a top 10 at kickoff and every pick of the day (those that never made
 *  the top 10 too), with each one's pick of the day when it was one. */
function resultRows(b: LabBoard, sports: Sport[]) {
  const potd = new Map((b.daily ? [...b.daily.recent, ...b.daily.picks] : []).filter((d) => sports.includes(d.sport) && !d.fill).map((d) => [`${d.sport}|${d.game_id}|${d.bet}`, d]));
  const rows: LabPick[] = b.recent.filter((p) => sports.includes(p.sport));
  const seen = new Set(rows.map((p) => `${p.sport}|${p.game_id}|${p.bet}`));
  potd.forEach((d, k) => { if (!seen.has(k) && new Date(d.kickoff) <= new Date(b.generated_at)) rows.push(d); });
  return { potd, rows: rows.sort((x, y) => y.kickoff.localeCompare(x.kickoff)) };
}

/** Results: the 5 latest graded picks, any sport on a tap (Andrew, 2026-11-18: "show the other sports and only the most
 *  recent 5 unless someone wants to click further"); more open 10 at a time. */
function RecordCard({ b, sport }: { b: LabBoard; sport: Sport }) {
  const [shownSport, setShownSport] = React.useState<Shown>(sport);
  const [limit, setLimit] = React.useState(RECENT_PICKS);
  React.useEffect(() => { setShownSport(sport); setLimit(RECENT_PICKS); }, [sport]);
  const { potd, rows } = resultRows(b, shownSport === "all" ? SPORTS : [shownSport]);
  const shown = rows.slice(0, limit);
  const byDay = new Map<string, LabPick[]>();
  for (const p of shown) { const d = playDate(p.kickoff); byDay.set(d, [...(byDay.get(d) ?? []), p]); }
  const pickSport = (v: Shown) => { setShownSport(v); setLimit(RECENT_PICKS); };
  const chip = (v: Shown, label: string) => (
    <button key={v} type="button" onClick={() => pickSport(v)} aria-pressed={shownSport === v}
      className={cn("rounded-md px-2 py-1 text-xs font-semibold", shownSport === v ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised hover:text-fg")}>{label}</button>
  );
  return (
    <Card>
      <CardHeader title="Results" icon={<Trophy className="h-4 w-4 text-accent" />} subtitle="Latest first. Graded after each final; picks never change after kickoff." />
      <div className="flex flex-wrap gap-1 border-t border-line px-4 py-2 sm:px-5" role="group" aria-label="Results for">
        {SPORTS.map((sp) => chip(sp, SPORT_LABEL[sp]))}{chip("all", "All")}
      </div>
      {!rows.length && <CardBody><p className="text-sm text-muted">Results show here once the first games on the list are played.</p></CardBody>}
      {[...byDay.entries()].map(([d, ps]) => (
        <div key={`${shownSport}|${d}`} className="border-t border-line">
          <div className="bg-raised/40 px-4 py-1.5 text-xs font-semibold sm:px-5">{day(d)}</div>
          <ul className="divide-y divide-line/60">
            {ps.map((p) => {
              const daily = potd.get(`${p.sport}|${p.game_id}|${p.bet}`);
              const actual = daily?.actual ?? p.actual;
              return (
                // a pick of the day can share its top 10 pick's id at another line (Ty Jerome 23.5 and 24.5, 10/29): key by bet
                <li key={`${p.id}|${p.bet}`} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                  <ResultMark p={daily?.result ? daily : p} floor={daily?.result ? 0 : BET} />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{p.bet}{daily && <span className="ml-1.5 rounded bg-accent/10 px-1 py-px text-[10px] font-semibold text-accent" title="Pick of the day">POTD</span>}</div>
                    <div className="truncate text-xs text-muted">{[shownSport === "all" && SPORT_LABEL[p.sport], actual].filter(Boolean).join(" · ")}</div>
                  </div>
                  <div className="shrink-0 text-xs text-muted">{pct(p.chance, 0)}</div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {(rows.length > limit || limit > RECENT_PICKS) && (
        <div className="flex border-t border-line text-xs font-semibold text-accent">
          {rows.length > limit && <button type="button" onClick={() => setLimit((n) => n + 10)} className="flex-1 px-4 py-2.5 hover:bg-raised/50">Show more results</button>}
          {limit > RECENT_PICKS && <button type="button" onClick={() => setLimit(RECENT_PICKS)} className="flex-1 px-4 py-2.5 text-muted hover:bg-raised/50">Show fewer</button>}
        </div>
      )}
    </Card>
  );
}

/** A big hit / miss mark for the results list. */
function ResultMark({ p, floor = BET }: { p: LabPick; floor?: number }) {
  const why = p.line_source !== "book" ? "Not counted: no sportsbook line" : leanOnly(p) ? `Not counted: ${LEAN_ONLY_ADVICE}` : `Not counted: a lean under ${n100(BET)}% at lock`;
  if (p.result && !counts(p, floor)) return <span title={why} aria-label={why}
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-muted">NC</span>;
  const r = p.result;
  const [txt, cls] = r === "won" ? ["✓", "bg-ok/15 text-ok"] : r === "lost" ? ["✗", "bg-danger/15 text-danger"]
    : r === "push" ? ["P", "bg-raised text-muted"] : r === "void" ? ["–", "bg-raised text-muted"] : ["…", "bg-raised text-muted"];
  const label = r ? { won: "Hit", lost: "Miss", push: "Push", void: "Void (did not play)" }[r] : "Pending";
  return <span title={label} aria-label={label} className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", cls)}>{txt}</span>;
}
