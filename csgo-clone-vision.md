# Project Vision: Browser-Based CS:GO Clone (Dust 2, Bot-Only)

## What We're Building

A browser-based tactical first-person shooter that faithfully recreates the CS:GO experience on a single map — Dust 2. There is no multiplayer. All 9 other players in every match are AI bots. The bots must feel like real soldiers and real CS:GO players — they use cover, coordinate with their team, rotate when the bomb is planted, and play to win. The end result should feel like a genuine CS:GO match, just without real people on the other end.

The player is one of 10 total players (5 Terrorists vs 5 Counter-Terrorists). The game follows a full 30-round competitive match format. First team to 16 rounds wins.

---

## The Map: Dust 2

Dust 2 is a three-lane tactical map with two bomb sites (A and B) connected through a central mid area. Every area has an established callout name that players use to communicate. The layout must feel accurate to the real map — same proportions, same angles, same key positions.

**Key zones and their callouts:**

- **T Spawn** — where Terrorists start. Open area with an elevated sniper platform.
- **Outside Long / Long Doors** — T-side approach to A Site via the long route.
- **A Long** — long narrow corridor from Long Doors to A Site. Classic AWP duel territory.
- **Pit / Pit Plat** — sunken area at the end of A Long, good sniper angles onto site.
- **A Cross** — exposed open ground between A Long and the actual A bomb site. Wide open, dangerous to cross.
- **A Site** — the main bomb plant zone on the A side. Open area with a platform, boxes, and multiple entry angles.
- **A Short / Catwalk** — shorter T-side path to A Site from Mid. Popular for fast rotations.
- **CT Spawn** — Counter-Terrorist starting area. Close to both sites.
- **Mid** — central area of the map. Features Mid Doors (a tall door the CT side controls), Suicide (a dangerous drop from T Spawn into Mid), and a connection to both sites.
- **B Tunnels (Upper + Lower)** — two-floor tunnel complex leading from T Spawn toward B Site. Chokepoint-heavy.
- **B Site** — bomb plant zone on the B side. More enclosed than A. Features B Platform, Back Plat, B Window, and a Fence hiding spot.
- **B Doors / CT Mid** — CT-side connection between mid and B Site.

Bots should know all of these zones by name so the AI logic can reason about map positions, rotations, and strategy using real callout language.

---

## How CS:GO Actually Plays

### The Round Loop

Every round follows this sequence:

1. **Freeze Time (~15 seconds)** — players are frozen in spawn. No movement. Buy menu is open.
2. **Buy Phase (~20 seconds)** — movement allowed, buy menu still accessible, round hasn't fully started.
3. **Live Round** — round is active. Lasts up to 1 minute 55 seconds. Ends when: all players on one team are eliminated, the bomb is planted and explodes, or the bomb is defused.
4. **Bomb Plant** — a T player holds the bomb (C4). When standing on a bomb site, they hold the plant key for ~3 seconds to arm it. The bomb then has a 40-second countdown.
5. **Defuse** — a CT player holds the defuse key for 10 seconds (5 seconds with a defuse kit) while standing near the bomb to disarm it.
6. **Round End** — brief pause, winner displayed, money awarded, then next round begins.
7. **Halftime at Round 15** — teams swap sides. T becomes CT, CT becomes T.

### The Economy (Money System)

Economy is one of CS:GO's defining features — teams have to manage money across rounds, leading to strategic buy and eco round decisions.

**Starting money:** $800 at the start of each half (pistol round only).

**Kill rewards (per kill):**
- Rifle / Sniper kill: $300
- SMG kill: $600
- Pistol kill: $300
- AWP kill: $100
- Knife kill: $1500
- Teamkill: -$300

**Round outcome rewards:**
- T win (eliminate all CTs): $3250/player
- CT win (eliminate all Ts or time runs out): $3250/player
- CT win (defuse bomb): $3500/player + $300 bonus to defuser
- T win (bomb explodes): $3500/player
- Bomb plant (regardless of round outcome): $300 to the planter
- T loss but bomb was planted: loss bonus + $800

