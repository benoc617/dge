# Gin Rummy — Technical Game Specification

## Overview

Gin Rummy is the third DGE game. It is a 2-player card game where players form
melds from their 10-card hand and minimize deadwood. A player may knock when
their unmelded deadwood totals 10 or less; declaring Gin means 0 deadwood.

Game state is stored entirely in `GameSession.log` as JSON (`GinRummyState`).
No additional Prisma models are required. The AI uses MCTS with information set
sampling (determinization).

---

## Game Rules

### Deck
Standard 52-card deck. Ace is always low (value 1). J/Q/K = 10. 2–10 = face value.

### Deal
10 cards to each player. Remaining 32 cards: top card flipped to start the
discard pile; remaining 31 cards form the stock pile.

### Turn Phases
1. **Draw** — take the top card from the stock pile (face-down) or the discard
   pile (face-up). After drawing, the player has 11 cards.
2. **Discard** — place one card face-up on the discard pile. Instead of just
   discarding, the player may **knock** or declare **gin**.

### Melds
- **Set** — 3 or 4 cards of the same rank (different suits).
- **Run** — 3 or more cards of the same suit in sequential rank (A-2-3 through
  J-Q-K). Ace is always low; K-A-2 wraps are not allowed.

### Knocking
When a player's unmelded **deadwood** (sum of card values outside melds) is
**≤ 10** after selecting a discard card, they may knock:
1. Knocker declares their meld arrangement; server auto-computes the optimal
   arrangement if none is supplied.
2. Defender **lays off** any cards that extend the knocker's melds (unless the
   knocker went gin — no layoff in that case).
3. Hands are scored.

### Gin
When a player has **0 deadwood** in their remaining 10 cards, they may declare
gin. No layoff is allowed. Gin bonus: 25 points.

### Undercut
If the defender's deadwood after layoff is ≤ the knocker's deadwood, the
defender wins. Undercut bonus: 25 points (added to the difference).

### Scoring
| Outcome | Formula |
|---------|---------|
| Knock win | defender DW − knocker DW |
| Gin | 25 + defender DW |
| Undercut | knocker DW − defender DW + 25 (to defender) |

**Match mode:** first player to reach the target score wins.
At match end:
- Game bonus: +100 to winner
- Line bonus: +25 per hand won
- Shutout bonus: +100 if opponent never won a hand

### Stock Exhaustion
If the stock pile is empty when a player needs to draw from it, the hand is
declared a **draw** (no points scored). The match continues in match mode.

### Turn Timer
Each player has a configurable per-turn timer (default 12 hours). If a player
times out, `processEndTurn` is called which sets `status: "timeout"` and awards
the win to the opponent. The game session is marked `complete`.

---

## State Schema (`GinRummyState`)

```typescript
interface GinRummyState {
  deck: Card[];              // stock pile (server-only — not exposed to client)
  discardPile: Card[];       // discard pile; top card is visible to all
  players: [PlayerHand, PlayerHand]; // index 0 = creator (white)
  playerIds: [string, string];       // DB player IDs

  currentPlayer: 0 | 1;     // whose turn it is
  phase: "draw" | "discard" | "layoff" | "hand_over" | "match_over";
  
  knockerMelds: Meld[] | null;  // set during layoff phase
  knockerIdx: (0 | 1) | null;

  handResult: HandResult | null;

  matchTarget: number | null;   // null = single hand
  scores: [number, number];
  handsWon: [number, number];
  handNumber: number;

  status: "playing" | "hand_complete" | "match_complete" | "resigned" | "timeout" | "draw";
  winner: (0 | 1) | null;
}
```

Card keys use `{rank}{suit}` format: e.g., `AH`, `10D`, `KS`.

---

## Action Types

| Action | Phase | Params | Description |
|--------|-------|--------|-------------|
| `draw_stock` | draw | — | Draw top card from stock pile |
| `draw_discard` | draw | — | Take top card from discard pile |
| `discard` | discard | `{ card: "AH" }` | Discard a card from hand |
| `knock` | discard | `{ card: "AH", melds?: [[...]] }` | Declare knock (server auto-computes melds if not provided) |
| `gin` | discard | `{ card: "AH" }` | Declare gin (0 deadwood) |
| `layoff` | layoff | `{ layoffs: [{card, meldIndex}] }` | Lay off cards on knocker's melds |
| `pass_layoff` | layoff | — | Decline to lay off |
| `next_hand` | hand_over | — | Start next hand (match mode) |
| `resign` | any | — | Forfeit the game |

