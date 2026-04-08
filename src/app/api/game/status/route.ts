import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { CIVIL_STATUS_NAMES, PLANET_CONFIG } from "@/lib/game-constants";
import { getCurrentTurn } from "@/lib/turn-order";
import { tryRollRound } from "@/lib/door-game-turns";
import { runDoorGameAITurns } from "@/lib/door-game-turns";
import { logSrxTiming, msElapsed } from "@/lib/srx-timing";
import bcrypt from "bcryptjs";

const playerInclude = {
  empire: {
    include: {
      planets: { orderBy: { createdAt: "asc" as const } },
      army: true,
      supplyRates: true,
      research: true,
    },
  },
};

type FullPlayer = NonNullable<Awaited<ReturnType<typeof findActivePlayer>>>;

function findActivePlayer(name: string) {
  return prisma.player.findFirst({
    where: { name, isAI: false, empire: { turnsLeft: { gt: 0 } } },
    orderBy: { createdAt: "desc" },
    include: playerInclude,
  });
}

function findPlayerById(id: string) {
  return prisma.player.findUnique({
    where: { id },
    include: playerInclude,
  });
}

async function buildResponse(player: FullPlayer) {
  const tBuild = performance.now();
  let sessionLoadMs: number | undefined;
  let rosterOrTurnMs: number | undefined;

  const e = player.empire!;
  const planetSummary: Record<string, number> = {};
  for (const p of e.planets) {
    planetSummary[p.type] = (planetSummary[p.type] || 0) + 1;
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
    const tSess0 = performance.now();
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
    sessionLoadMs = msElapsed(tSess0);
    if (!sess) {
      /* session deleted */
    } else {
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

      const roster0 = performance.now();
      const roster = await prisma.player.findMany({
        where: { gameSessionId: player.gameSessionId, empire: { turnsLeft: { gt: 0 } } },
        orderBy: { turnOrder: "asc" },
        select: { name: true, isAI: true },
      });
      rosterOrTurnMs = msElapsed(roster0);
      turnOrder = roster.map((p) => ({ name: p.name, isAI: p.isAI }));
    } else if (sess) {
      const turn0 = performance.now();
      const turn = await getCurrentTurn(player.gameSessionId);
      rosterOrTurnMs = msElapsed(turn0);
      if (turn) {
        isYourTurn = turn.currentPlayerId === player.id;
        currentTurnPlayer = turn.currentPlayerName;
        turnDeadline = turn.turnDeadline;
        turnOrder = turn.order.map((p) => ({ name: p.name, isAI: p.isAI }));
      } else {
        const roster0 = performance.now();
        const roster = await prisma.player.findMany({
          where: { gameSessionId: player.gameSessionId, empire: { turnsLeft: { gt: 0 } } },
          orderBy: { turnOrder: "asc" },
          select: { name: true, isAI: true },
        });
        rosterOrTurnMs = msElapsed(roster0);
        turnOrder = roster.map((p) => ({ name: p.name, isAI: p.isAI }));
      }
    }
  }

  logSrxTiming("status_buildResponse", {
    playerId: player.id,
    sessionId: player.gameSessionId,
    turnMode,
    totalMs: msElapsed(tBuild),
    sessionLoadMs,
    rosterOrTurnMs,
  });

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
    planets: e.planets.map((p) => ({
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
          unlockedTechIds: e.research.unlockedTechIds,
        }
      : null,
  };
}

// GET — unauthenticated status refresh (used after initial login, keyed by player ID)
export async function GET(req: NextRequest) {
  const tRoute = performance.now();
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");
  const playerId = searchParams.get("id");

  if (!playerName && !playerId) {
    return NextResponse.json({ error: "player or id param required" }, { status: 400 });
  }

  const tFind0 = performance.now();
  const player = playerId
    ? await findPlayerById(playerId)
    : await prisma.player.findFirst({
        where: { name: playerName!, isAI: false },
        orderBy: { createdAt: "desc" },
        include: playerInclude,
      });
  const findPlayerMs = msElapsed(tFind0);

  if (!player || !player.empire) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  const tBuild0 = performance.now();
  const body = await buildResponse(player);
  const buildResponseMs = msElapsed(tBuild0);
  logSrxTiming("status_get_route", {
    playerId: player.id,
    findPlayerMs,
    buildResponseMs,
    routeTotalMs: msElapsed(tRoute),
  });

  // Non-blocking: after response is sent, check if AIs need to run or round needs to roll.
  // tryRollRound handles day advancement + round timeout; runDoorGameAITurns deduplicates via doorAiInFlight.
  if (body.turnMode === "simultaneous" && player.gameSessionId && body.fullTurnsLeftToday === 0) {
    after(async () => {
      try {
        await tryRollRound(player.gameSessionId!);
        await runDoorGameAITurns(player.gameSessionId!);
      } catch (e) {
        console.error("[status] after: tryRollRound/AI drain error", e);
      }
    });
  }

  return NextResponse.json(body);
}

// POST — authenticated login (resume game with password)
export async function POST(req: NextRequest) {
  const tRoute = performance.now();
  const { name, password } = await req.json();

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const tFind0 = performance.now();
  const player = await findActivePlayer(name);
  const findPlayerMs = msElapsed(tFind0);

  if (!player) {
    const finished = await prisma.player.findFirst({
      where: { name, isAI: false },
      include: { empire: true },
    });
    if (finished?.empire && finished.empire.turnsLeft <= 0) {
      return NextResponse.json({ error: "This game is over. Start a new empire!" }, { status: 410 });
    }
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  if (!player.empire) {
    return NextResponse.json({ error: "Empire not found" }, { status: 404 });
  }

  if (player.passwordHash) {
    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 401 });
    }
    const valid = await bcrypt.compare(password, player.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }
  }

  if (player.userId) {
    await prisma.userAccount.update({
      where: { id: player.userId },
      data: { lastLoginAt: new Date() },
    });
  }

  const tBuild0 = performance.now();
  const body = await buildResponse(player);
  const buildResponseMs = msElapsed(tBuild0);
  logSrxTiming("status_post_route", {
    playerId: player.id,
    findPlayerMs,
    buildResponseMs,
    routeTotalMs: msElapsed(tRoute),
  });

  return NextResponse.json(body);
}
