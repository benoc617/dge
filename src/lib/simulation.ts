/**
 * Simulation engine for running full games at speed without HTTP.
 * Directly calls Prisma and game-engine functions.
 * Collects per-turn per-player snapshots for analysis.
 */

import { prisma } from "./prisma";
import { processAction, type ActionType, type TurnReport } from "./game-engine";
import { generatePlanetName, START, PLANET_CONFIG, UNIT_COST, MAINT } from "./game-constants";
import { getAvailableTech } from "./research";
import * as rng from "./rng";
import { setSeed } from "./rng";
import type { PlanetType, Prisma } from "@prisma/client";
import { empireFromPrisma, type PrismaEmpireShape } from "./sim-state";
import { searchOpponentMove, buildSearchStates } from "./search-opponent";

export type EmpireForStrategySim = Prisma.EmpireGetPayload<{
  include: { planets: true; army: true; research: true; supplyRates: true };
}>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimConfig {
  /** Total turns to simulate per player */
  turns: number;
  /** Number of human-like players (use AI strategies) */
  playerCount: number;
  /** RNG seed for reproducibility (null = true random) */
  seed: number | null;
  /** How much to log: 0=silent, 1=summary, 2=per-turn, 3=verbose */
  verbosity: number;
  /** Player strategies to use */
  strategies?: SimStrategy[];
  /** Set by session harness when using a real `GameSession`. */
  turnMode?: "sequential" | "simultaneous";
  /** Door-game: full turns per empire per calendar day (session harness only). */
  actionsPerDay?: number;
}

export type SimStrategy =
  | "balanced"
  | "economy_rush"
  | "military_rush"
  | "turtle"
  | "random"
  | "research_rush"
  | "credit_leverage"
  | "growth_focus"
  | "mcts"
  | "maxn";

/** Default roster when `strategies` is omitted (one per player, cycling). */
export const DEFAULT_SIM_STRATEGIES: SimStrategy[] = [
  "balanced",
  "economy_rush",
  "military_rush",
  "turtle",
  "random",
  "research_rush",
  "credit_leverage",
  "growth_focus",
];

export interface TurnSnapshot {
  turn: number;
  playerName: string;
  credits: number;
  food: number;
  ore: number;
  fuel: number;
  population: number;
  netWorth: number;
  totalPlanets: number;
  soldiers: number;
  fighters: number;
  lightCruisers: number;
  heavyCruisers: number;
  civilStatus: number;
  action: string;
  income: number;
  expenses: number;
  popNet: number;
  events: string[];
}

export type SessionSimMeta = {
  sessionId: string;
  turnMode: "sequential" | "simultaneous";
  galaxyName: string;
};

export interface SimResult {
  config: SimConfig;
  snapshots: TurnSnapshot[];
  summary: PlayerSummary[];
  balanceWarnings: string[];
  elapsedMs: number;
  /** Present when `runSessionSimulation` created a real galaxy session. */
  sessionMeta?: SessionSimMeta;
}

export interface PlayerSummary {
  name: string;
  strategy: SimStrategy;
  finalCredits: number;
  finalPopulation: number;
  finalNetWorth: number;
  finalPlanets: number;
  peakPopulation: number;
  peakCredits: number;
  turnsPlayed: number;
  collapsed: boolean;
  collapseReason?: string;
}

// ---------------------------------------------------------------------------
// Strategy logic — decides what action to take each turn
// ---------------------------------------------------------------------------

export interface StrategyContext {
  credits: number;
  food: number;
  ore: number;
  fuel: number;
  population: number;
  taxRate: number;
  civilStatus: number;
  turnsPlayed: number;
  netWorth: number;
  planets: { type: string; count: number }[];
  totalPlanets: number;
  soldiers: number;
  generals: number;
  fighters: number;
  defenseStations: number;
  lightCruisers: number;
  heavyCruisers: number;
  carriers: number;
  covertAgents: number;
  covertPoints: number;
  effectiveness: number;
  researchPoints: number;
  unlockedTechIds: string[];
  /** All active loans with IDs — needed to call bank_repay. */
  loans: { id: string; balance: number }[];
  /** Convenience count derived from loans.length. */
  activeLoanCount: number;
  /** Current station production allocation (0-100). 0 means supply rates not configured yet. */
  supplyRateStation: number;
  /** Rivals in the same session; empty in orphan (no-session) mode. Unprotected rivals are valid PvP targets. */
  rivals: { name: string; netWorth: number; isProtected: boolean; credits: number }[];
}

