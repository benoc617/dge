import { describe, expect, it } from "vitest";
import { toEmpireUpdateData } from "@/lib/empire-prisma";

describe("toEmpireUpdateData", () => {
  it("passes pendingDefenderAlerts directly (Json field on MySQL — no { set } wrapper needed)", () => {
    const u = toEmpireUpdateData({ credits: 100, pendingDefenderAlerts: [] });
    expect(u.credits).toBe(100);
    expect(u.pendingDefenderAlerts).toEqual([]);
  });

  it("omits pendingDefenderAlerts when undefined", () => {
    const u = toEmpireUpdateData({ credits: 50 });
    expect(u.pendingDefenderAlerts).toBeUndefined();
  });
});
