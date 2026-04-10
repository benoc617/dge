import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  adminLogin,
  adminGalaxies,
  adminCreateGalaxy,
  adminDeleteGalaxies,
  adminLogout,
  adminChangePassword,
  resetAdminPasswordOverride,
  resetSystemSettings,
  restoreSystemSettingsFromEnv,
  adminGetSettings,
  adminPatchSettings,
  joinGame,
  uniqueName,
  uniqueGalaxy,
  api,
  adminListUsers,
  adminSetUserPassword,
  adminDeleteUser,
  deleteTestGalaxySession,
  scheduleTestUserDeletion,
  TEST_PASSWORD,
} from "./helpers";

describe("E2E: Admin API", () => {
  beforeEach(async () => {
    await resetAdminPasswordOverride();
  });

  afterEach(async () => {
    // Restore any SystemSettings cleared by tests so the Gemini key survives the test run.
    await restoreSystemSettingsFromEnv();
  });

  it("changes admin password via API; clearing DB restores env password login", async () => {
    const defaultPass = "srxpass";
    const tempPass = "E2EAdminPw9!";
    const { status: s0, cookie } = await adminLogin(undefined, defaultPass);
    expect(s0).toBe(200);
    expect(cookie).toBeTruthy();

    const ch1 = await adminChangePassword(cookie!, defaultPass, tempPass);
    expect(ch1.status).toBe(200);

    await adminLogout(cookie!);

    const login2 = await adminLogin(undefined, tempPass);
    expect(login2.status).toBe(200);
    expect(login2.cookie).toBeTruthy();

    await resetAdminPasswordOverride();

    const login3 = await adminLogin(undefined, defaultPass);
    expect(login3.status).toBe(200);
  });

  it("reads and updates integration settings", async () => {
    // Reset SystemSettings to test from env-only baseline; restore after.
    await resetSystemSettings();
    const { cookie } = await adminLogin();
    expect(cookie).toBeTruthy();

    const get = await adminGetSettings(cookie!);
    expect(get.status).toBe(200);
    const g = get.data as {
      geminiModel: string;
      doorAiDecideBatchSize: number;
      geminiMaxConcurrent: number;
      doorAiMaxConcurrentMcts: number;
      doorAiMoveTimeoutMs: number;
    };
    expect(typeof g.geminiModel).toBe("string");
    expect(g.doorAiDecideBatchSize).toBeGreaterThanOrEqual(1);
    expect(g.geminiMaxConcurrent).toBeGreaterThanOrEqual(1);
    expect(g.doorAiMaxConcurrentMcts).toBeGreaterThanOrEqual(1);
    expect(g.doorAiMoveTimeoutMs).toBeGreaterThanOrEqual(1000);

    const patch = await adminPatchSettings(cookie!, {
      geminiModel: "gemini-2.5-flash",
      doorAiDecideBatchSize: 6,
      geminiMaxConcurrent: 3,
      doorAiMaxConcurrentMcts: 2,
      doorAiMoveTimeoutMs: 45_000,
    });
    expect(patch.status).toBe(200);

    const get2 = await adminGetSettings(cookie!);
    expect(get2.status).toBe(200);
    const g2 = get2.data as typeof g;
    expect(g2.doorAiDecideBatchSize).toBe(6);
    expect(g2.geminiMaxConcurrent).toBe(3);
    expect(g2.doorAiMaxConcurrentMcts).toBe(2);
    expect(g2.doorAiMoveTimeoutMs).toBe(45_000);
  });

  it("rejects invalid admin login", async () => {
    const { status } = await adminLogin("admin", "wrong-password");
    expect(status).toBe(401);
  });

  it("lists user accounts and can force password + delete", async () => {
    const u = uniqueName("admusr");
    const signup = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: u,
        fullName: "Admin Test User",
        email: `${u}@e2e.invalid`,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
      }),
    });
    expect(signup.status).toBe(201);
    scheduleTestUserDeletion(u);

    const { cookie } = await adminLogin();
    expect(cookie).toBeTruthy();

    const list = await adminListUsers(cookie!);
    expect(list.status).toBe(200);
    const users = (list.data as { users: { id: string; username: string }[] }).users;
    const row = users.find((x) => x.username === u.toLowerCase());
    expect(row).toBeTruthy();

    const patch = await adminSetUserPassword(cookie!, row!.id, "NewForced!88");
    expect(patch.status).toBe(200);

    const loginNew = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: "NewForced!88" }),
    });
    expect(loginNew.status).toBe(200);

    const del = await adminDeleteUser(cookie!, row!.id);
    expect(del.status).toBe(200);

    const list2 = await adminListUsers(cookie!);
    const users2 = (list2.data as { users: { id: string }[] }).users;
    expect(users2.some((x) => x.id === row!.id)).toBe(false);
  });

  it("lists galaxies and creates a pre-staged lobby; first human join activates", async () => {
    const { status: loginStatus, cookie } = await adminLogin();
    expect(loginStatus).toBe(200);
    expect(cookie).toBeTruthy();

    const list = await adminGalaxies(cookie!);
    expect(list.status).toBe(200);
    expect(Array.isArray((list.data as { galaxies: unknown[] }).galaxies)).toBe(true);

    const g = uniqueGalaxy("AdminStaging");
    const created = await adminCreateGalaxy(cookie!, {
      galaxyName: g,
      isPublic: true,
      aiNames: ["Admiral Koss"],
    });
    expect(created.status).toBe(201);
    const body = created.data as { sessionId: string; inviteCode: string };
    expect(body.sessionId).toBeTruthy();
    expect(body.inviteCode).toBeTruthy();

    const joiner = uniqueName("StagingJoin");
    const { status: joinSt, data: joinData } = await joinGame(joiner, TEST_PASSWORD, { inviteCode: body.inviteCode });
    expect(joinSt).toBe(201);
    expect(joinData.gameSessionId).toBe(body.sessionId);

    await deleteTestGalaxySession(body.sessionId);
  });

  it("deletes galaxies by id (bulk API)", async () => {
    const { cookie } = await adminLogin();
    expect(cookie).toBeTruthy();

    const g = uniqueGalaxy("AdminDelete");
    const created = await adminCreateGalaxy(cookie!, { galaxyName: g, isPublic: false });
    expect(created.status).toBe(201);
    const sessionId = (created.data as { sessionId: string }).sessionId;

    const del = await adminDeleteGalaxies(cookie!, [sessionId]);
    expect(del.status).toBe(200);
    expect((del.data as { deleted: number }).deleted).toBe(1);

    const list = await adminGalaxies(cookie!);
    const galaxies = (list.data as { galaxies: { id: string }[] }).galaxies;
    expect(galaxies.some((x) => x.id === sessionId)).toBe(false);
  });

  it("deletes chess sessions (players have no Empire rows)", async () => {
    const u = uniqueName("admchessdel");
    const signup = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: u,
        fullName: "Admin Chess Delete",
        email: `${u}@e2e.invalid`,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
      }),
    });
    expect(signup.status).toBe(201);
    scheduleTestUserDeletion(u);

    const reg = await api("/api/game/register", {
      method: "POST",
      body: JSON.stringify({
        name: u,
        password: TEST_PASSWORD,
        game: "chess",
        galaxyName: uniqueGalaxy("AdmChessDel"),
      }),
    });
    expect(reg.status).toBe(201);
    const sessionId = (reg.data as { gameSessionId: string }).gameSessionId;

    const { cookie } = await adminLogin();
    expect(cookie).toBeTruthy();
    const del = await adminDeleteGalaxies(cookie!, [sessionId]);
    expect(del.status).toBe(200);
    expect((del.data as { deleted: number }).deleted).toBe(1);
    expect((del.data as { results: { id: string; ok: boolean }[] }).results).toEqual([
      { id: sessionId, ok: true },
    ]);
  });
});
