# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server at localhost:3000
npm run build      # Production build
npm run lint       # ESLint

npx prisma migrate dev --name <migration_name>   # Create and apply a migration
npx prisma studio                                # GUI to inspect the database
npx prisma generate                              # Regenerate Prisma client after schema changes
```

There are no tests yet.

## Environment

Requires a `.env` file (not committed) with:
```
DATABASE_URL="postgresql://..."
GEMINI_API_KEY="..."
```

## Architecture

This is a turn-based space strategy game (BBS-era Solar Realms Elite remake) built with Next.js App Router.

**Data flow for a player action:**
1. UI (`src/app/page.tsx`) calls `POST /api/game/action`
2. Route handler (`src/app/api/game/action/route.ts`) looks up the player and delegates to `src/lib/game-engine.ts`
3. `game-engine.ts` mutates empire state via Prisma and writes to `TurnLog`
4. UI refreshes by calling `GET /api/game/status`

**AI NPC turn flow:**
1. Caller hits `POST /api/ai/turn` with an AI player's name
2. Route fetches empire state + recent `GameEvent` records and passes them to `src/lib/gemini.ts`
3. Gemini returns a structured JSON action decision
4. The same `processAction()` in `game-engine.ts` executes it, then a `GameEvent` is recorded

**Key lib files:**
- `src/lib/game-engine.ts` — all game logic lives here: `processAction(playerId, action, params)` is the single entry point for any empire mutation. Adding new action types means extending the `ActionType` union and the switch statement here.
- `src/lib/gemini.ts` — Gemini 1.5 Flash prompt construction and JSON response parsing. The AI persona string stored on each `Player.aiPersona` is injected into the prompt.
- `src/lib/prisma.ts` — singleton Prisma client (standard Next.js pattern to avoid exhausting connections in dev).

**Database schema highlights (`prisma/schema.prisma`):**
- `Player` → `Empire` is 1:1; `Empire` → `Planet[]` is 1:many
- AI players are distinguished by `Player.isAI = true` and have a `Player.aiPersona` prompt string
- `TurnLog` records every action taken (player or AI) for history/auditing
- `GameEvent` is a broadcast log used to give AI players context about recent world events

## Repository

- GitHub repo: https://github.com/benoc617/solar-realms-extreme
- GitHub account: `benoc617` (use this account for all repo operations)
- The `GITHUB_TOKEN` env var in `.zshrc` points to a different account (`boconnor_axoncorp`) and will override `gh` account switching if set — unset it before running `gh` commands: `unset GITHUB_TOKEN && gh ...`

**UI structure:**
- Single-page app in `src/app/page.tsx` with three panels rendered client-side: `EmpirePanel`, `ActionPanel`, `EventLog`
- All components are in `src/components/` and are `"use client"`
- Styling follows a monochrome terminal/BBS aesthetic: black background, green-400 text, yellow-400 accents
