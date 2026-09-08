# FOLD-CENSUS, Phase 0: what the LLM sends, what fold does with it, what the player had to fix

Measured over every trace and ledger on disk, 2026-09-01. Every row cites a real `path:line`.
This is the empirical base for the Phase 1 schema: every rule there traces to a row here.

## The corpus

| source | count | what it holds |
|---|---|---|
| `sanguine-traces/*.jsonl` | 11 files | recent extraction passes: full prompt + raw reply + parsed probes |
| `fold-traces/*.jsonl` | 37 files | older extraction passes, same shape |
| `sanguine-ledger/*/ledger.jsonl` | 26 chats with content | the chronicle/event log, `op=ev` (+ `op=forget`), with `src=llm/review/verdict/world/user` |
| `sanguine-ledger/*/ledger.jsonl.pre-*` | 7 snapshots | hand-repair backups, `pre-gold`, `pre-purse`, `pre-threads` ×2, `pre-abilities`, `pre-year`, `pre-repair` |
| chats under `data/default-user/chats/` | 20 dirs, ~10 with play | the fiction; state in each file's `chat_metadata.sanguine` |

**Extraction passes: 2,337, all `ok`.** 3,314 events over 2,337 passes; **494 passes (21%) produced an empty `events` array**. 49 trace files across ~20 chats; Wuxia dominates (~1,170 passes).

## The census, failure class × evidence × what catches it

### 1. IDENTITY, the key is guessed from free text, not referenced

