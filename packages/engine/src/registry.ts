/**
 * @dge/engine — Game registry.
 *
 * Games register themselves at startup via `registerGame`. Routes and services
 * look up the orchestrator by the `GameSession.gameType` field.
 *
 * The registry is a process-global singleton. Registration should happen once
 * at application startup (e.g. by importing `@/lib/srx-registration`).
 */

import type { GameDefinition, GameMetadata, GameHttpAdapter } from "@dge/shared";
import { GameOrchestrator } from "./orchestrator";
import type { TurnOrderHooks } from "./turn-order";
import type { DoorGameHooks } from "./door-game";

// Re-export so callers can import these types from @dge/engine/registry.
export type { GameMetadata, GameHttpAdapter } from "@dge/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GameHooks {
  /** Hooks for sequential-mode turn order (getCurrentTurn auto-skip). */
  turnOrder?: TurnOrderHooks;
  /** Hooks for simultaneous-mode (door-game) lifecycle. */
  doorGame?: DoorGameHooks;
}

export interface GameRegistrationInput<TState> {
  definition: GameDefinition<TState>;
  metadata: GameMetadata;
  adapter: GameHttpAdapter;
  hooks?: GameHooks;
}

export interface GameRegistration<TState = unknown> {
  definition: GameDefinition<TState>;
  orchestrator: GameOrchestrator<TState>;
  metadata: GameMetadata;
  adapter: GameHttpAdapter;
}

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

const _games = new Map<string, GameRegistration<unknown>>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a game with its definition, metadata, HTTP adapter, and engine hooks.
 * Creates a `GameOrchestrator` bound to the definition + hooks.
 *
 * Should be called once at startup (importing the registration module is enough).
 * Calling again with the same `gameType` replaces the previous registration.
 */
export function registerGame<TState>(
  gameType: string,
  input: GameRegistrationInput<TState>,
): void {
  const hooks = input.hooks ?? {};
  const orchestrator = new GameOrchestrator(
    input.definition,
    hooks.turnOrder,
    hooks.doorGame,
  );
  _games.set(gameType, {
    definition: input.definition as GameDefinition<unknown>,
    orchestrator: orchestrator as GameOrchestrator<unknown>,
    metadata: input.metadata,
    adapter: input.adapter,
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
