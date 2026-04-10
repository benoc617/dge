import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { register, joinGame, doAction, uniqueName, uniqueGalaxy, deleteTestGalaxySession, TEST_PASSWORD } from "../helpers";

describe("E2E: New-empire protection", () => {
  const a = uniqueName("ProtA");
  const b = uniqueName("ProtB");
  const password = TEST_PASSWORD;
  let sessionId: string;

  beforeAll(async () => {
    const { data } = await register(a, password, { galaxyName: uniqueGalaxy("ProtGal") });
    sessionId = data.gameSessionId as string;
    const invite = data.inviteCode as string;
    await joinGame(b, password, { inviteCode: invite });
  });

  afterAll(async () => {
    await deleteTestGalaxySession(sessionId);
  });

  it("blocks conventional attack on a protected rival", async () => {
    const { status, data } = await doAction(a, "attack_conventional", { target: b });
    expect(status).toBe(200);
    expect(data.success).toBe(false);
    expect(String(data.message)).toMatch(/protection/i);
  });
});
