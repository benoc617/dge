import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireAdmin, verifyAdminPassword, BCRYPT_ROUNDS } from "@/lib/admin-auth";
import {
  attachAdminSessionCookie,
  signAdminSessionToken,
} from "@/lib/admin-session";

import { AUTH } from "@/lib/game-constants";
import { validatePasswordStrength } from "@/lib/auth";

const ADMIN_ID = "admin";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "currentPassword and newPassword are required" }, { status: 400 });
  }
  const pwErr = validatePasswordStrength(newPassword, AUTH.PASSWORD_MIN_ADMIN);
  if (pwErr) {
    return NextResponse.json({ error: pwErr }, { status: 400 });
  }

  const ok = await verifyAdminPassword(currentPassword);
  if (!ok) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await prisma.adminSettings.upsert({
    where: { id: ADMIN_ID },
    create: { id: ADMIN_ID, passwordHash },
    update: { passwordHash },
  });

  const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
  const token = await signAdminSessionToken(adminUsername);
  const res = NextResponse.json({ ok: true });
  attachAdminSessionCookie(res, req, token);
  return res;
}
