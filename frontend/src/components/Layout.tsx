import * as React from "react";
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Moon, Settings, Star, Sun } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/format";
import { useLinkSuffix, useSeasonWeek, useTheme, type WeeksResponse } from "@/lib/state";
import { Select } from "./ui";
import { useLiveRecord } from "./LiveRecord";
import { useCfb, type CfbPrevious, type CfbStatus, type Week as CfbWeek } from "@/lib/cfb";
import { useNba, type NbaPrevious, type NbaStatus, type Slate } from "@/lib/nba";

type NavItem = { to: string; label: string; end?: boolean };

/** Inside a sport, one row of tabs toggles between its pages (Andrew, 2026-11-18: "picks of the day tab and the sports,
 *  the top 10 found within each sport, and in each sport toggle through props, games, sims"). Every sport keeps the same
 *  order: Top 10, its research, Parlay, Ask, then the proof pages. */
const sportTabs = (base: string, research: NavItem[], links: { parlay: string; how: string; record: string }): NavItem[] => [
  { to: base, label: "Top 10", end: true },
  ...research,
  { to: links.parlay, label: "Parlay" },
  { to: `${base === "/nfl" ? "" : base}/ask`, label: "Ask" },
  { to: links.record, label: "Track record" },
  { to: links.how, label: "How it works" },
];
const TABS_BY_SPORT: Record<Sport, NavItem[]> = {
  nfl: sportTabs("/nfl", [
    { to: "/props", label: "Props" }, { to: "/sims", label: "Sims" }, { to: "/rankings", label: "Anytime TD" },
    { to: "/hitrates", label: "Hit rates" }, { to: "/defenses", label: "Defenses" },
  ], { parlay: "/builder", how: "/how", record: "/backtest" }),
  cfb: sportTabs("/cfb", [
    { to: "/cfb/games", label: "Games" }, { to: "/cfb/props", label: "Props" }, { to: "/cfb/sims", label: "Sims" }, { to: "/cfb/teams", label: "Teams" },
  ], { parlay: "/cfb/parlay", how: "/cfb/how", record: "/cfb/record" }),
  nba: sportTabs("/nba", [
    { to: "/nba/props", label: "Props" }, { to: "/nba/sims", label: "Sims" }, { to: "/nba/hitrates", label: "Hit rates" },
  ], { parlay: "/nba/builder", how: "/nba/how", record: "/nba/record" }),
};

type Sport = "nfl" | "nba" | "cfb";
/** null: the Picks of the day page (and Settings), which belong to no sport. */
const sportOf = (path: string): Sport | null => (path === "/" || path === "/settings" ? null
  : path === "/nba" || path.startsWith("/nba/") ? "nba" : path === "/cfb" || path.startsWith("/cfb/") ? "cfb" : "nfl");

/** The site's top level: Picks of the day, then one section per sport, each opening on its top 10. */
function MainTabs({ sport, home }: { sport: Sport | null; home: boolean }) {
  const base = "flex items-center gap-1 rounded-md px-2 py-1.5 text-sm font-bold tracking-wide transition-colors sm:px-3";
  const tab = (to: string, on: boolean, label: React.ReactNode, aria?: string) => (
    <NavLink to={to} role="tab" aria-selected={on} aria-label={aria} className={cn(base, on ? "bg-accent text-accent-fg" : "text-muted hover:bg-raised hover:text-fg")}>{label}</NavLink>
  );
  return (
    <div className="flex rounded-lg border border-line bg-surface p-1" role="tablist" aria-label="Section">
      {tab("/", home, <><Star className="h-3.5 w-3.5" aria-hidden /><span className="sm:hidden">Today</span><span className="hidden sm:inline">Picks of the day</span></>, "Picks of the day")}
      {tab("/nfl", sport === "nfl", "NFL")}{tab("/cfb", sport === "cfb", "CFB")}{tab("/nba", sport === "nba", "NBA")}
    </div>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-raised" />
        {/* Lab flask: neck, body and the liquid line */}
        <path d="M13 7h6M14 7v6.5L8.6 22.8A2 2 0 0 0 10.3 26h11.4a2 2 0 0 0 1.7-3.2L18 13.5V7" className="stroke-accent" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.2 19.5h9.6l2 3.4a1 1 0 0 1-.9 1.6H10.1a1 1 0 0 1-.9-1.6z" className="fill-accent" />
      </svg>
      {!compact && (
        <div className="leading-tight">
          <div className="font-display text-[15px] font-bold tracking-tight">The Lab</div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">Props · Sims · Data</div>
        </div>
      )}
    </div>
  );
}

