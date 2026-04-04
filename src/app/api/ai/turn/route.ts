import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAIMove } from "@/lib/gemini";
import { processAction, ActionType } from "@/lib/game-engine";

export async function POST(req: NextRequest) {
  const { playerName } = await req.json();

  const player = await prisma.player.findUnique({
    where: { name: playerName },
    include: { empire: { include: { planets: true } } },
  });

  if (!player?.isAI) {
    return NextResponse.json({ error: "Player is not an AI" }, { status: 400 });
  }

  const recentEvents = await prisma.gameEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const eventMessages = recentEvents.map((e) => `[${e.type}] ${e.message}`);

  const move = await getAIMove(
    player.aiPersona ?? "A cunning space warlord",
    player.empire,
    eventMessages
  );

  const result = await processAction(player.id, move.action as ActionType, {
    target: move.target,
    amount: move.amount,
  });

  await prisma.gameEvent.create({
    data: {
      type: "ai_turn",
      message: `${player.name} (AI): ${result.message}`,
      details: { move, result },
    },
  });

  return NextResponse.json({ move, result });
}
