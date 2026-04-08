/**
 * @dge/engine — GameOrchestrator<TState>
 *
 * The orchestrator is the "full track" complement to GameDefinition.applyAction.
 *
 * Responsibilities (pure-track path — Phase 2):
 *   1. Acquire a per-session advisory lock (withCommitLock).
 *   2. Call definition.loadState to fetch world state from the DB.
 *   3. Optionally apply a tick via definition.applyTick.
 *   4. Call definition.applyAction (synchronous, pure).
 *   5. Call definition.saveState to persist the updated world state.
 *   6. Process side effects declared in ActionResult.sideEffects.
 *   7. Return the ActionResult to the caller.
 *
 * Full-track migration shims (Phase 5):
 *   processSequentialTick / processSequentialAction — sequential mode
 *   processDoorTick / processDoorAction — door-game (simultaneous) mode
 *   These delegate to GameDefinition.processFullAction / processFullTick
 *   which proxy to the game's existing async implementations during migration.
 *   The orchestrator is constructed with TurnOrderHooks + DoorGameHooks so it
 *   can call the engine's getCurrentTurn, openFullTurn, closeFullTurn etc.
 *
 * RNG:
 *   The orchestrator creates a fresh non-deterministic Rng for each action.
 *   Pass an explicit `rng` option for reproducible tests.
 */

import type { GameDefinition, ActionResult, TickResult, Rng, FullActionResult, FullActionOptions, FullTurnReport } from "@dge/shared";
import { withCommitLock } from "./db-context";
import { getDb } from "./db-context";
import {
  getCurrentTurn,
  advanceTurn,
  type TurnOrderHooks,
  type TurnOrderInfo,
} from "./turn-order";
import {
  canPlayerAct,
  openFullTurn,
  closeFullTurn,
  tryRollRound,
  type DoorGameHooks,
} from "./door-game";

// ---------------------------------------------------------------------------
// Minimal Rng implementation for the orchestrator
// (games provide their own for simulation / MCTS; this is for live paths)
// ---------------------------------------------------------------------------

