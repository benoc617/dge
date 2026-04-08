"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import EmpirePanel from "@/components/EmpirePanel";
import ActionPanel from "@/components/ActionPanel";
import EventLog from "@/components/EventLog";
import Leaderboard from "@/components/Leaderboard";
import { classifyTurnEvents } from "@/lib/critical-events";
import { AUTH, SESSION } from "@/lib/game-constants";
import { apiFetch } from "@/lib/client-fetch";
import { simultaneousDoorCommandCenterDisabled } from "@/lib/door-game-ui";

interface HubGame {
  playerId: string;
  playerName: string;
  gameSessionId: string;
  galaxyName: string | null;
  turnsLeft: number;
  turnsPlayed: number;
  inviteCode: string | null;
  isPublic: boolean;
  isYourTurn: boolean;
  currentTurnPlayer: string | null;
  maxPlayers: number;
  playerCount: number;
  waitingForHuman: boolean;
}

/** POST /api/game/register JSON body (partial). */
type RegisterApiPayload = {
  error?: string;
  message?: string;
  gameSessionId?: string;
  inviteCode?: string;
  galaxyName?: string | null;
  isPublic?: boolean;
  id?: string;
  name?: string;
};

function apiErrorMessage(data: RegisterApiPayload, res: Response, fallback: string): string {
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (!res.ok) return `${fallback} (HTTP ${res.status})`;
  return fallback;
}

export interface GameState {
  player: { id: string; name: string; isAI: boolean };
  isYourTurn?: boolean;
  /** True when session is admin-staged and no turn is active yet (should be brief). */
  waitingForGameStart?: boolean;
  currentTurnPlayer?: string | null;
  turnDeadline?: string | null;
  turnOrder?: { name: string; isAI: boolean }[];
  turnTimeoutSecs?: number;
  empire: {
    credits: number;
    food: number;
    ore: number;
    fuel: number;
    population: number;
    taxRate: number;
    civilStatus: number;
    civilStatusName: string;
    foodSellRate: number;
    oreSellRate: number;
    petroleumSellRate: number;
    netWorth: number;
    turnsPlayed: number;
    turnsLeft: number;
    isProtected: boolean;
    protectionTurns: number;
    turnOpen?: boolean;
    fullTurnsUsedThisRound?: number;
  };
  planets: {
    id: string;
    name: string;
    sector: number;
    type: string;
    typeLabel: string;
    population: number;
    longTermProduction: number;
    shortTermProduction: number;
    defenses: number;
    isRadiated: boolean;
  }[];
  planetSummary: Record<string, number>;
  army: {
    soldiers: number;
    generals: number;
    fighters: number;
    defenseStations: number;
    lightCruisers: number;
    heavyCruisers: number;
    carriers: number;
    covertAgents: number;
    commandShipStrength: number;
    effectiveness: number;
    covertPoints: number;
    soldiersLevel: number;
    fightersLevel: number;
    stationsLevel: number;
    lightCruisersLevel: number;
    heavyCruisersLevel: number;
  } | null;
  supplyRates: {
    rateSoldier: number;
    rateFighter: number;
    rateStation: number;
    rateHeavyCruiser: number;
    rateCarrier: number;
    rateGeneral: number;
    rateCovert: number;
    rateCredits: number;
  } | null;
  research: {
    accumulatedPoints: number;
    unlockedTechIds: string[];
  } | null;
  /** `simultaneous` = door-game (SRE-style) multi–full-turn days; omitted = legacy sequential. */
  turnMode?: "sequential" | "simultaneous";
  dayNumber?: number;
  actionsPerDay?: number;
  /** Full turns remaining this calendar round (tick→actions→end_turn each). */
  fullTurnsLeftToday?: number;
  turnOpen?: boolean;
  canAct?: boolean;
  roundEndsAt?: string | null;
}

interface CombatSummary {
  type: string;
  target: string;
  victory: boolean;
  fronts?: { name: string; attackerWins: number; defenderWins: number; won: boolean }[];
  loot?: { planetsCaptures: number; creditsLooted: number; populationTransferred: number; oreLooted?: number; foodLooted?: number };
  attackerLosses: Record<string, number>;
  defenderLosses?: Record<string, number>;
  messages: string[];
  /** Nuclear / chemical per-planet population killed */
  planetCasualties?: { planetName: string; populationKilled: number }[];
  populationKilledTotal?: number;
  planetsRadiatedCount?: number;
  planetsAffectedCount?: number;
  defenderCivilLevelsGained?: number;
  defenderEffectivenessLost?: number;
}

interface TurnPopupData {
  mode: "turn_start" | "action_result" | "intel_report";
  turn: number;
  action: string;
  actionMsg: string;
  /** Covert op target name (intel_report) */
  intelTarget?: string;
  income: { total: number; populationTax: number; urbanTax: number; tourism: number; foodSales: number; oreSales: number; petroSales: number; galacticRedistribution: number };
  expenses: { total: number; planetMaintenance: number; militaryMaintenance: number; galacticTax: number };
  population: { births: number; deaths: number; immigration: number; emigration: number; net: number; newTotal: number };
  resources: { foodProduced: number; foodConsumed: number; oreProduced: number; oreConsumed: number; fuelProduced: number; fuelConsumed: number };
  civilStatus: string;
  netWorth: number;
  events: string[];
  combat?: CombatSummary;
}

const TURN_TIMER_OPTIONS = [
  { label: "5 min", value: "5m", secs: 300 },
  { label: "30 min", value: "30m", secs: 1800 },
  { label: "1 hour", value: "1h", secs: 3600 },
  { label: "6 hours", value: "6h", secs: 21600 },
  { label: "12 hours", value: "12h", secs: 43200 },
  { label: "24 hours", value: "24h", secs: 86400 },
  { label: "48 hours", value: "48h", secs: 172800 },
  { label: "7 days", value: "7d", secs: 604800 },
];

function parseTurnTimer(value: string): number {
  return TURN_TIMER_OPTIONS.find((o) => o.value === value)?.secs ?? 86400;
}

const MAX_AI_COUNT = 5;

