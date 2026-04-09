/**
 * @dge/engine — Generic N-player MCTS and shallow MaxN search.
 *
 * Both algorithms are parameterized by SearchGameFunctions<TState>, where
 * TState is a complete world state containing all player data. Games that
 * track players as a separate array (e.g. one state-slice per player) should
 * wrap that array in a single object and implement SearchGameFunctions for it.
 *
 * --- MCTS (recommended) ---
 * UCB1 selection across all N players simultaneously. Each leaf is expanded
 * by generating candidate moves, then a rollout plays to `rolloutDepth` turns.
 * Backpropagation stores a score vector (one slot per player).
 *
 * --- MaxN ---
 * Depth-limited full tree search. Stochastic nodes (RNG in applyTick) are
 * handled by averaging `rngSamples` samples. Branch factor pruned to
 * `branchFactor` candidates per node.
 *
 * Both return a Move to feed into the game's action processing path.
 */

import type { Move } from "@dge/shared";

// ---------------------------------------------------------------------------
// Game function interface — what the search algorithms call into
// ---------------------------------------------------------------------------

/**
 * The functions a game must provide to plug into the generic MCTS/MaxN search.
 *
 * TState is a single complete world state containing all players' data.
 * The engine never constructs a per-player sub-state; playerIdx is always
 * passed explicitly so the game can look up the right player within TState.
 */
export interface SearchGameFunctions<TState> {
  /**
   * Apply an economy/physics tick for the player at playerIdx.
   * Must be synchronous and pure (no I/O).
   */
  applyTick(state: TState, playerIdx: number, rng: () => number, playerCount: number): TState;

  /**
   * Apply a player action for the player at playerIdx.
   * Must be synchronous and pure. Returns the updated state and whether the
   * action succeeded (failed actions are silently skipped in rollouts).
   */
  applyAction(
    state: TState,
    playerIdx: number,
    action: string,
    params: Record<string, unknown>,
    rng: () => number,
  ): { state: TState; success: boolean };

  /**
   * Score the state from the perspective of playerIdx. Higher is better.
   * Used during backpropagation and at terminal nodes.
   */
  evalState(state: TState, playerIdx: number): number;

  /**
   * Generate candidate moves for the player at playerIdx.
   * Pass maxMoves to limit the branch factor for performance.
   */
  generateCandidateMoves(state: TState, playerIdx: number, maxMoves: number): Move[];

  /**
   * Deep-clone the state so the search can speculatively mutate it without
   * affecting the original. Must return a fully independent copy.
   */
  cloneState(state: TState): TState;

  /**
   * Pick a single move from the candidates during a rollout.
   * Implementations can use strategy-aligned heuristics (biases the rollout
   * toward realistic play styles rather than uniform random).
   */
  pickRolloutMove(state: TState, playerIdx: number, candidates: Move[], rng: () => number): Move;

  /** How many players are in this state. */
  getPlayerCount(state: TState): number;

