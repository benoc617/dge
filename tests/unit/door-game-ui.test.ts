import { describe, it, expect } from "vitest";
import { simultaneousDoorCommandCenterDisabled } from "@/lib/door-game-ui";

describe("simultaneousDoorCommandCenterDisabled", () => {
  it("is false when turn is open and canAct is true", () => {
    expect(simultaneousDoorCommandCenterDisabled(true, true)).toBe(false);
  });

  it("is false when turn is open and canAct is undefined (do not treat as no daily slots)", () => {
    expect(simultaneousDoorCommandCenterDisabled(undefined, true)).toBe(false);
  });

  it("is true when canAct is explicitly false", () => {
    expect(simultaneousDoorCommandCenterDisabled(false, true)).toBe(true);
  });

  it("is true when turn is not open", () => {
    expect(simultaneousDoorCommandCenterDisabled(true, false)).toBe(true);
    expect(simultaneousDoorCommandCenterDisabled(true, undefined)).toBe(true);
  });
});
