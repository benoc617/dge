import { NextRequest, NextResponse } from "next/server";

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function getRequestHost(req: NextRequest): string {
  const host = req.headers.get("host") ?? "";
  return host.replace(/:\d+$/, "").toLowerCase();
}

/** CSRF: mutating methods from browsers must include this custom header. */
const CSRF_HEADER = "x-srx-csrf";
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function middleware(req: NextRequest) {
  const host = getRequestHost(req);
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // --- Localhost-only gate (API routes) ---
  if (isApi && !LOCALHOST_HOSTS.has(host) && host !== "app") {
    return NextResponse.json(
      { error: "Forbidden — API access restricted to localhost" },
      { status: 403 },
    );
  }

  // --- CSRF protection for mutating API requests ---
  if (isApi && MUTATING_METHODS.has(req.method)) {
    const csrfValue = req.headers.get(CSRF_HEADER);
    if (!csrfValue) {
      return NextResponse.json(
        { error: "Missing CSRF header (X-SRX-CSRF)" },
        { status: 403 },
      );
    }
  }

  // --- Security headers on all responses ---
  const res = NextResponse.next();

  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-DNS-Prefetch-Control", "off");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      // unsafe-eval required by React dev mode (stack trace reconstruction, HMR)
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