  /**
   * Returns true when this player has no more turns (game over for them).
   * The rollout loop skips players for whom this returns true.
   */
  isTerminal(state: TState, playerIdx: number): boolean;
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface MCTSConfig {
  /** Number of MCTS iterations (default 800). Ignored when timeLimitMs is set. */
  iterations: number;
  /** Wall-clock time budget in ms. When set, runs until elapsed instead of fixed iterations. */
  timeLimitMs?: number;
  /** Turns to simulate during each rollout (default 30). */
  rolloutDepth: number;
  /** UCB1 exploration constant (default sqrt(2) ≈ 1.41). */
  explorationC: number;
  /** Candidate moves per node (default 12). */
  branchFactor: number;
  /** RNG seed for reproducibility (null = Math.random). */
  seed: number | null;
}

export const DEFAULT_MCTS_CONFIG: MCTSConfig = {
  iterations: 800,
  rolloutDepth: 30,
  explorationC: Math.SQRT2,
  branchFactor: 12,
  seed: null,
};

export interface MaxNConfig {
  /** Search depth in turns (default 5). */
  depth: number;
  /** Candidate moves per node (default 8). */
  branchFactor: number;
  /** RNG samples to average over at stochastic nodes (default 3). */
  rngSamples: number;
  /** RNG seed for reproducibility (null = Math.random). */
  seed: number | null;
}

export const DEFAULT_MAXN_CONFIG: MaxNConfig = {
  depth: 5,
  branchFactor: 8,
  rngSamples: 3,
  seed: null,
};

export type SearchStrategy = "mcts" | "maxn";

export interface SearchOpponentConfig {
  strategy: SearchStrategy;
  mcts?: Partial<MCTSConfig>;
  maxn?: Partial<MaxNConfig>;
}

// ---------------------------------------------------------------------------
// Internal: simple mulberry32 RNG (no shared state)
// ---------------------------------------------------------------------------

function makeSeedRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// MCTS internals
// ---------------------------------------------------------------------------

interface MCTSNode<TState> {
  move: Move | null;          // null only at root
  parent: MCTSNode<TState> | null;
  children: MCTSNode<TState>[];
  visits: number;
  scores: number[];            // one entry per player
  untriedMoves: Move[];
  state: TState;               // world state *after* this node's move was applied
  currentPlayerIdx: number;    // whose turn it is at this node
}

function ucb1(node: MCTSNode<unknown>, parentVisits: number, explorationC: number, playerIdx: number): number {
  if (node.visits === 0) return Infinity;
  const exploitation = node.scores[playerIdx] / node.visits;
  const exploration = explorationC * Math.sqrt(Math.log(parentVisits) / node.visits);
  return exploitation + exploration;
}

function rollout<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  currentPlayerIdx: number,
  depth: number,
  rng: () => number,
): number[] {
  let curState = game.cloneState(state);
  let curIdx = currentPlayerIdx;
  const n = game.getPlayerCount(state);

  for (let d = 0; d < depth; d++) {
    if (game.isTerminal(curState, curIdx)) {
      curIdx = (curIdx + 1) % n;
      continue;
    }
    curState = game.applyTick(curState, curIdx, rng, n);
    const candidates = game.generateCandidateMoves(curState, curIdx, 8);
    if (candidates.length === 0) {
      curIdx = (curIdx + 1) % n;
      continue;
    }
    const pick = game.pickRolloutMove(curState, curIdx, candidates, rng);
    const result = game.applyAction(curState, curIdx, pick.action, pick.params, rng);
    curState = result.state;
    curIdx = (curIdx + 1) % n;
  }

  return Array.from({ length: n }, (_, i) => game.evalState(curState, i));
}

function expandNode<TState>(
  game: SearchGameFunctions<TState>,
  node: MCTSNode<TState>,
  cfg: MCTSConfig,
  rng: () => number,
): MCTSNode<TState> {
  const n = game.getPlayerCount(node.state);
  const moveIdx = Math.floor(rng() * node.untriedMoves.length);
  const move = node.untriedMoves.splice(moveIdx, 1)[0];
  const nextPlayerIdx = (node.currentPlayerIdx + 1) % n;

  let newState = game.cloneState(node.state);
  newState = game.applyTick(newState, node.currentPlayerIdx, rng, n);
  const result = game.applyAction(newState, node.currentPlayerIdx, move.action, move.params, rng);
  newState = result.state;

  const child: MCTSNode<TState> = {
    move,
    parent: node,
    children: [],
    visits: 0,
    scores: Array<number>(n).fill(0),
    untriedMoves: game.generateCandidateMoves(newState, nextPlayerIdx, cfg.branchFactor),
    state: newState,
    currentPlayerIdx: nextPlayerIdx,
  };
  node.children.push(child);
  return child;
}

function backpropagate<TState>(node: MCTSNode<TState>, scores: number[]): void {
  let cur: MCTSNode<TState> | null = node;
  while (cur !== null) {
    cur.visits++;
    for (let i = 0; i < scores.length; i++) {
      cur.scores[i] += scores[i];
    }
    cur = cur.parent;
  }
}

// ---------------------------------------------------------------------------
// MCTS — synchronous
// ---------------------------------------------------------------------------

/**
 * Run N-player MCTS and return the best move for the player at playerIdx.
 */
