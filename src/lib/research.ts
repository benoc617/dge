export interface TechDiscovery {
  id: string;
  name: string;
  category: "agriculture" | "industry" | "military" | "society" | "deep_space";
  cost: number;
  permanent: boolean;
  durationTurns?: number;
  description: string;
  effect: TechEffect;
  prerequisites: string[];
}

export type TechEffect =
  | { type: "food_bonus"; percent: number }
  | { type: "ore_bonus"; percent: number }
  | { type: "petro_bonus"; percent: number }
  | { type: "tourism_bonus"; percent: number }
  | { type: "pop_growth_bonus"; percent: number }
  | { type: "civil_unrest_reduction"; percent: number }
  | { type: "planet_maint_reduction"; percent: number }
  | { type: "unit_upgrade"; unitType: string; level: number }
  | { type: "command_ship_upgrade"; level: number }
  | { type: "research_speed"; percent: number }
  | { type: "credits_bonus"; percent: number };

export const TECH_TREE: TechDiscovery[] = [
  // Agriculture
  {
    id: "agri_1",
    name: "Improved Hydroponics",
    category: "agriculture",
    cost: 8000,
    permanent: true,
    description: "+10% food production permanently",
    effect: { type: "food_bonus", percent: 10 },
    prerequisites: [],
  },
  {
    id: "agri_2",
    name: "Drought Resistance",
    category: "agriculture",
    cost: 25000,
    permanent: true,
    description: "+5% food production, reduces starvation impact",
    effect: { type: "food_bonus", percent: 5 },
    prerequisites: ["agri_1"],
  },
  {
    id: "agri_3",
    name: "Bumper Harvest Protocol",
    category: "agriculture",
    cost: 15000,
    permanent: false,
    durationTurns: 15,
    description: "+25% food production for 15 turns",
    effect: { type: "food_bonus", percent: 25 },
    prerequisites: ["agri_1"],
  },

  // Industry
  {
    id: "ind_1",
    name: "Advanced Mining",
    category: "industry",
    cost: 10000,
    permanent: true,
    description: "+10% ore production permanently",
    effect: { type: "ore_bonus", percent: 10 },
    prerequisites: [],
  },
  {
    id: "ind_2",
    name: "Refined Petroleum Processing",
    category: "industry",
    cost: 18000,
    permanent: true,
    description: "+10% petroleum production permanently",
    effect: { type: "petro_bonus", percent: 10 },
    prerequisites: ["ind_1"],
  },
  {
    id: "ind_3",
    name: "Efficient Maintenance",
    category: "industry",
    cost: 35000,
    permanent: true,
    description: "-15% planet maintenance costs",
    effect: { type: "planet_maint_reduction", percent: 15 },
    prerequisites: ["ind_1"],
  },
  {
    id: "ind_4",
    name: "Tourism Boom",
    category: "industry",
    cost: 12000,
    permanent: false,
    durationTurns: 10,
    description: "Doubled tourism income for 10 turns",
    effect: { type: "tourism_bonus", percent: 100 },
    prerequisites: [],
  },

  // Military
  {
    id: "mil_soldiers_1",
    name: "Soldier Training I",
    category: "military",
    cost: 20000,
    permanent: true,
    description: "Upgrade soldiers to Tier 1",
    effect: { type: "unit_upgrade", unitType: "soldiers", level: 1 },
    prerequisites: [],
  },
  {
    id: "mil_soldiers_2",
    name: "Soldier Training II",
    category: "military",
    cost: 60000,
    permanent: true,
    description: "Upgrade soldiers to Tier 2",
    effect: { type: "unit_upgrade", unitType: "soldiers", level: 2 },
    prerequisites: ["mil_soldiers_1"],
  },
  {
    id: "mil_fighters_1",
    name: "Fighter Upgrades I",
    category: "military",
    cost: 25000,
    permanent: true,
    description: "Upgrade fighters to Tier 1",
    effect: { type: "unit_upgrade", unitType: "fighters", level: 1 },
    prerequisites: [],
  },
  {
    id: "mil_fighters_2",
    name: "Fighter Upgrades II",
    category: "military",
    cost: 75000,
    permanent: true,
    description: "Upgrade fighters to Tier 2",
    effect: { type: "unit_upgrade", unitType: "fighters", level: 2 },
    prerequisites: ["mil_fighters_1"],
  },
  {
    id: "mil_stations_1",
    name: "Station Fortification I",
    category: "military",
    cost: 30000,
    permanent: true,
    description: "Upgrade defense stations to Tier 1",
    effect: { type: "unit_upgrade", unitType: "stations", level: 1 },
    prerequisites: [],
  },
  {
    id: "mil_stations_2",
    name: "Station Fortification II",
    category: "military",
    cost: 90000,
    permanent: true,
    description: "Upgrade defense stations to Tier 2",
    effect: { type: "unit_upgrade", unitType: "stations", level: 2 },
    prerequisites: ["mil_stations_1"],
  },
  {
    id: "mil_hc_1",
    name: "Heavy Cruiser Refit I",
    category: "military",
    cost: 45000,
    permanent: true,
    description: "Upgrade heavy cruisers to Tier 1",
    effect: { type: "unit_upgrade", unitType: "heavyCruisers", level: 1 },
    prerequisites: [],
  },
  {
    id: "mil_hc_2",
    name: "Heavy Cruiser Refit II",
    category: "military",
    cost: 120000,
    permanent: true,
    description: "Upgrade heavy cruisers to Tier 2",
    effect: { type: "unit_upgrade", unitType: "heavyCruisers", level: 2 },
    prerequisites: ["mil_hc_1"],
  },
  {
    id: "mil_cmd_1",
    name: "Command Ship Upgrade I",
    category: "military",
    cost: 70000,
    permanent: true,
    description: "Command ship 2x heavy cruiser bonus",
    effect: { type: "command_ship_upgrade", level: 1 },
    prerequisites: ["mil_hc_1"],
  },

  // Society
  {
    id: "soc_1",
    name: "Population Initiative",
    category: "society",
    cost: 8000,
    permanent: true,
    description: "+10% population growth",
    effect: { type: "pop_growth_bonus", percent: 10 },
    prerequisites: [],
  },
  {
    id: "soc_2",
    name: "Civil Stability Program",
    category: "society",
    cost: 20000,
    permanent: true,
    description: "-20% civil unrest effects",
    effect: { type: "civil_unrest_reduction", percent: 20 },
    prerequisites: ["soc_1"],
  },
  {
    id: "soc_3",
    name: "Economic Stimulus",
    category: "society",
    cost: 15000,
    permanent: false,
    durationTurns: 20,
    description: "+15% credits income for 20 turns",
    effect: { type: "credits_bonus", percent: 15 },
    prerequisites: [],
  },

  // Deep Space
  {
    id: "ds_lc_1",
    name: "Light Cruiser Upgrades I",
    category: "deep_space",
    cost: 45000,
    permanent: true,
    description: "Upgrade light cruisers to Tier 1",
    effect: { type: "unit_upgrade", unitType: "lightCruisers", level: 1 },
    prerequisites: [],
  },
  {
    id: "ds_lc_2",
    name: "Light Cruiser Upgrades II",
    category: "deep_space",
    cost: 120000,
    permanent: true,
    description: "Upgrade light cruisers to Tier 2",
    effect: { type: "unit_upgrade", unitType: "lightCruisers", level: 2 },
    prerequisites: ["ds_lc_1"],
  },
  {
    id: "ds_research",
    name: "Research Accelerator",
    category: "deep_space",
    cost: 35000,
    permanent: true,
    description: "+25% research speed",
    effect: { type: "research_speed", percent: 25 },
    prerequisites: [],
  },
];

