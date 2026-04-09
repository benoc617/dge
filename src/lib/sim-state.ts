/**
 * Pure in-memory game state for search algorithms (MCTS, MaxN).
 *
 * No async, no DB, no global RNG mutation — everything is passed in or returned.
 * This is a faithful port of the key logic in game-engine.ts / processTurnTick,
 * using deterministic formulas (no alterNumber variance) so the search tree is
 * reproducible given a fixed RNG seed.
 *
 * Simplifications vs the real engine:
 * - Market ratios are fixed at 1.0 (no coordinator pool or dynamic pricing)
 * - No TurnLog / GameEvent writes
 * - No planet names / sectors (just type + production)
 * - Random events use the caller-supplied rng, not the global mulberry32 state
 * - Supply planets: simplified (no per-rate breakdown)
 * - Research production effects (food_bonus etc.) boost longTermProduction inline
 */

import {
  PLANET_CONFIG,
  UNIT_COST,
  MAINT,
  ECON,
  MIL,
  FINANCE,
  DEFICIT,
  NETWORTH,
  POLLUTION,
  COMBAT,
  POP,
  ACTIONS_PER_DAY,
  START,
  COST_INFLATION,
  getTaxBirthMultiplier,
  CIVIL_DESERTION_RATE_PER_LEVEL,
  RANDOM_EVENT_CHANCE,
  type PlanetTypeName,
} from "./game-constants";
import { getAvailableTech, getTech } from "./research";
import type { ActionType } from "./game-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PureArmyState {
  soldiers: number;
  generals: number;
  fighters: number;
  defenseStations: number;
  lightCruisers: number;
  heavyCruisers: number;
  carriers: number;
  covertAgents: number;
  commandShipStrength: number;
  effectiveness: number;
  covertPoints: number;
  // Tier levels (1 or 2, default 1)
  soldiersLevel: number;
  fightersLevel: number;
  stationsLevel: number;
  lightCruisersLevel: number;
  heavyCruisersLevel: number;
}

export interface PurePlanetState {
  type: PlanetTypeName;
  shortTermProduction: number;
  longTermProduction: number;
}

export interface PureResearchState {
  accumulatedPoints: number;
  unlockedTechIds: string[];
}

export interface PureSupplyRates {
  rateSoldier: number;
  rateFighter: number;
  rateStation: number;
  rateHeavyCruiser: number;
  rateCarrier: number;
  rateGeneral: number;
  rateCovert: number;
  rateCredits: number;
}

export interface PureEmpireState {
  id: string;
  name: string;
  credits: number;
  food: number;
  ore: number;
  fuel: number;
  population: number;
  taxRate: number;
  civilStatus: number;
  netWorth: number;
  turnsLeft: number;
  turnsPlayed: number;
  isProtected: boolean;
  protectionTurns: number;
  foodSellRate: number;
  oreSellRate: number;
  petroleumSellRate: number;
  planets: PurePlanetState[];
  army: PureArmyState;
  research: PureResearchState;
  supplyRates: PureSupplyRates;
  loans: number;
}

/** Minimal "other player" view used when computing rival interactions. */
export interface RivalView {
  id: string;
  name: string;
  netWorth: number;
  isProtected: boolean;
  credits: number;
  population: number;
  planets: PurePlanetState[];
  army: PureArmyState;
}

// ---------------------------------------------------------------------------
// RNG helpers (local, non-mutating)
// ---------------------------------------------------------------------------

/** Simple mulberry32 seeded RNG that does NOT touch global state. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Deep clone
// ---------------------------------------------------------------------------

export function cloneEmpire(s: PureEmpireState): PureEmpireState {
  return {
    ...s,
    planets: s.planets.map((p) => ({ ...p })),
    army: { ...s.army },
    research: { ...s.research, unlockedTechIds: [...s.research.unlockedTechIds] },
    supplyRates: { ...s.supplyRates },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countType(planets: PurePlanetState[], type: PlanetTypeName): number {
  return planets.filter((p) => p.type === type).length;
}

function avgShortTermProd(planets: PurePlanetState[], type: PlanetTypeName): number {
  const ps = planets.filter((p) => p.type === type);
  if (ps.length === 0) return 100;
  return ps.reduce((s, p) => s + p.shortTermProduction, 0) / ps.length;
}

function sumShortTermProd(planets: PurePlanetState[], type: PlanetTypeName): number {
  return planets.filter((p) => p.type === type).reduce((s, p) => s + p.shortTermProduction, 0);
}

function getTechBonuses(unlockedIds: string[]): {
  planetMaintReduction: number;
  creditsBonus: number;
  popGrowthBonus: number;
  civilUnrestReduction: number;
} {
  let planetMaintReduction = 0;
  let creditsBonus = 0;
  let popGrowthBonus = 0;
  let civilUnrestReduction = 0;
  for (const id of unlockedIds) {
    const tech = getTech(id);
    if (!tech) continue;
    const eff = tech.effect;
    if (eff.type === "planet_maint_reduction") planetMaintReduction += eff.percent;
    else if (eff.type === "credits_bonus") creditsBonus += eff.percent;
    else if (eff.type === "pop_growth_bonus") popGrowthBonus += eff.percent;
    else if (eff.type === "civil_unrest_reduction") civilUnrestReduction += eff.percent;
  }
  return { planetMaintReduction, creditsBonus, popGrowthBonus, civilUnrestReduction };
}

function computeNetWorth(s: PureEmpireState): number {
  return Math.floor(
    s.population * NETWORTH.POPULATION +
    s.credits * NETWORTH.CREDITS +
    s.planets.length * NETWORTH.PLANETS +
    s.army.soldiers * NETWORTH.SOLDIER +
    s.army.fighters * NETWORTH.FIGHTER +
    s.army.defenseStations * NETWORTH.STATION +
    s.army.lightCruisers * NETWORTH.LIGHT_CRUISER +
    s.army.heavyCruisers * NETWORTH.HEAVY_CRUISER +
    s.army.carriers * NETWORTH.CARRIER +
    s.army.generals * NETWORTH.GENERAL +
    s.army.covertAgents * NETWORTH.COVERT,
  );
}

// ---------------------------------------------------------------------------
// applyTick — pure deterministic port of processTurnTick
// ---------------------------------------------------------------------------

/**
 * Apply one economy tick to a PureEmpireState without touching the DB.
 * Stochastic elements (production variance, random events) use the supplied
 * RNG so search trees can control determinism.
 *
 * @param s         Empire state before the tick
 * @param rng       RNG function (use makeRng for deterministic, Math.random for live)
 * @param playerCount  Approximate player count for galactic redistribution (default 3)
 */
