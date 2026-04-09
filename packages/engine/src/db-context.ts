/**
 * @dge/engine — Transaction context and session advisory locking.
 *
 * Call registerPrismaClient(prisma) once at app startup before using
 * withCommitLock or getDb.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";

// The transaction client (returned inside $transaction callbacks) has the same
// model API as PrismaClient. We store it as unknown and cast to PrismaClient
// on reads — callers inside a lock should never call $transaction / $connect.
const txStore = new AsyncLocalStorage<unknown>();

let _prisma: PrismaClient | null = null;

/** Register the Prisma client instance. Call once at app startup. */
export function registerPrismaClient(client: PrismaClient): void {
  _prisma = client;
}

function getPrisma(): PrismaClient {
  if (!_prisma) throw new Error("[dge] Prisma client not registered. Call registerPrismaClient() at startup.");
  return _prisma;
}

/**
 * Returns the transaction client if inside a withCommitLock callback,
 * otherwise returns the root prisma client.
 * Use this everywhere instead of importing prisma directly so that
 * all DB work within a lock shares the same transaction connection.
 */
/**
 * Returns the transaction client if inside a withCommitLock callback,
 * otherwise returns the root prisma client.
 * Use this everywhere instead of importing prisma directly so that
 * all DB work within a lock shares the same transaction connection.
 *
 * The cast to PrismaClient is safe: the transaction client has the same
 * model operations. Only $transaction/$connect/$disconnect are absent, and
 * callers inside a lock must not nest transactions anyway.
 */
export function getDb(): PrismaClient {
  return (txStore.getStore() ?? getPrisma()) as PrismaClient;
}

/**
 * Run fn with getDb() guaranteed to return the root prisma client,
 * escaping any active transaction context.
 */
export function runOutsideTransaction<T>(fn: () => T): T {
  return txStore.exit(fn);
}

/**
 * Run fn atomically: if already inside a withCommitLock transaction, run fn
 * directly (writes already share that transaction). Otherwise start a short
 * transaction so all writes in fn are committed together or not at all.
 *
 * Use this to protect groups of sequential getDb() writes — e.g. empire update
 * + army update + TurnLog create — from partial-write inconsistency when no
 * advisory session lock is held (sequential-mode AI turns, endgame settlement).
 */
export async function withAtomicWrites<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore() !== undefined) {
    // Already inside a withCommitLock transaction — fn's getDb() calls share it.
    return fn();
  }
  return getPrisma().$transaction(
    async (tx) => txStore.run(tx, fn),
    { timeout: 10_000 },
  );
}

/**
 * Thrown when a session advisory lock cannot be acquired immediately.
 * Routes should return HTTP 409 with `{ sessionBusy: true }` when this is caught.
 * Named `SessionBusyError` — "galaxy" was SRX-specific terminology.
 */
export class SessionBusyError extends Error {
  constructor(message = "Session busy — retry.") {
    super(message);
    this.name = "SessionBusyError";
  }
}

/** @deprecated Use SessionBusyError. Kept for backward-compat during migration. */
export const GalaxyBusyError = SessionBusyError;

/**
 * Detect MySQL/MariaDB lock errors from NOWAIT (MySQL error 3572).
 */
function isMysqlLockError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  if (msg.includes("lock(s) could not be acquired immediately") || msg.includes("NOWAIT")) return true;
  const err = e as Error & { errno?: number; meta?: { errno?: number } };
  if (err.errno === 3572 || err.meta?.errno === 3572) return true;
  return false;
}

/**
 * Serialize mutating requests per game session with a try-lock (no indefinite wait).
 * Uses SELECT ... FOR UPDATE NOWAIT on a SessionLock row.
 * The lock is transaction-scoped and released automatically on commit or rollback.
 * All DB work in fn must go through getDb() to share the transaction connection.
 */
export async function withCommitLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prisma = getPrisma();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        INSERT IGNORE INTO SessionLock (sessionId, lockedAt) VALUES (${sessionId}, NOW())
      `;
      try {
        await tx.$queryRaw<{ sessionId: string }[]>`
          SELECT sessionId FROM SessionLock WHERE sessionId = ${sessionId} FOR UPDATE NOWAIT
        `;
      } catch (e) {
        if (isMysqlLockError(e)) throw new SessionBusyError();
        throw e;
      }
      return txStore.run(tx, fn);
    },
    { timeout: 60_000 },
  );
}
