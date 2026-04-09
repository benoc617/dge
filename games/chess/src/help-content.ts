export const CHESS_HELP_TITLE = "Chess";

export const CHESS_HELP_CONTENT = `
# Chess

Standard chess against an AI (MCTS) or a human opponent.

## How to Play

- **Click a piece** to select it. Legal destination squares will highlight.
- **Click a highlighted square** to complete the move.
- Click another of your pieces to switch selection.
- **Pawn promotion**: when a pawn reaches the back rank, choose a piece (Q/R/B/N).

## Opponent Modes

- **AI (MCTS)**: game starts immediately; AI uses Monte Carlo Tree Search (~3s per move).
- **Human (invite)**: share the invite code and wait for an opponent to join.

## Turn Timer

Each player has a configurable time limit per move (default **12 hours**). If you don't move in time, you **lose on time** — the opponent wins. The timer countdown is shown in the header bar.

## Rules

Standard FIDE chess rules apply:
- Castling, en passant, pawn promotion.
- Fifty-move draw rule.
- Threefold repetition draw.
- Insufficient material draw (K vs K, K+B vs K, K+N vs K, same-color bishops).

## Controls

- **Resign**: Click the Resign button to concede the game.
- Captured pieces are shown in the left panel.
- Move history is in the right panel.
- Check and checkmate are automatically detected.
`;

export const HELP_REGISTRY: Record<string, { title: string; content: string }> = {
  chess: { title: CHESS_HELP_TITLE, content: CHESS_HELP_CONTENT },
};
