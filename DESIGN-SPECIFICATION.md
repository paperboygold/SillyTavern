# Sanguine TRPG: System & Interface Specification

An engineering and user interface blueprint for a standalone, local-first narrative tabletop roleplaying game engine.

---

## Quick Navigation

```
1. Product Overview & User Flows
   1.1 Goals & Core Philosophy
   1.2 Responsive Layouts & Screen Breakpoints
   1.3 The Turn Cycle State Machine
   1.4 Three-Tier Interface (Status Bar, HUD, Detail Modal)

2. Rules & Game Engine
   2.1 Tabletop System Inspirations
   2.2 The Momentum & Resolution Engine (Position & Effect)
   2.3 Injury & Consequence Slots (Minor, Moderate, Severe)
   2.4 Adversary Threat Ratings (1–10 Scale)
   2.5 Story Stakes: Danger Clocks, Progress Bars, and Fronts
   2.6 Economy: Cash Accounts & Valued Inventory
   2.7 Living World: Off-Screen NPC & Faction Turns

3. Data Architecture & Schemas
   3.1 Event-Sourced Storage (SQLite WAL)
   3.2 State Tables & Clean Update Rules
   3.3 Data Models (Characters, Clocks, Inventory, Finances)
   3.4 Character Depth & Adult Narrative Contract
   3.5 AI Pipeline & Extraction Schema

4. Interface & Design System
   4.1 Viewport Breakpoints & Screen Layouts
   4.2 Core Screen Components
   4.3 The 9-Tab Detail Modal
   4.4 Design Tokens & Typography Scale
   4.5 Keyboard Shortcuts
```

---

# 1. Product Overview & User Flows

## 1.1 Goals & Core Philosophy

Traditional chat applications struggle with long-term storytelling. After dozens of turns, inventory vanishes, injuries are attributed to the wrong people, plot threads are forgotten, and non-player characters (NPCs) become generic and bland.

The **Sanguine TRPG Engine** is a dedicated, local-first app built around four practical priorities:

1. **Accurate Tracking:** State updates are logged to an immutable event history and verified before saving. The engine prevents ghost items, phantom money, and impossible state jumps.
2. **Stakes-First Mechanics:** The game focuses on what is at risk, who is pushing back, and what actions cost, rather than listing static facts.
3. **Rich Characterization & Adult Support:** NPCs have distinct physical appearances, bodily traits, clothing, signature weapons, speech habits, and personal quirks. The system natively supports high-fidelity descriptions across combat, romance, and explicit intimate scenes without awkward euphemisms or arbitrary fades to black.
4. **Focused Working Context:** The active scene displays only the handful of values that are currently changing (injuries, adversary threat, cash, and the main danger clock). Everything else stays quietly in the background until relevant.

---

## 1.2 Responsive Layouts & Screen Breakpoints

The app works cleanly on phones, laptops, and wide desktop screens without cluttering the screen with dense spreadsheets:

| Device | Screen Width | Main Layout | Detail Views |
|---|---|---|---|
| **Mobile** | Under $768\text{px}$ | Single-column story reading pane; sticky bottom status bar. | Full-screen slide-up modal ($100\%$ width, $92\%$ height) with swipe-down to dismiss. |
| **Laptop / Tablet** | $768\text{px} - 1439\text{px}$ | Centered reading pane (max $760\text{px}$); top status bar. | Slide-over drawer ($420\text{px}$ width) from the right with background dimming. |
| **Wide Desktop** | $1440\text{px}$ and up | Centered reading pane ($760\text{px}$); top status bar; optional pinned right-hand HUD ($380\text{px}$). | Full modal or drawer expands smoothly without shifting the reading pane. |

---

## 1.3 The Turn Cycle State Machine

Every turn moves through a predictable four-stage cycle:

```
[Player Action Input]
         │
         ▼
[1. Adjudication (Runs in Code)]
• Checks if the action is routine or carries genuine risk.
• If risky, calculates Standing:
  + Factors in character advantages, injuries, opposition, and precedent.
  + Sets Position (Controlled, Risky, or Desperate).
  + Sets Effect (Limited, Standard, or Great).
  + Automatically spends banked Momentum if in a Desperate spot.
• Emits an outcome verdict: CLEAR, COST, or SETBACK.
         │
         ▼
[2. Story Prose Generation]
• The AI writes the next scene, constrained by the outcome verdict
  and a compact 30-line summary of current world state.
         │
         ▼
[3. Single-Pass State Extraction]
• A fast background call reads the new narrative and outputs structured JSON:
  - Items gained, lost, or spent (always tied to an owner).
  - Cash paid or received.
  - Injuries inflicted or healed.
  - Status of open quests and danger clocks (settled, advanced, or moot).
  - Off-screen faction movements (if time passed).
         │
         ▼
[4. Verification & State Update]
• Code verifies the changes (e.g. confirms purchases deducted money).
• Appends approved changes to the local SQLite event log.
• Updates the status bar, HUD meters, and character sheets.
```

