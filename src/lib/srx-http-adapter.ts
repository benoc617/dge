/**
 * SRX HTTP Adapter — game-specific API payload construction for the Door Game Engine.
 *
 * Implements `GameHttpAdapter` from `@dge/shared` for the SRX game.
 * Routes delegate all SRX-specific payload shaping here so they stay
 * game-agnostic and simply call `requireGame(game).adapter.*`.
 *
 * Extracted from:
 *   - status/route.ts  → buildStatus (was buildResponse)
 *   - leaderboard/route.ts → buildLeaderboard
 *   - gameover/route.ts    → buildGameOver
 *   - register/route.ts    → getPlayerCreateData, onSessionCreated, defaults
 *   - login/route.ts       → computeHubTurnState
 */

import type { GameHttpAdapter } from "@dge/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CIVIL_STATUS_NAMES, PLANET_CONFIG, ACTIONS_PER_DAY, START } from "@/lib/game-constants";
import { getCurrentTurn } from "@/lib/turn-order";
import { getCachedLeaderboard } from "@/lib/game-state-service";
import { createStarterPlanets, createStarterEmpire } from "@/lib/player-init";

// ---------------------------------------------------------------------------
// Player include shape (used by buildStatus)
// ---------------------------------------------------------------------------

const playerInclude = {
  empire: {
    include: {
      planets: { orderBy: { createdAt: "asc" as const } },
      army: true,
      supplyRates: true,
      research: true,
    },
  },
} as const;

type FullPlayer = NonNullable<Prisma.PlayerGetPayload<{ include: typeof playerInclude }>>;

// ---------------------------------------------------------------------------
// SRX HTTP Adapter implementation
// ---------------------------------------------------------------------------

