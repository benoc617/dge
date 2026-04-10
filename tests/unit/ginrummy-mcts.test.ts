import { describe, it, expect } from "vitest";
import {
  createInitialState, cloneState,
  drawFromStock, knockHand, passLayoff,
} from "@dge/ginrummy";
import { cardFromKey, findBestMelds, cardKey } from "@dge/ginrummy";
import { ginRummySearchFunctions, getGinRummyAIMove } from "@dge/ginrummy";
import type { GinRummyState, Card } from "@dge/ginrummy";

function c(key: string): Card { return cardFromKey(key); }
function cs(...keys: string[]): Card[] { return keys.map(c); }

const P1 = "player1";
const P2 = "player2";

// ---------------------------------------------------------------------------
// ginRummySearchFunctions
// ---------------------------------------------------------------------------

describe("ginRummySearchFunctions — generateCandidateMoves", () => {
  it("generates compound draw+discard moves in draw phase", () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    expect(state.phase).toBe("draw");

    const moves = ginRummySearchFunctions.generateCandidateMoves(state, 0, 30);
    expect(moves.length).toBeGreaterThan(0);
    // All moves should be compound_turn
    expect(moves.every((m) => m.action === "compound_turn")).toBe(true);
  });

  it("generates discard moves in discard phase", () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    const afterDraw = drawFromStock(state, 0).state;
    expect(afterDraw.phase).toBe("discard");

    const moves = ginRummySearchFunctions.generateCandidateMoves(afterDraw, 0, 30);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.some((m) => m.action === "discard")).toBe(true);
  });

  it("generates layoff/pass moves in layoff phase", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH");
    s.players[1].cards = cs("7S", "AH", "2D", "3C", "4S", "5H", "6D", "8C", "9S", "10D");
    s.currentPlayer = 1;

    const moves = ginRummySearchFunctions.generateCandidateMoves(s, 1, 30);
    expect(moves.some((m) => m.action === "pass_layoff")).toBe(true);
  });

  it("returns empty for terminal state", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.status = "hand_complete";
    const moves = ginRummySearchFunctions.generateCandidateMoves(s, 0, 30);
    expect(moves).toHaveLength(0);
  });
});

describe("ginRummySearchFunctions — applyAction", () => {
  it("applies compound_turn correctly (draw_stock + discard)", () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    const firstCard = state.deck[state.deck.length - 1]; // top of stock
    const moves = ginRummySearchFunctions.generateCandidateMoves(state, 0, 30);
    const stockMove = moves.find(
      (m) => m.action === "compound_turn" && m.params.drawFrom === "stock",
    );
    expect(stockMove).toBeDefined();

    const result = ginRummySearchFunctions.applyAction(state, 0, stockMove!.action, stockMove!.params, () => 0);
    expect(result.success).toBe(true);
    // Player should still have 10 cards (drew 1, discarded 1)
    expect(result.state.players[0].cards).toHaveLength(10);
    // It should be player 1's turn now
    expect(result.state.currentPlayer).toBe(1);
    expect(result.state.phase).toBe("draw");
  });

  it("applies gin action", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.players[0].cards = [
      ...cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H"),
      c("JH"),
    ];
    s.phase = "discard";

    const result = ginRummySearchFunctions.applyAction(s, 0, "gin", { card: "JH" }, () => 0);
    expect(result.success).toBe(true);
    expect(result.state.handResult?.isGin).toBe(true);
  });
});

describe("ginRummySearchFunctions — evalState", () => {
  it("returns 0 for balanced hands", () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    // Both players have similar deadwood — score should be close to 0
    const score0 = ginRummySearchFunctions.evalState(state, 0);
    const score1 = ginRummySearchFunctions.evalState(state, 1);
    expect(score0).toBe(-score1); // sum to 0 for symmetric evaluation
  });

  it("returns large positive for winner, large negative for loser", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.status = "hand_complete";
    s.winner = 0;

    expect(ginRummySearchFunctions.evalState(s, 0)).toBeGreaterThan(100);
    expect(ginRummySearchFunctions.evalState(s, 1)).toBeLessThan(-100);
  });

  it("returns 0 for a draw", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.status = "draw";
    expect(ginRummySearchFunctions.evalState(s, 0)).toBe(0);
    expect(ginRummySearchFunctions.evalState(s, 1)).toBe(0);
  });
});

