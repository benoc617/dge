import { describe, it, expect } from "vitest";
import {
  parseAdminDoorAiInt,
  getEffectiveDoorAiSettings,
  invalidateDoorAiRuntimeCache,
  DOOR_AI_ADMIN_LIMITS,
} from "@/lib/door-ai-runtime-settings";

describe("parseAdminDoorAiInt", () => {
  it("clamps numbers and numeric strings", () => {
    expect(parseAdminDoorAiInt(99, 1, 1, 128)).toBe(99);
    expect(parseAdminDoorAiInt("7", 1, 1, 10)).toBe(7);
    expect(parseAdminDoorAiInt(500, 1, 1, 100)).toBe(100);
  });

  it("falls back when invalid", () => {
    expect(parseAdminDoorAiInt(undefined, 4, 1, 128)).toBe(4);
    expect(parseAdminDoorAiInt("x", 4, 1, 128)).toBe(4);
  });
});

describe("invalidateDoorAiRuntimeCache", () => {
  it("is safe to call (admin PATCH clears resolve TTL cache)", () => {
    expect(() => invalidateDoorAiRuntimeCache()).not.toThrow();
  });
});

describe("getEffectiveDoorAiSettings", () => {
  it("clamps DB row values to admin limits", () => {
    const L = DOOR_AI_ADMIN_LIMITS;
    const eff = getEffectiveDoorAiSettings({
      doorAiDecideBatchSize: 999,
      geminiMaxConcurrent: 0,
      doorAiMaxConcurrentMcts: 100,
      doorAiMoveTimeoutMs: 50,
    });
    expect(eff.doorAiDecideBatchSize).toBe(L.doorAiDecideBatchSize.max);
    expect(eff.geminiMaxConcurrent).toBe(L.geminiMaxConcurrent.min);
    expect(eff.doorAiMaxConcurrentMcts).toBe(L.doorAiMaxConcurrentMcts.max);
    expect(eff.doorAiMoveTimeoutMs).toBe(L.doorAiMoveTimeoutMs.min);
  });
});
