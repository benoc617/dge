/**
 * Search-based AI opponent: N-player MCTS and shallow MaxN.
 *
 * Both algorithms operate entirely on PureEmpireState (no DB, no async) and
 * are compatible with the simulation pipeline.
 *
 * --- MCTS (recommended) ---
 * Uses UCB1 selection across all N players simultaneously.  Each leaf is
 * expanded by generating candidate moves with generateCandidateMoves(), then
 * a rollout is played to `rolloutDepth` turns using an existing strategy
 * function.  Backpropagation stores a score vector (one slot per player).
 *
 * --- MaxN ---
 * Depth-limited full tree search.  Stochastic nodes (RNG in applyTick) are
 * handled by averaging `rngSamples` independent samples.  Branch factor is
 * pruned to `branchFactor` candidates per node.
 *
 * Both return a `CandidateMove` to be fed into pickSimAction → processAction.
 */

import {
  type PureEmpireState,
  type RivalView,
  type CandidateMove,
  applyTick,
  applyAction,
  generateCandidateMoves,
  evalState,
  makeRng,
  cloneEmpire,
  pickRolloutMove,
} from "./sim-state";
import type { ActionType } from "./game-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCTSConfig {
  /** Number of MCTS rollout iterations (default 800). Ignored when timeLimitMs is set. */
  iterations: number;
  /** Wall-clock time budget in ms. When set, runs until elapsed instead of fixed iterations. */
  timeLimitMs?: number;
  /** Turns to simulate during each rollout (default 25 = ~5 days). */
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
  /** Search depth in turns (default 5 = 1 door-game day). */
  depth: number;
  /** Candidate moves per node (default 8). */
  branchFactor: number;
  /** Number of RNG samples to average over at stochastic nodes (default 3). */
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

// ---------------------------------------------------------------------------
// MCTS
// ---------------------------------------------------------------------------

interface MCTSNode {
  move: CandidateMove | null; // null only for root
  parent: MCTSNode | null;
  children: MCTSNode[];
  visits: number;
  scores: number[]; // one entry per player, indexed by playerIdx
  untriedMoves: CandidateMove[];
  // State *after* this node's move was applied
  states: PureEmpireState[];
  currentPlayerIdx: number; // whose turn it is at this node
}

function ucb1(node: MCTSNode, parentVisits: number, explorationC: number, playerIdx: number): number {
  if (node.visits === 0) return Infinity;
  const exploitation = node.scores[playerIdx] / node.visits;
  const exploration = explorationC * Math.sqrt(Math.log(parentVisits) / node.visits);
  return exploitation + exploration;
}

/**
 * Run one MCTS rollout: random moves using the `rollout` strategy until
 * `rolloutDepth` turns have elapsed.
 */
function rollout(
  states: PureEmpireState[],
  currentPlayerIdx: number,
  depth: number,
  rng: () => number,
): number[] {
  let curStates = states.map(cloneEmpire);
  let curIdx = currentPlayerIdx;
  const n = curStates.length;

  for (let d = 0; d < depth; d++) {
    const s = curStates[curIdx];
    if (s.turnsLeft <= 0) { curIdx = (curIdx + 1) % n; continue; }

    const rivals: RivalView[] = curStates
      .filter((_, i) => i !== curIdx)
      .map((x) => ({
        id: x.id, name: x.name, netWorth: x.netWorth,
        isProtected: x.isProtected, credits: x.credits,
        population: x.population, planets: x.planets, army: x.army,
      }));

    // Apply tick
    curStates[curIdx] = applyTick(s, rng, n, true);

    // Pick a strategy-aligned move (biased toward inferred play style; much better
    // than uniform random for deferred-payoff strategies like research/supply).
    const candidates = generateCandidateMoves(curStates[curIdx], rivals, 8);
    const pick = pickRolloutMove(curStates[curIdx], candidates, rng);

    const result = applyAction(curStates[curIdx], pick.action, pick.params, rivals, rng);
    curStates[curIdx] = result.state;
    // Merge rival changes back
    for (const rv of result.rivals) {
      const idx = curStates.findIndex((x) => x.id === rv.id);
      if (idx >= 0 && idx !== curIdx) {
        curStates[idx].credits = rv.credits;
        curStates[idx].population = rv.population;
        curStates[idx].army = { ...rv.army };
      }
    }

    curIdx = (curIdx + 1) % n;
  }

  return curStates.map((s) => evalState(s, curStates));
}

/**
 * Run N-player MCTS and return the best move for `playerIdx`.
 */
