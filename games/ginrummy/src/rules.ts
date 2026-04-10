/**
 * Gin Rummy game rules and state transitions.
 *
 * All functions are pure (no I/O) and return a result object with the
 * new state. State mutations are never in place; cloneState() is used.
 */

import type {
  GinRummyState, Card, Suit, Rank, Meld, HandResult, GamePhase,
} from "./types";
import {
  cardKey, findBestMelds, calculateDeadwood,
  isValidMeldArrangement, findLayoffOptions,
} from "./melds";

export const SUITS: Suit[] = ["H", "D", "C", "S"];
export const RANKS: Rank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

// ---------------------------------------------------------------------------
// Deck utilities
// ---------------------------------------------------------------------------

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

export function shuffleDeck(deck: Card[], rng: () => number): Card[] {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cloneState(s: GinRummyState): GinRummyState {
  return JSON.parse(JSON.stringify(s)) as GinRummyState;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Deal a fresh hand. 10 cards to each player, remainder becomes stock with
 * the top card flipped to start the discard pile.
 *
 * @param matchTarget null for single-hand; positive int for match-to-N scoring.
 */
export function createInitialState(
  p1Id: string,
  p2Id: string,
  matchTarget: number | null = null,
  rng: () => number = Math.random,
): GinRummyState {
  const deck = shuffleDeck(createDeck(), rng);
  const p1Cards = deck.slice(0, 10);
  const p2Cards = deck.slice(10, 20);
  const remaining = deck.slice(20);
  // Flip top card of remaining to start discard pile
  const discardCard = remaining[remaining.length - 1];
  const stockPile = remaining.slice(0, remaining.length - 1);

  return {
    deck: stockPile,
    discardPile: [discardCard],
    players: [{ cards: p1Cards }, { cards: p2Cards }],
    playerIds: [p1Id, p2Id],
    currentPlayer: 0,
    phase: "draw",
    knockerMelds: null,
    knockerIdx: null,
    handResult: null,
    matchTarget,
    scores: [0, 0],
    handsWon: [0, 0],
    handNumber: 1,
    status: "playing",
    winner: null,
  };
}

// ---------------------------------------------------------------------------
// Action result type
// ---------------------------------------------------------------------------

interface ActionResult {
  success: boolean;
  message: string;
  state: GinRummyState;
}

function fail(state: GinRummyState, message: string): ActionResult {
  return { success: false, message, state };
}

// ---------------------------------------------------------------------------
// Draw actions
// ---------------------------------------------------------------------------

export function drawFromStock(state: GinRummyState, playerIdx: 0 | 1): ActionResult {
  if (state.currentPlayer !== playerIdx) return fail(state, "Not your turn.");
  if (state.phase !== "draw") return fail(state, "Not in draw phase.");
  if (state.deck.length === 0) return fail(state, "Stock pile is empty.");

  const s = cloneState(state);
  const card = s.deck.pop()!;
  s.players[playerIdx].cards.push(card);
  s.phase = "discard";
  return { success: true, message: `Drew from stock.`, state: s };
}

export function drawFromDiscard(state: GinRummyState, playerIdx: 0 | 1): ActionResult {
  if (state.currentPlayer !== playerIdx) return fail(state, "Not your turn.");
  if (state.phase !== "draw") return fail(state, "Not in draw phase.");
  if (state.discardPile.length === 0) return fail(state, "Discard pile is empty.");

  const s = cloneState(state);
  const card = s.discardPile.pop()!;
  s.players[playerIdx].cards.push(card);
  s.phase = "discard";
  return { success: true, message: `Picked up ${cardKey(card)} from discard.`, state: s };
}

// ---------------------------------------------------------------------------
// Discard / Knock / Gin
// ---------------------------------------------------------------------------

/** Check whether the stock is close to exhaustion and the hand should be drawn. */
function checkStockExhaustion(s: GinRummyState): boolean {
  return s.deck.length === 0;
}

export function discardCard(
  state: GinRummyState,
  playerIdx: 0 | 1,
  cardStr: string,
): ActionResult {
  if (state.currentPlayer !== playerIdx) return fail(state, "Not your turn.");
  if (state.phase !== "discard") return fail(state, "Not in discard phase.");

  const s = cloneState(state);
  const hand = s.players[playerIdx].cards;
  const idx = hand.findIndex((c) => cardKey(c) === cardStr);
  if (idx === -1) return fail(s, `Card ${cardStr} not in hand.`);

  const [card] = hand.splice(idx, 1);
  s.discardPile.push(card);

  // Stock exhaustion → hand is a draw
  if (checkStockExhaustion(s)) {
    s.status = "draw";
    s.phase = "hand_over";
    s.handResult = null;
    return { success: true, message: "Stock exhausted — this hand is a draw.", state: s };
  }

  // Normal: switch to opponent's draw phase
  s.currentPlayer = (1 - playerIdx) as 0 | 1;
  s.phase = "draw";
  return { success: true, message: `Discarded ${cardStr}.`, state: s };
}

/**
 * Knock — discard a card and declare a knock with your meld arrangement.
 * If no `meldKeys` are provided, the server computes the optimal arrangement.
 */
export function knockHand(
  state: GinRummyState,
  playerIdx: 0 | 1,
  discardCardStr: string,
  meldKeys?: string[][],
): ActionResult {
  if (state.currentPlayer !== playerIdx) return fail(state, "Not your turn.");
  if (state.phase !== "discard") return fail(state, "Not in discard phase.");

  const s = cloneState(state);
  const hand = s.players[playerIdx].cards;
  const idx = hand.findIndex((c) => cardKey(c) === discardCardStr);
  if (idx === -1) return fail(s, `Card ${discardCardStr} not in hand.`);

  const [discardCard] = hand.splice(idx, 1);

  let melds: Meld[];
  if (meldKeys && meldKeys.length > 0) {
    // Validate provided arrangement
    melds = meldKeys.map((keys) =>
      keys.map((k) => {
        const c = hand.find((hc) => cardKey(hc) === k);
        return c;
      }).filter((c): c is Card => c !== undefined),
    );
    if (!isValidMeldArrangement(hand, melds)) {
      hand.push(discardCard); // restore
      return fail(state, "Invalid meld arrangement.");
    }
  } else {
    const result = findBestMelds(hand);
    melds = result.melds;
  }

  const deadwood = calculateDeadwood(hand, melds);
  if (deadwood > 10) {
    hand.push(discardCard); // restore
    return fail(state, `Cannot knock — deadwood is ${deadwood} (must be ≤ 10).`);
  }

  s.discardPile.push(discardCard);
  s.knockerIdx = playerIdx;
  s.knockerMelds = melds;
  s.currentPlayer = (1 - playerIdx) as 0 | 1; // defender's turn
  s.phase = "layoff";
  return { success: true, message: `Knocked with ${deadwood} deadwood.`, state: s };
}

/**
 * Gin — 0 deadwood knock. No layoff allowed; scoring is immediate.
 */
export function ginHand(
  state: GinRummyState,
  playerIdx: 0 | 1,
  discardCardStr: string,
): ActionResult {
  if (state.currentPlayer !== playerIdx) return fail(state, "Not your turn.");
  if (state.phase !== "discard") return fail(state, "Not in discard phase.");

  const s = cloneState(state);
  const hand = s.players[playerIdx].cards;
  const idx = hand.findIndex((c) => cardKey(c) === discardCardStr);
  if (idx === -1) return fail(s, `Card ${discardCardStr} not in hand.`);

  const [discardCard] = hand.splice(idx, 1);
  const result = findBestMelds(hand);

  if (result.deadwoodValue !== 0) {
    hand.push(discardCard); // restore
    return fail(state, `Cannot gin — deadwood is ${result.deadwoodValue}.`);
  }

  s.discardPile.push(discardCard);

  const defenderIdx = (1 - playerIdx) as 0 | 1;
  const defenderHand = s.players[defenderIdx].cards;
  const defenderBest = findBestMelds(defenderHand);

  s.handResult = {
    knockerIdx: playerIdx,
    isGin: true,
    isUndercut: false,
    knockerDeadwood: 0,
    defenderDeadwood: defenderBest.deadwoodValue,
    defenderDeadwoodAfterLayoff: defenderBest.deadwoodValue,
    points: 25 + defenderBest.deadwoodValue,
    winner: playerIdx,
    knockerMelds: result.melds,
    defenderMelds: defenderBest.melds,
    knockerDeadwoodCards: [],
    defenderDeadwoodCards: defenderBest.deadwood,
  };

  return applyHandResult(s);
}

// ---------------------------------------------------------------------------
// Layoff phase
// ---------------------------------------------------------------------------

/**
 * Defender lays off cards on the knocker's melds, then the hand is scored.
 * `layoffs` is an array of { card: "AH", meldIndex: 0 } entries.
 */
export function layoffCards(
  state: GinRummyState,
  defenderIdx: 0 | 1,
  layoffs: Array<{ card: string; meldIndex: number }>,
): ActionResult {
  if (state.currentPlayer !== defenderIdx) return fail(state, "Not your turn.");
  if (state.phase !== "layoff") return fail(state, "Not in layoff phase.");

  const s = cloneState(state);
  const defenderHand = s.players[defenderIdx].cards;
  const knockerMelds = s.knockerMelds!;

  for (const { card: cardStr, meldIndex } of layoffs) {
    const cardIdx = defenderHand.findIndex((c) => cardKey(c) === cardStr);
    if (cardIdx === -1) continue;
    if (meldIndex < 0 || meldIndex >= knockerMelds.length) continue;

    const card = defenderHand[cardIdx];
    const options = findLayoffOptions([card], knockerMelds);
    const validOption = options.find(
      (o) => cardKey(o.card) === cardStr && o.meldIndex === meldIndex,
    );

    if (validOption) {
      defenderHand.splice(cardIdx, 1);
      if (validOption.position === "after") {
        knockerMelds[meldIndex].push(card);
      } else {
        knockerMelds[meldIndex].unshift(card);
      }
    }
  }

  return scoreKnock(s, defenderIdx);
}

/**
 * Defender passes layoff (no cards to lay off or chooses not to).
 */
export function passLayoff(state: GinRummyState, defenderIdx: 0 | 1): ActionResult {
  if (state.phase !== "layoff") return fail(state, "Not in layoff phase.");
  return scoreKnock(state, defenderIdx);
}

// ---------------------------------------------------------------------------
// Scoring internals
// ---------------------------------------------------------------------------

function scoreKnock(state: GinRummyState, _defenderIdx: 0 | 1): ActionResult {
  const s = cloneState(state);
  const knockerIdx = s.knockerIdx!;
  const defenderIdx = (1 - knockerIdx) as 0 | 1;

  const knockerHand = s.players[knockerIdx].cards;
  const defenderHand = s.players[defenderIdx].cards;
  const knockerMelds = s.knockerMelds!;

  const knockerDW = calculateDeadwood(knockerHand, knockerMelds);
  const defenderBest = findBestMelds(defenderHand);
  const defenderDW = defenderBest.deadwoodValue;

  let points: number;
  let winner: 0 | 1;
  let isUndercut = false;

  if (defenderDW <= knockerDW) {
    isUndercut = true;
    points = knockerDW - defenderDW + 25;
    winner = defenderIdx;
  } else {
    points = defenderDW - knockerDW;
    winner = knockerIdx;
  }

  const knockerDeadwoodCards = knockerHand.filter(
    (c) => !knockerMelds.flat().some((mc) => cardKey(mc) === cardKey(c)),
  );

  s.handResult = {
    knockerIdx,
    isGin: false,
    isUndercut,
    knockerDeadwood: knockerDW,
    defenderDeadwood: defenderDW,
    defenderDeadwoodAfterLayoff: defenderDW,
    points,
    winner,
    knockerMelds,
    defenderMelds: defenderBest.melds,
    knockerDeadwoodCards,
    defenderDeadwoodCards: defenderBest.deadwood,
  };

  s.knockerMelds = null; // melds are now embedded in handResult; clear from state
  return applyHandResult(s);
}

function applyHandResult(state: GinRummyState): ActionResult {
  const s = state;
  const result = s.handResult!;
  const winner = result.winner;

  s.scores[winner] += result.points;
  s.handsWon[winner] += 1;

  const msg = result.isGin
    ? `Gin! ${result.points} points.`
    : result.isUndercut
      ? `Undercut! ${result.points} points to ${winner === 0 ? "Player 1" : "Player 2"}.`
      : `Knock! ${result.points} points to ${winner === 0 ? "Player 1" : "Player 2"}.`;

  if (s.matchTarget !== null && s.scores[winner] >= s.matchTarget) {
    // Game bonus
    const loser = (1 - winner) as 0 | 1;
    let bonus = 100;
    bonus += s.handsWon[winner] * 25;
    if (s.handsWon[loser] === 0) bonus += 100; // shutout
    s.scores[winner] += bonus;
    s.status = "match_complete";
    s.winner = winner;
    s.phase = "match_over";
    // currentPlayer = winner (for display; no further actions)
    s.currentPlayer = winner;
  } else if (s.matchTarget === null) {
    // Single-hand game
    s.status = "hand_complete";
    s.winner = winner;
    s.phase = "hand_over";
    s.currentPlayer = winner; // winner can acknowledge
  } else {
    // Match continues — hand is over, wait for next_hand action
    s.status = "playing";
    s.phase = "hand_over";
    // Non-knocker deals next; alternate who goes first each hand
    s.currentPlayer = (s.handNumber % 2) as 0 | 1;
  }

  return { success: true, message: msg, state: s };
}

// ---------------------------------------------------------------------------
// Next hand (match play)
// ---------------------------------------------------------------------------

export function startNextHand(
  state: GinRummyState,
  rng: () => number = Math.random,
): ActionResult {
  if (state.phase !== "hand_over") return fail(state, "Current hand is not over yet.");

  const s = cloneState(state);
  const deck = shuffleDeck(createDeck(), rng);
  const p1Cards = deck.slice(0, 10);
  const p2Cards = deck.slice(10, 20);
  const remaining = deck.slice(20);

  s.deck = remaining.slice(0, remaining.length - 1);
  s.discardPile = [remaining[remaining.length - 1]];
  s.players[0] = { cards: p1Cards };
  s.players[1] = { cards: p2Cards };
  s.knockerMelds = null;
  s.knockerIdx = null;
  s.handResult = null;
  s.handNumber += 1;
  s.currentPlayer = (s.handNumber % 2 === 0 ? 0 : 1) as 0 | 1;
  s.phase = "draw";
  s.status = "playing";

  return { success: true, message: `Hand ${s.handNumber} begins.`, state: s };
}

// ---------------------------------------------------------------------------
// Resign
// ---------------------------------------------------------------------------

export function resign(state: GinRummyState, playerIdx: 0 | 1): GinRummyState {
  const s = cloneState(state);
  const winner = (1 - playerIdx) as 0 | 1;
  s.status = "resigned";
  s.winner = winner;
  s.phase = "match_over";
  s.currentPlayer = winner;
  return s;
}

// ---------------------------------------------------------------------------
// Legal action enumeration (for MCTS candidate generation)
// ---------------------------------------------------------------------------

export interface GinRummyMove {
  action: string;
  params: Record<string, unknown>;
  label: string;
}

export function getLegalActions(state: GinRummyState, playerIdx: 0 | 1): GinRummyMove[] {
  if (state.status !== "playing") return [];
  if (state.currentPlayer !== playerIdx) return [];

  const moves: GinRummyMove[] = [];

  if (state.phase === "draw") {
    if (state.deck.length > 0) {
      moves.push({ action: "draw_stock", params: {}, label: "Draw from stock" });
    }
    if (state.discardPile.length > 0) {
      const top = state.discardPile[state.discardPile.length - 1];
      const topKey = cardKey(top);
      moves.push({ action: "draw_discard", params: {}, label: `Take ${topKey} from discard` });
    }
  }

  if (state.phase === "discard") {
    const hand = state.players[playerIdx].cards;

    for (const card of hand) {
      const k = cardKey(card);
      // Compute what the hand looks like after discarding this card
      const remaining = hand.filter((c) => cardKey(c) !== k);
      const best = findBestMelds(remaining);

      moves.push({ action: "discard", params: { card: k }, label: `Discard ${k}` });

      if (best.deadwoodValue === 0) {
        moves.push({ action: "gin", params: { card: k }, label: `Gin (discard ${k})` });
      } else if (best.deadwoodValue <= 10) {
        moves.push({ action: "knock", params: { card: k }, label: `Knock (discard ${k})` });
      }
    }
  }

  if (state.phase === "layoff") {
    moves.push({ action: "pass_layoff", params: {}, label: "Pass layoff" });
    const defenderHand = state.players[playerIdx].cards;
    const options = findLayoffOptions(defenderHand, state.knockerMelds!);
    if (options.length > 0) {
      // Bundle all layoffs into one action
      const layoffs = options.map((o) => ({ card: cardKey(o.card), meldIndex: o.meldIndex }));
      moves.push({ action: "layoff", params: { layoffs }, label: `Lay off ${options.length} card(s)` });
    }
  }

  if (state.phase === "hand_over" && state.matchTarget !== null) {
    moves.push({ action: "next_hand", params: {}, label: "Start next hand" });
  }

  return moves;
}
