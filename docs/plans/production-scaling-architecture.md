---
name: Production Scaling Architecture
overview: ECS Fargate service-oriented architecture for scaling SRX with MySQL migration (reuse existing RDS), Redis cache, game state service layer, and separate AI opponent worker service.
todos:
  - id: mysql-migration
    content: "Phase 0: Migrate from Postgres to MySQL — schema, adapter, advisory locks, Docker Compose, connection strings"
    status: pending
  - id: game-state-cache
    content: "Layer 1: Redis cache — ECS Fargate service (or ElastiCache) + cache-aside in game-state-service.ts"
    status: pending
  - id: game-state-service
    content: "Layer 2: Game State Service module — unified read/write API over MySQL + Redis, cache invalidation on writes"
    status: pending
  - id: ai-service
    content: "Layer 3: AI Worker ECS service — MySQL job queue, worker_threads for MCTS, separate task def with independent scaling"
    status: pending
  - id: multi-instance
    content: "Layer 4: Multi-instance web tier — stateless Next.js behind ALB, all coordination through shared MySQL + Redis"
    status: pending
isProject: false
---

# Production Scaling Architecture (ECS Fargate)

## Target Architecture

Based on the existing puzzleboss2-infra patterns: ECS Fargate ARM64/Graviton, ALB, RDS, service discovery, Fluent Bit + Loki logging, Prometheus + Grafana metrics.

```mermaid
graph TB
    ALB[ALB] --> SRXWeb1["srx-web Task 1\n(Next.js)"]
    ALB --> SRXWeb2["srx-web Task 2\n(Next.js)"]

    subgraph ecs [ECS Cluster]
        SRXWeb1
        SRXWeb2
        SRXAi["srx-ai Task\n(AI Worker)"]
        RedisService["srx-redis Task\n(Redis 7)"]
    end

    SRXWeb1 -->|"redis.srx.local:6379"| RedisService
    SRXWeb2 -->|"redis.srx.local:6379"| RedisService
    SRXAi -->|"redis.srx.local:6379"| RedisService

    SRXWeb1 --> RDS["RDS MySQL 8.4\n(wind-up-birds)"]
    SRXWeb2 --> RDS
    SRXAi --> RDS
```

## Current Data Access Patterns (what drives the design)

### Hot read path: status poll (every 2s per connected player)
- Loads full empire graph: `Player` + `Empire` + `Planet[]` + `Army` + `SupplyRates` + `Research` (5-6 joined tables)
- Loads `GameSession` turn state fields
- Simultaneous mode: loads session roster (`Player.findMany`)
- **This data only changes when someone takes an action or a round rolls** — between mutations, every poll returns identical data

### Hot read path: leaderboard (every 10s per connected player)
- `Empire.findMany` with `Player` + `Planet[]` + `Army` subset, scoped by session
- Same staleness characteristic — only changes on mutations

### Write path: player action
- 3-5+ DB writes minimum (empire, army, turn log, finance side effects)
- Combat/market/diplomacy adds more
- Door-game: `closeFullTurn` + `tryRollRound` add further writes
- **Each mutation is the natural cache invalidation point**

### AI read path
- Same full empire graph as status poll, plus 16 recent `GameEvent` rows and rival protection data
- MCTS converts everything to `PureEmpireState` (plain objects, no DB refs) — operates entirely in memory after the initial load

### Cross-session isolation
- Nearly all queries are scoped to one `gameSessionId`
- Exceptions: `Market` (global singleton), unscoped leaderboard, `SystemSettings`

---

## Phase 0: Postgres to MySQL Migration

Migrate SRX from Postgres to MySQL 8.4 to reuse the existing RDS instance (`wind-up-birds`, db.t4g.small) from puzzleboss2-infra. SRX would get its own database on the same RDS instance (e.g. `CREATE DATABASE srx`).

### Scope of changes

The codebase has minimal Postgres-specific code. The migration is mostly mechanical:

