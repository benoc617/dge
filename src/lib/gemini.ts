import { GoogleGenerativeAI } from "@google/generative-ai";
import { PLANET_CONFIG, UNIT_COST } from "@/lib/game-constants";
import { targetHasNewEmpireProtection } from "@/lib/empire-protection";
import * as rng from "@/lib/rng";
import { empireFromPrisma, makeRng, type PrismaEmpireShape } from "@/lib/sim-state";
import { searchOpponentMoveAsync, buildSearchStates } from "@/lib/search-opponent";
import { getAvailableTech } from "@/lib/research";
import { withGeminiGeneration, withMctsDecide } from "@/lib/ai-concurrency";
import { resolveDoorAiRuntimeSettings } from "@/lib/door-ai-runtime-settings";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

/** Max wait for `generateContent`; on expiry the SDK aborts and we use `localFallback`. */
const DEFAULT_GEMINI_TIMEOUT_MS = 60_000;
const MAX_GEMINI_TIMEOUT_MS = 300_000;

/**
 * Milliseconds for each Gemini API call (`generateContent` request timeout).
 * Override with `GEMINI_TIMEOUT_MS` (min 1000, max 300000; invalid values → default 60000).
 */
/** When `1` or `true`, logs JSON lines to stdout for `getAIMove` and (from ai-runner) full AI turn timing. */
export function shouldLogAiTiming(): boolean {
  const v = process.env.SRX_LOG_AI_TIMING;
  return v === "1" || v === "true";
}

export function getGeminiRequestTimeoutMs(): number {
  const raw = process.env.GEMINI_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_GEMINI_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GEMINI_TIMEOUT_MS;
  return Math.min(MAX_GEMINI_TIMEOUT_MS, Math.max(1000, Math.floor(n)));
}

/** DB `SystemSettings` overrides env (`GEMINI_API_KEY` / `GEMINI_MODEL`). */
export async function resolveGeminiConfig(): Promise<{ apiKey: string | null; model: string }> {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
  const key = row?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY || null;
  const model = row?.geminiModel?.trim() || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return { apiKey: key, model };
}


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

const VALID_ACTIONS = new Set([
  "buy_planet",
  "set_tax_rate",
  "set_sell_rates",
  "set_supply_rates",
  "buy_soldiers",
  "buy_generals",
  "buy_fighters",
  "buy_stations",
  "buy_light_cruisers",
  "buy_heavy_cruisers",
  "buy_carriers",
  "buy_covert_agents",
  "buy_command_ship",
  "attack_conventional",
  "attack_guerrilla",
  "attack_nuclear",
  "attack_chemical",
  "attack_psionic",
  "attack_pirates",
  "covert_op",
  "propose_treaty",
  "accept_treaty",
  "break_treaty",
  "create_coalition",
  "join_coalition",
  "leave_coalition",
  "market_buy",
  "market_sell",
  "bank_loan",
  "bank_repay",
  "buy_bond",
  "buy_lottery_ticket",
  "discover_tech",
  "send_message",
  "end_turn",
]);

export type AIMoveContext = {
  /** This AI player's commander name (never a valid attack target). */
  commanderName: string;
  /** Other players in the same session (human + AI), excluding self. */
  rivalNames: string[];
  /**
   * Subset of `rivalNames` whose empires are not under new-empire protection — the only valid
   * `target` for attack_* and covert_op. Empty when every rival is protected or there are no rivals.
   */
  rivalAttackTargets: string[];
};

/** Persisted on `TurnLog.details` (via `logMeta`) for post-hoc latency analysis. */
export type AIMoveTiming = {
  configMs: number;
  /** `generateContent` only; 0 when fallback or no API call. */
  generateMs: number;
  totalMs: number;
};

export type AIMoveResult = {
  action: string;
  target?: string;
  amount?: number;
  reasoning: string;
  /** Whether the Gemini API produced the move or local rule-based fallback ran. */
  llmSource: "gemini" | "fallback";
  /** Wall-clock breakdown inside `getAIMove` (also merged into AI `logMeta` → TurnLog). */
  aiTiming?: AIMoveTiming;
  [key: string]: unknown;
};