- **572 distinct item names sent; 612 token-containment pairs** (strict-token-subset either way, `nearIdentity`'s algebra). The real ones, with the count each spelling was sent:
  - `'knife'` ×10 against `'ka-bar knife'` ×1
  - `'key'` ×6 against `motor pool key`, `room key`, `bronze key` ×12, `iron key`, `brass chest key`, `brass room key`, `heavy brass gate key`
  - `'med kit'` ×3 against `'med kit x2'`; `'duffel bag'` against `'tactical duffel bag'`; `'shotgun shells'` against `'shotgun'`; `'water bottles'` against `'water'`
- **The same row both fails and works in the same trace file:**
  - `sanguine-traces/Raccoon City First Day - 2026-08-09@13h39m44s933ms.jsonl:105` → `{"item":"knife","same_as":"ka-bar knife","dq":0}`: the model correctly named the held item via `same_as`
  - `sanguine-traces/Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl:34` → `{"item":"knife","same_as":"","dq":1}`: bare `knife`, no `same_as`, a second row or a wrong merge
- **Pov is free text and varies per spelling:** `Chí Guāngdé` 1139, `Solomon` 439, `Sol` 399, `Solomon Winters` 43, `Chi Guangde` 26, the same protagonist under four spellings. `fold-traces/Star Wars RPG - Non-COMPNOR compliant - 2026-08-09@01h05m10s856ms.jsonl:1-3` (`pov:"Sol"`).
- **Comma-joined items the player split by hand:** `ledger bc9cefec…` user events carry `"item":"school uniform, backpack"` and `"item":"school uniform, rough cloth wraps, backpack, smartphone, wallet"`: the model lumped distinct things into one name; the player re-stated them as separate rows.

**Catches it:** Phase 1's stable-ID reference (held things are `id`, not name) + Phase 3's `[same?]` for suspicions.

### 2. SUMMARIZATION, distinct things summed under one key

- `sanguine-traces/Raccoon City First Day - 2026-08-09@13h39m44s933ms.jsonl:22` → `{"item":"ammunition","dq":28,"at":"carried"}`: three magazines + twenty-five shells + a box of birdshot, one mass noun.
- The player's repair, verbatim, `ledger d66c02ab…`: *"Corrected: 'ammunition ×29' was three magazines, twenty-five buckshot shells and a boxed pickup counted as one unit"*, then three separate `dq` events for `9mm magazines` (3), `buckshot shells` (25), `box of birdshot` (1).

**Catches it:** schema clause (one entry per distinct named thing, a category is a violation) + Phase 3 SPLIT.

### 3. OMISSION, events never extracted (the dominant hand-correction class)

The player's own reconciliation events, `ledger d2294245…`:
- *"HP corrected to 38/70, the wolf-fight damage after message 22 (52, 43, 38) was never extracted"*
- *"ten wolf pelts collected and the healing salve carried in the belt pouch were never tracked"*
- *"wounds from the wolf pack fight, shredded forearm and crushed ribs, recorded as the current top consequences"*
- *"the Minor Healing Salve (msg 43), HP 38→56, 8 wolf pelts carried (two still needed), salve consumed"*

Plus, added by hand: `brass telescope` at assets, `12 sacks of grain` at scullery (`ledger d66c02ab…`), `silver` +6 (`cac4153c…`), `copper coins` −60/+50, `hp` corrected (`4919a84e…`).

**Catches it:** no schema catches omission. Only the stated-total conservation check does (Phase 2), and it is almost never given anything to check (row 7).

### 4. RETRACTION, things persist past their end

- *"Solomon is over: tired hands and burning eyes (they were one line at mid 90, restated for 30 turns)"*, `ledger d66c02ab…`; the status row survived 30 turns past resolution.
- `pre-threads-*` snapshots (×2), threads the fold never closed.
- **20 `op=forget` records in the ledger**, the only retraction that exists, and it is manual.

**Catches it:** Phase 3 staleness detector, carried/open + old last-event → *ask*, never hide (reverses the 540 `stale-hidden` sin).

### 5. MISSING SUBJECT, status without a `who`

- **190 of 307 st deltas (62%) carry an empty `who`.** The shape `{flag,on,severity,subject,turns,who}` is uniform, but `who` is empty 62% of the time.
- Player's repair: *"wounds from the wolf pack fight, shredded forearm and crushed ribs, recorded as the current top consequences"*, the missing consequences had no subject.

**Catches it:** Phase 1 schema, `who` required, defaulting to pov only when the story names no one else.

### 6. TAGGING, `at`

- **1 of 1,641 inv deltas has no `at`**, the money ×9,999 class is closed (the ceiling now reads off the key, `state-table.js:1231-1236`).

**Catches it:** already landed. `at` stays an enum of known places + carried/money/assets/abilities.

### 7. STATED-TOTAL SCARCITY, the conservation check has nothing to check

- **11 `set` vs 1,525 `dq` in 1,641 inv deltas** (105 carry neither). The model almost never reports an absolute total, so the fold accumulates `dq` with no anchor to a stated truth, which is why a wrong accumulation can never be detected.
- Only 3 of 1,641 deltas carry `how`: the acquisition channel is unexercised.

**Catches it:** Phase 1 schema makes `set` a first-class instruction ("when the story states a current total, send `set`"); Phase 2 diffs `set` against the accumulated fold.

### 8. UNDER-REPORTING, the event stream is thin

- 494/2,337 (21%) empty `events` arrays; threads empty 1,422/2,330 (61%); scene `elapsed_minutes` nonzero on 87% of passes (the clock moves; the ledger doesn't).

**Catches it:** the deep audit's conservation + staleness detectors are the backstop for a thin stream, exactly rows 3 and 4.

## The design rules Phase 1 must satisfy (each traced above)

| rule | traces to |
|---|---|
| **R1** Held things are referenced by stable opaque ID, never by name. New things get an ID at creation; `same_as`/`[same?]` merge reassigns it. Pov, location, weather are scene rows with IDs, not free text. | row 1 |
| **R2** One entry per distinct named thing; a category is a schema violation (the ammunition clause already exists; it must hold for every kind). | row 2 |
| **R3** `set` is a first-class instruction: a stated total sends `set`; the fold diffs it against accumulated `dq`. A `set`/fold mismatch is a conservation diff. | rows 3, 7 |
| **R4** Every quantitative row has a ceiling derived from its `at`; capacity is Σ carried ≤ limit (the anti-1000kg). | row 6 + the whole thesis |
| **R5** Every state change has a subject (`who` required; default pov only when the story names no one else). | row 5 |
| **R6** Retraction is an op, not an omission: `close`/`spend`-to-zero/`move`-home/`dispersed`; staleness asks, never hides. | row 4 |
| **R7** Coverage by ID: `mentions` names rows, exact membership, any language. | row 1 (the Zhāng Lín/张林 class) |
| **R8** The deep audit runs exact detectors (conservation diff, staleness, capacity) → a shortlist with chronicle evidence → one bounded adjudication call → visible, undoable ledger. Diffs never enter the fiction; an unresolvable one is a clickable reconcile item. | rows 3, 4, 7, 8 |

## Hand-correction ground truth (the `user`-sourced ledger events)

43 `src=user` events + 20 `forget` ops + 7 `.pre-*` repair snapshots. Every one is a violation a human caught that no detector did, the Phase 3 detector list is exactly "which detector would have caught this." The snapshot names name the failing subsystem outright: `gold`, `purse`, `threads` ×2, `abilities`, `year`, plus the free-text reconciliation events quoted above (HP, wolf pelts, wounds, salve, ammunition, tired-hands).

---

## Phase 1 live gate, measured against the model, 2026-09-01

`replay-rows.js --live` over the Raccoon City First Day chat (272 messages, 7 passes, the real
DeepSeek profile), folding the model's rows-ops through the new fold:

| metric | result |
|---|---|
| held-row ops referencing a valid id | **28/28 = 100%** (bound 60-row ledger; unbounded it fell to 88%) |
| duplicate-row attempts refused | 112 (`new-matches-held`), zero duplicate rows created |
| summarization (`ammunition x29`) | closed by construction, magazines, buckshot, birdshot, slugs are separate rows |
| conservation diffs (`set` vs fold) | 0, the model sent `set` on no pass |

Two findings the run exposed that the census could not:
1. **The pinned ledger must be bounded**, an unbounded ledger (162 rows of sounds and doors) exceeds what the model can see, so it stops referencing IDs and starts re-creating rows. The 60-row live-first bound took the held-id rate from 88% to 100% and is what the probe now ships.
2. **`set` is never volunteered**, the model sends `dq` and never a stated total, so the conservation check has nothing to fire on. Phase 2's instruction push + the deep audit's stated-total read are the fix, not a schema change.