**1. Prisma schema (`prisma/schema.prisma`)**

```
- datasource db { provider = "postgresql" }
+ datasource db { provider = "mysql" }
```

**Field type changes:**

- **`String[]` fields** (4 occurrences): `Empire.pendingDefenderAlerts`, `Coalition.memberIds`, `Research.unlockedTechIds`, `GameSession.playerNames`. Prisma on MySQL maps `String[]` to a JSON column internally. Reads/writes through Prisma are transparent — no application code changes.
- **`Json[]` field** (`GameSession.log`): Highest risk. Prisma's MySQL connector may not support `Json[]` (list of JSON values). **Fix:** Change to `Json @default("[]")` — a single JSON column holding an array. The app already treats it as an array; just ensure serialization is consistent.
- **`Json` and `Json?` fields** (`Convoy.contents`, `TurnLog.details`, `GameEvent.details`, `GameSession.finalScores`): MySQL has native JSON type. Prisma handles this identically. No changes.
- **`Float` fields** (`Market`): Maps to MySQL `DOUBLE`. No changes.
- **Enums**: Supported on MySQL. No changes.

**2. Prisma client adapter (`src/lib/prisma.ts`)**

```
- import { PrismaPg } from "@prisma/adapter-pg";
- import { Pool } from "pg";
+ import { PrismaMySQL } from "@prisma/adapter-mysql2";  // verify exact Prisma 7 package name
+ import mysql from "mysql2/promise";
```

Replace `pg.Pool` with `mysql2` connection pool. Same pattern (shared pool, max connections, timeouts).

Also update: `scripts/inspect-turn-logs.ts`, `scripts/compare-armies.ts` (same adapter swap).

**3. Advisory locks (`src/lib/db-context.ts`) — the only non-trivial change**

Current code:
```sql
SELECT pg_try_advisory_xact_lock(${key}::bigint) AS ok
```

`pg_try_advisory_xact_lock` is Postgres-specific — it acquires an advisory lock scoped to the current transaction, automatically released on commit/rollback. MySQL has no exact equivalent.

**Recommended replacement: `SELECT ... FOR UPDATE` on a lock row.**

Add an index/lock table:

```prisma
model SessionLock {
  sessionId String @id
  lockedAt  DateTime @default(now())
}
```

Create a lock row when a `GameSession` is created. Then in `withCommitLock`:

```typescript
// Inside the interactive transaction:
const rows = await tx.$queryRaw<{ sessionId: string }[]>`
  SELECT sessionId FROM SessionLock
  WHERE sessionId = ${sessionId}
  FOR UPDATE NOWAIT
`;
```

`FOR UPDATE NOWAIT` acquires a row-level lock scoped to the transaction (released on commit/rollback — same semantics as `pg_try_advisory_xact_lock`). `NOWAIT` returns an error immediately if the row is locked (equivalent to the `try_` behavior). Catch the lock error and throw `GalaxyBusyError`.

This approach:
- Has identical semantics to the current advisory lock (transaction-scoped, non-blocking try)
- Works on both MySQL and Postgres (portable)
- No external dependencies (Redis not required for locking)
- The `hashSessionIdToBigInt` helper becomes unnecessary

**Alternative:** Since we're adding Redis anyway, use `SET NX` with TTL for a distributed lock. But `FOR UPDATE NOWAIT` is simpler, doesn't add a Redis dependency to the correctness path, and matches the current transaction-scoped semantics exactly.

**4. Docker Compose (`docker-compose.yml`)**

```yaml
# Replace postgres service:
mysql:
  image: mysql:8.4
  environment:
    MYSQL_ROOT_PASSWORD: root
    MYSQL_DATABASE: srx
    MYSQL_USER: srx
    MYSQL_PASSWORD: srx
  ports:
    - "3306:3306"
  healthcheck:
    test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
    interval: 5s
    timeout: 3s
    retries: 5
  volumes:
    - srx_mysqldata:/var/lib/mysql
```

