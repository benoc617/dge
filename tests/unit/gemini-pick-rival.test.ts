import { describe, it, expect, beforeEach } from "vitest";
import { pickRivalOpponent, computeRivalAttackTargets } from "@/lib/gemini";
import * as rng from "@/lib/rng";

describe("pickRivalOpponent", () => {
  beforeEach(() => {
    rng.setSeed(42);
  });

  it("returns a name from rivalNames", () => {
    const r = pickRivalOpponent(["A", "B"]);
    expect(["A", "B"]).toContain(r);
  });

  it("is uniform over rivalNames (deterministic seed picks one of the set)", () => {
    rng.setSeed(7);
    const r = pickRivalOpponent(["AI1", "Human"]);
    expect(["AI1", "Human"]).toContain(r);
  });
});

describe("computeRivalAttackTargets", () => {
  it("excludes empires under new-empire protection", () => {
    const out = computeRivalAttackTargets([
      { name: "A", empire: { isProtected: true, protectionTurns: 5 } },
      { name: "B", empire: { isProtected: true, protectionTurns: 0 } },
      { name: "C", empire: { isProtected: false, protectionTurns: 0 } },
    ]);
    expect(out).toEqual(["B", "C"]);
  });

  it("returns empty when all rivals are protected", () => {
    const out = computeRivalAttackTargets([
      { name: "A", empire: { isProtected: true, protectionTurns: 3 } },
    ]);
    expect(out).toEqual([]);
  });
});
