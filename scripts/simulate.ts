#!/usr/bin/env npx tsx
/**
 * SRX Game Simulation CLI
 *
 * Run a full game simulation at speed for testing and balance iteration.
 *
 * Usage:
 *   npx tsx scripts/simulate.ts [options]
 *
 * Options:
 *   --turns N         Number of turns per player (default: 50)
 *   --players N       Number of simulated players (default: 3)
 *   --seed N          RNG seed for reproducibility (default: random)
 *   --verbosity N     0=silent, 1=summary, 2=per-turn, 3=verbose (default: 1)
 *   --csv FILE        Export snapshots to CSV file
 *   --strategies S    Comma-separated: balanced,economy_rush,military_rush,turtle,random,research_rush,credit_leverage,growth_focus
 *   --reset           DESTRUCTIVE: wipe ALL game data (sessions, players, scores) before simulation
 *   --repeat N        Run N simulations (with incrementing seeds)
 *   --session MODE    Full game: sequential | simultaneous (real GameSession + turn/door paths)
 *   --apd N           With --session simultaneous: actions per calendar day (default 1)
 *
 * Examples:
 *   npx tsx scripts/simulate.ts --turns 100 --players 5 --seed 42
 *   npx tsx scripts/simulate.ts --turns 50 --verbosity 2 --csv sim_output.csv
 *   npx tsx scripts/simulate.ts --repeat 10 --seed 1 --turns 100  # runs seeds 1-10
 */

import "dotenv/config";
import {
  runSimulation,
  printSimReport,
  snapshotsToCSV,
  type SimStrategy,
  type SimResult,
  type TurnSnapshot,
} from "../src/lib/simulation";
import { runSessionSimulation, type SessionSimTurnMode } from "../src/lib/simulation-harness";
import { prisma } from "../src/lib/prisma";
import * as fs from "fs";

function parseArgs(): {
  turns: number;
  players: number;
  seed: number | null;
  verbosity: number;
  csv: string | null;
  strategies: SimStrategy[] | undefined;
  reset: boolean;
  repeat: number;
  sessionMode: SessionSimTurnMode | null;
  actionsPerDay: number | undefined;
} {
  const args = process.argv.slice(2);
  const opts = {
    turns: 50,
    players: 3,
    seed: null as number | null,
    verbosity: 1,
    csv: null as string | null,
    strategies: undefined as SimStrategy[] | undefined,
    reset: false,
    repeat: 1,
    sessionMode: null as SessionSimTurnMode | null,
    actionsPerDay: undefined as number | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--turns":
        opts.turns = parseInt(args[++i]);
        break;
      case "--players":
        opts.players = parseInt(args[++i]);
        break;
      case "--seed":
        opts.seed = parseInt(args[++i]);
        break;
      case "--verbosity":
        opts.verbosity = parseInt(args[++i]);
        break;
      case "--csv":
        opts.csv = args[++i];
        break;
      case "--strategies":
        opts.strategies = args[++i].split(",") as SimStrategy[];
        break;
      case "--reset":
        opts.reset = true;
        break;
      case "--repeat":
        opts.repeat = parseInt(args[++i]);
        break;
      case "--session": {
        const m = args[++i] as string;
        if (m !== "sequential" && m !== "simultaneous") {
          console.error("--session must be sequential or simultaneous");
          process.exit(1);
        }
        opts.sessionMode = m;
        break;
      }
      case "--apd":
        opts.actionsPerDay = parseInt(args[++i]);
        break;
      case "--help":
      case "-h":
        console.log(`
SRX Game Simulation CLI

Usage: npx tsx scripts/simulate.ts [options]

Options:
  --turns N         Turns per player (default: 50)
  --players N       Number of players (default: 3)
  --seed N          RNG seed (default: random)
  --verbosity N     0=silent 1=summary 2=per-turn 3=verbose (default: 1)
  --csv FILE        Export to CSV
  --strategies S    Comma-separated (see header for full list)
  --reset           DESTRUCTIVE: wipe ALL game data first
  --repeat N        Run N simulations with incrementing seeds
  --session MODE    sequential | simultaneous (full session harness)
  --apd N           actions/day for simultaneous session (default 1)
`);
        process.exit(0);
    }
  }

  return opts;
}

