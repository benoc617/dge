import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  register,
  joinGame,
  getGameLog,
  getLeaderboard,
  getHighscores,
  getMessages,
  postMessage,
  uniqueName,
  uniqueGalaxy,
  api,
  postGameOver,
  runAI,
  getLobbies,
  getSession,
  getStatus,
  scheduleTestGalaxyDeletion,
  deleteTestGalaxySession,
  TEST_PASSWORD,
} from "./helpers";

describe("E2E: auxiliary API routes", () => {
  it("GET /api/game/log returns export shape", async () => {
    const { status, data } = await getGameLog();
    expect(status).toBe(200);
    expect(data).toHaveProperty("turnLogs");
    expect(data).toHaveProperty("gameEvents");
    expect(data).toHaveProperty("totalTurnLogs");
    expect(Array.isArray((data as { turnLogs: unknown }).turnLogs)).toBe(true);
  });

  it("GET /api/game/leaderboard returns ranked list", async () => {
    const { status, data } = await getLeaderboard();
    expect(status).toBe(200);
    const lb = (data as { leaderboard: unknown[] }).leaderboard;
    expect(Array.isArray(lb)).toBe(true);
  });

  it("GET /api/game/highscores returns scores array", async () => {
    const { status, data } = await getHighscores();
    expect(status).toBe(200);
    expect(Array.isArray((data as { scores: unknown[] }).scores)).toBe(true);
  });

  it("POST /api/game/gameover returns standings and marks game over", async () => {
    const name = uniqueName("GOE2E");
    const { status: regStatus, data: reg } = await register(name, TEST_PASSWORD, { galaxyName: uniqueGalaxy("GOGal") });
    expect(regStatus).toBe(201);
    scheduleTestGalaxyDeletion((reg as { gameSessionId?: string }).gameSessionId);
    const { status, data } = await postGameOver(name);
    expect(status).toBe(200);
    const d = data as { gameOver: boolean; standings: unknown[]; winner: string };
    expect(d.gameOver).toBe(true);
    expect(Array.isArray(d.standings)).toBe(true);
    expect(d.winner).toBeTruthy();
  });

  it("POST /api/ai/setup requires gameSessionId", async () => {
    const { status, data } = await api("/api/ai/setup", { method: "POST", body: JSON.stringify({ count: 1 }) });
    expect(status).toBe(400);
    expect((data as { error?: string }).error).toMatch(/gameSessionId/i);
  });

  it("POST /api/ai/setup with count (UI path) creates AI players", async () => {
    const name = uniqueName("AiSetupUI");
    const { status: regStatus, data: reg } = await register(name, TEST_PASSWORD, {
      galaxyName: uniqueGalaxy("AiSetupGal"),
    });
    expect(regStatus).toBe(201);
    const sessionId = (reg as { gameSessionId?: string }).gameSessionId!;
    scheduleTestGalaxyDeletion(sessionId);

    // Simulate exactly what page.tsx sends: { gameSessionId, count } (not names).
    const { status, data } = await api("/api/ai/setup", {
      method: "POST",
      body: JSON.stringify({ gameSessionId: sessionId, count: 2 }),
    });
    expect(status).toBe(200);
    const d = data as { created: { name: string }[]; message: string };
    expect(Array.isArray(d.created)).toBe(true);
    expect(d.created).toHaveLength(2);
    expect(typeof d.created[0].name).toBe("string");
  });

  it("POST /api/ai/run-all requires gameSessionId", async () => {
    const { status } = await api("/api/ai/run-all", { method: "POST", body: JSON.stringify({}) });
    expect(status).toBe(400);
  });

  it("POST /api/ai/run-all returns results array (empty when human's turn)", async () => {
    const name = uniqueName("RunAllE2E");
    const { data } = await register(name, TEST_PASSWORD, { galaxyName: uniqueGalaxy("RunAllGal") });
    scheduleTestGalaxyDeletion(data.gameSessionId as string);
    const { status, data: out } = await runAI(data.gameSessionId as string);
    expect(status).toBe(200);
    expect(Array.isArray((out as { results: unknown[] }).results)).toBe(true);
  });

  it("POST /api/ai/turn rejects non-AI player", async () => {
    const name = uniqueName("NotAI");
    const { data: reg } = await register(name, TEST_PASSWORD, { galaxyName: uniqueGalaxy("AiTurnGal") });
    scheduleTestGalaxyDeletion((reg as { gameSessionId?: string }).gameSessionId);
    const { status } = await api("/api/ai/turn", {
      method: "POST",
      body: JSON.stringify({ playerName: name }),
    });
    expect(status).toBe(400);
  });

  it("GET /api/game/help?game=srx returns title and content", async () => {
    const { status, data } = await api("/api/game/help?game=srx");
    expect(status).toBe(200);
    const d = data as { title: string; content: string };
    expect(typeof d.title).toBe("string");
    expect(d.title).toContain("Solar Realms");
    expect(typeof d.content).toBe("string");
    expect(d.content.length).toBeGreaterThan(100);
  });

  it("GET /api/game/help?game=unknown returns 404", async () => {
    const { status } = await api("/api/game/help?game=notarealegame");
    expect(status).toBe(404);
  });

  it("GET /api/game/messages 404 for unknown player", async () => {
    const { status } = await getMessages(`NoSuchPlayer_${Date.now()}`);
    expect(status).toBe(404);
  });

  describe("game field in API responses", () => {
    const creatorName = uniqueName("GameFld");
    const joinerName = uniqueName("GameFldJ");
    const password = TEST_PASSWORD;
    let sessionId: string;
    let inviteCode: string;
    let playerId: string;

    beforeAll(async () => {
      const { status, data } = await register(creatorName, password, {
        galaxyName: uniqueGalaxy("GameFldGal"),
        isPublic: true,
      });
      expect(status).toBe(201);
      const reg = data as { gameSessionId: string; inviteCode: string; id: string };
      sessionId = reg.gameSessionId;
      inviteCode = reg.inviteCode;
      playerId = reg.id;
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });

    it("POST /api/game/register response includes game: srx", async () => {
      const { data } = await register(uniqueName("Tmp"), password, {
        galaxyName: uniqueGalaxy("TmpGal"),
      });
      scheduleTestGalaxyDeletion((data as { gameSessionId?: string }).gameSessionId);
      expect((data as { game?: string }).game).toBe("srx");
    });

    it("POST /api/game/join response includes game: srx", async () => {
      const { status, data } = await joinGame(joinerName, password, { inviteCode });
      expect(status).toBe(201);
      expect((data as { game?: string }).game).toBe("srx");
    });

    it("GET /api/game/status response includes game: srx", async () => {
      const { status, data } = await getStatus(playerId);
      expect(status).toBe(200);
      expect((data as { game?: string }).game).toBe("srx");
    });

    it("GET /api/game/lobbies items include game: srx", async () => {
      const { status, data } = await getLobbies();
      expect(status).toBe(200);
      const items = data as { galaxyName: string; game?: string }[];
      const found = items.find((l) => l.galaxyName.startsWith("GameFldGal"));
      expect(found).toBeDefined();
      expect(found!.game).toBe("srx");
    });

    it("GET /api/game/session response includes game: srx", async () => {
      const { status, data } = await getSession(sessionId);
      expect(status).toBe(200);
      expect((data as { game?: string }).game).toBe("srx");
    });
  });

  describe("session-scoped messaging", () => {
    const a = uniqueName("MsgA");
    const b = uniqueName("MsgB");
    const password = TEST_PASSWORD;
    let sessionId: string;

    beforeAll(async () => {
      const { data } = await register(a, password, { galaxyName: uniqueGalaxy("MsgGal") });
      sessionId = data.gameSessionId as string;
      const invite = data.inviteCode as string;
      await joinGame(b, password, { inviteCode: invite });
    });

    afterAll(async () => {
      await deleteTestGalaxySession(sessionId);
    });

    it("POST and GET /api/game/messages", async () => {
      const { status: postSt } = await postMessage(a, b, "Ping from E2E");
      expect(postSt).toBe(201);
      const { status, data } = await getMessages(b);
      expect(status).toBe(200);
      const msgs = (data as { messages: { body: string }[] }).messages;
      expect(msgs.some((m) => m.body.includes("Ping from E2E"))).toBe(true);
    });
  });
});
