import { NextRequest, NextResponse } from "next/server";
import { createAIPlayersForSession, createRandomAIPlayersForSession } from "@/lib/create-ai-players";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const requestedNames: string[] | undefined = body.names;
  const count: number = Math.min(5, Math.max(1, Number(body.count ?? 3)));
  const gameSessionId: string | undefined = body.gameSessionId;

  if (!gameSessionId) {
    return NextResponse.json({ error: "gameSessionId required" }, { status: 400 });
  }

  // If specific names are requested (e.g. E2E tests or admin), use them with random personas.
  // Otherwise, pick random names + random strategies for `count` AIs.
  const { created } = requestedNames?.length
    ? await createAIPlayersForSession(gameSessionId, requestedNames)
    : await createRandomAIPlayersForSession(gameSessionId, count);

  return NextResponse.json({ created, message: `Created ${created.length} AI players.` });
}
