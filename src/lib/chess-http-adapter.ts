/**
 * Chess HTTP Adapter — game-specific API payload construction.
 */

import type { GameHttpAdapter } from "@dge/shared";
import { prisma } from "@/lib/prisma";
import { getCurrentTurn } from "@/lib/turn-order";
import type { ChessState } from "@dge/chess";

export const chessHttpAdapter: GameHttpAdapter = {
  defaultTotalTurns: 9999,
  defaultActionsPerDay: 1,
  defaultTurnTimeoutSecs: 43200, // 12 hours

  getPlayerCreateData() {
    return {};
  },

  async onSessionCreated(sessionId, creatorPlayerId, options) {
    const opponentMode = (options?.opponentMode as string) || "ai";

    if (opponentMode === "human") {
      // Wait for a human to join — don't init state yet (need both player IDs).
      await prisma.gameSession.update({
        where: { id: sessionId },
        data: {
          waitingForHuman: true,
          turnStartedAt: null,
          currentTurnPlayerId: null,
        },
      });
      return;
    }

    // Default: vs AI — create AI player and initialize chess state immediately.
    const ai = await prisma.player.create({
      data: {
        name: "Chess AI",
        isAI: true,
        aiPersona: "mcts",
        turnOrder: 1,
        gameSessionId: sessionId,
      },
    });

    const { createInitialState } = await import("@dge/chess");
    const state = createInitialState(creatorPlayerId, ai.id);

    await prisma.gameSession.update({
      where: { id: sessionId },
      data: {
        log: JSON.parse(JSON.stringify(state)),
        currentTurnPlayerId: creatorPlayerId,
        turnStartedAt: new Date(),
      },
    });
  },

  async buildStatus(playerId) {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        name: true,
        isAI: true,
        gameSessionId: true,
        gameSession: {
          select: {
            id: true,
            galaxyName: true,
            status: true,
            log: true,
            turnMode: true,
            currentTurnPlayerId: true,
            turnStartedAt: true,
            turnTimeoutSecs: true,
            inviteCode: true,
            isPublic: true,
            waitingForHuman: true,
            createdBy: true,
          },
        },
      },
    });

    if (!player?.gameSession) {
      return { error: "Player not found" };
    }

    const session = player.gameSession;
    const state = session.log as unknown as ChessState;

    // Turn info
    let isYourTurn = false;
    let currentTurnPlayer = "";
    if (state && state.status === "playing") {
      const currentPlayerId = state.turn === "white" ? state.whitePlayerId : state.blackPlayerId;
      isYourTurn = currentPlayerId === playerId;
      const currentP = await prisma.player.findUnique({
        where: { id: currentPlayerId },
        select: { name: true },
      });
      currentTurnPlayer = currentP?.name ?? "Unknown";
    }

    // All players in session
    const players = await prisma.player.findMany({
      where: { gameSessionId: session.id },
      orderBy: { turnOrder: "asc" },
      select: { id: true, name: true, isAI: true, turnOrder: true },
    });

    const myColor = state ? (playerId === state.whitePlayerId ? "white" : "black") : null;

    const turnDeadline = session.turnStartedAt
      ? new Date(new Date(session.turnStartedAt).getTime() + session.turnTimeoutSecs * 1000).toISOString()
      : null;

    return {
      playerId: player.id,
      name: player.name,
      sessionId: session.id,
      galaxyName: session.galaxyName,
      inviteCode: session.inviteCode,
      isPublic: session.isPublic,
      isCreator: session.createdBy === player.name,
      turnMode: session.turnMode,
      waitingForGameStart: session.waitingForHuman,
      turnDeadline,
      turnTimeoutSecs: session.turnTimeoutSecs,

      isYourTurn,
      currentTurnPlayer,
      gameStatus: state?.status ?? "playing",
      winner: state?.winner ?? null,
      myColor,
      inCheck: state?.inCheck ?? false,

      board: state?.board ?? null,
      turn: state?.turn ?? "white",
      castling: state?.castling ?? null,
      enPassant: state?.enPassant ?? null,
      moveHistory: state?.moveHistory ?? [],
      capturedByWhite: state?.capturedByWhite ?? [],
      capturedByBlack: state?.capturedByBlack ?? [],
      fullMoveNumber: state?.fullMoveNumber ?? 1,
      halfMoveClock: state?.halfMoveClock ?? 0,

      turnOrder: players.map((p) => ({
        name: p.name,
        isAI: p.isAI,
        turnOrder: p.turnOrder,
        isCurrent: session.currentTurnPlayerId === p.id,
      })),
    };
  },

  async onPlayerJoined(sessionId, playerId) {
    // When a human opponent joins, initialize the chess state.
    const session = await prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { log: true },
    });
    // If state already initialized (AI game or already joined), skip.
    if (session?.log) return;

    // Creator is the first player (turnOrder 0 = white).
    const players = await prisma.player.findMany({
      where: { gameSessionId: sessionId },
      orderBy: { turnOrder: "asc" },
      select: { id: true, turnOrder: true },
    });
    if (players.length < 2) return;

    const whitePlayer = players[0];
    const blackPlayer = players.find((p) => p.id === playerId) ?? players[1];

    const { createInitialState } = await import("@dge/chess");
    const state = createInitialState(whitePlayer.id, blackPlayer.id);

    await prisma.gameSession.update({
      where: { id: sessionId },
      data: {
        log: JSON.parse(JSON.stringify(state)),
        currentTurnPlayerId: whitePlayer.id,
        turnStartedAt: new Date(),
        waitingForHuman: false,
      },
    });
  },

  async computeHubTurnState(player, session) {
    return {
      isYourTurn: session.currentTurnPlayerId === player.id,
      currentTurnPlayer: null,
    };
  },
};