App `DATABASE_URL`: `mysql://srx:srx@mysql:3306/srx`

**5. Build-time dummy URL (`Dockerfile.dev`)**

```
- DATABASE_URL="postgresql://build:build@localhost:5432/build"
+ DATABASE_URL="mysql://build:build@localhost:3306/build"
```

**6. Dependencies (`package.json`)**

```
- "@prisma/adapter-pg"
- "pg"
+ "@prisma/adapter-mysql2"  (verify exact Prisma 7 package)
+ "mysql2"
```

**7. Documentation**

Update `README.md`, `CLAUDE.md`, `GAME-SPEC.md` — connection strings, port numbers, tooling references (`psql` → `mysql`, `pg_isready` → `mysqladmin ping`).

### Migration order

1. Update `schema.prisma` provider + fix `Json[]` → `Json`
2. Swap Prisma adapter + dependencies (`pg` → `mysql2`)
3. Replace advisory lock with `FOR UPDATE NOWAIT` + `SessionLock` table
4. Update Docker Compose + entrypoint
5. Run `prisma db push` against local MySQL
6. Run unit tests + E2E tests
7. Update docs

### Risk assessment

- **Low risk:** Schema types, adapter swap, connection strings, Docker Compose — all mechanical
- **Medium risk:** `Json[]` → `Json` for `GameSession.log` — need to verify all read/write paths handle the change
- **Medium risk:** Advisory lock replacement — `FOR UPDATE NOWAIT` has the same semantics but error handling differs (MySQL throws error 3572 vs Postgres returning false). Need to catch the right error code.
- **Low risk:** `String[]` fields — Prisma handles the JSON-backing transparently

### Production deployment

On ECS, SRX connects to the existing `wind-up-birds` RDS MySQL 8.4 instance:
- Create database: `CREATE DATABASE srx CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
- Create user: `CREATE USER 'srx'@'%' IDENTIFIED BY '...'` + `GRANT ALL ON srx.* TO 'srx'@'%'`
- `DATABASE_URL` in Secrets Manager: `mysql://srx:PASSWORD@wind-up-birds.XXXXX.us-east-1.rds.amazonaws.com:3306/srx`
- Security group: the existing `rds` SG from puzzleboss2-infra already allows inbound from ECS tasks SG

---

## Layer 1: Redis Read Cache

### How it runs: separate container, not inside the app

Redis is NOT a sidecar in the web task definition. It is its own ECS Fargate service, exactly like memcache in puzzleboss2-infra. The web and AI tasks reach it via service discovery DNS.

**Local dev (Docker Compose):** Add a `redis` service to `docker-compose.yml` alongside `postgres`. The app connects to `redis:6379`. No sidecar, no embedding.

```yaml
# docker-compose.yml addition
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 5s
    timeout: 3s
    retries: 5
```

**ECS Fargate:** A new `srx-redis` ECS service + task definition (mirrors the memcache pattern from puzzleboss2-infra):

- Task def: `redis:7-alpine` container, 256 CPU / 512 MiB memory, ARM64
- Service discovery: `redis.srx.local:6379` (private DNS namespace, like `memcache.puzzleboss.local:11211`)
- `desired_count: 1` — single Redis instance (cache, not persistent store)
- Fluent Bit sidecar + ecs_exporter sidecar (same pattern as all other puzzleboss services)
- Security group: allow inbound 6379 from ECS tasks SG only
- No ALB, no public access — internal only

**Alternative: AWS ElastiCache.** Managed Redis, ~$12/mo for `cache.t4g.micro`. Slightly more expensive than Fargate Redis (~$5/mo) but zero operational overhead (patching, failover). ElastiCache Serverless is another option — pay-per-use, may be cheapest at low traffic. Either works; the app code is identical either way (connect to a Redis endpoint).