export const srxHttpAdapter: GameHttpAdapter = {
  // -------------------------------------------------------------------------
  // Session-level defaults
  // -------------------------------------------------------------------------

  defaultTotalTurns: START.TURNS,
  defaultActionsPerDay: ACTIONS_PER_DAY,

  // -------------------------------------------------------------------------
  // Player initialization
  // -------------------------------------------------------------------------

  getPlayerCreateData() {
    return {
      empire: { create: createStarterEmpire(createStarterPlanets()) },
    };
  },

  async onSessionCreated(
    sessionId: string,
    creatorPlayerId: string,
    options: Record<string, unknown>,
  ): Promise<void> {
    const session = await prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { turnMode: true },
    });
    const simultaneous = session?.turnMode === "simultaneous";

    // Set currentTurnPlayerId: null for simultaneous (all players act freely),
    // creator's player ID for sequential (creator goes first).
    await prisma.gameSession.update({
      where: { id: sessionId },
      data: simultaneous
        ? { currentTurnPlayerId: null }
        : { currentTurnPlayerId: creatorPlayerId },
    });

    // Ensure the global Market singleton exists (SRX-specific).
    const marketCount = await prisma.market.count();
    if (marketCount === 0) {
      await prisma.market.create({ data: {} });
    }

    void options; // options available for future use (e.g. custom market settings)
  },

  // onPlayerJoined: no-op for SRX — starter empire is already in getPlayerCreateData.

  // -------------------------------------------------------------------------
  // Status payload
  // -------------------------------------------------------------------------

  async buildStatus(playerId: string): Promise<Record<string, unknown>> {
    const player = await prisma.player.findUnique({
      where: { id: playerId },
      include: playerInclude,
    });

    if (!player?.empire) {
      throw new Error(`SRX buildStatus: player ${playerId} not found or has no empire`);
    }

    return buildSrxResponse(player as unknown as FullPlayer);
  },

  // -------------------------------------------------------------------------
  // Leaderboard payload
  // -------------------------------------------------------------------------

  async buildLeaderboard(sessionId: string | null): Promise<unknown[]> {
    async function fetchLeaderboard() {
      const empires = await prisma.empire.findMany({
        where: {
          turnsLeft: { gt: 0 },
          ...(sessionId ? { player: { gameSessionId: sessionId } } : {}),
        },
        include: {
          player: { select: { name: true, isAI: true } },
          planets: { select: { type: true } },
          army: { select: { soldiers: true, fighters: true, lightCruisers: true, heavyCruisers: true } },
        },
        orderBy: { netWorth: "desc" },
      });
      return empires.map((e, i) => ({
        rank: i + 1,
        name: e.player.name,
        isAI: e.player.isAI,
        netWorth: e.netWorth,
        population: e.population,
        planets: e.planets.length,
        turnsPlayed: e.turnsPlayed,
        civilStatus: CIVIL_STATUS_NAMES[e.civilStatus] ?? "Unknown",
        isProtected: e.isProtected,
        protectionTurns: e.protectionTurns,
        military: e.army
          ? e.army.soldiers + e.army.fighters * 2 + e.army.lightCruisers * 4 + e.army.heavyCruisers * 10
          : 0,
      }));
    }

    return sessionId
      ? getCachedLeaderboard(sessionId, fetchLeaderboard)
      : fetchLeaderboard();
  },

  // -------------------------------------------------------------------------
  // Game-over payload
  // -------------------------------------------------------------------------

  async buildGameOver(
    sessionId: string,
    playerName: string,
  ): Promise<Record<string, unknown>> {
    const allPlayers = await prisma.player.findMany({
      where: { gameSessionId: sessionId },
      include: { empire: { include: { planets: true, army: true } } },
    });

    const standings = allPlayers
      .filter((p) => p.empire)
      .map((p) => ({
        name: p.name,
        isAI: p.isAI,
        netWorth: p.empire!.netWorth,
        population: p.empire!.population,
        planets: p.empire!.planets.length,
        credits: p.empire!.credits,
        turnsPlayed: p.empire!.turnsPlayed,
        military: p.empire!.army
          ? p.empire!.army.soldiers + p.empire!.army.fighters +
            p.empire!.army.lightCruisers + p.empire!.army.heavyCruisers +
            p.empire!.army.carriers + p.empire!.army.defenseStations
          : 0,
      }))
      .sort((a, b) => b.netWorth - a.netWorth);

    const highScoreEntries = standings.map((s, i) => ({
      playerName: s.name,
      netWorth: s.netWorth,
      population: s.population,
      planets: s.planets,
      turnsPlayed: s.turnsPlayed,
      rank: i + 1,
      totalPlayers: standings.length,
    }));

    await prisma.highScore.createMany({ data: highScoreEntries });

    await prisma.gameSession.update({
      where: { id: sessionId },
      data: {
        status: "finished",
        winnerId: allPlayers.find((p) => p.name === standings[0]?.name)?.id,
        winnerName: standings[0]?.name,
        finalScores: standings,
        finishedAt: new Date(),
      },
    });

    const winner = standings[0];
    const playerRank = standings.findIndex((s) => s.name === playerName) + 1;

    const recentHighScores = await prisma.highScore.findMany({
      orderBy: { netWorth: "desc" },
      take: 10,
    });

    return {
      gameOver: true,
      standings,
      winner: winner?.name ?? "Unknown",
      playerRank,
      playerScore: standings.find((s) => s.name === playerName),
      highScores: recentHighScores,
    };
  },

  // -------------------------------------------------------------------------
  // Hub turn state (for POST /api/auth/login games list)
  // -------------------------------------------------------------------------

  async computeHubTurnState(
    player: { id: string; empire: { fullTurnsUsedThisRound: number; turnsLeft: number } | null },
    session: { id: string; turnMode: string; actionsPerDay: number; currentTurnPlayerId: string | null },
  ): Promise<{ isYourTurn: boolean; currentTurnPlayer: string | null }> {
    if (session.turnMode === "simultaneous") {
      const used = player.empire?.fullTurnsUsedThisRound ?? 0;
      const fullTurnsLeftToday = Math.max(0, session.actionsPerDay - used);
      const isYourTurn = fullTurnsLeftToday > 0 && (player.empire?.turnsLeft ?? 0) > 0;
      return { isYourTurn, currentTurnPlayer: null };
    }

    // Sequential: call getCurrentTurn to resolve auto-skips and get current player name.
    const turn = await getCurrentTurn(session.id);
    if (turn) {
      return {
        isYourTurn: turn.currentPlayerId === player.id,
        currentTurnPlayer: turn.currentPlayerName,
      };
    }
    return { isYourTurn: false, currentTurnPlayer: null };
  },
};

// ---------------------------------------------------------------------------
// buildSrxResponse — core SRX status payload builder (extracted from status/route.ts)
// ---------------------------------------------------------------------------

