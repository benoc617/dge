/**
 * SRX — AI move generation.
 *
 * Game-specific: persona definitions, prompt construction, local fallback
 * heuristics, and MCTS fallback for the "optimal" persona.
 *
 * Generic LLM infrastructure (config resolution, API calling, semaphores,
 * types) is in @dge/engine/llm. This module imports and re-exports the
 * public-API symbols that callers historically obtained from here.
 */

import { targetHasNewEmpireProtection } from "@/lib/empire-protection";
import * as rng from "@/lib/rng";
import {
  empireFromPrisma, makeRng, generateCandidateMoves, pickRolloutMove,
  type PrismaEmpireShape, type RolloutStrategy, type CandidateMove,
} from "@/lib/sim-state";
import { searchOpponentMoveAsync, buildSearchStates } from "@/lib/search-opponent";
import { withMctsDecide } from "@/lib/ai-concurrency";
import { resolveDoorAiRuntimeSettings } from "@/lib/door-ai-runtime-settings";
import {
  callGeminiAPI,
  attachAiTiming,
  shouldLogAiTiming,
  getGeminiRequestTimeoutMs,
  resolveGeminiConfig,
  type AIMoveContext,
  type AIMoveTiming,
  type AIMoveResult,
} from "@dge/engine/llm";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// (callers import these from "@/lib/gemini"; keep the path stable)
// ---------------------------------------------------------------------------

export { shouldLogAiTiming, getGeminiRequestTimeoutMs, resolveGeminiConfig };
export type { AIMoveContext, AIMoveTiming, AIMoveResult };

// ---------------------------------------------------------------------------
// SRX AI personas
// ---------------------------------------------------------------------------

export const AI_PERSONAS: Record<string, string> = {
  economist: `You are "The Economist" - a shrewd galactic banker who prioritizes wealth above all.
Strategy: Focus on ore/tourism/urban planets for income. Maintain low taxes (20-35%).
Sell excess resources aggressively. Buy bonds to protect credits. Build defense stations and enough
military (light cruisers, fighters) to protect expansion—you cannot grow rich if a rival conquers you.
CONTEST THE LEADER: If one commander clearly leads in net worth or territory, they will snowball and
win unless challenged. Treat the leaderboard as a threat: close the gap with economy, market trades,
covert ops, and conventional attacks when you have a clear military edge (not only pirates).
Do not sit passive while the frontrunner pulls away; winning means overtaking or crippling the leader.
Key: Maximize credits and net worth, but actively undermine whoever is #1 when the math favors you.`,

  warlord: `You are "The Warlord" - a ruthless military commander who respects only strength.
Strategy: Rush soldiers and fighters early. Buy light cruisers for cost-efficient fleet power (950cr each).
Buy government planets for generals. Build heavy cruisers for space dominance when rich.
Attack rival empires often via conventional invasion—prefer pressing the advantage over waiting for
perfect odds. Strike the strongest threat (usually the net-worth leader) when you can hurt them;
do not farm only weak targets or pirates while a rival snowballs. Moderate tax rate (40-50%).
Keep effectiveness high by winning battles; accept calculated risks to deny enemies breathing room.
Key: Build the largest army and conquer—decisive offensives beat endless buildup.`,

  spymaster: `You are "The Spy Master" - a shadowy manipulator who weakens foes before striking.
Strategy: Prioritize government planets for covert agent capacity.
Run insurgent aid and demoralize ops against rival empires (never yourself).
Only attack conventionally when target is at civil status 4+.
Maintain moderate economy to fund operations.
Key: Covert operations to weaken enemies, then strike when they're vulnerable.`,

  diplomat: `You are "The Diplomat" - a silver-tongued negotiator who builds alliances.
Strategy: Propose treaties with all neighbors. Form coalitions early.
Focus on urban and education planets for population growth.
Only attack isolated empires with no treaties. Trade extensively.
Low taxes (20-30%) for maximum population growth.
Key: Build alliances and grow through peaceful expansion.`,

  turtle: `You are "The Turtle" - a patient defender who waits for the perfect moment.
Strategy: Maximum defense stations, light cruisers, and fighters. Light cruisers (950cr) are
cost-efficient. Build anti-pollution planets. Research military upgrades early. Buy bonds to store wealth.
CONTEST THE LEADER: If one empire dominates the standings, they will end the game ahead of you.
You still prefer not to strike first in small skirmishes, but you MAY initiate conventional attacks
against the net-worth leader when they are overextended, weakened by others, or when your fleet can
win decisively—deny them safe expansion. Counter-attack hard when attacked; punish bullies.
High tax tolerance (50-60%) to fund walls and fleets.
Key: Impenetrable defense, then break whoever tries to run away with the galaxy.`,

  optimal: `You are "The Optimal Commander" — a search-based AI that evaluates the game tree.
You use Monte Carlo Tree Search to look ahead and choose the statistically strongest action.
You adapt to every situation without fixed heuristics.
Key: Tree search, not instinct.`,

  researcher: `You are "The Researcher" - a long-term strategist who wins through technological superiority.
Strategy: Build research planets early (2-3 minimum). Accumulate research points; unlock the most
impactful techs in order—income bonuses, population growth, maintenance reductions.
Buy government planets for covert agent capacity and maintenance savings.
Keep army light early; invest freed credits back into planets. Attack only pirates (good income) while
building; only strike rival empires once you have tech advantages that multiply your combat power.
Once techs compound, your economy will outpace anyone. Then buy heavy military for the endgame.
Key: Research planets + tech depth → compounding advantages that overwhelm raw economy or brute force.`,
};

