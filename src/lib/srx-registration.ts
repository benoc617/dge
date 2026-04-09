/**
 * SRX game registration.
 *
 * Importing this module registers the SRX GameDefinition with the engine's
 * game registry, injecting the SRX-specific metadata, HTTP adapter,
 * turn-order hooks, and door-game hooks.
 *
 * Import this (or game-bootstrap.ts) once at the top of each API route
 * that needs to dispatch through the registry/orchestrator:
 *
 *   import "@/lib/game-bootstrap";
 *
 * Subsequent imports are a no-op (module is only evaluated once by Node).
 *
 * Circular-import note:
 *   registry → GameOrchestrator → (engine only)
 *   srxGameDefinition → @/lib/game-engine → @/lib/db-context → @dge/engine/db-context
 *   srxHttpAdapter → @/lib/prisma, @/lib/game-constants, @/lib/player-init, @/lib/turn-order
 *   None of the imports here create a cycle.
 */

import { registerGame } from "@dge/engine/registry";
import { srxGameDefinition } from "@dge/srx";
import {
  processAction,
  runAndPersistTick,
  runEndgameSettlementTick,
} from "@/lib/game-engine";
import { invalidatePlayer, invalidateLeaderboard } from "@/lib/game-state-service";
import { enqueueAiTurnsForSession } from "@/lib/ai-job-queue";
import { srxHttpAdapter } from "@/lib/srx-http-adapter";
import { dumpAndPurgeSessionLogsIfComplete } from "@/lib/session-log-export";
import { prisma } from "@/lib/prisma";
import { getDb } from "@/lib/db-context";
import type { GameMetadata } from "@dge/shared";
import { SESSION } from "@/lib/game-constants";

// ---------------------------------------------------------------------------
// SRX Metadata — drives the game-select card and create-game form
// ---------------------------------------------------------------------------

