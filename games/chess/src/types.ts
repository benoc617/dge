export type Color = "white" | "black";
export type PieceType = "K" | "Q" | "R" | "B" | "N" | "P";

export interface Piece {
  type: PieceType;
  color: Color;
}

export type Board = (Piece | null)[][];

export interface ChessMove {
  from: [number, number]; // [rank, file] 0-indexed
  to: [number, number];
  promotion?: PieceType;
}

export interface CastlingRights {
  whiteKingside: boolean;
  whiteQueenside: boolean;
  blackKingside: boolean;
  blackQueenside: boolean;
}

export type GameStatus =
  | "playing"
  | "checkmate"
  | "stalemate"
  | "draw_50move"
  | "draw_repetition"
  | "draw_insufficient"
  | "resigned"
  | "timeout";

export interface ChessState {
  board: Board;
  turn: Color;
  castling: CastlingRights;
  enPassant: [number, number] | null;
  halfMoveClock: number;
  fullMoveNumber: number;
  status: GameStatus;
  winner: Color | null;
  whitePlayerId: string;
  blackPlayerId: string;
  moveHistory: string[];
  capturedByWhite: PieceType[];
  capturedByBlack: PieceType[];
  positionHistory: string[];
  inCheck: boolean;
}
