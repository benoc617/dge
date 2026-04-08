import { getDb, runOutsideTransaction } from "@/lib/db-context";
import { runAndPersistTick, processAction, runEndgameSettlementTick, type TurnReport } from "@/lib/game-engine";
import {
  getAIMoveDecision,
  type DoorGameAIMoveDecision,
} from "@/lib/ai-runner";
import { processAiMoveOrSkip } from "@/lib/ai-process-move";
import { shouldLogAiTiming } from "@/lib/gemini";
import { resolveDoorAiRuntimeSettings } from "@/lib/door-ai-runtime-settings";

/** Default door-game AI caps when no DB row (matches prior constants; configurable via admin / env). */
export {
  DEFAULT_DOOR_AI_MOVE_TIMEOUT_MS as DOOR_AI_MOVE_TIMEOUT_MS,
  DEFAULT_DOOR_AI_DECIDE_BATCH_SIZE as DOOR_AI_DECIDE_BATCH_SIZE,
} from "@/lib/door-ai-runtime-settings";

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

export function canPlayerAct(
  empire: { turnsLeft: number; fullTurnsUsedThisRound: number },
  actionsPerDay: number,
): boolean {
  return empire.turnsLeft > 0 && empire.fullTurnsUsedThisRound < actionsPerDay;
}

/** True when `roundStartedAt + turnTimeoutSecs` has passed (door-game round deadline). */
export function isSessionRoundTimedOut(
  roundStartedAt: Date | null,
  turnTimeoutSecs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!roundStartedAt) return false;
  return nowMs >= roundStartedAt.getTime() + turnTimeoutSecs * 1000;
}

/**
 * True when the skip-path bug left an empire with turnOpen set, the last logged action was end_turn,
 * and closeFullTurn never ran (tick still "unprocessed" for the open slot).
 *
 * **Not** stuck: after a normal close, `POST /tick` opens the next full turn (`turnOpen` true,
 * `tickProcessed` true) but the newest TurnLog row may still be the previous full turn's `end_turn`
 * until the player acts — that is valid; do not repair.
 */
export function isStuckDoorTurnAfterSkipEndLog(
  turnOpen: boolean,
  lastTurnLogAction: string | null | undefined,
  tickProcessed: boolean | undefined,
): boolean {
  return turnOpen === true && lastTurnLogAction === "end_turn" && tickProcessed === false;
}

/**
 * Run economy tick for a new full turn and mark the empire as mid-turn (`turnOpen`).
 */
export async function openFullTurn(playerId: string): Promise<TurnReport | null> {
  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: { empire: true },
  });
  if (!player?.empire || player.empire.turnsLeft < 1) return null;
  if (player.empire.turnOpen) {
    return null;
  }

  if (player.empire.tickProcessed) {
    await getDb().empire.update({
      where: { id: player.empire.id },
      data: { turnOpen: true },
    });
    return null;
  }

  const report = await runAndPersistTick(playerId, { decrementTurnsLeft: false });
  if (!report) return null;

  await getDb().empire.update({
    where: { id: player.empire.id },
    data: { turnOpen: true },
  });

  return report;
}

/**
 * After `end_turn` processAction: close the full turn, count it for the round, decrement `turnsLeft`
 * (one game turn per full turn / miniturn), maybe roll the calendar day.
 */
