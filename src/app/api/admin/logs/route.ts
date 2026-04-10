import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { dumpAndPurgeSessionLogs } from "@/lib/session-log-export";

/**
 * GET /api/admin/logs
 * Returns all game sessions with their TurnLog + GameEvent row counts.
 * Identifies which sessions are still active (have players with turnsLeft > 0).
 */
export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const sessions = await prisma.gameSession.findMany({
    select: {
      id: true,
      galaxyName: true,
      startedAt: true,
      status: true,
      players: { select: { id: true } },
      _count: { select: { gameEvents: true } },
    },
    orderBy: { startedAt: "desc" },
  });

  const result = await Promise.all(
    sessions.map(async (sess) => {
      const playerIds = sess.players.map((p) => p.id);
      const turnLogCount = playerIds.length > 0
        ? await prisma.turnLog.count({ where: { playerId: { in: playerIds } } })
        : 0;
      return {
        id: sess.id,
        galaxyName: sess.galaxyName ?? "(unnamed)",
        createdAt: sess.startedAt,
        turnLogCount,
        gameEventCount: sess._count.gameEvents,
        // Use session.status (not empire.turnsLeft) so non-SRX games show correctly.
        isActive: sess.status === "active",
      };
    }),
  );

  return NextResponse.json({ sessions: result });
}

/**
 * DELETE /api/admin/logs
 * Body: { sessionId: string, force?: boolean }
 * Dumps all TurnLog + GameEvent for the session to stdout, then deletes them.
 * Refuses to purge active sessions unless force=true.
 */
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const force = body.force === true;

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    select: { id: true, galaxyName: true, players: { select: { id: true } } },
  });
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (!force) {
    // Use session.status (not empire.turnsLeft) so non-SRX games are guarded correctly.
    const activeSession = await prisma.gameSession.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    if (activeSession?.status === "active") {
      return NextResponse.json(
        { error: "Session is still active. Pass force=true to purge anyway." },
        { status: 409 },
      );
    }
  }

  const counts = await dumpAndPurgeSessionLogs(sessionId);
  return NextResponse.json({ ok: true, ...counts });
}
