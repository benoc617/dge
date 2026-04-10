/**
 * Gin Rummy GameDefinition for the DGE engine.
 *
 * State is stored in GameSession.log as JSON (no separate tables needed).
 * AI uses MCTS with information set sampling (determinization) — because gin
 * rummy is an imperfect-information game, each MCTS run operates on a
 * randomly completed "determinization" of the state, then votes are tallied
 * across multiple samples to choose the best action.
 *
 * Turn management: instead of relying on the engine's sequential
 * advanceTurn cycling, the TurnOrderHooks.getActivePlayers hook always
 * returns only the player whose turn it currently is (based on
 * GinRummyState.currentPlayer). This lets advanceTurn correctly keep or
 * switch the current player after every action, even though draws and
 * discards stay within the same player's turn.
 */

import type {
  GameDefinition, FullActionOptions, FullActionResult,
} from "@dge/shared";
import type { Move } from "@dge/shared";
import type { SearchGameFunctions } from "@dge/engine/search";
import { mctsSearchAsync } from "@dge/engine/search";
import { getDb } from "@dge/engine/db-context";
import type { GinRummyState } from "./types";
import {
  cloneState, createDeck, shuffleDeck, createInitialState,
  drawFromStock, drawFromDiscard, discardCard, knockHand, ginHand,
  layoffCards, passLayoff, startNextHand, resign, getLegalActions,
} from "./rules";
import { cardKey, findBestMelds, findLayoffOptions } from "./melds";

// ---------------------------------------------------------------------------
// State persistence via GameSession.log
// ---------------------------------------------------------------------------

export async function loadGinRummyState(sessionId: string): Promise<GinRummyState> {
  const session = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    select: { log: true },
  });
  if (!session?.log) throw new Error("Gin Rummy session not found");
  const raw = session.log as unknown;
  if (typeof raw === "string") return JSON.parse(raw) as GinRummyState;
  return raw as GinRummyState;
}

export async function saveGinRummyState(sessionId: string, state: GinRummyState): Promise<void> {
  const jsonLog = JSON.parse(JSON.stringify(state));
  const isOver =
    state.status === "match_complete" ||
    state.status === "hand_complete" ||
    state.status === "resigned" ||
    state.status === "timeout";
  const updates: Record<string, unknown> = { log: jsonLog };
  if (isOver) updates.status = "complete";
  await getDb().gameSession.update({
    where: { id: sessionId },
    data: updates,
  });
}

// ---------------------------------------------------------------------------
// Pure-track action dispatch (no DB)
// ---------------------------------------------------------------------------

type PureActionResult = { success: boolean; message: string; state: GinRummyState };

export function ginRummyApplyAction(
  state: GinRummyState,
  playerId: string,
  action: string,
  params: unknown,
): PureActionResult {
  const p = (params ?? {}) as Record<string, unknown>;
  const playerIdx = state.playerIds[0] === playerId ? 0 : 1;

  if (action === "resign") {
    return { success: true, message: "Resigned.", state: resign(state, playerIdx) };
  }
  if (action === "draw_stock") {
    return drawFromStock(state, playerIdx);
  }
  if (action === "draw_discard") {
    return drawFromDiscard(state, playerIdx);
  }
  if (action === "discard") {
    const card = p.card as string;
    if (!card) return { success: false, message: "card param required.", state };
    return discardCard(state, playerIdx, card);
  }
  if (action === "knock") {
    const card = p.card as string;
    const meldKeys = p.melds as string[][] | undefined;
    if (!card) return { success: false, message: "card param required.", state };
    return knockHand(state, playerIdx, card, meldKeys);
  }
  if (action === "gin") {
    const card = p.card as string;
    if (!card) return { success: false, message: "card param required.", state };
    return ginHand(state, playerIdx, card);
  }
  if (action === "layoff") {
    const layoffs = p.layoffs as Array<{ card: string; meldIndex: number }>;
    if (!layoffs) return { success: false, message: "layoffs param required.", state };
    return layoffCards(state, playerIdx, layoffs);
  }
  if (action === "pass_layoff") {
    return passLayoff(state, playerIdx);
  }
  if (action === "next_hand") {
    return startNextHand(state);
  }
  return { success: false, message: `Unknown action: ${action}`, state };
}

