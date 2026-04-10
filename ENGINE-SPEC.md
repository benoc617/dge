# Door Game Engine — Complete Engine Specification

This document fully specifies the Door Game Engine (DGE): the turn-management, AI, search, caching, authentication, and administration infrastructure shared across all games. It is intended to be complete enough to implement a new game from scratch using DGE.

For SRX-specific mechanics, formulas, and constants see [`games/srx/docs/GAME-SPEC.md`](games/srx/docs/GAME-SPEC.md).

---

## 1. Overview

DGE is a monorepo turn-based multiplayer game engine. It handles:

- Session lifecycle (lobby → active → finished)
- Sequential and simultaneous ("door-game") turn modes
- AI opponent integration (LLM + MCTS)
- Authentication and admin UI
- Shared database schema, caching, and concurrency

Games implement the `GameDefinition<TState>` interface and register with the engine. The engine drives all orchestration; games supply only game-specific logic.

---

## 2. Monorepo Structure

```
packages/engine/    @dge/engine    — turn orchestration, AI, search, cache, db-context
packages/shell/     @dge/shell     — React UI shell (hooks, layout, types)
packages/shared/    @dge/shared    — shared types, RNG interface
games/srx/          @dge/srx       — Solar Realms Extreme game definition + components
games/chess/        @dge/chess     — Chess game definition (MCTS-only AI, no Gemini)
games/ginrummy/     @dge/ginrummy  — Gin Rummy game definition (MCTS + determinization)
src/                               — Next.js application (routes, pages, components)
  app/                             — Next.js App Router pages and API routes
  components/                      — shared React components (AdminNav, HelpModal, etc.)
  lib/                             — SRX-wired services, srx-registration, srx-ui-config
prisma/schema.prisma               — single Prisma schema (engine + SRX models)
```

### Separation rules

- **Engine packages never import game code.** `@dge/engine` and `@dge/shell` have zero imports from `@dge/srx` or `src/lib/*`.
- **Games implement the `GameDefinition<TState>` interface** and register via `registerGame()`.
- **SRX-specific code** lives in `games/srx/` and `src/lib/` (wiring layer). The wiring layer imports from `@dge/engine` and `@dge/srx`, not the other way round.

---

## 3. Core Types (`@dge/shared`)

### 3.1 Rng Interface

```typescript
interface Rng {
  random(): number                         // float in [0, 1)
  randomInt(min: number, max: number): number  // integer in [min, max] inclusive
  chance(p: number): boolean               // true with probability p
  shuffle<T>(arr: T[]): T[]                // Fisher-Yates in-place shuffle
}
```

The engine passes `Rng` to all pure functions. The default implementation (`src/lib/rng.ts`) uses a seeded mulberry32 PRNG. `setSeed(null)` switches to production randomness; `setSeed(n)` enables deterministic simulation. The orchestrator creates a production `Rng` (backed by `Math.random`) for each live action; MCTS creates seeded instances for deterministic rollouts.

### 3.2 Move

```typescript
interface Move {
  action: string
  params: Record<string, unknown>
  label: string
}
```

### 3.3 ActionResult

```typescript
interface ActionResult<TState> {
  success: boolean
  state?: TState
  message: string
  gameOver?: boolean
  winner?: string | null
  replay?: ReplayFrame<TState>[]
  sideEffects?: SideEffect[]
  details?: Record<string, unknown>
}
```

### 3.4 TickResult

```typescript
interface TickResult<TState> {
  state: TState
  replay?: ReplayFrame<TState>[]
  report?: Record<string, unknown>
}
```

### 3.5 ReplayFrame

```typescript
interface ReplayFrame<TState> {
  state: TState
  event: string
  durationMs?: number
  metadata?: Record<string, unknown>
}
```

---

## 4. GameDefinition Interface (`@dge/shared`)

Every game must implement `GameDefinition<TState>`. The interface has three layers:

| Layer | DB access | Where called |
|-------|-----------|--------------|
| **Persistence** (`loadState`, `saveState`) | Yes | Orchestrator (full-track path) |
| **Pure game logic** (`applyAction`, `evalState`, `generateCandidateMoves`) | No | Both orchestrator and MCTS search |
| **Full-track shims** (`processFullAction`, `processFullTick`, etc.) | Yes | Orchestrator migration path |

The persistence layer and full-track shims give games that manage their own DB access (like SRX with its complex Empire/Planet/Army schema) a direct integration path. Games that store state in `GameSession.log` (like Chess) can use lightweight implementations.

```typescript
interface GameDefinition<TState> {
  // === Persistence (required) ===
  loadState(sessionId: string, playerId: string, action: string, db: unknown): Promise<TState>
  saveState(sessionId: string, state: TState, db: unknown): Promise<void>

  // === Pure game logic (required) ===
  applyAction(state: TState, playerId: string, action: string, params: unknown, rng: Rng): ActionResult<TState>
  evalState(state: TState, forPlayerId: string): number
  generateCandidateMoves(state: TState, forPlayerId: string): Move[]

  // === Pure game logic (optional) ===
  applyTick?(state: TState, rng: Rng): TickResult<TState>  // economy/physics tick; omit for tickless games (chess)
  projectState?(state: TState, forPlayerId: string): TState  // hide private info for fog-of-war
  buildAIContext?(state: TState, forPlayerId: string): unknown  // LLM prompt context
  toPureState?(state: TState): TState  // strip DB-shaped objects for structured clone
  generateReplay?(before: TState, after: TState, action: string, params: unknown): ReplayFrame<TState>[]

  // === Full-track migration shims (all optional) ===
  processFullAction?(playerId: string, action: string, params: Record<string, unknown>,
                     opts?: FullActionOptions): Promise<FullActionResult>
  processFullTick?(playerId: string): Promise<FullTurnReport>
  runAiSequence?(sessionId: string): Promise<void>
  postActionClose?(playerId: string, sessionId: string): Promise<void>

  // === Admin extensions (optional) ===
  admin?: GameAdminConfig
}
```

