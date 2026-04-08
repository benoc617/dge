# Plan: SRX -> DGE (Door Game Engine) Extraction

## Context

SRX is a turn-based galactic empire game supporting sequential and simultaneous ("door-game") turn modes, AI opponents (Gemini LLM + MCTS), Redis caching, MySQL, and Next.js in Docker. The goal is to extract a reusable multi-game engine ("DGE") while SRX becomes the first game implementation. The architecture is validated by also being suitable for a chess game.

The result is a monorepo where game-agnostic infrastructure (turns, AI, search, caching, auth, admin) lives in shared packages, and each game provides a definition (state type, actions, tick, evaluation) plus UI components.

---

## Design Decisions (from prior conversation)

1. **Single world state**: One `TState` per game. Player state is a subset of world state. `playerId` is a parameter to functions that need perspective.

2. **`GameDefinition<TState>` interface** -- the contract games implement:
   - `loadState(sessionId, playerId, action, db)` -- selective loading
   - `saveState(sessionId, state, db)` -- surgical persistence
   - `applyTick?(state, rng)` -- optional economy tick; returns `TickResult<TState>` (with optional replay frames)
   - `applyAction(state, playerId, action, params, rng)` -- pure action application; returns `ActionResult<TState>` (with optional replay frames)
   - `evalState(state, forPlayerId)` -- heuristic scoring for AI
   - `generateCandidateMoves(state, forPlayerId)` -- legal moves for search
   - `projectState?(state, forPlayerId)` -- hide private info before sending to client
   - `buildAIContext?(state, forPlayerId)` -- LLM prompt context
   - `toPureState?(state)` -- plain objects for MCTS structured clone
   - `generateReplay?(before, after, action, params)` -- optional: deferred replay frame generation (when expensive, e.g. physics sims)

3. **`GameUIConfig`** -- games register React components for the shell to render (MainPanel, SidePanel, LeaderboardRow, EventLine, ReplayRenderer, etc.)

4. **Monorepo structure**:
   ```
   packages/engine/    @dge/engine   -- turns, AI, search, cache, db-context
   packages/shell/     @dge/shell    -- React UI frame
   packages/shared/    @dge/shared   -- types, shared prisma schema, rng
   games/srx/          @dge/srx      -- SRX game definition + components
   app/                              -- Next.js app wiring everything
   ```

5. **Concurrency**: `withCommitLock(sessionId)` serializes mutations. `loadState` inside the lock always sees latest state.

6. **Replay/observability model**: Actions and ticks can produce **replay frames** — an ordered sequence of intermediate world states that describe what happened step-by-step. This supports:
   - Simple games (chess): one frame per move, trivial
   - Complex combat (SRX): 3-4 frames per battle (ground, space, bombardment, aftermath)
   - Physics games (pool, curling, bowling): dozens of frames for ball/stone trajectories and collisions
   
   The key types:
   ```typescript
   interface ReplayFrame<TState> {
     state: TState                       // world state at this moment
     event: string                       // human-readable description
     durationMs?: number                 // animation timing hint
     metadata?: Record<string, unknown>  // game-specific rendering data
   }

   interface ActionResult<TState> {
     success: boolean
     state?: TState                      // final state
     message: string
     gameOver?: boolean
     replay?: ReplayFrame<TState>[]      // step-by-step what happened
     sideEffects?: SideEffect[]
   }

   interface TickResult<TState> {
     state: TState
     replay?: ReplayFrame<TState>[]
     report?: Record<string, unknown>    // summary stats
   }
   ```
   
   Replay frames are persisted in `TurnLog.details` so opponents can watch what happened on their next poll. The shell provides a generic `useReplay()` hook for timeline playback; the game provides a `ReplayRenderer` component. MCTS ignores replay frames entirely (reads only `result.state`).
   
   For games where frame generation is expensive (full physics sim), an optional `generateReplay?(before, after, action, params)` method lets the game defer frame generation to the real action path only, skipping it during MCTS rollouts.

