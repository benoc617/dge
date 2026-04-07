/**
 * AI name pool and randomizable strategy pool.
 *
 * Names and strategies are no longer fixed pairs — when an AI is created, a name
 * is drawn from AI_NAME_POOL and a persona is drawn independently from
 * AI_STRATEGY_POOL.  The player never knows which strategy a given commander uses.
 */

/** All persona keys that can be assigned to an AI player. */
export const AI_STRATEGY_POOL = [
  "optimal",
  "turtle",
  "economist",
  "researcher",
  "warlord",
  "diplomat",
  "spymaster",
] as const;

export type AIPersonaKey = (typeof AI_STRATEGY_POOL)[number];

/** Pool of AI commander names — the legendary Fighting Baseball roster. */
export const AI_NAME_POOL = [
  "Sleve McDichael",
  "Onson Sweemey",
  "Darryl Archideld",
  "Anatoli Smorin",
  "Glenallen Mixon",
  "Mike Truk",
  "Shown Furcotte",
  "Karl Dandleton",
  "Kevin Nogilny",
  "Tony Smehrik",
  "Bobson Dugnutt",
  "Willie Dustice",
  "Jeromy Gorden",
  "Scott Dourque",
  "Yung Jurtis",
  "Rey McSriff",
  "Dwigt Rortugal",
  "Tim Sandaele",
] as const;

export type AINameKey = (typeof AI_NAME_POOL)[number];
