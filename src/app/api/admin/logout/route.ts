import { NextRequest, NextResponse } from "next/server";
import { clearAdminSessionCookie } from "@/lib/admin-session";

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearAdminSessionCookie(res, req);
  return res;
}
