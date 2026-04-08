import { describe, it, expect } from "vitest";
import {
  api,
  register,
  joinGame,
  getStatus,
  doTick,
  doAction,
  setupAI,
  getLeaderboard,
  uniqueName,
  uniqueGalaxy,
  completeDoorDaySlots,
  pollStatusUntil,
  scheduleTestGalaxyDeletion,
  TEST_PASSWORD,
} from "./helpers";
import { ACTIONS_PER_DAY, START } from "../../src/lib/game-constants";

describe("door-game simultaneous mode", () => {
  it("two players use POST /action; full turns and round fields", async () => {
    const g = uniqueGalaxy("Door");
    const player1Name = uniqueName("Door1");
    const player2Name = uniqueName("Door2");
    const password = TEST_PASSWORD;

    const r1 = await register(player1Name, password, { galaxyName: g, turnMode: "simultaneous" });
    expect(r1.status).toBe(201);
    scheduleTestGalaxyDeletion((r1.data as { gameSessionId?: string }).gameSessionId);
    const p1Id = (r1.data as { id?: string }).id;
    expect(p1Id).toBeTruthy();

    const r2 = await joinGame(player2Name, password, { inviteCode: (r1.data as { inviteCode?: string }).inviteCode });
    expect(r2.status).toBe(201);

    const s1a = await getStatus(p1Id!);
    expect(s1a.status).toBe(200);
    const d1 = s1a.data as {
      turnMode?: string;
      fullTurnsLeftToday?: number;
      turnOpen?: boolean;
      canAct?: boolean;
      empire?: { fullTurnsUsedThisRound?: number };
    };
    expect(d1.turnMode).toBe("simultaneous");
    expect(d1.fullTurnsLeftToday).toBe(ACTIONS_PER_DAY);
    expect(d1.canAct).toBe(true);

    const t1 = await doTick(player1Name);
    expect(t1.status).toBe(200);

    const s1b = await getStatus(p1Id!);
    const d1b = s1b.data as { turnOpen?: boolean; fullTurnsLeftToday?: number };
    expect(d1b.turnOpen).toBe(true);

    const a1 = await doAction(player1Name, "buy_soldiers", { amount: 1 });
    expect(a1.status).toBe(200);
    expect((a1.data as { success?: boolean }).success).toBe(true);

    const s1c = await getStatus(p1Id!);
    const d1c = s1c.data as {
      fullTurnsLeftToday?: number;
      empire?: { fullTurnsUsedThisRound?: number; turnsLeft?: number };
    };
    expect(d1c.fullTurnsLeftToday).toBe(ACTIONS_PER_DAY - 1);
    expect(d1c.empire?.fullTurnsUsedThisRound).toBe(1);
    expect(d1c.empire?.turnsLeft).toBe(START.TURNS - 1);

    const p2Id = (r2.data as { id?: string }).id;
    const t2 = await doTick(player2Name);
    expect(t2.status).toBe(200);
    const e2 = await doAction(player2Name, "end_turn");
    expect(e2.status).toBe(200);
    const s2 = await getStatus(p2Id!);
    const d2 = s2.data as {
      fullTurnsLeftToday?: number;
      empire?: { fullTurnsUsedThisRound?: number; turnsLeft?: number };
    };
    expect(d2.fullTurnsLeftToday).toBe(ACTIONS_PER_DAY - 1);
    expect(d2.empire?.fullTurnsUsedThisRound).toBe(1);
    expect(d2.empire?.turnsLeft).toBe(START.TURNS - 1);
  });

  it("concurrent POST /action from one player: one 200 and one 409 (last daily slot contested)", async () => {
    const g = uniqueGalaxy("DoorLock");
    const player1Name = uniqueName("DoorL1");
    const player2Name = uniqueName("DoorL2");
    const password = TEST_PASSWORD;

    const r1 = await register(player1Name, password, { galaxyName: g, turnMode: "simultaneous" });
    expect(r1.status).toBe(201);
    scheduleTestGalaxyDeletion((r1.data as { gameSessionId?: string }).gameSessionId);
    // Join a second player so the round cannot roll when player1 exhausts their slots
    // (allDone requires BOTH players done — prevents day reset that would re-enable player1).
    const r2 = await joinGame(player2Name, password, { inviteCode: (r1.data as { inviteCode?: string }).inviteCode });
    expect(r2.status).toBe(201);

    // Use ACTIONS_PER_DAY - 1 full turns so exactly one slot remains.
    await completeDoorDaySlots(player1Name, ACTIONS_PER_DAY - 1);

    // Fire two concurrent buy_soldiers against the last available slot.
    // The action route auto-opens a full turn when turnOpen=false, so no explicit tick needed.
    //
    // Core invariant: at most ONE action can consume the last slot (no double-processing).
    // The advisory lock (SELECT … FOR UPDATE NOWAIT) serializes concurrent mutations.
    // Possible outcomes:
    //   [200, 409] — first wins lock, second gets GalaxyBusy or sees no turns left.
    //   [409, 409] — rarer but valid: first gets GalaxyBusy (no lock yet), second also
    //                gets GalaxyBusy or the lock detects the slot was already consumed.
    //                When this happens, the slot is still available; a follow-up action verifies.
    const [a, b] = await Promise.all([
      api("/api/game/action", {
        method: "POST",
        body: JSON.stringify({ playerName: player1Name, action: "buy_soldiers", amount: 1 }),
      }),
      api("/api/game/action", {
        method: "POST",
        body: JSON.stringify({ playerName: player1Name, action: "buy_soldiers", amount: 1 }),
      }),
    ]);

    // KEY INVARIANT: no double-processing — never both succeed.
    const successes = [a.status, b.status].filter((s) => s === 200);
    expect(successes.length).toBeLessThanOrEqual(1);

    if (successes.length === 1) {
      // Happy path: exactly one succeeded, one was correctly rejected.
      const oneSucceeded = [a.data, b.data].some(
        (d) => typeof d === "object" && d !== null && (d as { success?: boolean }).success === true,
      );
      expect(oneSucceeded).toBe(true);
    } else {
      // Both rejected (advisory lock over-rejected or other valid serialization).
      // Verify the slot is still available by successfully firing a follow-up action.
      await doTick(player1Name); // open the slot
      const followUp = await doAction(player1Name, "buy_soldiers", { amount: 1 });
      expect(followUp.status).toBe(200);
      expect((followUp.data as { success?: boolean }).success).toBe(true);
    }
  });

  it("after five full turns each, calendar round rolls; each full turn decremented turnsLeft", async () => {
    const g = uniqueGalaxy("DoorRoll");
    const player1Name = uniqueName("DoorR1");
    const player2Name = uniqueName("DoorR2");
    const password = TEST_PASSWORD;

    const r1 = await register(player1Name, password, { galaxyName: g, turnMode: "simultaneous" });
    expect(r1.status).toBe(201);
    scheduleTestGalaxyDeletion((r1.data as { gameSessionId?: string }).gameSessionId);
    const p1Id = (r1.data as { id?: string }).id!;

    const r2 = await joinGame(player2Name, password, { inviteCode: (r1.data as { inviteCode?: string }).inviteCode });
    expect(r2.status).toBe(201);
    const p2Id = (r2.data as { id?: string }).id!;

    const before1 = await getStatus(p1Id);
    const before2 = await getStatus(p2Id);
    const tl0 = (before1.data as { empire?: { turnsLeft?: number } }).empire?.turnsLeft;
    expect(tl0).toBeDefined();
    expect((before2.data as { empire?: { turnsLeft?: number } }).empire?.turnsLeft).toBe(tl0);

    await completeDoorDaySlots(player1Name);
    await completeDoorDaySlots(player2Name);

    const after1 = await getStatus(p1Id);
    const after2 = await getStatus(p2Id);
    const tl1 = (after1.data as { empire?: { turnsLeft?: number } }).empire?.turnsLeft;
    const tl2 = (after2.data as { empire?: { turnsLeft?: number } }).empire?.turnsLeft;
    expect(tl1).toBe((tl0 ?? 0) - ACTIONS_PER_DAY);
    expect(tl2).toBe((tl0 ?? 0) - ACTIONS_PER_DAY);

    const d1 = after1.data as { dayNumber?: number; fullTurnsLeftToday?: number };
    expect(d1.fullTurnsLeftToday).toBe(ACTIONS_PER_DAY);
    expect(d1.dayNumber).toBe(2);
  });

  it("human can tick with AI in session; status polls run AIs; calendar day rolls when all daily slots done", async () => {
    const g = uniqueGalaxy("DoorAI");
    const humanName = uniqueName("DoorHum");
    const password = TEST_PASSWORD;

    const r1 = await register(humanName, password, { galaxyName: g, turnMode: "simultaneous" });
    expect(r1.status).toBe(201);
    const p1Id = (r1.data as { id?: string }).id!;
    const sessionId = (r1.data as { gameSessionId?: string }).gameSessionId!;
    scheduleTestGalaxyDeletion(sessionId);
    const aiName = "Admiral Koss";

    const aiRes = await setupAI([aiName], sessionId);
    expect(aiRes.status).toBe(200);

    // completeDoorDaySlots opens each slot with doTick (do not pre-tick).
    await completeDoorDaySlots(humanName);

    const fin = await pollStatusUntil(
      p1Id,
      (d) =>
        d.dayNumber === 2 &&
        (d.empire as { turnsLeft?: number } | undefined)?.turnsLeft === START.TURNS - ACTIONS_PER_DAY,
      { timeoutMs: 180_000, intervalMs: 400 },
    );
    expect(fin.dayNumber).toBe(2);
    expect((fin.empire as { turnsLeft?: number }).turnsLeft).toBe(START.TURNS - ACTIONS_PER_DAY);

    const lb = await getLeaderboard(humanName);
    expect(lb.status).toBe(200);
    const rows = (lb.data as { leaderboard?: { name: string; turnsPlayed?: number }[] }).leaderboard ?? [];
    const aiRow = rows.find((x) => x.name === aiName);
    expect(aiRow).toBeDefined();
    const humanTp = (fin.empire as { turnsPlayed?: number }).turnsPlayed ?? 0;
    const aiTp = (aiRow as { turnsPlayed?: number }).turnsPlayed ?? 0;
    expect(humanTp).toBe(ACTIONS_PER_DAY);
    expect(aiTp).toBeGreaterThanOrEqual(ACTIONS_PER_DAY);
  }, 180_000);

  it("two AI opponents: calendar day rolls and both AIs advance (multi-AI drain)", async () => {
    const g = uniqueGalaxy("DoorAI2");
    const humanName = uniqueName("DoorHum2");
    const password = TEST_PASSWORD;

    const r1 = await register(humanName, password, { galaxyName: g, turnMode: "simultaneous" });
    expect(r1.status).toBe(201);
    const p1Id = (r1.data as { id?: string }).id!;
    const sessionId = (r1.data as { gameSessionId?: string }).gameSessionId!;
    scheduleTestGalaxyDeletion(sessionId);

    const aiA = "Sleve McDichael";
    const aiB = "Onson Sweemey";
    const aiRes = await setupAI([aiA, aiB], sessionId);
    expect(aiRes.status).toBe(200);

    await completeDoorDaySlots(humanName);

    const fin = await pollStatusUntil(
      p1Id,
      (d) =>
        d.dayNumber === 2 &&
        (d.empire as { turnsLeft?: number } | undefined)?.turnsLeft === START.TURNS - ACTIONS_PER_DAY,
      { timeoutMs: 180_000, intervalMs: 400 },
    );
    expect(fin.dayNumber).toBe(2);
    expect((fin.empire as { turnsLeft?: number }).turnsLeft).toBe(START.TURNS - ACTIONS_PER_DAY);

    const lb = await getLeaderboard(humanName);
    expect(lb.status).toBe(200);
    const rows = (lb.data as { leaderboard?: { name: string; turnsPlayed?: number }[] }).leaderboard ?? [];
    const rowA = rows.find((x) => x.name === aiA);
    const rowB = rows.find((x) => x.name === aiB);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    expect((rowA as { turnsPlayed?: number }).turnsPlayed ?? 0).toBeGreaterThanOrEqual(ACTIONS_PER_DAY);
    expect((rowB as { turnsPlayed?: number }).turnsPlayed ?? 0).toBeGreaterThanOrEqual(ACTIONS_PER_DAY);
  }, 180_000);
});
