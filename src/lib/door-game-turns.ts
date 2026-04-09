/**
 * SRX — door-game turns shim.
 *
 * Implements DoorGameHooks for the SRX game (all empire-specific DB operations)
 * and re-exports engine door-game functions with those hooks pre-injected so
 * that API routes and the ai-worker call the same signatures as before.
 *
 * SRX-specific utilities (canPlayerAct, isStuckDoorTurnAfterSkipEndLog) live
 * here — they were removed from the engine because they reference Empire fields.
 */

import {
  openFullTurn as _openFullTurn,
  closeFullTurn as _closeFullTurn,
  tryRollRound as _tryRollRound,
  isSessionRoundTimedOut,
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
// Pure re-exports from engine (game-agnostic)
// ---------------------------------------------------------------------------

export { isSessionRoundTimedOut } from "@dge/engine/door-game";

// ---------------------------------------------------------------------------
// Re-exported constants from sub-modules
// ---------------------------------------------------------------------------

export {
  DEFAULT_DOOR_AI_MOVE_TIMEOUT_MS as DOOR_AI_MOVE_TIMEOUT_MS,
  DEFAULT_DOOR_AI_DECIDE_BATCH_SIZE as DOOR_AI_DECIDE_BATCH_SIZE,
} from "@/lib/door-ai-runtime-settings";

// ---------------------------------------------------------------------------
// SRX-specific pure utilities (previously in the engine — moved here because
// they reference Empire table field names which are not engine concepts)
// ---------------------------------------------------------------------------

/**
 * Synchronous pre-lock check: can this player act given their empire state?
 * SRX-specific: reads empire.turnsLeft and empire.fullTurnsUsedThisRound.
 * Use this for quick pre-lock route checks and unit tests.
 * Inside the lock the orchestrator delegates to the async DoorGameHooks.canPlayerAct.
 */
export function canPlayerAct(
  empire: { turnsLeft: number; fullTurnsUsedThisRound: number },
  actionsPerDay: number,
): boolean {
  return empire.turnsLeft > 0 && empire.fullTurnsUsedThisRound < actionsPerDay;
}

/**
 * SRX diagnostic: true when the door-game repair path should re-close a
 * stuck turn slot. Happens when skip/end_turn path left turnOpen=true but
 * closeFullTurn never ran (tickProcessed was false at the time).
 */
export function isStuckDoorTurnAfterSkipEndLog(
  turnOpen: boolean,
  lastTurnLogAction: string | null | undefined,
  tickProcessed: boolean | undefined,
): boolean {
  return turnOpen === true && lastTurnLogAction === "end_turn" && tickProcessed === false;
}

// ---------------------------------------------------------------------------
// Door-game processAction option sets
// These are SRX-specific ProcessActionOptions (not FullActionOptions) used
// by the SRX simulation harness and applyDoorGameAIMove below.
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
// SRX DoorGameHooks implementation (reads/writes Empire table)
// ---------------------------------------------------------------------------

function makeSrxHooks(options?: { scheduleAiDrain?: boolean }): DoorGameHooks {
  return {
    async canPlayerAct(playerId, actionsPerDay) {
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnsLeft: true, fullTurnsUsedThisRound: true },
      });
      if (!emp) return false;
      return emp.turnsLeft > 0 && emp.fullTurnsUsedThisRound < actionsPerDay;
    },

    async isTurnOpen(playerId) {
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnOpen: true },
      });
      return emp?.turnOpen ?? false;
    },

    async isTickProcessed(playerId) {
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { tickProcessed: true },
      });
      return emp?.tickProcessed ?? false;
    },

    async hasTurnsRemaining(playerId) {
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnsLeft: true },
      });
      return (emp?.turnsLeft ?? 0) > 0;
    },

    async openTurnSlot(playerId) {
      await getDb().empire.update({
        where: { playerId },
        data: { turnOpen: true },
      });
    },

    async closeTurnSlot(playerId) {
      await getDb().empire.updateMany({
        where: { playerId, turnsLeft: { gt: 0 } },
        data: {
          turnOpen: false,
          tickProcessed: false,
          fullTurnsUsedThisRound: { increment: 1 },
          turnsLeft: { decrement: 1 },
        },
      });
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnsLeft: true },
      });
      return { remainingTurns: emp?.turnsLeft ?? 0 };
    },

    async forfeitSlots(playerId, slotsLeft, _sessionId) {
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnsLeft: true, fullTurnsUsedThisRound: true },
      });
      if (!emp) return { remainingTurns: 0 };
      const actualForfeited = Math.min(slotsLeft, emp.turnsLeft);
      const newTurnsLeft = Math.max(0, emp.turnsLeft - slotsLeft);
      await getDb().empire.update({
        where: { playerId },
        data: {
          fullTurnsUsedThisRound: { increment: slotsLeft },
          turnOpen: false,
          tickProcessed: false,
          turnsLeft: newTurnsLeft,
          turnsPlayed: { increment: actualForfeited },
        },
      });
      return { remainingTurns: newTurnsLeft };
    },

    async resetDailySlots(sessionId) {
      await getDb().empire.updateMany({
        where: { player: { gameSessionId: sessionId } },
        data: {
          fullTurnsUsedThisRound: 0,
          tickProcessed: false,
          turnOpen: false,
        },
      });
    },

    async getPlayerSlotUsage(sessionId) {
      const players = await getDb().player.findMany({
        where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
        include: {
          empire: { select: { fullTurnsUsedThisRound: true, turnsLeft: true } },
        },
      });
      return players.map((p) => ({
        id: p.id,
        slotsUsed: p.empire?.fullTurnsUsedThisRound ?? 0,
        hasRemainingTurns: (p.empire?.turnsLeft ?? 0) > 0,
      }));
    },

    async runTick(playerId) {
      return runAndPersistTick(playerId, { decrementTurnsLeft: false });
    },

    async runEndgameTick(playerId, sessionId) {
      await runEndgameSettlementTick(playerId);
      dumpAndPurgeSessionLogsIfComplete(sessionId);
    },

    async logSessionEvent(sessionId, payload) {
      await getDb().gameEvent.create({
        data: {
          gameSessionId: sessionId,
          type: payload.type,
          message: payload.message,
          details: payload.details as object,
        },
      });
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
// Engine wrappers with SRX hooks injected
// ---------------------------------------------------------------------------

/**
 * Run economy tick for a new full turn and mark the player's turn slot as open.
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
 * When every active player has used all full turns for the round (or the round
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
  // Invalid action → skip path runs processAction(end_turn) but never hits closeFullTurn;
  // without this the player stays turnOpen and the round never advances.
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
 * Ensure tick is open and the turn slot is open so `getAIMoveDecision` is valid.
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

export { withCommitLock, SessionBusyError, GalaxyBusyError } from "@/lib/db-context";
export { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";
