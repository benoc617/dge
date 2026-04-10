/**
 * Chess GameDefinition for the DGE engine.
 *
 * State is stored in GameSession.log as JSON (no separate tables needed).
 * Uses MCTS via the engine's generic search for AI moves — no Gemini.
 */

import type {
  GameDefinition, ActionResult, TickResult, Move, Rng,
  FullActionOptions, FullActionResult, FullTurnReport,
  AiDifficultyTier, AiDifficultyProfile,
} from "@dge/shared";
import type { SearchGameFunctions } from "@dge/engine/search";
import { mctsSearch } from "@dge/engine/search";
import { getDb } from "@dge/engine/db-context";
import type { ChessState } from "./types";
import {
  getLegalMoves, applyMove, resign, cloneState, moveToString,
  stringToMove, evaluateMaterial, createInitialState,
} from "./rules";

// ---------------------------------------------------------------------------
// State persistence via GameSession.log
// ---------------------------------------------------------------------------

async function loadChessState(sessionId: string, _playerId: string, _action: string, _db: unknown): Promise<ChessState> {
  const session = await getDb().gameSession.findUnique({
    where: { id: sessionId },
    select: { log: true },
  });
  if (!session?.log) throw new Error("Chess session not found");
  const log = session.log as unknown;
  if (typeof log === "string") return JSON.parse(log) as ChessState;
  return log as ChessState;
}

async function saveChessState(sessionId: string, state: ChessState, _db: unknown): Promise<void> {
  const jsonLog = JSON.parse(JSON.stringify(state));
  const updates: Record<string, unknown> = { log: jsonLog };
  if (state.status !== "playing") updates.status = "complete";
  await getDb().gameSession.update({
    where: { id: sessionId },
    data: updates,
  });
}

// ---------------------------------------------------------------------------
// Pure-track functions (no DB, used by search/MCTS)
// ---------------------------------------------------------------------------

function chessApplyAction(
  state: ChessState,
  _playerId: string,
  action: string,
  params: unknown,
  _rng?: Rng | unknown,
): ActionResult<ChessState> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (action === "resign") {
    return { success: true, message: "Resigned.", state: resign(state) };
  }

  if (action === "move") {
    const moveStr = p.move as string;
    if (!moveStr) return { success: false, message: "No move specified.", state };

    const move = stringToMove(moveStr);
    const legal = getLegalMoves(state);
    const match = legal.find(
      (m) => m.from[0] === move.from[0] && m.from[1] === move.from[1] &&
             m.to[0] === move.to[0] && m.to[1] === move.to[1] &&
             (m.promotion ?? null) === (move.promotion ?? null),
    );
    if (!match) return { success: false, message: "Illegal move.", state };

    const newState = applyMove(state, match);
    let msg = `Moved ${moveStr}`;
    if (newState.status === "checkmate") msg += " — Checkmate!";
    else if (newState.inCheck) msg += " — Check!";
    else if (newState.status === "stalemate") msg += " — Stalemate.";
    else if (newState.status.startsWith("draw_")) msg += " — Draw.";
    return { success: true, message: msg, state: newState };
  }

  return { success: false, message: `Unknown action: ${action}`, state };
}

function chessGenerateMoves(state: ChessState, _playerId: string, maxMoves?: number): Move[] {
  const legal = getLegalMoves(state);
  const moves: Move[] = legal.map((m) => ({
    action: "move",
    params: { move: moveToString(m) },
    label: moveToString(m),
  }));
  if (maxMoves && moves.length > maxMoves) {
    return moves.slice(0, maxMoves);
  }
  return moves;
}

function chessEval(state: ChessState, playerId: string): number {
  if (state.status === "checkmate") {
    return state.winner === colorForPlayer(state, playerId) ? 10000 : -10000;
  }
  if (state.status !== "playing") return 0; // draw
  const material = evaluateMaterial(state.board);
  return colorForPlayer(state, playerId) === "white" ? material : -material;
}

function colorForPlayer(state: ChessState, playerId: string): "white" | "black" {
  return playerId === state.whitePlayerId ? "white" : "black";
}

// ---------------------------------------------------------------------------
// MCTS adapter (SearchGameFunctions<ChessState>)
// ---------------------------------------------------------------------------

export const chessSearchFunctions: SearchGameFunctions<ChessState> = {
  applyTick(state) { return state; }, // chess has no tick
  applyAction(state, playerIdx, action, params, _rng) {
    const playerId = playerIdx === 0 ? state.whitePlayerId : state.blackPlayerId;
    const result = chessApplyAction(state, playerId, action, params, () => 0);
    return { state: result.state ?? state, success: result.success };
  },
  evalState(state, playerIdx) {
    const playerId = playerIdx === 0 ? state.whitePlayerId : state.blackPlayerId;
    return chessEval(state, playerId);
  },
  generateCandidateMoves(state, _playerIdx, maxMoves) {
    const playerId = state.turn === "white" ? state.whitePlayerId : state.blackPlayerId;
    return chessGenerateMoves(state, playerId, maxMoves);
  },
  cloneState,
  pickRolloutMove(_state, _playerIdx, candidates, rng) {
    // Prefer captures and checks slightly by putting them first, then random pick
    return candidates[Math.floor(rng() * candidates.length)];
  },
  getPlayerCount() { return 2; },
  isTerminal(state) { return state.status !== "playing"; },
};

