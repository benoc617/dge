"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AI_NAME_POOL } from "@/lib/ai-builtin-config";
import {
  adminApiInit,
  clearAdminCredentials,
  loadStoredAdminUsername,
  saveAdminUsername,
} from "@/lib/admin-client-storage";

type SessionRow = {
  id: string;
  galaxyName: string | null;
  inviteCode: string | null;
  isPublic: boolean;
  waitingForHuman: boolean;
  humanCount: number;
  aiCount: number;
  playerCount: number;
  turnStartedAt: string | null;
};

export default function AdminGameSessionsPage() {
  const [hydrated, setHydrated] = useState(false);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPublic, setNewPublic] = useState(true);
  const [selectedAI, setSelectedAI] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [createError, setCreateError] = useState("");
  const [deleteError, setDeleteError] = useState("");

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

  const loadSessions = useCallback(async () => {
    const res = await fetch("/api/admin/galaxies", adminApiInit());
    if (!res.ok) return;
    const data = await res.json();
    const list: SessionRow[] = data.galaxies ?? [];
    setSessions(list);
    setSelectedIds((prev) => {
      const next = new Set<string>();
      const ids = new Set(list.map((g) => g.id));
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    if (authed) void loadSessions();
  }, [authed, loadSessions]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
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
    setSessions([]);
    setLoginError("");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setLoading(true);
    const res = await fetch(
      "/api/admin/galaxies",
      adminApiInit({
        method: "POST",
        body: JSON.stringify({
          galaxyName: newName.trim() || undefined,
          isPublic: newPublic,
          aiNames: selectedAI.size ? Array.from(selectedAI) : undefined,
        }),
      }),
    );
    setLoading(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setCreateError(typeof data.error === "string" ? data.error : "Create failed");
      return;
    }
    setNewName("");
    setSelectedAI(new Set());
    await loadSessions();
  }

  function toggleAIName(name: string) {
    setSelectedAI((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (sessions.length === 0) return;
    const allSelected = sessions.every((g) => selectedIds.has(g.id));
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(sessions.map((g) => g.id)));
  }

  async function deleteSessions(ids: string[]) {
    if (ids.length === 0) return;
    const label =
      ids.length === 1
        ? "Delete this game session and all related data?"
        : `Delete ${ids.length} game sessions and all related data?`;
    if (!confirm(label)) return;
    setDeleteError("");
    setDeleting(true);
    const res = await fetch(
      "/api/admin/galaxies",
      adminApiInit({
        method: "DELETE",
        body: JSON.stringify({ ids }),
      }),
    );
    setDeleting(false);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setDeleteError(typeof data.error === "string" ? data.error : "Delete failed");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    await loadSessions();
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
          {loginError && <p className="text-red-500 text-xs">{loginError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full border border-yellow-600 py-2 text-yellow-400 hover:bg-yellow-900/20 disabled:opacity-40"
          >
            SIGN IN
          </button>
        </form>
        <Link href="/admin" className="mt-6 text-green-800 text-xs hover:text-green-500">
          ← Admin
        </Link>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-green-400 font-mono p-4">
      <div className="flex justify-between items-center border-b border-green-900 pb-2 mb-4">
        <h1 className="text-yellow-400 font-bold tracking-widest text-sm">DGE ADMIN — GAME SESSIONS</h1>
        <div className="flex gap-3 text-xs items-center">
          <Link href="/admin" className="text-green-700 hover:text-green-400">
            ← Admin
          </Link>
          <Link href="/admin/users" className="text-cyan-600 hover:text-cyan-400 border border-cyan-900 px-2 py-0.5">
            Users
          </Link>
          <button type="button" onClick={() => void loadSessions()} className="text-green-600 hover:text-green-400">
            Refresh
          </button>
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

      {/* Create pre-staged session form */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <form onSubmit={handleCreate} className="border border-green-800 p-4 space-y-3">
          <h2 className="text-yellow-600 text-xs tracking-wider mb-2">CREATE PRE-STAGED SESSION</h2>
          <label className="text-green-700 text-xs block">Session name (optional, min 2 chars)</label>
          <input
            className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Leave empty for unnamed"
          />
          <label className="flex items-center gap-2 text-xs text-green-600 cursor-pointer">
            <input type="checkbox" checked={newPublic} onChange={(e) => setNewPublic(e.target.checked)} />
            Public listing
          </label>
          <div className="text-green-700 text-xs">Optional AI rivals (turn 0)</div>
          <div className="flex flex-wrap gap-2">
            {AI_NAME_POOL.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => toggleAIName(name)}
                className={`text-[10px] px-2 py-1 border ${
                  selectedAI.has(name) ? "border-yellow-600 text-yellow-400" : "border-green-900 text-green-700"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          {createError && <p className="text-red-500 text-xs">{createError}</p>}
          <button
            type="submit"
            disabled={loading || (newName.length > 0 && newName.trim().length < 2)}
            className="border border-green-600 px-4 py-2 text-sm hover:bg-green-900/30 disabled:opacity-40"
          >
            CREATE SESSION
          </button>
        </form>

        <div className="border border-green-900 p-4 text-green-700 text-xs space-y-1">
          <p>Sessions stay in &quot;waiting for human&quot; until the first player joins via invite code or public list.</p>
          <p>No turn timer runs until a human activates the session.</p>
          <p className="text-green-800">
            Players join via invite code or the public lobby list. Admins can pre-populate AI opponents at session creation.
          </p>
        </div>
      </div>

      {/* Session list */}
      <div className="flex flex-wrap items-center gap-3 mb-2 text-xs">
        <button
          type="button"
          disabled={deleting || selectedIds.size === 0}
          onClick={() => void deleteSessions(Array.from(selectedIds))}
          className="border border-red-800 text-red-400 px-3 py-1.5 hover:bg-red-950/40 disabled:opacity-40"
        >
          Delete selected ({selectedIds.size})
        </button>
        {deleteError && <span className="text-red-500">{deleteError}</span>}
      </div>

      <div className="overflow-x-auto border border-green-900">
        <table className="w-full text-xs text-left">
          <thead>
            <tr className="border-b border-green-900 text-green-700 uppercase tracking-wider">
              <th className="p-2 w-10">
                <input
                  type="checkbox"
                  aria-label="Select all sessions"
                  checked={sessions.length > 0 && sessions.every((g) => selectedIds.has(g.id))}
                  onChange={toggleSelectAll}
                  className="accent-green-600"
                />
              </th>
              <th className="p-2">Session Name</th>
              <th className="p-2">Invite</th>
              <th className="p-2">Lobby</th>
              <th className="p-2">Humans</th>
              <th className="p-2">AI</th>
              <th className="p-2">Public</th>
              <th className="p-2 w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((g) => (
              <tr key={g.id} className="border-b border-green-950 hover:bg-green-950/40">
                <td className="p-2 align-middle">
                  <input
                    type="checkbox"
                    aria-label={`Select ${g.galaxyName ?? g.id}`}
                    checked={selectedIds.has(g.id)}
                    onChange={() => toggleRow(g.id)}
                    className="accent-green-600"
                  />
                </td>
                <td className="p-2 text-green-300">{g.galaxyName ?? "—"}</td>
                <td className="p-2 text-yellow-600 font-mono">{g.inviteCode ?? "—"}</td>
                <td className="p-2">{g.waitingForHuman ? <span className="text-cyan-600">WAIT</span> : "—"}</td>
                <td className="p-2">{g.humanCount}</td>
                <td className="p-2">{g.aiCount}</td>
                <td className="p-2">{g.isPublic ? "yes" : "no"}</td>
                <td className="p-2">
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() => void deleteSessions([g.id])}
                    className="text-red-500 hover:text-red-400 border border-red-900 px-2 py-0.5 disabled:opacity-40"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sessions.length === 0 && <p className="p-4 text-green-800 text-xs">No active game sessions.</p>}
      </div>
    </main>
  );
}
