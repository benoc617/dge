import { getDb } from "./db-context";
import type { Empire, Planet, Army, SupplyRates, Market, PlanetType } from "@prisma/client";
import { toEmpireUpdateData } from "./empire-prisma";
import * as rng from "./rng";
import {
  POP, ECON, MAINT, UNIT_COST, MIL, POLLUTION, DEFICIT, NETWORTH,
  CIVIL_DESERTION_RATE_PER_LEVEL, PLANET_CONFIG, COST_INFLATION,
  generatePlanetName, getTaxBirthMultiplier, alterNumber, RANDOM_EVENT_CHANCE,
  type PlanetTypeName,
} from "./game-constants";
import {
  runConventionalInvasion, runGuerrillaAttack, runNuclearStrike,
  runChemicalWarfare, runPsionicBomb, runPirateRaid,
} from "./combat";
import { formatUnitLosses, formatUnitLossesOrNone } from "./combat-loss-format";
import { defenderCovertAlertMessage, executeCovertOp } from "./espionage";
import { getAvailableTech, getTech, TECH_TREE, RANDOM_EVENTS, type TechEffect } from "./research";
import { targetHasNewEmpireProtection } from "./empire-protection";

async function emitGameEvent(
  player: { gameSessionId: string | null | undefined },
  row: { type: string; message: string; details?: object },
) {
  await getDb().gameEvent.create({
    data: {
      gameSessionId: player.gameSessionId ?? undefined,
      type: row.type,
      message: row.message,
      ...(row.details ? { details: row.details as object } : {}),
    },
  });
}

/** Queue a line on the defender's next turn situation report (shown as ALERT: …). */
async function pushDefenderAlert(defenderEmpireId: string, message: string) {
  await getDb().empire.update({
    where: { id: defenderEmpireId },
    data: { pendingDefenderAlerts: { push: message } },
  });
}

export { targetHasNewEmpireProtection } from "./empire-protection";

