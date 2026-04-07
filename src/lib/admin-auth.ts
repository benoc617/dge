import crypto from "crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ADMIN_SESSION_COOKIE, verifyAdminSessionToken } from "@/lib/admin-session";

export const BCRYPT_ROUNDS = 12;

const ADMIN_SETTINGS_ID = "admin";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verifies the admin password: if `AdminSettings` has a row, bcrypt against DB;
 * otherwise timing-safe compare to `INITIAL_ADMIN_PASSWORD` env (required).
 */
export async function verifyAdminPassword(password: string): Promise<boolean> {
  const row = await prisma.adminSettings.findUnique({ where: { id: ADMIN_SETTINGS_ID } });
  if (row) {
    return bcrypt.compare(password, row.passwordHash);
  }
  const p = process.env.INITIAL_ADMIN_PASSWORD;
  if (!p) {
    console.warn("[admin-auth] INITIAL_ADMIN_PASSWORD env var is not set — using insecure default. Set this in production!");
    return timingSafeEqualStr(password, "srxpass");
  }
  return timingSafeEqualStr(password, p);
}

/** Username always from `ADMIN_USERNAME` env (default "admin"); password from DB override or env. */
export async function verifyAdminLogin(username: string, password: string): Promise<boolean> {
  const u = process.env.ADMIN_USERNAME ?? "admin";
  if (!timingSafeEqualStr(username, u)) return false;
  return verifyAdminPassword(password);
}

/**
 * Parse Basic auth from the Authorization header.
 * Returns { username, password } or null if missing/malformed.
 */
function parseBasicAuth(req: NextRequest): { username: string; password: string } | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

/**
 * Per-request admin auth guard.
 * 1) **HttpOnly session cookie** (signed, bound to admin password hash) — used by the browser admin UI.
 * 2) **Authorization: Basic** — scripts, curl, E2E helpers (no cookie).
 */
export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  const cookie = req.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (cookie && (await verifyAdminSessionToken(cookie))) {
    return null;
  }
  const creds = parseBasicAuth(req);
  if (!creds) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ok = await verifyAdminLogin(creds.username, creds.password);
  if (!ok) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }
  return null;
}
