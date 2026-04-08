import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const lobbies = await prisma.gameSession.findMany({
    where: {
      isPublic: true,
      status: "active",
    },
    select: {
      id: true,
      galaxyName: true,
      createdBy: true,
      maxPlayers: true,
      playerNames: true,
      startedAt: true,
      turnTimeoutSecs: true,
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
  }));

  return NextResponse.json(result);
}
