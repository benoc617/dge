/**
 * @dge/engine — Cache-aside helpers for hot read paths.
 *
 * Keys follow the pattern:   {namespace}:{type}:{id}
 * e.g. srx:player:{playerId}, srx:leaderboard:{sessionId}
 *
 * All functions fail-open: a Redis outage silently falls back to the DB.
 */
import { rGet, rSetEx, rDel } from "./redis";

const PLAYER_TTL = 30;      // seconds — cached player+state graph TTL
const LEADERBOARD_TTL = 15; // seconds

function playerKey(namespace: string, playerId: string) {
  return `${namespace}:player:${playerId}`;
}
function leaderboardKey(namespace: string, sessionId: string) {
  return `${namespace}:leaderboard:${sessionId}`;
}

/**
 * Cache-aside for the full player+state graph.
 * `fetch` is called on cache miss and the result is stored for PLAYER_TTL seconds.
 * Returns null if the player doesn't exist.
 */
export async function getCachedPlayer<T>(
  namespace: string,
  playerId: string,
  fetch: () => Promise<T | null>,
): Promise<T | null> {
  const key = playerKey(namespace, playerId);
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
    await rSetEx(key, PLAYER_TTL, JSON.stringify(result));
  }
  return result;
}

/**
 * Cache-aside for the leaderboard array for a session.
 * `fetch` is called on cache miss.
 */
export async function getCachedLeaderboard<T>(
  namespace: string,
  sessionId: string,
  fetch: () => Promise<T>,
): Promise<T> {
  const key = leaderboardKey(namespace, sessionId);
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

/** Evict the cached player state graph for a player. */
export async function invalidatePlayer(namespace: string, playerId: string): Promise<void> {
  await rDel(playerKey(namespace, playerId));
}

/** Evict the cached leaderboard for a session. */
export async function invalidateLeaderboard(namespace: string, sessionId: string): Promise<void> {
  await rDel(leaderboardKey(namespace, sessionId));
}

/** Evict both player and leaderboard caches for a player in a session. */
export async function invalidatePlayerAndLeaderboard(
  namespace: string,
  playerId: string,
  sessionId: string | null | undefined,
): Promise<void> {
  const keys = [playerKey(namespace, playerId)];
  if (sessionId) keys.push(leaderboardKey(namespace, sessionId));
  await rDel(...keys);
}
