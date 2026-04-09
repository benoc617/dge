import { type NextRequest, NextResponse } from "next/server";
import { HELP_REGISTRY as SRX_HELP_REGISTRY } from "@dge/srx/help-content";

/**
 * GET /api/game/help?game=srx
 *
 * Returns help content (title + markdown body) for the specified game type.
 * Served from the pre-compiled TypeScript string in each game's help-content.ts —
 * no filesystem reads at runtime.
 *
 * To add help for a new game, import its HELP_REGISTRY and spread it into COMBINED_REGISTRY.
 */

const COMBINED_REGISTRY: Record<string, { title: string; content: string }> = {
  ...SRX_HELP_REGISTRY,
  // Future games:
  // ...CHESS_HELP_REGISTRY,
};

export async function GET(req: NextRequest) {
  const game = req.nextUrl.searchParams.get("game") ?? "srx";
  const entry = COMBINED_REGISTRY[game];
  if (!entry) {
    return NextResponse.json({ error: `No help found for game: ${game}` }, { status: 404 });
  }
  return NextResponse.json({ title: entry.title, content: entry.content });
}