async function buildSrxResponse(player: FullPlayer): Promise<Record<string, unknown>> {
  const e = player.empire!;
  const planetSummary: Record<string, number> = {};
  for (const p of e.planets) {
    planetSummary[p.type as string] = (planetSummary[p.type as string] || 0) + 1;
  }

  let isYourTurn = false;
  let currentTurnPlayer: string | null = null;
  let turnDeadline: string | null = null;
  let turnOrder: { name: string; isAI: boolean }[] = [];
  let turnTimeoutSecs = 86400;
  let waitingForGameStart = false;

  let turnMode: "sequential" | "simultaneous" = "sequential";
  let dayNumber = 1;
  let actionsPerDay = 5;
  let fullTurnsLeftToday = 0;
  let turnOpen = false;
  let canAct = false;
  let roundEndsAt: string | null = null;

  if (player.gameSessionId) {
    const sess = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
      select: {
        turnTimeoutSecs: true,
        waitingForHuman: true,
        turnMode: true,
        dayNumber: true,
        actionsPerDay: true,
        roundStartedAt: true,
        turnStartedAt: true,
      },
    });

    if (sess) {
      turnTimeoutSecs = sess.turnTimeoutSecs;
      waitingForGameStart = sess.waitingForHuman === true;
      turnMode = sess.turnMode === "simultaneous" ? "simultaneous" : "sequential";
      dayNumber = sess.dayNumber;
      actionsPerDay = sess.actionsPerDay;
    }

    if (sess?.turnMode === "simultaneous") {
      const used = e.fullTurnsUsedThisRound ?? 0;
      fullTurnsLeftToday = Math.max(0, actionsPerDay - used);
      turnOpen = e.turnOpen ?? false;
      canAct = fullTurnsLeftToday > 0 && e.turnsLeft > 0;
      if (sess.roundStartedAt) {
        roundEndsAt = new Date(sess.roundStartedAt.getTime() + turnTimeoutSecs * 1000).toISOString();
        turnDeadline = roundEndsAt;
      } else {
        roundEndsAt = null;
        turnDeadline = null;
      }
      isYourTurn = canAct;
      currentTurnPlayer = null;

      const roster = await prisma.player.findMany({
        where: { gameSessionId: player.gameSessionId, empire: { turnsLeft: { gt: 0 } } },
        orderBy: { turnOrder: "asc" },
        select: { name: true, isAI: true },
      });
      turnOrder = roster.map((p) => ({ name: p.name, isAI: p.isAI }));
    } else if (sess) {
      const turn = await getCurrentTurn(player.gameSessionId);
      if (turn) {
        isYourTurn = turn.currentPlayerId === player.id;
        currentTurnPlayer = turn.currentPlayerName;
        turnDeadline = turn.turnDeadline;
        turnOrder = turn.order.map((p) => ({ name: p.name, isAI: p.isAI }));
      } else {
        const roster = await prisma.player.findMany({
          where: { gameSessionId: player.gameSessionId, empire: { turnsLeft: { gt: 0 } } },
          orderBy: { turnOrder: "asc" },
          select: { name: true, isAI: true },
        });
        turnOrder = roster.map((p) => ({ name: p.name, isAI: p.isAI }));
      }
    }
  }

  return {
    player: { id: player.id, name: player.name, isAI: player.isAI },
    gameSessionId: player.gameSessionId,
    isYourTurn,
    currentTurnPlayer,
    turnDeadline,
    turnOrder,
    turnTimeoutSecs,
    waitingForGameStart,
    turnMode,
    dayNumber,
    actionsPerDay,
    fullTurnsLeftToday,
    turnOpen,
    canAct,
    roundEndsAt,
    empire: {
      credits: e.credits,
      food: e.food,
      ore: e.ore,
      fuel: e.fuel,
      population: e.population,
      taxRate: e.taxRate,
      civilStatus: e.civilStatus,
      civilStatusName: CIVIL_STATUS_NAMES[e.civilStatus] ?? "Unknown",
      foodSellRate: e.foodSellRate,
      oreSellRate: e.oreSellRate,
      petroleumSellRate: e.petroleumSellRate,
      netWorth: e.netWorth,
      turnsPlayed: e.turnsPlayed,
      turnsLeft: e.turnsLeft,
      isProtected: e.isProtected,
      protectionTurns: e.protectionTurns,
      turnOpen: e.turnOpen,
      fullTurnsUsedThisRound: e.fullTurnsUsedThisRound,
    },
    planets: e.planets.map((p: Record<string, unknown>) => ({
      id: p.id,
      name: p.name,
      sector: p.sector,
      type: p.type,
      typeLabel: PLANET_CONFIG[p.type as keyof typeof PLANET_CONFIG]?.label ?? p.type,
      population: p.population,
      longTermProduction: p.longTermProduction,
      shortTermProduction: p.shortTermProduction,
      defenses: p.defenses,
      isRadiated: p.isRadiated,
    })),
    planetSummary,
    army: e.army
      ? {
          soldiers: e.army.soldiers,
          generals: e.army.generals,
          fighters: e.army.fighters,
          defenseStations: e.army.defenseStations,
          lightCruisers: e.army.lightCruisers,
          heavyCruisers: e.army.heavyCruisers,
          carriers: e.army.carriers,
          covertAgents: e.army.covertAgents,
          commandShipStrength: e.army.commandShipStrength,
          effectiveness: e.army.effectiveness,
          covertPoints: e.army.covertPoints,
          soldiersLevel: e.army.soldiersLevel,
          fightersLevel: e.army.fightersLevel,
          stationsLevel: e.army.stationsLevel,
          lightCruisersLevel: e.army.lightCruisersLevel,
          heavyCruisersLevel: e.army.heavyCruisersLevel,
        }
      : null,
    supplyRates: e.supplyRates,
    research: e.research
      ? {
          accumulatedPoints: e.research.accumulatedPoints,
          unlockedTechIds: e.research.unlockedTechIds as string[],
        }
      : null,
  };
}

// Export the raw builder for use in status/route.ts (it needs it for the
// POST resume path where the player object is already loaded).
export { buildSrxResponse };
