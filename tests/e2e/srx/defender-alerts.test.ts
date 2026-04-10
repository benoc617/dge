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
  TEST_PASSWORD,
} from "../helpers";

/**
 * When P1 guerrilla-attacks P2, P2's next turn tick situation report must include ALERT lines.
 */
describe("E2E: defender situation-report alerts", () => {
  const galaxy = uniqueGalaxy("AlertGal");
  const p1 = uniqueName("AlertP1");
  const p2 = uniqueName("AlertP2");
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

  it("defender receives ALERT in turnReport.events after guerrilla strike", async () => {
    await doTick(p1);
    const { status, data } = await doAction(p1, "attack_guerrilla", { target: p2 });
    expect(status).toBe(200);
    expect((data as { success: boolean }).success).toBe(true);

    const tick = await doTick(p2);
    expect(tick.status).toBe(200);
    const report = (tick.data as { turnReport?: { events: string[] } }).turnReport;
    expect(report).toBeDefined();
    const events = report!.events;
    expect(events.some((e) => e.startsWith("ALERT:"))).toBe(true);
    expect(events.some((e) => e.includes("Guerrilla"))).toBe(true);
  });
});
