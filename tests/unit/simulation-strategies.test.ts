import { describe, it, expect } from "vitest";
import {
  pickSimAction,
  DEFAULT_SIM_STRATEGIES,
  type StrategyContext,
  type SimStrategy,
} from "@/lib/simulation";

function emptyCtx(over: Partial<StrategyContext> = {}): StrategyContext {
  return {
    credits: 0,
    food: 0,
    ore: 0,
    fuel: 0,
    population: 50000,
    taxRate: 30,
    civilStatus: 0,
    turnsPlayed: 0,
    planets: [],
    totalPlanets: 0,
    soldiers: 0,
    generals: 0,
    fighters: 0,
    defenseStations: 0,
    lightCruisers: 0,
    heavyCruisers: 0,
    carriers: 0,
    covertAgents: 0,
    effectiveness: 100,
    researchPoints: 0,
    unlockedTechIds: [],
    activeLoanCount: 0,
    ...over,
  };
}

describe("simulation strategies", () => {
  it("exports eight default strategies", () => {
    expect(DEFAULT_SIM_STRATEGIES.length).toBe(8);
  });

  it.each(DEFAULT_SIM_STRATEGIES)("pickSimAction(%s) returns an action at turn 0", (strat) => {
    const a = pickSimAction(strat as SimStrategy, emptyCtx({ credits: 100000 }), 0);
    expect(a.action).toBeTruthy();
    expect(a.params).toBeDefined();
  });

  it("research_rush chooses discover_tech when points suffice", () => {
    const a = pickSimAction(
      "research_rush",
      emptyCtx({
        credits: 500000,
        researchPoints: 20000,
        unlockedTechIds: [],
      }),
      5,
    );
    expect(a.action).toBe("discover_tech");
    expect(a.params).toHaveProperty("techId");
  });

  it("credit_leverage requests a loan when under cap and low credits", () => {
    const a = pickSimAction(
      "credit_leverage",
      emptyCtx({ credits: 20000, activeLoanCount: 0 }),
      5,
    );
    expect(a.action).toBe("bank_loan");
    expect(a.params).toMatchObject({ amount: 100000 });
  });
});
