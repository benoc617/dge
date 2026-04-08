import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { alterNumber } from "./game-constants";
import * as rng from "./rng";

export interface CovertOpResult {
  success: boolean;
  detected: boolean;
  agentsLost: number;
  messages: string[];
  effects: Record<string, unknown>;
}

function getSuccessChance(attackerAgents: number, defenderAgents: number): number {
  if (attackerAgents === 0) return 0;
  const ratio = attackerAgents / Math.max(1, defenderAgents);
  return Math.min(95, Math.max(5, ratio * 50));
}

function getDetectionChance(attackerAgents: number, defenderAgents: number): number {
  const ratio = defenderAgents / Math.max(1, attackerAgents);
  return Math.min(80, Math.max(10, ratio * 40));
}

const COVERT_OPS: Record<number, { name: string; cost: number }> = {
  0: { name: "Spy", cost: 0 },
  1: { name: "Insurgent Aid", cost: 1 },
  2: { name: "Support Dissension", cost: 1 },
  3: { name: "Demoralize Troops", cost: 1 },
  4: { name: "Bombing Operations", cost: 1 },
  5: { name: "Relations Spying", cost: 0 },
  6: { name: "Take Hostages", cost: 1 },
  7: { name: "Carrier Sabotage", cost: 1 },
  8: { name: "Communications Spying", cost: 1 },
  9: { name: "Setup Coup", cost: 2 },
};

// --- Individual covert operation handlers ---
// Each returns { messages, effects } for the successful case.

type DefenderEmpire = Prisma.EmpireGetPayload<{
  include: { army: true; planets: true };
}>;

type OpResult = { messages: string[]; effects: Record<string, unknown> };

function executeSpy(defender: DefenderEmpire): OpResult {
  return {
    messages: [
      `Intelligence report on target:`,
      `Credits: ~${alterNumber(defender.credits, 15).toLocaleString()}, Pop: ~${alterNumber(defender.population, 15).toLocaleString()}`,
      `Planets: ${defender.planets.length}, Civil Status: ${defender.civilStatus}`,
      `Soldiers: ~${alterNumber(defender.army!.soldiers, 15)}, Fighters: ~${alterNumber(defender.army!.fighters, 15)}`,
    ],
    effects: { intel: true },
  };
}

async function executeInsurgentAid(defenderEmpireId: string, defender: DefenderEmpire): Promise<OpResult> {
  await prisma.empire.update({
    where: { id: defenderEmpireId },
    data: { civilStatus: Math.min(7, defender.civilStatus + 1) },
  });
  return {
    messages: [`Insurgent Aid: Target civil status worsened by 1 level.`],
    effects: { civilStatusChange: 1 },
  };
}

async function executeSupportDissension(defender: DefenderEmpire): Promise<OpResult> {
  const deserters = Math.floor(defender.army!.soldiers * 0.10);
  await prisma.army.update({
    where: { id: defender.army!.id },
    data: { soldiers: { decrement: deserters } },
  });
  return {
    messages: [`Support Dissension: ${deserters} enemy soldiers deserted.`],
    effects: { soldiersLost: deserters },
  };
}

async function executeDemoralizeTroops(defender: DefenderEmpire): Promise<OpResult> {
  const effLoss = 5 + Math.floor(rng.random() * 10);
  await prisma.army.update({
    where: { id: defender.army!.id },
    data: { effectiveness: Math.max(0, defender.army!.effectiveness - effLoss) },
  });
  return {
    messages: [`Demoralize Troops: Target effectiveness reduced by ${effLoss}%.`],
    effects: { effectivenessLoss: effLoss },
  };
}

async function executeBombing(defenderEmpireId: string, defender: DefenderEmpire): Promise<OpResult> {
  const foodDestroyed = Math.floor(defender.food * 0.30);
  await prisma.empire.update({
    where: { id: defenderEmpireId },
    data: { food: { decrement: foodDestroyed } },
  });
  return {
    messages: [`Bombing Operations: Destroyed ${foodDestroyed} food supply.`],
    effects: { foodDestroyed },
  };
}

async function executeRelationsSpying(defenderEmpireId: string): Promise<OpResult> {
  const treaties = await prisma.treaty.findMany({
    where: {
      OR: [{ fromEmpireId: defenderEmpireId }, { toEmpireId: defenderEmpireId }],
      status: "ACTIVE",
    },
  });
  const messages = [`Relations report: ${treaties.length} active treaties.`];
  for (const t of treaties) {
    const otherId = t.fromEmpireId === defenderEmpireId ? t.toEmpireId : t.fromEmpireId;
    messages.push(`  ${t.type} with empire ${otherId.slice(0, 8)}... (${t.turnsRemaining} turns)`);
  }
  return { messages, effects: { treatyCount: treaties.length } };
}

async function executeTakeHostages(defenderEmpireId: string, defender: DefenderEmpire): Promise<OpResult> {
  const ransom = Math.floor(defender.credits * 0.10);
  await prisma.empire.update({ where: { id: defenderEmpireId }, data: { credits: { decrement: ransom } } });
  return {
    messages: [`Take Hostages: Ransomed ${ransom.toLocaleString()} credits from target.`],
    effects: { creditsStolen: ransom },
  };
}

async function executeCarrierSabotage(defender: DefenderEmpire): Promise<OpResult> {
  const carriersDestroyed = Math.max(1, Math.floor(defender.army!.carriers * 0.10));
  await prisma.army.update({
    where: { id: defender.army!.id },
    data: { carriers: { decrement: carriersDestroyed } },
  });
  return {
    messages: [`Carrier Sabotage: ${carriersDestroyed} enemy carriers destroyed.`],
    effects: { carriersDestroyed },
  };
}