// ---------------------------------------------------------------------------
// AI difficulty profile
// ---------------------------------------------------------------------------

export const CHESS_DIFFICULTY_PROFILE: AiDifficultyProfile = {
  easy: {
    label: "Beginner",
    mctsConfig: {
      timeLimitMs: 400,
      iterations: 300,
      rolloutDepth: 15,
      branchFactor: 20,
      explorationC: 1.5,
    },
  },
  medium: {
    label: "Club Player",
    mctsConfig: {
      timeLimitMs: 3000,
      iterations: 2000,
      rolloutDepth: 40,
      branchFactor: 60,
      explorationC: Math.SQRT2,
    },
  },
  hard: {
    label: "Expert",
    mctsConfig: {
      timeLimitMs: 8000,
      iterations: 6000,
      rolloutDepth: 60,
      branchFactor: 80,
      explorationC: Math.SQRT2,
    },
  },
};

// ---------------------------------------------------------------------------
// AI move via MCTS
// ---------------------------------------------------------------------------

/**
 * Pick an AI move using MCTS.
 * The `tier` argument is optional — when omitted the medium profile is used.
 */
export async function getChessAIMove(
  state: ChessState,
  tier?: AiDifficultyTier,
): Promise<Move | null> {
  if (state.status !== "playing") return null;
  const playerIdx = state.turn === "white" ? 0 : 1;
  const cfg = (tier ?? CHESS_DIFFICULTY_PROFILE.medium).mctsConfig ?? {};
  const result = mctsSearch(chessSearchFunctions, cloneState(state), playerIdx, {
    iterations: cfg.iterations ?? 2000,
    timeLimitMs: cfg.timeLimitMs ?? 3000,
    rolloutDepth: cfg.rolloutDepth ?? 40,
    explorationC: cfg.explorationC ?? Math.SQRT2,
    branchFactor: cfg.branchFactor ?? 60,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Full-track GameDefinition (DB-backed for the orchestrator)
// ---------------------------------------------------------------------------

export const chessGameDefinition: GameDefinition<ChessState> = {
  loadState: loadChessState,
  saveState: saveChessState,
  applyAction: chessApplyAction,
  evalState: chessEval,
  generateCandidateMoves: chessGenerateMoves,
  aiDifficultyProfile: CHESS_DIFFICULTY_PROFILE,

  async processFullAction(
    playerId: string,
    action: string,
    params: Record<string, unknown>,
    opts?: FullActionOptions,
  ): Promise<FullActionResult> {
    // Find the player's session
    const player = await getDb().player.findUnique({
      where: { id: playerId },
      select: { gameSessionId: true },
    });
    if (!player?.gameSessionId) {
      return { success: false, message: "Player has no session." };
    }

    const state = await loadChessState(player.gameSessionId, playerId, "move", null);
    if (state.status !== "playing") {
      return { success: false, message: "Game is already over." };
    }

    // Verify it's this player's turn
    const expectedPlayer = state.turn === "white" ? state.whitePlayerId : state.blackPlayerId;
    if (playerId !== expectedPlayer) {
      return { success: false, message: "Not your turn." };
    }

    const result = chessApplyAction(state, playerId, action, params);
    if (result.success && result.state) {
      await saveChessState(player.gameSessionId, result.state, null);
    }
    return { success: result.success, message: result.message };
  },

  // Chess has no economy tick — the orchestrator will get { report: null }
  // processFullTick intentionally not defined.

  async runAiSequence(sessionId: string): Promise<void> {
    // Loop: while it's an AI player's turn, make MCTS moves
    for (let guard = 0; guard < 200; guard++) {
      const state = await loadChessState(sessionId, "", "ai", null);
      if (state.status !== "playing") break;

      const currentPlayerId = state.turn === "white" ? state.whitePlayerId : state.blackPlayerId;
      const player = await getDb().player.findUnique({
        where: { id: currentPlayerId },
        select: { isAI: true },
      });
      if (!player?.isAI) break;

      // Resolve difficulty tier from state (defaulting to medium)
      const difficulty = (state.aiDifficulty ?? "medium") as "easy" | "medium" | "hard";
      const tier = CHESS_DIFFICULTY_PROFILE[difficulty];
      const move = await getChessAIMove(state, tier);
      if (!move) {
        // No move found — resign
        const resigned = resign(state);
        await saveChessState(sessionId, resigned, null);
        break;
      }

      const result = chessApplyAction(state, currentPlayerId, move.action, move.params);
      if (result.success && result.state) {
        await saveChessState(sessionId, result.state, null);
      } else {
        break;
      }

      // Advance turn in the session
      const { advanceTurn } = await import("@dge/engine/turn-order");
      await advanceTurn(sessionId);
    }
  },
};