export function strategyContextFromEmpire(
  empire: EmpireForStrategySim,
  loans: { id: string; balance: number }[],
  rivals: { name: string; netWorth: number; isProtected: boolean; credits: number }[] = [],
): StrategyContext {
  const army = empire.army;
  if (!army) {
    throw new Error("strategyContextFromEmpire: empire has no army");
  }
  const planetCounts: { type: string; count: number }[] = [];
  const countMap: Record<string, number> = {};
  for (const pl of empire.planets) {
    countMap[pl.type] = (countMap[pl.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(countMap)) {
    planetCounts.push({ type, count });
  }
  return {
    credits: empire.credits,
    food: empire.food,
    ore: empire.ore,
    fuel: empire.fuel,
    population: empire.population,
    taxRate: empire.taxRate,
    civilStatus: empire.civilStatus,
    turnsPlayed: empire.turnsPlayed,
    netWorth: empire.netWorth,
    planets: planetCounts,
    totalPlanets: empire.planets.length,
    soldiers: army.soldiers,
    generals: army.generals,
    fighters: army.fighters,
    defenseStations: army.defenseStations,
    lightCruisers: army.lightCruisers,
    heavyCruisers: army.heavyCruisers,
    carriers: army.carriers,
    covertAgents: army.covertAgents,
    covertPoints: army.covertPoints,
    effectiveness: army.effectiveness,
    researchPoints: empire.research?.accumulatedPoints ?? 0,
    unlockedTechIds: (empire.research?.unlockedTechIds as string[]) ?? [],
    loans,
    activeLoanCount: loans.length,
    supplyRateStation: empire.supplyRates?.rateStation ?? 0,
    rivals,
  };
}

export async function buildStrategyContextForEmpire(empireId: string): Promise<StrategyContext | null> {
  const [empire, loans] = await Promise.all([
    prisma.empire.findUnique({
      where: { id: empireId },
      include: { planets: true, army: true, research: true, supplyRates: true },
    }),
    prisma.loan.findMany({ where: { empireId }, select: { id: true, balance: true } }),
  ]);
  if (!empire?.army) return null;
  return strategyContextFromEmpire(empire, loans);
}

function countType(ctx: StrategyContext, type: string): number {
  return ctx.planets.find((p) => p.type === type)?.count ?? 0;
}

function pickAction(strategy: SimStrategy, ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  switch (strategy) {
    case "economy_rush":
      return economyStrategy(ctx, turn);
    case "military_rush":
      return militaryStrategy(ctx, turn);
    case "turtle":
      return turtleStrategy(ctx, turn);
    case "random":
      return randomStrategy(ctx);
    case "research_rush":
      return researchStrategy(ctx, turn);
    case "credit_leverage":
      return creditLeverageStrategy(ctx, turn);
    case "growth_focus":
      return growthFocusStrategy(ctx, turn);
    case "mcts":
    case "maxn":
      // Search strategies require full empire data — fall back to balanced when
      // called via the legacy StrategyContext-only path (e.g. orphan sim without shapes).
      return balancedStrategy(ctx, turn);
    case "balanced":
    default:
      return balancedStrategy(ctx, turn);
  }
}

export function pickSimAction(strategy: SimStrategy, ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> };
export function pickSimAction(
  strategy: SimStrategy,
  ctx: StrategyContext,
  turn: number,
  empireShape?: PrismaEmpireShape,
  rivalShapes?: PrismaEmpireShape[],
): { action: ActionType; params: Record<string, unknown> };
export function pickSimAction(
  strategy: SimStrategy,
  ctx: StrategyContext,
  turn: number,
  empireShape?: PrismaEmpireShape,
  rivalShapes?: PrismaEmpireShape[],
): { action: ActionType; params: Record<string, unknown> } {
  if ((strategy === "mcts" || strategy === "maxn") && empireShape) {
    const selfState = empireFromPrisma(empireShape);
    const rivalStates = (rivalShapes ?? []).map((r) => empireFromPrisma(r));
    const { states, playerIdx } = buildSearchStates(selfState, rivalStates);
    const move = searchOpponentMove(states, playerIdx, {
      strategy,
      mcts: { timeLimitMs: 200, seed: rng.getSeed() ?? undefined },
      maxn: { seed: rng.getSeed() ?? undefined },
    });
    return { action: move.action, params: move.params };
  }
  return pickAction(strategy, ctx, turn);
}

function balancedStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  // Turn 0: set up ore sell rates for income
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 50, petroleumSellRate: 50 } };

  // Early game: build economy and pop base
  if (turn < 20) {
    if (countType(ctx, "URBAN") < 4 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
    if (countType(ctx, "FOOD") < 4 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
    if (countType(ctx, "ORE") < 4 && ctx.credits >= 10000) return { action: "buy_planet", params: { type: "ORE" } };
    if (ctx.soldiers < 200 && ctx.credits >= 5600) return { action: "buy_soldiers", params: { amount: 20 } };
  }

  // Mid game: diversify and build army
  if (turn >= 20 && turn < 60) {
    if (countType(ctx, "GOVERNMENT") < 2 && ctx.credits >= 12000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };
    if (countType(ctx, "TOURISM") < 2 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "TOURISM" } };
    if (ctx.fighters < 40 && ctx.credits >= 3800) return { action: "buy_fighters", params: { amount: 10 } };
    if (ctx.lightCruisers < 20 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
    if (ctx.soldiers < 400 && ctx.credits >= 5600) return { action: "buy_soldiers", params: { amount: 20 } };
    if (countType(ctx, "ORE") < 5 && ctx.credits >= 10000) return { action: "buy_planet", params: { type: "ORE" } };
    if (ctx.soldiers > 150 && ctx.fighters > 15) return { action: "attack_pirates", params: {} };
  }

  // Late game: military and raids
  if (turn >= 60) {
    if (ctx.soldiers > 100 && ctx.fighters > 15) return { action: "attack_pirates", params: {} };
    if (ctx.soldiers < 800 && ctx.credits >= 14000) return { action: "buy_soldiers", params: { amount: 50 } };
    if (ctx.fighters < 80 && ctx.credits >= 7600) return { action: "buy_fighters", params: { amount: 20 } };
    if (ctx.lightCruisers < 40 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
  }

  return { action: "end_turn", params: {} };
}

function economyStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  // Phase 0: set sell rates and low tax on turns 0-1
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 65, petroleumSellRate: 65 } };
  if (turn === 1 && ctx.taxRate > 22) return { action: "set_tax_rate", params: { rate: 22 } };

  const govPlanets = countType(ctx, "GOVERNMENT");

  // Phase 1 (turns 2-20): build income foundation + unlock military
  // Government first — needed for generals which unlock pirate raids
  if (govPlanets < 2 && ctx.credits >= 12000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };
  // Ore + food for resource income and sustainability
  if (countType(ctx, "ORE")  < 4 && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "FOOD") < 3 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
  // Petroleum: needed to fuel fighters/LCs without ore drain
  if (countType(ctx, "PETROLEUM") < 1 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "PETROLEUM" } };
  // Urban for population tax and housing
  if (countType(ctx, "URBAN") < 4 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
  // Tourism: pure credit income, no maintenance weight
  if (countType(ctx, "TOURISM") < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };

  // Generals: unlock attacks as soon as gov planet exists
  if (govPlanets >= 1 && ctx.generals < govPlanets * 4 && ctx.credits >= 3120) {
    return { action: "buy_generals", params: { amount: Math.min(4, govPlanets * 4 - ctx.generals) } };
  }

  // Sustainability floor: estimate ~2500 credits/turn planet maintenance; require 6 turns of buffer
  // before spending on military so planet collapse can't happen from a single purchase chain.
  const maintFloor = ctx.totalPlanets * 2500 + 30000;

  // Phase 2 (turn 18+): military buildup — only when credit buffer covers maintenance
  if (turn >= 18 && ctx.credits >= maintFloor) {
    if (ctx.soldiers   < 200  && ctx.credits >= 5600)  return { action: "buy_soldiers",      params: { amount: 20 } };
    if (ctx.fighters   < 30   && ctx.credits >= 3800)  return { action: "buy_fighters",      params: { amount: 10 } };
    if (ctx.lightCruisers < 20 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
  }

  // Pirate raids for supplemental income + effectiveness — start as soon as general + soldiers ready
  if (ctx.generals >= 1 && ctx.soldiers > 80 && turn >= 20) {
    return { action: "attack_pirates", params: {} };
  }

  // Phase 3 (turn 45+): aggressive military scaling for NW compounding
  if (turn >= 45 && ctx.credits >= maintFloor) {
    if (ctx.soldiers      < 800  && ctx.credits >= 11200)  return { action: "buy_soldiers",       params: { amount: 40 } };
    if (ctx.fighters      < 80   && ctx.credits >= 7600)   return { action: "buy_fighters",       params: { amount: 20 } };
    if (ctx.lightCruisers < 60   && ctx.credits >= 9500)   return { action: "buy_light_cruisers", params: { amount: 10 } };
    if (ctx.heavyCruisers < 20   && ctx.credits >= 19000)  return { action: "buy_heavy_cruisers", params: { amount: 10 } };
    // Keep expanding income base for ongoing military purchases
    if (countType(ctx, "ORE")     < 7  && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
    if (countType(ctx, "TOURISM") < 6  && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };
    if (countType(ctx, "URBAN")   < 7  && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
    // Pirate raids whenever not buying
    if (ctx.generals >= 1 && ctx.soldiers > 200) return { action: "attack_pirates", params: {} };
  }

  return { action: "end_turn", params: {} };
}

function militaryStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 60, petroleumSellRate: 60 } };
  if (turn === 1) return { action: "set_tax_rate", params: { rate: 20 } };

  // Economic foundation first (turns 2-10)
  if (turn < 10) {
    if (countType(ctx, "ORE") < 4 && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
    if (countType(ctx, "FOOD") < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "FOOD" } };
    if (countType(ctx, "URBAN") < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "URBAN" } };
    if (countType(ctx, "GOVERNMENT") < 2 && ctx.credits >= 13000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };
  }

  // Military buildup (continuous)
  if (ctx.generals < 6 && ctx.credits >= 3120) return { action: "buy_generals", params: { amount: 4 } };

  // Buy covert agents early for espionage softening (gov planets cap the total; buy a small cadre)
  const govPlanets = countType(ctx, "GOVERNMENT");
  if (govPlanets >= 1 && ctx.covertAgents < 5 && ctx.credits >= 10000) {
    return { action: "buy_covert_agents", params: { amount: 5 } };
  }

  if (ctx.soldiers < 500 && ctx.credits >= 8400) return { action: "buy_soldiers", params: { amount: 30 } };
  if (ctx.fighters < 80 && ctx.credits >= 7600) return { action: "buy_fighters", params: { amount: 20 } };
  if (ctx.lightCruisers < 30 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
  if (ctx.heavyCruisers < 10 && ctx.credits >= 19000) return { action: "buy_heavy_cruisers", params: { amount: 10 } };

  // PvP: after protection expires (turn 16+), attack weakest unprotected rival.
  // While building forces, soften targets with bombing (op 4 = destroys 30% food supply).
  const pvpTarget = ctx.rivals
    .filter((r) => !r.isProtected)
    .sort((a, b) => a.netWorth - b.netWorth)[0];
  if (pvpTarget && turn >= 16) {
    // Covert softening: bomb food supply while building up for conventional assault
    if (ctx.covertAgents > 0 && ctx.covertPoints >= 1 && ctx.soldiers < 300) {
      return { action: "covert_op", params: { target: pvpTarget.name, opType: 4 } };
    }
    // Conventional assault once ground + space forces are combat-ready
    if (ctx.soldiers >= 300 && ctx.fighters >= 40) {
      return { action: "attack_conventional", params: { target: pvpTarget.name } };
    }
  }

  // Raid pirates whenever strong enough (income + effectiveness gains)
  if (ctx.soldiers > 100 && ctx.fighters > 10) return { action: "attack_pirates", params: {} };

  // Continue expanding military
  if (ctx.soldiers < 2000 && ctx.credits >= 14000) return { action: "buy_soldiers", params: { amount: 50 } };
  if (ctx.fighters < 200 && ctx.credits >= 7600) return { action: "buy_fighters", params: { amount: 20 } };
  if (ctx.lightCruisers < 60 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
  if (ctx.heavyCruisers < 20 && ctx.credits >= 19000) return { action: "buy_heavy_cruisers", params: { amount: 10 } };

  return { action: "end_turn", params: {} };
}

function turtleStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 70, petroleumSellRate: 70 } };
  if (turn === 1 && ctx.taxRate > 25) return { action: "set_tax_rate", params: { rate: 25 } };

  // Rough per-turn income estimate from ore, tourism, urban+population (credits units).
  // BASE_ORE_PRICE(120)/SELL_RATIO_DIVISOR(1.2)*ORE.baseProduction(125)*sellRate(70%)=8750/planet.
  // TOURISM.baseProduction = 8000/planet. URBAN tax ≈ 1200/planet + population*taxRate*0.002.
  const oreIncome  = countType(ctx, "ORE")     * 8750;
  const tourIncome = countType(ctx, "TOURISM") * 7500;
  const urbIncome  = countType(ctx, "URBAN")   * 1200 + Math.floor(ctx.population * ctx.taxRate * 0.002);
  const incomeEst  = oreIncome + tourIncome + urbIncome;
  const stationMaint = ctx.defenseStations * MAINT.STATION;
  const freeIncome   = Math.max(0, incomeEst - stationMaint);

  // Economy foundation — ore and tourism are the money-makers; food/urban sustain population.
  if (countType(ctx, "FOOD")    < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "FOOD" } };
  if (countType(ctx, "ORE")     < 4 && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "TOURISM") < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };
  if (countType(ctx, "URBAN")   < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "URBAN" } };
  if (countType(ctx, "GOVERNMENT") < 2 && ctx.credits >= 13000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };

  // Mass station purchases: spend most of credits when income can sustain the maintenance.
  // Buy in large batches — the whole point of the turtle is a massive station wall.
  if (freeIncome >= 10000 && ctx.credits >= 26000) {
    const sustainable = Math.floor(freeIncome / MAINT.STATION);                          // how many more we can afford to maintain
    const affordable  = Math.floor(ctx.credits * 0.75 / UNIT_COST.DEFENSE_STATION);      // spend 75% of credits
    const buyCount    = Math.min(sustainable, affordable, 2000);                          // hard cap so one action isn't absurd
    if (buyCount >= 5) return { action: "buy_stations", params: { amount: buyCount } };
  }

  // Keep building income planets as long as economy can still grow.
  if (countType(ctx, "ORE")     < 7  && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "TOURISM") < 6  && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };
  if (countType(ctx, "URBAN")   < 6  && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "URBAN" } };

  // Minimum fighters for pirate raids (income supplement, not primary goal).
  if (ctx.fighters < 20 && ctx.credits >= 3800) return { action: "buy_fighters", params: { amount: 10 } };
  if (ctx.fighters >= 15) return { action: "attack_pirates", params: {} };

  // Any leftover credits → more stations.
  if (ctx.credits >= UNIT_COST.DEFENSE_STATION * 10) {
    const buyCount = Math.max(10, Math.floor(ctx.credits * 0.7 / UNIT_COST.DEFENSE_STATION));
    return { action: "buy_stations", params: { amount: buyCount } };
  }

  return { action: "end_turn", params: {} };
}

