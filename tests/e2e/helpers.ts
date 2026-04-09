/**
 * E2E test helpers — talks to the running dev server via HTTP.
 * Use `npm run test:e2e` (starts Next automatically) or run `npm run dev` and `vitest run tests/e2e`.
 */

import { ACTIONS_PER_DAY } from "../../src/lib/game-constants";

export const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

/** Shared test password that meets complexity requirements (uppercase, lowercase, digit, special char). */
export const TEST_PASSWORD = "Test1ng!Pass";

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** For E2E that must hit a rival (guerrilla, etc.): clear new-empire protection on named players. */
export async function clearNewEmpireProtectionForPlayers(names: string[]) {
  const { prisma } = await import("@/lib/prisma");
  await prisma.empire.updateMany({
    where: { player: { name: { in: names } } },
    data: { isProtected: false, protectionTurns: 0 },
  });
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export async function api(path: string, options?: RequestInit) {
  const method = (options?.method ?? "GET").toUpperCase();
  const csrfHeaders = MUTATING.has(method) ? { "X-SRX-CSRF": "1" } : {};
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...csrfHeaders, ...options?.headers },
    ...options,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { _parseError: true as const, raw: text.slice(0, 500) };
    }
  }
  return { status: res.status, data };
}

export async function register(
  name: string,
  password: string,
  opts?: { galaxyName?: string; isPublic?: boolean; turnMode?: "sequential" | "simultaneous" },
) {
  return api("/api/game/register", {
    method: "POST",
    body: JSON.stringify({ name, password, ...opts }),
  });
}

