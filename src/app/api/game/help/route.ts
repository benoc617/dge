import { type NextRequest, NextResponse } from "next/server";
import { HELP_REGISTRY as SRX_HELP_REGISTRY } from "@dge/srx/help-content";
import { HELP_REGISTRY as CHESS_HELP_REGISTRY } from "@dge/chess/help-content";
import { HELP_REGISTRY as GINRUMMY_HELP_REGISTRY } from "@dge/ginrummy/help-content";

/**
 * GET /api/game/help?game=srx
 *
 * Returns help content (title + markdown body) for the specified game type.
 * Served from the pre-compiled TypeScript string in each game's help-content.ts —
 * no filesystem reads at runtime.
 */

const COMBINED_REGISTRY: Record<string, { title: string; content: string }> = {
  ...SRX_HELP_REGISTRY,
  ...CHESS_HELP_REGISTRY,
  ...GINRUMMY_HELP_REGISTRY,
};

export async function GET(req: NextRequest) {
  const game = req.nextUrl.searchParams.get("game") ?? "srx";
  const entry = COMBINED_REGISTRY[game];
  if (!entry) {
    return NextResponse.json({ error: `No help found for game: ${game}` }, { status: 404 });
  }
  return NextResponse.json({ title: entry.title, content: entry.content });
}
