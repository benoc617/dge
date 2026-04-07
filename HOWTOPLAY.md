# How to Play Solar Realms Extreme

## The Goal

You rule a galactic empire for **100 turns**. Each turn you take one action — buy planets, build armies, attack rivals, trade, research, spy, or manage your economy. The player with the highest **net worth** at the end wins.

---

## Starting a Game

### Account (recommended)

1. On the title screen, enter a **username** and click **Sign up** (or fill username first, then Sign up).
2. On the sign-up form, enter **username**, **full name**, **email**, **password**, and **password (confirm)** — password must be at least **8** characters.
3. Click **Create account**, then **Login** with the same username and password.
4. The **Command Center** shows any games in progress, plus **Create New Galaxy**, **Join Existing Galaxy**, and **Log out**.

### Create a New Galaxy (after login)

1. From the Command Center, choose **Create New Galaxy**.
2. On one screen, set **max players** (2–128, default 50), optional galaxy name, **Public** or **Private**, turn timer, and optionally toggle **AI opponents** (see table below) — your account session is used; no extra password on this screen.
3. Click **CREATE GALAXY** (or **CREATE GALAXY — SOLO** if no AIs are selected). For **private** games, the **invite code** appears in the **CFG** tab after you enter the galaxy.
4. You start playing immediately after creation.

### Join an Existing Galaxy (after login)

1. From the Command Center, choose **Join Existing Galaxy**.
2. Enter an **invite code** or pick a **public galaxy** from the list (your logged-in session supplies your account password to the server).
3. You enter the galaxy immediately (no AI setup — the creator manages AI opponents).

### Login without a separate sign-up (legacy)

If you played before accounts existed, enter **username** and **password** and click **Login** — the game will resume your active empire the same way as before.

### Resuming from the Command Center

After **Login**, any **active** games appear on the Command Center with a **Resume** button. Finished games (all 100 turns played) cannot be resumed — they are recorded in the high score table.

### Operator: pre-staged galaxies (Admin)

Hosts can open **`/admin`** (link on the login screen) and sign in with server-configured credentials (defaults **`admin`** / **`srxpass`**, override with `ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` in the server environment). From there you can **list active galaxies**, **create** empty or AI-filled lobbies that stay in **waiting** until the first human player joins via invite code or the public list (no turn timer runs until that join), and **configure Gemini** (API key/model stored in the database; `DATABASE_URL` remains in the server environment only).

**`/admin/users`** (link from the admin header) lists every **registered account** in the database: last login time, how many active vs finished games they have, and short summaries of ongoing games. Operators can **set a new password** for an account (syncs in-game commander passwords for linked players) or **delete** an account (commander rows stay in their galaxies but are unlinked from the account).

### AI Opponents

When creating a galaxy, you can select from 5 rival AI commanders:

| AI Commander | Strategy |
|---|---|
| Admiral Koss | Economy-focused banker — avoids combat, maximizes wealth |
| Warlord Vrex | Military-first — rushes soldiers, attacks frequently |
| Shadow Nyx | Covert specialist — destabilizes targets before striking |
| Ambassador Sol | Diplomat — builds alliances, peaceful expansion |
| Fortress Prime | Defensive turtle — impenetrable defense, counter-attacks only |

Select any combination (or none for solo play). AI opponents take their turns automatically after you act — you don't need to trigger them manually. If an AI’s chosen action is invalid (not enough credits, protected target, etc.), it **skips** that turn—same fairness as a failed command followed by **Skip Turn**—so turn order stays steady.

### Turn Order

This is a strict turn-based game. Players act one at a time in a fixed order (set when they join the galaxy). You can see the full turn sequence in the **CFG tab** under "TURN ORDER" — the current player is highlighted. After you take your turn, AI players act automatically in sequence. If the next player is another human, you'll see "WAITING — [NAME]'S TURN" until they go. The game checks automatically every few seconds.

