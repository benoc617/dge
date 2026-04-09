import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION } from "@/lib/game-constants";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("id");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing session id" }, { status: 400 });
  }

  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      galaxyName: true,
      createdBy: true,
      isPublic: true,
      inviteCode: true,
      maxPlayers: true,
      playerNames: true,
      status: true,
      startedAt: true,
      turnTimeoutSecs: true,
      gameType: true,
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json({ ...session, game: session.gameType });
}

export async function PATCH(req: NextRequest) {
  const { sessionId, playerName, isPublic, maxPlayers, turnTimeoutSecs } = await req.json();

  if (!sessionId || !playerName) {
    return NextResponse.json({ error: "Missing sessionId or playerName" }, { status: 400 });
  }

  const session = await prisma.gameSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (session.createdBy !== playerName) {
    return NextResponse.json({ error: "Only the galaxy creator can change settings" }, { status: 403 });
  }

  const updateData: Record<string, unknown> = {};
  if (typeof isPublic === "boolean") updateData.isPublic = isPublic;
  if (
    typeof maxPlayers === "number" &&
    maxPlayers >= SESSION.MIN_PLAYERS &&
    maxPlayers <= SESSION.MAX_PLAYERS_CAP
  ) {
    updateData.maxPlayers = maxPlayers;
  }
  if (typeof turnTimeoutSecs === "number" && turnTimeoutSecs > 0) updateData.turnTimeoutSecs = turnTimeoutSecs;

  const updated = await prisma.gameSession.update({
    where: { id: sessionId },
    data: updateData,
    select: {
      id: true,
      galaxyName: true,
      isPublic: true,
      inviteCode: true,
      maxPlayers: true,
      turnTimeoutSecs: true,
      gameType: true,
    },
  });

  return NextResponse.json({ ...updated, game: updated.gameType });
}