---

## 1.4 Three-Tier Interface (Progressive Disclosure)

Rather than cluttering the screen with every stat at once, information is revealed in three intuitive levels:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 1: TOP STATUS BAR (Always Visible)                                 │
│ 14:07 · Friday, Sep 24 · The Broker's Shop · ₩210,000 · ◔ 2/8 · [COST]  │
└─────────────────────────────────────────────────────────────────────────┘
                                   │ Click any element
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 2: QUICK HUD PANEL (Glanceable Summary)                            │
│ • You: Solomon Winters · E-Rank Hunter · Cash: ₩210,000                 │
│   Injuries: [Moderate] Bandaged left calf                               │
│ • Danger: ◔ 2/8 The residency window closes (10 months left)            │
│ • Goals:  ■■□□□□□□□□ 2/20 D-Rank Raids Completed                        │
│ • Present: Park Min-ji (Friendly), Scarred Broker (Guarded)             │
│ • Weapons: Steel Shortsword (Worn), Leather Bracers (Cracked)           │
└─────────────────────────────────────────────────────────────────────────┘
                                   │ Click any item / Press Tab
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 3: 9-TAB DETAIL MODAL (Full Inspection & Management)               │
│ [Characters] [Clocks] [History] [Inventory] [Places]                    │
│ [Corrections] [Audit] [Prompts] [Diagnostics]                           │
│                                                                         │
│ Full character dossiers, relationship timelines with click-to-jump      │
│ message links, complete inventory values, danger portents, and logs.   │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **Tier 1: Top Status Bar (Always Visible):** A slim bar at the top of the screen showing current in-game time, location, cash on hand, the most urgent danger clock, and a colored chip showing the last action's outcome.
2. **Tier 2: Quick HUD Panel (On-Demand):** A clean summary panel focusing on immediate stakes: your active injuries, ticking clocks, active goals, who is in the room, and equipped gear. Clicking any row opens its full details.
3. **Tier 3: 9-Tab Detail Modal (Full Inspector):** A comprehensive popup dialog with 9 specialized tabs for deep inspection, editing, and history browsing.

---

# 2. Rules & Game Engine

## 2.1 Tabletop System Inspirations

The engine adapts proven mechanics from several standout tabletop RPG systems, simplifying them for smooth digital play:

| System | Ideas We Kept | What We Simplified or Dropped | Why It Matters |
|---|---|---|---|
| **Blades in the Dark** | **Position & Effect:** Separating how risky an action is from how much progress it makes. **Progress Clocks:** Visual 4, 6, and 8-segment danger wheels. | Dropped stress tracks, trauma counters, and dice pools. | Clocks make impending threats exciting and visible. Position and Effect ensure wounded characters can still act and make trade-offs. |
| **Ironsworn** | **Momentum Track:** Banking good play as leverage that cushions against future failure or burns to avoid disaster. **Progress Tracks:** 10- and 20-box tracks for long-term campaign milestones. | Dropped polyhedral dice rolling and complex move tables. | Momentum rewards smart play and tactical preparation without introducing random swingy dice rolls. |
| **Fate Core & Cortex** | **Consequence Slots (1–3):** Replacing hit points with descriptive injury slots (Minor, Moderate, Severe). **Aspects:** Short descriptive phrases that carry mechanical weight. | Dropped the Fate Point bidding economy and free-invoke bookkeeping. | A descriptive injury like *"Sprained right wrist"* drives the narrative better than subtracting 8 HP from an arbitrary total. |
| **Scarlet Heroes** | **1-Integer Threat:** Representing adversaries with a single number from 1 to 10. Damage steps down threat directly. | Dropped traditional armor class math and multi-stat monster blocks. | Compresses enemies into a single clean number. A fight with six goblins is tracked with six simple numbers instead of six pages of stats. |
| **Dungeon World** | **Fronts & Grim Portents:** Multi-stage threats with clear descriptive warning signs that happen in order before catastrophe strikes. | Dropped class playbooks, level-ups, and XP rules. | The player sees danger building step-by-step, eliminating arbitrary or sudden surprises. |
| **Stars Without Number** | **Rooted Faction Turns:** Named NPCs and factions pursue active goals off-screen during downtime or travel. | Dropped faction budgets, asset maintenance, and complex economy minigames. | Gives NPCs independent lives and agendas without bogging down the engine in accounting. |
| **Crusader Kings III** | **Causal Relationship Trails:** Every opinion change links directly to the specific conversation or event that caused it (*"+15: saved my life in dungeon"*). | Dropped massive dynastic simulation calculations. | Makes NPC relationships transparent, earned, and easy to recall. |
| **Disco Elysium** | **Living Quests:** Leads and thoughts written as flavorful narrative concepts rather than dry checklist items. | Dropped behind-the-scenes skill check rolls. | Keeps quest tracking literary, engaging, and atmospheric. |

