#!/usr/bin/env npx tsx
/**
 * Repair simultaneous (door-game) empires stuck after a bad AI skip path
 * (end_turn logged but closeFullTurn never ran → turnOpen stuck true, tickProcessed false).
 * Does **not** match a normal "new full turn opened via /tick" state (tickProcessed true, last log still end_turn).
 *
 * Usage (DATABASE_URL required, e.g. from .env):
 *   npx tsx scripts/repair-door-game-session.ts --galaxy "Banedonia 2" --dry-run
 *   npx tsx scripts/repair-door-game-session.ts --galaxy "Banedonia 2" --apply
 *   npx tsx scripts/repair-door-game-session.ts --session <cuid> --apply --player "Admiral Koss"
 *
 * --dry-run   Print what would happen (default if neither --apply nor --dry-run)
 * --apply     Run closeFullTurn for detected orphans (or --player)
 * --player    Restrict to one commander name (requires --apply)
 * --force     With --player --apply: run closeFullTurn even if last log is not end_turn
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { closeFullTurn, isStuckDoorTurnAfterSkipEndLog } from "../src/lib/door-game-turns";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function findOrphans(sessionId: string): Promise<{ playerId: string; name: string }[]> {
  const players = await prisma.player.findMany({
    where: { gameSessionId: sessionId },
    include: { empire: true },
  });
  const orphans: { playerId: string; name: string }[] = [];
  for (const p of players) {
    const e = p.empire;
    if (!e?.turnOpen) continue;
    const last = await prisma.turnLog.findFirst({
      where: { playerId: p.id },
      orderBy: { createdAt: "desc" },
      select: { action: true },
    });
    if (isStuckDoorTurnAfterSkipEndLog(true, last?.action, e.tickProcessed ?? undefined)) {
      orphans.push({ playerId: p.id, name: p.name });
    }
  }
  return orphans;
}

async function main() {
  const galaxy = arg("--galaxy");
  const sessionIdArg = arg("--session");
  const playerFilter = arg("--player");
  const apply = hasFlag("--apply");
  const dryRun = hasFlag("--dry-run") || !apply;
  const force = hasFlag("--force");

  if (!galaxy && !sessionIdArg) {
    console.error("Provide --galaxy <name> or --session <cuid>");
    process.exit(1);
  }

  let sessionId = sessionIdArg;
  if (galaxy) {
    const s = await prisma.gameSession.findFirst({
      where: { galaxyName: galaxy },
      select: { id: true, turnMode: true, galaxyName: true },
    });
    if (!s) {
      console.error(`No session with galaxyName: ${galaxy}`);
      process.exit(1);
    }
    if (s.turnMode !== "simultaneous") {
      console.error(`Session ${s.galaxyName} is not simultaneous (turnMode=${s.turnMode})`);
      process.exit(1);
    }
    sessionId = s.id;
  }

  if (!sessionId) {
    console.error("Missing session id");
    process.exit(1);
  }

  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    select: { galaxyName: true, turnMode: true },
  });
  if (!session || session.turnMode !== "simultaneous") {
    console.error("Session not found or not simultaneous");
    process.exit(1);
  }

  console.log(`Session: ${session.galaxyName ?? sessionId} (${sessionId})`);

  if (playerFilter) {
    const p = await prisma.player.findFirst({
      where: { gameSessionId: sessionId, name: playerFilter },
      include: { empire: true },
    });
    if (!p?.empire) {
      console.error(`Player not found: ${playerFilter}`);
      process.exit(1);
    }
    if (!p.empire.turnOpen) {
      console.log(`${p.name}: turnOpen is false — nothing to repair.`);
      process.exit(0);
    }
    const last = await prisma.turnLog.findFirst({
      where: { playerId: p.id },
      orderBy: { createdAt: "desc" },
      select: { action: true },
    });
    if (last?.action !== "end_turn" && !force) {
      console.error(
        `${p.name}: last TurnLog action is "${last?.action ?? "none"}" (expected end_turn). Use --force to close anyway.`,
      );
      process.exit(1);
    }
    if (!force && !isStuckDoorTurnAfterSkipEndLog(true, last?.action, p.empire.tickProcessed ?? undefined)) {
      console.log(
        `${p.name}: not the stuck skip pattern (e.g. new full turn open after /tick with tickProcessed true) — nothing to repair. Use --force to close anyway.`,
      );
      process.exit(0);
    }
    if (dryRun) {
      console.log(`[dry-run] Would closeFullTurn for ${p.name} (${p.id})`);
      process.exit(0);
    }
    await closeFullTurn(p.id, sessionId);
    console.log(`OK: closeFullTurn for ${p.name}`);
    process.exit(0);
  }

  const orphans = await findOrphans(sessionId);
  if (orphans.length === 0) {
    console.log("No orphan door states found (turnOpen + last log end_turn + tickProcessed false).");
    process.exit(0);
  }

  for (const o of orphans) {
    console.log(`Orphan: ${o.name} (${o.playerId}) — last log end_turn, turnOpen true, tickProcessed false (closeFullTurn missing)`);
  }

  if (dryRun) {
    console.log("\n[dry-run] Pass --apply to run closeFullTurn for each orphan.");
    process.exit(0);
  }

  for (const o of orphans) {
    await closeFullTurn(o.playerId, sessionId);
    console.log(`OK: closeFullTurn for ${o.name}`);
  }

  console.log("Done. Consider running the app and polling status so runDoorGameAITurns can continue.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
