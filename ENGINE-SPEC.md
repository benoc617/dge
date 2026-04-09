# Door Game Engine — Complete Engine Specification

This document fully specifies the Door Game Engine (DGE): the turn-management, AI, search, caching, authentication, and administration infrastructure shared across all games. It is intended to be complete enough to implement a second game from scratch using DGE.

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
  random(): number
  randomInt(min: number, max: number): number
  chance(p: number): boolean
}
```

The engine passes `Rng` to all pure functions. The default implementation (`src/lib/rng.ts`) uses a seeded mulberry32 PRNG. `setSeed(null)` switches to production randomness; `setSeed(n)` enables deterministic simulation.

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

## 4. GameDefinition Interface (`@dge/engine`)

Every game must implement `GameDefinition<TState>`:

```typescript
interface GameDefinition<TState> {
  // === Full-track (async, DB-aware) ===
  processFullAction(
    sessionId: string,
    playerId: string,
    action: string,
    params: unknown,
    opts?: ActionOptions,
  ): Promise<ActionResult<TState>>

  processFullTick(sessionId: string, playerId: string, opts?: TickOptions): Promise<TickResult<TState>>

  runAiSequence(sessionId: string): Promise<void>

  postActionClose?(sessionId: string, playerId: string, result: ActionResult<TState>): Promise<void>

  // === Pure (sync, no DB) — used by MCTS / simulation ===
  applyTick?(state: TState, rng: Rng): TState
  applyAction(state: TState, playerId: string, action: string, params: unknown, rng: Rng): ActionResult<TState>
  evalState(state: TState, forPlayerId: string): number
  generateCandidateMoves(state: TState, forPlayerId: string): Move[]

  // === Optional ===
  projectState?(state: TState, forPlayerId: string): TState
  buildAIContext?(state: TState, forPlayerId: string): unknown
  toPureState?(state: TState): TState
}
```

### 4.1 Full-track vs Pure track

| Track | Where used | DB access |
|-------|-----------|-----------|
| Full-track | Real gameplay, API routes | Yes (Prisma) |
| Pure track | MCTS rollouts, simulation harness | No |

The orchestrator calls full-track methods in response to HTTP actions. The search algorithm calls pure-track methods in tight loops. Games may share logic between both tracks (SRX does this for most action handlers).

---

## 5. Game Registry (`packages/engine/src/registry.ts`)

```typescript
// Registration input — passed to registerGame()
interface GameRegistrationInput<TState> {
  definition: GameDefinition<TState>;
  metadata: GameMetadata;      // lobby metadata (display name, options, player range)
  adapter: GameHttpAdapter;    // API route delegation hooks
  hooks?: GameHooks;           // engine lifecycle hooks (turn order, door-game)
}

registerGame(gameType: string, input: GameRegistrationInput<TState>): void
getGame(gameType: string): GameRegistration | undefined
requireGame(gameType: string): GameRegistration   // throws if not found
listGameTypes(): string[]
_clearRegistry(): void   // test helper only
```

Each registered game provides three pluggable objects alongside its `GameDefinition`:

| Object | Purpose |
|--------|---------|
| `GameMetadata` | Drives the generic lobby UI (display name, description, player range, create-game options) |
| `GameHttpAdapter` | Delegates game-specific API payload construction (status, leaderboard, game-over, player init) |
| `GameHooks` | Injects game-specific engine lifecycle callbacks (sequential turn-order, door-game close/roll) |

All games register at application startup. Instead of importing each game's registration file in every API route, a single **bootstrap module** consolidates all registrations:

```typescript
// src/lib/game-bootstrap.ts — import this once in any API route
import "@/lib/srx-registration";
// import "@/lib/chess-registration";   ← add new games here
```

Routes call `requireGame(game)` (where `game` comes from `GameSession.gameType` mapped to the `game` field in API responses) to retrieve the orchestrator, metadata, or adapter for the session's game type.

### 5.1 `GameMetadata` (lobby contract)

```typescript
interface GameMetadata {
  game: string;              // canonical key matching GameSession.gameType
  displayName: string;       // name shown on the game-select card
  description: string;       // short blurb
  playerRange: [number, number]; // [min, max] players
  supportsJoin: boolean;     // whether players can join via invite/public list
  autoCreateAI?: boolean;    // server auto-creates an AI opponent on creation
  createOptions: GameCreateOption[];  // options rendered in the create-game form
}

