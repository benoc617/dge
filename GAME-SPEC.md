# Solar Realms Extreme — Complete Game Specification

This document fully specifies the game mechanics, formulas, and data model of Solar Realms Extreme (SRX). It is intended to be complete enough to re-implement the game from scratch.

---

## 1. Overview

Solar Realms Extreme is a turn-based galactic empire management game inspired by the BBS-era classic Solar Realms Elite. Players manage an interstellar empire over 100 turns, balancing economy, population, military, diplomacy, espionage, research, and market trading. Each turn, the player takes exactly **one action**, and then the game engine processes a full turn tick that updates the empire's state.

---

## 2. Turn Structure

The engine always applies the **turn tick** (§3) before executing the **player action** (§4). Internally, one full `processAction` still ends with research points, loans, bonds, persistence, and turn log — but the tick may already have been persisted separately (see below).

### Two-phase turn (humans + API)

For human players and the split tick endpoint:

1. **`POST /api/game/tick`** (optional but used by the UI) — If `Empire.tickProcessed` is false, runs `processTurnTick`, persists empire/army/planet updates, sets `tickProcessed = true`, returns `{ turnReport }`. If the tick already ran, returns `{ alreadyProcessed: true }` without re-running.
2. **`POST /api/game/action`** — Executes the chosen action. If `tickProcessed` is true, skips re-running the tick (action only). If `tickProcessed` is false (e.g. simulation or legacy callers), runs the tick inline and may include `turnReport` in the response. On success, persists, sets `tickProcessed = false` for the next turn, logs, then the route advances turn order.

This lets the UI show a **situation report** (income, deficits, critical events) before the player commits their action. Failed actions do not advance the turn.

**AI players** call `runAndPersistTick` immediately before choosing an action, then `processAction` (no UI pause).

### Single `processAction` sequence (when tick not pre-persisted)

1. **Turn tick** (automatic, 19 steps — see §3)
2. **Player action** (one action chosen from §4)
3. **Research point accumulation** from research planets
4. **Loan payment processing**
5. **Bond maturity processing**
6. **Persist all changes to database**
7. **Write turn log**

The turn tick always runs before the player's action is executed in the same transaction of work — either in `runAndPersistTick` or at the start of `processAction`.

**Endgame settlement:** When `turnsLeft` reaches **0**, **`runEndgameSettlementTick`** runs **one** full **`processTurnTick`** from the **post–final-action** empire state (`ProcessTurnTickOptions.endgameSettlement: true` — does **not** increment `turnsPlayed`), then the same **research / loan / bond** finance pass used at the end of every `processAction`. Results are persisted and a **`TurnLog`** row is written with `action: endgame_settlement`. This applies the economy that would have started the **next** turn (production, maintenance, random events, etc.) so the last action is fully reflected without a second playable turn. **Sequential:** invoked at the end of **`processAction`** when the persisted empire has `turnsLeft === 0`. **Simultaneous:** **`processAction`** uses **`skipEndgameSettlement: true`**; **`closeFullTurn`** calls **`runEndgameSettlementTick`** after decrementing `turnsLeft` to 0 (before **`tryRollRound`**). Idempotent: skipped if an **`endgame_settlement`** log already exists for that player.

### Turn Order Enforcement

Turns are taken in strict sequential order within a session:

- Each player has a `turnOrder` (integer) set at creation time: 0 for the galaxy creator, 1+ for subsequent players (AI or human) in the order they were added.
- `GameSession.currentTurnPlayerId` stores the player ID of whoever is up. This is tracked by ID (not list index) so it is immune to players joining or being eliminated mid-round.
- **Lobby** (`waitingForHuman: true`, admin pre-staged galaxy): `getCurrentTurn` returns **null** — no tick, no actions. `POST /api/game/tick` and `POST /api/game/action` return **409** with `waitingForGameStart: true` when appropriate.
- Only the player matching `currentTurnPlayerId` can act when a turn exists. The tick API (`POST /api/game/tick`) and action API (`POST /api/game/action`) return **409** if `getCurrentTurn` is null for another reason ("No active turn"), or if it is another player's turn.
- After a player acts successfully, `currentTurnPlayerId` advances to the next active player by `turnOrder` (wrapping around). If the next player(s) are AI, the server starts `runAISequence` in the background (fire-and-forget); the client polls `GET /api/game/status` to see AI turns complete.
- **New players joining mid-game** get the next available `turnOrder` and are appended to the end of the rotation. They'll get their first turn after all existing players have finished the current cycle.
- If `currentTurnPlayerId` is null or points to an eliminated player, it auto-resolves to the first active player by `turnOrder`.
- The status API (`GET /api/game/status`) returns `isYourTurn` (boolean), `currentTurnPlayer` (name), `turnDeadline` (ISO string or **null** in lobby), `waitingForGameStart` when the session is still in admin lobby, and `turnOrder` (ordered list of all active players with name and isAI).
- If the current turn belongs to another human, the UI disables controls, shows "WAITING — [NAME]'S TURN", and polls about every 2 seconds.
- **Turn timer**: `GameSession.turnStartedAt` records when the current turn began (reset on every advance). `turnTimeoutSecs` is configurable at galaxy creation and in CFG (creator); default 86400 (24 hours). If `getCurrentTurn()` detects the current human player has exceeded their deadline, it runs `runAndPersistTick` if needed, then auto-executes `end_turn` and advances. The UI displays a live countdown in the header — yellow when it's your turn, red under 1 hour, gray when waiting for another player.

### Door-game / simultaneous mode (`GameSession.turnMode = simultaneous`)

**SRE-style “door game” play:** a **calendar round** (shown as **day** `dayNumber`) lasts until **every** active empire has used all of its **full turns** for that round (`actionsPerDay`, default **5**), **or** the **round timer** fires first. **Everyone can play at once** — humans are **not** blocked while AIs still owe daily full turns. **`GET /api/game/status`** schedules **`runDoorGameAITurns`** in the background whenever any AI still has daily slots left so AIs catch up while humans play.

**Round deadline:** when `now >= roundStartedAt + turnTimeoutSecs` (same **`turnTimeoutSecs`** as sequential games, default **86400**), **`tryRollRound`** treats remaining daily slots as **skipped** for any empire still short (`fullTurnsUsedThisRound` → `actionsPerDay`, `turnOpen` cleared). Each skipped slot also consumes **one** `turnsLeft` (same as a completed full turn). Emits **`GameEvent`** `round_timeout`, then the day can roll once all empires are marked done for the round.

