import { prisma } from "./prisma";
import { AI_PERSONAS } from "./gemini";
import { AI_NAME_POOL, AI_STRATEGY_POOL, type AIPersonaKey } from "./ai-builtin-config";
import { createStarterPlanets, createStarterEmpire } from "./player-init";

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

  for (const name of names) {
    const persona = pickRandomPersona();
    await prisma.player.create({
      data: {
        name,
        isAI: true,
        aiPersona: AI_PERSONAS[persona],
        turnOrder: nextTurnOrder++,
        gameSessionId,
        empire: { create: createStarterEmpire(createStarterPlanets()) },
      },
    });

    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { playerNames: { push: name } },
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

  const maxOrder = await prisma.player.aggregate({
    _max: { turnOrder: true },
    where: { gameSessionId },
  });
  let nextTurnOrder = (maxOrder._max.turnOrder ?? 0) + 1;

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
    await prisma.player.create({
      data: {
        name,
        isAI: true,
        aiPersona: AI_PERSONAS[persona],
        turnOrder: nextTurnOrder++,
        gameSessionId,
        empire: { create: createStarterEmpire(createStarterPlanets()) },
      },
    });

    await prisma.gameSession.update({
      where: { id: gameSessionId },
      data: { playerNames: { push: name } },
    });

    created.push(name);
  }

  const marketCount = await prisma.market.count();
  if (marketCount === 0) await prisma.market.create({ data: {} });

  return { created };
}
