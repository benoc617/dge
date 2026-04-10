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
  AiDifficultyTier, AiDifficultyProfile,
} from "@dge/shared";
import type { Move } from "@dge/shared";
import type { SearchGameFunctions } from "@dge/engine/search";
import { mctsSearchAsync } from "@dge/engine/search";
import { getDb, runOutsideTransaction } from "@dge/engine/db-context";
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
// Game logging (TurnLog + GameEvent + stdout dump/purge at game end)
// ---------------------------------------------------------------------------

const LOG_TAG = "[ginrummy-gamelog]";

async function logTurnLog(
  playerId: string,
  action: string,
  params: unknown,
  message: string,
  extra: { handNumber: number; phase: string },
): Promise<void> {
  try {
    const details = { params: params ?? {}, actionMsg: message, ...extra };
    await getDb().turnLog.create({
      data: { playerId, action, details: details as object },
    });
  } catch (err) {
    console.error(LOG_TAG, "turnLog write error:", err);
  }
}

async function logGameEvent(
  sessionId: string,
  type: string,
  message: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await getDb().gameEvent.create({
      data: { gameSessionId: sessionId, type, message, ...(details ? { details: details as object } : {}) },
    });
  } catch (err) {
    console.error(LOG_TAG, "gameEvent write error:", err);
  }
}

/** Fire-and-forget: dump TurnLog + GameEvent rows to stdout then delete them. */
function schedulePurge(sessionId: string): void {
  const db = runOutsideTransaction(() => getDb());
  void (async () => {
    try {
      const players = await db.player.findMany({
        where: { gameSessionId: sessionId },
        select: { id: true },
      });
      const playerIds = players.map((p) => p.id);

      const [turnLogs, gameEvents] = await Promise.all([
        playerIds.length > 0
          ? db.turnLog.findMany({ where: { playerId: { in: playerIds } }, orderBy: { createdAt: "asc" } })
          : Promise.resolve([]),
        db.gameEvent.findMany({ where: { gameSessionId: sessionId }, orderBy: { createdAt: "asc" } }),
      ]);

      console.info(LOG_TAG, JSON.stringify({
        type: "session_log_dump_start", sessionId,
        turnLogCount: turnLogs.length, gameEventCount: gameEvents.length,
      }));
      for (const row of turnLogs) {
        console.info(LOG_TAG, JSON.stringify({ type: "turn_log", sessionId, ...row }));
      }
      for (const event of gameEvents) {
        console.info(LOG_TAG, JSON.stringify({ logKind: "game_event", ...event }));
      }

      await db.$transaction(async (tx) => {
        if (playerIds.length > 0) {
          await tx.turnLog.deleteMany({ where: { playerId: { in: playerIds } } });
        }
        await tx.gameEvent.deleteMany({ where: { gameSessionId: sessionId } });
      });

      console.info(LOG_TAG, JSON.stringify({
        type: "session_log_purge_complete", sessionId,
        turnLogCount: turnLogs.length, gameEventCount: gameEvents.length,
      }));
    } catch (err) {
      console.error(LOG_TAG, "auto-purge error", sessionId, err);
    }
  })();
}

/** Returns true when the whole game is fully over (session should be sealed). */
function isGameOver(state: GinRummyState): boolean {
  return (
    state.status === "match_complete" ||
    state.status === "hand_complete" ||
    state.status === "resigned" ||
    state.status === "timeout"
  );
}

/**
 * Write the appropriate GameEvent for a terminal or hand-complete state,
 * then schedule log purge if the game is fully over.
 */
