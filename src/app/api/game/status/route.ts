import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { CIVIL_STATUS_NAMES, PLANET_CONFIG } from "@/lib/game-constants";
import { getCurrentTurn } from "@/lib/turn-order";
import { tryRollRound, enqueueAiTurnsForSession } from "@/lib/door-game-turns";
import { recoverSequentialAI, SEQUENTIAL_AI_STALE_MS } from "@/lib/ai-runner";
import { getCachedPlayer, invalidatePlayer } from "@/lib/game-state-service";
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
          unlockedTechIds: e.research.unlockedTechIds as string[],
        }
      : null,
  };
}

// GET — unauthenticated status refresh (used after initial login, keyed by player ID)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");
  const playerId = searchParams.get("id");

  if (!playerName && !playerId) {
    return NextResponse.json({ error: "player or id param required" }, { status: 400 });
  }

  const player = playerId
    ? await getCachedPlayer(playerId, () => findPlayerById(playerId))
    : await prisma.player.findFirst({
        where: { name: playerName!, isAI: false },
        orderBy: { createdAt: "desc" },
        include: playerInclude,
      });

  if (!player || !player.empire) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  const body = await buildResponse(player);

  // Simultaneous mode: if the player has exhausted daily slots, attempt to roll
  // the round *synchronously* so this response already reflects the new day.
  // Rolling before returning eliminates the extra poll cycle that previously left
  // the UI stuck on "WAITING FOR OTHERS" even after the day number had advanced.
  if (body.turnMode === "simultaneous" && player.gameSessionId && body.fullTurnsLeftToday === 0) {
    const rolled = await tryRollRound(player.gameSessionId);
    if (rolled) {
      // Rebuild the response with fresh empire data so canAct / dayNumber are correct.
      await invalidatePlayer(player.id);
      const freshPlayer = playerId
        ? await getCachedPlayer(playerId, () => findPlayerById(playerId))
        : await prisma.player.findFirst({
            where: { name: playerName!, isAI: false },
            orderBy: { createdAt: "desc" },
            include: playerInclude,
          });
      const freshBody = freshPlayer ? await buildResponse(freshPlayer) : body;
      after(async () => {
        try { await enqueueAiTurnsForSession(player.gameSessionId!); }
        catch (e) { console.error("[status] after: enqueue error", e); }
      });
      return NextResponse.json(freshBody);
    }
    // Round not ready yet — enqueue in background (dedup-safe).
    after(async () => {
      try { await enqueueAiTurnsForSession(player.gameSessionId!); }
      catch (e) { console.error("[status] after: enqueue error", e); }
    });
  }

  // Non-blocking: recover a sequential-mode AI turn that was abandoned after a
  // server restart (the fire-and-forget runAISequence promise was killed).
  // Only fires when it's not our turn (possibly an AI's turn) and the turn has
  // been idle for longer than SEQUENTIAL_AI_STALE_MS.
  if (body.turnMode === "sequential" && player.gameSessionId && !body.isYourTurn) {
    after(async () => {
      try {
        const turn = await getCurrentTurn(player.gameSessionId!);
        if (!turn?.isAI) return;
        const ageMs = Date.now() - new Date(turn.turnStartedAt).getTime();
        if (ageMs < SEQUENTIAL_AI_STALE_MS) return;
        await recoverSequentialAI(player.gameSessionId!);
      } catch (e) {
        console.error("[status] after: sequential AI stale-turn recovery error", e);
      }
    });
  }

  return NextResponse.json(body);
}

// POST — authenticated login (resume game with password)
export async function POST(req: NextRequest) {
  const { name, password } = await req.json();

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const player = await findActivePlayer(name);

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

  const body = await buildResponse(player);
  return NextResponse.json(body);
}
