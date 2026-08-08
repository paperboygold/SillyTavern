# fold — what the Solo Leveling chat proved, and how far it is from the system we agreed on

Measured against `data/default-user/chats/Solo Leveling The Eve of the Double Dungeon/*.jsonl`
→ `chat_metadata.fold`, at message 56 (fold turn 9, `clock.seen` 29). Not against the test suite:
the two worst defects found this session both had passing tests over them.

---

## 0. The repair that was applied by hand

`scratchpad/repair.py`. Nothing in it is a code change; every line is a place fold got the world
wrong and had no mechanism to correct itself.

| repaired | was | should have been |
|---|---|---|
| Kang | **two records** — `person␀c-rank team leader` (place *dungeon cavern*, turn 2) and `person␀kang` (place *the chamber*, turn 5) | one person, one place |
| Kim, Park, Lee, the Association agent | standing in *the chamber* — a dungeon cleared, looted and sealed 20 messages earlier | dispersed at the Nowon gate site |
| *Nowon D-rank gate* | **open** — "the gate has not been cleared, no team has entered" | closed. The news crawl in the fiction says so twice. |
| *Goblin Market gear trip* | open — "Solomon has not yet decided whether to go" | closed. He is standing in it. |
| residency, teaching Jin-Woo, Kang's standing offer, Jin-Woo's family, buying a weapon | **absent** | five live threads the fiction established explicitly |
| pressure | *goblin nest counterattacks 1/4*, *the party is overwhelmed 1/6* | both moot — nest routed, hobgoblin dead, gate sealed |
| point of view | **"Jin-Woo"** | Solomon Winters |
| conditions | "limping, scratched cheek" — Jin-Woo's face | bandaged left calf, bruised left arm |
| weather | "damp, lit by phosphorescent moss" — the dungeon, 21 turns stale | overcast thinning to pale blue |
| money | **won ×9,999** | ₩330,000 |
| status | "bleeding" — *Lee's ribs and Park's thigh*, filed under the player | the player's own two injuries |
| carried | knife, licence, pamphlet all silently hidden; phone numbers ×2 each | one of each |

> ⚠ **SillyTavern must reload the chat before you play on.** It holds `chat_metadata` in memory and
> writes the whole blob on save — it clobbered this repair once already mid-verification. Switch
> chats and back, or refresh, before the next message.

---

## 1. The one-sentence diagnosis

**fold tracks nouns and sentences about them; every system we agreed to draw on tracks things that
are at stake.**

Fate, Ironsworn, Blades, Scarlet Heroes and Mythic all represent a world as a small set of things
that *change state under pressure* — a clock that fills, a track that advances, a consequence slot
that takes a wound, a Hit Die that steps down. In fold, the only object that can be at stake is a
clock, and clocks cannot resolve. Everything else is a name with a description hanging off it.

The corollary, which the chat demonstrates line by line: **nothing in fold can be closed.**

| table | can it retract? |
|---|---|
| leads | `status ∈ {open, stalled, closed}` exists (`entities.js:142`) and nothing ever writes `closed`. Two resolved threads sat open for 8 turns. |
| clocks | `foldClocks` rejects `tick === 0` as `no-change` (`clock-table.js:218-221`); `renderClocks` filters only on *full* and *local* (`:325`). A threat that stops existing has no exit. |
| people | can go `elsewhere`, never *dispersed*. `RETIRED` (`entity-table.js:69`) means left the **story**. |
| items | expire by **silence**, not by being spent (`state-table.js:1057-1073`) — see §4. |
| context | expires on one global clock regardless of half-life — see §5. |

The plan already named this for presence: `merge_NB` is monotone, so membership cannot be retracted,
and the fix is to derive presence rather than store it. That analysis was right and it was applied
too narrowly. **The same bug is in the lead table, the clock table and the status flags**, and in
each case for the same reason — the retraction event is something a narrator never bothers to say.
Nobody writes "the gate is no longer uncleared."

---

## 2. Identity: Kang existed twice, permanently

`canonicalKey` (`entity-table.js:367-385`) resolves aliases by **exact normalised-string set
membership** (`:380`). At turn 2 the record held `name: "Kang Min-seo"`. At turn 3 the narrative
called her "Kang". `"kang" ≠ "kang min-seo"`, so a second record opened.

Then it became permanent: `:369` short-circuits on the direct key —

```js
const direct = entityKey(kind, nameKey);
if (table.has(direct)) return direct;
```

— so once both keys exist, every later write to "Kang" lands on the direct key and the alias scan
never runs again. Both records later acquired the alias *team leader* and **still** never merged.
There is no repair path in the code; the two rows drifted to two different places and both were
wrong.

The docblock at `:348-356` defends rejecting similarity measures, and it is right about the case it
argues — "the Hero" and "Solomon" share no characters, so no metric can help. But it generalised
from the hard case to the easy one. A character introduced by full name and thereafter called by one
part of it is the single most common naming pattern in fiction, and it is a *token subset* test —
exactly the rule `samePlace` (`entity-table.js`, and again at `clock-table.js:292-302`) already uses
for places.