const srxMetadata: GameMetadata = {
  game: "srx",
  displayName: "Solar Realms Extreme",
  description: "A turn-based galactic empire management game. Build planets, recruit armies, and outwit rivals to dominate the galaxy.",
  playerRange: [1, SESSION.MAX_PLAYERS_CAP],
  supportsJoin: true,
  createOptions: [
    {
      key: "aiCount",
      label: "AI Opponents",
      description: "Number of AI empires to add after creating your galaxy",
      type: "number",
      default: 3,
      min: 0,
      max: 5,
    },
    {
      key: "turnMode",
      label: "Turn Mode",
      description: "Simultaneous lets all players take turns at the same time each day",
      type: "select",
      default: "simultaneous",
      options: [
        { value: "simultaneous", label: "Simultaneous (Door Game)" },
        { value: "sequential", label: "Sequential" },
      ],
    },
    {
      key: "maxPlayers",
      label: "Max Players",
      description: "Maximum number of commanders in the galaxy",
      type: "number",
      default: 50,
      min: SESSION.MIN_PLAYERS,
      max: SESSION.MAX_PLAYERS_CAP,
    },
    {
      key: "turnTimeoutSecs",
      label: "Turn Timer",
      description: "How long each player has to take their turn (or each round in simultaneous mode)",
      type: "select",
      default: 86400,
      options: [
        { value: "3600", label: "1 hour" },
        { value: "14400", label: "4 hours" },
        { value: "28800", label: "8 hours" },
        { value: "86400", label: "24 hours" },
        { value: "172800", label: "48 hours" },
        { value: "604800", label: "1 week" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// SRX registration
// ---------------------------------------------------------------------------

registerGame("srx", {
  definition: srxGameDefinition,
  metadata: srxMetadata,
  adapter: srxHttpAdapter,
  hooks: {
    /**
     * TurnOrderHooks — injected into engine's getCurrentTurn / advanceTurn.
     * getActivePlayers filters by empire.turnsLeft > 0 (SRX-specific).
     */
    turnOrder: {
      async runTick(playerId: string): Promise<void> {
        await runAndPersistTick(playerId);
      },
      async processEndTurn(playerId: string): Promise<void> {
        await processAction(playerId, "end_turn");
      },
      async getActivePlayers(sessionId: string) {
        return prisma.player.findMany({
          where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
          orderBy: { turnOrder: "asc" },
          select: { id: true, name: true, isAI: true, turnOrder: true },
        });
      },
    },

    /**
     * DoorGameHooks — injected into engine's openFullTurn / closeFullTurn /
     * tryRollRound for simultaneous (door-game) mode.
     * All empire-specific DB operations are delegated here.
     */
    doorGame: {
      async canPlayerAct(playerId: string, actionsPerDay: number) {
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { turnsLeft: true, fullTurnsUsedThisRound: true },
        });
        if (!emp) return false;
        return emp.turnsLeft > 0 && emp.fullTurnsUsedThisRound < actionsPerDay;
      },
      async isTurnOpen(playerId: string) {
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { turnOpen: true },
        });
        return emp?.turnOpen ?? false;
      },
      async isTickProcessed(playerId: string) {
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { tickProcessed: true },
        });
        return emp?.tickProcessed ?? false;
      },
      async hasTurnsRemaining(playerId: string) {
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { turnsLeft: true },
        });
        return (emp?.turnsLeft ?? 0) > 0;
      },
      async openTurnSlot(playerId: string) {
        await getDb().empire.update({ where: { playerId }, data: { turnOpen: true } });
      },
      async closeTurnSlot(playerId: string) {
        await getDb().empire.updateMany({
          where: { playerId, turnsLeft: { gt: 0 } },
          data: {
            turnOpen: false,
            tickProcessed: false,
            fullTurnsUsedThisRound: { increment: 1 },
            turnsLeft: { decrement: 1 },
          },
        });
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { turnsLeft: true },
        });
        return { remainingTurns: emp?.turnsLeft ?? 0 };
      },
      async forfeitSlots(playerId: string, slotsLeft: number) {
        const emp = await getDb().empire.findUnique({
          where: { playerId },
          select: { turnsLeft: true },
        });
        if (!emp) return { remainingTurns: 0 };
        const newTurnsLeft = Math.max(0, emp.turnsLeft - slotsLeft);
        await getDb().empire.update({
          where: { playerId },
          data: {
            fullTurnsUsedThisRound: { increment: slotsLeft },
            turnOpen: false,
            tickProcessed: false,
            turnsLeft: newTurnsLeft,
          },
        });
        return { remainingTurns: newTurnsLeft };
      },
      async resetDailySlots(sessionId: string) {
        await getDb().empire.updateMany({
          where: { player: { gameSessionId: sessionId } },
          data: { fullTurnsUsedThisRound: 0, tickProcessed: false, turnOpen: false },
        });
      },
      async getPlayerSlotUsage(sessionId: string) {
        const players = await getDb().player.findMany({
          where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
          include: { empire: { select: { fullTurnsUsedThisRound: true, turnsLeft: true } } },
        });
        return players.map((p) => ({
          id: p.id,
          slotsUsed: p.empire?.fullTurnsUsedThisRound ?? 0,
          hasRemainingTurns: (p.empire?.turnsLeft ?? 0) > 0,
        }));
      },
      async runTick(playerId: string) {
        return runAndPersistTick(playerId, { decrementTurnsLeft: false });
      },
      async runEndgameTick(playerId: string, sessionId: string): Promise<void> {
        await runEndgameSettlementTick(playerId);
        dumpAndPurgeSessionLogsIfComplete(sessionId);
      },
      async logSessionEvent(sessionId: string, payload: { type: string; message: string; details: Record<string, unknown> }) {
        await getDb().gameEvent.create({
          data: {
            gameSessionId: sessionId,
            type: payload.type,
            message: payload.message,
            details: payload.details as object,
          },
        });
      },
      invalidatePlayer(playerId: string): void {
        void invalidatePlayer(playerId);
      },
      invalidateLeaderboard(sessionId: string): void {
        void invalidateLeaderboard(sessionId);
      },
      onDayComplete(sessionId: string): void {
        void enqueueAiTurnsForSession(sessionId).catch((err) => {
          console.error("[srx-registration] enqueueAiTurnsForSession after day roll", sessionId, err);
        });
      },
    },
  },
});
