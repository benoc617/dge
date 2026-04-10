import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { AUTH } from "@/lib/game-constants";
import { validatePasswordStrength } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const accounts = await prisma.userAccount.findMany({
    orderBy: { username: "asc" },
    include: {
      players: {
        where: { isAI: false },
        include: {
          empire: { select: { turnsLeft: true } },
          gameSession: { select: { id: true, galaxyName: true, status: true } },
        },
      },
    },
  });

  const users = accounts.map((a) => {
    let activeGames = 0;
    let finishedGames = 0;
    const activeSummaries: {
      sessionId: string;
      galaxyName: string | null;
      playerName: string;
      turnsLeft: number;
    }[] = [];

    for (const p of a.players) {
      const sess = p.gameSession;
      const turnsLeft = p.empire?.turnsLeft ?? 0;
      // Use session.status as the canonical active indicator so non-SRX games
      // (Gin Rummy, Chess — no empire row) show up correctly.
      const isActiveGame = sess?.status === "active";
      if (isActiveGame) {
        activeGames++;
        if (activeSummaries.length < 8) {
          activeSummaries.push({
            sessionId: sess!.id,
            galaxyName: sess!.galaxyName,
            playerName: p.name,
            turnsLeft,
          });
        }
      } else {
        finishedGames++;
      }
    }

    const sessionIds = new Set(
      a.players.map((p) => p.gameSessionId).filter((id): id is string => id != null),
    );

    return {
      id: a.id,
      username: a.username,
      fullName: a.fullName,
      email: a.email,
      createdAt: a.createdAt.toISOString(),
      lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
      activeGames,
      finishedGames,
      sessionsJoined: sessionIds.size,
      activeSummaries,
    };
  });

  return NextResponse.json({ users });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json();
  const userId = typeof body.userId === "string" ? body.userId : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!userId) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }
  const pwErr = validatePasswordStrength(newPassword);
  if (pwErr) {
    return NextResponse.json({ error: pwErr }, { status: 400 });
  }

  const exists = await prisma.userAccount.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { BCRYPT_ROUNDS } = await import("@/lib/admin-auth");
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.$transaction(async (tx) => {
    await tx.userAccount.update({
      where: { id: userId },
      data: { passwordHash },
    });
    await tx.player.updateMany({
      where: { userId },
      data: { passwordHash },
    });
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const userId = req.nextUrl.searchParams.get("id");
  if (!userId) {
    return NextResponse.json({ error: "Query id is required" }, { status: 400 });
  }

  try {
    await prisma.userAccount.delete({ where: { id: userId } });
  } catch {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