export function applyTick(
  s: PureEmpireState,
  rng: () => number = Math.random,
  playerCount = 3,
  decrementTurns = true,
): PureEmpireState {
  const n = cloneEmpire(s);
  const planets = n.planets;
  const army = n.army;
  const unlockedIds = n.research.unlockedTechIds;

  // --- Tech bonuses ---
  const { planetMaintReduction, creditsBonus, popGrowthBonus, civilUnrestReduction } =
    getTechBonuses(unlockedIds);

  const counts: Partial<Record<PlanetTypeName, number>> = {};
  for (const p of planets) counts[p.type] = (counts[p.type] ?? 0) + 1;
  const totalPlanets = planets.length;
  const govPlanets = counts["GOVERNMENT"] ?? 0;

  // --- Step 1: Drift production toward longTerm ---
  for (const p of planets) {
    if (p.shortTermProduction !== p.longTermProduction) {
      const diff = p.longTermProduction - p.shortTermProduction;
      const drift = Math.ceil(Math.abs(diff) * ECON.PRODUCTION_DRIFT_RATE) * Math.sign(diff);
      p.shortTermProduction += drift;
    }
  }

  // --- Steps 2-3: Resource production ---
  const civilPenalty =
    s.civilStatus * POP.CIVIL_STATUS_FACTOR * (1 - Math.min(civilUnrestReduction, 90) / 100);

  const foodProduced = Math.round(
    planets
      .filter((p) => p.type === "FOOD")
      .reduce((sum, p) => sum + PLANET_CONFIG.FOOD.baseProduction * p.shortTermProduction / 100, 0) *
      (1 - civilPenalty),
  );

  const oreProduced = Math.round(
    planets
      .filter((p) => p.type === "ORE")
      .reduce((sum, p) => sum + PLANET_CONFIG.ORE.baseProduction * p.shortTermProduction / 100, 0) *
      (1 - civilPenalty),
  );

  const fuelProduced = Math.round(
    planets
      .filter((p) => p.type === "PETROLEUM")
      .reduce((sum, p) => sum + PLANET_CONFIG.PETROLEUM.baseProduction * p.shortTermProduction / 100, 0) *
      (1 - civilPenalty),
  );

  const foodConsumedPop = Math.round(n.population * POP.FOOD_PER_PERSON);
  const foodConsumedArmy = Math.round(army.soldiers * MAINT.SOLDIER_FOOD + army.generals * MAINT.GENERAL_FOOD);
  const foodConsumed = foodConsumedPop + foodConsumedArmy;

  const oreConsumed = Math.round(
    army.fighters * MAINT.FIGHTER_ORE +
    army.defenseStations * MAINT.STATION_ORE +
    army.lightCruisers * MAINT.LIGHT_CRUISER_ORE +
    army.heavyCruisers * MAINT.HEAVY_CRUISER_ORE +
    army.carriers * MAINT.CARRIER_ORE +
    (army.commandShipStrength > 0 ? MAINT.COMMAND_SHIP_ORE : 0),
  );

  const fuelConsumed = Math.round(
    army.fighters * MAINT.FIGHTER_FUEL +
    army.lightCruisers * MAINT.LIGHT_CRUISER_FUEL +
    army.heavyCruisers * MAINT.HEAVY_CRUISER_FUEL +
    army.carriers * MAINT.CARRIER_FUEL +
    (army.commandShipStrength > 0 ? MAINT.COMMAND_SHIP_FUEL : 0),
  );

  // --- Step 4: Auto-sell resources (market ratio fixed at 1.0) ---
  const foodSold = Math.floor((foodProduced / 100) * n.foodSellRate);
  const foodSalesCredits = Math.round(foodSold * ECON.BASE_FOOD_PRICE / ECON.SELL_RATIO_DIVISOR);

  const oreSold = Math.floor((oreProduced / 100) * n.oreSellRate);
  const oreSalesCredits = Math.round(oreSold * ECON.BASE_ORE_PRICE / ECON.SELL_RATIO_DIVISOR);

  const petroSold = Math.floor((fuelProduced / 100) * n.petroleumSellRate);
  const petroSalesCredits = Math.round(petroSold * ECON.BASE_PETRO_PRICE / ECON.SELL_RATIO_DIVISOR);

  // --- Step 5: Income ---
  const populationTax = Math.floor(n.population * n.taxRate * ECON.POPULATION_TAX_FACTOR);

  const urbanAvgProd = avgShortTermProd(planets, "URBAN");
  let urbanTax = Math.floor((counts["URBAN"] ?? 0) * ECON.URBAN_TAX_PER_PLANET);
  urbanTax = Math.floor((urbanTax / 100) * urbanAvgProd);
  const urbanCivilPenalty = Math.round(urbanTax * civilPenalty / 4);
  urbanTax = Math.max(0, urbanTax - urbanCivilPenalty);

  const tourismAvgProd = avgShortTermProd(planets, "TOURISM");
  let tourismIncome = Math.floor((counts["TOURISM"] ?? 0) * ECON.TOURISM_BASE_CREDITS);
  tourismIncome = Math.floor((tourismIncome / 100) * tourismAvgProd);
  const tourismCivilPenalty = Math.round(tourismIncome * civilPenalty);
  tourismIncome = Math.max(0, tourismIncome - tourismCivilPenalty);

  // Approximate galactic redistribution
  const galacticRedist = playerCount > 0 ? Math.floor(10000 / playerCount / 200) : 0;

  const totalIncome = Math.round(
    (populationTax + urbanTax + tourismIncome + foodSalesCredits + oreSalesCredits + petroSalesCredits + galacticRedist) *
    (1 + creditsBonus / 100),
  );

  // --- Step 6: Expenses ---
  const planetMaintPerUnit = MAINT.PLANET_BASE + n.turnsPlayed * MAINT.PLANET_PER_TURN;
  const ohFactor = totalPlanets * (MAINT.IMPERIAL_OVERHEAD_PER_PLANET ?? 0);
  const overheadMult = 1 + ohFactor + ohFactor * ohFactor * 0.3;
  const maintWeightSum = planets.reduce((sum, p) => {
    if (p.type === "GOVERNMENT") return sum;
    return sum + (PLANET_CONFIG[p.type]?.maintenanceMult ?? 1.0);
  }, 0);
  const planetMaintBase = Math.round(
    Math.max(0, maintWeightSum) * planetMaintPerUnit * overheadMult * (1 - Math.min(planetMaintReduction, 90) / 100),
  );
  const nonGov = Math.max(1, totalPlanets - govPlanets);
  const govReduction = Math.floor((govPlanets * 4 / nonGov) * planetMaintBase);
  const planetMaintenance = Math.max(0, planetMaintBase - govReduction);

  const militaryMaintenance =
    army.soldiers * MAINT.SOLDIER +
    army.generals * MAINT.GENERAL +
    army.fighters * MAINT.FIGHTER +
    army.defenseStations * MAINT.STATION +
    army.lightCruisers * MAINT.LIGHT_CRUISER +
    army.heavyCruisers * MAINT.HEAVY_CRUISER +
    army.carriers * MAINT.CARRIER;

  const galacticTax = Math.floor((n.credits + totalIncome) * ECON.GALACTIC_TAX_RATE);
  const totalExpenses = planetMaintenance + militaryMaintenance + galacticTax;

  // --- Step 7-8: Apply net changes ---
  n.credits = n.credits + totalIncome - totalExpenses;
  n.food = n.food + foodProduced - foodConsumed - foodSold;
  n.ore = n.ore + oreProduced - oreConsumed - oreSold;
  n.fuel = n.fuel + fuelProduced - fuelConsumed - petroSold;

  // --- Step 9: Population dynamics ---
  const urbanSumProd = sumShortTermProd(planets, "URBAN");
  const urbanBonus = urbanSumProd / 100 * POP.URBAN_GROWTH_FACTOR;

  const petroProdShort = avgShortTermProd(planets, "PETROLEUM");
  const pollutionFromPetro = Math.floor(((counts["PETROLEUM"] ?? 0) / 100) * petroProdShort) * POLLUTION.PER_PETRO_PLANET;
  const pollutionFromPop = n.population * POLLUTION.PER_PERSON;
  const totalPollution = pollutionFromPetro + pollutionFromPop;
  const antiPolluPlanets = counts["ANTI_POLLUTION"] ?? 0;
  const antiPolluProd = avgShortTermProd(planets, "ANTI_POLLUTION");
  const antipollution = antiPolluPlanets * POLLUTION.ANTI_POLLUTION_ABSORPTION * (antiPolluProd / 100);
  const pollutionRatio = totalPollution / Math.max(1, antipollution);

  const bornPrime = n.population * POP.BIRTH_RATE;
  const bornBase = bornPrime * urbanBonus;
  const bornPollutionPenalty = bornBase * pollutionRatio;
  const bornCivilPenalty = bornBase * civilPenalty;
  const taxMult = getTaxBirthMultiplier(n.taxRate);
  const bornTaxPenalty = bornPrime * urbanBonus * taxMult * n.taxRate * POP.TAX_IMMIGRATION_PENALTY * 0.5;
  let births = Math.max(
    0,
    Math.round((bornBase - bornPollutionPenalty - bornCivilPenalty - bornTaxPenalty) * (1 + popGrowthBonus / 100)),
  );
  if (n.food < 0) births = Math.floor(births / 4);

  const deathsPrime = n.population * POP.DEATH_RATE;
  const deathsPollution = deathsPrime * pollutionRatio;
  const deathsCivil = deathsPrime * civilPenalty;
  const deaths = Math.round(deathsPrime + deathsPollution + deathsCivil);

  const eduPlanets = counts["EDUCATION"] ?? 0;
  const immigBase = eduPlanets * POP.EDUCATION_IMMIGRATION;
  const immigPollution = immigBase * pollutionRatio;
  const immigCivil = immigBase * civilPenalty;
  const immigTax = immigBase * n.taxRate * POP.TAX_IMMIGRATION_PENALTY;
  const immigration = Math.max(0, Math.round(immigBase - immigPollution - immigCivil - immigTax));

  const urbanCapacity = (counts["URBAN"] ?? 0) * POP.OVERCROWD_CAPACITY_PER_URBAN;
  const overcrowdExcess = Math.max(0, n.population - urbanCapacity);
  const emigOvercrowd = overcrowdExcess * POP.OVERCROWD_EMIGRATION_RATE;
  const emigTax = n.population * n.taxRate * POP.TAX_EMIGRATION_FACTOR;
  const emigCivil = n.population * n.civilStatus * POP.CIVIL_STATUS_FACTOR;
  const emigration = Math.round(emigOvercrowd + emigTax + emigCivil);

  n.population = Math.max(0, n.population + births + immigration - deaths - emigration);

  // --- Step 10: Civil status + desertion ---
  // Excess covert agents
  const maxCovert = govPlanets * MIL.COVERT_PER_GOV_PLANET;
  if (army.covertAgents > maxCovert && maxCovert >= 0 && rng() < 0.5) {
    n.civilStatus = Math.min(7, n.civilStatus + 1);
  }

  // Desertion
  if (n.civilStatus > 0) {
    const rate = (n.civilStatus * CIVIL_DESERTION_RATE_PER_LEVEL) / 100;
    army.soldiers = Math.max(0, army.soldiers - Math.floor(army.soldiers * rate));
    army.fighters = Math.max(0, army.fighters - Math.floor(army.fighters * rate));
    army.lightCruisers = Math.max(0, army.lightCruisers - Math.floor(army.lightCruisers * rate));
    army.heavyCruisers = Math.max(0, army.heavyCruisers - Math.floor(army.heavyCruisers * rate));
    army.carriers = Math.max(0, army.carriers - Math.floor(army.carriers * rate));
  }

  // Civil recovery
  if (n.civilStatus > 0 && n.credits >= 0 && n.food >= 0 && totalPlanets > 0) {
    const recoveryChance = (army.covertAgents / (totalPlanets * 0.2)) * 100;
    if (rng() * 100 <= recoveryChance) {
      n.civilStatus = Math.max(0, n.civilStatus - 1);
    }
  }

  // --- Step 11: Deficit consequences ---
  if (n.food < 0) {
    n.population -= Math.floor(n.population * DEFICIT.STARVATION_POP_LOSS);
    army.soldiers -= Math.floor(army.soldiers * DEFICIT.STARVATION_SOLDIER_LOSS);
    army.generals -= Math.floor(army.generals * DEFICIT.STARVATION_SOLDIER_LOSS);
    n.civilStatus = Math.min(7, n.civilStatus + 1);
    n.food = 0;
  }
  if (n.credits < 0) {
    army.soldiers -= Math.ceil(army.soldiers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.generals -= Math.ceil(army.generals * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.fighters -= Math.ceil(army.fighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.lightCruisers -= Math.ceil(army.lightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.heavyCruisers -= Math.ceil(army.heavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.carriers -= Math.ceil(army.carriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng() < 0.2) n.civilStatus = Math.min(7, n.civilStatus + 1);
    // Lose some planets (remove worst types)
    if (n.planets.length > 0) {
      const toRelease = Math.max(1, Math.ceil(n.planets.length * DEFICIT.BANKRUPT_PLANET_LOSS));
      n.planets.splice(n.planets.length - toRelease, toRelease);
    }
    n.credits = 0;
  }
  if (n.ore < 0) {
    army.fighters -= Math.ceil(army.fighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.lightCruisers -= Math.ceil(army.lightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.heavyCruisers -= Math.ceil(army.heavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.carriers -= Math.ceil(army.carriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng() < 0.2) n.civilStatus = Math.min(7, n.civilStatus + 1);
    n.ore = 0;
  }
  if (n.fuel < 0) {
    army.fighters -= Math.ceil(army.fighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.lightCruisers -= Math.ceil(army.lightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.heavyCruisers -= Math.ceil(army.heavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    army.carriers -= Math.ceil(army.carriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng() < 0.2) n.civilStatus = Math.min(7, n.civilStatus + 1);
    n.fuel = 0;
  }

  // Clamp
  army.soldiers = Math.max(0, army.soldiers);
  army.generals = Math.max(0, army.generals);
  army.fighters = Math.max(0, army.fighters);
  army.lightCruisers = Math.max(0, army.lightCruisers);
  army.heavyCruisers = Math.max(0, army.heavyCruisers);
  army.carriers = Math.max(0, army.carriers);
  army.covertAgents = Math.max(0, army.covertAgents);
  n.population = Math.max(0, n.population);

  // --- Step 12-13: Net worth ---
  n.netWorth = computeNetWorth(n);

  // --- Step 14-16: Army recovery ---
  army.effectiveness = Math.min(MIL.EFFECTIVENESS_MAX, army.effectiveness + MIL.EFFECTIVENESS_RECOVERY);
  if (army.commandShipStrength > 0) {
    army.commandShipStrength = Math.min(MIL.COMMAND_SHIP_MAX, army.commandShipStrength + MIL.COMMAND_SHIP_GROWTH);
  }
  army.covertPoints = Math.min(MIL.MAX_COVERT_POINTS, army.covertPoints + MIL.COVERT_POINTS_PER_TURN);

  // --- Step 17: Supply planets (simplified) ---
  const supplyPlanets = planets.filter((p) => p.type === "SUPPLY");
  if (supplyPlanets.length > 0) {
    const rawProd = supplyPlanets.reduce((sum, p) => sum + p.shortTermProduction / 100, 0);
    const effProd = rawProd / 10;
    const sr = n.supplyRates;
    army.soldiers += Math.floor(sr.rateSoldier / 100 * effProd * Math.floor(8000 / UNIT_COST.SOLDIER));
    army.fighters += Math.floor(sr.rateFighter / 100 * effProd * Math.floor(8000 / UNIT_COST.FIGHTER));
    army.defenseStations += Math.floor(sr.rateStation / 100 * effProd * Math.floor(8000 / UNIT_COST.DEFENSE_STATION));
    army.heavyCruisers += Math.floor(sr.rateHeavyCruiser / 100 * effProd * Math.floor(8000 / UNIT_COST.HEAVY_CRUISER));
    army.carriers += Math.floor(sr.rateCarrier / 100 * effProd * Math.floor(8000 / UNIT_COST.CARRIER));
    army.generals += Math.floor(sr.rateGeneral / 100 * effProd * Math.floor(8000 / UNIT_COST.GENERAL));
    army.covertAgents += Math.floor(sr.rateCovert / 100 * effProd * Math.floor(8000 / UNIT_COST.COVERT_AGENT));
    n.credits += Math.floor(sr.rateCredits / 100 * effProd * 4000);
  }

  // Research planets → light cruisers
  const resPlanets = planets.filter((p) => p.type === "RESEARCH");
  if (resPlanets.length > 0) {
    const lcProduced = Math.floor(resPlanets.reduce((s, p) => s + p.shortTermProduction / 100, 0) * 5);
    army.lightCruisers += lcProduced;
  }

  // Research planets → research points
  const resPoints = resPlanets.reduce((s, p) => s + PLANET_CONFIG.RESEARCH.baseProduction * p.shortTermProduction / 100, 0);
  n.research.accumulatedPoints += Math.round(resPoints);

  // --- Step 18: Random event ---
  if (rng() < RANDOM_EVENT_CHANCE) {
    const roll = rng();
    if (roll < 0.33) {
      n.credits += 2000;
    } else if (roll < 0.66) {
      n.population += 1000;
    } else {
      n.food += 200;
    }
  }

  // --- Step 19: Protection ---
  if (n.isProtected && n.protectionTurns > 0) {
    n.protectionTurns--;
    if (n.protectionTurns <= 0) {
      n.isProtected = false;
    }
  }

  // --- Turns ---
  n.turnsPlayed = n.turnsPlayed + 1;
  if (decrementTurns) n.turnsLeft = Math.max(0, n.turnsLeft - 1);

  n.netWorth = computeNetWorth(n);
  return n;
}

// ---------------------------------------------------------------------------
// applyAction — pure in-memory action execution
// ---------------------------------------------------------------------------

export interface PureActionResult {
  state: PureEmpireState;
  rivals: RivalView[];
  success: boolean;
  message: string;
}

/**
 * Apply a single action to a PureEmpireState.
 * For attacks/covert, pass `rivals` and the function mutates their views too
 * (returned in `result.rivals`).
 *
 * This does NOT run a tick; call applyTick first if needed.
 * Actions excluded (no-op / not relevant for sim):
 *   propose_treaty, accept_treaty, break_treaty, create/join/leave_coalition,
 *   send_message, buy_lottery_ticket, set_supply_rates (players rarely change),
 *   market_buy, market_sell (simplified: omit market dynamics)
 */
export function applyAction(
  s: PureEmpireState,
  action: ActionType,
  params: Record<string, unknown>,
  rivals: RivalView[],
  rng: () => number = Math.random,
): PureActionResult {
  const n = cloneEmpire(s);
  const rivClone = rivals.map((r) => ({ ...r, planets: r.planets.map((p) => ({ ...p })), army: { ...r.army } }));
  const govPlanets = countType(n.planets, "GOVERNMENT");

  switch (action) {
    case "buy_planet": {
      const type = ((params.type as string) ?? "FOOD").toUpperCase() as PlanetTypeName;
      const cfg = PLANET_CONFIG[type];
      if (!cfg) return { state: s, rivals, success: false, message: "Invalid planet type." };
      const cost = Math.round(cfg.baseCost * (1 + n.netWorth * COST_INFLATION));
      if (n.credits < cost) return { state: s, rivals, success: false, message: `Need ${cost} credits.` };
      n.credits -= cost;
      n.planets.push({ type, shortTermProduction: 100, longTermProduction: 100 });
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Colonized ${type}.` };
    }

    case "set_tax_rate": {
      const rate = Math.max(0, Math.min(100, Number(params.rate ?? s.taxRate)));
      n.taxRate = rate;
      return { state: n, rivals: rivClone, success: true, message: `Tax → ${rate}%.` };
    }

    case "set_sell_rates": {
      n.foodSellRate = Math.max(0, Math.min(100, Number(params.foodSellRate ?? s.foodSellRate)));
      n.oreSellRate = Math.max(0, Math.min(100, Number(params.oreSellRate ?? s.oreSellRate)));
      n.petroleumSellRate = Math.max(0, Math.min(100, Number(params.petroleumSellRate ?? s.petroleumSellRate)));
      return { state: n, rivals: rivClone, success: true, message: "Sell rates updated." };
    }

    case "buy_soldiers": {
      const count = Math.max(1, Number(params.amount ?? 10));
      const cost = count * UNIT_COST.SOLDIER;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.soldiers += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} soldiers.` };
    }

    case "buy_generals": {
      const count = Math.max(1, Number(params.amount ?? 1));
      const maxGenerals = govPlanets * MIL.GENERALS_PER_GOV_PLANET;
      if (n.army.generals + count > maxGenerals)
        return { state: s, rivals, success: false, message: "Generals cap." };
      const cost = count * UNIT_COST.GENERAL;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.generals += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} generals.` };
    }

    case "buy_fighters": {
      const count = Math.max(1, Number(params.amount ?? 5));
      const cost = count * UNIT_COST.FIGHTER;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.fighters += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} fighters.` };
    }

    case "buy_stations": {
      const count = Math.max(1, Number(params.amount ?? 2));
      const cost = count * UNIT_COST.DEFENSE_STATION;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.defenseStations += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} stations.` };
    }

    case "buy_light_cruisers": {
      const count = Math.max(1, Number(params.amount ?? 1));
      const cost = count * UNIT_COST.LIGHT_CRUISER;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.lightCruisers += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} LCs.` };
    }

    case "buy_heavy_cruisers": {
      const count = Math.max(1, Number(params.amount ?? 1));
      const cost = count * UNIT_COST.HEAVY_CRUISER;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.heavyCruisers += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} HCs.` };
    }

    case "buy_carriers": {
      const count = Math.max(1, Number(params.amount ?? 1));
      const cost = count * UNIT_COST.CARRIER;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.carriers += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Bought ${count} carriers.` };
    }

    case "buy_covert_agents": {
      const count = Math.max(1, Number(params.amount ?? 5));
      const maxC = govPlanets * MIL.COVERT_PER_GOV_PLANET;
      if (n.army.covertAgents + count > maxC)
        return { state: s, rivals, success: false, message: "Covert cap." };
      const cost = count * UNIT_COST.COVERT_AGENT;
      if (n.credits < cost) return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= cost;
      n.army.covertAgents += count;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: `Recruited ${count} agents.` };
    }

    case "buy_command_ship": {
      if (n.army.commandShipStrength > 0)
        return { state: s, rivals, success: false, message: "Already have command ship." };
      if (n.credits < UNIT_COST.COMMAND_SHIP)
        return { state: s, rivals, success: false, message: "Insufficient credits." };
      n.credits -= UNIT_COST.COMMAND_SHIP;
      n.army.commandShipStrength = 10;
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: "Command ship commissioned." };
    }

    case "attack_pirates": {
      if (n.army.generals < 1)
        return { state: s, rivals, success: false, message: "Need a general." };
      // Simplified pirate raid: estimate strength, use expected loot
      const playerStr = pirateStrengthEstimate(n.army);
      const pirateDifficulty = 0.65; // expected value of 0.4–0.9
      const pirateStr = playerStr * pirateDifficulty;
      if (playerStr > pirateStr) {
        // Victory: expected loot
        const baseLoot = Math.round(n.turnsPlayed * 300 + 5000);
        n.credits += baseLoot;
        n.army.effectiveness = Math.min(MIL.EFFECTIVENESS_MAX, n.army.effectiveness + MIL.EFFECTIVENESS_WON_PIRATE);
        // Minor expected losses (~3%)
        n.army.soldiers = Math.max(0, n.army.soldiers - Math.floor(n.army.soldiers * 0.03));
        n.army.fighters = Math.max(0, n.army.fighters - Math.floor(n.army.fighters * 0.03));
      } else {
        n.army.effectiveness = Math.max(0, n.army.effectiveness - MIL.EFFECTIVENESS_LOST_PIRATE);
        n.army.soldiers = Math.max(0, n.army.soldiers - Math.floor(n.army.soldiers * 0.07));
      }
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: "Pirate raid." };
    }

    case "attack_conventional": {
      const targetName = params.target as string;
      const rival = rivClone.find((r) => r.name === targetName);
      if (!rival) return { state: s, rivals, success: false, message: "Target not found." };
      if (rival.isProtected) return { state: s, rivals, success: false, message: "Target protected." };
      if (n.army.generals < 1) return { state: s, rivals, success: false, message: "Need a general." };

      // Approximate strength comparison
      const atkStr = conventionalStrength(n.army, false) * (1 + (rng() * COMBAT.RANDOMNESS));
      const defStr = conventionalStrength(rival.army, true) * (1 + (rng() * COMBAT.RANDOMNESS));

      if (atkStr > defStr) {
        // Victory: loot some credits/pop, minor unit losses
        const lootCredits = Math.floor(rival.credits * (COMBAT.INVASION_PLANETS_MIN / 100 + rng() * 0.3));
        const lootPop = Math.floor(rival.population * 0.05);
        n.credits += lootCredits;
        n.population += lootPop;
        rival.credits -= lootCredits;
        rival.population = Math.max(0, rival.population - lootPop);
        n.army.effectiveness = Math.min(MIL.EFFECTIVENESS_MAX, n.army.effectiveness + MIL.EFFECTIVENESS_WON_INVASION);
        // Attacker loses ~10%
        n.army.soldiers = Math.max(0, n.army.soldiers - Math.floor(n.army.soldiers * 0.10));
        n.army.fighters = Math.max(0, n.army.fighters - Math.floor(n.army.fighters * 0.10));
      } else {
        // Defeat: bigger attacker losses
        n.army.effectiveness = Math.max(0, n.army.effectiveness - MIL.EFFECTIVENESS_LOST_INVASION);
        n.army.soldiers = Math.max(0, n.army.soldiers - Math.floor(n.army.soldiers * 0.20));
        n.army.fighters = Math.max(0, n.army.fighters - Math.floor(n.army.fighters * 0.20));
      }
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: "Conventional attack." };
    }

    case "attack_guerrilla": {
      const targetName = params.target as string;
      const rival = rivClone.find((r) => r.name === targetName);
      if (!rival) return { state: s, rivals, success: false, message: "Target not found." };
      if (rival.isProtected) return { state: s, rivals, success: false, message: "Target protected." };
      const atkStr = n.army.soldiers * (n.army.effectiveness / 100) * (1 + rng() * COMBAT.RANDOMNESS);
      const defStr = rival.army.soldiers * COMBAT.GUERRILLA_DEFENSE_MULT * (1 + rng() * COMBAT.RANDOMNESS);
      if (atkStr > defStr) {
        const loot = Math.floor(rival.credits * 0.05);
        n.credits += loot;
        rival.credits -= loot;
      }
      n.army.soldiers = Math.max(0, n.army.soldiers - Math.floor(n.army.soldiers * 0.12));
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: "Guerrilla attack." };
    }

    case "attack_psionic": {
      const rival = rivClone.find((r) => r.name === (params.target as string));
      if (!rival) return { state: s, rivals, success: false, message: "Target not found." };
      if (rival.isProtected) return { state: s, rivals, success: false, message: "Target protected." };
      // Expected outcome: ~2 civil levels, ~14% effectiveness loss on defender
      rival.army.effectiveness = Math.max(0, rival.army.effectiveness - 14);
      return { state: n, rivals: rivClone, success: true, message: "Psionic attack." };
    }

    case "attack_nuclear": {
      const rival = rivClone.find((r) => r.name === (params.target as string));
      if (!rival) return { state: s, rivals, success: false, message: "Target not found." };
      if (rival.isProtected) return { state: s, rivals, success: false, message: "Target protected." };
      if (n.credits < FINANCE.NUKE_COST)
        return { state: s, rivals, success: false, message: "Need 500M credits for nuclear launch." };
      n.credits -= FINANCE.NUKE_COST;
      // Expected ~52.5% of target pop lost
      const popKilled = Math.floor(rival.population * 0.525);
      rival.population = Math.max(0, rival.population - popKilled);
      n.netWorth = computeNetWorth(n);
      return { state: n, rivals: rivClone, success: true, message: "Nuclear strike." };
    }

    case "bank_loan": {
      if (n.loans >= FINANCE.MAX_ACTIVE_LOANS)
        return { state: s, rivals, success: false, message: "Loan cap." };
      const amount = Math.max(1000, Math.min(999999, Number(params.amount ?? FINANCE.DEFAULT_LOAN_AMOUNT)));
      n.credits += amount;
      n.loans += 1;
      return { state: n, rivals: rivClone, success: true, message: `Loan ${amount}.` };
    }

    case "buy_bond": {
      const amount = Math.max(1000, Number(params.amount ?? FINANCE.DEFAULT_BOND_AMOUNT));
      if (n.credits < amount) return { state: s, rivals, success: false, message: "Insufficient credits." };
      // Simplified: spend now, expect +10% back in 30 turns (treat as deferred income)
      n.credits -= amount;
      return { state: n, rivals: rivClone, success: true, message: `Bond ${amount}.` };
    }

    case "discover_tech": {
      const techId = params.techId as string;
      if (!techId) return { state: s, rivals, success: false, message: "No tech specified." };
      if (n.research.unlockedTechIds.includes(techId))
        return { state: s, rivals, success: false, message: "Already researched." };
      const available = getAvailableTech(n.research.unlockedTechIds);
      const tech = available.find((t) => t.id === techId);
      if (!tech) return { state: s, rivals, success: false, message: "Tech not available." };
      if (n.research.accumulatedPoints < tech.cost)
        return { state: s, rivals, success: false, message: "Insufficient research points." };
      n.research.accumulatedPoints -= tech.cost;
      n.research.unlockedTechIds = [...n.research.unlockedTechIds, techId];
      // Apply immediate effect on planets (production bonuses)
      const eff = tech.effect;
      if (eff.type === "food_bonus") {
        for (const p of n.planets.filter((p) => p.type === "FOOD")) {
          p.longTermProduction = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
        }
      } else if (eff.type === "ore_bonus") {
        for (const p of n.planets.filter((p) => p.type === "ORE")) {
          p.longTermProduction = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
        }
      } else if (eff.type === "petro_bonus") {
        for (const p of n.planets.filter((p) => p.type === "PETROLEUM")) {
          p.longTermProduction = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
        }
      }
      return { state: n, rivals: rivClone, success: true, message: `Researched ${tech.name}.` };
    }

    case "end_turn":
    default:
      return { state: n, rivals: rivClone, success: true, message: "End turn." };
  }
}