- **One full turn** = one economy **`runAndPersistTick`** (with `decrementTurnsLeft: false`) + **one** mutating **`processAction`**; the **`POST /api/game/action`** handler closes the full turn automatically (`doorGameAutoCloseFullTurnAfterAction` + `closeFullTurn`) so players do not need a separate **`end_turn`** unless they skip without acting (**Skip Turn**). Mid-turn actions use `keepTickProcessed: true` so `tickProcessed` stays true until auto-close.
- **`Empire.turnOpen`:** true after the tick for that full turn has been applied, until `end_turn` + `closeFullTurn` runs.
- **`Empire.fullTurnsUsedThisRound`:** incremented when a full turn ends — explicit **`end_turn`** / Skip, or **automatic** close after any other successful action in simultaneous mode (`doorGameAutoCloseFullTurnAfterAction`). Up to **`actionsPerDay`** (default **5**) full turns per round per empire.
- **`POST /api/game/tick`** opens a full turn (`openFullTurn`) when allowed. **`POST /api/game/action`** is used for all actions (including simultaneous); mutating requests take a per-session **`pg_try_advisory_xact_lock`** inside a short transaction; **409** + `galaxyBusy` if the galaxy is busy.
- **`turnsPlayed`:** increments once per economy tick (once per **full turn** opened), not once per mid-turn action.
- **`turnsLeft`:** each empire’s `turnsLeft` decrements by **1** each time a full turn ends — in **`closeFullTurn`** (after **`end_turn`**, Skip, or auto-close following another action). Calendar day rollover **does not** batch-decrement everyone’s `turnsLeft`; length is driven by miniturn count, not by day count.
- **Round rollover (`tryRollRound`):** after optional timeout forfeit (charging `turnsLeft` for skipped slots as above), when every active empire has `fullTurnsUsedThisRound >= actionsPerDay`, resets `fullTurnsUsedThisRound`, `tickProcessed`, `turnOpen` for all empires in the session; increments `dayNumber`; sets **`roundStartedAt`** to now; emits **`GameEvent`** `day_complete`. **Immediately after** `day_complete`, **`tryRollRound`** kicks **`runDoorGameAITurns`** in the background (**does not** `await` inside the same call path as `withCommitLock`’s interactive transaction — awaiting AI drain there would exceed Prisma’s transaction timeout and return **500**). **`runDoorGameAITurns`** then runs **`drainDoorGameAiTurns`** so every AI exhausts its daily full-turn quota for the **new** day in one back-to-back batch once the galaxy commit has finished.
- **Status API** exposes `fullTurnsLeftToday`, `turnOpen`, `canAct`, `dayNumber`, `actionsPerDay`, `roundEndsAt` / `turnDeadline` (ISO countdown to **`roundStartedAt + turnTimeoutSecs`**). `currentTurnPlayerId` is **not** used for gating.
- **AI:** **`drainDoorGameAiTurns`** (via **`runDoorGameAITurns`**) runs AI full turns **sequentially** in `turnOrder` until no AI still owes daily slots (guard cap). **`runDoorGameAITurns`** wraps that drain with **`doorAiInFlight`** so overlapping kicks from **`tryRollRound`** (post-`day_complete`), a human **`after()`**, and **`GET /api/game/status`** serialize per session. **`runDoorGameAITurns`** runs after a human action (background `after()`) and from **`GET /api/game/status`** when any AI still has daily full turns left (mid-round catch-up). Each AI move is capped by a **wall-clock timeout** (`getAIMoveDecision` races a timer; on timeout the AI **end_turn**s that slot). If `processAiMoveOrSkip` takes the **skip** path (invalid action → `end_turn`), **`closeFullTurn` must still run** — same as a direct `end_turn` — or `turnOpen` stays true, `fullTurnsUsedThisRound` never increments, and the round can stall (`runOneDoorGameAI` pairs skip + success with `closeFullTurn`).
- **Repair:** `scripts/repair-door-game-session.ts` (`npm run repair:door-session`) can detect empires stuck with `turnOpen` + last `TurnLog` `end_turn` (`isStuckDoorTurnAfterSkipEndLog`) and apply `closeFullTurn` for legacy bad rows.

**Lobby:** `waitingForHuman` until first human; `roundStartedAt` is set at galaxy creation (register) or when the first human activates a pre-staged session (join).

---

## 3. Turn Tick (19 Steps)

### Step 1: Production Drift

Each planet has `longTermProduction` (baseline, 100 at creation) and `shortTermProduction` (current). Each turn, `shortTermProduction` drifts toward `longTermProduction`:

```
diff = longTermProduction - shortTermProduction
drift = ceil(|diff| × 0.1) × sign(diff)
shortTermProduction += drift
```

### Steps 2–3: Resource Production and Consumption

**Production** (per planet of matching type):

```
output = baseProduction × (shortTermProduction / 100)
output = alterNumber(round(output), 5%)    // ±5% variance
```

Total production is then reduced by civil penalty: `production × (1 - civilStatus × 0.05)`

Base production values per planet type:
| Planet Type | Base Production | Unit |
|-------------|----------------|------|
| FOOD | 200 | food |
| ORE | 125 | ore |
| PETROLEUM | 100 | fuel |

**Consumption:**

| Consumer | Formula |
|----------|---------|
| Population food | `population × 0.006` |
| Soldier food | `soldiers × 0.003` |
| General food | `generals × 0.003` |
| Fighter ore | `fighters × 0.005` |
| Station ore | `defenseStations × 0.01` |
| Light cruiser ore | `lightCruisers × 0.01` |
| Heavy cruiser ore | `heavyCruisers × 0.1` |
| Carrier ore | `carriers × 0.01` |
| Command ship ore | `1` (flat, if owned) |
| Fighter fuel | `fighters × 0.01` |
| Light cruiser fuel | `lightCruisers × 0.05` |
| Heavy cruiser fuel | `heavyCruisers × 0.1` |
| Carrier fuel | `carriers × 0.1` |
| Command ship fuel | `1` (flat, if owned) |

All consumption values get ±5% variance via `alterNumber`.

### Step 4: Auto-sell Resources

Players set sell rates (0–100%) for food, ore, and petroleum. **Defaults:** `foodSellRate` = 0; `oreSellRate` and `petroleumSellRate` = 50 (new empires). Each turn:

```
amountSold = floor((produced / 100) × sellRate)
revenue = round(amountSold × basePrice × marketRatio / 1.2)
```

Base prices: Food = 80, Ore = 120, Petroleum = 300 credits.

### Step 5: Income

| Source | Formula |
|--------|---------|
| Population tax | `alterNumber(floor(population × taxRate × 0.002), 5%)` |
| Urban tax | `urbanPlanets × 1200`, scaled by avg urban production, reduced by civil penalty ÷ 4 |
| Tourism | `tourismPlanets × 8000`, scaled by avg tourism production, reduced by full civil penalty |
| Food sales | From step 4 |
| Ore sales | From step 4 |
| Petroleum sales | From step 4 |
| Galactic redistribution | `coordinatorPool / playerCount / 200`, linearly ramped during first 20 turns |

### Step 6: Expenses

**Planet maintenance:**

```
perPlanetCost = 600 + turnsPlayed × 8
ohFactor = totalPlanets × 0.05
overheadMult = 1 + ohFactor + ohFactor² × 0.3
baseMaint = max(0, totalPlanets - govPlanets) × perPlanetCost × overheadMult
govReduction = floor((govPlanets × 4 / max(1, totalPlanets - govPlanets)) × baseMaint)
planetMaintenance = alterNumber(max(0, baseMaint - govReduction), 5%)
```

The superlinear overhead formula means maintenance grows quadratically with empire size. Government planets provide a reduction proportional to their ratio relative to non-government planets.

**Military maintenance** (credits per turn):

| Unit | Cost/unit |
|------|-----------|
| Soldier | 10 |
| General | 10 |
| Fighter | 30 |
| Defense station | 40 |
| Light cruiser | 30 |
| Heavy cruiser | 50 |
| Carrier | 25 |

Military maintenance gets ±5% variance.

**Galactic wealth tax:**

```
galacticTax = floor((credits + totalIncome) × 0.0005)
```

This tax is paid into the Coordinator Pool for redistribution.

### Steps 7–8: Apply Net Changes

```
credits += totalIncome - totalExpenses
food += foodProduced - foodConsumed - foodSold
ore += oreProduced - oreConsumed - oreSold
fuel += fuelProduced - fuelConsumed - petroSold
```

Market supplies and coordinator pool are updated accordingly.

### Step 9: Population Dynamics

**Births:**

```
bornPrime = population × 0.03
urbanBonus = sumOfAllUrbanPlanetProduction / 100 × 0.45
bornBase = bornPrime × urbanBonus
pollutionPenalty = bornBase × pollutionRatio
civilPenalty = bornBase × (civilStatus × 0.05)
taxMult = getTaxBirthMultiplier(taxRate)  // see table below
taxPenalty = bornPrime × urbanBonus × taxMult × taxRate × 0.002 × 0.5
births = max(0, round(bornBase - pollutionPenalty - civilPenalty - taxPenalty))
if food < 0: births = floor(births / 4)
births = alterNumber(births, 5%)
```

**Tax birth multiplier table:**

| Tax Rate | Multiplier |
|----------|-----------|
| 0–50% | 0.25 |
| 51–60% | 0.5 |
| 61–70% | 1.0 |
| 71–80% | 1.5 |
| 81–90% | 2.0 |
| 91–100% | 3.5 |
| >100% | 4.0 |

Higher tax = higher penalty to births.

**Deaths:**

```
deathsPrime = population × 0.008
deathsPollution = deathsPrime × pollutionRatio
deathsCivil = deathsPrime × (civilStatus × 0.05)
deaths = alterNumber(round(deathsPrime + deathsPollution + deathsCivil), 5%)
```

**Immigration** (from education planets):