---

## API

### `POST /api/game/register`
Additional options for Gin Rummy:
- `opponentMode`: `"ai"` (default) or `"human"` (invite-based)
- `matchTarget`: `"0"` (single hand), `"100"`, `"200"`, `"300"`
- `turnTimeoutSecs`: override the 12h default

### `GET /api/game/status?id=<playerId>`
Returns the full Gin Rummy status payload. The opponent's card values are
hidden (only count is exposed).

Key fields:
```json
{
  "phase": "draw",
  "isYourTurn": true,
  "myPlayerIdx": 0,
  "myCards": ["AH", "2H", "..."],
  "myMelds": [["AH", "2H", "3H"]],
  "myDeadwood": ["KS"],
  "myDeadwoodValue": 10,
  "opponentCardCount": 10,
  "discardTop": "7D",
  "stockCount": 25,
  "legalActions": [{ "action": "draw_stock", "params": {}, "label": "..." }],
  "scores": [0, 0],
  "handResult": null,
  "knockerMelds": null,
  "isLayoffPhase": false,
  "layoffOptions": [],
  "turnDeadline": "2024-01-01T12:00:00.000Z"
}
```

### `POST /api/game/action`
Accepts `playerId` (preferred) or `playerName` with action and params.

---

## Turn Management

Gin Rummy manages `GameSession.currentTurnPlayerId` via the
`TurnOrderHooks.getActivePlayers` hook. The hook reads `GinRummyState.currentPlayer`
from `GameSession.log` and returns only that single player. This makes
`advanceTurn` always land on the correct player:

- After `draw_stock` / `draw_discard`: `currentPlayer` unchanged → `advanceTurn`
  keeps the same player (1-element array wraps to itself).
- After `discard` / `knock` / `gin`: `currentPlayer` changes to opponent →
  `advanceTurn` switches to the opponent.
- After `layoff` / `pass_layoff`: `currentPlayer` set based on hand result → engine
  advances accordingly.

---

## AI (MCTS + Determinization)

Gin Rummy is an imperfect information game. The AI uses **information set
sampling** (determinization):

1. Run **N = 6** independent determinizations.
2. In each: randomly assign the opponent's hidden cards and stock order from
   the set of cards not visible to the AI (own hand + discard pile).
3. Run `mctsSearchAsync` (300 iterations, 2.5s budget / 6 = ~416ms each) on the
   determinized state.
4. **Vote** across all N runs; the most-voted action is executed.

### MCTS Compound Moves
For MCTS internal purposes, a "move" in draw phase is a compound
`draw_source + discard_choice` action (a full player turn). This ensures the
MCTS player rotation (`nextPlayerIdx = (current + 1) % 2`) is always correct.
The `runAiSequence` executes each step as a separate API action.

### Heuristic Overrides
- **Layoff phase**: immediately lay off all possible cards (heuristic).
- **Match hand_over**: immediately trigger next hand (heuristic).

---

## Files

| File | Role |
|------|------|
| `games/ginrummy/src/types.ts` | Core types: `Card`, `GinRummyState`, `HandResult`, etc. |
| `games/ginrummy/src/melds.ts` | Pure meld detection, deadwood calculation, layoff finding |
| `games/ginrummy/src/rules.ts` | Game lifecycle: deal, draw, discard, knock, gin, scoring |
| `games/ginrummy/src/definition.ts` | `GameDefinition`, MCTS search functions, determinization |
| `games/ginrummy/src/help-content.ts` | In-game help text |
| `games/ginrummy/src/index.ts` | Package barrel export |
| `src/lib/ginrummy-registration.ts` | Engine registration, `getActivePlayers` hook |
| `src/lib/ginrummy-http-adapter.ts` | `GameHttpAdapter`: status, session setup, player join |
| `src/components/GinRummyGameScreen.tsx` | React UI: card table, hand rendering, actions |

---

## Tests

### Unit Tests
- `tests/unit/ginrummy-melds.test.ts` — meld detection, deadwood, layoff options
- `tests/unit/ginrummy-rules.test.ts` — game lifecycle: deal, draw, knock, gin, undercut, resign
- `tests/unit/ginrummy-mcts.test.ts` — MCTS, eval, search functions, AI move generation

### E2E Tests
- `tests/e2e/ginrummy.test.ts` — registration, status, draw/discard, AI polling, resign, human vs human
