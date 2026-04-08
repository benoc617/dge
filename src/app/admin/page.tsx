"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { validatePasswordStrength } from "@/lib/auth";
import { AUTH } from "@/lib/game-constants";
import {
  adminApiInit,
  clearAdminCredentials,
  loadStoredAdminUsername,
  saveAdminUsername,
} from "@/lib/admin-client-storage";

export default function AdminPage() {
  const [hydrated, setHydrated] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [pwdCurrent, setPwdCurrent] = useState("");
  const [pwdNew, setPwdNew] = useState("");
  const [pwdConfirm, setPwdConfirm] = useState("");
  const [pwdLoading, setPwdLoading] = useState(false);
  const [pwdError, setPwdError] = useState("");
  const [pwdOk, setPwdOk] = useState(false);

  const [intGeminiModel, setIntGeminiModel] = useState("gemini-2.5-flash");
  const [intGeminiKey, setIntGeminiKey] = useState("");
  const [intGeminiPreview, setIntGeminiPreview] = useState("");
  const [intGeminiConfigured, setIntGeminiConfigured] = useState(false);
  const [intDoorAiDecideBatchSize, setIntDoorAiDecideBatchSize] = useState(4);
  const [intGeminiMaxConcurrent, setIntGeminiMaxConcurrent] = useState(4);
  const [intDoorAiMaxConcurrentMcts, setIntDoorAiMaxConcurrentMcts] = useState(1);
  const [intDoorAiMoveTimeoutMs, setIntDoorAiMoveTimeoutMs] = useState(60_000);
  const [intLoading, setIntLoading] = useState(false);
  const [intError, setIntError] = useState("");
  const [intOk, setIntOk] = useState(false);

  useEffect(() => {
    const u = loadStoredAdminUsername();
    if (u) setUsername(u);
    setHydrated(true);
  }, []);

  const checkMe = useCallback(async () => {
    if (!hydrated) return false;
    const res = await fetch("/api/admin/me", { credentials: "include" });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { username?: string };
      if (typeof data.username === "string") setUsername(data.username);
      setAuthed(true);
      return true;
    }
    setAuthed(false);
    return false;
  }, [hydrated]);

  useEffect(() => {
    void checkMe();
  }, [checkMe]);

  const loadIntegration = useCallback(async () => {
    const res = await fetch("/api/admin/settings", adminApiInit());
    if (!res.ok) return;
    const data = await res.json();
    setIntGeminiModel(typeof data.geminiModel === "string" ? data.geminiModel : "gemini-2.5-flash");
    setIntGeminiPreview(typeof data.geminiApiKeyPreview === "string" ? data.geminiApiKeyPreview : "");
    setIntGeminiConfigured(!!data.geminiApiKeyConfigured);
    setIntGeminiKey("");
    const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    setIntDoorAiDecideBatchSize(n(data.doorAiDecideBatchSize, 4));
    setIntGeminiMaxConcurrent(n(data.geminiMaxConcurrent, 4));
    setIntDoorAiMaxConcurrentMcts(n(data.doorAiMaxConcurrentMcts, 1));
    setIntDoorAiMoveTimeoutMs(n(data.doorAiMoveTimeoutMs, 60_000));
  }, []);

  useEffect(() => {
    if (authed) void loadIntegration();
  }, [authed, loadIntegration]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const res = await fetch(
      "/api/admin/login",
      adminApiInit({
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    );
    setLoading(false);
    if (!res.ok) {
      setError("Invalid credentials");
      return;
    }
    saveAdminUsername(username);
    setPassword("");
    setAuthed(true);
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", adminApiInit({ method: "POST" }));
    clearAdminCredentials();
    setAuthed(false);
    setUsername("");
    setPassword("");
    setPwdCurrent("");
    setPwdNew("");
    setPwdConfirm("");
    setPwdOk(false);
    setPwdError("");
    setIntOk(false);
    setIntError("");
    setPassword("");
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwdError("");
    setPwdOk(false);
    if (pwdNew !== pwdConfirm) {
      setPwdError("New passwords do not match");
      return;
    }
    const pwCheck = validatePasswordStrength(pwdNew, AUTH.PASSWORD_MIN_ADMIN);
    if (pwCheck) {
      setPwdError(pwCheck);
      return;
    }
    setPwdLoading(true);
    const res = await fetch(
      "/api/admin/password",
      adminApiInit({
        method: "POST",
        body: JSON.stringify({ currentPassword: pwdCurrent, newPassword: pwdNew }),
      }),
    );
    setPwdLoading(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPwdError(typeof data.error === "string" ? data.error : "Could not update password");
      return;
    }
    setPassword("");
    setPwdCurrent("");
    setPwdNew("");
    setPwdConfirm("");
    setPwdOk(true);
  }

  async function handleSaveIntegration(e: React.FormEvent) {
    e.preventDefault();
    setIntError("");
    setIntOk(false);
    setIntLoading(true);
    const body: Record<string, string | number> = {
      geminiModel: intGeminiModel.trim() || "gemini-2.5-flash",
      doorAiDecideBatchSize: intDoorAiDecideBatchSize,
      geminiMaxConcurrent: intGeminiMaxConcurrent,
      doorAiMaxConcurrentMcts: intDoorAiMaxConcurrentMcts,
      doorAiMoveTimeoutMs: intDoorAiMoveTimeoutMs,
    };
    if (intGeminiKey.trim()) body.geminiApiKey = intGeminiKey.trim();
    const res = await fetch(
      "/api/admin/settings",
      adminApiInit({
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
    setIntLoading(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setIntError(typeof data.error === "string" ? data.error : "Save failed");
      return;
    }
    setIntOk(true);
    await loadIntegration();
  }

  async function patchIntegration(body: Record<string, unknown>) {
    setIntError("");
    setIntOk(false);
    setIntLoading(true);
    const res = await fetch(
      "/api/admin/settings",
      adminApiInit({
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    );
    setIntLoading(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setIntError(typeof data.error === "string" ? data.error : "Update failed");
      return;
    }
    setIntOk(true);
    await loadIntegration();
  }

  if (!hydrated || authed === null) {
    return (
      <main className="min-h-screen bg-black text-green-400 font-mono flex items-center justify-center">
        <p className="text-green-700 text-sm">Loading…</p>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="min-h-screen bg-black text-green-400 font-mono flex flex-col items-center justify-center px-4">
        <h1 className="text-yellow-400 font-bold tracking-widest mb-6 text-lg">DGE ADMIN</h1>
        <form onSubmit={handleLogin} className="border border-green-800 p-6 w-full max-w-sm space-y-3">
          <label className="text-green-700 text-xs block">Username</label>
          <input
            className="w-full bg-black border border-green-700 text-green-300 px-2 py-1.5 text-sm"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <label className="text-green-700 text-xs block">Password</label>
          <input
            type="password"
            className="w-full bg-black border border-green-700 text-green-300 px-2 py-1.5 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full border border-yellow-600 py-2 text-yellow-400 hover:bg-yellow-900/20 disabled:opacity-40"
          >
            SIGN IN
          </button>
        </form>
        <Link href="/" className="mt-8 text-green-800 text-xs hover:text-green-500">
          ← Back to game
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-green-400 font-mono p-4">
      <div className="flex justify-between items-center border-b border-green-900 pb-2 mb-6">
        <h1 className="text-yellow-400 font-bold tracking-widest text-sm">DGE ADMIN</h1>
        <div className="flex gap-3 text-xs items-center">
          <Link href="/admin/game-sessions" className="text-green-500 hover:text-green-300 border border-green-800 px-2 py-0.5">
            Game Sessions
          </Link>
          <Link href="/admin/users" className="text-cyan-600 hover:text-cyan-400 border border-cyan-900 px-2 py-0.5">
            Users
          </Link>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="text-green-700 hover:text-red-400"
          >
            Log out
          </button>
          <Link href="/" className="text-green-700 hover:text-green-400">
            Game
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Change admin password */}
        <form onSubmit={handleChangePassword} className="border border-green-800 p-4 space-y-3">
          <h2 className="text-yellow-600 text-xs tracking-wider mb-2">CHANGE ADMIN PASSWORD</h2>
          <label className="text-green-700 text-xs block">Current password</label>
          <input
            type="password"
            autoComplete="current-password"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={pwdCurrent}
            onChange={(e) => setPwdCurrent(e.target.value)}
          />
          <label className="text-green-700 text-xs block">New password (min 12 characters)</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={pwdNew}
            onChange={(e) => setPwdNew(e.target.value)}
          />
          <label className="text-green-700 text-xs block">Confirm new password</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={pwdConfirm}
            onChange={(e) => setPwdConfirm(e.target.value)}
          />
          {pwdError && <p className="text-red-500 text-xs">{pwdError}</p>}
          {pwdOk && <p className="text-green-500 text-xs">Password updated. Current session updated automatically.</p>}
          <button
            type="submit"
            disabled={pwdLoading || !pwdCurrent || !pwdNew}
            className="border border-yellow-700 px-4 py-2 text-sm text-yellow-400 hover:bg-yellow-950/30 disabled:opacity-40"
          >
            UPDATE PASSWORD
          </button>
        </form>

        {/* Info panel */}
        <div className="border border-green-900 p-4 text-green-700 text-xs space-y-1">
          <p>
            Username is only set via <span className="text-green-600">ADMIN_USERNAME</span> (default admin). Password starts from{" "}
            <span className="text-green-600">INITIAL_ADMIN_PASSWORD</span> until you set one below (stored hashed in the database).
          </p>
          <p className="text-green-800 mt-2">
            After sign-in, auth is an httpOnly signed session cookie (password not stored in the browser). Scripts and tests may still use{" "}
            <span className="text-green-600">Authorization: Basic</span> instead.
          </p>
          <p className="mt-3 text-green-600">
            → <Link href="/admin/game-sessions" className="underline hover:text-green-400">Game Sessions</Link>
            {" "}to create pre-staged lobbies, manage active sessions, and delete old data.
          </p>
          <p className="text-green-600">
            → <Link href="/admin/users" className="underline hover:text-green-400">Users</Link>
            {" "}to view accounts, force password resets, and delete user records.
          </p>
        </div>
      </div>

      {/* Integration settings */}
      <div className="border border-green-900 p-4 mb-8 space-y-3">
        <h2 className="text-yellow-600 text-xs tracking-wider">INTEGRATION (GEMINI)</h2>
        <p className="text-green-700 text-xs max-w-3xl">
          <span className="text-green-600">DATABASE_URL</span> must stay in the server environment (not stored here). When set, Gemini fields override{" "}
          <span className="text-green-600">GEMINI_API_KEY</span> / <span className="text-green-600">GEMINI_MODEL</span>. Door-game AI limits override{" "}
          <span className="text-green-600">DOOR_AI_DECIDE_BATCH_SIZE</span>, <span className="text-green-600">GEMINI_MAX_CONCURRENT</span>,{" "}
          <span className="text-green-600">DOOR_AI_MAX_CONCURRENT_MCTS</span>, <span className="text-green-600">DOOR_AI_MOVE_TIMEOUT_MS</span> when a row exists.
          API keys are only shown masked below.
        </p>
        <form onSubmit={handleSaveIntegration} className="max-w-xl space-y-2 text-xs">
          <label className="text-green-700 block">Gemini model</label>
          <input
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intGeminiModel}
            onChange={(e) => setIntGeminiModel(e.target.value)}
            placeholder="gemini-2.5-flash"
          />
          <label className="text-green-700 block">Gemini API key (optional — leave blank to keep)</label>
          <input
            type="password"
            autoComplete="off"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intGeminiKey}
            onChange={(e) => setIntGeminiKey(e.target.value)}
            placeholder={intGeminiConfigured ? "••••••••" : "Paste new key to replace"}
          />
          {intGeminiConfigured && (
            <p className="text-green-600">
              Current key: <span className="text-yellow-600">{intGeminiPreview || "set"}</span>
            </p>
          )}
          <p className="text-green-700 pt-2 border-t border-green-900/80">Door-game / AI concurrency</p>
          <label className="text-green-700 block">Parallel decide batch size (1–128)</label>
          <input
            type="number"
            min={1}
            max={128}
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intDoorAiDecideBatchSize}
            onChange={(e) => setIntDoorAiDecideBatchSize(Number(e.target.value))}
          />
          <label className="text-green-700 block">Gemini max concurrent (1–64)</label>
          <input
            type="number"
            min={1}
            max={64}
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intGeminiMaxConcurrent}
            onChange={(e) => setIntGeminiMaxConcurrent(Number(e.target.value))}
          />
          <label className="text-green-700 block">Optimal / MCTS max concurrent (1–64)</label>
          <input
            type="number"
            min={1}
            max={64}
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intDoorAiMaxConcurrentMcts}
            onChange={(e) => setIntDoorAiMaxConcurrentMcts(Number(e.target.value))}
          />
          <label className="text-green-700 block">Door AI move timeout (ms, 1000–300000)</label>
          <input
            type="number"
            min={1000}
            max={300000}
            step={1000}
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={intDoorAiMoveTimeoutMs}
            onChange={(e) => setIntDoorAiMoveTimeoutMs(Number(e.target.value))}
          />
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="submit"
              disabled={intLoading}
              className="border border-green-600 px-3 py-1.5 text-green-400 hover:bg-green-950/40 disabled:opacity-40"
            >
              SAVE INTEGRATION
            </button>
            <button
              type="button"
              disabled={intLoading || !intGeminiConfigured}
              onClick={() => void patchIntegration({ geminiApiKey: null })}
              className="border border-green-900 px-3 py-1.5 text-green-600 hover:text-green-400 disabled:opacity-40"
            >
              Clear Gemini key
            </button>
          </div>
        </form>
        {intError && <p className="text-red-500 text-xs">{intError}</p>}
        {intOk && <p className="text-green-500 text-xs">Integration settings saved.</p>}
      </div>
    </main>
  );
}
