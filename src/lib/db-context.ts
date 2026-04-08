import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

const txStore = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Use inside interactive transactions so `processAction` / `runAndPersistTick` hit the same client as the advisory lock. */
export function getDb(): typeof prisma | Prisma.TransactionClient {
  return txStore.getStore() ?? prisma;
}

/** Run `fn` with `getDb()` guaranteed to return the root `prisma` client (escapes any active transaction context). */
export function runOutsideTransaction<T>(fn: () => T): T {
  return txStore.exit(fn);
}

export class GalaxyBusyError extends Error {
  constructor(message = "Galaxy busy — retry.") {
    super(message);
    this.name = "GalaxyBusyError";
  }
}

/**
 * Detect MySQL/MariaDB lock errors from NOWAIT (MySQL error 3572).
 * Thrown when SELECT ... FOR UPDATE NOWAIT cannot acquire the row lock immediately.
 */
function isMysqlLockError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  // MySQL 3572: "Statement aborted because lock(s) could not be acquired immediately and NOWAIT is set."
  if (msg.includes("lock(s) could not be acquired immediately") || msg.includes("NOWAIT")) return true;
  // mariadb driver exposes errno directly; Prisma may also wrap it in meta
  const err = e as Error & { errno?: number; meta?: { errno?: number } };
  if (err.errno === 3572 || err.meta?.errno === 3572) return true;
  return false;
}

/**
 * Serialize mutating requests per game session with a try-lock (no indefinite wait).
 * Uses SELECT ... FOR UPDATE NOWAIT on a SessionLock row — MySQL equivalent of pg_try_advisory_xact_lock.
 * The lock is transaction-scoped and released automatically on commit or rollback.
 * All DB work in `fn` must go through `getDb()` (not raw `prisma`) so it shares the transaction connection.
 */
export async function withCommitLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      // Ensure lock row exists — INSERT IGNORE handles concurrent creation races safely
      await tx.$executeRaw`
        INSERT IGNORE INTO SessionLock (sessionId, lockedAt) VALUES (${sessionId}, NOW())
      `;
      // Acquire a row-level lock; NOWAIT fails immediately if another transaction holds it
      try {
        await tx.$queryRaw<{ sessionId: string }[]>`
          SELECT sessionId FROM SessionLock WHERE sessionId = ${sessionId} FOR UPDATE NOWAIT
        `;
      } catch (e) {
        if (isMysqlLockError(e)) throw new GalaxyBusyError();
        throw e;
      }
      return txStore.run(tx as Prisma.TransactionClient, fn);
    },
    {
      // Default 5s is too low for door-game actions (economy persist + optional day roll + loan/bond loops).
      // AI batching after day roll is deferred to runDoorGameAITurns outside this transaction.
      timeout: 60_000,
    },
  );
}