function makeProductionRng(): Rng {
  return {
    random: Math.random,
    randomInt(min: number, max: number): number {
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
    chance(p: number): boolean {
      return Math.random() < p;
    },
    shuffle<T>(arr: T[]): T[] {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestrator options (pure-track)
// ---------------------------------------------------------------------------

export interface OrchestratorActionOptions {
  /** Override the RNG (useful for deterministic testing). */
  rng?: Rng;
  /**
   * When true, the tick is NOT applied before the action.
   * Use this when the caller has already run the tick (e.g. the door-game
   * path that pre-runs the tick before opening the action window).
   */
  skipTick?: boolean;
}

export interface OrchestratorTickOptions {
  rng?: Rng;
}

// ---------------------------------------------------------------------------
// Full-track result types
// ---------------------------------------------------------------------------

/** Outcome of processSequentialTick. */
export interface SequentialTickOutcome {
  /** The turn report, or null if the tick was already processed. */
  report: FullTurnReport;
  /** True when the calling player is not the current turn player. */
  notYourTurn?: boolean;
  /** Name of the player whose turn it actually is (when notYourTurn). */
  currentPlayerName?: string;
  /** True when the session has no active turn (lobby / not started). */
  noActiveTurn?: boolean;
}

/** Outcome of processSequentialAction. */
export interface SequentialActionOutcome {
  result: FullActionResult;
  /** True when the calling player is not the current turn player. */
  notYourTurn?: boolean;
  /** Name of the player whose turn it actually is (when notYourTurn). */
  currentPlayerName?: string;
  /** True when the session has no active turn (lobby / not started). */
  noActiveTurn?: boolean;
}

/** Outcome of processDoorTick. */
export interface DoorTickOutcome {
  /** Turn report if a tick ran; null if already processed or skip. */
  report: FullTurnReport;
  /** True when the empire's turnOpen was set (but no tick ran — idempotent open). */
  turnOpened: boolean;
}

/** Outcome of processDoorAction. */
export interface DoorActionOutcome {
  result: FullActionResult;
  /**
   * True when the route should enqueue AI drain jobs after the response.
   * Always true for successful door-game actions.
   */
  scheduleAiDrain: boolean;
  /**
   * Set when the orchestrator hit an orchestration-level constraint (not a
   * game-logic failure). Routes should return HTTP 409 in this case.
   *
   *   "no_turns_left"  — canPlayerAct returned false (no daily slots)
   *   "no_open_turn"   — end_turn with no open turn slot
   *   "not_found"      — player or session missing inside lock
   */
  constraintError?: "no_turns_left" | "no_open_turn" | "not_found";
}

// ---------------------------------------------------------------------------
// GameOrchestrator
// ---------------------------------------------------------------------------

/**
 * Coordinates the full action/tick lifecycle for a game session.
 *
 * @param TState  The game's world state type (e.g. SrxWorldState for SRX).
 */
export class GameOrchestrator<TState> {
  constructor(
    readonly definition: GameDefinition<TState>,
    /** Hooks for sequential turn-order (getCurrentTurn auto-skip). */
    private readonly turnOrderHooks?: TurnOrderHooks,
    /** Hooks for door-game lifecycle (tick, endgame, cache, AI drain). */
    private readonly doorGameHooks?: DoorGameHooks,
  ) {}

  // ---------------------------------------------------------------------------
  // Pure-track methods (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Apply a tick (economy pass) for the given player, within a session lock.
   * Returns the TickResult from GameDefinition.applyTick, or null if the
   * game has no tick (e.g. chess).
   */
  async processTick(
    sessionId: string,
    playerId: string,
    opts: OrchestratorTickOptions = {},
  ): Promise<TickResult<TState> | null> {
    if (!this.definition.applyTick) return null;

    const rng = opts.rng ?? makeProductionRng();

    return withCommitLock(sessionId, async () => {
      // Cast is safe: game state types are plain objects, never thenables.
      const state = (await this.definition.loadState(sessionId, playerId, "__tick__", null)) as TState;
      const result = this.definition.applyTick!(state, rng);
      await this.definition.saveState(sessionId, result.state, null);
      return result;
    });
  }

  /**
   * Apply a player action within a session lock.
   *
   * Full track:
   *   withCommitLock → loadState → [applyTick] → applyAction → saveState → [side effects]
   */
  async processAction(
    sessionId: string,
    playerId: string,
    action: string,
    params: unknown,
    opts: OrchestratorActionOptions = {},
  ): Promise<ActionResult<TState>> {
    const rng = opts.rng ?? makeProductionRng();

    return withCommitLock(sessionId, async () => {
      // 1. Load world state
      // Cast is safe: game state types are plain objects, never thenables.
      const state = (await this.definition.loadState(sessionId, playerId, action, null)) as TState;

      // 2. Optionally apply tick first (unless caller pre-ran it)
      let currentState: TState = state;
      if (!opts.skipTick && this.definition.applyTick) {
        const tickResult = this.definition.applyTick(currentState, rng);
        currentState = tickResult.state;
      }

      // 3. Apply the action (pure, synchronous)
      const result = this.definition.applyAction(currentState, playerId, action, params, rng);

      // 4. Persist updated state
      if (result.success && result.state) {
        await this.definition.saveState(sessionId, result.state, null);
      }

      // 5. Process side effects (Phase 3+ will implement this fully)
      if (result.sideEffects?.length) {
        await this._processSideEffects(sessionId, playerId, result.sideEffects);
      }

      return result;
    });
  }

  /**
   * Generate candidate moves for a player (for AI decision-making without
   * running a full search).
   */
  async getCandidateMoves(
    sessionId: string,
    playerId: string,
  ): Promise<import("@dge/shared").Move[]> {
    const state = (await this.definition.loadState(sessionId, playerId, "__candidates__", null)) as TState;
    return this.definition.generateCandidateMoves(state, playerId);
  }

  // ---------------------------------------------------------------------------
  // Full-track migration shims — sequential mode (Phase 5)
  // ---------------------------------------------------------------------------

  /**
   * Run the economy tick for the acting player (sequential mode).
   *
   * Flow: check turn ownership → processFullTick → return report
   *
   * Returns `noActiveTurn: true` when the session has no active turn (lobby).
   * Returns `notYourTurn: true` when it's not the player's turn.
   */
  async processSequentialTick(
    sessionId: string,
    playerId: string,
  ): Promise<SequentialTickOutcome> {
    const hooks = this.turnOrderHooks;
    if (!hooks) throw new Error("GameOrchestrator: turnOrderHooks required for processSequentialTick");
    // Capture optional method to avoid TypeScript "possibly undefined" after async gaps.
    const processFullTick = this.definition.processFullTick;
    if (!processFullTick) throw new Error("GameOrchestrator: definition.processFullTick required");

    const turn = await getCurrentTurn(sessionId, hooks);
    if (!turn) {
      return { report: null, noActiveTurn: true };
    }
    if (turn.currentPlayerId !== playerId) {
      return { report: null, notYourTurn: true, currentPlayerName: turn.currentPlayerName };
    }

    const report = await processFullTick.call(this.definition, playerId);
    return { report };
  }

  /**
   * Execute a player action in sequential (turn-order enforced) mode.
   *
   * Flow: check turn → processFullAction → advanceTurn → runAiSequence (bg)
   *
   * Returns `noActiveTurn: true` or `notYourTurn: true` when the action
   * cannot proceed due to turn enforcement.
   */
  async processSequentialAction(
    sessionId: string,
    playerId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<SequentialActionOutcome> {
    const hooks = this.turnOrderHooks;
    if (!hooks) throw new Error("GameOrchestrator: turnOrderHooks required for processSequentialAction");
    // Capture optional methods once to avoid TypeScript "possibly undefined" after async gaps.
    const processFullAction = this.definition.processFullAction;
    const runAiSequence = this.definition.runAiSequence;
    if (!processFullAction) throw new Error("GameOrchestrator: definition.processFullAction required");

    const turn = await getCurrentTurn(sessionId, hooks);
    if (!turn) {
      return {
        result: { success: false, message: "No active turn in this session." },
        noActiveTurn: true,
      };
    }
    if (turn.currentPlayerId !== playerId) {
      return {
        result: { success: false, message: `It's ${turn.currentPlayerName}'s turn` },
        notYourTurn: true,
        currentPlayerName: turn.currentPlayerName,
      };
    }

    const result = await processFullAction.call(this.definition, playerId, action, params);

    if (result.success) {
      await advanceTurn(sessionId);
      // Fire-and-forget AI sequence (sequential mode)
      if (runAiSequence) {
        runAiSequence.call(this.definition, sessionId).catch(() => {});
      }
    }

    return { result };
  }

  // ---------------------------------------------------------------------------
  // Full-track migration shims — door-game (simultaneous) mode (Phase 5)
  // ---------------------------------------------------------------------------

  /**
   * Open a new full-turn slot for a player in door-game (simultaneous) mode.
   *
   * Flow (inside lock): tryRollRound → openFullTurn → return tick report
   *
   * The caller is responsible for pre-checking canPlayerAct and turnOpen
   * (these are quick checks that can be done before acquiring the lock).
   */
  async processDoorTick(
    sessionId: string,
    playerId: string,
  ): Promise<DoorTickOutcome> {
    const hooks = this.doorGameHooks;
    if (!hooks) throw new Error("GameOrchestrator: doorGameHooks required for processDoorTick");

    return withCommitLock(sessionId, async () => {
      await tryRollRound(sessionId, hooks);
      const report = await openFullTurn(playerId, hooks);

      // Re-fetch empire to check turnOpen (openFullTurn may have set it even
      // without running a tick, if tickProcessed was already true).
      const emp = await getDb().empire.findUnique({
        where: { playerId },
        select: { turnOpen: true },
      });

      if (emp?.turnOpen && !report) {
        return { report: null, turnOpened: true };
      }
      return { report: report as FullTurnReport, turnOpened: false };
    });
  }

  /**
   * Execute a player action in door-game (simultaneous) mode.
   *
   * Flow (inside lock):
   *   canPlayerAct check → openFullTurn if needed →
   *   processFullAction → postActionClose or closeFullTurn
   *
   * Returns `scheduleAiDrain: true` when the route should enqueue AI jobs.
   */
  async processDoorAction(
    sessionId: string,
    playerId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<DoorActionOutcome> {
    const hooks = this.doorGameHooks;
    if (!hooks) throw new Error("GameOrchestrator: doorGameHooks required for processDoorAction");
    // Capture optional methods to avoid TypeScript "possibly undefined" after async gaps.
    const processFullAction = this.definition.processFullAction;
    const postActionClose = this.definition.postActionClose;
    if (!processFullAction) throw new Error("GameOrchestrator: definition.processFullAction required");

    return withCommitLock(sessionId, async () => {
      // Load fresh empire + session data inside the lock.
      const [player, session] = await Promise.all([
        getDb().player.findUnique({
          where: { id: playerId },
          include: { empire: true },
        }),
        getDb().gameSession.findUnique({
          where: { id: sessionId },
          select: { actionsPerDay: true },
        }),
      ]);

      if (!player?.empire) {
        return {
          result: { success: false, message: "Player not found" },
          scheduleAiDrain: false,
          constraintError: "not_found" as const,
        };
      }
      if (!session) {
        return {
          result: { success: false, message: "Session not found" },
          scheduleAiDrain: false,
          constraintError: "not_found" as const,
        };
      }

      const empire = player.empire;

      if (!canPlayerAct(empire, session.actionsPerDay)) {
        return {
          result: {
            success: false,
            message: "No full turns remaining today in this calendar round.",
          },
          scheduleAiDrain: false,
          constraintError: "no_turns_left" as const,
        };
      }

      // Open the full-turn slot if not already open.
      if (!empire.turnOpen) {
        if (action === "end_turn") {
          return {
            result: {
              success: false,
              message: "No open turn to end. Open a turn with POST /api/game/tick first (or take an action).",
            },
            scheduleAiDrain: false,
            constraintError: "no_open_turn" as const,
          };
        }
        await openFullTurn(playerId, hooks);
      }

      // Build door-game opts based on action type.
      const doorOpts: FullActionOptions =
        action === "end_turn"
          ? { tickOptions: { decrementTurnsLeft: false }, keepTickProcessed: false, skipEndgameSettlement: true }
          : { tickOptions: { decrementTurnsLeft: false }, keepTickProcessed: true, skipEndgameSettlement: true };

      const result = await processFullAction.call(this.definition, playerId, action, params, doorOpts);

      if (result.success) {
        if (action === "end_turn") {
          await closeFullTurn(playerId, sessionId, hooks);
        } else {
          // Let the game override post-action close (e.g. SRX creates a TurnLog row first).
          if (postActionClose) {
            await postActionClose.call(this.definition, playerId, sessionId);
          } else {
            await closeFullTurn(playerId, sessionId, hooks);
          }
        }
      }

      return { result, scheduleAiDrain: result.success };
    });
  }

  // ---------------------------------------------------------------------------
  // Side effect processing (stub — Phase 3+ will implement fully)
  // ---------------------------------------------------------------------------

  private async _processSideEffects(
    sessionId: string,
    playerId: string,
    sideEffects: NonNullable<ActionResult<TState>["sideEffects"]>,
  ): Promise<void> {
    // Phase 2 stub: side effects are logged but not persisted.
    // Phase 3+ will process gameEvent, turnLog, defenderAlert side effects.
    for (const effect of sideEffects) {
      void sessionId;
      void playerId;
      void effect;
      // TODO: implement side effect persistence in Phase 3+
    }
  }
}
