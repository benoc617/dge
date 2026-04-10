"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/client-fetch";
import { TurnTimer } from "@/components/TurnTimer";
import { HelpModal } from "@/components/HelpModal";

// ---------------------------------------------------------------------------
// Types (mirror what buildStatus returns)
// ---------------------------------------------------------------------------

interface Piece { type: string; color: string }
type Board = (Piece | null)[][];

interface ChessStatus {
  playerId: string;
  name: string;
  sessionId: string;
  galaxyName: string | null;
  inviteCode: string | null;
  waitingForGameStart: boolean;
  gameStatus: string;
  winner: string | null;
  myColor: string;
  inCheck: boolean;
  isYourTurn: boolean;
  currentTurnPlayer: string;
  board: Board;
  turn: string;
  moveHistory: string[];
  capturedByWhite: string[];
  capturedByBlack: string[];
  fullMoveNumber: number;
  halfMoveClock: number;
  turnDeadline: string | null;
  turnTimeoutSecs: number;
  turnOrder: { name: string; isAI: boolean; isCurrent: boolean }[];
  game?: string;
  aiDifficulty?: "easy" | "medium" | "hard";
}

// ---------------------------------------------------------------------------
// Piece rendering (Unicode chess symbols)
// ---------------------------------------------------------------------------

// All pieces use the filled glyphs (U+265A–265F) so white pieces render as solid, not outlines.
const PIECE_CHARS: Record<string, string> = {
  K: "\u265A", Q: "\u265B", R: "\u265C", B: "\u265D", N: "\u265E", P: "\u265F",
};

const PIECE_NAMES: Record<string, string> = { K: "King", Q: "Queen", R: "Rook", B: "Bishop", N: "Knight", P: "Pawn" };

const PIECE_COLOR_STYLE: Record<string, string> = {
  white: "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]",
  black: "text-gray-900 drop-shadow-[0_1px_1px_rgba(255,255,255,0.25)]",
};

function squareToAlgebraic(rank: number, file: number): string {
  return `${String.fromCharCode(97 + file)}${rank + 1}`;
}

