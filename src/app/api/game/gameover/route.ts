import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

export async function POST(req: NextRequest) {
  const { playerName } = await req.json();
  if (!playerName) {
    return NextResponse.json({ error: "playerName required" }, { status: 400 });
  }

  // Find the player and their session.
  const requestingPlayer = await prisma.player.findFirst({
    where: { name: playerName, isAI: false },
    orderBy: { createdAt: "desc" },
    select: {
      gameSessionId: true,
      gameSession: { select: { gameType: true } },
    },
  });

  const sessionId = requestingPlayer?.gameSessionId;
  const game = requestingPlayer?.gameSession?.gameType ?? "srx";

  if (!sessionId) {
    return NextResponse.json({ error: "No active session found for player" }, { status: 404 });
  }

  const { adapter } = requireGame(game);

  if (adapter.buildGameOver) {
    const payload = await adapter.buildGameOver(sessionId, playerName);
    return NextResponse.json(payload);
  }

  // Generic fallback: minimal game-over response with no SRX-specific fields.
  await prisma.gameSession.update({
    where: { id: sessionId },
    data: { status: "finished", finishedAt: new Date() },
  });

  return NextResponse.json({ gameOver: true, game, sessionId });
}
