import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  register,
  joinGame,
  getStatus,
  doAction,
  doTick,
  setupAI,
  getSession,
  uniqueName,
  uniqueGalaxy,
  deleteTestGalaxySession,
  pollStatusUntil,
  TEST_PASSWORD,
} from "../helpers";

describe("E2E: Multiplayer Turn Order", () => {
  const galaxy = uniqueGalaxy("MPTest");
  const player1Name = uniqueName("P1");
  const player2Name = uniqueName("P2");
  const password = TEST_PASSWORD;
  let player1Id: string;
  let player2Id: string;
  let sessionId: string;
  let inviteCode: string;

  beforeAll(async () => {
    // Player 1 creates the galaxy
    const { data } = await register(player1Name, password, { galaxyName: galaxy, isPublic: false });
    player1Id = data.id;
    sessionId = data.gameSessionId;
    inviteCode = data.inviteCode;
  });

  afterAll(async () => {
    await deleteTestGalaxySession(sessionId);
  });

  it("player 2 joins via invite code", async () => {
    const { status, data } = await joinGame(player2Name, password, { inviteCode });
    expect(status).toBe(201);
    player2Id = data.id;
    expect(data.gameSessionId).toBe(sessionId);
  });

  it("turn order has both players", async () => {
    const { data } = await getStatus(player1Id);
    expect(data.turnOrder.length).toBe(2);
    expect(data.turnOrder[0].name).toBe(player1Name);
    expect(data.turnOrder[1].name).toBe(player2Name);
  });

  it("player 1 goes first (creator)", async () => {
    const { data } = await getStatus(player1Id);
    expect(data.isYourTurn).toBe(true);
    expect(data.currentTurnPlayer).toBe(player1Name);
  });

  it("player 2 cannot act when it's not their turn", async () => {
    const { status, data } = await doAction(player2Name, "end_turn");
    expect(status).toBe(409);
    expect(data.notYourTurn).toBe(true);
  });

  it("player 2 sees it's not their turn", async () => {
    const { data } = await getStatus(player2Id);
    expect(data.isYourTurn).toBe(false);
    expect(data.currentTurnPlayer).toBe(player1Name);
  });

  it("player 1 takes their turn", async () => {
    await doTick(player1Name);
    const { status, data } = await doAction(player1Name, "end_turn");
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it("now it's player 2's turn", async () => {
    const { data } = await getStatus(player2Id);
    expect(data.isYourTurn).toBe(true);
    expect(data.currentTurnPlayer).toBe(player2Name);
  });

  it("player 1 cannot act now", async () => {
    const { status, data } = await doAction(player1Name, "end_turn");
    expect(status).toBe(409);
  });

  it("player 2 takes their turn", async () => {
    await doTick(player2Name);
    const { status, data } = await doAction(player2Name, "end_turn");
    expect(status).toBe(200);
    expect(data.success).toBe(true);
  });

  it("turn cycles back to player 1", async () => {
    const { data } = await getStatus(player1Id);
    expect(data.isYourTurn).toBe(true);
    expect(data.currentTurnPlayer).toBe(player1Name);
  });
});

describe("E2E: Multiplayer with AI", () => {
  const galaxy = uniqueGalaxy("MPAITest");
  const humanName = uniqueName("Human");
  const password = TEST_PASSWORD;
  let humanId: string;
  let sessionId: string;
  let inviteCode: string;

  beforeAll(async () => {
    const { data } = await register(humanName, password, { galaxyName: galaxy });
    humanId = data.id;
    sessionId = data.gameSessionId;
    inviteCode = data.inviteCode;

    await setupAI(["Admiral Koss"], sessionId);
  });

  afterAll(async () => {
    await deleteTestGalaxySession(sessionId);
  });

  it("has human + AI in turn order", async () => {
    const { data } = await getStatus(humanId);
    expect(data.turnOrder.length).toBe(2);
    expect(data.turnOrder[0].name).toBe(humanName);
    expect(data.turnOrder[0].isAI).toBe(false);
    expect(data.turnOrder[1].name).toBe("Admiral Koss");
    expect(data.turnOrder[1].isAI).toBe(true);
  });

  it("AI runs in background after human turn (poll until human is up again)", async () => {
    await doTick(humanName);
    const { data } = await doAction(humanName, "end_turn");
    expect(data.success).toBe(true);
    expect(data.aiResults).toBeUndefined();
    // AI uses Gemini when configured; poll up to 80s (E2E config allows 90s per test)
    const fin = await pollStatusUntil(humanId, (d) => d.isYourTurn === true, {
      timeoutMs: 80_000,
      intervalMs: 500,
    });
    expect(fin.isYourTurn).toBe(true);
  });

  it("human's turn again after AI", async () => {
    const { data } = await getStatus(humanId);
    expect(data.isYourTurn).toBe(true);
  });
});

describe("E2E: Mid-game join", () => {
  const galaxy = uniqueGalaxy("MidJoinTest");
  const player1Name = uniqueName("Early");
  const player2Name = uniqueName("Late");
  const password = TEST_PASSWORD;
  let player1Id: string;
  let player2Id: string;
  let sessionId: string;
  let inviteCode: string;

  beforeAll(async () => {
    const { data } = await register(player1Name, password, { galaxyName: galaxy });
    player1Id = data.id;
    sessionId = data.gameSessionId;
    inviteCode = data.inviteCode;

    // Player 1 takes a few turns alone
    await doTick(player1Name);
    await doAction(player1Name, "end_turn");
    await doTick(player1Name);
    await doAction(player1Name, "end_turn");
  });

  afterAll(async () => {
    await deleteTestGalaxySession(sessionId);
  });

  it("player 2 joins after game has started", async () => {
    const { status, data } = await joinGame(player2Name, password, { inviteCode });
    expect(status).toBe(201);
    player2Id = data.id;
  });

  it("turn order includes the new player at the end", async () => {
    const { data } = await getStatus(player1Id);
    expect(data.turnOrder.length).toBe(2);
    expect(data.turnOrder[0].name).toBe(player1Name);
    expect(data.turnOrder[1].name).toBe(player2Name);
  });

  it("current player is still player 1 (they're up)", async () => {
    const { data } = await getStatus(player1Id);
    expect(data.isYourTurn).toBe(true);
  });

  it("player 1 goes, then player 2 gets their turn", async () => {
    await doTick(player1Name);
    await doAction(player1Name, "end_turn");
    const { data } = await getStatus(player2Id);
    expect(data.isYourTurn).toBe(true);
    expect(data.currentTurnPlayer).toBe(player2Name);
  });

  it("after player 2 goes, it cycles back to player 1", async () => {
    await doTick(player2Name);
    await doAction(player2Name, "end_turn");
    const { data } = await getStatus(player1Id);
    expect(data.isYourTurn).toBe(true);
  });
});