function algebraicToCoords(sq: string): [number, number] {
  return [parseInt(sq[1]) - 1, sq.charCodeAt(0) - 97];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ChessGameScreenProps {
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
// Component
// ---------------------------------------------------------------------------

export function ChessGameScreen({
  playerName,
  sessionPlayerId,
  onLogout,
}: ChessGameScreenProps) {
  const [status, setStatus] = useState<ChessStatus | null>(null);
  const [selectedSquare, setSelectedSquare] = useState<[number, number] | null>(null);
  const [legalTargets, setLegalTargets] = useState<Set<string>>(new Set());
  const [legalMoves, setLegalMoves] = useState<{ from: string; to: string; promotion?: string }[]>([]);
  const [promotionPending, setPromotionPending] = useState<{ from: [number, number]; to: [number, number] } | null>(null);
  const [message, setMessage] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const moveListRef = useRef<HTMLDivElement>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [helpContent, setHelpContent] = useState<{ title: string; content: string } | null>(null);

  // -------------------------------------------------------------------------
  // Status polling
  // -------------------------------------------------------------------------

  const fetchStatus = useCallback(async () => {
    if (!sessionPlayerId) return;
    try {
      const res = await apiFetch(`/api/game/status?id=${sessionPlayerId}`);
      if (res.ok) {
        const data = await res.json() as ChessStatus;
        setStatus(data);
      }
    } catch { /* ignore */ }
  }, [sessionPlayerId]);

  useEffect(() => {
    fetchStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!status) return;
    // Poll while waiting for opponent to join, or waiting for AI/opponent to move.
    const shouldPoll =
      status.waitingForGameStart ||
      (status.gameStatus === "playing" && !status.isYourTurn);
    if (shouldPoll) {
      pollRef.current = setInterval(fetchStatus, status.waitingForGameStart ? 3000 : 1500);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [status, fetchStatus]);

  // Auto-scroll move list to bottom when moves change
  useEffect(() => {
    if (moveListRef.current) {
      moveListRef.current.scrollTop = moveListRef.current.scrollHeight;
    }
  }, [status?.moveHistory.length]);

  const openHelp = useCallback(async () => {
    if (helpContent) { setShowHelp(true); return; }
    try {
      const res = await fetch("/api/game/help?game=chess");
      if (res.ok) {
        const data = (await res.json()) as { title: string; content: string };
        setHelpContent(data);
        setShowHelp(true);
      }
    } catch { /* non-critical */ }
  }, [helpContent]);

  // -------------------------------------------------------------------------
  // Compute legal moves for the selected piece
  // -------------------------------------------------------------------------

  const computeLegalMoves = useCallback(async (rank: number, file: number) => {
    if (!status?.board) return;
    const piece = status.board[rank][file];
    if (!piece || piece.color !== status.myColor) return;

    try {
      const res = await apiFetch(`/api/game/chess/moves?id=${sessionPlayerId}`);
      if (res.ok) {
        const data = await res.json() as { moves: { from: string; to: string; promotion?: string }[] };
        const fromStr = squareToAlgebraic(rank, file);
        const forPiece = data.moves.filter((m) => m.from === fromStr);
        setLegalMoves(forPiece);
        setLegalTargets(new Set(forPiece.map((m) => m.to)));
      }
    } catch { /* ignore */ }
  }, [status, sessionPlayerId]);

  // -------------------------------------------------------------------------
  // Optimistic board update — apply the move locally before the server confirms
  // -------------------------------------------------------------------------

  const applyOptimisticMove = useCallback((moveStr: string) => {
    if (!status) return;
    const from = algebraicToCoords(moveStr.slice(0, 2));
    const to = algebraicToCoords(moveStr.slice(2, 4));
    const promoChar = moveStr.length > 4 ? moveStr[4].toUpperCase() : null;

    const newBoard: Board = status.board.map((r) => r.map((p) => (p ? { ...p } : null)));
    const movingPiece = newBoard[from[0]][from[1]];
    if (!movingPiece) return;

    const newCapturedByWhite = [...status.capturedByWhite];
    const newCapturedByBlack = [...status.capturedByBlack];

    const captured = newBoard[to[0]][to[1]];
    if (captured) {
      if (status.turn === "white") newCapturedByWhite.push(captured.type);
      else newCapturedByBlack.push(captured.type);
    }

    newBoard[to[0]][to[1]] = promoChar
      ? { type: promoChar, color: movingPiece.color }
      : movingPiece;
    newBoard[from[0]][from[1]] = null;

    // En passant: pawn moves diagonally to empty square
    if (movingPiece.type === "P" && from[1] !== to[1] && !captured) {
      const epPiece = newBoard[from[0]][to[1]];
      if (epPiece) {
        if (status.turn === "white") newCapturedByWhite.push(epPiece.type);
        else newCapturedByBlack.push(epPiece.type);
      }
      newBoard[from[0]][to[1]] = null;
    }

    // Castling: king moves 2 files
    if (movingPiece.type === "K" && Math.abs(to[1] - from[1]) === 2) {
      const isKingside = to[1] > from[1];
      const rookFromFile = isKingside ? 7 : 0;
      const rookToFile = isKingside ? 5 : 3;
      newBoard[from[0]][rookToFile] = newBoard[from[0]][rookFromFile];
      newBoard[from[0]][rookFromFile] = null;
    }

    setStatus({
      ...status,
      board: newBoard,
      isYourTurn: false,
      moveHistory: [...status.moveHistory, moveStr],
      turn: status.turn === "white" ? "black" : "white",
      capturedByWhite: newCapturedByWhite,
      capturedByBlack: newCapturedByBlack,
    });
  }, [status]);

  // -------------------------------------------------------------------------
  // Board click handler
  // -------------------------------------------------------------------------

  const handleSquareClick = useCallback(async (rank: number, file: number) => {
    if (!status || status.gameStatus !== "playing" || !status.isYourTurn || submitting) return;

    if (promotionPending) return;

    const piece = status.board[rank][file];

    if (selectedSquare) {
      const [sr, sf] = selectedSquare;
      const targetStr = squareToAlgebraic(rank, file);

      if (sr === rank && sf === file) {
        setSelectedSquare(null);
        setLegalTargets(new Set());
        setLegalMoves([]);
        return;
      }

      if (piece && piece.color === status.myColor) {
        setSelectedSquare([rank, file]);
        await computeLegalMoves(rank, file);
        return;
      }

      if (legalTargets.has(targetStr)) {
        const matching = legalMoves.filter((m) => m.to === targetStr);
        if (matching.length > 1) {
          setPromotionPending({ from: [sr, sf], to: [rank, file] });
          return;
        }
        await executeMove(matching[0].from + matching[0].to + (matching[0].promotion ?? ""));
        return;
      }

      return;
    }

    if (piece && piece.color === status.myColor) {
      setSelectedSquare([rank, file]);
      await computeLegalMoves(rank, file);
    }
  }, [status, selectedSquare, legalTargets, legalMoves, submitting, promotionPending, computeLegalMoves]);

  // -------------------------------------------------------------------------
  // Execute move — optimistic: update board immediately, POST in background
  // -------------------------------------------------------------------------

  const executeMove = useCallback(async (moveStr: string) => {
    setSubmitting(true);
    setMessage("");
    setSelectedSquare(null);
    setLegalTargets(new Set());
    setLegalMoves([]);
    setPromotionPending(null);

    applyOptimisticMove(moveStr);

    try {
      const res = await apiFetch("/api/game/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName, playerId: sessionPlayerId, action: "move", move: moveStr }),
      });
      const data = await res.json();
      if (!data.success) {
        setMessage(data.message || data.error || "Move failed.");
        await fetchStatus();
      }
    } catch {
      setMessage("Network error.");
      await fetchStatus();
    } finally {
      setSubmitting(false);
    }
  }, [playerName, fetchStatus, applyOptimisticMove]);

  // -------------------------------------------------------------------------
  // Promotion handler
  // -------------------------------------------------------------------------

  const handlePromotion = useCallback(async (pieceType: string) => {
    if (!promotionPending) return;
    const fromStr = squareToAlgebraic(promotionPending.from[0], promotionPending.from[1]);
    const toStr = squareToAlgebraic(promotionPending.to[0], promotionPending.to[1]);
    await executeMove(fromStr + toStr + pieceType.toLowerCase());
  }, [promotionPending, executeMove]);

  // -------------------------------------------------------------------------
  // Resign
  // -------------------------------------------------------------------------

  const handleResign = useCallback(async () => {
    if (!status || status.gameStatus !== "playing" || submitting) return;
    if (!confirm("Are you sure you want to resign?")) return;
    setSubmitting(true);
    try {
      await apiFetch("/api/game/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerName, playerId: sessionPlayerId, action: "resign" }),
      });
    } catch { /* ignore */ }
    setSubmitting(false);
    await fetchStatus();
  }, [status, playerName, submitting, fetchStatus]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!status) {
    return <div className="flex items-center justify-center h-screen text-green-400 font-mono">Loading chess...</div>;
  }

  // Waiting for human opponent — show lobby screen.
  if (status.waitingForGameStart) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-black text-green-400 font-mono gap-6">
        <h1 className="text-2xl font-bold tracking-wider text-yellow-400">
          CHESS{status.galaxyName ? <span className="text-green-600 text-base font-normal ml-2">» {status.galaxyName}</span> : ""}
        </h1>
        <div className="border border-green-800 p-8 max-w-sm text-center space-y-4">
          <div className="text-green-600 text-sm">Waiting for opponent to join…</div>
          <div className="text-xs text-green-700">Share this invite code:</div>
          <div
            className="text-2xl font-bold text-yellow-400 tracking-widest cursor-pointer hover:text-yellow-300"
            title="Click to copy"
            onClick={() => { navigator.clipboard?.writeText(status.inviteCode ?? ""); }}
          >
            {status.inviteCode}
          </div>
          <div className="text-[10px] text-green-800">Click code to copy</div>
        </div>
        <button onClick={onLogout} className="text-red-900 hover:text-red-500 text-xs mt-4">
          LEAVE
        </button>
      </div>
    );
  }

  const isFlipped = status.myColor === "black";
  const gameOver = status.gameStatus !== "playing";

  return (
    <div className="flex flex-col min-h-screen bg-black text-green-400 font-mono">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-green-900">
        <h1 className="text-lg font-bold tracking-wider text-yellow-400">
          CHESS{status.galaxyName ? <span className="text-green-600 text-xs font-normal ml-2">» {status.galaxyName}</span> : ""}
        </h1>
        <div className="flex gap-3 items-center text-sm">
          {gameOver ? (
            <span className="text-yellow-400 font-bold">
              {status.gameStatus === "checkmate" && (status.winner === status.myColor ? "YOU WIN" : "YOU LOSE")}
              {status.gameStatus === "stalemate" && "DRAW"}
              {status.gameStatus === "resigned" && (status.winner === status.myColor ? "OPPONENT RESIGNED" : "YOU RESIGNED")}
              {status.gameStatus === "timeout" && (status.winner === status.myColor ? "OPPONENT TIMED OUT" : "TIME EXPIRED")}
              {status.gameStatus.startsWith("draw_") && status.gameStatus !== "stalemate" && "DRAW"}
            </span>
          ) : status.isYourTurn ? (
            <span className="text-cyan-400 font-bold">YOUR TURN</span>
          ) : (
            <span className="text-yellow-400">THINKING…</span>
          )}
          {!gameOver && status.inCheck && <span className="text-red-500 font-bold">CHECK</span>}
          {!gameOver && status.turnDeadline && (
            <TurnTimer deadline={status.turnDeadline} isYourTurn={status.isYourTurn} />
          )}
          <span className="text-gray-600">Move {status.fullMoveNumber}</span>
          <span className="text-gray-600">·</span>
          <span className="text-green-600">{playerName}</span>
          <span className="text-gray-700">({status.myColor})</span>
          {status.aiDifficulty && status.aiDifficulty !== "medium" && (
            <span className="text-green-800 text-[10px]">
              {status.aiDifficulty === "easy" ? "Beginner" : "Expert"}
            </span>
          )}
          {status.aiDifficulty === "medium" && (
            <span className="text-green-800 text-[10px]">Club</span>
          )}
          <button
            type="button"
            onClick={() => void openHelp()}
            className="border border-green-800 text-green-600 hover:border-green-500 hover:text-green-400 px-1.5 py-0.5 text-[10px] leading-none"
            title="Show help (rules & reference)"
          >
            ?
          </button>
          <button onClick={onLogout} className="text-red-900 hover:text-red-500 text-xs">
            LEAVE
          </button>
        </div>
      </div>

      {/* Main layout: left panel (captures + controls), center board, right panel (moves) */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — captured pieces + controls */}
        <div className="w-48 border-r border-green-900 flex flex-col bg-black">
          <CapturedPanel
            label={isFlipped ? "YOUR CAPTURES" : "YOUR CAPTURES"}
            pieces={isFlipped ? status.capturedByBlack : status.capturedByWhite}
            capturedColor={isFlipped ? "white" : "black"}
          />
          <CapturedPanel
            label={isFlipped ? "OPP. CAPTURES" : "OPP. CAPTURES"}
            pieces={isFlipped ? status.capturedByWhite : status.capturedByBlack}
            capturedColor={isFlipped ? "black" : "white"}
          />
          <div className="flex-1" />
          <div className="p-3 border-t border-green-900 flex flex-col gap-2">
            {!gameOver && status.isYourTurn && (
              <button
                onClick={handleResign}
                disabled={submitting}
                className="w-full px-3 py-1.5 border border-red-900 text-red-500 hover:bg-red-900/30 disabled:opacity-50 text-xs font-bold tracking-wider"
              >
                RESIGN
              </button>
            )}
            {gameOver && (
              <button
                onClick={onLogout}
                className="w-full px-3 py-1.5 border border-green-700 text-green-400 hover:bg-green-900/30 text-xs font-bold tracking-wider"
              >
                BACK TO LOBBY
              </button>
            )}
            {message && <div className="text-xs text-red-400 text-center">{message}</div>}
          </div>
        </div>

        {/* Board column */}
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="relative">
            <div className="grid grid-cols-8 border-2 border-green-800" style={{ width: "min(70vw, 520px)", height: "min(70vw, 520px)" }}>
              {Array.from({ length: 64 }).map((_, i) => {
                const displayRow = Math.floor(i / 8);
                const displayCol = i % 8;
                const rank = isFlipped ? displayRow : 7 - displayRow;
                const file = isFlipped ? 7 - displayCol : displayCol;
                const piece = status.board[rank][file];
                const isLight = (rank + file) % 2 === 1;
                const isSelected = selectedSquare?.[0] === rank && selectedSquare?.[1] === file;
                const sqStr = squareToAlgebraic(rank, file);
                const isTarget = legalTargets.has(sqStr);
                const isLastMoveSquare = status.moveHistory.length > 0 && (() => {
                  const last = status.moveHistory[status.moveHistory.length - 1];
                  const from = last.slice(0, 2);
                  const to = last.slice(2, 4);
                  return sqStr === from || sqStr === to;
                })();

                let bg = isLight ? "bg-amber-100" : "bg-amber-800";
                if (isSelected) bg = "bg-blue-500";
                else if (isLastMoveSquare) bg = isLight ? "bg-yellow-200" : "bg-yellow-700";

                return (
                  <button
                    key={`${rank}-${file}`}
                    className={`${bg} relative flex items-center justify-center`}
                    style={{ aspectRatio: "1" }}
                    onClick={() => handleSquareClick(rank, file)}
                    disabled={submitting}
                    title={`${sqStr}${piece ? ` — ${piece.color} ${PIECE_NAMES[piece.type] ?? piece.type}` : ""}`}
                  >
                    {isTarget && !piece && (
                      <div className="absolute w-3 h-3 rounded-full bg-green-500 opacity-60" />
                    )}
                    {isTarget && piece && (
                      <div className="absolute inset-0 border-4 border-red-500 rounded-sm opacity-70" />
                    )}
                    {piece && (
                      <span className={`text-3xl sm:text-4xl select-none ${PIECE_COLOR_STYLE[piece.color] ?? ""}`}
                        style={{ lineHeight: 1 }}>
                        {PIECE_CHARS[piece.type] ?? "?"}
                      </span>
                    )}
                    {displayCol === 0 && (
                      <span className="absolute top-0.5 left-0.5 text-[9px] text-gray-500 font-mono select-none">{rank + 1}</span>
                    )}
                    {displayRow === 7 && (
                      <span className="absolute bottom-0.5 right-0.5 text-[9px] text-gray-500 font-mono select-none">
                        {String.fromCharCode(97 + file)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Promotion dialog overlay */}
            {promotionPending && (
              <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-10">
                <div className="bg-gray-900 border border-green-600 rounded p-4 text-center">
                  <p className="text-green-400 mb-3 font-bold">Promote pawn to:</p>
                  <div className="flex gap-3 justify-center">
                    {(["Q", "R", "B", "N"] as const).map((pt) => (
                      <button
                        key={pt}
                        onClick={() => handlePromotion(pt)}
                        className={`text-4xl p-2 hover:bg-green-900 rounded ${PIECE_COLOR_STYLE[status.myColor] ?? ""}`}
                        title={PIECE_NAMES[pt]}
                      >
                        {PIECE_CHARS[pt]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Game over overlay */}
            {gameOver && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-10">
                <div className="bg-gray-900 border border-yellow-600 rounded p-6 text-center space-y-3 max-w-xs">
                  <div className="text-yellow-400 font-bold text-lg tracking-wider">GAME OVER</div>
                  <div className="text-green-400 text-sm">
                    {status.gameStatus === "checkmate" && (status.winner === status.myColor ? "Checkmate — you win!" : "Checkmate — you lose.")}
                    {status.gameStatus === "stalemate" && "Draw by stalemate."}
                    {status.gameStatus === "resigned" && (status.winner === status.myColor ? "Your opponent resigned." : "You resigned.")}
                    {status.gameStatus === "timeout" && (status.winner === status.myColor ? "Opponent ran out of time." : "You ran out of time.")}
                    {status.gameStatus === "draw_50move" && "Draw by 50-move rule."}
                    {status.gameStatus === "draw_repetition" && "Draw by threefold repetition."}
                    {status.gameStatus === "draw_insufficient" && "Draw by insufficient material."}
                  </div>
                  <button
                    onClick={onLogout}
                    className="px-4 py-2 border border-green-600 text-green-400 hover:bg-green-900/50 text-xs font-bold tracking-wider"
                  >
                    BACK TO LOBBY
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Move list panel (right side) */}
        <div className="w-48 border-l border-green-900 flex flex-col bg-black">
          <div className="px-3 py-2 border-b border-green-900 text-xs text-green-600 font-bold tracking-wider">
            MOVES
          </div>
          <div ref={moveListRef} className="flex-1 overflow-y-auto px-3 py-2 text-xs font-mono">
            {status.moveHistory.length === 0 ? (
              <div className="text-gray-700 text-center py-4">No moves yet</div>
            ) : (
              <table className="w-full">
                <tbody>
                  {Array.from({ length: Math.ceil(status.moveHistory.length / 2) }).map((_, i) => {
                    const whiteMove = status.moveHistory[i * 2];
                    const blackMove = status.moveHistory[i * 2 + 1];
                    const isLatestWhite = i * 2 === status.moveHistory.length - 1;
                    const isLatestBlack = i * 2 + 1 === status.moveHistory.length - 1;
                    return (
                      <tr key={i}>
                        <td className="text-gray-700 pr-2 text-right w-6">{i + 1}.</td>
                        <td className={`pr-3 ${isLatestWhite ? "text-yellow-400 font-bold" : "text-gray-300"}`}>
                          {whiteMove}
                        </td>
                        <td className={blackMove ? (isLatestBlack ? "text-yellow-400 font-bold" : "text-gray-300") : ""}>
                          {blackMove ?? ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Help modal */}
      {showHelp && helpContent && (
        <HelpModal
          title={helpContent.title}
          content={helpContent.content}
          onClose={() => setShowHelp(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Captured pieces panel section
// ---------------------------------------------------------------------------

const PIECE_VALUE_ORDER: Record<string, number> = { Q: 0, R: 1, B: 2, N: 3, P: 4 };

function CapturedPanel({ label, pieces, capturedColor }: { label: string; pieces: string[]; capturedColor: string }) {
  const sorted = [...pieces].sort((a, b) => (PIECE_VALUE_ORDER[a] ?? 9) - (PIECE_VALUE_ORDER[b] ?? 9));
  return (
    <div className="px-3 py-2 border-b border-green-900">
      <div className="text-[10px] text-green-700 font-bold tracking-wider mb-1">{label}</div>
      <div className="flex flex-wrap gap-0.5 min-h-[1.5rem]">
        {sorted.length > 0 ? sorted.map((pt, i) => (
          <span key={i} className={`text-xl ${PIECE_COLOR_STYLE[capturedColor] ?? ""} opacity-70`} title={PIECE_NAMES[pt]}>
            {PIECE_CHARS[pt] ?? "?"}
          </span>
        )) : (
          <span className="text-gray-800 text-[10px] italic">none</span>
        )}
      </div>
    </div>
  );
}
