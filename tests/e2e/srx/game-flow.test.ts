import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  register,
  login,
  getStatus,
  doAction,
  doTick,
  setupAI,
  uniqueName,
  uniqueGalaxy,
  deleteTestGalaxySession,
  scheduleTestGalaxyDeletion,
  pollStatusUntil,
  TEST_PASSWORD,
} from "../helpers";

describe("E2E: Game Flow", () => {
  describe("registration and login", () => {
    const name = uniqueName("RegTest");
    const password = TEST_PASSWORD;
    let playerId: string;
    let sessionId: string;

    it("registers a new player", async () => {
      const { status, data } = await register(name, password, { galaxyName: uniqueGalaxy() });
      expect(status).toBe(201);
      expect(data.name).toBe(name);
      expect(data.empire).toBeDefined();
      expect(data.gameSessionId).toBeTruthy();
      playerId = data.id;
      sessionId = data.gameSessionId;
    });

    it("can login with password", async () => {
      const { status, data } = await login(name, password);
      expect(status).toBe(200);
      expect(data.player.name).toBe(name);
      expect(data.empire).toBeDefined();
      expect(data.isYourTurn).toBe(true);
    });

    it("rejects wrong password", async () => {
      const { status } = await login(name, "wrong");
      expect(status).toBe(401);
    });

    it("rejects empty name", async () => {
      const { status } = await register("", password);
      expect(status).toBe(400);
    });

    it("rejects short password", async () => {
      const { status } = await register(uniqueName(), "ab");
      expect(status).toBe(400);
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });
  });

  describe("taking actions", () => {
    const name = uniqueName("ActionTest");
    const password = TEST_PASSWORD;
    let playerId: string;
    let sessionId: string;

    beforeAll(async () => {
      const { data } = await register(name, password, { galaxyName: uniqueGalaxy() });
      playerId = data.id;
      sessionId = data.gameSessionId;
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });

    it("POST /api/game/tick returns turn report on first call", async () => {
      const { status, data } = await doTick(name);
      expect(status).toBe(200);
      expect(data.turnReport).toBeDefined();
      expect(data.turnReport.income).toBeDefined();
      expect(data.turnReport.events).toBeDefined();
    });

    it("POST /api/game/tick is idempotent (alreadyProcessed)", async () => {
      const { status, data } = await doTick(name);
      expect(status).toBe(200);
      expect(data.alreadyProcessed).toBe(true);
    });

    it("can skip turn after tick (no turnReport on action — tick already ran)", async () => {
      const { status, data } = await doAction(name, "end_turn");
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.turnReport).toBeUndefined();
    });

    it("end_turn without prior tick still works (inline tick + turnReport fallback)", async () => {
      const solo = uniqueName("InlineTick");
      const { data: reg } = await register(solo, password, { galaxyName: uniqueGalaxy() });
      scheduleTestGalaxyDeletion(reg.gameSessionId as string);
      const { status, data } = await doAction(solo, "end_turn");
      expect(status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.turnReport).toBeDefined();
    });

    it("status reflects updated turns", async () => {
      const { data } = await getStatus(playerId);
      expect(data.empire.turnsPlayed).toBeGreaterThanOrEqual(1);
    });

    it("can set tax rate", async () => {
      const { status, data } = await doAction(name, "set_tax_rate", { rate: 40 });
      expect(status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("can buy soldiers", async () => {
      const { data } = await doAction(name, "buy_soldiers", { amount: 5 });
      expect(data.success).toBe(true);
    });
  });

  describe("with AI opponents", () => {
    const name = uniqueName("AITest");
    const password = TEST_PASSWORD;
    let playerId: string;
    let sessionId: string;

    beforeAll(async () => {
      const { data } = await register(name, password, { galaxyName: uniqueGalaxy() });
      playerId = data.id;
      sessionId = data.gameSessionId;
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });

    it("can set up AI opponents", async () => {
      const { status, data } = await setupAI(["Admiral Koss"], sessionId);
      expect(status).toBe(200);
      expect(data.created.length).toBe(1);
    });

    it("AI turns run in background after player action (no aiResults in response)", async () => {
      await doTick(name);
      const { data } = await doAction(name, "end_turn");
      expect(data.success).toBe(true);
      expect(data.aiResults).toBeUndefined();
      // Poll until it's our turn again (AI calls Gemini when key present; allow 80s)
      const after = await pollStatusUntil(playerId, (d) => d.isYourTurn === true, {
        timeoutMs: 80_000,
        intervalMs: 500,
      });
      expect(after.isYourTurn).toBe(true);
    });

    it("turn order shows all players", async () => {
      const { data } = await getStatus(playerId);
      expect(data.turnOrder).toBeDefined();
      expect(data.turnOrder.length).toBe(2);
      expect(data.turnOrder[0].name).toBe(name);
      expect(data.turnOrder[1].isAI).toBe(true);
    });

    it("is always the human's turn after AI runs", async () => {
      const { data } = await getStatus(playerId);
      expect(data.isYourTurn).toBe(true);
    });
  });
});