export function mctsSearch<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  config: Partial<MCTSConfig> = {},
): Move {
  const cfg: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, ...config };
  const rng = cfg.seed !== null ? makeSeedRng(cfg.seed) : Math.random;
  const n = game.getPlayerCount(state);

  const rootCandidates = game.generateCandidateMoves(state, playerIdx, cfg.branchFactor);
  if (rootCandidates.length === 0) throw new Error("mctsSearch: no candidate moves available");
  if (rootCandidates.length === 1) return rootCandidates[0];

  const root: MCTSNode<TState> = {
    move: null,
    parent: null,
    children: [],
    visits: 0,
    scores: Array<number>(n).fill(0),
    untriedMoves: [...rootCandidates],
    state: game.cloneState(state),
    currentPlayerIdx: playerIdx,
  };

  const deadline = cfg.timeLimitMs != null ? Date.now() + cfg.timeLimitMs : null;
  for (let iter = 0; deadline !== null ? Date.now() < deadline : iter < cfg.iterations; iter++) {
    // 1. Selection
    let node = root;
    while (node.untriedMoves.length === 0 && node.children.length > 0) {
      node = node.children.reduce((best, child) =>
        ucb1(child, node.visits, cfg.explorationC, node.currentPlayerIdx) >
        ucb1(best, node.visits, cfg.explorationC, node.currentPlayerIdx)
          ? child
          : best,
      );
    }

    // 2. Expansion
    if (node.untriedMoves.length > 0) {
      node = expandNode(game, node, cfg, rng);
    }

    // 3. Simulation
    const leafScores = rollout(game, node.state, node.currentPlayerIdx, cfg.rolloutDepth, rng);

    // 4. Backpropagation
    backpropagate(node, leafScores);
  }

  if (root.children.length === 0) return rootCandidates[0];
  const best = root.children.reduce((a, b) => (a.visits > b.visits ? a : b));
  return best.move ?? rootCandidates[0];
}

// ---------------------------------------------------------------------------
// MCTS — async (yields event loop periodically to avoid starving HTTP)
// ---------------------------------------------------------------------------

const YIELD_INTERVAL_MS = 5;
const yieldEventLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Async variant of mctsSearch. Yields the event loop every ~5ms so HTTP
 * requests are not starved during long (e.g. 45s) MCTS budgets.
 * Identical algorithm — only the outer loop adds periodic yields.
 */
export async function mctsSearchAsync<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  config: Partial<MCTSConfig> = {},
): Promise<Move> {
  const cfg: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, ...config };
  const rng = cfg.seed !== null ? makeSeedRng(cfg.seed) : Math.random;
  const n = game.getPlayerCount(state);

  const rootCandidates = game.generateCandidateMoves(state, playerIdx, cfg.branchFactor);
  if (rootCandidates.length === 0) throw new Error("mctsSearchAsync: no candidate moves available");
  if (rootCandidates.length === 1) return rootCandidates[0];

  const root: MCTSNode<TState> = {
    move: null,
    parent: null,
    children: [],
    visits: 0,
    scores: Array<number>(n).fill(0),
    untriedMoves: [...rootCandidates],
    state: game.cloneState(state),
    currentPlayerIdx: playerIdx,
  };

  const deadline = cfg.timeLimitMs != null ? Date.now() + cfg.timeLimitMs : null;
  let lastYield = Date.now();

  for (let iter = 0; deadline !== null ? Date.now() < deadline : iter < cfg.iterations; iter++) {
    const now = Date.now();
    if (now - lastYield >= YIELD_INTERVAL_MS) {
      await yieldEventLoop();
      lastYield = Date.now();
    }

    let node = root;
    while (node.untriedMoves.length === 0 && node.children.length > 0) {
      node = node.children.reduce((best, child) =>
        ucb1(child, node.visits, cfg.explorationC, node.currentPlayerIdx) >
        ucb1(best, node.visits, cfg.explorationC, node.currentPlayerIdx)
          ? child
          : best,
      );
    }

    if (node.untriedMoves.length > 0) {
      node = expandNode(game, node, cfg, rng);
    }

    const leafScores = rollout(game, node.state, node.currentPlayerIdx, cfg.rolloutDepth, rng);
    backpropagate(node, leafScores);
  }

  if (root.children.length === 0) return rootCandidates[0];
  const best = root.children.reduce((a, b) => (a.visits > b.visits ? a : b));
  return best.move ?? rootCandidates[0];
}

