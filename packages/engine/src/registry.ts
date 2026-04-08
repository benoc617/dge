/**
 * @dge/engine — Game registry.
 *
 * Games register themselves at startup via `registerGame`. Routes and services
 * look up the orchestrator by the `GameSession.gameType` field.
 *
 * The registry is a process-global singleton. Registration should happen once
 * at application startup (e.g. by importing `@/lib/srx-registration`).
 */

import type { GameDefinition } from "@dge/shared";
import { GameOrchestrator } from "./orchestrator";
import type { TurnOrderHooks } from "./turn-order";
import type { DoorGameHooks } from "./door-game";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GameHooks {
  /** Hooks for sequential-mode turn order (getCurrentTurn auto-skip). */
  turnOrder?: TurnOrderHooks;
  /** Hooks for simultaneous-mode (door-game) lifecycle. */
  doorGame?: DoorGameHooks;
}

export interface GameRegistration<TState = unknown> {
  definition: GameDefinition<TState>;
  orchestrator: GameOrchestrator<TState>;
}

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

const _games = new Map<string, GameRegistration<unknown>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a game definition with its engine hooks.
 * Creates a `GameOrchestrator` bound to the definition + hooks.
 *
 * Should be called once at startup (importing the registration module is enough).
 * Calling again with the same `gameType` replaces the previous registration.
 */
export function registerGame<TState>(
  gameType: string,
  definition: GameDefinition<TState>,
  hooks: GameHooks = {},
): void {
  const orchestrator = new GameOrchestrator(
    definition,
    hooks.turnOrder,
    hooks.doorGame,
  );
  _games.set(gameType, {
    definition: definition as GameDefinition<unknown>,
    orchestrator: orchestrator as GameOrchestrator<unknown>,
  });
}

/**
 * Look up a registered game by type. Returns `undefined` if not registered.
 */
export function getGame(gameType: string): GameRegistration<unknown> | undefined {
  return _games.get(gameType);
}

/**
 * Look up a registered game, throwing if not found.
 */
export function requireGame(gameType: string): GameRegistration<unknown> {
  const entry = _games.get(gameType);
  if (!entry) {
    throw new Error(
      `Game type "${gameType}" is not registered. ` +
      `Ensure the game's registration module is imported at startup.`,
    );
  }
  return entry;
}

/**
 * List all registered game types. Useful for admin / diagnostics.
 */
export function listGameTypes(): string[] {
  return Array.from(_games.keys());
}

/**
 * Remove all registrations. Intended for test isolation only.
 * @internal
 */
export function _clearRegistry(): void {
  _games.clear();
}
