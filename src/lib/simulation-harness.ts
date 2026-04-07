/**
 * Full-game strategy simulations inside a real `GameSession`: sequential or simultaneous (door-game).
 * Uses the same `processAction` / door-game paths as HTTP routes.
 */

import { randomBytes } from "crypto";
import { prisma } from "./prisma";
import { processAction } from "./game-engine";
import { getCurrentTurn, advanceTurn } from "./turn-order";
import {
  openFullTurn,
  closeFullTurn,
  doorGameAutoCloseFullTurnAfterAction,
  tryRollRound,
  canPlayerAct,
  doorActionOpts,
  doorEndTurnOpts,
} from "./door-game-turns";
import { processAiMoveOrSkip } from "./ai-process-move";
import { deleteGameSession } from "./delete-game-session";
import {
  pickSimAction,
  strategyContextFromEmpire,
  finalizeSimSummaries,
  DEFAULT_SIM_STRATEGIES,
  type SimStrategy,
  type SimConfig,
  type SimResult,
  type TurnSnapshot,
} from "./simulation";
import { generatePlanetName, START } from "./game-constants";
import * as rng from "./rng";
import { setSeed } from "./rng";
import type { PlanetType } from "@prisma/client";
import type { PrismaEmpireShape } from "./sim-state";

export type SessionSimTurnMode = "sequential" | "simultaneous";

export interface SessionSimConfig extends SimConfig {
  turnMode: SessionSimTurnMode;
  /** Door-game: full turns per empire per calendar day (default 1). */
  actionsPerDay?: number;
}

export interface HarnessPlayer {
  empireId: string;
  playerId: string;
  name: string;
  strategy: SimStrategy;
  turnOrder: number;
}

/** Strategy phase index: 0 before first action for this empire, then +1 per full turn consumed. */
export function phaseTurnForStrategy(totalTurns: number, turnsLeft: number): number {
  return totalTurns - turnsLeft;
}

/** Fetch rival empire snapshots for PvP targeting context. */
async function fetchRivals(
  sessionId: string,
  ownEmpireId: string,
): Promise<{ name: string; netWorth: number; isProtected: boolean; credits: number }[]> {
  const players = await prisma.player.findMany({
    where: { gameSessionId: sessionId },
    include: {
      empire: {
        select: { id: true, netWorth: true, isProtected: true, protectionTurns: true, turnsLeft: true, credits: true },
      },
    },
  });
  return players
    .filter((p) => p.empire && p.empire.id !== ownEmpireId && p.empire.turnsLeft > 0)
    .map((p) => ({
      name: p.name,
      netWorth: p.empire!.netWorth,
      isProtected: p.empire!.isProtected && p.empire!.protectionTurns > 0,
      credits: p.empire!.credits,
    }));
}

/** Fetch full rival empire shapes for search strategies (mcts/maxn). */
async function fetchRivalShapes(
  sessionId: string,
  ownEmpireId: string,
): Promise<PrismaEmpireShape[]> {
  const players = await prisma.player.findMany({
    where: { gameSessionId: sessionId },
    include: {
      empire: { include: { planets: true, army: true, research: true, supplyRates: true } },
    },
  });
  return players
    .filter((p) => p.empire && p.empire.id !== ownEmpireId && p.empire.turnsLeft > 0)
    .map((p) => ({ ...(p.empire as PrismaEmpireShape), player: { name: p.name } }));
}

