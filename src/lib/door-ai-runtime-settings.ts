import { getDb } from "./db-context";
import { setAiConcurrencyCaps } from "./ai-concurrency";

/** Defaults when no DB row and no env (match prior hardcoded constants). */
export const DEFAULT_DOOR_AI_DECIDE_BATCH_SIZE = 4;
export const DEFAULT_GEMINI_MAX_CONCURRENT = 4;
export const DEFAULT_DOOR_AI_MAX_CONCURRENT_MCTS = 1;
export const DEFAULT_DOOR_AI_MOVE_TIMEOUT_MS = 60_000;

/** Valid ranges for admin PATCH and env fallbacks (single source of truth). */
export const DOOR_AI_ADMIN_LIMITS = {
  doorAiDecideBatchSize: { min: 1, max: 128 },
  geminiMaxConcurrent: { min: 1, max: 64 },
  doorAiMaxConcurrentMcts: { min: 1, max: 64 },
  doorAiMoveTimeoutMs: { min: 1000, max: 300_000 },
} as const;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Parse JSON body field for admin PATCH (number or numeric string). */
export function parseAdminDoorAiInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return clampInt(raw, min, max);
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return clampInt(n, min, max);
  }
  return fallback;
}

export type EffectiveDoorAiSettings = {
  doorAiDecideBatchSize: number;
  geminiMaxConcurrent: number;
  doorAiMaxConcurrentMcts: number;
  doorAiMoveTimeoutMs: number;
};

/** Prisma `SystemSettings` shape for door AI ints (nullable row uses env + defaults). */
export type SystemSettingsDoorAiRow = {
  doorAiDecideBatchSize: number;
  geminiMaxConcurrent: number;
  doorAiMaxConcurrentMcts: number;
  doorAiMoveTimeoutMs: number;
} | null;

/**
 * Effective door-game / Gemini concurrency settings: DB row wins when present, else env, else defaults.
 * Use for admin GET and for sync helpers; does not update semaphores.
 */
export function getEffectiveDoorAiSettings(row: SystemSettingsDoorAiRow): EffectiveDoorAiSettings {
  const L = DOOR_AI_ADMIN_LIMITS;
  if (row) {
    return {
      doorAiDecideBatchSize: clampInt(
        row.doorAiDecideBatchSize,
        L.doorAiDecideBatchSize.min,
        L.doorAiDecideBatchSize.max,
      ),
      geminiMaxConcurrent: clampInt(
        row.geminiMaxConcurrent,
        L.geminiMaxConcurrent.min,
        L.geminiMaxConcurrent.max,
      ),
      doorAiMaxConcurrentMcts: clampInt(
        row.doorAiMaxConcurrentMcts,
        L.doorAiMaxConcurrentMcts.min,
        L.doorAiMaxConcurrentMcts.max,
      ),
      doorAiMoveTimeoutMs: clampInt(
        row.doorAiMoveTimeoutMs,
        L.doorAiMoveTimeoutMs.min,
        L.doorAiMoveTimeoutMs.max,
      ),
    };
  }
  return {
    doorAiDecideBatchSize: clampInt(
      parsePositiveInt(process.env.DOOR_AI_DECIDE_BATCH_SIZE, DEFAULT_DOOR_AI_DECIDE_BATCH_SIZE),
      L.doorAiDecideBatchSize.min,
      L.doorAiDecideBatchSize.max,
    ),
    geminiMaxConcurrent: clampInt(
      parsePositiveInt(process.env.GEMINI_MAX_CONCURRENT, DEFAULT_GEMINI_MAX_CONCURRENT),
      L.geminiMaxConcurrent.min,
      L.geminiMaxConcurrent.max,
    ),
    doorAiMaxConcurrentMcts: clampInt(
      parsePositiveInt(
        process.env.DOOR_AI_MAX_CONCURRENT_MCTS,
        DEFAULT_DOOR_AI_MAX_CONCURRENT_MCTS,
      ),
      L.doorAiMaxConcurrentMcts.min,
      L.doorAiMaxConcurrentMcts.max,
    ),
    doorAiMoveTimeoutMs: clampInt(
      parsePositiveInt(process.env.DOOR_AI_MOVE_TIMEOUT_MS, DEFAULT_DOOR_AI_MOVE_TIMEOUT_MS),
      L.doorAiMoveTimeoutMs.min,
      L.doorAiMoveTimeoutMs.max,
    ),
  };
}

/** In-process cache so `getAIMove` / door-game drain do not hit Prisma on every call. */
const RESOLVE_CACHE_TTL_MS = 60_000;
let resolveCache: { expiresAt: number; value: EffectiveDoorAiSettings } | null = null;

/** Call from admin PATCH so new caps apply immediately (same process). */
export function invalidateDoorAiRuntimeCache(): void {
  resolveCache = null;
}

/**
 * Loads `SystemSettings`, applies clamps, refreshes Gemini/MCTS semaphore caps.
 * Cached ~60s to avoid a DB round-trip on every AI move; invalidated on admin settings PATCH.
 */
export async function resolveDoorAiRuntimeSettings(): Promise<EffectiveDoorAiSettings> {
  const now = Date.now();
  if (resolveCache && resolveCache.expiresAt > now) {
    return resolveCache.value;
  }

  const row = await getDb().systemSettings.findUnique({
    where: { id: "default" },
    select: {
      doorAiDecideBatchSize: true,
      geminiMaxConcurrent: true,
      doorAiMaxConcurrentMcts: true,
      doorAiMoveTimeoutMs: true,
    },
  });
  const eff = getEffectiveDoorAiSettings(row);
  setAiConcurrencyCaps(eff.geminiMaxConcurrent, eff.doorAiMaxConcurrentMcts);
  resolveCache = { expiresAt: now + RESOLVE_CACHE_TTL_MS, value: eff };
  return eff;
}
