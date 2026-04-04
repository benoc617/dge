import { prisma } from "./prisma";

export type ActionType =
  | "mine_ore"
  | "grow_food"
  | "refine_fuel"
  | "build_fighters"
  | "build_warship"
  | "colonize"
  | "attack"
  | "trade";

export interface ActionResult {
  success: boolean;
  message: string;
  details?: object;
}

const TURN_COST = 1;

export async function processAction(
  playerId: string,
  action: ActionType,
  params?: { target?: string; amount?: number }
): Promise<ActionResult> {
  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { empire: { include: { planets: true } } },
  });

  if (!player?.empire) return { success: false, message: "Empire not found." };

  const empire = player.empire;

  if (empire.turnsLeft < TURN_COST) {
    return { success: false, message: "No turns remaining." };
  }

  let result: ActionResult;

  switch (action) {
    case "mine_ore": {
      const amount = params?.amount ?? 100;
      await prisma.empire.update({
        where: { id: empire.id },
        data: { ore: { increment: amount }, turnsLeft: { decrement: TURN_COST } },
      });
      result = { success: true, message: `Mined ${amount} ore.` };
      break;
    }

    case "grow_food": {
      const amount = params?.amount ?? 100;
      await prisma.empire.update({
        where: { id: empire.id },
        data: { food: { increment: amount }, turnsLeft: { decrement: TURN_COST } },
      });
      result = { success: true, message: `Grew ${amount} food.` };
      break;
    }

    case "refine_fuel": {
      if (empire.ore < 50) return { success: false, message: "Not enough ore to refine fuel." };
      await prisma.empire.update({
        where: { id: empire.id },
        data: {
          ore: { decrement: 50 },
          fuel: { increment: 100 },
          turnsLeft: { decrement: TURN_COST },
        },
      });
      result = { success: true, message: "Refined 50 ore into 100 fuel." };
      break;
    }

    case "build_fighters": {
      const count = params?.amount ?? 5;
      const cost = count * 100;
      if (empire.credits < cost) {
        return { success: false, message: `Need ${cost} credits to build ${count} fighters.` };
      }
      await prisma.empire.update({
        where: { id: empire.id },
        data: {
          credits: { decrement: cost },
          fighters: { increment: count },
          turnsLeft: { decrement: TURN_COST },
        },
      });
      result = { success: true, message: `Built ${count} fighters for ${cost} credits.` };
      break;
    }

    case "build_warship": {
      const cost = 2000;
      if (empire.credits < cost) {
        return { success: false, message: `Need ${cost} credits to build a warship.` };
      }
      await prisma.empire.update({
        where: { id: empire.id },
        data: {
          credits: { decrement: cost },
          warships: { increment: 1 },
          turnsLeft: { decrement: TURN_COST },
        },
      });
      result = { success: true, message: `Warship constructed for ${cost} credits.` };
      break;
    }

    case "attack": {
      if (!params?.target) return { success: false, message: "No target specified." };

      const targetPlayer = await prisma.player.findFirst({
        where: { name: params.target },
        include: { empire: true },
      });

      if (!targetPlayer?.empire) {
        return { success: false, message: `Target empire '${params.target}' not found.` };
      }

      const attackPower = empire.fighters * 2 + empire.warships * 10;
      const defensePower = targetPlayer.empire.fighters * 2 + targetPlayer.empire.warships * 10 + 50;

      if (attackPower > defensePower) {
        const loot = Math.floor(targetPlayer.empire.credits * 0.1);
        await prisma.empire.update({
          where: { id: empire.id },
          data: {
            credits: { increment: loot },
            fighters: { decrement: Math.floor(empire.fighters * 0.1) },
            turnsLeft: { decrement: TURN_COST },
          },
        });
        await prisma.empire.update({
          where: { id: targetPlayer.empire.id },
          data: {
            credits: { decrement: loot },
            fighters: { decrement: Math.floor(targetPlayer.empire.fighters * 0.2) },
          },
        });
        result = { success: true, message: `Victory! Plundered ${loot} credits from ${params.target}.` };
      } else {
        await prisma.empire.update({
          where: { id: empire.id },
          data: {
            fighters: { decrement: Math.floor(empire.fighters * 0.2) },
            turnsLeft: { decrement: TURN_COST },
          },
        });
        result = { success: false, message: `Repelled by ${params.target}'s defenses. Lost fighters.` };
      }
      break;
    }

    default:
      return { success: false, message: "Unknown action." };
  }

  await prisma.turnLog.create({
    data: {
      playerId,
      action,
      details: { ...params, result },
    },
  });

  return result;
}
