# DGE — Door Game Engine

A multiplayer turn-based game engine built with Next.js, Prisma, MySQL, and Redis. Hosts multiple games from a single stack — each game implements a typed `GameDefinition` interface; the engine handles turn management, AI orchestration, persistence, lobbies, and the React shell.

**Included game:** [Solar Realms Extreme (SRX)](games/srx/README.md) — a galactic empire management game.

## Quick Start

### Option A — Docker Compose (recommended)

Runs **MySQL**, **Redis**, the **Next.js app server**, and the **AI worker** in containers. The app image bakes in the source at build time — there is no bind mount. After code changes run **`npm run deploy`** (or **`npm run docker:dev:redeploy`**) to rebuild.

```bash
# Optional: API keys and admin overrides (DATABASE_URL is set inside Compose for the app)
cat > .env <<EOF
GEMINI_API_KEY="your-key-here"
GEMINI_MODEL="gemini-2.5-flash"
# GEMINI_MAX_CONCURRENT="4"           # cap concurrent Gemini API calls (global)
# DOOR_AI_MAX_CONCURRENT_MCTS="1"     # Optimal/MCTS parallelism cap
# DOOR_AI_DECIDE_BATCH_SIZE="4"       # door-game parallel decide wave size
# DOOR_AI_MOVE_TIMEOUT_MS="60000"     # per-AI decide wall-clock cap in ms
# SRX_LOG_AI_TIMING="1"              # JSON [srx-ai] lines: Gemini/MCTS latency
# NEXT_DISABLE_DEV_INDICATOR="true"  # hide Next.js bottom-left dev indicator
# ADMIN_USERNAME="admin"
# INITIAL_ADMIN_PASSWORD="srxpass"
# ADMIN_SESSION_SECRET="..."
EOF

docker compose up --build
# or: npm run docker:up
```

