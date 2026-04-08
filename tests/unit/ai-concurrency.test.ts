import { describe, it, expect } from "vitest";
import { createAsyncSemaphore, parsePositiveInt } from "@/lib/ai-concurrency";

describe("parsePositiveInt", () => {
  it("returns default when missing or invalid", () => {
    expect(parsePositiveInt(undefined, 3)).toBe(3);
    expect(parsePositiveInt("", 3)).toBe(3);
    expect(parsePositiveInt("5", 3)).toBe(5);
    expect(parsePositiveInt("0", 3)).toBe(3);
    expect(parsePositiveInt("-1", 3)).toBe(3);
  });
});

describe("createAsyncSemaphore", () => {
  it("limits concurrent async work", async () => {
    const run = createAsyncSemaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;
    const task = async (id: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return id;
    };
    await Promise.all([run(() => task(1)), run(() => task(2)), run(() => task(3)), run(() => task(4))]);
    expect(maxConcurrent).toBe(2);
  });
});