/** Tuesday until rosters post, the new NFL week has no picks yet: the site shows the last week and says when the next posts. */
function NextWeekNote() {
  const { season, week, defaults } = useSeasonWeek();
  const next = defaults?.next_week;
  if (!next || season !== defaults?.current_season || week !== defaults?.current_week) return null;
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface/60 px-3 py-2 text-sm text-muted">
      Week {next} picks post Thursday, once rosters are out. Showing Week {week} results until then.
    </div>
  );
}

function SeasonWeekPicker() {
  const { season, week, set } = useSeasonWeek();
  const weeks = useQuery({ queryKey: ["weeks", season], queryFn: () => api.get<WeeksResponse>("/weeks", { season }), staleTime: 60_000 });
  const seasons = weeks.data?.seasons ?? [season];
  // past weeks' graded picks: the header's way into Previous weeks, as on the other sports
  const live = useLiveRecord();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const results = (live.data?.previous_weeks ?? []).filter((w) => w.season === season).map((w) => `${w.season}-${w.week}`);
  const onPrev = loc.pathname === "/previous";
  const value = onPrev ? `r:${params.get("p") ?? results[0] ?? ""}` : String(week);
  const pick = (v: string) => (v.startsWith("r:") ? nav(`/previous?p=${encodeURIComponent(v.slice(2))}`) : onPrev ? nav(`/props?season=${season}&week=${v}`) : set(season, Number(v)));
  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="season-select">Season</label>
      <Select id="season-select" value={season} onChange={(e) => set(Number(e.target.value), Number(e.target.value) === weeks.data?.current_season ? weeks.data.current_week : 1)} className="hidden h-8 w-auto text-xs sm:block">
        {seasons.map((s) => <option key={s} value={s}>{s}</option>)}
      </Select>
      <label className="sr-only" htmlFor="week-select">Week</label>
      <Select id="week-select" value={value} onChange={(e) => pick(e.target.value)} className="h-8 w-[5.5rem] text-xs sm:w-auto">
        <optgroup label="Picks">
          {(weeks.data?.weeks ?? [{ week, status: "", has_predictions: true }]).map((w) => (
            <option key={w.week} value={w.week} disabled={!w.has_predictions}>
              Week {w.week}{w.status === "upcoming" ? " · upcoming" : w.status === "in_progress" ? " · live" : ""}{!w.has_predictions ? " · no run" : ""}
            </option>
          ))}
        </optgroup>
        {!!results.length && (
          <optgroup label="Results">
            {results.map((k) => <option key={k} value={`r:${k}`}>Week {k.split("-")[1]} · results</option>)}
          </optgroup>
        )}
      </Select>
    </div>
  );
}

/** The NFL header's season and week pickers, for college football (weeks) and the NBA (days). The current week or
 *  slate opens the sport's home page; a past one opens Previous weeks on it. */
