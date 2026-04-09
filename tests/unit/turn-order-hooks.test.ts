/**
 * Unit tests for TurnOrderHooks interface contract.
 *
 * The getActivePlayers hook dispatch (if provided, call hook; else default
 * to all players) is a simple 3-line branch in turn-order.ts. It's exercised
 * end-to-end by game-flow.test.ts (SRX provides the hook) and will be tested
 * with chess (default fallback). These tests validate the type contract and
 * that hook construction works correctly.
 */

import { describe, it, expect } from "vitest";
import type { TurnOrderHooks } from "@dge/engine";

describe("TurnOrderHooks interface", () => {
  it("can be constructed with only required methods (no getActivePlayers)", () => {
    const hooks: TurnOrderHooks = {
      async runTick() {},
      async processEndTurn() {},
    };
    expect(hooks.getActivePlayers).toBeUndefined();
    expect(typeof hooks.runTick).toBe("function");
    expect(typeof hooks.processEndTurn).toBe("function");
  });

  it("can be constructed with getActivePlayers hook", () => {
    const hooks: TurnOrderHooks = {
      async runTick() {},
      async processEndTurn() {},
      async getActivePlayers(sessionId: string) {
        return [{ id: "p1", name: "Player1", isAI: false, turnOrder: 0 }];
      },
    };
    expect(typeof hooks.getActivePlayers).toBe("function");
  });

  it("getActivePlayers returns correctly shaped data", async () => {
    const hooks: TurnOrderHooks = {
      async runTick() {},
      async processEndTurn() {},
      async getActivePlayers() {
        return [
          { id: "p1", name: "Human", isAI: false, turnOrder: 0 },
          { id: "p2", name: "AI Bot", isAI: true, turnOrder: 1 },
        ];
      },
    };
    const players = await hooks.getActivePlayers!("session-1");
    expect(players).toHaveLength(2);
    expect(players[0]).toEqual({ id: "p1", name: "Human", isAI: false, turnOrder: 0 });
    expect(players[1]).toEqual({ id: "p2", name: "AI Bot", isAI: true, turnOrder: 1 });
  });

  it("SRX-style hook can filter out eliminated players", async () => {
    const allPlayers = [
      { id: "p1", name: "Active", isAI: false, turnOrder: 0, turnsLeft: 50 },
      { id: "p2", name: "Eliminated", isAI: false, turnOrder: 1, turnsLeft: 0 },
      { id: "p3", name: "AI Active", isAI: true, turnOrder: 2, turnsLeft: 10 },
    ];

    const hooks: TurnOrderHooks = {
      async runTick() {},
      async processEndTurn() {},
      async getActivePlayers() {
        return allPlayers
          .filter((p) => p.turnsLeft > 0)
          .map(({ id, name, isAI, turnOrder }) => ({ id, name, isAI, turnOrder }));
      },
    };

    const active = await hooks.getActivePlayers!("session-1");
    expect(active).toHaveLength(2);
    expect(active.map((p) => p.name)).toEqual(["Active", "AI Active"]);
  });

  it("chess-style game needs no getActivePlayers (all players always active)", () => {
    const hooks: TurnOrderHooks = {
      async runTick() {},
      async processEndTurn() {},
      // No getActivePlayers — engine default returns all players in session.
    };
    expect(hooks.getActivePlayers).toBeUndefined();
  });
});