async function createSessionAndPlayers(config: SessionSimConfig): Promise<{
  sessionId: string;
  galaxyName: string;
  players: HarnessPlayer[];
}> {
  const strategies = config.strategies ?? DEFAULT_SIM_STRATEGIES.slice(0, config.playerCount);
  const galaxyName = `sim_${randomBytes(10).toString("hex")}`;
  const inviteCode = randomBytes(4).toString("hex").toUpperCase();
  const now = new Date();
  const simultaneous = config.turnMode === "simultaneous";
  const apd = config.actionsPerDay ?? 1;

  const session = await prisma.gameSession.create({
    data: {
      galaxyName,
      inviteCode,
      playerNames: [],
      totalTurns: config.turns,
      turnTimeoutSecs: 86400,
      waitingForHuman: false,
      turnStartedAt: now,
      turnMode: simultaneous ? "simultaneous" : "sequential",
      actionsPerDay: apd,
      dayNumber: 1,
      roundStartedAt: simultaneous ? now : null,
      isPublic: false,
      maxPlayers: Math.max(8, config.playerCount),
    },
  });

  const harnessPlayers: HarnessPlayer[] = [];

  for (let i = 0; i < config.playerCount; i++) {
    const strategy = strategies[i % strategies.length]!;
    const name = `SimSess_${strategy}_${i}`;
    const planetCreateData = START.PLANETS.flatMap((spec) =>
      Array.from({ length: spec.count }, () => ({
        name: generatePlanetName(),
        sector: rng.randomInt(1, 100),
        type: spec.type as PlanetType,
        longTermProduction: 100,
        shortTermProduction: 100,
      })),
    );

    const player = await prisma.player.create({
      data: {
        name,
        isAI: true,
        gameSessionId: session.id,
        turnOrder: i,
        empire: {
          create: {
            credits: START.CREDITS,
            food: START.FOOD,
            ore: START.ORE,
            fuel: START.FUEL,
            population: START.POPULATION,
            taxRate: START.TAX_RATE,
            turnsLeft: config.turns,
            protectionTurns: START.PROTECTION_TURNS,
            planets: { create: planetCreateData },
            army: {
              create: {
                soldiers: START.SOLDIERS,
                generals: START.GENERALS,
                fighters: START.FIGHTERS,
              },
            },
            supplyRates: { create: {} },
            research: { create: {} },
          },
        },
      },
      include: { empire: true },
    });

    if (!player.empire) throw new Error(`Harness: no empire for ${name}`);
    harnessPlayers.push({
      empireId: player.empire.id,
      playerId: player.id,
      name,
      strategy,
      turnOrder: i,
    });
  }

  const firstPlayerId = harnessPlayers[0]!.playerId;
  await prisma.gameSession.update({
    where: { id: session.id },
    data: {
      currentTurnPlayerId: simultaneous ? null : firstPlayerId,
      playerNames: harnessPlayers.map((p) => p.name),
    },
  });

  return { sessionId: session.id, galaxyName, players: harnessPlayers };
}

async function snapshotFromReport(
  snapTurn: number,
  playerName: string,
  empireId: string,
  action: string,
  report: { income?: { total?: number }; expenses?: { total?: number }; population?: { newTotal?: number; net?: number }; netWorth?: number; events?: string[] } | undefined,
): Promise<TurnSnapshot> {
  const empire = await prisma.empire.findUnique({
    where: { id: empireId },
    include: { planets: true, army: true },
  });
  if (!empire?.army) {
    return {
      turn: snapTurn,
      playerName,
      credits: 0,
      food: 0,
      ore: 0,
      fuel: 0,
      population: 0,
      netWorth: 0,
      totalPlanets: 0,
      soldiers: 0,
      fighters: 0,
      lightCruisers: 0,
      heavyCruisers: 0,
      civilStatus: 0,
      action,
      income: 0,
      expenses: 0,
      popNet: 0,
      events: [],
    };
  }
  return {
    turn: snapTurn,
    playerName,
    credits: empire.credits,
    food: empire.food,
    ore: empire.ore,
    fuel: empire.fuel,
    population: report?.population?.newTotal ?? empire.population,
    netWorth: report?.netWorth ?? empire.netWorth,
    totalPlanets: empire.planets.length,
    soldiers: empire.army.soldiers,
    fighters: empire.army.fighters,
    lightCruisers: empire.army.lightCruisers,
    heavyCruisers: empire.army.heavyCruisers,
    civilStatus: empire.civilStatus,
    action,
    income: report?.income?.total ?? 0,
    expenses: report?.expenses?.total ?? 0,
    popNet: report?.population?.net ?? 0,
    events: report?.events ?? [],
  };
}