export async function login(name: string, password: string) {
  return api("/api/game/status", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
}

export async function joinGame(name: string, password: string, opts: { inviteCode?: string; sessionId?: string }) {
  return api("/api/game/join", {
    method: "POST",
    body: JSON.stringify({ name, password, ...opts }),
  });
}

export async function getStatus(playerId: string) {
  return api(`/api/game/status?id=${playerId}`);
}

export async function doAction(playerName: string, action: string, params?: Record<string, unknown>) {
  return api("/api/game/action", {
    method: "POST",
    body: JSON.stringify({ playerName, action, ...params }),
  });
}

/** Like doAction but uses playerId for unambiguous dispatch (avoids cross-game name collisions). */
export async function doActionById(playerId: string, playerName: string, action: string, params?: Record<string, unknown>) {
  return api("/api/game/action", {
    method: "POST",
    body: JSON.stringify({ playerId, playerName, action, ...params }),
  });
}

/** Run the turn tick for the current player (situation report). Idempotent if already processed. */
export async function doTick(playerName: string) {
  return api("/api/game/tick", {
    method: "POST",
    body: JSON.stringify({ playerName }),
  });
}

/** Like doTick but uses playerId for unambiguous dispatch. */
export async function doTickById(playerId: string, playerName: string) {
  return api("/api/game/tick", {
    method: "POST",
    body: JSON.stringify({ playerId, playerName }),
  });
}

/**
 * Poll GET /api/game/status until predicate holds. Status polls also trigger door-game AI catch-up.
 */
export async function pollStatusUntil(
  playerId: string,
  predicate: (data: Record<string, unknown>) => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<Record<string, unknown>> {
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const intervalMs = opts?.intervalMs ?? 400;
  const start = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - start < timeoutMs) {
    const s = await getStatus(playerId);
    last = (s.data ?? {}) as Record<string, unknown>;
    if (s.status === 200 && predicate(last)) return last;
    await sleep(intervalMs);
  }
  throw new Error(`pollStatusUntil timeout after ${timeoutMs}ms; last=${JSON.stringify(last).slice(0, 800)}`);
}

/** One commander uses all daily full-turn slots (tick + end_turn each). */
export async function completeDoorDaySlots(playerName: string, slots = ACTIONS_PER_DAY) {
  for (let i = 0; i < slots; i++) {
    const t = await doTick(playerName);
    if (t.status !== 200) {
      throw new Error(`doTick failed: ${t.status} ${JSON.stringify(t.data)}`);
    }
    const e = await doAction(playerName, "end_turn");
    if (e.status !== 200) {
      throw new Error(`end_turn failed: ${e.status} ${JSON.stringify(e.data)}`);
    }
    if (!(e.data as { success?: boolean }).success) {
      throw new Error(`end_turn not success: ${JSON.stringify(e.data)}`);
    }
  }
}

export async function setupAI(names: string[], gameSessionId: string) {
  return api("/api/ai/setup", {
    method: "POST",
    body: JSON.stringify({ names, gameSessionId }),
  });
}

export async function runAI(gameSessionId: string) {
  return api("/api/ai/run-all", {
    method: "POST",
    body: JSON.stringify({ gameSessionId }),
  });
}

export async function getLobbies() {
  return api("/api/game/lobbies");
}

export async function getSession(sessionId: string) {
  return api(`/api/game/session?id=${sessionId}`);
}

export async function patchSession(sessionId: string, playerName: string, isPublic: boolean) {
  return api("/api/game/session", {
    method: "PATCH",
    body: JSON.stringify({ sessionId, playerName, isPublic }),
  });
}

/** Generate a unique name to avoid collisions between test runs */
export function uniqueName(prefix = "TestCmdr") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export function uniqueGalaxy(prefix = "TestGalaxy") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function getGameLog(playerName?: string) {
  const q = playerName ? `?player=${encodeURIComponent(playerName)}` : "";
  return api(`/api/game/log${q}`);
}

export async function getLeaderboard(playerName?: string) {
  const q = playerName ? `?player=${encodeURIComponent(playerName)}` : "";
  return api(`/api/game/leaderboard${q}`);
}

/** Like getLeaderboard but uses playerId for unambiguous session scoping. */
export async function getLeaderboardById(playerId: string) {
  return api(`/api/game/leaderboard?id=${encodeURIComponent(playerId)}`);
}

export async function getHighscores() {
  return api("/api/game/highscores");
}

export async function postGameOver(playerName: string) {
  return api("/api/game/gameover", {
    method: "POST",
    body: JSON.stringify({ playerName }),
  });
}

export async function postGameOverById(playerId: string, playerName: string) {
  return api("/api/game/gameover", {
    method: "POST",
    body: JSON.stringify({ playerId, playerName }),
  });
}

export async function getMessages(playerName: string) {
  return api(`/api/game/messages?player=${encodeURIComponent(playerName)}`);
}

export async function postMessage(fromName: string, toName: string, body: string, subject?: string) {
  return api("/api/game/messages", {
    method: "POST",
    body: JSON.stringify({ fromName, toName, body, ...(subject ? { subject } : {}) }),
  });
}

/** Build Basic auth header value for admin API calls. */
function adminBasicAuth(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASS = process.env.INITIAL_ADMIN_PASSWORD ?? "srxpass";

/** Shared fetch wrapper for admin API calls — sends Basic auth + CSRF header. */
async function adminFetch(path: string, cookie: string, options?: RequestInit) {
  const method = (options?.method ?? "GET").toUpperCase();
  const csrfHeaders = MUTATING.has(method) ? { "X-SRX-CSRF": "1" } : {};
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: cookie,
      ...csrfHeaders,
      ...options?.headers,
    },
    ...options,
  });
  return {
    status: r.status,
    data: r.headers.get("content-type")?.includes("json") ? await r.json() : null,
  };
}

export async function adminLogin(username = DEFAULT_ADMIN_USER, password = DEFAULT_ADMIN_PASS) {
  const auth = adminBasicAuth(username, password);
  const res = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, "X-SRX-CSRF": "1" },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, cookie: auth };
}

/** Run a callback with admin Basic auth credentials. */
export async function withAdminCookie<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  const { status, cookie } = await adminLogin();
  if (status !== 200 || !cookie) throw new Error(`admin login failed (${status})`);
  return fn(cookie);
}

export async function adminGalaxies(cookie: string) {
  return adminFetch("/api/admin/galaxies", cookie);
}

