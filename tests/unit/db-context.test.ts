import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Unit tests for db-context helpers — specifically withAtomicWrites.
 *
 * withAtomicWrites is designed to:
 *   1. Run fn directly when already inside a withCommitLock transaction
 *      (detected via AsyncLocalStorage; writes share the existing tx).
 *   2. Open a short Prisma $transaction and thread it through AsyncLocalStorage
 *      so all getDb() calls inside fn use the new transaction client.
 *
 * Full integration (actual DB transactions) is covered by E2E tests via the
 * game-engine processAction path. Here we verify the pure-logic contract:
 * the fn is always called and its return value is passed through.
 */
describe("withAtomicWrites", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls fn and returns its result when not in a transaction context", async () => {
    // Register a minimal fake Prisma client so getDb() / withAtomicWrites can run.
    const fakeTx = { empire: {}, army: {}, planet: {}, turnLog: {} };
    const fakePrisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx)),
    };

    const { registerPrismaClient, withAtomicWrites } = await import("@dge/engine/db-context");
    registerPrismaClient(fakePrisma as never);

    const fn = vi.fn(async () => 42);
    const result = await withAtomicWrites(fn);

    expect(fn).toHaveBeenCalledOnce();
    expect(result).toBe(42);
    // $transaction should have been called to provide atomicity.
    expect(fakePrisma.$transaction).toHaveBeenCalledOnce();
  });

  it("propagates exceptions from fn", async () => {
    const fakeTx = {};
    const fakePrisma = {
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeTx)),
    };
    const { registerPrismaClient, withAtomicWrites } = await import("@dge/engine/db-context");
    registerPrismaClient(fakePrisma as never);

    const fn = vi.fn(async () => { throw new Error("inner error"); });
    await expect(withAtomicWrites(fn)).rejects.toThrow("inner error");
  });

  it("exports withAtomicWrites from @/lib/db-context", async () => {
    const mod = await import("@/lib/db-context");
    expect(typeof mod.withAtomicWrites).toBe("function");
  });
});
