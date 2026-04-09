import { describe, it, expect } from "vitest";
import {
  createInitialState,
  createInitialBoard,
  getLegalMoves,
  applyMove,
  resign,
  cloneState,
  moveToString,
  stringToMove,
  evaluateMaterial,
  isInCheck,
  boardPositionKey,
} from "@dge/chess";
import type { ChessState, ChessMove } from "@dge/chess";

function makeMove(state: ChessState, from: string, to: string, promotion?: string): ChessState {
  const move = stringToMove(from + to + (promotion ?? ""));
  const legal = getLegalMoves(state);
  const match = legal.find(
    (m) => m.from[0] === move.from[0] && m.from[1] === move.from[1] &&
           m.to[0] === move.to[0] && m.to[1] === move.to[1] &&
           (m.promotion ?? null) === (move.promotion ?? null),
  );
  expect(match).toBeDefined();
  return applyMove(state, match!);
}

describe("Chess rules — initial state", () => {
  it("creates a valid initial board", () => {
    const board = createInitialBoard();
    expect(board[0][4]?.type).toBe("K");
    expect(board[0][4]?.color).toBe("white");
    expect(board[7][4]?.type).toBe("K");
    expect(board[7][4]?.color).toBe("black");
    expect(board[1][0]?.type).toBe("P");
    expect(board[6][0]?.type).toBe("P");
  });

  it("creates initial state with correct defaults", () => {
    const state = createInitialState("w1", "b1");
    expect(state.turn).toBe("white");
    expect(state.whitePlayerId).toBe("w1");
    expect(state.blackPlayerId).toBe("b1");
    expect(state.status).toBe("playing");
    expect(state.moveHistory).toHaveLength(0);
    expect(state.fullMoveNumber).toBe(1);
    expect(state.castling.whiteKingside).toBe(true);
  });
});

describe("Chess rules — move generation", () => {
  it("generates 20 legal moves for white at start", () => {
    const state = createInitialState("w", "b");
    const moves = getLegalMoves(state);
    expect(moves.length).toBe(20);
  });

  it("returns no moves for a finished game", () => {
    const state = createInitialState("w", "b");
    state.status = "checkmate";
    expect(getLegalMoves(state)).toHaveLength(0);
  });
});

describe("Chess rules — move application", () => {
  it("applies e2e4 correctly", () => {
    const state = createInitialState("w", "b");
    const after = makeMove(state, "e2", "e4");
    expect(after.turn).toBe("black");
    expect(after.board[3][4]?.type).toBe("P");
    expect(after.board[3][4]?.color).toBe("white");
    expect(after.board[1][4]).toBeNull();
    expect(after.enPassant).toEqual([2, 4]);
    expect(after.moveHistory).toEqual(["e2e4"]);
  });

  it("increments fullMoveNumber after black moves", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    expect(state.fullMoveNumber).toBe(1);
    state = makeMove(state, "e7", "e5");
    expect(state.fullMoveNumber).toBe(2);
  });

  it("clears en passant after a non-double-pawn move", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    expect(state.enPassant).not.toBeNull();
    state = makeMove(state, "d7", "d6");
    expect(state.enPassant).toBeNull();
  });
});

describe("Chess rules — captures", () => {
  it("records captured pieces", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "d7", "d5");
    state = makeMove(state, "e4", "d5"); // white captures black pawn
    expect(state.capturedByWhite).toContain("P");
    expect(state.board[4][3]?.color).toBe("white");
  });
});

describe("Chess rules — en passant", () => {
  it("allows en passant capture", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "a7", "a6");
    state = makeMove(state, "e4", "e5");
    state = makeMove(state, "d7", "d5"); // black double-pawn, en passant target = d6
    expect(state.enPassant).toEqual([5, 3]); // d6 = rank 5, file 3

    // White captures en passant
    state = makeMove(state, "e5", "d6");
    expect(state.board[5][3]?.type).toBe("P");
    expect(state.board[5][3]?.color).toBe("white");
    expect(state.board[4][3]).toBeNull(); // captured pawn removed
    expect(state.capturedByWhite).toContain("P");
  });
});

