/**
 * SRX — door-game turns shim.
 *
 * Re-exports engine door-game functions, injecting SRX-specific hooks
 * (runAndPersistTick, runEndgameSettlementTick, enqueueAiTurnsForSession,
 * cache invalidation) so that API routes and the ai-worker call the same
 * signatures as before.
 *
 * SRX-specific door-game functions (AI move dispatch, auto-close TurnLog)
 * remain here and call through to engine functions with hooks.
 */

import {
  canPlayerAct,
  openFullTurn as _openFullTurn,
  closeFullTurn as _closeFullTurn,
  tryRollRound as _tryRollRound,
  type DoorGameHooks,
} from "@dge/engine/door-game";

import { getDb } from "@/lib/db-context";
import { runAndPersistTick, processAction, runEndgameSettlementTick, type TurnReport } from "@/lib/game-engine";
import { dumpAndPurgeSessionLogsIfComplete } from "@/lib/session-log-export";
import { invalidatePlayer, invalidateLeaderboard } from "@/lib/game-state-service";
import { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";
import {
  getAIMoveDecision,
  type DoorGameAIMoveDecision,
} from "@/lib/ai-runner";
import { processAiMoveOrSkip } from "@/lib/ai-process-move";
import { resolveDoorAiRuntimeSettings } from "@/lib/door-ai-runtime-settings";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Pure utilities — re-exported directly from engine
// ---------------------------------------------------------------------------

export {
  canPlayerAct,
  isSessionRoundTimedOut,
  isStuckDoorTurnAfterSkipEndLog,
} from "@dge/engine/door-game";

// ---------------------------------------------------------------------------
// Re-exported constants from sub-modules
// ---------------------------------------------------------------------------

export {
  DEFAULT_DOOR_AI_MOVE_TIMEOUT_MS as DOOR_AI_MOVE_TIMEOUT_MS,
  DEFAULT_DOOR_AI_DECIDE_BATCH_SIZE as DOOR_AI_DECIDE_BATCH_SIZE,
} from "@/lib/door-ai-runtime-settings";

// ---------------------------------------------------------------------------
// Door-game processAction option sets (SRX-specific)
// ---------------------------------------------------------------------------

/** Options for `processAction` during a door-game full turn (after tick is persisted). */
export const doorActionOpts = {
  keepTickProcessed: true as const,
  tickOptions: { decrementTurnsLeft: false as const },
  skipEndgameSettlement: true as const,
};

/** Options for door-game `end_turn` that closes the full turn. */
export const doorEndTurnOpts = {
  keepTickProcessed: false as const,
  tickOptions: { decrementTurnsLeft: false as const },
  skipEndgameSettlement: true as const,
};

// ---------------------------------------------------------------------------
// SRX hook factory
// ---------------------------------------------------------------------------

function makeSrxHooks(options?: { scheduleAiDrain?: boolean }): DoorGameHooks {
  return {
    async runTick(playerId, opts) {
      return runAndPersistTick(playerId, opts);
    },
    async runEndgameTick(playerId, sessionId) {
      await runEndgameSettlementTick(playerId);
      dumpAndPurgeSessionLogsIfComplete(sessionId);
    },
    invalidatePlayer(playerId) {
      void invalidatePlayer(playerId);
    },
    invalidateLeaderboard(sessionId) {
      void invalidateLeaderboard(sessionId);
    },
    onDayComplete(sessionId) {
      // Evict stale player caches for all session members so the next status
      // poll immediately sees the new day (resets fullTurnsUsedThisRound → 0).
      void prisma.player
        .findMany({ where: { gameSessionId: sessionId }, select: { id: true } })
        .then((players) => { for (const p of players) void invalidatePlayer(p.id); })
        .catch(() => {});
      if (options?.scheduleAiDrain !== false) {
        void enqueueAiTurnsForSession(sessionId).catch((err) => {
          console.error("[door-game] enqueueAiTurnsForSession after day roll", sessionId, err);
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Engine wrappers with SRX hooks
// ---------------------------------------------------------------------------

/**
 * Run economy tick for a new full turn and mark the empire as mid-turn (`turnOpen`).
 */
export async function openFullTurn(playerId: string): Promise<TurnReport | null> {
  return _openFullTurn(playerId, makeSrxHooks()) as Promise<TurnReport | null>;
}

/**
 * After `end_turn` processAction: close the full turn, count it for the round,
 * decrement `turnsLeft`, maybe roll the calendar day.
 */
export async function closeFullTurn(
  playerId: string,
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<void> {
  return _closeFullTurn(playerId, sessionId, makeSrxHooks(options));
}

/**
 * When every active empire has used all full turns for the round (or the round
 * deadline passed), advance the calendar day.
 *
 * @returns true if a roll occurred
 */
export async function tryRollRound(
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<boolean> {
  return _tryRollRound(sessionId, makeSrxHooks(options));
}

// ---------------------------------------------------------------------------
// SRX-specific door-game functions (not extracted to engine)
// ---------------------------------------------------------------------------

/**
 * After a successful mutating action (not `end_turn`), append an end_turn
 * TurnLog row and close the full turn.
 */
export async function doorGameAutoCloseFullTurnAfterAction(
  playerId: string,
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<void> {
  await getDb().turnLog.create({
    data: {
      playerId,
      action: "end_turn",
      details: {
        actionMsg: "Turn ended.",
        tickReportDeferred: true,
        autoClosedAfterAction: true,
      } as object,
    },
  });
  await closeFullTurn(playerId, sessionId, options);
}

/**
 * Run `getAIMoveDecision` with the same wall-clock cap as the serial path.
 */
export async function decideDoorGameAIMove(
  playerId: string,
  moveTimeoutMs?: number,
): Promise<DoorGameAIMoveDecision> {
  const ms =
    moveTimeoutMs ?? (await resolveDoorAiRuntimeSettings()).doorAiMoveTimeoutMs;
  try {
    return await Promise.race([
      getAIMoveDecision(playerId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
  } catch (err) {
    console.error("[door-game] getAIMoveDecision failed", playerId, err);
    return null;
  }
}

/**
 * Persist the chosen move (or timeout/skip) and close the door-game full turn.
 * Pass `{ scheduleAiDrain: false }` when called from the ai-worker to prevent
 * re-enqueueing (the worker handles cascading itself after each job completes).
 */
export async function applyDoorGameAIMove(
  playerId: string,
  move: DoorGameAIMoveDecision,
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<void> {
  if (!move) {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId, options);
    return;
  }

  if (move.action === "end_turn") {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId, options);
    return;
  }

  const out = await processAiMoveOrSkip(
    playerId,
    move.action,
    move.params,
    {
      llmSource: move.llmSource,
      aiReasoning: "(door game)",
      ...(move.aiTiming
        ? {
            aiTiming: {
              getAIMove: move.aiTiming,
            },
          }
        : {}),
    },
    doorActionOpts,
  );
  // Invalid action → skip path runs processAction(end_turn) but never hit closeFullTurn; without this
  // the empire stays turnOpen with fullTurnsUsed stuck at 0 and the galaxy never advances.
  if (out.skipped && out.finalResult.success) {
    await closeFullTurn(playerId, sessionId, options);
    return;
  }

  if (!out.skipped && out.finalResult.success) {
    await doorGameAutoCloseFullTurnAfterAction(playerId, sessionId, options);
    return;
  }

  // Rare: invalid action and end_turn skip both failed — force close so the round cannot stall.
  if (out.skipped && !out.finalResult.success) {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId, options);
  }
}

/**
 * Ensure tick is open and `turnOpen` is set so `getAIMoveDecision` is valid.
 */
export async function ensureDoorGameFullTurnOpen(playerId: string): Promise<boolean> {
  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: { empire: true, gameSession: true },
  });
  if (!player?.empire || !player.gameSession) return false;
  const apd = player.gameSession.actionsPerDay;
  if (!canPlayerAct(player.empire, apd)) return false;
  if (!player.empire.turnOpen) {
    await openFullTurn(playerId);
  }
  const again = await getDb().player.findUnique({
    where: { id: playerId },
    include: { empire: true, gameSession: true },
  });
  if (!again?.empire?.turnOpen || !canPlayerAct(again.empire, apd)) return false;
  return true;
}

/**
 * Run a single door-game AI turn: open the full turn slot, pick a move, apply it, and close.
 * Exported so the ai-worker process can call this directly after claiming a job.
 */
export async function runOneDoorGameAI(
  playerId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<void> {
  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: { empire: true, gameSession: true },
  });
  if (!player?.empire || !player.gameSessionId || !player.gameSession) return;
  const sessionId = player.gameSessionId;
  const actionsPerDay = player.gameSession.actionsPerDay;

  if (!canPlayerAct(player.empire, actionsPerDay)) return;

  if (!player.empire.turnOpen) {
    await openFullTurn(playerId);
  }

  const rt = await resolveDoorAiRuntimeSettings();
  const move = await decideDoorGameAIMove(playerId, rt.doorAiMoveTimeoutMs);
  await applyDoorGameAIMove(playerId, move, sessionId, options);
}

export { withCommitLock, GalaxyBusyError } from "@/lib/db-context";
export { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";
