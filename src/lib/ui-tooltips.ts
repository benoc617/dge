/**
 * Native `title` tooltips for UI panels — keep strings concise; no § (per project style).
 */
import { COMBAT, MIL, UNIT_COST } from "@/lib/game-constants";

export const LEADERBOARD = {
  panelTitle:
    "Galactic Powers — ranking in this session by net worth. Click another commander’s row to set them as your target in War and Ops (not your own row).",
  rk: "Rank in this galaxy (#1 = highest net worth).",
  commander: "Commander name. [AI] = computer-controlled. Click a rival row to target them.",
  prt: "New-empire protection: turns remaining while attacks from other players are blocked. — = no shield.",
  worth: "Net worth — primary score for victory and ranking.",
  pop: "Population (abbreviated: k = thousands, M = millions).",
  plt: "Number of colonized planets.",
  turns: "Turn — current turn number (economy ticks elapsed). Advances each time you open a full turn.",
  mil: `Military index (comparison only): soldiers + fighters×2 + light cruisers×4 + heavy cruisers×10 — not total raw units.`,
} as const;

export const EMPIRE = {
  netWorth: "Net worth — empire value used for ranking and win condition.",
  civilStatus: "Civil unrest level (0 = peaceful, 7 = coup). High levels hurt production and can trigger desertions.",
  credits: "Credits — currency for purchases, upkeep, and market.",
  food: "Food stockpile. Population and soldiers consume food each turn; shortage causes starvation.",
  ore: "Ore — used for industry, ships, and some upkeep.",
  fuel: "Fuel — consumed by fighters and carriers each turn.",
  population: "Population — grows or shrinks with food, housing, and civil status.",
  taxRate: "Income tax on population (0–100%). Higher revenue but can slow growth and worsen unrest.",
  sellRates: "Auto-sell: % of surplus food / ore / petroleum sold to the market each turn.",
  militaryHeading: "Your forces — counts shown; combat uses tier upgrades and effectiveness %.",
  effectiveness: `Army effectiveness (${COMBAT.RANDOMNESS * 100}% random variance in combat). Damaged by losses; recovers over time.`,
  covertPts: `Covert points — accumulate ${MIL.COVERT_POINTS_PER_TURN}/turn up to max ${MIL.MAX_COVERT_POINTS}. Spent on espionage ops; more agents raise capacity.`,
  commandShip: `Command ship — unique; boosts space-front strength and scales with investment (${UNIT_COST.COMMAND_SHIP.toLocaleString()} cr).`,
} as const;

/** Empire panel abbreviated unit boxes (Sol, Gen, …) */
export const EMPIRE_UNITS: Record<string, string> = {
  Sol: `Soldiers — infantry for ground and guerrilla combat fronts; consume food. Purchase ${UNIT_COST.SOLDIER} cr each. Strongest on ground/guerrilla; weak in pure space.`,
  Gen: `Generals — multiply soldier effectiveness on invasions; needed for large armies. Purchase ${UNIT_COST.GENERAL} cr each.`,
  Ftr: `Fighters — air/orbital combat; consume ore and fuel. Purchase ${UNIT_COST.FIGHTER} cr each. Strong on orbital and pirate raids.`,
  Stn: `Defense stations — planetary defense; strong on ground and orbital fronts. Purchase ${UNIT_COST.DEFENSE_STATION} cr each.`,
  LC: `Light cruisers — versatile ships; strong orbital/space, some ground. Purchase ${UNIT_COST.LIGHT_CRUISER} cr each.`,
  HC: `Heavy cruisers — capital ships; dominant on space front, costly. Purchase ${UNIT_COST.HEAVY_CRUISER} cr each.`,
  Car: `Carriers — project air power; consume fuel. Purchase ${UNIT_COST.CARRIER} cr each.`,
  Cov: `Covert agents — enable espionage ops and raise covert point cap. Purchase ${UNIT_COST.COVERT_AGENT} cr each.`,
};

export const COMMAND_CENTER = {
  panelTitle:
    "Command Center — one action per turn after the situation report: economy, military, warfare, ops, market, research, and session settings.",
  skipHint: "Press Enter to skip your turn (collect income only, no other action).",
  tabEconomy: "ECON — Colonize planets: buy production worlds (cost scales with empire size).",
  tabMilitary: "MIL — Recruit soldiers, ships, stations, agents, and the command ship.",
  tabWarfare: "WAR — Attacks: conventional, guerrilla, nuclear, chemical, psionic, pirate raid.",
  tabEspionage: "OPS — Covert operations vs a rival (costs covert points).",
  tabMarket: "MKT — Galactic market, Solar Bank loans/bonds, lottery.",
  tabResearch: "RES — Spend research points to unlock technologies.",
  tabSettings: "CFG — Galaxy name, invite code, visibility, turn timer, turn order.",
};

export const MILITARY_BUY: Record<string, string> = {
  buy_soldiers: EMPIRE_UNITS.Sol,
  buy_generals: EMPIRE_UNITS.Gen,
  buy_fighters: EMPIRE_UNITS.Ftr,
  buy_stations: EMPIRE_UNITS.Stn,
  buy_light_cruisers: EMPIRE_UNITS.LC,
  buy_heavy_cruisers: EMPIRE_UNITS.HC,
  buy_carriers: EMPIRE_UNITS.Car,
  buy_covert_agents: EMPIRE_UNITS.Cov,
  buy_command_ship: EMPIRE.commandShip,
};
