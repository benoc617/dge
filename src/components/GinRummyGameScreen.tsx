"use client";

import { useState, useCallback, useEffect } from "react";
import { apiFetch } from "@/lib/client-fetch";
import { TurnTimer } from "@/components/TurnTimer";

// ---------------------------------------------------------------------------
// Types (mirror what buildStatus returns)
// ---------------------------------------------------------------------------

interface LegalAction { action: string; params: Record<string, unknown>; label: string }
interface HandResult {
  knockerIdx: 0 | 1;
  isGin: boolean;
  isUndercut: boolean;
  knockerDeadwood: number;
  defenderDeadwood: number;
  defenderDeadwoodAfterLayoff: number;
  points: number;
  winner: 0 | 1;
  knockerMelds: string[][];
  defenderMelds: string[][];
  knockerDeadwoodCards: string[];
  defenderDeadwoodCards: string[];
}

interface GinStatus {
  playerId: string;
  name: string;
  sessionId: string;
  galaxyName: string | null;
  inviteCode: string | null;
  waitingForGameStart: boolean;
  turnDeadline: string | null;
  turnTimeoutSecs: number;
  isYourTurn: boolean;
  gameStatus: string;
  winner: 0 | 1 | null;
  phase: string;
  myPlayerIdx: 0 | 1 | null;
  myCards: string[];
  myMelds: string[][];
  myDeadwood: string[];
  myDeadwoodValue: number;
  opponentCardCount: number;
  discardTop: string | null;
  stockCount: number;
  legalActions: LegalAction[];
  handResult: HandResult | null;
  scores: [number, number];
  handsWon: [number, number];
  handNumber: number;
  matchTarget: number | null;
  knockerMelds: string[][] | null;
  isLayoffPhase: boolean;
  layoffOptions: string[];
  turnOrder: { name: string; isAI: boolean; isCurrent: boolean }[];
  game?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GinRummyGameScreenProps {
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

// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------

const SUIT_CHARS: Record<string, string> = { H: "♥", D: "♦", C: "♣", S: "♠" };
const RED_SUITS = new Set(["H", "D"]);

function parseCard(key: string): { rank: string; suit: string } {
  const suit = key[key.length - 1];
  const rank = key.slice(0, -1);
  return { rank, suit };
}

function CardView({
  cardKey,
  selected = false,
  faceDown = false,
  dim = false,
  highlight = false,
  small = false,
  onClick,
}: {
  cardKey: string;
  selected?: boolean;
  faceDown?: boolean;
  dim?: boolean;
  highlight?: boolean;
  small?: boolean;
  onClick?: () => void;
}) {
  const { rank, suit } = parseCard(cardKey);
  const isRed = RED_SUITS.has(suit);
  const suitChar = SUIT_CHARS[suit] ?? "?";

  const base = small
    ? "inline-flex flex-col items-center justify-between rounded border font-mono select-none px-0.5 py-0.5 w-8 h-11"
    : "inline-flex flex-col items-center justify-between rounded border font-mono select-none px-1 py-1 w-11 h-16";

  const colorCls = faceDown
    ? "bg-blue-900 border-blue-700 text-blue-400"
    : isRed
      ? "bg-gray-900 border-gray-600 text-red-400"
      : "bg-gray-900 border-gray-600 text-white";

  const stateCls = selected
    ? "ring-2 ring-yellow-400 -translate-y-2"
    : highlight
      ? "ring-2 ring-green-400"
      : dim
        ? "opacity-40"
        : "";

  const cursorCls = onClick ? "cursor-pointer hover:border-yellow-400 transition-all" : "";

  if (faceDown) {
    return (
      <div className={`${base} ${colorCls} ${stateCls} ${cursorCls}`} onClick={onClick} title="Face-down card">
        <span className={small ? "text-xs" : "text-sm"}>🂠</span>
      </div>
    );
  }

  const rankSizeTop = small ? "text-xs leading-none" : "text-sm leading-none";
  const suitSizeCenter = small ? "text-base" : "text-xl";

  return (
    <div
      className={`${base} ${colorCls} ${stateCls} ${cursorCls}`}
      onClick={onClick}
      title={`${rank} of ${suit === "H" ? "Hearts" : suit === "D" ? "Diamonds" : suit === "C" ? "Clubs" : "Spades"}`}
    >
      <span className={rankSizeTop}>{rank}</span>
      <span className={suitSizeCenter}>{suitChar}</span>
      <span className={`${rankSizeTop} rotate-180`}>{rank}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lobby / Waiting screen
// ---------------------------------------------------------------------------

function WaitingScreen({
  galaxyName,
  inviteCode,
  onBack,
}: { galaxyName: string | null; inviteCode: string | null; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (inviteCode) {
      void navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono flex flex-col items-center justify-center gap-6">
      <h1 className="text-2xl text-yellow-400">GIN RUMMY</h1>
      <p className="text-green-600">{galaxyName ?? "Unnamed game"}</p>
      <p className="text-green-400">Waiting for opponent to join…</p>
      {inviteCode && (
        <div className="flex gap-2 items-center">
          <span className="text-green-600">Invite code:</span>
          <span
            className="text-yellow-400 cursor-pointer border border-green-700 px-3 py-1 rounded hover:bg-green-900"
            onClick={copy}
            title="Click to copy"
          >
            {inviteCode}
          </span>
          {copied && <span className="text-green-400 text-xs">Copied!</span>}
        </div>
      )}
      <button
        onClick={onBack}
        className="mt-4 border border-green-700 text-green-400 px-4 py-2 rounded hover:bg-green-900"
      >
        BACK TO LOBBY
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Game-over overlay
// ---------------------------------------------------------------------------

function GameOverOverlay({
  status,
  handResult,
  scores,
  myPlayerIdx,
  matchTarget,
  handsWon,
  onBack,
}: {
  status: string;
  handResult: HandResult | null;
  scores: [number, number];
  myPlayerIdx: 0 | 1 | null;
  matchTarget: number | null;
  handsWon: [number, number];
  onBack: () => void;
}) {
  const myIdx = myPlayerIdx ?? 0;
  const iWon = handResult ? handResult.winner === myIdx : scores[myIdx] > scores[1 - myIdx];

  let headline = "";
  let detail = "";

  if (status === "resigned" || status === "timeout") {
    headline = iWon ? "OPPONENT FORFEITED" : status === "timeout" ? "TIME IS UP" : "YOU RESIGNED";
    detail = iWon ? "You win!" : "Better luck next time.";
  } else if (status === "draw") {
    headline = "DRAW";
    detail = "Stock exhausted — no points scored this hand.";
  } else if (status === "match_complete") {
    headline = iWon ? "YOU WIN THE MATCH!" : "MATCH OVER";
    detail = `Final score — You: ${scores[myIdx]} | Opponent: ${scores[1 - myIdx]}`;
  } else {
    // hand_complete
    if (handResult) {
      if (handResult.isGin) {
        headline = handResult.winner === myIdx ? "GIN! YOU WIN" : "OPPONENT GOES GIN";
      } else if (handResult.isUndercut) {
        headline = handResult.winner === myIdx ? "UNDERCUT! YOU WIN" : "YOU WERE UNDERCUT";
      } else {
        headline = handResult.winner === myIdx ? "KNOCK! YOU WIN" : "OPPONENT KNOCKS";
      }
      detail = `${handResult.points} points · You: ${scores[myIdx]} | Opp: ${scores[1 - myIdx]}`;
    }
  }

  return (
    <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-50 gap-4">
      <div className="border border-yellow-400 p-8 rounded text-center">
        <h2 className="text-3xl text-yellow-400 mb-2">{headline}</h2>
        <p className="text-green-400 mb-4">{detail}</p>
        {matchTarget && (
          <p className="text-green-600 text-sm">
            Hands won — You: {handsWon[myIdx]} | Opponent: {handsWon[1 - myIdx]}
          </p>
        )}
        <button
          onClick={onBack}
          className="mt-6 border border-green-400 text-green-400 px-6 py-2 rounded hover:bg-green-900"
        >
          BACK TO LOBBY
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main game screen
// ---------------------------------------------------------------------------

export function GinRummyGameScreen({
  playerName,
  sessionPlayerId,
  gameSessionId,
  initialInviteCode,
  initialGalaxyName,
  onLogout,
}: GinRummyGameScreenProps) {
  const [status, setStatus] = useState<GinStatus | null>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [pendingLayoffs, setPendingLayoffs] = useState<string[]>([]);
  const [message, setMessage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [showHandResult, setShowHandResult] = useState(false);

  const playerId = sessionPlayerId ?? "";
  const gameId = gameSessionId ?? "";

  // ── Status polling ───────────────────────────────────────────────────────

  const fetchStatus = useCallback(async () => {
    if (!playerId) return;
    const res = await apiFetch(
      `/api/game/status?id=${encodeURIComponent(playerId)}`,
    );
    if (!res.ok) return;
    const data = (await res.json()) as GinStatus;
    setStatus((prev) => {
      // Show hand result overlay when a hand ends
      if (
        data.handResult &&
        (!prev?.handResult || prev.phase !== "hand_over" && data.phase === "hand_over")
      ) {
        setShowHandResult(true);
      }
      return data;
    });
  }, [playerId]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(
      () => void fetchStatus(),
      status?.isYourTurn ? 3000 : 2000,
    );
    return () => clearInterval(interval);
  }, [fetchStatus, status?.isYourTurn]);

  // Reset layoff selection on phase change
  useEffect(() => {
    if (status?.phase !== "layoff") {
      setPendingLayoffs([]);
    }
  }, [status?.phase]);

  // ── Action helpers ───────────────────────────────────────────────────────

  const doAction = useCallback(
    async (action: string, params: Record<string, unknown> = {}) => {
      if (busy) return;
      setBusy(true);
      setMessage("");
      try {
        const res = await apiFetch("/api/game/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playerId, action, ...params }),
        });
        const data = (await res.json()) as { success: boolean; message?: string };
        if (!data.success) {
          setMessage(data.message ?? "Action failed.");
        } else {
          setSelectedCard(null);
          await fetchStatus();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, playerId, fetchStatus],
  );

  // ── Derived state ────────────────────────────────────────────────────────

  const gameOver =
    status &&
    (status.gameStatus === "match_complete" ||
      status.gameStatus === "hand_complete" ||
      status.gameStatus === "resigned" ||
      status.gameStatus === "timeout");

  const canDraw = status?.isYourTurn && status.phase === "draw" && !busy;
  const canDiscard = status?.isYourTurn && status.phase === "discard" && selectedCard && !busy;
  const canKnock =
    status?.isYourTurn &&
    status.phase === "discard" &&
    selectedCard &&
    !busy &&
    (() => {
      if (!status || !selectedCard) return false;
      const remaining = status.myCards.filter((c) => c !== selectedCard);
      return status.legalActions.some(
        (a) => a.action === "knock" && (a.params as Record<string, unknown>).card === selectedCard,
      );
    })();
  const canGin =
    status?.isYourTurn &&
    status.phase === "discard" &&
    selectedCard &&
    !busy &&
    status.legalActions.some(
      (a) => a.action === "gin" && (a.params as Record<string, unknown>).card === selectedCard,
    );

  const myName = playerName;
  const opponentName = status?.turnOrder.find((p) => p.name !== myName)?.name ?? "Opponent";
  const myScore = status?.scores[status.myPlayerIdx ?? 0] ?? 0;
  const oppScore = status?.scores[status.myPlayerIdx === 0 ? 1 : 0] ?? 0;

  const galaxyName = status?.galaxyName ?? initialGalaxyName ?? "Gin Rummy";

  // ── Waiting for opponent ─────────────────────────────────────────────────

  if (status?.waitingForGameStart) {
    return (
      <WaitingScreen
        galaxyName={galaxyName}
        inviteCode={status.inviteCode ?? initialInviteCode}
        onBack={onLogout}
      />
    );
  }

  // ── Turn status display ──────────────────────────────────────────────────

  let turnLabel = "";
  if (!status) {
    turnLabel = "Loading…";
  } else if (gameOver) {
    turnLabel = "GAME OVER";
  } else if (status.phase === "layoff") {
    turnLabel = status.isLayoffPhase ? "LAY OFF CARDS" : "WAITING FOR LAYOFF";
  } else if (status.isYourTurn) {
    if (status.phase === "draw") turnLabel = "DRAW A CARD";
    else if (status.phase === "discard") turnLabel = "DISCARD A CARD";
    else turnLabel = "YOUR TURN";
  } else {
    turnLabel = `${opponentName}'S TURN`;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-black text-green-400 font-mono flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-green-900 text-xs">
        <div className="flex items-center gap-3">
          <span className="text-yellow-400 font-bold">
            GIN RUMMY{galaxyName ? ` » ${galaxyName}` : ""}
          </span>
          <span className="text-green-600">Hand {status?.handNumber ?? 1}</span>
          {status?.matchTarget && (
            <span className="text-green-600">Match to {status.matchTarget}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className={status?.isYourTurn ? "text-yellow-400" : "text-green-600"}>
            {turnLabel}
          </span>
          {status?.turnDeadline && !gameOver && (
            <TurnTimer deadline={status.turnDeadline} isYourTurn={status.isYourTurn} />
          )}
          <button
            onClick={onLogout}
            className="text-green-700 hover:text-green-400 border border-green-800 px-2 py-0.5 rounded text-xs"
          >
            LOBBY
          </button>
        </div>
      </div>

      {/* Main layout: left scores + center table + right log */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: scores and controls */}
        <div className="w-48 border-r border-green-900 p-3 flex flex-col gap-4 text-xs overflow-y-auto">
          <div>
            <div className="text-green-600 mb-1">SCORES</div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-yellow-400">{myName}</span>
                <span className="text-yellow-400 tabular-nums">{myScore}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-300">{opponentName}</span>
                <span className="text-green-300 tabular-nums">{oppScore}</span>
              </div>
            </div>
          </div>

          {status?.matchTarget && (
            <div>
              <div className="text-green-600 mb-1">HANDS WON</div>
              <div className="space-y-1">
                <div className="flex justify-between">
                  <span className="text-yellow-400">{myName}</span>
                  <span className="tabular-nums">{status.handsWon[status.myPlayerIdx ?? 0]}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-green-300">{opponentName}</span>
                  <span className="tabular-nums">{status.handsWon[status.myPlayerIdx === 0 ? 1 : 0]}</span>
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="text-green-600 mb-1">YOUR HAND</div>
            <div className="space-y-0.5">
              <div className="text-green-400">
                Deadwood:{" "}
                <span className={status && status.myDeadwoodValue <= 10 ? "text-green-400" : "text-red-400"}>
                  {status?.myDeadwoodValue ?? "—"}
                </span>
              </div>
              {status?.myMelds && status.myMelds.length > 0 && (
                <div className="text-green-600">
                  Melds: {status.myMelds.length}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className="text-green-600 mb-1">TABLE</div>
            <div className="space-y-0.5">
              <div>Stock: {status?.stockCount ?? "—"}</div>
              <div>Discard: {status?.discardTop ?? "—"}</div>
            </div>
          </div>

          {status?.phase === "draw" && status.isYourTurn && (
            <div>
              <div className="text-green-600 mb-2">DRAW FROM</div>
              <div className="flex flex-col gap-2">
                <button
                  disabled={!canDraw || (status?.stockCount ?? 0) === 0}
                  onClick={() => void doAction("draw_stock")}
                  className="border border-green-600 text-green-400 py-1 rounded hover:bg-green-900 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  STOCK ({status?.stockCount ?? 0})
                </button>
                <button
                  disabled={!canDraw || !status?.discardTop}
                  onClick={() => void doAction("draw_discard")}
                  className="border border-blue-600 text-blue-400 py-1 rounded hover:bg-blue-900 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  DISCARD ({status?.discardTop ?? "—"})
                </button>
              </div>
            </div>
          )}

          {status?.phase === "discard" && status.isYourTurn && (
            <div>
              <div className="text-green-600 mb-2">ACTION</div>
              <div className="flex flex-col gap-2">
                <button
                  disabled={!canDiscard}
                  onClick={() => selectedCard && void doAction("discard", { card: selectedCard })}
                  className="border border-yellow-600 text-yellow-400 py-1 rounded hover:bg-yellow-900 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                >
                  DISCARD {selectedCard ?? "(select)"}
                </button>
                {canKnock && (
                  <button
                    disabled={!canKnock}
                    onClick={() => selectedCard && void doAction("knock", { card: selectedCard })}
                    className="border border-orange-500 text-orange-400 py-1 rounded hover:bg-orange-900 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
                  >
                    KNOCK ({status?.myDeadwoodValue})
                  </button>
                )}
                {canGin && (
                  <button
                    disabled={!canGin}
                    onClick={() => selectedCard && void doAction("gin", { card: selectedCard })}
                    className="border border-green-400 text-green-300 py-1 rounded hover:bg-green-900 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-bold"
                  >
                    GIN!
                  </button>
                )}
              </div>
            </div>
          )}

          {status?.isLayoffPhase && (
            <div>
              <div className="text-green-600 mb-2">LAY OFF</div>
              <div className="flex flex-col gap-2">
                {pendingLayoffs.length > 0 && (
                  <button
                    onClick={() => {
                      const layoffs = pendingLayoffs.map((card) => {
                        const opts = status.legalActions.find((a) => a.action === "layoff");
                        const allLayoffs = (opts?.params as Record<string, unknown>)?.layoffs as Array<{ card: string; meldIndex: number }> | undefined;
                        const match = allLayoffs?.find((l) => l.card === card);
                        return match ?? { card, meldIndex: 0 };
                      });
                      void doAction("layoff", { layoffs });
                    }}
                    className="border border-green-500 text-green-400 py-1 rounded hover:bg-green-900 text-xs"
                  >
                    LAY OFF ({pendingLayoffs.length})
                  </button>
                )}
                <button
                  onClick={() => void doAction("pass_layoff")}
                  className="border border-green-700 text-green-600 py-1 rounded hover:bg-green-900 text-xs"
                >
                  PASS
                </button>
              </div>
              {pendingLayoffs.length > 0 && (
                <div className="mt-2 text-green-600">
                  Selected: {pendingLayoffs.join(", ")}
                </div>
              )}
            </div>
          )}

          {status?.phase === "hand_over" && status.matchTarget !== null && status.isYourTurn && (
            <button
              onClick={() => void doAction("next_hand")}
              className="border border-yellow-500 text-yellow-400 py-1 rounded hover:bg-yellow-900 text-xs"
            >
              NEXT HAND
            </button>
          )}

          {!gameOver && (
            <button
              onClick={() => void doAction("resign")}
              className="mt-auto border border-red-800 text-red-700 py-1 rounded hover:bg-red-900 text-xs"
            >
              RESIGN
            </button>
          )}
        </div>

        {/* Center: card table */}
        <div className="flex-1 flex flex-col items-center justify-between p-4 relative">
          {/* Game-over overlay */}
          {gameOver && (
            <GameOverOverlay
              status={status!.gameStatus}
              handResult={status!.handResult}
              scores={status!.scores}
              myPlayerIdx={status!.myPlayerIdx}
              matchTarget={status!.matchTarget}
              handsWon={status!.handsWon}
              onBack={onLogout}
            />
          )}

          {/* Hand result popup (non-terminal hands in match mode) */}
          {showHandResult && status?.handResult && !gameOver && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-40">
              <div className="border border-yellow-400 bg-black p-6 rounded max-w-md text-center">
                <h3 className="text-xl text-yellow-400 mb-3">
                  {status.handResult.isGin ? "GIN!" : status.handResult.isUndercut ? "UNDERCUT!" : "KNOCK!"}
                </h3>
                <p className="text-green-400">
                  {status.handResult.winner === status.myPlayerIdx ? "You win" : "Opponent wins"}{" "}
                  {status.handResult.points} points
                </p>
                <p className="text-green-600 text-sm mt-1">
                  Knocker deadwood: {status.handResult.knockerDeadwood} · Defender: {status.handResult.defenderDeadwoodAfterLayoff}
                </p>
                <p className="text-green-400 mt-3">
                  Score — You: {status.scores[status.myPlayerIdx ?? 0]} | Opp: {status.scores[status.myPlayerIdx === 0 ? 1 : 0]}
                </p>
                <button
                  onClick={() => setShowHandResult(false)}
                  className="mt-4 border border-green-600 text-green-400 px-4 py-2 rounded hover:bg-green-900 text-sm"
                >
                  OK
                </button>
              </div>
            </div>
          )}

          {/* Opponent's hand (face down) */}
          <div className="w-full">
            <div className="text-xs text-green-600 mb-1 text-center">
              {opponentName} · {status?.opponentCardCount ?? 10} cards
            </div>
            <div className="flex justify-center gap-1 flex-wrap">
              {Array.from({ length: status?.opponentCardCount ?? 10 }).map((_, i) => (
                <CardView key={i} cardKey="??" faceDown small />
              ))}
            </div>
          </div>

          {/* Stock + Discard piles */}
          <div className="flex items-center gap-8">
            {/* Stock pile */}
            <div className="flex flex-col items-center gap-1">
              <div className="text-xs text-green-600">STOCK ({status?.stockCount ?? 0})</div>
              {(status?.stockCount ?? 0) > 0 ? (
                <CardView
                  cardKey="??"
                  faceDown
                  onClick={canDraw ? () => void doAction("draw_stock") : undefined}
                />
              ) : (
                <div className="w-11 h-16 border border-dashed border-green-800 rounded flex items-center justify-center text-green-800 text-xs">
                  EMPTY
                </div>
              )}
            </div>

            {/* Phase indicator */}
            <div className="text-center">
              <div className="text-yellow-400 text-sm font-bold">
                {status?.phase === "draw"
                  ? "DRAW"
                  : status?.phase === "discard"
                    ? "DISCARD"
                    : status?.phase === "layoff"
                      ? "LAYOFF"
                      : status?.phase === "hand_over"
                        ? "HAND OVER"
                        : "—"}
              </div>
              {message && (
                <div className="text-red-400 text-xs mt-1 max-w-24">{message}</div>
              )}
            </div>

            {/* Discard pile */}
            <div className="flex flex-col items-center gap-1">
              <div className="text-xs text-green-600">DISCARD</div>
              {status?.discardTop ? (
                <CardView
                  cardKey={status.discardTop}
                  onClick={canDraw ? () => void doAction("draw_discard") : undefined}
                  highlight={canDraw}
                />
              ) : (
                <div className="w-11 h-16 border border-dashed border-green-800 rounded flex items-center justify-center text-green-800 text-xs">
                  EMPTY
                </div>
              )}
            </div>
          </div>

          {/* Knocker's melds (shown during layoff) */}
          {status?.phase === "layoff" && status.knockerMelds && (
            <div className="w-full">
              <div className="text-xs text-green-600 mb-1 text-center">
                KNOCKER'S MELDS (lay off cards onto these)
              </div>
              <div className="flex justify-center gap-4 flex-wrap">
                {status.knockerMelds.map((meld, mi) => (
                  <div key={mi} className="flex gap-0.5 border border-green-800 p-1 rounded">
                    {meld.map((ck) => (
                      <CardView key={ck} cardKey={ck} small />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* My hand */}
          <div className="w-full">
            <div className="text-xs text-green-600 mb-1 text-center">
              YOUR HAND · Deadwood: {status?.myDeadwoodValue ?? "—"}
              {status?.phase === "discard" && status.isYourTurn && " · Click to select discard"}
            </div>
            {/* Melds grouping */}
            {status?.myMelds && status.myMelds.length > 0 && (
              <div className="flex justify-center gap-3 flex-wrap mb-2">
                {status.myMelds.map((meld, mi) => (
                  <div key={mi} className="flex gap-0.5 border border-green-800/50 p-0.5 rounded">
                    {meld.map((ck) => (
                      <CardView
                        key={ck}
                        cardKey={ck}
                        selected={selectedCard === ck}
                        dim={
                          status.phase === "discard" &&
                          status.isYourTurn &&
                          !!selectedCard &&
                          selectedCard !== ck
                        }
                        onClick={
                          status.isYourTurn && (status.phase === "discard")
                            ? () => setSelectedCard((prev) => (prev === ck ? null : ck))
                            : status.isLayoffPhase
                              ? () =>
                                  setPendingLayoffs((prev) =>
                                    prev.includes(ck)
                                      ? prev.filter((c) => c !== ck)
                                      : [...prev, ck],
                                  )
                              : undefined
                        }
                      />
                    ))}
                  </div>
                ))}
                {/* Deadwood cards */}
                {status.myDeadwood.length > 0 && (
                  <div className="flex gap-0.5 p-0.5">
                    {status.myDeadwood.map((ck) => (
                      <CardView
                        key={ck}
                        cardKey={ck}
                        selected={selectedCard === ck}
                        highlight={
                          status.isLayoffPhase &&
                          status.layoffOptions.includes(ck)
                        }
                        dim={
                          status.phase === "discard" &&
                          status.isYourTurn &&
                          !!selectedCard &&
                          selectedCard !== ck &&
                          !status.myMelds.flat().includes(ck)
                        }
                        onClick={
                          status.isYourTurn && status.phase === "discard"
                            ? () => setSelectedCard((prev) => (prev === ck ? null : ck))
                            : status.isLayoffPhase && status.layoffOptions.includes(ck)
                              ? () =>
                                  setPendingLayoffs((prev) =>
                                    prev.includes(ck)
                                      ? prev.filter((c) => c !== ck)
                                      : [...prev, ck],
                                  )
                              : undefined
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* All cards (flat view when no melds yet) */}
            {(!status?.myMelds || status.myMelds.length === 0) && (
              <div className="flex justify-center gap-1 flex-wrap">
                {(status?.myCards ?? []).map((ck) => (
                  <CardView
                    key={ck}
                    cardKey={ck}
                    selected={selectedCard === ck}
                    highlight={status?.isLayoffPhase && status.layoffOptions.includes(ck)}
                    dim={
                      status?.phase === "discard" &&
                      status?.isYourTurn &&
                      !!selectedCard &&
                      selectedCard !== ck
                    }
                    onClick={
                      status?.isYourTurn && status?.phase === "discard"
                        ? () => setSelectedCard((prev) => (prev === ck ? null : ck))
                        : status?.isLayoffPhase && status.layoffOptions.includes(ck)
                          ? () =>
                              setPendingLayoffs((prev) =>
                                prev.includes(ck)
                                  ? prev.filter((c) => c !== ck)
                                  : [...prev, ck],
                              )
                          : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel: hand result + log */}
        <div className="w-48 border-l border-green-900 p-3 flex flex-col gap-3 text-xs overflow-y-auto">
          <div>
            <div className="text-green-600 mb-1">HAND RESULT</div>
            {status?.handResult ? (
              <div className="space-y-1 text-green-400">
                <div>
                  {status.handResult.isGin
                    ? "GIN"
                    : status.handResult.isUndercut
                      ? "UNDERCUT"
                      : "KNOCK"}
                </div>
                <div>
                  {status.handResult.winner === status.myPlayerIdx ? "You won" : "Opp won"}{" "}
                  {status.handResult.points} pts
                </div>
                <div className="text-green-600">
                  Knocker DW: {status.handResult.knockerDeadwood}
                </div>
                <div className="text-green-600">
                  Defender DW: {status.handResult.defenderDeadwoodAfterLayoff}
                </div>
              </div>
            ) : (
              <div className="text-green-800">—</div>
            )}
          </div>

          <div>
            <div className="text-green-600 mb-1">OPPONENT</div>
            <div className="text-green-400">{status?.opponentCardCount ?? 10} cards in hand</div>
          </div>

          <div>
            <div className="text-green-600 mb-1">PLAYERS</div>
            {(status?.turnOrder ?? []).map((p) => (
              <div key={p.name} className={p.isCurrent ? "text-yellow-400" : "text-green-600"}>
                {p.isCurrent ? "▸ " : "  "}
                {p.name}
                {p.isAI ? " [AI]" : ""}
              </div>
            ))}
          </div>

          {status?.matchTarget && (
            <div>
              <div className="text-green-600 mb-1">MATCH</div>
              <div className="text-green-400">Target: {status.matchTarget}</div>
              <div className="text-green-400">
                You: {status.scores[status.myPlayerIdx ?? 0]}
              </div>
              <div className="text-green-400">
                Opp: {status.scores[status.myPlayerIdx === 0 ? 1 : 0]}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