export function mctsSearch(
  states: PureEmpireState[],
  playerIdx: number,
  config: Partial<MCTSConfig> = {},
): CandidateMove {
  const cfg: MCTSConfig = { ...DEFAULT_MCTS_CONFIG, ...config };
  const rng = cfg.seed !== null ? makeRng(cfg.seed) : Math.random;
  const n = states.length;

  const rivals: RivalView[] = states
    .filter((_, i) => i !== playerIdx)
    .map((s) => ({
      id: s.id, name: s.name, netWorth: s.netWorth,
      isProtected: s.isProtected, credits: s.credits,
      population: s.population, planets: s.planets, army: s.army,
    }));

  const rootCandidates = generateCandidateMoves(states[playerIdx], rivals, cfg.branchFactor);
  if (rootCandidates.length === 1) return rootCandidates[0];

  const root: MCTSNode = {
    move: null,
    parent: null,
    children: [],
    visits: 0,
    scores: Array<number>(n).fill(0),
    untriedMoves: [...rootCandidates],
    states: states.map(cloneEmpire),
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
      const moveIdx = Math.floor(rng() * node.untriedMoves.length);
      const move = node.untriedMoves.splice(moveIdx, 1)[0];
      const nextPlayerIdx = (node.currentPlayerIdx + 1) % n;

      // Apply tick for the current player, then apply the move
      const newStates = node.states.map(cloneEmpire);
      newStates[node.currentPlayerIdx] = applyTick(newStates[node.currentPlayerIdx], rng, n, true);

      const rivalViews: RivalView[] = newStates
        .filter((_, i) => i !== node.currentPlayerIdx)
        .map((s) => ({
          id: s.id, name: s.name, netWorth: s.netWorth,
          isProtected: s.isProtected, credits: s.credits,
          population: s.population, planets: s.planets, army: s.army,
        }));

      const result = applyAction(newStates[node.currentPlayerIdx], move.action, move.params, rivalViews, rng);
      newStates[node.currentPlayerIdx] = result.state;
      for (const rv of result.rivals) {
        const idx = newStates.findIndex((x) => x.id === rv.id);
        if (idx >= 0 && idx !== node.currentPlayerIdx) {
          newStates[idx].credits = rv.credits;
          newStates[idx].population = rv.population;
          newStates[idx].army = { ...rv.army };
        }
      }

      // Generate child candidates for the *next* player
      const childRivals: RivalView[] = newStates
        .filter((_, i) => i !== nextPlayerIdx)
        .map((s) => ({
          id: s.id, name: s.name, netWorth: s.netWorth,
          isProtected: s.isProtected, credits: s.credits,
          population: s.population, planets: s.planets, army: s.army,
        }));

      const child: MCTSNode = {
        move,
        parent: node,
        children: [],
        visits: 0,
        scores: Array<number>(n).fill(0),
        untriedMoves: generateCandidateMoves(newStates[nextPlayerIdx], childRivals, cfg.branchFactor),
        states: newStates,
        currentPlayerIdx: nextPlayerIdx,
      };
      node.children.push(child);
      node = child;
    }

    // 3. Simulation
    const leafScores = rollout(node.states, node.currentPlayerIdx, cfg.rolloutDepth, rng);

    // 4. Backpropagation
    let cur: MCTSNode | null = node;
    while (cur !== null) {
      cur.visits++;
      for (let i = 0; i < n; i++) {
        cur.scores[i] += leafScores[i];
      }
      cur = cur.parent;
    }
  }

  // Pick move with highest visit count at root (most robust)
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

/**
 * Recursive MaxN search.
 * Returns a score vector; at the root call, use the child with highest score[playerIdx].
 */
function maxNSearch(
  states: PureEmpireState[],
  playerIdx: number,
  depth: number,
  cfg: MaxNConfig,
  sampleRng: (i: number) => () => number,
): MaxNResult {
  const n = states.length;
  const s = states[playerIdx];

  if (depth === 0 || s.turnsLeft <= 0) {
    return { scores: states.map((x) => evalState(x, states)) };
  }

  const rivals: RivalView[] = states
    .filter((_, i) => i !== playerIdx)
    .map((x) => ({
      id: x.id, name: x.name, netWorth: x.netWorth,
      isProtected: x.isProtected, credits: x.credits,
      population: x.population, planets: x.planets, army: x.army,
    }));

  const candidates = generateCandidateMoves(s, rivals, cfg.branchFactor);
  const nextPlayerIdx = (playerIdx + 1) % n;

  let bestScores: number[] | null = null;

  for (const move of candidates) {
    // Average over `rngSamples` RNG draws
    const sampleScores = Array<number>(n).fill(0);

    for (let si = 0; si < cfg.rngSamples; si++) {
      const rng = sampleRng(si);
      const newStates = states.map(cloneEmpire);

      // Tick for current player
      newStates[playerIdx] = applyTick(newStates[playerIdx], rng, n, true);

      // Apply move
      const rivalViews: RivalView[] = newStates
        .filter((_, i) => i !== playerIdx)
        .map((x) => ({
          id: x.id, name: x.name, netWorth: x.netWorth,
          isProtected: x.isProtected, credits: x.credits,
          population: x.population, planets: x.planets, army: x.army,
        }));

      const result = applyAction(newStates[playerIdx], move.action, move.params, rivalViews, rng);
      newStates[playerIdx] = result.state;
      for (const rv of result.rivals) {
        const idx = newStates.findIndex((x) => x.id === rv.id);
        if (idx >= 0 && idx !== playerIdx) {
          newStates[idx].credits = rv.credits;
          newStates[idx].population = rv.population;
          newStates[idx].army = { ...rv.army };
        }
      }

      const childResult = maxNSearch(newStates, nextPlayerIdx, depth - 1, cfg, sampleRng);
      for (let i = 0; i < n; i++) sampleScores[i] += childResult.scores[i];
    }

    const avgScores = sampleScores.map((v) => v / cfg.rngSamples);

    // MaxN: current player maximizes their own score
    if (bestScores === null || avgScores[playerIdx] > bestScores[playerIdx]) {
      bestScores = avgScores;
    }
  }

  return { scores: bestScores ?? states.map((x) => evalState(x, states)) };
}

