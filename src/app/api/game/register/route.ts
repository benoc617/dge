import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ACTIONS_PER_DAY, START } from "@/lib/game-constants";
import { randomBytes } from "crypto";
import { clampMaxPlayers } from "@/lib/auth";
import { resolvePlayerCredentials } from "@/lib/player-auth";
import { createStarterPlanets, createStarterEmpire } from "@/lib/player-init";

function generateInviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

async function handleRegisterPost(req: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    name,
    password,
    galaxyName,
    isPublic,
    turnTimeoutSecs,
    maxPlayers,
    turnMode,
  } = body as {
    name?: string;
    password?: string;
    galaxyName?: string | null;
    isPublic?: boolean;
    turnTimeoutSecs?: number;
    maxPlayers?: number;
    turnMode?: string;
  };

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

  if (galaxyName && galaxyName.trim().length < 2) {
    return NextResponse.json({ error: "Galaxy name must be at least 2 characters" }, { status: 400 });
  }

  if (galaxyName) {
    const existingGalaxy = await prisma.gameSession.findUnique({
      where: { galaxyName: galaxyName.trim() },
    });
    if (existingGalaxy) {
      return NextResponse.json({ error: "Galaxy name already taken" }, { status: 409 });
    }
  }

  const inviteCode = generateInviteCode();
  const timeout = typeof turnTimeoutSecs === "number" && turnTimeoutSecs > 0 ? turnTimeoutSecs : 86400;
  const cap = clampMaxPlayers(maxPlayers);

  const now = new Date();
  const simultaneous = turnMode === "simultaneous";
  const session = await prisma.gameSession.create({
    data: {
      galaxyName: galaxyName?.trim() || null,
      createdBy: cred.playerName,
      isPublic: isPublic !== false,
      inviteCode,
      maxPlayers: cap,
      playerNames: [cred.playerName],
      totalTurns: START.TURNS,
      turnTimeoutSecs: timeout,
      waitingForHuman: false,
      turnStartedAt: now,
      turnMode: simultaneous ? "simultaneous" : "sequential",
      actionsPerDay: ACTIONS_PER_DAY,
      dayNumber: 1,
      roundStartedAt: simultaneous ? now : null,
    },
  });

  const player = await prisma.player.create({
    data: {
      name: cred.playerName,
      passwordHash: cred.passwordHash,
      userId: cred.userId,
      gameSessionId: session.id,
      empire: { create: createStarterEmpire(createStarterPlanets()) },
    },
    include: {
      empire: { include: { planets: true, army: true, supplyRates: true } },
    },
  });

  await prisma.gameSession.update({
    where: { id: session.id },
    data: simultaneous ? { currentTurnPlayerId: null } : { currentTurnPlayerId: player.id },
  });

  const marketCount = await prisma.market.count();
  if (marketCount === 0) {
    await prisma.market.create({ data: {} });
  }

  try {
    return NextResponse.json(
      {
        ...player,
        gameSessionId: session.id,
        inviteCode: session.inviteCode,
        galaxyName: session.galaxyName,
        isPublic: session.isPublic,
        maxPlayers: session.maxPlayers,
      },
      { status: 201 },
    );
  } catch (serializeErr) {
    console.error("[register] JSON response serialization failed:", serializeErr);
    return NextResponse.json(
      { error: "Could not build registration response (server bug)." },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    return await handleRegisterPost(req);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[register]", e);
    return NextResponse.json(
      {
        error:
          process.env.NODE_ENV === "development"
            ? `Registration failed: ${message}`
            : "Registration failed (server error). Check server logs and run prisma db push.",
      },
      { status: 500 },
    );
  }
}
