/**
 * Unit tests for @dge/engine door-game lifecycle functions.
 *
 * Tests openFullTurn and closeFullTurn with mock DoorGameHooks.
 * closeFullTurn calls tryRollRound which needs getDb() — we mock the
 * db-context module so no live DB is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindUnique = vi.fn().mockResolvedValue(null);
const mockUpdate = vi.fn().mockResolvedValue({});

vi.mock("@dge/engine/db-context", () => ({
  getDb: () => ({
    gameSession: {
      findUnique: mockFindUnique,
      update: mockUpdate,
    },
  }),
  withCommitLock: vi.fn(),
  registerPrismaClient: vi.fn(),
  runOutsideTransaction: vi.fn(),
  SessionBusyError: class extends Error { constructor(m = "") { super(m); } },
  GalaxyBusyError: class extends Error { constructor(m = "") { super(m); } },
}));

import { openFullTurn, closeFullTurn, tryRollRound, type DoorGameHooks } from "@dge/engine/door-game";

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

// ---------------------------------------------------------------------------
// tryRollRound
// ---------------------------------------------------------------------------

describe("tryRollRound", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockUpdate.mockReset().mockResolvedValue({});
  });

  it("returns false when session is not simultaneous mode", async () => {
    mockFindUnique.mockResolvedValue({
      turnMode: "sequential",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 1,
      roundStartedAt: new Date(),
      turnTimeoutSecs: 86400,
    });
    const hooks = makeMockHooks();
    expect(await tryRollRound("sess1", hooks)).toBe(false);
  });

  it("returns false when session is null", async () => {
    mockFindUnique.mockResolvedValue(null);
    const hooks = makeMockHooks();
    expect(await tryRollRound("sess1", hooks)).toBe(false);
  });

  it("returns false when waitingForHuman is true (lobby)", async () => {
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: true,
      actionsPerDay: 5,
      dayNumber: 1,
      roundStartedAt: new Date(),
      turnTimeoutSecs: 86400,
    });
    const hooks = makeMockHooks();
    expect(await tryRollRound("sess1", hooks)).toBe(false);
  });

  it("returns false when not all active players have used their daily slots", async () => {
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 1,
      roundStartedAt: new Date(),
      turnTimeoutSecs: 86400,
    });
    const hooks = makeMockHooks({
      getPlayerSlotUsage: vi.fn().mockResolvedValue([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 3, hasRemainingTurns: true },
      ]),
    });
    expect(await tryRollRound("sess1", hooks)).toBe(false);
  });

  it("advances day when all active players have exhausted daily slots", async () => {
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 3,
      roundStartedAt: new Date(Date.now() - 1000),
      turnTimeoutSecs: 86400,
    });
    const hooks = makeMockHooks({
      getPlayerSlotUsage: vi.fn().mockResolvedValue([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 5, hasRemainingTurns: true },
      ]),
    });
    expect(await tryRollRound("sess1", hooks)).toBe(true);
    expect(hooks.resetDailySlots).toHaveBeenCalledWith("sess1");
    expect(hooks.logSessionEvent).toHaveBeenCalledWith("sess1", expect.objectContaining({ type: "day_complete" }));
    expect(hooks.invalidateLeaderboard).toHaveBeenCalledWith("sess1");
    expect(hooks.onDayComplete).toHaveBeenCalledWith("sess1");
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sess1" },
      data: expect.objectContaining({ dayNumber: 4 }),
    }));
  });

  it("forfeits remaining slots on round timeout and increments daily slot counts", async () => {
    const expired = new Date(Date.now() - 100_000);
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 2,
      roundStartedAt: expired,
      turnTimeoutSecs: 60, // 60s timeout, already passed
    });

    const forfeitSlots = vi.fn().mockResolvedValue({ remainingTurns: 3 });

    // First call: before forfeit (p2 only used 2 of 5)
    // Second call: after forfeit (p2 now shows 5)
    const getPlayerSlotUsage = vi.fn()
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 2, hasRemainingTurns: true },
      ])
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 5, hasRemainingTurns: true },
      ]);

    const hooks = makeMockHooks({ forfeitSlots, getPlayerSlotUsage });
    const result = await tryRollRound("sess1", hooks);

    expect(forfeitSlots).toHaveBeenCalledWith("p2", 3, "sess1");
    expect(hooks.runEndgameTick).not.toHaveBeenCalled(); // remainingTurns > 0
    expect(hooks.logSessionEvent).toHaveBeenCalledWith("sess1", expect.objectContaining({ type: "round_timeout" }));
    expect(result).toBe(true); // day rolled
  });

  it("calls runEndgameTick when forfeitSlots returns remainingTurns === 0", async () => {
    const expired = new Date(Date.now() - 100_000);
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 3,
      dayNumber: 10,
      roundStartedAt: expired,
      turnTimeoutSecs: 30,
    });

    const forfeitSlots = vi.fn().mockResolvedValue({ remainingTurns: 0 });
    const getPlayerSlotUsage = vi.fn()
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 3, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 0, hasRemainingTurns: true },
      ])
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 3, hasRemainingTurns: false },
        { id: "p2", slotsUsed: 3, hasRemainingTurns: false },
      ]);

    const hooks = makeMockHooks({ forfeitSlots, getPlayerSlotUsage });
    const result = await tryRollRound("sess1", hooks);

    expect(forfeitSlots).toHaveBeenCalledWith("p2", 3, "sess1");
    expect(hooks.runEndgameTick).toHaveBeenCalledWith("p2", "sess1");
    // After forfeit all players have no remaining turns — no day roll
    expect(result).toBe(false);
  });

  it("skips forfeit for players who already exhausted their daily slots", async () => {
    const expired = new Date(Date.now() - 100_000);
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 1,
      roundStartedAt: expired,
      turnTimeoutSecs: 10,
    });

    const forfeitSlots = vi.fn().mockResolvedValue({ remainingTurns: 8 });
    const getPlayerSlotUsage = vi.fn()
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 5, hasRemainingTurns: true },
      ])
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 5, hasRemainingTurns: true },
        { id: "p2", slotsUsed: 5, hasRemainingTurns: true },
      ]);

    const hooks = makeMockHooks({ forfeitSlots, getPlayerSlotUsage });
    await tryRollRound("sess1", hooks);

    expect(forfeitSlots).not.toHaveBeenCalled();
  });

  it("skips forfeit for players with no remaining game turns", async () => {
    const expired = new Date(Date.now() - 100_000);
    mockFindUnique.mockResolvedValue({
      turnMode: "simultaneous",
      waitingForHuman: false,
      actionsPerDay: 5,
      dayNumber: 1,
      roundStartedAt: expired,
      turnTimeoutSecs: 10,
    });

    const forfeitSlots = vi.fn().mockResolvedValue({ remainingTurns: 0 });
    const getPlayerSlotUsage = vi.fn()
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 3, hasRemainingTurns: false },
      ])
      .mockResolvedValueOnce([
        { id: "p1", slotsUsed: 3, hasRemainingTurns: false },
      ]);

    const hooks = makeMockHooks({ forfeitSlots, getPlayerSlotUsage });
    await tryRollRound("sess1", hooks);

    expect(forfeitSlots).not.toHaveBeenCalled();
  });
});