// ---------------------------------------------------------------------------
// MCTS helpers: compound moves that cover a full player turn
// ---------------------------------------------------------------------------

/**
 * For a state in "draw" phase, generate all (drawSource, discardChoice)
 * compound moves as if the player will draw then immediately discard.
 * Used only within MCTS — the server executes draws and discards as
 * separate API actions.
 */
function getDiscardOptions(state: GinRummyState, playerIdx: 0 | 1): Move[] {
  const hand = state.players[playerIdx].cards;
  const moves: Move[] = [];
  for (const card of hand) {
    const k = cardKey(card);
    const remaining = hand.filter((c) => cardKey(c) !== k);
    const best = findBestMelds(remaining);
    if (best.deadwoodValue === 0) {
      moves.push({ action: "compound_turn", params: { discardCard: k, declareGin: true }, label: `Gin ${k}` });
    } else if (best.deadwoodValue <= 10) {
      moves.push({ action: "compound_turn", params: { discardCard: k, declareKnock: true }, label: `Knock ${k}` });
      moves.push({ action: "compound_turn", params: { discardCard: k }, label: `Discard ${k}` });
    } else {
      moves.push({ action: "compound_turn", params: { discardCard: k }, label: `Discard ${k}` });
    }
  }
  return moves;
}

function applyMctsAction(
  state: GinRummyState,
  action: string,
  params: Record<string, unknown>,
): { state: GinRummyState; success: boolean } {
  const idx = state.currentPlayer;

  if (action === "compound_turn") {
    const { drawFrom, discardCard: dc, declareKnock, declareGin } = params;
    let s: GinRummyState;
    if (drawFrom === "discard") {
      const r = drawFromDiscard(state, idx);
      if (!r.success) return { state, success: false };
      s = r.state;
    } else {
      const r = drawFromStock(state, idx);
      if (!r.success) return { state, success: false };
      s = r.state;
    }
    let finalR: PureActionResult;
    if (declareGin) {
      finalR = ginHand(s, idx, dc as string);
    } else if (declareKnock) {
      finalR = knockHand(s, idx, dc as string);
    } else {
      finalR = discardCard(s, idx, dc as string);
    }
    return { state: finalR.state, success: finalR.success };
  }

  if (action === "discard") {
    const r = discardCard(state, idx, params.card as string);
    return { state: r.state, success: r.success };
  }
  if (action === "knock") {
    const r = knockHand(state, idx, params.card as string);
    return { state: r.state, success: r.success };
  }
  if (action === "gin") {
    const r = ginHand(state, idx, params.card as string);
    return { state: r.state, success: r.success };
  }
  if (action === "layoff") {
    const r = layoffCards(state, idx, params.layoffs as Array<{ card: string; meldIndex: number }>);
    return { state: r.state, success: r.success };
  }
  if (action === "pass_layoff") {
    const r = passLayoff(state, idx);
    return { state: r.state, success: r.success };
  }

  return { state, success: false };
}

