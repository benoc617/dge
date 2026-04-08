// @dge/shell — game-agnostic React UI shell

// Types
export type {
  GameStateBase,
  ActionResponse,
  GamePanelProps,
  LeaderboardPanelProps,
  GameUIConfig,
} from "./types";

// Hooks
export { useGameState } from "./hooks/useGameState";
export type { UseGameStateOptions, UseGameStateResult } from "./hooks/useGameState";

export { useGameAction } from "./hooks/useGameAction";
export type { UseGameActionOptions, UseGameActionResult } from "./hooks/useGameAction";

// Components
export { GameLayout } from "./GameLayout";
export { TurnIndicator } from "./TurnIndicator";