**Cost comparison:**

- Fargate Redis (256 CPU, 512 MiB): ~$5/mo
- ElastiCache cache.t4g.micro: ~$12/mo
- ElastiCache Serverless: ~$0.50/mo at low traffic, scales with usage

### What it caches

The status poll is the hot path: every 2 seconds per connected player, it loads Player + Empire + Planets + Army + SupplyRates + Research (5-6 joined tables). Between mutations, every poll returns identical data. Cache-aside eliminates these redundant DB reads.

**Cache keys and sizes:**

- **`empire:{playerId}`** — full empire graph (the `playerInclude` query result). ~2-5KB JSON. This is the single most expensive repeated read.
- **`session:{sessionId}:roster`** — player list with turn state. ~0.5KB. Changes on join/leave/round roll.
- **`session:{sessionId}:leaderboard`** — pre-computed leaderboard response. ~1-2KB. Changes on any mutation.
- **`session:{sessionId}:turn`** — turn state fields (`currentTurnPlayerId`, `dayNumber`, `roundStartedAt`). ~0.1KB. Changes on turn advance / round roll.

Total memory per game with 5 players: ~20KB. 1000 concurrent games: ~20MB. Redis with 512MB is massive overkill — leaves room for other uses later.

**What NOT to cache:** `Market` (global singleton, rarely polled), `SystemSettings` (already has 60s in-process cache), AI move context (read once per AI turn, not polled).

### Cache-aside pattern

```
Read path (status poll):
  key = `empire:{playerId}`
  1. GET from Redis → hit → return cached (skip Postgres)
  2. Miss → query Postgres → SET in Redis with 30s TTL → return

Write path (processAction, closeFullTurn, tryRollRound):
  After DB commit → DEL affected keys
  Keys: empire:{self}, empire:{target}, session:{sid}:roster, session:{sid}:leaderboard
```

Invalidation is clean because game state is session-scoped. Every mutation knows its `playerId` and `gameSessionId`, so the invalidation set is predictable:

- Economy action → DEL `empire:{self}`, `session:{sid}:leaderboard`
- Combat → DEL `empire:{self}`, `empire:{target}`, `session:{sid}:leaderboard`
- Round roll → DEL all `empire:{pid}` in session, `session:{sid}:roster`
- Turn advance → DEL `session:{sid}:turn`

### Version stamps for 304 responses

Each cached empire gets a `version` (monotonic counter, incremented on write). The client sends its last-seen version. If unchanged, the server returns a minimal "no change" response — saves serialization, network, and React re-render. This is the most common case (player is polling, nothing happened).

### Implementation in the app

- Use `ioredis` — lightweight, well-maintained, works in both Next.js and standalone workers
- Redis connection string from env (`REDIS_URL`), same pattern as `DATABASE_URL`
- Cache writes are fire-and-forget (Redis is a performance optimization, not source of truth)
- If Redis is down or unreachable, fall through to Postgres transparently — never crash, never block

---

## Layer 2: Game State Service

An abstraction layer between the HTTP routes / AI code and the raw Prisma queries. Today, `game-engine.ts`, `door-game-turns.ts`, `ai-runner.ts`, and the API routes all directly call `prisma.empire.update(...)`. A Game State Service centralizes this.

### Why a service layer (not just caching)

- **Single place to handle cache invalidation** — every DB write goes through the service, which handles Redis invalidation as a side effect. No risk of forgetting to invalidate in one of the many write paths.
- **Query optimization** — the service can batch related reads, use Postgres `NOTIFY`/`LISTEN` for invalidation, or switch to raw SQL for hot paths without changing callers.
- **Schema evolution** — the service presents a stable interface. If you later shard by session, add read replicas, or swap Postgres for something else, callers don't change.
- **Testability** — mock the service for unit tests instead of mocking Prisma.

### Shape of the service