---

## 2.2 The Momentum & Resolution Engine

The engine is **completely diceless**. It determines action outcomes using established narrative precedent, character leverage, and banked momentum.

### 1. Classifying the Action
When a player declares an action carrying risk or opposition, code checks four basic factors:
- **Supported:** Does the character have the training, equipment, or backing to make this possible? ($+2$ if yes, $-2$ if completely unbacked).
- **Opposed:** Is someone actively fighting or resisting right now? ($-1$ if opposed).
- **Reckless:** Does the action ignore obvious warnings or common sense? ($-2$ if reckless).
- **Social Alignment (Grain):** Does the request align with what the target wants (`with`, $+1$), cut against what they want (`against`, $-1$), or sit unrelated (`beside`, $0$)?

### 2. Standing & Outcome Bands
The engine calculates a Standing score combining character condition, precedent, and banked momentum:
$$\text{Base Standing} = \text{Support} + \text{Opposition} + \text{Recklessness} + \text{Social Alignment} - \text{Injury Penalties} \pm \text{Precedent}$$

Banked momentum provides an automatic protective cushion against disaster:
$$\text{Cushion} = \min(2, \lfloor \text{Momentum} / 3 \rfloor) \quad (\text{when Momentum} > 0)$$

This creates a narrow Standing range $[\text{lo}, \text{hi}]$. The final outcome falls into one of three clear bands:
- **CLEAR (Standing $\ge +1$):** Complete success. The goal is achieved cleanly, momentum increases by $+1$, and enemy threat steps down.
- **COST (Standing between $-1$ and $0$):** Success with a complication. The action works, but at a price: take a minor injury, advance a danger clock, or expend a resource.
- **SETBACK (Standing $\le -2$):** Complication or failure. The situation escalates: suffer an injury, advance danger clocks by 1–2 segments, or lose momentum.

### 3. Position and Effect
Every risky action is also assigned a Position and an Effect:
- **Position (How risky is this?):**
  - `Controlled`: Low risk. A complication will be minor.
  - `Risky`: Standard danger. Complications carry real cost.
  - `Desperate`: Grave peril. Failure or complications will be severe.
- **The Momentum Resist Lever:** If an action is in a `Desperate` spot and the character has $\ge 3$ banked Momentum, the engine automatically burns $3$ Momentum to lower the risk to `Risky`, avoiding catastrophic fallout.
- **Effect (How much progress do you make?):**
  - `Limited`: Minor progress or partial effect.
  - `Standard`: Solid, expected achievement.
  - `Great`: Exceptional yield or decisive breakthrough.
  - Injuries reduce Effect steps, but Effect is never reduced below `Limited`—an injured character can always achieve something.

---

## 2.3 Injury & Consequence Slots

