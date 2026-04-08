/**
 * @dge/shell — UI shell types.
 *
 * These types define the contract between the shell (game-agnostic chrome)
 * and each game's UI implementation. Games provide a `GameUIConfig` that
 * tells the shell which components to render and how to lay them out.
 *
 * React is a peer dependency of this package.
 */

import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Generic client-side game state (shell-visible surface)
// ---------------------------------------------------------------------------

/**
 * The minimum game state shape the shell needs to render chrome:
 * header status, turn indicator, lobby banner, etc.
 *
 * Each game's client-side API response extends this (e.g. SRX's GameState
 * adds `empire`, `planets`, `army`, etc.). The shell only touches these fields.
 */
export interface GameStateBase {
  player: { id: string; name: string; isAI: boolean };
  /** True when it is this player's turn (sequential mode). */
  isYourTurn?: boolean;
  /** True when the galaxy is admin-staged and not yet started. */
  waitingForGameStart?: boolean;
  /** Name of the player whose turn it currently is. */
  currentTurnPlayer?: string | null;
  /** ISO timestamp when the current turn expires. */
  turnDeadline?: string | null;
  /** Ordered list of players in turn order. */
  turnOrder?: { name: string; isAI: boolean }[];
  /** Configured turn timeout in seconds. */
  turnTimeoutSecs?: number;
  /** "simultaneous" = door-game; absent or "sequential" = classic. */
  turnMode?: "sequential" | "simultaneous";
  /** Door-game: current calendar day. */
  dayNumber?: number;
  /** Door-game: full turns per calendar day. */
  actionsPerDay?: number;
  /** Door-game: full turns remaining for this player today. */
  fullTurnsLeftToday?: number;
  /** Door-game: whether this player's full-turn slot is open. */
  turnOpen?: boolean;
  /** Door-game: whether this player can take a full turn right now. */
  canAct?: boolean;
  /** Door-game: ISO timestamp when the current round ends. */
  roundEndsAt?: string | null;
  /**
   * Minimal empire summary the shell needs for game-over detection.
   * Games provide richer empire data via their extended state type.
   */
  empire?: {
    turnsLeft?: number;
    turnsPlayed?: number;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Action API response
// ---------------------------------------------------------------------------

/**
 * Minimum shape of a response from `POST /api/game/action` or
 * `POST /api/game/tick`. Games may include extra fields.
 */
export interface ActionResponse {
  success: boolean;
  message?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Game panel props
// ---------------------------------------------------------------------------

/**
 * Props passed by `GameLayout` to each game panel (MainPanel, SidePanel, etc.).
 *
 * TState is the game-specific extension of GameStateBase (e.g. SRX's GameState).
 */
export interface GamePanelProps<TState extends GameStateBase = GameStateBase> {
  /** Current game state from the status API. Null before first load. */
  state: TState | null;
  /** The logged-in player's commander name. */
  playerName: string;
  /** Dispatch an action to `POST /api/game/action`. */
  onAction: (action: string, params?: Record<string, unknown>) => Promise<ActionResponse>;
  /** Names of rival players (for targeting dropdowns). */
  rivals?: string[];
  /** Called when the player selects a rival to target. */
  onSelectTarget?: (name: string) => void;
  /** Accumulated event/log lines to display. */
  events?: string[];
  /** Bumped after each state refresh — lets panels re-fetch dependent data. */
  refreshKey?: number;
  /** True when actions should be disabled (not your turn, etc.). */
  disabled?: boolean;
}

/**
 * Props for the leaderboard / player roster panel.
 * Kept separate from GamePanelProps because the leaderboard typically has
 * its own polling and does not need the full game state.
 */
export interface LeaderboardPanelProps {
  currentPlayer: string;
  refreshKey: number;
  onSelectTarget: (name: string) => void;
  onRivalsLoaded?: (names: string[]) => void;
  gameSessionId?: string;
}

// ---------------------------------------------------------------------------
// Game UI configuration
// ---------------------------------------------------------------------------

/**
 * A game's UI registration — tells `GameLayout` how to render the game.
 *
 * Games create one `GameUIConfig` and pass it to `GameLayout`. The shell
 * renders the appropriate panel layout and injects the game's components.
 *
 * TState must extend `GameStateBase` so the shell can read the common fields.
 */
export interface GameUIConfig<TState extends GameStateBase = GameStateBase> {
  /**
   * Logical game type identifier — must match `GameSession.gameType`.
   * e.g. "srx", "chess"
   */
  gameType: string;

  /**
   * Panel layout variant:
   *   "three-column" — leaderboard strip + left/center/right panels (SRX)
   *   "two-column"   — leaderboard strip + board/sidebar (chess)
   *   "single"       — full-width single panel
   */
  layout: "three-column" | "two-column" | "single";

  /**
   * Center/main panel (SRX: ActionPanel, chess: Board).
   * Receives full GamePanelProps.
   */
  MainPanel: ComponentType<GamePanelProps<TState>>;

  /**
   * Left sidebar panel (SRX: EmpirePanel, chess: MoveHistory).
   * Optional — omit for single-panel layout.
   */
  SidePanel?: ComponentType<GamePanelProps<TState>>;

  /**
   * Right event log panel (SRX: EventLog).
   * Optional — games without a running commentary can omit this.
   */
  EventLogPanel?: ComponentType<{ events: string[]; className?: string }>;

  /**
   * Top leaderboard / player roster panel.
   * Optional — single-player games or games without rankings can omit this.
   */
  LeaderboardPanel?: ComponentType<LeaderboardPanelProps>;

  /**
   * Human-readable label for the primary score metric.
   * Displayed in game-over screens and leaderboard headers.
   * e.g. "Net Worth" (SRX), "ELO" (chess)
   */
  scoreLabel?: string;

  /**
   * Returns a human-readable description of the current turn state for the
   * header area. Defaults to "YOUR TURN" / "[Name]'S TURN".
   */
  turnLabel?: (state: TState, playerName: string) => string;
}
