import { describe, it, expect } from "vitest";
import {
  cardValue, rankIndex, cardKey, cardFromKey,
  isValidSet, isValidRun, isValidMeld,
  generateAllPossibleMelds, findBestMelds, calculateDeadwood,
  isValidMeldArrangement, findLayoffOptions,
} from "@dge/ginrummy";
import type { Card } from "@dge/ginrummy";

function c(key: string): Card { return cardFromKey(key); }
function cs(...keys: string[]): Card[] { return keys.map(c); }

// ---------------------------------------------------------------------------
// Card utilities
// ---------------------------------------------------------------------------

describe("Card utilities", () => {
  it("cardValue: Ace=1, numbered=face, face cards=10", () => {
    expect(cardValue(c("AH"))).toBe(1);
    expect(cardValue(c("2D"))).toBe(2);
    expect(cardValue(c("10S"))).toBe(10);
    expect(cardValue(c("JC"))).toBe(10);
    expect(cardValue(c("QH"))).toBe(10);
    expect(cardValue(c("KD"))).toBe(10);
    expect(cardValue(c("9H"))).toBe(9);
  });

  it("rankIndex: A=0, K=12", () => {
    expect(rankIndex("A")).toBe(0);
    expect(rankIndex("K")).toBe(12);
    expect(rankIndex("10")).toBe(9);
  });

  it("cardKey round-trips correctly", () => {
    const card = c("10D");
    expect(cardKey(card)).toBe("10D");
    expect(cardFromKey("AH")).toEqual({ rank: "A", suit: "H" });
    expect(cardFromKey("10D")).toEqual({ rank: "10", suit: "D" });
    expect(cardFromKey("KS")).toEqual({ rank: "K", suit: "S" });
  });
});

// ---------------------------------------------------------------------------
// Meld validation
// ---------------------------------------------------------------------------

describe("isValidSet", () => {
  it("accepts 3-of-a-kind", () => {
    expect(isValidSet(cs("7H", "7D", "7C"))).toBe(true);
  });

  it("accepts 4-of-a-kind", () => {
    expect(isValidSet(cs("QH", "QD", "QC", "QS"))).toBe(true);
  });

  it("rejects 2 cards", () => {
    expect(isValidSet(cs("5H", "5D"))).toBe(false);
  });

  it("rejects mixed ranks", () => {
    expect(isValidSet(cs("5H", "6D", "7C"))).toBe(false);
  });

  it("rejects duplicate suits", () => {
    expect(isValidSet(cs("5H", "5H", "5D"))).toBe(false);
  });
});