/**
 * Run strategy bots through a real `GameSession` (sequential or simultaneous).
 * Deletes the session and all players after summaries are computed.
 */
export async function runSessionSimulation(config: SessionSimConfig): Promise<SimResult> {
  const startTime = Date.now();
  setSeed(config.seed);

  const marketCount = await prisma.market.count();
  if (marketCount === 0) await prisma.market.create({ data: {} });

  const { sessionId, galaxyName, players } = await createSessionAndPlayers(config);
  const snapshots: TurnSnapshot[] = [];
  let snapTurn = 0;

  const playerRows = players.map((p) => ({
    id: p.empireId,
    playerId: p.playerId,
    name: p.name,
    strategy: p.strategy,
  }));

  try {
    if (config.turnMode === "sequential") {
      const maxSteps = config.turns * config.playerCount * 3;
      let guard = 0;
      while (guard++ < maxSteps) {
        const alive = await prisma.player.count({
          where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
        });
        if (alive === 0) break;

        const turnInfo = await getCurrentTurn(sessionId);
        if (!turnInfo) break;

        const hp = players.find((h) => h.playerId === turnInfo.currentPlayerId);
        if (!hp) break;

        const empire = await prisma.empire.findUnique({
          where: { id: hp.empireId },
          include: { planets: true, army: true, research: true, supplyRates: true },
        });
        if (!empire?.army || empire.turnsLeft < 1) {
          await advanceTurn(sessionId);
          continue;
        }

        if (empire.population < 10) {
          const out = await processAiMoveOrSkip(
            hp.playerId,
            "end_turn",
            {},
            { aiReasoning: "(session sim)" },
            undefined,
          );
          if (out.finalResult.success) await advanceTurn(sessionId);
          continue;
        }

        const isSearchStrategy = hp.strategy === "mcts" || hp.strategy === "maxn";
        const [loans, rivals, rivalShapes] = await Promise.all([
          prisma.loan.findMany({ where: { empireId: empire.id }, select: { id: true, balance: true } }),
          fetchRivals(sessionId, empire.id),
          isSearchStrategy ? fetchRivalShapes(sessionId, empire.id) : Promise.resolve(undefined),
        ]);
        const ctx = strategyContextFromEmpire(empire, loans, rivals);
        const phaseTurn = phaseTurnForStrategy(config.turns, empire.turnsLeft);
        const { action, params } = pickSimAction(
          hp.strategy,
          ctx,
          phaseTurn,
          isSearchStrategy ? (empire as unknown as PrismaEmpireShape) : undefined,
          rivalShapes,
        );

        const out = await processAiMoveOrSkip(hp.playerId, action, params, { aiReasoning: "(session sim)" }, undefined);
        const report = out.finalResult.turnReport;
        snapshots.push(
          await snapshotFromReport(snapTurn++, hp.name, hp.empireId, action, report),
        );

        if (out.finalResult.success) {
          await advanceTurn(sessionId);
        }
      }
    } else {
      let guard = 0;
      while (guard++ < 5_000_000) {
        await tryRollRound(sessionId, { scheduleAiDrain: false });

        const anyLeft = await prisma.player.findFirst({
          where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
        });
        if (!anyLeft) break;

        const session = await prisma.gameSession.findUnique({
          where: { id: sessionId },
          include: {
            players: { orderBy: { turnOrder: "asc" }, include: { empire: true } },
          },
        });
        if (!session) break;

        let acted = false;
        for (const pl of session.players) {
          if (!pl.empire || pl.empire.turnsLeft < 1) continue;
          if (!canPlayerAct(pl.empire, session.actionsPerDay)) continue;

          const hp = players.find((h) => h.playerId === pl.id);
          if (!hp) continue;

          if (!pl.empire.turnOpen) {
            await openFullTurn(pl.id);
          }

          const empire = await prisma.empire.findUnique({
            where: { id: pl.empire!.id },
            include: { planets: true, army: true, research: true, supplyRates: true },
          });
          if (!empire?.army) continue;

          if (empire.population < 10) {
            await processAction(pl.id, "end_turn", undefined, doorEndTurnOpts);
            await closeFullTurn(pl.id, sessionId, { scheduleAiDrain: false });
            snapshots.push(
              await snapshotFromReport(snapTurn++, hp.name, hp.empireId, "end_turn", undefined),
            );
            acted = true;
            break;
          }

          const isSearchStrategy = hp.strategy === "mcts" || hp.strategy === "maxn";
          const [loans, rivals, rivalShapes] = await Promise.all([
            prisma.loan.findMany({ where: { empireId: empire.id }, select: { id: true, balance: true } }),
            fetchRivals(sessionId, empire.id),
            isSearchStrategy ? fetchRivalShapes(sessionId, empire.id) : Promise.resolve(undefined),
          ]);
          const ctx = strategyContextFromEmpire(empire, loans, rivals);
          const phaseTurn = phaseTurnForStrategy(config.turns, empire.turnsLeft);
          const { action, params } = pickSimAction(
            hp.strategy,
            ctx,
            phaseTurn,
            isSearchStrategy ? (empire as unknown as PrismaEmpireShape) : undefined,
            rivalShapes,
          );

          if (action === "end_turn") {
            const r = await processAction(pl.id, "end_turn", undefined, doorEndTurnOpts);
            await closeFullTurn(pl.id, sessionId, { scheduleAiDrain: false });
            snapshots.push(
              await snapshotFromReport(snapTurn++, hp.name, hp.empireId, "end_turn", r.turnReport),
            );
            acted = true;
            break;
          }

          const out = await processAiMoveOrSkip(
            pl.id,
            action,
            params,
            { aiReasoning: "(session sim)" },
            doorActionOpts,
          );

          if (out.skipped && out.finalResult.success) {
            await closeFullTurn(pl.id, sessionId, { scheduleAiDrain: false });
            snapshots.push(
              await snapshotFromReport(
                snapTurn++,
                hp.name,
                hp.empireId,
                action,
                out.finalResult.turnReport,
              ),
            );
          } else if (!out.skipped && out.finalResult.success) {
            await doorGameAutoCloseFullTurnAfterAction(pl.id, sessionId, { scheduleAiDrain: false });
            snapshots.push(
              await snapshotFromReport(
                snapTurn++,
                hp.name,
                hp.empireId,
                action,
                out.finalResult.turnReport,
              ),
            );
          } else if (out.skipped && !out.finalResult.success) {
            await processAction(pl.id, "end_turn", undefined, doorEndTurnOpts);
            await closeFullTurn(pl.id, sessionId, { scheduleAiDrain: false });
            snapshots.push(
              await snapshotFromReport(snapTurn++, hp.name, hp.empireId, "end_turn", out.finalResult.turnReport),
            );
          }
          acted = true;
          break;
        }

        if (!acted) {
          const still = await prisma.player.findFirst({
            where: { gameSessionId: sessionId, empire: { turnsLeft: { gt: 0 } } },
          });
          if (!still) break;
        }
      }
    }
  } catch (err) {
    await deleteGameSession(sessionId).catch(() => {});
    throw err;
  }

  const balanceWarnings: string[] = [];
  let summary: Awaited<ReturnType<typeof finalizeSimSummaries>>["summary"];
  let bw: string[];
  try {
    const fin = await finalizeSimSummaries(config, snapshots, playerRows);
    summary = fin.summary;
    bw = fin.balanceWarnings;
  } finally {
    await deleteGameSession(sessionId).catch(() => {});
  }
  balanceWarnings.push(...bw);

  return {
    config: {
      ...config,
      turnMode: config.turnMode,
      actionsPerDay: config.actionsPerDay,
    },
    snapshots,
    summary,
    balanceWarnings,
    elapsedMs: Date.now() - startTime,
    sessionMeta: {
      sessionId,
      turnMode: config.turnMode,
      galaxyName,
    },
  };
}
