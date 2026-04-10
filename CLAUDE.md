# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Container-only npm (mandatory for agents)

**Claude Code, Cursor, and any other automation must not run project Node commands on the host** for verification, fixes, or "does it pass?" checks. The repo is meant to run **inside the Compose `app` container** (Linux image with dependencies installed in the image). Host `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest`, etc. often **fail spuriously** (e.g. missing Rolldown/Vitest native bindings, wrong platform binaries) and **do not** represent the canonical result.

### Never on the host (for agents)

- `npm test`, `npm run test:*`, `test:watch`, `test:coverage`
- `npm run lint`, `npm run typecheck`, `npm run build`
- `npx prisma …` when the goal is to match the running app container (prefer `exec` below)
- `npm run seed:system-settings`, `npm run repair:door-session`, `npm run sim` / `sim:*` **for verification** (run these **inside** `app` unless the user explicitly wants a host-only path)

### Always use the container

With the stack up (`npm run docker:up` or `docker compose up -d`), run **from the repo root** on the host:

| Purpose | Command |
|--------|---------|
| Unit tests | `npm run docker:test` |
| E2E tests | `npm run docker:test:e2e` |
| Unit + E2E | `npm run docker:test:all` |
| ESLint | `npm run docker:lint` |
| TypeScript | `npm run docker:typecheck` |
| Production build | `npm run docker:build` |
| Prisma | `docker compose exec app npx prisma db push` (or `generate`, `studio`) |
| Seed / repair / sim | `docker compose exec app npm run seed:system-settings` — same pattern for `repair:door-session`, `sim:quick`, etc. |

Equivalent: `docker compose exec app npm run lint` (etc.) if you prefer not to use the `docker:*` wrappers.

### Exceptions

1. The **user explicitly** asks for a host-only command (e.g. debugging one-off).
2. **CI** jobs that use a **clean Linux** checkout and `npm ci` — not the agent's default path.

If a command fails on the host, **do not** treat that as the project failing until the **same** command has been run **inside `app`**.

## Documentation Sync Rule

**Whenever you make a change to game mechanics, constants, UI, data model, or project structure — especially before a commit — you MUST update all affected documentation files:**

- **`README.md`** — Project overview, setup, tech stack, structure. Update if you add dependencies, change commands, add files, or change the project description.
- **`ENGINE-SPEC.md`** — Complete engine specification (turn modes, AI, schema, auth, admin, help system). Update if you change engine-level mechanics, the `GameDefinition` interface, admin pages, or auth.
- **`games/srx/docs/HOWTOPLAY.md`** — SRX player-facing game guide. Update if you change SRX game mechanics, actions, costs, strategies, or UI controls.
- **`games/srx/docs/GAME-SPEC.md`** — SRX complete technical specification. Update if you change ANY SRX formula, constant, data model field, action type, tech tree entry, combat mechanic, or turn tick step. This is the authoritative SRX spec — it must always match the code.
- **`games/chess/docs/GAME-SPEC.md`** — Chess technical specification. Update if you change chess rules, MCTS config, state persistence, or action handling.
- **`games/ginrummy/docs/GAME-SPEC.md`** — Gin Rummy technical specification. Update if you change Gin Rummy rules, meld detection, MCTS/determinization config, state schema, action types, or scoring.
- **`CLAUDE.md`** — This file. Update if you change commands, architecture, key file roles, or add new conventions.
- **`AGENTS.md`** — Cursor / editor agent rules. Update if you change container-only tooling policy, Next.js agent notices, or repo-wide agent constraints.

**Before every commit, verify that all documentation files reflect the current state of the codebase.** If a change only affects code style or non-functional refactoring, docs may not need updating — use judgment.

## Test Sync Rule

**Every code change MUST include corresponding test updates.** This is non-negotiable — treat tests as part of the definition of done, not a follow-up task.

**Run tests only via the container** — see **Container-only npm (mandatory for agents)** above. Use `npm run docker:test`, `docker:test:e2e`, or `docker:test:all` with Compose up. **Never** use host `npm test` as the default verification path.