---

## Phase 0: Monorepo Scaffolding

**Goal**: Set up workspace structure. Zero logic changes. Everything still works.

### Steps

1. Create directory structure:
   ```
   packages/engine/package.json     @dge/engine
   packages/engine/src/index.ts     empty barrel
   packages/engine/tsconfig.json
   packages/shell/package.json      @dge/shell
   packages/shell/src/index.ts      empty barrel
   packages/shell/tsconfig.json
   packages/shared/package.json     @dge/shared
   packages/shared/src/index.ts     empty barrel
   packages/shared/tsconfig.json
   ```

2. Add `"workspaces"` to root `package.json` pointing to `packages/*`, `games/*`.

3. Root `tsconfig.json` gets `references` to each package. Each package extends a shared `tsconfig.base.json`.

4. Keep existing `src/` code in place. The workspace packages start empty -- files move into them in subsequent phases. The existing `@/*` path alias continues working.

5. Verify `npm install`, `npm run docker:test`, `npm run docker:build` all succeed.

### Key files
- `package.json` (add workspaces)
- `tsconfig.json` (add references)
- New: `packages/*/package.json`, `packages/*/tsconfig.json`

### Verification
- `npm run docker:test` passes
- `npm run docker:build` succeeds
- Docker Compose stack works normally

### Risk: Low
npm workspaces + Next.js can have resolution quirks. Test early.

---

## Phase 1: Define Core Types + Extract Pure Infrastructure

**Goal**: Create the `GameDefinition<TState>` interface and move game-agnostic modules into `@dge/shared` and `@dge/engine`.

### Step 1a: Core type definitions in `@dge/shared`

Create `packages/shared/src/types.ts`:
```typescript
export interface Rng {
  random(): number
  randomInt(min: number, max: number): number
  chance(p: number): boolean
}

export interface Move {
  action: string
  params: Record<string, unknown>
  label: string
}

export interface ReplayFrame<TState> {
  state: TState
  event: string
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface ActionResult<TState> {
  success: boolean
  state?: TState
  message: string
  gameOver?: boolean
  winner?: string | null
  replay?: ReplayFrame<TState>[]
  sideEffects?: SideEffect[]
  details?: Record<string, unknown>
}

export interface TickResult<TState> {
  state: TState
  replay?: ReplayFrame<TState>[]
  report?: Record<string, unknown>
}

export interface GameDefinition<TState> {
  loadState(sessionId: string, playerId: string, action: string, db: any): Promise<TState>
  saveState(sessionId: string, state: TState, db: any): Promise<void>
  applyTick?(state: TState, rng: Rng): TState
  applyAction(state: TState, playerId: string, action: string, params: unknown, rng: Rng): ActionResult<TState>
  evalState(state: TState, forPlayerId: string): number
  generateCandidateMoves(state: TState, forPlayerId: string): Move[]
  projectState?(state: TState, forPlayerId: string): TState
  buildAIContext?(state: TState, forPlayerId: string): unknown
  toPureState?(state: TState): TState
}

export interface GameUIConfig {
  layout: 'three-column' | 'two-column' | 'single' | 'custom'
  MainPanel: React.ComponentType<GamePanelProps>
  SidePanel?: React.ComponentType<GamePanelProps>
  LeaderboardRow: React.ComponentType<LeaderboardRowProps>
  EventLine: React.ComponentType<EventLineProps>
  TurnSummaryContent?: React.ComponentType<TurnSummaryProps>
  GameOverContent?: React.ComponentType<GameOverProps>
  ReplayRenderer?: React.ComponentType<{ frame: ReplayFrame<any> }>
  actionTypes: string[]
  keyboardShortcuts?: Record<string, string>
  turnLabel?: (state: any, playerId: string) => string
  scoreLabel?: string
}
```