Each turn has a **timer** shown in the header (the creator picks the limit when creating the galaxy — e.g. 24 hours — and can change it in CFG). If a player doesn't act within the time limit, their turn is automatically skipped (income still collected). The timer turns red when under 1 hour.

### Door-game / simultaneous turns (optional)

If the galaxy creator enables **simultaneous turns** when creating the galaxy, play uses **calendar rounds** (days) in **door-game** style — like classic BBS play: you dial in, run your economy tick, then take **one action per full turn** (buy, attack, etc.); the server **ends** that full turn for you so it counts toward your five — you only need **Skip** when you want to burn a full turn **without** another action (or to open the tick first). Each round you get up to **five full turns** (header: `D3 · 2/5 full turns`). One **full turn** = **tick** (situation report) + **one** action (or **Skip** / `end_turn` alone). **You do not wait for AI** — everyone can play; the server runs **AI empires in the background** while you play, and **when a new calendar day begins** it starts a **batch drain** of every AI’s full turns for that day (after your action’s database commit finishes) so the log is not scattered across the whole day. Commits are immediate (rare **galaxy busy — retry** if two requests collide). Your game **turns left** drops **once per full turn** (each tick + action or Skip / `end_turn` that closes a slot — up to five per calendar round). When the **round timer** expires (same setting as sequential games, often 24h), any **remaining** full-turn slots you did not use that day are **skipped** and each skipped slot **also** consumes one **turns left**, same as if you had played them. The header shows a **countdown** to that deadline. **Skip** either opens your tick and then ends the full turn, or just ends if a turn is already open.

### Your turn: situation report first

When it becomes your turn, the game runs the **economy tick** for your empire and shows a **situation report** — income, expenses, population change, resources, and events. Serious problems (starvation, fuel deficit, civil disorder, protection ending, etc.) are highlighted in red so you can react before you choose your action. Dismiss the report, then use the Command Center as usual.

### Game Settings (CFG Tab)

The galaxy creator can manage game settings from the **CFG tab** in the Command Center:
- **Invite Code** — for **private** games, shown with a click-to-copy button. Public games do not display the code in the UI (use session id / lobby list to join).
- **Visibility Toggle** — switch between Public and Private. Only the creator can change this.
- **Turn Timer** — per-session deadline for each player's turn (creator only).

## Your First Turns

You start with 10,000 credits, 25,000 population, 7 planets (2 Food, 2 Ore, 2 Urban, 1 Government), 100 soldiers, 2 generals, 10 fighters, and 20 turns of attack protection.

**Recommended opening moves:**

1. **Set sell rates** — New empires default ore and petroleum auto-sell to **50%** (food stays 0%). Adjust on the CFG tab if you want; 50–80% is a solid range for passive income every turn.
2. **Lower your tax rate** — A tax rate of 20–30% lets your population grow. Population = tax revenue.
3. **Buy planets** — Food planets keep your people alive. Urban planets let your population grow. Ore and Petroleum planets produce resources. Get a balance going.
4. **Build soldiers** — Even during protection, start building military. You'll need it.

---

## The Header Bar

The header bar at the top of the game screen always shows:

