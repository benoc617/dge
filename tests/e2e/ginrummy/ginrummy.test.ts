/**
 * E2E tests for Gin Rummy — covers registration, status, draw/discard actions,
 * AI play, resign, and help content.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  api, getStatus,
  deleteTestGalaxySession, scheduleTestGalaxyDeletion,
  scheduleTestUserDeletion,
  uniqueGalaxy, uniqueName, sleep,
  TEST_PASSWORD, pollStatusUntil,
} from "../helpers";

const GR_GALAXY = uniqueGalaxy("GinRummyE2E");
const GR_USER = uniqueName("ginrummy_e2e");
let sessionId: string | null = null;
let playerId: string | null = null;

afterAll(async () => {
  if (sessionId) await deleteTestGalaxySession(sessionId);
  scheduleTestUserDeletion(GR_USER);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("Gin Rummy E2E", () => {
  it("registers a gin rummy game vs AI", async () => {
    // Sign up user
    const signupRes = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: GR_USER,
        fullName: "Gin Test",
        email: `${GR_USER}@test.local`,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
      }),
    });
    expect([201, 409].includes(signupRes.status)).toBe(true);

    // Register gin rummy game
    const res = await api("/api/game/register", {
      method: "POST",
      body: JSON.stringify({
        name: GR_USER,
        password: TEST_PASSWORD,
        game: "ginrummy",
        galaxyName: GR_GALAXY,
        opponentMode: "ai",
        matchTarget: "0", // single hand
      }),
    });
    expect(res.status).toBe(201);
    const data = res.data as Record<string, unknown>;
    expect(data.game).toBe("ginrummy");
    sessionId = data.gameSessionId as string;
    playerId = data.id as string;
    expect(sessionId).toBeTruthy();
    expect(playerId).toBeTruthy();
    scheduleTestGalaxyDeletion(sessionId);
  });

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  it("returns gin rummy status with correct initial fields", async () => {
    expect(playerId).toBeTruthy();
    const res = await getStatus(playerId!);
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;

    expect(data.gameStatus).toBe("playing");
    expect(data.phase).toBe("draw");
    expect(data.isYourTurn).toBe(true);
    expect(data.myPlayerIdx).toBe(0); // creator is player 0
    expect(Array.isArray(data.myCards)).toBe(true);
    expect((data.myCards as string[]).length).toBe(10);
    expect(typeof data.discardTop).toBe("string");
    expect(typeof data.stockCount).toBe("number");
    expect((data.stockCount as number)).toBe(31); // 52 - 10 - 10 - 1
    expect(data.opponentCardCount).toBe(10);
    expect(Array.isArray(data.scores)).toBe(true);
    expect(data.scores).toEqual([0, 0]);
    expect(data.matchTarget).toBeNull(); // single hand
  });

  // ---------------------------------------------------------------------------
  // Draw from stock
  // ---------------------------------------------------------------------------

  it("draws from stock and transitions to discard phase", async () => {
    expect(playerId).toBeTruthy();
    const res = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId, action: "draw_stock" }),
    });
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(true);

    // Status should now show discard phase and 11 cards in hand
    const statusRes = await getStatus(playerId!);
    expect(statusRes.status).toBe(200);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.phase).toBe("discard");
    expect((statusData.myCards as string[]).length).toBe(11);
    expect((statusData.stockCount as number)).toBe(30);
  });

  // ---------------------------------------------------------------------------
  // Discard
  // ---------------------------------------------------------------------------

  it("discards a card and switches to opponent's turn", async () => {
    expect(playerId).toBeTruthy();
    // Get current status to find a card to discard
    const statusRes = await getStatus(playerId!);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.phase).toBe("discard");

    const myCards = statusData.myCards as string[];
    expect(myCards.length).toBe(11);
    const cardToDiscard = myCards[0]; // discard first card

    const res = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId, action: "discard", card: cardToDiscard }),
    });
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AI takes its turn (polling)
  // ---------------------------------------------------------------------------

  it("AI takes its turn and returns to player's draw phase", async () => {
    expect(playerId).toBeTruthy();
    // Poll until it's our turn again (AI should complete its draw+discard)
    // Allow 80s — E2E config sets 90s per test so there's headroom under load
    const data = await pollStatusUntil(
      playerId!,
      (d) => d.isYourTurn === true && d.phase === "draw",
      { timeoutMs: 80_000, intervalMs: 500 },
    );
    expect(data.isYourTurn).toBe(true);
    expect(data.phase).toBe("draw");
    expect((data.myCards as string[]).length).toBe(10); // back to 10 cards
  });

  // ---------------------------------------------------------------------------
  // Legal actions API
  // ---------------------------------------------------------------------------

  it("legalActions includes draw_stock and draw_discard in draw phase", async () => {
    expect(playerId).toBeTruthy();
    const statusRes = await getStatus(playerId!);
    const data = statusRes.data as Record<string, unknown>;
    expect(data.phase).toBe("draw");
    const legalActions = data.legalActions as Array<{ action: string }>;
    const actions = legalActions.map((a) => a.action);
    expect(actions).toContain("draw_stock");
    expect(actions).toContain("draw_discard");
  });

  // ---------------------------------------------------------------------------
  // Invalid action rejection
  // ---------------------------------------------------------------------------

  it("rejects discard action in draw phase", async () => {
    expect(playerId).toBeTruthy();
    const statusRes = await getStatus(playerId!);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.phase).toBe("draw");
    const myCards = statusData.myCards as string[];

    const res = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId, action: "discard", card: myCards[0] }),
    });
    // Should fail — wrong phase
    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Play through multiple turns (smoke test)
  // ---------------------------------------------------------------------------

  it("plays through several turns without error", async () => {
    expect(playerId).toBeTruthy();

    // Play 3 full turns (draw + discard each)
    for (let turn = 0; turn < 3; turn++) {
      // Wait for our draw phase
      await pollStatusUntil(
        playerId!,
        (d) => d.isYourTurn === true && d.phase === "draw",
        { timeoutMs: 20_000, intervalMs: 400 },
      );

      // Draw from stock
      const drawRes = await api("/api/game/action", {
        method: "POST",
        body: JSON.stringify({ playerId, action: "draw_stock" }),
      });
      expect(drawRes.status).toBe(200);
      expect((drawRes.data as Record<string, unknown>).success).toBe(true);

      // Get status to find a card to discard
      const statusRes = await getStatus(playerId!);
      const statusData = statusRes.data as Record<string, unknown>;
      const myCards = statusData.myCards as string[];
      const cardToDiscard = myCards[myCards.length - 1]; // discard last card

      // Discard
      const discardRes = await api("/api/game/action", {
        method: "POST",
        body: JSON.stringify({ playerId, action: "discard", card: cardToDiscard }),
      });
      expect(discardRes.status).toBe(200);
      expect((discardRes.data as Record<string, unknown>).success).toBe(true);
    }
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Resign
  // ---------------------------------------------------------------------------

  it("can resign", async () => {
    expect(playerId).toBeTruthy();

    // First ensure it's our turn
    await pollStatusUntil(
      playerId!,
      (d) => d.isYourTurn === true,
      { timeoutMs: 20_000, intervalMs: 400 },
    ).catch(() => { /* Continue even if poll times out — resign is valid any time */ });

    const res = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId, action: "resign" }),
    });
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.success).toBe(true);

    // Status should now show resigned/complete
    await sleep(500);
    const statusRes = await getStatus(playerId!);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(["resigned", "timeout", "hand_complete", "match_complete"]).toContain(statusData.gameStatus);
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Help content
  // ---------------------------------------------------------------------------

  it("serves gin rummy help content", async () => {
    const res = await api("/api/game/help?game=ginrummy");
    expect(res.status).toBe(200);
    const data = res.data as Record<string, unknown>;
    expect(data.title).toContain("Gin Rummy");
    expect(typeof data.content).toBe("string");
    expect((data.content as string).length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Human vs Human lobby test
// ---------------------------------------------------------------------------

describe("Gin Rummy human vs human", () => {
  const LOBBY_GALAXY = uniqueGalaxy("GinRummyHuman");
  const P1_NAME = uniqueName("gr_human_p1");
  const P2_NAME = uniqueName("gr_human_p2");
  let p1Id: string | null = null;
  let p2Id: string | null = null;
  let hvhSessionId: string | null = null;

  afterAll(async () => {
    if (hvhSessionId) await deleteTestGalaxySession(hvhSessionId);
    scheduleTestUserDeletion(P1_NAME);
    scheduleTestUserDeletion(P2_NAME);
  });

  it("creates a human vs human game and waits for opponent", async () => {
    // Register P1 with human opponent mode
    const res = await api("/api/game/register", {
      method: "POST",
      body: JSON.stringify({
        name: P1_NAME,
        password: "TestPass1!",
        game: "ginrummy",
        galaxyName: LOBBY_GALAXY,
        opponentMode: "human",
      }),
    });
    expect(res.status).toBe(201);
    const data = res.data as Record<string, unknown>;
    hvhSessionId = data.gameSessionId as string;
    p1Id = data.id as string;
    const inviteCode = data.inviteCode as string;
    scheduleTestGalaxyDeletion(hvhSessionId);

    // P1 should be in waitingForGameStart state
    const statusRes = await getStatus(p1Id!);
    const statusData = statusRes.data as Record<string, unknown>;
    expect(statusData.waitingForGameStart).toBe(true);

    // P2 joins
    const joinRes = await api("/api/game/join", {
      method: "POST",
      body: JSON.stringify({
        name: P2_NAME,
        password: "TestPass1!",
        inviteCode,
      }),
    });
    expect(joinRes.status).toBe(201);
    const joinData = joinRes.data as Record<string, unknown>;
    p2Id = joinData.id as string;
    expect(p2Id).toBeTruthy();
  });

  it("both players see the game started after P2 joins", async () => {
    expect(p1Id).toBeTruthy();
    expect(p2Id).toBeTruthy();

    // P1 should no longer be waiting
    const p1StatusRes = await getStatus(p1Id!);
    const p1Status = p1StatusRes.data as Record<string, unknown>;
    expect(p1Status.waitingForGameStart).toBe(false);
    expect(p1Status.phase).toBe("draw");
    expect(Array.isArray(p1Status.myCards)).toBe(true);
    expect((p1Status.myCards as string[]).length).toBe(10);

    // P2 should also be in the game
    const p2StatusRes = await getStatus(p2Id!);
    const p2Status = p2StatusRes.data as Record<string, unknown>;
    expect(p2Status.waitingForGameStart).toBe(false);
    expect(p2Status.phase).toBe("draw");
    expect((p2Status.myCards as string[]).length).toBe(10);

    // Only P1 (player 0) should have their turn first
    expect(p1Status.isYourTurn).toBe(true);
    expect(p2Status.isYourTurn).toBe(false);
  });

  it("P1 draws and discards, P2 gets their turn", async () => {
    expect(p1Id).toBeTruthy();
    expect(p2Id).toBeTruthy();

    // P1 draws
    const drawRes = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId: p1Id, action: "draw_stock" }),
    });
    expect(drawRes.status).toBe(200);
    expect((drawRes.data as Record<string, unknown>).success).toBe(true);

    // P1 discards
    const statusRes = await getStatus(p1Id!);
    const statusData = statusRes.data as Record<string, unknown>;
    const myCards = statusData.myCards as string[];
    const discardCard = myCards[0];

    const discardRes = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId: p1Id, action: "discard", card: discardCard }),
    });
    expect(discardRes.status).toBe(200);

    // P2 should now have their turn
    const p2StatusRes = await getStatus(p2Id!);
    const p2Status = p2StatusRes.data as Record<string, unknown>;
    expect(p2Status.isYourTurn).toBe(true);
    expect(p2Status.phase).toBe("draw");

    // P2 cannot take P1's discard (it's a valid action — take from discard pile)
    const p2DrawRes = await api("/api/game/action", {
      method: "POST",
      body: JSON.stringify({ playerId: p2Id, action: "draw_discard" }),
    });
    expect(p2DrawRes.status).toBe(200);
    expect((p2DrawRes.data as Record<string, unknown>).success).toBe(true);
  });
});
