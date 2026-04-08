import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import { GalaxyBusyError } from "@/lib/db-context";
import { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";
import { logSrxTiming, msBetween, msElapsed } from "@/lib/srx-timing";
import { invalidatePlayerAndLeaderboard } from "@/lib/game-state-service";
import "@/lib/srx-registration"; // ensure SRX game is registered before any dispatch

export async function POST(req: NextRequest) {
  const tRoute = performance.now();
  const requestAtMs = Date.now();
  const requestAtIso = new Date().toISOString();
  const body = await req.json();
  const tAfterJson = performance.now();
  const { playerName, action, ...params } = body;

  if (!playerName || !action) {
    return NextResponse.json({ error: "playerName and action required" }, { status: 400 });
  }

  logSrxTiming("action_request", { requestAtIso, requestAtMs, playerName, action });

  const player = await prisma.player.findFirst({
    where: { name: playerName, empire: { turnsLeft: { gt: 0 } } },
    orderBy: { createdAt: "desc" },
    include: { empire: true },
  });
  const tAfterPlayer = performance.now();
  if (!player || !player.empire) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  // Legacy path: player has no session — call processFullAction directly (no turn check needed).
  if (!player.gameSessionId) {
    const { definition } = requireGame("srx");
    const result = await definition.processFullAction!(player.id, action, params);
    logSrxTiming("action_route_no_session", {
      requestAtIso, requestAtMs,
      committedAtIso: new Date().toISOString(), committedAtMs: Date.now(),
      playerName, action,
      routeTotalMs: msElapsed(tRoute),
      jsonParseMs: msBetween(tRoute, tAfterJson),
      findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
      success: result.success,
    });
    return NextResponse.json(result);
  }

  const sess = await prisma.gameSession.findUnique({
    where: { id: player.gameSessionId },
    select: { turnMode: true, waitingForHuman: true, gameType: true },
  });
  const tAfterSess = performance.now();
  const sessionLookupMs = msBetween(tAfterPlayer, tAfterSess);

  if (sess?.waitingForHuman) {
    return NextResponse.json({
      success: false,
      error: "Galaxy has not started yet.",
      waitingForGameStart: true,
    }, { status: 409 });
  }

  const gameType = sess?.gameType ?? "srx";
  const game = requireGame(gameType);

  // -------------------------------------------------------------------------
  // Door-game (simultaneous) path
  // -------------------------------------------------------------------------
  if (sess?.turnMode === "simultaneous") {
    const tLock0 = performance.now();
    try {
      const { result, scheduleAiDrain, constraintError } = await game.orchestrator.processDoorAction(
        player.gameSessionId,
        player.id,
        action,
        params,
      );

      const committedAtMs = Date.now();
      const committedAtIso = new Date().toISOString();

      // 409 outcomes from within the lock (canPlayerAct, no open turn, not found)
      if (constraintError) {
        return NextResponse.json(
          { success: false, error: result.message },
          { status: 409 },
        );
      }

      if (result.success) {
        void invalidatePlayerAndLeaderboard(player.id, player.gameSessionId);
        if (scheduleAiDrain) {
          const sid = player.gameSessionId;
          after(() => {
            void enqueueAiTurnsForSession(sid).catch((err) => {
              console.error("[door-game] enqueueAiTurnsForSession after human action", sid, err);
            });
          });
        }
      }

      logSrxTiming("door_action_route", {
        requestAtIso, requestAtMs, committedAtIso, committedAtMs,
        playerName, action, sessionId: player.gameSessionId,
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        lockCallMs: msElapsed(tLock0),
        success: result.success,
      });
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof GalaxyBusyError) {
        logSrxTiming("door_action_galaxy_busy", {
          requestAtIso, requestAtMs, playerName, action,
          sessionId: player.gameSessionId,
          routeTotalMs: msElapsed(tRoute),
          jsonParseMs: msBetween(tRoute, tAfterJson),
          findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
          sessionLookupMs,
        });
        return NextResponse.json(
          { success: false, error: err.message, galaxyBusy: true },
          { status: 409, headers: { "Retry-After": "0" } },
        );
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Sequential path
  // -------------------------------------------------------------------------
  const tSeq0 = performance.now();
  const outcome = await game.orchestrator.processSequentialAction(
    player.gameSessionId,
    player.id,
    action,
    params,
  );
  const tSeq1 = performance.now();

  if (outcome.noActiveTurn) {
    // Re-check waitingForHuman (getCurrentTurn returns null for lobby too).
    const s = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
      select: { waitingForHuman: true },
    });
    if (s?.waitingForHuman) {
      return NextResponse.json({
        success: false,
        error: "Galaxy has not started yet.",
        waitingForGameStart: true,
      }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: "No active turn in this session." }, { status: 409 });
  }

  if (outcome.notYourTurn) {
    return NextResponse.json({
      error: `It's ${outcome.currentPlayerName}'s turn`,
      success: false,
      notYourTurn: true,
      currentTurnPlayer: outcome.currentPlayerName,
    }, { status: 409 });
  }

  let advanceTurnMs = 0;
  if (outcome.result.success && player.gameSessionId) {
    // advanceTurn + runAiSequence already happened inside processSequentialAction.
    advanceTurnMs = msBetween(tSeq0, tSeq1); // total includes advance+ai fire
    void invalidatePlayerAndLeaderboard(player.id, player.gameSessionId);
  } else if (outcome.result.success) {
    void invalidatePlayerAndLeaderboard(player.id, null);
  }

  const committedAtMs = Date.now();
  const committedAtIso = new Date().toISOString();
  logSrxTiming("action_route_sequential", {
    requestAtIso, requestAtMs, committedAtIso, committedAtMs,
    playerName, action, sessionId: player.gameSessionId,
    routeTotalMs: msElapsed(tRoute),
    jsonParseMs: msBetween(tRoute, tAfterJson),
    findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
    sessionLookupMs,
    processActionMs: msBetween(tSeq0, tSeq1),
    advanceTurnMs,
    success: outcome.result.success,
  });

  return NextResponse.json(outcome.result);
}
