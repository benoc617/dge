export const GINRUMMY_HELP_TITLE = "Gin Rummy — How to Play";

export const GINRUMMY_HELP_CONTENT = `
# Gin Rummy

## Objective
Form melds from your 10-card hand and minimize "deadwood" (unmelded cards). Knock when your deadwood is 10 or less, or go for **Gin** with 0 deadwood.

## Your Turn
1. **Draw** one card — either the top of the stock pile (face down) or the top of the discard pile (face up).
2. **Discard** one card face up onto the discard pile.
   - Instead of just discarding, you may **Knock** or go for **Gin** (see below).

## Melds
- **Set** — 3 or 4 cards of the same rank (e.g. 7♠ 7♥ 7♦).
- **Run** — 3 or more cards of the same suit in sequential rank (e.g. 4♣ 5♣ 6♣). Ace is always low (A-2-3).

## Card Values (for deadwood)
- Ace = 1 · Number cards = face value · Jack/Queen/King = 10

## Knocking
When your unmelded deadwood totals **10 or less**, you may knock after discarding.
- Your opponent then lays off any cards that extend your melds.
- **Undercut**: if the defender's remaining deadwood ≤ your deadwood, they win the hand and get the difference + 25 bonus points.

## Gin
When you have **0 deadwood**, declare Gin (instead of just knocking).
- Your opponent may **not** lay off cards.
- Gin bonus: **25 points** + opponent's full deadwood.

## Scoring
- Knock win: opponent's deadwood − your deadwood.
- Gin: 25 + opponent's deadwood.
- Undercut: knocker's deadwood − defender's deadwood + 25 (to defender).
- **Single-hand mode**: highest score after one hand wins.
- **Match mode**: first to reach the target score (e.g. 100) wins. When the match ends, the winner gets a 100-point game bonus + 25 per hand won + 100 shutout bonus if opponent never won a hand.

## Stock Exhaustion
If the stock pile is emptied, the hand is a draw — no points are scored.

## Timer
Each player has a turn timer. If it runs out, your turn is forfeited (treated as a discard of the worst card).

## Controls
- Click a card in your hand to **select** it for discard.
- Use the **Draw Stock** / **Take Discard** buttons to draw.
- Use **Knock** or **Gin** buttons when available (green = eligible).
- During your opponent's knock, click cards in your hand to lay them off on their melds, then click **Done**.
`.trim();

export const HELP_REGISTRY: Record<string, { title: string; content: string }> = {
  ginrummy: { title: GINRUMMY_HELP_TITLE, content: GINRUMMY_HELP_CONTENT },
};
