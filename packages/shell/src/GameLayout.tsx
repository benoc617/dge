/**
 * @dge/shell — GameLayout component.
 *
 * Renders a game's panel layout based on its `GameUIConfig`. The shell
 * provides the structural chrome (leaderboard strip + panel grid); the game
 * provides the panel components via `GameUIConfig`.
 *
 * Supported layouts:
 *   "three-column"  —  SidePanel (3 cols) | MainPanel (5 cols) | EventLogPanel (4 cols)
 *   "two-column"    —  SidePanel (5 cols) | MainPanel (7 cols)
 *   "single"        —  MainPanel (12 cols), full width
 *
 * The LeaderboardPanel always spans full width above the grid when provided.
 */

"use client";

import type { GameStateBase, GameUIConfig, ActionResponse } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GameLayoutProps<TState extends GameStateBase = GameStateBase> {
  /** Game UI configuration (components + layout variant). */
  config: GameUIConfig<TState>;
  /** Current game state. Null before first load. */
  state: TState | null;
  /** The logged-in player's commander name. */
  playerName: string;
  /** Dispatch an action to the game server. */
  onAction: (action: string, params?: Record<string, unknown>) => Promise<ActionResponse>;
  /** Accumulated event log lines. */
  events?: string[];
  /** Rival commander names (for targeting). */
  rivals?: string[];
  /** Called when the player selects a target rival. */
  onSelectTarget?: (name: string) => void;
  /** Called when the leaderboard fetches the rival list. */
  onRivalsLoaded?: (names: string[]) => void;
  /** Bumped after each refresh — signals panels to re-fetch secondary data. */
  refreshKey?: number;
  /** Session ID for leaderboard scoping. */
  gameSessionId?: string;
  /** When true, action panels are disabled (e.g. waiting for your turn). */
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a game's full panel layout using the game's `GameUIConfig`.
 *
 * @example
 * <GameLayout
 *   config={srxUIConfig}
 *   state={gameState}
 *   playerName={playerName}
 *   onAction={doAction}
 *   events={events}
 *   rivals={rivals}
 *   onSelectTarget={setTarget}
 *   onRivalsLoaded={setRivals}
 *   refreshKey={refreshKey}
 * />
 */
export function GameLayout<TState extends GameStateBase = GameStateBase>({
  config,
  state,
  playerName,
  onAction,
  events = [],
  rivals = [],
  onSelectTarget,
  onRivalsLoaded,
  refreshKey = 0,
  gameSessionId,
  disabled = false,
}: GameLayoutProps<TState>) {
  const {
    layout,
    MainPanel,
    SidePanel,
    EventLogPanel,
    LeaderboardPanel,
  } = config;

  const panelProps = {
    state,
    playerName,
    onAction,
    rivals,
    onSelectTarget,
    events,
    refreshKey,
    disabled,
  };

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Leaderboard strip — always full width when provided */}
      {LeaderboardPanel && (
        <div>
          <LeaderboardPanel
            currentPlayer={playerName}
            refreshKey={refreshKey}
            onSelectTarget={onSelectTarget ?? (() => {})}
            onRivalsLoaded={onRivalsLoaded}
            gameSessionId={gameSessionId}
          />
        </div>
      )}

      {/* Panel grid */}
      {layout === "three-column" && (
        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
          {SidePanel && (
            <div className="col-span-12 lg:col-span-3 min-h-0 overflow-y-auto">
              <SidePanel {...panelProps} />
            </div>
          )}
          <div className={`col-span-12 ${SidePanel ? "lg:col-span-5" : "lg:col-span-8"} min-h-0 overflow-y-auto`}>
            <MainPanel {...panelProps} />
          </div>
          {EventLogPanel && (
            <div className="col-span-12 lg:col-span-4 min-h-0 overflow-y-auto">
              <EventLogPanel events={events} />
            </div>
          )}
        </div>
      )}

      {layout === "two-column" && (
        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
          {SidePanel && (
            <div className="col-span-12 lg:col-span-5 min-h-0 overflow-y-auto">
              <SidePanel {...panelProps} />
            </div>
          )}
          <div className={`col-span-12 ${SidePanel ? "lg:col-span-7" : "lg:col-span-12"} min-h-0 overflow-y-auto`}>
            <MainPanel {...panelProps} />
          </div>
        </div>
      )}

      {layout === "single" && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MainPanel {...panelProps} />
        </div>
      )}
    </div>
  );
}
