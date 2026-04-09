/**
 * MySQL-backed AI turn job queue for door-game (simultaneous) sessions.
 *
 * The web tier enqueues pending rows; the ai-worker process claims and runs them.
 * Concurrent workers use `SELECT … FOR UPDATE SKIP LOCKED` to avoid collisions.
 * All functions are safe to call from the web process — they're fast DB operations.
 */
import { prisma } from "@/lib/prisma";

export interface AiJob {
  id: string;
  sessionId: string;
  playerId: string;
  retryCount: number;
}

/** Jobs with retryCount at or above this threshold are permanently failed by stale recovery. */
export const MAX_JOB_RETRIES = 3;

/**
 * Insert pending AI turn jobs for every AI player in a door-game session that:
 *   1. Still has turnsLeft > 0
 *   2. Has not yet used all daily full turns (fullTurnsUsedThisRound < actionsPerDay)
 *   3. Does not already have a pending or claimed job
 *
 * Returns the number of jobs inserted (0 if all AIs are already queued or idle).
 * Silently returns 0 for non-simultaneous sessions or sessions not yet started.
 */
export async function enqueueAiTurnsForSession(sessionId: string): Promise<number> {
  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    select: { turnMode: true, waitingForHuman: true, actionsPerDay: true },
  });
  if (!session || session.turnMode !== "simultaneous" || session.waitingForHuman) return 0;

  const aiPlayers = await prisma.player.findMany({
    where: {
      gameSessionId: sessionId,
      isAI: true,
      empire: {
        turnsLeft: { gt: 0 },
        fullTurnsUsedThisRound: { lt: session.actionsPerDay },
      },
    },
    select: { id: true },
  });
  if (!aiPlayers.length) return 0;

  const playerIds = aiPlayers.map((p) => p.id);

  // Dedup: skip players that already have a pending/claimed job.
  const existing = await prisma.aiTurnJob.findMany({
    where: { playerId: { in: playerIds }, status: { in: ["pending", "claimed"] } },
    select: { playerId: true },
  });
  const alreadyQueued = new Set(existing.map((j) => j.playerId));

  const toInsert = playerIds.filter((id) => !alreadyQueued.has(id));
  if (!toInsert.length) return 0;

  await prisma.aiTurnJob.createMany({
    data: toInsert.map((playerId) => ({ sessionId, playerId })),
  });
  return toInsert.length;
}

/**
 * Claim the oldest pending job for this worker instance.
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent workers never claim the same row.
 * Returns null when the queue is empty.
 */
export async function claimNextJob(workerId: string): Promise<AiJob | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; sessionId: string; playerId: string; retryCount: number }[]>`
      SELECT id, sessionId, playerId, retryCount FROM AiTurnJob
      WHERE status = 'pending'
      ORDER BY createdAt ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) return null;
    const row = rows[0];
    await tx.aiTurnJob.update({
      where: { id: row.id },
      data: { status: "claimed", claimedBy: workerId, claimedAt: new Date() },
    });
    return { id: row.id, sessionId: row.sessionId, playerId: row.playerId, retryCount: row.retryCount };
  });
}

/** Mark a job as successfully completed and store its result. */
export async function completeJob(id: string, result: Record<string, unknown>): Promise<void> {
  await prisma.aiTurnJob.update({
    where: { id },
    data: { status: "done", completedAt: new Date(), result: result as object },
  });
}

/** Mark a job as failed and record the error message. */
export async function failJob(id: string, error: string): Promise<void> {
  await prisma.aiTurnJob.update({
    where: { id },
    data: { status: "failed", completedAt: new Date(), result: { error } as object },
  });
}

/**
 * Reset stale `claimed` jobs back to `pending` so they can be retried by
 * another worker (handles crashed workers, e.g. OOM during MCTS).
 *
 * Jobs that have already been recovered MAX_JOB_RETRIES times are permanently
 * failed instead of retried — this breaks infinite crash loops (e.g. a game
 * state that consistently OOMs the MCTS search).
 *
 * Returns:
 *   recovered         — number of jobs reset to pending (will be retried)
 *   permanentlyFailed — session IDs whose jobs were permanently failed
 *                       (callers should re-enqueue fresh jobs for these)
 */
export async function recoverStaleJobs(
  staleMs = 5 * 60 * 1000,
): Promise<{ recovered: number; permanentlyFailed: string[] }> {
  const cutoff = new Date(Date.now() - staleMs);

  const staleJobs = await prisma.aiTurnJob.findMany({
    where: { status: "claimed", claimedAt: { lt: cutoff } },
    select: { id: true, sessionId: true, retryCount: true },
  });
  if (!staleJobs.length) return { recovered: 0, permanentlyFailed: [] };

  const toRetry = staleJobs.filter((j) => j.retryCount < MAX_JOB_RETRIES);
  const toFail  = staleJobs.filter((j) => j.retryCount >= MAX_JOB_RETRIES);

  if (toRetry.length) {
    await prisma.aiTurnJob.updateMany({
      where: { id: { in: toRetry.map((j) => j.id) } },
      data: { status: "pending", claimedBy: null, claimedAt: null, retryCount: { increment: 1 } },
    });
  }

  if (toFail.length) {
    await prisma.aiTurnJob.updateMany({
      where: { id: { in: toFail.map((j) => j.id) } },
      data: {
        status: "failed",
        completedAt: new Date(),
        result: { error: `Exceeded ${MAX_JOB_RETRIES} stale-recovery retries — permanently failed` } as object,
      },
    });
  }

  return {
    recovered: toRetry.length,
    permanentlyFailed: [...new Set(toFail.map((j) => j.sessionId))],
  };
}