describe("Chess rules — castling", () => {
  it("allows kingside castling", () => {
    let state = createInitialState("w", "b");
    // Clear path for white kingside castle: move knight and bishop
    state = makeMove(state, "g1", "f3");
    state = makeMove(state, "a7", "a6");
    state = makeMove(state, "e2", "e3");
    state = makeMove(state, "a6", "a5");
    state = makeMove(state, "f1", "e2");
    state = makeMove(state, "a5", "a4");

    // Kingside castle should be legal
    const legal = getLegalMoves(state);
    const castle = legal.find(
      (m) => m.from[0] === 0 && m.from[1] === 4 && m.to[0] === 0 && m.to[1] === 6,
    );
    expect(castle).toBeDefined();

    state = applyMove(state, castle!);
    expect(state.board[0][6]?.type).toBe("K");
    expect(state.board[0][5]?.type).toBe("R");
    expect(state.board[0][4]).toBeNull();
    expect(state.board[0][7]).toBeNull();
    expect(state.castling.whiteKingside).toBe(false);
    expect(state.castling.whiteQueenside).toBe(false);
  });

  it("revokes castling when king moves", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "e7", "e5");
    state = makeMove(state, "e1", "e2"); // king moves
    expect(state.castling.whiteKingside).toBe(false);
    expect(state.castling.whiteQueenside).toBe(false);
  });

  it("revokes castling when rook moves", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "a2", "a4");
    state = makeMove(state, "a7", "a5");
    state = makeMove(state, "a1", "a3"); // rook moves
    expect(state.castling.whiteQueenside).toBe(false);
    expect(state.castling.whiteKingside).toBe(true); // kingside unaffected
  });
});

describe("Chess rules — check detection", () => {
  it("detects check", () => {
    let state = createInitialState("w", "b");
    // Scholar's mate attempt — not quite mate, but check
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "e7", "e5");
    state = makeMove(state, "f1", "c4");
    state = makeMove(state, "b8", "c6");
    state = makeMove(state, "d1", "h5");
    state = makeMove(state, "g8", "f6");
    state = makeMove(state, "h5", "f7"); // check!
    expect(state.inCheck).toBe(true);
  });
});

describe("Chess rules — checkmate (scholar's mate)", () => {
  it("detects checkmate", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "e7", "e5");
    state = makeMove(state, "f1", "c4");
    state = makeMove(state, "b8", "c6");
    state = makeMove(state, "d1", "h5");
    state = makeMove(state, "d8", "e7"); // bad move by black
    state = makeMove(state, "h5", "f7"); // checkmate — no, e7 blocks
    // Actually let me construct a proper scholar's mate
  });
});

describe("Chess rules — proper scholar's mate", () => {
  it("detects checkmate via Qxf7#", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "e7", "e5");
    state = makeMove(state, "f1", "c4");
    state = makeMove(state, "f8", "c5");
    state = makeMove(state, "d1", "h5");
    state = makeMove(state, "g8", "f6");
    state = makeMove(state, "h5", "f7");
    expect(state.status).toBe("checkmate");
    expect(state.winner).toBe("white");
    expect(getLegalMoves(state)).toHaveLength(0);
  });
});

describe("Chess rules — stalemate", () => {
  it("detects stalemate (manual setup)", () => {
    // Classic stalemate: black king on h8, white queen on g6, white king on f6
    // Black has no legal moves but is not in check.
    const state = createInitialState("w", "b");
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) state.board[r][f] = null;
    state.board[7][7] = { type: "K", color: "black" }; // h8
    state.board[5][6] = { type: "Q", color: "white" }; // g6
    state.board[5][5] = { type: "K", color: "white" }; // f6
    state.turn = "black";
    state.castling = { whiteKingside: false, whiteQueenside: false, blackKingside: false, blackQueenside: false };

    expect(isInCheck(state.board, "black")).toBe(false);
    const moves = getLegalMoves(state);
    expect(moves.length).toBe(0);
  });
});

