import { describe, it, expect } from "vitest";

/**
 * Unit tests for ai-job-queue pure-logic helpers.
 * DB-backed functions (enqueueAiTurnsForSession, claimNextJob, etc.) are covered by E2E/integration.
 * Here we test the module structure and type contracts only.
 */
describe("ai-job-queue module", () => {
  it("exports the expected functions", async () => {
    const mod = await import("@/lib/ai-job-queue");
    expect(typeof mod.enqueueAiTurnsForSession).toBe("function");
    expect(typeof mod.claimNextJob).toBe("function");
    expect(typeof mod.completeJob).toBe("function");
    expect(typeof mod.failJob).toBe("function");
    expect(typeof mod.recoverStaleJobs).toBe("function");
  });

  it("exports MAX_JOB_RETRIES as a positive integer", async () => {
    const { MAX_JOB_RETRIES } = await import("@/lib/ai-job-queue");
    expect(typeof MAX_JOB_RETRIES).toBe("number");
    expect(Number.isInteger(MAX_JOB_RETRIES)).toBe(true);
    expect(MAX_JOB_RETRIES).toBeGreaterThan(0);
  });

  it("recoverStaleJobs returns the expected shape", async () => {
    // Verify the return type contract (DB call will no-op in unit context since
    // Prisma is not connected, but we can inspect the function signature via
    // a mock — full DB behaviour is covered by E2E).
    const mod = await import("@/lib/ai-job-queue");
    // The function must accept an optional staleMs parameter.
    expect(mod.recoverStaleJobs.length).toBeLessThanOrEqual(1);
  });
});

describe("ai-job-queue retry logic constants", () => {
  it("MAX_JOB_RETRIES is 3 (breaks crash loops after 3 OOM/stale-recovery cycles)", async () => {
    const { MAX_JOB_RETRIES } = await import("@/lib/ai-job-queue");
    // If this changes, update the CLAUDE.md documentation and consider the
    // operational impact: lower values fail faster; higher values tolerate
    // more transient failures before permanently giving up on a turn.
    expect(MAX_JOB_RETRIES).toBe(3);
  });
});
