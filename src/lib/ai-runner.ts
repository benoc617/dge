/**
 * SRX — AI runner shim.
 *
 * Keeps SRX-specific AI orchestration (buildAIMoveContext, runOneAI,
 * getAIMoveDecision) and wraps the engine's generic runAISequence with
 * SRX-specific hooks (SRX getCurrentTurn/advanceTurn shims + runOneAI).
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getAIMove,
  AI_PERSONAS,
  computeRivalAttackTargets,
  type AIMoveContext,
  type AIMoveTiming,
} from "@/lib/gemini";
import { processAction, runAndPersistTick, type ActionType } from "@/lib/game-engine";
import { processAiMoveOrSkip } from "@/lib/ai-process-move";
import { getCurrentTurn, advanceTurn } from "@/lib/turn-order";
import { runAISequence as _runAISequence } from "@dge/engine/ai-runner";

const PLAYER_WITH_EMPIRE = {
  empire: { include: { planets: true, army: true, supplyRates: true, research: true } },
} as const;

type PlayerWithEmpireForAI = Prisma.PlayerGetPayload<{
  include: typeof PLAYER_WITH_EMPIRE;
}>;

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
async function buildAIMoveContext(player: PlayerWithEmpireForAI) {
  const empire = player.empire;
  if (!empire) {
    throw new Error("buildAIMoveContext: empire is required");
  }
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
    playerId: player.id,
    gameSessionId: gameSessionId ?? undefined,
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
    planets: empire.planets.map((p: { type: string; shortTermProduction: number; longTermProduction: number }) => ({
      type: p.type,
      shortTermProduction: p.shortTermProduction,
      longTermProduction: p.longTermProduction,
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
      soldiersLevel: empire.army.soldiersLevel,
      fightersLevel: empire.army.fightersLevel,
      stationsLevel: empire.army.stationsLevel,
      lightCruisersLevel: empire.army.lightCruisersLevel,
      heavyCruisersLevel: empire.army.heavyCruisersLevel,
    } : undefined,
    research: empire.research ? {
      accumulatedPoints: empire.research.accumulatedPoints,
      unlockedTechIds: empire.research.unlockedTechIds as string[],
    } : undefined,
    supplyRates: empire.supplyRates ? {
      rateSoldier: empire.supplyRates.rateSoldier,
      rateFighter: empire.supplyRates.rateFighter,
      rateStation: empire.supplyRates.rateStation,
      rateHeavyCruiser: empire.supplyRates.rateHeavyCruiser,
      rateCarrier: empire.supplyRates.rateCarrier,
      rateGeneral: empire.supplyRates.rateGeneral,
      rateCovert: empire.supplyRates.rateCovert,
      rateCredits: empire.supplyRates.rateCredits,
    } : undefined,
  };

  return { ctx, eventStrings, empireState };
}

/**
 * Pick an AI move without running a tick or persisting (used by door-game AI loop).
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

  const { ctx, eventStrings, empireState } = await buildAIMoveContext(player as PlayerWithEmpireForAI);

  const personaPrompt =
    (player.aiPersona && AI_PERSONAS[player.aiPersona as keyof typeof AI_PERSONAS]) ||
    AI_PERSONAS.economist;

  const move = await getAIMove(personaPrompt, empireState, eventStrings, ctx);

  return {
    action: move.action as ActionType,
    params: paramsFromAIMove(move),
    llmSource: move.llmSource,
    aiTiming: move.aiTiming,
  };
}

/** Resolved move from `getAIMoveDecision` (null = timeout / load failure). */
export type DoorGameAIMoveDecision = Awaited<ReturnType<typeof getAIMoveDecision>>;

/**
 * Run a single AI player's turn: tick, pick move, execute, log.
 */
