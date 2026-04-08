import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDb } from "@/lib/db-context";
import { runAndPersistTick } from "@/lib/game-engine";
import { getCurrentTurn } from "@/lib/turn-order";
import {
  withCommitLock,
  GalaxyBusyError,
  canPlayerAct,
  openFullTurn,
  tryRollRound,
} from "@/lib/door-game-turns";
import { logSrxTiming, msBetween, msElapsed } from "@/lib/srx-timing";
import { invalidatePlayer } from "@/lib/game-state-service";

export async function POST(req: NextRequest) {
  const tRoute = performance.now();
  const requestAtMs = Date.now();
  const requestAtIso = new Date().toISOString();
  const { playerName } = await req.json();
  const tAfterJson = performance.now();

  if (!playerName) {
    return NextResponse.json({ error: "playerName required" }, { status: 400 });
  }

  logSrxTiming("tick_request", {
    requestAtIso,
    requestAtMs,
    playerName,
  });

  const player = await prisma.player.findFirst({
    where: { name: playerName, isAI: false, empire: { turnsLeft: { gt: 0 } } },
    orderBy: { createdAt: "desc" },
    include: { empire: true },
  });
  const tAfterPlayer = performance.now();
  if (!player || !player.empire) {
    return NextResponse.json({ error: "Player not found" }, { status: 404 });
  }

  let sessionLookupMs: number | undefined;
  let getCurrentTurnMsForRoute: number | undefined;

  if (player.gameSessionId) {
    const sess = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
      select: {
        waitingForHuman: true,
        turnMode: true,
        actionsPerDay: true,
      },
    });
    const tAfterSess = performance.now();
    sessionLookupMs = msBetween(tAfterPlayer, tAfterSess);
    if (sess?.waitingForHuman) {
      logSrxTiming("tick_denied", {
        requestAtIso,
        requestAtMs,
        playerName,
        reason: "waiting_for_human",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
      });
      return NextResponse.json({
        error: "Galaxy has not started yet.",
        waitingForGameStart: true,
      }, { status: 409 });
    }

    if (sess?.turnMode === "simultaneous") {
      if (!canPlayerAct(player.empire, sess.actionsPerDay)) {
        logSrxTiming("tick_denied", {
          requestAtIso,
          requestAtMs,
          playerName,
          reason: "no_full_turns_left_today",
          routeTotalMs: msElapsed(tRoute),
          jsonParseMs: msBetween(tRoute, tAfterJson),
          findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
          sessionLookupMs,
        });
        return NextResponse.json(
          { error: "No full turns left today in this calendar round." },
          { status: 409 },
        );
      }
      if (player.empire.turnOpen) {
        logSrxTiming("tick_denied", {
          requestAtIso,
          requestAtMs,
          playerName,
          reason: "already_open",
          routeTotalMs: msElapsed(tRoute),
          jsonParseMs: msBetween(tRoute, tAfterJson),
          findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
          sessionLookupMs,
        });
        return NextResponse.json({ error: "Turn already open — take actions or end_turn.", alreadyOpen: true }, { status: 409 });
      }

      const tLock0 = performance.now();
      try {
        const res = await withCommitLock(player.gameSessionId, async () => {
          const t0 = performance.now();
          await tryRollRound(player.gameSessionId!);
          const t1 = performance.now();
          const report = await openFullTurn(player.id);
          const t2 = performance.now();
          const p2 = await getDb().player.findUnique({
            where: { id: player.id },
            include: { empire: true },
          });
          const t3 = performance.now();
          logSrxTiming("door_tick", {
            requestAtIso,
            requestAtMs,
            playerName,
            sessionId: player.gameSessionId,
            tryRollRoundMs: msBetween(t0, t1),
            openFullTurnMs: msBetween(t1, t2),
            reloadPlayerMs: msBetween(t2, t3),
            lockInnerMs: msBetween(t0, t3),
            lockTotalMs: msElapsed(tLock0),
            hasTurnReport: Boolean(report),
          });
          if (p2?.empire?.turnOpen && !report) {
            return NextResponse.json({ turnReport: null, turnOpened: true });
          }
          if (!report) {
            return NextResponse.json({ alreadyProcessed: true });
          }
          return NextResponse.json({ turnReport: report });
        });
        // Evict the player cache so the next status poll sees the updated turnOpen / tickProcessed.
        void invalidatePlayer(player.id).catch(() => {});
        const committedAtMs = Date.now();
        const committedAtIso = new Date().toISOString();
        logSrxTiming("tick_route_door", {
          requestAtIso,
          requestAtMs,
          committedAtIso,
          committedAtMs,
          playerName,
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
          logSrxTiming("tick_galaxy_busy", {
            requestAtIso,
            requestAtMs,
            playerName,
            sessionId: player.gameSessionId,
            routeTotalMs: msElapsed(tRoute),
            jsonParseMs: msBetween(tRoute, tAfterJson),
            findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
            sessionLookupMs,
            preLockMs: msBetween(tRoute, tLock0),
          });
          return NextResponse.json(
            { error: err.message, galaxyBusy: true },
            { status: 409, headers: { "Retry-After": "0" } },
          );
        }
        throw err;
      }
    }

    const tGetTurn0 = performance.now();
    const turn = await getCurrentTurn(player.gameSessionId);
    getCurrentTurnMsForRoute = msElapsed(tGetTurn0);
    if (!turn) {
      logSrxTiming("tick_denied", {
        requestAtIso,
        requestAtMs,
        playerName,
        reason: "no_active_turn",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        getCurrentTurnMs: getCurrentTurnMsForRoute,
      });
      return NextResponse.json({ error: "No active turn in this session." }, { status: 409 });
    }
    if (turn.currentPlayerId !== player.id) {
      logSrxTiming("tick_denied", {
        requestAtIso,
        requestAtMs,
        playerName,
        reason: "not_your_turn",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        getCurrentTurnMs: getCurrentTurnMsForRoute,
      });
      return NextResponse.json({
        error: `It's ${turn.currentPlayerName}'s turn`,
        notYourTurn: true,
      }, { status: 409 });
    }
  }

  const tTick0 = performance.now();
  const turnReport = await runAndPersistTick(player.id);
  const runAndPersistTickMs = msElapsed(tTick0);
  void invalidatePlayer(player.id).catch(() => {});
  const committedAtMs = Date.now();
  const committedAtIso = new Date().toISOString();
  logSrxTiming("tick_sequential", {
    requestAtIso,
    requestAtMs,
    committedAtIso,
    committedAtMs,
    playerName,
    sessionId: player.gameSessionId,
    runAndPersistTickMs,
    hasTurnReport: Boolean(turnReport),
  });
  logSrxTiming("tick_route_sequential", {
    requestAtIso,
    requestAtMs,
    committedAtIso,
    committedAtMs,
    playerName,
    sessionId: player.gameSessionId,
    routeTotalMs: msElapsed(tRoute),
    jsonParseMs: msBetween(tRoute, tAfterJson),
    findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
    sessionLookupMs,
    getCurrentTurnMs: getCurrentTurnMsForRoute,
    runAndPersistTickMs,
    hasTurnReport: Boolean(turnReport),
  });

  if (!turnReport) {
    return NextResponse.json({ alreadyProcessed: true });
  }

  return NextResponse.json({ turnReport });
}