function randomStrategy(ctx: StrategyContext): { action: ActionType; params: Record<string, unknown> } {
  const actions: { action: ActionType; params: Record<string, unknown> }[] = [
    { action: "end_turn", params: {} },
    { action: "end_turn", params: {} },
    { action: "buy_soldiers", params: { amount: 10 } },
    { action: "buy_fighters", params: { amount: 5 } },
    { action: "buy_light_cruisers", params: { amount: 5 } },
    { action: "buy_planet", params: { type: "ORE" } },
    { action: "buy_planet", params: { type: "FOOD" } },
    { action: "buy_planet", params: { type: "URBAN" } },
    { action: "attack_pirates", params: {} },
    { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 50, petroleumSellRate: 50 } },
  ];
  return actions[Math.floor(rng.random() * actions.length)];
}

function researchStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 55, petroleumSellRate: 55 } };
  if (turn === 1 && ctx.taxRate > 22) return { action: "set_tax_rate", params: { rate: 22 } };

  // Spend research points as soon as affordable — pick cheapest unlocked tech first
  const available = getAvailableTech(ctx.unlockedTechIds);
  const affordable = available
    .filter((t) => ctx.researchPoints >= t.cost)
    .sort((a, b) => a.cost - b.cost);
  if (affordable.length > 0) {
    return { action: "discover_tech", params: { techId: affordable[0].id } };
  }

  // Economy foundation: food first (must match pop growth), then ore/tourism/urban/government
  if (countType(ctx, "FOOD") < 5 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
  if (countType(ctx, "ORE") < 4 && ctx.credits >= 10000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "URBAN") < 3 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
  if (countType(ctx, "TOURISM") < 2 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "TOURISM" } };
  if (countType(ctx, "GOVERNMENT") < 2 && ctx.credits >= 12000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };
  // Petroleum: 1 planet covers all fuel needs for fighters + light cruisers
  if (countType(ctx, "PETROLEUM") < 1 && ctx.credits >= 20000) return { action: "buy_planet", params: { type: "PETROLEUM" } };

  // Minimum military for pirate raids; start raiding at turn 25
  if (ctx.soldiers < 200 && ctx.credits >= 5600) return { action: "buy_soldiers", params: { amount: 20 } };
  if (ctx.fighters < 20 && ctx.credits >= 3800) return { action: "buy_fighters", params: { amount: 10 } };
  if (turn > 25 && ctx.soldiers > 80 && ctx.fighters > 8) return { action: "attack_pirates", params: {} };

  // Research labs: buy up to 6 once economy foundation is solid (50K threshold ensures income backing).
  // Each lab costs ~1,600 cr/turn maintenance; 6 labs = ~9,600/turn — sustainable on 50K+ income.
  if (countType(ctx, "RESEARCH") < 6 && ctx.credits >= 50000 && ctx.civilStatus <= 3) {
    return { action: "buy_planet", params: { type: "RESEARCH" } };
  }

  // Late game: convert accumulated credits into NW — military and more economy planets
  if (turn > 60) {
    if (ctx.soldiers < 600 && ctx.credits >= 11200) return { action: "buy_soldiers", params: { amount: 40 } };
    if (ctx.fighters < 50 && ctx.credits >= 7600) return { action: "buy_fighters", params: { amount: 20 } };
    if (ctx.lightCruisers < 20 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 10 } };
  }

  return { action: "end_turn", params: {} };
}

function creditLeverageStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  // Phase 0: sell rates + tax
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 60, petroleumSellRate: 60 } };
  if (turn === 1 && ctx.taxRate > 22) return { action: "set_tax_rate", params: { rate: 22 } };

  const govPlanets = countType(ctx, "GOVERNMENT");

  // PRIORITY: repay outstanding loans before they compound into a death spiral.
  // 25% interest/turn is brutal — partial repayment is fine (engine clamps to credits).
  // Keep a 50k operating buffer; funnel everything else at the highest-balance loan.
  if (ctx.loans.length > 0 && ctx.credits > 50000) {
    const worstLoan = ctx.loans.reduce((a, b) => (a.balance >= b.balance ? a : b));
    return { action: "bank_repay", params: { loanId: worstLoan.id } };
  }

  // Phase 1 (turns 2-10): single bootstrap loan when broke and no active debt.
  // Take it only once — repayment logic above will clear it within a turn or two.
  if (ctx.loans.length === 0 && ctx.credits < 30000 && turn >= 2 && turn <= 10) {
    return { action: "bank_loan", params: { amount: 100000 } };
  }

  // Core income foundation — spend loan capital on high-yield planets quickly
  if (govPlanets < 2 && ctx.credits >= 12000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };
  if (countType(ctx, "ORE")        < 4 && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "FOOD")       < 3 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
  if (countType(ctx, "PETROLEUM")  < 1 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "PETROLEUM" } };
  if (countType(ctx, "URBAN")      < 4 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
  if (countType(ctx, "TOURISM")    < 3 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };

  // Generals: unlock pirate income ASAP — check for debt-free window
  if (ctx.loans.length === 0 && govPlanets >= 1 && ctx.generals < govPlanets * 4 && ctx.credits >= 3120) {
    return { action: "buy_generals", params: { amount: Math.min(4, govPlanets * 4 - ctx.generals) } };
  }

  // Bonds: invest surplus when debt-free — +10% return in 30 turns beats cash-idle
  if (ctx.loans.length === 0 && ctx.credits >= 150000 && turn >= 20 && turn < 60) {
    return { action: "buy_bond", params: { amount: 50000 } };
  }

  // Phase 2 (turn 22+): military NW buildup — only when debt-free and credit buffer healthy
  if (turn >= 22 && ctx.loans.length === 0 && ctx.credits >= 80000) {
    if (ctx.soldiers      < 200 && ctx.credits >= 5600)  return { action: "buy_soldiers",       params: { amount: 20 } };
    if (ctx.fighters      < 25  && ctx.credits >= 3800)  return { action: "buy_fighters",       params: { amount: 10 } };
    if (ctx.lightCruisers < 20  && ctx.credits >= 9500)  return { action: "buy_light_cruisers", params: { amount: 10 } };
  }

  // Pirate raids once military is ready — key income supplement
  if (ctx.loans.length === 0 && ctx.generals >= 1 && ctx.soldiers > 100 && turn >= 25) {
    return { action: "attack_pirates", params: {} };
  }

  // Phase 3 (turn 45+): aggressive scaling — income base is stable
  if (turn >= 45 && ctx.loans.length === 0 && ctx.credits >= 100000) {
    if (ctx.soldiers      < 1000 && ctx.credits >= 11200)  return { action: "buy_soldiers",       params: { amount: 40 } };
    if (ctx.fighters      < 100  && ctx.credits >= 7600)   return { action: "buy_fighters",       params: { amount: 20 } };
    if (ctx.lightCruisers < 80   && ctx.credits >= 9500)   return { action: "buy_light_cruisers", params: { amount: 10 } };
    if (ctx.heavyCruisers < 20   && ctx.credits >= 19000)  return { action: "buy_heavy_cruisers", params: { amount: 10 } };
    if (countType(ctx, "ORE")     < 7 && ctx.credits >= 11000) return { action: "buy_planet", params: { type: "ORE" } };
    if (countType(ctx, "TOURISM") < 6 && ctx.credits >= 15000) return { action: "buy_planet", params: { type: "TOURISM" } };
    if (countType(ctx, "URBAN")   < 7 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
    if (ctx.generals >= 1 && ctx.soldiers > 200) return { action: "attack_pirates", params: {} };
  }

  return { action: "end_turn", params: {} };
}

function growthFocusStrategy(ctx: StrategyContext, turn: number): { action: ActionType; params: Record<string, unknown> } {
  if (turn === 0) return { action: "set_sell_rates", params: { foodSellRate: 0, oreSellRate: 55, petroleumSellRate: 55 } };
  if (turn === 1 && ctx.taxRate > 18) return { action: "set_tax_rate", params: { rate: 18 } };

  // Core growth planets — food + urban + education for exponential pop
  if (countType(ctx, "FOOD") < 5 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
  if (countType(ctx, "URBAN") < 5 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
  if (countType(ctx, "EDUCATION") < 3 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "EDUCATION" } };

  // Income backbone: ORE + TOURISM to sustain expanding maintenance costs
  if (countType(ctx, "ORE") < 3 && ctx.credits >= 10000) return { action: "buy_planet", params: { type: "ORE" } };
  if (countType(ctx, "TOURISM") < 3 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "TOURISM" } };

  // Government: reduces imperial overhead and unlocks covert agents
  if (countType(ctx, "GOVERNMENT") < 2 && ctx.credits >= 12000) return { action: "buy_planet", params: { type: "GOVERNMENT" } };

  // Minimum military for pirate raids; start raiding at turn 25 for income supplement
  if (ctx.soldiers < 100 && ctx.credits >= 5600) return { action: "buy_soldiers", params: { amount: 20 } };
  if (ctx.fighters < 15 && ctx.credits >= 1900) return { action: "buy_fighters", params: { amount: 5 } };
  if (turn > 25 && ctx.soldiers > 80 && ctx.fighters > 8) return { action: "attack_pirates", params: {} };

  // Continue scaling all income and growth vectors
  if (countType(ctx, "FOOD") < 8 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "FOOD" } };
  if (countType(ctx, "URBAN") < 8 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "URBAN" } };
  if (countType(ctx, "TOURISM") < 6 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "TOURISM" } };
  if (countType(ctx, "EDUCATION") < 5 && ctx.credits >= 14000) return { action: "buy_planet", params: { type: "EDUCATION" } };

  // Light cruisers for better pirate yield from turn 35
  if (turn > 35 && ctx.lightCruisers < 15 && ctx.credits >= 9500) return { action: "buy_light_cruisers", params: { amount: 5 } };

  return { action: "end_turn", params: {} };
}