- **App:** [http://localhost:3000](http://localhost:3000) — Operators: [http://localhost:3000/admin](http://localhost:3000/admin) · [http://localhost:3000/admin/users](http://localhost:3000/admin/users)
- **MySQL on the host:** `localhost:3306` (user `srx`, password `srx`, database `srx`) — use in `DATABASE_URL` for host Prisma CLI (`db push`, `studio`).
- **Redis on the host:** `localhost:6379` — short-lived player and leaderboard read cache (fail-open; MySQL is always authoritative).
- The **ai-worker** container polls the `AiTurnJob` MySQL table and runs AI turns for simultaneous-mode sessions without blocking the app server.
- On startup the **app** container runs `prisma db push`. No migration files — schema changes go directly in `schema.prisma`.
- To seed **SystemSettings** from `.env` into the DB: **`docker compose exec app npm run seed:system-settings`**

Stop: `docker compose down` · Logs: `npm run docker:logs`

**Rebuild after edits:** `npm run docker:dev:redeploy`

If the app returns **500** and logs mention `lightningcss.*.node` or `globals.css`, run: **`npm run docker:reset-node-modules`**

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
EOF

npm install
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Operators: [http://localhost:3000/admin](http://localhost:3000/admin) (link on the login screen).

## Documentation

| Document | Description |
|----------|-------------|
| [ENGINE-SPEC.md](ENGINE-SPEC.md) | Engine specification — turn modes, AI, schema, auth, admin, help system |
| [games/srx/README.md](games/srx/README.md) | SRX game overview — systems, UI, simulation |
| [games/srx/docs/HOWTOPLAY.md](games/srx/docs/HOWTOPLAY.md) | SRX player-facing game guide |
| [games/srx/docs/GAME-SPEC.md](games/srx/docs/GAME-SPEC.md) | SRX complete technical specification |
| [CLAUDE.md](CLAUDE.md) | AI assistant guidance — commands, architecture, container-only npm |
| [AGENTS.md](AGENTS.md) | Cursor / editor agent rules |

## Engine Architecture

DGE is structured as an npm workspace monorepo. Game-agnostic infrastructure lives in `packages/`; each game is a self-contained implementation under `games/`.

```
packages/
  engine/    @dge/engine  — runtime: GameOrchestrator, turn management, MCTS/MaxN search,
                            registry, AI runner, door-game turns, advisory lock, job queue
  shared/    @dge/shared  — TypeScript types only: GameDefinition<TState>, ActionResult,
                            ReplayFrame, Move, Rng (no runtime code)
  shell/     @dge/shell   — React UI shell: GameLayout, TurnIndicator,
                            useGameState, useGameAction, GameUIConfig<TState>
games/
  srx/       @dge/srx     — Solar Realms Extreme game definition
src/
  app/                    — Next.js App Router (API routes + pages)
  components/             — Game-specific React components
  lib/                    — Game-specific services (game-engine, AI, combat, …)
```

### Key contracts

- Games implement `GameDefinition<TState>` from `@dge/shared` — the engine never imports game code
- Games register via `registerGame("type", { definition, metadata, adapter, hooks })` — routes dispatch by session `game` key
- `GameMetadata` drives the generic lobby UI (game-select cards, create-game form) without per-game React code in the lobby
- `GameHttpAdapter` lets API routes stay game-agnostic — each method delegates status, leaderboard, game-over, and player-init logic to the game
- `GameScreen` components (`src/components/<Name>GameScreen.tsx`) fully own the in-game UI; `page.tsx` dispatches to the correct one via `GAME_SCREEN_REGISTRY`
- Hook injection (`TurnOrderHooks` / `DoorGameHooks`) lets the engine call game-specific persistence and AI without importing game code
- The **bootstrap module** (`src/lib/game-bootstrap.ts`) consolidates all game registration imports so individual API routes need only one `import "@/lib/game-bootstrap"` line

### Turn modes

**Sequential** — one player acts at a time in a fixed rotation. AI turns run fire-and-forget in the background after each human action; the status API detects and recovers stuck AI turns after 90 s (e.g. after a server restart).

**Simultaneous (door-game)** — all players have a pool of daily full turns and can act in any order within the day. AIs run via the dedicated **ai-worker** container through a `AiTurnJob` job queue (SKIP LOCKED claiming, 5-minute stale recovery). `GET /api/game/status` drives `tryRollRound` to advance the calendar day once all slots are consumed or the round timer expires.

### Adding a game

1. Create `games/{name}/src/definition.ts` implementing `GameDefinition<{Name}State>`
2. Create `games/{name}/src/help-content.ts` with a `HELP_REGISTRY` entry
3. Add `games/{name}/package.json` as `@dge/{name}` and `games/{name}/docs/GAME-SPEC.md`
4. Implement `GameMetadata` (lobby card + create-form options) and `GameHttpAdapter` (API payload hooks)
5. Create `src/lib/{name}-registration.ts` calling `registerGame("{name}", { definition, metadata, adapter, hooks })` and add it to `src/lib/game-bootstrap.ts`
6. Create `src/components/{Name}GameScreen.tsx` for the in-game UI; register it in `GAME_SCREEN_REGISTRY` and `CLIENT_GAME_REGISTRY` in `src/app/page.tsx`
7. Add unit tests in `tests/unit/{name}-*.test.ts` and E2E tests in `tests/e2e/{name}-*.test.ts`

## Tech Stack

| Technology | Role |
|------------|------|
| Next.js 16 (App Router) | UI and API routes |
| Prisma 7 + `@prisma/adapter-mariadb` | MySQL ORM |
| Google Gemini (2.5 Flash default) | AI opponent decisions |
| Redis 7 | Player + leaderboard read cache (fail-open) |
| TypeScript | Entire codebase |
| Tailwind CSS | Styling |
| Vitest | Unit + E2E test suite |
| tsx | Simulation CLI + AI worker |

## Development

**Automation (Cursor, Claude Code, CI):** do **not** run `npm test`, `npm run lint`, `npm run typecheck`, or `npm run build` on the host — use the Compose `app` container. See [CLAUDE.md](CLAUDE.md) → **Container-only npm** and [AGENTS.md](AGENTS.md).

```bash
npm run docker:up        # Start Compose stack (MySQL + app + ai-worker)
npm run docker:down      # Stop stack
npm run docker:logs      # Follow app container logs
npm run deploy           # Rebuild app image and restart (apply code changes)
npm run docker:lint      # ESLint inside app container
npm run docker:typecheck # TypeScript check inside app container
npm run docker:build     # Production build inside app container
docker compose exec app npx prisma studio     # DB GUI
docker compose exec app npx prisma db push   # Sync schema to DB
```

### Testing

Always run tests inside the Compose `app` container. Host `npm test` often fails due to missing native bindings.

```bash
npm run docker:test        # Unit tests
npm run docker:test:e2e    # E2E against dev server on :3000
npm run docker:test:all    # Unit then E2E
```
