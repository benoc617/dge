import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** HttpOnly cookie name for browser admin UI (not used by Basic-auth API clients). */
export const ADMIN_SESSION_COOKIE = "srx_admin_session";

const TOKEN_VERSION = 1;
const MAX_AGE_SEC = 8 * 3600;
const ADMIN_SETTINGS_ID = "admin";

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Required in production. Min 32 chars. Used to sign session tokens (HMAC).
 * Rotate if leaked; changing it invalidates all existing admin cookies.
 */
export function getAdminSessionSecret(): string {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_SESSION_SECRET must be set (min 32 characters) in production.");
  }
  if (s && s.length > 0) {
    console.warn("[admin-session] ADMIN_SESSION_SECRET should be at least 32 characters.");
  }
  console.warn(
    "[admin-session] ADMIN_SESSION_SECRET not set — using insecure dev default. Set a long random string.",
  );
  return "dev-insecure-admin-session-secret-min-32-chars!!";
}

/** Binds tokens to the current admin password so changing the password invalidates all sessions. */
export async function getAdminSigningKey(): Promise<string> {
  const row = await prisma.adminSettings.findUnique({ where: { id: ADMIN_SETTINGS_ID } });
  if (row?.passwordHash) return row.passwordHash;
  const p = process.env.INITIAL_ADMIN_PASSWORD ?? "srxpass";
  return crypto.createHash("sha256").update(`env:${p}`).digest("hex");
}

export async function signAdminSessionToken(adminUsername: string): Promise<string> {
  const sk = await getAdminSigningKey();
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC;
  const payload = { v: TOKEN_VERSION, exp, u: adminUsername };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sigHex = crypto
    .createHmac("sha256", getAdminSessionSecret())
    .update(body + "." + sk)
    .digest("hex");
  return `${body}.${sigHex}`;
}

export async function verifyAdminSessionToken(token: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [body, sigHex] = parts;
  if (!body || !sigHex) return false;
  let sk: string;
  try {
    sk = await getAdminSigningKey();
  } catch {
    return false;
  }
  const expectedHex = crypto
    .createHmac("sha256", getAdminSessionSecret())
    .update(body + "." + sk)
    .digest("hex");
  if (!timingSafeEqualStr(sigHex, expectedHex)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v?: number;
      exp?: number;
      u?: string;
    };
    if (payload.v !== TOKEN_VERSION) return false;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return false;
    const expectedUser = process.env.ADMIN_USERNAME ?? "admin";
    if (payload.u !== expectedUser) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSecureRequest(req: NextRequest): boolean {
  if (process.env.NODE_ENV === "production") return true;
  return req.headers.get("x-forwarded-proto") === "https";
}

export function attachAdminSessionCookie(res: NextResponse, req: NextRequest, token: string): void {
  res.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export function clearAdminSessionCookie(res: NextResponse, req: NextRequest): void {
  res.cookies.set(ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
