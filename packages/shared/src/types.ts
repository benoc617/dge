/**
 * @dge/shared — Core types for the Door Game Engine.
 *
 * These interfaces define the contract between the engine infrastructure
 * and individual game implementations. Every game provides a
 * GameDefinition<TState> that the engine calls into.
 */

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

/** Seedable random number generator interface. */
export interface Rng {
  /** Returns a float in [0, 1). */
  random(): number;
  /** Returns an integer in [min, max] inclusive. */
  randomInt(min: number, max: number): number;
  /** Returns true with probability p (0..1). */
  chance(p: number): boolean;
  /** Shuffles an array in place (Fisher-Yates). Returns the same array. */
  shuffle<T>(arr: T[]): T[];
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** A candidate action a player or AI can take. */
export interface Move {
  action: string;
  params: Record<string, unknown>;
  /** Human-readable label for UI and debugging. */
  label: string;
}

// ---------------------------------------------------------------------------
// Replay / Observability
// ---------------------------------------------------------------------------

/**
 * A single frame in a replay sequence. Games produce these as part of
 * ActionResult or TickResult to let other players watch what happened.
 *
 * Usage by game type:
 *   - Chess: one frame per move (trivial)
 *   - SRX combat: 3-4 frames (ground assault, space battle, aftermath)
 *   - Physics games (pool, curling): keyframes per collision/rest event
 *
 * MCTS ignores replay frames entirely — it only reads ActionResult.state.
 * For expensive frame generation, implement GameDefinition.generateReplay
 * instead of populating replay in applyAction.
 */
export interface ReplayFrame<TState> {
  /** World state at this point in the sequence. */
  state: TState;
  /** Human-readable description of what happened. */
  event: string;
  /** How long to show this frame during playback (ms). Optional hint. */
  durationMs?: number;
  /** Game-specific rendering metadata (e.g. ball positions, attack vectors). */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Side Effects
// ---------------------------------------------------------------------------

/**
 * A side effect declared by applyAction that the orchestrator will persist
 * after saving state. Keeps applyAction pure while allowing games to emit
 * events, turn logs, alerts, etc.
 */
export type SideEffect =
  | { type: "gameEvent"; data: { message: string; eventType: string; details?: Record<string, unknown> } }
  | { type: "turnLog"; data: { action: string; details?: Record<string, unknown> } }
  | { type: "defenderAlert"; data: { targetPlayerId: string; message: string } }
  | { type: "custom"; name: string; data: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Action + Tick Results
// ---------------------------------------------------------------------------

/** Result returned by GameDefinition.applyAction. */
export interface ActionResult<TState> {
  success: boolean;
  /** Updated world state. Present when success is true. */
  state?: TState;
  /** Human-readable outcome message. */
  message: string;
  /** True when this action ends the game. */
  gameOver?: boolean;
  /** Winner's playerId, or null for a draw. Only set when gameOver is true. */
  winner?: string | null;
  /** Step-by-step replay for other players to watch. */
  replay?: ReplayFrame<TState>[];
  /** Side effects the orchestrator should persist after saving state. */
  sideEffects?: SideEffect[];
  /** Arbitrary extra data for the UI (e.g. combatResult, covertOpResult). */
  details?: Record<string, unknown>;
}

/** Result returned by GameDefinition.applyTick. */
export interface TickResult<TState> {
  state: TState;
  /** Step-by-step replay (e.g. physics resolution). */
  replay?: ReplayFrame<TState>[];
  /** Summary stats for the turn report (e.g. income, expenses, population). */
  report?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Full-track migration shims
// ---------------------------------------------------------------------------

/**
 * Options passed by the orchestrator to `GameDefinition.processFullAction`.
 *
 * The `context` field tells the game *how* the orchestrator is calling it so
 * the game can apply turn-mode-specific behavior internally without the engine
 * knowing game-specific details (e.g. SRX's keepTickProcessed / decrementTurnsLeft).
 *
 * The orchestrator sets context based on turn mode:
 *   - Sequential:              { context: { turnMode: "sequential" } }
 *   - Door-game end_turn:      { context: { turnMode: "door-game", isEndTurn: true } }
 *   - Door-game other action:  { context: { turnMode: "door-game", isEndTurn: false } }
 */
export interface FullActionOptions {
  /**
   * Context about how the orchestrator is invoking processFullAction.
   * Games read this to apply turn-mode-specific behavior internally.
   */
  context?: {
    /** "sequential" | "door-game" */
    turnMode?: string;
    /**
     * True when this action explicitly closes the player's turn window
     * (door-game end_turn). False for all other actions.
     */
    isEndTurn?: boolean;
  };
  /** Arbitrary extra meta (e.g. llmSource, aiReasoning) passed to turn logging. */
  logMeta?: Record<string, unknown>;
}

/**
 * Minimum shape returned by `GameDefinition.processFullAction`.
 * Must structurally include `success` and `message`; game-specific fields
 * are carried through as unknown extras (e.g. `actionDetails` for combat).
 */
export interface FullActionResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

/**
 * Turn report returned by `GameDefinition.processFullTick`.
 * Null = tick was already processed (idempotent).
 */
export type FullTurnReport = Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Admin Extension
// ---------------------------------------------------------------------------

/** An admin page a game registers under /admin/games/{gameType}/{path}. */
export interface AdminPage {
  path: string;
  label: string;
  // Component type omitted here (no React dep in shared) — added in @dge/shell
}

/** Game-specific admin configuration. */
export interface GameAdminConfig {
  /** Columns to display in the engine's /admin/highscores for this game. */
  highScoreColumns?: Array<{
    key: string;
    label: string;
    format?: (value: unknown) => string;
  }>;
  /** Called after the engine deletes high scores for this game type. */
  onHighScoreReset?: (gameType: string) => Promise<void>;
  /** Extra admin pages mounted under /admin/games/{gameType}/. */
  adminPages?: AdminPage[];
}

// ---------------------------------------------------------------------------
// Game Definition
// ---------------------------------------------------------------------------

/**
 * The contract a game must implement to plug into the DGE engine.
 *
 * TState is the complete world state for the game. Player state is a subset
 * of world state — there is no separate per-player concept. Functions that
 * need perspective accept a `playerId` parameter.
 *
 * Two tracks for action processing:
 *   - Pure track (applyAction): synchronous, no DB, used by MCTS + simulation.
 *   - Full track (GameOrchestrator): loadState → applyAction → saveState + side effects.
 */
export interface GameDefinition<TState> {
  // -------------------------------------------------------------------------
  // Persistence (full track only)
  // -------------------------------------------------------------------------

  /**
   * Load world state from the DB for the given session + acting player.
   * The action parameter lets games load selectively (e.g. only load the
   * target empire for combat actions, skip it for buy_planet).
   */
  loadState(
    sessionId: string,
    playerId: string,
    action: string,
    db: unknown,
  ): Promise<TState>;

  /**
   * Persist updated world state back to the DB.
   * Implementations should be surgical — only write what changed.
   */
  saveState(sessionId: string, state: TState, db: unknown): Promise<void>;

  // -------------------------------------------------------------------------
  // Pure game logic (both tracks)
  // -------------------------------------------------------------------------

  /**
   * Apply an economy/physics tick. Optional — games without a tick (e.g. chess)
   * omit this and the engine treats it as identity.
   */
  applyTick?(state: TState, rng: Rng): TickResult<TState>;

  /**
   * Apply a player action. Must be synchronous and pure (no DB, no side effects).
   * Side effects (events, logs) are declared in ActionResult.sideEffects.
   *
   * This is the function the MCTS search calls thousands of times in memory.
   * Do not call external I/O here.
   */
  applyAction(
    state: TState,
    playerId: string,
    action: string,
    params: unknown,
    rng: Rng,
  ): ActionResult<TState>;

  /**
   * Score the state from the perspective of forPlayerId.
   * Used by MCTS and MaxN search. Higher is better.
   * Should return a value in a consistent range (e.g. 0..1 or unbounded).
   */
  evalState(state: TState, forPlayerId: string): number;

  /**
   * Generate candidate moves for the acting player.
   * The engine's AI and search use this to prune the action space.
   */
  generateCandidateMoves(state: TState, forPlayerId: string): Move[];

  // -------------------------------------------------------------------------
  // Optional extensions
  // -------------------------------------------------------------------------

  /**
   * Project world state for a specific client — hide private information.
   * Default (when omitted): identity (full information game).
   *
   * Examples: hide opponent's hand in a card game; hide ship positions in
   * Battleship; hide exact enemy counts behind fog of war.
   */
  projectState?(state: TState, forPlayerId: string): TState;

  /**
   * Build LLM prompt context for the AI player.
   * Omit to use the engine's generic fallback prompt.
   */
  buildAIContext?(state: TState, forPlayerId: string): unknown;

  /**
   * Convert live state (may have DB-shaped objects) to plain objects safe
   * for structured clone / worker thread postMessage.
   * Used to hand state to MCTS worker threads.
   * Default (when omitted): identity (state is already plain objects).
   */
  toPureState?(state: TState): TState;

  /**
   * Generate replay frames from a before/after state pair.
   * Implement this instead of populating ActionResult.replay when frame
   * generation is expensive (e.g. full physics simulation) and should be
   * skipped during MCTS rollouts. The orchestrator calls this after applyAction
   * on the real (non-search) path.
   */
  generateReplay?(
    before: TState,
    after: TState,
    action: string,
    params: unknown,
  ): ReplayFrame<TState>[];

  /** Admin panel extensions for this game. */
  admin?: GameAdminConfig;

  // -------------------------------------------------------------------------
  // Full-track migration shims (Phase 5+)
  //
  // These optional methods let a game plug its existing async action/tick
  // implementations into the orchestrator's sequential and door-game flows
  // without yet extracting every handler into the pure applyAction.
  //
  // Games that have fully migrated to pure applyAction can omit these; the
  // orchestrator will use applyAction + saveState instead.
  // -------------------------------------------------------------------------

  /**
   * Run a player action via the game's existing full-track implementation
   * (async, DB-backed). Called by the orchestrator in place of the pure
   * applyAction + saveState path during incremental migration.
   *
   * The `opts` parameter carries turn-mode-specific overrides set by the
   * orchestrator (e.g. door-game tick/settlement flags).
   */
  processFullAction?(
    playerId: string,
    action: string,
    params: Record<string, unknown>,
    opts?: FullActionOptions,
  ): Promise<FullActionResult>;

  /**
   * Run the economy tick via the game's existing full-track implementation.
   * Returns the turn report (or null if already processed / not applicable).
   */
  processFullTick?(playerId: string): Promise<FullTurnReport>;

  /**
   * Fire-and-forget AI sequence for the session (sequential mode).
   * The orchestrator calls this after advancing the turn; games that have no
   * AI, or that manage AI externally, can omit this.
   */
  runAiSequence?(sessionId: string): Promise<void>;

  /**
   * Post-action close for door-game mode: called after a successful non-end_turn
   * action to close the full-turn slot. Games override this to add extra work
   * (e.g. SRX creates a TurnLog row before calling closeFullTurn). When omitted,
   * the orchestrator calls the engine's closeFullTurn directly.
   */
  postActionClose?(playerId: string, sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Game Metadata (lobby & registration)
// ---------------------------------------------------------------------------

/**
 * A single option displayed in the "Create Game" lobby form.
 * The register route collects these as `gameOptions` and passes them to
 * the adapter's `onSessionCreated` hook.
 */
export interface GameCreateOption {
  key: string;
  label: string;
  description?: string;
  type: "number" | "boolean" | "select";
  default: unknown;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

/**
 * Static metadata a game registers for lobby/UI use.
 * Drives the game-select cards, create-game form, and join rules
 * without requiring per-game React components in the lobby.
 */
export interface GameMetadata {
  /** Canonical key matching `GameSession.gameType`. e.g. "srx", "chess" */
  game: string;
  /** Human-readable name shown on the game-select card. */
  displayName: string;
  /** Short description shown on the game-select card. */
  description: string;
  /** [min, max] players for sessions of this game. */
  playerRange: [number, number];
  /** Whether human players can join an existing session via invite/public list. */
  supportsJoin: boolean;
  /** When true, the server automatically creates an AI opponent on session creation. */
  autoCreateAI?: boolean;
  /** Per-game options shown in the create-game form (rendered dynamically). */
  createOptions: GameCreateOption[];
}

// ---------------------------------------------------------------------------
// Game HTTP Adapter (API route delegation)
// ---------------------------------------------------------------------------

/**
 * Per-game hooks for API routes. Registered alongside GameDefinition so routes
 * stay game-agnostic and delegate all game-specific payload construction here.
 *
 * Required: buildStatus (replaces the SRX-specific buildResponse in status/route.ts).
 * Optional: all other methods fall back to sensible generic defaults when omitted.
 */
export interface GameHttpAdapter {
  // -------------------------------------------------------------------------
  // Status & read paths
  // -------------------------------------------------------------------------

  /**
   * Build the full status payload for GET /api/game/status and POST /api/game/status.
   * Replaces the monolithic SRX buildResponse() function.
   */
  buildStatus(playerId: string): Promise<Record<string, unknown>>;

  /**
   * Build the leaderboard rows for GET /api/game/leaderboard.
   * When omitted the route returns an empty array.
   */
  buildLeaderboard?(sessionId: string | null): Promise<unknown[]>;

  /**
   * Build the game-over payload for POST /api/game/gameover.
   * When omitted the route returns a minimal generic response.
   */
  buildGameOver?(sessionId: string, playerName: string): Promise<Record<string, unknown>>;

  // -------------------------------------------------------------------------
  // Session & player initialization
  // -------------------------------------------------------------------------

  /**
   * Returns Prisma nested-create data merged into the player.create() call.
   *   SRX: { empire: { create: createStarterEmpire(createStarterPlanets()) } }
   *   Chess: {} — state lives in GameSession.log
   */
  getPlayerCreateData(): Record<string, unknown>;

  /**
   * Called after the GameSession + creator Player rows are committed.
   * Use for game-specific post-creation setup.
   *   SRX: creates Market singleton, sets currentTurnPlayerId
   *   Chess: initializes board state in session.log, creates MCTS bot player
   */
  onSessionCreated?(
    sessionId: string,
    creatorPlayerId: string,
    options: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Called after a Player joins an existing session (not the creator).
   *   SRX: no-op — starter empire is already in getPlayerCreateData
   *   Chess: initializes ChessState when human opponent joins (vs Human mode)
   */
  onPlayerJoined?(sessionId: string, playerId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Session-level defaults
  // -------------------------------------------------------------------------

  /** Default total turns for new sessions. SRX: 100. Chess: no limit (use large number). */
  defaultTotalTurns: number;
  /** Default actions per day for simultaneous mode. SRX: 5. Chess: 1. */
  defaultActionsPerDay: number;
  /** Default turn timeout in seconds. SRX: 86400 (24h). Chess: 43200 (12h). Falls back to 86400 if unset. */
  defaultTurnTimeoutSecs?: number;

  // -------------------------------------------------------------------------
  // Hub games list (login response)
  // -------------------------------------------------------------------------

  /**
   * Compute isYourTurn / currentTurnPlayer for the hub games list in POST /api/auth/login.
   * When omitted the route uses a generic default: currentTurnPlayerId === player.id.
   *
   * Receives lightweight Prisma objects already loaded by the login route.
   */
  computeHubTurnState?(
    player: { id: string; empire: { fullTurnsUsedThisRound: number; turnsLeft: number } | null },
    session: { id: string; turnMode: string; actionsPerDay: number; currentTurnPlayerId: string | null },
  ): Promise<{ isYourTurn: boolean; currentTurnPlayer: string | null }>;
}