### Procedure for every change:

1. **Before writing code**, identify which existing tests cover the area you're about to modify. Run them **in the container** (`npm run docker:test` or narrower `docker compose exec app npx vitest run …`) to confirm they pass.
2. **While implementing**, update or add tests in lockstep with the code:
   - **New feature / new action type / new API field** → add unit tests for the logic AND E2E tests for the API surface.
   - **Changed behavior / formula / constant** → update existing tests to match the new expected values. Failing to update is as bad as not having tests.
   - **Bug fix** → write a regression test that would have caught the bug before applying the fix.
   - **Schema change** → update any E2E tests that depend on the affected model fields or API responses.
   - **Refactor (no behavior change)** → run the full suite (`npm run docker:test` with Compose up) and confirm nothing breaks.
3. **After implementing**, run `npm run docker:test` (unit) and, when you touch HTTP routes or multiplayer flows, `npm run docker:test:all` (unit + E2E against the running `app`). Confirm tests pass before considering the change complete.
4. **Never delete or skip a failing test** to make the suite green. Fix the code or fix the test — skipping masks regressions.

### Where tests live:

- **Unit tests** → `tests/unit/` — pure logic (game constants, RNG, research tree, formulas, turn-order logic). No server or DB.
- **E2E tests** → `tests/e2e/` — full API integration. Files run **sequentially** (`fileParallelism: false` in `vitest.e2e.config.ts`) to avoid DB cross-talk; each suite uses unique names/sessions. Uses helpers in `tests/e2e/helpers.ts`. Created sessions are **deleted** after use via admin API.
- If a new lib file is added under `src/lib/`, it should get a corresponding `tests/unit/<name>.test.ts`.
- If a new API route is added under `src/app/api/`, it should be exercised by at least one E2E test.

See *Tests for engine and game code* below for the full E2E file list.

## Next.js server (Docker only)

**Default workflow:** run the app with **`npm run docker:up`** or **`docker compose up --build`**. The **`Dockerfile.dev`** runs **`next build`** at image build time and the entrypoint starts **`next start`** (production server — no HMR, no Turbopack file watcher, no lazy-compilation stalls). Source is **baked into the image** (no bind mount). After code changes, **`npm run deploy`** or **`npm run docker:dev:redeploy`** rebuilds the image and recreates the app. **`DATABASE_URL`** points at the Compose MySQL service. **Do not** use `npm run dev` / `npm start` on the host for normal development.

- **`docker-compose.yml`** + **`Dockerfile.dev`**: MySQL 8.4 + Redis 7 + pre-built Next.js + **ai-worker** (polls `AiTurnJob` queue). No source bind mount — rebuild picks up code changes.
- MySQL is published on **host port 3306**. Redis on **host port 6379**. Both fail-open if unavailable.
- **`scripts/docker-entrypoint-dev.sh`**: `chown` → `setpriv node` → `prisma generate` → `db push` → `next start`.
- Optional **`.env`** is merged via `env_file` (`required: false`) for `GEMINI_*`, admin vars, etc.

**Agents:** do **not** launch `next dev`, `npm run dev`, or `npm start` on the host. Use **`docker compose exec app npx prisma …`** for `db push` and `generate` so the client matches the container. No migration files — use `prisma db push` to sync `schema.prisma` directly to the DB.

## Commands

