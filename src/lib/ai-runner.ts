import { prisma } from "@/lib/prisma";
import {
  getAIMove,
  AI_PERSONAS,
  computeRivalAttackTargets,
  shouldLogAiTiming,
  type AIMoveContext,
  type AIMoveTiming,
} from "@/lib/gemini";
import { processAction, runAndPersistTick, type ActionType } from "@/lib/game-engine";
import { processAiMoveOrSkip } from "@/lib/ai-process-move";
import { getCurrentTurn, advanceTurn } from "@/lib/turn-order";

const PLAYER_WITH_EMPIRE = {
  empire: { include: { planets: true, army: true, supplyRates: true, research: true } },
} as const;

function paramsFromAIMove(move: Awaited<ReturnType<typeof getAIMove>>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (move.target) params.target = move.target;
  if (move.amount) params.amount = move.amount;
  if (move.type) params.type = move.type;
  if (move.rate !== undefined) params.rate = move.rate;
  if (move.techId) params.techId = move.techId;
  if (move.opType !== undefined) params.opType = move.opType;
  if (move.resource) params.resource = move.resource;
  if (move.foodSellRate !== undefined) params.foodSellRate = move.foodSellRate;
  if (move.oreSellRate !== undefined) params.oreSellRate = move.oreSellRate;
  if (move.petroleumSellRate !== undefined) params.petroleumSellRate = move.petroleumSellRate;
  if (move.name) params.name = move.name;
  if (move.treatyType) params.treatyType = move.treatyType;
  return params;
}

/** Build the empire state snapshot and context needed by getAIMove. */
async function buildAIMoveContext(player: {
  name: string;
  gameSessionId: string | null;
  empire: NonNullable<Awaited<ReturnType<typeof prisma.player.findUnique<{ include: typeof PLAYER_WITH_EMPIRE }>>>>;
  id: string;
}) {
  const empire = player.empire;
  const gameSessionId = player.gameSessionId;

  const rivals = gameSessionId
    ? await prisma.player.findMany({
        where: { gameSessionId, id: { not: player.id } },
        select: { name: true, isAI: true, empire: { select: { isProtected: true, protectionTurns: true } } },
      })
    : [];

  const ctx: AIMoveContext = {
    commanderName: player.name,
    rivalNames: rivals.map((r) => r.name),
    rivalAttackTargets: computeRivalAttackTargets(rivals),
  };

  const recentEvents = gameSessionId
    ? await prisma.gameEvent.findMany({
        where: { gameSessionId },
        orderBy: { createdAt: "desc" },
        take: 16,
      })
    : [];

  const eventStrings = recentEvents
    .reverse()
    .map((ev) => `[${ev.type}] ${ev.message}`);

  const empireState = {
    credits: empire.credits,
    food: empire.food,
    ore: empire.ore,
    fuel: empire.fuel,
    population: empire.population,
    taxRate: empire.taxRate,
    civilStatus: empire.civilStatus,
    turnsPlayed: empire.turnsPlayed,
    turnsLeft: empire.turnsLeft,
    netWorth: empire.netWorth,
    isProtected: empire.isProtected,
    protectionTurns: empire.protectionTurns,
    foodSellRate: empire.foodSellRate,
    oreSellRate: empire.oreSellRate,
    petroleumSellRate: empire.petroleumSellRate,
    planets: empire.planets.map((p: { type: string; shortTermProduction: number }) => ({
      type: p.type,
      shortTermProduction: p.shortTermProduction,
    })),
    army: empire.army ? {
      soldiers: empire.army.soldiers,
      generals: empire.army.generals,
      fighters: empire.army.fighters,
      defenseStations: empire.army.defenseStations,
      lightCruisers: empire.army.lightCruisers,
      heavyCruisers: empire.army.heavyCruisers,
      carriers: empire.army.carriers,
      covertAgents: empire.army.covertAgents,
      commandShipStrength: empire.army.commandShipStrength,
      effectiveness: empire.army.effectiveness,
      covertPoints: empire.army.covertPoints,
    } : undefined,
    research: empire.research ? {
      accumulatedPoints: empire.research.accumulatedPoints,
      unlockedTechIds: empire.research.unlockedTechIds,
    } : undefined,
  };

  return { ctx, eventStrings, empireState };
}

/**
 * Pick an AI move without running a tick or persisting (used by door-game AI loop between ticks).
 * Empire state should reflect the end of the previous resolved slot.
 */
export async function getAIMoveDecision(playerId: string): Promise<{
  action: ActionType;
  params: Record<string, unknown>;
  llmSource: string;
  aiTiming?: AIMoveTiming;
} | null> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: PLAYER_WITH_EMPIRE,
  });
  if (!player?.empire || player.empire.turnsLeft < 1) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { ctx, eventStrings, empireState } = await buildAIMoveContext(player as any);

  const move = await getAIMove(
    player.aiPersona ?? AI_PERSONAS.economist,
    empireState,
    eventStrings,
    ctx,
  );

  return {
    action: move.action as ActionType,
    params: paramsFromAIMove(move),
    llmSource: move.llmSource,
    aiTiming: move.aiTiming,
  };
}