### Step 1b: Move pure infrastructure to `@dge/engine`

Files that move with minimal changes (replace originals with re-exports for backward compat):

| File | Destination | Changes needed |
|------|-------------|----------------|
| `src/lib/rng.ts` | `packages/shared/src/rng.ts` | Extract `Rng` interface; keep global API as SRX compat shim |
| `src/lib/db-context.ts` | `packages/engine/src/db-context.ts` | Accept PrismaClient via registration instead of importing `./prisma` |
| `src/lib/redis.ts` | `packages/engine/src/redis.ts` | Rename internal globals from `_srx*` to `_dge*` |
| `src/lib/game-state-service.ts` | `packages/engine/src/cache.ts` | Parameterize cache key prefixes |

Each original file becomes a one-line re-export shim:
```typescript
// src/lib/db-context.ts (shim)
export { getDb, withCommitLock, GalaxyBusyError } from "@dge/engine/db-context";
```

### Step 1c: Parameterize search-opponent.ts

This is the hardest part of Phase 1. Currently `search-opponent.ts` imports concrete functions from `sim-state.ts`:
```typescript
import { applyTick, applyAction, generateCandidateMoves, evalState, makeRng, cloneEmpire, pickRolloutMove } from "./sim-state";
```

Refactor to accept these as parameters:
```typescript
// packages/engine/src/search.ts
export interface SearchGameFunctions<TState> {
  applyTick(state: TState, rng: Rng): TState
  applyAction(state: TState, playerId: string, action: string, params: unknown, rng: Rng): ActionResult<TState>
  evalState(state: TState, forPlayerId: string): number
  generateCandidateMoves(state: TState, forPlayerId: string): Move[]
  cloneState(state: TState): TState
}

export function mctsSearch<TState>(
  game: SearchGameFunctions<TState>,
  states: TState,          // full world state
  actingPlayerId: string,
  allPlayerIds: string[],
  config: Partial<MCTSConfig>,
): Move
```

**Design note**: The current MCTS operates on `PureEmpireState[]` (array of per-player states). The engine model is `TState` (single world state). The SRX adapter wraps its array-of-empires into a single `SrxPureState` containing all empires, and `applyAction(state, playerId, ...)` operates on the right empire within it. This adapter lives in `games/srx/`.

The existing `search-opponent.ts` stays as a SRX-specific wrapper that calls the generic engine search with SRX's `SearchGameFunctions<SrxPureState>`.

### Key files
- New: `packages/shared/src/types.ts`, `packages/shared/src/rng.ts`
- New: `packages/engine/src/db-context.ts`, `packages/engine/src/redis.ts`, `packages/engine/src/cache.ts`, `packages/engine/src/search.ts`
- Modified: `src/lib/rng.ts`, `src/lib/db-context.ts`, `src/lib/redis.ts`, `src/lib/game-state-service.ts` (become re-export shims)
- Modified: `src/lib/search-opponent.ts` (wraps generic engine search)

### Verification
- All existing unit tests pass (via re-export shims)
- New unit tests for `@dge/engine` search with a trivial test game (not SRX)
- `search-opponent.test.ts` passes unchanged
- Docker tests pass

### Risk: Medium
The search parameterization requires careful design of the state model bridge. The `PureEmpireState[]` -> single `TState` adapter for SRX is the key difficulty.

---

## Phase 2: Implement `GameDefinition<SrxState>` for SRX

**Goal**: Create the SRX game definition implementing the engine interface.

### The Hard Problem

`processAction` in `game-engine.ts` (2166 lines) interleaves game logic with DB reads/writes. Making `applyAction` pure requires all needed state to be pre-loaded.

**Strategy**: Two-track approach:
- **Pure track** (for MCTS): Already exists as `sim-state.ts` -- `applyTick()`, `applyAction()`. Handles a subset of actions in memory.
- **Full track** (for real gameplay): The current `processAction`. This stays async and DB-aware.