```
immigBase = educationPlanets × 400
immigPollution = immigBase × pollutionRatio
immigCivil = immigBase × (civilStatus × 0.05)
immigTax = immigBase × taxRate × 0.002
immigration = alterNumber(max(0, round(immigBase - immigPollution - immigCivil - immigTax)), 5%)
```

**Emigration:**

```
urbanCapacity = urbanPlanets × 20000
overcrowdExcess = max(0, population - urbanCapacity)
emigOvercrowd = overcrowdExcess × 0.10
emigTax = population × taxRate × 0.001
emigCivil = population × civilStatus × 0.05
emigration = alterNumber(round(emigOvercrowd + emigTax + emigCivil), 5%)
```

**Net population:** `population = max(0, population + births + immigration - deaths - emigration)`

**Pollution calculation:**

```
pollutionFromPetro = floor(petroPlanets / 100 × avgPetroProd) × 0.1
pollutionFromPop = population × 0.000002
totalPollution = pollutionFromPetro + pollutionFromPop
antipollution = antiPollutionPlanets × 0.5 × (avgAntiPollutionProd / 100)
pollutionRatio = totalPollution / max(1, antipollution)
```

### Step 10: Civil Status

Civil status ranges from 0 (Peaceful) to 7 (Under Coup).

| Level | Name |
|-------|------|
| 0 | Peaceful |
| 1 | Mild Insurgencies |
| 2 | Occasional Riots |
| 3 | Violent Demonstrations |
| 4 | Political Conflicts |
| 5 | Internal Violence |
| 6 | Revolutionary Warfare |
| 7 | Under Coup |

**Excess covert agents check:**

```
maxCovert = govPlanets × 300
if covertAgents > maxCovert:
  50% chance: civilStatus += 1
  25% of excess agents die
```

**Military desertion** from civil unrest:

```
desertionRate = civilStatus × 8%
Applied to: soldiers, fighters, lightCruisers, heavyCruisers, carriers
```

**Civil recovery** (each turn, if credits ≥ 0 and food ≥ 0 and planets > 0):

```
recoveryChance = (covertAgents / (totalPlanets × 0.2)) × 100
if random roll ≤ recoveryChance: civilStatus -= 1
```

### Step 11: Deficit Consequences

**Food deficit (food < 0):**
- 20% population dies
- 10% soldiers and generals die
- civilStatus += 1
- Food set to 0

**Credits deficit (credits < 0):**
- ceil(totalPlanets × 10%) planets released
- 10% of all military units disbanded
- 20% chance civilStatus += 1
- Credits set to 0

**Ore deficit (ore < 0):**
- 10% of mechanical units (fighters, cruisers, carriers) disbanded
- 20% chance civilStatus += 1
- Ore set to 0

**Fuel deficit (fuel < 0):**
- 10% of fuel-consuming units disbanded
- 20% chance civilStatus += 1
- Fuel set to 0

### Step 12: Empire Collapse

Empire collapses if `population < 10` or `totalPlanets == 0`.

### Step 13: Net Worth

```
netWorth = floor(
  population × 0.0002 +
  credits × 0.000015 +
  totalPlanets × 2 +
  soldiers × 0.04 +
  fighters × 0.12 +
  defenseStations × 0.12 +
  lightCruisers × 0.12 +
  heavyCruisers × 0.20 +
  carriers × 0.25 +
  generals × 0.05 +
  covertAgents × 0.10
)
```

### Steps 14–16: Recovery and Growth

```
effectiveness = min(100, effectiveness + 2)
commandShipStrength = min(100, commandShipStrength + 5)  // only if > 0
covertPoints = min(50, covertPoints + 5)
```

### Step 17: Supply Planet Auto-Production

Supply planets automatically produce military units based on `SupplyRates` allocation (8 rates summing to 100%):

```
rawProd = sum(supplyPlanet.shortTermProduction) / 100
effProd = (rawProd + random × rawProd / 16) / 100
unitsProduced = floor(rate% × effProd × floor(8000 / unitCost))
```

Rates: `rateSoldier`, `rateFighter`, `rateStation`, `rateHeavyCruiser`, `rateCarrier`, `rateGeneral`, `rateCovert`, `rateCredits`.

**Research planets** also produce light cruisers:

```
lcProduced = floor(sum(researchPlanet.shortTermProduction / 100) × 5)
```

### Step 18: Random Events (10% chance)

Three equally likely events:
- Asteroid mining windfall: +~2000 credits (±20% variance)
- Refugee wave: +~1000 population (±20% variance)
- Bumper harvest: +~200 food (±20% variance)

### Step 19: Protection

New empires get 15 turns of protection (`isProtected`, `protectionTurns`). Decrements each turn; when `protectionTurns` reaches 0, `isProtected` becomes false.

**Enforcement:** While protected (`isProtected` and `protectionTurns > 0`), a rival **cannot** use player-targeting **`attack_conventional`**, **`attack_guerrilla`**, **`attack_nuclear`**, **`attack_chemical`**, **`attack_psionic`**, or **`covert_op`** against that empire — the action fails with a clear message. **`attack_pirates`** (PvE) is not blocked. The Galactic Powers panel shows `[PN]` when a commander still has protection turns.

---

## 4. Player Actions

One action per turn. Each action is processed after the turn tick.

### 4.1 Economy

#### `buy_planet`
- Parameter: `type` (one of 10 planet types)
- Cost: `round(baseCost × (1 + netWorth × 0.000001))`
- Creates a planet with random name, random sector (1–100), production 100/100

| Planet Type | Base Cost | Base Production | Role |
|-------------|-----------|-----------------|------|
| FOOD | 14,000 | 200 | Feeds population and soldiers |
| ORE | 10,000 | 125 | Feeds mechanical units |
| TOURISM | 14,000 | 8,000 | High credit income, fragile in war |
| PETROLEUM | 20,000 | 100 | Fuel production, causes pollution |
| URBAN | 14,000 | 100 | Exponential population growth, urban tax |
| EDUCATION | 14,000 | 100 | Linear immigration (+400/planet) |
| GOVERNMENT | 12,000 | 100 | Reduces maintenance, houses generals + covert agents |
| SUPPLY | 20,000 | 100 | Auto-produces military units |
| RESEARCH | 25,000 | 300 | Generates research points (300/turn) + light cruisers |
| ANTI_POLLUTION | 18,000 | 100 | Absorbs pollution from petroleum |

#### `set_tax_rate`
- Parameter: `rate` (0–100)
- Affects income, births, immigration, emigration

#### `set_sell_rates`
- Parameters: `foodSellRate`, `oreSellRate`, `petroleumSellRate` (each 0–100)
- Percentage of produced resources auto-sold on the market each turn

#### `set_supply_rates`
- Parameters: 8 rates summing to 100 (`rateSoldier`, `rateFighter`, `rateStation`, `rateHeavyCruiser`, `rateCarrier`, `rateGeneral`, `rateCovert`, `rateCredits`)
- Controls what supply planets produce

### 4.2 Military

#### `buy_soldiers`, `buy_generals`, `buy_fighters`, `buy_stations`, `buy_light_cruisers`, `buy_heavy_cruisers`, `buy_carriers`, `buy_covert_agents`
- Parameter: `amount`
- Cost: `amount × unitCost`

| Unit | Cost | Constraints |
|------|------|-------------|
| Soldier | 280 | None |
| General | 780 | Max `govPlanets × 50` |
| Fighter | 380 | None |
| Defense Station | 520 | None |
| Light Cruiser | 950 | None (also produced by Research planets) |
| Heavy Cruiser | 1,900 | None |
| Carrier | 1,430 | None |
| Covert Agent | 4,090 | Max `govPlanets × 300` |

#### `buy_command_ship`
- Cost: 20,000 credits
- Limit: 1 per empire
- Starts at strength 10, grows by 5/turn to max 100
- Boosts heavy cruiser strength in space combat

### 4.3 Combat

#### `attack_conventional`
- Requires: ≥ 1 general, target name
- 3-front sequential combat: space → orbital → ground
- Must win all 3 fronts (best of 5 rounds each) for victory
- Victory: capture 30–90% of defender's planets, credits, population
- See §5 for full combat formulas

#### `attack_guerrilla`
- Soldiers only, 5 rounds
- Defenders get 4× defense multiplier
- Low-cost harassment: damages enemy soldiers

#### `attack_nuclear`
- Cost: 500,000,000 credits per nuke
- Radiates target planets (-40 production), kills 40–65% population per planet

