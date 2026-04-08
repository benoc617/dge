import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDb } from "@/lib/db-context";
import { processAction, type ActionType } from "@/lib/game-engine";
import { getCurrentTurn, advanceTurn } from "@/lib/turn-order";
import { runAISequence } from "@/lib/ai-runner";
import {
  withCommitLock,
  GalaxyBusyError,
  canPlayerAct,
  openFullTurn,
  closeFullTurn,
  doorGameAutoCloseFullTurnAfterAction,
  enqueueAiTurnsForSession,
} from "@/lib/door-game-turns";
import { logSrxTiming, msBetween, msElapsed } from "@/lib/srx-timing";
import { invalidatePlayerAndLeaderboard } from "@/lib/game-state-service";

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

  logSrxTiming("action_request", {
    requestAtIso,
    requestAtMs,
    playerName,
    action,
  });

  const player = await prisma.player.findFirst({
    where: { name: playerName, empire: { turnsLeft: { gt: 0 } } },
    orderBy: { createdAt: "desc" },
    include: { empire: true },
  });
  const tAfterPlayer = performance.now();
  if (!player || !player.empire) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  if (!player.gameSessionId) {
    const result = await processAction(player.id, action as ActionType, params);
    logSrxTiming("action_route_no_session", {
      requestAtIso,
      requestAtMs,
      committedAtIso: new Date().toISOString(),
      committedAtMs: Date.now(),
      playerName,
      action,
      routeTotalMs: msElapsed(tRoute),
      jsonParseMs: msBetween(tRoute, tAfterJson),
      findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
      success: result.success,
    });
    return NextResponse.json(result);
  }

  const sess = await prisma.gameSession.findUnique({
    where: { id: player.gameSessionId },
    select: { turnMode: true, waitingForHuman: true },
  });
  const tAfterSess = performance.now();
  const sessionLookupMs = msBetween(tAfterPlayer, tAfterSess);

  if (sess?.turnMode === "simultaneous") {
    if (sess.waitingForHuman) {
      return NextResponse.json({
        success: false,
        error: "Galaxy has not started yet.",
        waitingForGameStart: true,
      }, { status: 409 });
    }

    try {
      const tLock0 = performance.now();
      const res = await withCommitLock(player.gameSessionId, async () => {
        const t0 = performance.now();
        const p = await getDb().player.findUnique({
          where: { id: player.id },
          include: { empire: true },
        });
        if (!p?.empire) {
          return NextResponse.json({ error: "Player not found" }, { status: 404 });
        }

        const session = await getDb().gameSession.findUnique({
          where: { id: player.gameSessionId! },
          select: { actionsPerDay: true },
        });
        if (!session) {
          return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }

        const e = p.empire;
        if (!canPlayerAct(e, session.actionsPerDay)) {
          return NextResponse.json(
            { success: false, error: "No full turns remaining today in this calendar round." },
            { status: 409 },
          );
        }

        const tLoadDone = performance.now();
        let openFullTurnMs = 0;
        if (!e.turnOpen) {
          if (action === "end_turn") {
            return NextResponse.json(
              {
                success: false,
                error: "No open turn to end. Open a turn with POST /api/game/tick first (or take an action).",
              },
              { status: 409 },
            );
          }
          const tOpen = performance.now();
          await openFullTurn(p.id);
          openFullTurnMs = msElapsed(tOpen);
        }

        const doorOpts =
          action === "end_turn"
            ? {
                tickOptions: { decrementTurnsLeft: false as const },
                keepTickProcessed: false as const,
                skipEndgameSettlement: true as const,
              }
            : {
                tickOptions: { decrementTurnsLeft: false as const },
                keepTickProcessed: true as const,
                skipEndgameSettlement: true as const,
              };

        const tProc0 = performance.now();
        const result = await processAction(p.id, action as ActionType, params, doorOpts);
        const processActionMs = msElapsed(tProc0);
        const sid = p.gameSessionId;

        let closePathMs = 0;
        if (result.success && action === "end_turn" && sid) {
          const tc = performance.now();
          await closeFullTurn(p.id, sid);
          closePathMs = msElapsed(tc);
          void invalidatePlayerAndLeaderboard(p.id, sid);
          after(() => {
            void enqueueAiTurnsForSession(sid).catch((err) => {
              console.error("[door-game] enqueueAiTurnsForSession after human end_turn", sid, err);
            });
          });
        }

        if (result.success && action !== "end_turn" && sid) {
          const tc = performance.now();
          await doorGameAutoCloseFullTurnAfterAction(p.id, sid);
          closePathMs = msElapsed(tc);
          void invalidatePlayerAndLeaderboard(p.id, sid);
          after(() => {
            void enqueueAiTurnsForSession(sid).catch((err) => {
              console.error("[door-game] enqueueAiTurnsForSession after human action", sid, err);
            });
          });
        }

        const tInnerEnd = performance.now();
        logSrxTiming("door_action", {
          requestAtIso,
          requestAtMs,
          playerName,
          action,
          sessionId: player.gameSessionId,
          loadMs: msBetween(t0, tLoadDone),
          openFullTurnMs,
          processActionMs,
          closePathMs,
          lockInnerMs: msBetween(t0, tInnerEnd),
          lockTotalMs: msElapsed(tLock0),
          success: result.success,
        });

        return NextResponse.json(result);
      });
      const committedAtMs = Date.now();
      const committedAtIso = new Date().toISOString();
      logSrxTiming("door_action_route", {
        requestAtIso,
        requestAtMs,
        committedAtIso,
        committedAtMs,
        playerName,
        action,
        sessionId: player.gameSessionId,
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        preLockMs: msBetween(tRoute, tLock0),
        lockCallMs: msElapsed(tLock0),
      });
      return res;
    } catch (err) {
      if (err instanceof GalaxyBusyError) {
        logSrxTiming("door_action_galaxy_busy", {
          requestAtIso,
          requestAtMs,
          playerName,
          action,
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

  const tGetTurn0 = performance.now();
  const turn = await getCurrentTurn(player.gameSessionId);
  const getCurrentTurnMs = msElapsed(tGetTurn0);
  if (!turn) {
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
    return NextResponse.json({
      success: false,
      error: "No active turn in this session.",
    }, { status: 409 });
  }
  if (turn.currentPlayerId !== player.id) {
    return NextResponse.json({
      error: `It's ${turn.currentPlayerName}'s turn`,
      success: false,
      notYourTurn: true,
      currentTurnPlayer: turn.currentPlayerName,
    }, { status: 409 });
  }

  const tSeq0 = performance.now();
  const result = await processAction(player.id, action as ActionType, params);
  const tSeq1 = performance.now();

  let advanceTurnMs = 0;
  if (result.success && player.gameSessionId) {
    const ta = performance.now();
    await advanceTurn(player.gameSessionId);
    advanceTurnMs = msElapsed(ta);
    runAISequence(player.gameSessionId).catch(() => {});
    void invalidatePlayerAndLeaderboard(player.id, player.gameSessionId);
  } else if (result.success) {
    void invalidatePlayerAndLeaderboard(player.id, null);
  }

  const tSeq2 = performance.now();
  const committedAtMs = Date.now();
  const committedAtIso = new Date().toISOString();
  logSrxTiming("action_sequential", {
    requestAtIso,
    requestAtMs,
    committedAtIso,
    committedAtMs,
    playerName,
    action,
    sessionId: player.gameSessionId,
    processActionMs: msBetween(tSeq0, tSeq1),
    advanceTurnMs,
    routeTotalMs: msBetween(tSeq0, tSeq2),
    success: result.success,
  });
  logSrxTiming("action_route_sequential", {
    requestAtIso,
    requestAtMs,
    committedAtIso,
    committedAtMs,
    playerName,
    action,
    sessionId: player.gameSessionId,
    routeTotalMs: msElapsed(tRoute),
    jsonParseMs: msBetween(tRoute, tAfterJson),
    findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
    sessionLookupMs,
    getCurrentTurnMs,
    processActionMs: msBetween(tSeq0, tSeq1),
    advanceTurnMs,
    success: result.success,
  });

  return NextResponse.json(result);
}