```bash
npm run docker:up    # Docker Compose: MySQL + Next (pre-built) — primary way to run the app
npm run docker:dev:redeploy  # docker compose up --build -d — rebuild app image from repo, start stack
npm run docker:reset-node-modules  # Legacy volume cleanup + docker compose build --no-cache app + up -d
npm run deploy       # docker compose build app && up -d — apply code changes without full stack recreate
npm run docker:down  # Stop Compose stack
npm run docker:logs  # Follow app container logs
npm run docker:test  # Unit tests inside `app` (Compose must be up)
npm run docker:test:e2e   # E2E only — `TEST_BASE_URL` → app on :3000 in same container
npm run docker:test:all   # Unit + E2E in container (stack up; dev server must be healthy for E2E)
npm run docker:lint  # ESLint inside `app` (agents: do not run `npm run lint` on host)
npm run docker:typecheck  # TypeScript --noEmit inside `app`
npm run docker:build   # next build inside `app`
npm run dev          # Host-only Next dev — NOT the default; use Docker for the app
npm run build        # Host-only — NOT for agent verification; use `docker:build`
npm run lint         # Host-only — NOT for agent verification; use `docker:lint`
npm run typecheck    # Host-only — NOT for agent verification; use `docker:typecheck`

# Database (agents: prefix with `docker compose exec app`)
docker compose exec app npx prisma db push   # sync schema.prisma → DB (no migration files)
docker compose exec app npx prisma studio
docker compose exec app npx prisma generate
docker compose exec app npm run seed:system-settings   # GEMINI_* from .env into SystemSettings
docker compose exec app npm run repair:door-session -- --galaxy "Name" --dry-run
docker compose exec app npm run repair:door-session -- --galaxy "Name" --apply

# Simulation (balance testing; agents: run inside `app`)
docker compose exec app npm run sim             # npx tsx scripts/simulate.ts [options]
docker compose exec app npm run sim:quick
docker compose exec app npm run sim:full
docker compose exec app npm run sim:stress
docker compose exec app npm run sim:csv
```

### Simulation CLI options

```
--turns N         Turns per player (default: 50)
--players N       Number of players (default: 3)
--seed N          RNG seed for reproducibility (default: random)
--verbosity N     0=silent 1=summary 2=per-turn 3=verbose (default: 1)
--csv FILE        Export snapshots to CSV
--strategies S    Comma-separated: balanced,economy_rush,military_rush,turtle,random,research_rush,credit_leverage,growth_focus
--reset           DESTRUCTIVE: wipe ALL game data (sessions, players, scores) before simulation
--repeat N        Run N simulations with incrementing seeds
--session MODE    sequential | simultaneous (real `GameSession`; uses turn-order / door-game paths)
--apd N           With simultaneous: actions per calendar day (default 1)
```

## Environment

Requires a `.env` file (not committed) with:
```
# Host Node + local MySQL (or Compose MySQL on host port 3306):
DATABASE_URL="mysql://srx:srx@localhost:3306/srx"
GEMINI_API_KEY="..."          # or set in shell env; shell takes precedence
GEMINI_MODEL="gemini-2.5-flash"  # optional, defaults to gemini-2.5-flash
GEMINI_TIMEOUT_MS="60000"     # optional; max wait per AI Gemini call (ms), default 60000, clamped 1000–300000; then localFallback
GEMINI_MAX_CONCURRENT="4"     # optional; max concurrent Gemini generateContent calls (global); overridden by SystemSettings when set
DOOR_AI_MAX_CONCURRENT_MCTS="1"  # optional; max concurrent Optimal-persona MCTS runs in getAIMove; overridden by SystemSettings when set
DOOR_AI_DECIDE_BATCH_SIZE="4"  # optional; max AIs per parallel getAIMoveDecision wave (door-game); overridden by SystemSettings when set
DOOR_AI_MOVE_TIMEOUT_MS="60000" # optional; wall-clock cap per door-game AI decide; overridden by SystemSettings when set
MCTS_BUDGET_MS="45000"        # optional; MCTS search budget for optimal persona (ms, default 45000); overridden by SystemSettings.mctsBudgetMs
AI_COMPACT_PROMPT="0"          # optional; set to "1" for shorter Gemini prompts (testing); overridden by SystemSettings.compactAiPrompt
REDIS_URL="redis://localhost:6379" # optional; player/leaderboard read cache; omit to disable (fail-open)
# AI worker (scripts/ai-worker.ts — separate container in Compose; override in .env or compose env):
# AI_WORKER_POLL_MS="500"           # poll interval when queue is empty (default 500)
# AI_WORKER_CONCURRENCY="2"         # parallel job slots per worker process (default 1)
# NEXT_DISABLE_DEV_INDICATOR="true"  # optional; hides the Next.js dev route indicator (restart dev server)
# Admin UI (/admin) — optional overrides (defaults admin / srxpass)
ADMIN_USERNAME="admin"
INITIAL_ADMIN_PASSWORD="srxpass"
# ADMIN_SESSION_SECRET="..."  # optional; defaults align with INITIAL_ADMIN_PASSWORD
```

