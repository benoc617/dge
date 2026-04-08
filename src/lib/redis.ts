/**
 * Singleton ioredis client — fail-open throughout.
 * When REDIS_URL is unset or Redis is unreachable, all helpers return null/undefined
 * and callers fall through to MySQL without errors.
 */
import Redis from "ioredis";

type RedisOrNull = Redis | null;

const g = globalThis as unknown as { _srxRedis?: RedisOrNull };

function createClient(): RedisOrNull {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 2000,
    });
    // Suppress "unhandled error" events so a Redis outage doesn't crash Next.js.
    client.on("error", () => {});
    return client;
  } catch {
    return null;
  }
}

export function getRedis(): RedisOrNull {
  if (g._srxRedis === undefined) {
    g._srxRedis = createClient();
  }
  return g._srxRedis;
}

/** Get a cached string value. Returns null on miss or error. */
export async function rGet(key: string): Promise<string | null> {
  try {
    return (await getRedis()?.get(key)) ?? null;
  } catch {
    return null;
  }
}

/** Set a key with a TTL in seconds. Fire-and-forget on error. */
export async function rSetEx(key: string, ttlSecs: number, value: string): Promise<void> {
  try {
    await getRedis()?.setex(key, ttlSecs, value);
  } catch {
    // fail open
  }
}

/** Delete one or more keys. Fire-and-forget on error. */
export async function rDel(...keys: string[]): Promise<void> {
  if (!keys.length) return;
  try {
    await getRedis()?.del(...keys);
  } catch {
    // fail open
  }
}
