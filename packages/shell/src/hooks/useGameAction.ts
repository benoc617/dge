/**
 * @dge/shell — useGameAction hook.
 *
 * Dispatches actions to `POST /api/game/action` and tracks pending state.
 * Game-agnostic: any action type and params shape is accepted.
 *
 * Usage:
 *   const { doAction, isBusy } = useGameAction({ playerName });
 *   await doAction("buy_soldiers", { amount: 100 });
 */

"use client";

import { useState, useCallback } from "react";
import type { ActionResponse } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseGameActionOptions {
  /** The acting player's commander name. */
  playerName: string | null;
  /**
   * Called after every action attempt (success or failure) so the caller
   * can trigger a state refresh.
   */
  onSettled?: (response: ActionResponse) => void;
}

export interface UseGameActionResult {
  /**
   * Dispatch a game action. Returns the raw API response (always resolves —
   * network errors are caught and returned as `{ success: false }`).
   */
  doAction: (
    action: string,
    params?: Record<string, unknown>,
  ) => Promise<ActionResponse>;
  /** True while a request is in flight. */
  isBusy: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Wraps `POST /api/game/action` with loading state tracking.
 *
 * The caller is responsible for reading `response.success` and
 * `response.message` to update the UI (show errors, refresh state, etc.).
 *
 * @example
 * const { doAction, isBusy } = useGameAction({ playerName, onSettled: refresh });
 *
 * async function handleBuySoldiers() {
 *   const resp = await doAction("buy_soldiers", { amount: 50 });
 *   if (!resp.success) showError(resp.message);
 * }
 */
export function useGameAction(options: UseGameActionOptions): UseGameActionResult {
  const { playerName, onSettled } = options;
  const [isBusy, setIsBusy] = useState(false);

  const doAction = useCallback(
    async (
      action: string,
      params: Record<string, unknown> = {},
    ): Promise<ActionResponse> => {
      if (!playerName) {
        return { success: false, message: "Not logged in." };
      }

      setIsBusy(true);
      let response: ActionResponse;

      try {
        const res = await fetch("/api/game/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName, action, ...params }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!res.ok && res.status === 409) {
          // 409 = galaxy busy or not-your-turn; body has details
          const data = (await res.json().catch(() => ({}))) as ActionResponse;
          response = { ...data, success: false, message: data.message ?? (data.error as string) ?? `HTTP ${res.status}` };
        } else if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as ActionResponse;
          response = { ...data, success: false, message: data.message ?? (data.error as string) ?? `HTTP ${res.status}` };
        } else {
          response = (await res.json()) as ActionResponse;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Request failed";
        response = { success: false, message: msg };
      }

      setIsBusy(false);
      onSettled?.(response);
      return response;
    },
    [playerName, onSettled],
  );

  return { doAction, isBusy };
}
