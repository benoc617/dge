import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTurn as getSrxCurrentTurn } from "@/lib/turn-order";
import { getCurrentTurn as getEngineTurn } from "@dge/engine/turn-order";
import { tryRollRound, enqueueAiTurnsForSession } from "@/lib/door-game-turns";
import { recoverSequentialAI, SEQUENTIAL_AI_STALE_MS } from "@/lib/ai-runner";
import { getCachedPlayer, invalidatePlayer } from "@/lib/game-state-service";
import { requireGame } from "@dge/engine/registry";
import bcrypt from "bcryptjs";
import "@/lib/game-bootstrap"; // ensure all games are registered

// ---------------------------------------------------------------------------
// Shared player load (used by both GET and POST)
// ---------------------------------------------------------------------------

/** Minimal player shape — empire is loaded by adapter.buildStatus / adapter.isGameOver internally. */
const playerSelect = {
  id: true,
  name: true,
  isAI: true,
  gameSessionId: true,
  passwordHash: true,
  userId: true,
} as const;

type SlimPlayer = {
  id: string;
  name: string;
  isAI: boolean;
  gameSessionId: string | null;
  passwordHash: string | null;
  userId: string | null;
};

function findPlayerByName(name: string): Promise<SlimPlayer | null> {
  return prisma.player.findFirst({
    where: { name, isAI: false },
    orderBy: { createdAt: "desc" },
    select: playerSelect,
  });
}

function findPlayerById(id: string): Promise<SlimPlayer | null> {
  return prisma.player.findUnique({
    where: { id },
    select: playerSelect,
  });
}

// ---------------------------------------------------------------------------
// Game-aware status builder — delegates to the registered adapter
// ---------------------------------------------------------------------------

async function buildStatus(
  playerId: string,
  sessionId: string | null,
): Promise<Record<string, unknown>> {
  // Determine which game this player is in.
  // gameType is in schema but may not appear in generated select types; fetch full row and cast.
  let game = "srx";
  if (sessionId) {
    const sess = await prisma.gameSession.findUnique({
      where: { id: sessionId },
    }) as { gameType?: string | null } | null;
    game = sess?.gameType ?? "srx";
  }

  const { adapter } = requireGame(game);
  const payload = await adapter.buildStatus(playerId);
  // Inject the `game` field at the API surface (DB column is `gameType`).
  return { ...payload, game };
}

// ---------------------------------------------------------------------------
// GET — unauthenticated status refresh (keyed by player ID or name)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const playerName = searchParams.get("player");
  const playerId = searchParams.get("id");

  if (!playerName && !playerId) {
    return NextResponse.json({ error: "player or id param required" }, { status: 400 });
  }

  const player = playerId
    ? await getCachedPlayer(playerId, () => findPlayerById(playerId))
    : await findPlayerByName(playerName!);

  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  const body = await buildStatus(player.id, player.gameSessionId);

  // Simultaneous mode: attempt to roll the round synchronously so this
  // response already reflects the new day (eliminates one stale poll cycle).
  if (body.turnMode === "simultaneous" && player.gameSessionId && body.fullTurnsLeftToday === 0) {
    const rolled = await tryRollRound(player.gameSessionId);
    if (rolled) {
      await invalidatePlayer(player.id);
      const freshPlayer = playerId
        ? await getCachedPlayer(playerId, () => findPlayerById(playerId))
        : await findPlayerByName(playerName!);
      const freshBody = freshPlayer
        ? await buildStatus(freshPlayer.id, freshPlayer.gameSessionId)
        : body;
      after(async () => {
        try { await enqueueAiTurnsForSession(player.gameSessionId!); }
        catch (e) { console.error("[status] after: enqueue error", e); }
      });
      return NextResponse.json(freshBody);
    }
    after(async () => {
      try { await enqueueAiTurnsForSession(player.gameSessionId!); }
      catch (e) { console.error("[status] after: enqueue error", e); }
    });
  }

  // Non-blocking: recover a sequential-mode AI turn abandoned after a restart.
  // Use game-specific turnOrderHooks (includes getActivePlayers) so games like
  // Gin Rummy that override turn routing are handled correctly.
  if (body.turnMode === "sequential" && player.gameSessionId && !body.isYourTurn) {
    const sessionIdForRecovery = player.gameSessionId;
    const gameTypeForRecovery = (body.game as string | undefined) ?? "srx";
    after(async () => {
      try {
        const { orchestrator } = requireGame(gameTypeForRecovery);
        const hooks = orchestrator.turnOrderHooks;
        // Use game-specific hooks when available so getActivePlayers reflects
        // the game's own state (e.g. Gin Rummy reads currentPlayer from log).
        // Fall back to the SRX-flavoured shim for legacy sessions.
        const turn = hooks
          ? await getEngineTurn(sessionIdForRecovery, hooks)
          : await getSrxCurrentTurn(sessionIdForRecovery);
        if (!turn?.isAI) return;
        const ageMs = Date.now() - new Date(turn.turnStartedAt).getTime();
        if (ageMs < SEQUENTIAL_AI_STALE_MS) return;
        await recoverSequentialAI(sessionIdForRecovery, gameTypeForRecovery);
      } catch (e) {
        console.error("[status] after: sequential AI stale-turn recovery error", e);
      }
    });
  }

  return NextResponse.json(body);
}

// ---------------------------------------------------------------------------
// POST — authenticated login (resume game with password)
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const { name, password } = await req.json();

  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const player = await findPlayerByName(name);

  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  // Delegate game-over check to the adapter (SRX: turnsLeft; others: session.status).
  {
    let gameTypeForCheck = "srx";
    if (player.gameSessionId) {
      const sess = await prisma.gameSession.findUnique({
        where: { id: player.gameSessionId },
      }) as { gameType?: string | null } | null;
      gameTypeForCheck = sess?.gameType ?? "srx";
    }
    const { adapter } = requireGame(gameTypeForCheck);
    if (await adapter.isGameOver(player.id)) {
      return NextResponse.json({ error: "This game is over. Start a new game!" }, { status: 410 });
    }
  }

  if (player.passwordHash) {
    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 401 });
    }
    const valid = await bcrypt.compare(password, player.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
    }
  }

  if (player.userId) {
    await prisma.userAccount.update({
      where: { id: player.userId },
      data: { lastLoginAt: new Date() },
    });
  }

  const body = await buildStatus(player.id, player.gameSessionId);
  return NextResponse.json(body);
}