Hit points are discarded in favor of three owned **Consequence Slots**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CHARACTER INJURY SLOTS                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│ Slot 1: [Minor]                                                         │
│ • Examples: Winded, bruised ribs, superficial scratch, sprained finger. │
│ • Penalty: No mechanical penalty; flavor and narrative standing only.   │
│ • Recovery: Clears automatically after one scene of rest.               │
├─────────────────────────────────────────────────────────────────────────┤
│ Slot 2: [Moderate]                                                      │
│ • Examples: Deep laceration, cracked bone, concussion, pulled tendon.   │
│ • Penalty: -1 to Standing and -1 step to Action Effect.                 │
│ • Recovery: Requires first aid, medical treatment, or field repair.     │
├─────────────────────────────────────────────────────────────────────────┤
│ Slot 3: [Severe]                                                        │
│ • Examples: Broken limb, arterial bleed, shattered armor, trauma.       │
│ • Penalty: -2 to Standing and -2 steps to Action Effect.                │
│ • Recovery: Requires hospital care, surgery, or major recovery time.    │
└─────────────────────────────────────────────────────────────────────────┘
```
**Ownership Rule:** Every injury belongs to a specific character. When a companion or enemy is wounded in battle, the mark is placed on their record. Injuries are never dumped onto the player character by mistake.

---

## 2.4 Adversary Threat Ratings (1–10 Scale)

Enemies do not need complicated stat sheets. Combat difficulty is tracked with a single **Threat Rating**:
- **Threat 1–2 (Minion / Grunt):** Low danger. Defeated by a single solid hit.
- **Threat 3–5 (Veteran / Specialist):** Experienced fighter. Requires multiple hits or clever tactical advantage.
- **Threat 6–8 (Elite / Boss):** Imposes a $-2$ Standing penalty. Delivers severe injuries on setbacks.
- **Threat 9–10 (Legendary Horror):** S-Rank threat. Requires extensive preparation, traps, or team coordination.

When a player action scores a hit, the enemy's Threat rating decreases. When Threat reaches $0$, the enemy is routed, knocked out, or killed.

---

## 2.5 Story Stakes: Danger Clocks, Progress Bars, and Fronts

Open quests, countdowns, and impending perils live in a unified **Threads Table**:

1. **Danger Clocks:** Segmented pie wheels (4, 6, or 8 ticks) that fill when complications occur or time runs out. When full, the danger strikes (e.g., *"The dungeon roof caves in"*).
2. **Progress Bars:** Linear tracks (10 or 20 boxes) that fill as you achieve major milestones (e.g., *"Hunter Residency: 20 D-Rank Raids"*).
3. **Fronts & Warning Portents:** Major threats list ordered milestone steps that happen in plain sight before disaster lands:
   ```
   Threat: Subterranean Goblin Incursion (6-Segment Clock)
   - Step 1: Scavenger goblin tracks found in subway maintenance tunnel.
   - Step 2: Station worker goes missing; maintenance shaft bloodied.
   - Step 3: Tunnel emergency lights cut; subway line suspended.
   - Step 4: Hobgoblin raiders build fortified barricade in concourse.
   - Step 5: Police quarantine breached; civilian panic spreads.
   - Step 6 [Danger Strikes]: Horde floods into downtown city streets.
   ```
4. **Calendar Clocks:** Clocks tied to time (e.g., `"1 month"`). When world time advances, the clock ticks forward automatically in code without needing AI intervention.

---

## 2.6 Economy: Cash Accounts & Valued Inventory

To prevent money from getting lost or hitting artificial item limits (e.g. 9,999 limits), the engine separates liquid currency from physical items:

```
┌─────────────────────────────────────────────────────────────────────────┐
│ CASH ACCOUNTS (Uncapped Safe Numbers)                                   │
│ • Cash on Hand:     ₩210,000                                            │
│ • Bank Balance:     ₩1,450,000                                          │
│ • Outstanding Debt: ₩5,000,000 (Owed to Hunter Association)             │
├─────────────────────────────────────────────────────────────────────────┤
│ PHYSICAL INVENTORY (Tracked with Location, Condition, and Value)        │
│ • Steel Shortsword:       Qty: 1 | Worn (70% value)   | Unit: ₩45,000   │
│ • Reinforced Bracers:     Qty: 1 | Cracked (40% value)| Unit: ₩18,000   │
│ • E-Rank Mana Stones:     Qty: 12| Pristine           | Unit: ₩60,000   │
└─────────────────────────────────────────────────────────────────────────┘
```
- **Transaction Balancing:** Buying an item must debit cash and credit the inventory in the same step. If an item is added with no payment recorded, the engine flags a quick review question on the next turn (*"Items acquired with no payment recorded; what was paid?"*).
- **Valuation:** Physical items track their base market price and condition (`pristine`, `worn`, `cracked`, `salvage`), allowing instant resale and trade calculations.

---

## 2.7 Living World: Off-Screen NPC & Faction Turns

When a scene transitions or time skips forward, off-screen NPCs and factions take turns in the background:
- **Rooted Actions Only:** Off-screen moves must strictly target an actor's established goals (`wants`) or advance an active Front. The AI cannot invent random new factions out of nowhere.
- **Hidden Events:** Off-screen developments are logged as `hidden`. The narrator is told what happened behind the scenes but instructed to reveal it only when the player discovers clues, hears rumors, or visits the location.
- **Discovery:** When the player investigates or enters the scene, the event becomes `open` and is highlighted with a **NEW** badge in the UI.

---

# 3. Data Architecture & Schemas

## 3.1 Event-Sourced Storage (SQLite WAL)

The application uses an append-only event stream stored locally in **SQLite with Write-Ahead Logging (WAL)**. Every turn, edit, and state change is saved as an immutable event record:

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  parent_event_id INTEGER,
  message_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  event_type TEXT NOT NULL, /* delta, review, user_edit, world_move */
  payload JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_events_session ON events(session_id, variant_id);
```