function protectionBlockMessage(turns: number): string {
  return `Target is under new-empire protection (${turns} turn${turns === 1 ? "" : "s"} remaining).`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProcessTurnTickOptions = {
  /**
   * When false, the tick still advances economy and increments turnsPlayed, but does not decrement turnsLeft
   * (simultaneous mode: slots 1..N-1 of a calendar day). Default true (sequential play).
   */
  decrementTurnsLeft?: boolean;
  /**
   * When true: one final economy pass after `turnsLeft` hits 0 so production/maintenance reflects post–final-action
   * state without incrementing `turnsPlayed` (not a playable turn).
   */
  endgameSettlement?: boolean;
};

export type ProcessActionOptions = {
  /** Merged into TurnLog.details (e.g. `llmSource` for AI turns). */
  logMeta?: Record<string, unknown>;
  /** Passed to inline `processTurnTick` when the tick has not been pre-persisted. */
  tickOptions?: ProcessTurnTickOptions;
  /**
   * Door-game (simultaneous) mode: after the action, keep `tickProcessed` true so the next action
   * stays in the same full turn until `end_turn` + `closeFullTurn`.
   */
  keepTickProcessed?: boolean;
  /**
   * When true, `processAction` does not run `runEndgameSettlementTick` when `turnsLeft` reaches 0 — door-game
   * calls it from `closeFullTurn` after decrementing `turnsLeft`.
   */
  skipEndgameSettlement?: boolean;
};

export type ActionType =
  | "buy_planet"
  | "set_tax_rate"
  | "set_sell_rates"
  | "set_supply_rates"
  | "buy_soldiers"
  | "buy_generals"
  | "buy_fighters"
  | "buy_stations"
  | "buy_light_cruisers"
  | "buy_heavy_cruisers"
  | "buy_carriers"
  | "buy_covert_agents"
  | "buy_command_ship"
  | "attack_conventional"
  | "attack_guerrilla"
  | "attack_nuclear"
  | "attack_chemical"
  | "attack_psionic"
  | "attack_pirates"
  | "covert_op"
  | "propose_treaty"
  | "accept_treaty"
  | "break_treaty"
  | "create_coalition"
  | "join_coalition"
  | "leave_coalition"
  | "market_buy"
  | "market_sell"
  | "bank_loan"
  | "bank_repay"
  | "buy_bond"
  | "buy_lottery_ticket"
  | "discover_tech"
  | "send_message"
  | "end_turn";

export interface ActionResult {
  success: boolean;
  message: string;
  turnReport?: TurnReport;
  details?: Record<string, unknown>;
  actionDetails?: Record<string, unknown>;
}

export interface TurnReport {
  income: {
    populationTax: number;
    urbanTax: number;
    tourism: number;
    foodSales: number;
    oreSales: number;
    petroSales: number;
    galacticRedistribution: number;
    total: number;
  };
  expenses: {
    planetMaintenance: number;
    militaryMaintenance: number;
    galacticTax: number;
    total: number;
  };
  population: {
    births: number;
    deaths: number;
    immigration: number;
    emigration: number;
    net: number;
    newTotal: number;
  };
  resources: {
    foodProduced: number;
    foodConsumed: number;
    oreProduced: number;
    oreConsumed: number;
    fuelProduced: number;
    fuelConsumed: number;
  };
  civilStatus: string;
  netWorth: number;
  events: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countPlanetsByType(planets: Planet[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of planets) counts[p.type] = (counts[p.type] || 0) + 1;
  return counts;
}

function avgShortTermProd(planets: Planet[], type: PlanetType): number {
  const matching = planets.filter((p) => p.type === type);
  if (matching.length === 0) return 0;
  return matching.reduce((s, p) => s + p.shortTermProduction, 0) / matching.length;
}

function sumShortTermProd(planets: Planet[], type: PlanetType): number {
  return planets.filter((p) => p.type === type).reduce((s, p) => s + p.shortTermProduction, 0);
}

async function getOrCreateMarket(): Promise<Market> {
  let market = await getDb().market.findFirst();
  if (!market) {
    market = await getDb().market.create({ data: {} });
  }
  return market;
}

// ---------------------------------------------------------------------------
// Turn Tick — runs every turn before the player action
// ---------------------------------------------------------------------------

export async function processTurnTick(
  empire: Empire,
  army: Army,
  planets: Planet[],
  supplyRates: SupplyRates | null,
  opts?: ProcessTurnTickOptions,
): Promise<{ updatedEmpire: Partial<Empire>; updatedArmy: Partial<Army>; updatedPlanets: { id: string; shortTermProduction: number }[]; report: TurnReport }> {
  const decTurnsLeft = opts?.decrementTurnsLeft !== false;
  const endgameSettlement = opts?.endgameSettlement === true;
  const events: string[] = [];
  const pendingAlerts = empire.pendingDefenderAlerts ?? [];
  for (const msg of pendingAlerts) {
    events.push(`ALERT: ${msg}`);
  }
  const counts = countPlanetsByType(planets);
  const totalPlanets = planets.length;
  const govPlanets = counts["GOVERNMENT"] || 0;

  // ----- Step 1: Drift planet production -----
  const planetUpdates: { id: string; shortTermProduction: number }[] = [];
  for (const p of planets) {
    if (p.shortTermProduction !== p.longTermProduction) {
      const diff = p.longTermProduction - p.shortTermProduction;
      const drift = Math.ceil(Math.abs(diff) * ECON.PRODUCTION_DRIFT_RATE) * Math.sign(diff);
      planetUpdates.push({ id: p.id, shortTermProduction: p.shortTermProduction + drift });
    }
  }

  // ----- Step 2-3: Resource production and consumption -----
  const foodPlanets = planets.filter((p) => p.type === "FOOD");
  const orePlanets = planets.filter((p) => p.type === "ORE");
  const petroPlanets = planets.filter((p) => p.type === "PETROLEUM");

  const civilPenalty = empire.civilStatus * POP.CIVIL_STATUS_FACTOR;

  let foodProduced = 0;
  for (const p of foodPlanets) {
    foodProduced += alterNumber(Math.round(PLANET_CONFIG.FOOD.baseProduction * p.shortTermProduction / 100), 5);
  }
  foodProduced = Math.round(foodProduced * (1 - civilPenalty));

  let oreProduced = 0;
  for (const p of orePlanets) {
    oreProduced += alterNumber(Math.round(PLANET_CONFIG.ORE.baseProduction * p.shortTermProduction / 100), 5);
  }
  oreProduced = Math.round(oreProduced * (1 - civilPenalty));

  let fuelProduced = 0;
  for (const p of petroPlanets) {
    fuelProduced += alterNumber(Math.round(PLANET_CONFIG.PETROLEUM.baseProduction * p.shortTermProduction / 100), 5);
  }
  fuelProduced = Math.round(fuelProduced * (1 - civilPenalty));

  const foodConsumedPop = Math.round(empire.population * POP.FOOD_PER_PERSON);
  const foodConsumedArmy = Math.round(army.soldiers * MAINT.SOLDIER_FOOD + army.generals * MAINT.GENERAL_FOOD);
  const foodConsumed = alterNumber(foodConsumedPop + foodConsumedArmy, 5);

  const oreConsumed = alterNumber(Math.round(
    army.fighters * MAINT.FIGHTER_ORE +
    army.defenseStations * MAINT.STATION_ORE +
    army.lightCruisers * MAINT.LIGHT_CRUISER_ORE +
    army.heavyCruisers * MAINT.HEAVY_CRUISER_ORE +
    army.carriers * MAINT.CARRIER_ORE +
    (army.commandShipStrength > 0 ? MAINT.COMMAND_SHIP_ORE : 0)
  ), 5);

  const fuelConsumed = alterNumber(Math.round(
    army.fighters * MAINT.FIGHTER_FUEL +
    army.lightCruisers * MAINT.LIGHT_CRUISER_FUEL +
    army.heavyCruisers * MAINT.HEAVY_CRUISER_FUEL +
    army.carriers * MAINT.CARRIER_FUEL +
    (army.commandShipStrength > 0 ? MAINT.COMMAND_SHIP_FUEL : 0)
  ), 5);

  // ----- Step 4: Auto-sell resources -----
  const market = await getOrCreateMarket();

  const foodSold = Math.floor((foodProduced / 100) * empire.foodSellRate);
  const foodSalesCredits = foodSold > 0 ? Math.round(foodSold * (ECON.BASE_FOOD_PRICE * market.foodRatio / ECON.SELL_RATIO_DIVISOR)) : 0;

  const oreSold = Math.floor((oreProduced / 100) * empire.oreSellRate);
  const oreSalesCredits = oreSold > 0 ? Math.round(oreSold * (ECON.BASE_ORE_PRICE * market.oreRatio / ECON.SELL_RATIO_DIVISOR)) : 0;

  const petroSold = Math.floor((fuelProduced / 100) * empire.petroleumSellRate);
  const petroSalesCredits = petroSold > 0 ? Math.round(petroSold * (ECON.BASE_PETRO_PRICE * market.petroRatio / ECON.SELL_RATIO_DIVISOR)) : 0;

  // ----- Step 5: Calculate income -----
  const populationTax = alterNumber(Math.floor(empire.population * empire.taxRate * ECON.POPULATION_TAX_FACTOR), 5);

  const urbanAvgProd = avgShortTermProd(planets, "URBAN");
  let urbanTax = Math.floor((counts["URBAN"] || 0) * ECON.URBAN_TAX_PER_PLANET);
  urbanTax = alterNumber(Math.floor((urbanTax / 100) * urbanAvgProd), 5);
  const urbanCivilPenalty = Math.round(urbanTax * civilPenalty / 4);
  urbanTax = Math.max(0, urbanTax - urbanCivilPenalty);

  const tourismAvgProd = avgShortTermProd(planets, "TOURISM");
  let tourismIncome = Math.floor((counts["TOURISM"] || 0) * ECON.TOURISM_BASE_CREDITS);
  tourismIncome = alterNumber(Math.floor((tourismIncome / 100) * tourismAvgProd), 5);
  const tourismCivilPenalty = Math.round(tourismIncome * civilPenalty);
  tourismIncome = Math.max(0, tourismIncome - tourismCivilPenalty);

  const playerCount = await getDb().empire.count();
  let galacticRedist = playerCount > 0 ? Math.floor((market.coordinatorPool / playerCount) / 200) : 0;
  if (empire.turnsPlayed < 20) {
    galacticRedist = Math.floor(empire.turnsPlayed * (galacticRedist / 20));
  }

  const totalIncome = populationTax + urbanTax + tourismIncome + foodSalesCredits + oreSalesCredits + petroSalesCredits + galacticRedist;

  // ----- Step 6: Calculate expenses -----
  const planetMaintPerUnit = MAINT.PLANET_BASE + empire.turnsPlayed * MAINT.PLANET_PER_TURN;
  const ohFactor = totalPlanets * (MAINT.IMPERIAL_OVERHEAD_PER_PLANET ?? 0);
  const overheadMult = 1 + ohFactor + ohFactor * ohFactor * 0.3;
  const planetMaintBase = Math.round(Math.max(0, totalPlanets - govPlanets) * planetMaintPerUnit * overheadMult);
  const nonGov = Math.max(1, totalPlanets - govPlanets);
  const govReduction = Math.floor((govPlanets * 4 / nonGov) * planetMaintBase);
  const planetMaintenance = alterNumber(Math.max(0, planetMaintBase - govReduction), 5);

  const militaryMaintenance = alterNumber(
    army.soldiers * MAINT.SOLDIER +
    army.generals * MAINT.GENERAL +
    army.fighters * MAINT.FIGHTER +
    army.defenseStations * MAINT.STATION +
    army.lightCruisers * MAINT.LIGHT_CRUISER +
    army.heavyCruisers * MAINT.HEAVY_CRUISER +
    army.carriers * MAINT.CARRIER,
    5,
  );

  const galacticTax = Math.floor((empire.credits + totalIncome) * ECON.GALACTIC_TAX_RATE);
  const totalExpenses = planetMaintenance + militaryMaintenance + galacticTax;

  // ----- Step 7-8: Apply net changes -----
  let newCredits = empire.credits + totalIncome - totalExpenses;
  let newFood = empire.food + foodProduced - foodConsumed - foodSold;
  let newOre = empire.ore + oreProduced - oreConsumed - oreSold;
  let newFuel = empire.fuel + fuelProduced - fuelConsumed - petroSold;

  // Update coordinator pool
  await getDb().market.update({
    where: { id: market.id },
    data: {
      coordinatorPool: { increment: galacticTax - galacticRedist },
      foodSupply: { increment: Math.max(0, foodSold + ECON.MARKET_NATURAL_GROWTH) },
      oreSupply: { increment: Math.max(0, oreSold + ECON.MARKET_NATURAL_GROWTH) },
      petroSupply: { increment: Math.max(0, petroSold + ECON.MARKET_NATURAL_GROWTH) },
    },
  });

  // ----- Step 9: Population dynamics -----
  const urbanSumProd = sumShortTermProd(planets, "URBAN");
  const urbanBonus = urbanSumProd / 100 * POP.URBAN_GROWTH_FACTOR;

  // Pollution calculation
  const petroProdShort = avgShortTermProd(planets, "PETROLEUM");
  const pollutionFromPetro = Math.floor(((counts["PETROLEUM"] || 0) / 100) * petroProdShort) * POLLUTION.PER_PETRO_PLANET;
  const pollutionFromPop = empire.population * POLLUTION.PER_PERSON;
  const totalPollution = pollutionFromPetro + pollutionFromPop;

  const antiPolluPlanets = counts["ANTI_POLLUTION"] || 0;
  const antiPolluProd = avgShortTermProd(planets, "ANTI_POLLUTION");
  const antipollution = antiPolluPlanets * POLLUTION.ANTI_POLLUTION_ABSORPTION * (antiPolluProd / 100);
  const pollutionRatio = totalPollution / Math.max(1, antipollution);

  // Births
  const bornPrime = empire.population * POP.BIRTH_RATE;
  const bornBase = bornPrime * urbanBonus;
  const bornPollutionPenalty = bornBase * pollutionRatio;
  const bornCivilPenalty = bornBase * civilPenalty;
  const taxMult = getTaxBirthMultiplier(empire.taxRate);
  const bornTaxPenalty = bornPrime * urbanBonus * taxMult * empire.taxRate * POP.TAX_IMMIGRATION_PENALTY * 0.5;
  let births = Math.max(0, Math.round(bornBase - bornPollutionPenalty - bornCivilPenalty - bornTaxPenalty));
  if (newFood < 0) births = Math.floor(births / 4);
  births = alterNumber(births, 5);

  // Deaths
  const deathsPrime = empire.population * POP.DEATH_RATE;
  const deathsPollution = deathsPrime * pollutionRatio;
  const deathsCivil = deathsPrime * civilPenalty;
  let deaths = Math.round(deathsPrime + deathsPollution + deathsCivil);
  deaths = alterNumber(deaths, 5);

  // Immigration
  const eduPlanets = counts["EDUCATION"] || 0;
  const immigBase = eduPlanets * POP.EDUCATION_IMMIGRATION;
  const immigPollution = immigBase * pollutionRatio;
  const immigCivil = immigBase * civilPenalty;
  const immigTax = immigBase * empire.taxRate * POP.TAX_IMMIGRATION_PENALTY;
  let immigration = Math.max(0, Math.round(immigBase - immigPollution - immigCivil - immigTax));
  immigration = alterNumber(immigration, 5);

  // Emigration
  const urbanCapacity = (counts["URBAN"] || 0) * POP.OVERCROWD_CAPACITY_PER_URBAN;
  const overcrowdExcess = Math.max(0, empire.population - urbanCapacity);
  const emigOvercrowd = overcrowdExcess * POP.OVERCROWD_EMIGRATION_RATE;
  const emigTax = empire.population * empire.taxRate * POP.TAX_EMIGRATION_FACTOR;
  const emigCivil = empire.population * empire.civilStatus * POP.CIVIL_STATUS_FACTOR;
  let emigration = Math.round(emigOvercrowd + emigTax + emigCivil);
  emigration = alterNumber(emigration, 5);

  let newPopulation = Math.max(0, empire.population + births + immigration - deaths - emigration);

  // ----- Step 10: Civil status -----
  let newCivilStatus = empire.civilStatus;
  let newSoldiers = army.soldiers;
  let newGenerals = army.generals;
  let newFighters = army.fighters;
  let newLightCruisers = army.lightCruisers;
  let newHeavyCruisers = army.heavyCruisers;
  let newCarriers = army.carriers;
  let newCovertAgents = army.covertAgents;

  // Excess covert agents check
  const maxCovert = govPlanets * MIL.COVERT_PER_GOV_PLANET;
  if (newCovertAgents > maxCovert && maxCovert >= 0) {
    if (rng.random() < 0.5) {
      newCivilStatus = Math.min(7, newCivilStatus + 1);
      events.push("Internal conflicts erupt due to excess covert agents!");
    }
    const excess = newCovertAgents - maxCovert;
    const lost = Math.floor(excess * 0.25);
    newCovertAgents -= lost;
    if (lost > 0) events.push(`${lost} covert agents found dead.`);
  }

  // Military desertion from civil unrest
  if (newCivilStatus > 0) {
    const rate = (newCivilStatus * CIVIL_DESERTION_RATE_PER_LEVEL) / 100;
    const soldLost = Math.floor(newSoldiers * rate);
    const fightLost = Math.floor(newFighters * rate);
    const lcLost = Math.floor(newLightCruisers * rate);
    const hcLost = Math.floor(newHeavyCruisers * rate);
    const carLost = Math.floor(newCarriers * rate);
    newSoldiers -= soldLost;
    newFighters -= fightLost;
    newLightCruisers -= lcLost;
    newHeavyCruisers -= hcLost;
    newCarriers -= carLost;
    const totalDeserted = soldLost + fightLost + lcLost + hcLost + carLost;
    if (totalDeserted > 0) events.push(`${newCivilStatus * CIVIL_DESERTION_RATE_PER_LEVEL}% of your army deserted due to civil unrest.`);
  }

  // Civil recovery check (probabilistic, covert-agent based)
  if (newCivilStatus > 0 && newCredits >= 0 && newFood >= 0 && totalPlanets > 0) {
    const recoveryChance = (newCovertAgents / (totalPlanets * 0.2)) * 100;
    if (rng.random() * 100 <= recoveryChance) {
      newCivilStatus = Math.max(0, newCivilStatus - 1);
      events.push("Insurgency situation improving.");
    }
  }

  // ----- Step 11: Deficit consequences -----
  // Food deficit
  if (newFood < 0) {
    const popLost = Math.floor(newPopulation * DEFICIT.STARVATION_POP_LOSS);
    const soldLost = Math.floor(newSoldiers * DEFICIT.STARVATION_SOLDIER_LOSS);
    const genLost = Math.floor(newGenerals * DEFICIT.STARVATION_SOLDIER_LOSS);
    newPopulation -= popLost;
    newSoldiers -= soldLost;
    newGenerals -= genLost;
    newCivilStatus = Math.min(7, newCivilStatus + 1);
    newFood = 0;
    events.push(`STARVATION: ${popLost.toLocaleString()} population and ${soldLost} soldiers died.`);
  }

  // Credits deficit
  if (newCredits < 0) {
    const planetsToRelease = Math.max(1, Math.ceil(totalPlanets * DEFICIT.BANKRUPT_PLANET_LOSS));
    events.push(`BANKRUPTCY: ${planetsToRelease} planets released, 10% military disbanded.`);
    // We'll handle planet deletion in the caller
    newSoldiers -= Math.ceil(newSoldiers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newGenerals -= Math.ceil(newGenerals * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newFighters -= Math.ceil(newFighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newLightCruisers -= Math.ceil(newLightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newHeavyCruisers -= Math.ceil(newHeavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newCarriers -= Math.ceil(newCarriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng.random() < 0.2) newCivilStatus = Math.min(7, newCivilStatus + 1);
    newCredits = 0;
  }

  // Ore deficit
  if (newOre < 0) {
    newFighters -= Math.ceil(newFighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newLightCruisers -= Math.ceil(newLightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newHeavyCruisers -= Math.ceil(newHeavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newCarriers -= Math.ceil(newCarriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng.random() < 0.2) newCivilStatus = Math.min(7, newCivilStatus + 1);
    newOre = 0;
    events.push("ORE DEFICIT: 10% of mechanical units disbanded.");
  }

  // Fuel deficit
  if (newFuel < 0) {
    newFighters -= Math.ceil(newFighters * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newLightCruisers -= Math.ceil(newLightCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newHeavyCruisers -= Math.ceil(newHeavyCruisers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    newCarriers -= Math.ceil(newCarriers * DEFICIT.BANKRUPT_MILITARY_LOSS);
    if (rng.random() < 0.2) newCivilStatus = Math.min(7, newCivilStatus + 1);
    newFuel = 0;
    events.push("FUEL DEFICIT: 10% of fuel-consuming units disbanded.");
  }

  // Clamp negatives
  newSoldiers = Math.max(0, newSoldiers);
  newGenerals = Math.max(0, newGenerals);
  newFighters = Math.max(0, newFighters);
  newLightCruisers = Math.max(0, newLightCruisers);
  newHeavyCruisers = Math.max(0, newHeavyCruisers);
  newCarriers = Math.max(0, newCarriers);
  newCovertAgents = Math.max(0, newCovertAgents);
  newPopulation = Math.max(0, newPopulation);

  // ----- Step 12: Empire collapse check -----
  if (newPopulation < 10 || totalPlanets === 0) {
    events.push("YOUR EMPIRE HAS COLLAPSED!");
  }

  // ----- Step 13: Net worth -----
  const netWorth = Math.floor(
    newPopulation * NETWORTH.POPULATION +
    newCredits * NETWORTH.CREDITS +
    totalPlanets * NETWORTH.PLANETS +
    newSoldiers * NETWORTH.SOLDIER +
    newFighters * NETWORTH.FIGHTER +
    army.defenseStations * NETWORTH.STATION +
    newLightCruisers * NETWORTH.LIGHT_CRUISER +
    newHeavyCruisers * NETWORTH.HEAVY_CRUISER +
    newCarriers * NETWORTH.CARRIER +
    newGenerals * NETWORTH.GENERAL +
    newCovertAgents * NETWORTH.COVERT
  );

  // ----- Step 14-16: Recovery and growth -----
  const newEffectiveness = Math.min(MIL.EFFECTIVENESS_MAX, army.effectiveness + MIL.EFFECTIVENESS_RECOVERY);
  const newCommandShip = army.commandShipStrength > 0
    ? Math.min(MIL.COMMAND_SHIP_MAX, army.commandShipStrength + MIL.COMMAND_SHIP_GROWTH)
    : 0;
  const newCovertPoints = Math.min(MIL.MAX_COVERT_POINTS, army.covertPoints + MIL.COVERT_POINTS_PER_TURN);

  // ----- Step 17: Supply planet production -----
  if (supplyRates) {
    const supplyPlanets = planets.filter((p) => p.type === "SUPPLY");
    if (supplyPlanets.length > 0) {
      const rawProd = supplyPlanets.reduce((s, p) => s + p.shortTermProduction, 0) / 100;
      const effProd = (rawProd + rng.random() * rawProd / 16) / 100;

      const prodSoldiers = Math.floor(supplyRates.rateSoldier / 100 * effProd * Math.floor(8000 / UNIT_COST.SOLDIER));
      const prodFighters = Math.floor(supplyRates.rateFighter / 100 * effProd * Math.floor(8000 / UNIT_COST.FIGHTER));
      const prodStations = Math.floor(supplyRates.rateStation / 100 * effProd * Math.floor(8000 / UNIT_COST.DEFENSE_STATION));
      const prodHC = Math.floor(supplyRates.rateHeavyCruiser / 100 * effProd * Math.floor(8000 / UNIT_COST.HEAVY_CRUISER));
      const prodCarriers = Math.floor(supplyRates.rateCarrier / 100 * effProd * Math.floor(8000 / UNIT_COST.CARRIER));
      const prodGenerals = Math.floor(supplyRates.rateGeneral / 100 * effProd * Math.floor(8000 / UNIT_COST.GENERAL));
      const prodCovert = Math.floor(supplyRates.rateCovert / 100 * effProd * Math.floor(8000 / UNIT_COST.COVERT_AGENT));
      const prodCredits = Math.floor(supplyRates.rateCredits / 100 * effProd * 4000);

      newSoldiers += prodSoldiers;
      newFighters += prodFighters;
      newHeavyCruisers += prodHC;
      newCarriers += prodCarriers;
      newGenerals += prodGenerals;
      newCovertAgents += prodCovert;
      newCredits += prodCredits;

      if (prodSoldiers + prodFighters + prodStations + prodHC + prodCarriers + prodGenerals + prodCovert > 0) {
        events.push(`Supply planets produced: ${[
          prodSoldiers && `${prodSoldiers} soldiers`,
          prodFighters && `${prodFighters} fighters`,
          prodStations && `${prodStations} stations`,
          prodHC && `${prodHC} heavy cruisers`,
          prodCarriers && `${prodCarriers} carriers`,
          prodGenerals && `${prodGenerals} generals`,
          prodCovert && `${prodCovert} covert agents`,
          prodCredits && `${prodCredits} credits`,
        ].filter(Boolean).join(", ")}`);
      }
    }
  }

  // Light cruisers from research planets
  const researchPlanets = planets.filter((p) => p.type === "RESEARCH");
  if (researchPlanets.length > 0) {
    const lcProduced = Math.floor(researchPlanets.reduce((s, p) => s + p.shortTermProduction / 100, 0) * 5);
    if (lcProduced > 0) {
      newLightCruisers += lcProduced;
      events.push(`Research planets produced ${lcProduced} light cruisers.`);
    }
  }

  // ----- Step 18: Random event -----
  if (rng.random() < RANDOM_EVENT_CHANCE) {
    const eventRoll = rng.random();
    if (eventRoll < 0.33) {
      const bonus = alterNumber(2000, 20);
      newCredits += bonus;
      events.push(`RANDOM EVENT: Asteroid mining windfall! +${bonus} credits.`);
    } else if (eventRoll < 0.66) {
      const popBoost = alterNumber(1000, 20);
      newPopulation += popBoost;
      events.push(`RANDOM EVENT: Refugee wave arrives! +${popBoost} population.`);
    } else {
      const foodBoost = alterNumber(200, 20);
      newFood += foodBoost;
      events.push(`RANDOM EVENT: Bumper harvest! +${foodBoost} food.`);
    }
  }

  // ----- Step 19: Protection -----
  let newProtectionTurns = empire.protectionTurns;
  let newIsProtected = empire.isProtected;
  if (newIsProtected && newProtectionTurns > 0) {
    newProtectionTurns--;
    if (newProtectionTurns <= 0) {
      newIsProtected = false;
      events.push("Protection period has ended. You are now vulnerable to attacks.");
    }
  }

  const report: TurnReport = {
    income: {
      populationTax: populationTax,
      urbanTax: urbanTax,
      tourism: tourismIncome,
      foodSales: foodSalesCredits,
      oreSales: oreSalesCredits,
      petroSales: petroSalesCredits,
      galacticRedistribution: galacticRedist,
      total: totalIncome,
    },
    expenses: {
      planetMaintenance: planetMaintenance,
      militaryMaintenance: militaryMaintenance,
      galacticTax: galacticTax,
      total: totalExpenses,
    },
    population: {
      births,
      deaths,
      immigration,
      emigration,
      net: births + immigration - deaths - emigration,
      newTotal: newPopulation,
    },
    resources: {
      foodProduced, foodConsumed: foodConsumed + foodSold,
      oreProduced, oreConsumed: oreConsumed + oreSold,
      fuelProduced, fuelConsumed: fuelConsumed + petroSold,
    },
    civilStatus: ["Peaceful", "Mild Insurgencies", "Occasional Riots", "Violent Demonstrations", "Political Conflicts", "Internal Violence", "Revolutionary Warfare", "Under Coup"][newCivilStatus] ?? "Unknown",
    netWorth,
    events,
  };

  return {
    updatedEmpire: {
      credits: newCredits,
      food: newFood,
      ore: newOre,
      fuel: newFuel,
      population: newPopulation,
      civilStatus: newCivilStatus,
      netWorth,
      turnsPlayed: endgameSettlement ? empire.turnsPlayed : empire.turnsPlayed + 1,
      turnsLeft: decTurnsLeft ? empire.turnsLeft - 1 : empire.turnsLeft,
      isProtected: newIsProtected,
      protectionTurns: newProtectionTurns,
      pendingDefenderAlerts: [],
    },
    updatedArmy: {
      soldiers: newSoldiers,
      generals: newGenerals,
      fighters: newFighters,
      defenseStations: army.defenseStations + (supplyRates ? Math.floor(supplyRates.rateStation / 100 * ((planets.filter(p => p.type === "SUPPLY").reduce((s, p) => s + p.shortTermProduction, 0) / 100 + 0) / 100) * Math.floor(8000 / UNIT_COST.DEFENSE_STATION)) : 0),
      lightCruisers: newLightCruisers,
      heavyCruisers: newHeavyCruisers,
      carriers: newCarriers,
      covertAgents: newCovertAgents,
      effectiveness: newEffectiveness,
      commandShipStrength: newCommandShip,
      covertPoints: newCovertPoints,
    },
    updatedPlanets: planetUpdates,
    report,
  };
}

// ---------------------------------------------------------------------------
// Run & Persist Turn Tick (Phase 1 — before player chooses action)
// ---------------------------------------------------------------------------

const playerInclude = {
  empire: { include: { planets: true, army: true, supplyRates: true, research: true } },
} as const;

export async function runAndPersistTick(
  playerId: string,
  opts?: ProcessTurnTickOptions,
): Promise<TurnReport | null> {
  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: playerInclude,
  });

  if (!player?.empire) return null;
  const empire = player.empire;
  const army = empire.army;
  if (!army || empire.turnsLeft < 1) return null;
  if (empire.tickProcessed) return null;

  const tick = await processTurnTick(empire, army, empire.planets, empire.supplyRates, opts);

  await getDb().empire.update({
    where: { id: empire.id },
    data: { ...toEmpireUpdateData(tick.updatedEmpire), tickProcessed: true },
  });
  await getDb().army.update({
    where: { id: army.id },
    data: tick.updatedArmy,
  });
  for (const pu of tick.updatedPlanets) {
    await getDb().planet.update({
      where: { id: pu.id },
      data: { shortTermProduction: pu.shortTermProduction },
    });
  }

  return tick.report;
}

/**
 * Research RP accrual, loan payments, and bond maturity — runs after the main economy tick in `processAction`,
 * and again after `runEndgameSettlementTick`'s settlement tick so finance stays consistent.
 */
async function applyPostActionEconomyFinance(
  empireId: string,
  tick: { updatedEmpire: Partial<Empire>; report: TurnReport },
  planets: Planet[],
  research: { id: string } | null,
): Promise<void> {
  const researchPlanetCount = planets.filter((p) => p.type === "RESEARCH").length;
  if (researchPlanetCount > 0 && research) {
    const rpProduced = researchPlanetCount * PLANET_CONFIG.RESEARCH.baseProduction;
    await getDb().research.update({
      where: { id: research.id },
      data: { accumulatedPoints: { increment: rpProduced } },
    });
  }

  const activeLoans = await getDb().loan.findMany({ where: { empireId } });
  for (const loan of activeLoans) {
    if (loan.turnsRemaining > 0) {
      const payment = Math.floor(loan.balance / loan.turnsRemaining);
      const interest = Math.floor((payment / 100) * loan.interestRate);
      const totalPayment = payment + interest;
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - totalPayment;

      const lotteryContrib = Math.floor(totalPayment * 0.1);
      const mkt = await getOrCreateMarket();
      await getDb().market.update({ where: { id: mkt.id }, data: { lotteryPool: { increment: lotteryContrib } } });

      const newBalance = loan.balance - payment;
      if (newBalance <= 0 || loan.turnsRemaining <= 1) {
        await getDb().loan.delete({ where: { id: loan.id } });
      } else {
        await getDb().loan.update({
          where: { id: loan.id },
          data: { balance: newBalance, turnsRemaining: loan.turnsRemaining - 1 },
        });
      }
    }
  }

  const activeBonds = await getDb().bond.findMany({ where: { empireId } });
  for (const bond of activeBonds) {
    if (bond.turnsRemaining <= 1) {
      const payout = bond.amount + Math.floor(bond.amount * bond.interestRate / 100);
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + payout;
      await getDb().bond.delete({ where: { id: bond.id } });
      tick.report.events.push(`Bond matured: received ${payout.toLocaleString()} credits.`);
    } else {
      await getDb().bond.update({
        where: { id: bond.id },
        data: { turnsRemaining: bond.turnsRemaining - 1 },
      });
    }
  }
}

/**
 * After the final playable turn (`turnsLeft` just reached 0), run one more full economy tick from the
 * post–final-action state so income, maintenance, and random resolution match what the next turn would have
 * applied. Does not increment `turnsPlayed`. Door-game: invoked from `closeFullTurn`; sequential: from `processAction`.
 */
export async function runEndgameSettlementTick(playerId: string): Promise<TurnReport | null> {
  const already = await getDb().turnLog.findFirst({
    where: { playerId, action: "endgame_settlement" },
    select: { id: true },
  });
  if (already) return null;

  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: playerInclude,
  });
  if (!player?.empire) return null;
  const empire = player.empire;
  const army = empire.army;
  if (!army) return null;
  if (empire.turnsLeft !== 0) return null;

  const tick = await processTurnTick(empire, army, empire.planets, empire.supplyRates, {
    decrementTurnsLeft: false,
    endgameSettlement: true,
  });

  await applyPostActionEconomyFinance(empire.id, tick, empire.planets, empire.research ?? null);

  await getDb().empire.update({
    where: { id: empire.id },
    data: { ...toEmpireUpdateData(tick.updatedEmpire), tickProcessed: true },
  });
  await getDb().army.update({
    where: { id: army.id },
    data: tick.updatedArmy,
  });
  for (const pu of tick.updatedPlanets) {
    await getDb().planet.update({
      where: { id: pu.id },
      data: { shortTermProduction: pu.shortTermProduction },
    });
  }

  await getDb().turnLog.create({
    data: {
      playerId,
      action: "endgame_settlement",
      details: {
        actionMsg: "Endgame economy settlement (applies one full tick from post–final-action state).",
        report: tick.report,
      } as object,
    },
  });

  return tick.report;
}

// ---------------------------------------------------------------------------
// Main Action Processor (Phase 2 — executes the chosen action)
// ---------------------------------------------------------------------------

export async function processAction(
  playerId: string,
  action: ActionType,
  params?: Record<string, unknown>,
  options?: ProcessActionOptions,
): Promise<ActionResult> {
  const player = await getDb().player.findUnique({
    where: { id: playerId },
    include: playerInclude,
  });

  if (!player?.empire) return { success: false, message: "Empire not found." };
  if (!player.empire.army) return { success: false, message: "Army not found." };

  const sessionFilter = player.gameSessionId ? { gameSessionId: player.gameSessionId } : {};
  let empire = player.empire;
  const army = player.empire.army;
  const planets = player.empire.planets;
  const supplyRates = player.empire.supplyRates;

  if (empire.turnsLeft < 1) {
    return { success: false, message: "No turns remaining." };
  }

  /** Income tick already ran (`POST /api/game/tick` or `runAndPersistTick`). Action phase uses a stub report with zeros — do not persist that stub as the economy (see TurnLog below). */
  const tickAlreadyPersisted = empire.tickProcessed;

  // If tick hasn't run yet (AI path or legacy), run it now
  let tickReport: TurnReport | undefined;
  let tick: { updatedEmpire: Partial<Empire>; updatedArmy: Partial<Army>; updatedPlanets: { id: string; shortTermProduction: number }[]; report: TurnReport };

  if (!empire.tickProcessed) {
    tick = await processTurnTick(empire, army, planets, supplyRates, options?.tickOptions);
    tickReport = tick.report;
  } else {
    // Tick already persisted — seed with current DB values so action cases
    // can read/write tick.updatedEmpire.credits etc. correctly
    tick = {
      updatedEmpire: {
        credits: empire.credits,
        food: empire.food,
        ore: empire.ore,
        fuel: empire.fuel,
        population: empire.population,
        civilStatus: empire.civilStatus,
        netWorth: empire.netWorth,
        turnsPlayed: empire.turnsPlayed,
        turnsLeft: empire.turnsLeft,
        isProtected: empire.isProtected,
        protectionTurns: empire.protectionTurns,
        taxRate: empire.taxRate,
        foodSellRate: empire.foodSellRate,
        oreSellRate: empire.oreSellRate,
        petroleumSellRate: empire.petroleumSellRate,
      },
      updatedArmy: {
        soldiers: army.soldiers,
        generals: army.generals,
        fighters: army.fighters,
        defenseStations: army.defenseStations,
        lightCruisers: army.lightCruisers,
        heavyCruisers: army.heavyCruisers,
        carriers: army.carriers,
        covertAgents: army.covertAgents,
        commandShipStrength: army.commandShipStrength,
        effectiveness: army.effectiveness,
        covertPoints: army.covertPoints,
      },
      updatedPlanets: [],
      report: { income: { populationTax: 0, urbanTax: 0, tourism: 0, foodSales: 0, oreSales: 0, petroSales: 0, galacticRedistribution: 0, total: 0 }, expenses: { planetMaintenance: 0, militaryMaintenance: 0, galacticTax: 0, total: 0 }, population: { births: 0, deaths: 0, immigration: 0, emigration: 0, net: 0, newTotal: empire.population }, resources: { foodProduced: 0, foodConsumed: 0, oreProduced: 0, oreConsumed: 0, fuelProduced: 0, fuelConsumed: 0 }, civilStatus: "", netWorth: empire.netWorth, events: [] },
    };
  }

  // Execute player action
  let actionMsg = "";
  const actionDetails: Record<string, unknown> = {};

  switch (action) {
    case "buy_planet": {
      const planetType = (params?.type as string || "FOOD").toUpperCase() as PlanetTypeName;
      const config = PLANET_CONFIG[planetType];
      if (!config) return { success: false, message: "Invalid planet type." };

      const cost = Math.round(config.baseCost * (1 + (tick.updatedEmpire.netWorth ?? 0) * COST_INFLATION));
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits to colonize a ${config.label} planet.` };
      }

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;

      await getDb().planet.create({
        data: {
          empireId: empire.id,
          name: generatePlanetName(),
          sector: rng.randomInt(1, 100),
          type: planetType as PlanetType,
          longTermProduction: 100,
          shortTermProduction: 100,
        },
      });

      actionMsg = `Colonized a new ${config.label} planet for ${cost} credits.`;
      break;
    }

    case "set_tax_rate": {
      const rate = Math.max(0, Math.min(100, Number(params?.rate ?? empire.taxRate)));
      tick.updatedEmpire.taxRate = rate;
      actionMsg = `Tax rate set to ${rate}%.`;
      break;
    }

    case "set_sell_rates": {
      const food = Math.max(0, Math.min(100, Number(params?.foodSellRate ?? empire.foodSellRate)));
      const ore = Math.max(0, Math.min(100, Number(params?.oreSellRate ?? empire.oreSellRate)));
      const petro = Math.max(0, Math.min(100, Number(params?.petroleumSellRate ?? empire.petroleumSellRate)));
      tick.updatedEmpire.foodSellRate = food;
      tick.updatedEmpire.oreSellRate = ore;
      tick.updatedEmpire.petroleumSellRate = petro;
      actionMsg = `Sell rates updated: Food ${food}%, Ore ${ore}%, Petroleum ${petro}%.`;
      break;
    }

    case "set_supply_rates": {
      if (!supplyRates) {
        return { success: false, message: "No supply configuration found." };
      }
      const rates = {
        rateSoldier: Number(params?.rateSoldier ?? supplyRates.rateSoldier),
        rateFighter: Number(params?.rateFighter ?? supplyRates.rateFighter),
        rateStation: Number(params?.rateStation ?? supplyRates.rateStation),
        rateHeavyCruiser: Number(params?.rateHeavyCruiser ?? supplyRates.rateHeavyCruiser),
        rateCarrier: Number(params?.rateCarrier ?? supplyRates.rateCarrier),
        rateGeneral: Number(params?.rateGeneral ?? supplyRates.rateGeneral),
        rateCovert: Number(params?.rateCovert ?? supplyRates.rateCovert),
        rateCredits: Number(params?.rateCredits ?? supplyRates.rateCredits),
      };
      const total = Object.values(rates).reduce((s, v) => s + v, 0);
      if (total !== 100) {
        return { success: false, message: `Supply rates must sum to 100 (got ${total}).` };
      }
      await getDb().supplyRates.update({ where: { id: supplyRates.id }, data: rates });
      actionMsg = "Supply production rates updated.";
      break;
    }

    case "buy_soldiers": {
      const count = Math.max(1, Number(params?.amount ?? 10));
      const cost = count * UNIT_COST.SOLDIER;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} soldiers.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.soldiers = (tick.updatedArmy.soldiers ?? 0) + count;
      actionMsg = `Recruited ${count} soldiers for ${cost} credits.`;
      break;
    }

    case "buy_generals": {
      const count = Math.max(1, Number(params?.amount ?? 1));
      const govPlanets = planets.filter((p) => p.type === "GOVERNMENT").length;
      const maxGenerals = govPlanets * MIL.GENERALS_PER_GOV_PLANET;
      if ((tick.updatedArmy.generals ?? 0) + count > maxGenerals) {
        return { success: false, message: `Max ${maxGenerals} generals (need more government planets).` };
      }
      const cost = count * UNIT_COST.GENERAL;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} generals.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.generals = (tick.updatedArmy.generals ?? 0) + count;
      actionMsg = `Promoted ${count} generals for ${cost} credits.`;
      break;
    }

    case "buy_fighters": {
      const count = Math.max(1, Number(params?.amount ?? 5));
      const cost = count * UNIT_COST.FIGHTER;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} fighters.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.fighters = (tick.updatedArmy.fighters ?? 0) + count;
      actionMsg = `Built ${count} fighters for ${cost} credits.`;
      break;
    }

    case "buy_stations": {
      const count = Math.max(1, Number(params?.amount ?? 2));
      const cost = count * UNIT_COST.DEFENSE_STATION;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} defense stations.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.defenseStations = (tick.updatedArmy.defenseStations ?? 0) + count;
      actionMsg = `Constructed ${count} defense stations for ${cost} credits.`;
      break;
    }

    case "buy_light_cruisers": {
      const count = Math.max(1, Number(params?.amount ?? 1));
      const cost = count * UNIT_COST.LIGHT_CRUISER;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} light cruisers.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.lightCruisers = (tick.updatedArmy.lightCruisers ?? 0) + count;
      actionMsg = `Built ${count} light cruisers for ${cost} credits.`;
      break;
    }

    case "buy_heavy_cruisers": {
      const count = Math.max(1, Number(params?.amount ?? 1));
      const cost = count * UNIT_COST.HEAVY_CRUISER;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} heavy cruisers.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.heavyCruisers = (tick.updatedArmy.heavyCruisers ?? 0) + count;
      actionMsg = `Built ${count} heavy cruisers for ${cost} credits.`;
      break;
    }

    case "buy_carriers": {
      const count = Math.max(1, Number(params?.amount ?? 1));
      const cost = count * UNIT_COST.CARRIER;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} carriers.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.carriers = (tick.updatedArmy.carriers ?? 0) + count;
      actionMsg = `Built ${count} carriers for ${cost} credits.`;
      break;
    }

    case "buy_covert_agents": {
      const count = Math.max(1, Number(params?.amount ?? 5));
      const govPlanets = planets.filter((p) => p.type === "GOVERNMENT").length;
      const maxCovert = govPlanets * MIL.COVERT_PER_GOV_PLANET;
      if ((tick.updatedArmy.covertAgents ?? 0) + count > maxCovert) {
        return { success: false, message: `Max ${maxCovert} covert agents (need more government planets).` };
      }
      const cost = count * UNIT_COST.COVERT_AGENT;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for ${count} covert agents.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.covertAgents = (tick.updatedArmy.covertAgents ?? 0) + count;
      actionMsg = `Recruited ${count} covert agents for ${cost} credits.`;
      break;
    }

    case "buy_command_ship": {
      if (army.commandShipStrength > 0) {
        return { success: false, message: "You already have a command ship." };
      }
      const cost = UNIT_COST.COMMAND_SHIP;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost} credits for a command ship.` };
      }
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      tick.updatedArmy.commandShipStrength = 10;
      actionMsg = `Command ship commissioned for ${cost} credits!`;
      break;
    }

    case "attack_conventional": {
      const targetName = params?.target as string;
      if (!targetName) return { success: false, message: "No target specified." };
      if ((tick.updatedArmy.generals ?? 0) < 1) return { success: false, message: "Need at least 1 general to attack." };

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: { include: { planets: true, army: true } } },
      });
      if (!targetPlayer?.empire?.army) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot attack your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const atkSnap = {
        soldiers: tick.updatedArmy.soldiers ?? army.soldiers,
        generals: tick.updatedArmy.generals ?? army.generals,
        fighters: tick.updatedArmy.fighters ?? army.fighters,
        defenseStations: tick.updatedArmy.defenseStations ?? army.defenseStations,
        lightCruisers: tick.updatedArmy.lightCruisers ?? army.lightCruisers,
        heavyCruisers: tick.updatedArmy.heavyCruisers ?? army.heavyCruisers,
        carriers: tick.updatedArmy.carriers ?? army.carriers,
        covertAgents: tick.updatedArmy.covertAgents ?? army.covertAgents,
        commandShipStrength: tick.updatedArmy.commandShipStrength ?? army.commandShipStrength,
        effectiveness: tick.updatedArmy.effectiveness ?? army.effectiveness,
        soldiersLevel: army.soldiersLevel,
        fightersLevel: army.fightersLevel,
        stationsLevel: army.stationsLevel,
        lightCruisersLevel: army.lightCruisersLevel,
        heavyCruisersLevel: army.heavyCruisersLevel,
      };

      const defArmy = targetPlayer.empire.army;
      const defSnap = {
        soldiers: defArmy.soldiers,
        generals: defArmy.generals,
        fighters: defArmy.fighters,
        defenseStations: defArmy.defenseStations,
        lightCruisers: defArmy.lightCruisers,
        heavyCruisers: defArmy.heavyCruisers,
        carriers: defArmy.carriers,
        covertAgents: defArmy.covertAgents,
        commandShipStrength: defArmy.commandShipStrength,
        effectiveness: defArmy.effectiveness,
        soldiersLevel: defArmy.soldiersLevel,
        fightersLevel: defArmy.fightersLevel,
        stationsLevel: defArmy.stationsLevel,
        lightCruisersLevel: defArmy.lightCruisersLevel,
        heavyCruisersLevel: defArmy.heavyCruisersLevel,
      };

      const result = runConventionalInvasion(
        atkSnap, defSnap,
        targetPlayer.empire.planets.length,
        targetPlayer.empire.credits,
        targetPlayer.empire.population,
      );

      // Apply attacker losses
      for (const [k, v] of Object.entries(result.attackerLosses)) {
        if (v > 0 && k in (tick.updatedArmy as Record<string, unknown>)) {
          (tick.updatedArmy as Record<string, number>)[k] = Math.max(0, ((tick.updatedArmy as Record<string, number>)[k] ?? 0) - v);
        }
      }

      // Apply defender losses
      const defUpdates: Record<string, number> = {};
      for (const [k, v] of Object.entries(result.defenderLosses)) {
        if (v > 0) defUpdates[k] = Math.max(0, (defArmy as unknown as Record<string, number>)[k] - v);
      }
      await getDb().army.update({ where: { id: defArmy.id }, data: defUpdates });

      // Effectiveness changes
      if (result.victory) {
        tick.updatedArmy.effectiveness = Math.min(MIL.EFFECTIVENESS_MAX,
          (tick.updatedArmy.effectiveness ?? army.effectiveness) + MIL.EFFECTIVENESS_WON_INVASION);

        // Transfer loot
        if (result.loot) {
          tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + result.loot.creditsLooted;
          tick.updatedEmpire.population = (tick.updatedEmpire.population ?? 0) + result.loot.populationTransferred;

          await getDb().empire.update({
            where: { id: targetPlayer.empire.id },
            data: {
              credits: { decrement: result.loot.creditsLooted },
              population: { decrement: result.loot.populationTransferred },
              civilStatus: Math.min(7, targetPlayer.empire.civilStatus + 1),
            },
          });

          // Transfer random planets
          const defPlanets = targetPlayer.empire.planets;
          const shuffled = defPlanets.sort(() => rng.random() - 0.5);
          const toCapture = shuffled.slice(0, result.loot.planetsCaptures);
          for (const p of toCapture) {
            await getDb().planet.update({ where: { id: p.id }, data: { empireId: empire.id } });
          }
        }
      } else {
        tick.updatedArmy.effectiveness = Math.max(0,
          (tick.updatedArmy.effectiveness ?? army.effectiveness) - MIL.EFFECTIVENESS_LOST_INVASION);
      }

      const lossSummary = `Your losses: ${formatUnitLossesOrNone(result.attackerLosses)}. Target unit casualties: ${formatUnitLossesOrNone(result.defenderLosses)}.`;
      const lootSummary = result.victory && result.loot
        ? `Planets captured: ${result.loot.planetsCaptures}; credits lost: ${result.loot.creditsLooted.toLocaleString()}; population lost: ${result.loot.populationTransferred.toLocaleString()}.`
        : "";
      await emitGameEvent(player, {
        type: "combat",
        message: `${player.name} attacked ${targetName}: ${result.victory ? "VICTORY" : "DEFEAT"}. ${lossSummary}${lootSummary ? ` ${lootSummary}` : ""}`,
        details: {
          fronts: result.fronts,
          loot: result.loot,
          attackerLosses: result.attackerLosses,
          defenderLosses: result.defenderLosses,
        } as object,
      });

      if (result.victory && result.loot) {
        await pushDefenderAlert(
          targetPlayer.empire.id,
          `Invasion by ${player.name}: attack succeeded. Lost ${result.loot.creditsLooted.toLocaleString()} credits, ${result.loot.populationTransferred.toLocaleString()} population, ${result.loot.planetsCaptures} planet(s) captured. Unit losses: ${formatUnitLossesOrNone(result.defenderLosses)}.`,
        );
      } else {
        await pushDefenderAlert(
          targetPlayer.empire.id,
          `Invasion by ${player.name}: your forces repelled the attack. Your unit losses: ${formatUnitLossesOrNone(result.defenderLosses)}.`,
        );
      }

      actionMsg = [result.messages.join(" "), lossSummary, lootSummary].filter(Boolean).join(" ");
      actionDetails.combatResult = result;
      break;
    }

    case "attack_guerrilla": {
      const targetName = params?.target as string;
      if (!targetName) return { success: false, message: "No target specified." };

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: { include: { army: true } } },
      });
      if (!targetPlayer?.empire?.army) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot attack your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const atkSnap = {
        soldiers: tick.updatedArmy.soldiers ?? army.soldiers,
        generals: tick.updatedArmy.generals ?? army.generals,
        fighters: 0, defenseStations: 0, lightCruisers: 0, heavyCruisers: 0,
        carriers: 0, covertAgents: 0, commandShipStrength: 0,
        effectiveness: tick.updatedArmy.effectiveness ?? army.effectiveness,
        soldiersLevel: army.soldiersLevel, fightersLevel: 0, stationsLevel: 0,
        lightCruisersLevel: 0, heavyCruisersLevel: 0,
      };
      const defArmy = targetPlayer.empire.army;
      const defSnap = {
        soldiers: defArmy.soldiers, generals: defArmy.generals,
        fighters: 0, defenseStations: 0, lightCruisers: 0, heavyCruisers: 0,
        carriers: 0, covertAgents: 0, commandShipStrength: 0,
        effectiveness: defArmy.effectiveness,
        soldiersLevel: defArmy.soldiersLevel, fightersLevel: 0, stationsLevel: 0,
        lightCruisersLevel: 0, heavyCruisersLevel: 0,
      };

      const result = runGuerrillaAttack(atkSnap, defSnap);

      tick.updatedArmy.soldiers = Math.max(0, (tick.updatedArmy.soldiers ?? army.soldiers) - (result.attackerLosses.soldiers ?? 0));
      await getDb().army.update({
        where: { id: defArmy.id },
        data: { soldiers: Math.max(0, defArmy.soldiers - (result.damageDealt.soldiers ?? 0)) },
      });

      const gLoss = `Your soldier losses: ${(result.attackerLosses.soldiers ?? 0).toLocaleString()}. Enemy soldier casualties: ${(result.damageDealt.soldiers ?? 0).toLocaleString()}.`;
      await emitGameEvent(player, {
        type: "combat",
        message: `Guerrilla attack on ${targetName}: ${result.messages[0]} ${gLoss}`,
        details: result as object,
      });

      await pushDefenderAlert(
        targetPlayer.empire.id,
        `Guerrilla strike by ${player.name}: your ground forces lost ${(result.damageDealt.soldiers ?? 0).toLocaleString()} soldiers.`,
      );

      actionMsg = `${result.messages.join(" ")} ${gLoss}`;
      actionDetails.combatResult = {
        victory: (result.damageDealt.soldiers ?? 0) > (result.attackerLosses.soldiers ?? 0),
        attackerLosses: result.attackerLosses,
        defenderLosses: result.damageDealt,
        messages: result.messages,
      };
      break;
    }

    case "attack_nuclear": {
      const targetName = params?.target as string;
      if (!targetName) return { success: false, message: "No target specified." };
      const numNukes = Math.max(1, Number(params?.amount ?? 1));
      const nukeCost = numNukes * 500000000;

      if ((tick.updatedEmpire.credits ?? 0) < nukeCost) {
        return { success: false, message: `Need ${nukeCost.toLocaleString()} credits for ${numNukes} nukes (500M each).` };
      }

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: { include: { planets: true } } },
      });
      if (!targetPlayer?.empire) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot target your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const result = runNuclearStrike(
        targetPlayer.empire.planets.map((p) => ({ id: p.id, name: p.name, population: p.population })),
        numNukes,
      );

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - nukeCost;

      for (const planetId of result.planetsRadiated) {
        await getDb().planet.update({
          where: { id: planetId },
          data: { isRadiated: true, longTermProduction: { decrement: 40 }, shortTermProduction: { decrement: 40 } },
        });
      }

      await getDb().empire.update({
        where: { id: targetPlayer.empire.id },
        data: { population: { decrement: result.populationKilled }, civilStatus: Math.min(7, targetPlayer.empire.civilStatus + 2) },
      });

      const nukePlanetLine = result.planetCasualties
        .map((p) => `${p.planetName}: ${p.populationKilled.toLocaleString()} killed`)
        .join("; ");
      const nukeSummary = `Total population killed: ${result.populationKilled.toLocaleString()}. Planets radiated: ${result.planetsRadiated.length} (${nukePlanetLine}).`;
      await emitGameEvent(player, {
        type: "nuclear",
        message: `${player.name} launched nuclear strike on ${targetName}! ${nukeSummary}`,
        details: result as object,
      });

      await pushDefenderAlert(
        targetPlayer.empire.id,
        `Nuclear strike by ${player.name}! Population lost: ${result.populationKilled.toLocaleString()} (${nukePlanetLine}). ${result.planetsRadiated.length} planet(s) radiated.`,
      );

      actionMsg = `${result.messages.join(" ")} ${nukeSummary}`;
      actionDetails.combatResult = {
        victory: true,
        attackerLosses: {},
        planetCasualties: result.planetCasualties,
        populationKilledTotal: result.populationKilled,
        planetsRadiatedCount: result.planetsRadiated.length,
        messages: result.messages,
      };
      break;
    }

    case "attack_chemical": {
      const targetName = params?.target as string;
      if (!targetName) return { success: false, message: "No target specified." };
      if ((tick.updatedArmy.covertAgents ?? army.covertAgents) < 10) {
        return { success: false, message: "Need at least 10 covert agents to deploy chemical weapons." };
      }

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: { include: { planets: true } } },
      });
      if (!targetPlayer?.empire) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot target your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const result = runChemicalWarfare(
        targetPlayer.empire.planets.map((p) => ({ id: p.id, name: p.name, population: p.population })),
      );

      for (const planetId of result.planetsAffected) {
        await getDb().planet.update({
          where: { id: planetId },
          data: { isRadiated: true },
        });
      }

      await getDb().empire.update({
        where: { id: targetPlayer.empire.id },
        data: { population: { decrement: result.populationKilled } },
      });

      const chemPlanetLine = result.planetCasualties
        .map((p) => `${p.planetName}: ${p.populationKilled.toLocaleString()} killed`)
        .join("; ");

      // Coordinator retaliation against attacker
      const preS = tick.updatedArmy.soldiers ?? army.soldiers;
      const preF = tick.updatedArmy.fighters ?? army.fighters;
      const preH = tick.updatedArmy.heavyCruisers ?? army.heavyCruisers;
      if (result.coordinatorRetaliation) {
        const milLoss = result.retaliationDamage / 100;
        tick.updatedArmy.soldiers = Math.max(0, Math.floor(preS * (1 - milLoss)));
        tick.updatedArmy.fighters = Math.max(0, Math.floor(preF * (1 - milLoss)));
        tick.updatedArmy.heavyCruisers = Math.max(0, Math.floor(preH * (1 - milLoss)));
      }

      const chemAttackerLosses: Record<string, number> = {};
      if (result.coordinatorRetaliation) {
        const ds = preS - (tick.updatedArmy.soldiers ?? 0);
        const df = preF - (tick.updatedArmy.fighters ?? 0);
        const dh = preH - (tick.updatedArmy.heavyCruisers ?? 0);
        if (ds > 0) chemAttackerLosses.soldiers = ds;
        if (df > 0) chemAttackerLosses.fighters = df;
        if (dh > 0) chemAttackerLosses.heavyCruisers = dh;
      }

      const chemSummary = `Target population killed: ${result.populationKilled.toLocaleString()} (${chemPlanetLine}).`;
      const retalSummary = result.coordinatorRetaliation
        ? `Coordinator retaliation — your losses: ${formatUnitLossesOrNone(chemAttackerLosses)}.`
        : "";

      await emitGameEvent(player, {
        type: "chemical",
        message: `${player.name} deployed chemical weapons on ${targetName}! ${chemSummary} ${result.coordinatorRetaliation ? "COORDINATOR RETALIATION! " + formatUnitLossesOrNone(chemAttackerLosses) : ""}`,
        details: result as object,
      });

      await pushDefenderAlert(
        targetPlayer.empire.id,
        `Chemical weapons by ${player.name}! Population killed: ${result.populationKilled.toLocaleString()} — ${chemPlanetLine}. ${result.planetsAffected.length} planet(s) contaminated.`,
      );

      actionMsg = [result.messages.join(" "), chemSummary, retalSummary].filter(Boolean).join(" ");
      actionDetails.combatResult = {
        victory: true,
        attackerLosses: chemAttackerLosses,
        planetCasualties: result.planetCasualties,
        populationKilledTotal: result.populationKilled,
        planetsAffectedCount: result.planetsAffected.length,
        messages: result.messages,
      };
      break;
    }

    case "attack_psionic": {
      const targetName = params?.target as string;
      if (!targetName) return { success: false, message: "No target specified." };

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: { include: { army: true } } },
      });
      if (!targetPlayer?.empire?.army) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot target your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const result = runPsionicBomb();

      await getDb().empire.update({
        where: { id: targetPlayer.empire.id },
        data: { civilStatus: Math.min(7, targetPlayer.empire.civilStatus + result.civilStatusIncrease) },
      });
      await getDb().army.update({
        where: { id: targetPlayer.empire.army.id },
        data: { effectiveness: Math.max(0, targetPlayer.empire.army.effectiveness - result.effectivenessLoss) },
      });

      const psiSummary = `Target civil unrest +${result.civilStatusIncrease} level(s); target army effectiveness −${result.effectivenessLoss}%.`;
      await emitGameEvent(player, {
        type: "psionic",
        message: `${player.name} used psionic bomb on ${targetName}! ${psiSummary}`,
        details: result as object,
      });

      await pushDefenderAlert(
        targetPlayer.empire.id,
        `Psionic attack by ${player.name}: civil unrest +${result.civilStatusIncrease} level(s), army effectiveness −${result.effectivenessLoss}%.`,
      );

      actionMsg = `${result.messages.join(" ")} ${psiSummary}`;
      actionDetails.combatResult = {
        victory: true,
        attackerLosses: {},
        defenderCivilLevelsGained: result.civilStatusIncrease,
        defenderEffectivenessLost: result.effectivenessLoss,
        messages: result.messages,
      };
      break;
    }

    case "attack_pirates": {
      const atkSnap = {
        soldiers: tick.updatedArmy.soldiers ?? army.soldiers,
        generals: tick.updatedArmy.generals ?? army.generals,
        fighters: tick.updatedArmy.fighters ?? army.fighters,
        defenseStations: tick.updatedArmy.defenseStations ?? army.defenseStations,
        lightCruisers: tick.updatedArmy.lightCruisers ?? army.lightCruisers,
        heavyCruisers: tick.updatedArmy.heavyCruisers ?? army.heavyCruisers,
        carriers: tick.updatedArmy.carriers ?? army.carriers,
        covertAgents: tick.updatedArmy.covertAgents ?? army.covertAgents,
        commandShipStrength: tick.updatedArmy.commandShipStrength ?? army.commandShipStrength,
        effectiveness: tick.updatedArmy.effectiveness ?? army.effectiveness,
        soldiersLevel: army.soldiersLevel,
        fightersLevel: army.fightersLevel,
        stationsLevel: army.stationsLevel,
        lightCruisersLevel: army.lightCruisersLevel,
        heavyCruisersLevel: army.heavyCruisersLevel,
      };

      const result = runPirateRaid(atkSnap, empire.turnsPlayed);

      for (const [k, v] of Object.entries(result.attackerLosses)) {
        if (v > 0 && k in (tick.updatedArmy as Record<string, unknown>)) {
          (tick.updatedArmy as Record<string, number>)[k] = Math.max(0, ((tick.updatedArmy as Record<string, number>)[k] ?? 0) - v);
        }
      }

      if (result.victory) {
        tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + result.lootCredits;
        tick.updatedEmpire.ore = (tick.updatedEmpire.ore ?? 0) + result.lootOre;
        tick.updatedEmpire.food = (tick.updatedEmpire.food ?? 0) + (result.lootFood ?? 0);
        tick.updatedArmy.effectiveness = Math.min(MIL.EFFECTIVENESS_MAX,
          (tick.updatedArmy.effectiveness ?? army.effectiveness) + MIL.EFFECTIVENESS_WON_PIRATE);
      } else {
        tick.updatedArmy.effectiveness = Math.max(0,
          (tick.updatedArmy.effectiveness ?? army.effectiveness) - MIL.EFFECTIVENESS_LOST_PIRATE);
      }

      const pirateLoss = `Your losses: ${formatUnitLossesOrNone(result.attackerLosses)}.`;
      await emitGameEvent(player, {
        type: "combat",
        message: `${player.name} raided pirates: ${result.victory ? "VICTORY" : "DEFEAT"} ${pirateLoss}`,
        details: result as object,
      });

      actionMsg = `${result.messages.join(" ")} ${pirateLoss}`;
      actionDetails.combatResult = {
        victory: result.victory,
        attackerLosses: result.attackerLosses,
        messages: result.messages,
        loot: result.victory ? { planetsCaptures: 0, creditsLooted: result.lootCredits, populationTransferred: 0, oreLooted: result.lootOre, foodLooted: result.lootFood } : undefined,
      };
      break;
    }

    case "covert_op": {
      const targetName = params?.target as string;
      const opType = Number(params?.opType ?? 0);
      if (!targetName) return { success: false, message: "No target specified." };

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: true },
      });
      if (!targetPlayer?.empire) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot run covert ops against your own empire." };
      if (targetHasNewEmpireProtection(targetPlayer.empire)) {
        return { success: false, message: protectionBlockMessage(targetPlayer.empire.protectionTurns) };
      }

      const currentAgents = tick.updatedArmy.covertAgents ?? army.covertAgents;
      const currentPoints = tick.updatedArmy.covertPoints ?? army.covertPoints;

      if (currentAgents < 1) return { success: false, message: "No covert agents available." };

      const result = await executeCovertOp(
        empire.id,
        targetPlayer.empire.id,
        opType,
        currentAgents,
        currentPoints,
      );

      if (result.agentsLost > 0) {
        tick.updatedArmy.covertAgents = Math.max(0, currentAgents - result.agentsLost);
      }

      const pointsCost = (result.effects.pointsCost as number) ?? 0;
      if (pointsCost > 0) {
        tick.updatedArmy.covertPoints = Math.max(0, currentPoints - pointsCost);
      }

      if (result.success && result.effects.creditsStolen) {
        tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + (result.effects.creditsStolen as number);
      }

      await emitGameEvent(player, {
        type: "covert",
        message: `Covert operation against ${targetName}: ${result.success ? "SUCCESS" : "FAILED"}`,
        details: { opType, detected: result.detected } as object,
      });

      const defenderCovertMsg = defenderCovertAlertMessage(player.name, opType, result);
      if (defenderCovertMsg) await pushDefenderAlert(targetPlayer.empire.id, defenderCovertMsg);

      actionMsg = result.messages.join(" ");
      actionDetails.intelMessages = result.messages;
      actionDetails.covertTarget = targetName;
      actionDetails.covertOpType = opType;
      break;
    }

    case "propose_treaty": {
      const targetName = params?.target as string;
      const treatyType = (params?.treatyType as string) ?? "NEUTRALITY";
      if (!targetName) return { success: false, message: "No target specified." };

      const targetPlayer = await getDb().player.findFirst({
        where: { name: targetName, ...sessionFilter },
        include: { empire: true },
      });
      if (!targetPlayer?.empire) return { success: false, message: `Target '${targetName}' not found.` };
      if (targetPlayer.id === playerId) return { success: false, message: "Cannot propose a treaty to yourself." };

      const existing = await getDb().treaty.findFirst({
        where: {
          OR: [
            { fromEmpireId: empire.id, toEmpireId: targetPlayer.empire.id },
            { fromEmpireId: targetPlayer.empire.id, toEmpireId: empire.id },
          ],
          status: { in: ["PENDING", "ACTIVE"] },
        },
      });
      if (existing) return { success: false, message: "A treaty already exists with this empire." };

      await getDb().treaty.create({
        data: {
          fromEmpireId: empire.id,
          toEmpireId: targetPlayer.empire.id,
          type: treatyType as "NEUTRALITY" | "FREE_TRADE" | "MINOR_ALLIANCE" | "TOTAL_DEFENSE" | "ARMED_DEFENSE_PACT" | "CRUISER_PROTECTION",
          turnsRemaining: 20,
          isBinding: true,
        },
      });

      await emitGameEvent(player, {
        type: "diplomacy",
        message: `${player.name} proposed a ${treatyType} treaty to ${targetName}.`,
      });

      await pushDefenderAlert(
        targetPlayer.empire.id,
        `${player.name} proposed a ${treatyType} treaty (pending your acceptance).`,
      );

      actionMsg = `Proposed ${treatyType} treaty to ${targetName}.`;
      break;
    }

    case "accept_treaty": {
      const treatyId = params?.treatyId as string;
      if (!treatyId) return { success: false, message: "No treaty ID specified." };

      const treaty = await getDb().treaty.findUnique({ where: { id: treatyId } });
      if (!treaty || treaty.toEmpireId !== empire.id || treaty.status !== "PENDING") {
        return { success: false, message: "Invalid or already processed treaty." };
      }

      await getDb().treaty.update({ where: { id: treatyId }, data: { status: "ACTIVE" } });
      await pushDefenderAlert(
        treaty.fromEmpireId,
        `${player.name} accepted your ${treaty.type} treaty proposal.`,
      );
      actionMsg = `Treaty accepted: ${treaty.type}.`;
      break;
    }

    case "break_treaty": {
      const treatyId = params?.treatyId as string;
      if (!treatyId) return { success: false, message: "No treaty ID specified." };

      const treaty = await getDb().treaty.findUnique({ where: { id: treatyId } });
      if (!treaty || treaty.status !== "ACTIVE") {
        return { success: false, message: "Treaty not found or not active." };
      }
      if (treaty.fromEmpireId !== empire.id && treaty.toEmpireId !== empire.id) {
        return { success: false, message: "Not your treaty." };
      }

      await getDb().treaty.update({ where: { id: treatyId }, data: { status: "BROKEN" } });

      if (treaty.isBinding && treaty.turnsRemaining > 0) {
        tick.updatedEmpire.civilStatus = Math.min(7, (tick.updatedEmpire.civilStatus ?? empire.civilStatus) + 1);
        actionMsg = `Broke binding treaty! Reputation damaged, civil unrest increased.`;
      } else {
        actionMsg = `Treaty terminated.`;
      }

      await emitGameEvent(player, {
        type: "diplomacy",
        message: `${player.name} broke a ${treaty.type} treaty!`,
      });

      const otherEmpireId = treaty.fromEmpireId === empire.id ? treaty.toEmpireId : treaty.fromEmpireId;
      await pushDefenderAlert(otherEmpireId, `${player.name} broke your ${treaty.type} treaty.`);

      break;
    }

    case "create_coalition": {
      const coalitionName = params?.name as string;
      if (!coalitionName) return { success: false, message: "Coalition name required." };

      const existing = await getDb().coalition.findUnique({ where: { name: coalitionName } });
      if (existing) return { success: false, message: "Coalition name already taken." };

      await getDb().coalition.create({
        data: {
          name: coalitionName,
          leaderId: empire.id,
          memberIds: [empire.id],
        },
      });

      actionMsg = `Coalition "${coalitionName}" created.`;
      break;
    }

    case "join_coalition": {
      const coalitionName = params?.name as string;
      if (!coalitionName) return { success: false, message: "Coalition name required." };

      const coalition = await getDb().coalition.findUnique({ where: { name: coalitionName } });
      if (!coalition) return { success: false, message: "Coalition not found." };
      if (coalition.memberIds.length >= coalition.maxMembers) {
        return { success: false, message: "Coalition is full." };
      }
      if (coalition.memberIds.includes(empire.id)) {
        return { success: false, message: "Already a member." };
      }

      await getDb().coalition.update({
        where: { id: coalition.id },
        data: { memberIds: [...coalition.memberIds, empire.id] },
      });

      actionMsg = `Joined coalition "${coalitionName}".`;
      break;
    }

    case "leave_coalition": {
      const coalitionName = params?.name as string;
      if (!coalitionName) return { success: false, message: "Coalition name required." };

      const coalition = await getDb().coalition.findUnique({ where: { name: coalitionName } });
      if (!coalition) return { success: false, message: "Coalition not found." };
      if (!coalition.memberIds.includes(empire.id)) {
        return { success: false, message: "Not a member." };
      }

      const newMembers = coalition.memberIds.filter((id) => id !== empire.id);
      if (newMembers.length === 0) {
        await getDb().coalition.delete({ where: { id: coalition.id } });
        actionMsg = `Left and dissolved coalition "${coalitionName}".`;
      } else {
        await getDb().coalition.update({
          where: { id: coalition.id },
          data: {
            memberIds: newMembers,
            leaderId: coalition.leaderId === empire.id ? newMembers[0] : coalition.leaderId,
          },
        });
        actionMsg = `Left coalition "${coalitionName}".`;
      }
      break;
    }

    case "market_buy": {
      const resource = (params?.resource as string)?.toLowerCase();
      const qty = Math.max(1, Number(params?.amount ?? 100));
      const mkt = await getOrCreateMarket();

      let price: number;
      let supply: number;
      let ratioField: "foodRatio" | "oreRatio" | "petroRatio";
      let supplyField: "foodSupply" | "oreSupply" | "petroSupply";
      let empireField: "food" | "ore" | "fuel";

      if (resource === "food") {
        price = ECON.BASE_FOOD_PRICE; supply = mkt.foodSupply;
        ratioField = "foodRatio"; supplyField = "foodSupply"; empireField = "food";
      } else if (resource === "ore") {
        price = ECON.BASE_ORE_PRICE; supply = mkt.oreSupply;
        ratioField = "oreRatio"; supplyField = "oreSupply"; empireField = "ore";
      } else if (resource === "fuel" || resource === "petroleum") {
        price = ECON.BASE_PETRO_PRICE; supply = mkt.petroSupply;
        ratioField = "petroRatio"; supplyField = "petroSupply"; empireField = "fuel";
      } else {
        return { success: false, message: "Resource must be food, ore, or fuel." };
      }

      if (supply < qty) return { success: false, message: `Only ${supply} available on market.` };
      const totalCost = Math.round(qty * price * mkt[ratioField]);
      if ((tick.updatedEmpire.credits ?? 0) < totalCost) {
        return { success: false, message: `Need ${totalCost} credits to buy ${qty} ${resource}.` };
      }

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - totalCost;
      (tick.updatedEmpire as Record<string, number>)[empireField] = ((tick.updatedEmpire as Record<string, number>)[empireField] ?? 0) + qty;

      // Buying raises price
      const newRatio = Math.min(ECON.MARKET_RATIO_MAX, mkt[ratioField] + qty * 0.00001);
      await getDb().market.update({
        where: { id: mkt.id },
        data: { [supplyField]: { decrement: qty }, [ratioField]: newRatio },
      });

      actionMsg = `Bought ${qty} ${resource} for ${totalCost.toLocaleString()} credits.`;
      break;
    }

    case "market_sell": {
      const resource = (params?.resource as string)?.toLowerCase();
      const qty = Math.max(1, Number(params?.amount ?? 100));
      const mkt = await getOrCreateMarket();

      let price: number;
      let ratioField: "foodRatio" | "oreRatio" | "petroRatio";
      let supplyField: "foodSupply" | "oreSupply" | "petroSupply";
      let empireField: "food" | "ore" | "fuel";

      if (resource === "food") {
        price = ECON.BASE_FOOD_PRICE; ratioField = "foodRatio"; supplyField = "foodSupply"; empireField = "food";
      } else if (resource === "ore") {
        price = ECON.BASE_ORE_PRICE; ratioField = "oreRatio"; supplyField = "oreSupply"; empireField = "ore";
      } else if (resource === "fuel" || resource === "petroleum") {
        price = ECON.BASE_PETRO_PRICE; ratioField = "petroRatio"; supplyField = "petroSupply"; empireField = "fuel";
      } else {
        return { success: false, message: "Resource must be food, ore, or fuel." };
      }

      const available = (tick.updatedEmpire as Record<string, number>)[empireField] ?? 0;
      if (available < qty) return { success: false, message: `Only have ${available} ${resource}.` };

      const revenue = Math.round(qty * price * mkt[ratioField] / ECON.SELL_RATIO_DIVISOR);
      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + revenue;
      (tick.updatedEmpire as Record<string, number>)[empireField] = available - qty;

      const newRatio = Math.max(ECON.MARKET_RATIO_MIN, mkt[ratioField] - qty * 0.00001);
      await getDb().market.update({
        where: { id: mkt.id },
        data: { [supplyField]: { increment: qty }, [ratioField]: newRatio },
      });

      actionMsg = `Sold ${qty} ${resource} for ${revenue.toLocaleString()} credits.`;
      break;
    }

    case "bank_loan": {
      const loanAmount = Math.max(1000, Math.min(999999, Number(params?.amount ?? 100000)));
      const activeLoans = await getDb().loan.count({ where: { empireId: empire.id } });
      if (activeLoans >= 3) return { success: false, message: "Maximum 3 active loans." };

      const baseRate = 50 + activeLoans * 10;
      await getDb().loan.create({
        data: {
          empireId: empire.id,
          principal: loanAmount,
          balance: loanAmount,
          interestRate: baseRate,
          turnsRemaining: 20,
        },
      });

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + loanAmount;
      actionMsg = `Took a loan of ${loanAmount.toLocaleString()} credits at ${baseRate}% interest (20 turns).`;
      break;
    }

    case "bank_repay": {
      const loanId = params?.loanId as string;
      const repayAmount = Number(params?.amount ?? 0);

      if (loanId) {
        const loan = await getDb().loan.findUnique({ where: { id: loanId } });
        if (!loan || loan.empireId !== empire.id) return { success: false, message: "Loan not found." };

        const payment = Math.min(repayAmount || loan.balance, tick.updatedEmpire.credits ?? 0, loan.balance);
        if (payment <= 0) return { success: false, message: "No credits to repay." };

        const newBalance = loan.balance - payment;
        if (newBalance <= 0) {
          await getDb().loan.delete({ where: { id: loanId } });
          actionMsg = `Loan fully repaid (${payment.toLocaleString()} credits).`;
        } else {
          await getDb().loan.update({ where: { id: loanId }, data: { balance: newBalance } });
          actionMsg = `Repaid ${payment.toLocaleString()} credits on loan (${newBalance.toLocaleString()} remaining).`;
        }
        tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - payment;
      } else {
        return { success: false, message: "Specify loanId to repay." };
      }
      break;
    }

    case "buy_bond": {
      const bondAmount = Math.max(1000, Number(params?.amount ?? 50000));
      if ((tick.updatedEmpire.credits ?? 0) < bondAmount) {
        return { success: false, message: `Need ${bondAmount} credits for the bond.` };
      }
      const activeBonds = await getDb().bond.count({ where: { empireId: empire.id } });
      if (activeBonds >= 5) return { success: false, message: "Maximum 5 active bonds." };

      await getDb().bond.create({
        data: {
          empireId: empire.id,
          amount: bondAmount,
          interestRate: 10,
          turnsRemaining: 30,
        },
      });

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - bondAmount;
      actionMsg = `Invested ${bondAmount.toLocaleString()} credits in a Galactic Bond (10% interest, matures in 30 turns).`;
      break;
    }

    case "buy_lottery_ticket": {
      const tickets = Math.max(1, Math.min(100, Number(params?.amount ?? 1)));
      const cost = tickets * 10000;
      if ((tick.updatedEmpire.credits ?? 0) < cost) {
        return { success: false, message: `Need ${cost.toLocaleString()} credits for ${tickets} lottery tickets.` };
      }

      tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) - cost;
      const jackpotContribution = Math.floor(cost * 0.25);
      const mkt = await getOrCreateMarket();
      await getDb().market.update({
        where: { id: mkt.id },
        data: { lotteryPool: { increment: jackpotContribution } },
      });

      // Check if they win
      const winChance = tickets * 0.001; // 0.1% per ticket
      if (rng.random() < winChance) {
        const winnings = mkt.lotteryPool + jackpotContribution;
        tick.updatedEmpire.credits = (tick.updatedEmpire.credits ?? 0) + winnings;
        await getDb().market.update({ where: { id: mkt.id }, data: { lotteryPool: 0 } });
        actionMsg = `JACKPOT! Won ${winnings.toLocaleString()} credits from the lottery!`;
        await emitGameEvent(player, {
          type: "lottery",
          message: `${player.name} won the lottery: ${winnings.toLocaleString()} credits!`,
        });
      } else {
        actionMsg = `Bought ${tickets} lottery ticket(s) for ${cost.toLocaleString()} credits. Better luck next time.`;
      }
      break;
    }

    case "discover_tech": {
      const techId = params?.techId as string;
      if (!techId) return { success: false, message: "No tech specified." };

      const research = player.empire.research;
      if (!research) return { success: false, message: "No research system initialized." };

      const tech = getTech(techId);
      if (!tech) return { success: false, message: "Unknown technology." };

      if (research.unlockedTechIds.includes(techId)) {
        return { success: false, message: "Already researched." };
      }

      const available = getAvailableTech(research.unlockedTechIds);
      if (!available.find((t) => t.id === techId)) {
        return { success: false, message: "Prerequisites not met or tech not available." };
      }

      if (research.accumulatedPoints < tech.cost) {
        return { success: false, message: `Need ${tech.cost.toLocaleString()} research points (have ${research.accumulatedPoints.toLocaleString()}).` };
      }

      // Spend points and unlock tech
      await getDb().research.update({
        where: { id: research.id },
        data: {
          accumulatedPoints: { decrement: tech.cost },
          unlockedTechIds: [...research.unlockedTechIds, techId],
        },
      });

      // Apply effect
      const eff = tech.effect;
      if (eff.type === "unit_upgrade") {
        const levelKey = `${eff.unitType}Level` as string;
        await getDb().army.update({
          where: { id: army.id },
          data: { [levelKey]: eff.level },
        });
        actionMsg = `Researched ${tech.name}: ${tech.description}`;
      } else if (eff.type === "food_bonus") {
        for (const p of planets.filter((p) => p.type === "FOOD")) {
          const newLong = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
          await getDb().planet.update({ where: { id: p.id }, data: { longTermProduction: newLong } });
        }
        actionMsg = `Researched ${tech.name}: +${eff.percent}% food production.`;
      } else if (eff.type === "ore_bonus") {
        for (const p of planets.filter((p) => p.type === "ORE")) {
          const newLong = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
          await getDb().planet.update({ where: { id: p.id }, data: { longTermProduction: newLong } });
        }
        actionMsg = `Researched ${tech.name}: +${eff.percent}% ore production.`;
      } else if (eff.type === "petro_bonus") {
        for (const p of planets.filter((p) => p.type === "PETROLEUM")) {
          const newLong = Math.min(200, p.longTermProduction + Math.floor(p.longTermProduction * eff.percent / 100));
          await getDb().planet.update({ where: { id: p.id }, data: { longTermProduction: newLong } });
        }
        actionMsg = `Researched ${tech.name}: +${eff.percent}% petroleum production.`;
      } else if (eff.type === "tourism_bonus" && !tech.permanent) {
        for (const p of planets.filter((p) => p.type === "TOURISM")) {
          const boost = Math.floor(p.shortTermProduction * eff.percent / 100);
          await getDb().planet.update({ where: { id: p.id }, data: { shortTermProduction: { increment: boost } } });
        }
        actionMsg = `Researched ${tech.name}: ${tech.description}`;
      } else {
        actionMsg = `Researched ${tech.name}: ${tech.description}`;
      }
      break;
    }

    case "send_message": {
      const toName = params?.target as string;
      const body = params?.body as string;
      if (!toName || !body) return { success: false, message: "Target and body required." };

      const toPlayer = await getDb().player.findFirst({ where: { name: toName, ...sessionFilter } });
      if (!toPlayer) return { success: false, message: `Player '${toName}' not found.` };

      await getDb().message.create({
        data: {
          fromPlayerId: playerId,
          toPlayerId: toPlayer.id,
          subject: (params?.subject as string) ?? "Message",
          body,
        },
      });

      actionMsg = `Message sent to ${toName}.`;
      break;
    }

    case "end_turn": {
      actionMsg = "Turn ended.";
      break;
    }

    default:
      return { success: false, message: `Unknown action: ${action}` };
  }

  await applyPostActionEconomyFinance(empire.id, tick, planets, player.empire.research ?? null);

  // Persist all changes + reset tickProcessed for next turn (unless door-game mid-turn)
  await getDb().empire.update({
    where: { id: empire.id },
    data: { ...toEmpireUpdateData(tick.updatedEmpire), tickProcessed: options?.keepTickProcessed ? true : false },
  });

  await getDb().army.update({
    where: { id: army.id },
    data: tick.updatedArmy,
  });

  // Update planet production drifts (only if tick ran inline)
  for (const pu of tick.updatedPlanets) {
    await getDb().planet.update({
      where: { id: pu.id },
      data: { shortTermProduction: pu.shortTermProduction },
    });
  }

  // Log action
  await getDb().turnLog.create({
    data: {
      playerId,
      action,
      details: {
        params,
        actionMsg,
        ...(tickAlreadyPersisted
          ? { tickReportDeferred: true }
          : { report: tick.report }),
        ...(options?.logMeta ?? {}),
      } as object,
    },
  });

  if (
    (tick.updatedEmpire.turnsLeft ?? empire.turnsLeft) === 0 &&
    !options?.skipEndgameSettlement
  ) {
    await runEndgameSettlementTick(playerId);
  }

  return {
    success: true,
    message: actionMsg,
    turnReport: tickReport,
    actionDetails: Object.keys(actionDetails).length > 0 ? actionDetails : undefined,
  };
}
