import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
import { PinProvider } from "./lib/state";
import Overview from "./pages/Overview";
import Rankings from "./pages/Rankings";
import Parlay from "./pages/Parlay";
import Defenses from "./pages/Defenses";
import DefenseDetail from "./pages/DefenseDetail";
import Player from "./pages/Player";
import Backtest from "./pages/Backtest";
import DataSync from "./pages/DataSync";
import SettingsPage from "./pages/Settings";
import Props from "./pages/Props";
import Trends from "./pages/Trends";
import Builder from "./pages/Builder";
import Ask from "./pages/Ask";
import How from "./pages/How";
import NbaHome from "./pages/nba/NbaHome";
import NbaProps from "./pages/nba/NbaProps";
import NbaBuilder from "./pages/nba/NbaBuilder";
import NbaAsk from "./pages/nba/NbaAsk";
import NbaPlayer from "./pages/nba/NbaPlayer";
import NbaRecord from "./pages/nba/NbaRecord";
import NbaHow from "./pages/nba/NbaHow";
import CfbHome from "./pages/cfb/CfbHome";
import CfbGame from "./pages/cfb/CfbGame";
import CfbAsk from "./pages/cfb/CfbAsk";
import CfbTeams from "./pages/cfb/CfbTeams";
import CfbProps from "./pages/cfb/CfbProps";
import CfbResearch from "./pages/cfb/CfbResearch";
import CfbHow from "./pages/cfb/CfbHow";
import CfbParlay from "./pages/cfb/CfbParlay";
import CfbGames from "./pages/cfb/CfbGames";
import HitRates from "./pages/HitRates";
import LabPicks from "./pages/LabPicks";
import { EmptyState } from "./components/ui";
import { STATIC } from "./lib/api";

// The hosted website uses #/ routes so any static host (GitHub Pages, Cloudflare Pages) can serve every page.
const Router = STATIC ? HashRouter : BrowserRouter;

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, placeholderData: (prev: unknown) => prev } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <Router>
        <PinProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Overview />} />
              <Route path="rankings" element={<Rankings />} />
              <Route path="parlay" element={<Parlay />} />
              <Route path="builder" element={<Builder />} />
              <Route path="ask" element={<Ask />} />
              <Route path="props" element={<Props />} />
              <Route path="hitrates" element={<HitRates />} />
              <Route path="trends" element={<Trends />} />
              <Route path="defenses" element={<Defenses />} />
              <Route path="defenses/:team" element={<DefenseDetail />} />
              <Route path="players/:id" element={<Player />} />
              <Route path="how" element={<How />} />
              <Route path="backtest" element={<Backtest />} />
              <Route path="data" element={<DataSync />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="top10" element={<LabPicks />} />
              <Route path="nba" element={<NbaHome />} />
              <Route path="nba/props" element={<NbaProps />} />
              <Route path="nba/builder" element={<NbaBuilder />} />
              <Route path="nba/ask" element={<NbaAsk />} />
              <Route path="nba/players/:id" element={<NbaPlayer />} />
              <Route path="nba/record" element={<NbaRecord />} />
              <Route path="nba/how" element={<NbaHow />} />
              <Route path="cfb" element={<CfbHome />} />
              <Route path="cfb/game/:id" element={<CfbGame />} />
              <Route path="cfb/ask" element={<CfbAsk />} />
              <Route path="cfb/teams" element={<CfbTeams />} />
              <Route path="cfb/props" element={<CfbProps />} />
              <Route path="cfb/record" element={<CfbResearch />} />
              <Route path="cfb/research" element={<CfbResearch />} />
              <Route path="cfb/how" element={<CfbHow />} />
              <Route path="cfb/parlay" element={<CfbParlay />} />
              <Route path="cfb/games" element={<CfbGames />} />
              <Route path="*" element={<EmptyState title="Page not found">That route does not exist.</EmptyState>} />
            </Route>
          </Routes>
        </PinProvider>
      </Router>
    </QueryClientProvider>
  </React.StrictMode>,
);