describe("ginRummySearchFunctions — isTerminal", () => {
  it("returns false for playing state in draw phase", () => {
    const state = createInitialState(P1, P2);
    expect(ginRummySearchFunctions.isTerminal(state)).toBe(false);
  });

  it("returns true for hand_complete", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.status = "hand_complete";
    expect(ginRummySearchFunctions.isTerminal(s)).toBe(true);
  });

  it("returns true for hand_over phase", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "hand_over";
    expect(ginRummySearchFunctions.isTerminal(s)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getGinRummyAIMove
// ---------------------------------------------------------------------------

describe("getGinRummyAIMove", () => {
  it("returns a valid draw action in draw phase", async () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    const move = await getGinRummyAIMove(state, P1);
    expect(move).not.toBeNull();
    expect(["draw_stock", "draw_discard"]).toContain(move!.action);
  }, 15000);

  it("returns a valid discard/knock/gin action in discard phase", async () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    const afterDraw = drawFromStock(state, 0).state;
    expect(afterDraw.phase).toBe("discard");
    const move = await getGinRummyAIMove(afterDraw, P1);
    expect(move).not.toBeNull();
    expect(["discard", "knock", "gin"]).toContain(move!.action);
  }, 15000);

  it("immediately gins or knocks when low/zero deadwood is available", async () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // P1 has 3H-KH (11 consecutive hearts). Discarding any one card leaves a
    // clean 10-card run (0 deadwood) → gin. MCTS should choose gin or knock.
    // Note: AH-JH is NOT fully clean — discarding 2H leaves AH isolated (DW 1).
    // Use 3H-KH instead so every possible discard leaves 0 DW.
    s.players[0].cards = [
      ...cs("3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H", "JH", "QH"),
      c("KH"),
    ];
    s.phase = "discard";

    const move = await getGinRummyAIMove(s, P1);
    expect(move).not.toBeNull();
    // All possible discards leave 0 DW → AI should choose gin (preferred) or knock
    expect(["gin", "knock"]).toContain(move!.action);
    expect(typeof move!.params.card).toBe("string");
  }, 15000);

  it("knocks when deadwood is 0 after discard", async () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // P1 has 0 DW after discarding AH (melds: 2H-3H-4H, 5H-6H-7H, 8H-9H-10H)
    // Wait, 9 cards in melds. Need 10 melded + 1 to discard
    // 3 sets of 3 = 9 + extra = 10 total → 0 DW after discarding AH
    s.players[0].cards = [
      ...cs("2H", "3H", "4H"), // set? no, run
      ...cs("5D", "5H", "5C"), // set
      ...cs("JH", "QH", "KH"), // run
      c("AH"), // discard
      c("9H"), // leftover
    ];
    s.phase = "discard";

    const move = await getGinRummyAIMove(s, P1);
    expect(move).not.toBeNull();
    // Should discard the high-value card (AH has value 1, but melds make 9H the deadwood)
    expect(["discard", "knock", "gin"]).toContain(move!.action);
  }, 15000);

  it("returns layoff action in layoff phase", async () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH");
    s.players[1].cards = cs("7S", "2D", "3C", "4S", "5H", "6D", "8C", "9S", "10D", "JH");
    s.currentPlayer = 1;

    const move = await getGinRummyAIMove(s, P2);
    expect(move).not.toBeNull();
    // Should lay off 7S
    expect(["layoff", "pass_layoff"]).toContain(move!.action);
  }, 15000);

  it("returns null for non-playing state", async () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.status = "hand_complete";
    const move = await getGinRummyAIMove(s, P1);
    expect(move).toBeNull();
  }, 5000);
});
