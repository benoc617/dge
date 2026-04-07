import * as rng from "./rng";

export const PLANET_TYPES = [
  "FOOD", "ORE", "TOURISM", "PETROLEUM", "URBAN", "EDUCATION",
  "GOVERNMENT", "SUPPLY", "RESEARCH", "ANTI_POLLUTION",
] as const;

export type PlanetTypeName = (typeof PLANET_TYPES)[number];

export const PLANET_CONFIG: Record<
  PlanetTypeName,
  { label: string; baseCost: number; baseProduction: number; desc: string }
> = {
  FOOD:           { label: "Food",           baseCost: 14000, baseProduction: 200, desc: "Feeds population and soldiers" },
  ORE:            { label: "Ore",            baseCost: 10000, baseProduction: 125, desc: "Steady ore; feeds mechanical units" },
  TOURISM:        { label: "Tourism",        baseCost: 14000, baseProduction: 8000, desc: "High credits in peace; fragile" },
  PETROLEUM:      { label: "Petroleum",      baseCost: 20000, baseProduction: 100, desc: "Fuel production; causes pollution" },
  URBAN:          { label: "Urban",          baseCost: 14000, baseProduction: 100, desc: "Exponential pop growth; urban tax" },
  EDUCATION:      { label: "Education",      baseCost: 14000, baseProduction: 100, desc: "Linear immigration growth" },
  GOVERNMENT:     { label: "Government",     baseCost: 12000, baseProduction: 100, desc: "Reduces maintenance; houses agents" },
  SUPPLY:         { label: "Supply",         baseCost: 20000, baseProduction: 100, desc: "Auto-produces military units" },
  RESEARCH:       { label: "Research",       baseCost: 25000, baseProduction: 300, desc: "Generates research points" },
  ANTI_POLLUTION: { label: "Anti-Pollution", baseCost: 18000, baseProduction: 100, desc: "Absorbs pollution from petroleum" },
};

export const COST_INFLATION = 0.001;

// --- Population ---
export const POP = {
  BIRTH_RATE: 0.03,
  DEATH_RATE: 0.008,
  URBAN_GROWTH_FACTOR: 0.45,
  EDUCATION_IMMIGRATION: 400,
  OVERCROWD_CAPACITY_PER_URBAN: 20000,
  OVERCROWD_EMIGRATION_RATE: 0.10,
  POLLUTION_POP_FACTOR: 0.000002,
  TAX_IMMIGRATION_PENALTY: 0.002,
  TAX_EMIGRATION_FACTOR: 0.001,
  CIVIL_STATUS_FACTOR: 0.05,
  STARVATION_POP_LOSS: 0.20,
  STARVATION_SOLDIER_LOSS: 0.10,
  FOOD_PER_PERSON: 0.006,
} as const;

// --- Economy ---
export const ECON = {
  POPULATION_TAX_FACTOR: 0.002,
  URBAN_TAX_PER_PLANET: 1200,
  TOURISM_BASE_CREDITS: 8000,
  GALACTIC_TAX_RATE: 0.0005,
  PRODUCTION_DRIFT_RATE: 0.1,
  PRODUCTION_VARIANCE_PCT: 5,
  BASE_FOOD_PRICE: 80,
  BASE_ORE_PRICE: 120,
  BASE_PETRO_PRICE: 300,
  SELL_RATIO_DIVISOR: 1.2,
  MARKET_RATIO_MIN: 0.4,
  MARKET_RATIO_MAX: 4.0,
  MARKET_NATURAL_GROWTH: 1000,
} as const;

// --- Maintenance ---
export const MAINT = {
  PLANET_BASE: 600,
  PLANET_PER_TURN: 8,
  IMPERIAL_OVERHEAD_PER_PLANET: 0.05,
  SOLDIER: 10,
  GENERAL: 10,
  FIGHTER: 30,
  STATION: 40,
  LIGHT_CRUISER: 30,
  HEAVY_CRUISER: 50,
  CARRIER: 25,
  SOLDIER_FOOD: 0.003,
  GENERAL_FOOD: 0.003,
  FIGHTER_ORE: 0.005,
  STATION_ORE: 0.01,
  LIGHT_CRUISER_ORE: 0.01,
  HEAVY_CRUISER_ORE: 0.1,
  CARRIER_ORE: 0.01,
  COMMAND_SHIP_ORE: 1,
  FIGHTER_FUEL: 0.01,
  LIGHT_CRUISER_FUEL: 0.05,
  HEAVY_CRUISER_FUEL: 0.1,
  CARRIER_FUEL: 0.1,
  COMMAND_SHIP_FUEL: 1,
} as const;

// --- Unit purchase costs ---
export const UNIT_COST = {
  SOLDIER: 280,
  GENERAL: 780,
  FIGHTER: 380,
  DEFENSE_STATION: 520,
  LIGHT_CRUISER: 950,
  HEAVY_CRUISER: 1900,
  CARRIER: 1430,
  COVERT_AGENT: 4090,
  COMMAND_SHIP: 20000,
} as const;

// --- Military ---
export const MIL = {
  GENERALS_PER_GOV_PLANET: 50,
  COVERT_PER_GOV_PLANET: 300,
  COVERT_POINTS_PER_TURN: 5,
  MAX_COVERT_POINTS: 50,
  COMMAND_SHIP_GROWTH: 5,
  COMMAND_SHIP_MAX: 100,
  EFFECTIVENESS_RECOVERY: 2,
  EFFECTIVENESS_MAX: 100,
  EFFECTIVENESS_WON_INVASION: 20,
  EFFECTIVENESS_LOST_INVASION: 10,
  EFFECTIVENESS_WON_PIRATE: 15,
  EFFECTIVENESS_LOST_PIRATE: 5,
} as const;

