import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "./api";

export type WeekInfo = { week: number; games: number; completed: number; status: string; has_predictions: boolean; first_day: string };
export type WeeksResponse = { season: number; seasons: number[]; current_season: number; current_week: number; next_week?: number | null; weeks: WeekInfo[] };

/** Season/week live in the URL (?season=&week=) so views are linkable and switching is instant. */
export function useSeasonWeek() {
  const [sp, setSp] = useSearchParams();
  const defaults = useQuery({ queryKey: ["weeks", "default"], queryFn: () => api.get<WeeksResponse>("/weeks"), staleTime: 60_000 });
  const season = Number(sp.get("season")) || defaults.data?.current_season || 2026;
  const week = Number(sp.get("week")) || defaults.data?.current_week || 7;
  const set = React.useCallback(
    (s: number, w: number) => {
      const next = new URLSearchParams(sp);
      next.set("season", String(s));
      next.set("week", String(w));
      setSp(next, { replace: true });
    },
    [sp, setSp],
  );
  return { season, week, set, defaults: defaults.data, isCurrent: season === defaults.data?.current_season && week === defaults.data?.current_week };
}

/** Keep ?season&week when navigating between pages. */
export function useLinkSuffix() {
  const [sp] = useSearchParams();
  const s = new URLSearchParams();
  if (sp.get("season")) s.set("season", sp.get("season")!);
  if (sp.get("week")) s.set("week", sp.get("week")!);
  const q = s.toString();
  return q ? `?${q}` : "";
}

/* ---------------------------------------------------------------- pinned candidates (max 3) */
export type Pin = { player_id: string; team: string; player_name: string; position: string; opponent: string | null; season: number; week: number };
type PinCtx = { pins: Pin[]; toggle: (p: Pin) => void; clear: () => void; has: (id: string) => boolean };
const PinContext = React.createContext<PinCtx | null>(null);

function readPins(): Pin[] {
  try {
    return JSON.parse(localStorage.getItem("fg-pins") || "[]");
  } catch {
    return [];
  }
}

export function PinProvider({ children }: { children: React.ReactNode }) {
  const [pins, setPins] = React.useState<Pin[]>(readPins);
  React.useEffect(() => {
    try {
      localStorage.setItem("fg-pins", JSON.stringify(pins));
    } catch {
      /* storage unavailable */
    }
  }, [pins]);
  const value = React.useMemo<PinCtx>(
    () => ({
      pins,
      has: (id) => pins.some((p) => p.player_id === id),
      clear: () => setPins([]),
      toggle: (p) =>
        setPins((cur) => {
          if (cur.some((x) => x.player_id === p.player_id)) return cur.filter((x) => x.player_id !== p.player_id);
          const same = cur.filter((x) => x.season === p.season && x.week === p.week);
          return same.length >= 3 ? same : [...same, p];
        }),
    }),
    [pins],
  );
  return <PinContext.Provider value={value}>{children}</PinContext.Provider>;
}

export function usePins() {
  const v = React.useContext(PinContext);
  if (!v) throw new Error("PinProvider missing");
  return v;
}

/* ---------------------------------------------------------------- theme */
export type Theme = "dark" | "light" | "system";
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = React.useState<Theme>(() => {
    try {
      return (localStorage.getItem("fg-theme") as Theme) || "dark";
    } catch {
      return "dark";
    }
  });
  React.useEffect(() => {
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    try {
      localStorage.setItem("fg-theme", theme);
    } catch {
      /* ignore */
    }
    if (theme === "system") {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);
  return [theme, setTheme];
}
