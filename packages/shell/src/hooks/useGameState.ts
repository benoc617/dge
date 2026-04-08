/**
 * @dge/shell — useGameState hook.
 *
 * Polls `GET /api/game/status` and returns the current game state.
 * Game-agnostic: works with any status API that returns a shape extending
 * GameStateBase.
 *
 * Usage:
 *   const { state, refresh, isLoading } = useGameState<SrxGameState>({
 *     playerName: "Commander",
 *     playerId: "clxxx...",
 *   });
 */

"use client";

import { useState, useCallback, useRef } from "react";
import type { GameStateBase } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseGameStateOptions {
  /** Player's commander name (used if playerId is not available). */
  playerName: string | null;
  /** Player's DB id — preferred over playerName for status lookups. */
  playerId?: string | null;
  /**
   * Called when the status response indicates the game is over
   * (`empire.turnsLeft <= 0`). Receives the player name so the caller
   * can load the game-over summary.
   */
  onGameOver?: (playerName: string) => void;
}

export interface UseGameStateResult<TState extends GameStateBase> {
  /** Current game state. Null before the first successful load. */
  state: TState | null;
  /**
   * Manually trigger a refresh. Accepts an optional one-shot playerId
   * override (useful right after register/join before React state flushes).
   */
  refresh: (playerIdOverride?: string | null) => Promise<TState | null>;
  /** True during the initial load (before any state is available). */
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches and tracks game state from the status API.
 *
 * Does NOT auto-poll — callers drive refresh timing (after actions, on a
 * timer, etc.) to avoid duplicate requests. The `Leaderboard` component
 * handles its own polling separately.
 *
 * @example
 * const { state, refresh } = useGameState<SrxGameState>({ playerName, playerId });
 * useEffect(() => {
 *   const id = setInterval(() => refresh(), 2000);
 *   return () => clearInterval(id);
 * }, [refresh]);
 */
export function useGameState<TState extends GameStateBase = GameStateBase>(
  options: UseGameStateOptions,
): UseGameStateResult<TState> {
  const { playerName, playerId, onGameOver } = options;

  const [state, setState] = useState<TState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const hasLoadedRef = useRef(false);
  const onGameOverRef = useRef(onGameOver);
  onGameOverRef.current = onGameOver;

  const refresh = useCallback(
    async (playerIdOverride?: string | null): Promise<TState | null> => {
      const effectivePlayerId = playerIdOverride ?? playerId;
      const effectiveName = playerName;

      if (!effectiveName && !effectivePlayerId) return null;

      if (!hasLoadedRef.current) setIsLoading(true);

      const qs = effectivePlayerId
        ? `id=${encodeURIComponent(effectivePlayerId)}`
        : `player=${encodeURIComponent(effectiveName!)}`;

      let res: Response;
      try {
        res = await fetch(`/api/game/status?${qs}`, {
          signal: AbortSignal.timeout(25_000),
        });
      } catch {
        setIsLoading(false);
        return null;
      }

      if (!res.ok) {
        setIsLoading(false);
        return null;
      }

      const raw = await res.text();
      if (!raw.trim()) {
        setIsLoading(false);
        return null;
      }

      try {
        const data = JSON.parse(raw) as TState;
        setState(data);
        hasLoadedRef.current = true;
        setIsLoading(false);

        // Game-over detection: turnsLeft hitting 0 signals end-of-game.
        if (
          data.empire?.turnsLeft !== undefined &&
          data.empire.turnsLeft <= 0 &&
          effectiveName &&
          onGameOverRef.current
        ) {
          onGameOverRef.current(effectiveName);
        }

        return data;
      } catch {
        setIsLoading(false);
        return null;
      }
    },
    [playerName, playerId],
  );

  return { state, refresh, isLoading };
}
