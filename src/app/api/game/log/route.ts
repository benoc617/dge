import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const playerName = req.nextUrl.searchParams.get("player");

  const turnLogs = await prisma.turnLog.findMany({
    orderBy: { createdAt: "asc" },
    include: { player: { select: { name: true, isAI: true } } },
  });

  const gameEvents = await prisma.gameEvent.findMany({
    orderBy: { createdAt: "asc" },
  });

  const players = await prisma.player.findMany({
    include: { empire: { include: { planets: true, army: true, research: true } } },
  });

  const finalState = players.map((p) => ({
    name: p.name,
    isAI: p.isAI,
    empire: p.empire ? {
      credits: p.empire.credits,
      food: p.empire.food,
      ore: p.empire.ore,
      fuel: p.empire.fuel,
      population: p.empire.population,
      netWorth: p.empire.netWorth,
      turnsPlayed: p.empire.turnsPlayed,
      turnsLeft: p.empire.turnsLeft,
      taxRate: p.empire.taxRate,
      civilStatus: p.empire.civilStatus,
      planets: p.empire.planets.length,
      planetBreakdown: p.empire.planets.reduce((acc, pl) => {
        acc[pl.type] = (acc[pl.type] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      army: p.empire.army ? {
        soldiers: p.empire.army.soldiers,
        generals: p.empire.army.generals,
        fighters: p.empire.army.fighters,
        defenseStations: p.empire.army.defenseStations,
        lightCruisers: p.empire.army.lightCruisers,
        heavyCruisers: p.empire.army.heavyCruisers,
        carriers: p.empire.army.carriers,
        covertAgents: p.empire.army.covertAgents,
        effectiveness: p.empire.army.effectiveness,
      } : null,
      researchPoints: p.empire.research?.accumulatedPoints ?? 0,
      unlockedTechs: (p.empire.research?.unlockedTechIds as string[]) ?? [],
    } : null,
  }));

  return NextResponse.json({
    exportedAt: new Date().toISOString(),
    requestedBy: playerName,
    totalTurnLogs: turnLogs.length,
    totalEvents: gameEvents.length,
    players: finalState,
    turnLogs: turnLogs.map((t) => ({
      turn: t.createdAt.toISOString(),
      player: t.player.name,
      isAI: t.player.isAI,
      action: t.action,
      details: t.details,
    })),
    gameEvents: gameEvents.map((e) => ({
      time: e.createdAt.toISOString(),
      type: e.type,
      message: e.message,
      details: e.details,
    })),
  });
}
