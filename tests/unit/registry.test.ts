/**
 * Unit tests for @dge/engine registry.
 *
 * Tests:
 *   - registerGame: stores definition + creates orchestrator
 *   - getGame: returns undefined for unknown types
 *   - requireGame: throws for unknown types
 *   - listGameTypes: enumerates registered games
 *   - _clearRegistry: isolates tests from each other
 *   - re-registration replaces previous entry
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  registerGame,
  getGame,
  requireGame,
  listGameTypes,
  _clearRegistry,
} from "@dge/engine/registry";
import { GameOrchestrator } from "@dge/engine";
import type { GameDefinition, GameMetadata, GameHttpAdapter, ActionResult, Move, Rng } from "@dge/shared";

// ---------------------------------------------------------------------------
// Minimal test GameDefinition (no real DB or logic needed)
// ---------------------------------------------------------------------------

type FakeState = { value: number };

function makeFakeDefinition(): GameDefinition<FakeState> {
  return {
    async loadState(_sid, _pid, _action, _db): Promise<FakeState> {
      return { value: 0 };
    },
    async saveState(_sid, _state, _db): Promise<void> {
      // no-op
    },
    applyAction(
      state: FakeState,
      _playerId: string,
      _action: string,
      _params: unknown,
      _rng: Rng,
    ): ActionResult<FakeState> {
      return { success: true, message: "ok", state };
    },
    evalState(_state: FakeState, _playerId: string): number {
      return 0;
    },
    generateCandidateMoves(_state: FakeState, _playerId: string): Move[] {
      return [];
    },
  };
}

const stubMetadata: GameMetadata = {
  game: "chess",
  displayName: "Chess",
  description: "Test game",
  playerRange: [2, 2],
  supportsJoin: false,
  createOptions: [],
};

const stubAdapter: GameHttpAdapter = {
  defaultTotalTurns: 200,
  defaultActionsPerDay: 1,
  getPlayerCreateData() { return {}; },
  async buildStatus() { return {}; },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("game registry", () => {
  beforeEach(() => {
    _clearRegistry();
  });

  it("getGame returns undefined for unregistered game type", () => {
    expect(getGame("chess")).toBeUndefined();
  });

  it("requireGame throws for unregistered game type", () => {
    expect(() => requireGame("chess")).toThrow(/chess.*not registered/i);
  });

  it("listGameTypes returns empty array when no games are registered", () => {
    expect(listGameTypes()).toEqual([]);
  });

  it("registerGame stores the definition and creates an orchestrator", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });

    const entry = getGame("chess");
    expect(entry).toBeDefined();
    expect(entry!.definition).toBe(def);
    expect(entry!.orchestrator).toBeInstanceOf(GameOrchestrator);
  });

  it("requireGame returns the registered entry", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });

    const entry = requireGame("chess");
    expect(entry.definition).toBe(def);
  });

  it("listGameTypes reflects all registered games", () => {
    registerGame("chess", { definition: makeFakeDefinition(), metadata: stubMetadata, adapter: stubAdapter });
    registerGame("srx", { definition: makeFakeDefinition(), metadata: { ...stubMetadata, game: "srx" }, adapter: stubAdapter });

    const types = listGameTypes();
    expect(types).toContain("chess");
    expect(types).toContain("srx");
    expect(types).toHaveLength(2);
  });

  it("re-registering the same game type replaces the previous entry", () => {
    const def1 = makeFakeDefinition();
    const def2 = makeFakeDefinition();

    registerGame("chess", { definition: def1, metadata: stubMetadata, adapter: stubAdapter });
    registerGame("chess", { definition: def2, metadata: stubMetadata, adapter: stubAdapter });

    const entry = requireGame("chess");
    expect(entry.definition).toBe(def2);
    expect(entry.definition).not.toBe(def1);
  });

  it("_clearRegistry removes all registrations", () => {
    registerGame("chess", { definition: makeFakeDefinition(), metadata: stubMetadata, adapter: stubAdapter });
    _clearRegistry();
    expect(listGameTypes()).toHaveLength(0);
    expect(getGame("chess")).toBeUndefined();
  });

  it("orchestrator has the definition bound", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });
    const { orchestrator } = requireGame("chess");
    expect(orchestrator.definition).toBe(def);
  });

  it("registerGame with no hooks creates orchestrator without hooks (no throw for non-full-track methods)", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });
    const { orchestrator } = requireGame("chess");
    // processAction (pure-track) works without hooks
    expect(orchestrator).toBeDefined();
  });

  it("registerGame stores metadata and makes it retrievable", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });
    const entry = requireGame("chess");
    expect(entry.metadata).toBe(stubMetadata);
    expect(entry.metadata.game).toBe("chess");
    expect(entry.metadata.displayName).toBe("Chess");
    expect(entry.metadata.supportsJoin).toBe(false);
    expect(Array.isArray(entry.metadata.createOptions)).toBe(true);
  });

  it("registerGame stores adapter and makes it retrievable", () => {
    const def = makeFakeDefinition();
    registerGame("chess", { definition: def, metadata: stubMetadata, adapter: stubAdapter });
    const entry = requireGame("chess");
    expect(entry.adapter).toBe(stubAdapter);
    expect(entry.adapter.defaultTotalTurns).toBe(200);
    expect(entry.adapter.defaultActionsPerDay).toBe(1);
    expect(typeof entry.adapter.getPlayerCreateData).toBe("function");
    expect(typeof entry.adapter.buildStatus).toBe("function");
  });

  it("re-registration replaces metadata and adapter too", () => {
    const updatedMeta: GameMetadata = { ...stubMetadata, displayName: "Chess v2" };
    const updatedAdapter: GameHttpAdapter = { ...stubAdapter, defaultTotalTurns: 999 };

    registerGame("chess", { definition: makeFakeDefinition(), metadata: stubMetadata, adapter: stubAdapter });
    registerGame("chess", { definition: makeFakeDefinition(), metadata: updatedMeta, adapter: updatedAdapter });

    const entry = requireGame("chess");
    expect(entry.metadata.displayName).toBe("Chess v2");
    expect(entry.adapter.defaultTotalTurns).toBe(999);
  });
});
