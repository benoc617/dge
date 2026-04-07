/** True when the empire cannot be targeted by attacks, covert ops, etc. (new-empire protection). */
export function targetHasNewEmpireProtection(empire: {
  isProtected: boolean;
  protectionTurns: number;
}): boolean {
  return empire.isProtected && empire.protectionTurns > 0;
}
