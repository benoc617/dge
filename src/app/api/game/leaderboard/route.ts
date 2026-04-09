import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");

  // Find the requesting player's game session to scope results.
  let sessionId: string | null = null;
  let game = "srx";

  if (playerName) {
    const player = await prisma.player.findFirst({
      where: { name: playerName, isAI: false },
      orderBy: { createdAt: "desc" },
      select: {
        gameSessionId: true,
        gameSession: { select: { gameType: true } },
      },
    });
    sessionId = player?.gameSessionId ?? null;
    game = player?.gameSession?.gameType ?? "srx";
  }

  const { adapter } = requireGame(game);

  if (!adapter.buildLeaderboard) {
    return NextResponse.json({ leaderboard: [] });
  }

  const leaderboard = await adapter.buildLeaderboard(sessionId);
  return NextResponse.json({ leaderboard });
}
