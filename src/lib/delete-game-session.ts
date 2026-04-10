import { prisma } from "./prisma";

/**
 * Permanently remove a game session and all players/empires in it (turn logs, messages,
 * loans/bonds, treaties, convoys, coalition membership). Safe for empty admin-staged lobbies.
 */
export async function deleteGameSession(sessionId: string): Promise<boolean> {
  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
    include: { players: { select: { id: true } } },
  });
  if (!session) return false;

  const playerIds = session.players.map((p) => p.id);

  // HighScore rows are keyed by playerName (no FK), so fetch names before we delete players.
  const playerNames =
    playerIds.length > 0
      ? (
          await prisma.player.findMany({
            where: { id: { in: playerIds } },
            select: { name: true },
          })
        ).map((p) => p.name)
      : [];

  const empires =
    playerIds.length > 0
      ? await prisma.empire.findMany({
          where: { playerId: { in: playerIds } },
          select: { id: true },
        })
      : [];
  const empireIds = empires.map((e) => e.id);

  await prisma.$transaction(async (tx) => {
    await tx.aiTurnJob.deleteMany({ where: { sessionId } });
    await tx.sessionLock.deleteMany({ where: { sessionId } });
    await tx.gameEvent.deleteMany({ where: { gameSessionId: sessionId } });
    if (playerNames.length > 0) {
      await tx.highScore.deleteMany({ where: { playerName: { in: playerNames } } });
    }

    if (playerIds.length === 0) {
      await tx.gameSession.delete({ where: { id: sessionId } });
      return;
    }

    await tx.turnLog.deleteMany({ where: { playerId: { in: playerIds } } });
    await tx.message.deleteMany({
      where: {
        OR: [
          { fromPlayerId: { in: playerIds } },
          { toPlayerId: { in: playerIds } },
        ],
      },
    });

    if (empireIds.length > 0) {
      await tx.loan.deleteMany({ where: { empireId: { in: empireIds } } });
      await tx.bond.deleteMany({ where: { empireId: { in: empireIds } } });
      await tx.treaty.deleteMany({
        where: {
          OR: [
            { fromEmpireId: { in: empireIds } },
            { toEmpireId: { in: empireIds } },
          ],
        },
      });
      await tx.convoy.deleteMany({
        where: {
          OR: [
            { fromEmpireId: { in: empireIds } },
            { toEmpireId: { in: empireIds } },
          ],
        },
      });

      const coalitions = await tx.coalition.findMany();
      for (const c of coalitions) {
        const memberIds = c.memberIds as string[];
        const touches =
          empireIds.includes(c.leaderId) || memberIds.some((id) => empireIds.includes(id));
        if (!touches) continue;

        const newMembers = memberIds.filter((id) => !empireIds.includes(id));
        if (newMembers.length === 0) {
          await tx.coalition.delete({ where: { id: c.id } });
          continue;
        }
        let leaderId = c.leaderId;
        if (empireIds.includes(leaderId)) leaderId = newMembers[0]!;
        await tx.coalition.update({
          where: { id: c.id },
          data: { leaderId, memberIds: newMembers },
        });
      }
    }

    await tx.empire.deleteMany({ where: { playerId: { in: playerIds } } });
    await tx.player.deleteMany({ where: { gameSessionId: sessionId } });
    await tx.gameSession.delete({ where: { id: sessionId } });
  });

  return true;
}