export async function closeFullTurn(
  playerId: string,
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<void> {
  try {
    const result = await getDb().empire.updateMany({
      where: { playerId, turnsLeft: { gt: 0 } },
      data: {
        turnOpen: false,
        tickProcessed: false,
        fullTurnsUsedThisRound: { increment: 1 },
        turnsLeft: { decrement: 1 },
      },
    });
    if (result.count === 0) {
      throw new Error(`closeFullTurn: no empire updated for playerId=${playerId} (missing or turnsLeft<=0)`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`closeFullTurn: failed to update empire for playerId=${playerId}: ${msg}`);
  }

  const empAfter = await getDb().empire.findUnique({
    where: { playerId },
    select: { turnsLeft: true },
  });
  if (empAfter?.turnsLeft === 0) {
    await runEndgameSettlementTick(playerId);
  }

  await tryRollRound(sessionId, options);
}

/**
 * After a successful mutating action (not `end_turn`), append the same TurnLog row `end_turn` would
 * and close the full turn — matches core SRE rule of one economy action per full turn without
 * requiring a separate Skip / end_turn request.
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
 * When every active empire has used all full turns for the round (or the round deadline passed),
 * advance the calendar day. `turnsLeft` is consumed per full turn in `closeFullTurn`, not here.
 * Round deadline: `roundStartedAt` + `turnTimeoutSecs` (default 24h) — remaining daily slots are
 * skipped (forfeit) for everyone still short; each forfeited slot also consumes one `turnsLeft`
 * (same as if the player had closed that full turn).
 * @param options.scheduleAiDrain — set `false` for headless session sims (default `true` matches HTTP routes).
 * @returns true if a roll occurred
 */
export async function tryRollRound(
  sessionId: string,
  options?: { scheduleAiDrain?: boolean },
): Promise<boolean> {
  const session = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    include: {
      players: {
        where: { empire: { turnsLeft: { gt: 0 } } },
        include: { empire: true },
      },
    },
  });

  if (!session || session.turnMode !== "simultaneous" || session.waitingForHuman) {
    return false;
  }

  const apd = session.actionsPerDay;

  if (isSessionRoundTimedOut(session.roundStartedAt, session.turnTimeoutSecs)) {
    const db = getDb();
    const stuck = await db.empire.findMany({
      where: {
        player: { gameSessionId: sessionId },
        turnsLeft: { gt: 0 },
        fullTurnsUsedThisRound: { lt: apd },
      },
      select: { id: true, playerId: true, fullTurnsUsedThisRound: true, turnsLeft: true },
    });
    let forgivenCount = 0;
    for (const emp of stuck) {
      const used = emp.fullTurnsUsedThisRound ?? 0;
      const slotsLeft = apd - used;
      if (slotsLeft <= 0) continue;
      const newTurnsLeft = Math.max(0, emp.turnsLeft - slotsLeft);
      await db.empire.update({
        where: { id: emp.id },
        data: {
          fullTurnsUsedThisRound: apd,
          turnOpen: false,
          tickProcessed: false,
          turnsLeft: newTurnsLeft,
        },
      });
      if (newTurnsLeft === 0) {
        await runEndgameSettlementTick(emp.playerId);
      }
      forgivenCount++;
    }
    if (forgivenCount > 0) {
      await db.gameEvent.create({
        data: {
          gameSessionId: sessionId,
          type: "round_timeout",
          message: `Calendar day ${session.dayNumber}: round timer — remaining full turns skipped (${forgivenCount} empires).`,
          details: { empireCount: forgivenCount, dayNumber: session.dayNumber } as object,
        },
      });
    }
  }

  const session2 = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    include: {
      players: {
        where: { empire: { turnsLeft: { gt: 0 } } },
        include: { empire: true },
      },
    },
  });
  if (!session2) return false;

  const active = session2.players.filter(
    (p: (typeof session2.players)[number]) => p.empire,
  );
  if (active.length === 0) return false;

  const allDone = active.every(
    (p: (typeof active)[number]) =>
      (p.empire!.fullTurnsUsedThisRound ?? 0) >= session2.actionsPerDay,
  );

  if (!allDone) {
    return false;
  }

  const db = getDb();
  await db.empire.updateMany({
    where: { player: { gameSessionId: sessionId } },
    data: {
      fullTurnsUsedThisRound: 0,
      tickProcessed: false,
      turnOpen: false,
    },
  });

  await db.gameSession.update({
    where: { id: sessionId },
    data: {
      dayNumber: session2.dayNumber + 1,
      roundStartedAt: new Date(),
    },
  });

  await db.gameEvent.create({
    data: {
      gameSessionId: sessionId,
      type: "day_complete",
      message: `Calendar day ${session2.dayNumber} complete — day ${session2.dayNumber + 1} begins.`,
      details: { previousDay: session2.dayNumber } as object,
    },
  });

  // New calendar day: kick AI drain without awaiting — must NOT run inside withCommitLock’s
  // interactive transaction (Prisma default 5s timeout; AI/Gemini can exceed it and return 500 P2028).
  // runDoorGameAITurns serializes via doorAiInFlight; route after() also schedules it after human actions.
  if (options?.scheduleAiDrain !== false) {
    void runDoorGameAITurns(sessionId).catch((err) => {
      console.error("[door-game] runDoorGameAITurns after day roll", sessionId, err);
    });
  }

  return true;
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
 */
