/**
 * @dge/engine — Generic LLM (Gemini) infrastructure.
 *
 * Provides game-agnostic types, config resolution, and a single `callGeminiAPI`
 * function that games use to get a text response from the configured Gemini model.
 *
 * Games (e.g. SRX) build game-specific prompts and interpret the returned text;
 * this module handles API key resolution, concurrency limiting, timeout, and
 * retry/fallback signalling (null return = use local fallback).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getDb } from "./db-context";
import { withGeminiGeneration } from "./ai-concurrency";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Context passed to the AI move generator — who are the rivals and who am I? */
export type AIMoveContext = {
  /** This AI player's commander name (never a valid attack target). */
  commanderName: string;
  /** Other players in the same session (human + AI), excluding self. */
  rivalNames: string[];
  /**
   * Subset of rivalNames whose empires are not under protection — the only valid
   * `target` for attack_* and covert_op. Empty when every rival is protected.
   */
  rivalAttackTargets: string[];
  /** AI player's own player ID — used by MCTS to fetch rival empires. */
  playerId?: string;
  /** Session ID — used by MCTS to fetch rival empires from the same game. */
  gameSessionId?: string;
};

/** Persisted on `TurnLog.details` (via `logMeta`) for post-hoc latency analysis. */
export type AIMoveTiming = {
  configMs: number;
  /** `generateContent` only; 0 when fallback or no API call. */
  generateMs: number;
  totalMs: number;
};

export type AIMoveResult = {
  action: string;
  target?: string;
  amount?: number;
  reasoning: string;
  /** Whether the Gemini API produced the move or local rule-based fallback ran. */
  llmSource: "gemini" | "fallback";
  /** Wall-clock breakdown inside the AI move function. */
  aiTiming?: AIMoveTiming;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Config + env helpers
// ---------------------------------------------------------------------------

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;
const MAX_GEMINI_TIMEOUT_MS = 300_000;

/** When `1` or `true`, logs JSON timing lines to stdout for AI move latency. */
export function shouldLogAiTiming(): boolean {
  const v = process.env.SRX_LOG_AI_TIMING;
  return v === "1" || v === "true";
}

/**
 * Milliseconds for each Gemini API call.
 * Override with `GEMINI_TIMEOUT_MS` (min 1000, max 300000; invalid → default 60000).
 */
export function getGeminiRequestTimeoutMs(): number {
  const raw = process.env.GEMINI_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_GEMINI_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GEMINI_TIMEOUT_MS;
  return Math.min(MAX_GEMINI_TIMEOUT_MS, Math.max(1000, Math.floor(n)));
}

/** DB `SystemSettings` overrides env (`GEMINI_API_KEY` / `GEMINI_MODEL`). */
export async function resolveGeminiConfig(): Promise<{ apiKey: string | null; model: string }> {
  const row = await getDb().systemSettings.findUnique({ where: { id: "default" } });
  const key = row?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY || null;
  const model = row?.geminiModel?.trim() || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return { apiKey: key, model };
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

/** Attach timing breakdown to an AIMoveResult (mutates + returns for chaining). */
export function attachAiTiming(
  result: AIMoveResult,
  tStart: number,
  configMs: number,
  generateMs: number,
): AIMoveResult {
  result.aiTiming = {
    configMs: Math.round(configMs),
    generateMs: Math.round(generateMs),
    totalMs: Math.round(performance.now() - tStart),
  };
  return result;
}

// ---------------------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------------------

/**
 * Call the configured Gemini model with the given prompt.
 *
 * Returns `{ text, configMs, generateMs }` on success, or `null` when:
 * - No API key is configured
 * - The API key is a placeholder ("your-…")
 * - The request times out or throws
 *
 * Callers should use `null` as a signal to run their local fallback.
 * Uses the `withGeminiGeneration` semaphore to cap concurrent API calls.
 */
export async function callGeminiAPI(prompt: string): Promise<{
  text: string;
  configMs: number;
  generateMs: number;
} | null> {
  const tConfig0 = performance.now();
  let geminiCfg: { apiKey: string | null; model: string };
  try {
    geminiCfg = await resolveGeminiConfig();
  } catch {
    return null;
  }
  const configMs = performance.now() - tConfig0;

  if (!geminiCfg.apiKey || geminiCfg.apiKey.startsWith("your-")) {
    return null;
  }

  try {
    const model = new GoogleGenerativeAI(geminiCfg.apiKey).getGenerativeModel({
      model: geminiCfg.model,
      // Disable extended thinking: game move decisions don't benefit from chain-of-thought
      // reasoning, and thinking adds 15–60s latency per call (9× slower with our prompt size).
      // SDK 0.24.1 types don't include thinkingConfig yet, hence the cast.
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } } as Record<string, unknown>,
    });
    const tGen0 = performance.now();
    const result = await withGeminiGeneration(async () =>
      model.generateContent(prompt, {
        timeout: getGeminiRequestTimeoutMs(),
      }),
    );
    const generateMs = performance.now() - tGen0;
    const text = result.response.text().trim();
    return { text, configMs, generateMs };
  } catch {
    return null;
  }
}