- **Branch-Aware Swipes:** Message swipes form branches in an event tree. When you swipe to an earlier variant, the engine automatically rolls back subsequent state changes without destructive database edits.
- **In-Memory Projections:** The engine keeps normalized tables in memory for fast rendering, updating them deterministically whenever new events land.

---

## 3.2 State Tables & Clean Update Rules

All in-memory data tables update using four standard, predictable merge rules:
1. **Set Rule (Idempotent):** Used for alias names and binary tags. Adding something already present changes nothing.
2. **Map Rule (Last Write Wins):** Used for current scene fields (time, weather, location). Newer values replace older ones.
3. **Accumulator Rule (Addition & Clamping):** Used for item counts, cash balances, and clock ticks. Values add together and respect zero floors.
4. **Graph Rule (Append Only):** Used for the event history, swipe branches, and relationship timelines. New entries append to the list.

---

## 3.3 TypeScript Data Models

### Character Profile Schema
```typescript
export interface Appearance {
  hair: string;                   // e.g. "Chestnut brown bob, blunt bangs parted at center"
  eyes: string;                   // e.g. "Dark amber, sharp lateral tilt, heavy lashes"
  face: string;                   // e.g. "High cheekbones, slight bridge bump on nose, soft jaw"
  scent: string;                  // e.g. "Jasmine blossoms, clean cotton, damp dungeon dust"
}

export interface BodyMeasurements {
  height_cm: number;
  frame: string;                  // e.g. "Slender athletic runner's build"
  muscularity: string;            // e.g. "Defined abdominal tone, lithe shoulder definition"
  bust: string;                   // e.g. "34D, high and firm, visible beneath fitted knitwear"
  waist_and_hips: string;         // e.g. "25-inch waist, pronounced round glutes, athletic thighs"
  skin: string;                   // e.g. "Warm porcelain, light freckles across collarbone"
}

export interface Clothing {
  outerwear: string;              // e.g. "Oversized olive-drab flight bomber jacket"
  top: string;                    // e.g. "Ribbed cream tight-knit long-sleeve top"
  bottom: string;                 // e.g. "High-waisted black tactical combat denim"
  underwear: string;              // e.g. "Black lace underwire bra, matching low-rise briefs"
  footwear: string;               // e.g. "Scuffed black leather combat boots, steel-shanked"
  condition: string;              // e.g. "Clean, faint dust marks at knees"
}

export interface Weapon {
  name: string;                   // e.g. "Matte-black stiletto dagger"
  type: string;                   // e.g. "Piercing blade"
  material: string;               // e.g. "Hardened tungsten alloy"
  sheath_location: string;        // e.g. "Concealed inside left boot shaft"
  condition: 'pristine' | 'worn' | 'damaged';
}

export interface SpeechHabits {
  voice_timbre: string;           // e.g. "Husky alto, drops to a breathy whisper under tension"
  cadence: string;                // e.g. "Rapid, clipped sentences; uses rising inflections"
  speech_tics: string[];          // e.g. ["Trails with '...Mm?'", "Drops formal honorifics when angry"]
  slang_or_dialect: string;       // e.g. "Contemporary Seoul street slang, courier shorthand"
}

export interface CharacterProfile {
  id: string;
  name: string;
  aliases: Set<string>;
  kind: 'person' | 'faction';
  location: string;
  
  // Physical Appearance & Sensory Detail
  appearance: Appearance;
  body: BodyMeasurements;
  clothing: Clothing;
  weapons: Weapon[];
  speech: SpeechHabits;
  quirks: string[];               // e.g. ["Chews bottom lip raw", "Tucks hair behind ear"]

  // Social & Campaign State
  standing_facts: string[];        // Permanent truths (e.g. "Licensed Courier", "Awakened 2024")
  current_disposition: string;     // e.g. "Guarded Attraction"
  relationship_timeline: Array<{
    from_disposition: string;
    to_disposition: string;
    message_id: string;
    reason: string;
  }>;
  goals: string;                  // Active agenda driving background moves
  known_info: string;             // Lore or secrets known by this character
  contact_details: string;        // e.g. "KakaoTalk ID, Pager frequency"

  // Injuries & Threat
  injuries: Array<{
    slot: 1 | 2 | 3;
    severity: 'minor' | 'moderate' | 'severe';
    description: string;
    turn_received: number;
  }>;
  threat_rating: number;           // 0 for non-combatants, 1..10 for combatants
}
```