function generateMctsCandidates(state: GinRummyState, _playerIdx: number, maxMoves: number): Move[] {
  const idx = state.currentPlayer;
  if (state.status !== "playing") return [];

  if (state.phase === "draw") {
    const moves: Move[] = [];
    const half = Math.ceil(maxMoves / 2);
    // Stock draw options
    if (state.deck.length > 0) {
      const afterStock = drawFromStock(state, idx);
      if (afterStock.success) {
        const opts = getDiscardOptions(afterStock.state, idx).slice(0, half);
        for (const m of opts) {
          moves.push({ action: "compound_turn", params: { drawFrom: "stock", ...m.params }, label: `S+${m.label}` });
        }
      }
    }
    // Discard draw options
    if (state.discardPile.length > 0) {
      const afterDiscard = drawFromDiscard(state, idx);
      if (afterDiscard.success) {
        const opts = getDiscardOptions(afterDiscard.state, idx).slice(0, half);
        for (const m of opts) {
          moves.push({ action: "compound_turn", params: { drawFrom: "discard", ...m.params }, label: `D+${m.label}` });
        }
      }
    }
    if (moves.length > maxMoves) return moves.slice(0, maxMoves);
    return moves;
  }

  if (state.phase === "discard") {
    const hand = state.players[idx].cards;
    const moves: Move[] = [];
    for (const card of hand) {
      const k = cardKey(card);
      const remaining = hand.filter((c) => cardKey(c) !== k);
      const best = findBestMelds(remaining);
      if (best.deadwoodValue === 0) {
        moves.push({ action: "gin", params: { card: k }, label: `Gin ${k}` });
      } else if (best.deadwoodValue <= 10) {
        moves.push({ action: "knock", params: { card: k }, label: `Knock ${k}` });
      }
      moves.push({ action: "discard", params: { card: k }, label: `Discard ${k}` });
    }
    if (moves.length > maxMoves) return moves.slice(0, maxMoves);
    return moves;
  }

  if (state.phase === "layoff") {
    const moves: Move[] = [{ action: "pass_layoff", params: {}, label: "Pass" }];
    const defHand = state.players[idx].cards;
    const opts = findLayoffOptions(defHand, state.knockerMelds!);
    if (opts.length > 0) {
      moves.push({
        action: "layoff",
        params: { layoffs: opts.map((o) => ({ card: cardKey(o.card), meldIndex: o.meldIndex })) },
        label: "Layoff all",
      });
    }
    return moves;
  }

  return [];
}

// ---------------------------------------------------------------------------
// SearchGameFunctions<GinRummyState>
// ---------------------------------------------------------------------------

export const ginRummySearchFunctions: SearchGameFunctions<GinRummyState> = {
  applyTick(state) { return state; }, // no economy tick in gin rummy

  applyAction(state, _playerIdx, action, params) {
    return applyMctsAction(state, action, params);
  },

  evalState(state, playerIdx) {
    if (
      state.status === "match_complete" ||
      state.status === "hand_complete"
    ) {
      return state.winner === playerIdx ? 1000 : -1000;
    }
    if (state.status === "resigned") {
      return state.winner === playerIdx ? 500 : -500;
    }
    if (state.status === "draw") return 0;

    // Heuristic: opponent deadwood − my deadwood (higher = I have less deadwood)
    const myHand = state.players[playerIdx].cards;
    const oppHand = state.players[1 - playerIdx].cards;
    const myDW = findBestMelds(myHand).deadwoodValue;
    const oppDW = findBestMelds(oppHand).deadwoodValue;
    return oppDW - myDW;
  },

  generateCandidateMoves: generateMctsCandidates,
  cloneState,

  pickRolloutMove(_state, _playerIdx, candidates, rng) {
    return candidates[Math.floor(rng() * candidates.length)];
  },

  getPlayerCount() { return 2; },

  isTerminal(state) {
    return (
      state.status !== "playing" ||
      state.phase === "hand_over" ||
      state.phase === "match_over"
    );
  },
};

// ---------------------------------------------------------------------------
// Determinization: fill in hidden information for MCTS
// ---------------------------------------------------------------------------

