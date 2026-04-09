"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { GameState } from "@/lib/srx-game-types";
import { getAvailableTech, TECH_TREE } from "@/lib/research";
import { PLANET_CONFIG, UNIT_COST, ECON, MIL, FINANCE, COST_INFLATION, type PlanetTypeName } from "@/lib/game-constants";
import { COMMAND_CENTER as CC, MILITARY_BUY } from "@/lib/ui-tooltips";
import Tooltip from "@/components/Tooltip";

interface SessionInfo {
  gameSessionId: string;
  isPublic: boolean;
  inviteCode: string | null;
  galaxyName: string | null;
  isCreator: boolean;
  turnTimeoutSecs: number;
}

interface Props {
  onAction: (action: string, params?: Record<string, unknown>) => void;
  /** Door-game: tick + end_turn when turn not open; else POST end_turn only. */
  onSkipTurn?: () => void | Promise<void>;
  state: GameState | null;
  targetName?: string;
  onTargetChange?: (name: string) => void;
  rivalNames?: string[];
  /** Disables economy/military/etc. actions (not skip — use `skipDisabled`). */
  disabled?: boolean;
  /** When set, overrides disabled for the Skip button only. */
  skipDisabled?: boolean;
  turnProcessing?: boolean;
  currentTurnPlayer?: string | null;
  turnOrder?: { name: string; isAI: boolean }[];
  sessionInfo?: SessionInfo;
  onSessionUpdate?: (isPublic: boolean) => void;
  onTurnTimerUpdate?: (secs: number) => void;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

const PLANET_TYPE_ENTRIES = (Object.entries(PLANET_CONFIG) as [PlanetTypeName, typeof PLANET_CONFIG[PlanetTypeName]][]);

type Tab = "economy" | "military" | "warfare" | "espionage" | "market" | "research" | "settings";

const INPUT_CLASS = "w-full bg-black border border-green-800 text-green-300 px-2 py-1 text-sm outline-none disabled:opacity-40 disabled:cursor-not-allowed";
const INPUT_CLASS_XS = "flex-1 bg-black border border-green-800 text-green-300 px-2 py-0.5 text-xs outline-none disabled:opacity-40 disabled:cursor-not-allowed";
const ACT_BTN = "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:text-green-800";

/** Static color maps for warfare buttons — avoids dynamic Tailwind class generation. */
const WAR_COLORS: Record<string, { border: string; bg: string; text: string; dim: string }> = {
  red:    { border: "border-red-700",    bg: "hover:bg-red-900",      text: "text-red-400",    dim: "text-red-800" },
  orange: { border: "border-orange-700", bg: "hover:bg-orange-900",   text: "text-orange-400", dim: "text-orange-800" },
  yellow: { border: "border-yellow-700", bg: "hover:bg-yellow-900/30", text: "text-yellow-300", dim: "text-yellow-800" },
  purple: { border: "border-purple-700", bg: "hover:bg-purple-900/30", text: "text-purple-400", dim: "text-purple-800" },
  blue:   { border: "border-blue-700",   bg: "hover:bg-blue-900/30",   text: "text-blue-400",   dim: "text-blue-800" },
  green:  { border: "border-green-700",  bg: "hover:bg-green-900",    text: "text-green-400",  dim: "text-green-800" },
};

function Kbd({ k }: { k: string }) {
  return (
    <kbd className="inline-block text-[9px] leading-none px-1 py-0.5 border border-green-700 bg-green-950/50 text-green-500 font-mono ml-1 align-middle rounded-sm">
      {k}
    </kbd>
  );
}

const TIMER_OPTIONS = [
  { label: "5 min", secs: 300 },
  { label: "30 min", secs: 1800 },
  { label: "1 hour", secs: 3600 },
  { label: "6 hours", secs: 21600 },
  { label: "12 hours", secs: 43200 },
  { label: "24 hours", secs: 86400 },
  { label: "48 hours", secs: 172800 },
  { label: "7 days", secs: 604800 },
];

function formatTimer(secs: number): string {
  const opt = TIMER_OPTIONS.find((o) => o.secs === secs);
  if (opt) return opt.label;
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  if (secs < 86400) return `${Math.round(secs / 3600)} hours`;
  return `${Math.round(secs / 86400)} days`;
}

export default function ActionPanel({ onAction, onSkipTurn, state, targetName, onTargetChange, rivalNames = [], disabled, skipDisabled: skipDisabledProp, turnProcessing, currentTurnPlayer, turnOrder, sessionInfo, onSessionUpdate, onTurnTimerUpdate }: Props) {
  const skipDisabled = skipDisabledProp ?? disabled;
  const [tab, setTab] = useState<Tab>("economy");
  const [amount, setAmount] = useState("10");
  const [marketResource, setMarketResource] = useState("food");
  const [marketAmount, setMarketAmount] = useState("100");
  const [selectedPlanetType, setSelectedPlanetType] = useState("FOOD");
  const target = targetName ?? "";
  const setTarget = onTargetChange ?? (() => {});
  const [taxRate, setTaxRate] = useState(state?.empire.taxRate?.toString() ?? "25");
  const [foodSellRate, setFoodSellRate] = useState(state?.empire.foodSellRate?.toString() ?? "0");
  const [oreSellRate, setOreSellRate] = useState(state?.empire.oreSellRate?.toString() ?? "50");
  const [petroSellRate, setPetroSellRate] = useState(state?.empire.petroleumSellRate?.toString() ?? "50");

  const panelRef = useRef<HTMLDivElement>(null);

  // Keep CFG inputs in sync with server after refresh (otherwise local state stayed at mount values).
  useEffect(() => {
    if (!state?.empire) return;
    setTaxRate(String(state.empire.taxRate));
    setFoodSellRate(String(state.empire.foodSellRate));
    setOreSellRate(String(state.empire.oreSellRate));
    setPetroSellRate(String(state.empire.petroleumSellRate));
  }, [state?.empire.taxRate, state?.empire.foodSellRate, state?.empire.oreSellRate, state?.empire.petroleumSellRate]);

  const tabs: { id: Tab; label: string; key: string; tooltip: string }[] = [
    { id: "economy", label: "ECON", key: "1", tooltip: CC.tabEconomy },
    { id: "military", label: "MIL", key: "2", tooltip: CC.tabMilitary },
    { id: "warfare", label: "WAR", key: "3", tooltip: CC.tabWarfare },
    { id: "espionage", label: "OPS", key: "4", tooltip: CC.tabEspionage },
    { id: "market", label: "MKT", key: "5", tooltip: CC.tabMarket },
    { id: "research", label: "RES", key: "6", tooltip: CC.tabResearch },
    { id: "settings", label: "CFG", key: "7", tooltip: CC.tabSettings },
  ];

  const militaryActions = [
    { id: "buy_soldiers", label: "Soldiers", cost: `${fmt(UNIT_COST.SOLDIER)}/ea`, key: "s" },
    { id: "buy_generals", label: "Generals", cost: `${fmt(UNIT_COST.GENERAL)}/ea`, key: "g" },
    { id: "buy_fighters", label: "Fighters", cost: `${fmt(UNIT_COST.FIGHTER)}/ea`, key: "f" },
    { id: "buy_stations", label: "Def Stations", cost: `${fmt(UNIT_COST.DEFENSE_STATION)}/ea`, key: "d" },
    { id: "buy_light_cruisers", label: "Light Cruisers", cost: `${fmt(UNIT_COST.LIGHT_CRUISER)}/ea`, key: "l" },
    { id: "buy_heavy_cruisers", label: "Heavy Cruisers", cost: `${fmt(UNIT_COST.HEAVY_CRUISER)}/ea`, key: "h" },
    { id: "buy_carriers", label: "Carriers", cost: `${fmt(UNIT_COST.CARRIER)}/ea`, key: "r" },
    { id: "buy_covert_agents", label: "Covert Agents", cost: `${fmt(UNIT_COST.COVERT_AGENT)}/ea`, key: "a" },
  ];

  const warfareActions = [
    { id: "attack_conventional", label: "Conventional", desc: "3-front invasion", key: "c", color: "red" },
    { id: "attack_guerrilla", label: "Guerrilla", desc: "Soldiers only; no capture", key: "g", color: "orange" },
    { id: "attack_nuclear", label: "Nuclear", desc: `${fmt(FINANCE.NUKE_COST / 1000000)}M/nuke; radiates`, key: "n", color: "yellow" },
    { id: "attack_chemical", label: "Chemical", desc: "BANNED - retaliation!", key: "h", color: "purple" },
    { id: "attack_psionic", label: "Psionic", desc: "Worsens civil status", key: "p", color: "blue" },
    { id: "attack_pirates", label: "Raid Pirates", desc: "Loot credits & ore", key: "r", color: "green" },
  ];

  const espionageOps = [
    { id: 0, label: "Spy", cost: 0, desc: "View target status", key: "s" },
    { id: 1, label: "Insurgent Aid", cost: 1, desc: "+1 civil status", key: "i" },
    { id: 2, label: "Dissension", cost: 1, desc: "Soldiers desert", key: "d" },
    { id: 3, label: "Demoralize", cost: 1, desc: "-effectiveness", key: "m" },
    { id: 4, label: "Bomb Food", cost: 1, desc: "Destroy food", key: "b" },
    { id: 5, label: "Relations Spy", cost: 0, desc: "View treaties", key: "l" },
    { id: 6, label: "Hostages", cost: 1, desc: "Steal credits", key: "o" },
    { id: 7, label: "Sabotage", cost: 1, desc: "Destroy carriers", key: "a" },
    { id: 8, label: "Comms Spy", cost: 1, desc: "Intercept logs", key: "c" },
    { id: 9, label: "Setup Coup", cost: 2, desc: "+2 civil, -eff", key: "u" },
  ];

  const doAction = useCallback((action: string, params?: Record<string, unknown>) => {
    if (disabled) return;
    onAction(action, params);
  }, [onAction, disabled]);

  const fireEconomy = useCallback((key: string) => {
    if (key === "c") doAction("buy_planet", { type: selectedPlanetType });
  }, [doAction, selectedPlanetType]);

  const fireMilitary = useCallback((key: string) => {
    const amt = parseInt(amount) || 1;
    const match = militaryActions.find((a) => a.key === key);
    if (match) doAction(match.id, { amount: amt });
    else if (key === "x") doAction("buy_command_ship");
  }, [doAction, amount]);

  const fireWarfare = useCallback((key: string) => {
    const match = warfareActions.find((a) => a.key === key);
    if (match) {
      const params: Record<string, unknown> = match.id === "attack_pirates" ? {} : { target };
      if (match.id === "attack_nuclear") params.amount = 1;
      doAction(match.id, params);
    }
  }, [doAction, target]);

  const fireEspionage = useCallback((key: string) => {
    const match = espionageOps.find((a) => a.key === key);
    if (match) doAction("covert_op", { target, opType: match.id });
  }, [doAction, target]);

  const fireMarket = useCallback((key: string) => {
    const amt = parseInt(marketAmount);
    if (key === "b") doAction("market_buy", { resource: marketResource, amount: amt });
    else if (key === "s") doAction("market_sell", { resource: marketResource, amount: amt });
    else if (key === "l") doAction("bank_loan", { amount: FINANCE.DEFAULT_LOAN_AMOUNT });
    else if (key === "o") doAction("buy_bond", { amount: FINANCE.DEFAULT_BOND_AMOUNT });
    else if (key === "t") doAction("buy_lottery_ticket", { amount: 1 });
  }, [doAction, marketResource, marketAmount]);

  const fireResearch = useCallback((key: string) => {
    const available = getAvailableTech(state?.research?.unlockedTechIds ?? []);
    const idx = "abcdefghij".indexOf(key);
    if (idx >= 0 && idx < available.length) {
      const tech = available[idx];
      if ((state?.research?.accumulatedPoints ?? 0) >= tech.cost) {
        doAction("discover_tech", { techId: tech.id });
      }
    }
  }, [doAction, state]);

  const fireSettings = useCallback((key: string) => {
    if (key === "t") doAction("set_tax_rate", { rate: parseInt(taxRate) });
    else if (key === "r") doAction("set_sell_rates", {
      foodSellRate: parseInt(foodSellRate),
      oreSellRate: parseInt(oreSellRate),
      petroleumSellRate: parseInt(petroSellRate),
    });
  }, [doAction, taxRate, foodSellRate, oreSellRate, petroSellRate]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const inInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";

      // Tab switching with number keys — works even in inputs via Alt+N
      if (!inInput && e.key >= "1" && e.key <= "7") {
        e.preventDefault();
        setTab(tabs[parseInt(e.key) - 1].id);
        return;
      }
      if (inInput && e.altKey && e.key >= "1" && e.key <= "7") {
        e.preventDefault();
        setTab(tabs[parseInt(e.key) - 1].id);
        (el as HTMLInputElement).blur();
        return;
      }

      // End turn: Enter when not in input, or Alt+Enter from anywhere
      if ((!inInput && e.key === "Enter") || (e.altKey && e.key === "Enter")) {
        if (skipDisabled) return;
        e.preventDefault();
        if (onSkipTurn) void onSkipTurn();
        else doAction("end_turn");
        return;
      }

      if (disabled) return;

      if (inInput) return;
      if (e.ctrlKey || e.metaKey) return;

      const key = e.key.toLowerCase();

      switch (tab) {
        case "economy": fireEconomy(key); break;
        case "military": fireMilitary(key); break;
        case "warfare": fireWarfare(key); break;
        case "espionage": fireEspionage(key); break;
        case "market": fireMarket(key); break;
        case "research": fireResearch(key); break;
        case "settings": fireSettings(key); break;
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [tab, disabled, skipDisabled, onSkipTurn, doAction, fireEconomy, fireMilitary, fireWarfare, fireEspionage, fireMarket, fireResearch, fireSettings]);

  const actBtn = ACT_BTN;

  return (
    <div ref={panelRef} className="border border-green-800 p-4 h-full flex flex-col">
      <div className="flex justify-between items-center mb-3 shrink-0">
        <Tooltip tip={CC.panelTitle}>
          <h2 className="text-yellow-400 font-bold tracking-wider cursor-help">[ COMMAND CENTER ]</h2>
        </Tooltip>
        <Tooltip tip={CC.skipHint}>
          <span className="text-green-800 text-[10px] cursor-help">Enter=Skip Turn</span>
        </Tooltip>
      </div>

      {/* Waiting banner */}
      {disabled && !turnProcessing && currentTurnPlayer && (
        <div className="w-full border border-cyan-800 bg-cyan-900/10 py-2 px-3 text-sm text-cyan-400 mb-3 tracking-wider shrink-0 text-center animate-pulse">
          ◈{" "}
          {currentTurnPlayer === "others"
            ? "WAITING — OTHER COMMANDERS"
            : currentTurnPlayer === "resolving"
              ? "RESOLVING MOVES"
              : `WAITING — ${currentTurnPlayer.toUpperCase()}'S TURN`}
        </div>
      )}
      <button
        type="button"
        onClick={() => (onSkipTurn ? void onSkipTurn() : doAction("end_turn"))}
        disabled={skipDisabled}
        className={`w-full border border-yellow-600 py-2 text-sm hover:bg-yellow-900/30 text-yellow-400 mb-3 tracking-wider shrink-0 ${actBtn}`}
      >
        <Kbd k="Enter" /> SKIP TURN — Collect Income Only
      </button>

      {/* Tabs */}
      <div className="flex gap-1 mb-3 border-b border-green-900 pb-2 shrink-0">
        {tabs.map((t) => (
          <Tooltip key={t.id} tip={t.tooltip}>
            <button
              type="button"
              onClick={() => setTab(t.id)}
              className={`text-xs px-3 py-1 border cursor-help ${
                tab === t.id
                  ? "border-yellow-600 text-yellow-400 bg-yellow-900/20"
                  : "border-green-800 text-green-600 hover:border-green-600"
              }`}
            >
              <Kbd k={t.key} /> {t.label}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Scrollable tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">

      {tab === "economy" && (
        <div className="space-y-2">
          <label className="text-green-600 text-xs block">Colonize Planet <Kbd k="C" /></label>
          <div className="space-y-1">
            {PLANET_TYPE_ENTRIES.map(([key, cfg]) => {
              const owned = state?.planetSummary?.[key] ?? 0;
              const selected = selectedPlanetType === key;
              const cost = Math.round(cfg.baseCost * (1 + (state?.empire.netWorth ?? 0) * COST_INFLATION));
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setSelectedPlanetType(key);
                    doAction("buy_planet", { type: key });
                  }}
                  className={`w-full text-left border py-1.5 px-2 text-xs transition-colors ${actBtn} ${
                    selected
                      ? "border-yellow-600 bg-yellow-900/15"
                      : "border-green-900 hover:border-green-600 hover:bg-green-900/30"
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className={selected ? "text-yellow-400" : "text-green-300"}>{cfg.label}</span>
                    <span className="text-green-700">{fmt(cost)} cr</span>
                  </div>
                  <div className="text-green-700 text-[10px] mt-0.5">{cfg.desc}{owned > 0 ? ` · you own ${owned}` : ""}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === "military" && (
        <div className="space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Amount:</label>
            <input
              type="number"
              value={amount}
              disabled={disabled}
              onChange={(e) => setAmount(e.target.value)}
              className={INPUT_CLASS}
              min="1"
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {militaryActions.map((a) => (
              <Tooltip key={a.id} tip={MILITARY_BUY[a.id]}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => doAction(a.id, { amount: parseInt(amount) || 1 })}
                  className={`border border-green-700 py-1.5 text-xs hover:bg-green-900 text-left px-2 cursor-help w-full ${actBtn}`}
                >
                  <div className="text-green-300"><Kbd k={a.key.toUpperCase()} /> {a.label}</div>
                  <div className="text-green-700">{a.cost}</div>
                </button>
              </Tooltip>
            ))}
            <Tooltip tip={MILITARY_BUY.buy_command_ship} className="col-span-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("buy_command_ship")}
                className={`border border-yellow-700 py-1.5 text-xs hover:bg-yellow-900 text-left px-2 cursor-help w-full ${actBtn}`}
              >
                <div className="text-yellow-400"><Kbd k="X" /> Command Ship</div>
                <div className="text-yellow-700">{fmt(UNIT_COST.COMMAND_SHIP)} cr (unique)</div>
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      {tab === "warfare" && (
        <div className="space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Target Empire:</label>
            <select
              value={target}
              disabled={disabled}
              onChange={(e) => setTarget(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">— Select target —</option>
              {rivalNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {warfareActions.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  const params: Record<string, unknown> = a.id === "attack_pirates" ? {} : { target };
                  if (a.id === "attack_nuclear") params.amount = 1;
                  doAction(a.id, params);
                }}
                className={`border ${WAR_COLORS[a.color].border} py-1.5 text-xs ${actBtn} ${WAR_COLORS[a.color].bg} text-left px-2`}
              >
                <div className={WAR_COLORS[a.color].text}>
                  <Kbd k={a.key.toUpperCase()} /> {a.label}
                </div>
                <div className={WAR_COLORS[a.color].dim}>{a.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "espionage" && (
        <div className="space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Target Empire:</label>
            <select
              value={target}
              disabled={disabled}
              onChange={(e) => setTarget(e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">— Select target —</option>
              {rivalNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          <div className="text-xs text-green-600 mb-1">
            Covert Points: {state?.army?.covertPoints ?? 0}/{MIL.MAX_COVERT_POINTS} | Agents: {state?.army?.covertAgents ?? 0}
          </div>

          <div className="grid grid-cols-2 gap-1">
            {espionageOps.map((op) => (
              <button
                key={op.id}
                type="button"
                disabled={disabled}
                onClick={() => doAction("covert_op", { target, opType: op.id })}
                className={`border border-green-800 py-1 text-xs hover:bg-green-900 text-left px-2 ${actBtn}`}
              >
                <div className="text-green-300"><Kbd k={op.key.toUpperCase()} /> {op.label} ({op.cost}pt)</div>
                <div className="text-green-700">{op.desc}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "market" && (
        <div className="space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Resource:</label>
            <select
              value={marketResource}
              disabled={disabled}
              onChange={(e) => setMarketResource(e.target.value)}
              className={`${INPUT_CLASS} mb-1`}
            >
              <option value="food">Food (base {fmt(ECON.BASE_FOOD_PRICE)} cr)</option>
              <option value="ore">Ore (base {fmt(ECON.BASE_ORE_PRICE)} cr)</option>
              <option value="fuel">Fuel (base {fmt(ECON.BASE_PETRO_PRICE)} cr)</option>
            </select>
            <label className="text-green-600 text-xs block mb-1">Amount:</label>
            <input
              type="number"
              value={marketAmount}
              disabled={disabled}
              onChange={(e) => setMarketAmount(e.target.value)}
              className={`${INPUT_CLASS} mb-1`}
              min="1"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("market_buy", { resource: marketResource, amount: parseInt(marketAmount) })}
                className={`flex-1 border border-green-600 py-1.5 text-xs hover:bg-green-900 ${actBtn}`}
              >
                <Kbd k="B" /> BUY
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("market_sell", { resource: marketResource, amount: parseInt(marketAmount) })}
                className={`flex-1 border border-yellow-600 py-1.5 text-xs hover:bg-yellow-900 text-yellow-400 ${actBtn}`}
              >
                <Kbd k="S" /> SELL
              </button>
            </div>
          </div>

          <div className="border-t border-green-900 pt-2">
            <h3 className="text-green-500 text-xs tracking-wider mb-1">SOLAR BANK</h3>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("bank_loan", { amount: FINANCE.DEFAULT_LOAN_AMOUNT })}
                className={`border border-green-700 py-1.5 text-xs hover:bg-green-900 px-2 ${actBtn}`}
              >
                <div className="text-green-300"><Kbd k="L" /> Take Loan</div>
                <div className="text-green-700">{fmt(FINANCE.DEFAULT_LOAN_AMOUNT / 1000)}K cr, {FINANCE.LOAN_INTEREST_RATE}% int</div>
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("buy_bond", { amount: FINANCE.DEFAULT_BOND_AMOUNT })}
                className={`border border-blue-700 py-1.5 text-xs hover:bg-blue-900/30 px-2 ${actBtn}`}
              >
                <div className="text-blue-400"><Kbd k="O" /> Buy Bond</div>
                <div className="text-blue-800">{fmt(FINANCE.DEFAULT_BOND_AMOUNT / 1000)}K cr, {FINANCE.BOND_INTEREST_RATE}%, {FINANCE.BOND_MATURITY_TURNS}t</div>
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("buy_lottery_ticket", { amount: 1 })}
                className={`border border-yellow-700 py-1.5 text-xs hover:bg-yellow-900/30 px-2 col-span-2 ${actBtn}`}
              >
                <div className="text-yellow-400"><Kbd k="T" /> Lottery Ticket ({fmt(FINANCE.LOTTERY_TICKET_COST)} cr)</div>
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "research" && (
        <div className="space-y-3">
          <div className="text-xs text-green-600">
            Research Points: {state?.research?.accumulatedPoints?.toLocaleString() ?? 0}
          </div>

          <div className="text-xs text-green-700 mb-1">Unlocked: {state?.research?.unlockedTechIds?.length ?? 0}/{TECH_TREE.length}</div>

          <div className="space-y-1 max-h-64 overflow-y-auto">
            {getAvailableTech(state?.research?.unlockedTechIds ?? []).map((tech, idx) => {
              const canAfford = (state?.research?.accumulatedPoints ?? 0) >= tech.cost;
              const shortcutKey = "ABCDEFGHIJ"[idx];
              return (
                <button
                  key={tech.id}
                  type="button"
                  onClick={() => doAction("discover_tech", { techId: tech.id })}
                  disabled={disabled || !canAfford}
                  className={`w-full border py-1.5 text-xs text-left px-2 ${actBtn} ${
                    canAfford
                      ? "border-green-600 hover:bg-green-900"
                      : "border-green-900 opacity-50"
                  }`}
                >
                  <div className="flex justify-between">
                    <span className="text-green-300">
                      {shortcutKey && <Kbd k={shortcutKey} />} {tech.name}
                    </span>
                    <span className={`text-xs ${canAfford ? "text-yellow-400" : "text-green-700"}`}>
                      {tech.cost.toLocaleString()} RP
                    </span>
                  </div>
                  <div className="text-green-700">{tech.description}</div>
                  <div className="text-green-800">
                    [{tech.category}] {tech.permanent ? "permanent" : `${tech.durationTurns}t`}
                  </div>
                </button>
              );
            })}
            {getAvailableTech(state?.research?.unlockedTechIds ?? []).length === 0 && (
              <p className="text-green-800 text-xs italic">No technologies available. Build research planets or unlock prerequisites.</p>
            )}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Tax Rate (0-100%):</label>
            <div className="flex gap-2">
              <input
                type="number"
                value={taxRate}
                disabled={disabled}
                onChange={(e) => setTaxRate(e.target.value)}
                className={`flex-1 ${INPUT_CLASS.replace("w-full ", "")}`}
                min="0"
                max="100"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => doAction("set_tax_rate", { rate: parseInt(taxRate) })}
                className={`border border-green-600 px-3 py-1 text-xs hover:bg-green-900 ${actBtn}`}
              >
                <Kbd k="T" /> SET
              </button>
            </div>
          </div>

          <div>
            <label className="text-green-600 text-xs block mb-1">Auto-Sell Rates (0-100%):</label>
            <div className="space-y-1">
              <div className="flex gap-2 items-center">
                <span className="text-green-700 text-xs w-16">Food:</span>
                <input
                  type="number"
                  value={foodSellRate}
                  disabled={disabled}
                  onChange={(e) => setFoodSellRate(e.target.value)}
                  className={INPUT_CLASS_XS}
                  min="0" max="100"
                />
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-green-700 text-xs w-16">Ore:</span>
                <input
                  type="number"
                  value={oreSellRate}
                  disabled={disabled}
                  onChange={(e) => setOreSellRate(e.target.value)}
                  className={INPUT_CLASS_XS}
                  min="0" max="100"
                />
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-green-700 text-xs w-16">Petro:</span>
                <input
                  type="number"
                  value={petroSellRate}
                  disabled={disabled}
                  onChange={(e) => setPetroSellRate(e.target.value)}
                  className={INPUT_CLASS_XS}
                  min="0" max="100"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                doAction("set_sell_rates", {
                  foodSellRate: parseInt(foodSellRate),
                  oreSellRate: parseInt(oreSellRate),
                  petroleumSellRate: parseInt(petroSellRate),
                })
              }
              className={`mt-1 w-full border border-green-600 py-1 text-xs hover:bg-green-900 ${actBtn}`}
            >
              <Kbd k="R" /> UPDATE SELL RATES
            </button>
          </div>

          <p className="text-green-800 text-xs mt-2">
            Tax rate affects income, emigration, and birth rate. Higher taxes = more credits but population loss.
            Sell rates determine what % of production is sold on the market for credits.
          </p>

          {sessionInfo && (
            <div className="mt-4 pt-3 border-t border-green-900">
              <div className="text-yellow-400 font-bold text-xs mb-2 tracking-wider">GAME SESSION</div>
              {sessionInfo.galaxyName && (
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-green-600">Galaxy</span>
                  <span className="text-green-300">{sessionInfo.galaxyName}</span>
                </div>
              )}
              {sessionInfo.inviteCode && !sessionInfo.isPublic && (
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-green-600">Invite Code</span>
                  <span className="text-yellow-300 font-mono tracking-widest cursor-pointer hover:text-yellow-100"
                    onClick={() => navigator.clipboard.writeText(sessionInfo.inviteCode!)}
                    title="Click to copy"
                  >
                    {sessionInfo.inviteCode} 📋
                  </span>
                </div>
              )}
              <div className="flex justify-between text-xs mb-1">
                <span className="text-green-600">Visibility</span>
                <span className={sessionInfo.isPublic ? "text-green-300" : "text-yellow-300"}>
                  {sessionInfo.isPublic ? "Public" : "Private"}
                </span>
              </div>
              {sessionInfo.isCreator && onSessionUpdate && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSessionUpdate(!sessionInfo.isPublic)}
                  className={`mt-1 w-full border border-green-700 py-1 text-xs hover:bg-green-900 text-green-400 ${actBtn}`}
                >
                  MAKE {sessionInfo.isPublic ? "PRIVATE" : "PUBLIC"}
                </button>
              )}

              <div className="flex justify-between text-xs mb-1 mt-2">
                <span className="text-green-600">Turn Timer</span>
                <span className="text-green-300">{formatTimer(sessionInfo.turnTimeoutSecs)}</span>
              </div>
              {sessionInfo.isCreator && onTurnTimerUpdate && (
                <select
                  value={sessionInfo.turnTimeoutSecs}
                  disabled={disabled}
                  onChange={(e) => onTurnTimerUpdate(Number(e.target.value))}
                  className="mt-1 w-full bg-black border border-green-700 text-green-400 text-xs px-2 py-1 focus:outline-none focus:border-yellow-600 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {TIMER_OPTIONS.map((o) => (
                    <option key={o.secs} value={o.secs}>{o.label}</option>
                  ))}
                </select>
              )}

              {turnOrder && turnOrder.length > 0 && (
                <div className="mt-3 pt-2 border-t border-green-900">
                  <div className="text-yellow-400 font-bold text-[10px] mb-1 tracking-wider">TURN ORDER</div>
                  {turnOrder.map((p, i) => {
                    const isCurrent = p.name === currentTurnPlayer;
                    return (
                      <div key={p.name} className={`text-xs flex items-center gap-1 py-0.5 ${isCurrent ? "text-cyan-400 font-bold" : "text-green-600"}`}>
                        <span className="w-3 text-right text-green-800">{i + 1}</span>
                        <span>{isCurrent ? "▸" : " "}</span>
                        <span>{p.name}</span>
                        {p.isAI && <span className="text-green-800 text-[9px]">[AI]</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      </div>
      {/* end scrollable tab content */}

      {/* Keyboard shortcut legend */}
      <div className="mt-3 pt-2 border-t border-green-900 shrink-0">
        <div className="text-green-800 text-[10px] leading-relaxed">
          <Kbd k="1" />-<Kbd k="7" /> tabs
          {" | "}
          <Kbd k="Enter" /> skip turn
          {" | "}
          <span className="text-green-700">Letter keys trigger actions in current tab</span>
        </div>
      </div>
    </div>
  );
}