export function getAvailableTech(unlockedIds: string[]): TechDiscovery[] {
  return TECH_TREE.filter(
    (tech) =>
      !unlockedIds.includes(tech.id) &&
      tech.prerequisites.every((prereq) => unlockedIds.includes(prereq)),
  );
}

export function getTech(id: string): TechDiscovery | undefined {
  return TECH_TREE.find((t) => t.id === id);
}

export const RANDOM_EVENTS = [
  { type: "positive", name: "Asteroid Mining Windfall", effect: (e: Record<string, number>) => { e.credits = (e.credits || 0) + 5000; return "Mining operation discovered rich asteroid! +5,000 credits."; } },
  { type: "positive", name: "Tourist Boom", effect: (e: Record<string, number>) => { e.credits = (e.credits || 0) + 8000; return "Tourist boom brings galactic visitors! +8,000 credits."; } },
  { type: "positive", name: "Population Surge", effect: (e: Record<string, number>) => { e.population = (e.population || 0) + 3000; return "Population surge from immigration wave! +3,000 population."; } },
  { type: "positive", name: "Tech Breakthrough", effect: (e: Record<string, number>) => { e.researchPoints = (e.researchPoints || 0) + 5000; return "Research lab breakthrough! +5,000 research points."; } },
  { type: "negative", name: "Plague", effect: (e: Record<string, number>) => { const loss = Math.floor((e.population || 0) * 0.05); e.population = (e.population || 0) - loss; return `Plague sweeps through colonies! -${loss.toLocaleString()} population.`; } },
  { type: "negative", name: "Pirate Surge", effect: (e: Record<string, number>) => { const loss = Math.floor((e.credits || 0) * 0.03); e.credits = (e.credits || 0) - loss; return `Pirates raid trade routes! -${loss.toLocaleString()} credits.`; } },
  { type: "negative", name: "Market Crash", effect: (e: Record<string, number>) => { const loss = Math.floor((e.credits || 0) * 0.05); e.credits = (e.credits || 0) - loss; return `Galactic market crash! -${loss.toLocaleString()} credits.`; } },
  { type: "neutral", name: "Galactic Election", effect: () => "Galactic election brings new Coordinator. Political tensions ease temporarily." },
  { type: "neutral", name: "Trade Route Discovered", effect: (e: Record<string, number>) => { e.credits = (e.credits || 0) + 2000; return "New trade route discovered! +2,000 credits."; } },
  { type: "neutral", name: "Refugee Wave", effect: (e: Record<string, number>) => { e.population = (e.population || 0) + 1500; return "Refugees arrive from war-torn sector. +1,500 population."; } },
];
