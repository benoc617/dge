import { COMBAT, alterNumber } from "./game-constants";
import * as rng from "./rng";

// ---------------------------------------------------------------------------
// Unit tier multiplier tables
// ---------------------------------------------------------------------------

type Front = "guerrilla" | "ground" | "orbital" | "space" | "pirate";

const UNIT_MULTIPLIERS: Record<string, Record<Front, number[]>> = {
  soldiers: {
    guerrilla: [1.0, 1.5, 0.5],
    ground:    [1.0, 1.0, 2.0],
    orbital:   [0,   0,   1.0],
    space:     [0,   0,   0],
    pirate:    [0.5, 1.0, 2.0],
  },
  fighters: {
    guerrilla: [0, 0, 0],
    ground:    [0.5, 0.5, 0.5],
    orbital:   [1.0, 2.0, 3.0],
    space:     [0,   1.0, 1.0],
    pirate:    [0.5, 1.0, 2.0],
  },
  defenseStations: {
    guerrilla: [0, 0, 0],
    ground:    [0.5, 0.5, 1.0],
    orbital:   [1.0, 2.0, 1.0],
    space:     [0,   0,   1.0],
    pirate:    [0.5, 1.0, 2.0],
  },
  lightCruisers: {
    guerrilla: [0, 0, 0],
    ground:    [0,   0.1, 0.2],
    orbital:   [1.0, 2.0, 3.0],
    space:     [1.0, 1.0, 1.0],
    pirate:    [0.5, 1.0, 2.0],
  },
  heavyCruisers: {
    guerrilla: [0, 0, 0],
    ground:    [0,   0,   0.5],
    orbital:   [1.0, 1.0, 1.0],
    space:     [1.0, 2.0, 3.0],
    pirate:    [0.5, 1.0, 2.0],
  },
};

function getUnitStrength(
  unitType: string,
  count: number,
  tier: number,
  front: Front,
): number {
  const tiers = UNIT_MULTIPLIERS[unitType]?.[front];
  if (!tiers) return 0;
  return count * (tiers[Math.min(tier, 2)] ?? 0);
}

// ---------------------------------------------------------------------------
// Calculate total front strength for one side
// ---------------------------------------------------------------------------

interface ArmySnapshot {
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
  soldiersLevel: number;
  fightersLevel: number;
  stationsLevel: number;
  lightCruisersLevel: number;
  heavyCruisersLevel: number;
}

function calcFrontStrength(a: ArmySnapshot, front: Front): number {
  let str = 0;
  str += getUnitStrength("soldiers", a.soldiers, a.soldiersLevel, front);
  str += getUnitStrength("fighters", a.fighters, a.fightersLevel, front);
  str += getUnitStrength("defenseStations", a.defenseStations, a.stationsLevel, front);
  str += getUnitStrength("lightCruisers", a.lightCruisers, a.lightCruisersLevel, front);
  str += getUnitStrength("heavyCruisers", a.heavyCruisers, a.heavyCruisersLevel, front);

  if (front === "space" && a.commandShipStrength > 0) {
    str += a.heavyCruisers * (a.commandShipStrength / 100);
  }

  str *= (a.effectiveness / 100);
  str *= (1 + rng.random() * COMBAT.RANDOMNESS);
  return Math.max(0, str);
}

// ---------------------------------------------------------------------------
// Distribute casualties proportionally across active units on a front
// ---------------------------------------------------------------------------

function distributeCasualties(
  a: ArmySnapshot,
  front: Front,
  casualtyFraction: number,
): Partial<ArmySnapshot> {
  const updates: Partial<ArmySnapshot> = {};
  const unitKeys: (keyof ArmySnapshot)[] = ["soldiers", "fighters", "defenseStations", "lightCruisers", "heavyCruisers"];

  for (const key of unitKeys) {
    const count = a[key] as number;
    if (count > 0) {
      const tierKey = (key + "Level") as keyof ArmySnapshot;
      const tier = (a[tierKey] as number) ?? 0;
      const mult = UNIT_MULTIPLIERS[key]?.[front]?.[Math.min(tier, 2)] ?? 0;
      if (mult > 0) {
        const lost = Math.ceil(count * casualtyFraction);
        (updates as Record<string, number>)[key] = Math.max(0, count - lost);
      }
    }
  }

  return updates;
}

