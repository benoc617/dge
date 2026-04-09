# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Container-only npm (mandatory for agents)

**Claude Code, Cursor, and any other automation must not run project Node commands on the host** for verification, fixes, or “does it pass?” checks. The repo is meant to run **inside the Compose `app` container** (Linux image with dependencies installed in the image). Host `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest`, etc. often **fail spuriously** (e.g. missing Rolldown/Vitest native bindings, wrong platform binaries) and **do not** represent the canonical result.

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
2. **CI** jobs that use a **clean Linux** checkout and `npm ci` — not the agent’s default path.

If a command fails on the host, **do not** treat that as the project failing until the **same** command has been run **inside `app`**.

## Documentation Sync Rule

**Whenever you make a change to game mechanics, constants, UI, data model, or project structure — especially before a commit — you MUST update all affected documentation files:**

- **`README.md`** — Project overview, setup, tech stack, structure. Update if you add dependencies, change commands, add files, or change the project description.
- **`ENGINE-SPEC.md`** — Complete engine specification (turn modes, AI, schema, auth, admin, help system). Update if you change engine-level mechanics, the `GameDefinition` interface, admin pages, or auth.
- **`games/srx/docs/HOWTOPLAY.md`** — SRX player-facing game guide. Update if you change SRX game mechanics, actions, costs, strategies, or UI controls.
- **`games/srx/docs/GAME-SPEC.md`** — SRX complete technical specification. Update if you change ANY SRX formula, constant, data model field, action type, tech tree entry, combat mechanic, or turn tick step. This is the authoritative SRX spec — it must always match the code.
- **`CLAUDE.md`** — This file. Update if you change commands, architecture, key file roles, or add new conventions.
- **`AGENTS.md`** — Cursor / editor agent rules. Update if you change container-only tooling policy, Next.js agent notices, or repo-wide agent constraints.

**Before every commit, verify that all five markdown files reflect the current state of the codebase.** If a change only affects code style or non-functional refactoring, docs may not need updating — use judgment.

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
   - **Refactor (no behavior change)** → run the full suite (`npm run docker:test` with Compose up) and confirm nothing breaks. If tests need adjusting for import paths or renamed functions, do it in the same change.
3. **After implementing**, run `npm run docker:test` (unit) and, when you touch HTTP routes or multiplayer flows, `npm run docker:test:all` (unit + E2E against the running `app`). Confirm tests pass before considering the change complete. Do not move on to documentation or commit prep with failing tests.
4. **Never delete or skip a failing test** to make the suite green. Fix the code or fix the test — skipping masks regressions.

### Where tests live:

- **Unit tests** → `tests/unit/` — pure logic (game constants, RNG, research tree, formulas, turn-order logic). No server or DB.
- **E2E tests** → `tests/e2e/` — full API integration (registration, actions, turn enforcement, multiplayer, lobbies). Use helpers in `tests/e2e/helpers.ts`. After each test, `tests/e2e/setup.ts` flushes **`scheduleTestGalaxyDeletion`** then **`scheduleTestUserDeletion`** (Prisma: unlink `Player.userId`, delete `UserAccount`); shared **`beforeAll`** sessions use **`afterAll` + `deleteTestGalaxySession`**. **Unit tests** under `tests/unit/` do not create `GameSession` or `UserAccount` rows (pure logic / mocks only).
- If a new lib file is added under `src/lib/`, it should get a corresponding `tests/unit/<name>.test.ts`.
- If a new API route is added under `src/app/api/`, it should be exercised by at least one E2E test.

## Next.js server (Docker only)

**Default workflow:** run the app with **`npm run docker:up`** or **`docker compose up --build`**. The **`Dockerfile.dev`** runs **`next build`** at image build time and the entrypoint starts **`next start`** (production server — no HMR, no Turbopack file watcher, no lazy-compilation stalls). Source is **baked into the image** (no bind mount). After code changes, **`npm run deploy`** or **`npm run docker:dev:redeploy`** rebuilds the image and recreates the app. **`DATABASE_URL`** points at the Compose MySQL service. **Do not** use `npm run dev` / `npm start` on the host for normal development.

**Agents (Claude Code, Cursor, etc.):** do **not** launch `next dev`, `npm run dev`, or `npm start` on the host unless the user **explicitly** asks for a host-only run. Starting the dev server outside Docker conflicts with the intended setup and can bind port 3000 while pointing at the wrong `DATABASE_URL`.

**Agents:** use **`docker compose exec app npx prisma …`** for `db push` and `generate` so the client matches the container. Humans may use the host Prisma CLI with **`DATABASE_URL`** → **`localhost:3306`** (see README); agents should still prefer `exec` for consistency. No migration files — use `prisma db push` to sync `schema.prisma` directly to the DB.

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

### Testing

**Agents:** use only the **`docker:*`** scripts in the table under **Container-only npm** — never the host `test` / `lint` / `typecheck` / `build` scripts for verification.

