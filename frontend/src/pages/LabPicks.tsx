import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Trophy } from "lucide-react";
import { STATIC } from "@/lib/api";
import { chicago, cn, pct } from "@/lib/format";
import { BET, BOARD_MIN_PRICE, confidenceOf, DAILY_MIN_CHANCE, DAILY_MIN_EDGE, LEAN, SPORTS, SURE, SPORT_LABEL, playDate, tally, type DailyPick, type LabBoard, type LabPick, type LabRecord, type Sport } from "@/lib/lab";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, LoadingBlock, Notice, Segmented } from "@/components/ui";
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

/** Each sport's best plays, ranked 1 to 10 by chance to hit. Kept deliberately plain: one sport switch drives the whole
 *  page, each row shows only the bet, when, the price and the chance with its trust tag; the reasons open on tap. */
export default function LabPicks() {
  const q = useQuery({ queryKey: ["lab-board"], queryFn: getBoard, staleTime: 5 * 60_000 });
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [sp, setSp] = useSearchParams();
  const sport: Sport = SPORTS.includes(sp.get("sport") as Sport) ? (sp.get("sport") as Sport) : "nfl";
  const b = q.data;
  const board = (b?.board ?? []).filter((p) => p.sport === sport);
  const note = b?.notes?.[sport];
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="space-y-4">
      <PageTitle kicker={b ? `Updated ${chicago(b.generated_at)}` : "Every sport"} title={`Top 10 picks: ${SPORT_LABEL[sport]}`} />
      <div className="-mt-3 space-y-3">
        {/* one switch for the whole page; each label carries that sport's top 10 record */}
        <Segmented label="Sport" value={sport} onChange={(v) => setSp({ sport: v }, { replace: true })}
          options={SPORTS.map((s) => ({ value: s, label: <>{SPORT_LABEL[s]}{b && b.record.by_sport[s]?.n ? <span className="ml-1 text-xs font-normal opacity-75">{recText(b.record.by_sport[s])}</span> : null}</> }))} />
        <Legend />
      </div>
      {b && stale(b.generated_at) && <Notice tone="warn" title="These picks haven't refreshed in over a day">
        Last refresh {chicago(b.generated_at)}. Check injury news and your book's line before betting.</Notice>}
      {q.isLoading && <Card><LoadingBlock rows={6} className="p-5" /></Card>}
      {q.isError && <Notice title="Not published yet">{(q.error as Error).message}</Notice>}
      {b && !b.sports[sport]?.loaded && <Notice tone="warn" title={`${SPORT_LABEL[sport]} numbers were not available on the last refresh`}>The list comes back with the next refresh.</Notice>}
      {b && b.sports[sport]?.loaded && note && <Notice tone="info">{note}{!board.length ? " Picks appear as lines are posted and the sport refreshes." : ""}</Notice>}

      {b?.daily && <DailyCard b={b} sport={sport} />}

      {!!board.length && (
        <Card className="overflow-hidden">
          <CardHeader title="Top 10" subtitle="#1 is the likeliest to hit. Tap a pick for why." />
          <ol className="divide-y divide-line/60">
            {board.map((p) => <PickRow key={p.id} p={p} open={open.has(p.id)} onToggle={() => toggle(p.id)} />)}
          </ol>
        </Card>
      )}

      {b && <RecordCard b={b} sport={sport} />}

      <details className="group rounded-xl border border-line bg-surface text-xs text-muted">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-fg sm:px-5">
          How picks are chosen <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" aria-hidden /></summary>
        <div className="space-y-1.5 px-4 pb-4 sm:px-5">
          <p>Every game is simulated 5,000 times. Each chance is then checked against how similar picks really did, and the 10 likeliest make the list,
            spread one per game and player first. Only lines a sportsbook has posted count, priced {BOARD_MIN_PRICE} or longer (a heavier favorite risks too much to win too little).
            NFL picks come from confidence tiers that hit 50%+ on games the model never saw; NBA picks are players sure to play; college picks are mostly favorites to win outright,
            since college spreads and totals rarely get past 55%.</p>
          <p>Picks of the day are stricter: {n100(DAILY_MIN_CHANCE)}%+ to hit and at least {n100(DAILY_MIN_EDGE)} points likelier than the book's price says. On a thin day the
            rest of the 3 are marked <b>Extra</b>: they're the next likeliest plays, can change until kickoff and count with the top 10, not the picks-of-the-day record.</p>
          <p>A pick on the list at kickoff is frozen and graded after the final. Records count only book lines; units assume 1 unit a pick at the locked price.
            Even a 90% pick loses 1 time in 10. Research, not betting advice.</p>
        </div>
      </details>
    </div>
  );
}

