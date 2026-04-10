/**
 * Gin Rummy — game registration side-effect module.
 *
 * Import this once at app startup (via game-bootstrap.ts) to register
 * the gin rummy game with the engine.
 */

import { registerGame } from "@dge/engine/registry";
import { ginRummyGameDefinition } from "@dge/ginrummy";
import { ginRummyHttpAdapter } from "@/lib/ginrummy-http-adapter";
import type { GameMetadata } from "@dge/shared";

const ginRummyMetadata: GameMetadata = {
  game: "ginrummy",
  displayName: "Gin Rummy",
  description: "Classic 2-player card game — form melds, knock, or go for gin.",
  playerRange: [2, 2],
  supportsJoin: true,
  autoCreateAI: false,
  createOptions: [
    {
      key: "aiDifficulty",
      label: "AI Difficulty",
      description: "How hard the AI opponent plays. Higher levels track discards and infer melds.",
      type: "select",
      default: "medium",
      options: [
        { value: "easy",   label: "Casual"      },
        { value: "medium", label: "Competitive" },
        { value: "hard",   label: "Shark"       },
      ],
    },
  ],
};

registerGame("ginrummy", {
  definition: ginRummyGameDefinition,
  metadata: ginRummyMetadata,
  adapter: ginRummyHttpAdapter,
  hooks: {
    turnOrder: {
      async runTick() {}, // Gin Rummy has no economy tick

      async processEndTurn(playerId: string) {
        // Called by engine auto-skip on timeout — forfeit the hand by resigning.
        const { getDb } = await import("@dge/engine/db-context");
        const player = await getDb().player.findUnique({
          where: { id: playerId },
          select: { gameSessionId: true },
        });
        if (!player?.gameSessionId) return;

        const { loadGinRummyState, saveGinRummyState } = await import("@dge/ginrummy");
        let state;
        try {
          state = await loadGinRummyState(player.gameSessionId);
        } catch {
          return;
        }
        if (state.status !== "playing") return;

        const playerIdx = state.playerIds[0] === playerId ? 0 : 1;
        const { resign } = await import("@dge/ginrummy");
        const updated = { ...state, ...resign(state, playerIdx), status: "timeout" as const };
        await saveGinRummyState(player.gameSessionId, updated);
      },

      /**
       * Always return only the current gin rummy player.
       * This drives advanceTurn to stay on the same player (within a turn)
       * or correctly switch (when currentPlayer changes).
       */
      async getActivePlayers(sessionId: string) {
        const { getDb } = await import("@dge/engine/db-context");
        const session = await getDb().gameSession.findUnique({
          where: { id: sessionId },
          select: { log: true },
        });
        if (!session?.log) {
          // Fallback: return all players
          return getDb().player.findMany({
            where: { gameSessionId: sessionId },
            orderBy: { turnOrder: "asc" },
            select: { id: true, name: true, isAI: true, turnOrder: true },
          });
        }

        const state = session.log as unknown as import("@dge/ginrummy").GinRummyState;
        const currentPlayerId = state.playerIds?.[state.currentPlayer];
        if (!currentPlayerId) {
          return getDb().player.findMany({
            where: { gameSessionId: sessionId },
            orderBy: { turnOrder: "asc" },
            select: { id: true, name: true, isAI: true, turnOrder: true },
          });
        }

        // Return only the current player — this makes advanceTurn keep or
        // switch the active player based on gin rummy state (not engine cycling).
        const p = await getDb().player.findUnique({
          where: { id: currentPlayerId },
          select: { id: true, name: true, isAI: true, turnOrder: true },
        });
        return p ? [p] : [];
      },
    },
  },
});