```
GameStateService:
  // Reads (cache-first)
  getEmpireState(playerId) → EmpireSnapshot
  getSessionRoster(sessionId) → PlayerRoster
  getLeaderboard(sessionId) → LeaderboardEntry[]
  getTurnState(sessionId) → TurnState

  // Writes (Postgres + invalidate cache)
  applyEmpireUpdate(playerId, delta) → void
  advanceRound(sessionId) → void
  recordTurnLog(playerId, action, details) → void

  // AI-specific reads (no cache needed — one-shot)
  getAIMoveContext(playerId) → AIMoveContext
```

This does NOT need to be a separate process or HTTP service initially. It can start as a TypeScript module (`src/lib/game-state-service.ts`) that wraps Prisma + Redis. The callers (`game-engine.ts`, API routes, AI runner) import from the service instead of calling Prisma directly. This makes the future extraction to a separate service trivial — swap the import for an HTTP client.

### Relationship to existing code

- `game-engine.ts` `processAction` currently does inline Prisma writes. Refactor: extract the DB writes at the end of `processAction` into `GameStateService.applyEmpireUpdate`.
- `buildResponse` in the status route currently runs 3-4 Prisma queries. Refactor: call `GameStateService.getEmpireState` + `getSessionRoster` + `getTurnState`.
- Advisory lock (`withCommitLock`) stays where it is — the service operates within or outside the lock context depending on the caller.

---

## Layer 3: AI Opponent Service

The biggest architectural separation. AI work has fundamentally different characteristics from web serving:

- **Web tier:** <50ms latency, I/O bound (DB + network), scales with concurrent players
- **AI tier:** Minutes per turn is fine, CPU bound (MCTS) + I/O (Gemini API), scales with concurrent games x AIs per game
- **Failure mode:** Web error = player sees error. AI failure = AI skips a turn (recoverable via job retry)

### ECS deployment: same image, different command (like bigjimmy)

The AI worker uses the **same Docker image** as the web tier but with a different entrypoint — exactly like bigjimmy in puzzleboss2-infra (same image as puzzleboss web, but `command = ["python", "bigjimmybot.py"]`).

```
srx-ai task definition:
  image: same ECR repo as srx-web
  command: ["node", "scripts/ai-worker.js"]   # or npx tsx scripts/ai-worker.ts
  cpu: 1024-4096  (1-4 vCPU — MCTS is CPU-hungry)
  memory: 2048-4096
  desired_count: 1-N (scale with game count)
  deployment: stop-then-start (like bigjimmy — no ALB, no zero-downtime needed)
  service_discovery: not needed (no inbound connections)
  no load_balancer block
```

The AI worker is a long-running Node.js process that polls for jobs, runs MCTS / Gemini, and writes results back to Postgres. It connects to the same RDS Postgres and Redis (via service discovery DNS) as the web tier.

### Job queue (MySQL-based, no new infrastructure)

New Prisma model:

```prisma
model AiTurnJob {
  id          String    @id @default(cuid())
  sessionId   String
  playerId    String
  status      String    @default("pending")  // pending | claimed | done | failed
  claimedBy   String?
  claimedAt   DateTime?
  completedAt DateTime?
  result      Json?     // { action, params, llmSource } or error details
  createdAt   DateTime  @default(now())

  @@index([status, createdAt])
}
```

**Enqueue:** When a human action closes a full turn (or round rolls), instead of `after(() => runDoorGameAITurns(...))`, insert `AiTurnJob` rows for each AI that owes a turn. This replaces the in-memory `doorAiInFlight` Map entirely — works across instances, survives restarts.

**Claim + process:** AI workers poll with the standard MySQL job queue pattern:
```sql
-- MySQL 8+ supports SELECT ... FOR UPDATE SKIP LOCKED
SELECT id, sessionId, playerId FROM AiTurnJob
WHERE status = 'pending'
ORDER BY createdAt
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- Then in the same transaction:
UPDATE AiTurnJob SET status = 'claimed', claimedBy = ?, claimedAt = NOW()
WHERE id = ?;
```