**Roleplayer's complaint:** the squad leader who doubled my pay out of her own share, whose number I
went out of my way to get, is two strangers in the cast list, in two different rooms, neither of
which is where she is.

---

## 3. Cost is the thing that isn't tracked

Over the raid the player spent, broke, took and banked ten things. Fold recorded them like this:

| what happened | fold |
|---|---|
| ₩360,000 raid share | **₩9,999** |
| paid for two bowls, extra egg, two bottles of soju | not recorded — money only ever went up |
| bracer shattered blocking a goblin | not recorded |
| second bracer cracked blocking a hobgoblin cleaver | not recorded |
| clawed left calf | flag `cut left calf`, no owner |
| left arm numbed to the shoulder | flag `numb left arm`, no owner |
| Kang doubled his cut from her own share | not recorded |
| Jin-Woo gave him a spare bracer and his last bandage | not recorded |
| the ahjumma fed him pork belly she didn't charge for | not recorded |
| stone crate — Association property, handed back | still carried |

The money case is precise and worth stating exactly, because it is not the ceiling I fixed last
turn. `maxQty` keys off **place** (`state-table.js:201-203`), so currency escapes the 9,999 item
clamp only when the extraction tags it `at: "money"`. The schema says so clearly (`state.js:356`)
and lists `at` as **required** (`:359`) — and the stored event is `{"item": "won", "dq": 360000}`
with no `at` at all. `required` is not enforced at runtime, nothing rejects a delta missing it, and
the untagged delta falls through to `carried`, where `merge` clamps at `MAX_QTY` (`:590`). So
`MAX_MONEY = Number.MAX_SAFE_INTEGER` (`:194`) is correct and was unreachable.

The status case is worse than a clamp. The `st` schema (`state.js:377-390`) is
`{flag, on, turns}` — **there is no subject.** Lee took claws across the ribs; Park's thigh reopened.
Both wrote `flag: "bleeding"` into the same flat namespace, and the panel rendered *the player* as
bleeding for the rest of the session. Five people were wounded in that fight and fold has one
undifferentiated `Status:` line.

**Roleplayer's complaint:** simulationism *is* the accounting of cost. If smart play is rewarded and
dumb play is fatal, then the ledger of what things cost is the entire game. Mine says I have ₩9,999
and someone else's ribs.

---

## 4. Possessions expire by silence

`isFresh` (`state-table.js:1057-1073`) hides a carried item after `STALE_THRESHOLD = 12` (`:305`)
events without a mention. The counter reads **`cap:stale-hidden: 97`**. Hidden by that rule at the
moment I looked: the goblin knife he killed for and has been fighting with, his hunter's licence,
the residency pamphlet, both bracers.

The docblock (`:1058-1068`) is honest that the threshold is a proxy for "nobody has mentioned this,
so perhaps it is gone", and scopes it to `CARRIED` for that reason. It is still the wrong shape of
inference, and the corpus says so directly: `BayesFilter.zero_residual_is_fixed` — absent new
evidence, belief holds **exactly**. A knife does not become uncertain because the conversation moved
on to noodles. What *should* expire is an assertion about a fast-moving variable (where someone is
standing), and what should never expire is a durable fact (what is on your belt). Fold has it
inverted: places persist forever and possessions evaporate.

Two adjacent defects in the same ledger:

- **Overlapping extraction windows double-count.** `5866000698935565` (mid 50) and
  `2498705269757958` (mid 52) both record "Solomon offers to teach Jin-Woo IT" and both record the
  phone-number exchange. Each phone number landed twice, once under `carried` and once under
  `contacts` — different `at`, therefore different `itemKey`, therefore no collision to notice. The
  goblin knife was acquired twice the same way (mid 22 and mid 38).
- **`canonicalItemName` merges by containment.** A `set` of `phone` (his handset) was absorbed into
  the existing `solomon's phone number`. One name containing another is not identity.

---

## 5. Everything ages on one clock

`context` holds, side by side, on the same staleness policy (`contextBand`, `state-table.js:339`;
`CONTEXT_ANNOTATE_AFTER = 2` at `:331`, drop at `STALE_THRESHOLD`):

- `rank: "E-Rank Hunter"` — the fiction states twice that rank is **fixed at Awakening and will not
  change**. Permanent.
- `location` — changes when you walk.
- `weather` — changes hourly, and was 21 turns stale reading *phosphorescent moss* while the player
  sat in a noodle shop.

Three different half-lives, one threshold. The two turn-2 entries I deleted (`immediate contacts`,
`leads`) were fossils of the opening status block that had survived 27 turns because nothing
contradicted them in the exact words required.

And at turn 29 the scene probe set **`pov: "Jin-Woo"`** — the panel claiming the player is playing
the NPC. That one is not staleness, it is a misread, and it is the failure with the highest blast
radius in the whole system: `conditions` followed it and started reporting Jin-Woo's scratched cheek
as the player's injuries.