function SportPeriodPicker({ sport }: { sport: "cfb" | "nba" }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const cfb = sport === "cfb";
  const cPrev = useCfb<CfbPrevious>("previous.json", cfb);
  const cWeek = useCfb<CfbWeek>("week.json", cfb);
  const cStat = useCfb<CfbStatus>("status.json", cfb);
  const nPrev = useNba<NbaPrevious>("previous.json", !cfb);
  const nSlate = useNba<Slate>("slate.json", !cfb);
  const nStat = useNba<NbaStatus>("status.json", !cfb);
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  let season: string;
  let now: string | null;
  let past: { key: string; label: string }[];
  if (cfb) {
    season = String(cStat.data?.season ?? cPrev.data?.season ?? "");
    const w = cWeek.data?.games[0]?.week;
    now = w != null ? `Week ${w} · upcoming` : null;
    const seen = new Set<string>();
    past = [...(cPrev.data?.games ?? [])].reverse().flatMap((g) => {
      const key = `${g.season_type}-${g.week}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ key, label: g.season_type === "regular" ? `Week ${g.week}` : `Postseason ${g.week}` }];
    });
  } else {
    season = nStat.data?.season_label ?? "";
    now = nSlate.data?.date ? `${day(nSlate.data.date)} · next games` : null;
    past = (nPrev.data?.days ?? []).map((d) => ({ key: d.date, label: day(d.date) }));
  }
  const base = cfb ? "/cfb" : "/nba";
  const onPrev = loc.pathname === `${base}/previous`;
  const value = onPrev ? params.get("p") ?? past[0]?.key ?? "" : "now";
  if (!season && !now && !past.length) return null;
  return (
    <div className="flex items-center gap-1.5">
      {season && (<>
        <label className="sr-only" htmlFor="season-select">Season</label>
        <Select id="season-select" value={season} onChange={() => undefined} className="hidden h-8 w-auto text-xs sm:block">
          <option value={season}>{season}</option>
        </Select>
      </>)}
      <label className="sr-only" htmlFor="week-select">{cfb ? "Week" : "Day"}</label>
      <Select id="week-select" value={value} className="h-8 w-[5.5rem] text-xs sm:w-auto"
        onChange={(e) => nav(e.target.value === "now" ? base : `${base}/previous?p=${encodeURIComponent(e.target.value)}`)}>
        {now && <option value="now">{now}</option>}
        {past.map((p) => <option key={p.key} value={p.key}>{p.label} · results</option>)}
        {onPrev && value === "__all" && <option value="__all">Every {cfb ? "week" : "day"}</option>}
      </Select>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"));
  return (
    <button
      onClick={() => setTheme(dark ? "light" : "dark")}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

export function Layout() {
  const suffix = useLinkSuffix();
  const loc = useLocation();
  const sport = sportOf(loc.pathname);
  // each sport's top 10 (and Picks of the day) has no season/week or day picker
  const top = ["/", "/nfl", "/nba", "/cfb", "/top10"].includes(loc.pathname);
  const nfl = sport === "nfl" && !top;   // only the NFL research pages carry the season/week query
  return (
    <div className="flex min-h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-2 px-3 sm:gap-3 sm:px-6">
          <NavLink to="/" aria-label="The Lab home" className="shrink-0"><span className="hidden lg:block"><Logo /></span><span className="lg:hidden"><Logo compact /></span></NavLink>
          <MainTabs sport={sport} home={loc.pathname === "/"} />
          <div className="flex-1" />
          <NavLink to="/settings" aria-label="Settings" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-fg"><Settings className="h-4 w-4" /></NavLink>
          <ThemeToggle />
        </div>
        {sport && (
          <div className="mx-auto flex w-full max-w-[1400px] items-center gap-2 px-3 sm:px-6">
            <nav aria-label={`${sport.toUpperCase()} pages`} className="-mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]">
              {TABS_BY_SPORT[sport].map((n) => (
                <NavLink key={n.to} to={n.to + (nfl && n.to !== "/nfl" ? suffix : "")} end={n.end}
                  className={({ isActive }) => cn("shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-sm font-semibold transition-colors",
                    isActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{n.label}</NavLink>
              ))}
            </nav>
            {nfl && <div className="shrink-0 py-1.5"><SeasonWeekPicker /></div>}
            {!top && sport !== "nfl" && <div className="shrink-0 py-1.5"><SportPeriodPicker sport={sport} /></div>}
          </div>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-10 pt-5 sm:px-6">
        {nfl && <NextWeekNote />}
        <Outlet />
        <footer className="mt-10 border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
          21+ only. The Lab is sports research, not betting or financial advice; no pick is guaranteed and past results don't promise future ones.
          Bet only what you can afford to lose and where sports betting is legal. Gambling problem? Call or text 1-800-GAMBLER.
        </footer>
      </main>
    </div>
  );
}

export function PageTitle({ title, kicker, children }: { title: string; kicker?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        {kicker && <div className="label mb-1">{kicker}</div>}
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[28px]">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