export async function adminCreateGalaxy(
  cookie: string,
  body: { galaxyName?: string; isPublic?: boolean; aiNames?: string[] },
) {
  return adminFetch("/api/admin/galaxies", cookie, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function adminDeleteGalaxies(cookie: string, ids: string[]) {
  return adminFetch("/api/admin/galaxies", cookie, {
    method: "DELETE",
    body: JSON.stringify({ ids }),
  });
}

/** Remove E2E game sessions via admin API (default admin / srxpass). No-op if login fails. */
export async function deleteTestGalaxySessions(sessionIds: string[]): Promise<void> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (ids.length === 0) return;
  const { status, cookie } = await adminLogin();
  if (status !== 200 || !cookie) return;
  try {
    await adminDeleteGalaxies(cookie, ids);
  } finally {
    await adminLogout(cookie);
  }
}

export async function deleteTestGalaxySession(sessionId: string | undefined | null): Promise<void> {
  if (!sessionId) return;
  await deleteTestGalaxySessions([sessionId]);
}

let pendingGalaxyDeletes: string[] = [];

/** Queue a session for deletion after the current test (see `tests/e2e/setup.ts` + `flushScheduledTestGalaxyDeletions`). */
export function scheduleTestGalaxyDeletion(sessionId: string | undefined | null) {
  if (sessionId) pendingGalaxyDeletes.push(sessionId);
}

export async function flushScheduledTestGalaxyDeletions(): Promise<void> {
  const ids = [...new Set(pendingGalaxyDeletes)];
  pendingGalaxyDeletes = [];
  await deleteTestGalaxySessions(ids);
}

/**
 * Remove `UserAccount` rows created during E2E (signup). Unlinks `Player.userId` first so FK is satisfied.
 * Uses Prisma (same process as the app under test — run E2E against a server that shares this DB).
 */
export async function deleteTestUserAccountsByUsernames(usernames: string[]): Promise<void> {
  const normalized = [...new Set(usernames.map((u) => u.trim().toLowerCase()).filter(Boolean))];
  if (normalized.length === 0) return;
  const { prisma } = await import("@/lib/prisma");
  const accounts = await prisma.userAccount.findMany({
    where: { username: { in: normalized } },
    select: { id: true },
  });
  for (const { id } of accounts) {
    await prisma.player.updateMany({ where: { userId: id }, data: { userId: null } });
    await prisma.userAccount.delete({ where: { id } }).catch((e: Error) => console.warn(`[cleanup] failed to delete user ${id}:`, e.message));
  }
}

let pendingUserDeletes: string[] = [];

/** Queue a username for `UserAccount` deletion after the current test (runs after galaxy flush). */
export function scheduleTestUserDeletion(username: string | undefined | null) {
  if (username) pendingUserDeletes.push(username.trim().toLowerCase());
}

export async function flushScheduledTestUserDeletions(): Promise<void> {
  const names = [...new Set(pendingUserDeletes)];
  pendingUserDeletes = [];
  await deleteTestUserAccountsByUsernames(names);
}

export async function adminLogout(cookie: string) {
  const r = await fetch(`${BASE}/api/admin/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: cookie,
      "X-SRX-CSRF": "1",
    },
  });
  return { status: r.status };
}

export async function adminChangePassword(cookie: string, currentPassword: string, newPassword: string) {
  return adminFetch("/api/admin/password", cookie, {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

/** Clears DB-stored admin password so login uses `INITIAL_ADMIN_PASSWORD` env only. For E2E isolation. */
export async function resetAdminPasswordOverride() {
  const { prisma } = await import("@/lib/prisma");
  await prisma.adminSettings.deleteMany();
}

/** Clears `SystemSettings` row so integration tests start from env-only. */
export async function resetSystemSettings() {
  const { prisma } = await import("@/lib/prisma");
  await prisma.systemSettings.deleteMany();
}

/**
 * Re-seed `SystemSettings` from environment variables.
 * Call in afterEach/afterAll after a test that wipes SystemSettings, so
 * manually-configured Gemini keys survive the test run.
 */
export async function restoreSystemSettingsFromEnv() {
  const key = process.env.GEMINI_API_KEY?.trim();
  const model = (process.env.GEMINI_MODEL ?? "gemini-2.5-flash").trim();
  const { prisma } = await import("@/lib/prisma");
  if (!key) {
    // No key to restore — just reset test-mode AI flags if a row exists.
    await prisma.systemSettings.updateMany({
      where: { id: "default" },
      data: { mctsBudgetMs: null, compactAiPrompt: false, doorAiMoveTimeoutMs: 60_000 },
    });
    return;
  }
  await prisma.systemSettings.upsert({
    where: { id: "default" },
    create: { id: "default", geminiApiKey: key, geminiModel: model },
    update: { geminiApiKey: key, geminiModel: model, mctsBudgetMs: null, compactAiPrompt: false, doorAiMoveTimeoutMs: 60_000 },
  });
}

export async function adminGetSettings(cookie: string) {
  return adminFetch("/api/admin/settings", cookie);
}

export async function adminPatchSettings(cookie: string, body: Record<string, unknown>) {
  return adminFetch("/api/admin/settings", cookie, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function adminListUsers(cookie: string) {
  return adminFetch("/api/admin/users", cookie);
}

export async function adminSetUserPassword(cookie: string, userId: string, newPassword: string) {
  return adminFetch("/api/admin/users", cookie, {
    method: "PATCH",
    body: JSON.stringify({ userId, newPassword }),
  });
}

export async function adminDeleteUser(cookie: string, userId: string) {
  return adminFetch(`/api/admin/users?id=${encodeURIComponent(userId)}`, cookie, {
    method: "DELETE",
  });
}

export async function adminGetLogs(cookie: string) {
  return adminFetch("/api/admin/logs", cookie);
}

export async function adminPurgeLogs(cookie: string, sessionId: string, force = false) {
  return adminFetch("/api/admin/logs", cookie, {
    method: "DELETE",
    body: JSON.stringify({ sessionId, force }),
  });
}

/**
 * Set AI settings optimised for fast E2E test runs: short MCTS budget + compact prompts.
 * Call in beforeAll for AI-heavy tests; restore with restoreSystemSettingsFromEnv in afterAll.
 */
export async function setFastAiTestSettings(): Promise<void> {
  const { cookie } = await adminLogin();
  if (!cookie) return;
  await adminPatchSettings(cookie, {
    mctsBudgetMs: 5000,
    compactAiPrompt: true,
    doorAiMoveTimeoutMs: 15_000,
  });
}

// --- Multiplayer test setup helpers ---

/** Register a galaxy and have a second player join. Returns player IDs and session ID. */
export async function setupTwoPlayerGame(
  p1Prefix = "P1",
  p2Prefix = "P2",
  opts?: { password?: string; turnMode?: "sequential" | "simultaneous" },
) {
  const galaxy = uniqueGalaxy("MPTest");
  const p1Name = uniqueName(p1Prefix);
  const p2Name = uniqueName(p2Prefix);
  const pwd = opts?.password ?? TEST_PASSWORD;

  const reg = await register(p1Name, pwd, { galaxyName: galaxy, isPublic: false, turnMode: opts?.turnMode });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.data)}`);
  const regData = reg.data as { id: string; gameSessionId: string; inviteCode: string };

  const join = await joinGame(p2Name, pwd, { inviteCode: regData.inviteCode });
  if (join.status !== 201) throw new Error(`join failed: ${join.status} ${JSON.stringify(join.data)}`);
  const joinData = join.data as { id: string };

  return {
    p1Name,
    p2Name,
    p1Id: regData.id,
    p2Id: joinData.id,
    sessionId: regData.gameSessionId,
    inviteCode: regData.inviteCode,
    galaxy,
  };
}

// --- Status response type for E2E assertions ---

export interface StatusResponse {
  isYourTurn?: boolean;
  currentTurnPlayer?: string;
  turnMode?: string;
  turnOpen?: boolean;
  fullTurnsLeftToday?: number;
  dayNumber?: number;
  actionsPerDay?: number;
  canAct?: boolean;
  roundEndsAt?: string;
  turnDeadline?: string;
  empire?: Record<string, unknown>;
  turnsLeft?: number;
  turnsPlayed?: number;
  [key: string]: unknown;
}