async function executeCommsSpy(defenderEmpireId: string): Promise<OpResult> {
  const recentLogs = await prisma.turnLog.findMany({
    where: { player: { empire: { id: defenderEmpireId } } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  const messages = [`Intercepted ${recentLogs.length} recent communications:`];
  for (const log of recentLogs) {
    messages.push(`  Action: ${log.action}`);
  }
  return { messages, effects: { logsIntercepted: recentLogs.length } };
}

async function executeSetupCoup(defenderEmpireId: string, defender: DefenderEmpire): Promise<OpResult> {
  const effLoss = 15;
  await prisma.empire.update({
    where: { id: defenderEmpireId },
    data: { civilStatus: Math.min(7, defender.civilStatus + 2) },
  });
  await prisma.army.update({
    where: { id: defender.army!.id },
    data: { effectiveness: Math.max(0, defender.army!.effectiveness - effLoss) },
  });
  return {
    messages: [`Setup Coup: Target civil status +2, effectiveness -${effLoss}%.`],
    effects: { civilStatusChange: 2, effectivenessLoss: effLoss },
  };
}

export async function executeCovertOp(
  attackerEmpireId: string,
  defenderEmpireId: string,
  opType: number,
  attackerAgents: number,
  attackerCovertPoints: number,
): Promise<CovertOpResult> {
  const defender = await prisma.empire.findUnique({
    where: { id: defenderEmpireId },
    include: { army: true, planets: true },
  });

  if (!defender?.army) {
    return { success: false, detected: false, agentsLost: 0, messages: ["Target not found."], effects: {} };
  }

  const defenderAgents = defender.army.covertAgents;
  const successChance = getSuccessChance(attackerAgents, defenderAgents);
  const detectionChance = getDetectionChance(attackerAgents, defenderAgents);

  const op = COVERT_OPS[opType];
  if (!op) return { success: false, detected: false, agentsLost: 0, messages: ["Invalid operation."], effects: {} };

  if (attackerCovertPoints < op.cost) {
    return { success: false, detected: false, agentsLost: 0, messages: [`Need ${op.cost} covert points for ${op.name}.`], effects: {} };
  }

  const succeeded = rng.random() * 100 < successChance;
  const detected = rng.random() * 100 < detectionChance;
  const agentsLost = detected ? Math.max(1, Math.ceil(attackerAgents * 0.02)) : 0;

  if (!succeeded) {
    const messages = [`${op.name} operation failed.`];
    if (detected) messages.push(`Your agents were detected! Lost ${agentsLost} agents.`);
    return { success: false, detected, agentsLost, messages, effects: { pointsCost: op.cost } };
  }

  const handlers: Record<number, () => OpResult | Promise<OpResult>> = {
    0: () => executeSpy(defender),
    1: () => executeInsurgentAid(defenderEmpireId, defender),
    2: () => executeSupportDissension(defender),
    3: () => executeDemoralizeTroops(defender),
    4: () => executeBombing(defenderEmpireId, defender),
    5: () => executeRelationsSpying(defenderEmpireId),
    6: () => executeTakeHostages(defenderEmpireId, defender),
    7: () => executeCarrierSabotage(defender),
    8: () => executeCommsSpy(defenderEmpireId),
    9: () => executeSetupCoup(defenderEmpireId, defender),
  };

  const { messages, effects } = await handlers[opType]();
  effects.pointsCost = op.cost;

  if (detected) messages.push(`Your agents were detected! Lost ${agentsLost} agents.`);

  return { success: true, detected, agentsLost, messages, effects };
}

/** Defender-facing line for the next turn situation report; null if the defender would not learn of the op. */
export function defenderCovertAlertMessage(
  attackerName: string,
  opType: number,
  result: CovertOpResult,
): string | null {
  if (!result.success) {
    return result.detected
      ? `Hostile covert activity from ${attackerName} was detected; the operation failed.`
      : null;
  }

  const effectNum = (key: string, fallback = 0): number => {
    const val = result.effects[key];
    return typeof val === "number" ? val : fallback;
  };

  switch (opType) {
    case 0:
      return result.detected
        ? `Your intelligence detected ${attackerName}'s spy operation (intel may have leaked).`
        : null;
    case 1:
      return `Insurgent activity backed by ${attackerName} worsened your civil stability.`;
    case 2:
      return `Dissension stirred by ${attackerName}: ${effectNum("soldiersLost")} soldiers deserted.`;
    case 3:
      return `Enemy morale operations by ${attackerName} cut your army effectiveness by ${effectNum("effectivenessLoss")}%.`;
    case 4:
      return `Bombing operations by ${attackerName} destroyed ${effectNum("foodDestroyed")} food stores.`;
    case 5:
      return result.detected
        ? `Your intelligence detected ${attackerName}'s spy operation on your diplomatic relations.`
        : null;
    case 6:
      return `Hostage-taking by ${attackerName}: you lost ${effectNum("creditsStolen").toLocaleString()} credits in ransom.`;
    case 7:
      return `Carrier sabotage by ${attackerName}: ${effectNum("carriersDestroyed")} carriers destroyed.`;
    case 8:
      return result.detected
        ? `Your intelligence detected ${attackerName}'s communications intercept attempt.`
        : null;
    case 9:
      return `Coup attempt by ${attackerName}: civil unrest surged and army effectiveness dropped ${effectNum("effectivenessLoss", 15)}%.`;
    default:
      return null;
  }
}
