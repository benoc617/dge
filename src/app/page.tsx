"use client";

import { useState } from "react";
import EmpirePanel from "@/components/EmpirePanel";
import ActionPanel from "@/components/ActionPanel";
import EventLog from "@/components/EventLog";

interface Planet {
  id: string;
  name: string;
  sector: number;
  population: number;
  ore: number;
  food: number;
  defenses: number;
}

interface Empire {
  credits: number;
  ore: number;
  food: number;
  fuel: number;
  fighters: number;
  transports: number;
  warships: number;
  turnsLeft: number;
  planets: Planet[];
}

export default function Home() {
  const [playerName, setPlayerName] = useState("");
  const [inputName, setInputName] = useState("");
  const [empire, setEmpire] = useState<Empire | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function register() {
    setLoading(true);
    setError("");
    const res = await fetch("/api/game/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: inputName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Registration failed");
    } else {
      setPlayerName(inputName);
      setEmpire(data.empire);
      addEvent(`Welcome, Commander ${inputName}! Your empire awaits.`);
    }
    setLoading(false);
  }

  async function login() {
    setLoading(true);
    setError("");
    const res = await fetch(`/api/game/status?player=${encodeURIComponent(inputName)}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Player not found");
    } else {
      setPlayerName(inputName);
      setEmpire(data.empire);
      addEvent(`Welcome back, Commander ${inputName}.`);
    }
    setLoading(false);
  }

  async function refreshEmpire() {
    const res = await fetch(`/api/game/status?player=${encodeURIComponent(playerName)}`);
    const data = await res.json();
    if (res.ok) setEmpire(data.empire);
  }

  function addEvent(msg: string) {
    setEvents((prev) => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev.slice(0, 49)]);
  }

  async function handleAction(action: string, params?: { target?: string; amount?: number }) {
    const res = await fetch("/api/game/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName, action, ...params }),
    });
    const data = await res.json();
    addEvent(data.message ?? data.error);
    await refreshEmpire();
  }

  if (!playerName) {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold tracking-widest text-yellow-400 mb-2">
            ★ SOLAR REALMS EXTREME ★
          </h1>
          <p className="text-green-600 text-sm tracking-widest">CONQUER THE GALAXY</p>
        </div>

        <div className="border border-green-700 p-8 w-96 bg-black/80">
          <input
            className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 mb-4 outline-none focus:border-yellow-400"
            placeholder="Commander name..."
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={login}
              disabled={loading || !inputName}
              className="flex-1 border border-green-600 py-2 hover:bg-green-900 disabled:opacity-40"
            >
              LOGIN
            </button>
            <button
              onClick={register}
              disabled={loading || !inputName}
              className="flex-1 border border-yellow-600 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400"
            >
              NEW GAME
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-green-400 font-mono p-4">
      <header className="border-b border-green-800 pb-2 mb-4 flex justify-between items-center">
        <h1 className="text-yellow-400 font-bold tracking-widest">★ SOLAR REALMS EXTREME ★</h1>
        <span className="text-green-600 text-sm">Commander: {playerName}</span>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          {empire && <EmpirePanel empire={empire} />}
        </div>
        <div className="lg:col-span-1">
          <ActionPanel onAction={handleAction} />
        </div>
        <div className="lg:col-span-1">
          <EventLog events={events} />
        </div>
      </div>
    </main>
  );
}
