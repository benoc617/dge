/**
 * SRX GameUIConfig — registers SRX's panel components with the @dge/shell.
 *
 * This wires the existing SRX React components (EmpirePanel, ActionPanel,
 * EventLog, Leaderboard) into the shell's GameUIConfig interface so that
 * GameLayout can render a full SRX game screen without knowing about SRX.
 *
 * Adapter notes:
 *   - EmpirePanel receives `state.empire`, `state.planets`, `state.army`,
 *     `state.supplyRates`, `state.research` via the GameState shape.
 *   - ActionPanel receives `state` + `onAction` + `rivals` + callbacks.
 *   - EventLog receives the `events` string array.
 *   - Leaderboard receives `currentPlayer` + `refreshKey` + callbacks.
 *
 * Shell prop → SRX prop translation is handled by thin adapter components
 * defined in this file so the originals remain unchanged.
 */

"use client";

import { useState } from "react";
import type { GameUIConfig, GamePanelProps, LeaderboardPanelProps } from "@dge/shell";
import type { GameState } from "@/lib/srx-game-types";

import EmpirePanel from "@/components/EmpirePanel";
import ActionPanel from "@/components/ActionPanel";
import EventLog from "@/components/EventLog";
import Leaderboard from "@/components/Leaderboard";

// ---------------------------------------------------------------------------
// Adapter components
// ---------------------------------------------------------------------------

/**
 * Adapts shell's GamePanelProps<GameState> → EmpirePanel's props.
 * EmpirePanel only reads `state` fields; it does not dispatch actions.
 */
function SrxEmpirePanelAdapter({ state }: GamePanelProps<GameState>) {
  if (!state) return null;
  return <EmpirePanel state={state} />;
}

/**
 * Adapts shell's GamePanelProps<GameState> → ActionPanel's props.
 *
 * ActionPanel manages its own target name internally via a controlled input.
 * The adapter bridges `onSelectTarget` (shell) ↔ `onTargetChange` (ActionPanel).
 * SessionInfo and onSkipTurn are left unset (page.tsx wires those directly).
 */
function SrxActionPanelAdapter({
  state,
  onAction,
  rivals = [],
  onSelectTarget,
  disabled = false,
}: GamePanelProps<GameState>) {
  const [targetName, setTargetName] = useState("");

  const handleTargetChange = (name: string) => {
    setTargetName(name);
    onSelectTarget?.(name);
  };

  if (!state) return null;
  return (
    <ActionPanel
      state={state}
      onAction={onAction}
      rivalNames={rivals}
      targetName={targetName}
      onTargetChange={handleTargetChange}
      disabled={disabled}
      currentTurnPlayer={state.currentTurnPlayer}
      turnOrder={state.turnOrder}
    />
  );
}

/**
 * Adapts shell's EventLogPanel signature → EventLog's props.
 * EventLog manages its own sizing; className from the shell panel slot is unused.
 */
function SrxEventLogAdapter({ events }: { events: string[]; className?: string }) {
  return <EventLog events={events} />;
}

/**
 * Adapts shell's LeaderboardPanelProps → Leaderboard's props.
 */
function SrxLeaderboardAdapter({
  currentPlayer,
  refreshKey,
  onSelectTarget,
  onRivalsLoaded,
}: LeaderboardPanelProps) {
  return (
    <Leaderboard
      currentPlayer={currentPlayer}
      refreshKey={refreshKey}
      onSelectTarget={onSelectTarget}
      onRivalsLoaded={onRivalsLoaded}
    />
  );
}

// ---------------------------------------------------------------------------
// SRX GameUIConfig
// ---------------------------------------------------------------------------

/**
 * SRX's GameUIConfig registration.
 *
 * Import this wherever you need to render a SRX game via GameLayout:
 *
 *   import { srxUIConfig } from "@/lib/srx-ui-config";
 *
 *   <GameLayout config={srxUIConfig} state={gameState} ... />
 */
export const srxUIConfig: GameUIConfig<GameState> = {
  gameType: "srx",
  layout: "three-column",
  SidePanel: SrxEmpirePanelAdapter,
  MainPanel: SrxActionPanelAdapter,
  EventLogPanel: SrxEventLogAdapter,
  LeaderboardPanel: SrxLeaderboardAdapter,
  scoreLabel: "Net Worth",
  turnLabel: (state, playerName) => {
    if (state.waitingForGameStart) return "LOBBY — GALAXY NOT STARTED";
    if (state.isYourTurn) return "YOUR TURN";
    const current = state.currentTurnPlayer;
    return current && current !== playerName ? `${current}'S TURN` : "WAITING";
  },
};
