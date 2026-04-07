import { describe, it, expect } from "vitest";
import { targetHasNewEmpireProtection } from "@/lib/empire-protection";

describe("targetHasNewEmpireProtection", () => {
  it("is true only when protected flag and remaining turns are both set", () => {
    expect(targetHasNewEmpireProtection({ isProtected: true, protectionTurns: 5 })).toBe(true);
    expect(targetHasNewEmpireProtection({ isProtected: true, protectionTurns: 0 })).toBe(false);
    expect(targetHasNewEmpireProtection({ isProtected: false, protectionTurns: 5 })).toBe(false);
    expect(targetHasNewEmpireProtection({ isProtected: false, protectionTurns: 0 })).toBe(false);
  });
});