export async function applyDoorGameAIMove(
  playerId: string,
  move: DoorGameAIMoveDecision,
  sessionId: string,
): Promise<void> {
  if (!move) {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId);
    return;
  }

  if (move.action === "end_turn") {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId);
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
    await closeFullTurn(playerId, sessionId);
    return;
  }

  if (!out.skipped && out.finalResult.success) {
    await doorGameAutoCloseFullTurnAfterAction(playerId, sessionId);
    return;
  }

  // Rare: invalid action and end_turn skip both failed — force close so the round cannot stall.
  if (out.skipped && !out.finalResult.success) {
    await processAction(playerId, "end_turn", undefined, doorEndTurnOpts);
    await closeFullTurn(playerId, sessionId);
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

async function runOneDoorGameAI(playerId: string): Promise<void> {
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

  const move = await decideDoorGameAIMove(playerId);
  await applyDoorGameAIMove(playerId, move, sessionId);
}

/** Serialize concurrent runs per session (status kick + action `after()` may overlap). */
const doorAiInFlight = new Map<string, Promise<void>>();

/**
 * Run AI empires until none owe daily full turns (or guard limit). Used after a human acts and
 * after calendar day rollover (batch at new day). When called from `tryRollRound`, does not use
 * `doorAiInFlight` (see `runDoorGameAITurns`).
 */
async function drainDoorGameAiTurns(sessionId: string): Promise<void> {
  const session = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    select: { turnMode: true, waitingForHuman: true, actionsPerDay: true },
  });
  if (!session || session.turnMode !== "simultaneous" || session.waitingForHuman) return;

  let guard = 0;
  while (guard++ < 500) {
    await tryRollRound(sessionId);

    const rt = await resolveDoorAiRuntimeSettings();
    const { doorAiDecideBatchSize, doorAiMoveTimeoutMs } = rt;

    const batch = await getDb().player.findMany({
      where: {
        gameSessionId: sessionId,
        isAI: true,
        empire: {
          turnsLeft: { gt: 0 },
          fullTurnsUsedThisRound: { lt: session.actionsPerDay },
        },
      },
      orderBy: [
        { empire: { fullTurnsUsedThisRound: "asc" } },
        { turnOrder: "asc" },
      ],
      take: doorAiDecideBatchSize,
      include: { empire: true },
    });

    if (batch.length === 0) break;

    const ready: string[] = [];
    for (const p of batch) {
      const ok = await ensureDoorGameFullTurnOpen(p.id);
      if (ok) ready.push(p.id);
    }

    if (ready.length === 0) {
      await runOneDoorGameAI(batch[0].id);
      continue;
    }

    const tDecide0 = performance.now();
    const decisions = await Promise.all(
      ready.map((id) => decideDoorGameAIMove(id, doorAiMoveTimeoutMs)),
    );
    const parallelDecideMs = performance.now() - tDecide0;

    const tApply0 = performance.now();
    for (let i = 0; i < ready.length; i++) {
      await applyDoorGameAIMove(ready[i], decisions[i], sessionId);
    }
    const serialApplyMs = performance.now() - tApply0;

    if (shouldLogAiTiming()) {
      console.info(
        "[door-game]",
        JSON.stringify({
          event: "doorWave",
          sessionId,
          batchSize: ready.length,
          parallelDecideMs: Math.round(parallelDecideMs),
          serialApplyMs: Math.round(serialApplyMs),
        }),
      );
    }
  }
}

/**
 * After a human closes a full turn, advance AI empires that still have daily turns remaining.
 * Call from `after()` so Next.js does not drop the work when the HTTP handler returns.
 *
 * Uses `runOutsideTransaction` so `getDb()` returns the root Prisma client — `after()` callbacks
 * inherit the parent's `AsyncLocalStorage` context, which may still hold a committed (dead)
 * interactive-transaction client from `withCommitLock`.
 */
export async function runDoorGameAITurns(sessionId: string): Promise<void> {
  const existing = doorAiInFlight.get(sessionId);
  if (existing) return existing;

  const p = runOutsideTransaction(() => drainDoorGameAiTurns(sessionId)).finally(() => {
    doorAiInFlight.delete(sessionId);
  });
  doorAiInFlight.set(sessionId, p);
  return p;
}

export { withCommitLock, GalaxyBusyError, hashSessionIdToBigInt } from "@/lib/db-context";
