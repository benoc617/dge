import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import { GalaxyBusyError } from "@/lib/db-context";
import { canPlayerAct } from "@/lib/door-game-turns";
import { logSrxTiming, msBetween, msElapsed } from "@/lib/srx-timing";
import { invalidatePlayer } from "@/lib/game-state-service";
import "@/lib/srx-registration"; // ensure SRX game is registered before any dispatch

export async function POST(req: NextRequest) {
  const tRoute = performance.now();
  const requestAtMs = Date.now();
  const requestAtIso = new Date().toISOString();
  const { playerName } = await req.json();
  const tAfterJson = performance.now();

  if (!playerName) {
    return NextResponse.json({ error: "playerName required" }, { status: 400 });
  }

  logSrxTiming("tick_request", { requestAtIso, requestAtMs, playerName });

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

  if (player.gameSessionId) {
    const sess = await prisma.gameSession.findUnique({
      where: { id: player.gameSessionId },
      select: { waitingForHuman: true, turnMode: true, actionsPerDay: true, gameType: true },
    });
    const tAfterSess = performance.now();
    sessionLookupMs = msBetween(tAfterPlayer, tAfterSess);

    if (sess?.waitingForHuman) {
      logSrxTiming("tick_denied", {
        requestAtIso, requestAtMs, playerName,
        reason: "waiting_for_human",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
      });
      return NextResponse.json({ error: "Galaxy has not started yet.", waitingForGameStart: true }, { status: 409 });
    }

    const gameType = sess?.gameType ?? "srx";
    const game = requireGame(gameType);

    // -----------------------------------------------------------------------
    // Door-game (simultaneous) tick path
    // -----------------------------------------------------------------------
    if (sess?.turnMode === "simultaneous") {
      // Pre-lock checks (cheap, no lock needed).
      if (!canPlayerAct(player.empire, sess.actionsPerDay)) {
        logSrxTiming("tick_denied", {
          requestAtIso, requestAtMs, playerName,
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
          requestAtIso, requestAtMs, playerName,
          reason: "already_open",
          routeTotalMs: msElapsed(tRoute),
          jsonParseMs: msBetween(tRoute, tAfterJson),
          findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
          sessionLookupMs,
        });
        return NextResponse.json(
          { error: "Turn already open — take actions or end_turn.", alreadyOpen: true },
          { status: 409 },
        );
      }

      const tLock0 = performance.now();
      try {
        const { report, turnOpened } = await game.orchestrator.processDoorTick(
          player.gameSessionId,
          player.id,
        );

        void invalidatePlayer(player.id).catch(() => {});
        const committedAtMs = Date.now();
        const committedAtIso = new Date().toISOString();
        logSrxTiming("tick_route_door", {
          requestAtIso, requestAtMs, committedAtIso, committedAtMs,
          playerName, sessionId: player.gameSessionId,
          routeTotalMs: msElapsed(tRoute),
          jsonParseMs: msBetween(tRoute, tAfterJson),
          findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
          sessionLookupMs,
          lockCallMs: msElapsed(tLock0),
          hasTurnReport: Boolean(report),
        });

        if (turnOpened && !report) {
          return NextResponse.json({ turnReport: null, turnOpened: true });
        }
        if (!report) {
          return NextResponse.json({ alreadyProcessed: true });
        }
        return NextResponse.json({ turnReport: report });
      } catch (err) {
        if (err instanceof GalaxyBusyError) {
          logSrxTiming("tick_galaxy_busy", {
            requestAtIso, requestAtMs, playerName,
            sessionId: player.gameSessionId,
            routeTotalMs: msElapsed(tRoute),
            jsonParseMs: msBetween(tRoute, tAfterJson),
            findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
            sessionLookupMs,
          });
          return NextResponse.json(
            { error: err.message, galaxyBusy: true },
            { status: 409, headers: { "Retry-After": "0" } },
          );
        }
        throw err;
      }
    }

    // -----------------------------------------------------------------------
    // Sequential tick path
    // -----------------------------------------------------------------------
    const tGetTurn0 = performance.now();
    const outcome = await game.orchestrator.processSequentialTick(
      player.gameSessionId,
      player.id,
    );
    const getCurrentTurnMs = msElapsed(tGetTurn0);

    if (outcome.noActiveTurn) {
      logSrxTiming("tick_denied", {
        requestAtIso, requestAtMs, playerName,
        reason: "no_active_turn",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        getCurrentTurnMs,
      });
      return NextResponse.json({ error: "No active turn in this session." }, { status: 409 });
    }
    if (outcome.notYourTurn) {
      logSrxTiming("tick_denied", {
        requestAtIso, requestAtMs, playerName,
        reason: "not_your_turn",
        routeTotalMs: msElapsed(tRoute),
        jsonParseMs: msBetween(tRoute, tAfterJson),
        findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
        sessionLookupMs,
        getCurrentTurnMs,
      });
      return NextResponse.json({
        error: `It's ${outcome.currentPlayerName}'s turn`,
        notYourTurn: true,
      }, { status: 409 });
    }

    void invalidatePlayer(player.id).catch(() => {});
    const committedAtMs = Date.now();
    const committedAtIso = new Date().toISOString();
    logSrxTiming("tick_route_sequential", {
      requestAtIso, requestAtMs, committedAtIso, committedAtMs,
      playerName, sessionId: player.gameSessionId,
      routeTotalMs: msElapsed(tRoute),
      jsonParseMs: msBetween(tRoute, tAfterJson),
      findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
      sessionLookupMs,
      getCurrentTurnMs,
      hasTurnReport: Boolean(outcome.report),
    });

    if (!outcome.report) {
      return NextResponse.json({ alreadyProcessed: true });
    }
    return NextResponse.json({ turnReport: outcome.report });
  }

  // -------------------------------------------------------------------------
  // No-session tick path (legacy / solo play)
  // -------------------------------------------------------------------------
  const game = requireGame("srx");
  const tTick0 = performance.now();
  const report = await game.definition.processFullTick!(player.id);
  const runAndPersistTickMs = msElapsed(tTick0);
  void invalidatePlayer(player.id).catch(() => {});
  const committedAtMs = Date.now();
  const committedAtIso = new Date().toISOString();
  logSrxTiming("tick_route_sequential", {
    requestAtIso, requestAtMs, committedAtIso, committedAtMs,
    playerName, sessionId: null,
    routeTotalMs: msElapsed(tRoute),
    jsonParseMs: msBetween(tRoute, tAfterJson),
    findPlayerMs: msBetween(tAfterJson, tAfterPlayer),
    runAndPersistTickMs,
    hasTurnReport: Boolean(report),
  });

  if (!report) {
    return NextResponse.json({ alreadyProcessed: true });
  }
  return NextResponse.json({ turnReport: report });
}
