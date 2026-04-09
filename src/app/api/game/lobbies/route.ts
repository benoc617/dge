import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // Optional filter: ?game=srx  (maps to DB field gameType)
  const gameFilter = searchParams.get("game") ?? null;

  const lobbies = await prisma.gameSession.findMany({
    where: {
      isPublic: true,
      status: "active",
      ...(gameFilter ? { gameType: gameFilter } : {}),
    },
    select: {
      id: true,
      galaxyName: true,
      createdBy: true,
      maxPlayers: true,
      playerNames: true,
      startedAt: true,
      turnTimeoutSecs: true,
      gameType: true,
    },
    orderBy: { startedAt: "desc" },
    take: 50,
  });

  const result = lobbies.map((l) => ({
    id: l.id,
    galaxyName: l.galaxyName ?? `Galaxy ${l.id.slice(-6)}`,
    createdBy: l.createdBy ?? "Unknown",
    playerCount: (l.playerNames as string[]).length,
    maxPlayers: l.maxPlayers,
    startedAt: l.startedAt,
    turnTimeoutSecs: l.turnTimeoutSecs,
    game: l.gameType ?? "srx",
  }));

  return NextResponse.json(result);
}
