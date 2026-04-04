import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");

  if (!playerName) {
    return NextResponse.json({ error: "player param required" }, { status: 400 });
  }

  const player = await prisma.player.findUnique({
    where: { name: playerName },
    include: {
      empire: { include: { planets: true } },
    },
  });

  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  return NextResponse.json(player);
}