// ---------------------------------------------------------------------------
// Combat strength estimates (for action applicability checks)
// ---------------------------------------------------------------------------

function tierMult(level: number): number {
  return level >= 2 ? 1.25 : 1.0;
}

function pirateStrengthEstimate(army: PureArmyState): number {
  const eff = army.effectiveness / 100;
  return (
    army.soldiers * 1.0 * tierMult(army.soldiersLevel) +
    army.fighters * 5.0 * tierMult(army.fightersLevel) +
    army.lightCruisers * 8.0 * tierMult(army.lightCruisersLevel) +
    army.heavyCruisers * 20.0 +
    army.commandShipStrength * 3.0
  ) * eff;
}

function conventionalStrength(army: PureArmyState, isDefender: boolean): number {
  const eff = army.effectiveness / 100;
  const defBonus = isDefender ? COMBAT.DEFENSE_BONUS : 1.0;
  return (
    army.soldiers * 1.0 * tierMult(army.soldiersLevel) +
    army.fighters * 5.0 * tierMult(army.fightersLevel) +
    army.defenseStations * 4.0 * tierMult(army.stationsLevel) +
    army.lightCruisers * 8.0 * tierMult(army.lightCruisersLevel) +
    army.heavyCruisers * 20.0 * tierMult(army.heavyCruisersLevel) +
    army.commandShipStrength * 3.0
  ) * eff * defBonus;
}

