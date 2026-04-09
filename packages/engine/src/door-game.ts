/**
 * @dge/engine — Simultaneous ("door-game") turn management.
 *
 * Game-agnostic orchestration layer: manages round lifecycle (open turn,
 * close turn, roll day, round timeout) without any game-specific DB schema
 * knowledge. All per-player turn state reads/writes are delegated to
 * DoorGameHooks, which games implement using their own data model.
 *
 * SRX stores turn state in the Empire table; a future game could store it
 * in the Player row, a separate PlayerTurnState table, or anywhere else —
 * the engine does not care.
 */

import { getDb } from "./db-context";

// ---------------------------------------------------------------------------
// Hooks (game-specific callbacks injected by the game layer)
// ---------------------------------------------------------------------------

/**
 * Callbacks for door-game lifecycle events.
 *
 * All state reads/writes for per-player turn tracking are here so the engine
 * has zero knowledge of the game's data schema (no empire.turnsLeft, etc.).
 */
export interface DoorGameHooks {
  // -------------------------------------------------------------------------
  // Per-player turn slot state — reads
  // -------------------------------------------------------------------------

  /**
   * True when the player can still act: they have remaining game turns AND
   * haven't used all of their daily full-turn slots.
   */
  canPlayerAct(playerId: string, actionsPerDay: number): Promise<boolean>;

  /**
   * True when the player's current full-turn slot is open (they've started
   * acting but haven't finished yet).
   */
  isTurnOpen(playerId: string): Promise<boolean>;

  /**
   * True when the economy/state tick has already run for this turn window
   * (so re-opening the slot skips the tick).
   */
  isTickProcessed(playerId: string): Promise<boolean>;

  /**
   * True when the player has remaining game turns (not fully eliminated).
   * Used in openFullTurn to guard against zero-turn-left players.
   */
  hasTurnsRemaining(playerId: string): Promise<boolean>;

  // -------------------------------------------------------------------------
  // Per-player turn slot state — writes
  // -------------------------------------------------------------------------

  /** Mark the player's turn slot as open (they are now in a turn window). */
  openTurnSlot(playerId: string): Promise<void>;

  /**
   * Close the player's turn slot: mark it as used and update per-round counts.
   * Returns how many game turns the player has remaining after this close.
   */
  closeTurnSlot(playerId: string): Promise<{ remainingTurns: number }>;

  /**
   * Forfeit `slotsLeft` remaining daily slots for the player (round timeout).
   * Returns how many game turns the player has remaining after forfeiture.
   */
  forfeitSlots(
    playerId: string,
    slotsLeft: number,
    sessionId: string,
  ): Promise<{ remainingTurns: number }>;

