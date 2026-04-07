"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  adminApiInit,
  clearAdminCredentials,
  loadStoredAdminUsername,
  saveAdminUsername,
} from "@/lib/admin-client-storage";

type UserRow = {
  id: string;
  username: string;
  fullName: string;
  email: string;
  createdAt: string;
  lastLoginAt: string | null;
  activeGames: number;
  finishedGames: number;
  sessionsJoined: number;
  activeSummaries: {
    sessionId: string;
    galaxyName: string | null;
    playerName: string;
    turnsLeft: number;
  }[];
};

function fmtIso(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export default function AdminUsersPage() {
  const [hydrated, setHydrated] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pwUserId, setPwUserId] = useState<string | null>(null);
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

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

  const loadUsers = useCallback(async () => {
    setLoadError("");
    setLoading(true);
    const res = await fetch("/api/admin/users", adminApiInit());
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.status === 401 ? "Not signed in." : "Failed to load users.");
      return;
    }
    const data = await res.json();
    setUsers(Array.isArray(data.users) ? data.users : []);
  }, []);

  useEffect(() => {
    void checkMe();
  }, [checkMe]);

  useEffect(() => {
    if (authed) void loadUsers();
  }, [authed, loadUsers]);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setActionError("");
    if (!pwUserId) return;
    if (pwNew !== pwConfirm) {
      setActionError("Passwords do not match.");
      return;
    }
    if (pwNew.length < 8) {
      setActionError("Password must be at least 8 characters.");
      return;
    }
    setPwLoading(true);
    const res = await fetch(
      "/api/admin/users",
      adminApiInit({
        method: "PATCH",
        body: JSON.stringify({ userId: pwUserId, newPassword: pwNew }),
      }),
    );
    setPwLoading(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setActionError(typeof data.error === "string" ? data.error : "Update failed");
      return;
    }
    setPwUserId(null);
    setPwNew("");
    setPwConfirm("");
    await loadUsers();
  }

  async function handleDelete(user: UserRow) {
    setActionError("");
    const ok = confirm(
      `Delete account @${user.username} (${user.email})?\n\n` +
        `The login record will be removed. Empire data in games remains; commander rows become unlinked (legacy-style).`,
    );
    if (!ok) return;
    const res = await fetch(
      `/api/admin/users?id=${encodeURIComponent(user.id)}`,
      adminApiInit({ method: "DELETE" }),
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setActionError(typeof data.error === "string" ? data.error : "Delete failed");
      return;
    }
    await loadUsers();
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    setLoginLoading(true);
    const res = await fetch(
      "/api/admin/login",
      adminApiInit({
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    );
    setLoginLoading(false);
    if (!res.ok) {
      setLoginError("Invalid credentials");
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
    setUsers([]);
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
        <h1 className="text-yellow-400 font-bold tracking-widest mb-6 text-lg">SRX ADMIN — USERS</h1>
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
          {loginError && <p className="text-red-500 text-xs">{loginError}</p>}
          <button
            type="submit"
            disabled={loginLoading}
            className="w-full border border-yellow-600 py-2 text-yellow-400 hover:bg-yellow-900/20 disabled:opacity-40"
          >
            SIGN IN
          </button>
        </form>
        <Link href="/admin" className="mt-8 text-green-800 text-xs hover:text-green-500">
          ← Back to admin
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-green-400 font-mono p-4">
      <div className="flex justify-between items-center border-b border-green-900 pb-2 mb-4">
        <h1 className="text-yellow-400 font-bold tracking-widest text-sm">SRX ADMIN — USERS</h1>
        <div className="flex gap-3 text-xs items-center">
          <button
            type="button"
            onClick={() => void loadUsers()}
            disabled={loading}
            className="text-green-600 hover:text-green-400 disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="text-green-700 hover:text-red-400"
          >
            Log out
          </button>
          <Link href="/admin" className="text-green-700 hover:text-green-400">
            Galaxies
          </Link>
          <Link href="/" className="text-green-700 hover:text-green-400">
            Game
          </Link>
        </div>
      </div>

      <p className="text-green-700 text-xs mb-4 max-w-3xl">
        Registered commanders (<span className="text-green-600">UserAccount</span>). Last login updates on successful{" "}
        <span className="text-green-600">/api/auth/login</span> or legacy{" "}
        <span className="text-green-600">POST /api/game/status</span> when the commander is linked to an account.
      </p>

      {loadError && <p className="text-red-500 text-xs mb-2">{loadError}</p>}
      {actionError && <p className="text-red-500 text-xs mb-2">{actionError}</p>}

      {pwUserId && (
        <form
          onSubmit={handleSetPassword}
          className="border border-yellow-800 bg-yellow-950/10 p-4 mb-4 max-w-md space-y-2 text-xs"
        >
          <div className="text-yellow-500 font-bold">Set password for selected user</div>
          <label className="text-green-700 block">New password (min 8)</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1"
            value={pwNew}
            onChange={(e) => setPwNew(e.target.value)}
          />
          <label className="text-green-700 block">Confirm</label>
          <input
            type="password"
            autoComplete="new-password"
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1"
            value={pwConfirm}
            onChange={(e) => setPwConfirm(e.target.value)}
          />
          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={pwLoading || !pwNew}
              className="border border-yellow-600 text-yellow-400 px-3 py-1 hover:bg-yellow-950/30 disabled:opacity-40"
            >
              {pwLoading ? "Saving…" : "Apply password"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPwUserId(null);
                setPwNew("");
                setPwConfirm("");
                setActionError("");
              }}
              className="border border-green-900 text-green-600 px-3 py-1"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto border border-green-900">
        <table className="w-full text-xs text-left min-w-[900px]">
          <thead>
            <tr className="border-b border-green-900 text-green-700 uppercase tracking-wider">
              <th className="p-2">User</th>
              <th className="p-2">Email</th>
              <th className="p-2">Created</th>
              <th className="p-2">Last login</th>
              <th className="p-2 text-center">Active</th>
              <th className="p-2 text-center">Finished</th>
              <th className="p-2 text-center">Sessions</th>
              <th className="p-2">Active games</th>
              <th className="p-2 w-40">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-green-950 hover:bg-green-950/40 align-top">
                <td className="p-2">
                  <div className="text-green-300 font-mono">@{u.username}</div>
                  <div className="text-green-600">{u.fullName}</div>
                </td>
                <td className="p-2 text-green-500 break-all">{u.email}</td>
                <td className="p-2 text-green-700 whitespace-nowrap">{fmtIso(u.createdAt)}</td>
                <td className="p-2 text-green-700 whitespace-nowrap">{fmtIso(u.lastLoginAt)}</td>
                <td className="p-2 text-center text-cyan-300">{u.activeGames}</td>
                <td className="p-2 text-center text-green-700">{u.finishedGames}</td>
                <td className="p-2 text-center text-green-700">{u.sessionsJoined}</td>
                <td className="p-2 text-green-700 max-w-[220px]">
                  {u.activeSummaries.length === 0 ? (
                    "—"
                  ) : (
                    <ul className="list-none space-y-0.5">
                      {u.activeSummaries.map((s) => (
                        <li key={s.sessionId + s.playerName} className="truncate" title={s.sessionId}>
                          {s.galaxyName ?? "—"} · {s.playerName} · T{s.turnsLeft}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="p-2">
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setActionError("");
                        setPwUserId(u.id);
                        setPwNew("");
                        setPwConfirm("");
                      }}
                      className="border border-yellow-800 text-yellow-500 px-2 py-0.5 hover:bg-yellow-950/30 text-left"
                    >
                      Set password
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(u)}
                      className="border border-red-900 text-red-500 px-2 py-0.5 hover:bg-red-950/40 text-left"
                    >
                      Delete account
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && !loading && <p className="p-4 text-green-800 text-xs">No registered users.</p>}
      </div>
    </main>
  );
}
