import { describe, it, expect, vi, beforeEach } from "vitest";

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
});