`SKIP LOCKED` (supported in MySQL 8.0+) means multiple workers never claim the same job. No Redis queue, no BullMQ, no new infrastructure beyond the existing RDS.

**Stale job recovery:** A periodic sweep marks `claimed` jobs older than 5 minutes as `pending` again (crashed worker). Resilience the current `doorAiInFlight` in-memory Map completely lacks.

### MCTS in worker threads (inside the AI worker process)

```mermaid
graph LR
    subgraph aiTask ["srx-ai ECS Task"]
        Main["Main Thread\n(job poll, Gemini, DB)"]
        WT1["Worker Thread 1\n(MCTS 45s)"]
        WT2["Worker Thread 2\n(MCTS 45s)"]
    end
    Main -->|"postMessage(PureEmpireState)"| WT1
    Main -->|"postMessage(PureEmpireState)"| WT2
    WT1 -->|"postMessage(CandidateMove)"| Main
    WT2 -->|"postMessage(CandidateMove)"| Main
```

- `PureEmpireState` is plain objects — regular `postMessage` structured clone, no `SharedArrayBuffer` needed
- MCTS runs at full speed in workers (no `setImmediate` yielding — it has its own thread)
- Main thread handles DB reads, Gemini API calls, job polling — all I/O, all lightweight
- Thread pool size = Fargate vCPUs allocated to the task (e.g. 4 vCPU = 4 concurrent MCTS)
- The existing sync `mctsSearch` is perfect for worker threads — no async complexity needed

### Gemini rate limiting (global)

With multiple workers, the per-process `withGeminiGeneration` semaphore no longer limits globally. Since you already have Redis:

- Redis `INCR` + TTL (sliding window): `INCR gemini:rpm:{minute}` before each call, check against limit. Sub-millisecond. Shared across all workers.
- Fallback: Postgres counter row with `SELECT ... FOR UPDATE` (~5ms, negligible vs 45s MCTS)

### Sequential mode compatibility

The sequential (`turnMode: "sequential"`) flow currently uses `runAISequence` inline with `advanceTurn`. Two options:
- Short term: keep as-is in the web tier (sequential games are lighter, fewer AIs, no MCTS optimal persona typically)
- Long term: move to the same job queue for consistency

---

## Layer 4: Multi-Instance Web Tier

With Layers 1-3 in place, the web tier becomes fully stateless:

- **No `doorAiInFlight`** — replaced by Postgres job queue
- **No in-process AI semaphores** — rate limiting in Redis
- **No settings cache inconsistency** — Redis is the shared cache, admin PATCH invalidates there
- **Status polls hit Redis** — MySQL load drops dramatically
- **`after()` callbacks only insert job rows** — no heavy computation

### ECS setup

```
srx-web task definition:
  image: srx ECR repo
  command: ["npx", "next", "start"]   # production server
  cpu: 512
  memory: 1024
  desired_count: 2-N

srx-web service:
  load_balancer: ALB target group
  service_discovery: web.srx.local (optional, for internal health checks)
  deployment: rolling (50% min healthy, 200% max)
```

Standard ALB routing. No sticky sessions needed — every request can hit any instance. The only shared state is MySQL + Redis, both accessible from all tasks.

### Estimated capacity

With the cache layer, each web instance handles:
- Status polls: Redis GET, ~0.1ms → network-limited (~10K req/sec per instance)
- Actions: MySQL write + Redis DEL, ~10-50ms → DB write throughput limited
- Bottleneck shifts to MySQL write throughput (hundreds of writes/sec is typical for a single RDS instance)

The existing `wind-up-birds` RDS db.t4g.small already runs puzzleboss2 — SRX as a separate database on the same instance can likely support 100+ concurrent games / 500+ connected players before needing a dedicated RDS instance or read replicas.

---

## ECS Service Summary

