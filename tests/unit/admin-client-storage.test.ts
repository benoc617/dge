import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  adminApiInit,
  loadStoredAdminUsername,
  saveAdminUsername,
  clearAdminCredentials,
} from "@/lib/admin-client-storage";

describe("admin-client-storage", () => {
  beforeEach(() => {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.clear();
    }
  });

  afterEach(() => {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.clear();
    }
  });

  it("round-trips username only in sessionStorage", () => {
    if (typeof sessionStorage === "undefined") {
      expect(loadStoredAdminUsername()).toBeNull();
      return;
    }
    saveAdminUsername("admin");
    expect(loadStoredAdminUsername()).toBe("admin");
    clearAdminCredentials();
    expect(loadStoredAdminUsername()).toBeNull();
  });

  it("migrates legacy key to username-only and drops password", () => {
    if (typeof sessionStorage === "undefined") {
      expect(loadStoredAdminUsername()).toBeNull();
      return;
    }
    sessionStorage.setItem("srx_admin_basic_v1", JSON.stringify({ u: "ops", p: "secret" }));
    expect(loadStoredAdminUsername()).toBe("ops");
    expect(sessionStorage.getItem("srx_admin_basic_v1")).toBeNull();
    expect(loadStoredAdminUsername()).toBe("ops");
  });

  it("adminApiInit adds credentials and CSRF for POST", () => {
    const init = adminApiInit({ method: "POST", body: "{}" });
    expect(init.credentials).toBe("include");
    const h = new Headers(init.headers);
    expect(h.get("X-SRX-CSRF")).toBe("1");
    expect(h.get("Content-Type")).toBe("application/json");
  });

  it("adminApiInit does not require CSRF for GET", () => {
    const init = adminApiInit({ method: "GET" });
    const h = new Headers(init.headers);
    expect(h.get("X-SRX-CSRF")).toBeNull();
  });
});