- **Galaxy name** (if set)
- **Whose turn** — `▸ YOUR TURN` (cyan) when it's your turn, or `▸ [NAME]'S TURN` (yellow) when waiting
- **Turn timer** — countdown clock for the current turn (24h default). Turns red under 1 hour.
- **Credits** — your current balance in yellow
- **Turn counter** — e.g., `T5 (95 left)` showing your turn number and how many remain
- **Protection** — `[P20]` if you still have protection turns remaining
- **Commander name**

---

## The Galactic Powers Panel

At the top of the game screen, the **Galactic Powers** leaderboard shows all players ranked by net worth with column headers: **Rank, Commander, Prt** (on wider screens), **Worth, Pop, Planets, Turns, Military**. **Turns** counts economy ticks completed (`turnsPlayed`) for that empire. **Prt** shows `[PN]` when that commander still has **new-empire protection** (same idea as your own `[P20]` badge in the header). You cannot **attack** or run **covert ops** against a protected rival until their protection turns expire.

You can see each rival's key stats at a glance. **Click any rival's name** to auto-select them as a target in the WAR and OPS tabs — the target dropdown updates instantly.

## Understanding the Turn Report

Every turn, before your action executes, the game processes your empire automatically. After each action, a **Turn Summary popup** appears with a structured two-column layout:

- **Income** (green) — Tax revenue, urban tax, tourism, market sales, galactic redistribution
- **Expenses** (red) — Planet maintenance, military upkeep, galactic tax
- **Net** (center, highlighted) — Your net income or loss for the turn
- **Population** (cyan) — Births, immigration, deaths, emigration, total with delta
- **Resources** — Food, ore, and fuel produced vs consumed
- **Combat Results** (when attacking) — Victory/defeat banner, front-by-front results for conventional attacks, spoils of war (planets, credits, population, ore/food where applicable), **your unit losses**, and **target unit losses** where applicable. Nuclear and chemical strikes list **per-planet population killed** and totals; psionic attacks show **civil unrest and effectiveness** impact on the target. Pirate raids show **your** casualties. The same detail appears in the **Comm Channel** line for that action (server `message` text).
- **Events** (yellow) — Random events, combat results, deficit warnings
- **ALERT** (highlighted as critical) — When another commander **attacks you**, runs **covert ops** against you, or **proposes, accepts, or breaks a treaty** with you, a short report appears on **your next turn** in the situation report (and in the Events list). Pure spy/intel ops may only show up if the enemy was **detected**.

Press Enter, Space, Escape, or click outside to dismiss the popup. The same information also logs to the **Comm Channel** (right panel) for scrollback reference — including full attack summaries (losses per unit type, planet casualties for WMD strikes, etc.) when you attack or raid.

**Failed commands** — If an action cannot run (not enough credits, at unit/planet caps, you already own a command ship, it is not your turn, etc.), a **red FAILED banner** appears directly under the header with the server message. Click **×** or wait about 12 seconds to dismiss. The same line is still logged in the Comm Channel.

If any resource hits zero, bad things happen — starvation kills population, bankruptcy loses planets.

Note: Every action (buying a planet, recruiting soldiers, attacking, etc.) costs one turn. The **"Skip Turn"** button is always visible at the top of the Command Center (above the tabs) — it just collects your income without taking any other action.

## Empire Panel

The left panel shows your empire status in a **compact grid layout**: Net Worth and Civil Status boxes at top, a resource grid (credits, food, ore, fuel), population and tax rate, sell rates, military units as mini-stats (with abbreviations like Sol, Gen, Ftr, Stn, LC, HC, Car, Cov), planet type badges (e.g., "2F 2O 1G"), and **Planet Details** as a collapsible section — click the toggle to expand and see each planet with its name, type, sector, and production level.

---

## The 7 Action Tabs

### 1. ECON (Economy)

- **Colonize Planet** — Each planet type is shown as a card with its name, cost, description, and how many you already own. Click any card to colonize immediately. Planet types:
  - **Food** — Feeds population and soldiers. You need these or everyone starves.
  - **Ore** — Feeds mechanical military units. Can sell excess.
  - **Tourism** — High credit income but fragile in wartime.
  - **Petroleum** — Produces fuel but causes pollution. Pair with Anti-Pollution.
  - **Urban** — Each supports 20,000 population and generates urban tax. Critical for growth.
  - **Education** — Brings +400 immigrants per planet per turn.
  - **Government** — Reduces maintenance costs. Required for generals (50 cap/planet) and covert agents (300 cap/planet).
  - **Supply** — Auto-produces military units each turn based on your allocation.
  - **Research** — Base cost 25,000 cr (before inflation). Generates research points (300/turn) and light cruisers.
  - **Anti-Pollution** — Absorbs pollution from petroleum planets.
- **Set Tax Rate** — Higher taxes = more income but less population growth. 20–35% is safe for growth; 40–60% for income; above 60% and people flee.
- **Set Sell Rates** — Percentage of produced food/ore/petroleum auto-sold each turn.

**Warning:** Planet maintenance grows quadratically. Going from 10 to 20 planets roughly triples your maintenance. Government planets help offset this.

### 2. MIL (Military)

Buy units to defend your empire and attack others:

| Unit | Cost | Role |
|------|------|------|
| Soldier (280 cr) | Ground combat, pirate raids | Cheapest unit, good in numbers |
| General (780 cr) | Required for attacks | Need government planets (50 per planet cap) |
| Fighter (380 cr) | Orbital and pirate combat | Core of your fleet |
| Defense Station (520 cr) | Static defense | Strong on defense, can't attack |
| Light Cruiser (950 cr) | Space + orbital combat | Also produced by Research planets |
| Heavy Cruiser (1,900 cr) | Space superiority | Dominates the space front |
| Carrier (1,430 cr) | Fleet support | Boosts carrier capacity |
| Covert Agent (4,090 cr) | Espionage operations | Need government planets (300 per planet cap) |
| Command Ship (20,000 cr) | Unique flagship | Boosts heavy cruiser strength, grows over time |

**Effectiveness** starts at 100% and drops when you lose battles. Recovers +2%/turn. Low effectiveness makes your entire army weaker.

### 3. WAR (Warfare)

Select a target from the **dropdown** (populated from all rival empires — or click a rival in the Galactic Powers panel to auto-select them).

- **Conventional Attack** — The main attack. Fights across 3 fronts (space → orbital → ground). You must win all 3 to capture planets and loot the enemy. Requires at least 1 general.
- **Guerrilla** — Soldiers-only skirmish. Good for harassment but defenders get 4× bonus.
- **Nuclear** — Costs 500M per nuke. Radiates planets and kills population. Devastating but expensive.
- **Chemical** — Kills population on 3 planets. 85% chance the Galactic Coordinator retaliates against YOU.
- **Psionic Bomb** — Wrecks the target's civil status and military effectiveness. No direct damage.
- **Pirate Raid** — Fight NPC pirates for loot (credits, ore, food). Scales with your military strength. Low risk, decent reward.

**Combat tips:**
- Defenders get a 1.5× strength bonus — don't attack unless you're stronger.
- Different units shine on different fronts. Soldiers dominate ground, fighters own orbital, heavy cruisers rule space.
- Research unit upgrades to unlock higher tier multipliers.

### 4. OPS (Covert Operations)

Requires covert agents and covert points (regenerate +5/turn, max 50).

| Operation | Points | What It Does |
|-----------|--------|-------------|
| Spy | 0 | Reveals target's resources, army, planets |
| Insurgent Aid | 1 | Worsens target's civil status |
| Support Dissension | 1 | 5% of target's soldiers desert |
| Demoralize Troops | 1 | Reduces target's effectiveness |
| Bombing Operations | 1 | Destroys 20% of target's food |
| Relations Spying | 0 | Reveals target's treaties |
| Take Hostages | 1 | Steals 5% of target's credits |
| Carrier Sabotage | 1 | Destroys 10% of target's carriers |
| Communications Spying | 1 | Reveals target's last 5 actions |
| Setup Coup | 2 | Civil status +2 AND effectiveness -15% |

Your agents can be detected and killed. More agents = higher success rate. Government planets house more agents.

### 5. MKT (Galactic Market)

- **Buy** resources (food, ore, fuel) at market price
- **Sell** resources at a discount (÷1.2)
- Prices shift with supply and demand — heavy buying raises prices, heavy selling lowers them
- Base prices: Food 80 cr, Ore 120 cr, Fuel 300 cr

### 6. RES (Research)

Research planets generate 300 points/turn. Spend points to unlock technologies across 5 categories:

- **Agriculture** — Boost food production (8K–25K RP)
- **Industry** — Boost ore/petroleum, reduce maintenance, tourism boom (10K–35K RP)
- **Military** — Upgrade unit tiers — huge combat multipliers (20K–120K RP)
- **Society** — Population growth, civil stability, income bonuses (8K–20K RP)
- **Deep Space** — Light cruiser upgrades, research speed boost (35K–120K RP)

With one research planet you'll accumulate ~15,000 RP over 50 turns — enough for entry-level techs. Two or three research planets lets you unlock mid-tier upgrades by end-game. Tier 2 military unlocks (60K–120K RP) require a dedicated research strategy.

**Priority techs:** Military unit upgrades make the biggest difference in combat. A Tier 2 soldier is 2× stronger on ground than Tier 0.

### 7. CFG (Settings)

- **Set Tax Rate** — Adjust your tax rate
- **Set Sell Rates** — Control food/ore/petroleum auto-sell percentages
- **Game Session** — View galaxy name, invite code (click to copy), toggle public/private visibility (creator only)
- **Turn Order** — See the full list of players in turn sequence with the current player highlighted and `[AI]` tags

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1`–`7` | Switch tabs (ECON, MIL, WAR, OPS, MKT, RES, CFG) |
| `Enter` | Skip turn (collect income only) |
| Letter keys | Trigger the labeled action in the current tab |
| `Alt+1`–`7` | Switch tabs when focused in an input field |

