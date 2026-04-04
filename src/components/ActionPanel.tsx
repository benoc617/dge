"use client";

import { useState } from "react";

interface Props {
  onAction: (action: string, params?: { target?: string; amount?: number }) => void;
}

export default function ActionPanel({ onAction }: Props) {
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");

  function act(action: string) {
    onAction(action, {
      target: target || undefined,
      amount: amount ? parseInt(amount) : undefined,
    });
  }

  const actions = [
    { id: "mine_ore", label: "Mine Ore", color: "border-green-600 hover:bg-green-900" },
    { id: "grow_food", label: "Grow Food", color: "border-green-600 hover:bg-green-900" },
    { id: "refine_fuel", label: "Refine Fuel", color: "border-blue-600 hover:bg-blue-900 text-blue-400" },
    { id: "build_fighters", label: "Build Fighters", color: "border-yellow-600 hover:bg-yellow-900 text-yellow-400" },
    { id: "build_warship", label: "Build Warship", color: "border-yellow-600 hover:bg-yellow-900 text-yellow-400" },
    { id: "attack", label: "Attack", color: "border-red-600 hover:bg-red-900 text-red-400" },
  ];

  return (
    <div className="border border-green-800 p-4">
      <h2 className="text-yellow-400 font-bold mb-3 tracking-wider">[ COMMAND CENTER ]</h2>

      <div className="mb-3 space-y-2">
        <input
          className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm outline-none focus:border-green-500"
          placeholder="Target (for attack/trade)..."
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <input
          className="w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm outline-none focus:border-green-500"
          placeholder="Amount (optional)..."
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {actions.map((a) => (
          <button
            key={a.id}
            onClick={() => act(a.id)}
            className={`border py-2 text-sm ${a.color} transition-colors`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <div className="mt-4 border-t border-green-900 pt-3">
        <p className="text-green-700 text-xs">
          Each action costs 1 turn. Build Fighters: 100cr each. Build Warship: 2000cr.
          Refine Fuel: 50 ore → 100 fuel.
        </p>
      </div>
    </div>
  );
}