// --- Finance ---
export const FINANCE = {
  LOTTERY_TICKET_COST: 10000,
  DEFAULT_LOAN_AMOUNT: 100000,
  LOAN_INTEREST_RATE: 50,
  MAX_ACTIVE_LOANS: 3,
  DEFAULT_BOND_AMOUNT: 50000,
  BOND_INTEREST_RATE: 10,
  BOND_MATURITY_TURNS: 30,
  NUKE_COST: 500000000,
} as const;

// --- Pollution ---
export const POLLUTION = {
  PER_PETRO_PLANET: 0.1,
  PER_PERSON: 0.000002,
  ANTI_POLLUTION_ABSORPTION: 0.5,
} as const;

// --- Combat ---
export const COMBAT = {
  DEFENSE_BONUS: 1.5,
  RANDOMNESS: 0.20,
  INVASION_ROUNDS_PER_FRONT: 5,
  LIGHT_CRUISER_PROTECTION_ROUNDS: 3,
  INVASION_PLANETS_MIN: 30,
  INVASION_PLANETS_MAX: 90,
  GUERRILLA_DEFENSE_MULT: 4,
  GUERRILLA_ROUNDS: 5,
  NUCLEAR_BASE_DAMAGE: 40,
  NUCLEAR_EXTRA_DAMAGE: 25,
} as const;

// --- Deficit consequences ---
export const DEFICIT = {
  BANKRUPT_PLANET_LOSS: 0.10,
  BANKRUPT_MILITARY_LOSS: 0.10,
  STARVATION_POP_LOSS: 0.20,
  STARVATION_SOLDIER_LOSS: 0.10,
} as const;

// --- Net Worth ---
export const NETWORTH = {
  POPULATION: 0.0002,
  CREDITS: 0.000015,
  PLANETS: 2,
  SOLDIER: 0.04,
  FIGHTER: 0.12,
  STATION: 0.12,
  LIGHT_CRUISER: 0.12,
  HEAVY_CRUISER: 0.20,
  CARRIER: 0.25,
  GENERAL: 0.05,
  COVERT: 0.10,
} as const;

// --- Civil Status ---
export const CIVIL_STATUS_NAMES = [
  "Peaceful",
  "Mild Insurgencies",
  "Occasional Riots",
  "Violent Demonstrations",
  "Political Conflicts",
  "Internal Violence",
  "Revolutionary Warfare",
  "Under Coup",
] as const;

export const CIVIL_DESERTION_RATE_PER_LEVEL = 8; // percent per civilStatus level

/** Account signup, session sizing */
export const AUTH = {
  PASSWORD_MIN_SIGNUP: 8,
  PASSWORD_MIN_GAME_LEGACY: 8,
  PASSWORD_MIN_ADMIN: 12,
} as const;

export const SESSION = {
  MAX_PLAYERS_DEFAULT: 50,
  MAX_PLAYERS_CAP: 128,
  MIN_PLAYERS: 2,
} as const;

// --- Starting state ---
/** Full turns (tick → actions → end_turn) per calendar round in door-game / simultaneous mode. */
export const ACTIONS_PER_DAY = 5;

export const START = {
  CREDITS: 10000,
  FOOD: 800,
  ORE: 400,
  FUEL: 150,
  POPULATION: 25000,
  TAX_RATE: 25,
  TURNS: 100,
  PROTECTION_TURNS: 15,
  PLANETS: [
    { type: "FOOD" as const, count: 2 },
    { type: "ORE" as const, count: 2 },
    { type: "URBAN" as const, count: 2 },
    { type: "GOVERNMENT" as const, count: 1 },
  ],
  SOLDIERS: 100,
  GENERALS: 2,
  FIGHTERS: 10,
} as const;

// --- Random events ---
export const RANDOM_EVENT_CHANCE = 0.10;

// --- Planet name generation ---
const PREFIXES = [
  "New", "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Sigma", "Tau",
  "Outer", "Inner", "Upper", "Far", "Near", "North", "South", "Old",
  "Prime", "Ultra", "Bright", "Dark", "Greater", "Lesser", "High", "Deep",
];

const ROOTS = [
  "Terra", "Kepler", "Orion", "Vega", "Sirius", "Rigel", "Centauri",
  "Cygnus", "Lyra", "Draco", "Phoenix", "Hydra", "Corvus", "Aquila",
  "Antares", "Polaris", "Arcturus", "Deneb", "Altair", "Castor",
  "Procyon", "Regulus", "Spica", "Mira", "Capella", "Nexus", "Axiom",
  "Kronos", "Helios", "Theron", "Atlas", "Titan", "Forge", "Haven",
];

const NUMERALS = ["I", "II", "III", "IV", "V", "VI", "VII"];

export function generatePlanetName(): string {
  const prefix = PREFIXES[Math.floor(rng.random() * PREFIXES.length)];
  const root = ROOTS[Math.floor(rng.random() * ROOTS.length)];
  const numeral = rng.random() > 0.5
    ? ` ${NUMERALS[Math.floor(rng.random() * NUMERALS.length)]}`
    : "";
  return `${prefix} ${root}${numeral}`;
}

export function getTaxBirthMultiplier(taxRate: number): number {
  if (taxRate > 100) return 4.0;
  if (taxRate > 90) return 3.5;
  if (taxRate > 80) return 2.0;
  if (taxRate > 70) return 1.5;
  if (taxRate > 60) return 1.0;
  if (taxRate > 50) return 0.5;
  return 0.25;
}

export function alterNumber(value: number, variancePct: number): number {
  const factor = 1 + (rng.random() * 2 - 1) * (variancePct / 100);
  return Math.round(value * factor);
}
