import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CIVIL_STATUS_NAMES } from "@/lib/game-constants";
import { logSrxTiming, msElapsed } from "@/lib/srx-timing";
import { getCachedLeaderboard } from "@/lib/game-state-service";

export async function GET(req: NextRequest) {
  const tRoute = performance.now();
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");

  // Find the requesting player's game session to scope results
  let sessionId: string | null = null;
  let resolveSessionMs: number | undefined;
  if (playerName) {
    const tSess0 = performance.now();
    const player = await prisma.player.findFirst({
      where: { name: playerName, isAI: false },
      orderBy: { createdAt: "desc" },
      select: { gameSessionId: true },
    });
    resolveSessionMs = msElapsed(tSess0);
    sessionId = player?.gameSessionId ?? null;
  }

  const tEmp0 = performance.now();

  async function fetchLeaderboard() {
    const empires = await prisma.empire.findMany({
      where: {
        turnsLeft: { gt: 0 },
        ...(sessionId ? { player: { gameSessionId: sessionId } } : {}),
      },
      include: {
        player: { select: { name: true, isAI: true } },
        planets: { select: { type: true } },
        army: { select: { soldiers: true, fighters: true, lightCruisers: true, heavyCruisers: true } },
      },
      orderBy: { netWorth: "desc" },
    });
    return empires.map((e, i) => ({
      rank: i + 1,
      name: e.player.name,
      isAI: e.player.isAI,
      netWorth: e.netWorth,
      population: e.population,
      planets: e.planets.length,
      turnsPlayed: e.turnsPlayed,
      civilStatus: CIVIL_STATUS_NAMES[e.civilStatus] ?? "Unknown",
      isProtected: e.isProtected,
      protectionTurns: e.protectionTurns,
      military: e.army
        ? e.army.soldiers + e.army.fighters * 2 + e.army.lightCruisers * 4 + e.army.heavyCruisers * 10
        : 0,
    }));
  }

  const leaderboard = sessionId
    ? await getCachedLeaderboard(sessionId, fetchLeaderboard)
    : await fetchLeaderboard();

  logSrxTiming("leaderboard_get", {
    playerName,
    sessionId,
    resolveSessionMs,
    empiresQueryMs: msElapsed(tEmp0),
    routeTotalMs: msElapsed(tRoute),
    rowCount: leaderboard.length,
  });

  return NextResponse.json({ leaderboard });
}
