/**
 * Gin Rummy HTTP Adapter — game-specific API payload construction.
 */

import type { GameHttpAdapter } from "@dge/shared";
import { prisma } from "@/lib/prisma";
import type { GinRummyState } from "@dge/ginrummy";
import { cardKey, findBestMelds, getLegalActions, findLayoffOptions } from "@dge/ginrummy";

export const ginRummyHttpAdapter: GameHttpAdapter = {
  defaultTotalTurns: 9999,
  defaultActionsPerDay: 1,
  defaultTurnTimeoutSecs: 43200, // 12 hours

  getPlayerCreateData() {
    return {};
  },

  async onSessionCreated(sessionId, creatorPlayerId, options) {
    const opponentMode = (options?.opponentMode as string) || "ai";

    if (opponentMode === "human") {
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

    // vs AI: create AI player, deal the initial hand
    const ai = await prisma.player.create({
      data: {
        name: "Gin AI",
        isAI: true,
        aiPersona: "mcts",
        turnOrder: 1,
        gameSessionId: sessionId,
      },
    });

    const matchTarget = parseMatchTarget(options?.matchTarget);
    const { createInitialState } = await import("@dge/ginrummy");
    const state = createInitialState(creatorPlayerId, ai.id, matchTarget);

    await prisma.gameSession.update({
      where: { id: sessionId },
      data: {
        log: JSON.parse(JSON.stringify(state)),
        currentTurnPlayerId: creatorPlayerId,
        turnStartedAt: new Date(),
      },
    });
  },

  async onPlayerJoined(sessionId, playerId) {
    const session = await prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { log: true },
    });
    if (session?.log) return; // already initialized

    // Two humans: initialize state now
    const players = await prisma.player.findMany({
      where: { gameSessionId: sessionId },
      orderBy: { turnOrder: "asc" },
      select: { id: true, turnOrder: true, gameSession: { select: { log: true } } },
    });
    if (players.length < 2) return;

    // Read matchTarget from the session options stored in the session's log if available
    const { createInitialState } = await import("@dge/ginrummy");
    const p1 = players[0];
    const p2 = players.find((p) => p.id === playerId) ?? players[1];
    const state = createInitialState(p1.id, p2.id, null);

    await prisma.gameSession.update({
      where: { id: sessionId },
      data: {
        log: JSON.parse(JSON.stringify(state)),
        currentTurnPlayerId: p1.id,
        turnStartedAt: new Date(),
        waitingForHuman: false,
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
    const state = session.log as unknown as GinRummyState | null;

    const isYourTurn = state ? state.playerIds[state.currentPlayer] === playerId : false;

    // All players in session
    const players = await prisma.player.findMany({
      where: { gameSessionId: session.id },
      orderBy: { turnOrder: "asc" },
      select: { id: true, name: true, isAI: true, turnOrder: true },
    });

    const myPlayerIdx: 0 | 1 | null = state
      ? state.playerIds[0] === playerId
        ? 0
        : 1
      : null;

    const turnDeadline =
      session.turnStartedAt
        ? new Date(
            new Date(session.turnStartedAt).getTime() + session.turnTimeoutSecs * 1000,
          ).toISOString()
        : null;

    // Build hand info (only show current player's own cards; hide opponent's)
    let myCards: string[] = [];
    let myMelds: string[][] = [];
    let myDeadwood: string[] = [];
    let myDeadwoodValue = 0;
    let opponentCardCount = 0;
    let discardTop: string | null = null;
    let stockCount = 0;
    let legalActions: ReturnType<typeof getLegalActions> = [];
    let phase = "draw";
    let handResult = null;
    let scores: [number, number] = [0, 0];
    let handsWon: [number, number] = [0, 0];
    let handNumber = 1;
    let matchTarget: number | null = null;
    let knockerMelds: string[][] | null = null;
    let isLayoffPhase = false;
    let layoffOptions: string[] = [];

    if (state) {
      const oppIdx = myPlayerIdx === 0 ? 1 : 0;
      myCards = (state.players[myPlayerIdx!]?.cards ?? []).map(cardKey);
      opponentCardCount = state.players[oppIdx]?.cards.length ?? 0;
      discardTop =
        state.discardPile.length > 0 ? cardKey(state.discardPile[state.discardPile.length - 1]) : null;
      stockCount = state.deck.length;
      phase = state.phase;
      handResult = state.handResult;
      scores = state.scores;
      handsWon = state.handsWon;
      handNumber = state.handNumber;
      matchTarget = state.matchTarget;

      if (myPlayerIdx !== null) {
        legalActions = getLegalActions(state, myPlayerIdx);

        const hand = state.players[myPlayerIdx].cards;
        const best = findBestMelds(hand);
        myMelds = best.melds.map((m) => m.map(cardKey));
        myDeadwood = best.deadwood.map(cardKey);
        myDeadwoodValue = best.deadwoodValue;
      }

      if (state.phase === "layoff" && myPlayerIdx !== null) {
        const defIdx = (1 - state.knockerIdx!) as 0 | 1;
        isLayoffPhase = myPlayerIdx === defIdx;
        knockerMelds = state.knockerMelds
          ? state.knockerMelds.map((m) => m.map(cardKey))
          : null;
        if (isLayoffPhase) {
          const defHand = state.players[myPlayerIdx].cards;
          const opts = findLayoffOptions(defHand, state.knockerMelds!);
          layoffOptions = [...new Set(opts.map((o) => cardKey(o.card)))];
        }
      }
    }

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
      gameStatus: state?.status ?? "playing",
      winner: state?.winner ?? null,
      phase,
      myPlayerIdx,
      myCards,
      myMelds,
      myDeadwood,
      myDeadwoodValue,
      opponentCardCount,
      discardTop,
      stockCount,
      legalActions,
      handResult,
      scores,
      handsWon,
      handNumber,
      matchTarget,
      knockerMelds,
      isLayoffPhase,
      layoffOptions,

      turnOrder: players.map((p) => ({
        name: p.name,
        isAI: p.isAI,
        turnOrder: p.turnOrder,
        isCurrent: session.currentTurnPlayerId === p.id,
      })),
    };
  },

  async computeHubTurnState(player, session) {
    return {
      isYourTurn: session.currentTurnPlayerId === player.id,
      currentTurnPlayer: null,
    };
  },
};

function parseMatchTarget(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n <= 0) return null;
  return n;
}