### 4.1 Full-track shims explained

The full-track shims (`processFullAction`, `processFullTick`, `runAiSequence`, `postActionClose`) exist for incremental migration. Games that manage their own DB persistence (SRX) implement these to plug their existing async action handlers into the orchestrator. Games that have fully migrated to the pure `applyAction` + `saveState` path can omit them — the orchestrator uses the pure path instead.

| Shim | Called when | What it replaces |
|------|-----------|------------------|
| `processFullAction` | Orchestrator needs to run an action | Pure: `applyAction` + `saveState` |
| `processFullTick` | Orchestrator needs to run a tick | Pure: `applyTick` + `saveState` |
| `runAiSequence` | After human turn advances (sequential mode) | Engine would need game-specific AI logic |
| `postActionClose` | After door-game non-end_turn action succeeds | Default: `closeFullTurn` directly |

### 4.2 Supporting types (`@dge/shared`)

```typescript
interface FullActionOptions {
  context?: {
    turnMode?: string        // "sequential" | "door-game"
    isEndTurn?: boolean      // true when action is end_turn in door-game mode
  }
  logMeta?: Record<string, unknown>  // extra metadata for turn logging
}

interface FullActionResult {
  success: boolean
  message: string
  [key: string]: unknown  // game-specific extras (e.g. actionDetails, combatResult)
}

type FullTurnReport = Record<string, unknown> | null  // null = tick already processed

type SideEffect =
  | { type: "gameEvent"; data: { message: string; eventType: string; details?: Record<string, unknown> } }
  | { type: "turnLog"; data: { action: string; details?: Record<string, unknown> } }
  | { type: "defenderAlert"; data: { targetPlayerId: string; message: string } }
  | { type: "custom"; name: string; data: Record<string, unknown> }

interface GameAdminConfig {
  highScoreColumns?: Array<{ key: string; label: string; format?: (v: unknown) => string }>
  onHighScoreReset?(gameType: string): Promise<void>
  adminPages?: AdminPage[]
}
```

### 4.3 AI Difficulty System (`@dge/shared`)

Games that support AI difficulty selection declare an `aiDifficultyProfile` on their `GameDefinition`. The engine recognises the standard `aiDifficulty` session-creation option and stores the selected tier in game state (not in the engine itself — each game owns persistence).

```typescript
type AiDifficulty = "easy" | "medium" | "hard"

interface AiDifficultyTier {
  label?: string                   // human-readable name (e.g. "Beginner", "Shark")
  mctsConfig?: {                   // overrides for the engine's mctsSearch call
    timeLimitMs?: number
    iterations?: number
    rolloutDepth?: number
    branchFactor?: number
    explorationC?: number
  }
  behavior?: Record<string, unknown>  // arbitrary game-specific flags
  // Examples:
  //   Gin Rummy: { trackDiscards: boolean; inferOpponentMelds: boolean }
  //   Blackjack: { countCards: boolean }
}

interface AiDifficultyProfile {
  easy: AiDifficultyTier
  medium: AiDifficultyTier
  hard: AiDifficultyTier
}
```

**Responsibilities by layer:**

| Layer | Responsibility |
|-------|----------------|
| `@dge/shared` | Defines the three types above |
| `GameDefinition` | Declares `aiDifficultyProfile?` — the mapping from tier name to config |
| `GameMetadata.createOptions` | Includes an `aiDifficulty` option of type `"select"` so the lobby renders the dropdown |
| `GameHttpAdapter.onSessionCreated` | Reads `options.aiDifficulty`, stores it in game state |
| Game AI function (e.g. `getChessAIMove`, `getGinRummyAIMove`) | Accepts an optional `AiDifficultyTier`; reads `mctsConfig` and `behavior` from it |

The `behavior` field is opaque to the engine — each game defines and casts its own behavioral struct. This lets future games add domain-specific AI capabilities (e.g. card counting in Blackjack) using the same architecture without any engine changes.

Currently implementing games:
- **Chess** — `CHESS_DIFFICULTY_PROFILE` (Beginner / Club Player / Expert); no behavioral flags, MCTS budget only.
- **Gin Rummy** — `GINRUMMY_DIFFICULTY_PROFILE` (Casual / Competitive / Shark); behavioral flags `trackDiscards` and `inferOpponentMelds` extend the MCTS search with discard-pile observation tracking.

---

## 5. Game Registry (`packages/engine/src/registry.ts`)

```typescript
registerGame(gameType: string, input: GameRegistrationInput<TState>): void
getGame(gameType: string): GameRegistration | undefined
requireGame(gameType: string): GameRegistration   // throws if not found
listGameTypes(): string[]
_clearRegistry(): void   // test helper only
```

Each registered game provides four pluggable objects:

| Object | Purpose | Interface defined in |
|--------|---------|---------------------|
| `GameDefinition<TState>` | Core game logic (see §4) | `@dge/shared` |
| `GameMetadata` | Lobby metadata (see §A.2) | `@dge/shared` |
| `GameHttpAdapter` | API route delegation (see §A.3) | `@dge/shared` |
| `GameHooks` | Engine lifecycle callbacks (see §A.4–A.5) | `@dge/engine` |

All games register at application startup via a **bootstrap module**:

```typescript
// src/lib/game-bootstrap.ts — import this once in any API route
import "@/lib/srx-registration";
import "@/lib/chess-registration";
import "@/lib/ginrummy-registration";
// add new games here
```