The `GameDefinition.applyAction` is the **pure track** -- used by MCTS and simulation. The engine provides a separate `GameOrchestrator` that handles the full track (load -> apply -> persist -> log).

### Step 2a: Define `SrxState` type

```typescript
// games/srx/src/types.ts
interface SrxWorldState {
  session: { id: string; dayNumber: number; turnMode: string; ... }
  empires: Record<string, SrxEmpireSlice>  // playerId -> empire data
  market: MarketState
}

// For MCTS pure state (already exists as PureEmpireState[]):
interface SrxPureState {
  empires: PureEmpireState[]
  playerIndex: number  // which empire is "self"
}
```

### Step 2b: Create SRX game definition

```typescript
// games/srx/src/definition.ts
export const srxGameDefinition: GameDefinition<SrxWorldState> = {
  async loadState(sessionId, playerId, action, db) {
    // Selective loading based on action:
    // buy_planet, set_tax_rate, buy_soldiers: load only acting player
    // attack_*, covert_op: load acting player + target
    // market_*: load acting player + market
    // Uses existing playerInclude query from game-engine.ts
  },

  async saveState(sessionId, state, db) {
    // Surgical writes using existing toEmpireUpdateData() from empire-prisma.ts
    // Only writes changed empires
  },

  applyTick(state, rng) {
    // Wraps existing sim-state.applyTick for the acting player's empire
  },

  applyAction(state, playerId, action, params, rng) {
    // Wraps existing sim-state.applyAction
    // This is the PURE version for MCTS
  },

  evalState(state, forPlayerId) {
    // Wraps existing sim-state.evalState
  },

  generateCandidateMoves(state, forPlayerId) {
    // Wraps existing sim-state.generateCandidateMoves
  },

  toPureState(state) {
    // Converts SrxWorldState -> SrxPureState using empireFromPrisma
  },

  buildAIContext(state, forPlayerId) {
    // Wraps existing buildAIMoveContext from ai-runner.ts
  },
}
```

### Step 2c: Create `GameOrchestrator` in engine

```typescript
// packages/engine/src/orchestrator.ts
export class GameOrchestrator<TState> {
  constructor(
    private definition: GameDefinition<TState>,
    private db: PrismaClient,
  ) {}

  // The "full track" -- load, apply, persist, log
  async processAction(sessionId: string, playerId: string, action: string, params: unknown): Promise<ActionResult<TState>> {
    return withCommitLock(sessionId, async () => {
      const state = await this.definition.loadState(sessionId, playerId, action, getDb())
      const rng = createRng()
      const result = this.definition.applyAction(state, playerId, action, params, rng)
      if (result.success && result.state) {
        await this.definition.saveState(sessionId, result.state, getDb())
      }
      return result
    })
  }
}
```

**Important**: This is the *aspirational* shape. In practice, SRX's `processAction` does things the pure `applyAction` can't -- like creating TurnLog rows, emitting GameEvents, pushing defender alerts. These side effects need a mechanism.

**Side effect approach**: `ActionResult` includes a `sideEffects` array:
```typescript
interface ActionResult<TState> {
  success: boolean
  state?: TState
  message: string
  sideEffects?: SideEffect[]  // { type: 'gameEvent', data: {...} }, { type: 'turnLog', data: {...} }
}
```
The orchestrator processes side effects after saving state. This keeps `applyAction` pure while allowing games to declare what should be logged/emitted.

### Step 2d: Incremental migration of action handlers

Don't extract all 35 actions at once. Start with simple ones to prove the pattern:

**Wave 1** (pure economy, no targets): `buy_planet`, `set_tax_rate`, `set_sell_rates`, `set_supply_rates`, `end_turn`, `buy_soldiers`, `buy_generals`, `buy_fighters`

**Wave 2** (market/finance): `market_buy`, `market_sell`, `bank_loan`, `bank_repay`, `buy_bond`, `buy_lottery_ticket`, `discover_tech`

