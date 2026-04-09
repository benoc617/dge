/**
 * Re-exports from @dge/engine/db-context.
 * Also registers the SRX prisma client with the engine on import.
 */
import { prisma } from "./prisma";
import {
  registerPrismaClient,
  getDb,
  runOutsideTransaction,
  withCommitLock,
  SessionBusyError,
  GalaxyBusyError,
} from "@dge/engine/db-context";

// Register once — safe to call multiple times (idempotent after first call).
registerPrismaClient(prisma as Parameters<typeof registerPrismaClient>[0]);

export { getDb, runOutsideTransaction, withCommitLock, SessionBusyError, GalaxyBusyError };