MySQL runs via Docker Compose (`docker compose up`). Standalone: `docker run -d --name srx-mysql -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=srx -e MYSQL_USER=srx -e MYSQL_PASSWORD=srx -p 3306:3306 mysql:8.4`

Prisma 7 uses `prisma.config.ts` for datasource config (NOT in schema.prisma). The `PrismaClient` requires `@prisma/adapter-mariadb`.

## Inspecting game state and logs (agents / debugging)

### API (HTTP)

- **`GET /api/game/status?id=<playerId>`** or **`?player=<name>`** — current game state, turn order, `isYourTurn`, etc.
- **`GET /api/game/session?id=<sessionId>`** — invite code, session name, visibility (creator flows).
- **`GET /api/game/log?player=<name>`** — dumps all `TurnLog` and `GameEvent` rows (not scoped to one session). Prefer Prisma queries for session-scoped history.

### Database (recommended for session-scoped history)

1. Load env: `set -a && [ -f .env ] && . ./.env && set +a` (or rely on the shell's existing `DATABASE_URL`).
2. **Prisma Studio** — `docker compose exec app npx prisma studio` (same DB and client as the app).
3. **Raw SQL** — `docker compose exec mysql mysql -u srx -psrx srx 2>/dev/null`. Column names use camelCase (e.g. `galaxyName`, `isAI`).

For session-scoped SQL query examples see `games/srx/docs/GAME-SPEC.md`.

### What the logs mean

- **`[srx-timing]`** (always on) — JSON lines to stdout for **`POST /api/game/action`** and **`POST /api/game/tick`** (route timing + lock contention). `src/lib/srx-timing.ts`
- **`[srx-ai]`** (always on) — JSON lines for **`getAIMove`** / **`runOneAI`** latency (Gemini vs fallback, configMs, generateMs, totalMs).
- **`[srx-gamelog]`** — JSON lines when a completed SRX game's logs are auto-purged from the DB. `src/lib/session-log-export.ts`
- **`[ginrummy-gamelog]`** — same pattern for Gin Rummy; emitted by `games/ginrummy/src/definition.ts` via `schedulePurge()` after game ends.
- **`TurnLog`** — one row per completed action; `details` JSON includes `params`, `actionMsg`, and either **`report`** (economy snapshot) or **`tickReportDeferred: true`**.
- **`GameEvent`** — broadcast log; `type: ai_turn` rows include `details.llmSource` (`gemini` | `fallback`).

## Engine Packages & Game Separation (DGE)

This repo uses an **npm workspace monorepo** where game-agnostic infrastructure lives in `packages/` and each game is an independent implementation.

### Package responsibilities

| Package | Import | Role |
|---------|--------|------|
| `packages/shared/` | `@dge/shared` | TypeScript types only: `GameDefinition<TState>`, `ActionResult`, `ReplayFrame`, `Move`, `Rng`, **`GameMetadata`**, **`GameHttpAdapter`**, `GameCreateOption` |
| `packages/engine/` | `@dge/engine` | Runtime: `GameOrchestrator`, registry (`registerGame`, `requireGame`), MCTS search, turn management, AI runner, cache, DB lock |
| `packages/shell/` | `@dge/shell` | React UI: `GameLayout`, `TurnIndicator`, `useGameState`, `useGameAction`, `GameUIConfig<TState>` |
| `games/srx/` | `@dge/srx` | SRX game definition: `srxGameDefinition` implements `GameDefinition<SrxWorldState>` |
| `games/chess/` | `@dge/chess` | Chess game definition: `chessGameDefinition` implements `GameDefinition<ChessState>` (MCTS-only AI, no Gemini) |
| `games/ginrummy/` | `@dge/ginrummy` | Gin Rummy game definition: `ginRummyGameDefinition` implements `GameDefinition<GinRummyState>` (MCTS + information set sampling) |

### Separation rules (must not violate)

- **Engine never imports game code** — no references to `@/lib/game-engine`, `sim-state`, `door-game-turns`, etc.
- **Shell never imports game components** — only `GameStateBase` and `GameUIConfig<TState>` are game-aware
- **Game-specific hooks injected via interfaces** — `TurnOrderHooks` / `DoorGameHooks` let the engine call game persistence without knowing SRX
- **Registration side-effects** — `src/lib/srx-registration.ts`, `chess-registration.ts`, `ginrummy-registration.ts` wire games into the engine registry; imported via `src/lib/game-bootstrap.ts`
- **`src/lib/game-bootstrap.ts`** — single module that imports all game registration files; API routes import this once
- Game HTTP adapters (`srx-http-adapter.ts`, `chess-http-adapter.ts`, `ginrummy-http-adapter.ts`) implement `GameHttpAdapter` — `buildStatus`, `getPlayerCreateData`, `onSessionCreated`, `onPlayerJoined`, `isGameOver`, `computeHubTurnState`

For complete annotated module descriptions see `ENGINE-SPEC.md` §Key lib files.

### Help system (per game)

Each game provides `games/{name}/src/help-content.ts` exporting a `HELP_REGISTRY` mapping game type key to `{ title, content }`. `GET /api/game/help?game={name}` serves this content. Update alongside `games/{name}/docs/HOWTOPLAY.md` when game mechanics change.

### Documentation locations

| Doc | Location | Covers |
|-----|----------|--------|
| Engine spec | `ENGINE-SPEC.md` | DGE infrastructure — turn modes, AI, schema, auth, admin |
| SRX game spec | `games/srx/docs/GAME-SPEC.md` | All SRX formulas, constants, actions, combat, tech |
| SRX how-to-play | `games/srx/docs/HOWTOPLAY.md` | Player-facing SRX guide |
| SRX help (in-game) | `games/srx/src/help-content.ts` | In-game reference (served via API + HelpModal) |
| Chess game spec | `games/chess/docs/GAME-SPEC.md` | Chess rules, MCTS AI, state persistence |
| Chess help (in-game) | `games/chess/src/help-content.ts` | In-game reference for chess |
| Gin Rummy game spec | `games/ginrummy/docs/GAME-SPEC.md` | Gin Rummy rules, MCTS + determinization, state schema |
| Gin Rummy help (in-game) | `games/ginrummy/src/help-content.ts` | In-game reference for Gin Rummy |
| Agent instructions | `CLAUDE.md` | This file |
| Editor agent rules | `AGENTS.md` | Container-only policy, Next.js agent notices |

### Adding a new game

Chess (`games/chess/`) and Gin Rummy (`games/ginrummy/`) are reference implementations. To add another:

1. Create `games/{name}/src/definition.ts` implementing `GameDefinition<{Name}State>`
2. Create `games/{name}/src/help-content.ts` with `HELP_REGISTRY` entry; add it to the `COMBINED_REGISTRY` in `src/app/api/game/help/route.ts`
3. Create `games/{name}/src/index.ts` barrel exporting the definition and state type
4. Create `games/{name}/package.json` as `@dge/{name}` and `games/{name}/docs/GAME-SPEC.md`
5. Implement `GameMetadata` (lobby card + create-form options) and `GameHttpAdapter` (see §A.3 of `ENGINE-SPEC.md`)
6. Add a `src/lib/{name}-registration.ts` side-effect module that calls `registerGame("{name}", { definition, metadata, adapter, hooks })`
7. Add one import to `src/lib/game-bootstrap.ts`: `import "@/lib/{name}-registration"`
8. Create `src/components/{Name}GameScreen.tsx` for the in-game UI; register it in `GAME_SCREEN_REGISTRY` and `CLIENT_GAME_REGISTRY` in `src/app/page.tsx`
9. Add path aliases to `tsconfig.json` for `@dge/{name}` and `@dge/{name}/*`
10. Add `COPY games/{name}/package.json` to `Dockerfile.dev` before the `npm ci` step
11. Add unit tests in `tests/unit/{name}-*.test.ts` and E2E tests in `tests/e2e/{name}/` subdir

### Tests for engine and game code

- **`tests/unit/registry.test.ts`** — `registerGame`, `getGame`, `requireGame`, `_clearRegistry`
- **`tests/unit/orchestrator.test.ts`** — guard conditions, `canPlayerAct`, `sessionCannotHaveActiveTurn`
- **`tests/unit/turn-order-hooks.test.ts`** — `TurnOrderHooks` interface contract
- **`tests/unit/engine-door-game.test.ts`** — game-agnostic `openFullTurn`, `closeFullTurn`, `tryRollRound`
- **`tests/unit/srx-context-bridging.test.ts`** — `FullActionOptions.context` bridging in SRX definition
- **`tests/unit/srx-game-definition.test.ts`** — SRX pure-track: `applyTick`, `applyAction`, `evalState`, `generateCandidateMoves`
- **`tests/unit/door-game-turns.test.ts`** — door-game lifecycle
- **`tests/unit/turn-order-lobby.test.ts`** — `sessionCannotHaveActiveTurn` (sequential)
- **`tests/unit/chess-rules.test.ts`** / **`chess-mcts.test.ts`** — chess rules + MCTS search
- **`tests/unit/ginrummy-melds.test.ts`** / **`ginrummy-rules.test.ts`** / **`ginrummy-mcts.test.ts`** — Gin Rummy logic

E2E tests (need MySQL + app running):

| File | Covers |
|------|--------|
| `admin.test.ts` | Admin login, galaxies CRUD, settings, password, users list / force password / delete |
| `auth-account.test.ts` | `POST /api/auth/signup`, `POST /api/auth/login`, register links `UserAccount` |
| `lobby.test.ts` | Public list, join, invite, session name collision, session patch |
| `multi-game.test.ts` | Cross-game isolation — SRX + Chess sessions for same user |
| `srx/game-flow.test.ts` | Register/login, tick/action split, inline tick, AI setup + background AI turn (poll), turn order |
| `srx/multiplayer.test.ts` | Multi-human sessions, turn order enforcement |
| `srx/api-routes.test.ts` | `log`, `leaderboard`, `highscores`, `messages`, gameover, `ai/run-all`, `ai/turn` (error path) |
| `srx/protection.test.ts` | Attacks vs protected rival blocked |
| `srx/combat-reporting.test.ts` | `message` + `actionDetails.combatResult` (pirate, guerrilla) |
| `srx/defender-alerts.test.ts` | Defender alert queue / ALERT lines |
| `srx/door-game.test.ts` | Door-game register/join, tick+action auto-close, concurrent lock (200+409), round rollover |
| `chess/chess.test.ts` | Chess game registration, status with board, legal moves, AI response (MCTS), resign, game-over 410 |
| `ginrummy/ginrummy.test.ts` | Gin Rummy registration (vs AI + vs human), status, draw/discard, AI polling, resign |

## Architecture

The platform is a multi-game engine (DGE) with Solar Realms Extreme, Chess, and Gin Rummy as game implementations. See `ENGINE-SPEC.md` for the complete engine specification and each game's `docs/GAME-SPEC.md` for game-specific mechanics.

### Data flow for a human turn (SRX / sequential mode)
1. When `isYourTurn` becomes true, UI calls `POST /api/game/tick` — `runAndPersistTick()` runs the turn tick, persists, sets `Empire.tickProcessed`, returns `turnReport`. Shows **TurnSummaryModal**.
2. Player chooses an action; UI calls `POST /api/game/action`
3. Route verifies turn via `getCurrentTurn`, then `processAction()` — skips tick if already processed, executes action only, resets `tickProcessed`
4. On success, `advanceTurn` and fire-and-forget `runAISequence` (AI turns do not block the HTTP response)
5. UI polls `GET /api/game/status?id=<playerId>` every ~2s while waiting for AI or other humans

For door-game (simultaneous) turn mechanics, turn order enforcement, and AI turn flow see `ENGINE-SPEC.md` §Turn Modes.

### UI structure

- Single-page app in `src/app/page.tsx` — thin lobby shell (login, signup, game select). Dispatches to the game's `GameScreen` component via `GAME_SCREEN_REGISTRY`.
- **`src/components/SrxGameScreen.tsx`** — full SRX in-game UI (header, panels, polling, modals).
- **`src/components/ChessGameScreen.tsx`** — full chess in-game UI (interactive board, move selection, promotion, resign, captured pieces, AI polling).
- **`src/components/GinRummyGameScreen.tsx`** — full Gin Rummy in-game UI (card table, hand rendering, draw/discard/knock/gin/layoff actions, match scoring, hand sort/drag, help modal).
- **Screens flow**: Login → Game Select → Command Center/Hub → Create Session or Join → `GameScreen`. Legacy login (no `UserAccount`) goes straight into the game.
- All API responses use `game` field (not `gameType`). DB column is `GameSession.gameType`; routes map it at the boundary.
- Styling: monochrome terminal/BBS aesthetic (black background, green-400 text, yellow-400 accents).

For authentication, lobby system, database schema, and action types see `ENGINE-SPEC.md`.

## Repository

- GitHub repo: https://github.com/benoc617/DGE
- GitHub account: `benoc617` (use this account for all repo operations)
- The `GITHUB_TOKEN` env var in `.zshrc` points to a different account (`boconnor_axoncorp`) and will override `gh` account switching if set — unset it before running `gh` commands: `unset GITHUB_TOKEN && gh ...`

## TODO / backlog

- **Treaty diplomacy in the UI** — `game-engine.ts` already implements `propose_treaty`, `accept_treaty`, and `break_treaty`. The web UI does not expose these. Implement a diplomacy surface (e.g. new tab or CFG subsection), extend `GET /api/game/status` (or a small `GET /api/game/treaties`) to return pending/active treaties, wire `onAction` calls, and add E2E coverage.

- **Prune `AiTurnJob` done/failed rows** — `done`/`failed` rows are never deleted automatically (only removed by `deleteGameSession`). A busy simultaneous-mode deployment generates ~1,500 job rows per 3-AI game that accumulate forever. Add a periodic sweep in the `ai-worker.ts` stale-recovery loop (or a maintenance API endpoint) that deletes rows with `status IN ('done','failed') AND completedAt < NOW() - INTERVAL 7 DAY`.

- **Auto-purge completed sessions after a retention window** — `GameSession` rows with `status = 'finished'/'complete'` and all their dependent rows (`Player`, `Empire`, `Planet`, `Army`, `SupplyRates`, `Research`, `Treaty`, `Loan`, `Bond`, `Convoy`, `Message`, `SessionLock`) are never cleaned up automatically — only by explicit admin deletion. Add a background job or a `/admin/maintenance` bulk-delete action that removes sessions where `finishedAt < NOW() - INTERVAL 30 DAY`, reusing `deleteGameSession`.

- **Cap or deduplicate `HighScore` rows** — one row is appended per player per completed SRX game via `createMany`, with no limit or trimming. After many games the table grows unboundedly. Options: keep only the top N all-time entries per game type, or keep only the best score per `(playerName, gameType)` pair (upsert instead of insert).
