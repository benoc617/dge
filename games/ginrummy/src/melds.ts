/**
 * Gin Rummy meld detection and deadwood calculation.
 *
 * All functions are pure (no I/O). The meld optimizer uses backtracking over
 * all non-overlapping combinations of valid melds to find the arrangement that
 * minimizes deadwood.
 */

import type { Card, Meld, MeldResult, LayoffOption, Rank } from "./types";

// ---------------------------------------------------------------------------
// Card value / rank utilities
// ---------------------------------------------------------------------------

const RANK_ORDER: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

export function cardValue(card: Card): number {
  if (card.rank === "A") return 1;
  if (card.rank === "J" || card.rank === "Q" || card.rank === "K") return 10;
  return parseInt(card.rank, 10);
}

export function rankIndex(rank: Rank): number {
  return RANK_ORDER.indexOf(rank);
}

export function cardKey(card: Card): string {
  return `${card.rank}${card.suit}`;
}

export function cardFromKey(key: string): Card {
  // Last char is suit; everything before is rank
  const suit = key[key.length - 1] as import("./types").Suit;
  const rank = key.slice(0, -1) as Rank;
  return { suit, rank };
}

// ---------------------------------------------------------------------------
// Meld validation
// ---------------------------------------------------------------------------

export function isValidSet(cards: Card[]): boolean {
  if (cards.length < 3 || cards.length > 4) return false;
  const rank = cards[0].rank;
  const suits = new Set(cards.map((c) => c.suit));
  return cards.every((c) => c.rank === rank) && suits.size === cards.length;
}

export function isValidRun(cards: Card[]): boolean {
  if (cards.length < 3) return false;
  const suit = cards[0].suit;
  if (!cards.every((c) => c.suit === suit)) return false;
  const indices = cards.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return false;
  }
  return true;
}

export function isValidMeld(cards: Card[]): boolean {
  return isValidSet(cards) || isValidRun(cards);
}

// ---------------------------------------------------------------------------
// Meld generation (all possible melds from a given hand)
// ---------------------------------------------------------------------------

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  return [...withFirst, ...withoutFirst];
}

/** Generate every valid meld (set or run) that can be formed from the given cards. */
export function generateAllPossibleMelds(hand: Card[]): Meld[] {
  const melds: Meld[] = [];

  // Sets: group by rank
  const byRank = new Map<Rank, Card[]>();
  for (const c of hand) {
    const group = byRank.get(c.rank) ?? [];
    group.push(c);
    byRank.set(c.rank, group);
  }
  for (const [, cards] of byRank) {
    if (cards.length >= 3) {
      melds.push(...combinations(cards, 3));
      if (cards.length === 4) melds.push([...cards]);
    }
  }

  // Runs: group by suit, find consecutive sequences of length >= 3
  const bySuit = new Map<string, Card[]>();
  for (const c of hand) {
    const group = bySuit.get(c.suit) ?? [];
    group.push(c);
    bySuit.set(c.suit, group);
  }
  for (const [, cards] of bySuit) {
    if (cards.length < 3) continue;
    const sorted = [...cards].sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));
    for (let start = 0; start < sorted.length - 2; start++) {
      for (let end = start + 2; end < sorted.length; end++) {
        const subset = sorted.slice(start, end + 1);
        const consecutive = subset.every(
          (c, i) => i === 0 || rankIndex(c.rank) === rankIndex(subset[i - 1].rank) + 1,
        );
        if (consecutive) melds.push(subset);
      }
    }
  }

  return melds;
}

// ---------------------------------------------------------------------------
// Meld optimizer — backtracking search over non-overlapping meld subsets
// ---------------------------------------------------------------------------

function deadwoodSum(cards: Card[]): number {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

/**
 * Find the meld arrangement for `hand` that minimizes deadwood.
 * Uses backtracking over all combinations of non-overlapping valid melds.
 */
export function findBestMelds(hand: Card[]): MeldResult {
  if (hand.length === 0) {
    return { melds: [], deadwood: [], deadwoodValue: 0 };
  }

  const possibleMelds = generateAllPossibleMelds(hand);

  let bestDeadwood = deadwoodSum(hand);
  let bestMelds: Meld[] = [];
  let bestDeadwoodCards = [...hand];

  function search(fromIdx: number, usedKeys: Set<string>, chosen: Meld[]) {
    const unusedCards = hand.filter((c) => !usedKeys.has(cardKey(c)));
    const dw = deadwoodSum(unusedCards);
    if (dw < bestDeadwood) {
      bestDeadwood = dw;
      bestMelds = chosen.map((m) => [...m]);
      bestDeadwoodCards = unusedCards;
    }
    if (bestDeadwood === 0) return; // can't do better

    for (let i = fromIdx; i < possibleMelds.length; i++) {
      const meld = possibleMelds[i];
      const meldKeys = meld.map(cardKey);
      if (meldKeys.some((k) => usedKeys.has(k))) continue;
      for (const k of meldKeys) usedKeys.add(k);
      chosen.push(meld);
      search(i + 1, usedKeys, chosen);
      chosen.pop();
      for (const k of meldKeys) usedKeys.delete(k);
    }
  }

  search(0, new Set(), []);

  return {
    melds: bestMelds,
    deadwood: bestDeadwoodCards,
    deadwoodValue: bestDeadwood,
  };
}

// ---------------------------------------------------------------------------
// Utility: deadwood with a specific meld arrangement
// ---------------------------------------------------------------------------

export function calculateDeadwood(hand: Card[], melds: Meld[]): number {
  const usedKeys = new Set(melds.flat().map(cardKey));
  return hand.filter((c) => !usedKeys.has(cardKey(c))).reduce((s, c) => s + cardValue(c), 0);
}

export function isValidMeldArrangement(hand: Card[], melds: Meld[]): boolean {
  const handKeys = new Set(hand.map(cardKey));
  const usedKeys = new Set<string>();
  for (const card of melds.flat()) {
    const k = cardKey(card);
    if (!handKeys.has(k) || usedKeys.has(k)) return false;
    usedKeys.add(k);
  }
  return melds.every(isValidMeld);
}

// ---------------------------------------------------------------------------
// Layoff — find cards the defender can add to the knocker's melds
// ---------------------------------------------------------------------------

/**
 * Find all cards in `cards` that can legally be laid off on `knockerMelds`.
 * Returns one option per (card, meld) pair with valid position.
 */
export function findLayoffOptions(cards: Card[], knockerMelds: Meld[]): LayoffOption[] {
  const options: LayoffOption[] = [];

  for (const card of cards) {
    for (let mi = 0; mi < knockerMelds.length; mi++) {
      const meld = knockerMelds[mi];

      if (isValidSet(meld) && meld.length < 4) {
        // Set extension: same rank, different suit
        if (card.rank === meld[0].rank) {
          const existingSuits = new Set(meld.map((c) => c.suit));
          if (!existingSuits.has(card.suit)) {
            options.push({ card, meldIndex: mi, position: "after" });
          }
        }
      } else if (isValidRun(meld)) {
        // Run extension: same suit, adjacent rank at either end
        const sorted = [...meld].sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));
        const suit = meld[0].suit;
        if (card.suit === suit) {
          const lowIdx = rankIndex(sorted[0].rank);
          const highIdx = rankIndex(sorted[sorted.length - 1].rank);
          const cardIdx = rankIndex(card.rank);
          if (cardIdx === highIdx + 1) options.push({ card, meldIndex: mi, position: "after" });
          if (cardIdx === lowIdx - 1) options.push({ card, meldIndex: mi, position: "before" });
        }
      }
    }
  }

  return options;
}