#### `attack_chemical`
- Requires: ≥ 10 covert agents
- Kills 15% population on up to 3 planets, radiates them
- 85% chance of Galactic Coordinator retaliation (10% of attacker's military destroyed)

#### `attack_psionic`
- Increases target's civil status by 2–3 levels
- Reduces target's effectiveness by 10–20%

#### `attack_pirates` (PvE)
- Pirates scale with player strength (40–90% of player's pirate-front strength)
- Victory: loot credits, ore, and food (scales with army strength and turns played)
- Defeat: lose 6–10% of soldiers and fighters

### 4.4 Espionage

#### `covert_op`
- Parameters: `target`, `opType` (0–9)
- Success chance: `min(95, max(5, (attackerAgents / max(1, defenderAgents)) × 50))`
- Detection chance: `min(80, max(10, (defenderAgents / max(1, attackerAgents)) × 40))`
- If detected: lose ~2% of agents

| Op | Name | Points | Effect on Success |
|----|------|--------|-------------------|
| 0 | Spy | 0 | Reveals target's credits, pop, planets, army (±15% accuracy) |
| 1 | Insurgent Aid | 1 | Target civil status +1 |
| 2 | Support Dissension | 1 | 5% of target's soldiers desert |
| 3 | Demoralize Troops | 1 | Target effectiveness -5 to -15% |
| 4 | Bombing Operations | 1 | Destroy 20% of target's food |
| 5 | Relations Spying | 0 | Reveals target's active treaties |
| 6 | Take Hostages | 1 | Steal 5% of target's credits |
| 7 | Carrier Sabotage | 1 | Destroy 10% of target's carriers (min 1) |
| 8 | Communications Spying | 1 | Reveals target's last 5 actions |
| 9 | Setup Coup | 2 | Target civil status +2, effectiveness -15% |

Covert points regenerate at 5/turn, max 50.

### 4.5 Diplomacy

#### `propose_treaty`
- Parameters: `target`, `treatyType`
- Treaty types: NEUTRALITY, FREE_TRADE, MINOR_ALLIANCE, TOTAL_DEFENSE, ARMED_DEFENSE_PACT, CRUISER_PROTECTION
- Duration: 20 turns, binding

#### `accept_treaty` / `break_treaty`
- Breaking a binding treaty: civil status +1

#### `create_coalition` / `join_coalition` / `leave_coalition`
- Max 5 members per coalition
- Leaving as last member dissolves the coalition

### 4.6 Market

#### `market_buy`
- Parameters: `resource` (food/ore/fuel), `amount`
- Cost: `round(amount × basePrice × marketRatio)`
- Buying raises market ratio: `ratio += amount × 0.00001` (capped at 4.0)

#### `market_sell`
- Revenue: `round(amount × basePrice × marketRatio / 1.2)`
- Selling lowers market ratio: `ratio -= amount × 0.00001` (floor 0.4)

Base prices: Food 80, Ore 120, Fuel 300.
Market starts with 500,000 of each resource, ratio 1.0.

### 4.7 Finance (Solar Bank)

#### `bank_loan`
- Amount: 1,000 to 999,999 (default 100,000)
- Interest: 50% + 10% per active loan
- Duration: 20 turns
- Max 3 active loans
- Each turn: `payment = floor(balance / turnsRemaining)`, plus interest
- 10% of loan payments go to lottery pool

#### `bank_repay`
- Early repayment of a specific loan

#### `buy_bond`
- Amount: min 1,000 (default 50,000)
- Interest: 10%
- Maturity: 30 turns
- Max 5 active bonds
- At maturity: receive `amount + floor(amount × 10 / 100)`

#### `buy_lottery_ticket`
- Cost: 10,000 per ticket (max 100)
- Win chance: 0.1% per ticket
- 25% of ticket cost goes to jackpot pool
- Winner receives entire pool

### 4.8 Research

#### `discover_tech`
- Parameter: `techId`
- Cost: tech's research point cost
- Prerequisites must be met (prior techs unlocked)
- Research points generated: `researchPlanets × 300` per turn

### 4.9 Other

#### `end_turn` (displayed as "Skip Turn" in UI)
- No additional action; just collect the turn tick income
- Since every other action already consumes a turn, this is specifically for when the player wants to take no action
- The "Skip Turn" button is displayed at the top of the Command Center panel, above the tab bar (not inside any tab)

#### `send_message`
- Parameters: `target`, `body`, optional `subject`

---

## 4.10 End of Game

When `turnsLeft` reaches 0, **`runEndgameSettlementTick`** first applies one final economy tick from the post–final-action state so that all purchases, attacks, and other changes from the last turn are fully resolved (production, maintenance, random events, loans, bonds, research RP — same as a normal tick but without incrementing `turnsPlayed`). A `TurnLog` row with `action: "endgame_settlement"` is persisted. See §2 for details. Then:

1. Client calls `POST /api/game/gameover` with the player name
2. Server fetches all players + empires + armies, computes final standings sorted by net worth
3. Each player's final score is recorded in the `HighScore` table (persists across games)
4. Returns: standings array, winner name, player rank, and top 10 all-time high scores
5. Client displays the `GameOverScreen` modal with:
   - Victory/defeat banner (personalized based on whether the player won)
   - Full final standings table with Rank, Commander, Net Worth, Population, Planets, Military
   - Player empire summary (credits, population, planets, military, rank)
   - All-time high score leaderboard
   - "Export Game Log" button → downloads complete JSON log via `GET /api/game/log`
   - "New Game" button → reloads the page

### High Scores

The `HighScore` model stores: `playerName`, `netWorth`, `population`, `planets`, `turnsPlayed`, `rank`, `totalPlayers`, `finishedAt`. Scores persist across games and are displayed in the game-over screen and available via `GET /api/game/highscores`.

### Game Log Export

`GET /api/game/log` returns a complete JSON dump of the game:
- All players with final empire state (resources, population, army, research, planet breakdown)
- Every `TurnLog` entry (player, action, details, timestamp) in chronological order
- Every `GameEvent` (type, message, details, timestamp) in chronological order
- Export timestamp and requesting player name

---

## 5. Combat System

### 5.1 Unit Tier System

Each unit type has 3 tiers (0, 1, 2) unlocked via research. Higher tiers have stronger front multipliers.

**Unit multiplier table** — `[tier0, tier1, tier2]` per front:

| Unit | Guerrilla | Ground | Orbital | Space | Pirate |
|------|-----------|--------|---------|-------|--------|
| Soldiers | 1.0, 1.5, 0.5 | 1.0, 1.0, 2.0 | 0, 0, 1.0 | 0, 0, 0 | 0.5, 1.0, 2.0 |
| Fighters | 0, 0, 0 | 0.5, 0.5, 0.5 | 1.0, 2.0, 3.0 | 0, 1.0, 1.0 | 0.5, 1.0, 2.0 |
| Defense Stations | 0, 0, 0 | 0.5, 0.5, 1.0 | 1.0, 2.0, 1.0 | 0, 0, 1.0 | 0.5, 1.0, 2.0 |
| Light Cruisers | 0, 0, 0 | 0, 0.1, 0.2 | 1.0, 2.0, 3.0 | 1.0, 1.0, 1.0 | 0.5, 1.0, 2.0 |
| Heavy Cruisers | 0, 0, 0 | 0, 0, 0.5 | 1.0, 1.0, 1.0 | 1.0, 2.0, 3.0 | 0.5, 1.0, 2.0 |

### 5.2 Front Strength Calculation

```
strength = Σ (unitCount × tierMultiplier[front])
if front == "space" and commandShip > 0:
  strength += heavyCruisers × (commandShipStrength / 100)
strength × (effectiveness / 100)
strength × (1 + random × 0.20)   // ±20% randomness
```

### 5.3 Conventional Invasion

**Sequence:** space → orbital → ground (must win each to advance)

Per front: **5 rounds** (best of 5 wins the front). Must win ≥ 3 rounds.

```
attackerStrength = calcFrontStrength(attacker, front)
defenderStrength = calcFrontStrength(defender, front) × 1.5   // defense bonus

// Light cruiser bonus: first 3 rounds of space, attacker gets ×1.2
if front == "space" and round < 3:
  attackerStrength × 1.2
```

Winner of each round inflicts casualties:
- Winning side: casualty rate = `min(0.3, (winnerStr / max(1, loserStr)) × 0.05)`
- Losing side takes this rate; winning side takes `rate × 0.3`

**Victory loot** (if attacker wins all 3 fronts):
```
capturePercent = random(30%, 90%)
planetsCaptures = max(1, floor(defenderPlanets × capturePercent / 100))
creditsLooted = floor(defenderCredits × capturePercent / 100)
populationTransferred = floor(defenderPopulation × capturePercent / 100)
```

Defender's civil status +1 on loss.

### 5.4 Guerrilla Attack

5 rounds, soldiers only.

```
attackerStrength = soldiers × tierMultiplier × (effectiveness / 100) × (1 + random × 0.20)
defenderStrength = soldiers × 4 × (effectiveness / 100) × (1 + random × 0.20)

damageToDefender = ceil(defenderSoldiers × 0.02 × (atkStr / (atkStr + defStr)))
damageToAttacker = ceil(attackerSoldiers × 0.05 × (defStr / (atkStr + defStr)))
```

### 5.5 Nuclear Strike

Cost: 500,000,000 per nuke. Each nuke targets one planet:
- Planet becomes radiated
- Production -40 (both long-term and short-term)
- Population killed: `floor(planetPopulation × (40 + random × 25) / 100)`
- Defender civil status +2
- **`runNuclearStrike`** returns **`planetCasualties`**: `{ planetId, planetName, populationKilled }[]` (one entry per nuke), **`populationKilled`** (sum), and **`planetsRadiated`** (IDs). Used for action messages, `actionDetails.combatResult`, and UI.

### 5.6 Chemical Warfare

Requires ≥ 10 covert agents. Hits up to 3 planets:
- 15% population killed per planet
- Planets become radiated
- 85% chance Coordinator retaliates: 10% of attacker's soldiers, fighters, heavy cruisers destroyed
- **`runChemicalWarfare`** returns **`planetCasualties`** (same shape as nuclear) plus **`planetsAffected`** (IDs). Retaliation losses applied in `game-engine.ts` are reflected in **`actionDetails.combatResult.attackerLosses`** (actual pre/post deltas).

### 5.7 Psionic Bomb

- Target civil status increases by 2–3 levels
- Target effectiveness decreases by 10–20%

### 5.8 Pirate Raid (PvE)

```
playerStrength = calcFrontStrength(army, "pirate")
pirateDifficulty = 0.4 + random × 0.5    // 40-90% of player strength
pirateStrength = max(30, playerStrength × pirateDifficulty)
```

Victory if `playerStrength > pirateStrength`:
```
lootCredits = alterNumber(round(3000 + playerStrength × 15 + turnsPlayed × 40), 25%)
lootOre = alterNumber(round(100 + playerStrength × 0.8), 25%)
lootFood = alterNumber(round(50 + playerStrength × 0.5), 25%)

casualtyRate = max(0.005, 0.04 / dominance)   // dominance = playerStr / pirateStr
```

Defeat: 6–10% of soldiers and fighters lost.

Effectiveness: +15 on win, -5 on loss.

---

## 6. Technology Tree

5 categories, 22 technologies. Research planets generate 300 points/turn. Technologies have costs, prerequisites, and permanent or temporary effects.

### Agriculture
| ID | Name | Cost | Prereqs | Effect |
|----|------|------|---------|--------|
| agri_1 | Improved Hydroponics | 8,000 | — | +10% food production (permanent) |
| agri_2 | Drought Resistance | 25,000 | agri_1 | +5% food production (permanent) |
| agri_3 | Bumper Harvest Protocol | 15,000 | agri_1 | +25% food production (15 turns) |

### Industry
| ID | Name | Cost | Prereqs | Effect |
|----|------|------|---------|--------|
| ind_1 | Advanced Mining | 10,000 | — | +10% ore production (permanent) |
| ind_2 | Refined Petroleum | 18,000 | ind_1 | +10% petroleum production (permanent) |
| ind_3 | Efficient Maintenance | 35,000 | ind_1 | -15% planet maintenance (permanent) |
| ind_4 | Tourism Boom | 12,000 | — | +100% tourism income (10 turns) |

### Military
| ID | Name | Cost | Prereqs | Effect |
|----|------|------|---------|--------|
| mil_soldiers_1 | Soldier Training I | 20,000 | — | Soldiers → Tier 1 |
| mil_soldiers_2 | Soldier Training II | 60,000 | mil_soldiers_1 | Soldiers → Tier 2 |
| mil_fighters_1 | Fighter Upgrades I | 25,000 | — | Fighters → Tier 1 |
| mil_fighters_2 | Fighter Upgrades II | 75,000 | mil_fighters_1 | Fighters → Tier 2 |
| mil_stations_1 | Station Fortification I | 30,000 | — | Stations → Tier 1 |
| mil_stations_2 | Station Fortification II | 90,000 | mil_stations_1 | Stations → Tier 2 |
| mil_hc_1 | Heavy Cruiser Refit I | 45,000 | — | Heavy Cruisers → Tier 1 |
| mil_hc_2 | Heavy Cruiser Refit II | 120,000 | mil_hc_1 | Heavy Cruisers → Tier 2 |
| mil_cmd_1 | Command Ship Upgrade I | 70,000 | mil_hc_1 | 2× command ship heavy cruiser bonus |

### Society
| ID | Name | Cost | Prereqs | Effect |
|----|------|------|---------|--------|
| soc_1 | Population Initiative | 8,000 | — | +10% population growth (permanent) |
| soc_2 | Civil Stability Program | 20,000 | soc_1 | -20% civil unrest effects (permanent) |
| soc_3 | Economic Stimulus | 15,000 | — | +15% credits income (20 turns) |

### Deep Space
| ID | Name | Cost | Prereqs | Effect |
|----|------|------|---------|--------|
| ds_lc_1 | Light Cruiser Upgrades I | 45,000 | — | Light Cruisers → Tier 1 |
| ds_lc_2 | Light Cruiser Upgrades II | 120,000 | ds_lc_1 | Light Cruisers → Tier 2 |
| ds_research | Research Accelerator | 35,000 | — | +25% research speed (permanent) |

---

## 7. Starting State

New empires begin with:

| Resource | Amount |
|----------|--------|
| Credits | 10,000 |
| Food | 800 |
| Ore | 400 |
| Fuel | 150 |
| Population | 25,000 |
| Tax rate | 25% |
| Turns | 100 |
| Protection turns | 20 |
| Sell rates | All 0% |

**Starting planets:** 2 Food, 2 Ore, 2 Urban, 1 Government (7 total)

**Starting military:** 100 soldiers, 2 generals, 10 fighters

**Army stats:** Effectiveness 100%, all unit tiers at 0, covert points 0, no command ship.

---

## 8. Data Model

### UserAccount
- `id`, `username` (unique, stored lowercase), `fullName`, `email` (unique), `passwordHash` (bcrypt), `lastLoginAt` (DateTime?, updated on successful `POST /api/auth/login` and on resume via `POST /api/game/status` when linked to an account), timestamps
- Optional 1:many with `Player` via `Player.userId`

### Player
- `id`, `name`, `passwordHash` (bcrypt, nullable for AI/legacy), `isAI`, `aiPersona`, `turnOrder` (Int, position in session's turn sequence), `gameSessionId` (nullable), `userId` (optional FK to `UserAccount`), timestamps
- `@@unique([name, gameSessionId])` — names are unique within a game session, but can repeat across sessions
- 1:1 with Empire

### Empire
- `id`, `playerId` (unique)
- `tickProcessed` (boolean, default false) — true after the current turn's tick has been persisted for this empire; reset when the action completes successfully. Used to split tick vs action for the UI and AI.
- `pendingDefenderAlerts` (string[], default `[]`) — messages queued when this empire is the **defender** in another player's military attack, covert op, or relevant diplomacy (treaty proposed / accepted / broken). On the next `processTurnTick`, each line is prepended to the situation report `events` as `ALERT: …`, then the array is cleared. Stealth intel-only covert ops (e.g. Spy) notify the defender only if the attacker's agents were **detected**; destructive or visible ops always notify when successful. **Persistence:** clearing the queue uses Prisma’s scalar-list `{ set: [] }` (not a raw `[]` in `update` data) — see `src/lib/empire-prisma.ts` (`toEmpireUpdateData`).
- Resources: `credits`, `food`, `ore`, `fuel`
- Population: `population`, `taxRate`, `civilStatus` (0–7)
- Sell rates: `foodSellRate`, `oreSellRate`, `petroleumSellRate` (0–100; defaults 0 / 50 / 50)
- Progress: `netWorth`, `turnsPlayed`, `turnsLeft`
- Protection: `isProtected`, `protectionTurns`
- Relations: 1:many `Planet[]`, 1:1 `Army`, 1:1 `SupplyRates`, 1:1 `Research`

### Planet
- `id`, `empireId`, `name`, `sector` (1–100)
- `type`: FOOD | ORE | TOURISM | PETROLEUM | URBAN | EDUCATION | GOVERNMENT | SUPPLY | RESEARCH | ANTI_POLLUTION
- `population`, `longTermProduction`, `shortTermProduction` (both default 100)
- `defenses`, `isRadiated`

### Army
- `id`, `empireId` (unique)
- Units: `soldiers`, `generals`, `fighters`, `defenseStations`, `lightCruisers`, `heavyCruisers`, `carriers`, `covertAgents`
- Tiers: `soldiersLevel`, `fightersLevel`, `stationsLevel`, `lightCruisersLevel`, `heavyCruisersLevel` (0–2)
- Stats: `commandShipStrength` (0–100), `effectiveness` (0–100), `covertPoints` (0–50)

### SupplyRates
- `id`, `empireId` (unique)
- 8 rates summing to 100: `rateSoldier` (40), `rateFighter` (20), `rateStation` (10), `rateHeavyCruiser` (0), `rateCarrier` (0), `rateGeneral` (10), `rateCovert` (10), `rateCredits` (10)

### Research
- `id`, `empireId` (unique)
- `accumulatedPoints`, `unlockedTechIds` (string array)

### Market (global singleton)
- `foodSupply` (500K), `oreSupply` (500K), `petroSupply` (500K)
- `foodRatio` (1.0), `oreRatio` (1.0), `petroRatio` (1.0)
- `coordinatorPool`, `lotteryPool`

### Treaty
- `fromEmpireId`, `toEmpireId`
- `type`: NEUTRALITY | FREE_TRADE | MINOR_ALLIANCE | TOTAL_DEFENSE | ARMED_DEFENSE_PACT | CRUISER_PROTECTION
- `status`: PENDING | ACTIVE | EXPIRED | BROKEN
- `turnsRemaining` (20), `isBinding`

### Coalition
- `name` (unique), `leaderId`, `memberIds` (string array), `maxMembers` (5)

### Convoy
- `fromEmpireId`, `toEmpireId`, `type` (TRADE | MILITARY | COLONIZATION)
- `contents` (JSON), `turnsRemaining` (5), `sectorFrom`, `sectorTo`

### Message
- `fromPlayerId`, `toPlayerId`, `subject`, `body`, `isRead`

### Loan
- `empireId`, `principal`, `balance`, `interestRate` (50), `turnsRemaining` (20)

### Bond
- `empireId`, `amount`, `interestRate` (10), `turnsRemaining` (30)

### TurnLog
- `playerId`, `action`, `details` (JSON), timestamp
- `details` typically includes `params`, `actionMsg`, and either `report` (full tick/economy snapshot for that action) **or** `tickReportDeferred: true` when the income tick already ran in `POST /api/game/tick` / `runAndPersistTick` — in that case the economy is not duplicated in the log row (avoids all-zero “fake” reports).
- For **AI** actions, `details` may include `llmSource`: `gemini` | `fallback` and `aiReasoning` (string) — same semantics as `GameEvent` `ai_turn` `details.llmSource`.
- **`aiTiming`** (optional, JSON): **`getAIMove`** — `{ configMs, generateMs, totalMs }` (`generateMs` is the Gemini `generateContent` call when `llmSource` is `gemini`; **0** for fallback). **`runOneAI`** — `{ contextMs, getAIMoveMs }` only (DB `Player` + rival query; wall time for `getAIMove`). Full **execute** / **total** wall time for the AI turn is **`GameEvent.details.aiTiming.runOneAI`** (below), not duplicated on `TurnLog` because the turn log row is written before `processAction` finishes.

### GameEvent
- `gameSessionId` (optional) — when set, the event belongs to that session (combat, diplomacy, lottery, **`ai_turn`** with `details.llmSource` = `gemini` | `fallback`). Older rows may have null (global / legacy).
- `type`, `message`, `details` (JSON), timestamp
- **`ai_turn` messages** are prefixed `[gemini]` or `[fallback]` so logs show whether the Gemini API produced the move or rule-based `localFallback` ran (API missing, invalid JSON, or invalid action name).
- **`ai_turn` `details.aiTiming`** (sequential `runOneAI` only): full breakdown — **`getAIMove`** (same as above) plus **`runOneAI.executeMs`** (`processAction` / `processAiMoveOrSkip` body) and **`runOneAI.totalMs`** (context + `getAIMove` + execute). Use this for latency analysis or exports; door-game / `/api/ai/turn` only persist **`getAIMove`** on `TurnLog`.

### HighScore
- `playerName`, `netWorth`, `population`, `planets`, `turnsPlayed`, `rank`, `totalPlayers`, `finishedAt`
- Created for every player at game end; persists across games

### GameSession
- `id`, `galaxyName` (unique, optional), `createdBy` (player name or `"admin"` for pre-staged galaxies), `isPublic` (default true), `inviteCode` (unique, auto-generated 8-char hex), `maxPlayers` (default **50**, clamped **2–128** on create and on `PATCH`), `currentTurnPlayerId` (String?, ID of the player whose turn it is; **null** in admin lobby until first human joins), `turnStartedAt` (**DateTime?** — **null** while `waitingForHuman` is true; no turn timer until first human activates), `turnTimeoutSecs` (Int, default 86400)
- **`waitingForHuman`** (Boolean, default false) — **true** for admin-created pre-staged galaxies until the first human player joins. While true, `getCurrentTurn` returns **null** (no actions, no tick, no timer).
- `playerNames[]`, `totalTurns`, `status` (active/finished), `winnerId`, `winnerName`, `finalScores` (JSON), `log` (JSON[]), timestamps
- `players` — 1:many relation to `Player` via `Player.gameSessionId`, ordered by `Player.turnOrder`

**Admin lobby:** `POST /api/admin/galaxies` (authenticated) creates a session with `waitingForHuman: true`, `turnStartedAt: null`, `currentTurnPlayerId: null`, optional AI empires at turn 0. First human `POST /api/game/join` activates play (human `turnOrder: 0`, AIs bumped), sets `waitingForHuman: false`, `currentTurnPlayerId`, `turnStartedAt: now()`.

---

## 9. AI System

AI players use Google Gemini to make decisions (model configurable via `GEMINI_MODEL` env var, default `gemini-2.5-flash`). Each AI has a persona string injected into the prompt. When no Gemini API key is available, a local rule-based fallback makes persona-aware strategic decisions (economy expansion, military builds, etc.) without any external API call.

### 5 AI Personas

| Name | Strategy |
|------|----------|
| Economist | Maximize wealth; contest the net-worth leader with economy, covert, and attacks when advantaged (not passive). |
| Warlord | Rush military; frequent attacks, prefer decisive strikes on the strongest threat / leader when possible. |
| Spy Master | Government planets → covert agents → destabilize targets → attack when civil status is high. |
| Diplomat | Treaties and coalitions. Peaceful expansion. Only attack isolated empires. |
| Turtle | Maximum defense; contest a runaway leader with decisive attacks when they are vulnerable; counter-attack hard. |

### AI Setup Flow

When a player creates a new galaxy from the Command Center hub, **galaxy session settings** (name, visibility, timer, max players) and **optional AI rivals** (toggle any of the 5 personas, or none for solo) are configured on **one screen**. After `POST /api/game/register` succeeds, if at least one AI is selected the client immediately calls `POST /api/ai/setup` with a `names` array, then enters the game. AI turns run automatically — see Turn Order below.

### AI Prompt Structure

The prompt includes: persona text, full empire state (credits, resources, population, tax, planets summary, army, research), recent game events (last 8), all available actions with cost reference, and critical tactical rules. **Rival targeting** lists all rival commanders uniformly (no human-vs-AI priority). `pickRivalOpponent` chooses uniformly among `rivalNames`.

AI responds with JSON: `{ action, type?, target?, amount?, rate?, techId?, reasoning }`.

**Invalid AI actions (validation failure, insufficient credits, protected target, etc.):** The engine runs `processAction` for the chosen action; if it returns `success: false`, the server immediately runs `processAction(..., "end_turn")` via `processAiMoveOrSkip` in `src/lib/ai-process-move.ts` — same fairness as a human using Skip Turn after a bad attempt. The persisted `TurnLog` is for `end_turn`; `TurnLog.details` may include `skippedAfterInvalid`, `invalidAction`, and `invalidMessage`. `GameEvent` `ai_turn` text appends ` — skipped turn.` to the failure message when the skip path succeeds. **Door-game / simultaneous:** the caller (`runOneDoorGameAI`) must invoke `closeFullTurn` after a successful skip — sequential `runOneAI` does not use `closeFullTurn` because it uses a different turn model.

On parse failure: defaults to `end_turn`.

---

## 10. Randomness

All randomness uses a seedable PRNG (mulberry32 algorithm) via `src/lib/rng.ts`. In production, it uses `Math.random()` (unseeded). For simulations, calling `setSeed(n)` makes all game outcomes deterministic and reproducible.

The `alterNumber(value, variancePct)` function adds ±variance to any value:
```
factor = 1 + (random × 2 - 1) × (variancePct / 100)
return round(value × factor)
```

---

## 11. Planet Name Generation

Names follow the pattern: `{Prefix} {Root}{optional Numeral}`

- **Prefixes** (24): New, Alpha, Beta, Gamma, Delta, Epsilon, Sigma, Tau, Outer, Inner, Upper, Far, Near, North, South, Old, Prime, Ultra, Bright, Dark, Greater, Lesser, High, Deep
- **Roots** (34): Terra, Kepler, Orion, Vega, Sirius, Rigel, Centauri, Cygnus, Lyra, Draco, Phoenix, Hydra, Corvus, Aquila, Antares, Polaris, Arcturus, Deneb, Altair, Castor, Procyon, Regulus, Spica, Mira, Capella, Nexus, Axiom, Kronos, Helios, Theron, Atlas, Titan, Forge, Haven
- **Numerals** (50% chance): I, II, III, IV, V, VI, VII

---

## 12. UI & Components

The game is a single-page app (`src/app/page.tsx`) with a 3-column layout (3-5-4 grid on lg screens) and a monochrome terminal/BBS aesthetic (black background, green-400 text, yellow-400 accents).

### Layout

| Region | Span | Component | Description |
|--------|------|-----------|-------------|
| Header | 12 | `page.tsx` | Galaxy name, **whose turn** (`▸ YOUR TURN` or `▸ [NAME]'S TURN`), **turn timer** (24h countdown, red under 1h), **credits**, turn counter (`T5 (95 left)`), protection badge, commander name. |
| Top | 12 | `Leaderboard.tsx` | Galactic Powers ranking with column headers (Rk, Commander, **Prt** on sm+, Worth, Pop, Plt, Turns, Mil). **Turns** = `Empire.turnsPlayed` (economy ticks). **Prt** shows `[PN]` when the commander has new-empire protection. Click a rival to auto-select them as target. |
| Left | 3 | `EmpirePanel.tsx` | Compact stat-box grid: Net Worth + Civil Status boxes, 4-col resource grid, population/tax, sell rates inline, military mini-stats (4-col), planet type badges, collapsible planet details. |
| Center | 5 | `ActionPanel.tsx` | "Skip Turn" button at top (disabled with "WAITING — [NAME]'S TURN" when not your turn), then 7-tabbed action panel (ECON, MIL, WAR, OPS, MKT, RES, CFG). ECON tab shows planet cards with descriptions + cost + owned count. MIL tab includes light cruisers (950 cr). CFG tab: **GAME SESSION** (galaxy name, invite code with copy, visibility toggle for creator) + **TURN ORDER** (numbered list of all players, current highlighted, `[AI]` tags). Target fields use `<select>` dropdowns. |
| Right | 4 | `EventLog.tsx` | Scrolling event log with color-coded turn reports (income green, expenses red, population cyan, events yellow). AI turn summaries appear after each action. |

### Turn Summary Popup (`TurnSummaryModal`)

Two modes:

1. **Turn start — situation report** — Shown after `POST /api/game/tick` when it becomes your turn. Title e.g. "TURN N — SITUATION REPORT", button "CHOOSE ACTION". Full income/expense/population/resources and **critical event** banner (red) for starvation, fuel deficit, ore deficit, bankruptcy, civil unrest, protection ended, **`ALERT:` lines** (hostile actions against you since your last turn), etc. (`src/lib/critical-events.ts`).

2. **After combat** — When an attack completes, a compact modal can show combat results only (`actionDetails.combatResult` from `processAction`).

Dismissible via Enter, Space, Escape, or clicking outside.

Combat data is returned from `processAction()` via `actionDetails.combatResult` for all 6 attack types (conventional, guerrilla, nuclear, chemical, psionic, pirate raid).

- **Loss reporting** — The action `message` string and `actionDetails.combatResult` enumerate outcomes: conventional/guerrilla/pirate include per-unit `attackerLosses` / `defenderLosses` (army field keys); nuclear and chemical include `planetCasualties[]` (`planetName`, `populationKilled`) plus totals; psionic includes `defenderCivilLevelsGained` and `defenderEffectivenessLost`. Formatting helpers live in `src/lib/combat-loss-format.ts`.
- **Combat modal** — After an attack, `TurnSummaryModal` shows labeled blocks: **YOUR LOSSES**, **TARGET UNIT LOSSES** (when the defender lost units), **SPOILS OF WAR** / loot, **PLANET CASUALTIES** (nuclear/chemical), **PSIONIC EFFECT ON TARGET** (psionic).

### Authentication

**Accounts:** `POST /api/auth/signup` creates a `UserAccount` (`username`, `fullName`, `email`, `password` + confirm; signup password minimum **8** characters). `POST /api/auth/login` verifies the account password and returns `{ user, games }` where `games` lists active `Player` rows for that account (with turn/session summary).

**In-game passwords:** If a `UserAccount` exists for the normalized `name`, `POST /api/game/register` and `POST /api/game/join` require that password to match the account; the same bcrypt hash is stored on `Player.passwordHash` and `userId` is set. **Legacy** players without a `UserAccount` still use a password of at least **3** characters (bcrypt on `Player`).

- **Registration** (`POST /api/game/register`): requires `{ name, password }`. Optionally accepts `galaxyName`, `isPublic`, `turnTimeoutSecs`, **`maxPlayers`** (clamped 2–128, default 50). Creates a `GameSession` with an auto-generated 8-char invite code. Returns `gameSessionId`, `inviteCode`, `galaxyName`, `isPublic`, `maxPlayers`.
- **Join** (`POST /api/game/join`): requires `{ name, password }` plus either `inviteCode` or `sessionId`. Validates the session is active and not full. Creates a new player in the existing session.
- **Resume** (`POST /api/game/status`): requires `{ name, password }`. Verifies bcrypt hash. Rejects:
  - Unknown players or AI players (404 — query filters for `isAI: false`)
  - Finished games where `turnsLeft <= 0` (410 Gone — "This game is over")
  - Wrong password (401)
- **Subsequent refreshes** (`GET /api/game/status?id=<playerId>` or `?player=name`): unauthenticated — used by the UI after initial login. Returns `isYourTurn`, `currentTurnPlayer`, `turnDeadline`, and `turnOrder` alongside full empire state. The `?id=` form is preferred for polling.
- Legacy players without a `passwordHash` are allowed through on resume (backward compatibility).

### Lobby System

- **Public lobbies** (`GET /api/game/lobbies`): returns up to 50 active public sessions with galaxy name, creator, player count, max players.
- **Session info** (`GET /api/game/session?id=`): returns session details including invite code (for display in CFG tab).
- **Session settings** (`PATCH /api/game/session`): creator-only. Accepts `{ sessionId, playerName, isPublic, maxPlayers, turnTimeoutSecs }`. `maxPlayers` is clamped **2–128**. Toggles visibility between public and private; optional per-session turn timer.
- Every session gets a unique invite code on creation. Share the code to let others join even private games.
- **`GET /api/game/leaderboard?player=`** — session-scoped when `player` is set. Each row includes `turnsPlayed`, `isProtected`, `protectionTurns`, `military`, `civilStatus`, etc.

### AI & auxiliary game HTTP routes

| Route | Purpose |
|-------|---------|
| `POST /api/ai/setup` | Body `{ names: string[], gameSessionId }` — creates the selected AI commanders in the session (used from the game-setup UI). |
| `POST /api/ai/run-all` | Body `{ gameSessionId }` (required). Runs `runAISequence`: executes every **consecutive** AI turn starting from `getCurrentTurn` until the next player is human or the safety cap is hit. Returns `{ results: { name, action, message }[] }`. If it is currently a human’s turn, **`results` is empty** (no Gemini work). |
| `POST /api/ai/turn` | Body `{ playerName }` — finds the latest `isAI` player with that name, runs one full AI turn via `getAIMove` + `processAction` (Gemini or local fallback). Returns `{ move, result }`. Returns **400** if the player is not an AI or has no turns left. Intended for debugging / tooling. |
| `POST /api/game/gameover` | Body `{ playerName }` — resolves the human player’s session, computes final standings, writes **`HighScore`** rows, marks **`GameSession`** finished (`status`, `winnerId`, `finalScores`, `finishedAt`). Returns `{ gameOver, standings, winner, playerRank, playerScore, highScores }`. |

### Admin API (server-only)

Environment: `ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` (defaults **`admin`** / **`srxpass`**), optional `ADMIN_SESSION_SECRET` for signing the session cookie (defaults align with initial password). **`DATABASE_URL`** is **only** read from the environment (required for Prisma and migrations). **`GEMINI_API_KEY`** / **`GEMINI_MODEL`** can be overridden by **`SystemSettings`** when set.

**`SystemSettings`** singleton (`id = "default"`): optional `geminiApiKey`, `geminiModel` (default `gemini-2.5-flash`). Postgres connection is **not** stored in the database.

| Route | Purpose |
|-------|---------|
| `POST /api/admin/login` | Body `{ username, password }`. Sets httpOnly `admin_session` cookie. |
| `POST /api/admin/logout` | Clears cookie. |
| `GET /api/admin/me` | 200 if authenticated, else 401. |
| `GET /api/admin/galaxies` | Lists active `GameSession` rows with human/AI counts, `waitingForHuman`, invite code, timer fields. |
| `POST /api/admin/galaxies` | Body `{ galaxyName?, isPublic?, aiNames? }`. Creates pre-staged lobby + optional AIs. |
| `DELETE /api/admin/galaxies` | Body `{ ids: string[] }` — deletes each session (and related rows) via `deleteGameSession` in `src/lib/delete-game-session.ts`. Returns `{ deleted, results: { id, ok }[] }`. |
| `POST /api/admin/password` | Body `{ currentPassword, newPassword }` (min 8 chars). Requires admin cookie. Stores bcrypt hash in **`AdminSettings`** (`id = "admin"`). If no row exists, login uses **`INITIAL_ADMIN_PASSWORD`** env (default `srxpass`). Username is always **`ADMIN_USERNAME`** env only (not changeable in UI). |
| `GET /api/admin/settings` | Requires admin cookie. Returns masked Gemini key preview and `geminiModel`. |
| `PATCH /api/admin/settings` | Partial update: `geminiApiKey`, `geminiModel` (use `null` to clear key). |
| `GET /api/admin/users` | Requires admin cookie. Lists all `UserAccount` rows with `lastLoginAt`, per-user **active** vs **finished** game counts (non-AI `Player`: active = session `status === "active"` and `empire.turnsLeft > 0`), `sessionsJoined` (distinct session ids), and up to 8 **activeSummaries** (galaxy name, commander name, turns left). |
| `PATCH /api/admin/users` | Body `{ userId, newPassword }` (min length matches signup). Bcrypt-updates `UserAccount.passwordHash` and all linked `Player.passwordHash` for that `userId`. |
| `DELETE /api/admin/users?id=` | Deletes the `UserAccount`. `Player.userId` is set **null** (FK); commander rows remain unless removed separately. |

UI: **`/admin`** (`src/app/admin/page.tsx`) — link to **`/admin/users`**; galaxy table with per-row checkboxes, **Delete** per row, **Delete selected** bulk action, **Change admin password** form, **Integration (Gemini)** form. **`/admin/users`** — table of accounts with last login and game stats; **Set password** and **Delete account**. Login screen links to Admin. Route handlers use **`requireAdmin(req)`** in `src/lib/admin-auth.ts` (cookie check, 401 if invalid).

### AI Setup Flow (UI)

1. **Sign up** (`SIGN UP`): username, full name, email, password + confirm → then **Login** with username/password → **Command Center** hub lists active games and offers **Create New Galaxy** / **Join Existing Galaxy** / **Log out**.
2. **Login** without a `UserAccount` falls back to legacy **`POST /api/game/status`** resume (same as before).
3. **Create path** (from hub): single **NEW GALAXY** screen — optional galaxy name, public/private, turn timer, **max players**, and optional AI toggles (5 commanders). The client sends the account password from the logged-in session (no password fields). On submit: `POST /api/game/register` → if any AIs selected, `POST /api/ai/setup` with `{ names: [...], gameSessionId }` → main game. Private invite codes appear in **CFG** after entering the game.
4. **Join path** (from hub): invite code or public list — client sends account password from the logged-in session (no password fields on the join screen) → joins session → starts game (no AI setup — creator manages AIs).

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`7` | Switch action tab |
| `Enter` | Skip turn |
| Letter keys | Tab-specific actions (shown as `[key]` badges) |

---

## 13. Constants Reference

All game constants live in `src/lib/game-constants.ts`. This is the single source of truth — all UI labels, simulation strategies, and game logic reference these values directly. No game numbers are hardcoded elsewhere.

### Quick Reference Table

| Constant | Value | Location |
|----------|-------|----------|
| `COST_INFLATION` | 0.001 | Planet cost scaling |
| `POP.BIRTH_RATE` | 0.03 | Base birth rate |
| `POP.DEATH_RATE` | 0.008 | Base death rate |
| `POP.URBAN_GROWTH_FACTOR` | 0.45 | Birth multiplier per urban production |
| `POP.EDUCATION_IMMIGRATION` | 400 | Immigrants per education planet |
| `POP.OVERCROWD_CAPACITY_PER_URBAN` | 20,000 | Pop capacity per urban planet |
| `POP.OVERCROWD_EMIGRATION_RATE` | 0.10 | Emigration rate on excess |
| `POP.FOOD_PER_PERSON` | 0.006 | Food consumption per person |
| `ECON.POPULATION_TAX_FACTOR` | 0.002 | Tax per person |
| `ECON.URBAN_TAX_PER_PLANET` | 1,200 | Credits per urban planet |
| `ECON.TOURISM_BASE_CREDITS` | 8,000 | Credits per tourism planet |
| `ECON.GALACTIC_TAX_RATE` | 0.0005 | Wealth tax rate |
| `ECON.SELL_RATIO_DIVISOR` | 1.2 | Sell price discount |
| `MAINT.PLANET_BASE` | 600 | Base maintenance per planet |
| `MAINT.PLANET_PER_TURN` | 8 | Additional maintenance per turn |
| `MAINT.IMPERIAL_OVERHEAD_PER_PLANET` | 0.05 | Superlinear overhead factor |
| `COMBAT.DEFENSE_BONUS` | 1.5 | Defender strength multiplier |
| `UNIT_COST.LIGHT_CRUISER` | 950 | Light cruiser purchase cost |
| `COMBAT.RANDOMNESS` | 0.20 | ±20% combat randomness |
| `COMBAT.INVASION_ROUNDS_PER_FRONT` | 5 | Rounds per combat front |
| `RANDOM_EVENT_CHANCE` | 0.10 | 10% per turn |
| `CIVIL_DESERTION_RATE_PER_LEVEL` | 8% | Military desertion per civil level |
