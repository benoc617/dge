import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { normalizeUsername } from "@/lib/auth";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

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
      OR: [
        { empire: { turnsLeft: { gt: 0 } } },
        { empire: null },
      ],
    },
    include: { empire: true, gameSession: true },
    orderBy: { updatedAt: "desc" },
  });

  const games: {
    playerId: string;
    playerName: string;
    gameSessionId: string;
    galaxyName: string | null;
    game: string;
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

    const game = sess.gameType ?? "srx";

    // Delegate turn-state computation to the game adapter.
    let isYourTurn = false;
    let currentTurnPlayer: string | null = null;
    try {
      const { adapter } = requireGame(game);
      if (adapter.computeHubTurnState) {
        const ts = await adapter.computeHubTurnState(
          {
            id: p.id,
            empire: p.empire
              ? { fullTurnsUsedThisRound: p.empire.fullTurnsUsedThisRound ?? 0, turnsLeft: p.empire.turnsLeft }
              : null,
          },
          {
            id: sess.id,
            turnMode: sess.turnMode,
            actionsPerDay: sess.actionsPerDay,
            currentTurnPlayerId: sess.currentTurnPlayerId,
          },
        );
        isYourTurn = ts.isYourTurn;
        currentTurnPlayer = ts.currentTurnPlayer;
      } else {
        // Generic sequential default.
        isYourTurn = sess.currentTurnPlayerId === p.id;
        currentTurnPlayer = null;
      }
    } catch {
      // Unknown game type — skip turn state.
    }

    games.push({
      playerId: p.id,
      playerName: p.name,
      gameSessionId: sess.id,
      galaxyName: sess.galaxyName,
      game,
      turnsLeft: p.empire?.turnsLeft ?? 0,
      turnsPlayed: p.empire?.turnsPlayed ?? 0,
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