// ---------------------------------------------------------------------------
// Main simulation runner
// ---------------------------------------------------------------------------

export async function runSimulation(config: SimConfig): Promise<SimResult> {
  const startTime = Date.now();
  const snapshots: TurnSnapshot[] = [];
  const balanceWarnings: string[] = [];

  // Set seed
  setSeed(config.seed);

  // Ensure market exists
  const marketCount = await prisma.market.count();
  if (marketCount === 0) await prisma.market.create({ data: {} });

  // Create players
  const strategies: SimStrategy[] = config.strategies ?? DEFAULT_SIM_STRATEGIES.slice(0, config.playerCount);

  const playerIds: { id: string; playerId: string; name: string; strategy: SimStrategy }[] = [];

  for (let i = 0; i < config.playerCount; i++) {
    const strategy = strategies[i % strategies.length];
    const name = `Sim_${strategy}_${i}`;

    const existing = await prisma.player.findFirst({
      where: { name, gameSessionId: null },
      include: { empire: true },
    });
    if (existing?.empire) {
      playerIds.push({ id: existing.empire.id, playerId: existing.id, name, strategy });
      continue;
    }
    if (existing) {
      await prisma.player.delete({ where: { id: existing.id } });
    }

    const planetCreateData = START.PLANETS.flatMap((spec) =>
      Array.from({ length: spec.count }, () => ({
        name: generatePlanetName(),
        sector: rng.randomInt(1, 100),
        type: spec.type as PlanetType,
        longTermProduction: 100,
        shortTermProduction: 100,
      })),
    );

    const player = await prisma.player.create({
      data: {
        name,
        empire: {
          create: {
            credits: START.CREDITS,
            food: START.FOOD,
            ore: START.ORE,
            fuel: START.FUEL,
            population: START.POPULATION,
            taxRate: START.TAX_RATE,
            turnsLeft: config.turns,
            protectionTurns: START.PROTECTION_TURNS,
            planets: { create: planetCreateData },
            army: {
              create: {
                soldiers: START.SOLDIERS,
                generals: START.GENERALS,
                fighters: START.FIGHTERS,
              },
            },
            supplyRates: { create: {} },
            research: { create: {} },
          },
        },
      },
      include: { empire: true },
    });

    playerIds.push({ id: player.empire!.id, playerId: player.id, name, strategy });
  }

  if (config.verbosity >= 1) {
    console.log(`\n=== SRX SIMULATION ===`);
    console.log(`Players: ${config.playerCount} | Turns: ${config.turns} | Seed: ${config.seed ?? "random"}`);
    console.log(`Strategies: ${playerIds.map((p) => `${p.name}(${p.strategy})`).join(", ")}`);
    console.log(`========================\n`);
  }

  // Run turns
  for (let turn = 0; turn < config.turns; turn++) {
    for (const p of playerIds) {
      // Fetch current state for strategy decisions
      const [empire, loans] = await Promise.all([
        prisma.empire.findUnique({
          where: { id: p.id },
          include: { planets: true, army: true, research: true, supplyRates: true },
        }),
        prisma.loan.findMany({ where: { empireId: p.id }, select: { id: true, balance: true } }),
      ]);

      if (!empire || !empire.army || empire.turnsLeft < 1) continue;
      if (empire.population < 10) continue;

      const ctx = strategyContextFromEmpire(empire, loans);

      const { action, params } = pickSimAction(
        p.strategy,
        ctx,
        turn,
        (p.strategy === "mcts" || p.strategy === "maxn") ? (empire as unknown as PrismaEmpireShape) : undefined,
        undefined, // orphan sim has no session rivals
      );

      const result = await processAction(p.playerId, action, params);

      const report = result.turnReport;

      const snapshot: TurnSnapshot = {
        turn,
        playerName: p.name,
        credits: empire.credits + (report?.income.total ?? 0) - (report?.expenses.total ?? 0),
        food: empire.food,
        ore: empire.ore,
        fuel: empire.fuel,
        population: report?.population.newTotal ?? empire.population,
        netWorth: report?.netWorth ?? empire.netWorth,
        totalPlanets: empire.planets.length,
        soldiers: empire.army.soldiers,
        fighters: empire.army.fighters,
        lightCruisers: empire.army.lightCruisers,
        heavyCruisers: empire.army.heavyCruisers,
        civilStatus: empire.civilStatus,
        action,
        income: report?.income.total ?? 0,
        expenses: report?.expenses.total ?? 0,
        popNet: report?.population.net ?? 0,
        events: report?.events ?? [],
      };

      snapshots.push(snapshot);

      if (config.verbosity >= 2) {
        console.log(
          `T${String(turn).padStart(3)} ${p.name.padEnd(24)} ${action.padEnd(20)} ` +
          `Cr:${snapshot.credits.toLocaleString().padStart(10)} Pop:${snapshot.population.toLocaleString().padStart(10)} ` +
          `NW:${snapshot.netWorth.toString().padStart(5)} Pl:${snapshot.totalPlanets} ` +
          `I:${snapshot.income.toLocaleString().padStart(8)} E:${snapshot.expenses.toLocaleString().padStart(8)} ` +
          `${snapshot.events.length > 0 ? "! " + snapshot.events[0] : ""}`
        );
      }
    }

    if (config.verbosity >= 1 && (turn + 1) % 25 === 0) {
      console.log(`--- Turn ${turn + 1} complete ---`);
    }
  }

  const { summary, balanceWarnings: bw } = await finalizeSimSummaries(config, snapshots, playerIds);
  balanceWarnings.push(...bw);

  const elapsedMs = Date.now() - startTime;

  return { config, snapshots, summary, balanceWarnings, elapsedMs };
}

