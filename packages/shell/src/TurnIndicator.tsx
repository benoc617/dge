/**
 * @dge/shell — TurnIndicator component.
 *
 * Displays the current turn/round status in the game header. Works for both
 * sequential and simultaneous (door-game) turn modes.
 *
 * Game-agnostic: reads only the `GameStateBase` fields common to all games.
 */

"use client";

import { useState, useEffect } from "react";
import type { GameStateBase } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TurnIndicatorProps {
  state: GameStateBase | null;
  playerName: string;
  /**
   * Optional custom label override. When provided, replaces the default
   * turn-state label entirely (e.g. "LOBBY — GALAXY NOT STARTED").
   */
  customLabel?: string | null;
  /** Additional CSS classes for the container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Turn timer sub-component
// ---------------------------------------------------------------------------

function TurnTimer({
  deadline,
  className = "",
}: {
  deadline: string | null | undefined;
  className?: string;
}) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    if (!deadline) {
      setTimeLeft("");
      return;
    }

    function update() {
      const target = new Date(deadline!).getTime();
      const remaining = target - Date.now();
      if (remaining <= 0) {
        setTimeLeft("EXPIRED");
        return;
      }
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      const s = Math.floor((remaining % 60_000) / 1_000);
      if (h > 0) {
        setTimeLeft(`${h}h ${String(m).padStart(2, "0")}m`);
      } else if (m > 0) {
        setTimeLeft(`${m}m ${String(s).padStart(2, "0")}s`);
      } else {
        setTimeLeft(`${s}s`);
      }
    }

    update();
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [deadline]);

  if (!timeLeft || timeLeft === "EXPIRED") return null;

  const isUrgent = (() => {
    if (!deadline) return false;
    return new Date(deadline).getTime() - Date.now() < 3_600_000; // < 1 hour
  })();

  return (
    <span className={`font-mono text-xs tabular-nums ${isUrgent ? "text-red-400" : "text-green-600"} ${className}`}>
      ⏱ {timeLeft}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Renders the turn/round status label for the game header.
 *
 * Sequential mode:
 *   ▸ YOUR TURN   |   ▸ [Name]'S TURN
 *
 * Door-game (simultaneous) mode:
 *   D3 · 2/5 full turns   |   ▸ START FULL TURN   |   ▸ TURN OPEN   |   ▸ WAITING FOR OTHERS
 */
export function TurnIndicator({ state, playerName, customLabel, className = "" }: TurnIndicatorProps) {
  if (customLabel) {
    return (
      <span className={`text-cyan-400 font-bold tracking-wide text-sm ${className}`}>
        ▸ {customLabel}
      </span>
    );
  }

  if (!state) return null;

  const isSimultaneous = state.turnMode === "simultaneous";

  // -----------------------------------------------------------------------
  // Door-game (simultaneous) indicator
  // -----------------------------------------------------------------------
  if (isSimultaneous) {
    const day = state.dayNumber ?? 1;
    const apd = state.actionsPerDay ?? 5;
    const fullTurnsLeft = state.fullTurnsLeftToday ?? 0;
    const used = apd - fullTurnsLeft;

    const dayBadge = (
      <span className="text-green-500 font-mono text-xs mr-2">
        D{day} · {used}/{apd} full turns
      </span>
    );

    let statusLabel: React.ReactNode;
    if (state.waitingForGameStart) {
      statusLabel = <span className="text-cyan-400 font-bold text-sm">▸ LOBBY — GALAXY NOT STARTED</span>;
    } else if (state.canAct === false && fullTurnsLeft === 0) {
      statusLabel = <span className="text-yellow-600 font-bold text-sm">▸ WAITING FOR OTHERS</span>;
    } else if (state.turnOpen) {
      statusLabel = <span className="text-yellow-300 font-bold text-sm">▸ TURN OPEN</span>;
    } else if (state.canAct) {
      statusLabel = <span className="text-cyan-400 font-bold text-sm">▸ START FULL TURN</span>;
    } else {
      statusLabel = <span className="text-green-700 font-bold text-sm">▸ NO TURNS LEFT</span>;
    }

    const roundDeadline = state.roundEndsAt;

    return (
      <span className={`flex items-center gap-2 ${className}`}>
        {dayBadge}
        {statusLabel}
        {roundDeadline && <TurnTimer deadline={roundDeadline} />}
      </span>
    );
  }

  // -----------------------------------------------------------------------
  // Sequential indicator
  // -----------------------------------------------------------------------
  if (state.waitingForGameStart) {
    return (
      <span className={`text-cyan-400 font-bold tracking-wide text-sm ${className}`}>
        ▸ LOBBY — GALAXY NOT STARTED
      </span>
    );
  }

  const isYourTurn = state.isYourTurn;
  const currentPlayer = state.currentTurnPlayer;

  return (
    <span className={`flex items-center gap-3 ${className}`}>
      {isYourTurn ? (
        <span className="text-cyan-400 font-bold tracking-wide text-sm">▸ YOUR TURN</span>
      ) : (
        <span className="text-yellow-600 font-bold tracking-wide text-sm">
          ▸ {currentPlayer ?? "???"}
          {currentPlayer && currentPlayer !== playerName ? "'S TURN" : ""}
        </span>
      )}
      <TurnTimer deadline={state.turnDeadline} />
    </span>
  );
}
