/**
 * Unit tests for the AI difficulty profile system.
 * Covers @dge/shared types, CHESS_DIFFICULTY_PROFILE, GINRUMMY_DIFFICULTY_PROFILE,
 * and getGinRummyAIMove / getChessAIMove accepting a tier parameter.
 */
import { describe, it, expect } from "vitest";
import { CHESS_DIFFICULTY_PROFILE, getChessAIMove } from "@dge/chess";
import {
  GINRUMMY_DIFFICULTY_PROFILE,
  getGinRummyAIMove,
  type GinAiBehavior,
} from "@dge/ginrummy";
import { createInitialState as createChessState, cloneState as cloneChessState } from "@dge/chess";
import { createInitialState as createGinState, drawFromStock } from "@dge/ginrummy";

const P1 = "player1";
const P2 = "player2";

// ---------------------------------------------------------------------------
// Chess difficulty profile structure
// ---------------------------------------------------------------------------

describe("CHESS_DIFFICULTY_PROFILE", () => {
  it("defines all three tiers", () => {
    expect(CHESS_DIFFICULTY_PROFILE.easy).toBeDefined();
    expect(CHESS_DIFFICULTY_PROFILE.medium).toBeDefined();
    expect(CHESS_DIFFICULTY_PROFILE.hard).toBeDefined();
  });

  it("easy has shorter time limit than medium", () => {
    const easy = CHESS_DIFFICULTY_PROFILE.easy.mctsConfig?.timeLimitMs ?? 0;
    const medium = CHESS_DIFFICULTY_PROFILE.medium.mctsConfig?.timeLimitMs ?? 0;
    expect(easy).toBeLessThan(medium);
  });

  it("medium has shorter time limit than hard", () => {
    const medium = CHESS_DIFFICULTY_PROFILE.medium.mctsConfig?.timeLimitMs ?? 0;
    const hard = CHESS_DIFFICULTY_PROFILE.hard.mctsConfig?.timeLimitMs ?? 0;
    expect(medium).toBeLessThan(hard);
  });

  it("all tiers have a human-readable label", () => {
    expect(CHESS_DIFFICULTY_PROFILE.easy.label).toBeTruthy();
    expect(CHESS_DIFFICULTY_PROFILE.medium.label).toBeTruthy();
    expect(CHESS_DIFFICULTY_PROFILE.hard.label).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Gin Rummy difficulty profile structure
// ---------------------------------------------------------------------------

describe("GINRUMMY_DIFFICULTY_PROFILE", () => {
  it("defines all three tiers", () => {
    expect(GINRUMMY_DIFFICULTY_PROFILE.easy).toBeDefined();
    expect(GINRUMMY_DIFFICULTY_PROFILE.medium).toBeDefined();
    expect(GINRUMMY_DIFFICULTY_PROFILE.hard).toBeDefined();
  });

  it("easy has trackDiscards = false", () => {
    const b = GINRUMMY_DIFFICULTY_PROFILE.easy.behavior as GinAiBehavior;
    expect(b.trackDiscards).toBe(false);
    expect(b.inferOpponentMelds).toBe(false);
  });

  it("medium has trackDiscards = true but inferOpponentMelds = false", () => {
    const b = GINRUMMY_DIFFICULTY_PROFILE.medium.behavior as GinAiBehavior;
    expect(b.trackDiscards).toBe(true);
    expect(b.inferOpponentMelds).toBe(false);
  });

  it("hard has both trackDiscards and inferOpponentMelds = true", () => {
    const b = GINRUMMY_DIFFICULTY_PROFILE.hard.behavior as GinAiBehavior;
    expect(b.trackDiscards).toBe(true);
    expect(b.inferOpponentMelds).toBe(true);
  });

  it("hard has longer time budget than easy", () => {
    const easy = GINRUMMY_DIFFICULTY_PROFILE.easy.mctsConfig?.timeLimitMs ?? 0;
    const hard = GINRUMMY_DIFFICULTY_PROFILE.hard.mctsConfig?.timeLimitMs ?? 0;
    expect(hard).toBeGreaterThan(easy);
  });
});

// ---------------------------------------------------------------------------
// getChessAIMove accepts difficulty tier
// ---------------------------------------------------------------------------

describe("getChessAIMove with difficulty tier", () => {
  it("returns a valid move with easy tier", async () => {
    const state = createChessState(P1, P2);
    const move = await getChessAIMove(state, CHESS_DIFFICULTY_PROFILE.easy);
    expect(move).toBeDefined();
    expect(move!.action).toBe("move");
  }, 5000);

  it("returns null when game is already over regardless of tier", async () => {
    const state = createChessState(P1, P2);
    state.status = "checkmate";
    const move = await getChessAIMove(state, CHESS_DIFFICULTY_PROFILE.hard);
    expect(move).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getGinRummyAIMove accepts difficulty tier
// ---------------------------------------------------------------------------

describe("getGinRummyAIMove with difficulty tier", () => {
  it("returns a valid draw action with easy tier", async () => {
    const state = createGinState(P1, P2, null, () => 0.5);
    const move = await getGinRummyAIMove(state, P1, GINRUMMY_DIFFICULTY_PROFILE.easy);
    expect(move).not.toBeNull();
    expect(["draw_stock", "draw_discard"]).toContain(move!.action);
  }, 10000);

  it("returns a valid discard action with hard tier", async () => {
    const state = createGinState(P1, P2, null, () => 0.5);
    const afterDraw = drawFromStock(state, 0).state;
    const move = await getGinRummyAIMove(afterDraw, P1, GINRUMMY_DIFFICULTY_PROFILE.hard);
    expect(move).not.toBeNull();
    expect(["discard", "knock", "gin"]).toContain(move!.action);
  }, 15000);

  it("returns null for non-playing state with any tier", async () => {
    const state = createGinState(P1, P2);
    state.status = "hand_complete";
    const move = await getGinRummyAIMove(state, P1, GINRUMMY_DIFFICULTY_PROFILE.medium);
    expect(move).toBeNull();
  }, 5000);
});