  /**
   * Reset daily slot counters for all players in the session (new day begins).
   */
  resetDailySlots(sessionId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Round state — for tryRollRound
  // -------------------------------------------------------------------------

  /**
   * Returns per-player slot usage for the current round, scoped to players
   * who still have game turns remaining.
   *
   * `slotsUsed`        — how many daily full turns this player has completed.
   * `hasRemainingTurns` — whether the player has game turns left.
   */
  getPlayerSlotUsage(
    sessionId: string,
  ): Promise<{ id: string; slotsUsed: number; hasRemainingTurns: boolean }[]>;

  // -------------------------------------------------------------------------
  // Game lifecycle callbacks
  // -------------------------------------------------------------------------

  /**
   * Run the economy/state tick for an opening full-turn window.
   * The hook is responsible for all game-specific tick behavior
   * (e.g. SRX runs an economy pass without decrementing turnsLeft).
   */
  runTick(playerId: string): Promise<unknown>;

  /**
   * Run the final endgame tick when a player's game turns hit zero.
   * Called after closeTurnSlot or forfeitSlots returns remainingTurns === 0.
   */
  runEndgameTick(playerId: string, sessionId: string): Promise<void>;

  /**
   * Persist a session-level event (e.g. round_timeout, day_complete).
   * The engine calls this rather than writing to GameEvent directly.
   */
  logSessionEvent(
    sessionId: string,
    payload: {
      type: string;
      message: string;
      details: Record<string, unknown>;
    },
  ): Promise<void>;

  // -------------------------------------------------------------------------
  // Optional helpers
  // -------------------------------------------------------------------------

  /** Fire-and-forget cache invalidation for a player's state. */
  invalidatePlayer?(playerId: string): void;

  /** Fire-and-forget cache invalidation for the session leaderboard. */
  invalidateLeaderboard?(sessionId: string): void;

  /**
   * Called after a new calendar day begins (day_complete event fired).
   * Use to enqueue AI jobs, evict caches, etc.
   */
  onDayComplete?(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// Pure utilities (no hooks, no DB)
// ---------------------------------------------------------------------------

/**
 * True when `roundStartedAt + turnTimeoutSecs` has passed (door-game round deadline).
 */
export function isSessionRoundTimedOut(
  roundStartedAt: Date | null,
  turnTimeoutSecs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!roundStartedAt) return false;
  return nowMs >= roundStartedAt.getTime() + turnTimeoutSecs * 1000;
}

// ---------------------------------------------------------------------------
// Core door-game lifecycle functions
// ---------------------------------------------------------------------------

/**
 * Run the economy tick for a new full turn and mark the player's slot as open.
 * Returns the tick report (game-specific) or null if not applicable.
 *
 * Returns null when the player has no remaining game turns (already done).
 * Returns null when the slot is already open (idempotent).
 * Returns null when the tick was already processed (sets turnOpen only).
 */
export async function openFullTurn(
  playerId: string,
  hooks: DoorGameHooks,
): Promise<unknown> {
  if (!(await hooks.hasTurnsRemaining(playerId))) return null;
  if (await hooks.isTurnOpen(playerId)) return null;

  if (await hooks.isTickProcessed(playerId)) {
    // Tick already ran for this turn window; just open the slot.
    await hooks.openTurnSlot(playerId);
    return null;
  }

  const report = await hooks.runTick(playerId);
  await hooks.openTurnSlot(playerId);
  return report;
}

/**
 * After `end_turn` processAction: close the full turn, count it for the
 * round, and maybe roll the calendar day.
 */
export async function closeFullTurn(
  playerId: string,
  sessionId: string,
  hooks: DoorGameHooks,
): Promise<void> {
  const { remainingTurns } = await hooks.closeTurnSlot(playerId);
  if (remainingTurns === 0) {
    await hooks.runEndgameTick(playerId, sessionId);
  }
  hooks.invalidatePlayer?.(playerId);
  await tryRollRound(sessionId, hooks);
}

/**
 * When every active player has used all full turns for the round (or the
 * round deadline passed), advance the calendar day.
 *
 * Game turns are consumed per full turn in `closeFullTurn`/`forfeitSlots`,
 * not here.
 *
 * @returns true if a day roll occurred.
 */
export async function tryRollRound(
  sessionId: string,
  hooks: DoorGameHooks,
): Promise<boolean> {
  const session = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    select: {
      turnMode: true,
      waitingForHuman: true,
      actionsPerDay: true,
      dayNumber: true,
      roundStartedAt: true,
      turnTimeoutSecs: true,
    },
  });

  if (!session || session.turnMode !== "simultaneous" || session.waitingForHuman) {
    return false;
  }

  const apd = session.actionsPerDay;

  // Round deadline: forfeit remaining slots for players that haven't finished.
  if (isSessionRoundTimedOut(session.roundStartedAt, session.turnTimeoutSecs)) {
    const usage = await hooks.getPlayerSlotUsage(sessionId);
    let forgivenCount = 0;

    for (const p of usage) {
      if (!p.hasRemainingTurns) continue;
      const slotsLeft = apd - p.slotsUsed;
      if (slotsLeft <= 0) continue;

      const { remainingTurns } = await hooks.forfeitSlots(p.id, slotsLeft, sessionId);
      if (remainingTurns === 0) {
        await hooks.runEndgameTick(p.id, sessionId);
      }
      forgivenCount++;
    }

    if (forgivenCount > 0) {
      await hooks.logSessionEvent(sessionId, {
        type: "round_timeout",
        message: `Calendar day ${session.dayNumber}: round timer — remaining full turns skipped (${forgivenCount} players).`,
        details: { playerCount: forgivenCount, dayNumber: session.dayNumber },
      });
    }
  }

  // Re-fetch slot usage after potential forfeiture.
  const usage2 = await hooks.getPlayerSlotUsage(sessionId);
  const active = usage2.filter((p) => p.hasRemainingTurns);
  if (active.length === 0) return false;

  const allDone = active.every((p) => p.slotsUsed >= apd);
  if (!allDone) return false;

  // All active players done — advance the calendar day.
  await hooks.resetDailySlots(sessionId);

  await getDb().gameSession.update({
    where: { id: sessionId },
    data: {
      dayNumber: session.dayNumber + 1,
      roundStartedAt: new Date(),
    },
  });

  await hooks.logSessionEvent(sessionId, {
    type: "day_complete",
    message: `Calendar day ${session.dayNumber} complete — day ${session.dayNumber + 1} begins.`,
    details: { previousDay: session.dayNumber },
  });

  hooks.invalidateLeaderboard?.(sessionId);
  hooks.onDayComplete?.(sessionId);

  return true;
}