// ---------------------------------------------------------------------------
// SRX-specific empire state type (used in prompt building and fallback)
// ---------------------------------------------------------------------------

interface EmpireState {
  credits: number;
  food: number;
  ore: number;
  fuel: number;
  population: number;
  taxRate: number;
  civilStatus: number;
  turnsPlayed: number;
  turnsLeft: number;
  netWorth: number;
  isProtected: boolean;
  protectionTurns: number;
  foodSellRate: number;
  oreSellRate: number;
  petroleumSellRate: number;
  planets: { type: string; shortTermProduction: number }[];
  army: {
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
  };
  research?: {
    accumulatedPoints: number;
    unlockedTechIds: string[];
  };
}

// ---------------------------------------------------------------------------
// Target selection utilities
// ---------------------------------------------------------------------------

/** Uniform random rival for attacks/covert (exported for unit tests). */
export function pickRivalOpponent(rivalNames: string[]): string {
  if (rivalNames.length === 0) throw new Error("pickRivalOpponent: empty rivalNames");
  return rivalNames[rng.randomInt(0, rivalNames.length - 1)]!;
}

/** Rivals that may be targeted by attacks/covert (excludes new-empire protection). */
export function computeRivalAttackTargets(
  rivals: {
    name: string;
    empire: { isProtected: boolean; protectionTurns: number } | null | undefined;
  }[],
): string[] {
  return rivals
    .filter((r) => r.empire != null && !targetHasNewEmpireProtection(r.empire))
    .map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Action validation + sanitization
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set([
  "buy_planet", "set_tax_rate", "set_sell_rates", "set_supply_rates",
  "buy_soldiers", "buy_generals", "buy_fighters", "buy_stations",
  "buy_light_cruisers", "buy_heavy_cruisers", "buy_carriers",
  "buy_covert_agents", "buy_command_ship",
  "attack_conventional", "attack_guerrilla", "attack_nuclear",
  "attack_chemical", "attack_psionic", "attack_pirates",
  "covert_op", "propose_treaty", "accept_treaty", "break_treaty",
  "create_coalition", "join_coalition", "leave_coalition",
  "market_buy", "market_sell", "bank_loan", "bank_repay",
  "buy_bond", "buy_lottery_ticket", "discover_tech", "send_message", "end_turn",
]);

function sanitizeAIMove(
  move: Record<string, unknown>,
  ctx: AIMoveContext,
  llmSource: "gemini" | "fallback",
): AIMoveResult {
  const action = typeof move.action === "string" && VALID_ACTIONS.has(move.action) ? move.action : "end_turn";
  const commanderName = ctx.commanderName;
  const rivalNames = ctx.rivalNames.filter((n) => n !== commanderName);
  const rivalAttackTargets = (ctx.rivalAttackTargets ?? []).filter(
    (n) => n !== commanderName && rivalNames.includes(n),
  );

  const HOSTILE_TARGET_ACTIONS = new Set([
    "attack_conventional", "attack_guerrilla", "attack_nuclear",
    "attack_chemical", "attack_psionic", "covert_op",
  ]);

  let target = typeof move.target === "string" ? move.target : undefined;
  const needsTarget = HOSTILE_TARGET_ACTIONS.has(action) || action === "propose_treaty";

  if (needsTarget) {
    if (HOSTILE_TARGET_ACTIONS.has(action)) {
      if (rivalAttackTargets.length === 0) {
        return {
          action: "end_turn",
          reasoning:
            rivalNames.length === 0
              ? typeof move.reasoning === "string" ? move.reasoning : "No rivals in session"
              : "No attackable rivals (all under new-empire protection)",
          llmSource,
        };
      }
      if (!target || !rivalAttackTargets.includes(target) || target === commanderName) {
        target = pickRivalOpponent(rivalAttackTargets);
      }
    } else if (action === "propose_treaty") {
      if (rivalNames.length === 0) {
        return {
          action: "end_turn",
          reasoning: typeof move.reasoning === "string" ? move.reasoning : "No rivals in session",
          llmSource,
        };
      }
      if (!target || !rivalNames.includes(target) || target === commanderName) {
        target = pickRivalOpponent(rivalNames);
      }
    }
  }

  const reasoning = typeof move.reasoning === "string" ? move.reasoning : "—";
  const out: AIMoveResult = { ...move, action, reasoning, llmSource };
  if (target !== undefined) out.target = target;
  return out;
}

// ---------------------------------------------------------------------------
// Internal timing log (SRX-specific [srx-ai] prefix)
// ---------------------------------------------------------------------------

function logGetAIMoveTiming(payload: {
  totalMs: number;
  configMs: number;
  generateMs: number;
  source: "gemini" | "fallback";
  reason?: string;
}) {
  if (!shouldLogAiTiming()) return;
  console.info("[srx-ai]", JSON.stringify({ event: "getAIMove", ...payload }));
}

// ---------------------------------------------------------------------------
// MCTS local fallback (optimal persona)
// ---------------------------------------------------------------------------

async function mctsLocalFallback(
  state: EmpireState,
  budgetMs: number,
): Promise<{ action: string; reasoning: string; [key: string]: unknown } | null> {
  try {
    const seedVal = rng.getSeed();
    const localRng = seedVal !== null ? makeRng(seedVal) : undefined;
    const shape: PrismaEmpireShape = {
      id: "optimal-ai",
      credits: state.credits ?? 0,
      food: state.food ?? 0,
      ore: state.ore ?? 0,
      fuel: state.fuel ?? 0,
      population: state.population ?? 0,
      taxRate: state.taxRate ?? 25,
      civilStatus: state.civilStatus ?? 0,
      netWorth: state.netWorth ?? 0,
      turnsLeft: state.turnsLeft ?? 0,
      turnsPlayed: state.turnsPlayed ?? 0,
      isProtected: state.isProtected ?? false,
      protectionTurns: state.protectionTurns ?? 0,
      foodSellRate: state.foodSellRate ?? 0,
      oreSellRate: state.oreSellRate ?? 50,
      petroleumSellRate: state.petroleumSellRate ?? 50,
      planets: (state.planets ?? []).map((p) => ({
        type: p.type,
        shortTermProduction: p.shortTermProduction,
        longTermProduction: p.shortTermProduction,
      })),
      army: {
        ...state.army,
        covertPoints: state.army?.covertPoints ?? 0,
        commandShipStrength: state.army?.commandShipStrength ?? 0,
        soldiersLevel: 1, fightersLevel: 1, stationsLevel: 1,
        lightCruisersLevel: 1, heavyCruisersLevel: 1,
      },
      research: state.research ?? { accumulatedPoints: 0, unlockedTechIds: [] },
      supplyRates: null,
      loans: 0,
    };
    const selfState = empireFromPrisma(shape, "optimal-ai");
    const { states, playerIdx } = buildSearchStates(selfState, []);
    const move = await searchOpponentMoveAsync(states, playerIdx, {
      strategy: "mcts",
      mcts: {
        iterations: 999_999,
        timeLimitMs: budgetMs,
        rolloutDepth: 25,
        seed: localRng ? Math.floor(localRng() * 0xffffffff) : undefined,
      },
    });
    return {
      action: move.action,
      ...move.params,
      reasoning: `MCTS(${budgetMs}ms budget): ${move.label}`,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulation-strategy fallback (all non-optimal personas)
// ---------------------------------------------------------------------------

/**
 * Map an SRX AI persona string to one of the sim-state RolloutStrategy types.
 * The sim strategies are simulation-tested; we reuse them here rather than
 * maintaining a separate, untested heuristic.
 */
function personaToRolloutStrategy(persona: string): RolloutStrategy {
  if (persona.includes("Warlord"))   return "military";
  if (persona.includes("Turtle"))    return "supply";   // builds stations/defense via supply logic
  if (persona.includes("Researcher"))return "research";
  if (persona.includes("Spy"))       return "credit";   // credit / covert-agent heavy
  if (persona.includes("Economist")) return "economy";
  return "balanced"; // Diplomat, default
}

async function localFallback(
  state: EmpireState,
  persona: string,
  ctx: AIMoveContext,
): Promise<{ action: string; target?: string; amount?: number; reasoning: string; opType?: number; [key: string]: unknown }> {
  // Optimal persona always uses MCTS (unchanged).
  if (persona.includes("Optimal") || persona.includes("optimal")) {
    const mctsResult = await mctsLocalFallback(state, 45_000);
    if (mctsResult) return mctsResult as { action: string; reasoning: string; [key: string]: unknown };
  }

  const s = state;
  const army = s?.army;
  const rivalAttackTargets = (ctx.rivalAttackTargets ?? []).filter((n) => n !== ctx.commanderName);
  const isWarlord   = persona.includes("Warlord");
  const isSpy       = persona.includes("Spy");

  // Build PrismaEmpireShape so we can use generateCandidateMoves / pickRolloutMove
  // (same conversion as mctsLocalFallback — missing fields filled with safe defaults).
  const shape: PrismaEmpireShape = {
    id: "ai-fallback",
    credits:    s?.credits ?? 0,
    food:       s?.food ?? 0,
    ore:        s?.ore ?? 0,
    fuel:       s?.fuel ?? 0,
    population: s?.population ?? 0,
    taxRate:    s?.taxRate ?? 25,
    civilStatus:s?.civilStatus ?? 0,
    netWorth:   s?.netWorth ?? 0,
    turnsLeft:  s?.turnsLeft ?? 0,
    turnsPlayed:s?.turnsPlayed ?? 0,
    isProtected:s?.isProtected ?? false,
    protectionTurns: s?.protectionTurns ?? 0,
    foodSellRate:      s?.foodSellRate ?? 0,
    oreSellRate:       s?.oreSellRate ?? 50,
    petroleumSellRate: s?.petroleumSellRate ?? 50,
    planets: (s?.planets ?? []).map((p) => ({
      type: p.type,
      shortTermProduction: p.shortTermProduction,
      longTermProduction:  p.shortTermProduction,
    })),
    army: {
      ...(army ?? {}),
      soldiers:       army?.soldiers ?? 0,
      generals:       army?.generals ?? 0,
      fighters:       army?.fighters ?? 0,
      defenseStations:army?.defenseStations ?? 0,
      lightCruisers:  army?.lightCruisers ?? 0,
      heavyCruisers:  army?.heavyCruisers ?? 0,
      carriers:       army?.carriers ?? 0,
      covertAgents:   army?.covertAgents ?? 0,
      covertPoints:   army?.covertPoints ?? 0,
      commandShipStrength: army?.commandShipStrength ?? 0,
      effectiveness:  army?.effectiveness ?? 100,
      soldiersLevel:       1,
      fightersLevel:       1,
      stationsLevel:       1,
      lightCruisersLevel:  1,
      heavyCruisersLevel:  1,
    },
    research: s?.research ?? { accumulatedPoints: 0, unlockedTechIds: [] },
    supplyRates: null,
    loans: 0,
  };
  const pureState = empireFromPrisma(shape, "ai-fallback");

  // Generate the candidate move set (economic, military, research — no rival detail).
  const candidates: CandidateMove[] = generateCandidateMoves(pureState, []);

  // Inject attack/covert candidates for aggressive personas when rivals are available.
  // We add one of each relevant type; pickRolloutMove's strategy scoring then decides
  // whether they win against the economic candidates.
  if (!s?.isProtected && rivalAttackTargets.length > 0 && army) {
    const target = pickRivalOpponent(rivalAttackTargets);
    if (army.generals >= 1) {
      candidates.push({ action: "attack_conventional", params: { target }, label: `Attack ${target}` });
      candidates.push({ action: "attack_guerrilla",    params: { target }, label: `Guerrilla ${target}` });
    }
    if (isSpy && army.covertAgents >= 1) {
      candidates.push({ action: "covert_op", params: { target, opType: rng.randomInt(0, 4) }, label: `Covert op vs ${target}` });
    }
    if (isWarlord || isSpy) {
      candidates.push({ action: "attack_pirates", params: {}, label: "Attack pirates" });
    }
  }

  // Select the best move using the persona's sim strategy.
  const strategy = personaToRolloutStrategy(persona);
  const best = pickRolloutMove(pureState, candidates, () => rng.random(), strategy);

  return {
    action: best.action,
    ...best.params,
    reasoning: `${strategy} strategy: ${best.label}`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function getAIMove(
  persona: string,
  empireState: unknown,
  gameEvents: string[],
  ctx: AIMoveContext,
): Promise<AIMoveResult> {
  await resolveDoorAiRuntimeSettings();
  const tStart = performance.now();
  const state = empireState as EmpireState;

  const planetSummary: Record<string, number> = {};
  if (state?.planets) {
    for (const p of state.planets) {
      planetSummary[p.type] = (planetSummary[p.type] || 0) + 1;
    }
  }

  const attackable = ctx.rivalAttackTargets?.filter((n) => ctx.rivalNames.includes(n)) ?? [];
  const protectedRivals = ctx.rivalNames.filter((n) => !attackable.includes(n));

  const rivalBlock =
    ctx.rivalNames.length > 0
      ? `RIVAL COMMANDERS:
${ctx.rivalNames.map((n) => `- ${n}`).join("\n")}
ATTACK / COVERT \`target\` — use ONLY these names (not under new-empire protection):
${attackable.length > 0 ? attackable.map((n) => `- ${n}`).join("\n") : "- (none — do NOT use attack_* or covert_op vs players; use attack_pirates, economy, or end_turn)"}
${
  protectedRivals.length > 0
    ? `PROTECTED (cannot attack or covert yet):\n${protectedRivals.map((n) => `- ${n}`).join("\n")}`
    : ""
}
TREATY \`target\` — any name from RIVAL COMMANDERS above.
YOUR NAME (never use as target): ${ctx.commanderName}`
      : `NO OTHER EMPIRES IN SESSION — use economy/military buildup or end_turn only (no attack/covert targets).`;

  const prompt = `You are an AI commander in Solar Realms Extreme, a turn-based galactic strategy game.

YOUR PERSONA:
${persona}

${rivalBlock}

YOUR EMPIRE STATE:
- Credits: ${state?.credits ?? 0} | Food: ${state?.food ?? 0} | Ore: ${state?.ore ?? 0} | Fuel: ${state?.fuel ?? 0}
- Population: ${state?.population ?? 0} | Tax Rate: ${state?.taxRate ?? 30}% | Civil Status: ${state?.civilStatus ?? 0}/7
- Turns Played: ${state?.turnsPlayed ?? 0} | Turns Left: ${state?.turnsLeft ?? 0} | Net Worth: ${state?.netWorth ?? 0}
- Protected: ${state?.isProtected ? `Yes (${state.protectionTurns} turns)` : "No"}
- Sell Rates: Food ${state?.foodSellRate ?? 0}% | Ore ${state?.oreSellRate ?? 50}% | Petro ${state?.petroleumSellRate ?? 50}%
- Planets: ${JSON.stringify(planetSummary)} (${state?.planets?.length ?? 0} total)
- Army: Soldiers=${state?.army?.soldiers ?? 0} Generals=${state?.army?.generals ?? 0} Fighters=${state?.army?.fighters ?? 0} Stations=${state?.army?.defenseStations ?? 0} LightCruisers=${state?.army?.lightCruisers ?? 0} HeavyCruisers=${state?.army?.heavyCruisers ?? 0} Carriers=${state?.army?.carriers ?? 0} Covert=${state?.army?.covertAgents ?? 0}
- Effectiveness: ${state?.army?.effectiveness ?? 100}% | Covert Points: ${state?.army?.covertPoints ?? 0}
- Research Points: ${state?.research?.accumulatedPoints ?? 0} | Techs Unlocked: ${state?.research?.unlockedTechIds?.length ?? 0}

RECENT EVENTS (this galaxy only):
${gameEvents.slice(0, 12).join("\n") || "None"}

AVAILABLE ACTIONS (choose one):
Economy: buy_planet (type: FOOD|ORE|TOURISM|PETROLEUM|URBAN|EDUCATION|GOVERNMENT|SUPPLY|RESEARCH|ANTI_POLLUTION)
Economy: set_tax_rate (rate: 0-100), set_sell_rates (foodSellRate/oreSellRate/petroleumSellRate: 0-100)
Military: buy_soldiers, buy_generals, buy_fighters, buy_stations, buy_light_cruisers, buy_heavy_cruisers, buy_carriers, buy_covert_agents (amount: N)
Combat: attack_conventional (target: name), attack_guerrilla (target: name), attack_pirates
Market: market_buy (resource: food|ore|fuel, amount: N), market_sell (resource, amount)
Finance: bank_loan (amount: N), buy_bond (amount: N), buy_lottery_ticket (amount: 1-100)
Covert: covert_op (target: name, opType: 0-9)
Research: discover_tech (techId: string) -- if you have enough research points
Other: end_turn (just collect income)

COST REFERENCE: Soldier=280cr, General=780cr, Fighter=380cr, Station=520cr, LightCruiser=950cr, HeavyCruiser=1900cr, Carrier=1430cr, CovertAgent=4090cr
PLANET COSTS (base, before netWorth inflation): Food=14000, Ore=10000, Tourism=14000, Petroleum=20000, Urban=14000, Education=14000, Gov=12000, Supply=20000, Research=25000, AntiPollution=18000

CRITICAL RULES:
- For attack_* and covert_op, \`target\` must be from ATTACK / COVERT list only — NEVER a PROTECTED rival or "${ctx.commanderName}" (yourself).
- Each action costs 1 turn. Choose the SINGLE BEST action for this turn.
- If food is low, buy food planets or buy food from market.
- If population is high relative to urban planets (1 urban = 20k capacity), buy urban planets.
- Government planets are needed for generals (50/planet cap) and covert agents (300/planet cap).
- Early game: focus on economy (planets, sell rates) before military — unless persona demands aggression.
- You need generals to attack. Buy government planets first.
- Light cruisers (950cr) are cost-efficient space/orbital units. Research planets also produce them for free.
- Heavy cruisers (1900cr) dominate the space front but cost double. Mix both for a balanced fleet.

Respond ONLY with valid JSON:
{"action": "action_name", "type": "value_if_buy_planet", "target": "name_if_attack", "amount": number_if_applicable, "opType": number_if_covert, "rate": number_if_set_tax, "techId": "id_if_discover", "reasoning": "brief tactical reasoning"}`;

  const runFallback = async (): Promise<AIMoveResult> => {
    const raw = await localFallback(state, persona, ctx);
    return sanitizeAIMove(raw as Record<string, unknown>, ctx, "fallback");
  };

  // Optimal persona always uses MCTS — never calls Gemini.
  if (persona.includes("Optimal") || persona.includes("optimal")) {
    const out = await withMctsDecide(async () => runFallback());
    logGetAIMoveTiming({ totalMs: performance.now() - tStart, configMs: 0, generateMs: 0, source: "fallback", reason: "optimal_persona" });
    return attachAiTiming(out, tStart, 0, 0);
  }

  // Call Gemini via engine (handles config resolution, semaphore, timeout).
  const apiResult = await callGeminiAPI(prompt);

  if (!apiResult) {
    const out = await runFallback();
    logGetAIMoveTiming({ totalMs: performance.now() - tStart, configMs: 0, generateMs: 0, source: "fallback", reason: "no_api_key_or_error" });
    return attachAiTiming(out, tStart, 0, 0);
  }

  const { text, configMs, generateMs } = apiResult;

  try {
    const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.action !== "string" || !VALID_ACTIONS.has(parsed.action)) {
      const out = await runFallback();
      logGetAIMoveTiming({ totalMs: performance.now() - tStart, configMs, generateMs, source: "fallback", reason: "invalid_action" });
      return attachAiTiming(out, tStart, configMs, generateMs);
    }
    const out = sanitizeAIMove(parsed, ctx, "gemini");
    logGetAIMoveTiming({ totalMs: performance.now() - tStart, configMs, generateMs, source: "gemini" });
    return attachAiTiming(out, tStart, configMs, generateMs);
  } catch {
    const out = await runFallback();
    logGetAIMoveTiming({ totalMs: performance.now() - tStart, configMs, generateMs: 0, source: "fallback", reason: "api_or_parse_error" });
    return attachAiTiming(out, tStart, configMs, 0);
  }
}
