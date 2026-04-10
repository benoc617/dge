import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireGame } from "@dge/engine/registry";
import { runAISequence } from "@/lib/ai-runner";
import "@/lib/game-bootstrap";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gameSessionId: string | undefined = body.gameSessionId;

  if (!gameSessionId) {
    return NextResponse.json({ error: "gameSessionId required" }, { status: 400 });
  }

  // Use game-specific runAiSequence when available (e.g. Gin Rummy, Chess use
  // their own AI logic and don't have empire rows — SRX runOneAI bails early).
  const sess = await prisma.gameSession.findUnique({
    where: { id: gameSessionId },
  }) as { gameType?: string | null } | null;
  const gameType = sess?.gameType ?? "srx";

  try {
    const { definition } = requireGame(gameType);
    if (definition.runAiSequence) {
      await definition.runAiSequence(gameSessionId);
      return NextResponse.json({ results: [] });
    }
  } catch {
    // unknown game type — fall through to SRX runner
  }

  const results = await runAISequence(gameSessionId);
  return NextResponse.json({ results });
}
