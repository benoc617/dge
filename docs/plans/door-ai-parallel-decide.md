# Plan: Parallel `getAIMove` / `getAIMoveDecision` for door-game AI drain

**Status:** Implemented — batched parallel decide is **always on** (fixed **`DOOR_AI_DECIDE_BATCH_SIZE`** **4** in `door-game-turns.ts`); no env toggle.  
**Owner:** Engineering  
**Last updated:** 2026-04-08

---

## 1. Executive summary

**Problem:** In simultaneous (door-game) mode, the server drains AI full turns one at a time. Each iteration awaits **`getAIMoveDecision`** (Gemini API calls and/or up to **45s** MCTS for Optimal), then applies the move. Total wall time scales roughly as **sum of AI latencies**, so a session with several AIs feels sluggish even though moves are independent at the “thinking” layer.

**Proposal:** Keep **one commit stream per galaxy** (unchanged), but **overlap** the expensive **decision** phase: for a controlled batch of AI players, run **`getAIMoveDecision` in parallel**, then **apply** results **strictly in order** (same fairness ordering as today: fewest `fullTurnsUsedThisRound`, then `turnOrder`).

**Non-goals (this plan):** Parallel `processAction` for the same session; changing Gemini/MCTS algorithms; removing the session advisory lock on HTTP routes.

---

## 2. Current architecture (reference)

| Piece | Location | Role |
|--------|----------|------|
| AI drain loop | `src/lib/door-game-turns.ts` — `drainDoorGameAiTurns`, `runDoorGameAITurns` | Picks next AI (`findFirst` with `fullTurnsUsedThisRound` asc, `turnOrder` asc), calls `runOneDoorGameAI`, repeats until no one owes slots or guard hits. |
| Per-AI step | `runOneDoorGameAI` | `openFullTurn` if needed → `getAIMoveDecision` (with 60s timeout) → `processAiMoveOrSkip` / `end_turn` / `closeFullTurn`. |
| Decision only | `src/lib/ai-runner.ts` — `getAIMoveDecision` | DB load player + `buildAIMoveContext` (rivals, events) → `getAIMove` (Gemini / MCTS / fallback). |
| LLM / search | `src/lib/gemini.ts` — `getAIMove` | Personas, Optimal bypass, MCTS time budget, etc. |
| Serialize drain | `doorAiInFlight` Map | One in-flight `drainDoorGameAiTurns` promise per `sessionId`. |

**Bottleneck:** `await getAIMoveDecision` is sequential; **`processAction`** is already necessarily sequential for correctness.

---

## 3. Goals and success criteria

1. **Latency:** Wall-clock time for “all AIs that owe exactly one slot in a wave” to **decide** moves drops toward **max(decide_i)** instead of **sum(decide_i)** (subject to concurrency caps).
2. **Correctness:** No double commits; no violation of existing door-game invariants; invalid moves still handled via `processAiMoveOrSkip` / skip path.
3. **Safety:** Bounded parallelism (memory, CPU, Gemini RPM, MCTS CPU); feature flag to disable.
4. **Observability:** Logs/metrics to compare serial vs parallel paths in production.

---

## 4. Design overview

### 4.1 Core idea: “wave = parallel decide, serial apply”

Within one **wave**:

1. **Select batch** — A set of AI `playerId`s eligible for the next **decision** in this drain iteration (see §5).
2. **Prepare** — For each member: ensure a full turn is **open** (`openFullTurn` if `!turnOpen`). *Must be defined whether this is sequential or parallel across empires* (§5.2).
3. **Decide (parallel)** — `Promise.all` over **wrapped** `getAIMoveDecision(id)` with **per-player** timeout (same semantics as today’s `DOOR_AI_MOVE_TIMEOUT_MS`).
4. **Apply (serial)** — In a **fixed order** (§5.3), for each `(playerId, move | null)`: reuse the **existing** tail of `runOneDoorGameAI` (timeout → `end_turn` + `closeFullTurn`; else `processAiMoveOrSkip` / `closeFullTurn` as today).

### 4.2 Staleness / snapshot semantics

Parallel `getAIMoveDecision` calls each read the DB **around the same time**; **apply** order changes **global** state (market, events, other empires’ visibility in `GameEvent` tails, etc.).

**Declared semantics (v1):** Decisions are **best-effort** against a **pre-apply snapshot** for that wave; **apply order** is deterministic. Later AIs in the wave may have chosen moves that are **suboptimal or invalid** once earlier AIs commit — **invalid** outcomes are already handled by existing skip/`end_turn` logic.

**Optional v2 (later):** Single consistent read snapshot (transaction `READ ONLY` or explicit `updatedAt` check) for all players in the wave; or shrink batch size to 1 when strict consistency is required.

### 4.3 Relationship to fairness ordering

