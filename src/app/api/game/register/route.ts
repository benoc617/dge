import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { name } = await req.json();

  if (!name || name.trim().length < 2) {
    return NextResponse.json({ error: "Name must be at least 2 characters" }, { status: 400 });
  }

  const existing = await prisma.player.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "Name already taken" }, { status: 409 });
  }

  const player = await prisma.player.create({
    data: {
      name,
      empire: {
        create: {
          planets: {
            create: {
              name: `${name} Prime`,
              sector: Math.floor(Math.random() * 100) + 1,
              population: 5000,
              ore: 200,
              food: 200,
            },
          },
        },
      },
    },
    include: { empire: { include: { planets: true } } },
  });

  return NextResponse.json(player, { status: 201 });
}
