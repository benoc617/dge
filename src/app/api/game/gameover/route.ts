import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

export async function POST(req: NextRequest) {
  const { playerName, playerId: bodyPlayerId } = await req.json();
  if (!playerName && !bodyPlayerId) {
    return NextResponse.json({ error: "playerName or playerId required" }, { status: 400 });
  }

  const requestingPlayer = bodyPlayerId
    ? await prisma.player.findUnique({
        where: { id: bodyPlayerId },
        select: {
          name: true,
          gameSessionId: true,
          gameSession: { select: { gameType: true } },
        },
      })
    : await prisma.player.findFirst({
        where: { name: playerName, isAI: false },
        orderBy: { createdAt: "desc" },
        select: {
          name: true,
          gameSessionId: true,
          gameSession: { select: { gameType: true } },
        },
      });

  const sessionId = requestingPlayer?.gameSessionId;
  const game = requestingPlayer?.gameSession?.gameType ?? "srx";
  const resolvedName = requestingPlayer?.name ?? playerName;

  if (!sessionId) {
    return NextResponse.json({ error: "No active session found for player" }, { status: 404 });
  }

  const { adapter } = requireGame(game);

  if (adapter.buildGameOver) {
    const payload = await adapter.buildGameOver(sessionId, resolvedName);
    return NextResponse.json(payload);
  }

  // Generic fallback: minimal game-over response with no SRX-specific fields.
  await prisma.gameSession.update({
    where: { id: sessionId },
    data: { status: "finished", finishedAt: new Date() },
  });

  return NextResponse.json({ gameOver: true, game, sessionId });
}