Routes call `requireGame(game)` to retrieve the orchestrator, metadata, or adapter for the session's game type.

### 5.1 `game` field vs `gameType` column

The database column is `GameSession.gameType`. The API and UI use the field name `game`. Routes map `gameType → game` in every outbound JSON response. This keeps the DB schema stable while giving the public API a cleaner name.

The client mirrors `GameMetadata` as a static `ClientGameMetadata` array (`CLIENT_GAME_REGISTRY` in `src/app/page.tsx`) so the lobby UI renders without server round-trips.

---

## 6. GameOrchestrator (`packages/engine/src/orchestrator.ts`)

The `GameOrchestrator<TState>` wraps a `GameDefinition` and coordinates turn lifecycle. It is constructed once per `registerGame` call (not per-request) and stored in the registry.

### 6.1 Pure-track methods

These use `loadState` → `applyAction` → `saveState` within a `withCommitLock`:

```typescript
class GameOrchestrator<TState> {
  // Pure-track: lock → load → [tick] → action → save → side effects
  async processTick(sessionId, playerId, opts?): Promise<TickResult<TState> | null>
  async processAction(sessionId, playerId, action, params, opts?): Promise<ActionResult<TState>>
  async getCandidateMoves(sessionId, playerId): Promise<Move[]>
}
```

### 6.2 Full-track migration methods

These delegate to the game's `processFullAction` / `processFullTick` shims and handle turn enforcement:

```typescript
// Sequential mode — enforces turn order via TurnOrderHooks
async processSequentialTick(sessionId, playerId): Promise<SequentialTickOutcome>
async processSequentialAction(sessionId, playerId, action, params): Promise<SequentialActionOutcome>

// Door-game (simultaneous) mode — manages slots via DoorGameHooks
async processDoorTick(sessionId, playerId): Promise<DoorTickOutcome>
async processDoorAction(sessionId, playerId, action, params): Promise<DoorActionOutcome>
```

**Sequential flow**: `processSequentialAction` checks `getCurrentTurn` → calls `processFullAction` with `{ context: { turnMode: "sequential" } }` → on success calls `advanceTurn` → fire-and-forget `runAiSequence`.