export async function finalizeSimSummaries(
  _config: SimConfig,
  snapshots: TurnSnapshot[],
  playerIds: { id: string; playerId: string; name: string; strategy: SimStrategy }[],
): Promise<{ summary: PlayerSummary[]; balanceWarnings: string[] }> {
  const summary: PlayerSummary[] = [];
  const balanceWarnings: string[] = [];

  for (const p of playerIds) {
    const empire = await prisma.empire.findUnique({
      where: { id: p.id },
      include: { planets: true, army: true },
    });

    const playerSnaps = snapshots.filter((s) => s.playerName === p.name);
    const peakPop = Math.max(0, ...playerSnaps.map((s) => s.population));
    const peakCr = Math.max(0, ...playerSnaps.map((s) => s.credits));

    const collapsed = (empire?.population ?? 0) < 10 || (empire?.planets.length ?? 0) === 0;

    summary.push({
      name: p.name,
      strategy: p.strategy,
      finalCredits: empire?.credits ?? 0,
      finalPopulation: empire?.population ?? 0,
      finalNetWorth: empire?.netWorth ?? 0,
      finalPlanets: empire?.planets.length ?? 0,
      peakPopulation: peakPop,
      peakCredits: peakCr,
      turnsPlayed: empire?.turnsPlayed ?? 0,
      collapsed,
      collapseReason: collapsed
        ? (empire?.population ?? 0) < 10
          ? "population_extinct"
          : "no_planets"
        : undefined,
    });
  }

  for (const s of summary) {
    if (s.collapsed && s.turnsPlayed < 20) {
      balanceWarnings.push(`${s.name} (${s.strategy}) collapsed by turn ${s.turnsPlayed} — early game may be too punishing.`);
    }
    if (s.finalPopulation > 10_000_000) {
      balanceWarnings.push(`${s.name} (${s.strategy}) has ${s.finalPopulation.toLocaleString()} pop — possible runaway growth.`);
    }
    if (s.finalCredits > 50_000_000) {
      balanceWarnings.push(`${s.name} (${s.strategy}) has ${s.finalCredits.toLocaleString()} credits — economy may be too generous.`);
    }
    if (s.peakPopulation > 0 && s.finalPopulation < s.peakPopulation * 0.1) {
      balanceWarnings.push(`${s.name} (${s.strategy}) lost 90%+ of peak population — death spiral detected.`);
    }
  }

  return { summary, balanceWarnings };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function printSimReport(result: SimResult): void {
  const { summary, balanceWarnings, config, elapsedMs, snapshots } = result;

  console.log(`\n${"=".repeat(80)}`);
  console.log(`  SRX SIMULATION REPORT`);
  console.log(`${"=".repeat(80)}`);
  const modeLine =
    config.turnMode != null
      ? ` | Mode: ${config.turnMode}${config.actionsPerDay != null ? ` (apd=${config.actionsPerDay})` : ""}`
      : "";
  console.log(
    `  Turns: ${config.turns} | Players: ${config.playerCount} | Seed: ${config.seed ?? "random"}${modeLine}`,
  );
  if (result.sessionMeta) {
    console.log(
      `  Galaxy: ${result.sessionMeta.galaxyName} (${result.sessionMeta.turnMode}) — session deleted after run`,
    );
  }
  console.log(`  Elapsed: ${(elapsedMs / 1000).toFixed(2)}s | Turns/sec: ${(config.turns * config.playerCount / (elapsedMs / 1000)).toFixed(0)}`);
  console.log(`  Total snapshots: ${snapshots.length}\n`);

  // Player summaries
  console.log("  FINAL STANDINGS:");
  console.log("  " + "-".repeat(76));
  console.log(
    "  " +
    "Player".padEnd(26) +
    "Strategy".padEnd(14) +
    "NW".padStart(8) +
    "Pop".padStart(12) +
    "Credits".padStart(12) +
    "Planets".padStart(8) +
    "Status".padStart(10),
  );
  console.log("  " + "-".repeat(76));

  const sorted = [...summary].sort((a, b) => b.finalNetWorth - a.finalNetWorth);
  for (const s of sorted) {
    console.log(
      "  " +
      s.name.padEnd(26) +
      s.strategy.padEnd(14) +
      s.finalNetWorth.toString().padStart(8) +
      s.finalPopulation.toLocaleString().padStart(12) +
      s.finalCredits.toLocaleString().padStart(12) +
      s.finalPlanets.toString().padStart(8) +
      (s.collapsed ? " DEAD" : " OK").padStart(10),
    );
  }

  // Per-player trajectory (every 10 turns)
  console.log(`\n  ECONOMY TRAJECTORY (every 10 turns):`);
  for (const s of sorted) {
    if (s.collapsed && s.turnsPlayed < 5) continue;
    const playerSnaps = snapshots.filter((sn) => sn.playerName === s.name);
    const milestones = playerSnaps.filter((sn) => sn.turn % 10 === 0 || sn.turn === config.turns - 1);
    console.log(`\n  ${s.name} (${s.strategy}):`);
    console.log("  " + "Turn".padStart(6) + "Credits".padStart(12) + "Pop".padStart(12) + "NW".padStart(8) + "Planets".padStart(8) + "Income".padStart(10) + "Expenses".padStart(10) + "PopNet".padStart(10));
    for (const m of milestones) {
      console.log(
        "  " +
        m.turn.toString().padStart(6) +
        m.credits.toLocaleString().padStart(12) +
        m.population.toLocaleString().padStart(12) +
        m.netWorth.toString().padStart(8) +
        m.totalPlanets.toString().padStart(8) +
        m.income.toLocaleString().padStart(10) +
        m.expenses.toLocaleString().padStart(10) +
        (m.popNet >= 0 ? "+" : "") + m.popNet.toLocaleString().padStart(9),
      );
    }
  }

  // Balance warnings
  if (balanceWarnings.length > 0) {
    console.log(`\n  BALANCE WARNINGS (${balanceWarnings.length}):`);
    for (const w of balanceWarnings) {
      console.log(`  ⚠ ${w}`);
    }
  } else {
    console.log(`\n  No balance warnings detected.`);
  }

  console.log(`\n${"=".repeat(80)}\n`);
}

// ---------------------------------------------------------------------------
// CSV export for external analysis
// ---------------------------------------------------------------------------

export function snapshotsToCSV(snapshots: TurnSnapshot[]): string {
  const headers = [
    "turn", "player", "credits", "food", "ore", "fuel", "population",
    "netWorth", "totalPlanets", "soldiers", "fighters", "lightCruisers",
    "heavyCruisers", "civilStatus", "action", "income", "expenses", "popNet",
  ];
  const rows = snapshots.map((s) => [
    s.turn, s.playerName, s.credits, s.food, s.ore, s.fuel, s.population,
    s.netWorth, s.totalPlanets, s.soldiers, s.fighters, s.lightCruisers,
    s.heavyCruisers, s.civilStatus, s.action, s.income, s.expenses, s.popNet,
  ].join(","));
  return [headers.join(","), ...rows].join("\n");
}
