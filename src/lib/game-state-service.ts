/**
 * Cache-aside helpers for hot read paths.
 *
 * empire:{playerId}          TTL 30s — full player+empire+planets+army+supplyRates+research graph
 * leaderboard:{sessionId}    TTL 15s — ranked leaderboard array for a session
 *
 * All functions fail-open: a Redis outage silently falls back to MySQL.
 */
import { rGet, rSetEx, rDel } from "@/lib/redis";

const EMPIRE_TTL = 30;
const LEADERBOARD_TTL = 15;

function empireKey(playerId: string) {
  return `srx:empire:${playerId}`;
}
function leaderboardKey(sessionId: string) {
  return `srx:leaderboard:${sessionId}`;
}

/**
 * Cache-aside for the full player+empire graph (playerInclude query result).
 * `fetch` is called on cache miss and the result is stored for EMPIRE_TTL seconds.
 * Returns null if the player doesn't exist.
 */
export async function getCachedPlayer<T>(
  playerId: string,
  fetch: () => Promise<T | null>,
): Promise<T | null> {
  const key = empireKey(playerId);
  const cached = await rGet(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // corrupt cache entry — fall through to DB
    }
  }
  const result = await fetch();
  if (result !== null) {
    await rSetEx(key, EMPIRE_TTL, JSON.stringify(result));
  }
  return result;
}

/**
 * Cache-aside for the leaderboard array for a session.
 * `fetch` is called on cache miss.
 */
export async function getCachedLeaderboard<T>(
  sessionId: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const key = leaderboardKey(sessionId);
  const cached = await rGet(key);
  if (cached !== null) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // corrupt cache entry — fall through to DB
    }
  }
  const result = await fetch();
  await rSetEx(key, LEADERBOARD_TTL, JSON.stringify(result));
  return result;
}

/** Evict the cached empire graph for a player (call after any action that mutates empire state). */
export async function invalidatePlayer(playerId: string): Promise<void> {
  await rDel(empireKey(playerId));
}

/** Evict the cached leaderboard for a session (call after any action that changes rankings). */
export async function invalidateLeaderboard(sessionId: string): Promise<void> {
  await rDel(leaderboardKey(sessionId));
}

/** Evict both empire and leaderboard caches for a player in a session. */
export async function invalidatePlayerAndLeaderboard(
  playerId: string,
  sessionId: string | null | undefined,
): Promise<void> {
  const keys = [empireKey(playerId)];
  if (sessionId) keys.push(leaderboardKey(sessionId));
  await rDel(...keys);
}
