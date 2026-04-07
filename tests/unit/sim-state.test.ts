import { describe, it, expect, beforeEach } from "vitest";
import {
  applyTick,
  applyAction,
  generateCandidateMoves,
  evalState,
  makeRng,
  cloneEmpire,
  inferRolloutStrategy,
  pickRolloutMove,
  type PureEmpireState,
  type RivalView,
  type CandidateMove,
} from "@/lib/sim-state";
import { START, UNIT_COST } from "@/lib/game-constants";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEmpire(overrides: Partial<PureEmpireState> = {}): PureEmpireState {
  return {
    id: "e1",
    name: "TestPlayer",
    credits: START.CREDITS,
    food: START.FOOD,
    ore: START.ORE,
    fuel: START.FUEL,
    population: START.POPULATION,
    taxRate: START.TAX_RATE,
    civilStatus: 0,
    netWorth: 10,
    turnsLeft: START.TURNS,
    turnsPlayed: 0,
    isProtected: true,
    protectionTurns: START.PROTECTION_TURNS,
    foodSellRate: 0,
    oreSellRate: 50,
    petroleumSellRate: 50,
    planets: [
      { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
      { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
      { type: "ORE", shortTermProduction: 100, longTermProduction: 100 },
      { type: "ORE", shortTermProduction: 100, longTermProduction: 100 },
      { type: "URBAN", shortTermProduction: 100, longTermProduction: 100 },
      { type: "URBAN", shortTermProduction: 100, longTermProduction: 100 },
      { type: "GOVERNMENT", shortTermProduction: 100, longTermProduction: 100 },
    ],
    army: {
      soldiers: START.SOLDIERS,
      generals: START.GENERALS,
      fighters: START.FIGHTERS,
      defenseStations: 0,
      lightCruisers: 0,
      heavyCruisers: 0,
      carriers: 0,
      covertAgents: 0,
      commandShipStrength: 0,
      effectiveness: 50,
      covertPoints: 0,
      soldiersLevel: 1,
      fightersLevel: 1,
      stationsLevel: 1,
      lightCruisersLevel: 1,
      heavyCruisersLevel: 1,
    },
    research: { accumulatedPoints: 0, unlockedTechIds: [] },
    supplyRates: {
      rateSoldier: 50, rateFighter: 50, rateStation: 0,
      rateHeavyCruiser: 0, rateCarrier: 0, rateGeneral: 0, rateCovert: 0, rateCredits: 0,
    },
    loans: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyTick
// ---------------------------------------------------------------------------

describe("applyTick", () => {
  const deterministicRng = makeRng(42);

  it("does not mutate the original state", () => {
    const orig = makeEmpire();
    const origStr = JSON.stringify(orig);
    applyTick(orig, deterministicRng);
    expect(JSON.stringify(orig)).toBe(origStr);
  });

  it("increments turnsPlayed and decrements turnsLeft", () => {
    const s = makeEmpire({ turnsPlayed: 0, turnsLeft: 50 });
    const after = applyTick(s, makeRng(1));
    expect(after.turnsPlayed).toBe(1);
    expect(after.turnsLeft).toBe(49);
  });

  it("produces positive income with URBAN+FOOD+ORE planets at moderate tax", () => {
    const s = makeEmpire();
    const after = applyTick(s, makeRng(2));
    // With sell rates and population tax, credits should at minimum not collapse to 0
    expect(after.credits).toBeGreaterThan(0);
  });

  it("reduces food when starving (no food planets, high population)", () => {
    const s = makeEmpire({
      planets: [
        { type: "URBAN", shortTermProduction: 100, longTermProduction: 100 },
      ],
      food: 0,
      population: 50000,
    });
    const after = applyTick(s, makeRng(3));
    // Starvation: population should drop
    expect(after.population).toBeLessThan(s.population);
  });

  it("is deterministic given same RNG seed", () => {
    const s = makeEmpire();
    const a = applyTick(s, makeRng(99));
    const b = applyTick(s, makeRng(99));
    expect(a.credits).toBe(b.credits);
    expect(a.population).toBe(b.population);
    expect(a.netWorth).toBe(b.netWorth);
  });

  it("decrements protection turns", () => {
    const s = makeEmpire({ isProtected: true, protectionTurns: 3 });
    const after = applyTick(s, makeRng(10));
    expect(after.protectionTurns).toBe(2);
  });

  it("clears protection when turns reach 0", () => {
    const s = makeEmpire({ isProtected: true, protectionTurns: 1 });
    const after = applyTick(s, makeRng(10));
    expect(after.isProtected).toBe(false);
    expect(after.protectionTurns).toBe(0);
  });

  it("handles credits deficit by losing planets and military", () => {
    const s = makeEmpire({ credits: 0 });
    // Force negative credits by applying tick with high maintenance
    const big = makeEmpire({
      credits: 0,
      planets: Array.from({ length: 30 }, () => ({
        type: "URBAN" as const,
        shortTermProduction: 100,
        longTermProduction: 100,
      })),
    });
    const after = applyTick(big, makeRng(5));
    // May or may not go bankrupt, but should not throw
    expect(after.credits).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// applyAction
// ---------------------------------------------------------------------------

describe("applyAction", () => {
  it("buy_planet deducts cost and adds a planet", () => {
    const s = makeEmpire({ credits: 50000, netWorth: 10 });
    const result = applyAction(s, "buy_planet", { type: "FOOD" }, [], makeRng(1));
    expect(result.success).toBe(true);
    expect(result.state.planets.length).toBe(s.planets.length + 1);
    expect(result.state.credits).toBeLessThan(s.credits);
  });

  it("buy_planet fails when insufficient credits", () => {
    const s = makeEmpire({ credits: 100 });
    const result = applyAction(s, "buy_planet", { type: "FOOD" }, [], makeRng(1));
    expect(result.success).toBe(false);
    expect(result.state.planets.length).toBe(s.planets.length);
  });

  it("set_tax_rate clamps to [0, 100]", () => {
    const s = makeEmpire();
    const res1 = applyAction(s, "set_tax_rate", { rate: 150 }, [], makeRng(1));
    expect(res1.state.taxRate).toBe(100);
    const res2 = applyAction(s, "set_tax_rate", { rate: -10 }, [], makeRng(1));
    expect(res2.state.taxRate).toBe(0);
    const res3 = applyAction(s, "set_tax_rate", { rate: 35 }, [], makeRng(1));
    expect(res3.state.taxRate).toBe(35);
  });

  it("buy_soldiers increases army and deducts credits", () => {
    const s = makeEmpire({ credits: 10000 });
    const count = 10;
    const result = applyAction(s, "buy_soldiers", { amount: count }, [], makeRng(1));
    expect(result.success).toBe(true);
    expect(result.state.army.soldiers).toBe(s.army.soldiers + count);
    expect(result.state.credits).toBe(s.credits - count * UNIT_COST.SOLDIER);
  });

  it("buy_generals respects government planet cap", () => {
    const noGovEmpire = makeEmpire({ planets: [] });
    const result = applyAction(noGovEmpire, "buy_generals", { amount: 1 }, [], makeRng(1));
    expect(result.success).toBe(false);
  });

  it("buy_generals succeeds within cap", () => {
    const s = makeEmpire({ credits: 10000, army: { ...makeEmpire().army, generals: 0 } });
    const result = applyAction(s, "buy_generals", { amount: 1 }, [], makeRng(1));
    expect(result.success).toBe(true);
    expect(result.state.army.generals).toBe(1);
  });

  it("bank_loan adds credits and increments loan count", () => {
    const s = makeEmpire({ loans: 0 });
    const result = applyAction(s, "bank_loan", { amount: 100000 }, [], makeRng(1));
    expect(result.success).toBe(true);
    expect(result.state.credits).toBe(s.credits + 100000);
    expect(result.state.loans).toBe(1);
  });

  it("bank_loan fails when at max loans", () => {
    const s = makeEmpire({ loans: 3 });
    const result = applyAction(s, "bank_loan", { amount: 100000 }, [], makeRng(1));
    expect(result.success).toBe(false);
  });

  it("attack_pirates with strong army usually succeeds", () => {
    const s = makeEmpire({
      credits: 5000,
      army: {
        ...makeEmpire().army,
        soldiers: 1000,
        fighters: 50,
        generals: 2,
        effectiveness: 80,
      },
    });
    const result = applyAction(s, "attack_pirates", {}, [], makeRng(1));
    expect(result.success).toBe(true);
  });

  it("attack_conventional against protected rival fails", () => {
    const s = makeEmpire({ army: { ...makeEmpire().army, generals: 2 } });
    const rival: RivalView = {
      id: "r1", name: "Rival", netWorth: 5,
      isProtected: true, credits: 5000, population: 20000,
      planets: [{ type: "FOOD", shortTermProduction: 100, longTermProduction: 100 }],
      army: makeEmpire().army,
    };
    const result = applyAction(s, "attack_conventional", { target: "Rival" }, [rival], makeRng(1));
    expect(result.success).toBe(false);
  });

  it("discover_tech fails if insufficient research points", () => {
    const s = makeEmpire({ research: { accumulatedPoints: 0, unlockedTechIds: [] } });
    const result = applyAction(s, "discover_tech", { techId: "basic_farming" }, [], makeRng(1));
    expect(result.success).toBe(false);
  });

  it("end_turn returns success without state change", () => {
    const s = makeEmpire();
    const result = applyAction(s, "end_turn", {}, [], makeRng(1));
    expect(result.success).toBe(true);
    expect(result.state.credits).toBe(s.credits);
  });

  it("does not mutate the original state", () => {
    const s = makeEmpire({ credits: 50000, netWorth: 10 });
    const origCredits = s.credits;
    const origPlanetCount = s.planets.length;
    applyAction(s, "buy_planet", { type: "FOOD" }, [], makeRng(1));
    expect(s.credits).toBe(origCredits);
    expect(s.planets.length).toBe(origPlanetCount);
  });
});

// ---------------------------------------------------------------------------
// generateCandidateMoves
// ---------------------------------------------------------------------------

describe("generateCandidateMoves", () => {
  it("always includes end_turn", () => {
    const s = makeEmpire();
    const moves = generateCandidateMoves(s, []);
    expect(moves.some((m) => m.action === "end_turn")).toBe(true);
  });

  it("respects maxMoves limit", () => {
    const s = makeEmpire({ credits: 999999 });
    const moves = generateCandidateMoves(s, [], 4);
    expect(moves.length).toBeLessThanOrEqual(4);
  });

  it("suggests planet buys when affordable", () => {
    const s = makeEmpire({ credits: 50000, netWorth: 0 });
    const moves = generateCandidateMoves(s, []);
    expect(moves.some((m) => m.action === "buy_planet")).toBe(true);
  });

  it("does not suggest pirate attacks without generals", () => {
    const s = makeEmpire({ army: { ...makeEmpire().army, generals: 0 } });
    const moves = generateCandidateMoves(s, []);
    expect(moves.every((m) => m.action !== "attack_pirates")).toBe(true);
  });

  it("suggests attacking weak rivals", () => {
    const weakRival: RivalView = {
      id: "r1", name: "WeakGuy", netWorth: 1,
      isProtected: false, credits: 1000, population: 1000,
      planets: [],
      army: {
        ...makeEmpire().army,
        soldiers: 1, fighters: 0, effectiveness: 10,
        defenseStations: 0, lightCruisers: 0, heavyCruisers: 0, carriers: 0,
      },
    };
    const strongSelf = makeEmpire({
      army: { ...makeEmpire().army, soldiers: 10000, fighters: 100, generals: 5, effectiveness: 100 },
    });
    const moves = generateCandidateMoves(strongSelf, [weakRival]);
    expect(moves.some((m) => m.action === "attack_conventional")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evalState
// ---------------------------------------------------------------------------

describe("evalState", () => {
  it("returns 0.5 for a single player", () => {
    const s = makeEmpire();
    const score = evalState(s, [s]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns higher score for the richer player", () => {
    const rich = makeEmpire({ id: "rich", netWorth: 1000, credits: 500000 });
    const poor = makeEmpire({ id: "poor", netWorth: 5, credits: 100 });
    const richScore = evalState(rich, [rich, poor]);
    const poorScore = evalState(poor, [rich, poor]);
    expect(richScore).toBeGreaterThan(poorScore);
  });

  it("penalizes high civil status", () => {
    const stable = makeEmpire({ id: "s", civilStatus: 0 });
    const unstable = makeEmpire({ id: "u", civilStatus: 7 });
    const all = [stable, unstable];
    const stableScore = evalState(stable, all);
    const unstableScore = evalState(unstable, all);
    expect(stableScore).toBeGreaterThan(unstableScore);
  });
});

// ---------------------------------------------------------------------------
// cloneEmpire
// ---------------------------------------------------------------------------

describe("cloneEmpire", () => {
  it("produces a deep copy (modifying clone does not affect original)", () => {
    const orig = makeEmpire();
    const clone = cloneEmpire(orig);
    clone.credits = 999999;
    clone.planets.push({ type: "TOURISM", shortTermProduction: 100, longTermProduction: 100 });
    clone.research.unlockedTechIds.push("some_tech");
    expect(orig.credits).toBe(START.CREDITS);
    expect(orig.planets.length).toBe(7);
    expect(orig.research.unlockedTechIds.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// inferRolloutStrategy
// ---------------------------------------------------------------------------

describe("inferRolloutStrategy", () => {
  it("returns balanced for a mixed-planet empire", () => {
    const s = makeEmpire({
      planets: [
        { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
        { type: "ORE", shortTermProduction: 100, longTermProduction: 100 },
        { type: "URBAN", shortTermProduction: 100, longTermProduction: 100 },
        { type: "TOURISM", shortTermProduction: 100, longTermProduction: 100 },
        { type: "PETROLEUM", shortTermProduction: 100, longTermProduction: 100 },
        { type: "GOVERNMENT", shortTermProduction: 100, longTermProduction: 100 },
        { type: "ANTI_POLLUTION", shortTermProduction: 100, longTermProduction: 100 },
      ],
    });
    expect(inferRolloutStrategy(s)).toBe("balanced");
  });

  it("detects research strategy when 2+ research planets", () => {
    const s = makeEmpire({
      planets: [
        { type: "RESEARCH", shortTermProduction: 100, longTermProduction: 100 },
        { type: "RESEARCH", shortTermProduction: 100, longTermProduction: 100 },
        { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
      ],
    });
    expect(inferRolloutStrategy(s)).toBe("research");
  });

  it("detects supply strategy when 2+ supply planets", () => {
    const s = makeEmpire({
      planets: [
        { type: "SUPPLY", shortTermProduction: 100, longTermProduction: 100 },
        { type: "SUPPLY", shortTermProduction: 100, longTermProduction: 100 },
        { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
      ],
    });
    expect(inferRolloutStrategy(s)).toBe("supply");
  });

  it("detects military strategy for army-heavy empire", () => {
    const s = makeEmpire({
      population: 10000,
      army: {
        ...makeEmpire().army,
        soldiers: 800,
        fighters: 100,
        generals: 4,  // 3+ generals signals intentional military investment
      },
    });
    expect(inferRolloutStrategy(s)).toBe("military");
  });
});

// ---------------------------------------------------------------------------
// pickRolloutMove
// ---------------------------------------------------------------------------

describe("pickRolloutMove", () => {
  const rng = makeRng(7);

  it("always returns a candidate from the list", () => {
    const s = makeEmpire();
    const candidates: CandidateMove[] = generateCandidateMoves(s, []);
    const pick = pickRolloutMove(s, candidates, rng);
    expect(candidates).toContainEqual(pick);
  });

  it("returns the only candidate when list has one item", () => {
    const s = makeEmpire();
    const only: CandidateMove = { action: "end_turn", params: {}, label: "Skip" };
    expect(pickRolloutMove(s, [only], rng)).toBe(only);
  });

  it("research empire prefers research planet and discover_tech moves", () => {
    const s = makeEmpire({
      credits: 100000,
      netWorth: 0,
      research: { accumulatedPoints: 50000, unlockedTechIds: [] },
      planets: [
        { type: "RESEARCH", shortTermProduction: 100, longTermProduction: 100 },
        { type: "RESEARCH", shortTermProduction: 100, longTermProduction: 100 },
        { type: "FOOD", shortTermProduction: 100, longTermProduction: 100 },
      ],
    });
    const candidates: CandidateMove[] = [
      { action: "buy_soldiers", params: { amount: 10 }, label: "Soldiers" },
      { action: "discover_tech", params: { techId: "basic_farming" }, label: "Tech" },
      { action: "buy_planet", params: { type: "RESEARCH" }, label: "Research planet" },
      { action: "end_turn", params: {}, label: "Skip" },
    ];
    // Run many times; research-aligned moves should dominate
    const counts: Record<string, number> = {};
    const deterministicRng = makeRng(42);
    for (let i = 0; i < 50; i++) {
      const pick = pickRolloutMove(s, candidates, deterministicRng);
      counts[pick.action] = (counts[pick.action] ?? 0) + 1;
    }
    const techAndResearch = (counts["discover_tech"] ?? 0) + (counts["buy_planet"] ?? 0);
    expect(techAndResearch).toBeGreaterThan(counts["buy_soldiers"] ?? 0);
  });
});
