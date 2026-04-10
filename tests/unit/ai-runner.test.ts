import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks (must be declared before any imports that use them)
// ---------------------------------------------------------------------------

const { mockUpdateMany } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gameSession: {
      updateMany: mockUpdateMany,
      // findUnique returns null → resolvedType defaults to "srx" in recoverSequentialAI.
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // Other models used by runAISequence hooks — not exercised in these tests
    // because engineRunAISequence is mocked to return [] without calling hooks.
    player: { findUnique: vi.fn().mockResolvedValue(null) },
    gameEvent: { create: vi.fn() },
  },
}));

const { engineRunAISequence } = vi.hoisted(() => ({
  engineRunAISequence: vi.fn().mockResolvedValue([]),
}));

vi.mock("@dge/engine/ai-runner", () => ({
  runAISequence: engineRunAISequence,
}));

vi.mock("@/lib/turn-order", () => ({
  getCurrentTurn: vi.fn(),
  advanceTurn: vi.fn(),
}));

vi.mock("@/lib/game-engine", () => ({
  runAndPersistTick: vi.fn(),
  processAction: vi.fn(),
}));

vi.mock("@/lib/ai-process-move", () => ({
  processAiMoveOrSkip: vi.fn(),
}));

vi.mock("@/lib/gemini", () => ({
  getAIMove: vi.fn(),
  AI_PERSONAS: { economist: "You are an economist AI." },
  computeRivalAttackTargets: vi.fn().mockReturnValue([]),
  shouldLogAiTiming: vi.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

import { recoverSequentialAI, SEQUENTIAL_AI_STALE_MS } from "@/lib/ai-runner";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoverSequentialAI", () => {
  beforeEach(() => {
    mockUpdateMany.mockReset();
    engineRunAISequence.mockReset();
    engineRunAISequence.mockResolvedValue([]);
  });

  it("fires runAISequence when turnStartedAt is stale (count = 1)", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 1 });

    await recoverSequentialAI("session-stale");

    expect(mockUpdateMany).toHaveBeenCalledOnce();
    const { where, data } = mockUpdateMany.mock.calls[0][0] as {
      where: { id: string; turnStartedAt: { lt: Date } };
      data: { turnStartedAt: Date };
    };
    expect(where.id).toBe("session-stale");
    expect(where.turnStartedAt.lt).toBeInstanceOf(Date);
    // cutoff should be approximately SEQUENTIAL_AI_STALE_MS in the past
    const nowMs = Date.now();
    expect(nowMs - where.turnStartedAt.lt.getTime()).toBeCloseTo(SEQUENTIAL_AI_STALE_MS, -3);
    // turnStartedAt is set to a recent timestamp (the "claim" stamp)
    expect(data.turnStartedAt).toBeInstanceOf(Date);
    expect(nowMs - data.turnStartedAt.getTime()).toBeLessThan(1000);

    // Give the void runAISequence one microtask tick to start
    await Promise.resolve();
    expect(engineRunAISequence).toHaveBeenCalledOnce();
  });

  it("does not fire runAISequence when turnStartedAt is fresh (count = 0)", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    await recoverSequentialAI("session-fresh");

    await Promise.resolve();
    expect(engineRunAISequence).not.toHaveBeenCalled();
  });

  it("only fires runAISequence once when called concurrently (second call gets count = 0)", async () => {
    // First call atomically claims recovery; second call sees count=0 because
    // turnStartedAt was already refreshed by the first call's updateMany.
    mockUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // first caller wins
      .mockResolvedValueOnce({ count: 0 }); // second caller: already claimed

    await Promise.all([
      recoverSequentialAI("session-race"),
      recoverSequentialAI("session-race"),
    ]);

    await Promise.resolve();
    expect(engineRunAISequence).toHaveBeenCalledOnce();
  });

  it("uses SEQUENTIAL_AI_STALE_MS as the stale threshold constant", () => {
    expect(SEQUENTIAL_AI_STALE_MS).toBe(90_000);
  });
});