**Wave 3** (combat/covert, need target loading): `attack_conventional`, `attack_guerrilla`, `attack_nuclear`, `attack_chemical`, `attack_psionic`, `attack_pirates`, `covert_op`

**Wave 4** (diplomacy): `propose_treaty`, `accept_treaty`, `break_treaty`, `create_coalition`, `join_coalition`, `leave_coalition`

Each wave: extract from `processAction` switch -> test -> verify.

### Key files
- New: `games/srx/src/types.ts`, `games/srx/src/definition.ts`
- New: `packages/engine/src/orchestrator.ts`
- Modified: `src/lib/game-engine.ts` (gradually delegate to definition)
- Existing (referenced): `src/lib/sim-state.ts`, `src/lib/empire-prisma.ts`

### Verification
- Existing e2e tests pass (orchestrator calls through to existing code during migration)
- New unit tests for `SrxGameDefinition` pure methods
- TypeScript verifies `srxGameDefinition` satisfies `GameDefinition<SrxWorldState>`
- Simulation harness works

### Risk: HIGH
This is the hardest phase. The `processAction` function mixes logic and persistence deeply. The wave approach mitigates by starting with easy actions.

**Key mitigation**: During migration, the orchestrator can fall back to calling the existing `processAction` for actions not yet extracted. This means every intermediate state is deployable.

---

## Phase 3: Extract Turn Management

**Goal**: Make turn orchestration game-agnostic in the engine.

### Steps

1. **`turn-order.ts`** -> `packages/engine/src/turn-order.ts`
   - Replace direct calls to `runAndPersistTick` and `processAction` (timeout auto-skip) with calls through the orchestrator.
   - Signature: `getCurrentTurn(sessionId, orchestrator)`, `advanceTurn(sessionId, orchestrator)`

2. **`door-game-turns.ts`** -> `packages/engine/src/door-game.ts`
   - `openFullTurn`, `closeFullTurn`, `tryRollRound`, `canPlayerAct` become engine functions.
   - Replace `runAndPersistTick(playerId)` -> `orchestrator.processTick(sessionId, playerId)`
   - Replace `processAction(playerId, 'end_turn')` -> `orchestrator.processAction(sessionId, playerId, 'end_turn', {})`
   - Replace `runEndgameSettlementTick(playerId)` -> `orchestrator.processEndgame(sessionId, playerId)` (new method on orchestrator that calls `definition.applyTick` one final time)

3. Add turn management methods to `GameOrchestrator`:
   ```typescript
   async openFullTurn(sessionId, playerId): Promise<TurnReport | null>
   async closeFullTurn(sessionId, playerId): Promise<void>
   async tryRollRound(sessionId): Promise<boolean>
   async getCurrentTurn(sessionId): Promise<TurnOrderInfo | null>
   async advanceTurn(sessionId): Promise<TurnOrderInfo | null>
   ```

### Key files
- Modified: `src/lib/turn-order.ts` -> re-export shim
- Modified: `src/lib/door-game-turns.ts` -> re-export shim
- New: `packages/engine/src/turn-order.ts`, `packages/engine/src/door-game.ts`
- Modified: `packages/engine/src/orchestrator.ts` (add turn methods)

### Verification
- `door-game.test.ts` (e2e) passes
- `door-game-turns.test.ts` (unit) passes
- `turn-order-lobby.test.ts` passes
- `game-flow.test.ts` (e2e) passes

### Risk: Medium
The coupling is mostly function-call level -- replacing direct imports with orchestrator calls. The schema fields (`Empire.turnOpen`, `GameSession.dayNumber`) stay in the shared Prisma schema.

---

## Phase 4: Extract AI Layer

**Goal**: Game-agnostic AI runner + LLM integration in engine. SRX provides personas and prompt construction.

### Steps