### Clocks, Inventory, and Financial Schemas
```typescript
export interface Clock {
  id: string;
  title: string;
  doom_description: string;       // What happens when it fills
  type: 'doom' | 'progress';
  filled_segments: number;
  max_segments: number;           // 4, 6, 8 for danger; 10, 20 for goals
  warning_steps?: string[];       // Sequential warning signs
  calendar_rate?: string;         // e.g. "1 month"
  location?: string;
  visibility: 'open' | 'hidden';
  status: 'open' | 'advanced' | 'settled' | 'moot';
}

export interface CashAccount {
  id: string;                     // e.g. "krw_cash", "krw_bank"
  currency: string;               // e.g. "KRW"
  account_type: 'cash' | 'bank' | 'debt';
  balance: number;                // Safe integer
}

export interface InventoryItem {
  id: string;
  name: string;
  location: 'carried' | 'storage' | 'equipped';
  quantity: number;
  unit_value: number;
  currency: string;
  condition: 'pristine' | 'worn' | 'cracked' | 'salvage';
  liquidity: 'high' | 'medium' | 'restricted';
}
```

---

## 3.4 Character Depth & Adult Narrative Contract

The narrator prompt explicitly directs the AI to provide physical, sensory, and tactile fidelity:

```markdown
### SYSTEM DIRECTIVE: SENSORY & SOMATIC FIDELITY
1. Physical Appearance & Presence:
   - Ground character interactions in their recorded Appearance, Body, and Clothing profiles.
   - Describe skin texture, body heat, breath rhythm, physical touch, hair movement, eye contact, and curves clearly and directly.
   - Avoid vague cliches when specific physical details can describe the moment.

2. Uninhibited Intimacy & Romantic Scenes:
   - Romantic, sensual, and explicit adult encounters are supported narrative themes. Depict them with anatomical accuracy, physical sensation, tactile friction, and emotional realism.
   - Do not use awkward medical euphemisms or cut to black unless explicitly requested by the player. Treat physical intimacy with the same high craftsmanship as combat.

3. Consistent Speech Habits:
   - Dialogue must strictly follow the character's recorded vocal timbre, sentence rhythm, slang, and speech tics.
```

---

## 3.5 AI Pipeline & Extraction Schema

Post-turn state updates are extracted in a single structured JSON call:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["deltas", "clock_updates", "identity_checks", "world_moves"],
  "properties": {
    "deltas": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["owner", "change_type"],
        "properties": {
          "owner": { "type": "string" },
          "change_type": { "type": "string", "enum": ["item", "cash", "injury", "threat"] },
          "item_change": {
            "type": "object",
            "additionalProperties": false,
            "required": ["name", "quantity_delta", "location"],
            "properties": {
              "name": { "type": "string" },
              "quantity_delta": { "type": "integer" },
              "location": { "type": "string", "enum": ["carried", "storage", "equipped"] },
              "unit_value": { "type": "number" }
            }
          },
          "cash_change": {
            "type": "object",
            "additionalProperties": false,
            "required": ["currency", "account_type", "amount_delta"],
            "properties": {
              "currency": { "type": "string" },
              "account_type": { "type": "string", "enum": ["cash", "bank", "debt"] },
              "amount_delta": { "type": "number" }
            }
          },
          "injury_change": {
            "type": "object",
            "additionalProperties": false,
            "required": ["slot", "description", "severity", "active"],
            "properties": {
              "slot": { "type": "integer", "enum": [1, 2, 3] },
              "description": { "type": "string" },
              "severity": { "type": "string", "enum": ["minor", "moderate", "severe"] },
              "active": { "type": "boolean" }
            }
          },
          "threat_delta": { "type": "integer" }
        }
      }
    },
    "clock_updates": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["clock_id", "status", "evidence"],
        "properties": {
          "clock_id": { "type": "string" },
          "status": { "type": "string", "enum": ["open", "advanced", "settled", "moot"] },
          "evidence": { "type": "string" }
        }
      }
    },
    "identity_checks": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["pair_id", "is_same_entity"],
        "properties": {
          "pair_id": { "type": "string" },
          "is_same_entity": { "type": "boolean" }
        }
      }
    },
    "world_moves": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["actor_name", "action_summary", "grounded_goal"],
        "properties": {
          "actor_name": { "type": "string" },
          "action_summary": { "type": "string" },
          "grounded_goal": { "type": "string" }
        }
      }
    }
  }
}
```

---

# 4. Interface & Design System

## 4.1 Viewport Breakpoints & Screen Layouts

The layout adapts cleanly across devices:

```
DESKTOP (1440px and up)
┌─────────────────────────────────────────────────────────────────────────┐
│ Top Status Bar (Height: 36px, Full Width)                               │
├───────────────────────────────────────────┬─────────────────────────────┤
│                                           │ Quick HUD Panel             │
│ Primary Story Reading Stream              │ (Width: 380px)              │
│ (Max Width: 760px, Centered)              │ - Immediate Stakes First    │
│                                           │ - Direct Inline Edit        │
│                                           │ - Quick Modal Jump          │
├───────────────────────────────────────────┴─────────────────────────────┤
│ Action Input Bar (Max Width: 760px, Centered)                           │
└─────────────────────────────────────────────────────────────────────────┘

