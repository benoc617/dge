import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAIMove, AI_PERSONAS, computeRivalAttackTargets, type AIMoveContext } from "@/lib/gemini";
import { processAiMoveOrSkip } from "@/lib/ai-process-move";
import { type ActionType } from "@/lib/game-engine";

export async function POST(req: NextRequest) {
  const { playerName } = await req.json();

  const player = await prisma.player.findFirst({
    where: { name: playerName, isAI: true },
    orderBy: { createdAt: "desc" },
    include: {
      empire: { include: { planets: true, army: true, supplyRates: true, research: true } },
    },
  });

  if (!player?.isAI) {
    return NextResponse.json({ error: "Player is not an AI" }, { status: 400 });
  }

  if (!player.empire || player.empire.turnsLeft < 1) {
    return NextResponse.json({ error: "No turns left" }, { status: 400 });
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
  };

  const recentEvents = gameSessionId
    ? await prisma.gameEvent.findMany({
        where: { gameSessionId },
        orderBy: { createdAt: "desc" },
        take: 16,
      })
    : [];

  const eventMessages = recentEvents
    .reverse()
    .map((ev) => `[${ev.type}] ${ev.message}`);

  const move = await getAIMove(
    player.aiPersona ?? AI_PERSONAS.economist,
    {
      credits: player.empire.credits,
      food: player.empire.food,
      ore: player.empire.ore,
      fuel: player.empire.fuel,
      population: player.empire.population,
      taxRate: player.empire.taxRate,
      civilStatus: player.empire.civilStatus,
      turnsPlayed: player.empire.turnsPlayed,
      turnsLeft: player.empire.turnsLeft,
      netWorth: player.empire.netWorth,
      isProtected: player.empire.isProtected,
      protectionTurns: player.empire.protectionTurns,
      foodSellRate: player.empire.foodSellRate,
      oreSellRate: player.empire.oreSellRate,
      petroleumSellRate: player.empire.petroleumSellRate,
      planets: player.empire.planets.map((p) => ({
        type: p.type,
        shortTermProduction: p.shortTermProduction,
      })),
      army: player.empire.army ? {
        soldiers: player.empire.army.soldiers,
        generals: player.empire.army.generals,
        fighters: player.empire.army.fighters,
        defenseStations: player.empire.army.defenseStations,
        lightCruisers: player.empire.army.lightCruisers,
        heavyCruisers: player.empire.army.heavyCruisers,
        carriers: player.empire.army.carriers,
        covertAgents: player.empire.army.covertAgents,
        commandShipStrength: player.empire.army.commandShipStrength,
        effectiveness: player.empire.army.effectiveness,
        covertPoints: player.empire.army.covertPoints,
      } : undefined,
      research: player.empire.research ? {
        accumulatedPoints: player.empire.research.accumulatedPoints,
        unlockedTechIds: player.empire.research.unlockedTechIds,
      } : undefined,
    },
    eventMessages,
    ctx,
  );

  const llmSource = move.llmSource;

  // Build params from AI move
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

  const { finalResult, skipped, invalidMessage } = await processAiMoveOrSkip(
    player.id,
    move.action as ActionType,
    params,
    {
      llmSource,
      aiReasoning: move.reasoning,
      ...(move.aiTiming
        ? {
            aiTiming: {
              getAIMove: move.aiTiming,
            },
          }
        : {}),
    },
  );

  const displayMessage =
    finalResult.success && skipped && invalidMessage
      ? `${invalidMessage} — skipped turn.`
      : finalResult.message;

  await prisma.gameEvent.create({
    data: {
      gameSessionId: gameSessionId ?? undefined,
      type: "ai_turn",
      message: `[${llmSource}] ${player.name}: ${displayMessage}`,
      details: {
        llmSource,
        action: skipped ? "end_turn" : move.action,
        attemptedAction: move.action,
        skippedInvalid: skipped,
        reasoning: move.reasoning,
        success: finalResult.success,
      } as object,
    },
  });

  return NextResponse.json({ move, result: finalResult, skippedInvalid: skipped });
}
