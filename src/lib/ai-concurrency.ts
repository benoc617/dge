/**
 * Async semaphores for overlapping AI decisions (door-game) without unbounded
 * Gemini RPM or parallel Optimal/MCTS CPU. Caps default from env at module load;
 * `setAiConcurrencyCaps` updates them when `SystemSettings` is resolved (admin / runtime).
 */

export function parsePositiveInt(env: string | undefined, defaultVal: number): number {
  const n = Number.parseInt(String(env ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultVal;
}

/** Fixed-capacity async semaphore (used by unit tests; Gemini/MCTS use dynamic caps below). */
export function createAsyncSemaphore(maxConcurrent: number) {
  const cap = Math.max(1, maxConcurrent);
  let active = 0;
  const queue: Array<() => void> = [];
  return async function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= cap) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

const caps = {
  gemini: parsePositiveInt(process.env.GEMINI_MAX_CONCURRENT, 4),
  mcts: parsePositiveInt(process.env.DOOR_AI_MAX_CONCURRENT_MCTS, 1),
};

/**
 * Updates global Gemini / MCTS concurrency limits (called from `resolveDoorAiRuntimeSettings`).
 * Skips writes when values are unchanged (called often; avoids redundant work).
 */
export function setAiConcurrencyCaps(geminiMaxConcurrent: number, doorAiMaxConcurrentMcts: number): void {
  const g = Math.max(1, Math.min(64, Math.floor(geminiMaxConcurrent)));
  const m = Math.max(1, Math.min(64, Math.floor(doorAiMaxConcurrentMcts)));
  if (caps.gemini === g && caps.mcts === m) return;
  caps.gemini = g;
  caps.mcts = m;
}

function createDynamicSemaphore(getCap: () => number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function runWithLimit<T>(fn: () => Promise<T>): Promise<T> {
    const cap = Math.max(1, getCap());
    if (active >= cap) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** Limits concurrent Gemini `generateContent` calls (global). */
export const withGeminiGeneration = createDynamicSemaphore(() => caps.gemini);

/** Limits concurrent Optimal-persona MCTS work inside `getAIMove` (global). */
export const withMctsDecide = createDynamicSemaphore(() => caps.mcts);