```mermaid
graph TB
    subgraph ecsCluster [ECS Cluster: srx]
        subgraph webService ["srx-web (desired_count: 2+)"]
            W1["Task 1: Next.js"]
            W2["Task 2: Next.js"]
        end
        subgraph aiService ["srx-ai (desired_count: 1-N)"]
            AI1["Task 1: AI Worker\n+ MCTS thread pool"]
        end
        subgraph redisService ["srx-redis (desired_count: 1)"]
            R1["Task 1: Redis 7"]
        end
    end

    ALBNode[ALB] --> W1
    ALBNode --> W2
    W1 & W2 & AI1 --> RDS["RDS MySQL\n(wind-up-birds)"]
    W1 & W2 & AI1 --> R1
```

| Service | Image | Command | CPU | Memory | Count | ALB | SD Name |
|---------|-------|---------|-----|--------|-------|-----|---------|
| srx-web | srx:latest | `next start` | 512 | 1024 | 2+ | Yes | web.srx.local |
| srx-ai | srx:latest | `node ai-worker.js` | 1024-4096 | 2048-4096 | 1-N | No | -- |
| srx-redis | redis:7-alpine | default | 256 | 512 | 1 | No | redis.srx.local |

Reuses the existing RDS MySQL instance (`wind-up-birds`), Secrets Manager for env vars, ECR for image storage — all following the same patterns as puzzleboss2-infra.

**Cost estimate (minimal):** ~$15-30/mo (2x web 512CPU, 1x AI 1024CPU, 1x Redis 256CPU). No new RDS cost — reuses existing instance. Scales linearly by adding AI tasks.

---

## Phasing

**Phase 0 — MySQL migration (prerequisite for ECS deploy, can defer for local dev):**
- Swap Prisma provider, adapter, dependencies
- Replace advisory lock with `FOR UPDATE NOWAIT` + `SessionLock` table
- Fix `Json[]` → `Json` for `GameSession.log`
- Update Docker Compose to MySQL
- Run full test suite against MySQL
- **Can be done independently** — everything else works on either database. Do this before ECS deploy since the target is the existing RDS MySQL.

**Phase 1 — Redis cache + Game State Service module:**
- Add `redis` to `docker-compose.yml`
- Create `src/lib/game-state-service.ts` wrapping MySQL reads + Redis cache-aside
- Wire into status route and leaderboard — immediate latency win on every poll
- Incrementally migrate other read paths
- **Independently deployable:** works on the laptop today, zero ECS changes needed yet

**Phase 2 — AI job queue + worker threads:**
- Add `AiTurnJob` Prisma model
- Replace `after(() => runDoorGameAITurns(...))` with job row inserts
- Build `scripts/ai-worker.ts` — polls jobs, runs MCTS in `worker_threads`, writes results
- Test locally with `docker compose` (AI worker as another service)
- **Independently deployable:** works with single web instance + single AI worker in Compose

**Phase 3 — ECS Fargate deployment:**
- Create `srx-infra` Terraform repo (or add to puzzleboss2-infra)
- Task definitions for srx-web, srx-ai, srx-redis (or ElastiCache)
- ECR, ALB, service discovery, secrets (reuse existing RDS — no new database infra)
- CI/CD via GitHub Actions (same `deploy.sh` pattern as puzzleboss2-infra)
- Scale `srx-ai` `desired_count` based on active game count

**Phase 4 — Operational maturity:**
- Grafana dashboards (MCTS throughput, job queue depth, cache hit rate, Gemini RPM)
- Auto-scaling policies (web: CPU/request count, AI: job queue depth)
- Alerting on job queue backup, Redis memory, RDS connections

Each phase is independently valuable. Phase 0 is the only prerequisite for ECS deployment (to hit the existing RDS). Phases 1-2 can be done in parallel and work on either database. Phase 3 is mostly Terraform boilerplate you've already written for puzzleboss2.
