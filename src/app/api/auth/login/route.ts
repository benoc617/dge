import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeUsername } from "@/lib/auth";
import { getCurrentTurn } from "@/lib/turn-order";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || typeof username !== "string") {
    return NextResponse.json({ error: "Username is required" }, { status: 400 });
  }
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const norm = normalizeUsername(username);
  const account = await prisma.userAccount.findUnique({
    where: { username: norm },
  });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const valid = await bcrypt.compare(password, account.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  await prisma.userAccount.update({
    where: { id: account.id },
    data: { lastLoginAt: new Date() },
  });

  const players = await prisma.player.findMany({
    where: {
      userId: account.id,
      isAI: false,
      empire: { turnsLeft: { gt: 0 } },
    },
    include: { empire: true, gameSession: true },
    orderBy: { updatedAt: "desc" },
  });

  const games: {
    playerId: string;
    playerName: string;
    gameSessionId: string;
    galaxyName: string | null;
    turnsLeft: number;
    turnsPlayed: number;
    inviteCode: string | null;
    isPublic: boolean;
    isYourTurn: boolean;
    currentTurnPlayer: string | null;
    maxPlayers: number;
    playerCount: number;
    waitingForHuman: boolean;
  }[] = [];

  for (const p of players) {
    const sess = p.gameSession;
    if (!sess || sess.status !== "active") continue;
    let isYourTurn = false;
    let currentTurnPlayer: string | null = null;
    const turn = await getCurrentTurn(sess.id);
    if (turn) {
      isYourTurn = turn.currentPlayerId === p.id;
      currentTurnPlayer = turn.currentPlayerName;
    }
    games.push({
      playerId: p.id,
      playerName: p.name,
      gameSessionId: sess.id,
      galaxyName: sess.galaxyName,
      turnsLeft: p.empire!.turnsLeft,
      turnsPlayed: p.empire!.turnsPlayed,
      inviteCode: sess.inviteCode,
      isPublic: sess.isPublic,
      isYourTurn,
      currentTurnPlayer,
      maxPlayers: sess.maxPlayers,
      playerCount: (sess.playerNames as string[]).length,
      waitingForHuman: sess.waitingForHuman === true,
    });
  }

  return NextResponse.json({
    user: {
      username: account.username,
      fullName: account.fullName,
      email: account.email,
    },
    games,
  });
}
