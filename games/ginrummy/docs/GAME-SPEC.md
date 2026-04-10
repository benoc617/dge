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

  aiDifficulty?: "easy" | "medium" | "hard"; // chosen at session creation; default "medium"
  observedPickups?: [string[], string[]];      // cards each player has picked from discard (for AI inference)
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
- `aiDifficulty`: `"easy"` | `"medium"` (default) | `"hard"` — see AI difficulty section below
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
   the set of cards not visible to the AI (own hand + discard pile, plus observed pickups).
3. Run `mctsSearchAsync` per the difficulty tier's budget on the determinized state.
4. **Vote** across all N runs; the most-voted action is executed.

### AI Difficulty

Three difficulty tiers are available, selected at session creation via the `aiDifficulty` option (default `medium`). The tier is stored in `GinRummyState.aiDifficulty` and applied every time `getGinRummyAIMove` is called.

| Tier | Label | Budget (`timeLimitMs`) | `iterations` | `trackDiscards` | `inferOpponentMelds` |
|------|-------|----------------------|--------------|-----------------|---------------------|
| `easy` | Casual | 300 ms | 100 | false | false |
| `medium` | Competitive | 700 ms | 200 | true | false |
| `hard` | Shark | 2 000 ms | 400 | true | true |

**Behavioral flags** (part of `GinAiBehavior`):

- **`trackDiscards`** — When `true`, cards the opponent picks from the discard pile are recorded in `GinRummyState.observedPickups`. Future determinizations bias the opponent's inferred hand to include those known cards, making the AI aware of what the opponent is collecting.
- **`inferOpponentMelds`** — When `true` (requires `trackDiscards`), observed pickups are preferentially kept in the determinized opponent hand, further improving the quality of information the AI reasons over. This is the strongest level — the AI effectively "watches" what you pick up.

The profile is exported as `GINRUMMY_DIFFICULTY_PROFILE` from `@dge/ginrummy`. The `GinAiBehavior` interface is also exported.

### MCTS Compound Moves
For MCTS internal purposes, a "move" in draw phase is a compound
`draw_source + discard_choice` action (a full player turn). This ensures the
MCTS player rotation (`nextPlayerIdx = (current + 1) % 2`) is always correct.
The `runAiSequence` executes each step as a separate API action.

### Heuristic Overrides
- **Layoff phase**: immediately lay off all possible cards (heuristic).
- **Match hand_over**: immediately trigger next hand (heuristic).

---

## Game Logging

Every gin rummy action is persisted to the `TurnLog` table (same as SRX). On hand/match completion, a `GameEvent` row is written summarising the result. When the game fully ends (single-hand `hand_complete`, `match_complete`, `resigned`, `timeout`), all `TurnLog` and `GameEvent` rows are dumped to stdout as `[ginrummy-gamelog]` JSON lines and then deleted from the DB (same pattern as SRX's `session-log-export`).

### TurnLog rows
Written for every successful action via `processFullAction` and `runAiSequence`.
```json
{
  "playerId": "...",
  "action": "draw_stock",
  "details": { "params": {}, "actionMsg": "Drew from stock.", "handNumber": 1, "phase": "draw" }
}
```

### GameEvent rows
| `type` | Written when |
|--------|-------------|
| `hand_complete` | A hand ends in a match (game continues after `next_hand`) |
| `hand_complete` | A single-hand game ends |
| `match_complete` | The match target score is reached |
| `game_resigned` | A player resigns |
| `game_timeout` | Turn timer expires |

### Stdout log format (`[ginrummy-gamelog]`)
```
[ginrummy-gamelog] {"type":"session_log_dump_start","sessionId":"...","turnLogCount":N,"gameEventCount":M}
[ginrummy-gamelog] {"type":"turn_log","sessionId":"...","playerId":"...","action":"draw_stock",...}
[ginrummy-gamelog] {"type":"game_event","sessionId":"...","type":"hand_complete","message":"..."}
[ginrummy-gamelog] {"type":"session_log_purge_complete","sessionId":"...","turnLogCount":N,"gameEventCount":M}
```

---

## UI Features

### Hand Management

The `GinRummyGameScreen` provides client-side hand management tools:

- **Sort by rank** (`RANK` button): orders cards A, 2–9, T, J, Q, K with suit as tiebreaker (C, D, H, S).
- **Sort by suit** (`SUIT` button): groups cards by suit (C, D, H, S) with rank as tiebreaker.
- **Drag to reorder**: each card in the flat hand view is `draggable`; drop onto another card to insert before it. A yellow left-edge highlight shows the drop target. Reordering sets the sort mode to "custom".
- Active sort mode is highlighted in yellow on the sort buttons.
- Ordering is client-only and never sent to the server; the server's `myCards` order is the source of truth for game logic.
- When a new card is drawn, it appends at the end of the local order. When a card is discarded, it is removed while preserving the relative order of remaining cards.

### Help

A `?` button in the header opens a `HelpModal` fetched from `GET /api/game/help?game=ginrummy`. Content is cached in component state after the first fetch.

Sort helpers (`ginRankIdx`, `ginSuitIdx`) are exported from `GinRummyGameScreen.tsx` for unit testing.

---

## Files

| File | Role |
|------|------|
| `games/ginrummy/src/types.ts` | Core types: `Card`, `GinRummyState`, `HandResult`, etc. |
| `games/ginrummy/src/melds.ts` | Pure meld detection, deadwood calculation, layoff finding |
| `games/ginrummy/src/rules.ts` | Game lifecycle: deal, draw, discard, knock, gin, scoring |
| `games/ginrummy/src/definition.ts` | `GameDefinition`, MCTS search functions, determinization, logging |
| `games/ginrummy/src/help-content.ts` | In-game help text |
| `games/ginrummy/src/index.ts` | Package barrel export |
| `src/lib/ginrummy-registration.ts` | Engine registration, `getActivePlayers` hook |
| `src/lib/ginrummy-http-adapter.ts` | `GameHttpAdapter`: status, session setup, player join |
| `src/components/GinRummyGameScreen.tsx` | React UI: card table, hand sort/drag/reorder, actions, help |

---

## Tests

### Unit Tests
- `tests/unit/ginrummy-melds.test.ts` — meld detection, deadwood, layoff options
- `tests/unit/ginrummy-rules.test.ts` — game lifecycle: deal, draw, knock, gin, undercut, resign
- `tests/unit/ginrummy-mcts.test.ts` — MCTS, eval, search functions, AI move generation
- `tests/unit/ginrummy-ui.test.ts` — `ginRankIdx`, `ginSuitIdx`, `sortHand` ordering

### E2E Tests
- `tests/e2e/ginrummy/ginrummy.test.ts` — registration, status, draw/discard, AI polling, TurnLog presence after actions, log purge after game over, resign, human vs human; help API (`GET /api/game/help?game=ginrummy` and `?game=chess`)
