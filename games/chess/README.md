# Chess

Standard chess on the [Door Game Engine (DGE)](../../README.md). Play against an MCTS AI or invite a human opponent.

## The Game

Full FIDE-standard chess with castling, en passant, pawn promotion, check/checkmate, stalemate, 50-move draw, threefold repetition, and insufficient material draw. The AI uses Monte Carlo Tree Search (3-second time budget) — no external API calls.

## Documentation

| Document | Description |
|----------|-------------|
| [docs/GAME-SPEC.md](docs/GAME-SPEC.md) | Complete technical specification — state model, rules, AI, API, UI |

## How to Play

1. From the lobby, select **Chess** and create a game
2. Choose opponent mode: **AI (MCTS)** or **Human (invite)**
3. Set turn timer (default 12 hours per move)
4. For AI games: play starts immediately — you are white
5. For human games: share the invite code and wait for your opponent
6. **Click a piece** to select it — legal destination squares highlight in green
7. **Click a highlighted square** to complete the move
8. Against AI: responses arrive in ~3 seconds via MCTS
9. **Resign** at any time using the Resign button

## Features

- Interactive graphical board with solid white/black Unicode chess pieces
- Point-and-click move selection with legal move highlighting
- Pawn promotion dialog (Queen, Rook, Bishop, Knight)
- Captured pieces panel (left), move history panel (right)
- Turn timer with countdown (loss on time if exceeded)
- Optimistic UI — moves apply instantly before server confirmation
- Human vs Human support with invite codes
- Lobby waiting state for invite-based games
- Check/checkmate/stalemate/draw/timeout detection
- Game state persisted in `GameSession.log` (no additional DB tables)

## Source Layout

```
games/chess/
  src/
    types.ts            # ChessState, Board, Piece, ChessMove, GameStatus
    rules.ts            # Pure chess rules engine
    definition.ts       # GameDefinition<ChessState> + MCTS AI
    help-content.ts     # In-game help text
    index.ts            # Barrel export
  docs/
    GAME-SPEC.md        # Technical specification
  package.json          # @dge/chess workspace package
```