```bash
npm run docker:test         # Unit tests in `app` container (requires `docker compose up`)
npm run docker:test:e2e     # E2E in `app` — hits `http://127.0.0.1:3000` (dev server in same container)
npm run docker:test:all     # Unit then E2E in container
```

**Host-only scripts** (`npm test`, `test:e2e` with start-server-and-test on :3005, etc.) exist for **CI** (Linux runner + `npm ci`) or explicit user workflows; they **must not** be the default for automation — see **Container-only npm**.

**Running tests in Docker (Compose)** — With the stack up (`docker compose up` / `npm run docker:up`), tests run **inside the `app` container** so they use the same Linux `node_modules` and DB as the dev server. The `docker:test*` npm scripts wrap `docker compose exec app …`.

1. **Schema sync** (against the Compose MySQL service):
   ```bash
   docker compose exec app npx prisma db push
   ```
2. **After `schema.prisma` changes**, either **rebuild the app image** (`npm run deploy` / `docker:dev:redeploy`) or regenerate in the running container and restart — otherwise routes may return **500** until client and DB match.
   ```bash
   docker compose exec app npx prisma generate
   docker compose restart app
   ```
   Wait for the app healthcheck (~15s) before E2E.
3. **Unit tests** (no DB required for most; fast):
   ```bash
   npm run docker:test
   # or: docker compose exec app npm test
   ```
4. **E2E tests** — Next must be reachable from inside the same container (Compose serves on port 3000):
   ```bash
   npm run docker:test:e2e
   ```
5. **Full test pass** (schema sync + generate + restart + unit + E2E):
   ```bash
   docker compose exec app npx prisma db push && \
   docker compose exec app npx prisma generate && \
   docker compose restart app && \
   sleep 15 && \
   npm run docker:test:all
   ```

- **Unit tests** (`tests/unit/`): pure logic — RNG, constants, research, combat, espionage, `empire-prisma`, critical-events, `auth` helpers, `system-settings`, `ui-tooltips`, turn-order lobby rules, `gemini` rival pick, `door-game-turns` helpers (`canPlayerAct`, round-timeout), `door-ai-runtime-settings` (clamp/defaults), `ai-concurrency` (semaphore caps), `ai-job-queue` (export presence; DB-backed behaviour covered by E2E), `srx-timing`, `door-game-ui`, etc. No database or server needed. Large orchestration (`game-engine`, `ai-runner`, `simulation`, DB-backed `player-auth`) is covered by **E2E** and **simulation** (`docker compose exec app npm run sim:*`), not duplicated as thin unit shells — add **unit** tests when you extract pure functions worth testing in isolation.
- **E2E tests** (`tests/e2e/`, needs MySQL + app running): HTTP integration. Files run **sequentially** (`fileParallelism: false` in `vitest.e2e.config.ts`) to avoid DB cross-talk; each suite uses unique names/galaxies. Uses `tests/e2e/helpers.ts` (includes `clearNewEmpireProtectionForPlayers` where tests need to strike a rival). Created sessions are **deleted** after use via admin API (`deleteTestGalaxySession` / `scheduleTestGalaxyDeletion` + `tests/e2e/setup.ts`). Signup test users use **`scheduleTestUserDeletion`** (`deleteTestUserAccountsByUsernames` after galaxies flush).

| File | Covers |
|------|--------|
| `game-flow.test.ts` | Register/login, tick/action split, inline tick, AI setup + background AI turn (poll), turn order |
| `multiplayer.test.ts` | Multi-human sessions, turn order enforcement |
| `lobby.test.ts` | Public list, join, invite, galaxy name collision, session patch |
| `admin.test.ts` | Admin login, galaxies CRUD, settings, password, **users list / force password / delete** |
| `auth-account.test.ts` | `POST /api/auth/signup`, `POST /api/auth/login`, register links `UserAccount` |
| `api-routes.test.ts` | `log`, `leaderboard`, `highscores`, `messages`, **gameover**, **`ai/run-all`**, **`ai/turn` (error path)** |
| `protection.test.ts` | Attacks vs protected rival blocked |
| `combat-reporting.test.ts` | `message` + `actionDetails.combatResult` (pirate, guerrilla) |
| `defender-alerts.test.ts` | Defender alert queue / ALERT lines |
| `door-game.test.ts` | Door-game register/join, tick+action auto-close, concurrent lock (200+409), round rollover; **human+one AI** and **human+two AIs** (status polls drive AI drain; day rolls) |

The **game-flow** AI test uses **one** AI opponent and a long timeout for Gemini when the key is set; local fallback still exercises the path.
- **Agents:** use **`npm run docker:test:e2e`** (runs `test:e2e:only` inside `app` against :3000). Do not run host **`npm run test:e2e`** (boots a second dev server on :3005) unless the user explicitly asks.
- Framework: Vitest. Unit config: `vitest.config.ts` (include `tests/unit/**` only). E2E config: `vitest.e2e.config.ts`.
- The simulation harness (`docker compose exec app npm run sim:*`) is still available for balance/regression testing.

## Docker (local development)

This is the **canonical** environment for running **Next.js** in this repo (see **Next.js dev server (Docker only)** above).

- **`docker-compose.yml`** + **`Dockerfile.dev`**: MySQL 8.4 + Redis 7 + **pre-built Next.js** (`next build` at image build time → `next start` at runtime) + **ai-worker** (polls `AiTurnJob` queue). The **app image** **`COPY`s the repo** and runs **`next build`** — **no source bind mount**, no HMR/Turbopack file watcher. Rebuild to pick up changes: **`npm run deploy`** or **`docker compose build app && docker compose up -d app`**. **`node_modules`** and **`.next`** live in the container filesystem (not host-mounted). **`scripts/docker-entrypoint-dev.sh`** runs **`npm ci`** if **`lightningcss`** is missing (rare partial install).
- MySQL is published on **host port 3306**. Inside Compose, the app uses `DATABASE_URL=mysql://srx:srx@mysql:3306/srx`.
- **Redis** is published on **host port 6379** (`REDIS_URL=redis://redis:6379` inside Compose). Used for a short-lived player and leaderboard read cache (30 s / 15 s TTL). Fail-open — if Redis is unavailable, reads fall back to MySQL and mutations silently skip invalidation.
- **ai-worker** shares the `Dockerfile.dev` image but runs `scripts/ai-worker.ts` (set via `SRX_WORKER_SCRIPT`). It polls the `AiTurnJob` MySQL table and executes AI turns for simultaneous-mode sessions so AI work survives app restarts and never blocks HTTP responses.
- **`scripts/docker-entrypoint-dev.sh`**: starts as root to **`chown -R node:node /app`** (image layers are root-owned), then **`setpriv`** to **`node`**; sets **`HOME=/home/node`** and **`npm_config_cache`** so **`npm ci`** / **`npx`** do not use **`/root/.npm`**. Then `prisma generate`, `db push`, then `next start --hostname 0.0.0.0`.
- Optional **`.env`** is merged via `env_file` (`required: false`) for `GEMINI_*`, admin vars, etc.; `DATABASE_URL` in compose overrides for the app container.

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

Use this when you need to verify what happened in a live or test DB (e.g. from Cursor with terminal + `DATABASE_URL` loaded from `.env`).

### API (HTTP)

- **`GET /api/game/status?id=<playerId>`** or **`?player=<name>`** — current empire, session, turn order, `isYourTurn`, etc. Simultaneous (door-game) mode adds `turnMode`, `dayNumber`, `actionsPerDay`, `fullTurnsLeftToday`, `turnOpen`, `canAct`, `roundEndsAt` / `turnDeadline` (round timer). After `tryRollRound`, reloads empire scalars so the client isn’t stale; calls `enqueueAiTurnsForSession` (non-blocking) when any AI still owes daily full turns so the **ai-worker** picks up the work. Requires the app running (Compose is default; host `npm run dev` only if you started it explicitly).
- **`GET /api/game/session?id=<sessionId>`** — invite code, galaxy name, visibility (creator flows).
- **`GET /api/game/log?player=<name>`** — dumps **all** `TurnLog` and **all** `GameEvent` rows in the database (not scoped to one session). Prefer Prisma queries below for “this galaxy only.”

### Database (recommended for session-scoped history)

1. Load env: `cd` to repo root and `set -a && [ -f .env ] && . ./.env && set +a` (or rely on the shell’s existing `DATABASE_URL`).
2. **Prisma Studio** — browse tables visually. **Agents:** `docker compose exec app npx prisma studio` (same DB and client as the app). Humans may use host `npx prisma studio` with `DATABASE_URL` → `localhost:3306` when Compose owns MySQL.
3. **Ad-hoc script** — `npx tsx -e ‘...’` with `PrismaClient` + `@prisma/adapter-mariadb` (same pattern as `src/lib/prisma.ts`). Example: `GameSession.findFirst({ where: { galaxyName: "..." } })`, then `TurnLog.findMany({ where: { player: { gameSessionId: sid } }, orderBy: { createdAt: "asc" } })`.
4. **Raw SQL via the mysql container** — always use `docker compose exec mysql mysql -u srx -psrx srx` (the `mysql` client is not installed in the `app` container). Suppress the password warning with `2>/dev/null`. Column names in the schema use camelCase (e.g. `galaxyName`, `isAI`, `aiPersona`, `turnsLeft`).

### Useful raw-SQL queries for live game analysis

```sql
-- All players + empire snapshot for a named galaxy
SELECT p.name, p.isAI, p.aiPersona, p.turnOrder,
       e.turnsLeft, e.turnsPlayed, e.netWorth, e.credits
FROM Player p
JOIN Empire e ON e.playerId = p.id
JOIN GameSession gs ON gs.id = p.gameSessionId
WHERE gs.galaxyName = ‘Galaxy Name’
ORDER BY p.turnOrder;

-- Per-AI action breakdown (what each AI has actually done)
SELECT p.name, tl.action, COUNT(*) as cnt
FROM TurnLog tl
JOIN Player p ON p.id = tl.playerId
JOIN GameSession gs ON gs.id = p.gameSessionId
WHERE gs.galaxyName = ‘Galaxy Name’ AND p.isAI = 1
GROUP BY p.name, tl.action
ORDER BY p.name, cnt DESC;

-- Recent AI turns with LLM source (gemini vs fallback) — newest first
SELECT p.name, tl.action,
       JSON_UNQUOTE(JSON_EXTRACT(tl.details, ‘$.llmSource’)) as llm_source,
       LEFT(JSON_UNQUOTE(JSON_EXTRACT(tl.details, ‘$.actionMsg’)), 80) as msg,
       tl.createdAt
FROM TurnLog tl
JOIN Player p ON p.id = tl.playerId
JOIN GameSession gs ON gs.id = p.gameSessionId
WHERE gs.galaxyName = ‘Galaxy Name’ AND p.isAI = 1
ORDER BY tl.createdAt DESC
LIMIT 40;

-- Check SystemSettings (Gemini key presence) and active UserAccounts
SELECT CASE WHEN geminiApiKey IS NOT NULL THEN ‘HAS_KEY’ ELSE ‘NO_KEY’ END, geminiModel
FROM SystemSettings;
SELECT username FROM UserAccount;
SELECT galaxyName, status FROM GameSession;
```

**TurnLog interpretation:** Each sequential-mode AI turn creates two TurnLog rows — the tick entry (action=`end_turn`, NULL llmSource, `tickReportDeferred: true`) and the actual AI action entry (llmSource=`gemini` or `fallback`). An AI that "always ends turn" may actually be making real decisions — check the non-NULL llmSource rows to see true action choices. The tick rows are not AI decisions.

### What the logs mean

- **`[srx-timing]`** (always on) — JSON lines to stdout for **`POST /api/game/action`** and **`POST /api/game/tick`** (route timing + lock contention). Status and leaderboard routes no longer emit timing. Use **`docker compose logs -f app`** to correlate slow actions or galaxy-busy events with DB lock phases. **`src/lib/srx-timing.ts`**
- **`[srx-ai]`** (always on) — JSON lines for **`getAIMove`** / **`runOneAI`** latency (Gemini vs fallback, configMs, generateMs, totalMs). No env flag needed.
- **`[srx-gamelog]`** — JSON lines emitted when a completed game's logs are auto-purged from the DB. One line per `TurnLog` row and one per `GameEvent` row, plus `session_log_dump_start` and `session_log_purge_complete` bookends. **`src/lib/session-log-export.ts`**.
- **`TurnLog`** — one row per completed action; `details` JSON includes `params`, `actionMsg`, and either **`report`** (economy snapshot) or **`tickReportDeferred: true`** when the tick already ran earlier in the turn (`POST /api/game/tick` or AI `runAndPersistTick`). Rows with `tickReportDeferred` are **not** missing economy data — the real numbers were applied when the tick ran; omitting the duplicate avoids storing an all-zero stub.
- **`GameEvent`** — `gameSessionId` is set for new events from in-game actions and AI turns (per-session). `type: ai_turn` rows include `details.llmSource` (`gemini` | `fallback`); the `message` field is prefixed `[gemini]` or `[fallback]` for quick scanning. Legacy rows may have null `gameSessionId`.

### Known pitfalls (investigated)

- **AI “self-attack”** — Gemini (or bad JSON) could emit `target` equal to the acting commander’s name. **`processAction` now rejects** targeting your own `playerId` for attacks, covert ops, and treaty proposals. The Gemini prompt also forbids self-targets.
- **TurnLog `report.income` all zeros** — seen when actions ran **after** the tick was already persisted; previously the full `details` stored a zeroed stub `report`. Now **`tickReportDeferred: true`** is stored instead of that stub when applicable.

## Engine Packages & Game Separation (DGE)

This repo uses an **npm workspace monorepo** where game-agnostic infrastructure lives in `packages/` and SRX is one game implementation.

### Package responsibilities

| Package | Import | Role |
|---------|--------|------|
| `packages/shared/` | `@dge/shared` | TypeScript types only: `GameDefinition<TState>`, `ActionResult`, `ReplayFrame`, `Move`, `Rng`, **`GameMetadata`**, **`GameHttpAdapter`**, `GameCreateOption` |
| `packages/engine/` | `@dge/engine` | Runtime: `GameOrchestrator`, registry (`registerGame`, `requireGame`), MCTS search, turn management, AI runner, cache, DB lock |
| `packages/shell/` | `@dge/shell` | React UI: `GameLayout`, `TurnIndicator`, `useGameState`, `useGameAction`, `GameUIConfig<TState>` |
| `games/srx/` | `@dge/srx` | SRX game definition: `srxGameDefinition` implements `GameDefinition<SrxWorldState>` |

### Separation rules (must not violate)

- **Engine never imports game code** — no references to `@/lib/game-engine`, `sim-state`, `door-game-turns`, etc.
- **Shell never imports game components** — only `GameStateBase` and `GameUIConfig<TState>` are game-aware
- **Game-specific hooks injected via interfaces** — `TurnOrderHooks` / `DoorGameHooks` let the engine call game persistence without knowing SRX
- **Registration side-effect** — `src/lib/srx-registration.ts` wires SRX into the engine registry (definition + `GameMetadata` + `GameHttpAdapter` + hooks); imported via `src/lib/game-bootstrap.ts`
- **`src/lib/game-bootstrap.ts`** — single module that imports all game registration files; API routes import this once instead of individual game registration modules
- **`src/lib/srx-http-adapter.ts`** — implements `GameHttpAdapter` for SRX; extracts game-specific payload construction from API routes (`buildStatus`, `buildLeaderboard`, `buildGameOver`, `getPlayerCreateData`, `onSessionCreated`, `computeHubTurnState`)

### Help system (per game)

Each game provides a help file at `games/{name}/src/help-content.ts` that exports:
- `{NAME}_HELP_TITLE` — string
- `{NAME}_HELP_CONTENT` — markdown string
- `HELP_REGISTRY` — `Record<string, { title: string; content: string }>` mapping game type key to content

`GET /api/game/help?game={name}` serves this content. The `?` button in the game header fetches it and shows `<HelpModal>`. Content is cached after first fetch per browser session.

When updating game mechanics, update the help file alongside `games/{name}/docs/HOWTOPLAY.md`.

### Documentation locations

| Doc | Location | Covers |
|-----|----------|--------|
| Engine spec | `ENGINE-SPEC.md` | DGE infrastructure — turn modes, AI, schema, auth, admin |
| SRX game spec | `games/srx/docs/GAME-SPEC.md` | All SRX formulas, constants, actions, combat, tech |
| SRX how-to-play | `games/srx/docs/HOWTOPLAY.md` | Player-facing SRX guide |
| SRX help (in-game) | `games/srx/src/help-content.ts` | In-game reference (served via API + HelpModal) |
| Agent instructions | `CLAUDE.md` | This file |
| Editor agent rules | `AGENTS.md` | Container-only policy, Next.js agent notices |

### Adding a second game

1. Create `games/{name}/src/definition.ts` implementing `GameDefinition<{Name}State>`
2. Create `games/{name}/src/help-content.ts` with `HELP_REGISTRY` entry; add it to the `COMBINED_REGISTRY` in `src/app/api/game/help/route.ts`
3. Create `games/{name}/src/index.ts` barrel exporting the definition and state type
4. Create `games/{name}/package.json` as `@dge/{name}` and `games/{name}/docs/GAME-SPEC.md`
5. Implement `GameMetadata` (lobby card + create-form options) and `GameHttpAdapter` (API payload hooks — `buildStatus`, `getPlayerCreateData`, `defaultTotalTurns`, etc.)
6. Add a `src/lib/{name}-registration.ts` side-effect module that calls `registerGame("{name}", { definition, metadata, adapter, hooks })`
7. Add one import to `src/lib/game-bootstrap.ts`: `import "@/lib/{name}-registration"` — all routes that import `game-bootstrap` will pick up the new game automatically
8. Create `src/components/{Name}GameScreen.tsx` for the in-game UI; register it in `GAME_SCREEN_REGISTRY` and `CLIENT_GAME_REGISTRY` in `src/app/page.tsx`
9. Add unit tests in `tests/unit/{name}-*.test.ts` and E2E tests in `tests/e2e/{name}-*.test.ts`

### Tests for engine and game code

- **`tests/unit/registry.test.ts`** — covers `registerGame`, `getGame`, `requireGame`, `_clearRegistry`
- **`tests/unit/orchestrator.test.ts`** — covers guard conditions, `canPlayerAct`, `sessionCannotHaveActiveTurn`
- **`tests/unit/srx-game-definition.test.ts`** — covers SRX pure-track: `applyTick`, `applyAction`, `evalState`, `generateCandidateMoves`
- **`tests/unit/door-game-turns.test.ts`** — covers door-game lifecycle (openFullTurn, closeFullTurn, tryRollRound)
- **`tests/unit/turn-order-lobby.test.ts`** — covers `sessionCannotHaveActiveTurn` (sequential)
- **`tests/e2e/`** — full-track sequential + door-game integration (game-flow, multiplayer, door-game, auth, admin)

Shell React components (`GameLayout`, `TurnIndicator`) are integration-tested via the SRX E2E suite; dedicated unit tests would require a jsdom environment (not currently configured).

## Architecture

Solar Realms Extreme is a turn-based galactic empire management game (BBS-era Solar Realms Elite remake with modern improvements). See `games/srx/docs/GAME-SPEC.md` for the complete SRX technical specification and `ENGINE-SPEC.md` for the engine specification.

### Data flow for a human turn
1. When `isYourTurn` becomes true, UI calls `POST /api/game/tick` — `runAndPersistTick()` runs the turn tick, persists, sets `Empire.tickProcessed`, returns `turnReport`. Shows **TurnSummaryModal** (situation report) with critical-event highlighting (`src/lib/critical-events.ts`).
2. Player chooses an action; UI calls `POST /api/game/action`
3. Route (`src/app/api/game/action/route.ts`) verifies turn via `getCurrentTurn`, then `processAction()` — skips tick if already processed, executes action only, resets `tickProcessed`
4. On success, `advanceTurn` and fire-and-forget `runAISequence` (AI turns do not block the HTTP response)
5. UI polls `GET /api/game/status?id=<playerId>` every ~2s while waiting for AI or other humans

### Door-game / simultaneous turns (`GameSession.turnMode === simultaneous`)
1. **Create:** `POST /api/game/register` may include `turnMode: "simultaneous"` (default `sequential`). Session tracks `dayNumber`, `actionsPerDay`, `roundStartedAt`; empires track `turnOpen`, `fullTurnsUsedThisRound`.
2. **Open round:** humans and AIs can all take daily full turns; **no** API block while AIs owe slots. `GET /api/game/status` (and the action route after `closeFullTurn`) call **`enqueueAiTurnsForSession`** to insert pending `AiTurnJob` rows. The standalone **ai-worker** container claims jobs via `SELECT … FOR UPDATE SKIP LOCKED` and runs `runOneDoorGameAI`. After each job completes it cascades — re-enqueueing any AI that still owes daily slots. This replaces the former in-process `runDoorGameAITurns` background path for simultaneous mode. Each AI move races a `DOOR_AI_MOVE_TIMEOUT_MS` wall-clock cap.
3. **Per full turn:** `POST /api/game/tick` opens a turn (`openFullTurn` → `runAndPersistTick` with `decrementTurnsLeft: false`, `turnOpen: true`). Each successful mutating `POST /api/game/action` (not `end_turn`) triggers `doorGameAutoCloseFullTurnAfterAction` + `closeFullTurn` so one action closes the slot; explicit `end_turn` / **Skip** is for skipping without acting. **`closeFullTurn`** decrements that empire’s **`turnsLeft`** by 1 (one game turn per miniturn). **Round timer** forfeit: **`tryRollRound`** charges **`turnsLeft`** for each skipped daily slot (same as closed full turns). `tryRollRound` advances the calendar day when every empire has used all daily full turns, **or** after **`roundStartedAt + turnTimeoutSecs`** skips remaining slots (`round_timeout` event). `GET /api/game/status` calls `tryRollRound` so polling can complete a round.
4. **All actions** use `POST /api/game/action` (with per-session advisory try-lock; **409** `galaxyBusy` on contention). After `closeFullTurn` or `end_turn`, the route calls `enqueueAiTurnsForSession` (fire-and-forget) to insert `AiTurnJob` rows for any AI still owed daily slots — the external **ai-worker** container picks these up. Core orchestration: `src/lib/door-game-turns.ts` (`openFullTurn`, `closeFullTurn`, `tryRollRound`, `enqueueAiTurnsForSession` re-export, `withCommitLock`). `src/lib/db-context.ts` (`getDb`, AsyncLocalStorage + transaction client for lock + engine; `withCommitLock` uses **60s** interactive transaction timeout).

### Turn order enforcement
- `Player.turnOrder` (Int) assigns each player a fixed position in the session (0 = creator, 1+ = subsequent players/AIs in join order).
- `GameSession.currentTurnPlayerId` stores the ID of the player whose turn it is. This is immune to player list changes (joins, eliminations) — no index drift.
- Only the player matching `currentTurnPlayerId` can act. `POST /api/game/action` returns 409 for anyone else.
- After a successful action, `currentTurnPlayerId` advances to the next active player by `turnOrder`. If the next player(s) are AI, `runAISequence` runs in the background; the client observes progress via polling.
- New players joining mid-game get the next `turnOrder` value and slot into the rotation at the end. Their first turn comes after all existing players finish the current cycle.
- If `currentTurnPlayerId` is null or points to an eliminated player, it auto-resolves to the first active player by `turnOrder`.
- `GET /api/game/status` returns `isYourTurn` (boolean), `currentTurnPlayer` (name), `turnDeadline` (ISO string), and `turnOrder` (ordered list of player names + isAI).
- If the current turn belongs to another human player, the UI polls about every 2 seconds until it becomes this player's turn.
- **Turn timer**: `GameSession.turnStartedAt` resets each time the turn advances. `turnTimeoutSecs` is configurable (default 86400 = 24h). `getCurrentTurn()` auto-skips timed-out human players (`runAndPersistTick` if needed, then `end_turn`). The UI header shows a live countdown (`TurnTimer` component); it turns red under 1 hour.
- Core logic lives in `src/lib/turn-order.ts` (`getCurrentTurn`, `advanceTurn`) and `src/lib/ai-runner.ts` (`runAISequence`).

### AI NPC turn flow
1. Player selects AI opponents during game setup (name selection screen after registration)
2. `POST /api/ai/setup` creates AI players — accepts optional `names` array to create specific opponents
3. After a human acts, `runAISequence` runs in the background; each AI calls `runAndPersistTick` then `processAiMoveOrSkip()` (`processAction` for the chosen move; on failure, `end_turn` so the slot still logs and advances like a human skip)
4. `POST /api/ai/run-all` can also be called directly to advance AI turns.

### Key lib files
- `src/lib/game-engine.ts` — core game loop. `runAndPersistTick(playerId)` persists the turn tick; `processAction(playerId, action, params)` runs tick (if not yet processed) + action; **`runEndgameSettlementTick(playerId)`** runs one full economy tick from the post–final-action state when `turnsLeft` hits 0 (sequential: end of `processAction`; simultaneous: from `closeFullTurn`). 35 action types supported. Player-targeting attacks (not pirates) and **covert_op** are rejected when the target still has **new-empire protection**.
- `src/lib/empire-prisma.ts` — `toEmpireUpdateData()` maps `Partial<Empire>` to `Prisma.EmpireUpdateInput` so scalar list fields (e.g. `pendingDefenderAlerts`) use `{ set: [...] }` instead of invalid raw `[]` in `prisma.empire.update`.
- `src/lib/critical-events.ts` — regex classification for critical vs warning vs info lines in the turn summary modal.
- `src/lib/game-constants.ts` — **all** balance values, planet config, costs, formulas, starting state, finance constants. The single source of truth for game numbers — UI labels reference these directly.
- `src/lib/ui-tooltips.ts` — Tooltip copy for Galactic Powers, Empire Status (resources + military unit stats), and Command Center tabs / military purchases.
- `src/components/Tooltip.tsx` — Hover/focus tooltips rendered via **`createPortal`** + `position: fixed` (reliable vs native `title`, which is delayed and often broken in embedded browsers; avoids clipping under `overflow-y-auto`).
- `src/lib/combat.ts` — 3-front sequential combat, guerrilla, nuclear, chemical, psionic, pirate raids (scaling rewards). Unit tier multiplier tables. Nuclear/chemical results include **`planetCasualties`** for per-planet population killed.
- `src/lib/combat-loss-format.ts` — `formatUnitLosses` / `formatUnitLossesOrNone` for consistent loss lines in `processAction` messages, `GameEvent` text, defender alerts, and UI-adjacent payloads.
- `src/lib/espionage.ts` — 10 covert operation types with probabilistic success/detection.
- `src/lib/research.ts` — tech tree with 5 categories (22 techs), permanent/temporary bonuses, unit tier upgrades. Random event definitions.
- `src/lib/empire-protection.ts` — `targetHasNewEmpireProtection()` (shared by `game-engine` validation and AI target lists). Re-exported from `game-engine` for callers that already import there.
- `src/lib/gemini.ts` — Gemini prompt construction with 7 AI persona types (economist, warlord, spymaster, diplomat, turtle, **optimal**, **researcher**); **`AIMoveContext`** includes **`rivalAttackTargets`** (rivals not under new-empire protection) so prompts, **`sanitizeAIMove`**, and **`localFallback`** only pick **`pickRivalOpponent`** from attackable empires for `attack_*` / `covert_op` (treaties still use full `rivalNames`). **`resolveGeminiConfig()`** reads **`SystemSettings`** first, then `GEMINI_API_KEY` / `GEMINI_MODEL` env. Each `generateContent` uses **`GEMINI_TIMEOUT_MS`** (default 60s, clamped 1s–5m) via the SDK request `timeout` so hung API calls do not block `advanceTurn`. **`localFallback`** runs when no API key, timeout, invalid JSON, or invalid action — it includes **attacks, covert ops, and pirates**. The **`"optimal"` persona** bypasses all heuristics and runs **MCTS** (`sim-state` + `search-opponent`) with a 300ms budget. `getAIMove` returns `llmSource: 'gemini' | 'fallback'` (stored in `TurnLog` / `GameEvent`). Set **`SRX_LOG_AI_TIMING=1`** to emit JSON lines **`[srx-ai] {"event":"getAIMove",...}`** (configMs, generateMs, totalMs, source) and **`[srx-ai] {"event":"runOneAI",...}`** (contextMs, getAIMoveMs, executeMs) for latency analysis from Docker/stdout.
- `src/lib/rng.ts` — seedable PRNG (mulberry32). All randomness goes through this. `setSeed(n)` for deterministic runs, `setSeed(null)` for production randomness.
- `src/lib/simulation.ts` — orphan-player simulation (no `GameSession`). Nine preset strategies (`DEFAULT_SIM_STRATEGIES` including `mcts`), `strategyContextFromEmpire` (takes `loans: { id, balance }[]` so `bank_repay` works correctly for heuristic strategies), `finalizeSimSummaries`, `pickSimAction` (overloaded: accepts optional `PrismaEmpireShape` + `rivalShapes` for search strategies), balance warnings, CSV export.
- `src/lib/simulation-harness.ts` — `runSessionSimulation`: full games in **sequential** (`getCurrentTurn` / `advanceTurn`) or **simultaneous** (door-game: `openFullTurn`, `processAction` with `doorActionOpts`, `closeFullTurn`, `tryRollRound` with `scheduleAiDrain: false` to avoid async Gemini AI fighting the sim). Deletes the temp session after summaries. Passes full empire shapes to `pickSimAction` for mcts/maxn strategies.
- `src/lib/sim-state.ts` — pure in-memory game state for search algorithms. `PureEmpireState`, `applyTick`, `applyAction`, `generateCandidateMoves`, `evalState` (includes research-potential and supply-pipeline deferred-value terms), `makeRng` (local mulberry32 seeded RNG), `cloneEmpire`, `empireFromPrisma`, `inferRolloutStrategy` (detects research/supply/military/etc. from planet composition), `pickRolloutMove` (strategy-aligned move selection for MCTS rollouts). No async, no DB, no global RNG mutation.
- `src/lib/search-opponent.ts` — N-player MCTS (UCB1 + strategy-aligned rollout via `pickRolloutMove` + backprop) and shallow MaxN search. Configurable via `MCTSConfig` / `MaxNConfig`. Entry points: `mctsSearch`, `maxNMove`, `searchOpponentMove`, `buildSearchStates`.
- `src/lib/door-game-ui.ts` — simultaneous mode: `simultaneousDoorCommandCenterDisabled` aligns Command Center `disabled` with the header (`canAct === false` vs undefined — avoids “TURN OPEN” with all actions grayed during a stale/partial status refresh).
- `src/lib/door-game-turns.ts` — door-game mode: `openFullTurn`, `closeFullTurn`, `tryRollRound` (optional `scheduleAiDrain`; when true, calls `enqueueAiTurnsForSession` after `day_complete` to insert job-queue rows for the external ai-worker), `runOneDoorGameAI` (called by **ai-worker** to execute a single AI full turn), `canPlayerAct`; re-exports `enqueueAiTurnsForSession`, `withCommitLock` / `GalaxyBusyError` from `db-context`. Internal `drainDoorGameAiTurns` / `runDoorGameAITurns` are retained for simulation harness use (`scheduleAiDrain: false`). AI move decisions use batched parallel **`getAIMoveDecision`** + serial **`applyDoorGameAIMove`**; batch size / timeouts from **`resolveDoorAiRuntimeSettings()`** (`SystemSettings` + env). Ordering by **fewest `fullTurnsUsedThisRound`**, then `turnOrder`. **`src/lib/door-ai-runtime-settings.ts`** — effective door/Gemini concurrency caps; **`resolveDoorAiRuntimeSettings()`** uses a **~60s in-process cache** (invalidated on admin **`/api/admin/settings`** PATCH) so AI moves are not one Prisma query each. **`src/lib/ai-concurrency.ts`** — dynamic semaphores for Gemini / MCTS (`setAiConcurrencyCaps` from resolver; used by `gemini.ts` `getAIMove`).
- `src/lib/redis.ts` — ioredis client (`getRedis()`); thin helpers `rGet`, `rSetEx`, `rDel`. Fail-open: if `REDIS_URL` is unset or Redis is unavailable, operations silently no-op. Used only for read-cache; MySQL is always authoritative.
- `src/lib/game-state-service.ts` — cache-aside helpers: `getCachedPlayer(id)` (30 s TTL), `getCachedLeaderboard(sessionId)` (15 s TTL), `invalidatePlayer(id)`, `invalidateLeaderboard(sessionId)`, `invalidatePlayerAndLeaderboard`. Mutations (tick, action, ai-worker) call `invalidatePlayer` after DB commit so status polls don't serve stale `turnOpen` / `fullTurnsUsedThisRound`.
- `src/lib/ai-job-queue.ts` — `AiTurnJob` CRUD: `enqueueAiTurnsForSession` (dedup: skips players with a pending/claimed job), `claimNextJob` (SKIP LOCKED), `completeJob`, `failJob`, `recoverStaleJobs` (resets claimed jobs older than threshold back to pending for crashed-worker recovery).
- `src/lib/db-context.ts` — `getDb()` for Prisma client or interactive transaction; `withCommitLock(sessionId, fn)` uses `INSERT IGNORE SessionLock` + `SELECT … FOR UPDATE NOWAIT` (MySQL advisory lock).
- `src/lib/turn-order.ts` — strict sequential turn system. `sessionCannotHaveActiveTurn()` encodes lobby / missing timer; `getCurrentTurn(sessionId)` returns **null** when `waitingForHuman` is true or `turnStartedAt` is null (admin lobby); otherwise resolves the current player (with timeout auto-skip). `advanceTurn(sessionId)` no-ops in lobby.
- `src/lib/admin-auth.ts` — async `verifyAdminLogin` / `verifyAdminPassword` (DB `AdminSettings` or env password), `requireAdmin` — **valid signed httpOnly cookie** (`srx_admin_session`, see `admin-session.ts`) **or** **`Authorization: Basic`** (E2E, curl). Browser UI: `src/lib/admin-client-storage.ts` stores optional **username pref** only in `sessionStorage` (no password); **Log out** clears cookie + storage.
- `src/lib/player-init.ts` — `createStarterPlanets()` and `createStarterEmpire()` — shared starter data for register, join, and AI player creation.
- `src/lib/create-ai-players.ts` — `createAIPlayersForSession` (named-list, random persona each time) and `createRandomAIPlayersForSession` (count-based, random name + random persona). AI names come from `AI_NAME_POOL` (10 names); strategies from `AI_STRATEGY_POOL` (7 personas: optimal, turtle, economist, researcher, warlord, diplomat, spymaster). Names and strategies are **never fixed pairs** — each creation randomizes independently so players never know an AI's strategy.
- `src/lib/ai-process-move.ts` — `processAiMoveOrSkip`: runs `processAction` for the AI’s chosen action; if `success: false`, runs `end_turn` with `skippedAfterInvalid` in `logMeta` (parity with human failed attempt + skip).
- `src/lib/ai-runner.ts` — `runAISequence(sessionId)` walks through consecutive AI turns in order, stopping when a human is reached (sequential mode). `getAIMoveDecision(playerId)` returns just the AI's chosen action without executing it — used by the door-game AI drain to batch decision calls before serially applying them.
- `src/lib/prisma.ts` — Prisma 7 client with `@prisma/adapter-mariadb` (`DATABASE_URL` from env only).
- `src/lib/system-settings.ts` — masked Gemini key preview for admin settings API (never return raw secrets).
- `scripts/ai-worker.ts` — standalone long-running process (separate Compose service). Polls `AiTurnJob` via `claimNextJob` (SKIP LOCKED), calls `runOneDoorGameAI`, then cascades with `enqueueAiTurnsForSession`. Supports `AI_WORKER_CONCURRENCY` parallel slots. Recovers stale (crashed-worker) jobs every 30 s. Env: `DATABASE_URL`, `REDIS_URL`, `GEMINI_API_KEY`, `AI_WORKER_POLL_MS`, `AI_WORKER_CONCURRENCY`, `SRX_LOG_AI_TIMING`.
- `scripts/simulate.ts` — CLI runner for the simulation engine. **`--reset` wipes ALL game data** (sessions, players, scores) — not just simulation artifacts. `--repeat N` only cleans simulation-specific players (`Sim_*`) between runs.

### Authentication & Lobby System
- **`UserAccount`** (`username` unique lowercase, `fullName`, `email` unique, bcrypt password, optional **`lastLoginAt`**): created via `POST /api/auth/signup` (min **8** char password). `POST /api/auth/login` returns `{ user, games }` for the Command Center hub and sets **`lastLoginAt`**; resume via `POST /api/game/status` also updates it when the player is linked.
- **`POST /api/game/register`** and **`POST /api/game/join`** use `src/lib/player-auth.ts` (`resolvePlayerCredentials`): if a `UserAccount` exists for the normalized username, the password must match the account (min length for legacy-only players without an account remains **3**). New `Player` rows store `userId` when linked.
- Resume: UI tries **`POST /api/auth/login`** first; **404** falls back to **`POST /api/game/status`** with `{ name, password }` (legacy commanders without a `UserAccount`). Verifies bcrypt on `Player.passwordHash`. Legacy players without a hash are allowed through.
- Finished games (`turnsLeft <= 0`) return HTTP 410 on resume attempt — they are not resumable.
- AI players have no password and cannot be resumed.
- Once in-game, the UI uses `GET /api/game/status?id=<playerId>` (preferred) or `?player=name` for refreshes.
- **Galaxy creation**: `POST /api/game/register` accepts optional `galaxyName`, `isPublic`, `turnTimeoutSecs`, **`maxPlayers`** (2–128, default 50). An 8-char invite code is auto-generated for every session.
- **Join existing**: `POST /api/game/join` accepts `inviteCode` or `sessionId` (for public games). Creates a new player in the existing session.
- **Public lobbies**: `GET /api/game/lobbies` returns active public games. `PATCH /api/game/session` toggles `isPublic` (creator-only); **`maxPlayers`** patch allowed **2–128**.
- **Session info**: `GET /api/game/session?id=` returns session details including invite code.
- **UI flow**: Login → **Command Center** (active games + Create / Join / Log out) **or** legacy login straight into game; **Create Galaxy** one screen (max players, name, visibility, timer, optional AI toggles; session password from login) → Play; Join → Play.
- **Admin** (`/admin` + **`/admin/users`** + **`/admin/game-sessions`** + **`/admin/maintenance`**, link on login): `POST /api/admin/login` (sets **signed httpOnly session cookie**; `ADMIN_SESSION_SECRET` min 32 chars in production) | `POST /api/admin/logout` | `GET /api/admin/me` | `POST /api/admin/password` (change password → `AdminSettings` bcrypt + new cookie) | `GET/PATCH /api/admin/settings` (Gemini + door-game AI limits in `SystemSettings` including `mctsBudgetMs`/`compactAiPrompt`; `DATABASE_URL` env-only) | `GET/POST/DELETE /api/admin/galaxies` (DELETE body `{ ids }` removes sessions via `src/lib/delete-game-session.ts`) | **`GET/PATCH/DELETE /api/admin/users`** (list accounts + stats, force user password syncs `UserAccount` + linked `Player` hashes, delete account clears `Player.userId`) | **`GET/DELETE /api/admin/logs`** (GET: session log row counts; DELETE body `{ sessionId, force? }`: dump+purge TurnLog+GameEvent for that session; requires `force:true` for active sessions) | **`POST /api/admin/migrate`** (runs `prisma db push --accept-data-loss` inside the app process for hot schema patches) — **cookie or Basic** (`admin-auth.ts`). Username only from `ADMIN_USERNAME`; password from DB row or `INITIAL_ADMIN_PASSWORD` env. Pre-staged galaxies use `waitingForHuman` until first human `POST /api/game/join`.

### Database schema highlights (`prisma/schema.prisma`)
- `UserAccount` — optional global login (`username`, `fullName`, `email`, `passwordHash`, `lastLoginAt`); `Player.userId` links when the commander is registered
- `Player` → `Empire` is 1:1; `Player.passwordHash` stores bcrypt hash (nullable for AI/legacy); `Player.gameSessionId` links to a `GameSession`
- `Empire` → `Planet[]` is 1:many (individual planet rows with name, sector, type, production, radiation); `Empire.tickProcessed` tracks whether the current turn's tick has been persisted (split tick vs action); door-game fields `turnOpen`, `fullTurnsUsedThisRound`
- `Empire` → `Army` is 1:1 (9 unit types, 5 tier levels, effectiveness, covert points)
- `Empire` → `SupplyRates` is 1:1 (supply planet production allocation)
- `Empire` → `Research` is 1:1 (accumulated points, unlocked tech IDs)
- `Market` is a global singleton (supply/demand, coordinator pool, lottery pool)
- `Treaty` tracks inter-empire agreements (6 types, binding duration)
- `Coalition` groups up to 5 empires
- `Loan` / `Bond` for Solar Bank
- `Convoy` / `Message` for multiplayer features
- `TurnLog` records every action; `GameEvent` is broadcast log
- `HighScore` persists final scores across games
- `AiTurnJob` — door-game AI turn job queue. One row per pending AI turn (fields: `sessionId`, `playerId`, `status` pending/claimed/done/failed, `workerId`, `result` JSON, timestamps). Claimed via `SELECT … FOR UPDATE SKIP LOCKED` so multiple workers never double-claim. Rows are deleted by `deleteGameSession` along with the session.
- `SessionLock` — per-session advisory lock support row. One row per active session; used by `withCommitLock` (`INSERT IGNORE` + `SELECT … FOR UPDATE NOWAIT`). Deleted by `deleteGameSession`.
- `AdminSettings` singleton (`id = "admin"`) stores bcrypt admin password when set from `/admin`; if absent, `INITIAL_ADMIN_PASSWORD` env is used
- `SystemSettings` singleton (`id = "default"`) stores optional `geminiApiKey`, `geminiModel`, and door-game AI fields (`doorAiDecideBatchSize`, `geminiMaxConcurrent`, `doorAiMaxConcurrentMcts`, `doorAiMoveTimeoutMs`, `mctsBudgetMs` nullable, `compactAiPrompt` boolean); `DATABASE_URL` stays in the environment only. `mctsBudgetMs` controls MCTS search budget for optimal persona (null → uses `MCTS_BUDGET_MS` env or 45000ms default); `compactAiPrompt` enables short Gemini prompts for testing.
- `GameSession` tracks game sessions with `galaxyName` (unique), `createdBy`, `isPublic`, `inviteCode` (unique, auto-generated 8-char hex), `maxPlayers` (default **50**, max **128**), `currentTurnPlayerId` (whose turn it is, by player ID; null in admin lobby until first human), `turnStartedAt` (**nullable** — null in lobby, no timer), **`waitingForHuman`** (pre-staged admin galaxies until first human joins), `turnTimeoutSecs` (default 86400), **`turnMode`**, **`dayNumber`**, **`actionsPerDay`**, **`roundStartedAt`** (door-game round timer anchor), player list, status, and outcome. Players are linked via `Player.gameSessionId` and ordered by `Player.turnOrder`.

### Action types (all handled in game-engine.ts)
- Economy: `buy_planet`, `set_tax_rate`, `set_sell_rates`, `set_supply_rates`
- Military: `buy_soldiers`, `buy_generals`, `buy_fighters`, `buy_stations`, `buy_light_cruisers`, `buy_heavy_cruisers`, `buy_carriers`, `buy_covert_agents`, `buy_command_ship`
- Combat: `attack_conventional`, `attack_guerrilla`, `attack_nuclear`, `attack_chemical`, `attack_psionic`, `attack_pirates`
- Covert: `covert_op` (with opType 0-9)
- Diplomacy: `propose_treaty`, `accept_treaty`, `break_treaty`, `create_coalition`, `join_coalition`, `leave_coalition`
- Market: `market_buy`, `market_sell`
- Finance: `bank_loan`, `bank_repay`, `buy_bond`, `buy_lottery_ticket`
- Research: `discover_tech`
- Social: `send_message`
- Other: `end_turn`

## Repository

- GitHub repo: https://github.com/benoc617/solar-realms-extreme
- GitHub account: `benoc617` (use this account for all repo operations)
- The `GITHUB_TOKEN` env var in `.zshrc` points to a different account (`boconnor_axoncorp`) and will override `gh` account switching if set — unset it before running `gh` commands: `unset GITHUB_TOKEN && gh ...`

## UI structure
- Single-page app in `src/app/page.tsx` — a **thin lobby shell** that handles login, signup, and game selection. Once a session is active it dispatches to the selected game's `GameScreen` component (registered in `GAME_SCREEN_REGISTRY`).
- **`src/app/page.tsx` roles**: lobby only — authentication (`login`, `game-select`, `hub`, `join-game`, `create-galaxy` phases), reading `CLIENT_GAME_REGISTRY` (client-side mirror of `GameMetadata`) to render game cards and create-game forms dynamically, and dispatching to the correct `GameScreen`.
- **`src/components/SrxGameScreen.tsx`** — owns the full SRX in-game UI (header, panels, polling, modals). Receives initial session props from `page.tsx` and manages all game state internally.
- **Screens flow**: Login (**Login** / **Sign up**) → Sign up form → Login → **Game Select** (cards from `CLIENT_GAME_REGISTRY`) → **Command Center / Hub** (your active games for the selected game + Create / Join / Log out) → **Create Galaxy** (dynamic options from `createOptions`) → `GameScreen`; OR Hub → Join → `GameScreen`. Legacy login (no `UserAccount`) goes straight into the game when a matching active player exists.
- **`game` field** — all API responses use `game` (not `gameType`). The DB column remains `GameSession.gameType`; routes map it at the boundary.
- **Login screen** (username + password) → **Login** or **Sign up**; link to **`/admin`**
- Top: `Leaderboard` — Galactic Powers panel with column headers (Rk, Commander, **Prt** on sm+, Worth, Pop, Plt, Turns, Mil). **Turns** = `turnsPlayed` (economy ticks). **Prt** shows `[PN]` when that rival has new-empire protection. Click a rival to auto-select them as target in the WAR/OPS dropdowns.
- Left (3 cols): `EmpirePanel` — **compact stat-box grid layout** with Net Worth + Civil Status boxes at top, resource grid (4-col), population/tax row, sell rates inline, military mini-stat grid, planet badges, and collapsible planet details.
- Center (5 cols): `ActionPanel` — **Skip Turn** button at top (runs tick+end in door-game when needed), disabled rules differ for sequential vs simultaneous; then 7 tabbed sections (ECON, MIL, WAR, OPS, MKT, RES, CFG). ECON tab shows planet cards with descriptions + cost + owned count. MIL tab includes `buy_light_cruisers` (950 cr). Target fields use `<select>` dropdowns. CFG tab includes **GAME SESSION** (galaxy name, invite code click-to-copy, visibility toggle for creator) and **TURN ORDER** (numbered list of all players, current player highlighted, `[AI]` tags).
- Right (4 cols): `EventLog` — color-coded turn reports with income/expense/population breakdowns, event highlights.
- **Header bar**: galaxy name, then: **whose turn** — `▸ LOBBY — GALAXY NOT STARTED` (cyan) when `waitingForGameStart`; **simultaneous** door-game: `D{n} · x/5 full turns`, then `▸ START FULL TURN` (can act, turn not open), `▸ TURN OPEN`, `▸ WAITING FOR OTHERS` (no daily slots left or waiting on others), or `▸ NO TURNS LEFT`; **round timer** (countdown to `roundEndsAt`); **sequential**: `▸ YOUR TURN` (cyan) or `▸ [NAME]'S TURN` (yellow); **turn timer** (countdown to deadline, red under 1h; hidden in lobby); **credits** (yellow), **turn counter** (`T5 (95 left)`), **protection badge** (`[P20]`), **commander name**.
- **Turn Summary Popup** (`TurnSummaryModal`) — at **turn start**, shows situation report from `POST /api/game/tick` (critical alerts for starvation, fuel deficit, unrest, etc.); after **attacks**, shows combat summary from `actionDetails.combatResult` (your losses, target losses, planet casualties for nuclear/chemical, psionic effects). Dismissible via Enter/Space/Escape or clicking outside.
- **Game Over Screen** (`GameOverScreen`) — appears when turnsLeft reaches 0. Shows final standings, player empire summary, all-time high scores, game log export button, and new game button.
- Styling: monochrome terminal/BBS aesthetic (black background, green-400 text, yellow-400 accents)
- Keyboard shortcuts: `1`-`7` switch tabs, letter keys trigger actions per tab, `Enter` skips turn. All labels reference `game-constants.ts` — no hardcoded numbers in UI.
- "Skip Turn" (not "End Turn") — since every other action already uses a turn, skipping is what happens when you take no action.

## TODO / backlog

- **Treaty diplomacy in the UI** — `game-engine.ts` already implements `propose_treaty`, `accept_treaty`, and `break_treaty` (`POST /api/game/action` with `target` / `treatyType` / `treatyId`). The web UI does not expose these: players cannot pick treaty type, see pending proposals, or accept without knowing a DB `treatyId`. Implement a diplomacy surface (e.g. new tab or CFG subsection), extend `GET /api/game/status` (or a small `GET /api/game/treaties`) to return pending/active treaties for the session, wire `onAction` calls, keyboard shortcuts if desired, and add E2E coverage.