interface GameOverData {
  standings: { name: string; isAI: boolean; netWorth: number; population: number; planets: number; credits: number; turnsPlayed: number; military: number }[];
  winner: string;
  playerRank: number;
  playerScore?: { name: string; netWorth: number; population: number; planets: number; credits: number; military: number };
  highScores: { playerName: string; netWorth: number; rank: number; totalPlayers: number; finishedAt: string }[];
}

export default function Home() {
  const [playerName, setPlayerName] = useState("");
  const [inputName, setInputName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [turnProcessing, setTurnProcessing] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [targetName, setTargetName] = useState("");
  const [rivalNames, setRivalNames] = useState<string[]>([]);
  const [turnPopup, setTurnPopup] = useState<TurnPopupData | null>(null);
  const [tickFired, setTickFired] = useState(false);
  const [gameOver, setGameOver] = useState<GameOverData | null>(null);
  /** Immediate feedback when an in-game action fails (credits, caps, etc.). */
  const [actionError, setActionError] = useState<string | null>(null);
  const actionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevDayNumberRef = useRef<number | null>(null);
  /** Door-game: detect turnOpen true→false so we can reset tickFired for the next auto-tick. */
  const prevTurnOpenRef = useRef<boolean | null>(null);
  /** Stable id for refresh right after register/join before React state flushes. */
  const createdPlayerIdRef = useRef<string | null>(null);
  /** After combat/intel modal, auto /tick must not overwrite turnPopup — queue situation report here. */
  const deferSituationReportUntilPopupClosedRef = useRef(false);
  const pendingTurnStartPopupRef = useRef<TurnPopupData | null>(null);
  const pendingEndOfDayAfterModalChainRef = useRef(false);

  const [gameSessionId, setGameSessionId] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [galaxyName, setGalaxyName] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [isCreator, setIsCreator] = useState(false);

  // Lobby state
  const [lobbies, setLobbies] = useState<{ id: string; galaxyName: string; createdBy: string; playerCount: number; maxPlayers: number; turnTimeoutSecs?: number }[]>([]);
  const [joinInviteCode, setJoinInviteCode] = useState("");

  const [authUser, setAuthUser] = useState<{ username: string; fullName: string; email: string } | null>(null);
  const [authGames, setAuthGames] = useState<HubGame[]>([]);
  const [sessionPlayerId, setSessionPlayerId] = useState<string | null>(null);

  const [signupFullName, setSignupFullName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupPasswordConfirm, setSignupPasswordConfirm] = useState("");

  // New game setup state
  const [setupPhase, setSetupPhase] = useState<
    "login" | "signup" | "hub" | "join-game" | "create-galaxy"
  >("login");
  const [aiCount, setAiCount] = useState(3);
  const [inputGalaxyName, setInputGalaxyName] = useState("");
  const [inputIsPublic, setInputIsPublic] = useState(true);
  const [inputTurnTimer, setInputTurnTimer] = useState("24h");
  const [inputMaxPlayers, setInputMaxPlayers] = useState(String(SESSION.MAX_PLAYERS_DEFAULT));
  const [inputSimultaneousTurns, setInputSimultaneousTurns] = useState(false);
  const [dayRolloverNotice, setDayRolloverNotice] = useState<{ completedDay: number } | null>(null);
  const [endOfDayModal, setEndOfDayModal] = useState(false);

  const addEvent = useCallback((msg: string) => {
    setEvents((prev) => [`[T${prev.length}] ${msg}`, ...prev.slice(0, 199)]);
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

  const triggerGameOver = useCallback(async (name: string) => {
    const res = await apiFetch("/api/game/gameover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName: name }),
    });
    if (res.ok) {
      const data = await res.json();
      setGameOver(data);
    }
  }, []);

  const refreshState = useCallback(
    async (name: string, playerId?: string | null): Promise<GameState | null> => {
      const tR0 = performance.now();
      const qs = playerId
        ? `id=${encodeURIComponent(playerId)}`
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
        const data = JSON.parse(raw) as GameState & {
          empire?: { turnsLeft?: number };
        };
        setGameState(data);
        setRefreshKey((k) => k + 1);
        console.log(`[srx-ui] refreshState ${(performance.now()-tR0).toFixed(0)}ms`);
        if (data.empire?.turnsLeft !== undefined && data.empire.turnsLeft <= 0 && !gameOver) {
          triggerGameOver(name);
        }
        return data;
      } catch {
        /* ignore malformed status payload or AbortError from timeout */
        return null;
      }
    },
    [gameOver, triggerGameOver],
  );

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

  async function register() {
    setError("");
    if (!authUser) {
      setError("Sign in required.");
      return;
    }
    if (!loginPassword.trim()) {
      setError("Password required");
      return;
    }
    setLoading(true);
    const maxP = Math.min(
      SESSION.MAX_PLAYERS_CAP,
      Math.max(SESSION.MIN_PLAYERS, Number.parseInt(inputMaxPlayers, 10) || SESSION.MAX_PLAYERS_DEFAULT),
    );
    const res = await apiFetch("/api/game/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: inputName,
        password: loginPassword,
        galaxyName: inputGalaxyName.trim() || null,
        isPublic: inputIsPublic,
        turnTimeoutSecs: parseTurnTimer(inputTurnTimer),
        maxPlayers: maxP,
        turnMode: inputSimultaneousTurns ? "simultaneous" : "sequential",
      }),
    });
    const raw = await res.text();
    let data: RegisterApiPayload = {};
    if (raw.trim()) {
      try {
        data = JSON.parse(raw) as RegisterApiPayload;
      } catch {
        setError("Registration failed (server returned invalid data).");
        setLoading(false);
        return;
      }
    }
    if (!res.ok) {
      setError(apiErrorMessage(data, res, "Registration failed"));
      setLoading(false);
      return;
    }
    if (data.gameSessionId) setGameSessionId(data.gameSessionId);
    if (data.inviteCode) setInviteCode(data.inviteCode);
    if (data.galaxyName) setGalaxyName(data.galaxyName);
    setIsPublic(data.isPublic ?? true);
    setIsCreator(true);
    if (data.id) {
      setSessionPlayerId(data.id);
      createdPlayerIdRef.current = data.id;
    }
    const commanderName = typeof data.name === "string" ? data.name : inputName;
    if (typeof data.name === "string") setInputName(data.name);

    const sessionId = data.gameSessionId as string | undefined;
    if (sessionId && aiCount > 0) {
      addEvent("Setting up AI opponents...");
      const resAi = await apiFetch("/api/ai/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: aiCount,
          gameSessionId: sessionId,
        }),
      });
      const aiData = (await resAi.json()) as { created?: string[] };
      if (resAi.ok) {
        for (const n of aiData.created ?? []) {
          addEvent(`AI Commander ${n} has entered the galaxy.`);
        }
      } else {
        setError((aiData as { error?: string }).error ?? "AI setup failed");
        setLoading(false);
        return;
      }
    }

    setPlayerName(commanderName);
    await refreshState(commanderName, createdPlayerIdRef.current ?? sessionPlayerId);
    addEvent(`Welcome, Commander ${commanderName}! Your empire awaits.`);
    setLoading(false);
  }

  async function fetchLobbies() {
    const res = await apiFetch("/api/game/lobbies");
    if (res.ok) {
      setLobbies(await res.json());
    }
  }

  async function joinGame(sessionId?: string) {
    setError("");
    if (!authUser) {
      setError("Sign in required.");
      return;
    }
    if (!loginPassword.trim()) {
      setError("Password required");
      return;
    }
    setLoading(true);
    const body: Record<string, unknown> = {
      name: inputName,
      password: loginPassword,
    };
    if (sessionId) body.sessionId = sessionId;
    else if (joinInviteCode) body.inviteCode = joinInviteCode;
    else {
      setError("Enter an invite code or select a public galaxy");
      setLoading(false);
      return;
    }
    const res = await apiFetch("/api/game/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Failed to join");
      setLoading(false);
      return;
    }
    if (data.gameSessionId) setGameSessionId(data.gameSessionId);
    if (data.galaxyName) setGalaxyName(data.galaxyName);
    if (data.id) {
      setSessionPlayerId(data.id);
      createdPlayerIdRef.current = data.id;
    }
    const pname = typeof data.name === "string" ? data.name : inputName;
    setPlayerName(pname);
    await refreshState(pname, data.id);
    addEvent(`Welcome, Commander ${pname}! You have joined the galaxy.`);
    setLoading(false);
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
      await refreshState(playerName, sessionPlayerId ?? undefined);
    }
  }

  async function login() {
    setLoading(true);
    setError("");
    const resAuth = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: inputName.trim(), password: loginPassword }),
    });
    if (resAuth.ok) {
      const data = (await resAuth.json()) as {
        user: { username: string; fullName: string; email: string };
        games: HubGame[];
      };
      setAuthUser(data.user);
      setAuthGames(data.games);
      setInputName(data.user.username);
      setSetupPhase("hub");
      setLoading(false);
      return;
    }
    if (resAuth.status === 404) {
      const res = await apiFetch("/api/game/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: inputName, password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Invalid credentials");
        setLoading(false);
        return;
      }
      setAuthUser(null);
      setAuthGames([]);
      setPlayerName(inputName);
      if (data.player?.id) {
        setSessionPlayerId(data.player.id);
        createdPlayerIdRef.current = data.player.id;
      }
      if (data.gameSessionId) {
        setGameSessionId(data.gameSessionId);
        const sesRes = await fetch(`/api/game/session?id=${data.gameSessionId}`);
        if (sesRes.ok) {
          const ses = await sesRes.json();
          setInviteCode(ses.inviteCode ?? "");
          setGalaxyName(ses.galaxyName ?? "");
          setIsPublic(ses.isPublic ?? true);
          setIsCreator(ses.createdBy === inputName);
        }
      }
      setGameState(data);
      setRefreshKey((k) => k + 1);
      addEvent(`Welcome back, Commander ${inputName}.`);
      if (data.isYourTurn === false && data.currentTurnPlayer) {
        addEvent(`  Waiting for ${data.currentTurnPlayer} to take their turn...`);
      }
      setLoading(false);
      return;
    }
    const errData = (await resAuth.json()) as { error?: string };
    setError(errData.error ?? "Login failed");
    setLoading(false);
  }

  async function submitSignup() {
    setError("");
    if (!inputName.trim() || inputName.trim().length < 2) {
      setError("Username must be at least 2 characters");
      return;
    }
    if (!signupFullName.trim()) {
      setError("Full name is required");
      return;
    }
    if (!signupEmail.trim()) {
      setError("Email is required");
      return;
    }
    if (signupPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (signupPassword !== signupPasswordConfirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    const res = await apiFetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: inputName.trim(),
        fullName: signupFullName.trim(),
        email: signupEmail.trim(),
        password: signupPassword,
        passwordConfirm: signupPasswordConfirm,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError((data as { error?: string }).error ?? "Sign up failed");
      setLoading(false);
      return;
    }
    setSignupFullName("");
    setSignupEmail("");
    setSignupPassword("");
    setSignupPasswordConfirm("");
    setSetupPhase("login");
    setLoading(false);
  }

  function enterGameFromHub(game: HubGame) {
    setError("");
    setLoading(true);
    setPlayerName(game.playerName);
    setSessionPlayerId(game.playerId);
    createdPlayerIdRef.current = game.playerId;
    setGameSessionId(game.gameSessionId);
    setGameOver(null);
    void (async () => {
      try {
        const sesRes = await fetch(`/api/game/session?id=${game.gameSessionId}`);
        if (sesRes.ok) {
          const ses = await sesRes.json();
          setInviteCode(ses.inviteCode ?? "");
          setGalaxyName(ses.galaxyName ?? "");
          setIsPublic(ses.isPublic ?? true);
          setIsCreator(ses.createdBy === game.playerName);
        }
        await refreshState(game.playerName, game.playerId);
        addEvent(`Welcome back, Commander ${game.playerName}.`);
      } finally {
        setLoading(false);
      }
    })();
  }

  function logoutFromHub() {
    setAuthUser(null);
    setAuthGames([]);
    setLoginPassword("");
    setSetupPhase("login");
  }

  async function handleSkipTurn() {
    if (gameState?.turnMode === "simultaneous" && gameState.canAct !== false && !gameState.turnOpen) {
      try {
        await apiFetch("/api/game/tick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerName }),
        });
        await refreshState(
          playerName,
          createdPlayerIdRef.current ?? sessionPlayerId ?? gameState?.player.id,
        );
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
        body: JSON.stringify({ playerName, action, ...params }),
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
    let data: {
      success?: boolean;
      message?: string;
      error?: string;
      actionDetails?: Record<string, unknown>;
    };
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
      console.log(`[srx-ui] handleAction ${action} FAIL fetch=${(tFetched-t0).toFixed(0)}ms parse=${(tParsed-tFetched).toFixed(0)}ms total=${(performance.now()-t0).toFixed(0)}ms`);
      showActionError(failMsg);
      addEvent(`  ✖ ${failMsg}`);
      setTurnProcessing(false);
      return;
    }

    // Failed action — show error, stay on your turn
    if (!data.success) {
      console.log(`[srx-ui] handleAction ${action} !success fetch=${(tFetched-t0).toFixed(0)}ms parse=${(tParsed-tFetched).toFixed(0)}ms total=${(performance.now()-t0).toFixed(0)}ms`);
      showActionError(failMsg);
      addEvent(`  ✖ ${failMsg}`);
      setTurnProcessing(false);
      return;
    }

    // Log action result
    const actionMsg =
      action === "end_turn" ? "Turn skipped (income collected)." : (data.message ?? data.error ?? "");
    if (action === "end_turn") {
      addEvent(`  ▸ Turn skipped (income collected).`);
    } else {
      addEvent(`  ▸ ${data.message ?? data.error ?? ""}`);
    }

    const details = data.actionDetails;

    // Covert / intelligence — same modal treatment as situation report (events block)
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

    // Show combat results if applicable
    if (details?.combatResult && action.startsWith("attack_")) {
      const cr = details.combatResult as CombatSummary & {
        victory?: boolean;
        fronts?: unknown;
        loot?: unknown;
        attackerLosses?: Record<string, number>;
        defenderLosses?: unknown;
        messages?: string[];
      };
      const crx = cr as CombatSummary & {
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
        fronts: cr.fronts,
        loot: cr.loot,
        attackerLosses: cr.attackerLosses ?? {},
        defenderLosses: cr.defenderLosses,
        messages: cr.messages ?? [],
        planetCasualties: crx.planetCasualties,
        populationKilledTotal: crx.populationKilledTotal,
        planetsRadiatedCount: crx.planetsRadiatedCount,
        planetsAffectedCount: crx.planetsAffectedCount,
        defenderCivilLevelsGained: crx.defenderCivilLevelsGained,
        defenderEffectivenessLost: crx.defenderEffectivenessLost,
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
      // Optimistic update: the server already closed the full turn (turnOpen→false,
      // fullTurnsUsedThisRound incremented). Apply locally so the tick useEffect can
      // fire immediately instead of waiting for a full refreshState round trip.
      setGameState((prev) => {
        if (!prev) return prev;
        const used = (prev.empire.fullTurnsUsedThisRound ?? 0) + 1;
        const left = Math.max(0, (prev as GameState & { actionsPerDay?: number }).actionsPerDay ?? 5 - used);
        return {
          ...prev,
          empire: { ...prev.empire, turnOpen: false, fullTurnsUsedThisRound: used },
          turnOpen: false,
          canAct: left > 0 && prev.empire.turnsLeft > 1,
          fullTurnsLeftToday: left,
        };
      });
      console.log(`[srx-ui] handleAction ${action} OK(opt) fetch=${(tFetched-t0).toFixed(0)}ms parse=${(tParsed-tFetched).toFixed(0)}ms total=${(performance.now()-t0).toFixed(0)}ms`);
      setTurnProcessing(false);
    } else {
      const tRefresh0 = performance.now();
      const st = await refreshState(
        playerName,
        createdPlayerIdRef.current ?? sessionPlayerId ?? gameState?.player.id,
      );
      console.log(`[srx-ui] handleAction ${action} OK fetch=${(tFetched-t0).toFixed(0)}ms parse=${(tParsed-tFetched).toFixed(0)}ms refresh=${(performance.now()-tRefresh0).toFixed(0)}ms total=${(performance.now()-t0).toFixed(0)}ms`);
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

  // Run turn tick when it becomes our turn
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
          body: JSON.stringify({ playerName }),
        });
        const tTickFetched = performance.now();
        let data: { turnReport?: unknown; turnOpened?: boolean; alreadyProcessed?: boolean };
        try {
          const text = await res.text();
          data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
          console.log(`[srx-ui] tick parse-error fetch=${(tTickFetched-tTick0).toFixed(0)}ms`);
          setTickFired(false);
          return;
        }
        if (!res.ok) {
          console.log(`[srx-ui] tick FAIL(${res.status}) fetch=${(tTickFetched-tTick0).toFixed(0)}ms total=${(performance.now()-tTick0).toFixed(0)}ms`);
          setTickFired(false);
          return;
        }
        const tr = data.turnReport;
        if (tr && typeof tr === "object" && tr !== null && "income" in tr) {
          const r = tr as TurnPopupData;
          addEvent(`═══════════════════════════════════`);
          addEvent(`  TURN ${gameState.empire.turnsPlayed} — SITUATION REPORT`);
          addEvent(`═══════════════════════════════════`);
          addEvent(`  INCOME: ${r.income.total.toLocaleString()} cr`);
          addEvent(`  EXPENSES: ${r.expenses.total.toLocaleString()} cr`);
          addEvent(`  NET: ${(r.income.total - r.expenses.total >= 0 ? "+" : "")}${(r.income.total - r.expenses.total).toLocaleString()} cr`);
          addEvent(`  POP: ${r.population.newTotal.toLocaleString()} (${r.population.net >= 0 ? "+" : ""}${r.population.net.toLocaleString()})`);
          if (r.events.length > 0) {
            for (const ev of r.events) addEvent(`  ⚡ ${ev}`);
          }
          addEvent(`───────────────────────────────────`);

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
        if (simultaneous) {
          await refreshState(playerName, gameState.player.id);
        } else if (tr && typeof tr === "object") {
          await refreshState(playerName, gameState.player.id);
        }
        console.log(`[srx-ui] tick OK fetch=${(tTickFetched-tTick0).toFixed(0)}ms total=${(performance.now()-tTick0).toFixed(0)}ms hasTR=${!!tr}`);
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
  ]);

  // Reset tickFired when it's no longer our turn
  useEffect(() => {
    if (gameState && gameState.isYourTurn === false) {
      setTickFired(false);
    }
  }, [gameState?.isYourTurn]);

  // Door-game: closing a full turn (end_turn) sets turnOpen false; isYourTurn stays true while
  // canAct, so tickFired would never reset and auto /tick would not run for the next full turn.
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

  // Poll for turn updates (AI, other humans, or door-game round rollover). Paused while tab is hidden
  // so background tabs do not hammer /api/game/status (heavy: tryRollRound, door-game AI kick).
  useEffect(() => {
    if (!gameState || turnProcessing) return;
    if (gameState.turnMode !== "simultaneous" && gameState.isYourTurn !== false) return;

    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const res = await fetch(`/api/game/status?id=${gameState.player.id}`);
        if (res.ok) {
          const data = await res.json();
          setGameState(data);
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

  // ─── LOGIN / REGISTER SCREEN ───
  if (!playerName && setupPhase === "login") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-8">
          <pre className="text-yellow-400 text-xs leading-tight mb-2">{`
 ███████╗██████╗ ██╗  ██╗
 ██╔════╝██╔══██╗╚██╗██╔╝
 ███████╗██████╔╝ ╚███╔╝
 ╚════██║██╔══██╗ ██╔██╗
 ███████║██║  ██║██╔╝ ██╗
 ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝`}</pre>
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">
            SOLAR REALMS EXTREME
          </h1>
          <p className="text-green-600 text-sm tracking-widest">CONQUER THE GALAXY</p>
        </div>
        <div className="border border-green-700 p-8 w-96 max-w-[95vw] bg-black/80">
          <label className="text-green-600 text-xs block mb-1">Username</label>
          <input
            className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 mb-3 outline-none focus:border-yellow-400 font-mono"
            placeholder="Your username..."
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            autoFocus
          />
          <label className="text-green-600 text-xs block mb-1">Password</label>
          <input
            type="password"
            className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 mb-4 outline-none focus:border-yellow-400 font-mono"
            placeholder="Password..."
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
          <div className="flex gap-3">
            <button
              onClick={login}
              disabled={loading || !inputName || !loginPassword}
              className="flex-1 border border-green-600 py-2 hover:bg-green-900 disabled:opacity-40"
            >
              LOGIN
            </button>
            <button
              onClick={() => {
                setError("");
                setSignupFullName("");
                setSignupEmail("");
                setSignupPassword("");
                setSignupPasswordConfirm("");
                setSetupPhase("signup");
              }}
              className="flex-1 border border-yellow-600 py-2 hover:bg-yellow-900 text-yellow-400"
            >
              SIGN UP
            </button>
          </div>
        </div>
        <p className="text-green-800 text-xs mt-4">A turn-based galactic empire management game</p>
        <Link href="/admin" className="text-green-800 text-xs mt-3 hover:text-green-500 underline">
          Admin
        </Link>
      </main>
    );
  }

  // ─── SIGN UP ───
  if (!playerName && setupPhase === "signup") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">SOLAR REALMS EXTREME</h1>
          <p className="text-green-600 text-sm tracking-widest">CREATE ACCOUNT</p>
        </div>
        <div className="border border-green-700 p-6 w-[420px] max-w-[95vw] bg-black/80 space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Username</label>
            <input
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="Choose a username..."
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Full name</label>
            <input
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="Your name"
              value={signupFullName}
              onChange={(e) => setSignupFullName(e.target.value)}
            />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Email address</label>
            <input
              type="email"
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="you@example.com"
              value={signupEmail}
              onChange={(e) => setSignupEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Password</label>
            <input
              type="password"
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="Min 8 characters"
              value={signupPassword}
              onChange={(e) => setSignupPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Password (confirm)</label>
            <input
              type="password"
              className={`w-full bg-black border text-green-300 px-3 py-2 outline-none font-mono ${signupPasswordConfirm && signupPassword !== signupPasswordConfirm ? "border-red-600" : "border-green-600 focus:border-yellow-400"}`}
              placeholder="Repeat password"
              value={signupPasswordConfirm}
              onChange={(e) => setSignupPasswordConfirm(e.target.value)}
            />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            onClick={submitSignup}
            disabled={loading}
            className="w-full border border-yellow-600 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 font-bold tracking-wider"
          >
            {loading ? "CREATING ACCOUNT…" : "CREATE ACCOUNT"}
          </button>
          <button
            onClick={() => { setError(""); setSetupPhase("login"); }}
            className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500"
          >
            ← BACK TO LOGIN
          </button>
        </div>
      </main>
    );
  }

  // ─── POST-LOGIN HUB (account games + join / create) ───
  if (!playerName && setupPhase === "hub" && authUser) {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono py-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">SOLAR REALMS EXTREME</h1>
          <p className="text-green-600 text-sm tracking-widest">COMMAND CENTER</p>
        </div>
        <div className="border border-green-700 p-6 w-[520px] max-w-[95vw] bg-black/80 space-y-4">
          <div className="border-2 border-green-800 border-b border-green-900 pb-3">
            <div className="text-green-400 font-bold">{authUser.fullName}</div>
            <div className="text-green-400 text-sm">@{authUser.username}</div>
            <div className="text-green-700 text-xs mt-1">{authUser.email}</div>
          </div>

          <div>
            <div className="text-yellow-400 text-xs font-bold tracking-wider mb-2">YOUR GAMES</div>
            {authGames.length === 0 ? (
              <p className="text-green-700 text-xs">No active games in progress.</p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {authGames.map((g) => (
                  <div
                    key={g.playerId}
                    className="border border-green-800 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                  >
                    <div>
                      <div className="text-green-300 text-sm">{g.galaxyName ?? "Unnamed galaxy"}</div>
                      <div className="text-green-700 text-[10px]">
                        Turn {g.turnsPlayed} · {g.turnsLeft} left · {g.playerCount}/{g.maxPlayers} commanders
                        {g.waitingForHuman ? " · LOBBY" : ""}
                      </div>
                      {!g.waitingForHuman && (
                        <div className="text-green-600 text-[10px] mt-0.5">
                          {g.isYourTurn ? "▸ Your turn" : `▸ ${g.currentTurnPlayer ?? "?"}'s turn`}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => enterGameFromHub(g)}
                      disabled={loading}
                      className="border border-green-600 px-3 py-1 text-xs hover:bg-green-900 disabled:opacity-40 shrink-0"
                    >
                      RESUME
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                setError("");
                setInputName(authUser.username);
                setInputMaxPlayers(String(SESSION.MAX_PLAYERS_DEFAULT));
                setSetupPhase("create-galaxy");
              }}
              className="w-full border border-yellow-600 p-3 hover:bg-yellow-900/20 text-left"
            >
              <div className="text-yellow-400 font-bold tracking-wider">CREATE NEW GALAXY</div>
              <p className="text-green-700 text-xs mt-1">Galaxy settings and optional AI rivals on one screen.</p>
            </button>
            <button
              onClick={() => {
                setError("");
                setInputName(authUser.username);
                void fetchLobbies();
                setJoinInviteCode("");
                setSetupPhase("join-game");
              }}
              className="w-full border border-green-600 p-3 hover:bg-green-900/20 text-left"
            >
              <div className="text-green-400 font-bold tracking-wider">JOIN EXISTING GALAXY</div>
              <p className="text-green-700 text-xs mt-1">Public list or invite code.</p>
            </button>
          </div>

          <button
            onClick={logoutFromHub}
            className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500"
          >
            LOG OUT
          </button>
        </div>
      </main>
    );
  }

  // ─── JOIN GAME SCREEN ───
  if (!playerName && setupPhase === "join-game") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">SOLAR REALMS EXTREME</h1>
          <p className="text-green-600 text-sm tracking-widest">JOIN A GALAXY</p>
        </div>
        <div className="border border-green-700 p-6 w-[480px] bg-black/80 space-y-4">
          {authUser && (
            <div className="text-green-700 text-xs border border-green-900 p-2 mb-2">
              Commander: <span className="text-green-400">{authUser.username}</span>
            </div>
          )}
          <div>
            <label className="text-green-600 text-xs block mb-1">Invite Code:</label>
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono tracking-widest uppercase"
                placeholder="XXXXXXXX"
                value={joinInviteCode}
                onChange={(e) => setJoinInviteCode(e.target.value)}
                maxLength={8}
                autoFocus
              />
              <button
                onClick={() => joinGame()}
                disabled={loading || !joinInviteCode || !loginPassword}
                className="border border-yellow-600 px-4 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 text-sm"
              >
                JOIN
              </button>
            </div>
          </div>

          {lobbies.length > 0 && (
            <div>
              <div className="text-green-600 text-xs mb-2 border-b border-green-900 pb-1">PUBLIC GALAXIES</div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {lobbies.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => joinGame(l.id)}
                    disabled={loading || !loginPassword}
                    className="w-full flex justify-between items-center border border-green-800 p-2 hover:border-green-600 hover:bg-green-900/20 disabled:opacity-40"
                  >
                    <div className="text-left">
                      <div className="text-green-300 text-sm">{l.galaxyName}</div>
                      <div className="text-green-700 text-[10px]">Created by {l.createdBy}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-green-600 text-xs">{l.playerCount}/{l.maxPlayers}</div>
                      {l.turnTimeoutSecs && (
                        <div className="text-green-800 text-[9px]">
                          {TURN_TIMER_OPTIONS.find((o) => o.secs === l.turnTimeoutSecs)?.label ?? `${Math.round((l.turnTimeoutSecs ?? 0) / 3600)}h`}/turn
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {lobbies.length === 0 && (
            <div className="text-green-800 text-xs text-center py-4">No public galaxies available</div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            onClick={() => {
              setError("");
              setSetupPhase(authUser ? "hub" : "login");
            }}
            className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500"
          >
            ← BACK
          </button>
        </div>
      </main>
    );
  }

  // ─── CREATE GALAXY (settings + optional AI rivals, single screen) ───
  if (!playerName && setupPhase === "create-galaxy") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono py-8 px-2">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">SOLAR REALMS EXTREME</h1>
          <p className="text-green-600 text-sm tracking-widest">NEW GALAXY</p>
          <p className="text-green-800 text-[11px] mt-1 max-w-md mx-auto">
            Session settings and optional AI rivals — one step to create and enter.
          </p>
        </div>
        <div className="border border-green-700 p-6 w-[min(540px,96vw)] max-h-[min(90vh,900px)] overflow-y-auto bg-black/80 space-y-4">
          {authUser && (
            <div className="text-green-700 text-xs border border-green-900 p-2">
              Commander: <span className="text-green-400">{authUser.username}</span>
            </div>
          )}
          <div>
            <label className="text-green-600 text-xs block mb-1">Galaxy Name (optional):</label>
            <input
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="e.g. Alpha Centauri"
              value={inputGalaxyName}
              onChange={(e) => setInputGalaxyName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between border border-green-800 p-3">
            <div>
              <div className="text-green-400 text-xs font-bold">Visibility</div>
              <div className="text-green-700 text-[10px]">
                {inputIsPublic ? "Anyone can browse and join" : "Invite code required — shown in CFG after you enter"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setInputIsPublic(!inputIsPublic)}
              className={`border px-3 py-1 text-xs ${inputIsPublic ? "border-green-600 text-green-400" : "border-yellow-600 text-yellow-400"}`}
            >
              {inputIsPublic ? "PUBLIC" : "PRIVATE"}
            </button>
          </div>
          <div className="flex items-center justify-between border border-green-800 p-3">
            <div>
              <div className="text-green-400 text-xs font-bold">Turn Timer</div>
              <div className="text-green-700 text-[10px]">Time limit per turn before auto-skip</div>
            </div>
            <select
              value={inputTurnTimer}
              onChange={(e) => setInputTurnTimer(e.target.value)}
              className="bg-black border border-green-700 text-green-400 text-xs px-2 py-1 focus:outline-none focus:border-yellow-600"
            >
              {TURN_TIMER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center justify-between border border-green-800 p-3 gap-3">
            <div>
              <div className="text-green-400 text-xs font-bold">Max players</div>
              <div className="text-green-700 text-[10px]">
                {SESSION.MIN_PLAYERS}–{SESSION.MAX_PLAYERS_CAP} (default {SESSION.MAX_PLAYERS_DEFAULT})
              </div>
            </div>
            <input
              type="number"
              min={SESSION.MIN_PLAYERS}
              max={SESSION.MAX_PLAYERS_CAP}
              className="w-24 bg-black border border-green-700 text-green-400 text-sm px-2 py-1 font-mono"
              value={inputMaxPlayers}
              onChange={(e) => setInputMaxPlayers(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between border border-green-800 p-3">
            <div>
              <div className="text-green-400 text-xs font-bold">Simultaneous turns</div>
              <div className="text-green-700 text-[10px]">
                All players submit each move before the round resolves (5 moves per day). Otherwise one player at a time.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setInputSimultaneousTurns(!inputSimultaneousTurns)}
              className={`border px-3 py-1 text-xs ${inputSimultaneousTurns ? "border-yellow-600 text-yellow-400" : "border-green-600 text-green-400"}`}
            >
              {inputSimultaneousTurns ? "ON" : "OFF"}
            </button>
          </div>

          <div className="border-t border-green-900 pt-4">
            <div className="text-green-500 text-xs font-bold tracking-wider mb-1">AI OPPONENTS (OPTIONAL)</div>
            <p className="text-green-700 text-[10px] mb-3">
              Each AI is assigned a random strategy (economy, military, research, stealth, turtle, diplomatic, or optimal). You won&apos;t know their approach until the game unfolds.
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAiCount((c) => Math.max(0, c - 1))}
                disabled={aiCount === 0}
                className="border border-green-700 px-3 py-1 text-green-400 hover:border-green-400 disabled:opacity-30 text-lg leading-none"
              >−</button>
              <span className="text-yellow-400 font-bold w-6 text-center text-sm">{aiCount}</span>
              <button
                type="button"
                onClick={() => setAiCount((c) => Math.min(MAX_AI_COUNT, c + 1))}
                disabled={aiCount >= MAX_AI_COUNT}
                className="border border-green-700 px-3 py-1 text-green-400 hover:border-green-400 disabled:opacity-30 text-lg leading-none"
              >+</button>
              <span className="text-green-700 text-xs">rival{aiCount !== 1 ? "s" : ""} (max {MAX_AI_COUNT})</span>
            </div>
            {aiCount === 0 && (
              <p className="text-green-700 text-[10px] mt-2">Solo play — no AI opponents.</p>
            )}
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            type="button"
            onClick={register}
            disabled={loading || !loginPassword}
            className="w-full border border-yellow-600 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 font-bold tracking-wider"
          >
            {loading ? "CREATING…" : aiCount > 0 ? `CREATE GALAXY (${aiCount} AI)` : "CREATE GALAXY — SOLO"}
          </button>
          <button
            type="button"
            onClick={() => {
              setError("");
              setSetupPhase(authUser ? "hub" : "login");
            }}
            className="w-full text-center text-green-700 text-xs py-1 hover:text-green-500"
          >
            ← BACK
          </button>
        </div>
      </main>
    );
  }

  // ─── MAIN GAME SCREEN ───
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
                    D{gameState.dayNumber ?? 1} · {gameState.fullTurnsLeftToday ?? 0}/{gameState.actionsPerDay ?? 5} full turns
                  </span>
                  <span
                    className={`font-bold ${
                      gameState.empire.turnsLeft < 1
                        ? "text-red-400"
                        : gameState.turnOpen
                          ? "text-cyan-400"
                          : "text-yellow-400"
                    }`}
                    title={
                      gameState.empire.turnsLeft < 1
                        ? "No game turns remaining."
                        : gameState.canAct === false
                          ? "You used all full turns for this calendar day, or you are waiting for other commanders. When the round timer expires, unused full turns are skipped and the next calendar day begins."
                          : gameState.turnOpen
                            ? "This full turn is open — take actions, then end turn when done."
                            : "Begin this full turn with your situation report (economy update). Usually starts automatically; use Skip if needed."
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
        </div>
      </header>

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

      {/* Leaderboard strip */}
      <div className="mb-1 shrink-0">
        <Leaderboard
          currentPlayer={playerName}
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

      {/* Turn Summary Popup */}
      {turnPopup && !gameOver && <TurnSummaryModal data={turnPopup} onClose={handleTurnPopupClose} />}

      {/* Game Over Screen */}
      {gameOver && <GameOverScreen data={gameOver} playerName={playerName} onExportLog={async () => {
        const res = await fetch(`/api/game/log?player=${encodeURIComponent(playerName)}`);
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `srx-game-log-${playerName}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }} />}
    </main>
  );
}

function TurnTimer({ deadline, isYourTurn }: { deadline: string; isYourTurn: boolean }) {
  const [remaining, setRemaining] = useState("");
  const [urgent, setUrgent] = useState(false);

  useEffect(() => {
    function tick() {
      const ms = new Date(deadline).getTime() - Date.now();
      if (ms <= 0) {
        setRemaining("0:00:00");
        setUrgent(true);
        return;
      }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setRemaining(`${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
      setUrgent(ms < 3600000);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const color = urgent
    ? "text-red-400"
    : isYourTurn
      ? "text-yellow-400"
      : "text-green-700";

  return (
    <span className={`${color} text-xs tabular-nums`} title={isYourTurn ? "Time remaining for your turn" : "Time remaining for current player"}>
      ⏱ {remaining}
    </span>
  );
}

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
        {/* Critical alerts banner — top of modal */}
        {hasCritical && (
          <div className="border-2 border-red-600 bg-red-950/40 p-3 mb-3 animate-pulse">
            <div className="text-red-400 font-bold text-sm text-center tracking-widest mb-1">
              ⚠ CRITICAL ALERTS ⚠
            </div>
            {classified.critical.map((ev, i) => (
              <div key={i} className="text-red-300 text-center py-0.5 font-bold">
                {ev}
              </div>
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
            {data.mode === "intel_report" && (
              <>Target: <span className="text-cyan-400">{data.intelTarget || "—"}</span></>
            )}
            {data.mode === "action_result" && `${data.action}: ${data.actionMsg}`}
          </div>
        </div>

        {data.mode === "turn_start" && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {/* Income */}
            <div>
              <div className="text-green-400 font-bold border-b border-green-900 mb-1 pb-0.5">INCOME</div>
              <Row label="Tax revenue" value={data.income.populationTax} color="text-green-300" />
              <Row label="Urban tax" value={data.income.urbanTax} color="text-green-300" />
              <Row label="Tourism" value={data.income.tourism} color="text-green-300" />
              {totalSales > 0 && <Row label="Market sales" value={totalSales} color="text-green-300" />}
              {data.income.galacticRedistribution > 0 && <Row label="Redistribution" value={data.income.galacticRedistribution} color="text-green-300" />}
              <Row label="TOTAL" value={data.income.total} color="text-green-400" bold />
            </div>

            {/* Expenses */}
            <div>
              <div className="text-red-400 font-bold border-b border-green-900 mb-1 pb-0.5">EXPENSES</div>
              <Row label="Planets" value={data.expenses.planetMaintenance} color="text-red-300" />
              <Row label="Military" value={data.expenses.militaryMaintenance} color="text-red-300" />
              {data.expenses.galacticTax > 0 && <Row label="Galactic tax" value={data.expenses.galacticTax} color="text-red-300" />}
              <Row label="TOTAL" value={data.expenses.total} color="text-red-400" bold />
            </div>

            {/* Net */}
            <div className="col-span-2 text-center py-1.5 border border-green-900 rounded">
              <span className={`font-bold text-sm ${netIncome >= 0 ? "text-green-400" : "text-red-400"}`}>
                NET: {netIncome >= 0 ? "+" : ""}{netIncome.toLocaleString()} cr
              </span>
            </div>

            {/* Population */}
            <div>
              <div className="text-cyan-400 font-bold border-b border-green-900 mb-1 pb-0.5">POPULATION</div>
              <Row label="Births" value={data.population.births} color="text-cyan-300" prefix="+" />
              <Row label="Immigration" value={data.population.immigration} color="text-cyan-300" prefix="+" />
              <Row label="Deaths" value={data.population.deaths} color="text-orange-300" prefix="-" />
              <Row label="Emigration" value={data.population.emigration} color="text-orange-300" prefix="-" />
              <Row label="TOTAL" value={data.population.newTotal} color="text-cyan-400" bold
                suffix={` (${data.population.net >= 0 ? "+" : ""}${data.population.net.toLocaleString()})`} />
            </div>

            {/* Resources */}
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

        {/* Combat Results */}
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
                    <span className={f.won ? "text-green-400" : "text-red-400"}>
                      {f.won ? "Won" : "Lost"} ({f.attackerWins}-{f.defenderWins})
                    </span>
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
                {data.combat.planetsRadiatedCount != null && data.combat.planetsRadiatedCount > 0 && (
                  <div className="flex justify-between text-[10px] text-green-700 mt-0.5">
                    <span>Planets radiated</span>
                    <span>{data.combat.planetsRadiatedCount}</span>
                  </div>
                )}
                {data.combat.planetsAffectedCount != null && data.combat.planetsAffectedCount > 0 && (
                  <div className="flex justify-between text-[10px] text-green-700 mt-0.5">
                    <span>Planets contaminated</span>
                    <span>{data.combat.planetsAffectedCount}</span>
                  </div>
                )}
              </div>
            )}

            {(data.combat.defenderCivilLevelsGained != null || data.combat.defenderEffectivenessLost != null) && (
              <div className="mb-1 border border-purple-900/50 p-1.5 bg-purple-950/20">
                <div className="text-purple-400 font-bold mb-0.5">PSIONIC EFFECT ON TARGET</div>
                {data.combat.defenderCivilLevelsGained != null && (
                  <div className="flex justify-between">
                    <span className="text-green-600">Civil unrest levels</span>
                    <span className="text-purple-300">+{data.combat.defenderCivilLevelsGained}</span>
                  </div>
                )}
                {data.combat.defenderEffectivenessLost != null && (
                  <div className="flex justify-between">
                    <span className="text-green-600">Army effectiveness</span>
                    <span className="text-purple-300">−{data.combat.defenderEffectivenessLost}%</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Events / intelligence lines */}
        {data.events.length > 0 && (
          <div className="mt-3 pt-2 border-t border-green-900">
            <div className="text-yellow-400 font-bold mb-1">{data.mode === "intel_report" ? "INTELLIGENCE" : "EVENTS"}</div>
            {classified.critical.map((ev, i) => (
              <div key={`c${i}`} className="text-red-400 font-bold py-0.5">⚠ {ev}</div>
            ))}
            {classified.warnings.map((ev, i) => (
              <div key={`w${i}`} className="text-yellow-300 py-0.5">⚡ {ev}</div>
            ))}
            {classified.info.map((ev, i) => (
              <div key={`i${i}`} className="text-green-500 py-0.5">● {ev}</div>
            ))}
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

function GameOverScreen({ data, playerName, onExportLog }: { data: GameOverData; playerName: string; onExportLog: () => void }) {
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
              <div
                key={s.name}
                className={`flex items-center py-0.5 ${isYou ? "text-yellow-400 font-bold" : "text-green-300"}`}
              >
                <span className="w-8">{medals[i] ?? `#${i + 1}`}</span>
                <span className="flex-1">
                  {s.name}{s.isAI ? " [AI]" : ""}{isYou ? " (you)" : ""}
                </span>
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
          <button
            onClick={onExportLog}
            className="flex-1 border border-green-700 py-2 text-sm hover:bg-green-900 text-green-400"
          >
            EXPORT GAME LOG
          </button>
          <button
            onClick={() => window.location.reload()}
            className="flex-1 border border-yellow-600 py-2 text-sm hover:bg-yellow-900 text-yellow-400"
          >
            NEW GAME
          </button>
        </div>
        <div className="text-center text-green-800 text-[10px] mt-2">Game log exported as JSON for analysis</div>
      </div>
    </div>
  );
}