**Loss bonus (escalating per consecutive loss):**
- Lose 1 round: $1400
- Lose 2 in a row: $1900
- Lose 3 in a row: $2400
- Lose 4 in a row: $2900
- Lose 5+ in a row: $3400
- This resets the round after a win.

**Max money cap:** $16,000 per player.

**Round types this creates:**
- **Pistol Round** — first round of each half. Everyone has $800. Pistols and armor only.
- **Full Buy** — team can afford rifles, armor, and grenades ($4000+).
- **Force Buy** — team can't afford full kit but spends what they have to stay competitive.
- **Eco Round** — team saves money, buys almost nothing to maximize their budget for the next round.

### Movement

CS:GO's movement is skill-based and directly impacts shooting accuracy:

- **Running** — generates audible footsteps heard by enemies. Shooting while running is very inaccurate.
- **Walking (Shift)** — silent movement. Players use this when close to enemies. No footstep sound.
- **Crouching** — reduces player hitbox height, improves accuracy significantly, slows movement.
- **Counter-Strafing** — tapping the opposite movement key to instantly stop velocity. Critical skill — you must be fully stopped to shoot accurately. This is what separates good players from bad.
- **Peeking** — moving out from cover briefly to take a shot and then retreating. Wide swings give the peeker a speed advantage (the "peeker's advantage").
- **Jiggle Peek** — rapidly strafing in and out of an angle to bait enemy shots without fully committing.

### Shooting and Accuracy

- Accuracy is at its best when standing completely still.
- Movement heavily degrades accuracy — running and shooting is mostly useless at range.
- **First bullet accuracy** — the first bullet fired from a still position is very accurate for most weapons.
- **Spray patterns** — each weapon has a fixed, repeating recoil pattern. Players learn to "spray transfer" by pulling their mouse against the recoil to compensate:
  - AK-47: First 8 bullets go sharply upward, then drift left, then right, alternating.
  - M4A4: First 10 bullets go up-right, then left up to bullet 20, then right again.
  - Pistols: Light recoil, manageable with burst fire.
- Crouching improves accuracy but is a predictable pattern enemies can exploit.
- Spread also increases with consecutive shots regardless of compensation — controlled bursts are optimal at range.

### Weapons and Equipment

**Terrorist defaults:** Glock-18 pistol + knife. Starting option: AK-47 as primary rifle.
**CT defaults:** USP-S pistol + knife. Starting option: M4A4 or M4A1-S as primary rifle.

**Weapon categories:**
- Pistols: Glock, USP-S, P250, Desert Eagle, Five-SeveN, Tec-9
- SMGs: MP9, MAC-10, UMP-45, P90
- Rifles: AK-47 (T), M4A4/M4A1-S (CT), FAMAS (T budget), Galil AR (CT budget)
- Heavy: Nova/XM1014 shotguns, M249/Negev LMGs
- Sniper: AWP (one-shot kill to body), SSG 08 (cheaper, weaker)
- Grenades: Flashbang, Smoke, HE Grenade, Molotov (T) / Incendiary (CT), Decoy

**Armor:** Kevlar Vest ($650) reduces damage. Helmet ($350 extra) prevents headshots from killing in one hit with most weapons (not AWP or AK-47).

**Defuse Kit (CT only, $400):** Reduces defuse time from 10 seconds to 5 seconds. Extremely important to buy.

### Damage and Hitboxes

Hitboxes are split into head, upper body, lower body, and arms/legs. Headshots deal significantly more damage and often kill in one hit.

- AK-47: 111 body damage (through no armor), 68 with armor. Headshot kills regardless of armor.
- M4A4: 33 body damage with armor. Headshot kills without helmet, 2 hits with helmet.
- AWP: 115 body damage. Kills in one hit anywhere on the torso or head.
- Glock: 25 body damage. Multiple shots required.

### Grenades

- **Flashbang** — detonates after ~1.5 seconds and blinds players in LoS. Can be thrown to clear angles before peeking.
- **Smoke Grenade** — creates an opaque smoke cloud for ~18 seconds. Used to block sightlines, cover bomb plants/defuses, split pushes.
- **HE Grenade** — deals up to 98 damage in a radius. Used to soften enemies before a push.
- **Molotov / Incendiary** — sets fire to an area for ~7 seconds. Deals ~40 damage/second. Used to deny positions or slow enemies.

