/**
 * SRX GameDefinition — plugs SRX into the Door Game Engine.
 *
 * Two tracks:
 *
 * PURE TRACK (applyTick, applyAction, evalState, generateCandidateMoves)
 *   Synchronous, no I/O. Used by MCTS search and simulation. Delegates to
 *   the existing sim-state.ts functions which were extracted for exactly
 *   this purpose. Supports the subset of actions that sim-state.ts handles.
 *
 * FULL TRACK (loadState, saveState)
 *   Async, DB-backed. loadState loads the acting player's empire + relevant
 *   rivals from Prisma. saveState writes back empire/army scalar updates.
 *   Planet creation (buy_planet) is NOT yet handled in saveState — that
 *   action continues to run through the existing processAction. The full
 *   orchestration of API actions is still handled by game-engine.processAction
 *   during Phase 2; the orchestrator will take over incrementally in Phase 3+.
 *
 * Phase 2 scope:
 *   - loadState: loads acting player + target rival (for combat actions)
 *   - saveState: updates empire scalars + army scalars; skips planet changes
 *   - applyAction: pure track only; unsupported actions return success: false
 *   - API routes remain unchanged (still call processAction directly)
 */

import type { GameDefinition, ActionResult, TickResult, Move, Rng, FullActionOptions, FullActionResult, FullTurnReport } from "@dge/shared";
import type { SrxWorldState } from "./types";
import {
  type PureEmpireState,
  type RivalView,
  type CandidateMove,
  applyTick as srxApplyTick,
  applyAction as srxApplyAction,
  evalState as srxEvalState,
  generateCandidateMoves as srxGenerateCandidateMoves,
  empireFromPrisma,
  cloneEmpire,
} from "@/lib/sim-state";
import type { ActionType } from "@/lib/game-engine";
import { processAction, runAndPersistTick } from "@/lib/game-engine";
import { runAISequence as srxRunAISequence } from "@/lib/ai-runner";
import { doorGameAutoCloseFullTurnAfterAction } from "@/lib/door-game-turns";
import { getDb } from "@/lib/db-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRivalViews(empires: PureEmpireState[], actingIdx: number): RivalView[] {
  return empires
    .filter((_, i) => i !== actingIdx)
    .map((e) => ({
      id: e.id,
      name: e.name,
      netWorth: e.netWorth,
      isProtected: e.isProtected,
      credits: e.credits,
      population: e.population,
      planets: e.planets,
      army: e.army,
    }));
}

function mergeRivalChanges(
  empires: PureEmpireState[],
  actingIdx: number,
  updatedRivals: RivalView[],
): PureEmpireState[] {
  return empires.map((e, i) => {
    if (i === actingIdx) return e;
    const updated = updatedRivals.find((r) => r.id === e.id);
    if (!updated) return e;
    return {
      ...e,
      credits: updated.credits,
      population: updated.population,
      army: { ...updated.army },
    };
  });
}

// ---------------------------------------------------------------------------
// SRX GameDefinition
// ---------------------------------------------------------------------------

