/**
 * SRX game registration.
 *
 * Importing this module registers the SRX GameDefinition with the engine's
 * game registry, injecting the SRX-specific turn-order and door-game hooks.
 *
 * Import this once at the top of each API route that needs to dispatch
 * through the registry/orchestrator:
 *
 *   import "@/lib/srx-registration";
 *
 * Subsequent imports are a no-op (module is only evaluated once by Node).
 *
 * Circular-import note:
 *   registry → GameOrchestrator → (engine only)
 *   srxGameDefinition → @/lib/game-engine → @/lib/db-context → @dge/engine/db-context
 *   None of the imports here create a cycle.
 */

import { registerGame } from "@dge/engine/registry";
import { srxGameDefinition } from "@dge/srx";
import {
  processAction,
  runAndPersistTick,
  runEndgameSettlementTick,
} from "@/lib/game-engine";
import { invalidatePlayer, invalidateLeaderboard } from "@/lib/game-state-service";
import { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";

registerGame("srx", srxGameDefinition, {
  /**
   * TurnOrderHooks — injected into engine's getCurrentTurn for sequential mode.
   * These replace the SRX-specific shim in src/lib/turn-order.ts.
   */
  turnOrder: {
    async runTick(playerId: string): Promise<void> {
      await runAndPersistTick(playerId);
    },
    async processEndTurn(playerId: string): Promise<void> {
      await processAction(playerId, "end_turn");
    },
  },

  /**
   * DoorGameHooks — injected into engine's openFullTurn / closeFullTurn /
   * tryRollRound for simultaneous (door-game) mode.
   * Mirrors makeSrxHooks() from src/lib/door-game-turns.ts.
   */
  doorGame: {
    async runTick(playerId: string, opts?: { decrementTurnsLeft?: boolean }) {
      return runAndPersistTick(playerId, opts);
    },
    async runEndgameTick(playerId: string): Promise<void> {
      await runEndgameSettlementTick(playerId);
    },
    invalidatePlayer(playerId: string): void {
      void invalidatePlayer(playerId);
    },
    invalidateLeaderboard(sessionId: string): void {
      void invalidateLeaderboard(sessionId);
    },
    onDayComplete(sessionId: string): void {
      void enqueueAiTurnsForSession(sessionId).catch((err) => {
        console.error("[srx-registration] enqueueAiTurnsForSession after day roll", sessionId, err);
      });
    },
  },
});