/** The four trust tags, once, in a single row. */
function Legend() {
  const tags = [[SURE, "Top confidence", `${n100(SURE)}%+`], [BET, "Bet", `${n100(BET)}%+`], [LEAN, "Lean", `${n100(LEAN)}–${n100(BET)}%`], [0, "Risky", `under ${n100(LEAN)}%`]] as const;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {tags.map(([c, label, range]) => (
        <span key={label} title={confidenceOf(c).advice}><b className={TONE_CLASS[confidenceOf(c).tone]}>{label}</b> {range}</span>
      ))}
    </div>
  );
}

function PickRow({ p, open, onToggle }: { p: LabPick; open: boolean; onToggle: () => void }) {
  return (
    <li>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raised/50 sm:px-5">
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-display text-base font-bold",
          p.rank === 1 ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent")}>{p.rank}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-snug">{p.bet}</div>
          <div className="mt-0.5 text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.price != null ? ` · ${price(p.price)}` : ""}{p.line_source === "usual" ? " · check your book's line" : ""}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-display text-lg font-bold leading-tight">{pct(p.chance, 0)}</div>
          {p.result ? <ResultBadge p={p} /> : <ConfidenceTag chance={p.chance} />}
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
function ConfidenceTag({ chance }: { chance: number }) {
  const c = confidenceOf(chance);
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
  const lines = ps.filter((p) => !p.withdrawn).map((p) => `${p.slot}. ${p.bet}${p.price != null ? ` ${price(p.price)}` : ""} (${p.matchup}): ${pct(p.chance, 0)} to hit${p.fill ? ` (${confidenceOf(p.chance).label.toLowerCase()}, below our 60% bar)` : ""}`);
  return [`The Lab's ${SPORT_LABEL[sport]} picks of the day, ${day(date)}`, ...lines,
    r.n ? `Picks of the day: ${recText(r)}${unitsText(r) ? `, ${unitsText(r)}` : ""} (book lines only, 1 unit a pick)` : "", "21+. Not betting advice."].filter(Boolean).join("\n");
}

/** The sport's 3 picks of the day (today, and tomorrow once chosen), locked when chosen and tracked separately. */
function DailyCard({ b, sport }: { b: LabBoard; sport: Sport }) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const groups = new Map<string, DailyPick[]>();
  for (const p of b.daily.picks.filter((d) => d.sport === sport)) groups.set(p.date, [...(groups.get(p.date) ?? []), p]);
  const rec = b.daily.record.by_sport[sport];
  const copy = (key: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 2000); }, () => {});
  };
  return (
    <Card>
      <CardHeader title="Picks of the day" icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle={rec?.n ? `Record ${recText(rec)}${rec.rate != null ? ` (${pct(rec.rate, 0)})` : ""}${unitsText(rec) ? `, ${unitsText(rec)}` : ""}` : "Our 3 strongest picks each game day"} />
      {!groups.size && <CardBody><p className="text-sm text-muted">Picks post once {SPORT_LABEL[sport]} games have lines, and stay put once chosen.</p></CardBody>}
      {[...groups.entries()].map(([date, ps]) => (
        <div key={date} className="border-t border-line/60 first:border-t-0">
          <div className="flex items-center justify-between gap-3 px-4 pt-3 sm:px-5">
            <span className="text-sm font-semibold">{date === b.daily.today ? "Today" : day(date)}</span>
            <button type="button" className="text-xs text-accent hover:underline" onClick={() => copy(date, postText(sport, date, ps, rec))}>
              {copied === date ? "Copied" : "Copy for posting"}</button>
          </div>
          <ol className="divide-y divide-line/40">
            {ps.map((p) => {
              const c = confidenceOf(p.chance);
              return (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                  <span className="w-5 shrink-0 text-center font-display font-bold text-accent">{p.slot}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{p.bet}</div>
                    <div className="text-xs text-muted">{p.matchup} · {when(p.kickoff)}{p.price != null ? ` · ${price(p.price)}` : ""}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold">{pct(p.chance, 0)}</div>
                    {p.result ? <ResultBadge p={p} /> : p.fill
                      ? <div className={cn("text-[11px] font-semibold", TONE_CLASS[c.tone])} title={`Under the ${n100(DAILY_MIN_CHANCE)}% bar: the next likeliest play, not in the picks-of-the-day record. ${c.advice}`}>Extra · {c.label}</div>
                      : <ConfidenceTag chance={p.chance} />}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </Card>
  );
}

const recText = (r: LabRecord) => (r.n ? `${r.won}-${r.lost}${r.push ? `-${r.push}` : ""}` : "–");
const unitsText = (r: LabRecord) => (r.priced ? `${r.units >= 0 ? "+" : "−"}${Math.abs(r.units).toFixed(1)}u` : "");

/** A record as the results card shows it: W-L and hit rate, units underneath. */
function RecordStat({ label, r }: { label: string; r: LabRecord }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="font-display text-xl font-bold">{recText(r)}{r.rate != null && <span className="ml-1.5 text-sm font-semibold text-muted">{pct(r.rate, 0)}</span>}</div>
      {r.priced > 0 && <div className={cn("text-xs font-semibold", r.units >= 0 ? "text-ok" : "text-danger")}
        title={`${r.roi! >= 0 ? "+" : "−"}${Math.abs(r.roi! * 100).toFixed(1)}% ROI${r.priced < r.n ? ` on ${r.priced} priced picks` : ""}, 1 unit a pick`}>{unitsText(r)}</div>}
    </div>
  );
}

const RECENT_DAYS = 3;

/** Every pick that was on the list at kickoff (and every pick of the day) for the page's sport, graded after the final, by day. */
function RecordCard({ b, sport }: { b: LabBoard; sport: Sport }) {
  const [all, setAll] = React.useState(false);
  const r = b.record.by_sport[sport];
  const dr = b.daily?.record.by_sport[sport];
  const recent = b.recent.filter((p) => p.sport === sport);
  const potd = new Map((b.daily ? [...b.daily.recent, ...b.daily.picks] : []).filter((d) => d.sport === sport && !d.fill).map((d) => [`${d.game_id}|${d.bet}`, d]));
  // picks of the day that never made the top 10 still belong in the results
  const rows: (LabPick & { day?: number })[] = [...recent];
  const seen = new Set(recent.map((p) => `${p.game_id}|${p.bet}`));
  potd.forEach((d, k) => { if (!seen.has(k) && new Date(d.kickoff) <= new Date(b.generated_at)) rows.push(d); });
  const byDay = new Map<string, LabPick[]>();
  for (const p of rows.sort((x, y) => y.kickoff.localeCompare(x.kickoff))) {
    const d = playDate(p.kickoff); byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }
  const days = [...byDay.entries()];
  const shown = all ? days : days.slice(0, RECENT_DAYS);
  return (
    <Card>
      <CardHeader title={`${SPORT_LABEL[sport]} results`} icon={<Trophy className="h-4 w-4 text-accent" />}
        subtitle="Graded after each final. Picks never change after kickoff." />
      <CardBody className="space-y-2">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <RecordStat label="Top 10" r={r} />
          {dr && <RecordStat label="Picks of the day" r={dr} />}
        </div>
        {!rows.length && <p className="text-sm text-muted">Results show here once the first games on the list are played.</p>}
      </CardBody>
      {shown.map(([d, ps]) => {
        const t = tally(ps);
        return (
          // keyed by sport too, so switching sports builds a fresh list instead of reusing the last sport's rows
          <div key={`${sport}|${d}`} className="border-t border-line">
            <div className="flex items-center justify-between bg-raised/40 px-4 py-1.5 text-xs font-semibold sm:px-5">
              <span>{day(d)}</span><span className="text-muted">{t.n ? recText(t) : ps.some((p) => !p.result) ? "Pending" : t.unbooked ? "Not counted" : "Void"}</span>
            </div>
            <ul className="divide-y divide-line/60">
              {ps.map((p) => {
                const daily = potd.get(`${p.game_id}|${p.bet}`);
                const actual = daily?.actual ?? p.actual;
                return (
                  // a pick of the day can share its top 10 pick's id at another line (Ty Jerome 23.5 and 24.5, 10/29): key by bet
                  <li key={`${p.id}|${p.bet}`} className="flex items-center gap-3 px-4 py-2 text-sm sm:px-5">
                    <ResultMark p={daily?.result ? daily : p} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-snug">{p.bet}{daily && <span className="ml-1.5 rounded bg-accent/10 px-1 py-px text-[10px] font-semibold text-accent" title="Pick of the day">POTD</span>}</div>
                      {actual && <div className="truncate text-xs text-muted">{actual}</div>}
                    </div>
                    <div className="shrink-0 text-xs text-muted">{pct(p.chance, 0)}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {days.length > RECENT_DAYS && (
        <button type="button" onClick={() => setAll((v) => !v)} className="w-full border-t border-line px-4 py-2.5 text-xs font-semibold text-accent hover:bg-raised/50">
          {all ? "Show fewer days" : `Show ${days.length - RECENT_DAYS} older ${days.length - RECENT_DAYS === 1 ? "day" : "days"}`}</button>
      )}
    </Card>
  );
}

/** A big hit / miss mark for the results list. */
function ResultMark({ p }: { p: LabPick }) {
  if (p.result && p.line_source !== "book") return <span title="Not counted: no sportsbook line" aria-label="Not counted: no sportsbook line"
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-muted">NC</span>;
  const r = p.result;
  const [txt, cls] = r === "won" ? ["✓", "bg-ok/15 text-ok"] : r === "lost" ? ["✗", "bg-danger/15 text-danger"]
    : r === "push" ? ["P", "bg-raised text-muted"] : r === "void" ? ["–", "bg-raised text-muted"] : ["…", "bg-raised text-muted"];
  const label = r ? { won: "Hit", lost: "Miss", push: "Push", void: "Void (did not play)" }[r] : "Pending";
  return <span title={label} aria-label={label} className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold", cls)}>{txt}</span>;
}
