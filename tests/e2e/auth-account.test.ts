import { describe, it, expect } from "vitest";
import {
  api,
  register,
  uniqueName,
  uniqueGalaxy,
  scheduleTestGalaxyDeletion,
  scheduleTestUserDeletion,
  TEST_PASSWORD,
} from "./helpers";

describe("auth account API", () => {
  it("signup then login returns user and empty games", async () => {
    const u = uniqueName("acct");
    const signup = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: u,
        fullName: "Test Commander",
        email: `${u}@test.invalid`,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
      }),
    });
    expect(signup.status).toBe(201);
    scheduleTestUserDeletion(u);

    const authLogin = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: TEST_PASSWORD }),
    });
    expect(authLogin.status).toBe(200);
    const d = authLogin.data as { user: { username: string }; games: unknown[] };
    expect(d.user.username).toBe(u.toLowerCase());
    expect(Array.isArray(d.games)).toBe(true);
    expect(d.games.length).toBe(0);
  });

  it("register links UserAccount and login lists active game", async () => {
    const u = uniqueName("lnk");
    const signup = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        username: u,
        fullName: "Link Test",
        email: `${u}@test.invalid`,
        password: TEST_PASSWORD,
        passwordConfirm: TEST_PASSWORD,
      }),
    });
    expect(signup.status).toBe(201);
    scheduleTestUserDeletion(u);

    const { status, data } = await register(u, TEST_PASSWORD, { galaxyName: uniqueGalaxy("AuthLnk") });
    expect(status).toBe(201);
    scheduleTestGalaxyDeletion((data as { gameSessionId?: string }).gameSessionId);
    expect((data as { name?: string }).name).toBe(u.toLowerCase());

    const authLogin = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: u, password: TEST_PASSWORD }),
    });
    expect(authLogin.status).toBe(200);
    const d = authLogin.data as { games: { playerId: string; game: string; isYourTurn: boolean; currentTurnPlayer: string | null }[] };
    expect(d.games.length).toBe(1);
    expect(d.games[0].playerId).toBeTruthy();
    expect(d.games[0].game).toBe("srx");
    expect(typeof d.games[0].isYourTurn).toBe("boolean");
    expect(d.games[0].isYourTurn).toBe(true);
  });
});