1. **Split `gemini.ts`**:
   - `packages/engine/src/llm.ts`: `resolveGeminiConfig()`, `callGeminiAPI()`, timeout handling, concurrency semaphores (`withGeminiGeneration`, `withMctsDecide`). The engine provides a generic `LLMProvider` interface.
   - `games/srx/src/ai-personas.ts`: `AI_PERSONAS` object, `localFallback` heuristics, `computeRivalAttackTargets`, prompt template construction. All the SRX-specific prompting.

2. **Split `ai-runner.ts`**:
   - `packages/engine/src/ai-runner.ts`: Generic AI turn loop. `runAISequence(sessionId, orchestrator)` walks consecutive AI turns. `getAIMoveDecision(playerId, orchestrator)` calls `definition.buildAIContext` -> LLM -> parse -> validate.
   - `games/srx/src/ai-context.ts`: `buildAIMoveContext` (SRX empire snapshot assembly), `paramsFromAIMove` (SRX param mapping).

3. **`ai-process-move.ts`** -> `packages/engine/src/ai-process-move.ts`: Already generic (try action, fall back to end_turn).

4. **`ai-concurrency.ts`**, **`door-ai-runtime-settings.ts`** -> engine (generic concurrency controls).

### Key files
- Modified: `src/lib/gemini.ts` -> split
- Modified: `src/lib/ai-runner.ts` -> split
- New: `packages/engine/src/llm.ts`, `packages/engine/src/ai-runner.ts`
- New: `games/srx/src/ai-personas.ts`, `games/srx/src/ai-context.ts`

### Verification
- AI e2e tests pass (game-flow.test.ts AI section, door-game.test.ts AI drain)
- `gemini-*.test.ts` unit tests pass
- `ai-process-move.test.ts`, `ai-concurrency.test.ts` pass

### Risk: Medium
The prompt construction is deeply SRX-specific but cleanly separable. The LLM calling infrastructure is already mostly generic.

---

## Phase 5: API Routes + Game Registration

**Goal**: Routes become thin wrappers calling the orchestrator. Games register at startup.

### Steps

1. **Game registry**:
   ```typescript
   // packages/engine/src/registry.ts
   const games = new Map<string, { definition: GameDefinition<any>, uiConfig: GameUIConfig }>()
   export function registerGame(gameType: string, definition: GameDefinition<any>, uiConfig: GameUIConfig)
   export function getGame(gameType: string)
   ```

2. **Refactor API routes** to use orchestrator:
   ```typescript
   // src/app/api/game/action/route.ts
   const game = getGame(session.gameType)
   const orchestrator = new GameOrchestrator(game.definition, prisma)
   // Sequential: orchestrator.processAction(...)
   // Simultaneous: orchestrator.openFullTurn(...) etc.
   ```

3. **Add `gameType` to `GameSession`** Prisma model (default `"srx"` for existing sessions).

4. **Status route**: calls `definition.projectState()` before serializing response. Each game controls what the client sees.

5. **Prisma schema**: Keep as single file but clearly section game-agnostic vs SRX models. Add `gameType String @default("srx")` to `GameSession`.

### Key files
- New: `packages/engine/src/registry.ts`
- Modified: all `src/app/api/game/*/route.ts` (thin wrappers)
- Modified: `prisma/schema.prisma` (add `gameType` to `GameSession`)

### Verification
- All e2e tests pass
- Manual testing of full game flow
- Docker Compose works

### Risk: Medium
The routes contain significant orchestration logic (307 lines in action/route.ts). Moving this into the orchestrator is mechanical but needs care.

---

## Phase 6: UI Shell + Chess Validation

**Goal**: Prove the engine works for a second game. Build the React UI shell.

### Step 6a: UI Shell (`@dge/shell`)