// ---------------------------------------------------------------------------
// MaxN
// ---------------------------------------------------------------------------

interface MaxNResult {
  scores: number[]; // one per player
}

function maxNSearch<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  depth: number,
  cfg: MaxNConfig,
  sampleRng: (i: number) => () => number,
): MaxNResult {
  const n = game.getPlayerCount(state);

  if (depth === 0 || game.isTerminal(state, playerIdx)) {
    return { scores: Array.from({ length: n }, (_, i) => game.evalState(state, i)) };
  }

  const candidates = game.generateCandidateMoves(state, playerIdx, cfg.branchFactor);
  const nextPlayerIdx = (playerIdx + 1) % n;

  let bestScores: number[] | null = null;

  for (const move of candidates) {
    const sampleScores = Array<number>(n).fill(0);

    for (let si = 0; si < cfg.rngSamples; si++) {
      const rng = sampleRng(si);
      let newState = game.cloneState(state);
      newState = game.applyTick(newState, playerIdx, rng, n);
      const result = game.applyAction(newState, playerIdx, move.action, move.params, rng);
      newState = result.state;

      const childResult = maxNSearch(game, newState, nextPlayerIdx, depth - 1, cfg, sampleRng);
      for (let i = 0; i < n; i++) sampleScores[i] += childResult.scores[i];
    }

    const avgScores = sampleScores.map((v) => v / cfg.rngSamples);
    if (bestScores === null || avgScores[playerIdx] > bestScores[playerIdx]) {
      bestScores = avgScores;
    }
  }

  return {
    scores: bestScores ?? Array.from({ length: n }, (_, i) => game.evalState(state, i)),
  };
}

/**
 * Run shallow MaxN and return the best move for the player at playerIdx.
 */
export function maxNMove<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  config: Partial<MaxNConfig> = {},
): Move {
  const cfg: MaxNConfig = { ...DEFAULT_MAXN_CONFIG, ...config };
  const n = game.getPlayerCount(state);

  const candidates = game.generateCandidateMoves(state, playerIdx, cfg.branchFactor);
  if (candidates.length === 0) throw new Error("maxNMove: no candidate moves available");
  if (candidates.length === 1) return candidates[0];

  const nextPlayerIdx = (playerIdx + 1) % n;
  const baseSeed = cfg.seed !== null ? cfg.seed : Math.floor(Math.random() * 0xffffffff);
  const sampleRng = (sampleIdx: number) => makeSeedRng(baseSeed + sampleIdx * 997);

  let bestMove = candidates[0];
  let bestScore = -Infinity;

  for (const move of candidates) {
    const sampleScores: number[] = Array<number>(n).fill(0);

    for (let si = 0; si < cfg.rngSamples; si++) {
      const rng = sampleRng(si);
      let newState = game.cloneState(state);
      newState = game.applyTick(newState, playerIdx, rng, n);
      const result = game.applyAction(newState, playerIdx, move.action, move.params, rng);
      newState = result.state;

      const childResult = maxNSearch(game, newState, nextPlayerIdx, cfg.depth - 1, cfg, sampleRng);
      sampleScores[playerIdx] += childResult.scores[playerIdx];
    }

    const avgScore = sampleScores[playerIdx] / cfg.rngSamples;
    if (avgScore > bestScore) {
      bestScore = avgScore;
      bestMove = move;
    }
  }

  return bestMove;
}

/**
 * Pick a move using the specified search strategy.
 */
export function searchOpponentMove<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  cfg: SearchOpponentConfig = { strategy: "mcts" },
): Move {
  if (cfg.strategy === "maxn") return maxNMove(game, state, playerIdx, cfg.maxn);
  return mctsSearch(game, state, playerIdx, cfg.mcts);
}

/**
 * Async variant — use this from live server paths to avoid starving HTTP.
 */
export async function searchOpponentMoveAsync<TState>(
  game: SearchGameFunctions<TState>,
  state: TState,
  playerIdx: number,
  cfg: SearchOpponentConfig = { strategy: "mcts" },
): Promise<Move> {
  if (cfg.strategy === "maxn") return maxNMove(game, state, playerIdx, cfg.maxn);
  return mctsSearchAsync(game, state, playerIdx, cfg.mcts);
}