Today’s **`findFirst`** ordering (`fullTurnsUsedThisRound` asc, `turnOrder` asc) **must** be preserved for **apply** order. **Batch selection** should be a **prefix** of that ordering among eligible AIs, or the **same** ordering applied to the chosen batch so **apply** never inverts fairness.

---

## 5. Detailed design

### 5.1 Batch selection algorithm

**Inputs:** `sessionId`, `actionsPerDay` from session.

**Eligible AI:** `isAI === true`, `empire.turnsLeft > 0`, `empire.fullTurnsUsedThisRound < actionsPerDay`.

**Sort key:** `(fullTurnsUsedThisRound ASC, turnOrder ASC)` — same as current `findFirst` ordering.

**Batch contents:**

- **Batch size:** Fixed **`DOOR_AI_DECIDE_BATCH_SIZE`** (**4**) in code. Take the **first N** eligible players in sort order.

- **Option B:** All eligible players in one wave — **risky** for Gemini rate limits and CPU.

**Readiness for `getAIMove`:**

- If `turnOpen === false`: must run **`openFullTurn`** first (tick + set `turnOpen`).
- If `turnOpen === true`: only **`getAIMoveDecision`** (continuation of same full turn).

**MVP simplification:** First implementation only batches AIs that **already have `turnOpen === true`** (mid–full-turn). Second pass or next wave handles those who needed `openFullTurn` — **or** run **`openFullTurn` sequentially for all batch members** before **parallel decide** (see §5.2).

### 5.2 `openFullTurn` ordering

`openFullTurn` **writes** per empire (tick, `turnOpen`). Likely **no cross-empire row conflicts** if each targets a different `playerId`/`empireId`. **Plan:** Run **sequentially** in `turnOrder` (or batch sort order) **first** to minimize risk; **profile** and consider parallel `openFullTurn` only after tests prove no deadlocks or lock contention.

### 5.3 Apply order

**Strict:** Same order as batch selection — **sorted** `(fullTurnsUsedThisRound, turnOrder)` at **wave start**. Re-sort after each apply **if** state changes who is “next” — **simpler:** do **not** re-sort mid-wave; **one wave** = fixed list; after each apply, **re-run** outer drain loop for the next wave (existing `while` loop).

### 5.4 Timeouts

- Preserve **`DOOR_AI_MOVE_TIMEOUT_MS`** (60s) per player **around** `getAIMoveDecision` in parallel (each promise races its own timer).
- **Optional:** Slightly lower per-player timeout when parallelizing to cap worst-case wave time (e.g. `min(60_000, 90_000 / batchSize)` — **only if** product agrees).

### 5.5 Concurrency limits inside `getAIMove`

| Risk | Mitigation |
|------|------------|
| Gemini RPM/TPM | Wrap `getAIMove` (or only Gemini path) with **`p-limit`** or semaphore; env **`GEMINI_MAX_CONCURRENT`** (e.g. **3**). |
| Multiple Optimal MCTS | Env **`DOOR_AI_MAX_CONCURRENT_MCTS`** (e.g. **1**) — queue MCTS; allow parallel Gemini for others. |
| CPU saturation | Cap batch size `N`; optional **priority** queue: Optimal last in batch if we want to reduce parallel MCTS. |

**Implementation note:** `getAIMove` is inside `gemini.ts`; door-game may pass **context** or use a **global** (async local) semaphore — **prefer** explicit **options** passed from `door-game-turns` into a thin wrapper in `ai-runner` to avoid hidden globals.

### 5.6 Feature flag

- **Removed:** always use batched parallel decide + serial apply (no env toggle).

### 5.7 Refactor prerequisites (code structure)

1. **`extractApplyDoorGameAIMove`** — From `runOneDoorGameAI`, extract everything **after** `getAIMoveDecision` returns (including `null` / timeout handling) into **`applyDoorGameAIMove(playerId, move | null, sessionId, actionsPerDay)`** (or pass `move` + `precomputed sessionId`).

2. **`extractDecideDoorGameAIMove`** — **`openFullTurn` if needed** + **`getAIMoveDecision`** + timeout → returns `move | null` + metadata for logging.

3. **`runOneDoorGameAI`** — Becomes **`await decide…` + `await apply…`** (serial path) for parity tests.

4. **`drainWaveParallelDecide`** — New internal function used when flag **`1`**: `collectBatch` → `sequentialOpens` → `Promise.all(decides)` → `sequentialApply`.

---

## 6. Edge cases