**Door-game flow**: `processDoorAction` acquires `withCommitLock` → checks `canPlayerAct` hook → opens turn slot if needed → calls `processFullAction` with `{ context: { turnMode: "door-game", isEndTurn } }` → on success calls `closeFullTurn` (or game's `postActionClose`).

### 6.3 Outcome types

| Type | Key fields |
|------|-----------|
| `SequentialTickOutcome` | `report`, `notYourTurn?`, `noActiveTurn?` |
| `SequentialActionOutcome` | `result`, `notYourTurn?`, `noActiveTurn?` |
| `DoorTickOutcome` | `report`, `turnOpened` |
| `DoorActionOutcome` | `result`, `scheduleAiDrain`, `constraintError?` (`"no_turns_left"` / `"no_open_turn"` / `"not_found"`) |

The `TurnOrderHooks` and `DoorGameHooks` are injected at construction (from `GameHooks` during registration) and are private to the orchestrator. Standalone helper functions (`sessionCannotHaveActiveTurn`, `isSessionRoundTimedOut`) are exported from `turn-order.ts` and `door-game.ts` respectively for use by routes and hooks.

---

## 7. Turn Modes

### 7.1 Sequential turns

- `GameSession.currentTurnPlayerId` — ID of the player whose turn it is
- `Player.turnOrder` — fixed position; advances cyclically
- `getCurrentTurn(sessionId, hooks)` — resolves current player; auto-skips timed-out players via `TurnOrderHooks`
- `advanceTurn(sessionId, hooks?)` — moves `currentTurnPlayerId` to next active player
- Turn timer: `turnStartedAt` resets each advance; `turnTimeoutSecs` default 86400 (24h)
- AI turns run via `runAISequence` after each human action (fire-and-forget)

### 7.2 Simultaneous / door-game turns

- `GameSession.turnMode === "simultaneous"`
- Calendar rounds: `dayNumber`, `actionsPerDay` (default 5), `roundStartedAt`
- Per-player turn state (tracked via `DoorGameHooks` — the engine has no opinion on where the game stores this; SRX uses `Empire` fields, another game could use `Player` fields or a separate table)
- `openFullTurn(playerId, hooks)` — begins a full-turn slot (runs tick via hook, marks slot open)
- `closeFullTurn(playerId, sessionId, hooks)` — ends slot, decrements game turns via hook
- `tryRollRound(sessionId, hooks)` — advances `dayNumber` when all active players have exhausted daily slots or round timer expired; charges game turns for skipped slots via `forfeitSlots` hook. Forfeited slots decrement `turnsLeft` **and** increment `turnsPlayed` so the invariant `turnsPlayed + turnsLeft == totalTurns` holds. When `forfeitSlots` returns `remainingTurns === 0`, `runEndgameTick` is called for that player.
- AI turns queued via `enqueueAiTurnsForSession` → `AiTurnJob` table → ai-worker picks up
- Round timer: when `roundStartedAt + turnTimeoutSecs` elapses, `tryRollRound` skips remaining slots

### 7.3 Lobby state

A session with `waitingForHuman: true` is a pre-staged admin lobby. `currentTurnPlayerId` is null; `turnStartedAt` is null; `getCurrentTurn` returns null. The lobby activates when the first human joins via `POST /api/game/join`.

---

## 8. AI System

### 8.1 Engine-level AI infrastructure

The engine provides two AI mechanisms that games can use:

**MCTS search** (`packages/engine/src/search.ts`) — generic N-player Monte Carlo Tree Search with UCB1 selection and configurable rollout. Games provide a `SearchGameFunctions<TState>` implementation (see §A.6). Entry points:
- `mctsSearch(game, state, playerIdx, config)` — returns the best `Move`
- `maxNSearch(game, state, playerIdx, config)` — shallow MaxN alternative

MCTS only calls **pure-track** functions. No DB access.

**AI worker** (`scripts/ai-worker.ts`) — standalone process (separate Compose service) that polls `AiTurnJob` via `SELECT … FOR UPDATE SKIP LOCKED`. Runs `runOneDoorGameAI`, then cascades with `enqueueAiTurnsForSession`. Supports `AI_WORKER_CONCURRENCY` parallel slots. Recovers stale jobs (claimed > 1 minute, reset to pending) every 30s.

**Concurrency controls** (`packages/engine/src/ai-concurrency.ts`) — dynamic semaphores (`withGeminiGeneration`, `withMctsDecide`) with caps from `resolveDoorAiRuntimeSettings()` (~60s in-process cache). Games can use these to throttle expensive AI operations.

### 8.2 Game-specific AI (SRX example)

SRX implements its own AI layer on top of the engine infrastructure:

- **LLM integration** (`src/lib/gemini.ts`) — Gemini prompt construction with 7 persona types (`economist`, `warlord`, `spymaster`, `diplomat`, `turtle`, `researcher`, `optimal`). `resolveGeminiConfig()` reads `SystemSettings` first, then env vars. Each call bounded by `GEMINI_TIMEOUT_MS`. The `optimal` persona uses engine MCTS; all others use heuristic `localFallback` or Gemini prompts.
- **AI runner** (`src/lib/ai-runner.ts`) — `runAISequence(sessionId)` walks consecutive AI turns; `getAIMoveDecision(playerId)` returns just the chosen action for batching.

Chess uses engine MCTS directly (no LLM) via `SearchGameFunctions<ChessState>` in `games/chess/src/definition.ts`.

Gin Rummy also uses MCTS via `SearchGameFunctions<GinRummyState>` (`games/ginrummy/src/definition.ts`) but wraps it with **information set sampling** (determinization): because the opponent's hand and stock order are hidden, the AI runs N MCTS passes over randomly sampled complete game states and votes on the best action.

---

## 9. Concurrency and Locking (`packages/engine/src/db-context.ts`)

- `withCommitLock(sessionId, fn)` — per-session advisory lock
  - `INSERT IGNORE SessionLock` + `SELECT … FOR UPDATE NOWAIT`
  - Interactive transaction with 60s timeout
  - Throws `SessionBusyError` (HTTP 409) on contention
- `getDb()` — returns current Prisma client (global or transaction-scoped via AsyncLocalStorage)
- Action routes use the lock; all game state mutations inside the lock always see latest committed state

---

## 10. Caching (`src/lib/game-state-service.ts`, `src/lib/redis.ts`)

- Redis read cache: player status (30s TTL), leaderboard (15s TTL)
- `getCachedPlayer(id)`, `getCachedLeaderboard(sessionId)` — cache-aside
- `invalidatePlayer(id)`, `invalidateLeaderboard(sessionId)` — called after any DB mutation
- Fail-open: if Redis is unavailable, operations silently no-op; MySQL is always authoritative
- `getRedis()` — ioredis client; only created if `REDIS_URL` env is set

---

## 11. Database Schema (Engine Tables)

All tables are defined in `prisma/schema.prisma`.

**Engine tables** (game-agnostic):

| Table | Purpose |
|-------|---------|
| `UserAccount` | Optional global login (username, email, bcrypt password, lastLoginAt) |
| `GameSession` | One row per game session (galaxyName, inviteCode, turnMode, dayNumber, gameType, log, status) |
| `Player` | One row per player slot (turnOrder, userId link, passwordHash, isAI) |
| `SessionLock` | Per-session advisory lock support (one row per active session) |
| `AiTurnJob` | Door-game AI turn job queue (status: pending/claimed/done/failed) |
| `AdminSettings` | Singleton; admin password override |
| `SystemSettings` | Singleton; Gemini API key, door-AI concurrency limits, MCTS budget |
| `HighScore` | Persisted final scores across sessions |
| `TurnLog` | One row per completed action (action, params, details JSON) |
| `GameEvent` | Broadcast event log (type, message, gameSessionId) |

**SRX-specific tables**: `Empire`, `Planet`, `Army`, `SupplyRates`, `Research`, `Loan`, `Bond`, `Convoy`, `Market`, `Treaty`, `Coalition`, `Message`.

Games that store state compactly (like Chess and Gin Rummy) use `GameSession.log` (a `Json` field) instead of dedicated tables.

### Key session fields

```
GameSession {
  id, gameType (default "srx"), galaxyName (unique), inviteCode (unique, 8-char hex)
  isPublic, waitingForHuman, maxPlayers (2–128, default 50)
  log (Json?, stores game state for non-DB games like chess)
  status (String, "active" | "complete")
  turnMode (sequential | simultaneous)
  currentTurnPlayerId (null in lobby)
  turnStartedAt (null in lobby, resets each advance)
  turnTimeoutSecs (default 86400)
  dayNumber, actionsPerDay, roundStartedAt  -- simultaneous only
}
```

---

## 12. Authentication

### 12.1 Player authentication

- `UserAccount` — global account (`POST /api/auth/signup`, min 8-char password)
- `POST /api/auth/login` — returns `{ user, games }`, updates `lastLoginAt`
- `POST /api/game/register` / `POST /api/game/join` — link to `UserAccount` when username matches
- Legacy commanders (no `UserAccount`) authenticated via `Player.passwordHash` (bcrypt, min 3 chars)
- `resolvePlayerCredentials` — checks account first, falls back to player password

### 12.2 Admin authentication (`src/lib/admin-auth.ts`)

- `POST /api/admin/login` — signed httpOnly cookie (`srx_admin_session`)
- `requireAdmin` — accepts valid cookie **or** `Authorization: Basic` (for E2E / curl)
- Password stored in `AdminSettings.passwordHash` (bcrypt); falls back to `INITIAL_ADMIN_PASSWORD` env
- `POST /api/admin/password` → updates `AdminSettings`, issues new cookie

---

## 13. Admin UI

Four pages at `/admin`, `/admin/game-sessions`, `/admin/users`, `/admin/maintenance`. All share `<AdminNav>` navigation:

| Box | Links to |
|-----|---------|
| ADMIN | `/admin` — settings, password change |
| GAME SESSIONS | `/admin/game-sessions` — create/delete sessions |
| USERS | `/admin/users` — list accounts, force password, delete |
| MAINTENANCE | `/admin/maintenance` — log management, schema migration |
| REFRESH | Reloads current page's data list |
| LOG OUT | Clears cookie + client storage |
| GAME | `/` — returns to game UI |

Current page's box is grayed out. Refresh is grayed when not applicable.

Admin API routes:
- `GET/POST/DELETE /api/admin/galaxies` — session CRUD
- `GET/PATCH/DELETE /api/admin/users` — user CRUD
- `GET/PATCH /api/admin/settings` — Gemini / door-AI limits (SystemSettings)
- `GET/DELETE /api/admin/logs` — session log row counts; dump+purge TurnLog+GameEvent
- `POST /api/admin/migrate` — hot schema migration (`prisma db push`)
- `POST /api/admin/login` | `POST /api/admin/logout` | `GET /api/admin/me` | `POST /api/admin/password`

---

## 14. Per-Game Help System

Each game ships a help content file at `games/<name>/src/help-content.ts`:

```typescript
export const HELP_REGISTRY: Record<string, { title: string; content: string }> = {
  srx: { title: "Solar Realms Extreme — Help", content: "..." },
}
```

The help route (`src/app/api/game/help/route.ts`) merges all game registries into a single `COMBINED_REGISTRY`. `GET /api/game/help?game=srx` (or `?game=chess`) serves the content as JSON (`{ title, content }`).

The help button (`?`) in the game header bar fetches and displays this content in `<HelpModal>`. Content is cached after the first fetch (no repeat API call within the same session).

---

## 15. UI Shell (`@dge/shell`)

Shared React infrastructure:

| Export | Purpose |
|--------|---------|
| `GameStateBase` | Minimal state shape all games must expose |
| `GameUIConfig<TState>` | Layout + panel component registry per game |
| `GamePanelProps<TState>` | Props passed to MainPanel / SidePanel |
| `useGameState(config)` | Status polling hook |
| `useGameAction(config)` | Action dispatch hook with retry/error handling |
| `GameLayout` | Three/two/single column layout renderer |
| `TurnIndicator` | Generic whose-turn display |

Game-specific UI lives in `games/<name>/src/components/` and can be exposed via `GameUIConfig` for layout-driven rendering, or wrapped entirely in a top-level `GameScreen` component registered in `GAME_SCREEN_REGISTRY` in `src/app/page.tsx`. The latter approach gives a game full control over its in-game UI layout without having to fit into the three-column shell.

### Lobby UI

`src/app/page.tsx` drives the lobby without game-specific code. It reads `CLIENT_GAME_REGISTRY` (a client-side array of `ClientGameMetadata` objects mirroring `GameMetadata`) to:

- Render a **game-select card** per game (name, description)
- Render a **create-game form** with per-game options (dynamic inputs from `createOptions`)
- Filter the **hub** game list by selected game
- Pass the correct `game` key to `POST /api/game/register` and `POST /api/game/join`

No game-specific conditional code appears in the lobby screens.

---

## 16. Adding a New Game (Checklist)

See **Appendix A** for the full interface specifications referenced below.

| Step | What to do |
|------|-----------|
| 1 | Create `games/<name>/` with `package.json` (`@dge/<name>`), `tsconfig.json`, `src/definition.ts`, `docs/GAME-SPEC.md` |
| 2 | Implement `GameDefinition<TState>` (§4, §A.1) — required: `loadState`, `saveState`, `applyAction`, `evalState`, `generateCandidateMoves` |
| 3 | Implement `GameMetadata` (§A.2) — lobby card and create-game form; include `aiDifficulty` select option if the game supports difficulty selection |
| 4 | Implement `GameHttpAdapter` (§A.3) — required: `buildStatus`, `getPlayerCreateData`, `defaultTotalTurns`, `defaultActionsPerDay`; optional: `defaultTurnTimeoutSecs` |
| 5 | Create `src/lib/<name>-registration.ts` — calls `registerGame("<name>", { definition, metadata, adapter, hooks? })` |
| 6 | Add `import "@/lib/<name>-registration"` to `src/lib/game-bootstrap.ts` |
| 7 | Create `src/components/<Name>GameScreen.tsx` — owns the full in-game UI |
| 8 | Register in `GAME_SCREEN_REGISTRY` and `CLIENT_GAME_REGISTRY` in `src/app/page.tsx` |
| 9 | Create `games/<name>/src/help-content.ts` with `HELP_REGISTRY` entry; add to `COMBINED_REGISTRY` in help route |
| 10 | Add path aliases to root `tsconfig.json` and `COPY` lines to `Dockerfile.dev` |
| 11 | If using game-specific Prisma models, add to `schema.prisma` and run `prisma db push` |
| 12 | Add tests: `tests/unit/<name>-*.test.ts` + `tests/e2e/<name>-*.test.ts` |
| 13 | **Optional AI difficulty**: define an `AiDifficultyProfile` (§4.3), add it to `GameDefinition.aiDifficultyProfile`, store the selected tier in game state, and read it in the AI move function |

**Optional per turn mode**: implement `TurnOrderHooks` (§A.4) for sequential mode, `DoorGameHooks` (§A.5) for simultaneous mode, `SearchGameFunctions` (§A.6) for MCTS AI.

### UI dispatch flow

`src/app/page.tsx` is a thin lobby shell. Once a session is active, it dispatches to the game's `GameScreen`:

```typescript
const GameScreen = GAME_SCREEN_REGISTRY[activeGame] ?? SrxGameScreen;
return <GameScreen {...sessionProps} onLogout={handleLogout} />;
```

Each `GameScreen` fully owns its in-game UI — panels, polling, actions, modals. The lobby shell only passes initial session props (IDs, invite code, galaxy name, etc.).

---

## 17. Test Coverage Map

| Area | Test type | File(s) |
|------|-----------|---------|
| Engine registry | Unit | `tests/unit/registry.test.ts` |
| GameOrchestrator guards | Unit | `tests/unit/orchestrator.test.ts` |
| Turn order logic | Unit | `tests/unit/turn-order-lobby.test.ts` |
| Turn order hooks | Unit | `tests/unit/turn-order-hooks.test.ts` |
| Door-game helpers | Unit | `tests/unit/door-game-turns.test.ts` |
| Door-game engine (openFullTurn/closeFullTurn) | Unit | `tests/unit/engine-door-game.test.ts` |
| SRX context bridging | Unit | `tests/unit/srx-context-bridging.test.ts` |
| AI concurrency semaphores | Unit | `tests/unit/ai-concurrency.test.ts` |
| AI runtime settings | Unit | `tests/unit/door-ai-runtime-settings.test.ts` |
| AI difficulty profiles | Unit | `tests/unit/ai-difficulty.test.ts` |
| RNG | Unit | `tests/unit/rng.test.ts` |
| Help API | E2E | `tests/e2e/api-routes.test.ts` |
| Admin CRUD | E2E | `tests/e2e/admin.test.ts` |
| Auth / signup | E2E | `tests/e2e/auth-account.test.ts` |
| Full game flow | E2E | `tests/e2e/game-flow.test.ts` |
| Door-game mode | E2E | `tests/e2e/door-game.test.ts` |
| Multiplayer | E2E | `tests/e2e/multiplayer.test.ts` |

SRX-specific tests:

| Area | Test type | File(s) |
|------|-----------|---------|
| SRX GameDefinition (applyTick, applyAction, evalState, moves) | Unit | `tests/unit/srx-game-definition.test.ts` |
| Game constants | Unit | `tests/unit/game-constants.test.ts` |
| Research tree | Unit | `tests/unit/research.test.ts` |
| Combat formulas | Unit | `tests/unit/combat.test.ts` |
| Espionage | Unit | `tests/unit/espionage.test.ts` |
| Empire Prisma mapping | Unit | `tests/unit/empire-prisma.test.ts` |
| Critical events | Unit | `tests/unit/critical-events.test.ts` |
| Simulation / balance | Unit | `tests/unit/simulation.test.ts` |
| Combat reporting | E2E | `tests/e2e/combat-reporting.test.ts` |
| Defender alerts | E2E | `tests/e2e/defender-alerts.test.ts` |
| Protection enforcement | E2E | `tests/e2e/protection.test.ts` |
| Lobby flow | E2E | `tests/e2e/lobby.test.ts` |

Chess-specific tests:

| Area | Test type | File(s) |
|------|-----------|---------|
| Chess rules (move gen, check, mate, castling, en passant, promotion, draw) | Unit | `tests/unit/chess-rules.test.ts` |
| Chess MCTS search functions | Unit | `tests/unit/chess-mcts.test.ts` |
| Chess full game flow (register, status, moves, play, AI, resign, game-over) | E2E | `tests/e2e/chess.test.ts` |

Gin Rummy-specific tests:

| Area | Test type | File(s) |
|------|-----------|---------|
| Meld detection, deadwood, layoff options | Unit | `tests/unit/ginrummy-melds.test.ts` |
| Game lifecycle: deal, draw, knock, gin, undercut, scoring, resign | Unit | `tests/unit/ginrummy-rules.test.ts` |
| MCTS search functions, eval, determinization, AI moves | Unit | `tests/unit/ginrummy-mcts.test.ts` |
| Full game flow (register, status, draw, discard, AI, resign, human vs human) | E2E | `tests/e2e/ginrummy.test.ts` |

---

## 18. Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | — | MySQL connection string (required) |
| `REDIS_URL` | — | Redis connection; omit to disable cache |
| `GEMINI_API_KEY` | — | Optional; enables LLM AI personas |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model name |
| `GEMINI_TIMEOUT_MS` | `60000` | Per-call timeout, clamped 1000–300000 |
| `GEMINI_MAX_CONCURRENT` | `4` | Max parallel Gemini calls; overridden by SystemSettings |
| `DOOR_AI_MAX_CONCURRENT_MCTS` | `1` | Max parallel MCTS runs; overridden by SystemSettings |
| `DOOR_AI_DECIDE_BATCH_SIZE` | `4` | AI decision batch size; overridden by SystemSettings |
| `DOOR_AI_MOVE_TIMEOUT_MS` | `60000` | Per-AI wall-clock cap; overridden by SystemSettings |
| `AI_WORKER_POLL_MS` | `500` | ai-worker poll interval when queue empty |
| `AI_WORKER_CONCURRENCY` | `1` | Parallel job slots per worker process |
| `MCTS_BUDGET_MS` | `45000` | MCTS search budget for optimal persona (ms); overridden by SystemSettings |
| `AI_COMPACT_PROMPT` | `0` | Set to `1` for shorter Gemini prompts; overridden by SystemSettings |
| `SRX_LOG_AI_TIMING` | — | Set to `1` to emit `[srx-ai]` JSON timing lines |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `INITIAL_ADMIN_PASSWORD` | `srxpass` | Admin password if not set in AdminSettings |
| `ADMIN_SESSION_SECRET` | — | httpOnly cookie signing key (min 32 chars in production) |

`DATABASE_URL` is always read from the environment. Other DB-stored settings (`geminiApiKey`, concurrency caps) override env values when present in `SystemSettings`.

---

## 19. Observability

### Timing logs (SRX-specific)

These logging prefixes are implemented by SRX's wiring layer (`src/lib/srx-timing.ts`), not the engine. Other games can implement their own observability.

`[srx-timing]` JSON lines (always on) — emitted for:
- `POST /api/game/action` — route + lock + action phases
- `POST /api/game/tick` — route + tick phases
- `GET|POST /api/game/status` — route + buildResponse breakdown
- `GET /api/game/leaderboard`

`[srx-ai]` JSON lines (opt-in via `SRX_LOG_AI_TIMING=1`) — emitted for:
- `getAIMove` — configMs, generateMs, totalMs, source
- `runOneAI` — contextMs, getAIMoveMs, executeMs

### Engine-level observability

**TurnLog** — one row per completed action (engine table). `details` JSON is game-specific. SRX uses `params`, `actionMsg`, and either `report` (economy snapshot) or `tickReportDeferred: true`.

**GameEvent** — broadcast log (engine table). `gameSessionId` scoped (new events) or null (legacy). SRX `type: ai_turn` rows include `details.llmSource` (`gemini` | `fallback`).

Both tables are written by games via their `processFullAction` implementations or via `SideEffect` declarations in `ActionResult`. The engine provides the tables; games decide what to log.

---

## Appendix A — Game–Engine Contract (Complete Interface Reference)

This appendix consolidates every interface a game may implement. See §16 for the step-by-step checklist.

### A.1 `GameDefinition<TState>` (`@dge/shared`)

The core contract. See §4 for the annotated version. Summary of required vs optional:

| Method | Required | Used by |
|--------|----------|---------|
| `loadState(sessionId, playerId, action, db)` | **Yes** | Orchestrator |
| `saveState(sessionId, state, db)` | **Yes** | Orchestrator |
| `applyAction(state, playerId, action, params, rng)` | **Yes** | Orchestrator + MCTS |
| `evalState(state, forPlayerId)` | **Yes** | MCTS |
| `generateCandidateMoves(state, forPlayerId)` | **Yes** | MCTS + AI |
| `applyTick?(state, rng): TickResult<TState>` | No | Orchestrator (tickless games omit) |
| `projectState?(state, forPlayerId)` | No | Fog-of-war games |
| `buildAIContext?(state, forPlayerId)` | No | LLM prompt construction |
| `toPureState?(state)` | No | Worker thread serialization |
| `generateReplay?(before, after, action, params)` | No | Expensive replay generation |
| `processFullAction?(playerId, action, params, opts?)` | No | Full-track migration |
| `processFullTick?(playerId)` | No | Full-track migration |
| `runAiSequence?(sessionId)` | No | Sequential AI after human turn |
| `postActionClose?(playerId, sessionId)` | No | Door-game custom close logic |
| `admin?: GameAdminConfig` | No | Admin panel extensions |

### A.2 `GameMetadata` (`@dge/shared`)

Drives the lobby UI (game-select cards, create-game form) without per-game React code.

```typescript
interface GameMetadata {
  game: string               // canonical key matching GameSession.gameType
  displayName: string        // name on the game-select card
  description: string        // short blurb
  playerRange: [number, number]  // [min, max] players
  supportsJoin: boolean      // players can join via invite / public list
  autoCreateAI?: boolean     // server auto-creates AI opponent on creation
  createOptions: GameCreateOption[]  // dynamic form fields
}

interface GameCreateOption {
  key: string
  label: string
  description?: string
  type: "number" | "boolean" | "select"
  default: unknown
  min?: number; max?: number
  options?: { value: string; label: string }[]
}
```

### A.3 `GameHttpAdapter` (`@dge/shared`)

Per-game hooks for API routes. Routes call adapter methods instead of branching on game type.

```typescript
interface GameHttpAdapter {
  // Required
  buildStatus(playerId: string): Promise<Record<string, unknown>>
  getPlayerCreateData(): Record<string, unknown>
  defaultTotalTurns: number
  defaultActionsPerDay: number
  defaultTurnTimeoutSecs?: number   // Falls back to 86400 (24h) if unset

  /** True when the player's game is irrevocably over. Called by action/tick/status routes to return 410. */
  isGameOver(playerId: string): Promise<boolean>

  // Optional
  buildLeaderboard?(sessionId: string | null): Promise<unknown[]>
  buildGameOver?(sessionId: string, playerName: string): Promise<Record<string, unknown>>
  onSessionCreated?(sessionId: string, creatorPlayerId: string, options: Record<string, unknown>): Promise<void>
  onPlayerJoined?(sessionId: string, playerId: string): Promise<void>
  /** Return extra per-game stats for the hub (e.g. SRX returns { turnsLeft, turnsPlayed }). */
  getHubStats?(playerId: string): Promise<Record<string, unknown>>
  computeHubTurnState?(
    player: { id: string },   // empire-agnostic; adapter loads game state internally
    session: { id: string; turnMode: string; actionsPerDay: number; currentTurnPlayerId: string | null },
  ): Promise<{ isYourTurn: boolean; currentTurnPlayer: string | null }>
  /**
   * Door-game (simultaneous) pre-lock guards. Returns null for non-door games.
   * Called by the tick route before acquiring the advisory lock.
   */
  getDoorGameGuards?(
    playerId: string, actionsPerDay: number,
  ): Promise<{ canAct: boolean; turnAlreadyOpen: boolean } | null>
}
```

| Method | When called |
|--------|-----------|
| `buildStatus` | `GET/POST /api/game/status` — builds the full response payload |
| `isGameOver` | `POST /api/game/action`, `/tick`, and resume — returns 410 when the game is over |
| `getPlayerCreateData` | `POST /api/game/register` / `join` — Prisma nested-create data for new players |
| `onSessionCreated` | After `GameSession` + creator `Player` committed — game-specific init (AI players, initial state) |
| `onPlayerJoined` | After a player joins an existing session |
| `buildLeaderboard` | `GET /api/game/leaderboard` |
| `buildGameOver` | `POST /api/game/gameover` — accepts `playerId` (preferred) or `playerName` for unambiguous lookup |
| `getHubStats` | `POST /api/auth/login` — optional per-game stats appended to hub game cards (SRX: `turnsLeft`, `turnsPlayed`) |
| `computeHubTurnState` | `POST /api/auth/login` — isYourTurn for the hub game list; adapter loads game-specific state internally |
| `getDoorGameGuards` | `POST /api/game/tick` (simultaneous mode) — pre-lock slot availability checks; null = sequential only |

### A.4 `TurnOrderHooks` (`@dge/engine`)

Required only for games using sequential turn mode. Injected via `GameHooks.turnOrder`.

```typescript
interface TurnOrderHooks {
  runTick(playerId: string): Promise<void>           // tick for timed-out player
  processEndTurn(playerId: string): Promise<void>    // end_turn for timed-out player
  getActivePlayers?(sessionId: string): Promise<     // which players are still active
    { id: string; name: string; isAI: boolean; turnOrder: number }[]
  >
}
```

`getCurrentTurn(sessionId, hooks)` uses these to auto-skip timed-out human players (runs their tick + end_turn). `getActivePlayers` defaults to all players in the session when omitted — override for games where players can be eliminated mid-session.

### A.5 `DoorGameHooks` (`@dge/engine`)

Required only for games using simultaneous (door-game) turn mode. Injected via `GameHooks.doorGame`.

```typescript
interface DoorGameHooks {
  // Per-player state reads
  canPlayerAct(playerId: string, actionsPerDay: number): Promise<boolean>
  isTurnOpen(playerId: string): Promise<boolean>
  isTickProcessed(playerId: string): Promise<boolean>
  hasTurnsRemaining(playerId: string): Promise<boolean>

  // Per-player state writes
  openTurnSlot(playerId: string): Promise<void>
  closeTurnSlot(playerId: string): Promise<{ remainingTurns: number }>
  forfeitSlots(playerId: string, slotsLeft: number, sessionId: string): Promise<{ remainingTurns: number }>  // must also increment turnsPlayed
  resetDailySlots(sessionId: string): Promise<void>

  // Round state
  getPlayerSlotUsage(sessionId: string): Promise<{ id: string; slotsUsed: number; hasRemainingTurns: boolean }[]>

  // Game lifecycle callbacks
  runTick(playerId: string): Promise<unknown>
  runEndgameTick(playerId: string, sessionId: string): Promise<void>
  logSessionEvent(sessionId: string, payload: { type: string; message: string; details: Record<string, unknown> }): Promise<void>

  // Optional
  invalidatePlayer?(playerId: string): void
  invalidateLeaderboard?(sessionId: string): void
  onDayComplete?(sessionId: string): void
}
```

The engine calls these hooks from `openFullTurn`, `closeFullTurn`, and `tryRollRound`. The game stores per-player turn state however it chooses (SRX uses `Empire` fields; another game could use `Player` fields or a separate table).

### A.6 `SearchGameFunctions<TState>` (`@dge/engine`)

Required only for games that use the engine's MCTS or MaxN search. Players are identified by integer index (0-based), not string ID — the game maps between the two.

```typescript
interface SearchGameFunctions<TState> {
  applyTick(state: TState, playerIdx: number, rng: () => number, playerCount: number): TState
  applyAction(state: TState, playerIdx: number, action: string, params: Record<string, unknown>, rng: () => number): { state: TState; success: boolean }
  evalState(state: TState, playerIdx: number): number
  generateCandidateMoves(state: TState, playerIdx: number, maxMoves: number): Move[]
  cloneState(state: TState): TState
  pickRolloutMove(state: TState, playerIdx: number, candidates: Move[], rng: () => number): Move
  getPlayerCount(state: TState): number
  isTerminal(state: TState, playerIdx: number): boolean
}
```

| Method | Purpose |
|--------|---------|
| `applyTick` | Economy/physics pass before each player's action in rollouts |
| `applyAction` | Apply a move; `success: false` = silently skip in rollout |
| `evalState` | Score from playerIdx perspective (higher = better); used for backprop |
| `generateCandidateMoves` | Branch factor — `maxMoves` limits candidates per node |
| `cloneState` | Deep-clone for speculative mutation |
| `pickRolloutMove` | Strategy-aligned heuristic for realistic rollout play |
| `getPlayerCount` | Number of players in the game |
| `isTerminal` | True when this player is eliminated / game over |

MCTS configuration:

```typescript
interface MCTSConfig {
  iterations: number       // default 800; ignored when timeLimitMs is set
  timeLimitMs?: number     // wall-clock budget (overrides iterations)
  rolloutDepth: number     // turns per rollout (default 30)
  explorationC: number     // UCB1 constant (default √2)
  branchFactor: number     // candidates per node (default 12)
  seed: number | null      // RNG seed; null = Math.random
}
```