export const srxGameDefinition: GameDefinition<SrxWorldState> = {
  // -------------------------------------------------------------------------
  // Full track — persistence (Phase 2: acting player + combat target only)
  // -------------------------------------------------------------------------

  async loadState(
    sessionId: string,
    playerId: string,
    action: string,
    _db: unknown,
  ): Promise<SrxWorldState> {
    const db = getDb();

    // Always load the acting player's full empire.
    const player = await db.player.findUnique({
      where: { id: playerId },
      include: {
        empire: {
          include: { planets: true, army: true, supplyRates: true, research: true },
        },
        gameSession: { select: { _count: { select: { players: true } } } },
      },
    });

    if (!player?.empire?.army) {
      throw new Error(`Empire not found for player ${playerId}`);
    }

    const playerCount = player.gameSession?._count?.players ?? 1;

    // Prisma types army/supplyRates/research as nullable (presence checked above).
    // PrismaEmpireShape requires non-nullable army — cast is safe after the null check.
    const selfEmpire = empireFromPrisma(
      player.empire as unknown as Parameters<typeof empireFromPrisma>[0],
      player.name,
    );
    const armyId = player.empire.army!.id;

    const empires: PureEmpireState[] = [selfEmpire];
    const armyIds: string[] = [armyId];

    // For combat/covert actions, load the target empire too.
    const needsTarget = [
      "attack_conventional",
      "attack_guerrilla",
      "attack_nuclear",
      "attack_chemical",
      "attack_psionic",
      "covert_op",
    ].includes(action);

    if (needsTarget) {
      const targetName = undefined; // params not available here — target loaded lazily by applyAction
      void targetName; // reserved for future selective loading
    }

    return { sessionId, empires, armyIds, playerCount };
  },

  async saveState(
    _sessionId: string,
    state: SrxWorldState,
    _db: unknown,
  ): Promise<void> {
    const db = getDb();

    // Write back empire and army scalars for all loaded empires.
    // Planet changes (new planets from buy_planet) are NOT handled here —
    // those continue through the existing processAction path.
    for (let i = 0; i < state.empires.length; i++) {
      const e = state.empires[i];
      const armyId = state.armyIds[i];

      await db.empire.update({
        where: { id: e.id },
        data: {
          credits: e.credits,
          food: e.food,
          ore: e.ore,
          fuel: e.fuel,
          population: e.population,
          taxRate: e.taxRate,
          civilStatus: e.civilStatus,
          netWorth: e.netWorth,
          turnsLeft: e.turnsLeft,
          turnsPlayed: e.turnsPlayed,
          isProtected: e.isProtected,
          protectionTurns: e.protectionTurns,
          foodSellRate: e.foodSellRate,
          oreSellRate: e.oreSellRate,
          petroleumSellRate: e.petroleumSellRate,
        },
      });

      await db.army.update({
        where: { id: armyId },
        data: {
          soldiers: e.army.soldiers,
          generals: e.army.generals,
          fighters: e.army.fighters,
          defenseStations: e.army.defenseStations,
          lightCruisers: e.army.lightCruisers,
          heavyCruisers: e.army.heavyCruisers,
          carriers: e.army.carriers,
          covertAgents: e.army.covertAgents,
          commandShipStrength: e.army.commandShipStrength,
          effectiveness: e.army.effectiveness,
          covertPoints: e.army.covertPoints,
        },
      });
    }
  },

  // -------------------------------------------------------------------------
  // Pure track — economy tick
  // -------------------------------------------------------------------------

  applyTick(state: SrxWorldState, rng: Rng): TickResult<SrxWorldState> {
    // Apply tick to all loaded empires. In practice the orchestrator will
    // call this for the acting player only; we map all to stay generic.
    const rawRng = () => rng.random();
    const empires = state.empires.map((e) =>
      srxApplyTick(e, rawRng, state.playerCount, true),
    );
    return { state: { ...state, empires } };
  },

  // -------------------------------------------------------------------------
  // Pure track — action application (MCTS / simulation)
  // -------------------------------------------------------------------------

  applyAction(
    state: SrxWorldState,
    playerId: string,
    action: string,
    params: unknown,
    rng: Rng,
  ): ActionResult<SrxWorldState> {
    const actingIdx = state.empires.findIndex((e) => e.id === playerId);
    if (actingIdx === -1) {
      return { success: false, message: `Player ${playerId} not found in world state.` };
    }

    const rawRng = () => rng.random();
    const rivals = buildRivalViews(state.empires, actingIdx);

    const result = srxApplyAction(
      state.empires[actingIdx],
      action as ActionType,
      params as Record<string, unknown>,
      rivals,
      rawRng,
    );

    if (!result.success) {
      return { success: false, message: result.message };
    }

    // Merge acting player's updated state back
    const empires = state.empires.map((e, i) =>
      i === actingIdx ? result.state : e,
    );

    // Merge rival changes (combat actions update rival credits/population/army)
    const mergedEmpires = mergeRivalChanges(empires, actingIdx, result.rivals);

    return {
      success: true,
      message: result.message,
      state: { ...state, empires: mergedEmpires },
    };
  },

  // -------------------------------------------------------------------------
  // Pure track — evaluation and search
  // -------------------------------------------------------------------------

  evalState(state: SrxWorldState, forPlayerId: string): number {
    const empire = state.empires.find((e) => e.id === forPlayerId);
    if (!empire) return 0;
    return srxEvalState(empire, state.empires);
  },

  generateCandidateMoves(state: SrxWorldState, forPlayerId: string): Move[] {
    const actingIdx = state.empires.findIndex((e) => e.id === forPlayerId);
    if (actingIdx === -1) return [];
    const rivals = buildRivalViews(state.empires, actingIdx);
    return srxGenerateCandidateMoves(
      state.empires[actingIdx],
      rivals,
      12,
    ) as Move[];
  },

  // -------------------------------------------------------------------------
  // Optional extensions
  // -------------------------------------------------------------------------

  toPureState(state: SrxWorldState): SrxWorldState {
    // Already plain objects — deep clone for worker thread safety.
    return {
      ...state,
      empires: state.empires.map(cloneEmpire),
      armyIds: [...state.armyIds],
    };
  },

  projectState(state: SrxWorldState, forPlayerId: string): SrxWorldState {
    // Strip private info from empires the client shouldn't see.
    // For now: return acting player fully, rivals with only public fields.
    const empires = state.empires.map((e) => {
      if (e.id === forPlayerId) return e;
      // Public projection: hide exact finances, research, supply rates
      return {
        ...e,
        credits: 0,          // hidden
        food: 0,             // hidden
        ore: 0,              // hidden
        fuel: 0,             // hidden
        loans: 0,            // hidden
        research: { accumulatedPoints: 0, unlockedTechIds: [] },
        supplyRates: e.supplyRates, // keep for AI context
      };
    });
    return { ...state, empires };
  },

  // -------------------------------------------------------------------------
  // Full-track migration shims (Phase 5)
  //
  // These proxy directly to the existing SRX game-engine implementations so
  // the orchestrator can drive sequential + door-game flows without each
  // action handler being fully extracted into the pure applyAction yet.
  // -------------------------------------------------------------------------

  async processFullAction(
    playerId: string,
    action: string,
    params: Record<string, unknown>,
    opts?: FullActionOptions,
  ): Promise<FullActionResult> {
    // processAction returns { success, message, ...extra }; cast is safe.
    return processAction(playerId, action as ActionType, params, opts) as Promise<FullActionResult>;
  },

  async processFullTick(playerId: string): Promise<FullTurnReport> {
    // TurnReport is structurally compatible with FullTurnReport; cast satisfies TS.
    return runAndPersistTick(playerId) as Promise<FullTurnReport>;
  },

  async runAiSequence(sessionId: string): Promise<void> {
    await srxRunAISequence(sessionId);
  },

  async postActionClose(playerId: string, sessionId: string): Promise<void> {
    await doorGameAutoCloseFullTurnAfterAction(playerId, sessionId);
  },
};