/**
 * Full DB wipe — ALL game data including live sessions, players, empires, scores.
 * Only used with explicit `--reset` flag. Intentionally destructive.
 */
async function resetDatabase(): Promise<void> {
  console.log("Resetting database (full wipe — all sessions/players/empires)...");
  await prisma.turnLog.deleteMany();
  await prisma.gameEvent.deleteMany();
  await prisma.message.deleteMany();
  await prisma.convoy.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.bond.deleteMany();
  await prisma.treaty.deleteMany();
  await prisma.coalition.deleteMany();
  await prisma.research.deleteMany();
  await prisma.supplyRates.deleteMany();
  await prisma.army.deleteMany();
  await prisma.planet.deleteMany();
  await prisma.empire.deleteMany();
  await prisma.player.deleteMany();
  await prisma.gameSession.deleteMany();
  await prisma.highScore.deleteMany();
  await prisma.market.deleteMany();
  console.log("Database cleared.");
}

/**
 * Remove only simulation players (gameSessionId = null, name starts with "Sim_") and their
 * empires/logs. Leaves live game sessions, players, and scores intact.
 */
async function resetSimulationData(): Promise<void> {
  const simPlayers = await prisma.player.findMany({
    where: { gameSessionId: null, name: { startsWith: "Sim_" } },
    select: { id: true },
  });
  if (simPlayers.length === 0) return;

  const playerIds = simPlayers.map((p) => p.id);

  await prisma.turnLog.deleteMany({ where: { playerId: { in: playerIds } } });
  const simEmpires = await prisma.empire.findMany({
    where: { playerId: { in: playerIds } },
    select: { id: true },
  });
  const empireIds = simEmpires.map((e) => e.id);
  if (empireIds.length > 0) {
    await prisma.loan.deleteMany({ where: { empireId: { in: empireIds } } });
    await prisma.bond.deleteMany({ where: { empireId: { in: empireIds } } });
  }
  await prisma.empire.deleteMany({ where: { playerId: { in: playerIds } } });
  await prisma.player.deleteMany({ where: { id: { in: playerIds } } });
}

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.reset) {
    await resetDatabase();
  }

  const allResults: SimResult[] = [];

  for (let run = 0; run < opts.repeat; run++) {
    const seed = opts.seed !== null ? opts.seed + run : null;

    if (run > 0) {
      await resetSimulationData();
    }

    const verbosity = opts.repeat > 1 ? Math.min(opts.verbosity, 1) : opts.verbosity;

    const result: SimResult =
      opts.sessionMode != null
        ? await runSessionSimulation({
            turns: opts.turns,
            playerCount: opts.players,
            seed,
            verbosity,
            strategies: opts.strategies,
            turnMode: opts.sessionMode,
            actionsPerDay: opts.actionsPerDay,
          })
        : await runSimulation({
            turns: opts.turns,
            playerCount: opts.players,
            seed,
            verbosity,
            strategies: opts.strategies,
          });
    allResults.push(result);

    if (opts.repeat === 1) {
      printSimReport(result);
    } else {
      const winner = [...result.summary].sort((a, b) => b.finalNetWorth - a.finalNetWorth)[0];
      console.log(
        `Run ${run + 1}/${opts.repeat} (seed=${seed}): ` +
        `Winner: ${winner.name} (${winner.strategy}) NW=${winner.finalNetWorth} ` +
        `| ${result.balanceWarnings.length} warnings ` +
        `| ${(result.elapsedMs / 1000).toFixed(1)}s`,
      );
    }

    if (opts.csv && opts.repeat === 1) {
      fs.writeFileSync(opts.csv, snapshotsToCSV(result.snapshots));
      console.log(`CSV exported to ${opts.csv}`);
    }
  }

  // Aggregate report for repeat runs
  if (opts.repeat > 1) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  AGGREGATE REPORT (${opts.repeat} runs)`);
    console.log(`${"=".repeat(60)}`);

    const stratWins: Record<string, number> = {};
    const stratCollapses: Record<string, number> = {};
    const stratNW: Record<string, number[]> = {};
    let totalWarnings = 0;

    for (const r of allResults) {
      totalWarnings += r.balanceWarnings.length;
      const sorted = [...r.summary].sort((a, b) => b.finalNetWorth - a.finalNetWorth);
      const winnerStrat = sorted[0]?.strategy ?? "unknown";
      stratWins[winnerStrat] = (stratWins[winnerStrat] ?? 0) + 1;

      for (const s of r.summary) {
        if (!stratNW[s.strategy]) stratNW[s.strategy] = [];
        stratNW[s.strategy].push(s.finalNetWorth);
        if (s.collapsed) stratCollapses[s.strategy] = (stratCollapses[s.strategy] ?? 0) + 1;
      }
    }

    console.log(`\n  Win rates:`);
    const winSorted = Object.entries(stratWins).sort((a, b) => b[1] - a[1]);
    for (const [strat, wins] of winSorted) {
      console.log(`    ${strat.padEnd(16)} ${wins}/${opts.repeat} (${(wins / opts.repeat * 100).toFixed(0)}%)`);
    }
    const top = winSorted[0];
    if (top && opts.repeat >= 10 && top[1] / opts.repeat >= 0.5) {
      console.log(
        `\n  Balance note: "${top[0]}" won ${top[1]}/${opts.repeat} runs (≥50%) — possible dominant strategy.`,
      );
    }
    const avgs = Object.values(stratNW)
      .map((nws) => nws.reduce((a, b) => a + b, 0) / nws.length)
      .filter((a) => a > 0);
    if (avgs.length >= 2 && opts.repeat >= 5) {
      const maxAvg = Math.max(...avgs);
      const minAvg = Math.min(...avgs);
      if (maxAvg / minAvg > 3) {
        console.log(
          `  Balance note: mean final NW across strategies differs by ~${(maxAvg / minAvg).toFixed(1)}× — check for economic runaways.`,
        );
      }
    }

    console.log(`\n  Average final net worth:`);
    for (const [strat, nws] of Object.entries(stratNW)) {
      const avg = nws.reduce((a, b) => a + b, 0) / nws.length;
      const max = Math.max(...nws);
      const min = Math.min(...nws);
      console.log(`    ${strat.padEnd(16)} avg=${avg.toFixed(0).padStart(6)} min=${min.toString().padStart(6)} max=${max.toString().padStart(6)}`);
    }

    console.log(`\n  Collapse rates:`);
    for (const [strat, count] of Object.entries(stratCollapses)) {
      console.log(`    ${strat.padEnd(16)} ${count}/${opts.repeat}`);
    }

    console.log(`\n  Total balance warnings across all runs: ${totalWarnings}`);
    console.log(`  Total elapsed: ${(allResults.reduce((s, r) => s + r.elapsedMs, 0) / 1000).toFixed(1)}s`);
    console.log(`${"=".repeat(60)}\n`);

    if (opts.csv) {
      type SnapWithRun = TurnSnapshot & { run: number };
      const allSnaps: SnapWithRun[] = allResults.flatMap((r, i) =>
        r.snapshots.map((s) => ({ ...s, run: i })),
      );
      const headers = "run,turn,player,credits,food,ore,fuel,population,netWorth,totalPlanets,soldiers,fighters,civilStatus,action,income,expenses,popNet";
      const rows = allSnaps.map(
        (s) =>
          `${s.run},${s.turn},${s.playerName},${s.credits},${s.food},${s.ore},${s.fuel},${s.population},${s.netWorth},${s.totalPlanets},${s.soldiers},${s.fighters},${s.civilStatus},${s.action},${s.income},${s.expenses},${s.popNet}`,
      );
      fs.writeFileSync(opts.csv, [headers, ...rows].join("\n"));
      console.log(`CSV exported to ${opts.csv}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
