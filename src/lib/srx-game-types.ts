/**
 * Shared types for the SRX game UI.
 * Imported by page.tsx (re-exported), EmpirePanel, ActionPanel, SrxGameScreen.
 */

export interface GameState {
  player: { id: string; name: string; isAI: boolean };
  game?: string;
  isYourTurn?: boolean;
  /** True when session is admin-staged and no turn is active yet. */
  waitingForGameStart?: boolean;
  currentTurnPlayer?: string | null;
  turnDeadline?: string | null;
  turnOrder?: { name: string; isAI: boolean }[];
  turnTimeoutSecs?: number;
  empire: {
    credits: number;
    food: number;
    ore: number;
    fuel: number;
    population: number;
    taxRate: number;
    civilStatus: number;
    civilStatusName: string;
    foodSellRate: number;
    oreSellRate: number;
    petroleumSellRate: number;
    netWorth: number;
    turnsPlayed: number;
    turnsLeft: number;
    isProtected: boolean;
    protectionTurns: number;
    turnOpen?: boolean;
    fullTurnsUsedThisRound?: number;
  };
  planets: {
    id: string;
    name: string;
    sector: number;
    type: string;
    typeLabel: string;
    population: number;
    longTermProduction: number;
    shortTermProduction: number;
    defenses: number;
    isRadiated: boolean;
  }[];
  planetSummary: Record<string, number>;
  army: {
    soldiers: number;
    generals: number;
    fighters: number;
    defenseStations: number;
    lightCruisers: number;
    heavyCruisers: number;
    carriers: number;
    covertAgents: number;
    commandShipStrength: number;
    effectiveness: number;
    covertPoints: number;
    soldiersLevel: number;
    fightersLevel: number;
    stationsLevel: number;
    lightCruisersLevel: number;
    heavyCruisersLevel: number;
  } | null;
  supplyRates: {
    rateSoldier: number;
    rateFighter: number;
    rateStation: number;
    rateHeavyCruiser: number;
    rateCarrier: number;
    rateGeneral: number;
    rateCovert: number;
    rateCredits: number;
  } | null;
  research: {
    accumulatedPoints: number;
    unlockedTechIds: string[];
  } | null;
  /** `simultaneous` = door-game (SRE-style) multi-full-turn days; omitted = legacy sequential. */
  turnMode?: "sequential" | "simultaneous";
  dayNumber?: number;
  actionsPerDay?: number;
  /** Full turns remaining this calendar round (tick→actions→end_turn each). */
  fullTurnsLeftToday?: number;
  turnOpen?: boolean;
  canAct?: boolean;
  roundEndsAt?: string | null;
}

export interface CombatSummary {
  type: string;
  target: string;
  victory: boolean;
  fronts?: { name: string; attackerWins: number; defenderWins: number; won: boolean }[];
  loot?: { planetsCaptures: number; creditsLooted: number; populationTransferred: number; oreLooted?: number; foodLooted?: number };
  attackerLosses: Record<string, number>;
  defenderLosses?: Record<string, number>;
  messages: string[];
  planetCasualties?: { planetName: string; populationKilled: number }[];
  populationKilledTotal?: number;
  planetsRadiatedCount?: number;
  planetsAffectedCount?: number;
  defenderCivilLevelsGained?: number;
  defenderEffectivenessLost?: number;
}

export interface TurnPopupData {
  mode: "turn_start" | "action_result" | "intel_report";
  turn: number;
  action: string;
  actionMsg: string;
  intelTarget?: string;
  income: { total: number; populationTax: number; urbanTax: number; tourism: number; foodSales: number; oreSales: number; petroSales: number; galacticRedistribution: number };
  expenses: { total: number; planetMaintenance: number; militaryMaintenance: number; galacticTax: number };
  population: { births: number; deaths: number; immigration: number; emigration: number; net: number; newTotal: number };
  resources: { foodProduced: number; foodConsumed: number; oreProduced: number; oreConsumed: number; fuelProduced: number; fuelConsumed: number };
  civilStatus: string;
  netWorth: number;
  events: string[];
  combat?: CombatSummary;
}

export interface GameOverData {
  standings: { name: string; isAI: boolean; netWorth: number; population: number; planets: number; credits: number; turnsPlayed: number; military: number }[];
  winner: string;
  playerRank: number;
  playerScore?: { name: string; netWorth: number; population: number; planets: number; credits: number; military: number };
  highScores: { playerName: string; netWorth: number; rank: number; totalPlayers: number; finishedAt: string }[];
}
