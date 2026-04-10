# Gin Rummy

Classic 2-player card game for the Door Game Engine. Form melds (sets and runs),
minimize deadwood, and knock when you're ready — or go for gin with a perfect hand.

## How to Play

### Creating a Game
In the lobby, choose **Gin Rummy** and configure:
- **Opponent** — Play against the MCTS AI or invite a human via invite code.
- **Scoring** — Single hand (highest score wins), or Match to 100/200/300.
- **Turn Timer** — Per-turn time limit (default 12 hours).

### Your Turn
1. **Draw** a card from the stock pile (face-down) or the discard pile (face-up).
2. **Discard** one card, or declare **Knock** / **Gin** if your hand is ready.

### Winning
- **Gin** — 0 deadwood (all cards in melds). Bonus 25 points + opponent's full deadwood.
- **Knock** — Deadwood ≤ 10. Opponent may lay off cards. You score the difference.
- **Undercut** — If opponent's deadwood ≤ yours after layoff, they win with a 25-point bonus.

## Features
- Full standard Gin Rummy rules with correct Ace-low handling
- Server-side optimal meld arrangement (auto-computed when you knock/gin)
- MCTS AI with information set sampling — AI reasons about hidden cards
- Match-to-N scoring with game, line, and shutout bonuses
- Human vs human with invite code support
- 12-hour per-turn timer with automatic forfeit on timeout
- Live deadwood counter in the left panel

## Technical
See [docs/GAME-SPEC.md](docs/GAME-SPEC.md) for the complete technical specification.
