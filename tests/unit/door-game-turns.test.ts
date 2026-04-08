import { describe, it, expect } from "vitest";
import {
  canPlayerAct,
  isStuckDoorTurnAfterSkipEndLog,
  isSessionRoundTimedOut,
  DOOR_AI_MOVE_TIMEOUT_MS,
  DOOR_AI_DECIDE_BATCH_SIZE,
} from "@/lib/door-game-turns";

describe("DOOR_AI_MOVE_TIMEOUT_MS", () => {
  it("matches door-game AI decide race cap (60s)", () => {
    expect(DOOR_AI_MOVE_TIMEOUT_MS).toBe(60_000);
  });
});

describe("DOOR_AI_DECIDE_BATCH_SIZE", () => {
  it("is the fixed parallel-decide wave size", () => {
    expect(DOOR_AI_DECIDE_BATCH_SIZE).toBe(4);
  });
});

describe("canPlayerAct", () => {
  it("is true when turns remain and daily full turns not exhausted", () => {
    expect(canPlayerAct({ turnsLeft: 10, fullTurnsUsedThisRound: 0 }, 5)).toBe(true);
    expect(canPlayerAct({ turnsLeft: 10, fullTurnsUsedThisRound: 4 }, 5)).toBe(true);
  });

  it("is false when no game turns left", () => {
    expect(canPlayerAct({ turnsLeft: 0, fullTurnsUsedThisRound: 0 }, 5)).toBe(false);
  });

  it("is false when daily full turns are exhausted", () => {
    expect(canPlayerAct({ turnsLeft: 10, fullTurnsUsedThisRound: 5 }, 5)).toBe(false);
  });
});

describe("isStuckDoorTurnAfterSkipEndLog", () => {
  it("is true when turn open, last log end_turn, and tickProcessed false (closeFullTurn never ran)", () => {
    expect(isStuckDoorTurnAfterSkipEndLog(true, "end_turn", false)).toBe(true);
  });

  it("is false when tickProcessed true (normal new full turn after /tick; last log may still be prior end_turn)", () => {
    expect(isStuckDoorTurnAfterSkipEndLog(true, "end_turn", true)).toBe(false);
  });

  it("is false when tickProcessed undefined (conservative — do not treat as stuck)", () => {
    expect(isStuckDoorTurnAfterSkipEndLog(true, "end_turn", undefined)).toBe(false);
  });

  it("is false when turn closed or last action was not end_turn", () => {
    expect(isStuckDoorTurnAfterSkipEndLog(false, "end_turn", false)).toBe(false);
    expect(isStuckDoorTurnAfterSkipEndLog(true, "buy_planet", false)).toBe(false);
    expect(isStuckDoorTurnAfterSkipEndLog(true, undefined, false)).toBe(false);
  });
});

describe("isSessionRoundTimedOut", () => {
  it("is false when roundStartedAt is null", () => {
    expect(isSessionRoundTimedOut(null, 86400, 1_000_000)).toBe(false);
  });

  it("is false before roundStartedAt + turnTimeoutSecs", () => {
    const t0 = new Date("2026-01-01T12:00:00.000Z");
    expect(isSessionRoundTimedOut(t0, 3600, t0.getTime() + 3599_000)).toBe(false);
  });

  it("is true at or after roundStartedAt + turnTimeoutSecs", () => {
    const t0 = new Date("2026-01-01T12:00:00.000Z");
    expect(isSessionRoundTimedOut(t0, 3600, t0.getTime() + 3600_000)).toBe(true);
    expect(isSessionRoundTimedOut(t0, 3600, t0.getTime() + 7200_000)).toBe(true);
  });
});