async function runOneAI(
  playerId: string,
  playerName: string,
  personaKeyOrPrompt: string | null,
): Promise<{ action: string; message: string }> {
  const persona =
    (personaKeyOrPrompt && AI_PERSONAS[personaKeyOrPrompt as keyof typeof AI_PERSONAS]) ||
    AI_PERSONAS.economist;

  await runAndPersistTick(playerId);

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: PLAYER_WITH_EMPIRE,
  });

  if (!player?.empire || player.empire.turnsLeft < 1) {
    return { action: "skip", message: "No turns left" };
  }

  const gameSessionId = player.gameSessionId;

  try {
    const tTurn0 = performance.now();
    const { ctx, eventStrings, empireState } = await buildAIMoveContext(player as PlayerWithEmpireForAI);
    const contextMs = performance.now() - tTurn0;

    const tMove0 = performance.now();
    const move = await getAIMove(persona, empireState, eventStrings, ctx);
    const getAIMoveMs = performance.now() - tMove0;

    const llmSource = move.llmSource;
    const params = paramsFromAIMove(move);

    const tExec0 = performance.now();
    const logMeta = {
      llmSource,
      aiReasoning: move.reasoning,
      aiTiming: {
        getAIMove: move.aiTiming
          ? { configMs: move.aiTiming.configMs, generateMs: move.aiTiming.generateMs, totalMs: move.aiTiming.totalMs }
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

    return { action: skipped ? "end_turn" : move.action, message: displayMessage };
  } catch (primaryErr) {
    // Bug fix: if processAction(end_turn) itself throws (e.g. transient DB error),
    // the exception previously propagated into the fire-and-forget runAISequence
    // call, leaving currentTurnPlayerId pointing at this AI and the session stuck
    // until the turn timer auto-skipped (up to 24 h). Wrap in a second try/catch
    // so the outer runAISequence loop can always advance the turn.
    try {
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
      return { action: "end_turn (fallback)", message: result.message };
    } catch (fallbackErr) {
      const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      console.error(`[srx-ai] runOneAI double-exception for ${playerName}: primary="${primaryMsg}" fallback="${fallbackMsg}"`);
      // Return a synthetic result so runAISequence can advance the turn.
      // advanceTurn will move currentTurnPlayerId to the next player.
      return { action: "end_turn (double-fallback)", message: "AI turn failed — skipped." };
    }
  }
}

/**
 * Starting from the current turn, run all consecutive AI players in sequence.
 * Stops when a human player's turn is reached or wraps fully around.
 */
export async function runAISequence(
  gameSessionId: string,
): Promise<{ name: string; action: string; message: string }[]> {
  return _runAISequence(gameSessionId, {
    getCurrentTurn,
    advanceTurn,
    async runAI(playerId, playerName) {
      const player = await prisma.player.findUnique({
        where: { id: playerId },
        select: { aiPersona: true },
      });
      return runOneAI(playerId, playerName, player?.aiPersona ?? null);
    },
  });
}

/**
 * Milliseconds of inactivity on an AI's sequential turn before assuming the
 * background promise was killed (e.g. server restart) and recovery is needed.
 * 1.5× the default 60s Gemini timeout, so normal turns never trigger recovery.
 */
export const SEQUENTIAL_AI_STALE_MS = 90_000;

/**
 * Called from status polling to recover a sequential-mode AI turn that was
 * abandoned mid-flight (e.g. after a server restart killed the fire-and-forget
 * runAISequence promise).
 *
 * Atomically claims recovery by conditionally refreshing `GameSession.turnStartedAt`
 * to now. If `turnStartedAt` is already fresh (< SEQUENTIAL_AI_STALE_MS ago),
 * the conditional update matches 0 rows and this is a no-op — preventing
 * duplicate recovery across multiple Next.js workers.
 *
 * Uses the game-specific `definition.runAiSequence` when available (e.g. Gin
 * Rummy, Chess) so the correct AI logic runs rather than the SRX-specific
 * `runOneAI` path (which bails early when there's no empire row).
 */
export async function recoverSequentialAI(gameSessionId: string, gameType?: string): Promise<void> {
  const cutoff = new Date(Date.now() - SEQUENTIAL_AI_STALE_MS);
  const { count } = await prisma.gameSession.updateMany({
    where: { id: gameSessionId, turnStartedAt: { lt: cutoff } },
    data: { turnStartedAt: new Date() },
  });
  if (count === 0) return; // Turn is fresh, or another worker already claimed recovery

  // Prefer game-specific runAiSequence (non-SRX games like Gin Rummy, Chess).
  const resolvedType = gameType ?? (await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
  }) as { gameType?: string | null } | null)?.gameType ?? "srx";

  try {
    const { requireGame } = await import("@dge/engine/registry");
    const { definition } = requireGame(resolvedType);
    if (definition.runAiSequence) {
      void definition.runAiSequence(gameSessionId);
      return;
    }
  } catch {
    // fallthrough to SRX path below
  }

  void runAISequence(gameSessionId);
}