function makeSeedRng(seed: number): () => number {
  // Mulberry32
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function determinizeState(
  state: GinRummyState,
  aiPlayerIdx: 0 | 1,
  rng: () => number,
): GinRummyState {
  const oppIdx = (1 - aiPlayerIdx) as 0 | 1;
  const oppHandSize = state.players[oppIdx].cards.length;
  const stockSize = state.deck.length;

  // Cards the AI knows about: its own hand + the full discard pile
  const knownKeys = new Set([
    ...state.players[aiPlayerIdx].cards.map(cardKey),
    ...state.discardPile.map(cardKey),
    ...(state.knockerMelds ? state.knockerMelds.flat().map(cardKey) : []),
  ]);

  const unknownCards = createDeck().filter((c) => !knownKeys.has(cardKey(c)));
  const shuffled = shuffleDeck(unknownCards, rng);

  const det = cloneState(state);
  det.players[oppIdx].cards = shuffled.slice(0, oppHandSize);
  det.deck = shuffled.slice(oppHandSize, oppHandSize + stockSize);
  return det;
}

// ---------------------------------------------------------------------------
// AI move selection (MCTS + voting across determinizations)
// ---------------------------------------------------------------------------

const N_DETERMINIZATIONS = 6;
const MCTS_ITERATIONS = 200;
const MCTS_BUDGET_MS = 2000;

export async function getGinRummyAIMove(
  state: GinRummyState,
  aiPlayerId: string,
): Promise<{ action: string; params: Record<string, unknown> } | null> {
  const aiIdx = state.playerIds[0] === aiPlayerId ? 0 : 1;

  if (state.status !== "playing") return null;

  // Layoff: simple heuristic — lay off all possible cards
  if (state.phase === "layoff") {
    if (state.currentPlayer !== aiIdx) return null;
    const defHand = state.players[aiIdx].cards;
    const opts = findLayoffOptions(defHand, state.knockerMelds!);
    if (opts.length > 0) {
      return {
        action: "layoff",
        params: { layoffs: opts.map((o) => ({ card: cardKey(o.card), meldIndex: o.meldIndex })) },
      };
    }
    return { action: "pass_layoff", params: {} };
  }

  // Match hand_over: trigger next hand
  if (state.phase === "hand_over" && state.matchTarget !== null) {
    if (state.currentPlayer !== aiIdx) return null;
    return { action: "next_hand", params: {} };
  }

  if (state.phase !== "draw" && state.phase !== "discard") return null;
  if (state.currentPlayer !== aiIdx) return null;

  const voteCounts = new Map<string, number>();
  const budget = Math.floor(MCTS_BUDGET_MS / N_DETERMINIZATIONS);

  for (let i = 0; i < N_DETERMINIZATIONS; i++) {
    const rng = makeSeedRng(i * 7919 + Date.now() % 1000);
    const det = determinizeState(state, aiIdx, rng);

    const candidates = generateMctsCandidates(det, aiIdx, 30);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      voteFor(voteCounts, candidates[0]);
      continue;
    }

    try {
      const move = await mctsSearchAsync(ginRummySearchFunctions, det, aiIdx, {
        iterations: MCTS_ITERATIONS,
        timeLimitMs: budget,
        rolloutDepth: 20,
        branchFactor: 20,
      });
      voteFor(voteCounts, move);
    } catch {
      // Fall back to first candidate
      voteFor(voteCounts, candidates[0]);
    }
  }

  const bestMctsMove = pickBestVote(voteCounts);
  if (!bestMctsMove) {
    // Fallback: use heuristic
    const legal = getLegalActions(state, aiIdx);
    return legal.length > 0 ? { action: legal[0].action, params: legal[0].params } : null;
  }

  // Convert MCTS move to API move
  return mctsToApiMove(bestMctsMove, state.phase);
}

function voteFor(votes: Map<string, number>, move: Move) {
  const key = JSON.stringify({ action: move.action, params: move.params });
  votes.set(key, (votes.get(key) ?? 0) + 1);
}

function pickBestVote(
  votes: Map<string, number>,
): { action: string; params: Record<string, unknown> } | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, count] of votes) {
    if (count > bestCount) {
      bestCount = count;
      best = key;
    }
  }
  if (!best) return null;
  return JSON.parse(best) as { action: string; params: Record<string, unknown> };
}

