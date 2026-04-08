import { prisma } from "./prisma";
import { AI_PERSONAS } from "./gemini";
import { AI_NAME_POOL, AI_STRATEGY_POOL, type AIPersonaKey } from "./ai-builtin-config";
import { createStarterPlanets } from "./player-init";
import { START } from "./game-constants";

export type { AIPersonaKey };
export { AI_NAME_POOL, AI_STRATEGY_POOL };

/** Pick `count` random unique names from a pool, avoiding names already in `exclude`. */
function pickRandomNames(count: number, exclude: Set<string>): string[] {
  const available = (AI_NAME_POOL as readonly string[]).filter((n) => !exclude.has(n));
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/** Pick a random persona key from the strategy pool. */
function pickRandomPersona(): AIPersonaKey {
  return AI_STRATEGY_POOL[Math.floor(Math.random() * AI_STRATEGY_POOL.length)];
}

/**
 * Create a single AI player with their starting empire as flat (non-nested) Prisma calls.
 * Avoids the mariadb adapter's LengthMismatch bug that occurs with deeply nested creates.
 */
async function createAIPlayerFlat(
  name: string,
  /** Persona KEY (e.g. "economist"), NOT the full prompt text. Stored in varchar(191). */
  personaKey: string,
  turnOrder: number,
  gameSessionId: string,
): Promise<void> {
  // 1. Player row — store the persona KEY (≤ 191 chars), not the full prompt text.
  const { id: playerId } = await prisma.player.create({
    data: { name, isAI: true, aiPersona: personaKey, turnOrder, gameSessionId },
    select: { id: true },
  });

  // 2. Empire row (no nested creates)
  const { id: empireId } = await prisma.empire.create({
    data: {
      playerId,
      credits: START.CREDITS,
      food: START.FOOD,
      ore: START.ORE,
      fuel: START.FUEL,
      population: START.POPULATION,
      taxRate: START.TAX_RATE,
      turnsLeft: START.TURNS,
      protectionTurns: START.PROTECTION_TURNS,
      pendingDefenderAlerts: [],
    },
    select: { id: true },
  });

  // 3. Planets (createMany avoids per-row SELECT)
  const planetData = createStarterPlanets().map((p) => ({ ...p, empireId }));
  await prisma.planet.createMany({ data: planetData });

  // 4. Army
  await prisma.army.create({
    data: {
      empireId,
      soldiers: START.SOLDIERS,
      generals: START.GENERALS,
      fighters: START.FIGHTERS,
    },
    select: { id: true },
  });

  // 5. Supply rates (all defaults)
  await prisma.supplyRates.create({ data: { empireId }, select: { id: true } });

  // 6. Research (all defaults)
  await prisma.research.create({ data: { empireId, unlockedTechIds: [] }, select: { id: true } });
}

/**
 * Create `count` AI players in a session with randomly assigned names and strategies.
 * Skips names that already exist in the session.
 */
export async function createRandomAIPlayersForSession(
  gameSessionId: string,
  count: number,
): Promise<{ created: string[] }> {
  const maxOrder = await prisma.player.aggregate({
    _max: { turnOrder: true },
    where: { gameSessionId },
  });
  let nextTurnOrder = (maxOrder._max.turnOrder ?? 0) + 1;

  // Get existing AI names in this session to avoid duplicates
  const existing = await prisma.player.findMany({
    where: { gameSessionId, isAI: true },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((p) => p.name));

  const names = pickRandomNames(count, existingNames);
  const created: string[] = [];

  // Fetch current playerNames once; track locally to avoid re-reading on each iteration.
  const sess = await prisma.gameSession.findUnique({ where: { id: gameSessionId }, select: { playerNames: true } });
  let currentPlayerNames: string[] = Array.isArray(sess?.playerNames) ? (sess.playerNames as string[]) : [];

  for (const name of names) {
    const persona = pickRandomPersona();
    await createAIPlayerFlat(name, persona, nextTurnOrder++, gameSessionId);

    currentPlayerNames = [...currentPlayerNames, name];
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { playerNames: currentPlayerNames },
    });

    created.push(name);
  }

  const marketCount = await prisma.market.count();
  if (marketCount === 0) await prisma.market.create({ data: {} });

  return { created };
}

/**
 * Create AI players by explicit name list (used by E2E tests and admin flows that
 * request specific commanders).  Each requested name gets a randomly assigned persona —
 * the caller does not control the strategy.
 *
 * Skips names that already exist in the session.
 */
export async function createAIPlayersForSession(
  gameSessionId: string,
  requestedNames?: string[],
): Promise<{ created: string[] }> {
  const names =
    requestedNames?.length
      ? requestedNames
      : (AI_NAME_POOL.slice(0, 3) as unknown as string[]);

  const [maxOrderResult, sess] = await Promise.all([
    prisma.player.aggregate({ _max: { turnOrder: true }, where: { gameSessionId } }),
    prisma.gameSession.findUnique({ where: { id: gameSessionId }, select: { playerNames: true } }),
  ]);
  let nextTurnOrder = (maxOrderResult._max.turnOrder ?? 0) + 1;
  let currentPlayerNames: string[] = Array.isArray(sess?.playerNames) ? (sess.playerNames as string[]) : [];

  const created: string[] = [];

  for (const name of names) {
    const existing = await prisma.player.findFirst({
      where: { name, gameSessionId },
    });
    if (existing) {
      created.push(`${name} (already exists)`);
      continue;
    }

    const persona = pickRandomPersona();
    await createAIPlayerFlat(name, persona, nextTurnOrder++, gameSessionId);

    currentPlayerNames = [...currentPlayerNames, name];
    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { playerNames: currentPlayerNames },
    });

    created.push(name);
  }

  const marketCount = await prisma.market.count();
  if (marketCount === 0) await prisma.market.create({ data: {} });

  return { created };
}
