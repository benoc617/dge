/**
 * E2E tests for cross-game isolation — one user with active games in multiple
 * game types (SRX + chess) must be able to interact with each game independently
 * without name collisions causing mis-routing.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  api,
  register,
  getStatus,
  doActionById,
  doTickById,
  getLeaderboardById,
  getLeaderboard,
  setupAI,
  deleteTestGalaxySessions,
  deleteTestUserAccountsByUsernames,
  uniqueGalaxy,
  uniqueName,
  TEST_PASSWORD,
} from "./helpers";

const USERNAME = uniqueName("multi");
const SRX_GALAXY = uniqueGalaxy("MultiSRX");
const CHESS_GALAXY = uniqueGalaxy("MultiChess");

let srxPlayerId: string;
let srxSessionId: string;
let chessPlayerId: string;
let chessSessionId: string;

beforeAll(async () => {
  // Create a UserAccount shared by both games.
  const signup = await api("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      username: USERNAME,
      fullName: "Multi-Game Tester",
      email: `${USERNAME}@test.invalid`,
      password: TEST_PASSWORD,
      passwordConfirm: TEST_PASSWORD,
    }),
  });
  expect([201, 409].includes(signup.status)).toBe(true);

  // Register SRX game first (older createdAt).
  const srx = await register(USERNAME, TEST_PASSWORD, { galaxyName: SRX_GALAXY });
  expect(srx.status).toBe(201);
  const srxData = srx.data as Record<string, unknown>;
  srxPlayerId = srxData.id as string;
  srxSessionId = srxData.gameSessionId as string;

  // Add an AI opponent so the SRX leaderboard has >1 entry.
  const ai = await setupAI(["TestBot"], srxSessionId);
  expect(ai.status).toBe(200);

  // Register chess game second (newer createdAt — name-based lookups would hit this one first).
  const chess = await api("/api/game/register", {
    method: "POST",
    body: JSON.stringify({
      name: USERNAME,
      password: TEST_PASSWORD,
      game: "chess",
      galaxyName: CHESS_GALAXY,
    }),
  });
  expect(chess.status).toBe(201);
  const chessData = chess.data as Record<string, unknown>;
  chessPlayerId = chessData.id as string;
  chessSessionId = chessData.gameSessionId as string;
}, 30_000);

afterAll(async () => {
  await deleteTestGalaxySessions([srxSessionId, chessSessionId].filter(Boolean));
  await deleteTestUserAccountsByUsernames([USERNAME]);
});

describe("multi-game isolation", () => {
  // ------------------------------------------------------------------
  // Login hub
  // ------------------------------------------------------------------
  it("login hub lists both SRX and chess games for the same user", async () => {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: USERNAME, password: TEST_PASSWORD }),
    });
    expect(res.status).toBe(200);

    const { games } = res.data as {
      games: { playerId: string; game: string; galaxyName: string }[];
    };

    const srxGame = games.find((g) => g.game === "srx");
    const chessGame = games.find((g) => g.game === "chess");

    expect(srxGame).toBeDefined();
    expect(chessGame).toBeDefined();
    expect(srxGame!.playerId).toBe(srxPlayerId);
    expect(chessGame!.playerId).toBe(chessPlayerId);
    expect(srxGame!.galaxyName).toBe(SRX_GALAXY);
    expect(chessGame!.galaxyName).toBe(CHESS_GALAXY);
  });

  // ------------------------------------------------------------------
  // Status isolation
  // ------------------------------------------------------------------
  it("status?id= returns the correct game for each player ID", async () => {
    const srxStatus = await getStatus(srxPlayerId);
    expect(srxStatus.status).toBe(200);
    const srxData = srxStatus.data as Record<string, unknown>;
    expect(srxData.gameSessionId).toBe(srxSessionId);
    expect(srxData.game).toBe("srx");
    expect(srxData.army).toBeDefined();

    const chessStatus = await getStatus(chessPlayerId);
    expect(chessStatus.status).toBe(200);
    const chessData = chessStatus.data as Record<string, unknown>;
    expect(chessData.sessionId).toBe(chessSessionId);
    expect(chessData.board).toBeDefined();
    expect(chessData.myColor).toBe("white");
  });

  // ------------------------------------------------------------------
  // Leaderboard isolation
  // ------------------------------------------------------------------
  it("leaderboard by player ID scopes to the correct session", async () => {
    const srxLb = await getLeaderboardById(srxPlayerId);
    expect(srxLb.status).toBe(200);
    const srxEntries = (srxLb.data as { leaderboard: { name: string }[] }).leaderboard;
    expect(srxEntries.length).toBeGreaterThanOrEqual(2);
    expect(srxEntries.some((e) => e.name.toLowerCase() === USERNAME.toLowerCase())).toBe(true);

    const chessLb = await getLeaderboardById(chessPlayerId);
    expect(chessLb.status).toBe(200);
    const chessEntries = (chessLb.data as { leaderboard: unknown[] }).leaderboard;
    expect(chessEntries.length).toBe(0);
  });

  it("leaderboard by name (legacy) returns data from the most-recent game — regression baseline", async () => {
    // The name-based path returns the most recently created player's game.
    // Since chess was registered after SRX, it finds chess → empty leaderboard.
    // This documents the known limitation — callers should use playerId.
    const lb = await getLeaderboard(USERNAME);
    expect(lb.status).toBe(200);
    const entries = (lb.data as { leaderboard: unknown[] }).leaderboard;
    expect(entries.length).toBe(0);
  });

  // ------------------------------------------------------------------
  // Action dispatch isolation
  // ------------------------------------------------------------------
  it("SRX tick + action dispatches correctly via playerId", async () => {
    const tick = await doTickById(srxPlayerId, USERNAME);
    expect(tick.status).toBe(200);
    const tickData = tick.data as { turnReport?: unknown };
    expect(tickData.turnReport).toBeDefined();

    const action = await doActionById(srxPlayerId, USERNAME, "end_turn");
    expect(action.status).toBe(200);
    const actionData = action.data as { success: boolean };
    expect(actionData.success).toBe(true);
  });

  it("chess action dispatches correctly via playerId", async () => {
    const action = await doActionById(chessPlayerId, USERNAME, "move", { move: "e2e4" });
    expect(action.status).toBe(200);
    const data = action.data as { success: boolean; message: string };
    expect(data.success).toBe(true);
    expect(data.message).toContain("e2e4");
  });

  it("chess action via playerId does not affect SRX game state", async () => {
    const srxStatus = await getStatus(srxPlayerId);
    expect(srxStatus.status).toBe(200);
    const srxData = srxStatus.data as Record<string, unknown>;
    expect(srxData.gameSessionId).toBe(srxSessionId);
    expect(srxData.game).toBe("srx");
    expect(srxData.army).toBeDefined();
  });
});
