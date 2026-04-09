/**
 * Unit tests for @dge/engine door-game lifecycle functions.
 *
 * Tests openFullTurn and closeFullTurn with mock DoorGameHooks.
 * closeFullTurn calls tryRollRound which needs getDb() — we mock the
 * db-context module so no live DB is required.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@dge/engine/db-context", () => ({
  getDb: () => ({
    gameSession: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  }),
  withCommitLock: vi.fn(),
  registerPrismaClient: vi.fn(),
  runOutsideTransaction: vi.fn(),
  SessionBusyError: class extends Error { constructor(m = "") { super(m); } },
  GalaxyBusyError: class extends Error { constructor(m = "") { super(m); } },
}));

import { openFullTurn, closeFullTurn, type DoorGameHooks } from "@dge/engine/door-game";

// ---------------------------------------------------------------------------
// Mock DoorGameHooks factory
// ---------------------------------------------------------------------------

function makeMockHooks(overrides: Partial<DoorGameHooks> = {}): DoorGameHooks {
  return {
    canPlayerAct: vi.fn().mockResolvedValue(true),
    isTurnOpen: vi.fn().mockResolvedValue(false),
    isTickProcessed: vi.fn().mockResolvedValue(false),
    hasTurnsRemaining: vi.fn().mockResolvedValue(true),
    openTurnSlot: vi.fn().mockResolvedValue(undefined),
    closeTurnSlot: vi.fn().mockResolvedValue({ remainingTurns: 10 }),
    forfeitSlots: vi.fn().mockResolvedValue({ remainingTurns: 5 }),
    resetDailySlots: vi.fn().mockResolvedValue(undefined),
    getPlayerSlotUsage: vi.fn().mockResolvedValue([]),
    runTick: vi.fn().mockResolvedValue({ income: 100 }),
    runEndgameTick: vi.fn().mockResolvedValue(undefined),
    logSessionEvent: vi.fn().mockResolvedValue(undefined),
    invalidatePlayer: vi.fn(),
    invalidateLeaderboard: vi.fn(),
    onDayComplete: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// openFullTurn
// ---------------------------------------------------------------------------

describe("openFullTurn", () => {
  it("returns null when hasTurnsRemaining is false (player eliminated)", async () => {
    const hooks = makeMockHooks({ hasTurnsRemaining: vi.fn().mockResolvedValue(false) });
    const result = await openFullTurn("p1", hooks);
    expect(result).toBeNull();
    expect(hooks.runTick).not.toHaveBeenCalled();
    expect(hooks.openTurnSlot).not.toHaveBeenCalled();
  });

  it("returns null when turn slot is already open (idempotent)", async () => {
    const hooks = makeMockHooks({ isTurnOpen: vi.fn().mockResolvedValue(true) });
    const result = await openFullTurn("p1", hooks);
    expect(result).toBeNull();
    expect(hooks.runTick).not.toHaveBeenCalled();
    expect(hooks.openTurnSlot).not.toHaveBeenCalled();
  });

  it("opens slot without running tick when tick already processed", async () => {
    const hooks = makeMockHooks({ isTickProcessed: vi.fn().mockResolvedValue(true) });
    const result = await openFullTurn("p1", hooks);
    expect(result).toBeNull();
    expect(hooks.runTick).not.toHaveBeenCalled();
    expect(hooks.openTurnSlot).toHaveBeenCalledWith("p1");
  });

  it("runs tick then opens slot on fresh turn", async () => {
    const tickReport = { income: 500, expenses: 200 };
    const hooks = makeMockHooks({ runTick: vi.fn().mockResolvedValue(tickReport) });
    const result = await openFullTurn("p1", hooks);
    expect(result).toEqual(tickReport);
    expect(hooks.runTick).toHaveBeenCalledWith("p1");
    expect(hooks.openTurnSlot).toHaveBeenCalledWith("p1");
  });

  it("calls hooks in correct order: hasTurnsRemaining → isTurnOpen → isTickProcessed → runTick → openTurnSlot", async () => {
    const callOrder: string[] = [];
    const hooks = makeMockHooks({
      hasTurnsRemaining: vi.fn().mockImplementation(async () => { callOrder.push("hasTurnsRemaining"); return true; }),
      isTurnOpen: vi.fn().mockImplementation(async () => { callOrder.push("isTurnOpen"); return false; }),
      isTickProcessed: vi.fn().mockImplementation(async () => { callOrder.push("isTickProcessed"); return false; }),
      runTick: vi.fn().mockImplementation(async () => { callOrder.push("runTick"); return {}; }),
      openTurnSlot: vi.fn().mockImplementation(async () => { callOrder.push("openTurnSlot"); }),
    });
    await openFullTurn("p1", hooks);
    expect(callOrder).toEqual(["hasTurnsRemaining", "isTurnOpen", "isTickProcessed", "runTick", "openTurnSlot"]);
  });
});

// ---------------------------------------------------------------------------
// closeFullTurn
// ---------------------------------------------------------------------------

describe("closeFullTurn", () => {
  it("calls closeTurnSlot and invalidatePlayer, skips endgame when turns remain", async () => {
    const hooks = makeMockHooks({ closeTurnSlot: vi.fn().mockResolvedValue({ remainingTurns: 5 }) });
    await closeFullTurn("p1", "sess1", hooks);
    expect(hooks.closeTurnSlot).toHaveBeenCalledWith("p1");
    expect(hooks.runEndgameTick).not.toHaveBeenCalled();
    expect(hooks.invalidatePlayer).toHaveBeenCalledWith("p1");
  });

  it("runs endgame tick when remainingTurns hits 0", async () => {
    const hooks = makeMockHooks({ closeTurnSlot: vi.fn().mockResolvedValue({ remainingTurns: 0 }) });
    await closeFullTurn("p1", "sess1", hooks);
    expect(hooks.closeTurnSlot).toHaveBeenCalledWith("p1");
    expect(hooks.runEndgameTick).toHaveBeenCalledWith("p1", "sess1");
    expect(hooks.invalidatePlayer).toHaveBeenCalledWith("p1");
  });

  it("does not call invalidatePlayer if hook is not provided", async () => {
    const hooks = makeMockHooks({ invalidatePlayer: undefined });
    await closeFullTurn("p1", "sess1", hooks);
    // No error thrown — optional hook is simply not called.
    expect(hooks.closeTurnSlot).toHaveBeenCalled();
  });
});
