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
}

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
    const rows = await tx.$queryRaw<{ id: string; sessionId: string; playerId: string }[]>`
      SELECT id, sessionId, playerId FROM AiTurnJob
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
    return { id: row.id, sessionId: row.sessionId, playerId: row.playerId };
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
 * Reset `claimed` jobs older than `staleMs` milliseconds back to `pending`
 * so they can be retried by another worker (handles crashed workers).
 * Returns the number of jobs recovered.
 */
export async function recoverStaleJobs(staleMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - staleMs);
  const result = await prisma.aiTurnJob.updateMany({
    where: { status: "claimed", claimedAt: { lt: cutoff } },
    data: { status: "pending", claimedBy: null, claimedAt: null },
  });
  return result.count;
}
