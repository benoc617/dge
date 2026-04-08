/**
 * Structured request/phase timing for optimization (always on).
 * Emits JSON lines: `[srx-timing] {"event":"...",...}` to stdout (Docker logs).
 *
 * Wall-clock fields (when present): `requestAtIso` / `requestAtMs` = handler start (after JSON parse);
 * `committedAtIso` / `committedAtMs` = after DB work for that request (e.g. post `withCommitLock`, or
 * after `runAndPersistTick`). The next line is typically `return NextResponse.json` (response not yet on the wire).
 */
export function logSrxTiming(event: string, data: Record<string, unknown>): void {
  console.info("[srx-timing]", JSON.stringify({ event, ...data }));
}

export function msElapsed(from: number): number {
  return Math.round(performance.now() - from);
}

/** Elapsed milliseconds between two `performance.now()` marks. */
export function msBetween(start: number, end: number): number {
  return Math.round(end - start);
}
