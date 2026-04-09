import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION } from "@/lib/game-constants";
import { randomBytes } from "crypto";
import { resolvePlayerCredentials } from "@/lib/player-auth";
import { requireGame } from "@dge/engine/registry";
import "@/lib/game-bootstrap"; // ensure all games are registered

function generateInviteCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

function clampMaxPlayers(n: unknown, max: number = SESSION.MAX_PLAYERS_CAP): number {
  const v = typeof n === "number" ? n : parseInt(String(n), 10);
  if (!Number.isFinite(v)) return 50;
  return Math.max(SESSION.MIN_PLAYERS, Math.min(max, v));
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
    game: gameKey,
    galaxyName,
    isPublic,
    turnTimeoutSecs,
    maxPlayers,
    // game-specific options collected from the create form
    ...gameOptions
  } = body as {
    name?: string;
    password?: string;
    game?: string;
    galaxyName?: string | null;
    isPublic?: boolean;
    turnTimeoutSecs?: number;
    maxPlayers?: number;
    [key: string]: unknown;
  };

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!password || typeof password !== "string") {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  // Resolve game — defaults to "srx" for backwards compatibility.
  const resolvedGame = (typeof gameKey === "string" && gameKey) ? gameKey : "srx";
  let gameReg: ReturnType<typeof requireGame>;
  try {
    gameReg = requireGame(resolvedGame);
  } catch {
    return NextResponse.json({ error: `Unknown game: ${resolvedGame}` }, { status: 400 });
  }
  const { adapter, metadata } = gameReg;

  const cred = await resolvePlayerCredentials(name, password);
  if ("error" in cred) {
    return NextResponse.json({ error: cred.error }, { status: cred.status });
  }

  if (galaxyName && typeof galaxyName === "string" && galaxyName.trim().length < 2) {
    return NextResponse.json({ error: "Galaxy name must be at least 2 characters" }, { status: 400 });
  }

  if (galaxyName) {
    const existingGalaxy = await prisma.gameSession.findUnique({
      where: { galaxyName: (galaxyName as string).trim() },
    });
    if (existingGalaxy) {
      return NextResponse.json({ error: "Galaxy name already taken" }, { status: 409 });
    }
  }

  const inviteCode = generateInviteCode();
  const defaultTimeout = adapter.defaultTurnTimeoutSecs ?? 86400;
  const timeout = typeof turnTimeoutSecs === "number" && turnTimeoutSecs > 0 ? turnTimeoutSecs : defaultTimeout;

  // turnMode comes from gameOptions (passed via the create form).
  const turnModeOption = typeof gameOptions.turnMode === "string" ? gameOptions.turnMode : "sequential";
  const simultaneous = turnModeOption === "simultaneous";

  // maxPlayers clamped to the game's declared player range.
  const [, maxAllowed] = metadata.playerRange;
  const cap = clampMaxPlayers(maxPlayers, maxAllowed);

  const now = new Date();

  const session = await prisma.gameSession.create({
    data: {
      gameType: resolvedGame,
      galaxyName: typeof galaxyName === "string" ? galaxyName.trim() || null : null,
      createdBy: cred.playerName,
      isPublic: isPublic !== false,
      inviteCode,
      maxPlayers: cap,
      playerNames: [cred.playerName],
      totalTurns: adapter.defaultTotalTurns,
      turnTimeoutSecs: timeout,
      waitingForHuman: false,
      turnStartedAt: now,
      turnMode: simultaneous ? "simultaneous" : "sequential",
      actionsPerDay: adapter.defaultActionsPerDay,
      dayNumber: 1,
      roundStartedAt: simultaneous ? now : null,
    },
  });

  // Game-specific: player state creation (delegated to adapter).
  const player = await prisma.player.create({
    data: {
      name: cred.playerName,
      passwordHash: cred.passwordHash,
      userId: cred.userId,
      gameSessionId: session.id,
      ...(adapter.getPlayerCreateData() as object),
    },
    include: {
      empire: { include: { planets: true, army: true, supplyRates: true } },
    },
  });

  // Game-specific: post-creation setup (delegated to adapter).
  if (adapter.onSessionCreated) {
    await adapter.onSessionCreated(session.id, player.id, gameOptions as Record<string, unknown>);
  }

  try {
    return NextResponse.json(
      {
        ...player,
        game: resolvedGame,
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
