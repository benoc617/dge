/**
 * Chess — game registration side-effect module.
 *
 * Import this once at app startup (via game-bootstrap.ts) to register
 * the chess game with the engine.
 */

import { registerGame } from "@dge/engine/registry";
import { chessGameDefinition } from "@dge/chess";
import { chessHttpAdapter } from "@/lib/chess-http-adapter";
import type { GameMetadata } from "@dge/shared";

const chessMetadata: GameMetadata = {
  game: "chess",
  displayName: "Chess",
  description: "Classic chess — AI or human opponent, 12h turn timer.",
  playerRange: [2, 2],
  supportsJoin: true,
  autoCreateAI: false,
  createOptions: [
    {
      key: "aiDifficulty",
      label: "AI Difficulty",
      description: "Strength of the computer opponent (affects search depth and time).",
      type: "select",
      default: "medium",
      options: [
        { value: "easy",   label: "Beginner"    },
        { value: "medium", label: "Club Player" },
        { value: "hard",   label: "Expert"      },
      ],
    },
  ],
};

registerGame("chess", {
  definition: chessGameDefinition,
  metadata: chessMetadata,
  adapter: chessHttpAdapter,
  hooks: {
    turnOrder: {
      async runTick() {}, // Chess has no tick
      async processEndTurn(playerId: string) {
        // Called by engine auto-skip on timeout — chess loses on time.
        const { getDb } = await import("@dge/engine/db-context");
        const player = await getDb().player.findUnique({
          where: { id: playerId },
          select: { gameSessionId: true },
        });
        if (!player?.gameSessionId) return;

        const session = await getDb().gameSession.findUnique({
          where: { id: player.gameSessionId },
          select: { log: true },
        });
        if (!session?.log) return;

        const state = session.log as unknown as import("@dge/chess").ChessState;
        if (state.status !== "playing") return;

        const timedOutColor = state.whitePlayerId === playerId ? "white" : "black";
        const winner = timedOutColor === "white" ? "black" : "white";
        const updated = { ...state, status: "timeout" as const, winner };

        await getDb().gameSession.update({
          where: { id: player.gameSessionId },
          data: {
            log: JSON.parse(JSON.stringify(updated)),
            status: "complete",
          },
        });
      },
      // No getActivePlayers hook — default (all players) is correct for chess.
      // Chess doesn't eliminate players mid-session; the game ends when
      // status changes to checkmate/stalemate/draw/resigned.
    },
  },
});
