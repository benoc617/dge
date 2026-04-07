/**
 * Browser admin UI: optional username pref in sessionStorage (no password).
 * Auth is an **httpOnly** cookie set by `POST /api/admin/login` (`srx_admin_session`).
 * Legacy key `srx_admin_basic_v1` (username+password) is stripped on read.
 */

const KEY = "srx_admin_ui_v1";
const LEGACY_KEY = "srx_admin_basic_v1";

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Fetch init for `/api/admin/*` from the browser: sends cookies + CSRF on mutating requests. */
export function adminApiInit(init?: RequestInit): RequestInit {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (MUTATING.has(method) && !headers.has("X-SRX-CSRF")) {
    headers.set("X-SRX-CSRF", "1");
  }
  if (
    !headers.has("Content-Type") &&
    (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE")
  ) {
    headers.set("Content-Type", "application/json");
  }
  return {
    ...init,
    credentials: "include",
    headers,
  };
}

export function loadStoredAdminUsername(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const legacy = sessionStorage.getItem(LEGACY_KEY);
    if (legacy) {
      sessionStorage.removeItem(LEGACY_KEY);
      try {
        const o = JSON.parse(legacy) as { u?: unknown };
        if (typeof o.u === "string" && o.u) {
          sessionStorage.setItem(KEY, JSON.stringify({ u: o.u }));
          return o.u;
        }
      } catch {
        /* ignore */
      }
    }
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as { u?: unknown };
    return typeof o.u === "string" ? o.u : null;
  } catch {
    return null;
  }
}

export function saveAdminUsername(username: string): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ u: username }));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearAdminCredentials(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
}
