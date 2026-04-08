import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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

/** Map session id to a signed bigint for Postgres advisory locks. */
export function hashSessionIdToBigInt(sessionId: string): bigint {
  const buf = createHash("sha256").update(sessionId).digest();
  const n = buf.readBigUInt64BE(0);
  const mask = (BigInt(1) << BigInt(63)) - BigInt(1);
  return n & mask;
}

/**
 * Serialize mutating requests per game session with a try-lock (no indefinite wait).
 * All DB work in `fn` must go through `getDb()` (not raw `prisma`) so it shares the transaction connection.
 */
export async function withCommitLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const key = hashSessionIdToBigInt(sessionId);
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${key}::bigint) AS ok
    `;
      if (!rows[0]?.ok) {
        throw new GalaxyBusyError();
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