/**
 * Run shallow MaxN and return the best move for `playerIdx`.
 */
export function maxNMove(
  states: PureEmpireState[],
  playerIdx: number,
  config: Partial<MaxNConfig> = {},
): CandidateMove {
  const cfg: MaxNConfig = { ...DEFAULT_MAXN_CONFIG, ...config };
  const n = states.length;

  const rivals: RivalView[] = states
    .filter((_, i) => i !== playerIdx)
    .map((s) => ({
      id: s.id, name: s.name, netWorth: s.netWorth,
      isProtected: s.isProtected, credits: s.credits,
      population: s.population, planets: s.planets, army: s.army,
    }));

  const candidates = generateCandidateMoves(states[playerIdx], rivals, cfg.branchFactor);
  if (candidates.length === 1) return candidates[0];

  const nextPlayerIdx = (playerIdx + 1) % n;

  // Create per-sample RNG functions
  const baseSeed = cfg.seed !== null ? cfg.seed : Math.floor(Math.random() * 0xffffffff);
  const sampleRng = (sampleIdx: number) => makeRng(baseSeed + sampleIdx * 997);

  let bestMove = candidates[0];
  let bestScore = -Infinity;

  for (const move of candidates) {
    const sampleScores: number[] = Array<number>(n).fill(0);

    for (let si = 0; si < cfg.rngSamples; si++) {
      const rng = sampleRng(si);
      const newStates = states.map(cloneEmpire);

      // Tick for current player
      newStates[playerIdx] = applyTick(newStates[playerIdx], rng, n, true);

      // Apply move
      const rivalViews: RivalView[] = newStates
        .filter((_, i) => i !== playerIdx)
        .map((s) => ({
          id: s.id, name: s.name, netWorth: s.netWorth,
          isProtected: s.isProtected, credits: s.credits,
          population: s.population, planets: s.planets, army: s.army,
        }));

      const result = applyAction(newStates[playerIdx], move.action, move.params, rivalViews, rng);
      newStates[playerIdx] = result.state;
      for (const rv of result.rivals) {
        const idx = newStates.findIndex((x) => x.id === rv.id);
        if (idx >= 0 && idx !== playerIdx) {
          newStates[idx].credits = rv.credits;
          newStates[idx].population = rv.population;
          newStates[idx].army = { ...rv.army };
        }
      }

      const childResult = maxNSearch(newStates, nextPlayerIdx, cfg.depth - 1, cfg, sampleRng);
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

// ---------------------------------------------------------------------------
// Unified entry point for simulation / AI
// ---------------------------------------------------------------------------

export type SearchStrategy = "mcts" | "maxn";

export interface SearchOpponentConfig {
  strategy: SearchStrategy;
  mcts?: Partial<MCTSConfig>;
  maxn?: Partial<MaxNConfig>;
}

/**
 * Pick a move for `playerIdx` using the specified search strategy.
 *
 * @param states  All player states (index == player slot; playerIdx is the mover)
 * @param playerIdx  Which player is moving
 * @param cfg  Search configuration
 */
export function searchOpponentMove(
  states: PureEmpireState[],
  playerIdx: number,
  cfg: SearchOpponentConfig = { strategy: "mcts" },
): CandidateMove {
  if (cfg.strategy === "maxn") {
    return maxNMove(states, playerIdx, cfg.maxn);
  }
  return mctsSearch(states, playerIdx, cfg.mcts);
}

/**
 * Convenience: build a `states` array where the caller's empire is at index 0
 * and rivals fill the rest.
 */
export function buildSearchStates(
  self: PureEmpireState,
  rivals: PureEmpireState[],
): { states: PureEmpireState[]; playerIdx: number } {
  return {
    states: [self, ...rivals],
    playerIdx: 0,
  };
}
