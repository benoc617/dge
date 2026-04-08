#!/usr/bin/env npx tsx
/**
 * SRX AI Turn Worker
 *
 * Long-running process that polls the AiTurnJob MySQL table and executes AI turns
 * for door-game (simultaneous) sessions. Run alongside the web service — multiple
 * workers can run concurrently; they claim jobs via SELECT … FOR UPDATE SKIP LOCKED
 * and never collide.
 *
 * Each job represents one AI player's full turn in a door-game session:
 *   1. Claim the job atomically (SKIP LOCKED prevents double-claim)
 *   2. Open the full turn, pick an AI move, apply it, close the turn
 *   3. Enqueue follow-up jobs (cascaded needs: new day rolled, other AIs still owe turns)
 *   4. Mark the job done / failed
 *
 * Stale job recovery resets claimed-but-never-completed jobs (crashed workers) back to pending.
 *
 * Environment:
 *   DATABASE_URL          — MySQL connection string (required)
 *   REDIS_URL             — Redis URL (optional; used for cache invalidation)
 *   GEMINI_API_KEY        — Gemini API key (optional; falls back to local heuristic)
 *   AI_WORKER_POLL_MS     — Poll interval when queue is empty (default: 500)
 *   AI_WORKER_CONCURRENCY — Jobs to run in parallel (default: 1, increase for Gemini-only)
 *   SRX_LOG_AI_TIMING     — Set to "1" to emit JSON timing lines to stdout
 */
import "dotenv/config";
import {
  claimNextJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  enqueueAiTurnsForSession,
} from "../src/lib/ai-job-queue";
import { runOneDoorGameAI } from "../src/lib/door-game-turns";

const WORKER_ID = crypto.randomUUID();
const POLL_INTERVAL_MS = parseInt(process.env.AI_WORKER_POLL_MS ?? "500", 10);
const CONCURRENCY = Math.max(1, parseInt(process.env.AI_WORKER_CONCURRENCY ?? "1", 10));
const STALE_RECOVERY_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(jobId: string, sessionId: string, playerId: string): Promise<void> {
  const t0 = Date.now();
  console.log(`[ai-worker] ${WORKER_ID.slice(0, 8)} job=${jobId.slice(0, 8)} player=${playerId.slice(0, 8)} session=${sessionId.slice(0, 8)} starting`);

  try {
    // Run the AI's full turn; scheduleAiDrain:false prevents re-enqueueing inside closeFullTurn.
    // We do the cascading ourselves below.
    await runOneDoorGameAI(playerId, { scheduleAiDrain: false });

    const ms = Date.now() - t0;
    // Mark done BEFORE cascading so the dedup check in enqueueAiTurnsForSession
    // does not see this job as "claimed" and block re-enqueueing the same player.
    await completeJob(jobId, { success: true, ms, cascaded: 0 });

    // Cascade: enqueue jobs for any AIs that still owe turns (new day rolled, or multi-AI session).
    const enqueued = await enqueueAiTurnsForSession(sessionId);

    console.log(`[ai-worker] ${WORKER_ID.slice(0, 8)} job=${jobId.slice(0, 8)} done ms=${ms} cascaded=${enqueued}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - t0;
    console.error(`[ai-worker] ${WORKER_ID.slice(0, 8)} job=${jobId.slice(0, 8)} failed ms=${ms} err=${msg}`);
    await failJob(jobId, msg);
  }
}

/**
 * One worker slot: claim a job (if available) and process it.
 * Returns true if a job was processed, false if queue was empty.
 */
async function tick(workerId: string): Promise<boolean> {
  const job = await claimNextJob(workerId);
  if (!job) return false;
  await processJob(job.id, job.sessionId, job.playerId);
  return true;
}

async function runWorker(): Promise<void> {
  console.log(
    `[ai-worker] starting id=${WORKER_ID} concurrency=${CONCURRENCY} poll=${POLL_INTERVAL_MS}ms`,
  );

  let lastRecovery = 0;

  while (true) {
    try {
      // Stale job recovery (every 30s)
      const now = Date.now();
      if (now - lastRecovery > STALE_RECOVERY_INTERVAL_MS) {
        const recovered = await recoverStaleJobs(STALE_THRESHOLD_MS);
        if (recovered > 0) {
          console.log(`[ai-worker] recovered ${recovered} stale jobs`);
        }
        lastRecovery = now;
      }

      // Run up to CONCURRENCY jobs in parallel
      const slots = Array.from({ length: CONCURRENCY }, () => tick(WORKER_ID));
      const results = await Promise.all(slots);
      const anyWork = results.some(Boolean);

      if (!anyWork) {
        await sleep(POLL_INTERVAL_MS);
      }
      // If work was done, immediately poll again — there may be more jobs.
    } catch (err) {
      console.error("[ai-worker] poll loop error:", err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

runWorker().catch((err) => {
  console.error("[ai-worker] fatal:", err);
  process.exit(1);
});
