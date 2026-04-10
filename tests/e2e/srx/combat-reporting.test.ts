import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  register,
  joinGame,
  doTick,
  doAction,
  uniqueName,
  uniqueGalaxy,
  clearNewEmpireProtectionForPlayers,
  deleteTestGalaxySession,
  scheduleTestGalaxyDeletion,
  TEST_PASSWORD,
} from "../helpers";

/**
 * Ensures attack responses include detailed loss breakdowns in `message` and `actionDetails.combatResult`
 * (see `src/lib/combat-loss-format.ts`, `game-engine.ts` attack cases).
 */
describe("E2E: combat loss reporting (API)", () => {
  it("attack_pirates includes your unit losses in message and combatResult", async () => {
    const name = uniqueName("PirateLoss");
    const password = TEST_PASSWORD;
    const { data: reg } = await register(name, password, { galaxyName: uniqueGalaxy() });
    scheduleTestGalaxyDeletion((reg as { gameSessionId?: string }).gameSessionId);
    await doTick(name);
    const { status, data } = await doAction(name, "attack_pirates");
    expect(status).toBe(200);
    const d = data as {
      success: boolean;
      message: string;
      actionDetails?: { combatResult?: { attackerLosses?: Record<string, number>; victory?: boolean } };
    };
    expect(d.success).toBe(true);
    expect(d.message).toMatch(/Your losses:/i);
    expect(d.actionDetails?.combatResult).toBeDefined();
    const losses = d.actionDetails!.combatResult!.attackerLosses!;
    const total = Object.values(losses).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
  });

  describe("two-player guerrilla", () => {
    const galaxy = uniqueGalaxy("CombatRpt");
    const p1 = uniqueName("CRP1");
    const p2 = uniqueName("CRP2");
    const password = TEST_PASSWORD;
    let sessionId: string;

    beforeAll(async () => {
      const { data } = await register(p1, password, { galaxyName: galaxy, isPublic: false });
      sessionId = data.gameSessionId as string;
      await joinGame(p2, password, { inviteCode: data.inviteCode as string });
      await clearNewEmpireProtectionForPlayers([p1, p2]);
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });

    it("attack_guerrilla returns attacker/defender soldier detail in message and combatResult", async () => {
      await doTick(p1);
      const { status, data } = await doAction(p1, "attack_guerrilla", { target: p2 });
      expect(status).toBe(200);
      const d = data as {
        success: boolean;
        message: string;
        actionDetails?: {
          combatResult?: {
            attackerLosses?: Record<string, number>;
            defenderLosses?: Record<string, number>;
          };
        };
      };
      expect(d.success).toBe(true);
      expect(d.message).toMatch(/Your soldier losses:/i);
      expect(d.message).toMatch(/Enemy soldier casualties:/i);
      expect(d.actionDetails?.combatResult?.defenderLosses?.soldiers).toBeDefined();
      expect(d.actionDetails?.combatResult?.defenderLosses?.soldiers).toBeGreaterThanOrEqual(0);
      expect(d.actionDetails?.combatResult?.attackerLosses?.soldiers).toBeDefined();
    });
  });
});