### The HUD

CS:GO's HUD is clean and information-dense. Key elements:

- **Health** — bottom left, green number (0–100)
- **Armor** — bottom left, grey number
- **Helmet icon** — appears when helmet is equipped
- **Ammo** — bottom right: current magazine / reserve ammo
- **Active weapon** — bottom right, weapon icon + name
- **Money** — bottom right, green dollar amount
- **Kill feed** — top right, scrolling list of recent kills with weapon icons
- **Round timer** — top center, counts down from 1:55
- **Players alive counter** — top center, shows how many players remain on each team (with avatars or numbers)
- **Bomb timer** — appears at top when bomb is planted, red countdown bar
- **Radar/minimap** — top left, circular or square, shows your team's positions as colored dots, bomb location when visible
- **Scoreboard (Tab)** — full overlay showing: player name, kills, assists, deaths, money, ping — for all 10 players grouped by team
- **Buy menu (B key)** — grid-based weapon selection. Shows all purchasable items with costs. Only accessible in buy zone during buy/freeze phase.
- **Bomb status** — small C4 icon in weapon slot area when you're carrying the bomb (T side)
- **Defuse kit status** — small kit icon when a CT has a kit

---

## What the Bots Need to Feel Like

The bots are the heart of this game. They need to feel like real CS:GO players, not generic game AI.

**On the Terrorist side**, bots should:
- Decide on a strategy at round start: rush A, rush B, split A/B, default (play slow and gather info), or fake (pretend to push one site then rotate)
- Coordinate pushes — not all 5 running in individually, but stacking up and going together
- Buy correctly based on their money — full buy when they can afford it, eco when they can't
- Use grenades intelligently: flash before peeking a corner, smoke to block CT crossing angles, molotov to delay rotations
- Plant the bomb in a covered position when possible, then defend it
- Save expensive weapons when the round is clearly lost (don't die with a rifle if the round is over)

**On the Counter-Terrorist side**, bots should:
- Spread to cover both sites and mid at round start — don't all stack one site
- Hold defensive angles from good positions, not out in the open
- Rotate when they hear the bomb being planted — the CTs who aren't near the bomb site need to start moving immediately
- Buy defuse kits when they can afford it
- Communicate bomb location with teammates (bot-to-bot awareness)
- Retake as a team — bots shouldn't throw themselves at the bomb site one at a time

**All bots (both sides) should:**
- Walk silently when close to known enemy positions
- Use cover — they should not stand in the open and duel
- Peek angles rather than running directly at enemies
- React to sound — gunshots and footsteps should trigger their awareness
- Have realistic aim: a delay before they start shooting after seeing an enemy, and spread that makes them miss sometimes — not aimbot precision
- Be tunable in difficulty so the game is playable at different skill levels

---

## Recommended Technologies

These are the tools we want to build with. Claude can push back if something doesn't work or a better option exists.

- **Babylon.js** — the 3D rendering engine. Runs in the browser, has a mature ecosystem, Havok physics integration, and built-in NavMesh support.
- **Havok Physics** (via Babylon.js plugin) — for collision, gravity, and physics-based interactions.
- **Recast/Detour NavMesh** (via Babylon.js's built-in RecastJS plugin) — for bot pathfinding across the map geometry.
- **Yuka.js** — a JavaScript game AI library purpose-built for agent-based AI. Handles steering, perception (vision + memory), goal-driven behavior, and navigation. Works engine-agnostic and integrates with Babylon.js.
- **Vite** — build tool and dev server.
- **Vanilla JavaScript (ES modules)** or TypeScript — no framework needed.

---

## What's Not in Scope (For Now)

- No real multiplayer or networking of any kind
- No matchmaking, lobbies, or online features
- No official Valve assets — use procedural geometry and placeholder textures
- No skins or cosmetics
- No voice chat
- No leaderboards or persistent stats
