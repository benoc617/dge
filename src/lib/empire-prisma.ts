import type { Prisma } from "@prisma/client";

/** Maps a partial empire shape to `Prisma.EmpireUpdateInput`. Json fields (pendingDefenderAlerts) accept the array value directly on MySQL — no `{ set: [...] }` wrapper needed. */
export function toEmpireUpdateData(empire: Record<string, unknown>): Prisma.EmpireUpdateInput {
  return empire as Prisma.EmpireUpdateInput;
}
