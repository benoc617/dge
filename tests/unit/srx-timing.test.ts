import { describe, it, expect, vi } from "vitest";
import { logSrxTiming, msElapsed, msBetween } from "@/lib/srx-timing";

describe("srx-timing", () => {
  describe("logSrxTiming", () => {
    it("emits [srx-timing] JSON to console.info", () => {
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      logSrxTiming("test_event", { x: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("[srx-timing]");
      const json = spy.mock.calls[0][1] as string;
      expect(JSON.parse(json)).toEqual({ event: "test_event", x: 1 });
      spy.mockRestore();
    });
  });

  describe("msElapsed / msBetween", () => {
    it("msBetween matches difference", () => {
      const a = 10;
      const b = 25.7;
      expect(msBetween(a, b)).toBe(16);
    });

    it("msElapsed returns non-negative rounded ms", () => {
      const t0 = performance.now();
      const e = msElapsed(t0);
      expect(e).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(e)).toBe(true);
    });
  });
});
