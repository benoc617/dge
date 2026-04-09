"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import EmpirePanel from "@/components/EmpirePanel";
import ActionPanel from "@/components/ActionPanel";
import EventLog from "@/components/EventLog";
import Leaderboard from "@/components/Leaderboard";
import { HelpModal } from "@/components/HelpModal";
import { TurnTimer } from "@/components/TurnTimer";
import { classifyTurnEvents } from "@/lib/critical-events";
import { apiFetch } from "@/lib/client-fetch";
import { simultaneousDoorCommandCenterDisabled } from "@/lib/door-game-ui";
import type { GameState, CombatSummary, TurnPopupData, GameOverData } from "@/lib/srx-game-types";

export interface SrxGameScreenProps {
  playerName: string;
  sessionPlayerId: string | null;
  gameSessionId: string | null;
  initialInviteCode: string;
  initialGalaxyName: string;
  initialIsPublic: boolean;
  isCreator: boolean;
  initialEvents: string[];
  onLogout: () => void;
}

export function SrxGameScreen({
  playerName,
  sessionPlayerId,
  gameSessionId,
  initialInviteCode,
  initialGalaxyName,
  initialIsPublic,
  isCreator,
  initialEvents,
  onLogout,
}: SrxGameScreenProps) {
  // ---------------------------------------------------------------------------
  // Game state
  // ---------------------------------------------------------------------------

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<string[]>(initialEvents);
  const [refreshKey, setRefreshKey] = useState(0);
  const [targetName, setTargetName] = useState("");
  const [rivalNames, setRivalNames] = useState<string[]>([]);
  const [turnProcessing, setTurnProcessing] = useState(false);
  const [tickFired, setTickFired] = useState(false);
  const [turnPopup, setTurnPopup] = useState<TurnPopupData | null>(null);
  const [gameOver, setGameOver] = useState<GameOverData | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dayRolloverNotice, setDayRolloverNotice] = useState<{ completedDay: number } | null>(null);
  const [endOfDayModal, setEndOfDayModal] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [helpContent, setHelpContent] = useState<{ title: string; content: string } | null>(null);

  // Session info (mutable: isPublic can be toggled by creator)
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [galaxyName] = useState(initialGalaxyName);
  const [isPublic, setIsPublic] = useState(initialIsPublic);

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  const actionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevDayNumberRef = useRef<number | null>(null);
  const prevTurnOpenRef = useRef<boolean | null>(null);
  const deferSituationReportUntilPopupClosedRef = useRef(false);
  const pendingTurnStartPopupRef = useRef<TurnPopupData | null>(null);
  const pendingEndOfDayAfterModalChainRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  const eventCounterRef = useRef(0);
  const addEvent = useCallback((msg: string) => {
    const n = ++eventCounterRef.current;
    setEvents((prev) => [`[T${n}] ${msg}`, ...prev.slice(0, 199)]);
  }, []);

  const showActionError = useCallback((message: string) => {
    if (actionErrorTimerRef.current) {
      clearTimeout(actionErrorTimerRef.current);
      actionErrorTimerRef.current = null;
    }
    setActionError(message);
    actionErrorTimerRef.current = setTimeout(() => {
      setActionError(null);
      actionErrorTimerRef.current = null;
    }, 12000);
  }, []);

  const dismissActionError = useCallback(() => {
    if (actionErrorTimerRef.current) {
      clearTimeout(actionErrorTimerRef.current);
      actionErrorTimerRef.current = null;
    }
    setActionError(null);
  }, []);

  useEffect(() => {
    return () => {
      if (actionErrorTimerRef.current) clearTimeout(actionErrorTimerRef.current);
    };
  }, []);

  const openHelp = useCallback(async () => {
    if (helpContent) {
      setShowHelp(true);
      return;
    }
    try {
      const res = await fetch("/api/game/help?game=srx");
      if (res.ok) {
        const data = (await res.json()) as { title: string; content: string };
        setHelpContent(data);
        setShowHelp(true);
      }
    } catch {
      // silently ignore — help is non-critical
    }
  }, [helpContent]);

  // ---------------------------------------------------------------------------
  // refreshState
  // ---------------------------------------------------------------------------

  const triggerGameOver = useCallback(async (name: string) => {
    const res = await apiFetch("/api/game/gameover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName: name, playerId: sessionPlayerId }),
    });
    if (res.ok) {
      const data = await res.json();
      setGameOver(data as GameOverData);
    }
  }, [sessionPlayerId]);

  const refreshState = useCallback(
    async (name: string, pid?: string | null): Promise<GameState | null> => {
      const tR0 = performance.now();
      const qs = pid
        ? `id=${encodeURIComponent(pid)}`
        : `player=${encodeURIComponent(name)}`;
      let res: Response;
      try {
        res = await fetch(`/api/game/status?${qs}`, {
          signal: AbortSignal.timeout(25_000),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      const raw = await res.text();
      if (!raw.trim()) return null;
      try {
        const data = JSON.parse(raw) as GameState & { empire?: { turnsLeft?: number } };
        setGameState(data);
        setRefreshKey((k) => k + 1);
        console.log(`[srx-ui] refreshState ${(performance.now() - tR0).toFixed(0)}ms`);
        if (data.empire?.turnsLeft !== undefined && data.empire.turnsLeft <= 0 && !gameOver) {
          void triggerGameOver(name);
        }
        return data;
      } catch {
        return null;
      }
    },
    [gameOver, triggerGameOver],
  );

  // Initial state load on mount.
  useEffect(() => {
    void refreshState(playerName, sessionPlayerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------------------
  // Turn popup
  // ---------------------------------------------------------------------------

  const handleTurnPopupClose = useCallback(() => {
    if (pendingTurnStartPopupRef.current) {
      const next = pendingTurnStartPopupRef.current;
      pendingTurnStartPopupRef.current = null;
      deferSituationReportUntilPopupClosedRef.current = false;
      setTurnPopup(next);
      return;
    }
    setTurnPopup(null);
    deferSituationReportUntilPopupClosedRef.current = false;
    if (pendingEndOfDayAfterModalChainRef.current) {
      pendingEndOfDayAfterModalChainRef.current = false;
      setEndOfDayModal(true);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Turn actions
  // ---------------------------------------------------------------------------

  async function handleStartFullTurn() {
    if (!gameState || gameState.canAct === false || gameState.turnOpen || turnProcessing) return;
    setTickFired(true);
    try {
      const res = await apiFetch("/api/game/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName, playerId: sessionPlayerId }),
      });
      if (!res.ok) { setTickFired(false); return; }
      await refreshState(playerName, sessionPlayerId);
    } catch {
      setTickFired(false);
    }
  }

  async function handleSkipTurn() {
    if (gameState?.turnMode === "simultaneous" && gameState.canAct !== false && !gameState.turnOpen) {
      try {
        await apiFetch("/api/game/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName, playerId: sessionPlayerId }),
        });
        await refreshState(playerName, sessionPlayerId);
      } catch {
        /* ignore */
      }
    }
    await handleAction("end_turn");
  }

  async function handleAction(action: string, params?: Record<string, unknown>) {
    const t0 = performance.now();
    setTurnProcessing(true);
    dismissActionError();
    let res: Response;
    const simultaneous = gameState?.turnMode === "simultaneous";
    try {
      res = await apiFetch("/api/game/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName, playerId: sessionPlayerId, action, ...params }),
      });
    } catch {
      const msg = "Network error — could not reach the server.";
      showActionError(msg);
      addEvent(`  ✖ ${msg}`);
      setTurnProcessing(false);
      return;
    }
    const tFetched = performance.now();

    const text = await res.text();
    const tParsed = performance.now();
    let data: { success?: boolean; message?: string; error?: string; actionDetails?: Record<string, unknown> };
    try {
      data = text ? (JSON.parse(text) as typeof data) : {};
    } catch {
      const msg = "Invalid response from server.";
      showActionError(msg);
      addEvent(`  ✖ ${msg}`);
      setTurnProcessing(false);
      return;
    }

    const failMsg = data.message ?? data.error ?? `Request failed (${res.status}).`;

    if (!res.ok) {
      console.log(`[srx-ui] handleAction ${action} FAIL fetch=${(tFetched - t0).toFixed(0)}ms parse=${(tParsed - tFetched).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
      showActionError(failMsg);
      addEvent(`  ✖ ${failMsg}`);
      setTurnProcessing(false);
      return;
    }

    if (!data.success) {
      console.log(`[srx-ui] handleAction ${action} !success fetch=${(tFetched - t0).toFixed(0)}ms parse=${(tParsed - tFetched).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
      showActionError(failMsg);
      addEvent(`  ✖ ${failMsg}`);
      setTurnProcessing(false);
      return;
    }

    const actionMsg =
      action === "end_turn" ? "Turn skipped (income collected)." : (data.message ?? data.error ?? "");
    if (action === "end_turn") {
      addEvent(`  ▸ Turn skipped (income collected).`);
    } else {
      addEvent(`  ▸ ${data.message ?? data.error ?? ""}`);
    }

    const details = data.actionDetails;

    // Covert / intelligence modal
    const intelMsgs = details?.intelMessages;
    if (action === "covert_op" && Array.isArray(intelMsgs) && intelMsgs.length > 0) {
      deferSituationReportUntilPopupClosedRef.current = true;
      setTurnPopup({
        mode: "intel_report",
        turn: gameState?.empire.turnsPlayed ?? 0,
        action: "Covert operation",
        actionMsg: data.message ?? "",
        intelTarget: (details?.covertTarget as string) ?? (params?.target as string) ?? "",
        income: { populationTax: 0, urbanTax: 0, tourism: 0, foodSales: 0, oreSales: 0, petroSales: 0, galacticRedistribution: 0, total: 0 },
        expenses: { planetMaintenance: 0, militaryMaintenance: 0, galacticTax: 0, total: 0 },
        population: { births: 0, deaths: 0, immigration: 0, emigration: 0, net: 0, newTotal: 0 },
        resources: { foodProduced: 0, foodConsumed: 0, oreProduced: 0, oreConsumed: 0, fuelProduced: 0, fuelConsumed: 0 },
        civilStatus: "",
        netWorth: 0,
        events: intelMsgs as string[],
      });
    }

    // Combat results modal
    if (details?.combatResult && action.startsWith("attack_")) {
      const cr = details.combatResult as CombatSummary & {
        victory?: boolean;
        fronts?: unknown;
        loot?: unknown;
        attackerLosses?: Record<string, number>;
        defenderLosses?: unknown;
        messages?: string[];
        planetCasualties?: { planetName: string; populationKilled: number }[];
        populationKilledTotal?: number;
        planetsRadiatedCount?: number;
        planetsAffectedCount?: number;
        defenderCivilLevelsGained?: number;
        defenderEffectivenessLost?: number;
      };
      const combat: CombatSummary = {
        type: action.replace("attack_", "").replace(/_/g, " "),
        target: (params?.target as string) || (action === "attack_pirates" ? "Pirates" : "Unknown"),
        victory: cr.victory ?? false,
        fronts: cr.fronts as CombatSummary["fronts"],
        loot: cr.loot as CombatSummary["loot"],
        attackerLosses: cr.attackerLosses ?? {},
        defenderLosses: cr.defenderLosses as Record<string, number> | undefined,
        messages: cr.messages ?? [],
        planetCasualties: cr.planetCasualties,
        populationKilledTotal: cr.populationKilledTotal,
        planetsRadiatedCount: cr.planetsRadiatedCount,
        planetsAffectedCount: cr.planetsAffectedCount,
        defenderCivilLevelsGained: cr.defenderCivilLevelsGained,
        defenderEffectivenessLost: cr.defenderEffectivenessLost,
      };
      deferSituationReportUntilPopupClosedRef.current = true;
      setTurnPopup({
        mode: "action_result",
        turn: gameState?.empire.turnsPlayed ?? 0,
        action: action.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        actionMsg,
        income: { populationTax: 0, urbanTax: 0, tourism: 0, foodSales: 0, oreSales: 0, petroSales: 0, galacticRedistribution: 0, total: 0 },
        expenses: { planetMaintenance: 0, militaryMaintenance: 0, galacticTax: 0, total: 0 },
        population: { births: 0, deaths: 0, immigration: 0, emigration: 0, net: 0, newTotal: 0 },
        resources: { foodProduced: 0, foodConsumed: 0, oreProduced: 0, oreConsumed: 0, fuelProduced: 0, fuelConsumed: 0 },
        civilStatus: "",
        netWorth: 0,
        events: [],
        combat,
      });
    }

    if (simultaneous && action !== "end_turn") {
      setGameState((prev) => {
        if (!prev) return prev;
        const used = (prev.empire.fullTurnsUsedThisRound ?? 0) + 1;
        const left = Math.max(0, ((prev as GameState & { actionsPerDay?: number }).actionsPerDay ?? 5) - used);
        return {
          ...prev,
          empire: { ...prev.empire, turnOpen: false, fullTurnsUsedThisRound: used },
          turnOpen: false,
          canAct: left > 0 && prev.empire.turnsLeft > 1,
          fullTurnsLeftToday: left,
        };
      });
      console.log(`[srx-ui] handleAction ${action} OK(opt) fetch=${(tFetched - t0).toFixed(0)}ms parse=${(tParsed - tFetched).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
      setTurnProcessing(false);
    } else {
      const tRefresh0 = performance.now();
      const st = await refreshState(playerName, sessionPlayerId);
      console.log(`[srx-ui] handleAction ${action} OK fetch=${(tFetched - t0).toFixed(0)}ms parse=${(tParsed - tFetched).toFixed(0)}ms refresh=${(performance.now() - tRefresh0).toFixed(0)}ms total=${(performance.now() - t0).toFixed(0)}ms`);
      const hadFullTurnsLeft = (gameState?.fullTurnsLeftToday ?? 0) > 0;
      if (simultaneous && st?.fullTurnsLeftToday === 0 && hadFullTurnsLeft) {
        if (deferSituationReportUntilPopupClosedRef.current) {
          pendingEndOfDayAfterModalChainRef.current = true;
        } else {
          setEndOfDayModal(true);
        }
      }
      setTurnProcessing(false);
    }
  }

  async function updateSessionVisibility(newIsPublic: boolean) {
    const res = await apiFetch("/api/game/session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: gameSessionId, playerName, isPublic: newIsPublic }),
    });
    if (res.ok) {
      setIsPublic(newIsPublic);
    }
  }

  async function updateTurnTimer(secs: number) {
    const res = await apiFetch("/api/game/session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: gameSessionId, playerName, turnTimeoutSecs: secs }),
    });
    if (res.ok) {
      await refreshState(playerName, sessionPlayerId);
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-tick effect
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!gameState || !playerName || tickFired || turnProcessing) return;
    const simultaneous = gameState.turnMode === "simultaneous";
    const needTick = simultaneous
      ? gameState.canAct !== false && gameState.turnOpen === false
      : gameState.isYourTurn === true;
    if (!needTick) return;
    setTickFired(true);

    (async () => {
      const tTick0 = performance.now();
      try {
        const res = await apiFetch("/api/game/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName, playerId: sessionPlayerId }),
        });
        const tTickFetched = performance.now();
        let data: { turnReport?: unknown; turnOpened?: boolean; alreadyProcessed?: boolean };
        try {
          const text = await res.text();
          data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
          console.log(`[srx-ui] tick parse-error fetch=${(tTickFetched - tTick0).toFixed(0)}ms`);
          setTickFired(false);
          return;
        }
        if (!res.ok) {
          console.log(`[srx-ui] tick FAIL(${res.status}) fetch=${(tTickFetched - tTick0).toFixed(0)}ms total=${(performance.now() - tTick0).toFixed(0)}ms`);
          setTickFired(false);
          return;
        }
        const tr = data.turnReport;
        if (tr && typeof tr === "object" && tr !== null && "income" in tr) {
          const r = tr as TurnPopupData;
          addEvent(`========================================`);
          addEvent(`  TURN ${gameState.empire.turnsPlayed} — SITUATION REPORT`);
          addEvent(`========================================`);
          addEvent(`  INCOME: ${r.income.total.toLocaleString()} cr`);
          addEvent(`  EXPENSES: ${r.expenses.total.toLocaleString()} cr`);
          addEvent(`  NET: ${(r.income.total - r.expenses.total >= 0 ? "+" : "")}${(r.income.total - r.expenses.total).toLocaleString()} cr`);
          addEvent(`  POP: ${r.population.newTotal.toLocaleString()} (${r.population.net >= 0 ? "+" : ""}${r.population.net.toLocaleString()})`);
          if (r.events.length > 0) {
            for (const ev of r.events) addEvent(`  ⚡ ${ev}`);
          }
          addEvent(`----------------------------------------`);

          const turnStartPayload: TurnPopupData = {
            mode: "turn_start",
            turn: gameState.empire.turnsPlayed,
            action: "Turn Start",
            actionMsg: "Situation report before your action",
            income: r.income,
            expenses: r.expenses,
            population: r.population,
            resources: r.resources,
            civilStatus: r.civilStatus,
            netWorth: r.netWorth,
            events: r.events,
          };
          if (deferSituationReportUntilPopupClosedRef.current) {
            pendingTurnStartPopupRef.current = turnStartPayload;
          } else {
            setTurnPopup(turnStartPayload);
          }
        }
        await refreshState(playerName, sessionPlayerId);
        console.log(`[srx-ui] tick OK fetch=${(tTickFetched - tTick0).toFixed(0)}ms total=${(performance.now() - tTick0).toFixed(0)}ms hasTR=${!!tr}`);
      } catch {
        setTickFired(false);
      }
    })();
  }, [
    gameState?.isYourTurn,
    gameState?.turnMode,
    gameState?.canAct,
    gameState?.turnOpen,
    playerName,
    tickFired,
    turnProcessing,
    addEvent,
    refreshState,
    gameState?.empire.turnsPlayed,
    gameState?.player.id,
    sessionPlayerId,
  ]);

  // Reset tickFired when it's no longer our turn.
  useEffect(() => {
    if (gameState && gameState.isYourTurn === false) {
      setTickFired(false);
    }
  }, [gameState?.isYourTurn]);

  // Door-game: closing a full turn (end_turn) sets turnOpen false; isYourTurn stays true
  // while canAct, so tickFired would never reset for the next full turn.
  useEffect(() => {
    if (gameState?.turnMode !== "simultaneous") return;
    const open = gameState.turnOpen === true;
    const prev = prevTurnOpenRef.current;
    prevTurnOpenRef.current = open;
    if (prev === true && open === false) {
      setTickFired(false);
    }
  }, [gameState?.turnMode, gameState?.turnOpen]);

  useEffect(() => {
    if (gameState?.turnMode === "simultaneous") {
      setTickFired(false);
    }
  }, [gameState?.dayNumber, gameState?.turnMode]);

  useEffect(() => {
    if (!gameState || gameState.turnMode !== "simultaneous" || gameState.dayNumber == null) return;
    const d = gameState.dayNumber;
    if (prevDayNumberRef.current !== null && d > prevDayNumberRef.current) {
      setDayRolloverNotice({ completedDay: prevDayNumberRef.current });
    }
    prevDayNumberRef.current = d;
  }, [gameState?.dayNumber, gameState?.turnMode]);

  // Polling (while waiting for AI / other humans / door-game round rollover).
  useEffect(() => {
    if (!gameState || turnProcessing) return;
    if (gameState.turnMode !== "simultaneous" && gameState.isYourTurn !== false) return;

    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(`/api/game/status?id=${gameState.player.id}`);
        if (res.ok) {
          const data = await res.json();
          setGameState(data as GameState);
          setRefreshKey((k) => k + 1);
        }
      } catch {
        /* ignore polling errors */
      }
    };

    const interval = setInterval(poll, 2000);
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [gameState?.isYourTurn, gameState?.turnMode, gameState?.player.id, turnProcessing]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main className="h-screen bg-black text-green-400 font-mono px-4 pt-1 pb-1 flex flex-col overflow-hidden">
      <header className="border-b border-green-800 pb-1 mb-1 flex justify-between items-center shrink-0">
        <h1 className="text-yellow-400 font-bold tracking-widest">
          SRX{galaxyName ? <span className="text-green-600 text-xs font-normal ml-2">» {galaxyName}</span> : ""}
        </h1>
        <div className="flex items-center gap-3 text-xs">
          {gameState && (
            <>
              {gameState.waitingForGameStart ? (
                <span className="font-bold text-cyan-600">▸ LOBBY — GALAXY NOT STARTED</span>
              ) : gameState.turnMode === "simultaneous" ? (
                <>
                  <span className="text-green-600">
                    D{gameState.dayNumber ?? 1} · {(gameState.actionsPerDay ?? 5) - (gameState.fullTurnsLeftToday ?? 0)}/{gameState.actionsPerDay ?? 5} turns used
                  </span>
                  <span
                    className={`font-bold ${
                      gameState.empire.turnsLeft < 1
                        ? "text-red-400"
                        : gameState.turnOpen
                          ? "text-cyan-400"
                          : gameState.canAct === false
                            ? "text-yellow-400"
                            : "text-yellow-400 cursor-pointer hover:text-yellow-200"
                    }`}
                    title={
                      gameState.empire.turnsLeft < 1
                        ? "No game turns remaining."
                        : gameState.canAct === false
                          ? "You used all full turns for this calendar day, or you are waiting for other commanders. When the round timer expires, unused full turns are skipped and the next calendar day begins."
                          : gameState.turnOpen
                            ? "This full turn is open — take actions, then end turn when done."
                            : "Click to begin your full turn now (or wait — it starts automatically)."
                    }
                    onClick={
                      !gameState.turnOpen && gameState.canAct !== false && !turnProcessing
                        ? () => void handleStartFullTurn()
                        : undefined
                    }
                  >
                    {gameState.empire.turnsLeft < 1
                      ? "▸ NO TURNS LEFT"
                      : gameState.canAct === false
                        ? "▸ WAITING FOR OTHERS"
                        : gameState.turnOpen
                          ? "▸ TURN OPEN"
                          : "▸ START FULL TURN"}
                  </span>
                  {(gameState.roundEndsAt ?? gameState.turnDeadline) && (
                    <TurnTimer
                      deadline={(gameState.roundEndsAt ?? gameState.turnDeadline) as string}
                      isYourTurn={gameState.canAct !== false}
                    />
                  )}
                </>
              ) : (
                <>
                  <span className={`font-bold ${gameState.isYourTurn !== false ? "text-cyan-400" : "text-yellow-400"}`}>
                    {gameState.isYourTurn !== false
                      ? "▸ YOUR TURN"
                      : `▸ ${gameState.currentTurnPlayer?.toUpperCase()}'S TURN`}
                  </span>
                  {gameState.turnDeadline && (
                    <TurnTimer deadline={gameState.turnDeadline} isYourTurn={gameState.isYourTurn !== false} />
                  )}
                </>
              )}
              <span className="text-green-700">│</span>
              <span className="text-yellow-400 font-bold">{gameState.empire.credits.toLocaleString()} cr</span>
              <span className="text-green-700">│</span>
              <span className="text-green-600">T{gameState.empire.turnsPlayed}</span>
              <span className={gameState.empire.turnsLeft < 10 ? "text-red-400" : "text-green-700"}>
                ({gameState.empire.turnsLeft} left)
              </span>
              {gameState.empire.isProtected && (
                <span className="text-blue-400">[P{gameState.empire.protectionTurns}]</span>
              )}
            </>
          )}
          <span className="text-green-700">│</span>
          <span className="text-green-600">{playerName}</span>
          <button
            type="button"
            onClick={() => void openHelp()}
            className="ml-1 border border-green-800 text-green-600 hover:border-green-500 hover:text-green-400 px-1.5 py-0.5 text-[10px] leading-none"
            title="Show help (game rules & reference)"
          >
            ?
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="ml-1 border border-green-900 text-green-800 hover:border-green-700 hover:text-green-600 px-1.5 py-0.5 text-[10px] leading-none"
            title="Return to hub"
          >
            ⎋
          </button>
        </div>
      </header>

      {showHelp && helpContent && (
        <HelpModal
          title={helpContent.title}
          content={helpContent.content}
          onClose={() => setShowHelp(false)}
        />
      )}

      {actionError && (
        <div
          role="alert"
          aria-live="assertive"
          className="shrink-0 mb-1 flex items-start gap-2 border-2 border-red-500 bg-red-950/90 px-3 py-2 text-sm text-red-100 shadow-[0_0_16px_rgba(239,68,68,0.25)]"
        >
          <span className="font-bold text-red-400 shrink-0">✖ FAILED</span>
          <span className="flex-1 min-w-0 break-words leading-snug">{actionError}</span>
          <button
            type="button"
            onClick={dismissActionError}
            className="shrink-0 px-1.5 py-0.5 text-red-300 hover:text-white border border-red-700 hover:border-red-400"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="mb-1 shrink-0">
        <Leaderboard
          currentPlayer={playerName}
          playerId={sessionPlayerId}
          refreshKey={refreshKey}
          onSelectTarget={setTargetName}
          onRivalsLoaded={setRivalNames}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 lg:min-h-[calc(100vh-7rem)]">
          <div className="lg:col-span-3">
            {gameState && <EmpirePanel state={gameState} />}
          </div>
          <div className="lg:col-span-5 lg:min-h-[calc(100vh-7rem)]">
            <ActionPanel
              onAction={handleAction}
              onSkipTurn={handleSkipTurn}
              state={gameState}
              targetName={targetName}
              onTargetChange={setTargetName}
              rivalNames={rivalNames}
              disabled={
                turnProcessing ||
                (gameState?.turnMode === "simultaneous"
                  ? simultaneousDoorCommandCenterDisabled(gameState?.canAct, gameState?.turnOpen)
                  : gameState?.isYourTurn === false)
              }
              skipDisabled={
                turnProcessing ||
                (gameState?.turnMode === "simultaneous"
                  ? gameState?.canAct === false
                  : gameState?.isYourTurn === false)
              }
              turnProcessing={turnProcessing}
              currentTurnPlayer={
                gameState?.turnMode === "simultaneous"
                  ? gameState?.canAct === false
                    ? "others"
                    : null
                  : (gameState?.currentTurnPlayer ?? null)
              }
              turnOrder={gameState?.turnOrder}
              sessionInfo={gameSessionId ? {
                gameSessionId,
                isPublic,
                inviteCode: inviteCode || null,
                galaxyName: galaxyName || null,
                isCreator,
                turnTimeoutSecs: gameState?.turnTimeoutSecs ?? 86400,
              } : undefined}
              onSessionUpdate={updateSessionVisibility}
              onTurnTimerUpdate={updateTurnTimer}
            />
          </div>
          <div className="lg:col-span-4 lg:min-h-[calc(100vh-7rem)]">
            <EventLog events={events} />
          </div>
        </div>
      </div>

      {dayRolloverNotice && !gameOver && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="day-rollover-title"
        >
          <div className="border border-yellow-600 bg-black p-6 max-w-md text-center shadow-xl">
            <p id="day-rollover-title" className="text-yellow-400 font-bold mb-2 tracking-wider">
              DAY {dayRolloverNotice.completedDay} COMPLETE
            </p>
            <p className="text-green-500 text-sm mb-4 leading-relaxed">
              A new calendar day has begun. Each commander gets up to five full turns (tick → actions → end) per day; your game turn counter drops once when the day completes.
            </p>
            <button
              type="button"
              className="border border-green-600 px-4 py-2 text-cyan-400 hover:bg-green-950 font-mono"
              onClick={() => setDayRolloverNotice(null)}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {endOfDayModal && !gameOver && gameState?.turnMode === "simultaneous" && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="end-of-day-title"
        >
          <div className="border border-cyan-700 bg-black p-6 max-w-md text-center shadow-xl">
            <p id="end-of-day-title" className="text-cyan-400 font-bold mb-2 tracking-wider">
              DAY COMPLETE FOR YOU
            </p>
            <p className="text-green-500 text-sm mb-2 leading-relaxed">
              You have used all {gameState.actionsPerDay ?? 5} full turns today. Credits: {gameState.empire.credits.toLocaleString()} · Net worth:{" "}
              {gameState.empire.netWorth.toLocaleString()}
            </p>
            <p className="text-green-700 text-xs mb-4">
              Your day is complete. The galaxy may still be active — other commanders may still be playing this round.
            </p>
            <button
              type="button"
              className="border border-green-600 px-4 py-2 text-cyan-400 hover:bg-green-950 font-mono"
              onClick={() => setEndOfDayModal(false)}
            >
              OK
            </button>
          </div>
        </div>
      )}

      {turnPopup && !gameOver && <TurnSummaryModal data={turnPopup} onClose={handleTurnPopupClose} />}

      {gameOver && (
        <GameOverScreen
          data={gameOver}
          playerName={playerName}
          onExportLog={async () => {
            const res = await fetch(`/api/game/log?player=${encodeURIComponent(playerName)}`);
            const data = await res.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `srx-game-log-${playerName}-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Internal components
// ---------------------------------------------------------------------------

function TurnSummaryModal({ data, onClose }: { data: TurnPopupData; onClose: () => void }) {
  const netIncome = data.income.total - data.expenses.total;
  const totalSales = data.income.foodSales + data.income.oreSales + data.income.petroSales;
  const classified = classifyTurnEvents(data.events);
  const hasCritical = classified.critical.length > 0;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <div
        className={`border bg-black p-5 w-[480px] max-h-[85vh] overflow-y-auto font-mono text-xs shadow-lg ${hasCritical ? "border-red-600 shadow-red-900/40" : "border-green-600 shadow-green-900/30"}`}
        onClick={(e) => e.stopPropagation()}
      >
        {hasCritical && (
          <div className="border-2 border-red-600 bg-red-950/40 p-3 mb-3 animate-pulse">
            <div className="text-red-400 font-bold text-sm text-center tracking-widest mb-1">⚠ CRITICAL ALERTS ⚠</div>
            {classified.critical.map((ev, i) => (
              <div key={i} className="text-red-300 text-center py-0.5 font-bold break-words">{ev}</div>
            ))}
          </div>
        )}

        <div className="text-center mb-3">
          <div className="text-yellow-400 font-bold text-sm tracking-widest">
            {data.mode === "intel_report"
              ? "INTELLIGENCE REPORT"
              : data.mode === "turn_start"
                ? `TURN ${data.turn} — SITUATION REPORT`
                : `TURN ${data.turn} REPORT`}
          </div>
          <div className="text-green-500 text-[10px]">
            {data.mode === "turn_start" && "Review before choosing your action"}
            {data.mode === "intel_report" && (<>Target: <span className="text-cyan-400">{data.intelTarget || "—"}</span></>)}
            {data.mode === "action_result" && `${data.action}: ${data.actionMsg}`}
          </div>
        </div>

        {data.mode === "turn_start" && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <div>
              <div className="text-green-400 font-bold border-b border-green-900 mb-1 pb-0.5">INCOME</div>
              <Row label="Tax revenue" value={data.income.populationTax} color="text-green-300" />
              <Row label="Urban tax" value={data.income.urbanTax} color="text-green-300" />
              <Row label="Tourism" value={data.income.tourism} color="text-green-300" />
              {totalSales > 0 && <Row label="Market sales" value={totalSales} color="text-green-300" />}
              {data.income.galacticRedistribution > 0 && <Row label="Redistribution" value={data.income.galacticRedistribution} color="text-green-300" />}
              <Row label="TOTAL" value={data.income.total} color="text-green-400" bold />
            </div>
            <div>
              <div className="text-red-400 font-bold border-b border-green-900 mb-1 pb-0.5">EXPENSES</div>
              <Row label="Planets" value={data.expenses.planetMaintenance} color="text-red-300" />
              <Row label="Military" value={data.expenses.militaryMaintenance} color="text-red-300" />
              {data.expenses.galacticTax > 0 && <Row label="Galactic tax" value={data.expenses.galacticTax} color="text-red-300" />}
              <Row label="TOTAL" value={data.expenses.total} color="text-red-400" bold />
            </div>
            <div className="col-span-2 text-center py-1.5 border border-green-900 rounded">
              <span className={`font-bold text-sm ${netIncome >= 0 ? "text-green-400" : "text-red-400"}`}>
                NET: {netIncome >= 0 ? "+" : ""}{netIncome.toLocaleString()} cr
              </span>
            </div>
            <div>
              <div className="text-cyan-400 font-bold border-b border-green-900 mb-1 pb-0.5">POPULATION</div>
              <Row label="Births" value={data.population.births} color="text-cyan-300" prefix="+" />
              <Row label="Immigration" value={data.population.immigration} color="text-cyan-300" prefix="+" />
              <Row label="Deaths" value={data.population.deaths} color="text-orange-300" prefix="-" />
              <Row label="Emigration" value={data.population.emigration} color="text-orange-300" prefix="-" />
              <Row label="TOTAL" value={data.population.newTotal} color="text-cyan-400" bold
                suffix={` (${data.population.net >= 0 ? "+" : ""}${data.population.net.toLocaleString()})`} />
            </div>
            <div>
              <div className="text-green-500 font-bold border-b border-green-900 mb-1 pb-0.5">RESOURCES</div>
              <div className="flex justify-between"><span className="text-green-600">Food</span><span className="text-green-300">+{data.resources.foodProduced} / -{data.resources.foodConsumed}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Ore</span><span className="text-green-300">+{data.resources.oreProduced} / -{data.resources.oreConsumed}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Fuel</span><span className="text-green-300">+{data.resources.fuelProduced} / -{data.resources.fuelConsumed}</span></div>
              <div className="mt-1 pt-1 border-t border-green-900">
                <div className="flex justify-between"><span className="text-green-600">Status</span><span className="text-green-300">{data.civilStatus}</span></div>
                <div className="flex justify-between"><span className="text-green-600">Net Worth</span><span className="text-yellow-400 font-bold">{data.netWorth.toLocaleString()}</span></div>
              </div>
            </div>
          </div>
        )}

        {data.combat && (
          <div className="mt-3 pt-2 border-t border-green-900">
            <div className={`font-bold mb-2 text-sm text-center tracking-wider ${data.combat.victory ? "text-yellow-400" : "text-red-400"}`}>
              {data.combat.victory ? "⚔ VICTORY" : "⚔ DEFEAT"} — {data.combat.type.toUpperCase()} vs {data.combat.target}
            </div>
            {data.combat.fronts && data.combat.fronts.length > 0 && (
              <div className="mb-2">
                {data.combat.fronts.map((f, i) => (
                  <div key={i} className="flex justify-between py-0.5">
                    <span className="text-green-600 capitalize">{f.name} front</span>
                    <span className={f.won ? "text-green-400" : "text-red-400"}>{f.won ? "Won" : "Lost"} ({f.attackerWins}-{f.defenderWins})</span>
                  </div>
                ))}
              </div>
            )}
            {data.combat.loot && (
              <div className="mb-2 border border-yellow-900/50 p-1.5 bg-yellow-900/10">
                <div className="text-yellow-400 font-bold mb-0.5">SPOILS OF WAR</div>
                {data.combat.loot.planetsCaptures > 0 && <div className="flex justify-between"><span className="text-green-600">Planets captured</span><span className="text-yellow-300">{data.combat.loot.planetsCaptures}</span></div>}
                {data.combat.loot.creditsLooted > 0 && <div className="flex justify-between"><span className="text-green-600">Credits looted</span><span className="text-yellow-300">{data.combat.loot.creditsLooted.toLocaleString()}</span></div>}
                {data.combat.loot.populationTransferred > 0 && <div className="flex justify-between"><span className="text-green-600">Population gained</span><span className="text-yellow-300">{data.combat.loot.populationTransferred.toLocaleString()}</span></div>}
                {(data.combat.loot.oreLooted ?? 0) > 0 && <div className="flex justify-between"><span className="text-green-600">Ore recovered</span><span className="text-yellow-300">{data.combat.loot.oreLooted!.toLocaleString()}</span></div>}
                {(data.combat.loot.foodLooted ?? 0) > 0 && <div className="flex justify-between"><span className="text-green-600">Food recovered</span><span className="text-yellow-300">{data.combat.loot.foodLooted!.toLocaleString()}</span></div>}
              </div>
            )}
            {Object.values(data.combat.attackerLosses).some(v => v > 0) && (
              <div className="mb-1">
                <div className="text-red-400 font-bold mb-0.5">YOUR LOSSES</div>
                {Object.entries(data.combat.attackerLosses).filter(([, v]) => v > 0).map(([unit, count]) => (
                  <div key={unit} className="flex justify-between">
                    <span className="text-green-600 capitalize">{unit.replace(/([A-Z])/g, " $1").trim()}</span>
                    <span className="text-red-300">-{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {data.combat.defenderLosses && Object.values(data.combat.defenderLosses).some(v => v > 0) && (
              <div className="mb-1">
                <div className="text-orange-400 font-bold mb-0.5">TARGET UNIT LOSSES</div>
                {Object.entries(data.combat.defenderLosses).filter(([, v]) => v > 0).map(([unit, count]) => (
                  <div key={unit} className="flex justify-between">
                    <span className="text-green-600 capitalize">{unit.replace(/([A-Z])/g, " $1").trim()}</span>
                    <span className="text-orange-300">-{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            {data.combat.planetCasualties && data.combat.planetCasualties.length > 0 && (
              <div className="mb-1 border border-orange-900/50 p-1.5 bg-orange-950/20">
                <div className="text-orange-400 font-bold mb-0.5">PLANET CASUALTIES</div>
                {data.combat.planetCasualties.map((row, i) => (
                  <div key={i} className="flex justify-between py-0.5">
                    <span className="text-green-600">{row.planetName}</span>
                    <span className="text-orange-300">{row.populationKilled.toLocaleString()} pop killed</span>
                  </div>
                ))}
                {data.combat.populationKilledTotal != null && (
                  <div className="flex justify-between border-t border-orange-900/40 mt-1 pt-1">
                    <span className="text-green-600">Total population killed</span>
                    <span className="text-orange-300 font-bold">{data.combat.populationKilledTotal.toLocaleString()}</span>
                  </div>
                )}
              </div>
            )}
            {(data.combat.defenderCivilLevelsGained != null || data.combat.defenderEffectivenessLost != null) && (
              <div className="mb-1 border border-purple-900/50 p-1.5 bg-purple-950/20">
                <div className="text-purple-400 font-bold mb-0.5">PSIONIC EFFECT ON TARGET</div>
                {data.combat.defenderCivilLevelsGained != null && (
                  <div className="flex justify-between"><span className="text-green-600">Civil unrest levels</span><span className="text-purple-300">+{data.combat.defenderCivilLevelsGained}</span></div>
                )}
                {data.combat.defenderEffectivenessLost != null && (
                  <div className="flex justify-between"><span className="text-green-600">Army effectiveness</span><span className="text-purple-300">−{data.combat.defenderEffectivenessLost}%</span></div>
                )}
              </div>
            )}
          </div>
        )}

        {data.events.length > 0 && (
          <div className="mt-3 pt-2 border-t border-green-900">
            <div className="text-yellow-400 font-bold mb-1">{data.mode === "intel_report" ? "INTELLIGENCE" : "EVENTS"}</div>
            {classified.critical.map((ev, i) => (<div key={`c${i}`} className="text-red-400 font-bold py-0.5 break-words">⚠ {ev}</div>))}
            {classified.warnings.map((ev, i) => (<div key={`w${i}`} className="text-yellow-300 py-0.5 break-words">⚡ {ev}</div>))}
            {classified.info.map((ev, i) => (<div key={`i${i}`} className="text-green-500 py-0.5 break-words">● {ev}</div>))}
          </div>
        )}

        <button
          onClick={onClose}
          autoFocus
          className={`mt-4 w-full border py-2 text-sm tracking-wider ${data.mode === "turn_start" || data.mode === "intel_report" ? "border-yellow-600 hover:bg-yellow-900/30 text-yellow-400" : "border-green-600 hover:bg-green-900 text-green-400"}`}
        >
          {data.mode === "turn_start" || data.mode === "intel_report" ? "CHOOSE ACTION" : "CONTINUE"}
        </button>
        <div className="text-center text-green-800 text-[10px] mt-1">Press Enter or click anywhere outside to dismiss</div>
      </div>
    </div>
  );
}

function Row({ label, value, color, bold, prefix, suffix }: {
  label: string; value: number; color: string; bold?: boolean; prefix?: string; suffix?: string;
}) {
  if (value === 0 && !bold) return null;
  return (
    <div className="flex justify-between">
      <span className="text-green-600">{label}</span>
      <span className={`${color} ${bold ? "font-bold" : ""}`}>
        {prefix}{value.toLocaleString()}{suffix ?? ""}
      </span>
    </div>
  );
}

function GameOverScreen({ data, playerName, onExportLog }: { data: GameOverData; playerName: string; onExportLog: () => Promise<void> }) {
  const isWinner = data.winner === playerName;
  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95">
      <div className="border border-yellow-600 bg-black p-6 w-[600px] max-h-[90vh] overflow-y-auto font-mono text-xs shadow-lg shadow-yellow-900/30">
        <div className="text-center mb-4">
          <pre className="text-yellow-400 text-[10px] leading-tight mb-2">{`
 ██████╗  █████╗ ███╗   ███╗███████╗
██╔════╝ ██╔══██╗████╗ ████║██╔════╝
██║  ███╗███████║██╔████╔██║█████╗
██║   ██║██╔══██║██║╚██╔╝██║██╔══╝
╚██████╔╝██║  ██║██║ ╚═╝ ██║███████╗
 ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝
  ██████╗ ██╗   ██╗███████╗██████╗
 ██╔═══██╗██║   ██║██╔════╝██╔══██╗
 ██║   ██║██║   ██║█████╗  ██████╔╝
 ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗
 ╚██████╔╝ ╚████╔╝ ███████╗██║  ██║
  ╚═════╝   ╚═══╝  ╚══════╝╚═╝  ╚═╝`}</pre>
          <div className={`text-lg font-bold tracking-widest ${isWinner ? "text-yellow-400" : "text-green-400"}`}>
            {isWinner ? "GALACTIC DOMINATION ACHIEVED" : "THE GALAXY HAS BEEN CONQUERED"}
          </div>
          <div className="text-green-600 text-sm mt-1">
            {isWinner
              ? `Commander ${playerName}, you reign supreme!`
              : `Commander ${data.winner} has won. You placed #${data.playerRank}.`}
          </div>
        </div>

        <div className="border border-green-800 p-3 mb-4">
          <div className="text-yellow-400 font-bold mb-2 tracking-wider text-center">FINAL STANDINGS</div>
          <div className="text-green-700 text-[10px] flex mb-1 border-b border-green-900 pb-1">
            <span className="w-8">Rk</span>
            <span className="flex-1">Commander</span>
            <span className="w-20 text-right">Net Worth</span>
            <span className="w-16 text-right">Pop</span>
            <span className="w-10 text-right">Plt</span>
            <span className="w-12 text-right">Mil</span>
          </div>
          {data.standings.map((s, i) => {
            const isYou = s.name === playerName;
            return (
              <div key={s.name} className={`flex items-center py-0.5 ${isYou ? "text-yellow-400 font-bold" : "text-green-300"}`}>
                <span className="w-8">{medals[i] ?? `#${i + 1}`}</span>
                <span className="flex-1">{s.name}{s.isAI ? " [AI]" : ""}{isYou ? " (you)" : ""}</span>
                <span className="w-20 text-right">{s.netWorth.toLocaleString()}</span>
                <span className="w-16 text-right">{s.population >= 1000 ? `${Math.round(s.population / 1000)}K` : s.population}</span>
                <span className="w-10 text-right">{s.planets}</span>
                <span className="w-12 text-right">{s.military.toLocaleString()}</span>
              </div>
            );
          })}
        </div>

        {data.playerScore && (
          <div className="border border-green-800 p-3 mb-4">
            <div className="text-green-400 font-bold mb-2 tracking-wider text-center">YOUR EMPIRE SUMMARY</div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <div className="flex justify-between"><span className="text-green-600">Net Worth</span><span className="text-yellow-400 font-bold">{data.playerScore.netWorth.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Credits</span><span className="text-green-300">{data.playerScore.credits.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Population</span><span className="text-cyan-300">{data.playerScore.population.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Planets</span><span className="text-green-300">{data.playerScore.planets}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Military</span><span className="text-red-300">{data.playerScore.military.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Rank</span><span className="text-yellow-400">#{data.playerRank} of {data.standings.length}</span></div>
            </div>
          </div>
        )}

        {data.highScores.length > 0 && (
          <div className="border border-green-800 p-3 mb-4">
            <div className="text-yellow-400 font-bold mb-2 tracking-wider text-center">ALL-TIME HIGH SCORES</div>
            {data.highScores.map((hs, i) => (
              <div key={i} className={`flex items-center py-0.5 ${hs.playerName === playerName ? "text-yellow-400" : "text-green-300"}`}>
                <span className="w-8">{medals[i] ?? `#${i + 1}`}</span>
                <span className="flex-1">{hs.playerName}</span>
                <span className="w-24 text-right">{hs.netWorth.toLocaleString()}</span>
                <span className="w-24 text-right text-green-700 text-[10px]">{new Date(hs.finishedAt).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={() => void onExportLog()} className="flex-1 border border-green-700 py-2 text-sm hover:bg-green-900 text-green-400">
            EXPORT GAME LOG
          </button>
          <button onClick={() => window.location.reload()} className="flex-1 border border-yellow-600 py-2 text-sm hover:bg-yellow-900 text-yellow-400">
            NEW GAME
          </button>
        </div>
        <div className="text-center text-green-800 text-[10px] mt-2">Game log exported as JSON for analysis</div>
      </div>
    </div>
  );
}
