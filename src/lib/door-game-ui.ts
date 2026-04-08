/**
 * Door-game Command Center: disable economy/military/etc. when the player may not act on this
 * full turn, or the full turn is not open yet.
 *
 * Uses `canAct === false` (not `!canAct`) so `canAct` **undefined** during a status refresh does
 * not disable the panel while `turnOpen` is true — that matched a bug where the header showed
 * "TURN OPEN" but every action stayed grayed out.
 */
export function simultaneousDoorCommandCenterDisabled(
  canAct: boolean | undefined,
  turnOpen: boolean | undefined,
): boolean {
  return canAct === false || turnOpen !== true;
}
