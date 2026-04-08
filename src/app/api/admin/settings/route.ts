import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { maskGeminiApiKeyPreview } from "@/lib/system-settings";
import {
  DOOR_AI_ADMIN_LIMITS,
  getEffectiveDoorAiSettings,
  invalidateDoorAiRuntimeCache,
  parseAdminDoorAiInt,
} from "@/lib/door-ai-runtime-settings";

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const row = await prisma.systemSettings.findUnique({ where: { id: "default" } });
  const gem = maskGeminiApiKeyPreview(row?.geminiApiKey);

  const doorRow = row
    ? {
        doorAiDecideBatchSize: row.doorAiDecideBatchSize,
        geminiMaxConcurrent: row.geminiMaxConcurrent,
        doorAiMaxConcurrentMcts: row.doorAiMaxConcurrentMcts,
        doorAiMoveTimeoutMs: row.doorAiMoveTimeoutMs,
      }
    : null;
  const door = getEffectiveDoorAiSettings(doorRow);

  return NextResponse.json({
    geminiApiKeyConfigured: gem.configured,
    geminiApiKeyPreview: gem.preview,
    geminiModel: row?.geminiModel ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    doorAiDecideBatchSize: door.doorAiDecideBatchSize,
    geminiMaxConcurrent: door.geminiMaxConcurrent,
    doorAiMaxConcurrentMcts: door.doorAiMaxConcurrentMcts,
    doorAiMoveTimeoutMs: door.doorAiMoveTimeoutMs,
  });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const existing = await prisma.systemSettings.findUnique({ where: { id: "default" } });

  let geminiApiKey = existing?.geminiApiKey ?? null;
  let geminiModel = existing?.geminiModel ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;

  if ("geminiApiKey" in body) {
    if (body.geminiApiKey === null) {
      geminiApiKey = null;
    } else if (typeof body.geminiApiKey === "string") {
      const t = body.geminiApiKey.trim();
      geminiApiKey = t.length ? t : null;
    } else {
      return NextResponse.json({ error: "geminiApiKey must be string or null" }, { status: 400 });
    }
  }

  if ("geminiModel" in body) {
    if (body.geminiModel === null) {
      geminiModel = DEFAULT_GEMINI_MODEL;
    } else if (typeof body.geminiModel === "string") {
      const t = body.geminiModel.trim();
      geminiModel = t.length ? t : DEFAULT_GEMINI_MODEL;
    } else {
      return NextResponse.json({ error: "geminiModel must be string or null" }, { status: 400 });
    }
  }

  const doorRow = existing
    ? {
        doorAiDecideBatchSize: existing.doorAiDecideBatchSize,
        geminiMaxConcurrent: existing.geminiMaxConcurrent,
        doorAiMaxConcurrentMcts: existing.doorAiMaxConcurrentMcts,
        doorAiMoveTimeoutMs: existing.doorAiMoveTimeoutMs,
      }
    : null;
  const cur = getEffectiveDoorAiSettings(doorRow);
  const L = DOOR_AI_ADMIN_LIMITS;

  let doorAiDecideBatchSize = cur.doorAiDecideBatchSize;
  let geminiMaxConcurrent = cur.geminiMaxConcurrent;
  let doorAiMaxConcurrentMcts = cur.doorAiMaxConcurrentMcts;
  let doorAiMoveTimeoutMs = cur.doorAiMoveTimeoutMs;

  if ("doorAiDecideBatchSize" in body && body.doorAiDecideBatchSize !== undefined) {
    doorAiDecideBatchSize = parseAdminDoorAiInt(
      body.doorAiDecideBatchSize,
      cur.doorAiDecideBatchSize,
      L.doorAiDecideBatchSize.min,
      L.doorAiDecideBatchSize.max,
    );
  }
  if ("geminiMaxConcurrent" in body && body.geminiMaxConcurrent !== undefined) {
    geminiMaxConcurrent = parseAdminDoorAiInt(
      body.geminiMaxConcurrent,
      cur.geminiMaxConcurrent,
      L.geminiMaxConcurrent.min,
      L.geminiMaxConcurrent.max,
    );
  }
  if ("doorAiMaxConcurrentMcts" in body && body.doorAiMaxConcurrentMcts !== undefined) {
    doorAiMaxConcurrentMcts = parseAdminDoorAiInt(
      body.doorAiMaxConcurrentMcts,
      cur.doorAiMaxConcurrentMcts,
      L.doorAiMaxConcurrentMcts.min,
      L.doorAiMaxConcurrentMcts.max,
    );
  }
  if ("doorAiMoveTimeoutMs" in body && body.doorAiMoveTimeoutMs !== undefined) {
    doorAiMoveTimeoutMs = parseAdminDoorAiInt(
      body.doorAiMoveTimeoutMs,
      cur.doorAiMoveTimeoutMs,
      L.doorAiMoveTimeoutMs.min,
      L.doorAiMoveTimeoutMs.max,
    );
  }

  await prisma.systemSettings.upsert({
    where: { id: "default" },
    create: {
      id: "default",
      geminiApiKey,
      geminiModel,
      doorAiDecideBatchSize,
      geminiMaxConcurrent,
      doorAiMaxConcurrentMcts,
      doorAiMoveTimeoutMs,
    },
    update: {
      geminiApiKey,
      geminiModel,
      doorAiDecideBatchSize,
      geminiMaxConcurrent,
      doorAiMaxConcurrentMcts,
      doorAiMoveTimeoutMs,
    },
  });

  invalidateDoorAiRuntimeCache();

  return NextResponse.json({ ok: true });
}
