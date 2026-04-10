export type Suit = "H" | "D" | "C" | "S";
export type Rank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";

export interface Card {
  suit: Suit;
  rank: Rank;
}

export type Meld = Card[];

export interface MeldResult {
  melds: Meld[];
  deadwood: Card[];
  deadwoodValue: number;
}

export interface LayoffOption {
  card: Card;
  meldIndex: number;
  position: "before" | "after";
}

export interface PlayerHand {
  cards: Card[];
}

export type GamePhase = "draw" | "discard" | "layoff" | "hand_over" | "match_over";

export type GameStatus =
  | "playing"
  | "hand_complete"
  | "match_complete"
  | "resigned"
  | "timeout"
  | "draw";

export interface HandResult {
  knockerIdx: 0 | 1;
  isGin: boolean;
  isUndercut: boolean;
  knockerDeadwood: number;
  defenderDeadwood: number;
  defenderDeadwoodAfterLayoff: number;
  points: number;
  winner: 0 | 1;
  knockerMelds: Meld[];
  defenderMelds: Meld[];
  knockerDeadwoodCards: Card[];
  defenderDeadwoodCards: Card[];
}

export interface GinRummyState {
  deck: Card[];
  discardPile: Card[];
  players: [PlayerHand, PlayerHand];
  playerIds: [string, string];
  currentPlayer: 0 | 1;
  phase: GamePhase;

  // Set during layoff phase: knocker's meld arrangement
  knockerMelds: Meld[] | null;
  knockerIdx: (0 | 1) | null;

  handResult: HandResult | null;

  matchTarget: number | null; // null = single hand
  scores: [number, number];
  handsWon: [number, number];
  handNumber: number;

  status: GameStatus;
  winner: (0 | 1) | null;
}
