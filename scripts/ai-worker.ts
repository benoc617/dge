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
  MAX_JOB_RETRIES,
} from "../src/lib/ai-job-queue";
import { runOneDoorGameAI } from "../src/lib/door-game-turns";
import { resolveDoorAiRuntimeSettings } from "../src/lib/door-ai-runtime-settings";

const WORKER_ID = crypto.randomUUID();
const POLL_INTERVAL_MS = parseInt(process.env.AI_WORKER_POLL_MS ?? "500", 10);
const STALE_RECOVERY_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(
  jobId: string,
  sessionId: string,
  playerId: string,
  retryCount: number,
): Promise<void> {
  const t0 = Date.now();
  const prefix = `[ai-worker] ${WORKER_ID.slice(0, 8)} job=${jobId.slice(0, 8)} player=${playerId.slice(0, 8)} session=${sessionId.slice(0, 8)}`;

  if (retryCount > 0) {
    console.warn(`${prefix} starting (retry ${retryCount}/${MAX_JOB_RETRIES - 1})`);
  } else {
    console.log(`${prefix} starting`);
  }

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

    console.log(`${prefix} done ms=${ms} cascaded=${enqueued}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ms = Date.now() - t0;
    console.error(`${prefix} failed ms=${ms} err=${msg}`);
    await failJob(jobId, msg);

    // Bug fix: re-enqueue so the AI's daily slot is not silently lost. Without
    // this, a runtime exception (e.g. transient DB error, invalid action path)
    // leaves the player with no pending/claimed job and no mechanism to retry
    // until the next human action or status poll triggers enqueueAiTurnsForSession.
    try {
      const requeued = await enqueueAiTurnsForSession(sessionId);
      if (requeued > 0) {
        console.warn(`${prefix} re-enqueued ${requeued} job(s) after failure`);
      }
    } catch (enqErr) {
      console.error(`${prefix} re-enqueue after failure also failed:`, enqErr);
    }
  }
}

/**
 * One independent worker slot — loops forever, claiming and processing jobs.
 *
 * Each slot is a fully independent async loop. When it finishes a job, it
 * immediately tries to claim the next one (no waiting for other slots).
 * When the queue is empty, it sleeps for POLL_INTERVAL_MS before retrying.
 *
 * This ensures a 45s MCTS job on slot 0 never blocks slots 1-3 from picking
 * up and completing fast Gemini jobs that arrive in the meantime.
 */
async function runSlot(slotId: number): Promise<never> {
  const prefix = `[ai-worker] ${WORKER_ID.slice(0, 8)} slot=${slotId}`;
  while (true) {
    try {
      const job = await claimNextJob(WORKER_ID);
      if (!job) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await processJob(job.id, job.sessionId, job.playerId, job.retryCount);
    } catch (err) {
      console.error(`${prefix} error:`, err);
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function runWorker(): Promise<void> {
  const initialSettings = await resolveDoorAiRuntimeSettings();
  console.log(
    `[ai-worker] starting id=${WORKER_ID} concurrency=${initialSettings.aiWorkerConcurrency} (admin-configurable) poll=${POLL_INTERVAL_MS}ms`,
  );

  // Stale job recovery loop — runs independently of worker slots.
  // Resets claimed-but-never-completed jobs (e.g. from OOM crashes) back to pending.
  // Jobs that have crashed MAX_JOB_RETRIES times are permanently failed to break
  // infinite crash loops, and their sessions are immediately re-enqueued so the
  // AI still gets another chance via a fresh job.
  (async function staleRecoveryLoop() {
    while (true) {
      try {
        const { recovered, permanentlyFailed } = await recoverStaleJobs(STALE_THRESHOLD_MS);
        if (recovered > 0) {
          console.log(`[ai-worker] recovered ${recovered} stale jobs`);
        }
        for (const sessionId of permanentlyFailed) {
          console.error(`[ai-worker] job for session ${sessionId.slice(0, 8)} permanently failed after ${MAX_JOB_RETRIES} retries — re-enqueueing fresh job`);
          try {
            await enqueueAiTurnsForSession(sessionId);
          } catch (enqErr) {
            console.error(`[ai-worker] re-enqueue for permanently failed session ${sessionId.slice(0, 8)} failed:`, enqErr);
          }
        }
      } catch (err) {
        console.error("[ai-worker] stale recovery error:", err);
      }
      await sleep(STALE_RECOVERY_INTERVAL_MS);
    }
  })();

  // Concurrency adjustment loop — periodically reads DB config and spawns/logs slot changes.
  // Initial slots are started here; dynamic scaling (adding slots at runtime) is not yet
  // supported — the worker reads the initial concurrency and launches that many slots.
  const concurrency = initialSettings.aiWorkerConcurrency;
  const slots: Promise<never>[] = [];
  for (let i = 0; i < concurrency; i++) {
    slots.push(runSlot(i));
  }

  // Slots run forever — await to catch fatal errors.
  await Promise.race(slots);
}

runWorker().catch((err) => {
  console.error("[ai-worker] fatal:", err);
  process.exit(1);
});