| Case | Handling |
|------|----------|
| `getAIMoveDecision` throws | Catch per player; treat as **`null`** (same as timeout) → `end_turn` + `closeFullTurn` if policy matches today. |
| Partial batch failure | Each player independent; others still apply. |
| `tryRollRound` / day roll mid-drain | **Call `tryRollRound`** at **start of each outer loop iteration** (as today). If wave crosses day boundary — **define:** **abort wave** after apply if session state changed, or **only** run waves from **consistent** pre-`tryRollRound` snapshot — **v1:** run `tryRollRound` before batch collection; **re-fetch** eligibility after each full **serial** apply path if needed (today’s loop already re-reads). |
| Guard `500` | Keep; **decrement** guard by **batch size** or **1** — **define:** prefer **+1 per wave** (one wave = one iteration) to avoid **500 × batch** explosions. |
| **doorAiInFlight** | Unchanged; still one drain at a time per session. |

---

## 7. Testing strategy

### 7.1 Unit tests (`tests/unit/`)

- **Ordering helper** (if extracted): given mock empires, batch order matches `(fullTurnsUsedThisRound, turnOrder)`.
- **Apply with null move** — `applyDoorGameAIMove` matches current `runOneDoorGameAI` behavior (mock DB or pure function where possible).

### 7.2 Integration / E2E (`tests/e2e/door-game.test.ts`)

- **Default (parallel decide off):** Human + one AI; human + **two** AIs — calendar day rolls, all AIs reach `turnsPlayed >= actionsPerDay` on the leaderboard.
- E2E always exercises the batched drain (`docker:test:e2e`).

### 7.3 Manual / staging

- Load test with **4 AIs**, Optimal + 3 Gemini; compare logs **serial vs parallel** wall time.

---

## 8. Observability

- **Structured log** per wave: `sessionId`, `batchSize`, `playerIds`, `parallelDecideMs`, `serialApplyMs`, `flagOn`.
- Extend **`SRX_LOG_AI_TIMING`** (if present) with **`doorWave`** event.

---

## 9. Documentation updates (when implemented)

| File | Change |
|------|--------|
| `GAME-SPEC.md` | Door-game §AI: parallel **decide**, serial **apply**; staleness semantics one short paragraph. |
| `CLAUDE.md` | `door-game-turns` bullet: flag name + batch behavior. |
| `README.md` | Optional env vars under Docker / env section. |

---

## 10. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Gemini **429** / rate limits | **p-limit** + backoff (optional); reduce batch size. |
| **Harder debugging** (race-y logs) | Wave IDs in logs; flag off in prod until stable. |
| **MCTS** pegs CPU | Cap concurrent MCTS = 1; lower Optimal budget or exclude from batch (serial Optimal only). |
| **Prisma** connection pool exhaustion | Batch cap N; monitor pool metrics. |

---

## 11. Rollout plan

| Phase | Deliverable |
|-------|-------------|
| **0** | This document reviewed + agreed. |
| **1** | Refactor: `decide` + `apply` split; **`runOneDoorGameAI`** = serial compose; **all tests green**, flag **off**. |
| **2** | Implement `drainWaveParallelDecide` behind **`DOOR_AI_PARALLEL_DECIDE=1`**; unit tests for ordering + apply. |
| **3** | Concurrency limits (Gemini + MCTS); env docs. |
| **4** | E2E with flag on; staging soak. |
| **5** | Default flag on **or** keep default off until measured. |

---

## 12. Open questions (resolve before or during Phase 2)

1. **Batch size default** — `4` vs `8`?
2. **Optimal in batch** — Always **serial** MCTS only, or allow parallel with **1** cap?
3. **`openFullTurn`** — **Sequential only** in v1, or **parallel** after validation?
4. **Guard counter** — Increment per wave vs per AI (§6)?
5. Should `tryRollRound` run **between** each apply in a wave, or only **between** waves?

---

## 13. Checklist (implementation)

- [x] Extract `applyDoorGameAIMove` / `decideDoorGameAIMove` (or equivalent names).
- [x] Serial-only drain removed; single path only.
- [x] Batch collection + sort order matches §5.1.
- [x] `Promise.all` + per-player timeout (same as serial).
- [x] Serial apply loop + existing `closeFullTurn` / `tryRollRound` interaction.
- [x] `GEMINI_MAX_CONCURRENT` / `DOOR_AI_MAX_CONCURRENT_MCTS` in `ai-concurrency.ts` + `gemini.ts`.
- [x] `doorWave` logs when `SRX_LOG_AI_TIMING` is set.
- [x] Unit tests (`tests/unit/door-game-ai-parallel.test.ts`); E2E unchanged (parallel off by default).
- [x] GAME-SPEC / CLAUDE / README env updates.

---

## 14. References

- `src/lib/door-game-turns.ts` — `drainDoorGameAiTurns`, `runOneDoorGameAI`
- `src/lib/ai-runner.ts` — `getAIMoveDecision`, `buildAIMoveContext`
- `src/lib/gemini.ts` — `getAIMove`, Optimal / MCTS
- `src/lib/db-context.ts` — `withCommitLock` (HTTP routes; drain uses `getDb()` directly)