/**
 * Run a single AI player's turn: get their decision and execute it.
 */
async function runOneAI(playerId: string, playerName: string, persona: string | null) {
  await runAndPersistTick(playerId);

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: PLAYER_WITH_EMPIRE,
  });

  if (!player?.empire || player.empire.turnsLeft < 1) {
    return { name: playerName, action: "skip", success: false, message: "No turns left" };
  }

  const gameSessionId = player.gameSessionId;

  try {
    const tTurn0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { ctx, eventStrings, empireState } = await buildAIMoveContext(player as any);
    const contextMs = performance.now() - tTurn0;

    const tMove0 = performance.now();
    const move = await getAIMove(
      persona ?? AI_PERSONAS.economist,
      empireState,
      eventStrings,
      ctx,
    );
    const getAIMoveMs = performance.now() - tMove0;

    const llmSource = move.llmSource;

    const params = paramsFromAIMove(move);

    const tExec0 = performance.now();
    /** Written to TurnLog before `processAction` completes — omit execute/total wall (unknown until after). */
    const logMeta = {
      llmSource,
      aiReasoning: move.reasoning,
      aiTiming: {
        getAIMove: move.aiTiming
          ? {
              configMs: move.aiTiming.configMs,
              generateMs: move.aiTiming.generateMs,
              totalMs: move.aiTiming.totalMs,
            }
          : undefined,
        runOneAI: {
          contextMs: Math.round(contextMs),
          getAIMoveMs: Math.round(getAIMoveMs),
        },
      },
    };

    const { finalResult, skipped, invalidMessage } = await processAiMoveOrSkip(
      playerId,
      move.action as ActionType,
      params,
      logMeta,
    );
    const executeMs = performance.now() - tExec0;
    const aiTimingFull = {
      getAIMove: logMeta.aiTiming.getAIMove,
      runOneAI: {
        ...logMeta.aiTiming.runOneAI,
        executeMs: Math.round(executeMs),
        totalMs: Math.round(performance.now() - tTurn0),
      },
    };

    if (shouldLogAiTiming()) {
      console.info(
        "[srx-ai]",
        JSON.stringify({
          event: "runOneAI",
          commander: playerName,
          contextMs: Math.round(contextMs),
          getAIMoveMs: Math.round(getAIMoveMs),
          executeMs: Math.round(executeMs),
          totalMs: Math.round(performance.now() - tTurn0),
          llmSource: move.llmSource,
        }),
      );
    }

    const displayMessage =
      finalResult.success && skipped && invalidMessage
        ? `${invalidMessage} — skipped turn.`
        : finalResult.message;

    await prisma.gameEvent.create({
      data: {
        gameSessionId: gameSessionId ?? undefined,
        type: "ai_turn",
        message: `[${llmSource}] ${playerName}: ${displayMessage}`,
        details: {
          llmSource,
          action: skipped ? "end_turn" : move.action,
          attemptedAction: move.action,
          skippedInvalid: skipped,
          reasoning: move.reasoning,
          success: finalResult.success,
          aiTiming: aiTimingFull,
        } as object,
      },
    });

    return {
      name: playerName,
      action: skipped ? "end_turn" : move.action,
      success: finalResult.success,
      message: displayMessage,
    };
  } catch {
    const result = await processAction(playerId, "end_turn", undefined, {
      logMeta: { llmSource: "fallback", aiReasoning: "exception fallback" },
    });
    await prisma.gameEvent.create({
      data: {
        gameSessionId: gameSessionId ?? undefined,
        type: "ai_turn",
        message: `[fallback] ${playerName}: ${result.message}`,
        details: { llmSource: "fallback", action: "end_turn", reasoning: "exception fallback", success: result.success } as object,
      },
    });
    return { name: playerName, action: "end_turn (fallback)", success: result.success, message: result.message };
  }
}

/**
 * Starting from the current turn, run all consecutive AI players in sequence.
 * Stops when it reaches a human player (their turn) or wraps fully around.
 * Returns the list of AI actions taken.
 */
export async function runAISequence(gameSessionId: string): Promise<{ name: string; action: string; message: string }[]> {
  const results: { name: string; action: string; message: string }[] = [];
  const maxIterations = 20; // safety cap

  for (let i = 0; i < maxIterations; i++) {
    const turn = await getCurrentTurn(gameSessionId);
    if (!turn) break;

    // Stop if the current player is human — it's their turn now
    if (!turn.isAI) break;

    // Run this AI's turn
    const aiPlayer = await prisma.player.findUnique({
      where: { id: turn.currentPlayerId },
      select: { aiPersona: true },
    });

    const result = await runOneAI(turn.currentPlayerId, turn.currentPlayerName, aiPlayer?.aiPersona ?? null);
    results.push({ name: result.name, action: result.action, message: result.message });

    // Advance to the next player
    await advanceTurn(gameSessionId);
  }

  return results;
}