interface GameCreateOption {
  key: string;
  label: string;
  description?: string;
  type: "number" | "boolean" | "select";
  default: unknown;
  min?: number; max?: number;
  options?: { value: string; label: string }[];
}
```

The client mirrors this as a static `ClientGameMetadata` array (`CLIENT_GAME_REGISTRY` in `src/app/page.tsx`) so the lobby UI renders without server dependencies.

### 5.2 `GameHttpAdapter` (API delegation contract)

```typescript
interface GameHttpAdapter {
  // Status & read paths
  buildStatus(playerId: string): Promise<Record<string, unknown>>;
  buildLeaderboard?(sessionId: string | null): Promise<unknown[]>;
  buildGameOver?(sessionId: string, playerName: string): Promise<Record<string, unknown>>;

  // Session & player initialization
  getPlayerCreateData(): Record<string, unknown>;
  onSessionCreated?(sessionId, creatorPlayerId, options): Promise<void>;
  onPlayerJoined?(sessionId, playerId): Promise<void>;

  // Session defaults
  defaultTotalTurns: number;
  defaultActionsPerDay: number;

  // Hub games list (login response)
  computeHubTurnState?(player, session): Promise<{ isYourTurn, currentTurnPlayer }>;
}
```

API routes call adapter methods instead of branching on game type. SRX's adapter lives in `src/lib/srx-http-adapter.ts`.

### 5.3 `game` field vs `gameType` column

The database column is `GameSession.gameType`. The API and UI use the field name `game`. Routes map `gameType → game` in every outbound JSON response. This keeps the DB schema stable while giving the public API a cleaner name.

---

## 6. GameOrchestrator (`packages/engine/src/orchestrator.ts`)

The `GameOrchestrator<TState>` wraps a `GameDefinition` and provides turn-lifecycle hooks:

```typescript
class GameOrchestrator<TState> {
  // Sequential turn mode
  readonly turnOrderHooks: TurnOrderHooks<TState>
  // Door-game (simultaneous) mode
  readonly doorGameHooks: DoorGameHooks<TState>

