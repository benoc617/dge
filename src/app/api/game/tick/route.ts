import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import { SessionBusyError } from "@/lib/db-context";
import { logSrxTiming, msElapsed } from "@/lib/srx-timing";
import { invalidatePlayer } from "@/lib/game-state-service";
import "@/lib/game-bootstrap"; // ensure all games are registered before any dispatch

export async function POST(req: NextRequest) {
  const tRoute = performance.now();
  const body = await req.json();
  const { playerName, playerId: bodyPlayerId } = body;

  if (!playerName && !bodyPlayerId) {
    return NextResponse.json({ error: "playerName (or playerId) required" }, { status: 400 });
  }

  const player = bodyPlayerId
    ? await prisma.player.findUnique({
        where: { id: bodyPlayerId },
        select: { id: true, name: true, isAI: true, gameSessionId: true },
      })
    : await prisma.player.findFirst({
        where: { name: playerName, isAI: false },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, isAI: true, gameSessionId: true },
      });
  if (!player) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  if (player.gameSessionId) {
    // gameType is in schema but may not appear in generated select types; fetch full row and cast.
    const sess = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
    }) as { waitingForHuman: boolean; turnMode: string; actionsPerDay: number; status: string; gameType?: string | null } | null;

    if (sess?.waitingForHuman) {
      logSrxTiming("tick_denied", { playerName, reason: "waiting_for_human" });
      return NextResponse.json({ error: "Game session has not started yet.", waitingForGameStart: true }, { status: 409 });
    }

    const gameType = sess?.gameType ?? "srx";
    const { adapter, orchestrator } = requireGame(gameType);

    // Delegate game-over check to the adapter (SRX checks turnsLeft; others check session.status).
    if (await adapter.isGameOver(player.id)) {
      return NextResponse.json({ error: "Game over — no more actions." }, { status: 410 });
    }

    // -----------------------------------------------------------------------
    // Door-game (simultaneous) tick path
    // -----------------------------------------------------------------------
    if (sess?.turnMode === "simultaneous") {
      // Ask the adapter for door-game pre-lock guards. Returns null for non-door games.
      const guards = adapter.getDoorGameGuards
        ? await adapter.getDoorGameGuards(player.id, sess.actionsPerDay)
        : null;

      if (guards !== null) {
        if (!guards.canAct) {
          logSrxTiming("tick_denied", { playerName, reason: "no_full_turns_left_today" });
          return NextResponse.json(
            { error: "No full turns left today in this calendar round." },
            { status: 409 },
          );
        }
        if (guards.turnAlreadyOpen) {
          logSrxTiming("tick_denied", { playerName, reason: "already_open" });
          return NextResponse.json(
            { error: "Turn already open — take actions or end_turn.", alreadyOpen: true },
            { status: 409 },
          );
        }
      }

      const tLock0 = performance.now();
      try {
        const { report, turnOpened } = await orchestrator.processDoorTick(
          player.gameSessionId,
          player.id,
        );

        void invalidatePlayer(player.id).catch(() => {});
        logSrxTiming("tick_route_door", {
          playerName, sessionId: player.gameSessionId,
          routeTotalMs: msElapsed(tRoute),
          lockCallMs: msElapsed(tLock0),
        });

        if (turnOpened && !report) {
          return NextResponse.json({ turnReport: null, turnOpened: true });
        }
        if (!report) {
          return NextResponse.json({ alreadyProcessed: true });
        }
        return NextResponse.json({ turnReport: report });
      } catch (err) {
        if (err instanceof SessionBusyError) {
          logSrxTiming("tick_session_busy", { playerName, sessionId: player.gameSessionId });
          return NextResponse.json(
            { error: err.message, sessionBusy: true },
            { status: 409, headers: { "Retry-After": "0" } },
          );
        }
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Sequential tick path
    // -----------------------------------------------------------------------
    const outcome = await orchestrator.processSequentialTick(
      player.gameSessionId,
      player.id,
    );

    if (outcome.noActiveTurn) {
      logSrxTiming("tick_denied", { playerName, reason: "no_active_turn" });
      return NextResponse.json({ error: "No active turn in this session." }, { status: 409 });
    }
    if (outcome.notYourTurn) {
      logSrxTiming("tick_denied", { playerName, reason: "not_your_turn" });
      return NextResponse.json({
        error: `It's ${outcome.currentPlayerName}'s turn`,
        notYourTurn: true,
      }, { status: 409 });
    }

    void invalidatePlayer(player.id).catch(() => {});
    logSrxTiming("tick_route_sequential", {
      playerName, sessionId: player.gameSessionId,
      routeTotalMs: msElapsed(tRoute),
    });

    if (!outcome.report) {
      return NextResponse.json({ alreadyProcessed: true });
    }
    return NextResponse.json({ turnReport: outcome.report });
  }

  // -------------------------------------------------------------------------
  // No-session tick path (legacy / solo play) — SRX only.
  // The SRX adapter's isGameOver reads the empire directly via playerId.
  // -------------------------------------------------------------------------
  const { adapter: srxAdapter, definition: srxDef, orchestrator: _srxOrch } = requireGame("srx");
  if (await srxAdapter.isGameOver(player.id)) {
    return NextResponse.json({ error: "Game over — no turns remaining." }, { status: 410 });
  }
  const report = await srxDef.processFullTick!(player.id);
  void invalidatePlayer(player.id).catch(() => {});
  logSrxTiming("tick_route_sequential", {
    playerName, sessionId: null,
    routeTotalMs: msElapsed(tRoute),
  });

  if (!report) {
    return NextResponse.json({ alreadyProcessed: true });
  }
  return NextResponse.json({ turnReport: report });
}
