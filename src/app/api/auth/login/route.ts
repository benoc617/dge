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

  // Only active sessions — session.status === "active" covers all game types
  // without needing to inspect the SRX empire table.
  const players = await prisma.player.findMany({
    where: {
      userId: account.id,
      isAI: false,
      gameSession: { status: "active" },
    },
    select: { id: true, name: true, gameSessionId: true, gameSession: true },
    orderBy: { updatedAt: "desc" },
  });

  const games: {
    playerId: string;
    playerName: string;
    gameSessionId: string;
    galaxyName: string | null;
    game: string;
    inviteCode: string | null;
    isPublic: boolean;
    isYourTurn: boolean;
    currentTurnPlayer: string | null;
    maxPlayers: number;
    playerCount: number;
    waitingForHuman: boolean;
    [key: string]: unknown; // game-specific hub stats (e.g. turnsLeft, turnsPlayed for SRX)
  }[] = [];

  for (const p of players) {
    const sess = p.gameSession;
    if (!sess || sess.status !== "active") continue;

    const gameType = (sess as { gameType?: string | null }).gameType ?? "srx";

    // Delegate turn-state and optional game-specific stats to the adapter.
    let isYourTurn = false;
    let currentTurnPlayer: string | null = null;
    let hubStats: Record<string, unknown> = {};
    try {
      const { adapter } = requireGame(gameType);
      if (adapter.computeHubTurnState) {
        const ts = await adapter.computeHubTurnState(
          { id: p.id },
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
      if (adapter.getHubStats) {
        hubStats = await adapter.getHubStats(p.id);
      }
    } catch {
      // Unknown game type — skip turn state.
    }

    games.push({
      playerId: p.id,
      playerName: p.name,
      gameSessionId: sess.id,
      galaxyName: sess.galaxyName,
      game: gameType,
      inviteCode: sess.inviteCode,
      isPublic: sess.isPublic,
      isYourTurn,
      currentTurnPlayer,
      maxPlayers: sess.maxPlayers,
      playerCount: (sess.playerNames as string[]).length,
      waitingForHuman: sess.waitingForHuman === true,
      ...hubStats,
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