describe("isValidRun", () => {
  it("accepts 3-card run", () => {
    expect(isValidRun(cs("4C", "5C", "6C"))).toBe(true);
  });

  it("accepts longer run", () => {
    expect(isValidRun(cs("9H", "10H", "JH", "QH", "KH"))).toBe(true);
  });

  it("accepts A-2-3 run", () => {
    expect(isValidRun(cs("AH", "2H", "3H"))).toBe(true);
  });

  it("rejects mixed suits", () => {
    expect(isValidRun(cs("4H", "5C", "6H"))).toBe(false);
  });

  it("rejects non-consecutive", () => {
    expect(isValidRun(cs("4H", "6H", "8H"))).toBe(false);
  });

  it("rejects only 2 cards", () => {
    expect(isValidRun(cs("4H", "5H"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Meld generation
// ---------------------------------------------------------------------------

describe("generateAllPossibleMelds", () => {
  it("finds set from 4 of same rank", () => {
    const hand = cs("7H", "7D", "7C", "7S", "AH", "2D");
    const melds = generateAllPossibleMelds(hand);
    const sets = melds.filter(m => isValidSet(m));
    // Should include 4-of-a-kind + all 3-of-a-kind combinations = 1 + 4 = 5 sets
    expect(sets.length).toBeGreaterThanOrEqual(4); // at least 4 three-card combinations
  });

  it("finds runs in a suit", () => {
    const hand = cs("4C", "5C", "6C", "7C", "AH");
    const melds = generateAllPossibleMelds(hand);
    const runs = melds.filter(m => isValidRun(m));
    // 4C-5C-6C, 5C-6C-7C, 4C-5C-6C-7C
    expect(runs.length).toBe(3);
  });

  it("returns no melds for unrelated cards", () => {
    const hand = cs("AH", "3D", "6C", "9S", "JH");
    const melds = generateAllPossibleMelds(hand);
    expect(melds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findBestMelds
// ---------------------------------------------------------------------------

describe("findBestMelds", () => {
  it("returns empty melds for empty hand", () => {
    const result = findBestMelds([]);
    expect(result.melds).toHaveLength(0);
    expect(result.deadwoodValue).toBe(0);
  });

  it("finds 0 deadwood when all cards form melds", () => {
    // Two sets
    const hand = cs("7H", "7D", "7C", "KH", "KD", "KC");
    const result = findBestMelds(hand);
    expect(result.deadwoodValue).toBe(0);
    expect(result.melds).toHaveLength(2);
  });

  it("minimizes deadwood with overlapping meld options", () => {
    // 7H 7D 7C = set (value 21), 7H 8H 9H = run (value 24)
    // Best: use the set + run separately if no overlap, or pick the better
    const hand = cs("7H", "7D", "7C", "8H", "9H", "AH");
    const result = findBestMelds(hand);
    // Best: 7H-7D-7C (set) + 8H-9H can't form meld, OR 7H-8H-9H (run) + 7D-7C can't form meld
    // Set: deadwood = 8+9+1=18; Run: deadwood = 7+7+1=15
    // Should prefer run + 7D + 7C (deadwood = 7+7+1 = 15) vs set + 8H+9H (deadwood = 8+9+1 = 18)
    // So best: run 7H-8H-9H, deadwood = 7D+7C+AH = 7+7+1 = 15
    expect(result.deadwoodValue).toBe(15);
  });

  it("finds the optimal arrangement for a gin hand", () => {
    // 10 cards that form 2 complete melds (0 deadwood)
    const hand = cs("AH", "2H", "3H", "4H", "5H", "6H", "7H", "8H", "9H", "10H");
    const result = findBestMelds(hand);
    expect(result.deadwoodValue).toBe(0);
  });

  it("handles face card deadwood correctly", () => {
    const hand = cs("KH", "QD", "JC");
    const result = findBestMelds(hand);
    // No melds possible, deadwood = 10+10+10 = 30
    expect(result.deadwoodValue).toBe(30);
    expect(result.melds).toHaveLength(0);
  });

  it("prefers partial set over complete isolation", () => {
    // 3 kings = set, remaining junk = 2+4+6+8+3+5+7 = 35
    const hand = cs("KH", "KD", "KC", "2H", "4D", "6C", "8S", "3H", "5D", "7C");
    const result = findBestMelds(hand);
    expect(result.deadwoodValue).toBe(35); // Kings melded; non-K deadwood = 35
    expect(result.melds.some(m => m.every(c => c.rank === "K"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateDeadwood
// ---------------------------------------------------------------------------

describe("calculateDeadwood", () => {
  it("calculates deadwood for cards not in melds", () => {
    const hand = cs("7H", "7D", "7C", "KH", "AH");
    const melds = [cs("7H", "7D", "7C")];
    expect(calculateDeadwood(hand, melds)).toBe(11); // K(10) + A(1) = 11
  });

  it("returns full hand value with no melds", () => {
    const hand = cs("KH", "QD", "JC", "AH");
    expect(calculateDeadwood(hand, [])).toBe(31); // 10+10+10+1
  });
});

// ---------------------------------------------------------------------------
// isValidMeldArrangement
// ---------------------------------------------------------------------------

describe("isValidMeldArrangement", () => {
  it("accepts a valid arrangement", () => {
    const hand = cs("7H", "7D", "7C", "4H", "5H", "6H");
    const melds = [cs("7H", "7D", "7C"), cs("4H", "5H", "6H")];
    expect(isValidMeldArrangement(hand, melds)).toBe(true);
  });

  it("rejects a card not in hand", () => {
    const hand = cs("7H", "7D", "7C");
    const melds = [cs("7H", "7D", "8C")]; // 8C not in hand
    expect(isValidMeldArrangement(hand, melds)).toBe(false);
  });

  it("rejects duplicate card usage", () => {
    const hand = cs("7H", "7D", "7C", "8H");
    const melds = [cs("7H", "7D", "7C"), cs("7H", "8H", "9H")]; // 7H used twice
    expect(isValidMeldArrangement(hand, melds)).toBe(false);
  });

  it("rejects invalid meld", () => {
    const hand = cs("7H", "8H", "10H");
    const melds = [cs("7H", "8H", "10H")]; // skip 9H — not consecutive
    expect(isValidMeldArrangement(hand, melds)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findLayoffOptions
// ---------------------------------------------------------------------------

describe("findLayoffOptions", () => {
  it("finds set extension", () => {
    const knockerMelds = [cs("7H", "7D", "7C")];
    const defenderCards = cs("7S", "AH");
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts.some(o => cardKey(o.card) === "7S" && o.meldIndex === 0)).toBe(true);
  });

  it("finds run extension at high end", () => {
    const knockerMelds = [cs("4H", "5H", "6H")];
    const defenderCards = cs("7H", "AH");
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts.some(o => cardKey(o.card) === "7H" && o.meldIndex === 0 && o.position === "after")).toBe(true);
  });

  it("finds run extension at low end", () => {
    const knockerMelds = [cs("5H", "6H", "7H")];
    const defenderCards = cs("4H", "AH");
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts.some(o => cardKey(o.card) === "4H" && o.meldIndex === 0 && o.position === "before")).toBe(true);
  });

  it("does not find extension for full set (4 cards)", () => {
    const knockerMelds = [cs("7H", "7D", "7C", "7S")];
    const defenderCards = cs("7H");
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts).toHaveLength(0);
  });

  it("does not find extension for wrong suit on run", () => {
    const knockerMelds = [cs("4H", "5H", "6H")];
    const defenderCards = cs("7D"); // right rank, wrong suit
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts).toHaveLength(0);
  });

  it("returns empty when no layoff possible", () => {
    const knockerMelds = [cs("QH", "QD", "QC")];
    const defenderCards = cs("2H", "5C");
    const opts = findLayoffOptions(defenderCards, knockerMelds);
    expect(opts).toHaveLength(0);
  });
});
