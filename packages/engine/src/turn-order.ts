/**
 * @dge/engine — Sequential turn management.
 *
 * Game-agnostic: uses shared DB schema fields on GameSession and Player.
 *
 * Game-specific hooks (runTick / processEndTurn / getActivePlayers) are
 * injected via TurnOrderHooks so this module has no dependency on any
 * game implementation.
 */

import { getDb } from "./db-context";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TurnOrderInfo {
  currentPlayerId: string;
  currentPlayerName: string;
  isAI: boolean;
  turnStartedAt: string;
  turnDeadline: string;
  order: { name: string; isAI: boolean; turnOrder: number; isCurrent: boolean }[];
}

type ActivePlayer = { id: string; name: string; isAI: boolean; turnOrder: number };

// ---------------------------------------------------------------------------
// Hooks (game-specific callbacks injected by the SRX layer)
// ---------------------------------------------------------------------------

/**
 * Callbacks that getCurrentTurn needs to auto-skip a timed-out player.
 * These are game-specific; inject them via registerGame hooks.
 */
export interface TurnOrderHooks {
  /** Run the economy/state tick for the timed-out player and persist it. */
  runTick(playerId: string): Promise<void>;
  /** Process an end_turn action for the timed-out player. */
  processEndTurn(playerId: string): Promise<void>;
  /**
   * Return the list of players who still have game turns remaining in this
   * session. When omitted the engine returns ALL players in the session
   * (game-agnostic default: treats every player as active until the session
   * itself is marked complete).
   *
   * Override this for games where individual players can be eliminated
   * mid-session (e.g. SRX: filter by empire.turnsLeft > 0).
   */
  getActivePlayers?(
    sessionId: string,
  ): Promise<{ id: string; name: string; isAI: boolean; turnOrder: number }[]>;
}

// ---------------------------------------------------------------------------
// Pure utilities (no hooks, no DB)
// ---------------------------------------------------------------------------

/**
 * True when the session cannot have an active turn: admin lobby (`waitingForHuman`)
 * or timer not started (`turnStartedAt` null). Exported for unit tests.
 */
export function sessionCannotHaveActiveTurn(session: {
  waitingForHuman: boolean;
  turnStartedAt: Date | null;
}): boolean {
  return session.waitingForHuman || session.turnStartedAt == null;
}

/**
 * Find the next player after the given one in turn order (wraps around).
 */
function nextPlayer(players: ActivePlayer[], currentId: string): ActivePlayer {
  const idx = players.findIndex((p) => p.id === currentId);
  return players[(idx + 1) % players.length];
}

/**
 * Resolve who the current turn player actually is.
 * If currentTurnPlayerId is null or points to an eliminated player,
 * falls back to the first player in turnOrder.
 */
function resolveCurrentPlayer(players: ActivePlayer[], storedId: string | null): ActivePlayer {
  if (storedId) {
    const found = players.find((p) => p.id === storedId);
    if (found) return found;
  }
  return players[0];
}

function buildInfo(
  current: ActivePlayer,
  players: ActivePlayer[],
  turnStartedAt: Date,
  turnTimeoutSecs: number,
): TurnOrderInfo {
  const deadline = new Date(turnStartedAt.getTime() + turnTimeoutSecs * 1000);
  return {
    currentPlayerId: current.id,
    currentPlayerName: current.name,
    isAI: current.isAI,
    turnStartedAt: turnStartedAt.toISOString(),
    turnDeadline: deadline.toISOString(),
    order: players.map((p) => ({
      name: p.name,
      isAI: p.isAI,
      turnOrder: p.turnOrder,
      isCurrent: p.id === current.id,
    })),
  };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getActivePlayers(
  gameSessionId: string,
  hooks?: TurnOrderHooks,
): Promise<ActivePlayer[]> {
  if (hooks?.getActivePlayers) {
    return hooks.getActivePlayers(gameSessionId);
  }
  // Default: all players in the session — game-agnostic (no game-state filter).
  // Games where players can be individually eliminated should supply getActivePlayers.
  return getDb().player.findMany({
    where: { gameSessionId },
    orderBy: { turnOrder: "asc" },
    select: { id: true, name: true, isAI: true, turnOrder: true },
  });
}

// ---------------------------------------------------------------------------
// Core turn-order functions
// ---------------------------------------------------------------------------

/**
 * Get the player whose turn it is right now in a session.
 * If the current player has timed out, auto-skip them first (via hooks).
 */
export async function getCurrentTurn(
  gameSessionId: string,
  hooks: TurnOrderHooks,
): Promise<TurnOrderInfo | null> {
  for (let guard = 0; guard < 20; guard++) {
    const session = await getDb().gameSession.findUnique({
      where: { id: gameSessionId },
      select: {
        currentTurnPlayerId: true,
        turnStartedAt: true,
        turnTimeoutSecs: true,
        waitingForHuman: true,
      },
    });
    if (!session) return null;

    if (sessionCannotHaveActiveTurn(session)) return null;
    const turnStartedAt = session.turnStartedAt!;

    const players = await getActivePlayers(gameSessionId, hooks);
    if (players.length === 0) return null;

    const current = resolveCurrentPlayer(players, session.currentTurnPlayerId);

    // Sync currentTurnPlayerId if it was null or stale
    if (session.currentTurnPlayerId !== current.id) {
      await getDb().gameSession.update({
        where: { id: gameSessionId },
        data: { currentTurnPlayerId: current.id },
      });
    }

    const deadline = new Date(turnStartedAt.getTime() + session.turnTimeoutSecs * 1000);

    // Auto-skip timed-out human players
    if (!current.isAI && new Date() > deadline) {
      await hooks.runTick(current.id);
      await hooks.processEndTurn(current.id);
      const next = nextPlayer(players, current.id);
      await getDb().gameSession.update({
        where: { id: gameSessionId },
        data: { currentTurnPlayerId: next.id, turnStartedAt: new Date() },
      });
      continue;
    }

    return buildInfo(current, players, turnStartedAt, session.turnTimeoutSecs);
  }

  return null;
}

/**
 * Advance to the next player in turn order. Resets the turn timer.
 * Pass the same TurnOrderHooks used for getCurrentTurn so the active-player
 * list is consistent (e.g. SRX filters by empire.turnsLeft via the hook).
 */
export async function advanceTurn(
  gameSessionId: string,
  hooks?: TurnOrderHooks,
): Promise<TurnOrderInfo | null> {
  const session = await getDb().gameSession.findUnique({
    where: { id: gameSessionId },
    select: { currentTurnPlayerId: true, turnTimeoutSecs: true, waitingForHuman: true },
  });
  if (!session || session.waitingForHuman) return null;

  const players = await getActivePlayers(gameSessionId, hooks);
  if (players.length === 0) return null;

  const current = resolveCurrentPlayer(players, session.currentTurnPlayerId);
  const next = nextPlayer(players, current.id);
  const now = new Date();

  await getDb().gameSession.update({
    where: { id: gameSessionId },
    data: { currentTurnPlayerId: next.id, turnStartedAt: now },
  });

  return buildInfo(next, players, now, session.turnTimeoutSecs);
}
