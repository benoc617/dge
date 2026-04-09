import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentTurn } from "@/lib/turn-order";
import { tryRollRound, enqueueAiTurnsForSession } from "@/lib/door-game-turns";
import { recoverSequentialAI, SEQUENTIAL_AI_STALE_MS } from "@/lib/ai-runner";
import { getCachedPlayer, invalidatePlayer } from "@/lib/game-state-service";
import { requireGame } from "@dge/engine/registry";
import bcrypt from "bcryptjs";
import "@/lib/game-bootstrap"; // ensure all games are registered

// ---------------------------------------------------------------------------
// Shared player load (used by both GET and POST)
// ---------------------------------------------------------------------------

const playerInclude = {
  empire: {
    include: {
      planets: { orderBy: { createdAt: "asc" as const } },
      army: true,
      supplyRates: true,
      research: true,
    },
  },
} as const;

/**
 * Find a human player by name.
 * Empire filter removed — chess players have no empire record.
 * Game-over detection is delegated to the adapter via buildStatus.
 */
function findPlayerByName(name: string) {
  return prisma.player.findFirst({
    where: { name, isAI: false },
    orderBy: { createdAt: "desc" },
    include: playerInclude,
  });
}

function findPlayerById(id: string) {
  return prisma.player.findUnique({
    where: { id },
    include: playerInclude,
  });
}

/** True when the player's game is over (game-agnostic check). */
async function isGameOver(player: { empire: { turnsLeft: number } | null; gameSessionId: string | null }): Promise<boolean> {
  // SRX: turnsLeft exhausted
  if (player.empire && player.empire.turnsLeft <= 0) return true;
  // Any game: session status complete
  if (player.gameSessionId) {
    const sess = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
      select: { status: true },
    });
    if (sess?.status === "complete") return true;
  }
  return false;
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
  if (body.turnMode === "sequential" && player.gameSessionId && !body.isYourTurn) {
    after(async () => {
      try {
        const turn = await getCurrentTurn(player.gameSessionId!);
        if (!turn?.isAI) return;
        const ageMs = Date.now() - new Date(turn.turnStartedAt).getTime();
        if (ageMs < SEQUENTIAL_AI_STALE_MS) return;
        await recoverSequentialAI(player.gameSessionId!);
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

  // Game-over check: SRX uses turnsLeft; any game also checks session.status.
  if (await isGameOver(player)) {
    return NextResponse.json({ error: "This game is over. Start a new game!" }, { status: 410 });
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