function mergeArmyUpdates(a: ArmySnapshot, updates: Partial<ArmySnapshot>): ArmySnapshot {
  return { ...a, ...updates };
}

// ---------------------------------------------------------------------------
// 3-front sequential combat
// ---------------------------------------------------------------------------

export interface CombatResult {
  victory: boolean;
  fronts: {
    name: string;
    rounds: { attacker: number; defender: number; winner: "attacker" | "defender" }[];
    attackerWins: number;
    defenderWins: number;
    won: boolean;
  }[];
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  loot?: {
    planetsCaptures: number;
    creditsLooted: number;
    populationTransferred: number;
  };
  messages: string[];
}

export function runConventionalInvasion(
  attacker: ArmySnapshot,
  defender: ArmySnapshot,
  defenderPlanets: number,
  defenderCredits: number,
  defenderPopulation: number,
): CombatResult {
  const messages: string[] = [];
  const fronts: CombatResult["fronts"] = [];
  const frontSequence: Front[] = ["space", "orbital", "ground"];

  let atkArmy = { ...attacker };
  let defArmy = { ...defender };

  const initialAtk = { ...atkArmy };
  const initialDef = { ...defArmy };

  let overallVictory = true;

  for (const front of frontSequence) {
    const frontResult = {
      name: front,
      rounds: [] as { attacker: number; defender: number; winner: "attacker" | "defender" }[],
      attackerWins: 0,
      defenderWins: 0,
      won: false,
    };

    for (let round = 0; round < COMBAT.INVASION_ROUNDS_PER_FRONT; round++) {
      let atkStr = calcFrontStrength(atkArmy, front);
      const defStr = calcFrontStrength(defArmy, front) * COMBAT.DEFENSE_BONUS;

      // Light cruiser protection in space front
      if (front === "space" && round < COMBAT.LIGHT_CRUISER_PROTECTION_ROUNDS) {
        atkStr *= 1.2;
      }

      const winner = atkStr >= defStr ? "attacker" : "defender";
      frontResult.rounds.push({ attacker: Math.round(atkStr), defender: Math.round(defStr), winner });

      if (winner === "attacker") {
        frontResult.attackerWins++;
        const casualtyRate = Math.min(0.3, (atkStr / Math.max(1, defStr)) * 0.05);
        const defUpdates = distributeCasualties(defArmy, front, casualtyRate);
        defArmy = mergeArmyUpdates(defArmy, defUpdates);
        // Attacker takes lighter casualties
        const atkCasualtyRate = casualtyRate * 0.3;
        const atkUpdates = distributeCasualties(atkArmy, front, atkCasualtyRate);
        atkArmy = mergeArmyUpdates(atkArmy, atkUpdates);
      } else {
        frontResult.defenderWins++;
        const casualtyRate = Math.min(0.3, (defStr / Math.max(1, atkStr)) * 0.05);
        const atkUpdates = distributeCasualties(atkArmy, front, casualtyRate);
        atkArmy = mergeArmyUpdates(atkArmy, atkUpdates);
        const defCasualtyRate = casualtyRate * 0.3;
        const defUpdates = distributeCasualties(defArmy, front, defCasualtyRate);
        defArmy = mergeArmyUpdates(defArmy, defUpdates);
      }
    }

    frontResult.won = frontResult.attackerWins >= 3;
    fronts.push(frontResult);

    if (!frontResult.won) {
      overallVictory = false;
      messages.push(`Repelled at the ${front} front (${frontResult.attackerWins}-${frontResult.defenderWins}).`);
      break;
    } else {
      messages.push(`Won the ${front} front (${frontResult.attackerWins}-${frontResult.defenderWins}).`);
    }
  }

  // Calculate losses
  const attackerLosses: Record<string, number> = {};
  const defenderLosses: Record<string, number> = {};
  const unitKeys = ["soldiers", "fighters", "defenseStations", "lightCruisers", "heavyCruisers"] as const;

  for (const k of unitKeys) {
    attackerLosses[k] = Math.max(0, initialAtk[k] - atkArmy[k]);
    defenderLosses[k] = Math.max(0, initialDef[k] - defArmy[k]);
  }

  let loot: CombatResult["loot"] | undefined;

  if (overallVictory) {
    const capturePercent = COMBAT.INVASION_PLANETS_MIN + rng.random() * (COMBAT.INVASION_PLANETS_MAX - COMBAT.INVASION_PLANETS_MIN);
    const planetsCaptures = Math.max(1, Math.floor(defenderPlanets * capturePercent / 100));
    const creditsLooted = Math.floor(defenderCredits * capturePercent / 100);
    const populationTransferred = Math.floor(defenderPopulation * capturePercent / 100);

    loot = { planetsCaptures, creditsLooted, populationTransferred };
    messages.push(`VICTORY! Captured ${planetsCaptures} planets, looted ${creditsLooted.toLocaleString()} credits.`);
  }

  return {
    victory: overallVictory,
    fronts,
    attackerLosses,
    defenderLosses,
    loot,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Guerrilla attack
// ---------------------------------------------------------------------------

export interface GuerrillaResult {
  damageDealt: Record<string, number>;
  attackerLosses: Record<string, number>;
  messages: string[];
}

export function runGuerrillaAttack(
  attacker: ArmySnapshot,
  defender: ArmySnapshot,
): GuerrillaResult {
  const messages: string[] = [];
  const damageDealt: Record<string, number> = {};
  const attackerLosses: Record<string, number> = {};

  let atkSoldiers = attacker.soldiers;
  let defSoldiers = defender.soldiers;

  for (let round = 0; round < COMBAT.GUERRILLA_ROUNDS; round++) {
    const atkStr = atkSoldiers * (UNIT_MULTIPLIERS.soldiers.guerrilla[attacker.soldiersLevel] ?? 1)
      * (attacker.effectiveness / 100)
      * (1 + rng.random() * COMBAT.RANDOMNESS);

    const defStr = defSoldiers * COMBAT.GUERRILLA_DEFENSE_MULT
      * (defender.effectiveness / 100)
      * (1 + rng.random() * COMBAT.RANDOMNESS);

    // Guerrilla: damage proportional to DEFENDER army size
    const damageToDefender = Math.ceil(defender.soldiers * 0.02 * (atkStr / Math.max(1, atkStr + defStr)));
    const damageToAttacker = Math.ceil(atkSoldiers * 0.05 * (defStr / Math.max(1, atkStr + defStr)));

    defSoldiers = Math.max(0, defSoldiers - damageToDefender);
    atkSoldiers = Math.max(0, atkSoldiers - damageToAttacker);
  }

  damageDealt.soldiers = Math.max(0, defender.soldiers - defSoldiers);
  attackerLosses.soldiers = Math.max(0, attacker.soldiers - atkSoldiers);

  messages.push(`Guerrilla ambush: killed ${damageDealt.soldiers} enemy soldiers, lost ${attackerLosses.soldiers}.`);

  return { damageDealt, attackerLosses, messages };
}

// ---------------------------------------------------------------------------
// Nuclear strike
// ---------------------------------------------------------------------------

export interface PlanetCasualtyLine {
  planetId: string;
  planetName: string;
  populationKilled: number;
}

export interface NuclearResult {
  planetsRadiated: string[];
  populationKilled: number;
  /** Per-planet population killed (same order as strikes). */
  planetCasualties: PlanetCasualtyLine[];
  messages: string[];
}

export function runNuclearStrike(
  targetPlanets: { id: string; name: string; population: number }[],
  numNukes: number,
): NuclearResult {
  const messages: string[] = [];
  const planetsRadiated: string[] = [];
  const planetCasualties: PlanetCasualtyLine[] = [];
  let populationKilled = 0;

  const targets = targetPlanets.slice(0, numNukes);
  for (const planet of targets) {
    planetsRadiated.push(planet.id);
    const killed = Math.floor(planet.population * (COMBAT.NUCLEAR_BASE_DAMAGE + rng.random() * COMBAT.NUCLEAR_EXTRA_DAMAGE) / 100);
    populationKilled += killed;
    planetCasualties.push({ planetId: planet.id, planetName: planet.name, populationKilled: killed });
    messages.push(`Nuclear strike on ${planet.name}: ${killed.toLocaleString()} killed, planet radiated.`);
  }

  return { planetsRadiated, populationKilled, planetCasualties, messages };
}

// ---------------------------------------------------------------------------
// Chemical warfare
// ---------------------------------------------------------------------------

export interface ChemicalResult {
  planetsAffected: string[];
  populationKilled: number;
  /** Per-planet population killed. */
  planetCasualties: PlanetCasualtyLine[];
  coordinatorRetaliation: boolean;
  retaliationDamage: number;
  messages: string[];
}

export function runChemicalWarfare(
  targetPlanets: { id: string; name: string; population: number }[],
): ChemicalResult {
  const messages: string[] = [];
  const planetsAffected: string[] = [];
  const planetCasualties: PlanetCasualtyLine[] = [];
  let populationKilled = 0;

  for (const planet of targetPlanets.slice(0, 3)) {
    planetsAffected.push(planet.id);
    const killed = Math.floor(planet.population * 0.15);
    populationKilled += killed;
    planetCasualties.push({ planetId: planet.id, planetName: planet.name, populationKilled: killed });
    messages.push(`Chemical agent deployed on ${planet.name}: ${killed.toLocaleString()} casualties.`);
  }

  // Galactic Coordinator retaliation (very likely to be caught)
  const caught = rng.random() < 0.85;
  let retaliationDamage = 0;
  if (caught) {
    retaliationDamage = 10; // percent of attacker's military destroyed
    messages.push("GALACTIC COORDINATOR: Chemical weapons detected! Retaliatory strike authorized.");
  }

  return { planetsAffected, populationKilled, planetCasualties, coordinatorRetaliation: caught, retaliationDamage, messages };
}

// ---------------------------------------------------------------------------
// Psionic bomb
// ---------------------------------------------------------------------------

export interface PsionicResult {
  civilStatusIncrease: number;
  effectivenessLoss: number;
  messages: string[];
}

export function runPsionicBomb(): PsionicResult {
  const increase = 2 + Math.floor(rng.random() * 2); // 2-3 levels
  const effectivenessLoss = 10 + Math.floor(rng.random() * 10);
  return {
    civilStatusIncrease: increase,
    effectivenessLoss,
    messages: [`Psionic bomb detonated! Target civil status worsened by ${increase} levels, effectiveness -${effectivenessLoss}%.`],
  };
}

// ---------------------------------------------------------------------------
// Pirate raid
// ---------------------------------------------------------------------------

export interface PirateResult {
  victory: boolean;
  lootCredits: number;
  lootOre: number;
  lootFood: number;
  attackerLosses: Record<string, number>;
  messages: string[];
}

export function runPirateRaid(army: ArmySnapshot, turnsPlayed: number = 0): PirateResult {
  const messages: string[] = [];

  // Pirates scale with player strength to keep raids challenging
  const playerStrength = calcFrontStrength(army, "pirate");
  const pirateDifficulty = 0.4 + rng.random() * 0.5; // 40-90% of player str
  const pirateStrength = Math.max(30, playerStrength * pirateDifficulty);

  const victory = playerStrength > pirateStrength;
  const attackerLosses: Record<string, number> = {};

  if (victory) {
    // Loot scales linearly with army strength — bigger fleets find richer pirate nests
    const baseLoot = 3000 + playerStrength * 15 + turnsPlayed * 40;
    const lootCredits = alterNumber(Math.round(baseLoot), 25);
    const lootOre = alterNumber(Math.round(100 + playerStrength * 0.8), 25);
    const lootFood = alterNumber(Math.round(50 + playerStrength * 0.5), 25);
    messages.push(`Pirate nest destroyed! Recovered ${lootCredits.toLocaleString()} credits, ${lootOre} ore, ${lootFood} food.`);
    const dominance = playerStrength / pirateStrength;
    const casualtyRate = Math.max(0.005, 0.04 / dominance);
    attackerLosses.soldiers = Math.ceil(army.soldiers * casualtyRate);
    attackerLosses.fighters = Math.ceil(army.fighters * casualtyRate);
    return { victory, lootCredits, lootOre, lootFood, attackerLosses, messages };
  } else {
    const casualtyRate = 0.06 + rng.random() * 0.04;
    attackerLosses.soldiers = Math.ceil(army.soldiers * casualtyRate);
    attackerLosses.fighters = Math.ceil(army.fighters * casualtyRate);
    messages.push(`Pirates repelled your forces! Lost ${attackerLosses.soldiers} soldiers and ${attackerLosses.fighters} fighters.`);
    return { victory, lootCredits: 0, lootOre: 0, lootFood: 0, attackerLosses, messages };
  }
}