async function handleSessionEvent(sessionId: string, state: GinRummyState): Promise<void> {
  // Fetch player names for readable messages
  const players = await getDb().player.findMany({
    where: { id: { in: [state.playerIds[0], state.playerIds[1]] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(players.map((p) => [p.id, p.name]));
  const name0 = nameById.get(state.playerIds[0]) ?? "Player 1";
  const name1 = nameById.get(state.playerIds[1]) ?? "Player 2";
  const playerNames: [string, string] = [name0, name1];

  const baseDetails: Record<string, unknown> = {
    scores: state.scores,
    handsWon: state.handsWon,
    handNumber: state.handNumber,
    matchTarget: state.matchTarget,
  };

  let type: string;
  let message: string;
  let details = baseDetails;

  if (state.status === "resigned") {
    const winnerIdx = state.winner ?? 0;
    const loserIdx = (1 - winnerIdx) as 0 | 1;
    type = "game_resigned";
    message = `${playerNames[loserIdx]} resigned. ${playerNames[winnerIdx]} wins.`;
  } else if (state.status === "match_complete" || state.status === "hand_complete") {
    const r = state.handResult!;
    const winnerName = playerNames[r.winner];
    const qualifier = r.isGin ? " with GIN" : r.isUndercut ? " (undercut)" : "";
    const scoreStr = `${state.scores[0]}–${state.scores[1]}`;
    details = { ...baseDetails, handResult: r };
    if (state.status === "match_complete") {
      type = "match_complete";
      message = `Hand ${state.handNumber}: ${winnerName} wins${qualifier} — match over. Scores: ${scoreStr}. Winner: ${playerNames[state.winner!]}.`;
    } else {
      type = "hand_complete";
      message = `Hand ${state.handNumber}: ${winnerName} wins${qualifier} (+${r.points} pts). Scores: ${scoreStr}.`;
    }
  } else if (state.status === "timeout") {
    type = "game_timeout";
    message = "Game ended due to timeout.";
  } else if (state.phase === "hand_over" && state.status === "playing") {
    // Mid-match hand completed; game continues after next_hand
    const r = state.handResult!;
    const winnerName = playerNames[r.winner];
    const qualifier = r.isGin ? " with GIN" : r.isUndercut ? " (undercut)" : "";
    const scoreStr = `${state.scores[0]}–${state.scores[1]}`;
    type = "hand_complete";
    message = `Hand ${state.handNumber}: ${winnerName} wins${qualifier} (+${r.points} pts). Scores: ${scoreStr}.`;
    details = { ...baseDetails, handResult: r };
    await logGameEvent(sessionId, type, message, details);
    return; // not game-over, skip purge
  } else {
    return; // no event for this state
  }

  await logGameEvent(sessionId, type, message, details);

  if (isGameOver(state)) {
    schedulePurge(sessionId);
  }
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
  behavior?: GinAiBehavior,
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

  // When trackDiscards is enabled, use observed opponent pickups to bias the
  // determinization: keep those cards in the opponent's hand if possible.
  const observedOppKeys: string[] =
    behavior?.trackDiscards && state.observedPickups
      ? (state.observedPickups[oppIdx] ?? [])
      : [];

  const unknownCards = createDeck().filter((c) => !knownKeys.has(cardKey(c)));

  // Separate unknown cards into "likely in opponent hand" (observed) and the rest.
  const observedSet = new Set(observedOppKeys);
  const likelyOpp = unknownCards.filter((c) => observedSet.has(cardKey(c)));
  const remaining = unknownCards.filter((c) => !observedSet.has(cardKey(c)));

  const shuffledRemaining = shuffleDeck(remaining, rng);
  const shuffledLikely = shuffleDeck(likelyOpp, rng);

  // Fill opponent hand: prefer observed cards, then fill with unknowns.
  const oppPool = [...shuffledLikely, ...shuffledRemaining];
  const det = cloneState(state);
  det.players[oppIdx].cards = oppPool.slice(0, oppHandSize);
  // Remaining pool (after opponent hand) goes to deck.
  const deckPool = oppPool.slice(oppHandSize);
  det.deck = deckPool.slice(0, stockSize);
  return det;
}

// ---------------------------------------------------------------------------
// AI difficulty profile
// ---------------------------------------------------------------------------

/**
 * Gin Rummy specific AI behavioral flags.
 * These extend the generic MCTS budget with strategic awareness options.
 */
export interface GinAiBehavior {
  /**
   * When true, the AI tracks which cards the opponent has picked from the
   * discard pile (recorded in state.observedPickups). It biases determinizations
   * to keep observed picks in the opponent's hand, improving meld inference.
   */
  trackDiscards: boolean;
  /**
   * When true, the AI further biases candidate discard moves away from cards
   * that would complete known/inferred opponent melds. Requires trackDiscards.
   */
  inferOpponentMelds: boolean;
}

export const GINRUMMY_DIFFICULTY_PROFILE: AiDifficultyProfile = {
  easy: {
    label: "Casual",
    mctsConfig: {
      timeLimitMs: 300,
      iterations: 100,
    },
    behavior: { trackDiscards: false, inferOpponentMelds: false } satisfies GinAiBehavior,
  },
  medium: {
    label: "Competitive",
    mctsConfig: {
      timeLimitMs: 700,
      iterations: 200,
    },
    behavior: { trackDiscards: true, inferOpponentMelds: false } satisfies GinAiBehavior,
  },
  hard: {
    label: "Shark",
    mctsConfig: {
      timeLimitMs: 2000,
      iterations: 400,
    },
    behavior: { trackDiscards: true, inferOpponentMelds: true } satisfies GinAiBehavior,
  },
};

// ---------------------------------------------------------------------------
// AI move selection (MCTS + voting across determinizations)
// ---------------------------------------------------------------------------

const N_DETERMINIZATIONS = 6;
const DEFAULT_MCTS_ITERATIONS = 200;
const DEFAULT_MCTS_BUDGET_MS = 2000;

export async function getGinRummyAIMove(
  state: GinRummyState,
  aiPlayerId: string,
  tier?: AiDifficultyTier,
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

  // Resolve behavior flags and MCTS config from difficulty tier
  const behavior = (tier?.behavior as GinAiBehavior | undefined) ?? { trackDiscards: false, inferOpponentMelds: false };
  const mctsConfig = tier?.mctsConfig ?? {};
  const iterationsPerDet = mctsConfig.iterations ?? DEFAULT_MCTS_ITERATIONS;
  const totalBudgetMs = mctsConfig.timeLimitMs ?? DEFAULT_MCTS_BUDGET_MS;

  const voteCounts = new Map<string, number>();
  const budget = Math.floor(totalBudgetMs / N_DETERMINIZATIONS);

  for (let i = 0; i < N_DETERMINIZATIONS; i++) {
    const rng = makeSeedRng(i * 7919 + Date.now() % 1000);
    const det = determinizeState(state, aiIdx, rng, behavior);

    const candidates = generateMctsCandidates(det, aiIdx, 30);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      voteFor(voteCounts, candidates[0]);
      continue;
    }

    try {
      const move = await mctsSearchAsync(ginRummySearchFunctions, det, aiIdx, {
        iterations: iterationsPerDet,
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
// Discard-pickup observation tracking
// ---------------------------------------------------------------------------

/**
 * When a player uses `draw_discard`, record the top discard card in
 * state.observedPickups so the opponent AI can use it in determinizations.
 * This function is intentionally cheap — it only acts on draw_discard.
 * Returns the updated state (or the original if no tracking needed).
 */
function trackDiscardPickupIfNeeded(
  prevState: GinRummyState,
  newState: GinRummyState,
  playerId: string,
  action: string,
): GinRummyState {
  if (action !== "draw_discard") return newState;
  // The top of the discard pile before the draw is now in the player's hand.
  const topCard = prevState.discardPile[prevState.discardPile.length - 1];
  if (!topCard) return newState;

  const playerIdx = newState.playerIds[0] === playerId ? 0 : 1;
  const key = cardKey(topCard);

  const current: [string[], string[]] = newState.observedPickups
    ? [[...newState.observedPickups[0]], [...newState.observedPickups[1]]]
    : [[], []];

  if (!current[playerIdx].includes(key)) {
    current[playerIdx].push(key);
  }

  return { ...newState, observedPickups: current };
}

// ---------------------------------------------------------------------------
// Full-track GameDefinition (DB-backed for the orchestrator)
// ---------------------------------------------------------------------------

export const ginRummyGameDefinition: GameDefinition<GinRummyState> = {
  loadState: async (sessionId) => loadGinRummyState(sessionId),
  saveState: async (sessionId, state) => saveGinRummyState(sessionId, state),
  aiDifficultyProfile: GINRUMMY_DIFFICULTY_PROFILE,

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
    const sessionId = player.gameSessionId;

    let state: GinRummyState;
    try {
      state = await loadGinRummyState(sessionId);
    } catch {
      return { success: false, message: "Game session not found." };
    }

    const wasOver = isGameOver(state);
    if (wasOver && action !== "next_hand") {
      return { success: false, message: "Game is already over." };
    }

    const prevPhase = state.phase;
    const prevStatus = state.status;
    const result = ginRummyApplyAction(state, playerId, action, params);
    if (!result.success) {
      return { success: false, message: result.message };
    }

    // Track discard pickups for inference-aware AI difficulties.
    // When a player draws from the discard pile, record the card so the opponent
    // AI can use it to bias future determinizations.
    const updatedState = trackDiscardPickupIfNeeded(
      state,
      result.state,
      playerId,
      action,
    );

    await saveGinRummyState(sessionId, updatedState);
    await logTurnLog(playerId, action, params, result.message, {
      handNumber: state.handNumber,
      phase: prevPhase,
    });

    // Write session event when phase/status changed to a noteworthy state
    const nowOver = isGameOver(updatedState);
    const handJustEnded =
      updatedState.phase === "hand_over" && prevPhase !== "hand_over";
    const matchJustEnded = updatedState.status !== prevStatus && nowOver;
    if (matchJustEnded || (handJustEnded && !nowOver)) {
      await handleSessionEvent(sessionId, updatedState);
    }

    return { success: true, message: result.message };
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

      // Resolve difficulty tier from state
      const difficulty = (state.aiDifficulty ?? "medium") as "easy" | "medium" | "hard";
      const tier = GINRUMMY_DIFFICULTY_PROFILE[difficulty];
      const move = await getGinRummyAIMove(state, currentPlayerId, tier);
      if (!move) break;

      const prevPhase = state.phase;
      const prevStatus = state.status;
      const result = ginRummyApplyAction(state, currentPlayerId, move.action, move.params);
      if (!result.success) break;

      await saveGinRummyState(sessionId, result.state);
      await logTurnLog(currentPlayerId, move.action, move.params, result.message, {
        handNumber: state.handNumber,
        phase: prevPhase,
      });

      const nowOver = isGameOver(result.state);
      const handJustEnded =
        result.state.phase === "hand_over" && prevPhase !== "hand_over";
      const matchJustEnded = result.state.status !== prevStatus && nowOver;
      if (matchJustEnded || (handJustEnded && !nowOver)) {
        await handleSessionEvent(sessionId, result.state);
      }

      // If the active player changed, advance the engine's currentTurnPlayerId.
      if (result.state.playerIds[result.state.currentPlayer] !== currentPlayerId) {
        const { advanceTurn } = await import("@dge/engine/turn-order");
        await advanceTurn(sessionId);
      }

      if (nowOver) break;
    }
  },
};
