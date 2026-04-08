/**
 * Unit tests for @dge/engine GameOrchestrator.
 *
 * Scope:
 *   - Guard conditions (missing hooks, missing full-track methods)
 *   - Constructor and public surface (definition binding, orchestrator access)
 *   - Pure utility re-exports from engine (sessionCannotHaveActiveTurn, canPlayerAct)
 *
 * The full-track sequential and door-game action flows (processSequentialAction,
 * processDoorAction, processDoorTick) require a live DB and are covered by the
 * E2E test suite (game-flow.test.ts, multiplayer.test.ts, door-game.test.ts).
 *
 * The pure-track processAction / processTick paths are covered by the search
 * integration in search-opponent.test.ts which drives MCTS rollouts.
 */

import { describe, it, expect } from "vitest";
import { GameOrchestrator, sessionCannotHaveActiveTurn, canPlayerAct } from "@dge/engine";
import type { GameDefinition, ActionResult, Move, Rng } from "@dge/shared";
import type { TurnOrderHooks } from "@dge/engine";

// ---------------------------------------------------------------------------
// Minimal fake GameDefinition (pure-track only — no DB methods)
// ---------------------------------------------------------------------------

type FakeState = { n: number };

function makeDef(overrides: Partial<GameDefinition<FakeState>> = {}): GameDefinition<FakeState> {
  return {
    async loadState(): Promise<FakeState> { return { n: 0 }; },
    async saveState(): Promise<void> {},
    applyAction(state: FakeState, _pid: string, _action: string, _params: unknown, _rng: Rng): ActionResult<FakeState> {
      return { success: true, message: "ok", state };
    },
    evalState(): number { return 0; },
    generateCandidateMoves(): Move[] { return []; },
    ...overrides,
  };
}

const stubHooks: TurnOrderHooks = {
  async runTick() {},
  async processEndTurn() {},
};

// ---------------------------------------------------------------------------
// Constructor and public surface
// ---------------------------------------------------------------------------

describe("GameOrchestrator constructor", () => {
  it("stores the definition as a public property", () => {
    const def = makeDef();
    const orc = new GameOrchestrator(def);
    expect(orc.definition).toBe(def);
  });

  it("constructs without hooks (pure-track usage)", () => {
    expect(() => new GameOrchestrator(makeDef())).not.toThrow();
  });

  it("constructs with turnOrderHooks + doorGameHooks", () => {
    const doorHooks = {
      async runTick() { return null; },
      async runEndgameTick() {},
    };
    const orc = new GameOrchestrator(makeDef(), stubHooks, doorHooks);
    expect(orc.definition).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Guard conditions — missing hooks
// ---------------------------------------------------------------------------

describe("GameOrchestrator.processSequentialTick — guard conditions", () => {
  it("throws when turnOrderHooks are not provided", async () => {
    const orc = new GameOrchestrator(makeDef());
    await expect(orc.processSequentialTick("s", "p")).rejects.toThrow(/turnOrderHooks required/);
  });

  it("throws when definition has no processFullTick method", async () => {
    const orc = new GameOrchestrator(makeDef(), stubHooks);
    await expect(orc.processSequentialTick("s", "p")).rejects.toThrow(/processFullTick required/);
  });
});

describe("GameOrchestrator.processSequentialAction — guard conditions", () => {
  it("throws when turnOrderHooks are not provided", async () => {
    const orc = new GameOrchestrator(makeDef());
    await expect(orc.processSequentialAction("s", "p", "end_turn", {})).rejects.toThrow(/turnOrderHooks required/);
  });

  it("throws when definition has no processFullAction method", async () => {
    const orc = new GameOrchestrator(makeDef(), stubHooks);
    await expect(orc.processSequentialAction("s", "p", "end_turn", {})).rejects.toThrow(/processFullAction required/);
  });
});

describe("GameOrchestrator.processDoorTick — guard conditions", () => {
  it("throws when doorGameHooks are not provided", async () => {
    const orc = new GameOrchestrator(makeDef(), stubHooks);
    await expect(orc.processDoorTick("s", "p")).rejects.toThrow(/doorGameHooks required/);
  });
});

describe("GameOrchestrator.processDoorAction — guard conditions", () => {
  it("throws when doorGameHooks are not provided", async () => {
    const orc = new GameOrchestrator(makeDef(), stubHooks);
    await expect(orc.processDoorAction("s", "p", "end_turn", {})).rejects.toThrow(/doorGameHooks required/);
  });

  it("throws when definition has no processFullAction method", async () => {
    const doorHooks = {
      async runTick() { return null; },
      async runEndgameTick() {},
    };
    const orc = new GameOrchestrator(makeDef(), stubHooks, doorHooks);
    await expect(orc.processDoorAction("s", "p", "end_turn", {})).rejects.toThrow(/processFullAction required/);
  });
});

// ---------------------------------------------------------------------------
// Pure utility functions exported from @dge/engine
// ---------------------------------------------------------------------------

describe("sessionCannotHaveActiveTurn", () => {
  it("true when waitingForHuman", () => {
    expect(sessionCannotHaveActiveTurn({ waitingForHuman: true, turnStartedAt: null })).toBe(true);
  });

  it("true when turnStartedAt is null", () => {
    expect(sessionCannotHaveActiveTurn({ waitingForHuman: false, turnStartedAt: null })).toBe(true);
  });

  it("false when game is active with a running turn clock", () => {
    expect(sessionCannotHaveActiveTurn({ waitingForHuman: false, turnStartedAt: new Date() })).toBe(false);
  });
});

describe("canPlayerAct", () => {
  it("true when fullTurnsUsedThisRound < actionsPerDay", () => {
    expect(canPlayerAct({ fullTurnsUsedThisRound: 2, turnsLeft: 50 }, 5)).toBe(true);
  });

  it("false when fullTurnsUsedThisRound >= actionsPerDay", () => {
    expect(canPlayerAct({ fullTurnsUsedThisRound: 5 }, 5)).toBe(false);
    expect(canPlayerAct({ fullTurnsUsedThisRound: 6 }, 5)).toBe(false);
  });

  it("false when turnsLeft is 0 (game over)", () => {
    expect(canPlayerAct({ fullTurnsUsedThisRound: 0, turnsLeft: 0 }, 5)).toBe(false);
  });

  it("true when turnsLeft > 0 and daily slot remains", () => {
    expect(canPlayerAct({ fullTurnsUsedThisRound: 1, turnsLeft: 99 }, 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getCandidateMoves (pure-track — no DB when definition provides no-DB loadState)
// ---------------------------------------------------------------------------

describe("GameOrchestrator.getCandidateMoves", () => {
  it("delegates to definition.generateCandidateMoves with the loaded state", async () => {
    let loadedState: FakeState | null = null;

    const def = makeDef({
      async loadState(): Promise<FakeState> { return { n: 99 }; },
      generateCandidateMoves(state: FakeState): Move[] {
        loadedState = state;
        return [{ action: "test", params: {}, label: "Test" }];
      },
    });

    const orc = new GameOrchestrator(def);
    const moves = await orc.getCandidateMoves("session-1", "player-1");

    expect(moves).toHaveLength(1);
    expect(moves[0].action).toBe("test");
    // Verify loadState was called and its result passed to generateCandidateMoves
    expect(loadedState).toEqual({ n: 99 });
  });
});