/**
 * Convert an MCTS compound move to the first API action needed to execute it.
 * The runAiSequence loop will call this function again for subsequent actions.
 */
function mctsToApiMove(
  move: { action: string; params: Record<string, unknown> },
  phase: string,
): { action: string; params: Record<string, unknown> } {
  if (move.action === "compound_turn") {
    const { drawFrom, discardCard: dc, declareKnock, declareGin } = move.params;
    if (phase === "draw") {
      // First step: just the draw
      return { action: drawFrom === "discard" ? "draw_discard" : "draw_stock", params: {} };
    }
    // We're in discard phase (the draw already happened); do the discard/knock/gin
    if (declareGin) return { action: "gin", params: { card: dc } };
    if (declareKnock) return { action: "knock", params: { card: dc } };
    return { action: "discard", params: { card: dc } };
  }
  return { action: move.action, params: move.params };
}

// ---------------------------------------------------------------------------
// Full-track GameDefinition (DB-backed for the orchestrator)
// ---------------------------------------------------------------------------

export const ginRummyGameDefinition: GameDefinition<GinRummyState> = {
  loadState: async (sessionId) => loadGinRummyState(sessionId),
  saveState: async (sessionId, state) => saveGinRummyState(sessionId, state),

  applyAction(state, playerId, action, params) {
    return ginRummyApplyAction(state, playerId, action, params) as ReturnType<
      NonNullable<GameDefinition<GinRummyState>["applyAction"]>
    >;
  },

  evalState(state, playerId) {
    const playerIdx = state.playerIds[0] === playerId ? 0 : 1;
    return ginRummySearchFunctions.evalState(state, playerIdx);
  },

  generateCandidateMoves(state, playerId) {
    const playerIdx = state.playerIds[0] === playerId ? 0 : 1;
    return generateMctsCandidates(state, playerIdx, 30);
  },

  async processFullAction(
    playerId: string,
    action: string,
    params: Record<string, unknown>,
    _opts?: FullActionOptions,
  ): Promise<FullActionResult> {
    const player = await getDb().player.findUnique({
      where: { id: playerId },
      select: { gameSessionId: true },
    });
    if (!player?.gameSessionId) {
      return { success: false, message: "Player has no session." };
    }

    let state: GinRummyState;
    try {
      state = await loadGinRummyState(player.gameSessionId);
    } catch {
      return { success: false, message: "Game session not found." };
    }

    const isOver =
      state.status === "match_complete" ||
      state.status === "hand_complete" ||
      state.status === "resigned" ||
      state.status === "timeout";
    if (isOver && action !== "next_hand") {
      return { success: false, message: "Game is already over." };
    }

    const result = ginRummyApplyAction(state, playerId, action, params);
    if (result.success) {
      await saveGinRummyState(player.gameSessionId, result.state);
    }
    return { success: result.success, message: result.message };
  },

  async runAiSequence(sessionId: string): Promise<void> {
    // Keep taking AI actions while the current player is an AI.
    for (let guard = 0; guard < 100; guard++) {
      let state: GinRummyState;
      try {
        state = await loadGinRummyState(sessionId);
      } catch {
        break;
      }
      if (state.status !== "playing") break;

      const currentPlayerId = state.playerIds[state.currentPlayer];
      const player = await getDb().player.findUnique({
        where: { id: currentPlayerId },
        select: { isAI: true },
      });
      if (!player?.isAI) break;

      const move = await getGinRummyAIMove(state, currentPlayerId);
      if (!move) break;

      const result = ginRummyApplyAction(state, currentPlayerId, move.action, move.params);
      if (!result.success) break;

      await saveGinRummyState(sessionId, result.state);

      // If the active player changed, advance the engine's currentTurnPlayerId.
      if (result.state.playerIds[result.state.currentPlayer] !== currentPlayerId) {
        const { advanceTurn } = await import("@dge/engine/turn-order");
        await advanceTurn(sessionId);
      }
    }
  },
};