---

## 6. Adjudication has never actually run

`verdict:uncontested` 4, `verdict:skipped` 1, across 29 assistant turns. **Not one real verdict.**

That is not yet a defect — automatic adjudication only went in partway through this session, and all
five of those turns were genuinely conversation over ramyeon. But it means the entire Phase 4
mechanism is unexercised, and the chat contains the exact test case it was built for. Message 35:

> *"I sprint TOWARDS the goblins and scream at them loudly… leap straight over their heads to circle
> around behind the hobgoblin."*

An E-rank with a wounded calf and a rusted knife vaults a rank of charging goblins, unopposed, and
lands where he intended. `standingRange`/`adjudicate` (`verdict-table.js:195-198`) never saw it.

Credit where it is due: the narrator imposed a cost anyway — claws opened his calf on the way over,
and the second bracer cracked blocking the cleaver two messages later. `gm-core.md`'s *"player
agency is not player immunity"* is visibly working. But that is the prompt holding the line, and the
research finding this whole design rests on is that prompt-level strictness **decays with context
length**. At turn 29 it holds. The bet is about turn 200.

**No adversary was ever tracked.** Messages 26–38 are a six-message pitched battle with eight-plus
goblins and a hobgoblin, and fold's representation of the enemy was two clocks, both of which ticked
once and then stopped. Scarlet Heroes' whole contribution — one integer per adversary — is not
partially implemented; it is absent.

---

## 7. Distance from the system we agreed on

| mechanism | source | state |
|---|---|---|
| Threads / Characters as the whole memory | Mythic | **built.** `leads` + `people`, with `feels`/`wants`/`knows`. The best thing in fold. |
| Threads must *close* | Mythic | **missing.** Vocabulary exists, nothing writes it. |
| Progress tracks | Ironsworn | **missing.** "20 raids in 12 months" is the campaign's spine and is inexpressible — I had to file it as a lead with the count in prose. |
| Clocks | Blades | **built, cannot resolve.** No locality on records written before `where` existed; no eviction below `MAX_CLOCKS = 12` (`clock-table.js:57, :178`), so dead pressure accumulates and eventually refuses live pressure. |
| Consequences replacing HP — 3 slots, phrase + severity word | Fate / Cortex | **missing.** Flat, unowned boolean flags instead. |
| Aspects — a phrase that is mechanically live | Fate | **missing.** `detail` is prose *without* mechanical standing: it drifts and cannot be reasoned over. The plan called this the worst case; it is what shipped. It is also why `detail` froze instantaneous posture — "sheathing her blade", "staring at hobgoblin corpse" — as standing fact, which is `LevelOfDetail.lean:140` exactly: you are not allowed to expect the same person in the same doorway. |
| One integer per adversary | Scarlet Heroes | **missing entirely.** |
| Resources as a usage die | Black Hack | **missing.** Item arithmetic instead, which is what produced ₩9,999. |
| three-band outcome, decided in code | Ironsworn / PbtA | **built, unexercised.** `CLEAR / COST / SETBACK` at `verdict-table.js:70-71`. |
| Momentum / standing | Ironsworn | **partial.** `state.momentum` exists (`verdict.js:39`); the three obligations the player actually banked this session are not in it. |
| Precedent as the oracle | the plan's core claim | **built** (`precedentFor`, `verdict-table.js:238`), never invoked, because §6. |
| Faction status as one integer | Blades | **missing.** White Tiger is not an entity, though the player now has a standing relationship with it. |
| Faction turns | SWN | **missing.** |
| Fate-point economy | Fate | **deliberately dropped** ✓ — correct call, degenerate with one LLM as banker and beneficiary. |

### The shape of the gap

Read down that table and the pattern is not "features missing". It is that **fold built the memory
and skipped the mechanics.** The Mythic layer — who exists, what they want, what threads are open —
is genuinely good and better than what Scribe or RPG Companion ship. Everything that makes those
threads *bite* is absent: nothing advances, nothing resolves, nothing costs, nothing is at stake.

Which is why the panel reads as a database viewer. It is one. Nine leads that cannot close, seven
people who cannot leave, two clocks that cannot stop, and an inventory that forgets your knife.

### The cheapest three things that would change the feel

Stated for the record, not actioned:

1. **A retraction path for every table.** One shape, applied to leads, clocks and status alike: the
   probe is asked what became *settled* this turn, not only what is true. Presence already proved
   the pattern — derive, don't store — and the same trick works for a thread ("is anything still
   open about this?" is already the `open` field, and it is already the gate `isExposition` uses).
2. **A subject on every state change.** `st` needs a `who`, consequences need an owner, and the
   moment they have one, five wounded hunters become five people with visible damage instead of one
   corrupted status line. This is also the smallest step toward Fate consequence slots.
3. **Progress tracks as a first-class face.** 1-of-20 raids, 0-of-N toward a goal. It is the Count
   face with a target, it is the campaign's actual spine, and today it is a sentence inside a lead.

Everything else on the list is downstream of those three.
