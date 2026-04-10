import { describe, it, expect } from "vitest";
import {
  createInitialState, cloneState, createDeck, shuffleDeck,
  drawFromStock, drawFromDiscard, discardCard,
  knockHand, ginHand, layoffCards, passLayoff,
  startNextHand, resign, getLegalActions,
} from "@dge/ginrummy";
import { cardKey, cardFromKey, findBestMelds } from "@dge/ginrummy";
import type { GinRummyState, Card } from "@dge/ginrummy";

function c(key: string): Card { return cardFromKey(key); }
function cs(...keys: string[]): Card[] { return keys.map(c); }

const P1 = "player1";
const P2 = "player2";

// ---------------------------------------------------------------------------
// createDeck / shuffleDeck
// ---------------------------------------------------------------------------

describe("Deck utilities", () => {
  it("creates a 52-card deck", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    // All unique
    const keys = new Set(deck.map(cardKey));
    expect(keys.size).toBe(52);
  });

  it("shuffleDeck produces a permutation", () => {
    const deck = createDeck();
    const shuffled = shuffleDeck(deck, Math.random);
    expect(shuffled).toHaveLength(52);
    const origKeys = new Set(deck.map(cardKey));
    shuffled.forEach((c) => expect(origKeys.has(cardKey(c))).toBe(true));
  });
});

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe("createInitialState", () => {
  it("deals 10 cards to each player and sets up discard/stock", () => {
    const state = createInitialState(P1, P2, null, () => 0.5);
    expect(state.players[0].cards).toHaveLength(10);
    expect(state.players[1].cards).toHaveLength(10);
    expect(state.discardPile).toHaveLength(1);
    expect(state.deck).toHaveLength(31); // 52 - 10 - 10 - 1 = 31
    expect(state.currentPlayer).toBe(0);
    expect(state.phase).toBe("draw");
    expect(state.status).toBe("playing");
    expect(state.scores).toEqual([0, 0]);
    expect(state.playerIds).toEqual([P1, P2]);
  });

  it("uses matchTarget when provided", () => {
    const state = createInitialState(P1, P2, 100);
    expect(state.matchTarget).toBe(100);
  });

  it("all 52 cards are accounted for", () => {
    const state = createInitialState(P1, P2);
    const allKeys = new Set([
      ...state.players[0].cards.map(cardKey),
      ...state.players[1].cards.map(cardKey),
      ...state.discardPile.map(cardKey),
      ...state.deck.map(cardKey),
    ]);
    expect(allKeys.size).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// Draw actions
// ---------------------------------------------------------------------------

describe("drawFromStock", () => {
  it("draws a card from the stock pile", () => {
    const state = createInitialState(P1, P2);
    const result = drawFromStock(state, 0);
    expect(result.success).toBe(true);
    expect(result.state.players[0].cards).toHaveLength(11);
    expect(result.state.deck).toHaveLength(30);
    expect(result.state.phase).toBe("discard");
  });

  it("rejects if not your turn", () => {
    const state = createInitialState(P1, P2);
    const result = drawFromStock(state, 1); // P2's turn is not first
    expect(result.success).toBe(false);
  });

  it("rejects if not in draw phase", () => {
    const state = createInitialState(P1, P2);
    const after = drawFromStock(state, 0).state; // now in discard phase
    const result = drawFromStock(after, 0);
    expect(result.success).toBe(false);
  });
});

describe("drawFromDiscard", () => {
  it("takes top card from discard pile", () => {
    const state = createInitialState(P1, P2);
    const discardTop = state.discardPile[state.discardPile.length - 1];
    const result = drawFromDiscard(state, 0);
    expect(result.success).toBe(true);
    expect(result.state.players[0].cards).toHaveLength(11);
    expect(result.state.players[0].cards.some((c) => cardKey(c) === cardKey(discardTop))).toBe(true);
    expect(result.state.discardPile).toHaveLength(0);
    expect(result.state.phase).toBe("discard");
  });
});

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

describe("discardCard", () => {
  it("removes card from hand and adds to discard pile", () => {
    const state = createInitialState(P1, P2);
    const afterDraw = drawFromStock(state, 0).state;
    const cardToDiscard = afterDraw.players[0].cards[0];
    const cardStr = cardKey(cardToDiscard);
    const result = discardCard(afterDraw, 0, cardStr);
    expect(result.success).toBe(true);
    expect(result.state.players[0].cards).toHaveLength(10);
    expect(result.state.discardPile[result.state.discardPile.length - 1]).toEqual(cardToDiscard);
    expect(result.state.currentPlayer).toBe(1); // switched to P2
    expect(result.state.phase).toBe("draw");
  });

  it("rejects if card not in hand", () => {
    const state = createInitialState(P1, P2);
    const afterDraw = drawFromStock(state, 0).state;
    const result = discardCard(afterDraw, 0, "??");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Knock
// ---------------------------------------------------------------------------

describe("knockHand", () => {
  it("allows knock when deadwood <= 10", () => {
    // Build a state where P1 has 10 deadwood after discarding the right card
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // Give P1 a hand with 10 melded + 1 card with value ≤ 10 to discard
    s.players[0].cards = [
      ...cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H"), // 9-card run = 0 DW
      c("KH"), // extra card to discard (value=10)
      c("10H"), // will be drawn (we add it as 11th)
    ];
    s.phase = "discard";
    // Try to knock by discarding KH (remaining 10 cards: run 9 + 10H → 10 DW)
    const result = knockHand(s, 0, "KH");
    expect(result.success).toBe(true);
    expect(result.state.phase).toBe("layoff");
    expect(result.state.knockerIdx).toBe(0);
    expect(result.state.currentPlayer).toBe(1); // defender's turn
  });

  it("rejects knock when deadwood > 10", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // Give P1 a hand with high deadwood
    s.players[0].cards = cs("2H", "4D", "6C", "8S", "10H", "QD", "KC", "AS", "3H", "5D", "7C");
    s.phase = "discard";
    const result = knockHand(s, 0, "7C"); // remaining has lots of deadwood
    // Check: depends on actual cards — if all unrelated, deadwood > 10
    // All remaining after discarding 7C: 2H(2)+4D(4)+6C(6)+8S(8)+10H(10)+QD(10)+KC(10)+AS(1)+3H(3)+5D(5) = 59 DW
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gin
// ---------------------------------------------------------------------------

describe("ginHand", () => {
  it("allows gin when 0 deadwood after discarding", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // Give P1 a gin hand: two complete sets + discard card
    s.players[0].cards = [
      ...cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H"),
      c("JH"), // the card to gin-discard
    ];
    s.phase = "discard";
    const result = ginHand(s, 0, "JH");
    expect(result.success).toBe(true);
    expect(result.state.handResult?.isGin).toBe(true);
    expect(result.state.handResult?.winner).toBe(0);
    expect(result.state.handResult?.points).toBeGreaterThan(25);
  });

  it("rejects gin when deadwood > 0 after discarding", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.players[0].cards = cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H", "KC");
    s.phase = "discard";
    // Discard 10H → remaining has AH-9H run (0 dw) + KC(10 dw) → not gin
    const result = ginHand(s, 0, "10H");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layoff
// ---------------------------------------------------------------------------

describe("layoffCards + passLayoff", () => {
  it("defender can lay off matching cards", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // Set up a knocked state
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "KH", "QH"); // knocker
    s.players[1].cards = cs("7S", "AH", "2H", "3H", "4H", "5H", "6D", "8C", "9S", "10D"); // defender has 7S
    s.currentPlayer = 1; // defender's turn

    const result = layoffCards(s, 1, [{ card: "7S", meldIndex: 0 }]);
    expect(result.success).toBe(true);
    // 7S should be added to meld[0]
    expect(result.state.knockerMelds).toBeNull(); // melds consumed by scoring
    expect(result.state.handResult).not.toBeNull();
  });

  it("passLayoff immediately scores the hand", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH"); // 1 DW
    s.players[1].cards = cs("2D", "3D", "4D", "5D", "6D", "7D", "8D", "9D", "10D", "2H"); // defender
    s.currentPlayer = 1;

    const result = passLayoff(s, 1);
    expect(result.success).toBe(true);
    expect(result.state.handResult).not.toBeNull();
    expect(result.state.scores[0] + result.state.scores[1]).toBeGreaterThan(0);
  });

  it("detects undercut: defender deadwood <= knocker deadwood", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    // Knocker has 10 DW, defender has 5 DW
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "KH"); // 10 DW (K=10)
    s.players[1].cards = cs("2D", "3D", "4D", "5D", "6D", "7S", "8C", "9C", "3H", "AH"); // best DW = low
    s.currentPlayer = 1;

    // Force defender to have very low DW
    s.players[1].cards = [
      ...cs("2D", "3D", "4D"), // run 0 DW
      ...cs("5H", "5D", "5C"), // set 0 DW
      c("AH"), // 1 DW
    ];

    const result = passLayoff(s, 1);
    expect(result.success).toBe(true);
    const hr = result.state.handResult!;
    // knocker DW=10, defender DW=1 → undercut! defender wins 10-1+25=34 pts
    expect(hr.isUndercut).toBe(true);
    expect(hr.winner).toBe(1); // defender wins
    expect(hr.points).toBe(34);
  });
});

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------

describe("Match scoring", () => {
  it("single-hand mode: sets status to hand_complete after scoring", () => {
    const state = createInitialState(P1, P2, null);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH"); // 1 DW
    s.players[1].cards = cs("KH", "QD", "JC", "10S", "9H", "8D", "7S", "6C", "5H", "4D"); // high DW
    s.currentPlayer = 1;

    const result = passLayoff(s, 1);
    expect(result.state.status).toBe("hand_complete");
    expect(result.state.winner).toBe(0);
  });

  it("match mode: continues to hand_over when target not reached", () => {
    const state = createInitialState(P1, P2, 100);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH"); // 1 DW
    s.players[1].cards = cs("KH", "QD", "JC", "10S", "9H", "8D", "7S", "6C", "5H", "4D");
    s.currentPlayer = 1;

    const result = passLayoff(s, 1);
    // Points won should be < 100
    expect(result.state.status).toBe("playing");
    expect(result.state.phase).toBe("hand_over");
  });

  it("match mode: completes match when score reaches target", () => {
    const state = createInitialState(P1, P2, 10);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[0].cards = cs("7H", "7D", "7C", "AH"); // 1 DW
    s.players[1].cards = cs("KH", "QD", "JC", "10S", "9H", "8D", "7S", "6C", "5H", "4D"); // high DW
    s.currentPlayer = 1;

    const result = passLayoff(s, 1);
    expect(result.state.status).toBe("match_complete");
    expect(result.state.winner).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// startNextHand
// ---------------------------------------------------------------------------

describe("startNextHand", () => {
  it("re-deals a fresh hand", () => {
    const state = createInitialState(P1, P2, 100);
    const s = cloneState(state);
    s.phase = "hand_over";
    s.scores = [5, 0];
    s.handsWon = [1, 0];
    s.handNumber = 1;

    const result = startNextHand(s);
    expect(result.success).toBe(true);
    expect(result.state.handNumber).toBe(2);
    expect(result.state.phase).toBe("draw");
    expect(result.state.players[0].cards).toHaveLength(10);
    expect(result.state.players[1].cards).toHaveLength(10);
    expect(result.state.knockerMelds).toBeNull();
    expect(result.state.handResult).toBeNull();
  });

  it("rejects if hand not over", () => {
    const state = createInitialState(P1, P2);
    const result = startNextHand(state);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resign
// ---------------------------------------------------------------------------

describe("resign", () => {
  it("sets winner to opponent", () => {
    const state = createInitialState(P1, P2);
    const result = resign(state, 0);
    expect(result.winner).toBe(1);
    expect(result.status).toBe("resigned");
    expect(result.phase).toBe("match_over");
  });

  it("works for player 1 resigning", () => {
    const state = createInitialState(P1, P2);
    const result = resign(state, 1);
    expect(result.winner).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getLegalActions
// ---------------------------------------------------------------------------

describe("getLegalActions", () => {
  it("returns draw actions in draw phase", () => {
    const state = createInitialState(P1, P2);
    const actions = getLegalActions(state, 0);
    const actionNames = actions.map((a) => a.action);
    expect(actionNames).toContain("draw_stock");
    expect(actionNames).toContain("draw_discard");
  });

  it("returns discard actions in discard phase", () => {
    const state = createInitialState(P1, P2);
    const afterDraw = drawFromStock(state, 0).state;
    const actions = getLegalActions(afterDraw, 0);
    expect(actions.some((a) => a.action === "discard")).toBe(true);
  });

  it("includes knock when deadwood <= 10", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    // Give P1 a hand where discarding KC gives ≤10 DW
    s.players[0].cards = [
      ...cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H"),
      c("KC"),
      c("10H"),
    ];
    s.phase = "discard";
    const actions = getLegalActions(s, 0);
    expect(actions.some((a) => a.action === "knock")).toBe(true);
  });

  it("includes gin when deadwood = 0", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.players[0].cards = [
      ...cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H"),
      c("JH"),
    ];
    s.phase = "discard";
    const actions = getLegalActions(s, 0);
    expect(actions.some((a) => a.action === "gin")).toBe(true);
  });

  it("returns empty when not your turn", () => {
    const state = createInitialState(P1, P2);
    const actions = getLegalActions(state, 1); // P1's turn
    expect(actions).toHaveLength(0);
  });

  it("returns layoff options in layoff phase", () => {
    const state = createInitialState(P1, P2);
    const s = cloneState(state);
    s.phase = "layoff";
    s.knockerIdx = 0;
    s.knockerMelds = [cs("7H", "7D", "7C")];
    s.players[1].cards = cs("7S", "AH", "2D", "3C", "4S", "5H", "6D", "8C", "9S", "10D");
    s.currentPlayer = 1;
    const actions = getLegalActions(s, 1);
    expect(actions.some((a) => a.action === "pass_layoff")).toBe(true);
    expect(actions.some((a) => a.action === "layoff")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full hand simulation
// ---------------------------------------------------------------------------

describe("Full hand simulation", () => {
  it("plays through a complete hand without errors", () => {
    let state = createInitialState(P1, P2, null, () => 0.3);
    let moves = 0;

    while (state.status === "playing" && moves < 200) {
      const actions = getLegalActions(state, state.currentPlayer);
      if (actions.length === 0) break;

      // Pick first action
      const { action, params } = actions[0];
      if (action === "draw_stock") {
        const r = drawFromStock(state, state.currentPlayer);
        if (!r.success) break;
        state = r.state;
      } else if (action === "draw_discard") {
        const r = drawFromDiscard(state, state.currentPlayer);
        if (!r.success) break;
        state = r.state;
      } else if (action === "discard") {
        const r = discardCard(state, state.currentPlayer, params.card as string);
        if (!r.success) break;
        state = r.state;
      } else if (action === "knock") {
        const r = knockHand(state, state.currentPlayer, params.card as string);
        if (!r.success) break;
        state = r.state;
      } else if (action === "gin") {
        const r = ginHand(state, state.currentPlayer, params.card as string);
        if (!r.success) break;
        state = r.state;
      } else if (action === "layoff") {
        const r = layoffCards(state, state.currentPlayer, params.layoffs as Array<{card: string; meldIndex: number}>);
        if (!r.success) break;
        state = r.state;
      } else if (action === "pass_layoff") {
        const r = passLayoff(state, state.currentPlayer);
        if (!r.success) break;
        state = r.state;
      }
      moves++;
    }

    // Game should have ended (draw, hand_complete, or knock/gin resolved)
    expect(["hand_complete", "draw", "match_complete"]).toContain(state.status);
  });
});