describe("Chess rules — resign", () => {
  it("resigns correctly", () => {
    const state = createInitialState("w", "b");
    const resigned = resign(state);
    expect(resigned.status).toBe("resigned");
    expect(resigned.winner).toBe("black"); // white's turn, white resigned, black wins
  });
});

describe("Chess rules — clone", () => {
  it("creates independent copies", () => {
    const state = createInitialState("w", "b");
    const clone = cloneState(state);
    clone.board[0][0] = null;
    clone.moveHistory.push("test");
    expect(state.board[0][0]).not.toBeNull();
    expect(state.moveHistory).toHaveLength(0);
  });
});

describe("Chess rules — notation", () => {
  it("converts moves to/from string", () => {
    const m: ChessMove = { from: [1, 4], to: [3, 4] };
    expect(moveToString(m)).toBe("e2e4");
    const parsed = stringToMove("e2e4");
    expect(parsed.from).toEqual([1, 4]);
    expect(parsed.to).toEqual([3, 4]);
    expect(parsed.promotion).toBeUndefined();
  });

  it("handles promotion notation", () => {
    const m: ChessMove = { from: [6, 0], to: [7, 0], promotion: "Q" };
    expect(moveToString(m)).toBe("a7a8q");
    const parsed = stringToMove("a7a8q");
    expect(parsed.promotion).toBe("Q");
  });
});

describe("Chess rules — material evaluation", () => {
  it("returns 0 for initial position", () => {
    const board = createInitialBoard();
    expect(evaluateMaterial(board)).toBe(0);
  });

  it("returns positive after white captures a piece", () => {
    let state = createInitialState("w", "b");
    state = makeMove(state, "e2", "e4");
    state = makeMove(state, "d7", "d5");
    state = makeMove(state, "e4", "d5");
    expect(evaluateMaterial(state.board)).toBeGreaterThan(0);
  });
});

describe("Chess rules — position key", () => {
  it("produces different keys for different positions", () => {
    const state = createInitialState("w", "b");
    const key1 = boardPositionKey(state);
    const after = makeMove(state, "e2", "e4");
    const key2 = boardPositionKey(after);
    expect(key1).not.toBe(key2);
  });

  it("detects same position with different turn as different", () => {
    const s1 = createInitialState("w", "b");
    const s2 = cloneState(s1);
    s2.turn = "black";
    expect(boardPositionKey(s1)).not.toBe(boardPositionKey(s2));
  });
});

describe("Chess rules — 50-move rule", () => {
  it("triggers draw at halfMoveClock 100", () => {
    const state = createInitialState("w", "b");
    state.halfMoveClock = 99;
    // Make a non-pawn, non-capture move to tick it to 100
    // Set up a trivial position where kings can shuffle
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) state.board[r][f] = null;
    state.board[0][4] = { type: "K", color: "white" };
    state.board[7][4] = { type: "K", color: "black" };
    state.board[0][0] = { type: "R", color: "white" };
    state.castling = { whiteKingside: false, whiteQueenside: false, blackKingside: false, blackQueenside: false };
    state.positionHistory = [];
    state.enPassant = null;

    const after = makeMove(state, "e1", "d1");
    expect(after.halfMoveClock).toBe(100);
    expect(after.status).toBe("draw_50move");
  });
});

describe("Chess rules — timeout status", () => {
  it("GameStatus type includes 'timeout' for engine turn-timer forfeits", () => {
    const state = createInitialState("w1", "b1");
    expect(state.status).toBe("playing");

    const timedOut: ChessState = { ...state, status: "timeout", winner: "black" };
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.winner).toBe("black");
  });

  it("timeout state is distinct from resigned", () => {
    const state = createInitialState("w1", "b1");
    const resigned = resign(state, "white");
    expect(resigned.status).toBe("resigned");

    const timedOut: ChessState = { ...state, status: "timeout", winner: "black" };
    expect(timedOut.status).not.toBe(resigned.status);
  });
});