// ---------------------------------------------------------------------------
// generateCandidateMoves — prune action space to ~8–14 meaningful choices
// ---------------------------------------------------------------------------

export interface CandidateMove {
  action: ActionType;
  params: Record<string, unknown>;
  label: string;
}

/**
 * Generate a pruned list of candidate moves for a given state.
 * The list is ordered roughly by expected value (good moves first).
 * Pass `maxMoves` to limit for performance (default 20).
 *
 * Planet caps scale with empire size and game phase — a 20-planet empire at turn 50
 * should be able to expand to 60+ planets, not cap at 15. Military purchases scale
 * with available credits (spend ~15% of available budget per buy).
 */
export function generateCandidateMoves(
  s: PureEmpireState,
  rivals: RivalView[],
  maxMoves = 20,
): CandidateMove[] {
  const moves: CandidateMove[] = [];
  const govPlanets = countType(s.planets, "GOVERNMENT");
  const attackableRivals = rivals.filter((r) => !r.isProtected);
  const totalPlanets = s.planets.length;

  // --- Always include end_turn as fallback ---
  moves.push({ action: "end_turn", params: {}, label: "End turn" });

  // --- Sell rates (if suboptimal) ---
  if (s.foodSellRate < 50 && countType(s.planets, "FOOD") > 0) {
    moves.push({ action: "set_sell_rates", params: { foodSellRate: 70, oreSellRate: s.oreSellRate, petroleumSellRate: s.petroleumSellRate }, label: "Sell food 70%" });
  }
  if (s.oreSellRate < 50 && countType(s.planets, "ORE") > 0) {
    moves.push({ action: "set_sell_rates", params: { foodSellRate: s.foodSellRate, oreSellRate: 70, petroleumSellRate: s.petroleumSellRate }, label: "Sell ore 70%" });
  }

  // --- Planet buying ---
  const planetCost = (type: PlanetTypeName) =>
    Math.round(PLANET_CONFIG[type].baseCost * (1 + s.netWorth * COST_INFLATION));

  // Credit buffer: require 3 turns of maintenance in reserve (scaled by turns remaining).
  // Late game (< 20 turns left): lower to 2 turns — spend aggressively for NW.
  // This is much less conservative than the old 8-turn buffer which killed expansion.
  const planetMaintPerTurn = totalPlanets * (MAINT.PLANET_BASE + MAINT.PLANET_PER_TURN * s.turnsPlayed);
  const bufferTurns = s.turnsLeft < 20 ? 2 : 3;
  const creditBufferNeeded = planetMaintPerTurn * bufferTurns;

  // --- Phase-aware planet caps (scale with empire size and game progress) ---
  // Early game (< 15 planets): use sensible minimums.
  // Mid/late game: caps scale with total planet count to allow realistic growth.
  const candidatePlanetTypes: PlanetTypeName[] = [];

  // Food: scale with population consumption, not a hard cap
  const foodCount = countType(s.planets, "FOOD");
  const estFoodConsumed = s.population * POP.FOOD_PER_PERSON + s.army.soldiers * MAINT.SOLDIER_FOOD;
  const estFoodProd = foodCount * PLANET_CONFIG.FOOD.baseProduction;
  const foodTarget = Math.max(2, Math.ceil(estFoodConsumed / Math.max(1, PLANET_CONFIG.FOOD.baseProduction) * 1.3));
  if (foodCount < foodTarget || s.food < 500) {
    candidatePlanetTypes.push("FOOD");
  }

  // Ore: scale with military consumption
  const oreCount = countType(s.planets, "ORE");
  const oreTarget = Math.max(2, Math.ceil(totalPlanets * 0.08));
  if (s.ore < 400 || oreCount < oreTarget) candidatePlanetTypes.push("ORE");

  // Government: scale with empire (generals, covert cap, maintenance savings)
  // 15% of total planets, minimum 2
  const govTarget = Math.max(2, Math.ceil(totalPlanets * 0.15));
  if (govPlanets < govTarget) candidatePlanetTypes.push("GOVERNMENT");

  // Urban: scale with population — 1 urban per ~20k capacity
  const urbanCount = countType(s.planets, "URBAN");
  const urbanTarget = Math.max(3, Math.ceil(s.population / 18000));
  if (urbanCount < urbanTarget) candidatePlanetTypes.push("URBAN");

  // Tourism: income planets scale with empire size (up to ~12% of planets)
  const tourismCount = countType(s.planets, "TOURISM");
  const tourismTarget = Math.max(2, Math.ceil(totalPlanets * 0.12));
  if (tourismCount < tourismTarget) candidatePlanetTypes.push("TOURISM");

  // Fuel: petroleum planets scale mildly
  const petroCount = countType(s.planets, "PETROLEUM");
  if (s.fuel < 200 || petroCount < Math.max(1, Math.ceil(totalPlanets * 0.05))) {
    candidatePlanetTypes.push("PETROLEUM");
  }

  // Research: scale with empire — research planets produce LCs and research points
  const researchCount = countType(s.planets, "RESEARCH");
  const researchTarget = Math.max(3, Math.ceil(totalPlanets * 0.12));
  if (researchCount < researchTarget) candidatePlanetTypes.push("RESEARCH");

  // Supply: free military production; scale with empire
  const supplyCount = countType(s.planets, "SUPPLY");
  const supplyTarget = Math.max(2, Math.ceil(totalPlanets * 0.10));
  if (supplyCount < supplyTarget) candidatePlanetTypes.push("SUPPLY");

  // Education: immigration booster
  const eduCount = countType(s.planets, "EDUCATION");
  if (eduCount < Math.max(2, Math.ceil(totalPlanets * 0.06)) && urbanCount >= 2) {
    candidatePlanetTypes.push("EDUCATION");
  }

  // Anti-pollution: needed once petroleum planets produce pollution
  const pollutionCount = countType(s.planets, "ANTI_POLLUTION");
  if (petroCount > 0 && pollutionCount < Math.ceil(petroCount * 0.5)) {
    candidatePlanetTypes.push("ANTI_POLLUTION");
  }

  for (const type of candidatePlanetTypes) {
    if (s.credits >= planetCost(type) + creditBufferNeeded) {
      moves.push({ action: "buy_planet", params: { type }, label: `Buy ${type} planet` });
    }
  }

  // --- Military (scale purchases with available credits) ---
  // Spend up to ~15% of available credits per purchase, with sensible minimums.
  const availForMil = Math.max(0, s.credits - creditBufferNeeded);

  // Soldiers: scale from 20 to 200
  const soldierAmt = Math.min(200, Math.max(20, Math.floor(availForMil * 0.15 / UNIT_COST.SOLDIER)));
  if (availForMil >= UNIT_COST.SOLDIER * 20) {
    moves.push({ action: "buy_soldiers", params: { amount: soldierAmt }, label: `Buy ${soldierAmt} soldiers` });
  }

  // Generals: need government planets
  const genCap = govPlanets * MIL.GENERALS_PER_GOV_PLANET;
  const genAmt = Math.min(Math.max(1, genCap - s.army.generals), Math.floor(availForMil * 0.10 / UNIT_COST.GENERAL));
  if (govPlanets > 0 && s.army.generals < genCap && availForMil >= UNIT_COST.GENERAL) {
    moves.push({ action: "buy_generals", params: { amount: Math.max(1, genAmt) }, label: `Buy ${Math.max(1, genAmt)} generals` });
  }

  // Fighters: scale from 5 to 50
  const fighterAmt = Math.min(50, Math.max(5, Math.floor(availForMil * 0.12 / UNIT_COST.FIGHTER)));
  if (availForMil >= UNIT_COST.FIGHTER * 5) {
    moves.push({ action: "buy_fighters", params: { amount: fighterAmt }, label: `Buy ${fighterAmt} fighters` });
  }

  // Light cruisers: scale from 2 to 20
  const lcAmt = Math.min(20, Math.max(2, Math.floor(availForMil * 0.12 / UNIT_COST.LIGHT_CRUISER)));
  if (availForMil >= UNIT_COST.LIGHT_CRUISER * 2) {
    moves.push({ action: "buy_light_cruisers", params: { amount: lcAmt }, label: `Buy ${lcAmt} LCs` });
  }

  // Heavy cruisers: scale from 1 to 10
  const hcAmt = Math.min(10, Math.max(1, Math.floor(availForMil * 0.10 / UNIT_COST.HEAVY_CRUISER)));
  if (availForMil >= UNIT_COST.HEAVY_CRUISER) {
    moves.push({ action: "buy_heavy_cruisers", params: { amount: hcAmt }, label: `Buy ${hcAmt} HCs` });
  }

  // Covert agents
  const covertCap = govPlanets * MIL.COVERT_PER_GOV_PLANET;
  if (govPlanets > 0 && s.army.covertAgents < covertCap && availForMil >= UNIT_COST.COVERT_AGENT) {
    const covAmt = Math.min(5, Math.max(1, Math.floor(availForMil * 0.05 / UNIT_COST.COVERT_AGENT)));
    moves.push({ action: "buy_covert_agents", params: { amount: covAmt }, label: `Buy ${covAmt} covert agents` });
  }

  // --- Pirates (good income if army is decent) ---
  if (s.army.generals >= 1 && pirateStrengthEstimate(s.army) > 100) {
    moves.push({ action: "attack_pirates", params: {}, label: "Attack pirates" });
  }

  // --- Attacks against rivals (only if strong enough) ---
  const myStr = conventionalStrength(s.army, false);
  for (const rival of attackableRivals) {
    const rivStr = conventionalStrength(rival.army, true);
    if (myStr > rivStr * 1.2 && s.army.generals >= 1) {
      moves.push({
        action: "attack_conventional",
        params: { target: rival.name },
        label: `Attack ${rival.name}`,
      });
    }
  }

  // --- Research ---
  const availTechs = getAvailableTech(s.research.unlockedTechIds);
  const affordable = availTechs.filter((t) => t.cost <= s.research.accumulatedPoints);
  if (affordable.length > 0) {
    // Pick cheapest affordable tech
    const pick = affordable.reduce((a, b) => (a.cost < b.cost ? a : b));
    moves.push({ action: "discover_tech", params: { techId: pick.id }, label: `Research ${pick.name}` });
  }

  // --- Loans (early game bootstrap) ---
  if (s.loans < FINANCE.MAX_ACTIVE_LOANS && s.credits < 15000 && s.turnsPlayed < 20) {
    moves.push({ action: "bank_loan", params: { amount: FINANCE.DEFAULT_LOAN_AMOUNT }, label: "Take loan" });
  }

  // --- Bonds (invest surplus when stable income) ---
  if (s.credits >= 100000 && estimateNetIncomePerTurn(s) > 2000 && s.turnsPlayed >= 15) {
    moves.push({ action: "buy_bond", params: { amount: 50000 }, label: "Buy 50k bond" });
  }

  // --- Market sell (sell excess resources for credits) ---
  if (s.food > 2000 && estFoodProd > estFoodConsumed * 1.3) {
    const sellAmt = Math.floor(s.food * 0.3);
    moves.push({ action: "market_sell", params: { resource: "food", amount: sellAmt }, label: `Sell ${sellAmt} food` });
  }
  if (s.ore > 2000) {
    const sellAmt = Math.floor(s.ore * 0.3);
    moves.push({ action: "market_sell", params: { resource: "ore", amount: sellAmt }, label: `Sell ${sellAmt} ore` });
  }

  // --- Tax rate adjustment ---
  if (s.taxRate > 60 && s.civilStatus < 3) {
    moves.push({ action: "set_tax_rate", params: { rate: 50 }, label: "Lower tax to 50%" });
  }
  if (s.taxRate < 40 && s.credits < 5000) {
    moves.push({ action: "set_tax_rate", params: { rate: 50 }, label: "Raise tax to 50%" });
  }

  // Return up to maxMoves, always include end_turn
  const result: CandidateMove[] = [moves[0]]; // end_turn
  for (let i = 1; i < moves.length && result.length < maxMoves; i++) {
    result.push(moves[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rollout strategy inference + move selection
// ---------------------------------------------------------------------------

/** Internal rollout strategy label (separate from SimStrategy to avoid circular imports). */
export type RolloutStrategy = "economy" | "military" | "research" | "supply" | "credit" | "growth" | "balanced";

/**
 * Infer the empire's current play style from its planet composition, army, and game phase.
 * Used by MCTS rollouts to select moves that align with the current strategy.
 *
 * Game-phase awareness prevents early-game lock-in: 2 research planets at turn 10
 * should not permanently lock into "research" — at turn 60+ with 40 planets it's
 * time to diversify into military. The thresholds use *ratios* of total planets
 * so strategy inference adapts as the empire grows.
 */
export function inferRolloutStrategy(s: PureEmpireState): RolloutStrategy {
  const total = s.planets.length;
  if (total === 0) return "balanced";

  const researchCount = countType(s.planets, "RESEARCH");
  const supplyCount = countType(s.planets, "SUPPLY");
  const govCount = countType(s.planets, "GOVERNMENT");
  const urbanCount = countType(s.planets, "URBAN");
  const foodCount = countType(s.planets, "FOOD");
  const oreCount = countType(s.planets, "ORE");
  const milUnits = s.army.soldiers + s.army.fighters * 3 + s.army.lightCruisers * 6 + s.army.heavyCruisers * 15;

  // Late game (< 25 turns left): shift toward military for NW
  const isLateGame = s.turnsLeft < 25;

  // Use ratio-based thresholds (15%+) so strategy detection scales with empire size.
  // A 5-planet empire with 2 research = 40% research → research strategy.
  // A 40-planet empire with 2 research = 5% research → not locked into research.
  const researchRatio = researchCount / total;
  const supplyRatio = supplyCount / total;

  // Late game: military focus if we have the infrastructure
  if (isLateGame && govCount >= 2 && s.army.generals >= 2) return "military";

  // Research: dominant when research is a significant share of the empire
  if (researchRatio >= 0.15 && researchCount >= 2) return "research";
  // Supply: dominant when supply is a significant share
  if (supplyRatio >= 0.12 && supplyCount >= 2) return "supply";
  // Credit / spy: heavy covert investment relative to gov planets
  if (govCount >= 2 && s.army.covertAgents > govCount * 100) return "credit";
  // Military: clearly above-baseline army investment
  if (milUnits > s.population * 0.01 && s.army.generals >= 3) return "military";
  // Growth / urban focus
  if (urbanCount > total * 0.25 && urbanCount >= 3) return "growth";
  // Economy: resource-planet heavy
  if (foodCount + oreCount > total * 0.35 && total >= 5) return "economy";
  return "balanced";
}

/**
 * Score a candidate move by how well it fits the rollout strategy.
 * Higher = more aligned. Small RNG noise added by the caller.
 */
function rolloutMoveScore(move: CandidateMove, strategy: RolloutStrategy): number {
  const a = move.action;
  const pType = (move.params.type as string | undefined) ?? "";

  // Universal: end_turn is always low-priority; planet buying and military are always decent.
  // market_sell and buy_bond are moderate-value utility moves in all strategies.
  const isMilBuy = a === "buy_soldiers" || a === "buy_fighters" || a === "buy_light_cruisers" || a === "buy_heavy_cruisers";
  const isCombat = a === "attack_pirates" || a === "attack_conventional" || a === "attack_guerrilla";

  switch (strategy) {
    case "research":
      if (a === "discover_tech") return 4.0;
      if (a === "buy_planet" && pType === "RESEARCH") return 3.5;
      if (a === "buy_planet" && (pType === "FOOD" || pType === "ORE")) return 2.0;
      if (a === "buy_planet") return 1.5;
      if (isMilBuy) return 1.3;          // still need some military for NW
      if (a === "market_sell") return 1.2;
      if (a === "end_turn") return 0.3;
      return 1.0;
    case "supply":
      if (a === "buy_planet" && pType === "SUPPLY") return 4.0;
      if (a === "buy_planet" && pType === "GOVERNMENT") return 2.5;  // gov supports supply
      if (a === "buy_planet") return 2.0;
      if (isMilBuy) return 1.5;          // supply produces units, buying complements
      if (a === "end_turn") return 0.3;
      return 1.0;
    case "military":
      if (isCombat) return 3.5;
      if (isMilBuy) return 3.0;
      if (a === "buy_generals") return 2.8;
      if (a === "buy_covert_agents") return 2.0;
      if (a === "buy_planet" && pType === "GOVERNMENT") return 2.0;
      if (a === "buy_planet" && pType === "SUPPLY") return 1.8;   // free units
      if (a === "buy_planet") return 1.0;
      if (a === "market_sell") return 1.5;  // liquidate for more military budget
      if (a === "end_turn") return 0.3;
      return 1.0;
    case "credit":
      if (a === "bank_loan") return 3.5;
      if (a === "buy_bond") return 3.0;
      if (a === "buy_covert_agents") return 2.5;
      if (a === "buy_planet" && pType === "GOVERNMENT") return 2.0;
      if (a === "buy_planet") return 1.5;
      if (a === "market_sell") return 1.5;
      return 1.0;
    case "growth":
      if (a === "buy_planet" && (pType === "URBAN" || pType === "EDUCATION")) return 3.5;
      if (a === "buy_planet" && pType === "FOOD") return 2.5;
      if (a === "set_tax_rate") return 2.0;
      if (a === "buy_planet") return 2.0;
      if (a === "end_turn") return 0.3;
      return 1.0;
    case "economy":
      if (a === "set_sell_rates") return 3.0;
      if (a === "buy_planet" && (pType === "FOOD" || pType === "ORE" || pType === "TOURISM")) return 2.5;
      if (a === "buy_planet" && pType === "URBAN") return 2.0;
      if (a === "buy_planet") return 1.5;
      if (a === "buy_bond") return 1.8;    // invest surplus
      if (a === "market_sell") return 1.5;
      return 1.0;
    case "balanced":
    default:
      // Expansion-first balanced: planets are high-value (income + NW), military secondary
      if (a === "buy_planet") return 2.2;
      if (a === "attack_pirates") return 2.0;
      if (a === "buy_generals")   return 1.8;
      if (isMilBuy) return 1.5;
      if (isCombat) return 1.6;
      if (a === "discover_tech")  return 1.4;
      if (a === "buy_bond") return 1.3;
      if (a === "market_sell") return 1.2;
      if (a === "buy_covert_agents") return 1.1;
      if (a === "end_turn") return 0.3;
      return 1.0;
  }
}

/**
 * Select a move from `candidates` aligned with the empire's inferred strategy.
 * Adds small RNG noise so rollouts don't become fully deterministic.
 */
export function pickRolloutMove(
  s: PureEmpireState,
  candidates: CandidateMove[],
  rng: () => number,
  overrideStrategy?: RolloutStrategy,
): CandidateMove {
  if (candidates.length === 1) return candidates[0];
  const strategy = overrideStrategy ?? inferRolloutStrategy(s);

  // Over-extension: fewer than 5 turns of planet maintenance in reserve, OR in net deficit.
  const maintPerTurn = s.planets.length * (MAINT.PLANET_BASE + MAINT.PLANET_PER_TURN * s.turnsPlayed);
  const netIncome = estimateNetIncomePerTurn(s);
  const isOverExtended = (maintPerTurn > 0 && s.credits < maintPerTurn * 5) || netIncome < -800;

  // Food pressure: if production falling behind consumption AND below pop floor, prioritise food.
  // Above the floor, mild pressure only — don't let food crowd out military.
  const POP_FLOOR = 15_000;
  const estFoodProd     = countType(s.planets, "FOOD") * PLANET_CONFIG.FOOD.baseProduction;
  const estFoodConsumed = s.population * POP.FOOD_PER_PERSON + s.army.soldiers * MAINT.SOLDIER_FOOD;
  const isFoodPressure  = estFoodProd < estFoodConsumed * 1.1;
  const isBelowPopFloor = s.population < POP_FLOOR;

  let best = candidates[0];
  let bestScore = -Infinity;
  for (const c of candidates) {
    let score = rolloutMoveScore(c, strategy) + rng() * 0.15;
    if (isOverExtended) {
      if (c.action === "buy_planet") score -= 2.5;
      if (c.action === "end_turn")   score += 1.0;
    }
    if (isFoodPressure) {
      const pType = (c.params.type as string | undefined) ?? "";
      if (c.action === "buy_planet" && pType === "FOOD") {
        score += isBelowPopFloor ? 3.0 : 1.0; // urgent below floor, mild above
      } else if (c.action === "buy_planet") {
        score -= isBelowPopFloor ? 1.5 : 0.3; // strongly defer below floor, barely above
      }
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// evalState — multi-objective heuristic scoring
// ---------------------------------------------------------------------------

/** Number of techs in the full research tree. */
const TOTAL_TECHS = 22;

/**
 * Estimate total maintenance cost per turn for scoring purposes.
 * Planet maintenance grows with turnsPlayed; army adds flat rates.
 */
function estimateMaintPerTurn(s: PureEmpireState): number {
  const planetMaint = s.planets.length * (MAINT.PLANET_BASE + MAINT.PLANET_PER_TURN * s.turnsPlayed);
  const armyMaint =
    s.army.soldiers      * MAINT.SOLDIER +
    s.army.generals      * MAINT.GENERAL +
    s.army.fighters      * MAINT.FIGHTER +
    s.army.defenseStations * MAINT.STATION +
    s.army.lightCruisers * MAINT.LIGHT_CRUISER +
    s.army.heavyCruisers * MAINT.HEAVY_CRUISER +
    s.army.carriers      * MAINT.CARRIER;
  return planetMaint + armyMaint;
}

/**
 * Estimate net credits earned per turn from the current state (income minus expenses).
 * Used by evalState to reward positive cash flow over raw net-worth accumulation.
 * Intentionally approximate — avoids a full applyTick clone.
 */
function estimateNetIncomePerTurn(s: PureEmpireState): number {
  const { creditsBonus } = getTechBonuses(s.research.unlockedTechIds);

  const populationTax = Math.floor(s.population * s.taxRate * ECON.POPULATION_TAX_FACTOR);
  const urbanCount  = countType(s.planets, "URBAN");
  const urbanTax    = Math.floor(urbanCount * ECON.URBAN_TAX_PER_PLANET);
  const tourismCount   = countType(s.planets, "TOURISM");
  const tourismIncome  = Math.floor(tourismCount * ECON.TOURISM_BASE_CREDITS);

  // Resource income: approximate with count × baseProduction (avg 100% efficiency)
  const foodCount  = countType(s.planets, "FOOD");
  const foodIncome = Math.round(
    foodCount * PLANET_CONFIG.FOOD.baseProduction
    * (s.foodSellRate / 100) * ECON.BASE_FOOD_PRICE / ECON.SELL_RATIO_DIVISOR,
  );
  const oreCount  = countType(s.planets, "ORE");
  const oreIncome = Math.round(
    oreCount * PLANET_CONFIG.ORE.baseProduction
    * (s.oreSellRate / 100) * ECON.BASE_ORE_PRICE / ECON.SELL_RATIO_DIVISOR,
  );
  const petroCount  = countType(s.planets, "PETROLEUM");
  const petroIncome = Math.round(
    petroCount * PLANET_CONFIG.PETROLEUM.baseProduction
    * (s.petroleumSellRate / 100) * ECON.BASE_PETRO_PRICE / ECON.SELL_RATIO_DIVISOR,
  );

  const totalIncome = Math.round(
    (populationTax + urbanTax + tourismIncome + foodIncome + oreIncome + petroIncome)
    * (1 + creditsBonus / 100),
  );

  return totalIncome - estimateMaintPerTurn(s);
}

/**
 * Evaluate how well `s` is doing relative to other players.
 * Returns a score in [0, 1] — higher is better.
 *
 * Key insight from real game data:
 *   - The winning human (benoc) reached 303 NW, 126 planets, 66k pop.
 *   - Planet pipeline (research → LCs, supply → units) drives NW every turn.
 *   - Government planets save maintenance and house generals/covert agents.
 *   - Military NW is the dominant component (soldiers, fighters, LCs, HCs).
 *   - Population scales tax revenue — 66k pop at 30% tax >> 15k pop.
 *
 * Weights:
 *  - net worth rank (0.22)             ← primary: captures all NW components
 *  - military NW absolute (0.14)       ← direct reward for military NW
 *  - planet pipeline value (0.12)      ← deferred value: research/supply produce NW every turn
 *  - planet count growth (0.10)        ← more planets = more income, more NW
 *  - food security (0.10)              ← prevents starvation spiral
 *  - income flow (0.10)                ← sustains credit supply
 *  - military relative strength (0.08) ← positioning vs peers
 *  - economy stability (0.06)
 *  - population (0.04)                 ← scaled reward up to 60k (not 15k floor)
 *  - maintenance sustainability (0.02)
 *  - turns remaining buffer (0.02)
 */
export function evalState(s: PureEmpireState, allStates: PureEmpireState[]): number {
  if (allStates.length === 0) return 0.5;

  // Net worth rank (0 = best)
  const sorted = [...allStates].sort((a, b) => b.netWorth - a.netWorth);
  const rank = sorted.findIndex((x) => x.id === s.id);
  const rankScore = allStates.length > 1 ? (allStates.length - 1 - rank) / (allStates.length - 1) : 0.5;

  // Military NW: absolute contribution from all unit types.
  // 300 NW = full score (winning human had 303 NW; old cap of 120 saturated too early).
  const milNW =
    s.army.soldiers        * NETWORTH.SOLDIER +
    s.army.generals        * NETWORTH.GENERAL +
    s.army.fighters        * NETWORTH.FIGHTER +
    s.army.defenseStations * NETWORTH.STATION +
    s.army.lightCruisers   * NETWORTH.LIGHT_CRUISER +
    s.army.heavyCruisers   * NETWORTH.HEAVY_CRUISER +
    s.army.carriers        * NETWORTH.CARRIER;
  const milNWScore = Math.min(1, milNW / 300);

  // Planet pipeline value: research and supply planets produce NW every remaining turn.
  // Research planets generate LCs (0.12 NW each); supply planets generate mixed units.
  // Government planets save ~300 cr/planet/turn in maintenance overhead.
  // Value = (estimated NW production per turn) × remaining turns, normalized.
  const researchPlanets = countType(s.planets, "RESEARCH");
  const supplyPlanets = countType(s.planets, "SUPPLY");
  const govPlanets = countType(s.planets, "GOVERNMENT");
  const pipelineNWPerTurn =
    researchPlanets * 0.5 +   // ~4 LCs/turn at 0.12 NW each, plus research points
    supplyPlanets * 0.3 +     // mixed unit production
    govPlanets * 0.1;         // maintenance savings → effective income
  const totalPipelineValue = pipelineNWPerTurn * Math.min(s.turnsLeft, 50);
  const pipelineScore = Math.min(1, totalPipelineValue / 30);

  // Planet count growth: reward having more planets than peers.
  // More planets = more income, more NW (2 NW each), more production.
  const maxPlanets = Math.max(1, ...allStates.map((x) => x.planets.length));
  const planetGrowthScore = allStates.length > 1
    ? s.planets.length / maxPlanets
    : Math.min(1, s.planets.length / 50);

  // Food security: predicted production vs consumption.
  const foodPlanets     = countType(s.planets, "FOOD");
  const estFoodProd     = foodPlanets * PLANET_CONFIG.FOOD.baseProduction;
  const estFoodConsumed = Math.max(1,
    s.population * POP.FOOD_PER_PERSON +
    s.army.soldiers * MAINT.SOLDIER_FOOD +
    s.army.generals * MAINT.GENERAL_FOOD,
  );
  const foodRatio       = estFoodProd / estFoodConsumed;
  const foodSecureScore = s.food < 0 ? 0 : Math.min(1, Math.max(0, (foodRatio - 0.8) / 0.7));

  // Population: scaled reward up to 60k — population drives tax revenue linearly.
  // Not a hard floor; more pop = more income = more military purchases.
  const POP_TARGET = 60_000;
  const popScore = Math.min(1, s.population / POP_TARGET);

  // Economy health (binary checks + credit level)
  const orePlanets = countType(s.planets, "ORE");
  const foodOk   = foodPlanets > 0 && s.food >= 0 ? 1 : 0;
  const oreOk    = (orePlanets > 0 || s.army.fighters === 0) && s.ore >= 0 ? 1 : 0;
  const fuelOk   = s.fuel >= 0 ? 1 : 0;
  const creditOk = s.credits > 0 ? Math.min(1, s.credits / 20000) : 0;
  const econScore = (foodOk + oreOk + fuelOk + creditOk) / 4;

  // Maintenance sustainability
  const totalMaint = estimateMaintPerTurn(s);
  const turnsOfMaintCovered = (s.credits > 0 && totalMaint > 0) ? s.credits / totalMaint : 0;
  const sustainScore = Math.min(1, turnsOfMaintCovered / 10);

  // Income flow: net credits per turn.
  // Scale: 0 at -3k/turn deficit, 0.5 at break-even, 1.0 at +10k/turn surplus.
  const netIncome = estimateNetIncomePerTurn(s);
  const incomeFlowScore = netIncome >= 0
    ? Math.min(1, 0.5 + netIncome / 20000)
    : Math.max(0, 0.5 + netIncome / 6000);

  // Military relative strength vs peers
  const myMilStr  = conventionalStrength(s.army, false);
  const maxMilStr = Math.max(1, ...allStates.map((x) => conventionalStrength(x.army, false)));
  const milScore  = myMilStr / maxMilStr;

  // Turns remaining
  const turnScore = s.turnsLeft > 0 ? Math.min(1, s.turnsLeft / START.TURNS) : 0;

  return (
    rankScore          * 0.22 +
    milNWScore         * 0.14 +
    pipelineScore      * 0.12 +
    planetGrowthScore  * 0.10 +
    foodSecureScore    * 0.10 +
    incomeFlowScore    * 0.10 +
    milScore           * 0.08 +
    econScore          * 0.06 +
    popScore           * 0.04 +
    sustainScore       * 0.02 +
    turnScore          * 0.02
  );
}

// ---------------------------------------------------------------------------
// Utility: build PureEmpireState from Prisma-shaped data
// (used by search-opponent.ts to bridge from the live DB into the pure model)
// ---------------------------------------------------------------------------

export interface PrismaEmpireShape {
  id: string;
  credits: number;
  food: number;
  ore: number;
  fuel: number;
  population: number;
  taxRate: number;
  civilStatus: number;
  netWorth: number;
  turnsLeft: number;
  turnsPlayed: number;
  isProtected: boolean;
  protectionTurns: number;
  foodSellRate: number;
  oreSellRate: number;
  petroleumSellRate: number;
  player?: { name: string } | null;
  planets: { type: string; shortTermProduction: number; longTermProduction: number }[];
  army: {
    soldiers: number; generals: number; fighters: number; defenseStations: number;
    lightCruisers: number; heavyCruisers: number; carriers: number; covertAgents: number;
    commandShipStrength: number; effectiveness: number; covertPoints: number;
    soldiersLevel: number; fightersLevel: number; stationsLevel: number;
    lightCruisersLevel: number; heavyCruisersLevel: number;
  };
  research?: { accumulatedPoints: number; unlockedTechIds: string[] | unknown } | null;
  supplyRates?: {
    rateSoldier: number; rateFighter: number; rateStation: number; rateHeavyCruiser: number;
    rateCarrier: number; rateGeneral: number; rateCovert: number; rateCredits: number;
  } | null;
  loans?: number;
}

export function empireFromPrisma(data: PrismaEmpireShape, playerName?: string): PureEmpireState {
  const name = playerName ?? data.player?.name ?? data.id;
  return {
    id: data.id,
    name,
    credits: data.credits,
    food: data.food,
    ore: data.ore,
    fuel: data.fuel,
    population: data.population,
    taxRate: data.taxRate,
    civilStatus: data.civilStatus,
    netWorth: data.netWorth,
    turnsLeft: data.turnsLeft,
    turnsPlayed: data.turnsPlayed,
    isProtected: data.isProtected,
    protectionTurns: data.protectionTurns,
    foodSellRate: data.foodSellRate,
    oreSellRate: data.oreSellRate,
    petroleumSellRate: data.petroleumSellRate,
    planets: data.planets.map((p) => ({
      type: p.type as PlanetTypeName,
      shortTermProduction: p.shortTermProduction,
      longTermProduction: p.longTermProduction,
    })),
    army: { ...data.army },
    research: data.research
      ? { accumulatedPoints: data.research.accumulatedPoints, unlockedTechIds: [...(data.research.unlockedTechIds as string[])] }
      : { accumulatedPoints: 0, unlockedTechIds: [] },
    supplyRates: data.supplyRates
      ? { ...data.supplyRates }
      : { rateSoldier: 50, rateFighter: 50, rateStation: 0, rateHeavyCruiser: 0, rateCarrier: 0, rateGeneral: 0, rateCovert: 0, rateCredits: 0 },
    loans: data.loans ?? 0,
  };
}

// Re-export for external use
export { ACTIONS_PER_DAY };
