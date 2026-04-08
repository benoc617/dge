# Solar Realms Extreme (SRX)

A turn-based galactic empire management game — a modern reimagining of the BBS-era classic [Solar Realms Elite](https://breakintochat.com/wiki/Solar_Realms_Elite). Built with Next.js, Prisma, MySQL, and Redis, styled with a monochrome terminal/BBS aesthetic.

## Quick Start

### Option A — Docker Compose (recommended)

Runs **MySQL**, **Redis**, the **Next.js app server**, and the **AI worker** in containers. The app **image** includes a copy of the repo at build time — there is **no bind mount**. After you change code, run **`npm run deploy`** (or **`npm run docker:dev:redeploy`**) so Docker rebuilds the image and recreates the app and ai-worker containers.

```bash
# Optional: API keys and admin overrides (DATABASE_URL is set inside Compose for the app)
cat > .env <<EOF
GEMINI_API_KEY="your-key-here"
GEMINI_MODEL="gemini-2.5-flash"
# GEMINI_MAX_CONCURRENT="4"           # cap concurrent Gemini API calls (global); /admin can persist overrides in SystemSettings
# DOOR_AI_MAX_CONCURRENT_MCTS="1"      # Optimal/MCTS parallelism cap (same)
# DOOR_AI_DECIDE_BATCH_SIZE="4"       # door-game parallel decide wave size (same)
# DOOR_AI_MOVE_TIMEOUT_MS="60000"    # per-AI decide wall-clock cap in ms (same)
# DOOR_AI_MAX_CONCURRENT_MCTS="1"     # cap concurrent Optimal/MCTS in getAIMove
# SRX_LOG_AI_TIMING="1"               # JSON [srx-ai] lines: Gemini/MCTS latency (see CLAUDE.md); [srx-timing] is always on
# NEXT_DISABLE_DEV_INDICATOR="true"   # hide Next.js bottom-left dev indicator (restart required)
# ADMIN_USERNAME="admin"
# INITIAL_ADMIN_PASSWORD="srxpass"
# ADMIN_SESSION_SECRET="..."
EOF

docker compose up --build
# or: npm run docker:up
```

- **App:** [http://localhost:3000](http://localhost:3000) — Operators: [http://localhost:3000/admin](http://localhost:3000/admin) · [http://localhost:3000/admin/users](http://localhost:3000/admin/users) (accounts)
- **MySQL on the host:** `localhost:3306` (user `srx`, password `srx`, database `srx`) — use this in `DATABASE_URL` if you run **Prisma CLI on the host** (`db push`, `studio`) against the same database.
- **Redis on the host:** `localhost:6379` — short-lived player and leaderboard read cache (fail-open; MySQL is always authoritative).
- The **ai-worker** container polls the `AiTurnJob` MySQL table and executes AI turns for simultaneous-mode sessions concurrently with the app server.
- On startup the **app** container runs `prisma db push` (sync schema to DB). No migration files — schema changes go directly to `schema.prisma` and are pushed.
- To seed **SystemSettings** from your `.env` into the DB (for `/admin` overrides): **`docker compose exec app npm run seed:system-settings`** (recommended; matches the app container). Alternative on the host: `DATABASE_URL="mysql://srx:srx@localhost:3306/srx" npm run seed:system-settings`

Stop: `docker compose down` · Logs: `npm run docker:logs`

**Rebuild dev from current tree** (after pulls or local edits — rebuilds the app image and starts the stack): **`npm run docker:dev:redeploy`**

If the app returns **500** (including on login) and logs mention **`lightningcss.*.node`** or **`globals.css`**, run a clean rebuild: **`npm run docker:reset-node-modules`** (removes legacy volumes from older setups, **`docker compose build --no-cache app`**, then **`up -d`**).

Compose sets **`SRX_DOCKER=1`** so Turbopack’s dev filesystem cache is **off** in the container. If Turbopack still crashes, add **`SRX_FORCE_WEBPACK=1`** to the `app` service environment to use **`next dev --webpack`**.

### Option B — Node on the host

```bash
docker run -d --name srx-mysql \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=srx \
  -e MYSQL_USER=srx -e MYSQL_PASSWORD=srx \
  -p 3306:3306 mysql:8.4

cat > .env <<EOF
DATABASE_URL="mysql://srx:srx@localhost:3306/srx"
GEMINI_API_KEY="your-key-here"
GEMINI_MODEL="gemini-2.5-flash"
# GEMINI_MAX_CONCURRENT="4"
# DOOR_AI_DECIDE_BATCH_SIZE="4"
# DOOR_AI_MOVE_TIMEOUT_MS="60000"
# NEXT_DISABLE_DEV_INDICATOR="true"
EOF

npm install
npx prisma db push
npm run seed:system-settings   # copies GEMINI_* from .env into SystemSettings (optional; app reads env first)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to play. Operators can open [http://localhost:3000/admin](http://localhost:3000/admin) (link on the login screen) to list galaxies and create **pre-staged** lobbies that wait for the first human player before turns begin. **`/admin/users`** lists `UserAccount` rows (last login, game counts) and allows password resets and account deletion.

## Documentation

| Document | Description |
|----------|-------------|
| [HOWTOPLAY.md](HOWTOPLAY.md) | Player-facing game guide — strategies, controls, how everything works |
| [GAME-SPEC.md](GAME-SPEC.md) | Complete technical specification — every formula, constant, and data model. Enough to rebuild the game from scratch. |
| [CLAUDE.md](CLAUDE.md) | AI assistant guidance — commands, architecture, conventions (includes **container-only** npm for agents) |
| [AGENTS.md](AGENTS.md) | Cursor / editor agent rules — Docker-only tooling notice |

## What Is This Game?

You manage an interstellar empire across **100 turns**. Each turn you take one action — buy planets, recruit military, attack rivals, conduct espionage, trade on the market, research technology, or adjust your economy — then your empire ticks forward: resources are produced and consumed, population grows or shrinks, maintenance is paid, and random events may occur. The player with the highest **net worth** at the end wins. **Optional simultaneous-turn** galaxies use **door-game** rounds: up to **five full turns per calendar day** (tick → one action per full turn, auto-closed on the server; use **Skip** to end without acting); **each** full turn consumes **one** of your **100** `turnsLeft` (not once per calendar day). Humans and AIs can all play during the round; AIs run in the background (after each new day the server kicks a full AI drain once the galaxy transaction has committed; mid-round catch-up still uses background runs), and a **round timer** skips unused full turns when it expires — each skipped slot also consumes `turnsLeft` — so the calendar advances (see `HOWTOPLAY.md`). The default remains **sequential** one-player-at-a-time turns.

### Core Systems

- **10 planet types** — Food, Ore, Tourism, Petroleum, Urban, Education, Government, Supply, Research, Anti-Pollution
- **Population dynamics** — births, deaths, immigration, emigration driven by urban capacity, education, tax rate, pollution, and civil unrest
- **Superlinear maintenance** — planet upkeep grows quadratically with empire size; unchecked expansion is self-punishing
- **9 military unit types** (all purchasable, including light cruisers) across 3 upgrade tiers with a 3-front sequential combat system
- **6 attack types** — conventional invasion, guerrilla, nuclear, chemical, psionic, pirate raids (PvE)
- **10 covert operations** — spy, insurgent aid, dissension, demoralize, bombing, hostages, sabotage, and more
- **22 technologies** across 5 research categories
- **Global market** with supply/demand pricing, Solar Bank (loans, bonds, lottery)
- **Up to 5 AI opponents** powered by Google Gemini (configurable model, default `gemini-2.5-flash`) with 7 distinct strategic personas — **randomly assigned** at galaxy creation (Economy, Military, Research, Stealth, Turtle, Diplomatic, Optimal). The Optimal AI uses built-in Monte Carlo Tree Search and never calls Gemini. Works offline with a built-in rule-based fallback when no API key is set.

### UI & Controls

Single-page app with 3-column layout (3-5-4 grid): compact stat-box empire panel (left), 7-tabbed action panel (center), event log (right). **Header bar** shows whose turn it is (including a **lobby** line for admin-pre-staged galaxies awaiting the first human), countdown timer when a turn is active, credits, turn counter, and commander name. **Lobby system**: create named galaxies (public or private), share invite codes, browse and join public games, or resume existing games. New games require a commander name and password. Finished games are not resumable. **Strict turn order**: players act one at a time in a fixed sequence. AI opponents run in the background after your action; the UI polls so you see each AI's turn. If the next player is human, you wait until they go. **Turn start**: a situation report modal (income, events, critical alerts for starvation, fuel deficit, unrest, etc.) appears when your turn begins, before you choose an action. "Skip Turn" at top of command center. **Galactic Powers** leaderboard lists rivals with a **Prt** column for new-empire protection; click a rival to target them. Planet colonizer with card-style descriptions per type. Game Over screen with final standings, high scores, and game log export. CFG tab shows invite code for private games (click-to-copy), visibility toggle, turn timer setting (creator), and full turn order. Full keyboard shortcut support — `1`–`7` switch tabs, letter keys trigger actions, `Enter` skips turn. **Operators**: `/admin` (optional `ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` in `.env`) lists galaxies and creates empty or AI-filled pre-staged sessions; **`/admin/users`** manages registered accounts (stats, force password, delete).

## Simulation & Balance Testing

SRX includes a deterministic simulation engine for rapid balance iteration. All game randomness uses a seedable PRNG, so identical seeds produce identical games.

**Agents / automation:** run simulations **inside** the `app` container (Compose up):

```bash
docker compose exec app npm run sim:quick
docker compose exec app npm run sim:full
docker compose exec app npm run sim:stress
docker compose exec app npm run sim:balance
docker compose exec app npm run sim:csv
docker compose exec app npm run sim:session:seq
docker compose exec app npm run sim:session:sim
docker compose exec app npm run sim -- --turns 200 --players 8 --seed 42 --strategies balanced,military_rush,turtle,research_rush
docker compose exec app npm run sim -- --session sequential --turns 50 --players 3 --seed 1
docker compose exec app npm run sim -- --session simultaneous --apd 1 --turns 50 --players 3 --seed 1
```

On a host with a matching Node install and `DATABASE_URL`, the same `npm run sim:*` scripts work — prefer the container for consistency with the rest of this repo.

**Orphan sim** (`sim` without `--session`): strategy bots with `gameSessionId = null` — fast, no turn-order or door-game API.

**Session sim** (`--session sequential` or `simultaneous`): creates a real `GameSession`, runs the same code paths as the HTTP game (`getCurrentTurn` / `advanceTurn`, or door-game `openFullTurn` / `closeFullTurn`). The temp galaxy is deleted after the report. Use `--apd N` with simultaneous (`default 5` in live games; `1` for shorter sims).

Preset strategies (default roster cycles one per simulated player): `balanced`, `economy_rush`, `military_rush`, `turtle`, `random`, `research_rush`, `credit_leverage`, `growth_focus`, `mcts`. Use `--players 9` to run all presets in one sim. `sim:balance` runs 25×100-turn games with aggregate win rates and balance notes.

## Monorepo Structure (DGE — Door Game Engine)

SRX is built on **DGE** (Door Game Engine), a game-agnostic engine extracted into reusable npm workspace packages. SRX is the first game implementation; the engine is designed to host additional games (e.g. chess) without modification.

```
packages/
  engine/    @dge/engine  — game-agnostic runtime: turn management, MCTS/MaxN search,
                            GameOrchestrator, registry, caching, AI runner, door-game turns
  shared/    @dge/shared  — shared TypeScript types: GameDefinition<TState>, Rng, Move,
                            ActionResult, ReplayFrame, SideEffect (no runtime code)
  shell/     @dge/shell   — game-agnostic React UI shell: GameLayout, TurnIndicator,
                            useGameState hook, useGameAction hook, GameUIConfig<TState>
games/
  srx/       @dge/srx     — SRX game definition: pure-track applyTick/applyAction/evalState/
                            generateCandidateMoves + migration shims for the full-track path
src/
  app/                    — Next.js App Router (API routes + pages)
  components/             — SRX React components (EmpirePanel, ActionPanel, EventLog, Leaderboard)
  lib/                    — SRX-specific services (game-engine, AI runner, combat, espionage, …)
```

**Key contracts:**
- Games implement `GameDefinition<TState>` from `@dge/shared` — the engine never imports game code
- Games register via `registerGame("type", definition, hooks)` — routes look up by session's `gameType`
- Games provide a `GameUIConfig<TState>` to `@dge/shell` — the shell renders panels without knowing about game internals
- Hook injection (via `TurnOrderHooks` / `DoorGameHooks`) lets the engine call game-specific persistence and AI functions

## Tech Stack

| Technology | Role |
|------------|------|
| Next.js 16 (App Router) | UI and API routes |
| Prisma 7 + `@prisma/adapter-mariadb` | MySQL ORM |
| Google Gemini (2.5 Flash default) | AI opponent decisions |
| Redis 7 | Player + leaderboard read cache (fail-open) |
| TypeScript | Entire codebase |
| Tailwind CSS | Terminal/BBS aesthetic |
| Vitest | Unit + E2E test suite |
| tsx | Simulation CLI runner + AI worker |

## Project Structure

```
packages/
  engine/src/
    orchestrator.ts           # GameOrchestrator: sequential + door-game action/tick lifecycle
    registry.ts               # registerGame / requireGame / listGameTypes
    turn-order.ts             # Sequential turn management (getCurrentTurn, advanceTurn)
    door-game.ts              # Simultaneous turn management (openFullTurn, closeFullTurn, tryRollRound)
    search.ts                 # MCTS and MaxN search (parameterised by GameDefinition)
    ai-runner.ts              # Generic AI turn loop (delegates to definition.buildAIContext)
    cache.ts                  # Cache-aside helpers (namespace-parameterised)
    db-context.ts             # Prisma client + advisory lock (withCommitLock)
    redis.ts                  # Fail-open Redis helpers
    llm.ts                    # Gemini API caller (game-agnostic)
    ai-concurrency.ts         # Dynamic Gemini/MCTS semaphores
    door-ai-runtime-settings.ts  # Door-game AI concurrency caps (DB + env)
  shared/src/
    types.ts                  # GameDefinition<TState>, ActionResult, ReplayFrame, Move, Rng, …
    rng.ts                    # Seedable PRNG (shared Rng implementation)
  shell/src/
    types.ts                  # GameStateBase, GameUIConfig<TState>, GamePanelProps<TState>
    GameLayout.tsx            # Panel renderer (three-column / two-column / single)
    TurnIndicator.tsx         # Turn status (sequential + door-game + lobby)
    hooks/useGameState.ts     # Generic status-poll hook
    hooks/useGameAction.ts    # POST /api/game/action wrapper
games/
  srx/src/
    definition.ts             # SrxGameDefinition implements GameDefinition<SrxWorldState>
    types.ts                  # SrxWorldState, SrxEmpireSlice
    index.ts                  # Barrel (srxGameDefinition, SrxWorldState)
src/
  app/
    page.tsx                        # Main game UI + TurnSummaryModal + TurnTimer
    admin/page.tsx                  # Operator admin UI (/admin): galaxies list + create pre-staged lobbies
    admin/users/page.tsx            # Operator user accounts (/admin/users): list, force password, delete
    api/auth/                       # signup, login (UserAccount + Command Center)
    api/game/                       # action, tick, status, register, join, lobbies, session, messages, leaderboard, gameover, highscores, log
    api/ai/                         # setup, run-all, turn
    api/admin/                      # login, logout, me, password, settings, galaxies, users (cookie auth)
  components/
    ActionPanel.tsx                  # 7-tabbed action panel + turn order display
    EmpirePanel.tsx                  # Empire status with collapsible planet details
    EventLog.tsx                     # Color-coded turn report and event log
    Leaderboard.tsx                  # Galactic Powers (Rk, Commander, Prt, Worth, Pop, Plt, Turns, Mil) + click-to-target
  lib/
    game-engine.ts                   # Core: 19-step turn tick + 35 action types; blocks attacks/covert vs protected rivals
    empire-prisma.ts                 # Prisma-safe empire partial updates (scalar lists)
    game-constants.ts                # All balance values (single source of truth)
    turn-order.ts                    # Sequential turns; lobby = no active turn until first human (admin-staged galaxies)
    admin-auth.ts                    # Admin login + requireAdmin for /api/admin/*
    auth.ts                          # Player/account authentication helpers
    create-ai-players.ts             # Shared AI creation (register AI setup + admin-staged galaxies)
    ai-builtin-config.ts             # Fixed AI commander names / persona keys
    ai-runner.ts                     # Sequential AI turn execution
    ai-process-move.ts               # AI action + end_turn when invalid (skip parity with humans)
    combat.ts                        # Combat system (6 attack types, unit tiers)
    combat-loss-format.ts            # Human-readable unit-loss strings for reports & API messages
    espionage.ts                     # 10 covert operations
    research.ts                      # Tech tree (22 techs, 5 categories)
    gemini.ts                        # AI prompts (neutral rival targeting) + local fallback
    rng.ts                           # Seedable PRNG (mulberry32)
    simulation.ts                    # Headless simulation engine (StrategyContext, 9 preset strategies)
    simulation-harness.ts            # Full session simulation runner (sequential + simultaneous)
    sim-state.ts                     # Pure in-memory empire state + evalState heuristic for search algorithms
    search-opponent.ts               # MCTS and MaxN search for the Optimal AI opponent
    prisma.ts                        # Database client
    player-auth.ts                   # Player credential resolution (UserAccount-aware)
    player-init.ts                   # Starter empire/planet creation (shared by register, join, AI setup)
    db-context.ts                    # AsyncLocalStorage DB context + advisory lock for door-game
    door-game-turns.ts               # Simultaneous turn mechanics (open/close/rollRound/AI drain)
    door-game-ui.ts                  # Client rule for Command Center disabled vs canAct/turnOpen
    delete-game-session.ts           # Session + player cascade cleanup (includes AiTurnJob + SessionLock)
    system-settings.ts               # SystemSettings (Gemini key masking for admin API)
    door-ai-runtime-settings.ts      # Door-game AI caps (DB + env), semaphore refresh; short TTL cache
    redis.ts                         # ioredis client; fail-open helpers (rGet, rSetEx, rDel)
    game-state-service.ts            # Player/leaderboard cache-aside (getCachedPlayer, invalidatePlayer, …)
    ai-job-queue.ts                  # AiTurnJob CRUD: enqueue, claim (SKIP LOCKED), complete, fail, recoverStale
    ui-tooltips.ts                   # Tooltip text for Galactic Powers, Empire Status, Command Center
    critical-events.ts               # Situation-report event tiers (critical / warning / info)
tests/
  unit/                              # Pure logic (rng, constants, research, combat, espionage, empire-prisma, turn-order lobby, gemini pickRival, …)
  e2e/                               # HTTP API: game flow, multiplayer, lobbies, auth accounts, aux routes (log, gameover, ai), admin (+ users), …
  vitest.e2e.config.ts               # E2E config: sequential files, `tests/e2e` only
scripts/
  deploy-docker-dev.sh               # docker compose build app + up -d (pick up code changes)
  ai-worker.ts                       # Standalone AI turn worker (separate Compose service; polls AiTurnJob)
  simulate.ts                        # CLI runner for simulations
  fix-tsc-bin.js                     # postinstall: repair broken node_modules/.bin/tsc symlink
  docker-entrypoint-dev.sh           # Compose app entry: prisma generate, db push, next dev
  docker-reset-node-modules-volume.sh  # Legacy volume cleanup + no-cache rebuild (lightningcss / stale .next)
prisma/
  schema.prisma                      # Database schema
Dockerfile.dev                       # Dev image: npm ci, COPY repo, prisma generate; no runtime bind mount
docker-compose.yml                   # MySQL + Redis + Next.js app + AI worker (source baked into image; MySQL data volume only)
.dockerignore                        # Build context exclusions
```

## Development

**Automation (Cursor, Claude Code, CI-style scripts):** do **not** run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`, or other verification **on the host** — use the Compose **`app`** container (`npm run docker:*` or `docker compose exec app …`). See **`CLAUDE.md`** → **Container-only npm (mandatory for agents)** and root **`AGENTS.md`**.

```bash
npm run docker:up        # Compose: MySQL + dev server in Docker (see Quick Start) — primary workflow
npm run docker:down      # Stop Compose stack
npm run docker:logs      # Follow `app` container logs
npm run deploy           # docker compose build app + up -d (apply code changes to the running dev server)
npm run docker:lint      # ESLint inside `app` (stack must be up)
npm run docker:typecheck # TypeScript check inside `app`
npm run docker:build     # Production build inside `app`
docker compose exec app npx prisma studio   # DB GUI (inside container; same DB as the app)
docker compose exec app npx prisma db push        # Sync schema to DB (no migration files)
```

**Host-only** (optional; not the default for agents): `npm run dev`, `npm run build`, `npm run lint`, `npx prisma …` on the host with `DATABASE_URL` pointing at **localhost:3306** when MySQL is from Compose — can work for humans, but optional native deps (e.g. Vitest) may not match Docker.

### Testing

**Always** run Vitest and E2E **inside** the Compose **`app`** container. Host `npm test` often fails (missing Rolldown/Vitest native bindings, mismatched `node_modules`).

```bash
npm run docker:test        # Unit tests (`docker compose exec app` — stack must be up)
npm run docker:test:e2e    # E2E against dev server on :3000 in the same container
npm run docker:test:all    # Unit then E2E in container
```

**Host scripts** (`npm test`, `npm run test:e2e` on :3005, etc.) are for **CI** (Linux + clean `npm ci`) or explicit local use — **not** for automation against this repo’s Docker workflow.

**E2E:** Prefer **`npm run docker:test:e2e`**. The host script `test:e2e` uses [start-server-and-test](https://github.com/bahmutov/start-server-and-test) to boot `next dev` on **127.0.0.1:3005** — conflicts with Docker’s `next dev` on :3000. **`docker:test:e2e`** runs `test:e2e:only` inside `app` with `TEST_BASE_URL=http://127.0.0.1:3000`. Run `prisma db push` so the schema matches the Prisma client.

**Door-game repair (legacy AI skip bug):** with `DATABASE_URL` set (e.g. `localhost:5433` to Compose Postgres), run `npm run repair:door-session -- --galaxy "Your Galaxy" --dry-run` to list empires where `turnOpen` is true, the last `TurnLog` is `end_turn`, and `tickProcessed` is false (meaning `closeFullTurn` never ran). It ignores the normal case where `/tick` opened a new full turn but the newest log is still the previous `end_turn`. Then `--apply` to run `closeFullTurn` for each. Or `--apply --player "Commander Name"` with optional `--force` to close an open turn manually.

All game balance values live in `src/lib/game-constants.ts` — the single source of truth referenced by game logic, UI labels, and simulation strategies. Changing a constant there automatically updates everything.