LAPTOP & TABLET (768px - 1439px)
┌─────────────────────────────────────────────────────────────────────────┐
│ Top Status Bar (Height: 36px, Full Width)                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Primary Story Reading Stream (Max Width: 740px, Centered)               │
│                                                                         │
│ * Detail Modal opens on-demand as a 420px slide-over from the right.    │
├─────────────────────────────────────────────────────────────────────────┤
│ Action Input Bar (Max Width: 740px, Centered)                           │
└─────────────────────────────────────────────────────────────────────────┘

MOBILE (Under 768px)
┌─────────────────────────────────────────────────────────────────────────┐
│ Top Header: Scene Location & Time (Height: 32px)                        │
├─────────────────────────────────────────────────────────────────────────┤
│ Full-Width Story Reading Stream (Lateral padding: 16px)                 │
│                                                                         │
│ * Detail Modal slides up from bottom (100% width, 92% height).          │
├─────────────────────────────────────────────────────────────────────────┤
│ Action Input Bar                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│ Sticky Bottom Status Bar (Cash · Main Clock · Roll Result Chip)         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 4.2 Core Screen Components

### 1. Top Status Bar (`#status-bar`)
- **Layout:** Left (Time, Date, Location), Center (Cash Balance), Right (Main Danger Clock, Last Roll Outcome Chip).
- **Interaction:** Clicking any section opens the Quick HUD or Detail Modal focused on that topic.
- **States:** Neutral dark gray by default; pulses with green (`CLEAR`), amber (`COST`), or crimson (`SETBACK`) when an action resolves.

### 2. Story Reading Pane (`#story-stream`)
- **Layout:** Clean typography column. Player inputs render in distinct dialogue callouts; assistant responses render in reader-friendly body prose (60–75 characters per line).
- **Inline Entity Highlights:** Character and item names have subtle dotted underlines; hovering displays a quick summary card showing appearance, injuries, and current attitude.

### 3. Quick HUD Panel (`#quick-hud`)
- **Dimensions:** Width $288\text{px}$ (laptop) to $380\text{px}$ (desktop); scrollable.
- **Content Hierarchy:**
  1. `[You]`: Character name, active injuries, cash on hand.
  2. `[Danger]`: Ticking danger clocks sorted by urgency.
  3. `[Goals]`: Active campaign progress bars.
  4. `[Present]`: Characters currently in the scene with attitude badges.
  5. `[Weapons & Gear]`: Carried items, condition ratings, and weapons.
- **Direct Editing:** Clicking any number or text field lets you edit it in place. Clicking the lock icon pins it so the AI cannot change it. Clicking the row opens its full tab in the detail modal.

---

## 4.3 The 9-Tab Detail Modal

