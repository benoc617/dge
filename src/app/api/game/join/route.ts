import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePlayerCredentials } from "@/lib/player-auth";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

export async function POST(req: NextRequest) {
  const { name, password, inviteCode, sessionId } = await req.json();

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const cred = await resolvePlayerCredentials(name, password);
  if ("error" in cred) {
    return NextResponse.json({ error: cred.error }, { status: cred.status });
  }

  let session;

  if (inviteCode) {
    session = await prisma.gameSession.findUnique({
      where: { inviteCode: inviteCode.toUpperCase().trim() },
    });
    if (!session) {
      return NextResponse.json({ error: "Invalid invite code" }, { status: 404 });
    }
  } else if (sessionId) {
    session = await prisma.gameSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!session.isPublic) {
      return NextResponse.json({ error: "This galaxy requires an invite code" }, { status: 403 });
    }
  } else {
    return NextResponse.json({ error: "Provide either inviteCode or sessionId" }, { status: 400 });
  }

  if (session.status !== "active") {
    return NextResponse.json({ error: "This galaxy is no longer active" }, { status: 410 });
  }

  // Check if the game supports joining.
  const game = (session as { gameType?: string | null }).gameType ?? "srx";
  let gameReg: ReturnType<typeof requireGame>;
  try {
    gameReg = requireGame(game);
  } catch {
    return NextResponse.json({ error: `Unknown game type: ${game}` }, { status: 500 });
  }
  const { adapter, metadata } = gameReg;

  if (!metadata.supportsJoin) {
    return NextResponse.json(
      { error: `${metadata.displayName} sessions cannot be joined — they are fixed to a set number of players.` },
      { status: 409 },
    );
  }

  if ((session.playerNames as string[]).length >= session.maxPlayers) {
    return NextResponse.json({ error: "Galaxy is full" }, { status: 409 });
  }

  const existingPlayer = await prisma.player.findFirst({
    where: { name: cred.playerName, gameSessionId: session.id },
  });
  if (existingPlayer) {
    return NextResponse.json({ error: "Name already taken in this galaxy" }, { status: 409 });
  }

  const playerCreateData = adapter.getPlayerCreateData();

  const player = await prisma.$transaction(async (tx) => {
    const humansBefore = await tx.player.count({
      where: { gameSessionId: session.id, isAI: false },
    });
    const sess = await tx.gameSession.findUnique({ where: { id: session.id } });
    if (!sess) throw new Error("Session missing");

    const isFirstHumanActivating = sess.waitingForHuman && humansBefore === 0;

    let turnOrder: number;
    if (isFirstHumanActivating) {
      await tx.player.updateMany({
        where: { gameSessionId: session.id, isAI: true },
        data: { turnOrder: { increment: 1 } },
      });
      turnOrder = 0;
    } else {
      const maxOrder = await tx.player.aggregate({
        _max: { turnOrder: true },
        where: { gameSessionId: session.id },
      });
      turnOrder = (maxOrder._max.turnOrder ?? 0) + 1;
    }

    const p = await tx.player.create({
      data: {
        name: cred.playerName,
        passwordHash: cred.passwordHash,
        userId: cred.userId,
        turnOrder,
        gameSessionId: session.id,
        ...(playerCreateData as object),
      },
      include: {
        empire: { include: { planets: true, army: true, supplyRates: true } },
      },
    });

    if (isFirstHumanActivating) {
      const simultaneous = sess.turnMode === "simultaneous";
      await tx.gameSession.update({
        where: { id: session.id },
        data: {
          waitingForHuman: false,
          ...(simultaneous
            ? {
                currentTurnPlayerId: null,
                turnStartedAt: new Date(),
                roundStartedAt: new Date(),
                dayNumber: 1,
              }
            : {
                currentTurnPlayerId: p.id,
                turnStartedAt: new Date(),
              }),
          playerNames: [...(Array.isArray(sess.playerNames) ? (sess.playerNames as string[]) : []), cred.playerName],
        },
      });
    } else {
      await tx.gameSession.update({
        where: { id: session.id },
        data: { playerNames: [...(Array.isArray(sess.playerNames) ? (sess.playerNames as string[]) : []), cred.playerName] },
      });
    }

    return p;
  });

  // Game-specific: post-join hooks (e.g. notify other players, side effects).
  if (adapter.onPlayerJoined) {
    await adapter.onPlayerJoined(session.id, player.id);
  }

  return NextResponse.json({
    ...player,
    game,
    gameSessionId: session.id,
    galaxyName: session.galaxyName,
  }, { status: 201 });
}
