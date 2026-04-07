import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    adminSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

describe("admin-session", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = "a".repeat(32);
    process.env.INITIAL_ADMIN_PASSWORD = "unit-test-admin-pw";
    process.env.ADMIN_USERNAME = "admin";
  });

  it("signs and verifies a session token", async () => {
    const { signAdminSessionToken, verifyAdminSessionToken } = await import("@/lib/admin-session");
    const token = await signAdminSessionToken("admin");
    expect(await verifyAdminSessionToken(token)).toBe(true);
  });

  it("rejects tampered token", async () => {
    const { signAdminSessionToken, verifyAdminSessionToken } = await import("@/lib/admin-session");
    const token = await signAdminSessionToken("admin");
    const bad = token.slice(0, -4) + "ffff";
    expect(await verifyAdminSessionToken(bad)).toBe(false);
  });

  it("rejects wrong username in payload", async () => {
    const { signAdminSessionToken, verifyAdminSessionToken } = await import("@/lib/admin-session");
    const token = await signAdminSessionToken("other");
    expect(await verifyAdminSessionToken(token)).toBe(false);
  });
});
