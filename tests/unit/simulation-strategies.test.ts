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
    netWorth: 0,
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
    covertPoints: 0,
    effectiveness: 100,
    researchPoints: 0,
    unlockedTechIds: [],
    loans: [],
    activeLoanCount: 0,
    supplyRateStation: 0,
    rivals: [],
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
      emptyCtx({ credits: 20000, loans: [], activeLoanCount: 0 }),
      5,
    );
    expect(a.action).toBe("bank_loan");
    expect(a.params).toMatchObject({ amount: 100000 });
  });

  it("turtle buys stations in bulk when income exceeds maintenance", () => {
    // 4 ore planets (income ≈ 35k) + 3 tourism (≈22.5k) = freeIncome >> stationMaint(0)
    const a = pickSimAction(
      "turtle",
      emptyCtx({
        credits: 200000,
        planets: [
          { type: "FOOD", count: 3 },
          { type: "ORE", count: 4 },
          { type: "TOURISM", count: 3 },
          { type: "URBAN", count: 3 },
          { type: "GOVERNMENT", count: 2 },
        ],
        totalPlanets: 15,
        defenseStations: 0,
      }),
      20,
    );
    expect(a.action).toBe("buy_stations");
    expect((a.params.amount as number)).toBeGreaterThan(50); // should buy many at once
  });

  it("turtle keeps buying economy planets when income base is low", () => {
    // FOOD already at 3, no ORE or TOURISM → freeIncome near 0 → should buy ORE
    const a = pickSimAction(
      "turtle",
      emptyCtx({
        credits: 50000,
        planets: [{ type: "FOOD", count: 3 }],
        totalPlanets: 3,
      }),
      5,
    );
    expect(a.action).toBe("buy_planet");
    expect(a.params.type).toBe("ORE");
  });

  it("military_rush attacks weakest unprotected rival when strong enough", () => {
    const a = pickSimAction(
      "military_rush",
      emptyCtx({
        credits: 50000,
        soldiers: 500,
        fighters: 80,
        generals: 6,       // already maxed so buy_generals won't fire first
        lightCruisers: 30, // already maxed
        heavyCruisers: 10, // already maxed
        planets: [
          { type: "ORE", count: 4 },
          { type: "FOOD", count: 3 },
          { type: "URBAN", count: 3 },
          { type: "GOVERNMENT", count: 2 },
        ],
        totalPlanets: 12,
        covertAgents: 5,   // already bought; prevents buy_covert_agents from firing first
        covertPoints: 0,   // no covert points so bombing won't fire before attack
        rivals: [
          { name: "EnemyA", netWorth: 120, isProtected: true,  credits: 50000 },
          { name: "EnemyB", netWorth: 80,  isProtected: false, credits: 30000 },
          { name: "EnemyC", netWorth: 60,  isProtected: false, credits: 20000 },
        ],
      }),
      20,
    );
    expect(a.action).toBe("attack_conventional");
    expect(a.params.target).toBe("EnemyC"); // weakest unprotected
  });

  it("military_rush skips PvP when all rivals are protected", () => {
    const a = pickSimAction(
      "military_rush",
      emptyCtx({
        credits: 10000,
        soldiers: 600,
        fighters: 100,
        planets: [{ type: "ORE", count: 4 }, { type: "FOOD", count: 3 }, { type: "URBAN", count: 3 }, { type: "GOVERNMENT", count: 2 }],
        totalPlanets: 12,
        rivals: [
          { name: "Safe1", netWorth: 50, isProtected: true, credits: 40000 },
          { name: "Safe2", netWorth: 70, isProtected: true, credits: 60000 },
        ],
      }),
      15,
    );
    // Should NOT return attack_conventional
    expect(a.action).not.toBe("attack_conventional");
  });
});