Clicking any element on screen opens the full detail modal (`<dialog>`), focused directly on the requested tab:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ SANGUINE DETAIL MODAL                                                                                  │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ [Characters] [Clocks] [History] [Inventory] [Places] [Corrections] [Audit] [Prompts] [Diagnostics] [✕] │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ TAB CONTENT:                                                                                           │
│                                                                                                        │
│ 1. CHARACTERS (overlay-cast.js)                                                                        │
│    - Roster of all characters and factions (Present, Elsewhere, Departed).                             │
│    - Full Dossier: Hair, eyes, face, bodily measurements, clothing layers, weapons, voice, and tics.   │
│    - Star Character Toggle: Marks character for detailed inclusion in AI story prompts.                │
│    - Relationship Timeline: History of attitude changes with clickable links to the exact message.     │
│    - Aliases & Agendas: Known nicknames and active background goals.                                   │
│                                                                                                        │
│ 2. CLOCKS & GOALS (overlay-threads.js)                                                                 │
│    - Danger clocks, progress bars, and open quest leads.                                               │
│    - Details: What settles it, consequences of failure, location, deadlines, and warning steps.        │
│    - Quick Controls: Mark settled (✓), edit (✎), drop (✕), or pin as primary focus.                   │
│                                                                                                        │
│ 3. HISTORY & RECALL (overlay-chronicle.js)                                                             │
│    - Chronological log of past story beats and events.                                                 │
│    - Event breakdown: items gained/lost, injuries received, clocks ticked.                             │
│    - Source tags: shows whether an event came from story prose, player edit, or background move.       │
│                                                                                                        │
│ 4. INVENTORY & GEAR (overlay-inventory.js)                                                             │
│    - Categorized shelves: Carried, Storage, and Equipped.                                              │
│    - Market Values: Base price, condition (pristine/worn/salvage), and liquidity.                     │
│    - Acquisition History: Click any item to jump to the story turn where it was acquired.              │
│                                                                                                        │
│ 5. PLACES & ASSETS (overlay-assets.js)                                                                 │
│    - Property Holdings: Owned buildings, shops, vehicles, and land.                                    │
│    - World Map Tree: Nested hierarchy of cities, districts, buildings, and rooms.                     │
│    - Recurring Income & Upkeep: Automatic cash flow calculated per in-game day or month.               │
│                                                                                                        │
│ 6. CORRECTIONS & RECONCILE (overlay-repairs.js)                                                        │
│    - Surfaces differences between story text and game records.                                         │
│    - Safe fixes (renames, item moves) apply automatically with undo options.                           │
│    - Destructive fixes (deleting items or characters) require player confirmation.                     │
│                                                                                                        │
│ 7. AUDIT & HEALTH (overlay-audit.js)                                                                   │
│    - Checks for duplicate items, missing payments, or split character profiles.                        │
│    - One-click manual cleanup tools to keep records consistent without breaking story immersion.      │
│                                                                                                        │
│ 8. PROMPT SETTINGS (overlay-prompts.js)                                                                │
│    - Live view of the compact summary injected into the AI story prompt.                               │
│    - Turn individual sections on/off or add custom instructions.                                       │
│                                                                                                        │
│ 9. DIAGNOSTICS (overlay-diagnostics.js)                                                                │
│    - AI performance metrics, prompt cache hit rates (60–75%), token counts, and extraction speed.       │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4.4 Design Tokens & Typography Scale

### Dark-Theme Color Palette
```css
:root {
  /* Surface Colors */
  --bg-app: #0d0d0f;
  --bg-surface: #16161a;
  --bg-surface-elevated: #1f1f24;
  --bg-scrim: rgba(0, 0, 0, 0.65);

  /* Borders & Dividers */
  --border-subtle: #26262c;
  --border-strong: #383842;
  --border-focus: #5e6ad2;

  /* Typography Colors */
  --text-primary: #ececf1;
  --text-secondary: #9e9ea8;
  --text-muted: #666672;
  --text-inverse: #0d0d0f;

  /* Outcome & Accent Colors */
  --accent-clear: #22c55e;        /* Green: Full success, progress */
  --accent-cost: #f59e0b;         /* Amber: Success with complication */
  --accent-setback: #ef4444;      /* Red: Complication, danger */
  --accent-link: #6366f1;         /* Indigo: Clickable links, buttons */
  --accent-pinned: #d97706;       /* Amber: Locked/pinned items */
}
```

### Typography Hierarchy
```css
:root {
  --font-story: "Charter", "Georgia", "Merriweather", serif;
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Consolas", monospace;

  --text-xs: 11px;     /* Metadata, clock segment numbers */
  --text-sm: 13px;     /* Status bar items, badge labels */
  --text-base: 15px;   /* UI controls, HUD item descriptions */
  --text-story: 17px;  /* Story reading pane (1.6 line height) */
  --text-lg: 19px;     /* Card titles, character names */
  --text-xl: 24px;     /* Modal titles, major milestones */
}
```

---

## 4.5 Keyboard Shortcuts

| Key | Context | Action |
|---|---|---|
| `Tab` | Global | Toggles the Quick HUD or Detail Modal open/closed. |
| `Escape` | Modal / HUD | Closes active modal, dismisses tooltips, or cancels inline text editing. |
| `Ctrl + K` / `Cmd + K` | Global | Opens the quick-search omnibox for characters, items, and quests. |
| `Alt + 1` | Global | Opens Detail Modal to **Characters**. |
| `Alt + 2` | Global | Opens Detail Modal to **Clocks & Goals**. |
| `Alt + 3` | Global | Opens Detail Modal to **Inventory & Gear**. |
| `Enter` | Inline Edit | Saves edited text to the event log. |

---

This specification serves as the direct, clean technical blueprint for implementing the Sanguine TRPG engine as a modern, local-first application.
