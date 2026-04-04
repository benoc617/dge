import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processAction, ActionType } from "@/lib/game-engine";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { playerName, action, target, amount } = body;

  if (!playerName || !action) {
    return NextResponse.json({ error: "playerName and action required" }, { status: 400 });
  }

  const player = await prisma.player.findUnique({ where: { name: playerName } });
  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  const result = await processAction(player.id, action as ActionType, { target, amount });
  return NextResponse.json(result);
}
