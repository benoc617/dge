import { NextRequest, NextResponse } from "next/server";
import { verifyAdminLogin } from "@/lib/admin-auth";
import {
  attachAdminSessionCookie,
  signAdminSessionToken,
} from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!(await verifyAdminLogin(username, password))) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const adminUsername = process.env.ADMIN_USERNAME ?? "admin";
  const token = await signAdminSessionToken(adminUsername);
  const res = NextResponse.json({ ok: true });
  attachAdminSessionCookie(res, req, token);
  return res;
}