function attachAiTiming(
  result: AIMoveResult,
  tStart: number,
  configMs: number,
  generateMs: number,
): AIMoveResult {
  result.aiTiming = {
    configMs: Math.round(configMs),
    generateMs: Math.round(generateMs),
    totalMs: Math.round(performance.now() - tStart),
  };
  return result;
}

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
    "attack_conventional",
    "attack_guerrilla",
    "attack_nuclear",
    "attack_chemical",
    "attack_psionic",
    "covert_op",
  ]);

  let target = typeof move.target === "string" ? move.target : undefined;
  const needsTarget =
    HOSTILE_TARGET_ACTIONS.has(action) ||
    action === "propose_treaty";

  if (needsTarget) {
    if (HOSTILE_TARGET_ACTIONS.has(action)) {
      if (rivalAttackTargets.length === 0) {
        return {
          action: "end_turn",
          reasoning:
            rivalNames.length === 0
              ? typeof move.reasoning === "string"
                ? move.reasoning
                : "No rivals in session"
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

  const out: AIMoveResult = {
    ...move,
    action,
    reasoning,
    llmSource,
  };
  if (target !== undefined) out.target = target;
  return out;
}

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

  const attackable =
    ctx.rivalAttackTargets?.filter((n) => ctx.rivalNames.includes(n)) ?? [];
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

  // Optimal persona always uses the in-house MCTS algorithm — never calls Gemini.
  if (persona.includes("Optimal") || persona.includes("optimal")) {
    const out = await withMctsDecide(async () => runFallback());
    logGetAIMoveTiming({
      totalMs: performance.now() - tStart,
      configMs: 0,
      generateMs: 0,
      source: "fallback",
      reason: "optimal_persona",
    });
    return attachAiTiming(out, tStart, 0, 0);
  }

  const tConfig0 = performance.now();
  const geminiCfg = await resolveGeminiConfig();
  const configMs = performance.now() - tConfig0;

  if (!geminiCfg.apiKey || geminiCfg.apiKey.startsWith("your-")) {
    const out = await runFallback();
    logGetAIMoveTiming({
      totalMs: performance.now() - tStart,
      configMs,
      generateMs: 0,
      source: "fallback",
      reason: "no_api_key",
    });
    return attachAiTiming(out, tStart, configMs, 0);
  }

  try {
    const model = new GoogleGenerativeAI(geminiCfg.apiKey).getGenerativeModel({ model: geminiCfg.model });
    const tGen0 = performance.now();
    const result = await withGeminiGeneration(async () =>
      model.generateContent(prompt, {
        timeout: getGeminiRequestTimeoutMs(),
      }),
    );
    const generateMs = performance.now() - tGen0;
    const text = result.response.text().trim();
    const json = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.action !== "string" || !VALID_ACTIONS.has(parsed.action)) {
      const out = await runFallback();
      logGetAIMoveTiming({
        totalMs: performance.now() - tStart,
        configMs,
        generateMs,
        source: "fallback",
        reason: "invalid_action",
      });
      return attachAiTiming(out, tStart, configMs, generateMs);
    }
    const out = sanitizeAIMove(parsed, ctx, "gemini");
    logGetAIMoveTiming({
      totalMs: performance.now() - tStart,
      configMs,
      generateMs,
      source: "gemini",
    });
    return attachAiTiming(out, tStart, configMs, generateMs);
  } catch {
    const out = await runFallback();
    logGetAIMoveTiming({
      totalMs: performance.now() - tStart,
      configMs,
      generateMs: 0,
      source: "fallback",
      reason: "api_or_parse_error",
    });
    return attachAiTiming(out, tStart, configMs, 0);
  }
}

/**
 * Time-budgeted MCTS fallback for the "optimal" persona.
 * Uses the async MCTS variant that yields the event loop every ~50ms so
 * long budgets (e.g. 45s) don't starve HTTP requests.
 * Returns null on any error so `localFallback` can drop through to heuristics.
 */
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
        longTermProduction: p.shortTermProduction, // best guess
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

async function localFallback(
  state: EmpireState,
  persona: string,
  ctx: AIMoveContext,
): Promise<{ action: string; target?: string; amount?: number; reasoning: string; opType?: number; [key: string]: unknown }> {
  // Optimal persona: MCTS only — no Gemini, no heuristic fallback.
  // getAIMove() already bypasses Gemini before reaching here; this 45s budget
  // lets the search run properly as a live AI opponent.
  // Uses async MCTS that yields the event loop every ~50ms.
  if (persona.includes("Optimal") || persona.includes("optimal")) {
    const mctsResult = await mctsLocalFallback(state, 45_000);
    if (mctsResult) return mctsResult as { action: string; reasoning: string; [key: string]: unknown };
  }

  const s = state;
  const planets = s?.planets ?? [];
  const army = s?.army;
  const credits = s?.credits ?? 0;
  const food = s?.food ?? 0;
  const population = s?.population ?? 0;
  const turnsPlayed = s?.turnsPlayed ?? 0;

  const rivalAttackTargets = (ctx.rivalAttackTargets ?? []).filter((n) => n !== ctx.commanderName);

  const PC = PLANET_CONFIG;
  const UC = UNIT_COST;

  const pCount: Record<string, number> = {};
  for (const p of planets) pCount[p.type] = (pCount[p.type] || 0) + 1;
  const totalPlanets = planets.length;
  const foodPlanets = pCount["FOOD"] ?? 0;
  const orePlanets = pCount["ORE"] ?? 0;
  const urbanPlanets = pCount["URBAN"] ?? 0;
  const govPlanets = pCount["GOVERNMENT"] ?? 0;
  const supplyPlanets = pCount["SUPPLY"] ?? 0;

  const isWarlord = persona.includes("Warlord");
  const isTurtle = persona.includes("Turtle");
  const isEcon = persona.includes("Economist");
  const isSpy = persona.includes("Spy");
  const isResearcher = persona.includes("Researcher");

  if (turnsPlayed === 0 && s.foodSellRate === 0) {
    return { action: "set_sell_rates", foodSellRate: 0, oreSellRate: 60, petroleumSellRate: 80, reasoning: "Set initial sell rates" };
  }

  if (food < 50 && credits >= PC.FOOD.baseCost) {
    return { action: "buy_planet", type: "FOOD", reasoning: "Critical: food low" };
  }
  if (food < 0 && credits >= 100 * 80) {
    return { action: "market_buy", resource: "food", amount: 100, reasoning: "Emergency food buy" };
  }

  // Early aggression (Warlord / Spy) when attackable rivals exist
  if (rivalAttackTargets.length > 0 && !s.isProtected && army) {
    if (isWarlord && turnsPlayed >= 6 && (army.generals ?? 0) >= 1 && rng.random() < 0.2) {
      return {
        action: "attack_conventional",
        target: pickRivalOpponent(rivalAttackTargets),
        reasoning: "Press rival empires",
      };
    }
    if (isSpy && turnsPlayed >= 8 && (army.covertAgents ?? 0) >= 1 && rng.random() < 0.25) {
      return {
        action: "covert_op",
        target: pickRivalOpponent(rivalAttackTargets),
        opType: rng.random() < 0.5 ? 0 : 1,
        reasoning: "Covert ops vs rival",
      };
    }
    if (isWarlord && turnsPlayed >= 5 && rng.random() < 0.14) {
      return { action: "attack_pirates", reasoning: "Raid pirates for income" };
    }
  }

  if (turnsPlayed < 20) {
    if (foodPlanets < 3 && credits >= PC.FOOD.baseCost) return { action: "buy_planet", type: "FOOD", reasoning: "Need more food early" };
    if (isResearcher && (pCount["RESEARCH"] ?? 0) < 2 && credits >= PC.RESEARCH.baseCost) {
      return { action: "buy_planet", type: "RESEARCH", reasoning: "Build research capacity" };
    }
    if (urbanPlanets < 3 && credits >= PC.URBAN.baseCost) return { action: "buy_planet", type: "URBAN", reasoning: "Grow population capacity" };
    if (orePlanets < 3 && credits >= PC.ORE.baseCost) return { action: "buy_planet", type: "ORE", reasoning: "Need ore for units" };
    if (govPlanets < 2 && credits >= PC.GOVERNMENT.baseCost) return { action: "buy_planet", type: "GOVERNMENT", reasoning: "Need government for generals" };
    if (isEcon && credits >= PC.TOURISM.baseCost) return { action: "buy_planet", type: "TOURISM", reasoning: "Tourism income" };
    if (credits >= UC.SOLDIER * 10) {
      const amt = Math.min(Math.floor(credits * 0.4 / UC.SOLDIER), 50);
      if (amt > 0) return { action: "buy_soldiers", amount: amt, reasoning: "Build early defense" };
    }
    return { action: "end_turn", reasoning: "Saving credits" };
  }

  if (population > urbanPlanets * 18000 && credits >= PC.URBAN.baseCost) {
    return { action: "buy_planet", type: "URBAN", reasoning: "Population nearing cap" };
  }

  if (isWarlord) {
    if (rivalAttackTargets.length > 0 && !s.isProtected && army && (army.generals ?? 0) >= 1) {
      if (rng.random() < 0.38) {
        return {
          action: "attack_conventional",
          target: pickRivalOpponent(rivalAttackTargets),
          reasoning: "Conventional invasion",
        };
      }
      if (rng.random() < 0.14) {
        return {
          action: "attack_guerrilla",
          target: pickRivalOpponent(rivalAttackTargets),
          reasoning: "Guerrilla harassment",
        };
      }
      if (rng.random() < 0.12) {
        return { action: "attack_pirates", reasoning: "Pirate raid" };
      }
    }
    if (govPlanets < 2 && credits >= PC.GOVERNMENT.baseCost) return { action: "buy_planet", type: "GOVERNMENT", reasoning: "Need generals" };
    if (army && army.generals < 2 && govPlanets > 0 && credits >= UC.GENERAL * 2) return { action: "buy_generals", amount: 2, reasoning: "Need generals to attack" };
    if (army && army.soldiers < 200 && credits >= UC.SOLDIER * 30) return { action: "buy_soldiers", amount: Math.min(30, Math.floor(credits / UC.SOLDIER)), reasoning: "Build army" };
    if (army && army.fighters < 50 && credits >= UC.FIGHTER * 15) return { action: "buy_fighters", amount: Math.min(15, Math.floor(credits / UC.FIGHTER)), reasoning: "Build fighters" };
    if (credits >= UC.LIGHT_CRUISER * 10) return { action: "buy_light_cruisers", amount: Math.min(10, Math.floor(credits / UC.LIGHT_CRUISER)), reasoning: "Light cruisers for fleet" };
    if (credits >= UC.HEAVY_CRUISER * 5) return { action: "buy_heavy_cruisers", amount: Math.min(5, Math.floor(credits / UC.HEAVY_CRUISER)), reasoning: "Heavy cruisers for space" };
    if (supplyPlanets < 1 && credits >= PC.SUPPLY.baseCost) return { action: "buy_planet", type: "SUPPLY", reasoning: "Auto-produce military" };
    if (foodPlanets < totalPlanets * 0.2 && credits >= PC.FOOD.baseCost) return { action: "buy_planet", type: "FOOD", reasoning: "Need food for army" };
    return { action: "buy_soldiers", amount: Math.max(1, Math.min(20, Math.floor(credits / UC.SOLDIER))), reasoning: "More soldiers" };
  }

  if (isTurtle) {
    if (credits >= UC.DEFENSE_STATION * 10 && army && army.defenseStations < 80) return { action: "buy_stations", amount: Math.min(10, Math.floor(credits / UC.DEFENSE_STATION)), reasoning: "Fortify defenses" };
    if (credits >= UC.FIGHTER * 10 && army && army.fighters < 60) return { action: "buy_fighters", amount: Math.min(10, Math.floor(credits / UC.FIGHTER)), reasoning: "Defensive fleet" };
    if (credits >= UC.LIGHT_CRUISER * 5) return { action: "buy_light_cruisers", amount: Math.min(5, Math.floor(credits / UC.LIGHT_CRUISER)), reasoning: "Light cruiser defense" };
    if (foodPlanets < totalPlanets * 0.25 && credits >= PC.FOOD.baseCost) return { action: "buy_planet", type: "FOOD", reasoning: "Secure food supply" };
    if (credits >= PC.ORE.baseCost) return { action: "buy_planet", type: "ORE", reasoning: "Feed the military machine" };
    return { action: "end_turn", reasoning: "Holding steady" };
  }

  if (isResearcher) {
    const researchPlanets = pCount["RESEARCH"] ?? 0;
    const resPoints = state.research?.accumulatedPoints ?? 0;
    // Always keep growing research infrastructure
    if (researchPlanets < 3 && credits >= PC.RESEARCH.baseCost) {
      return { action: "buy_planet", type: "RESEARCH", reasoning: "Expand research network" };
    }
    // Unlock techs ASAP when affordable
    if (resPoints > 0) {
      const avail = getAvailableTech(state.research?.unlockedTechIds ?? []);
      const affordable = avail.filter((t) => t.cost <= resPoints);
      if (affordable.length > 0) {
        const pick = affordable.reduce((a, b) => a.cost < b.cost ? a : b);
        return { action: "discover_tech", techId: pick.id, reasoning: `Research ${pick.id} for tech advantage` };
      }
    }
    if (govPlanets < 2 && credits >= PC.GOVERNMENT.baseCost) {
      return { action: "buy_planet", type: "GOVERNMENT", reasoning: "Maintenance savings + agent capacity" };
    }
    if (foodPlanets < 3 && credits >= PC.FOOD.baseCost) {
      return { action: "buy_planet", type: "FOOD", reasoning: "Feed the empire" };
    }
    // Light pirate raids for income once army is minimal
    if (army && (army.generals ?? 0) >= 1 && rng.random() < 0.18) {
      return { action: "attack_pirates", reasoning: "Pirate income funding research" };
    }
    // Keep minimal soldiers for defense
    if (army && army.soldiers < 100 && credits >= UC.SOLDIER * 20) {
      return { action: "buy_soldiers", amount: 20, reasoning: "Minimal defense" };
    }
    // Buy more research planets if budget allows
    if (credits >= PC.RESEARCH.baseCost) {
      return { action: "buy_planet", type: "RESEARCH", reasoning: "More research output" };
    }
    return { action: "end_turn", reasoning: "Accumulating research points" };
  }

  if (isSpy) {
    if (rivalAttackTargets.length > 0 && army && (army.covertAgents ?? 0) >= 1 && rng.random() < 0.32) {
      return {
        action: "covert_op",
        target: pickRivalOpponent(rivalAttackTargets),
        opType: rng.randomInt(0, 4),
        reasoning: "Sustained covert pressure",
      };
    }
    if (rivalAttackTargets.length > 0 && !s.isProtected && army && (army.generals ?? 0) >= 1 && (army.soldiers ?? 0) >= 120 && rng.random() < 0.2) {
      return {
        action: "attack_conventional",
        target: pickRivalOpponent(rivalAttackTargets),
        reasoning: "Strike after intelligence",
      };
    }
    if (govPlanets < 3 && credits >= PC.GOVERNMENT.baseCost) return { action: "buy_planet", type: "GOVERNMENT", reasoning: "House covert agents" };
    if (army && army.covertAgents < govPlanets * 200 && credits >= UC.COVERT_AGENT * 3) return { action: "buy_covert_agents", amount: Math.min(3, Math.floor(credits / UC.COVERT_AGENT)), reasoning: "Expand spy network" };
    if (credits >= UC.SOLDIER * 20 && army && army.soldiers < 150) return { action: "buy_soldiers", amount: Math.min(20, Math.floor(credits / UC.SOLDIER)), reasoning: "Need ground troops" };
    if (foodPlanets < 3 && credits >= PC.FOOD.baseCost) return { action: "buy_planet", type: "FOOD", reasoning: "Feed empire" };
    if (credits >= PC.URBAN.baseCost) return { action: "buy_planet", type: "URBAN", reasoning: "Grow population" };
    return { action: "end_turn", reasoning: "Planning operations" };
  }

  // Economist / diplomat / default
  if (totalPlanets < 15) {
    const needs: [boolean, string][] = [
      [foodPlanets < totalPlanets * 0.2, "FOOD"],
      [urbanPlanets < 4, "URBAN"],
      [orePlanets < 3, "ORE"],
      [!pCount["TOURISM"], "TOURISM"],
      [(pCount["PETROLEUM"] ?? 0) < 2, "PETROLEUM"],
    ];
    const need = needs.find(([flag]) => flag);
    if (need) {
      const cost = PC[need[1] as keyof typeof PC]?.baseCost ?? 14000;
      if (credits >= cost) return { action: "buy_planet", type: need[1], reasoning: `Expand: need ${need[1]}` };
    }
    if (credits >= PC.TOURISM.baseCost) return { action: "buy_planet", type: "TOURISM", reasoning: "More tourism income" };
  }

  if (army && army.soldiers < 100 && credits >= UC.SOLDIER * 15) {
    return { action: "buy_soldiers", amount: Math.min(15, Math.floor(credits / UC.SOLDIER)), reasoning: "Minimum defense" };
  }
  if (army && army.fighters < 30 && credits >= UC.FIGHTER * 10) {
    return { action: "buy_fighters", amount: Math.min(10, Math.floor(credits / UC.FIGHTER)), reasoning: "Fleet defense" };
  }

  if (credits >= 50000) return { action: "buy_bond", amount: Math.min(credits - 10000, 50000), reasoning: "Invest surplus" };
  return { action: "end_turn", reasoning: "Conserving resources" };
}
