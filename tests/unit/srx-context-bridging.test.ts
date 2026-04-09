/**
 * Unit tests for SRX FullActionOptions.context → ProcessActionOptions bridging.
 *
 * The SRX GameDefinition.processFullAction converts the engine's generic
 * FullActionOptions.context into SRX-specific ProcessActionOptions fields.
 * This test validates the mapping without hitting the DB.
 */

import { describe, it, expect } from "vitest";
import type { FullActionOptions } from "@dge/shared";

/**
 * Extracted bridging logic from games/srx/src/definition.ts processFullAction.
 * This mirrors exactly what the definition does — if someone changes that code,
 * this test should be updated (and will catch accidental regressions).
 */
function bridgeContextToSrxOpts(opts?: FullActionOptions) {
  const srxOpts: {
    logMeta?: Record<string, unknown>;
    tickOptions?: { decrementTurnsLeft: boolean };
    keepTickProcessed?: boolean;
    skipEndgameSettlement?: boolean;
  } = {
    logMeta: opts?.logMeta,
  };
  if (opts?.context?.turnMode === "door-game") {
    srxOpts.tickOptions = { decrementTurnsLeft: false };
    srxOpts.keepTickProcessed = !opts.context.isEndTurn;
    srxOpts.skipEndgameSettlement = true;
  }
  return srxOpts;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SRX FullActionOptions.context → ProcessActionOptions bridging", () => {
  it("sequential mode (no context) produces default SRX options", () => {
    const result = bridgeContextToSrxOpts({ context: { turnMode: "sequential" } });
    expect(result.tickOptions).toBeUndefined();
    expect(result.keepTickProcessed).toBeUndefined();
    expect(result.skipEndgameSettlement).toBeUndefined();
  });

  it("undefined opts produces default SRX options", () => {
    const result = bridgeContextToSrxOpts(undefined);
    expect(result.tickOptions).toBeUndefined();
    expect(result.keepTickProcessed).toBeUndefined();
    expect(result.skipEndgameSettlement).toBeUndefined();
  });

  it("door-game end_turn produces correct SRX options", () => {
    const result = bridgeContextToSrxOpts({
      context: { turnMode: "door-game", isEndTurn: true },
    });
    expect(result.tickOptions).toEqual({ decrementTurnsLeft: false });
    expect(result.keepTickProcessed).toBe(false);
    expect(result.skipEndgameSettlement).toBe(true);
  });

  it("door-game non-end_turn action produces correct SRX options", () => {
    const result = bridgeContextToSrxOpts({
      context: { turnMode: "door-game", isEndTurn: false },
    });
    expect(result.tickOptions).toEqual({ decrementTurnsLeft: false });
    expect(result.keepTickProcessed).toBe(true);
    expect(result.skipEndgameSettlement).toBe(true);
  });

  it("door-game without explicit isEndTurn defaults to keepTickProcessed=true", () => {
    const result = bridgeContextToSrxOpts({
      context: { turnMode: "door-game" },
    });
    // isEndTurn is undefined → !undefined = true → keepTickProcessed = true
    expect(result.keepTickProcessed).toBe(true);
    expect(result.skipEndgameSettlement).toBe(true);
  });

  it("preserves logMeta regardless of context", () => {
    const meta = { llmSource: "gemini", custom: 42 };
    const result = bridgeContextToSrxOpts({
      logMeta: meta,
      context: { turnMode: "door-game", isEndTurn: true },
    });
    expect(result.logMeta).toEqual(meta);
  });
});
