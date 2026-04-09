"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { LEADERBOARD as TT } from "@/lib/ui-tooltips";
import Tooltip from "@/components/Tooltip";

export interface RivalEntry {
  rank: number;
  name: string;
  isAI: boolean;
  netWorth: number;
  population: number;
  planets: number;
  turnsPlayed: number;
  civilStatus: string;
  military: number;
  isProtected?: boolean;
  protectionTurns?: number;
}

interface Props {
  currentPlayer: string;
  /** Bumped after meaningful game state changes. Triggers a leaderboard refresh (debounced). */
  refreshKey: number;
  onSelectTarget: (name: string) => void;
  onRivalsLoaded?: (names: string[]) => void;
}

const POLL_INTERVAL_MS = 10_000;
const DEBOUNCE_MS = 2_000;

export default function Leaderboard({ currentPlayer, refreshKey, onSelectTarget, onRivalsLoaded }: Props) {
  const [rivals, setRivals] = useState<RivalEntry[]>([]);
  const [expanded, setExpanded] = useState(true);
  const lastFetchRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLeaderboard = useCallback(async () => {
    lastFetchRef.current = Date.now();
    try {
      const res = await fetch(`/api/game/leaderboard?player=${encodeURIComponent(currentPlayer)}`);
      if (res.ok) {
        const data = await res.json();
        const list: RivalEntry[] = data.leaderboard ?? [];
        setRivals(list);
        onRivalsLoaded?.(list.filter((r) => r.name !== currentPlayer).map((r) => r.name));
      }
    } catch (err) {
      console.warn("[leaderboard] fetch failed:", err);
    }
  }, [currentPlayer, onRivalsLoaded]);

  // Fetch on mount
  useEffect(() => {
    fetchLeaderboard();
  }, [fetchLeaderboard]);

  // Poll on a long interval (leaderboard data is not time-critical)
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchLeaderboard();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchLeaderboard]);

  // Debounced refresh when refreshKey changes (e.g. after a tick completes).
  // Skips if we fetched recently to avoid piling requests onto the connection pool.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const sinceLastFetch = Date.now() - lastFetchRef.current;
    if (sinceLastFetch < DEBOUNCE_MS) return;
    debounceRef.current = setTimeout(() => {
      fetchLeaderboard();
      debounceRef.current = null;
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refreshKey, fetchLeaderboard]);

  if (rivals.length <= 1) return null;

  const you = rivals.find((r) => r.name === currentPlayer);
  const yourRank = you?.rank ?? 0;

  return (
    <div className="border border-green-800 p-3">
      <Tooltip tip={TT.panelTitle}>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex justify-between items-center cursor-help"
        >
          <h2 className="text-yellow-400 font-bold tracking-wider text-sm">
            [ GALACTIC POWERS ] <span className="text-green-700 font-normal text-xs">({rivals.length} empires)</span>
          </h2>
          <span className="text-green-700 text-xs">{expanded ? "▼" : "▶"}</span>
        </button>
      </Tooltip>

      {expanded && (
        <div className="mt-2 space-y-0.5">
          <div className="flex items-center gap-2 text-[10px] px-1.5 py-0.5 border-b border-green-900 text-green-700 uppercase tracking-wider">
            <Tooltip tip={TT.rk}>
              <span className="w-5 text-right cursor-help inline-flex justify-end">Rk</span>
            </Tooltip>
            <Tooltip tip={TT.commander} className="flex-1 min-w-0">
              <span className="block w-full cursor-help truncate">Commander</span>
            </Tooltip>
            <Tooltip tip={TT.prt}>
              <span className="w-7 text-right hidden sm:inline-flex cursor-help justify-end">Prt</span>
            </Tooltip>
            <Tooltip tip={TT.worth}>
              <span className="w-12 text-right cursor-help inline-flex justify-end">Worth</span>
            </Tooltip>
            <Tooltip tip={TT.pop}>
              <span className="w-10 text-right cursor-help inline-flex justify-end">Pop</span>
            </Tooltip>
            <Tooltip tip={TT.plt}>
              <span className="w-6 text-right cursor-help inline-flex justify-end">Plt</span>
            </Tooltip>
            <Tooltip tip={TT.turns}>
              <span className="w-7 text-right cursor-help inline-flex justify-end">Turn</span>
            </Tooltip>
            <Tooltip tip={TT.mil}>
              <span className="w-6 text-right cursor-help inline-flex justify-end">Mil</span>
            </Tooltip>
          </div>
          {rivals.map((r) => {
            const isYou = r.name === currentPlayer;
            return (
              <div
                key={r.name}
                className={`flex items-center gap-2 text-xs px-1.5 py-1 border ${
                  isYou
                    ? "border-yellow-800/50 bg-yellow-900/10"
                    : "border-transparent hover:border-green-800 hover:bg-green-900/20 cursor-pointer"
                }`}
                onClick={() => { if (!isYou) onSelectTarget(r.name); }}
                title={isYou ? "Your empire" : `Click to target ${r.name}`}
              >
                <span className={`w-5 text-right font-bold ${isYou ? "text-yellow-400" : r.rank <= 3 ? "text-yellow-600" : "text-green-700"}`}>
                  #{r.rank}
                </span>

                <span className={`flex-1 truncate ${isYou ? "text-yellow-300" : "text-green-300"}`}>
                  {r.name}
                  {r.isAI && <span className="text-green-700 ml-1">[AI]</span>}
                  {isYou && <span className="text-yellow-600 ml-1">(you)</span>}
                </span>

                <span
                  className="w-7 text-right text-[10px] text-blue-500/90 hidden sm:inline tabular-nums"
                  title={
                    r.isProtected && (r.protectionTurns ?? 0) > 0
                      ? `New-empire protection: ${r.protectionTurns} turns`
                      : "No protection"
                  }
                >
                  {r.isProtected && (r.protectionTurns ?? 0) > 0 ? `[P${r.protectionTurns}]` : "—"}
                </span>

                <span className="text-yellow-400 w-12 text-right" title="Net Worth">
                  {r.netWorth}
                </span>
                <span className="text-green-600 w-10 text-right" title={`${r.population.toLocaleString()} pop`}>
                  {abbreviate(r.population)}
                </span>
                <span className="text-green-700 w-6 text-right" title={`${r.planets} planets`}>
                  {r.planets}p
                </span>
                <span
                  className="text-green-600 w-7 text-right tabular-nums"
                  title={`Economy ticks completed: ${r.turnsPlayed}`}
                >
                  {r.turnsPlayed}
                </span>
                <span className="text-red-800 w-6 text-right" title={`Military strength: ${r.military}`}>
                  {abbreviate(r.military)}
                </span>
              </div>
            );
          })}

          {yourRank > 0 && (
            <div className="text-center text-green-700 text-[10px] pt-1 border-t border-green-900">
              Your rank: #{yourRank} of {rivals.length}
              {yourRank === 1 && " — Leading the galaxy!"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return n.toString();
}
