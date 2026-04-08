import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";

const url = new URL(process.env.DATABASE_URL!);
const prisma = new PrismaClient({
  adapter: new PrismaMariaDb({
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  }),
});

/** Mirrors leaderboard Mil column */
function leaderboardMil(a: {
  soldiers: number;
  fighters: number;
  lightCruisers: number;
  heavyCruisers: number;
}) {
  return a.soldiers + a.fighters * 2 + a.lightCruisers * 4 + a.heavyCruisers * 10;
}

/** Mirrors combat.ts calcFrontStrength for ground (no RNG) */
function groundStrengthBase(a: {
  soldiers: number;
  fighters: number;
  defenseStations: number;
  lightCruisers: number;
  heavyCruisers: number;
  effectiveness: number;
  soldiersLevel: number;
  fightersLevel: number;
  stationsLevel: number;
  lightCruisersLevel: number;
  heavyCruisersLevel: number;
}): number {
  const tier = (u: string, lv: number) => Math.min(lv, 2);
  const g = (type: string, count: number, lv: number, tiers: number[]) =>
    count * (tiers[tier(type, lv)] ?? 0);

  let str = 0;
  str += g("s", a.soldiers, a.soldiersLevel, [1.0, 1.0, 2.0]);
  str += g("f", a.fighters, a.fightersLevel, [0.5, 0.5, 0.5]);
  str += g("st", a.defenseStations, a.stationsLevel, [0.5, 0.5, 1.0]);
  str += g("lc", a.lightCruisers, a.lightCruisersLevel, [0, 0.1, 0.2]);
  str += g("hc", a.heavyCruisers, a.heavyCruisersLevel, [0, 0, 0.5]);
  str *= a.effectiveness / 100;
  return str;
}

async function main() {
  const names = ["Banedon 1", "Shadow Nyx"];
  for (const name of names) {
    const p = await prisma.player.findFirst({
      where: { name },
      include: { empire: { include: { army: true } } },
    });
    if (!p?.empire?.army) {
      console.log(name, "NOT FOUND");
      continue;
    }
    const a = p.empire.army;
    const mil = leaderboardMil(a);
    const gAtt = groundStrengthBase(a);
    const gDef = gAtt * 1.5; // defender bonus applied to defender in combat

    console.log(`\n=== ${name} ===`);
    console.log(
      `Leaderboard Mil: ${mil}  (soldiers + fighters×2 + LC×4 + HC×10; ignores stations, carriers, gens)`,
    );
    console.log(
      `Units: soldiers=${a.soldiers} fighters=${a.fighters} stations=${a.defenseStations} LC=${a.lightCruisers} HC=${a.heavyCruisers} eff=${a.effectiveness}%`,
    );
    console.log(
      `Approx ground strength (no RNG, before defense bonus): ${gAtt.toFixed(1)}  (HC/LC barely count on ground)`,
    );
  }

  const atk = await prisma.player.findFirst({
    where: { name: "Banedon 1" },
    include: { empire: { include: { army: true } } },
  });
  const def = await prisma.player.findFirst({
    where: { name: "Shadow Nyx" },
    include: { empire: { include: { army: true } } },
  });
  if (atk?.empire?.army && def?.empire?.army) {
    const A = atk.empire.army;
    const D = def.empire.army;
    const atkG = groundStrengthBase(A);
    const defG = groundStrengthBase(D) * 1.5;
    console.log("\n--- Conventional GROUND front (rough, no RNG) ---");
    console.log(`Banedon attacks: attacker ground ~${atkG.toFixed(1)} vs defender×1.5 ~${defG.toFixed(1)}`);
    console.log(
      `If atkG < defG, defender wins rounds → you get repelled at ground (matches your logs).`,
    );
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