Extract game-agnostic UI:
- `Login.tsx`, `CommandCenter.tsx` (lobby), `GameOverScreen.tsx` -> `packages/shell/`
- `GameLayout.tsx` -- renders panels per `GameUIConfig.layout`
- `useGameState()` hook (status polling)
- `useGameAction()` hook (action dispatch with retry)
- `TurnIndicator`, `PlayerRoster`, `EventLogShell` (generic chrome)

SRX keeps: `EmpirePanel`, `ActionPanel`, `SrxLeaderboardRow`, `SrxEventLine`, `TurnSummary`

### Step 6b: Chess game (minimal implementation)

```
games/chess/
  src/
    definition.ts       GameDefinition<ChessState>
    pure-state.ts       Board type, FEN serialization
    move-generator.ts   Legal move generation (~300 lines)
    evaluation.ts       Material + position scoring
    constants.ts        Starting position, piece values
    components/
      Board.tsx         8x8 grid with click-to-move
      MoveHistory.tsx   Algebraic notation list
  prisma/
    schema.prisma       ChessGame model (sessionId, boardJson)
```

Chess validates:
- `applyTick` being optional (no economy)
- Shared world state (one board, two players)
- `generateCandidateMoves` producing legal moves
- MCTS playing chess without modification
- Two-player sequential turns via existing turn-order
- `projectState` as identity (perfect information)
- `two-column` layout in the shell

### Verification
- Chess: create game, make moves, AI opponent plays via MCTS, checkmate detection
- SRX: all existing tests still pass
- Both games playable in same Next.js app

### Risk: Medium-High
Chess move generation is non-trivial (~300 lines). But this is bounded, well-understood work. The real value is validating the engine interface, not building a polished chess game.

---

## Execution Order and Dependencies

```
Phase 0 ──> Phase 1 ──> Phase 2 ──────> Phase 5 ──> Phase 6
                │           │
                │           └──> Phase 3
                │
                └──> Phase 4 (can start after 1c search extraction)
```

- **0 -> 1 -> 2**: Strictly sequential. Each builds on the prior.
- **3**: Depends on Phase 2 for the GameDefinition interface, but can start once the basic definition exists (not all 35 actions).
- **4**: Depends on Phase 1 (search extraction). Can run in parallel with Phase 2.
- **5**: Depends on 2, 3, 4 being substantially complete.
- **6**: Depends on 5.

---

## Key Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `processAction` extraction (Phase 2) | HIGH | Wave approach -- start with simple actions. Orchestrator falls back to existing `processAction` for un-migrated actions. |
| MCTS state model bridge (Phase 1c) | MEDIUM | SRX adapter wraps `PureEmpireState[]` into `SrxPureState`. Engine search operates on generic `TState`. |
| npm workspace + Next.js resolution | MEDIUM | Phase 0 validates this before any logic changes. |
| Prisma multi-schema composition | LOW | Punt -- keep single schema file, clearly sectioned. |
| `applyAction` purity for DB-heavy actions | MEDIUM | Accept two tracks: pure (MCTS) and async (orchestrator). Unify over time. |

---

## What Will Be Refined During Implementation

1. **`loadState` contract** -- exactly what goes into `TState` per action emerges from implementing Wave 1-3 action handlers.
2. **Side effect model** -- how `applyAction` declares events/logs without doing DB writes. The `sideEffects` array in `ActionResult` is the starting design.
3. **`ActionResult` generics** -- whether games need custom result types beyond the base fields.
4. **Event system** -- how the orchestrator processes game events and turn logs emitted by actions.
5. **Multi-player MCTS bridge** -- the exact adapter between "array of empires" (current) and "single world state" (engine) will need iteration.
6. **Replay frame granularity** -- for physics games (pool, curling), how many frames per action? Full physics sim at 60fps would be hundreds of frames. Likely need a "keyframe" approach where `ReplayFrame` captures collision/rest events, and the client interpolates between them. Also: replay persistence size in `TurnLog.details` — may need compression or separate storage for frame-heavy games.