---

## Key Strategies

### Economy First
Don't build military early. Spend your first 15–20 turns buying planets and growing your economy. A strong economy funds everything else.

### Watch Your Food
Population eats food. Soldiers eat food. If food hits zero, 20% of your population dies and civil status worsens. Always have food planets proportional to your population.

### Urban Planets = Population Cap
Each urban planet supports 20,000 people. If your population exceeds capacity, 10% of the excess emigrates each turn. Buy urban planets to keep growing.

### Government Planets Are Essential
They reduce maintenance (which grows quadratically), house generals (50 per planet, needed for attacks), and house covert agents (300 per planet). Get at least 2–3 government planets by mid-game.

### Don't Over-Expand
Maintenance scales super-linearly. 10 planets cost far less than twice what 5 planets cost. Expand carefully and make sure income exceeds expenses.

### Military Timing
Build military after your economy is self-sustaining. A small army doing pirate raids pays for itself. Don't attack other players until you're confident you can win — defenders get a 1.5× bonus.

### Pirate Raids
Low-risk income source. Even a modest army can beat pirates and earn credits, ore, and food. Raid often once you have soldiers and fighters.

### Civil Status Matters
Unrest reduces production, causes military desertion (8% per level!), increases emigration. Keep it at 0 (Peaceful) by: avoiding deficits, keeping covert agents (they help recovery), and not breaking treaties.

---

## Winning

The game ends after 100 turns. **Net worth** determines the winner:

- Planets × 3 each
- Population × 0.0002 per person
- Credits × 0.000015 per credit
- Military units contribute based on type (heavy cruisers and carriers worth most)

A balanced empire with many planets, a large population, solid finances, and a capable military will have the highest net worth. Pure military or pure economy strategies can both win if executed well.

### Game Over Screen

When the last turn ends, a **Game Over** screen appears with:

- **Victory/Defeat banner** — personalized based on whether you won
- **Final standings** — all players ranked by net worth with population, planets, and military counts
- **Your empire summary** — detailed breakdown of your final stats and rank
- **All-time high scores** — top 10 scores across all games you've played
- **Export Game Log** — download a complete JSON file of every turn, action, and event for analysis
- **New Game** — start fresh

Your score is permanently recorded in the high score table, so you can track your performance across games.
