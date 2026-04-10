"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { SESSION } from "@/lib/game-constants";
import { apiFetch } from "@/lib/client-fetch";
import { SrxGameScreen } from "@/components/SrxGameScreen";
import { ChessGameScreen } from "@/components/ChessGameScreen";
import { GinRummyGameScreen } from "@/components/GinRummyGameScreen";
// Re-export GameState so existing imports from "@/app/page" keep working.
export type { GameState } from "@/lib/srx-game-types";

// ---------------------------------------------------------------------------
// Client-side game metadata (no server deps — pure data)
// ---------------------------------------------------------------------------

interface ClientGameCreateOption {
  key: string;
  label: string;
  description?: string;
  type: "number" | "boolean" | "select";
  default: unknown;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

interface ClientGameMetadata {
  game: string;
  displayName: string;
  shortName?: string;
  description: string;
  supportsJoin: boolean;
  createOptions: ClientGameCreateOption[];
}

const TURN_TIMER_OPTIONS = [
  { label: "5 min", secs: 300 },
  { label: "30 min", secs: 1800 },
  { label: "1 hour", secs: 3600 },
  { label: "6 hours", secs: 21600 },
  { label: "12 hours", secs: 43200 },
  { label: "24 hours", secs: 86400 },
  { label: "48 hours", secs: 172800 },
  { label: "7 days", secs: 604800 },
];

const CLIENT_GAME_REGISTRY: ClientGameMetadata[] = [
  {
    game: "srx",
    displayName: "Solar Realms Extreme",
    shortName: "SRX",
    description:
      "Turn-based galactic empire management. Up to 128 commanders, 100 turns, sequential or simultaneous (door-game) play.",
    supportsJoin: true,
    createOptions: [
      {
        key: "aiCount",
        label: "AI Opponents",
        description: "Random-strategy AI commanders (economy, military, research, stealth, turtle, diplomatic, or optimal)",
        type: "number",
        default: 3,
        min: 0,
        max: 5,
      },
      {
        key: "turnMode",
        label: "Turn Mode",
        description: "Simultaneous lets all players take turns at the same time each day (5 per day)",
        type: "select",
        default: "simultaneous",
        options: [
          { value: "simultaneous", label: "Simultaneous (Door Game)" },
          { value: "sequential", label: "Sequential (one at a time)" },
        ],
      },
      {
        key: "maxPlayers",
        label: "Max Players",
        description: `${SESSION.MIN_PLAYERS}–${SESSION.MAX_PLAYERS_CAP} commanders in the galaxy`,
        type: "number",
        default: SESSION.MAX_PLAYERS_DEFAULT,
        min: SESSION.MIN_PLAYERS,
        max: SESSION.MAX_PLAYERS_CAP,
      },
      {
        key: "turnTimeoutSecs",
        label: "Turn Timer",
        description: "Time limit per turn before auto-skip",
        type: "select",
        default: String(86400),
        options: TURN_TIMER_OPTIONS.map((o) => ({ value: String(o.secs), label: o.label })),
      },
    ],
  },
  {
    game: "chess",
    displayName: "Chess",
    description: "Classic chess with MCTS AI or a human opponent. Per-turn timer with enforced timeout.",
    supportsJoin: true,
    createOptions: [
      {
        key: "opponentMode",
        label: "Opponent",
        description: "Play against the MCTS AI or invite a human player",
        type: "select",
        default: "ai",
        options: [
          { value: "ai", label: "AI (MCTS)" },
          { value: "human", label: "Human (invite)" },
        ],
      },
      {
    key: "turnTimeoutSecs",
    label: "Turn Timer",
    description: "Time limit per move before auto-forfeit",
    type: "select",
    default: String(43200),
    options: TURN_TIMER_OPTIONS.map((o) => ({ value: String(o.secs), label: o.label })),
  },
    ],
  },
  {
    game: "ginrummy",
    displayName: "Gin Rummy",
    description: "Classic 2-player card game. Form melds, minimize deadwood, knock or go for gin.",
    supportsJoin: true,
    createOptions: [
      {
        key: "opponentMode",
        label: "Opponent",
        description: "Play against the MCTS AI or invite a human player",
        type: "select",
        default: "ai",
        options: [
          { value: "ai", label: "AI (MCTS)" },
          { value: "human", label: "Human (invite)" },
        ],
      },
      {
        key: "matchTarget",
        label: "Scoring",
        description: "Single hand or first to reach the target score",
        type: "select",
        default: "100",
        options: [
          { value: "0", label: "Single hand" },
          { value: "100", label: "Match to 100" },
          { value: "200", label: "Match to 200" },
          { value: "300", label: "Match to 300" },
        ],
      },
      {
        key: "turnTimeoutSecs",
        label: "Turn Timer",
        description: "Time limit per turn before auto-forfeit",
        type: "select",
        default: String(43200),
        options: TURN_TIMER_OPTIONS.map((o) => ({ value: String(o.secs), label: o.label })),
      },
    ],
  },
];

function getGameMeta(game: string): ClientGameMetadata {
  return CLIENT_GAME_REGISTRY.find((g) => g.game === game) ?? CLIENT_GAME_REGISTRY[0];
}

// ---------------------------------------------------------------------------
// Hub game shape (from POST /api/auth/login)
// ---------------------------------------------------------------------------

interface HubGame {
  playerId: string;
  playerName: string;
  gameSessionId: string;
  galaxyName: string | null;
  game?: string;
  turnsLeft?: number;   // SRX only (via getHubStats); undefined for Chess/Gin Rummy
  turnsPlayed?: number; // SRX only
  inviteCode: string | null;
  isPublic: boolean;
  isYourTurn: boolean;
  currentTurnPlayer: string | null;
  maxPlayers: number;
  playerCount: number;
  waitingForHuman: boolean;
}

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

// ---------------------------------------------------------------------------
// Game screen registry — maps game key → Screen component
// ---------------------------------------------------------------------------

type GameScreenProps = {
  playerName: string;
  sessionPlayerId: string | null;
  gameSessionId: string | null;
  initialInviteCode: string;
  initialGalaxyName: string;
  initialIsPublic: boolean;
  isCreator: boolean;
  initialEvents: string[];
  onLogout: () => void;
};

const GAME_SCREEN_REGISTRY: Record<string, React.ComponentType<GameScreenProps>> = {
  srx: SrxGameScreen,
  chess: ChessGameScreen,
  ginrummy: GinRummyGameScreen,
};

// ---------------------------------------------------------------------------
// Page component (lobby only + game dispatch)
// ---------------------------------------------------------------------------

export default function Home() {
  // ── Active game session (set on register/join/resume, cleared on logout) ──
  const [playerName, setPlayerName] = useState("");
  const [sessionPlayerId, setSessionPlayerId] = useState<string | null>(null);
  const [gameSessionId, setGameSessionId] = useState<string | null>(null);
  const [activeGame, setActiveGame] = useState("srx");
  const [initialInviteCode, setInitialInviteCode] = useState("");
  const [initialGalaxyName, setInitialGalaxyName] = useState("");
  const [initialIsPublic, setInitialIsPublic] = useState(true);
  const [isCreator, setIsCreator] = useState(false);
  const [initialEvents, setInitialEvents] = useState<string[]>([]);
  const createdPlayerIdRef = useRef<string | null>(null);

  // ── Browser title ──
  useEffect(() => {
    if (playerName) {
      const gameMeta = CLIENT_GAME_REGISTRY.find((g) => g.game === activeGame);
      const label = gameMeta?.displayName ?? activeGame.toUpperCase();
      document.title = initialGalaxyName ? `${label} — ${initialGalaxyName}` : label;
    } else {
      document.title = "Door Game Engine";
    }
  }, [playerName, activeGame, initialGalaxyName]);

  // ── Lobby state ──
  const [authUser, setAuthUser] = useState<{ username: string; fullName: string; email: string } | null>(null);
  const [authGames, setAuthGames] = useState<HubGame[]>([]);
  const [selectedGame, setSelectedGame] = useState("srx");
  const [setupPhase, setSetupPhase] = useState<
    "login" | "signup" | "game-select" | "hub" | "join-game" | "create-galaxy"
  >("login");
  const [inputName, setInputName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lobbies, setLobbies] = useState<{ id: string; galaxyName: string; createdBy: string; playerCount: number; maxPlayers: number; turnTimeoutSecs?: number }[]>([]);
  const [joinInviteCode, setJoinInviteCode] = useState("");
  const [inputGalaxyName, setInputGalaxyName] = useState("");
  const [inputIsPublic, setInputIsPublic] = useState(true);
  const [gameOptions, setGameOptions] = useState<Record<string, unknown>>({});

  // Sign-up form fields
  const [signupFullName, setSignupFullName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupPasswordConfirm, setSignupPasswordConfirm] = useState("");

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function initGameOptionsForGame(gameName: string) {
    const meta = getGameMeta(gameName);
    const defaults: Record<string, unknown> = {};
    for (const opt of meta.createOptions) {
      defaults[opt.key] = opt.default;
    }
    setGameOptions(defaults);
  }

  function handleLogout() {
    setPlayerName("");
    setSessionPlayerId(null);
    setGameSessionId(null);
    setInitialEvents([]);
    createdPlayerIdRef.current = null;
    // Silently refresh the games list so the hub reflects current session state
    // (e.g. a game that just ended won't still appear as active).
    if (authUser && loginPassword) {
      void apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUser.username, password: loginPassword }),
      }).then(async (res) => {
        if (res.ok) {
          const data = await res.json() as { user: typeof authUser; games: HubGame[] };
          setAuthGames(data.games);
        }
      }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

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
      setSetupPhase("game-select");
      setLoading(false);
      return;
    }
    if (resAuth.status === 404) {
      // Legacy commander without a UserAccount — try POST /api/game/status directly.
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
          setInitialInviteCode(ses.inviteCode ?? "");
          setInitialGalaxyName(ses.galaxyName ?? "");
          setInitialIsPublic(ses.isPublic ?? true);
          setIsCreator(ses.createdBy === inputName);
          setActiveGame(ses.game ?? ses.gameType ?? "srx");
        }
      }
      setLoading(false);
      return;
    }
    const errData = (await resAuth.json()) as { error?: string };
    setError(errData.error ?? "Login failed");
    setLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Sign-up
  // ---------------------------------------------------------------------------

  async function submitSignup() {
    setError("");
    if (!inputName.trim() || inputName.trim().length < 2) {
      setError("Username must be at least 2 characters");
      return;
    }
    if (!signupFullName.trim()) { setError("Full name is required"); return; }
    if (!signupEmail.trim()) { setError("Email is required"); return; }
    if (signupPassword.length < 8) { setError("Password must be at least 8 characters"); return; }
    if (signupPassword !== signupPasswordConfirm) { setError("Passwords do not match"); return; }
    setLoading(true);
    const res = await apiFetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: inputName.trim(), fullName: signupFullName.trim(),
        email: signupEmail.trim(), password: signupPassword, passwordConfirm: signupPasswordConfirm,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError((data as { error?: string }).error ?? "Sign up failed");
      setLoading(false);
      return;
    }
    setSignupFullName(""); setSignupEmail(""); setSignupPassword(""); setSignupPasswordConfirm("");
    setSetupPhase("login");
    setLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Register (create new galaxy)
  // ---------------------------------------------------------------------------

  async function register() {
    setError("");
    if (!authUser) { setError("Sign in required."); return; }
    if (!loginPassword.trim()) { setError("Password required"); return; }
    setLoading(true);

    const meta = getGameMeta(selectedGame);
    const events: string[] = [];

    // Build request body: top-level engine fields + all gameOptions.
    const reqBody: Record<string, unknown> = {
      name: authUser.username,
      password: loginPassword,
      game: selectedGame,
      galaxyName: inputGalaxyName.trim() || null,
      isPublic: inputIsPublic,
      ...gameOptions,
    };
    // Ensure turnTimeoutSecs is numeric (it arrives as string from select).
    if (typeof reqBody.turnTimeoutSecs === "string") {
      reqBody.turnTimeoutSecs = parseInt(reqBody.turnTimeoutSecs as string, 10) || 86400;
    }

    const res = await apiFetch("/api/game/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const raw = await res.text();
    let data: RegisterApiPayload = {};
    if (raw.trim()) {
      try { data = JSON.parse(raw) as RegisterApiPayload; }
      catch { setError("Registration failed (server returned invalid data)."); setLoading(false); return; }
    }
    if (!res.ok) {
      setError(apiErrorMessage(data, res, "Registration failed"));
      setLoading(false);
      return;
    }

    const newSessionId = data.gameSessionId as string | undefined;
    const playerId = data.id;

    // Call AI setup if the game uses AI count and it's > 0.
    const aiCount = typeof gameOptions.aiCount === "number" ? gameOptions.aiCount
      : parseInt(String(gameOptions.aiCount ?? "0"), 10);
    if (newSessionId && aiCount > 0 && meta.createOptions.some((o) => o.key === "aiCount")) {
      events.push(`[T1] Setting up ${aiCount} AI opponent${aiCount !== 1 ? "s" : ""}...`);
      const resAi = await apiFetch("/api/ai/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameSessionId: newSessionId, count: aiCount }),
      });
      if (resAi.ok) {
        const aiData = await resAi.json() as { created?: string[] };
        const names: string[] = Array.isArray(aiData.created) ? aiData.created : [];
        for (const n of names) events.push(`[T${events.length + 1}] AI Commander ${n} has entered the galaxy.`);
      } else {
        setError((await resAi.json() as { error?: string }).error ?? "AI setup failed");
        setLoading(false);
        return;
      }
    }

    // Set up game session state and dispatch to game screen.
    setGameSessionId(newSessionId ?? null);
    setInitialInviteCode(data.inviteCode ?? "");
    setInitialGalaxyName(data.galaxyName ?? "");
    setInitialIsPublic(data.isPublic ?? true);
    setIsCreator(true);
    setActiveGame(selectedGame);
    setSessionPlayerId(playerId ?? null);
    createdPlayerIdRef.current = playerId ?? null;
    events.push(`[T${events.length + 1}] Welcome, Commander ${authUser.username}! Your empire awaits.`);
    setInitialEvents(events);
    setPlayerName(authUser.username);
    setLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Join existing galaxy
  // ---------------------------------------------------------------------------

  async function fetchLobbies() {
    const res = await apiFetch(`/api/game/lobbies?game=${encodeURIComponent(selectedGame)}`);
    if (res.ok) {
      setLobbies(await res.json());
    }
  }

  async function joinGame(lobbySessionId?: string) {
    setError("");
    if (!authUser) { setError("Sign in required."); return; }
    if (!loginPassword.trim()) { setError("Password required"); return; }
    setLoading(true);
    const body: Record<string, unknown> = { name: authUser.username, password: loginPassword };
    if (lobbySessionId) body.sessionId = lobbySessionId;
    else if (joinInviteCode) body.inviteCode = joinInviteCode;
    else { setError("Enter an invite code or select a public session"); setLoading(false); return; }

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
    setGameSessionId(data.gameSessionId);
    setInitialGalaxyName(data.galaxyName ?? "");
    setInitialInviteCode("");
    setInitialIsPublic(true);
    setIsCreator(false);
    setActiveGame(data.game ?? selectedGame);
    if (data.id) {
      setSessionPlayerId(data.id);
      createdPlayerIdRef.current = data.id;
    }

    // Fetch session to get inviteCode and isPublic.
    if (data.gameSessionId) {
      const sesRes = await fetch(`/api/game/session?id=${data.gameSessionId}`);
      if (sesRes.ok) {
        const ses = await sesRes.json();
        setInitialInviteCode(ses.inviteCode ?? "");
        setInitialIsPublic(ses.isPublic ?? true);
      }
    }

    setInitialEvents([`[T1] Welcome, Commander ${authUser.username}! You have joined the galaxy.`]);
    setPlayerName(authUser.username);
    setLoading(false);
  }

  // ---------------------------------------------------------------------------
  // Enter game from hub (resume)
  // ---------------------------------------------------------------------------

  function enterGameFromHub(g: HubGame) {
    setError("");
    setLoading(true);
    setPlayerName(g.playerName);
    setSessionPlayerId(g.playerId);
    createdPlayerIdRef.current = g.playerId;
    setGameSessionId(g.gameSessionId);
    setActiveGame(g.game ?? "srx");
    setInitialEvents([]);

    void (async () => {
      try {
        const sesRes = await fetch(`/api/game/session?id=${g.gameSessionId}`);
        if (sesRes.ok) {
          const ses = await sesRes.json();
          setInitialInviteCode(ses.inviteCode ?? "");
          setInitialGalaxyName(ses.galaxyName ?? "");
          setInitialIsPublic(ses.isPublic ?? true);
          setIsCreator(ses.createdBy === g.playerName);
        }
      } catch { /* ignore */ } finally {
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

  // ---------------------------------------------------------------------------
  // Game dispatch — once playerName is set, render the game screen
  // ---------------------------------------------------------------------------

  if (playerName) {
    const GameScreen = GAME_SCREEN_REGISTRY[activeGame] ?? SrxGameScreen;
    return (
      <GameScreen
        playerName={playerName}
        sessionPlayerId={sessionPlayerId}
        gameSessionId={gameSessionId}
        initialInviteCode={initialInviteCode}
        initialGalaxyName={initialGalaxyName}
        initialIsPublic={initialIsPublic}
        isCreator={isCreator}
        initialEvents={initialEvents}
        onLogout={handleLogout}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------------------

  if (setupPhase === "login") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-8">
          <pre className="text-yellow-400 text-xs leading-tight mb-2">{`
 ██████╗  ██████╗ ███████╗
 ██╔══██╗██╔════╝ ██╔════╝
 ██║  ██║██║  ███╗█████╗
 ██║  ██║██║   ██║██╔══╝
 ██████╔╝╚██████╔╝███████╗
 ╚═════╝  ╚═════╝ ╚══════╝`}</pre>
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">DOOR GAMES</h1>
          <p className="text-green-600 text-sm tracking-widest">TURN-BASED MULTIPLAYER</p>
        </div>
        <form
          className="border border-green-700 p-8 w-96 max-w-[95vw] bg-black/80"
          onSubmit={(e) => { e.preventDefault(); void login(); }}
          autoComplete="on"
        >
          <label className="text-green-600 text-xs block mb-1">Username</label>
          <input
            name="username"
            autoComplete="username"
            className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 mb-3 outline-none focus:border-yellow-400 font-mono"
            placeholder="Your username..."
            value={inputName}
            onChange={(e) => setInputName(e.target.value)}
            autoFocus
          />
          <label className="text-green-600 text-xs block mb-1">Password</label>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 mb-4 outline-none focus:border-yellow-400 font-mono"
            placeholder="Password..."
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
          />
          {error && <p className="text-red-500 text-sm mb-3">{error}</p>}
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={loading || !inputName || !loginPassword}
              className="flex-1 border border-green-600 py-2 hover:bg-green-900 disabled:opacity-40"
            >
              LOGIN
            </button>
            <button
              type="button"
              onClick={() => {
                setError(""); setSignupFullName(""); setSignupEmail("");
                setSignupPassword(""); setSignupPasswordConfirm(""); setSetupPhase("signup");
              }}
              className="flex-1 border border-yellow-600 py-2 hover:bg-yellow-900 text-yellow-400"
            >
              SIGN UP
            </button>
          </div>
        </form>
        <Link href="/admin" className="text-green-800 text-xs mt-4 hover:text-green-500 underline">Admin</Link>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // SIGN UP
  // ---------------------------------------------------------------------------

  if (setupPhase === "signup") {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">DOOR GAMES</h1>
          <p className="text-green-600 text-sm tracking-widest">CREATE ACCOUNT</p>
        </div>
        <div className="border border-green-700 p-6 w-[420px] max-w-[95vw] bg-black/80 space-y-3">
          <div>
            <label className="text-green-600 text-xs block mb-1">Username</label>
            <input className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono" placeholder="Choose a username..." value={inputName} onChange={(e) => setInputName(e.target.value)} autoFocus />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Full name</label>
            <input className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono" placeholder="Your name" value={signupFullName} onChange={(e) => setSignupFullName(e.target.value)} />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Email address</label>
            <input type="email" className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono" placeholder="you@example.com" value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Password</label>
            <input type="password" autoComplete="new-password" className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono" placeholder="Min 8 characters" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} />
          </div>
          <div>
            <label className="text-green-600 text-xs block mb-1">Password (confirm)</label>
            <input type="password" autoComplete="new-password" className={`w-full bg-black border text-green-300 px-3 py-2 outline-none font-mono ${signupPasswordConfirm && signupPassword !== signupPasswordConfirm ? "border-red-600" : "border-green-600 focus:border-yellow-400"}`} placeholder="Repeat password" value={signupPasswordConfirm} onChange={(e) => setSignupPasswordConfirm(e.target.value)} />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button onClick={() => void submitSignup()} disabled={loading} className="w-full border border-yellow-600 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 font-bold tracking-wider">
            {loading ? "CREATING ACCOUNT…" : "CREATE ACCOUNT"}
          </button>
          <button onClick={() => { setError(""); setSetupPhase("login"); }} className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500">
            ← BACK TO LOGIN
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // GAME SELECT
  // ---------------------------------------------------------------------------

  if (setupPhase === "game-select" && authUser) {
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono py-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">DOOR GAMES</h1>
          <p className="text-green-600 text-sm tracking-widest">SELECT A GAME</p>
        </div>
        <div className="w-[520px] max-w-[95vw] space-y-3">
          <div className="text-green-700 text-xs border border-green-900 p-2 mb-2 font-normal">
            Welcome back, <span className="text-green-400">{authUser.username}</span>.
          </div>

          {CLIENT_GAME_REGISTRY.map((gameMeta) => {
            const gameGames = authGames.filter((g) => g.game === gameMeta.game || (!g.game && gameMeta.game === "srx"));
            return (
              <button
                key={gameMeta.game}
                onClick={() => {
                  setSelectedGame(gameMeta.game);
                  setSetupPhase("hub");
                }}
                className="w-full border border-yellow-700 p-4 hover:bg-yellow-900/20 text-left group"
              >
                <div className="text-yellow-400 font-bold tracking-wider text-base group-hover:text-yellow-300">
                  {gameMeta.displayName.toUpperCase()}
                </div>
                <p className="text-green-700 text-xs mt-1">{gameMeta.description}</p>
                {gameGames.length > 0 && (
                  <p className="text-green-600 text-xs mt-1.5">
                    {gameGames.length} active session{gameGames.length !== 1 ? "s" : ""}
                  </p>
                )}
              </button>
            );
          })}

          <button onClick={logoutFromHub} className="w-full text-center text-green-800 text-xs py-2 hover:text-green-600">
            LOG OUT
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // HUB (your games for the selected game)
  // ---------------------------------------------------------------------------

  if (setupPhase === "hub" && authUser) {
    const meta = getGameMeta(selectedGame);
    const myGames = authGames.filter((g) => g.game === selectedGame || (!g.game && selectedGame === "srx"));

    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono py-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">{meta.displayName.toUpperCase()}</h1>
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
            {myGames.length === 0 ? (
              <p className="text-green-700 text-xs">No active games in progress.</p>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {myGames.map((g) => (
                  <div key={g.playerId} className="border border-green-800 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                      <div className="text-green-300 text-sm">{g.galaxyName ?? "Unnamed session"}</div>
                      <div className="text-green-700 text-[10px]">
                        {g.turnsPlayed !== undefined && g.turnsLeft !== undefined
                          ? `Turn ${g.turnsPlayed} · ${g.turnsLeft} left · `
                          : null}
                        {g.playerCount}/{g.maxPlayers} players
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
                setInputGalaxyName("");
                initGameOptionsForGame(selectedGame);
                setSetupPhase("create-galaxy");
              }}
              className="w-full border border-yellow-600 p-3 hover:bg-yellow-900/20 text-left"
            >
              <div className="text-yellow-400 font-bold tracking-wider">CREATE NEW SESSION</div>
              <p className="text-green-700 text-xs mt-1">Configure and launch a new game on one screen.</p>
            </button>
            {meta.supportsJoin && (
              <button
                onClick={() => {
                  setError("");
                  void fetchLobbies();
                  setJoinInviteCode("");
                  setSetupPhase("join-game");
                }}
                className="w-full border border-green-600 p-3 hover:bg-green-900/20 text-left"
              >
                <div className="text-green-400 font-bold tracking-wider">JOIN EXISTING SESSION</div>
                <p className="text-green-700 text-xs mt-1">Public list or invite code.</p>
              </button>
            )}
          </div>

          <button onClick={logoutFromHub} className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500">
            LOG OUT
          </button>
          <button onClick={() => setSetupPhase("game-select")} className="w-full text-center text-green-800 text-xs py-1 hover:text-green-600">
            ← BACK TO GAME SELECT
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // JOIN GAME
  // ---------------------------------------------------------------------------

  if (setupPhase === "join-game") {
    const meta = getGameMeta(selectedGame);
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">{meta.displayName.toUpperCase()}</h1>
          <p className="text-green-600 text-sm tracking-widest">JOIN A SESSION</p>
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
                onClick={() => void joinGame()}
                disabled={loading || !joinInviteCode || !loginPassword}
                className="border border-yellow-600 px-4 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 text-sm"
              >
                JOIN
              </button>
            </div>
          </div>

          {lobbies.length > 0 && (
            <div>
              <div className="text-green-600 text-xs mb-2 border-b border-green-900 pb-1">PUBLIC SESSIONS</div>
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {lobbies.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => void joinGame(l.id)}
                    disabled={loading || !loginPassword}
                    className="w-full flex justify-between items-center border border-green-800 p-2 hover:border-green-600 hover:bg-green-900/20 disabled:opacity-40"
                  >
                    <div className="text-left">
                      <div className="text-green-300 text-sm">{l.galaxyName}</div>
                      <div className="text-green-700 text-[10px]">Created by {l.createdBy}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-green-600 text-xs">{l.playerCount}/{l.maxPlayers}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {lobbies.length === 0 && (
            <div className="text-green-800 text-xs text-center py-4">No public sessions available</div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}
          <button
            onClick={() => { setError(""); setSetupPhase(authUser ? "hub" : "login"); }}
            className="w-full text-center text-green-700 text-xs py-2 hover:text-green-500"
          >
            ← BACK
          </button>
        </div>
      </main>
    );
  }

  // ---------------------------------------------------------------------------
  // CREATE GALAXY — metadata-driven form
  // ---------------------------------------------------------------------------

  if (setupPhase === "create-galaxy") {
    const meta = getGameMeta(selectedGame);
    return (
      <main className="min-h-screen bg-black text-green-400 flex flex-col items-center justify-center font-mono py-8 px-2">
        <div className="text-center mb-4">
          <h1 className="text-2xl font-bold tracking-widest text-yellow-400 mb-1">{meta.displayName.toUpperCase()}</h1>
          <p className="text-green-600 text-sm tracking-widest">NEW SESSION</p>
          <p className="text-green-800 text-[11px] mt-1 max-w-md mx-auto">
            One step to create and enter.
          </p>
        </div>
        <div className="border border-green-700 p-6 w-[min(540px,96vw)] max-h-[min(90vh,900px)] overflow-y-auto bg-black/80 space-y-4">
          {authUser && (
            <div className="text-green-700 text-xs border border-green-900 p-2">
              Commander: <span className="text-green-400">{authUser.username}</span>
            </div>
          )}

          {/* Session name (engine-level, always shown) */}
          <div>
            <label className="text-green-600 text-xs block mb-1">Session Name (optional):</label>
            <input
              className="w-full bg-black border border-green-600 text-green-300 px-3 py-2 outline-none focus:border-yellow-400 font-mono"
              placeholder="e.g. My Session"
              value={inputGalaxyName}
              onChange={(e) => setInputGalaxyName(e.target.value)}
              autoFocus
            />
          </div>

          {/* Visibility (engine-level, always shown) */}
          <div className="flex items-center justify-between border border-green-800 p-3">
            <div>
              <div className="text-green-400 text-xs font-bold">Visibility</div>
              <div className="text-green-700 text-[10px]">
                {inputIsPublic ? "Anyone can browse and join" : "Invite code required"}
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

          {/* Dynamic game-specific options */}
          {meta.createOptions.map((opt) => {
            const val = gameOptions[opt.key] ?? opt.default;
            if (opt.type === "select") {
              return (
                <div key={opt.key} className="flex items-center justify-between border border-green-800 p-3">
                  <div>
                    <div className="text-green-400 text-xs font-bold">{opt.label}</div>
                    {opt.description && <div className="text-green-700 text-[10px]">{opt.description}</div>}
                  </div>
                  <select
                    value={String(val)}
                    onChange={(e) => setGameOptions((prev) => ({ ...prev, [opt.key]: e.target.value }))}
                    className="bg-black border border-green-700 text-green-400 text-xs px-2 py-1 focus:outline-none focus:border-yellow-600"
                  >
                    {opt.options?.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              );
            }
            if (opt.type === "boolean") {
              return (
                <div key={opt.key} className="flex items-center justify-between border border-green-800 p-3">
                  <div>
                    <div className="text-green-400 text-xs font-bold">{opt.label}</div>
                    {opt.description && <div className="text-green-700 text-[10px]">{opt.description}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => setGameOptions((prev) => ({ ...prev, [opt.key]: !prev[opt.key] }))}
                    className={`border px-3 py-1 text-xs ${val ? "border-yellow-600 text-yellow-400" : "border-green-600 text-green-400"}`}
                  >
                    {val ? "ON" : "OFF"}
                  </button>
                </div>
              );
            }
            // number
            if (opt.key === "aiCount") {
              const n = Number(val);
              const maxN = opt.max ?? 5;
              return (
                <div key={opt.key} className="border-t border-green-900 pt-4">
                  <div className="text-green-500 text-xs font-bold tracking-wider mb-1">AI OPPONENTS (OPTIONAL)</div>
                  {opt.description && <p className="text-green-700 text-[10px] mb-3">{opt.description}</p>}
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setGameOptions((prev) => ({ ...prev, [opt.key]: Math.max(opt.min ?? 0, n - 1) }))} disabled={n <= (opt.min ?? 0)} className="border border-green-700 px-3 py-1 text-green-400 hover:border-green-400 disabled:opacity-30 text-lg leading-none">−</button>
                    <span className="text-yellow-400 font-bold w-6 text-center text-sm">{n}</span>
                    <button type="button" onClick={() => setGameOptions((prev) => ({ ...prev, [opt.key]: Math.min(maxN, n + 1) }))} disabled={n >= maxN} className="border border-green-700 px-3 py-1 text-green-400 hover:border-green-400 disabled:opacity-30 text-lg leading-none">+</button>
                    <span className="text-green-700 text-xs">rival{n !== 1 ? "s" : ""} (max {maxN})</span>
                  </div>
                </div>
              );
            }
            return (
              <div key={opt.key} className="flex items-center justify-between border border-green-800 p-3 gap-3">
                <div>
                  <div className="text-green-400 text-xs font-bold">{opt.label}</div>
                  {opt.description && <div className="text-green-700 text-[10px]">{opt.description}</div>}
                </div>
                <input
                  type="number"
                  min={opt.min}
                  max={opt.max}
                  className="w-24 bg-black border border-green-700 text-green-400 text-sm px-2 py-1 font-mono"
                  value={String(val)}
                  onChange={(e) => setGameOptions((prev) => ({ ...prev, [opt.key]: parseInt(e.target.value, 10) || opt.default }))}
                />
              </div>
            );
          })}

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <button
            type="button"
            onClick={() => void register()}
            disabled={loading || !loginPassword}
            className="w-full border border-yellow-600 py-2 hover:bg-yellow-900 disabled:opacity-40 text-yellow-400 font-bold tracking-wider"
          >
            {loading ? "CREATING…" : "CREATE SESSION"}
          </button>
          <button
            type="button"
            onClick={() => { setError(""); setSetupPhase(authUser ? "hub" : "login"); }}
            className="w-full text-center text-green-700 text-xs py-1 hover:text-green-500"
          >
            ← BACK
          </button>
        </div>
      </main>
    );
  }

  // Fallback (should not reach here)
  return <main className="min-h-screen bg-black flex items-center justify-center font-mono text-green-400">Loading…</main>;
}