  sessionCannotHaveActiveTurn(session: SessionLike): boolean
  canPlayerAct(empire: { turnsLeft: number; fullTurnsUsedThisRound: number }, actionsPerDay: number): boolean
  getCandidateMoves(state: TState, playerId: string): Move[]
}
```

The orchestrator is constructed per-request (stateless wrapper). It delegates action execution to the game definition and uses hooks for engine-level concerns (lock acquisition, turn advancement, AI queueing).

---

## 7. Turn Modes

### 7.1 Sequential turns

- `GameSession.currentTurnPlayerId` — ID of the player whose turn it is
- `Player.turnOrder` — fixed position; advances cyclically
- `getCurrentTurn(sessionId)` — resolves current player; auto-skips timed-out players
- `advanceTurn(sessionId)` — moves `currentTurnPlayerId` to next active player
- Turn timer: `turnStartedAt` resets each advance; `turnTimeoutSecs` default 86400 (24h)
- AI turns run via `runAISequence` after each human action (fire-and-forget)

### 7.2 Simultaneous / door-game turns

- `GameSession.turnMode === "simultaneous"`
- Calendar rounds: `dayNumber`, `actionsPerDay` (default 5), `roundStartedAt`
- Per empire: `turnOpen`, `fullTurnsUsedThisRound`
- `openFullTurn(sessionId, playerId)` — begins a full-turn slot (runs tick, sets `turnOpen`)
- `closeFullTurn(sessionId, playerId)` — ends slot, decrements `turnsLeft`
- `tryRollRound(sessionId)` — advances `dayNumber` when all empires exhausted daily slots or round timer expired; charges `turnsLeft` for skipped slots
- AI turns queued via `enqueueAiTurnsForSession` → `AiTurnJob` table → ai-worker picks up
- Round timer: when `roundStartedAt + turnTimeoutSecs` elapses, `tryRollRound` skips remaining slots

### 7.3 Lobby state

A session with `waitingForHuman: true` is a pre-staged admin lobby. `currentTurnPlayerId` is null; `turnStartedAt` is null; `getCurrentTurn` returns null. The lobby activates when the first human joins via `POST /api/game/join`.

---

## 8. AI System

### 8.1 LLM integration (`src/lib/gemini.ts`)

- `resolveGeminiConfig()` — reads `SystemSettings` (DB) first, then env (`GEMINI_API_KEY`, `GEMINI_MODEL`)
- Each call is bounded by `GEMINI_TIMEOUT_MS` (default 60s, clamped 1s–5min)
- `withGeminiGeneration` / `withMctsDecide` — dynamic semaphores (caps from `resolveDoorAiRuntimeSettings()` with ~60s in-process cache)
- `getAIMove(playerId)` returns `{ action, params, llmSource: 'gemini' | 'fallback' }`

### 8.2 AI strategies

Seven persona types (assigned randomly at session creation; players never know an AI's strategy):
`economist`, `warlord`, `spymaster`, `diplomat`, `turtle`, `researcher`, `optimal`

- `optimal` runs MCTS (`sim-state` + `search-opponent`) with a 300ms budget
- All others use heuristic `localFallback` or Gemini prompts when a key is configured

### 8.3 MCTS search (`src/lib/search-opponent.ts`)

N-player MCTS with UCB1 selection, strategy-aligned rollout (`pickRolloutMove`), and backprop. Entry points:
- `mctsSearch(config)` — returns the best `Move`
- `maxNMove(config)` — shallow MaxN alternative
- `searchOpponentMove(config)` — dispatches based on config

MCTS only calls **pure-track** functions. No DB access.

### 8.4 AI worker (`scripts/ai-worker.ts`)

Standalone process (separate Compose service). Polls `AiTurnJob` via `SELECT … FOR UPDATE SKIP LOCKED`. Runs `runOneDoorGameAI`, then cascades with `enqueueAiTurnsForSession`. Supports `AI_WORKER_CONCURRENCY` parallel slots. Recovers stale jobs (reset claimed→pending) every 30s.

---

## 9. Concurrency and Locking (`src/lib/db-context.ts`)

- `withCommitLock(sessionId, fn)` — per-session advisory lock
  - `INSERT IGNORE SessionLock` + `SELECT … FOR UPDATE NOWAIT`
  - Interactive transaction with 60s timeout
  - Throws `GalaxyBusyError` (HTTP 409) on contention
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

All tables are defined in `prisma/schema.prisma`. Engine-level tables:

| Table | Purpose |
|-------|---------|
| `UserAccount` | Optional global login (username, email, bcrypt password, lastLoginAt) |
| `GameSession` | One row per game session (galaxyName, inviteCode, turnMode, dayNumber, etc.) |
| `Player` | One row per empire slot (turnOrder, userId link, passwordHash) |
| `SessionLock` | Per-session advisory lock support (one row per active session) |
| `AiTurnJob` | Door-game AI turn job queue (status: pending/claimed/done/failed) |
| `AdminSettings` | Singleton; admin password override |
| `SystemSettings` | Singleton; Gemini API key, door-AI concurrency limits |
| `HighScore` | Persisted final scores across sessions |
| `TurnLog` | One row per completed action (action, params, details JSON) |
| `GameEvent` | Broadcast event log (type, message, gameSessionId) |
| `Market` | Global market singleton (supply, demand, coordinator pool) |
| `Treaty` | Inter-empire agreements (6 types, binding duration) |
| `Coalition` | Groups of up to 5 empires |
| `Message` | Player-to-player messages |

Game-specific tables (SRX): `Empire`, `Planet`, `Army`, `SupplyRates`, `Research`, `Loan`, `Bond`, `Convoy`.

### Key session fields

```
GameSession {
  id, galaxyName (unique), inviteCode (unique, 8-char hex)
  isPublic, waitingForHuman, maxPlayers (2–128, default 50)
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

Three pages at `/admin`, `/admin/game-sessions`, `/admin/users`. All share `<AdminNav>` navigation:

| Box | Links to |
|-----|---------|
| ADMIN | `/admin` — settings, password change |
| GAME SESSIONS | `/admin/game-sessions` — create/delete sessions |
| USERS | `/admin/users` — list accounts, force password, delete |
| REFRESH | Reloads current page's data list |
| LOG OUT | Clears cookie + client storage |
| GAME | `/` — returns to game UI |

Current page's box is grayed out. Refresh is grayed when not applicable.

Admin API routes:
- `GET/POST/DELETE /api/admin/galaxies` — session CRUD
- `GET/PATCH/DELETE /api/admin/users` — user CRUD
- `GET/PATCH /api/admin/settings` — Gemini / door-AI limits (SystemSettings)
- `POST /api/admin/login` | `POST /api/admin/logout` | `GET /api/admin/me` | `POST /api/admin/password`

---

## 14. Per-Game Help System

Each game ships a help content file at `games/<name>/src/help-content.ts`:

```typescript
export const HELP_REGISTRY: Record<string, { title: string; content: string }> = {
  srx: { title: "Solar Realms Extreme — Help", content: "..." },
}
```

`GET /api/game/help?game=srx` serves the content as JSON (`{ title, content }`).

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

## 16. Adding a New Game

1. **Create `games/<name>/`** with `package.json` (`@dge/<name>`), `tsconfig.json`, `src/definition.ts`, and `games/<name>/docs/GAME-SPEC.md`
2. **Implement `GameDefinition<TState>`** — at minimum `loadState`, `saveState`, `applyAction`, `evalState`, `generateCandidateMoves`. Add `applyTick` if your game has economy ticks.
3. **Implement `GameMetadata`** — display name, description, player range, `supportsJoin`, and `createOptions` for the lobby form.
4. **Implement `GameHttpAdapter`** — at minimum `buildStatus`, `getPlayerCreateData`, `defaultTotalTurns`, `defaultActionsPerDay`. Add `onSessionCreated`, `onPlayerJoined`, `buildLeaderboard`, `buildGameOver`, `computeHubTurnState` as needed.
5. **Create `src/lib/<name>-registration.ts`** calling `registerGame("<name>", { definition, metadata, adapter, hooks })`.
6. **Add the registration import to `src/lib/game-bootstrap.ts`** — one line: `import "@/lib/<name>-registration"`.
7. **Create a `GameScreen` component** (e.g. `src/components/<Name>GameScreen.tsx`) that owns the full in-game UI. It receives the same props as `SrxGameScreen` (`playerName`, `sessionPlayerId`, `gameSessionId`, `initialInviteCode`, `initialGalaxyName`, `initialIsPublic`, `isCreator`, `initialEvents`, `onLogout`).
8. **Register the `GameScreen`** in `GAME_SCREEN_REGISTRY` in `src/app/page.tsx` and add a matching entry to `CLIENT_GAME_REGISTRY`.
9. **Create `games/<name>/src/help-content.ts`** with a `HELP_REGISTRY` entry; add it to the `COMBINED_REGISTRY` in `src/app/api/game/help/route.ts`.
10. **Add any game-specific Prisma models** to `prisma/schema.prisma` and run `docker compose exec app npx prisma db push`.
11. **Add tests** — unit tests in `tests/unit/<name>-*.test.ts`, E2E tests in `tests/e2e/<name>-*.test.ts`.

### UI dispatch flow (pages and lobby)

`src/app/page.tsx` is a thin lobby shell. It handles login/signup and game selection using `CLIENT_GAME_REGISTRY` (client-side mirror of `GameMetadata`). Once a game session is active (`playerName` is set), it dispatches to the game's `GameScreen` component from `GAME_SCREEN_REGISTRY`:

```typescript
// In page.tsx
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
| Door-game helpers | Unit | `tests/unit/door-game-turns.test.ts` |
| AI concurrency semaphores | Unit | `tests/unit/ai-concurrency.test.ts` |
| AI runtime settings | Unit | `tests/unit/door-ai-runtime-settings.test.ts` |
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
| `SRX_LOG_AI_TIMING` | — | Set to `1` to emit `[srx-ai]` JSON timing lines |
| `ADMIN_USERNAME` | `admin` | Admin login username |
| `INITIAL_ADMIN_PASSWORD` | `srxpass` | Admin password if not set in AdminSettings |
| `ADMIN_SESSION_SECRET` | — | httpOnly cookie signing key (min 32 chars in production) |

`DATABASE_URL` is always read from the environment. Other DB-stored settings (`geminiApiKey`, concurrency caps) override env values when present in `SystemSettings`.

---

## 19. Observability

### Timing logs

`[srx-timing]` JSON lines (always on) — emitted for:
- `POST /api/game/action` — route + lock + action phases
- `POST /api/game/tick` — route + tick phases
- `GET|POST /api/game/status` — route + buildResponse breakdown
- `GET /api/game/leaderboard`

`[srx-ai]` JSON lines (opt-in via `SRX_LOG_AI_TIMING=1`) — emitted for:
- `getAIMove` — configMs, generateMs, totalMs, source
- `runOneAI` — contextMs, getAIMoveMs, executeMs

### TurnLog

One row per completed action. `details` JSON contains `params`, `actionMsg`, and one of:
- `report` — economy snapshot (income, expenses, population changes)
- `tickReportDeferred: true` — tick ran earlier this turn; no duplicate report stored

### GameEvent

Broadcast log. `gameSessionId` scoped (new events) or null (legacy). `type: ai_turn` rows include `details.llmSource` (`gemini` | `fallback`).
