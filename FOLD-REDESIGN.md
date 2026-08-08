# fold redesign — from a database of nouns to a ledger of stakes

*Design document only. No implementation has been done. Companion to
`FOLD-RPG-GAP.md` (the problem statement) and `~/.claude/plans/abundant-drifting-eagle.md`
(the prior plan, phases 1–4 of which are built). This document does not restate their research;
it builds on it, corrects it where the source disagrees, and commits to a schema, a retraction
mechanism, a UI, a migration, and an ordered plan.*

**Ground truth for every measurement below** is the user's live chats, re-read today:

| chat | messages | `clock.seen` | events | headline counters |
|---|---|---|---|---|
| Solo Leveling — Eve of the Double Dungeon (message 72, turn 14, `clock.seen` 40, after the **second** hand repair — §0.1) | 72 | 40 | — | `extract:ok` 14 · `retry-empty` 16 · `delta-empty` 21 · `cap:stale-hidden` 198 · `cap:context-stale` 82 · `verdict:uncontested` 14 · **bands still 0** · `cap:field-locked` 7 · `reject:remove-unknown` 4 · `reject:clock-reversed` 1 |
| Evil Hero Party (2026-08-07, 171 msgs) | 171 | 91 | 27 (1 with a delta) | `extract:ok` 16 · `waiting` 53 · `retry-empty` 12 · `unparseable` 2 · **zero clocks in 91 turns** |
| Raccoon City First Day (2026-08-06, 153 msgs) | 153 | 56 | 57 (57 with deltas) | **`cap:stale-hidden` 540** and nothing else — extraction never ran; everything came from block absorption |

The task brief quoted an earlier snapshot of the Solo Leveling counters (`extract:ok` 9,
`stale-hidden` 97, `uncontested` 4); play has continued since, so the numbers above are the
baseline this design must beat. All 787 unit tests pass at time of writing
(`npm run test:unit --prefix tests`, 19 suites).

---

## 0. What the live log says today, two days after the hand repair

`FOLD-RPG-GAP.md` §0 describes a hand repair (`scratchpad/repair.py`) applied at turn 29.
The chat has since advanced six turns. Reading the header again is the fastest possible argument
for this redesign, because **every repaired class of defect has already recurred**:

- **Identity split again.** `person␀scarred broker` (turn 10, place *"Goblin Market, basement of
  old shopping centre, Jongno 3-ga"*) and `person␀broker` (turn 11, place *"the broker's shop"*)
  are one man behind one counter. This is the Kang bug (`FOLD-RPG-GAP.md` §2) reproducing within
  48 hours of being hand-fixed, via the same short-circuit: `canonicalKey` returns the direct key
  before the alias scan can run (`entity-table.js:368-371`). "broker" ⊂ "scarred broker" is a
  token subset — the exact test `samePlace` already trusts for places (`entity-table.js:169-181`).
- **Presence is right and the vocabulary defeats it.** The scarred broker's stored place fails
  `samePlace` against the scene's locked `location: "the broker's shop"`, so the man showing you
  weapons is filed *Elsewhere*. The mechanism (derive presence) held; the place vocabulary split.
- **Duplicates re-accumulated.** The repair set candy to 2; event mid 58 ("The ahjumma gives
  Solomon two wrapped candies along with his change") re-recorded the beat mid 54 had already
  recorded, and the fold now says `wrapped candy x4`. The phone-number exchange exists **three
  times** in the ledger — mids 50, 52 and 54, each anchored on a different newest-message key, so
  the exact-dedup (`chronicle.js:221`, anchor = newest source) and the semantic dedup
  (`chronicle-table.js:286-293`, keyword-signature equality) both miss.
- **Ownership still fails.** Event mid 54: *"Jin-Woo receives Solomon's phone number"* →
  `{"item":"solomon's phone number","dq":1}` → the **player** now carries his own phone number,
  because a delta has no subject (`state.js:350-361` — `{item, dq, at}`; `state.js:377-393` —
  `{flag, on, turns}`; neither has anywhere to put *whose*).
- **Cost is still untracked.** Message 62: *"Eighty-five thousand for the pair," he says.
  "Staff's forty, sword's forty-five."* The staff and shortsword were credited (event mid 60);
  no won left the ledger. Money remains write-only in the gaining direction — the ₩9,999 bug's
  root survives its fix.
- **Adjudication has still never fired.** 35 turns: `verdict:uncontested` 9, `skipped` 1, bands
  all zero. And `pressure:ok` 0 — the one live clock (`the residency window closes`, 1/8) was
  written by the repair script, not by the probe.
- **The user is playing against the tracker.** `locks: {location: true, time: true}` — he has
  pinned two of five scene fields by hand to stop the narrator overwriting corrections. Locks are
  the only part of the correction loop that exists, and he is using them as a bandage.
- **Two permanent facts burn the staleness counter forever.** `rank` and `mana` sit in scene
  context at `t: 2` (33 turns stale). `contextBand` (`state-table.js:339-345`) drops them from the
  prompt every render — a large share of `cap:context-stale` 76 is fold repeatedly discarding two
  facts the fiction says are *fixed at Awakening*. Permanence is inexpressible, so it is billed
  as staleness.

### 0.1 The second repair (message 72, turn 14) — six findings, four new

A second hand repair (`scratchpad/repair2.py`, backups alongside) was applied at message 72.
Beyond re-confirming the §0 classes (the broker split persisted; money still never debited
despite the purchase being priced **five times** in plain text — *"Eighty-five thousand for the
pair"*, *"Twelve thousand"*, *"Eighteen thousand"*, *"twelve with the extra coagulant"*, and the
player's own *"I hand over the 120k"* — all six items credited, balance unmoved), it surfaced
four defects in neither `FOLD-RPG-GAP.md` nor the first draft of this document. Each changed
the design; the section that absorbs it is noted:

1. **`castAt` collapses the third value.** `presenceOf` carefully returns UNPLACED as a
   distinct answer for "the evidence cannot decide" (`entity-table.js:196-205`, citing the
   dispatch law) — and one function later `castAt` folds UNPLACED into *here*
   (`entity-table.js:621`), asserting anyone without a recorded place into the room. A
   three-valued derivation with a two-valued consumer. → §2 (review asks), §8 (rendering).
2. **A lock is a permanent silent lie.** `locks: {location: true}` pinned "the broker's shop"
   from turn 10; the story moved twice; the lock blocked 7 writes (`cap:field-locked` 7) and
   the panel rendered **HERE: (empty)** — nobody in the scene, including the player, because
   the pov's place no longer matched the locked location. No expiry, no contest signal, nothing
   on the row saying the lock is fighting the narrative. → §5 (contested state), §8 (surface).
3. **Dials have no polarity.** Two clocks coexisted for one stake: *"The residency window
   closes"* (fills = sponsorship lapses) and *"Residency in Korea"* (`about: "Solomon completes
   20 D-rank raids and gains residency"` — fills = you **win**), and `renderClocks`
   (`clock-table.js:324-334`) printed both under `Pressure:`. A dial that fills on success is
   not pressure, and the narrator was told it is. Explains `reject:clock-reversed` 1. The first
   draft's size-based discrimination (4/6/8 = clock, 20 = track) was the wrong axis. → §4.
4. **A list doing a judgement's job, again.** From the block *"left arm heavily bruised but
   functional"*, `splitConditions` split on `\bbut\b` and kept **both** halves as live flags —
   `functional` is not in `isNegation`'s enumerated vocabulary (`block-parse.js:389-392, :404`).
   Same class as the "otherwise uninjured" bug that docblock claims fixed, and the same class as
   the deleted verb lists. Also live simultaneously: `fatigued` and `mild fatigue` — two flags
   for one condition, because `contentTokens` has no morphology ("fatigued" ≠ "fatigue",
   `state-table.js:407-412`) so `statusKeyFor`'s overlap never fired. → §3, §11.
5. **Block absorption re-creates the prose blobs the tables replaced.** The card began emitting
   a status block, and `state.context` grew free-text `leads`, `pressure` and `health` fields —
   prose duplicates of the thread table, the clock table and the status flags, parked where
   nothing can act on them, and arriving `src: block`, which **outranks** narrative for
   `CONTEXT_OVERRIDE_AFTER` turns (`state-table.js:1158-1169`). The least structured
   representation wins on trust; the residency stake existed in **three** places at once. → §5.
6. **Thread identity has no machinery at all.** `next raid with Kang's squad` and `next raid
   with Kang's team` opened as two threads. Leads have no `aka` field, so the alias resolution
   that half-works for people does not exist for threads. → §2.

Repairs applied by hand, now part of ground truth for fixtures: broker and raid-thread merged;
Kang's standing offer and the weapon hunt closed; bug-bounty thread added; the inverted
residency clock deleted; location unlocked and corrected; the three prose fossils dropped;
inventory reconciled — gear moved to a `goshiwon room` place, **₩210,000** after the purchase,
five martial-arts abilities and two software assets the fiction had established and fold
tracked nowhere.

The one-sentence diagnosis from the gap analysis stands and needs no restating: **fold tracks
nouns and sentences about them; the systems it draws on track things that are at stake, and
nothing in fold can close.** What follows is the design that fixes the class, not the instances.

---

## 1. The design in one screen

Three stores instead of five, one retraction mechanism instead of none, and one rendering of the
world that is shared by the panel, the narrator injection, the extraction prompt and the
adjudicator.

```
LEDGER   (chronicle, Graph face — unchanged in kind)
  events; a delta may now carry `who`. State remains a fold over live events.
  Closures are events too: retraction is an append, never an in-place delete.

CAST     (per-character rows; the player's row is "the sheet")
  kind ∈ {person, faction} — an off-screen actor is a row, not a thread (§7.3)
  name · aka(Set) · place(versioned Map) · feels(word) · wants · knows
  reach       — how to contact them ("has Kang's number") — NOT inventory
  marks       — up to 3 consequence slots {phrase, severity word}, OWNED here
  facts       — standing truths that never age (rank, mana, trained-in-staff)
  threat      — one small integer, present only while an adversary is active

THREADS  (one table absorbing leads + clocks + progress tracks + fronts)
  name · what's open · status ∈ {open, closed, moot}
  dial?: {filled, size}   — a thread with a dial is a clock; a big dial is a
                            progress track; no dial is a Mythic thread
  steps?: [phrase…]       — named dial segments make it a DW front; doom = about
  per?: <span>            — calendar fronts tick in code from elapsed time (§7.3)
  where? · seen? · source

SCENE    (four fields + pov: location, time, date, weather)
  versioned per-field, lockable, banded assert/annotate/drop for injection.
  `conditions` LEAVES this table — injuries are marks on the pov row.

INTEGERS money (fold over ledger) · momentum · thread dials · adversary threat
```

Budget check against the real chat: at the broker's shop the live changing quantities are money
and one thread dial — two. During the Nowon raid they would have been: hobgoblin threat, goblin
group threat, pov marks, one clock — four. That is Cowan's ceiling honoured by the schema rather
than by discipline, and it is why the whole ledger can be **pinned verbatim into every prompt**
(§5) instead of retrieved piecemeal — which is the actual answer to the user's stated enemy:
*"too much shit for the LLM to trace, or you get forced to make dozens of tool calls."*

The phrase-over-number rule is kept everywhere it was adopted (`entity-table.js:71-88`) and
extended to marks: severity is a word (*minor / moderate / severe*), never a point total. The
integers that remain are the ones whose arithmetic is done by fold, not by the model.

### 1.1 Every element on a face

| element | face | merge | note |
|---|---|---|---|
| ledger events, closures | Graph | `merge_graph` | append-and-retrieve; closures fold as retractions |
| cast row fields | Map | field-wise, turn-versioned (`merge_entity`, `entity-table.js:272-332`) | already built; unchanged |
| `aka` | **Set** | `merge_nb` | the one legitimate Set: a name once used never stops having been used (`entity-table.js:301-311`) |
| marks | Map | versioned field on the row | retracted by a closure event, not by silence |
| thread record, `steps`, `per` | Map | field-wise versioned (today's `merge_clock`, `clock-table.js:129-147`) | |
| thread `dial.filled` | Count | `+` on one field | order-independent because addition commutes; calendar (`per`) fronts tick it from the clock in code |
| world-turn moves | Graph | ledger events, `src: 'world'` | rooted in an existing row's `wants` or a front's next step, or refused (§7.4) |
| relationship trails | Graph | `merge_graph`, bounded | per-row history of `feels`/`wants`/`knows` changes, stamped with the extracting pass's anchor mid so each change is attributable to the message that caused it — `merge_entity` is last-write per field and rightly so; the trail is the sibling record of what the last write replaced (§8, Relationships tab) |
| inventory, money | Count/Map | `merge_qty` / `setQty` (`state-table.js:589-649`) | unchanged |
| momentum, observe counters | Map / Count | as today | |
| presence | **derived** | — | `presenceOf` (`entity-table.js:196-205`); no stored bit |

Nothing new wants the Set face except `aka`, which confirms the plan's central finding rather
than fighting it. The JS mirror of the algebra is fold's own vendored
`public/scripts/extensions/fold/lib/hash.js:23-45` (`insert_with(m, f, k, v)`; `merge_nb`,
`merge_b`, `merge_bu`, `merge_acc`, `merge_graph`).

**Citation corrections, verified against the corpus this session** (the "read source, never
recall" rule caught four):

1. `song/lean/Song/kernel/Table.lean:57-59` `only_four_merges` is real, but the four verbs there
   are named `keep / set / count / link` (defined `Table.lean:45-51`), and the theorem is
   exhaustiveness of a closed tag, not uniqueness of functions — the stronger statement is
   `merge_is_the_only_freedom` (`Table.lean:37-40`). The `merge_NB/B/BU` naming lives in
   `sanguine/proof/Substrate/Algebra/Security/HashTrinityCore.lean:107-113`. This document uses
   the sanguine names and cites both.
2. The "stale insert at full weight is a projection that absorbs the emission" language is the
   `IsProjection` docstring at `sanguine/proof/Substrate/Algebra/Neural/InsertEmission.lean:277-283`
   ("*can* be overwritten" — possible, not proved to occur); `the_insert_law` itself (`:322`) is the
   preservation bound plus the boost/projection dichotomy. Citations below use `:277-283`.
3. `entity-table.js:116-117` cites `whispering-tides/src/ecs.slang:418-437` as "recomputes spatial
   membership every frame". **That is wrong**: those lines are `ecsInArc`, a hit-arc cone test,
   and the file contains no spatial-membership structure at all (grepped; the honest version is
   "recomputes hit geometry per resolution, holds no spatial index"). The docblock gets fixed as
   part of Phase 2's file touch; the design argument survives on the other four sources.
4. There is no `/home/socol/Workspace/fold/lib/hash.js`. The real mirrors are Rust
   (`fold/hashtrinity/src/lib.rs:1018` — note the signature is `insert_with(&mut self, k, new, f)`,
   merge **last**; `fold/bedrock/src/web/mod.rs:28-41`, where the fourth face is `merge_4th`) and
   the extension's own `lib/hash.js`.

Also verified as claimed: `OntologyClosure.lean:127-130` (`merge_NB_converges` — the file says
"idempotent + commutative"; "monotone" is our gloss), `:136-139` (`merge_B_order_matters`),
`:152-155` (`merge_max_converges`); `LevelOfDetail.lean:110, :140` (the doorway sentence is the
file header, `:10-12`); `BayesFilter.lean:80-81` (`zero_residual_is_fixed` is
`kalmanUpdate x K x = x` for **every** gain — measurement equal to prediction moves nothing;
"absent new evidence, belief holds exactly" is a fair gloss and marked as one);
`SelectionDispatch.lean:223`; `TimerWheel.lean:42-46`. And the corpus still contains **no**
theorem about set-leaving, expiry or time-bounded membership — the nearest new thing is
`KeyResolution.lean` (aliasing, not time) — so the Phase-6 proof debt from the prior plan stands
unpaid and stays on the books (§10, phase G).

---

## 2. The one retraction mechanism: extraction becomes review

This is the centre of the redesign. Everything in §0 that "cannot close" fails for one reason,
named in the gap analysis: *the retraction event is something a narrator never bothers to say.*
Nobody writes "the gate is no longer uncleared." The current probes are **write-only** — they are
asked what is true, and silence about a tracked line means nothing (`entities.js:175` even
instructs "Mark a lead closed once it is resolved", and counted across all four live chat files
— 31 lead rows in three campaigns, ~180 assistant turns — every single one is `open`; not one
`closed` or `stalled` has ever been written. The enum at `entities.js:142-143` is load-bearing
vocabulary with zero writes).

The fix is the SOM-DST insight the prior plan already recorded (`{CARRYOVER, DELETE, UPDATE}` as
an explicit model output) applied wholesale: **the extraction pass reads the ledger back and
returns a disposition for every open line.** Because §1 keeps the whole ledger under a screenful,
this is cheap — the same pinned block the narrator gets is placed in the extraction prompt, each
open line carrying a stable id:

```
Tracked now (review these — say which are settled):
  T1 [open 1/20] Hunter residency: twenty D-rank raids — 1 of 20 logged
  T2 [open] Teaching Jin-Woo IT — Jin-Woo has not answered
  T3 [open] A weapon that is not a goblin's knife — nothing bought yet
  M1 [mark: Solomon] bandaged left calf (moderate)
  P1 [here] Jin-Woo · P2 [here] the broker · ...
```

and a fourth probe fragment (riding the same call — no new request, same as clocks did,
`clocks.js:8-13`) answers, per id: `still ∈ {open, advanced, settled, moot}` plus a five-word
note. The answers become **closure events in the ledger** (Graph face, `src: 'review'`), and the
state fold retracts. Nothing is deleted in place; a swipe that removes the closing turn un-closes
the thread, exactly as the delta machinery already behaves (`state-table.js:6-26`).

One mechanism, five applications:

| table | review question | what closes it today |
|---|---|---|
| threads | "is anything still open about T3?" | nothing (`FOLD-RPG-GAP.md` §1) |
| marks | "is M1 still afflicting Solomon?" | `turns` guess at write time only (`state-table.js:887-891`) |
| presence | "is P4 still at the Nowon gate site?" | derived, but starves without re-reports |
| dials | "did T1 advance or become moot?" | `tick===0` rejected as no-change (`clock-table.js:217-221`); moot inexpressible |
| unplaced people | "where is P4 now?" | `castAt` asserts them into the room (`entity-table.js:621`, §0.1-1) |
| identity | "are P2 and P7 the same thing?" (asked when the near-identity detector flags a pair — **cast rows AND threads**) | people: `canonicalKey` short-circuit (`entity-table.js:368-371`); threads: nothing at all — leads have no `aka` (§0.1-6) |

The identity question is the dispatch-law third action (`SelectionDispatch.lean:223`): when the
evidence cannot decide, fold neither merges silently nor leaves the split — it asks the reader.
The broker pair is precisely this case, and *"one name containing another is not identity"*
(`FOLD-RPG-GAP.md` §4) is precisely why the merge must be confirmed rather than assumed.

The detector deserves precision about its own limits, because the second repair produced a pair
a token-subset test **cannot** catch: `next raid with Kang's squad` vs `…Kang's team` differ in
one substituted token, so neither is a subset of the other. The detector is therefore: same
head token AND (one name's tokens ⊆ the other's, OR the two token sets differ by at most one
substitution). That is deliberately loose — it is a **trigger for a question, not a decision** —
which is what makes it compatible with §11's ban on similarity metrics: a metric that *decides*
identity was rejected because it must be right; a detector that *asks* only has to be right
often enough that the question budget stays small, and every miss is recoverable by hand-merge
in the UI. Threads get the same `aka` accumulation cast rows have once a merge is confirmed, so
a confirmed merge never has to be re-asked.

The same third action covers UNPLACED people (§0.1-1): the review asks where they are rather
than the renderer guessing. `castAt`'s collapse of UNPLACED into *here* was defensible as
"absence of evidence is not absence" (`entity-table.js:609-615`) and indefensible as an
*assertion* — the fix keeps the three-valued result all the way to the consumers: the panel
hedges them visibly, the injection never asserts them plainly (§8), and the review resolves
them.

Why the model can answer these: closure is a **reading-comprehension question about a named
specific**, which is the category of question this codebase already trusts the model with
(`trigger-table.js:158-169` — "reading the narrative is never fold's job… ask it"), as opposed to
hoping it spontaneously re-reports absence. At message 62 the question "is T3 (a weapon…) still
open?" has the answer sitting in the same window: *"set aside for purchase… Eighty-five thousand
for the pair."*

**Measured claims this must beat** (success criteria in §10): the Goblin-Market-trip lead sat open
while the player stood inside it; two moot clocks squatted in the table until the repair script
deleted them; `cap:stale-hidden` 144/540 is the current "retraction by silence" doing the wrong
job on the wrong table.

### 2.1 The other half: stop double-writing

Review closes what should close; the window split stops re-opening what was already written.
Today `buildWindow` takes the trailing N messages every pass (`extract.js:90-100`) and the pass
runs every 1–2 turns (`index.js:687`, `trigger-table.js:112-113`), so consecutive windows overlap
by 4–5 messages and the same beat is read up to three times, each pass anchored on a different
newest message so both dedups miss (measured: phone numbers at mids 50/52/54; knife at 22 and
38; candy at 54 and 58).

The redesign splits the window at a persisted high-water mark (`state.clock` gains `extractMid`,
beside `extract` at `state.js:246-249`):

```
Earlier, for context only (already recorded — extract nothing from this):
  <messages ≤ extractMid>
New since the last look:
  <messages > extractMid>
```

Events and deltas may anchor only on the new half. The pinned ledger in the prompt does the rest:
a model shown "Solomon has: Kang's number" does not propose gaining it a third time, and a delta
that still slips through and matches a live line is refused with a new counter,
`reject:already-recorded`. The overlap is kept — the model still *sees* the context — but it can
no longer *bill* it.

Two adjacent mechanical fixes ride along:

- **`canonicalItemName` containment is narrowed to head-token identity.** `sameItem`'s
  either-direction token-subset (`block-parse.js:285-296`) let a `set` of `phone` be absorbed into
  `solomon's phone number` (`FOLD-RPG-GAP.md` §4). Two names are one item only when their head
  nouns match and neither's qualifier contradicts the other's; "phone" ≠ "phone number" heads
  differently and stays distinct.
- **Contact information leaves inventory entirely.** "Kang's phone number" is not a thing in a
  pocket; it is *reach* — the concept the entity schema already carries as prose ("reachable by
  email", `entity-table.js:411`). The delta instruction stops offering a `contacts` place; the
  entity probe gets a `reach` field. Migration moves the two existing contact rows onto the Kang
  and Jin-Woo cast rows.

---

## 3. Ownership: a `who` on every state change

The smallest schema change with the largest blast radius. The `st` delta becomes
`{who, flag, on, turns}` and `vit` gains the same field; `who` is resolved through the alias set
(`resolveEntity`, `entity-table.js:394-402`) and defaults to the pov character when empty —
which is the semantics the panel already (wrongly, silently) applies today.

Owned status flags then graduate into **marks**: up to three consequence slots per cast row,
each a phrase plus a severity word (Fate/Cortex, per the plan's keep table). What this fixes, all
measured in the current log:

- *"Lee gets raked across the ribs"* and *"Park's bandaged thigh re-opens"* both wrote the flag
  `bleeding` with no subject (events at mid 30, both `{"flag":"bleeding","on":true}`), and the
  panel showed **the player** bleeding for the rest of the session (`FOLD-RPG-GAP.md` §3).
  With `who`, they are Lee's mark and Park's mark, visible on their rows.
- `conditions` leaves the scene table. Today it is a `SCENE_FIELDS` member (`panel.js:56`)
  rendered inside the scene header joined with the weather (`panel.js:261`,
  `[conditions, weather].join('; ')`) — which is exactly why "Bandaged calf" read as a property
  of the Goblin Market. The scene probe's `conditions` field (`scene.js:67-70`) is retargeted to
  write a mark on the pov row; the header shows where/when/weather and nothing about anyone's body.
- The adjudicator's `hurt` term stops counting other people's wounds against the player.
  `verdict.js:192` reads `state.snapshot().status.length` — a subjectless count; it becomes the
  pov row's mark count, weighted by severity word.
- Adversaries get their integer. During a fight, a cast row may carry `threat` — Scarlet Heroes'
  one-integer-per-adversary, stepped down by verdicts and closed by review (a dead hobgoblin's
  row is `settled`). Six enemies are six small integers on rows that already exist; the six-message
  Nowon battle that fold represented as two stalled clocks (`FOLD-RPG-GAP.md` §6) becomes
  legible at a glance.

`MAX_CONDITION_TURNS`-style duration guessing (`state-table.js:887-891`) stops being the primary
healing mechanism — review is — but `turns` survives as a hint for things that genuinely fade on
their own; measured, it was used for nothing else (`cap:condition-expired` has never fired in any
of the three chats).

Marks also end two vocabulary failures the second repair exposed (§0.1-4). *"left arm heavily
bruised but functional"* produced two live flags — the injury AND `functional` — because
`splitConditions` splits on `\bbut\b` and then trusts `isNegation`'s enumerated English list to
drop the reassuring half (`block-parse.js:389-392, :404`), and "functional" is not on the list.
And `fatigued` / `mild fatigue` coexisted because `contentTokens` has no morphology
("fatigued" ≠ "fatigue", `state-table.js:407-412`), so `statusKeyFor`'s overlap never fired.
Both are lists doing a judgement's job. Under marks, the judgement moves to where this codebase
already puts judgements: the probe's schema says *record the affliction, never the reassurance —
"bruised but functional" is one mark, "bruised left arm"* — and near-duplicate marks on one
owner are a standing target of the review's identity question, which needs no stemmer.
`isNegation` and `splitConditions` are demoted to read-time healing of pre-marks ledger rows,
the same one-way service `stripDecoration` performs for old item names (`state-table.js:927-933`).

---

## 4. Threads: leads, clocks and progress tracks are one table

The measured case for unification is in today's header: the residency obligation exists **twice**
— `lead␀hunter residency` ("1 of 20 logged. Nineteen to go…") and clock
`the residency window closes` (1/8, `about: "twelve months pass with fewer than twenty raids
logged…"`) — two tables, two lifecycles, two renderings of one stake. And the campaign's actual
spine, *20 raids in 12 months*, is expressible in neither: it is a **progress track** (Ironsworn),
which fold has no face for, so the count lives in prose inside the lead's `open` field.

A thread is `{name, open, status, dial?, where?, seen?, source}`, and a dial is
`{filled, size, kind ∈ {doom, progress}}`:

- **No dial** → a Mythic thread, today's lead. Same fields, same exposition gate
  (`isExposition`, `entity-table.js:545-553` — kept; it measurably works, `reject:exposition` 7
  in Evil Hero Party).
- **`kind: doom`** → a Blades clock: fills = bad. `size ∈ {4,6,8}` (`CLOCK_SIZES`), `filled`
  keeps the Count-face-on-one-field merge and the `MAX_TICK` bound
  (`clock-table.js:129-147, :67`); `where`/`seen` keep locality and hidden-clock rendering
  (`clock-table.js:78-79, :188-192`). Renders as a clock face; injects under `Pressure:`.
- **`kind: progress`** → an Ironsworn track: fills = good. `size` up to 20; the residency is
  `1/20`, ticked by review when a raid is logged. Renders as a filling bar; injects under
  `Progress:`, never `Pressure:`.

**Polarity is an explicit kind because the first draft got this wrong** (§0.1-3): it
discriminated track from clock by *size*, and the second repair found the live counter-example —
two dials for the residency stake, one filling toward the sponsorship lapsing and one filling
toward *"Solomon completes 20 D-rank raids and gains residency"*, both rendered under
`Pressure:` (`clock-table.js:324-334`). A dial that fills on success being narrated as mounting
threat is not a display bug; it is the injection steering the model to treat the player's
progress as danger. Size cannot carry that distinction — a 4-segment "finish the ritual" is
progress and an 8-segment doom is doom. Polarity also explains `reject:clock-reversed` and gives
the probe an honest vocabulary: negative ticks unwind a doom, and *advancing* is always the
`filled` direction whichever way the stakes point.

`status` gains `moot` beside `open/closed` — the Nowon counterattack clock after the nest was
routed was not *completed*, it stopped being about anything; conflating the two is how "fired"
and "irrelevant" would blur. `MAX_CLOCKS = 12` eviction pressure (`clock-table.js:57`,
`FOLD-RPG-GAP.md` §7 "dead pressure accumulates and eventually refuses live pressure") mostly
dissolves because threads close; a cap stays as a safety with its own counter.

Rendering follows Disco Elysium as the plan specified: a thread is a line of prose with a meter
attached, never a meter with a label. Closed threads strike through and hold one turn
(the mechanism `entitiesOfKind` already implements for GONE, `entity-table.js:599-603`), then
move to the sheet-level archive (§8, altitude 3).

---

## 5. Scene, money, and what the injection asserts

**Scene** keeps four fields plus pov, all versioned, all lockable, with the three-band
assert/annotate/drop for injection (`state-table.js:325-345` — measured working;
`cap:context-stale` is the annotate/drop machinery firing). Two changes:

- Standing facts (`rank`, `mana`, and any block field that is a truth about the character rather
  than the moment) migrate to `facts` on the pov row and **never age**. The three half-lives the
  gap analysis names (§5: permanent / walk-speed / hourly) become: facts never expire; location
  and weather age on the existing bands; presence is derived. Nothing shares a clock with
  anything of a different half-life any more.
- The **pov row is the anchor of the whole model.** `pov` misreads had the highest blast radius
  in the log (§5: panel claimed the player was Jin-Woo, and `conditions` followed). pov keeps its
  lock, and review is asked to confirm it whenever it changes — a change of protagonist is a
  named question, not a silent overwrite.

**Money** stays a fold (the mechanism is correct post-repair: ₩210,000 derives cleanly after
repair2, and `maxQty`/`MAX_MONEY`, `state-table.js:194-203`, are right). What is missing is the
debit side, now **measured twice**: across 40 turns money moved up and never down, while the
second repair counted the one purchase priced *five separate times* in plain text — including
the player's own "I hand over the 120k" — with all six items credited and the balance unmoved
(§0.1). The first draft ordered three fixes by expected yield with the prompt line first; the
coordinator's correction is accepted: **a prompt line is the weakest of the three, by the same
argument that moved adjudication into code** — instructions decay, triggers in code do not. The
order inverts, and the strongest fix becomes structural:

1. **A directed question, triggered in code.** Whenever a pass credits items and no money delta
   accompanies them, the review block appends: *"These acquisitions were recorded with nothing
   paid: ‹items›. Balance on record: ₩N. What was paid, if anything?"* Code decides WHEN to ask
   (a credit with no debit is mechanically detectable); the model only reads the scene and
   answers — the exact division of labour `verdict.js:5-18` established.
2. Review settlement: a purchase-shaped thread that settles asks "what did it cost?".
3. The adjudicator's COST band (§6) writes its cost as a delta rather than hoping the narrator's
   prose gets re-extracted.
4. The delta instruction still gains its line (*"a purchase is a loss of money and a gain of the
   item, in the same event"*) — kept because it is nearly free, trusted for nothing.

`magnitudeCorroborated` already accepts spelled-out scale words ("eighty-five **thousand**",
`state-table.js:280`), so the gate will not block any of these.

**Block fields that shadow structured tables are routed, never parked** (§0.1-5). The card now
emits a status block, and absorption grew `context` three free-text fields — `leads`,
`pressure`, `health` — that are prose duplicates of the thread table and the marks, sitting
where nothing can act on them, *and outranking narrative on trust* because `src: block` wins for
`CONTEXT_OVERRIDE_AFTER` turns (`state-table.js:1158-1169`). The residency stake existed in
three representations at once. The rule that fixes the class: on absorption, a block field whose
label names a structured domain (`LEAD_LABELS`, pressure/threat labels, health/condition labels,
inventory — the label sets already exist, `entity-table.js:57-58`, `panel.js:56`) is **parsed
into that domain's own validation pipeline** — leads become thread proposals, health becomes
mark proposals, inventory stays the restated-totals path it already has — or, where parsing
fails, refused with a counter (`reject:block-shadow`). Context keeps only labels fold has no
structure for, which was always its stated job (`panel.js:799-801` "shown as given rather than
dropped for not fitting a schema"). Trust ranking then applies within one representation instead
of across two.

**Locks gain a contested state** (§0.1-2). The lock mechanism did its job seven times and the
result was a panel showing an empty room in a scene containing the player — a lock has no
expiry, no contest signal, and silently discards every disagreeing write (`state.js:220-224`,
`cap:field-locked`). Expiry-by-time would be decay, which §11 forbids; the honest mechanism is
the one the rest of this design uses everywhere: **surface the disagreement and ask.** A locked
field keeps its value AND records the last blocked write with a per-field contest count; at 3
consecutive disagreeing reads the row shows *contested — narrative says "‹value›"* with
one-click accept/keep (§8), and the review pass includes the contest as a question. The lock
still wins until the user says otherwise — that is what a lock is — but it can no longer lie
silently, and `cap:field-locked` gains a sibling, `lock:contested`, so the fight is measurable.

**The injection contract is unified.** Today three consumers assemble three different views:
the narrator gets `[Scene]`+`[State]` (`state.js:475-570`), the extractor gets a bare transcript
(`extract.js:186-197`), and the adjudicator gets a bare transcript (`verdict.js:121-126`).
The redesign has **one `ledgerBlock()` renderer** — the pinned screenful — consumed by all
three (narrator at its existing depths, extractor as §2's review block, adjudicator as §6's
evidence). One renderer means the panel, the model and the judge can never disagree about what
fold believes, and `InsertEmission.lean:277-283` is honoured in all three places at once: stale
lines are dropped, not annotated, before any of them see the block.

**Staleness-as-hiding is deleted.** `isFresh`'s CARRIED hiding (`state-table.js:1057-1073`) is
the wrong inference by the corpus's own light (`BayesFilter.zero_residual_is_fixed`,
`BayesFilter.lean:80-81` — a measurement equal to prediction moves nothing; a knife does not
become uncertain because the conversation moved to noodles) and it is fold's single largest
silent intervention (`cap:stale-hidden` 144 and 540). Items persist until an event or a review
closure removes them. The counter is retired to zero *by construction*, which is the cleanest
success criterion in this document.

---

## 6. Adjudication: fed, firing, and writing its costs back

Measured: zero real verdicts ever (§0). Three defects, three changes.

**It judges blind → feed it the ledger.** `classify()` sends only the transcript
(`verdict.js:114-140`), so `supported` — "does anything on record make this possible?"
(`verdict.js:78-79`) — is answered *without the record*. The classifier gets `ledgerBlock()`:
marks, threat integers, momentum, the target's `feels/wants/knows`, live threads. This is the
"precedent is the oracle" decision (plan §Decisions) actually plumbed; today `precedentFor`
(`verdict-table.js:238-264`) is the only tracked fact that reaches the verdict.

**It fires too rarely → the gate stays, the classification sharpens.** The structural gate
(`looksLikeAttempt`, `trigger-table.js:239-257`) is correct and stays — the deleted verb-list
postmortems (`trigger-table.js:144-170`) remain deleted. What changes is the contested
classification: with marks, threats and dials in evidence, "an E-rank with a wounded calf vaults
a rank of charging goblins" (message 35 — the exact test case, `FOLD-RPG-GAP.md` §6) is visibly
opposed-and-reckless rather than a sentence floating free of state. The claim is testable
offline, and §10 phase E makes it a harness rather than a hope: replay the chat's user messages
through `classify`+`adjudicate` with the real ledger and assert the raid attempts band non-CLEAR.
The band thresholds (`CLEAR_AT`/`SETBACK_AT`, `verdict-table.js:70-71`) stay put until that
harness produces a distribution to tune against — they are unexercised, and retuning an
unexercised constant is the "prose outran behaviour" failure `observe.js:5-11` exists to prevent.

**Its outcomes vanish → verdicts write state.** Today the only side effect is SETBACK ticking
the *globally first* non-full clock (`verdict.js:204-209` — `clocks.snapshot(turn).find(...)`,
which in a multi-thread chat is a random victim). Redesigned:

- SETBACK advances the dial of the thread the classifier's `keywords`/`against` actually match,
  falling back to none — a mis-aimed tick is worse than no tick.
- COST writes a pending-cost note that the next extraction is told about: *"the last attempt
  succeeded at a cost; record what it cost as a delta"* — closing the loop that currently relies
  on the narrator's prose happening to re-extract.
- CLEAR against opposition earns momentum as built (`verdict-table.js:213-225`); the three banked
  obligations the gap analysis lists (Kang's doubled cut, Jin-Woo's bracer and bandage, the
  ahjumma's meal) are not momentum — they are `knows`/`reach` entries on those rows and threads
  where actionable, which is where a callback engine can find them.
- The verdict and its `why` trail surface on the ambient strip (§8) — the player sees *that* and
  *why* the world pushed back, which is the Blades "tense in a fun way" visibility rule the plan
  adopted, applied to the judge as well as the clocks.

*What stays hidden:* the interval arithmetic. No lo/hi, no thresholds on screen — bands and
reasons only ("It works, at a cost — actively opposed, carrying an injury"). `explain()`
(`verdict.js:223-229`) is already the right shape.

---

## 7. The world moves while you are not looking

### 7.1 A reasoning error, recorded

The first draft of this document dropped faction turns with the measurement "zero off-screen
faction actions in ~180 turns of logs." **That inference was invalid, and the error is worth
keeping on the page so it is not repeated: the logs cannot exhibit a feature the system has
never had.** Absence of off-screen action in a system with no off-screen machinery is evidence
about the machinery, not about the value. It is the same shape of mistake as judging
`verdict:clear` thresholds from a chat where adjudication never ran — and this document made
both, one knowingly (§6 declines to retune unexercised constants) and one not.

What the logs *can* show is unserved demand, and re-read for it they are full of it:

- Kang's live row: `wants: "run profitable D-rank raids and bring her team home alive"`, and the
  thread `Kang's standing offer` records *"they run D-ranks almost daily."* Six in-fiction days
  from now she has run several raids — and under the current design her row will still say she is
  standing at the Nowon gate site, because nothing moves anyone the camera is not pointed at.
  (That exact failure is repair row 2 in `FOLD-RPG-GAP.md` §0: Kim, Park, Lee and the agent
  frozen in a sealed dungeon 20 messages after leaving it.)
- The thread `Jin-Woo's family`: *"the bills do not stop… Jin-Woo raids to cover the gap."*
  An agenda with a clock on it, currently inert.
- The thread `Missing hunter in Busan` — a news-crawl seed whose whole point is to develop
  off-screen, currently a fossil that can only ever be re-mentioned.
- The one live clock, `the residency window closes`, whose firing condition is *"twelve months
  pass with fewer than twenty raids logged"* — **a pure calendar condition that nothing in fold
  can tick**, because ticks arrive only from on-screen extraction (`clocks.js:108-137`). A front
  is already sitting in the live data with no engine under it.

And the user's play style makes this load-bearing, not decorative: *"simulationist roleplaying
experiences that both reward and punish the player realistically."* A world that only acts when
observed cannot punish you for ignoring it — ignoring the residency grind, ignoring the Busan
story, ignoring Kang's offer until her roster fills — and those are precisely the smart/dumb
consequences the whole design exists to deliver.

### 7.2 Sources, and what is adopted from each

**Dungeon World fronts** ([Dungeon World SRD, "Fronts"](https://www.dungeonworldsrd.com/gamemastering/fronts/)):
a front is linked *dangers*, each with an *impulse* (its motivation), a ladder of *grim
portents* — "more often than not grim portents have a logical order… you can advance a grim
portent descriptively (you've seen the change happen during play) or prescriptively (as your
hard move)" — and an *impending doom*: "when all of the grim portents of a danger come to pass,
the impending doom sets in… the setting has changed in some meaningful way." **Adopted
wholesale.** It needs no randomness, its portent ladder is a dial with named segments, and its
descriptive/prescriptive split maps exactly onto fold's two advancement paths (on-screen
extraction ticks vs the world-turn below).

**SWN faction turns** ([Take on Rules read-through of the SWN faction system](https://takeonrules.com/2018/12/27/lets-read-stars-without-number-factions/);
sequence per the free edition: earn FacCreds → pay asset maintenance → hold or change a goal
from a fixed menu → take **one action type per turn** from a fixed list — Attack, Buy Asset,
Expand Influence, and so on). **Adopted: the shape** — a named actor with a standing goal who
takes one legible action per off-screen turn. **Dropped: the economy.** FacCreds, asset
maintenance, hit points and the action menu are a bookkeeping subsystem built so a human GM can
resolve a sector between sessions without judgement calls; fold has a model to make the
judgement call and a chronicle to check it against, and the user's axis is compression —
maximum world-motion per unit of tracked state. One actor costs one cast row, not a balance
sheet. (Blades' one-integer faction status survives as the `feels` word on that row, per the
plan's keep table.)

The prior plan already committed to both rows (`abundant-drifting-eagle.md`, keep table:
fronts — "the mechanism for 'the world moves whether or not you are watching'"; faction turns —
"the antidote to NPCs with no agenda") and costed them at "one larger call per in-game downtime
period, rare." §7.4 reconciles that cost line with this document's no-second-call commitment.

### 7.3 Shape: actors are rows, moves are threads, fronts are threads with named steps

- **An off-screen actor is a cast row.** Kind `faction` beside `person` — the `kind␀name`
  product key admits a third kind for free (`entity-table.js:213-215`) — with the same fields
  doing the same jobs: `wants` is the goal, `feels` is standing toward the player, `place` is
  its sphere of operation. An actor is *not* a thread: actors persist across many stakes and do
  not close; what an actor is currently doing is a thread, and threads close. Justification by
  counter-case: modelling White Tiger as a thread would force "White Tiger exists" to be
  something that can become `settled`, which is a category error the schema should make
  inexpressible. The cheapest layer — a *person* with a `wants` who acts between scenes — needs
  no faction kind at all, and per the measured demand above it covers most of the value (Kang
  and Jin-Woo are people, not factions).
- **A front is a thread whose dial has named segments.** Threads gain one optional field:
  `steps: []`, a versioned Map-face list of portent phrases aligned to the dial
  (`steps.length === dial.size` when present). The doom is the `about` field that already exists
  ("what happens when it fills", `clock-table.js:186`). Filling stays the Count face on
  `filled`; the names ride the record like every other described field. No new table, no new
  merge.
- **Deterministic calendar fronts tick in code, not by model.** A front may carry
  `per: <span>` ("1 month"); the dial then advances from the narrative clock's own elapsed time
  (`parseElapsed`/`skipClock`, `clock.js:339, :389`) with no model involvement — the residency
  window is this exact case, and asking a model to count months would be trading arithmetic fold
  can do for a hallucination surface. `dispositionRank` of judgement to code, again.
- **World-turn results are ordinary ledger events**, `src: 'world'`, carrying `where` and
  `seen` (`clock-table.js:188-192, :78-79` — both fields exist), folding like everything else
  and therefore swipe-safe and auditable like everything else.

### 7.4 When it fires: the pass that already runs, armed by declared time

The plan costed "one larger call per downtime period." This design does better: **zero
additional calls**, honouring §11's commitment, because the trigger already exists and is
already instrumented. A declared elapse is detected by `parseElapsed` and acted on twice today —
the player's own skip moves the clock (`state.js:98-117`) and schedules an extraction
(`sceneMayHaveMoved`, `trigger-table.js:63-77`; counted as `extract:on-time-skipped`,
`observe.js:140`). The world-turn is a fifth fragment on that same shared pass
(`extract.js:156-275`), **armed only when** the pass was triggered by a time skip or scene
break, or when a `per`-front's boundary elapsed. On an ordinary conversational turn the
fragment is absent and the pass is exactly today's.

The armed fragment receives the elapsed span and the pinned ledger, and is asked one
constrained question: *given that this much time passed, which of these standing agendas and
fronts plausibly advanced, and how?* Constraints, enforced in code like every other probe:

- A proposed move must be **rooted**: it names an existing row's `wants` or an existing front's
  next step. Unrooted inventions are refused and counted (`reject:unrooted-move`) — the world
  probe may *advance* the world fold knows about, never author a new one. New actors and fronts
  still enter the normal way, by being established on-screen.
- Advancement is bounded per span the way ticks are bounded per turn (`MAX_TICK`,
  `clock-table.js:67`), scaled by the declared span — an afternoon advances almost nothing, a
  year (one turn can be a year) advances much, and the span is in the prompt so the model's
  judgement is anchored to it.
- Moves land as `seen: hidden` unless the probe can justify the pov perceiving them — the same
  honest default the clock probe already has (`clocks.js:74-78`).

### 7.5 What the player sees: discovery, not bulletins

The visibility rule adopted for hidden clocks generalises: **the panel and the injection never
tell the player what their character has not learned, and never pretend nothing is happening.**

- Hidden world state renders as the hidden dial does today — named, unquantified
  (`panel.js:501-508`; `renderClocks` hidden branch, `clock-table.js:329-333`).
- The narrator, unlike the player, gets the full hidden state in `ledgerBlock()` under an
  explicit reveal contract: *these things are true and the character does not know them; reveal
  them only through what the character could perceive.* This is the lock-serialization insight
  (§8) applied to knowledge: tell the model the constraint instead of hoping omission implies it.
- Locality gates the reveal surface: world events carry `where`, and the same `local` predicate
  that scopes clocks (`clock-table.js:273-276`) decides when a changed place is assertable —
  walk back to the Nowon gate site and the pinned block may now assert what changed there;
  until then it may not.
- The review pass (§2) flips `hidden → open` when the narration actually reveals a thing, so
  discovery is itself recorded and badged on the panel — the world changed, *and you found out*
  is a NEW-badge moment, which is exactly the feeling this feature exists to produce.

## 8. The UI: three altitudes, no configuration

References, verified this session: the interaction pattern to copy is sanguinehost's, **with one
correction to the plan** — in the shipped code a drag does *not* close the card
(`sanguinehost.com/public/main.js:940-953`, whose comment supersedes the stale one at
`:1699-1701`); a tap on the void closes without resetting the camera (`main.js:1038`), and only
explicit closes pair `selectPillar(null); resetCamera()` (`main.js:1893-1898`). The principle
fold takes is the corrected one: **dismissal and returning home are different moves, and
interaction never costs you your place.**

### Altitude 1 — the ambient strip

One slim always-visible line (the collapsed form of the panel, not a separate feature):

```
14:07 · the broker's shop · ₩330,000 · ◔ 1/20 · [last verdict flash]
```

Time, place, money, the most urgent dial, and a transient band-colored flash when a verdict
fires. Clicking anywhere on it opens altitude 2 at the thing clicked. Nothing on it is
configurable; it renders whatever exists and collapses segments that don't.

### Altitude 2 — the glance panel (the current panel, restructured)

Keeps: the moving-panel chrome (`panel.js:65-98`), recency rails (`panel.js:486-489`),
NEW/UPDATED/RESOLVED badges (`panel.js:541-548`), disposition pips (`panel.js:557-565`),
hidden-clock rendering (`panel.js:496-522`), the countdown alert (`panel.js:364-397`).

Restructured order, stakes before nouns: **You** (pov, marks, money) → **Pressure** (doom
dials, urgency-sorted as today, `clock-table.js:266-278`) → **Progress** (progress dials, drawn
as filling bars, never clock faces — §4 polarity) → **Here** (cast rows with pips) →
**Elsewhere** (collapsed to a count, expandable) → **Stuff** (carried; places;
property/abilities last) → **Threads** (dial-less, prose-with-meter). The scene header loses
`conditions` (§3). Every section is the same data the injection carries — the panel *is*
`ledgerBlock()` with affordances.

Two honesty marks the second repair demanded (§0.1-1, §0.1-2): an UNPLACED person renders in
**Here** but visibly hedged — dimmed, suffixed "· whereabouts unstated" — and is never asserted
plainly in the injection; and a **contested lock** stops being invisible: the locked row gains
an amber state reading *locked — narrative says "‹blocked value›" (accept · keep)*, so the
seven silently discarded writes that emptied the scene become one glanceable disagreement with
a one-click resolution.

Two affordances generalise to **every row**, stolen with citations:

- **Edit in place**: `contenteditable` + commit-on-blur/Enter, display-form/edit-form swap on
  focus, placeholder-on-empty — RPG Companion's one genuinely excellent surface
  (`rpg-companion-sillytavern/src/systems/rendering/userStats.js:328, :452`,
  `infoBox.js:632-637`, `thoughts.js:585`). Every commit is a **user event in the ledger**
  (the mechanism exists: `recordUserEvent` `chronicle.js:339-354`, `moveItem`/`adjustItem`
  `state.js:647-699`, `clocks.set` `clocks.js:168-195`) — hand edits stay auditable and
  swipe-safe, and the §0 repair script becomes clicking.
- **Lock in place**: the hover-revealed corner glyph, permanently visible when locked
  (`rpg-companion-sillytavern/style.css:874-914`), addressing any row by path
  (`lockManager.js:425-475`). And the part of their design that is better than fold's current
  skip-the-write (`state.js:220-224`): **serialize the lock into the prompt** —
  `lockManager.js:11-12, :57-61` marks the value `locked: true` in what the model reads, so the
  narrator is *told* the field is pinned instead of silently overridden and left to fight it.
  `ledgerBlock()` renders locked fields as `(fixed)`.

### Altitude 3 — the sheet (a place you go)

A full-height drawer over the chat (state preserved on close, camera untouched — the
sanguinehost rule). Opened from any glance row via the attend→open pattern: hover highlights
(geometric hit test, no dwell timers — `main.js:987-988`'s projected-radius idea reduced to
row hover), click opens the card for that row. The open/close animation is one class toggle on
`opacity/transform/pointer-events` (`sanguinehost.com/public/index.html:603-633` — the
`pointer-events` pairing is the detail that keeps a hidden panel from eating clicks), sliding
from the right on desktop and bottom on mobile (`index.html:1155-1178`).

Contents, four tabs, none configurable:

1. **Relationships** — requested by the user in exactly these terms after meeting Park Min-ji
   ("we really need a dedicated relationships tab/section with present (in scene) relationships
   and then all historical relationships to navigate through"), and the request names what the
   roster framing missed: a cast list answers *who exists*; this tab answers *where you stand*.
   Two bands: **Present** — the in-scene cast, same rows as the glance panel's Here; and
   **Everyone you have known** — every cast row ever, gone included, ordered by last
   interaction, navigable. A row opens the relationship card: name and aka; disposition pips
   with the word **and its trail** — each `feels` change listed with the message that caused it
   (CK3's never-a-bare-number rule applied to people: *"friendly — doubled your cut from her own
   share"* explains a relationship the way `+15 opinion: saved my life` explains a number);
   `wants` / `knows` / `reach`; their marks; shared threads (threads whose name or `aka` matches
   theirs); and their event history — chronicle events whose keywords match their aliases, which
   the keyword index already serves (`chronicle-table.js` `buildKeywordIndex`). Every field
   editable and lockable like everywhere else. This tab is also the player-facing half of the
   plan's callback thesis: Mythic's Characters list is the callback pool, and browsing old
   relationships is how a player finds the thread worth pulling.
2. **Threads** — open, closed (struck), moot; the archive is the campaign's spine in one list.
3. **Ledger** — the chronicle, newest first, with each event's delta; **click a value anywhere
   in the UI → its contributor trail → click a contributor → the chat scrolls to the causing
   message.** The trail exists (`state.js:599`); contributors gain the anchor `mid` (they
   currently store only `{at: timestamp, dq, summary}`, `state-table.js:955`) and the jump is
   `document.querySelector('.mes[mesid]')`+`scrollIntoView`. This is CK3's never-a-bare-number
   rule and ScenePulse's cause-link, on data fold already stores.
4. **Instruments** — the observe report (`observe.js:92-103`), never-fired list
   (`observe.js:158-161`), and the calibrate table. The debugging surface stops being the
   browser console (`index.js:613-647`'s console dumps retire here).

**Zero mandatory configuration** is measured against the negative reference: RPG Companion ships
51 checkboxes in one template (24 display + 9 feature + 15 widget + 2 advanced;
`rpg-companion-sillytavern/template.html:114-905`), twelve of which are *toggles controlling
whether other toggles are visible* (`template.html:470-563`). fold ships the existing RPG-mode
master switch (`index.js:677-701`) and nothing else new. Panel geometry is direct manipulation,
remembered per SillyTavern's MovingUI as today.

---

## 9. Migration

Non-negotiable constraint: the Solo Leveling campaign, mid-flight, with hand repairs and locks
in it, must load unchanged in meaning. All fold state lives in `chat_metadata.fold {v, state,
chronicle}`; the redesign bumps `v: 1 → 2` with an idempotent, pure `migrate()` run on first
load of a v1 blob, unit-tested and — the real test — **replayed against copies of all three live
chats with a before/after invariant script** (extend `tests/util/fold-calibrate.mjs`, which
already parses the real headers):

| v1 | v2 | rule |
|---|---|---|
| `state.entities` person rows | cast rows | field-preserving; `detail` splits: contact info → `reach`, rest stays |
| `state.entities` lead rows | threads (no dial) | 1:1; `open`/`status`/`source` carry over |
| `state.clocks` | threads (dial) | 1:1; `filled/size/where/seen` carry; full → `closed`; `kind` defaults `doom` — a v1 clock whose `about` reads as the player winning is exactly the case migration must NOT guess, so it stays `doom` and is flagged for the first review pass (§0.1-3) |
| `state.context` fields shadowing structured tables (`leads`, `pressure`, `health`) | routed through the §5 block rule into thread/mark proposals, or dropped with `reject:block-shadow` | never carried into v2 context — the second repair deleted these by hand; migration does it by rule |
| lead + clock about one stake | **not auto-merged** | flagged as an identity question for the first review pass (§2); auto-merging on token overlap is exactly the guess this design forbids |
| `state.context.conditions` | pov marks | routed on **provenance, not label** (Phase D deviation 1): only `src: 'narrative'` — the scene probe, whose schema defines the field as the pov's body — routes to marks; a card's own `conditions` heading can mean the weather (measured: Raccoon City's *"cool, dry night; dim CRT-lit apartment"* would have become three marks claiming the protagonist suffers from a CRT). `health`-family labels route regardless. Legacy healing via the demoted `splitConditions`/`isNegation`; severity defaults *moderate* |
| `state.context.rank`, `mana`, other block-only labels | pov `facts` | never age again |
| chronicle `st` deltas (subjectless) | fold-time default `who = pov` | **read-time healing, no rewrite** — the house pattern (`state-table.js:927-933` re-normalizes on read; same trick) |
| inventory `contacts` place rows | `reach` on the named row | the two rows in today's ledger name their owners in the item name |
| `state.locks` | unchanged | locks survive verbatim |
| `chronicle.events` | **untouched** | state is a fold; old events fold forever under v2 read rules |

Invariants the replay script asserts per chat: cast row count preserved (± confirmed merges,
which at migration time is zero), thread count = leads + clocks, derived money unchanged,
derived item multiset unchanged minus contacts rows, every lock intact, all 787 existing tests
still green plus the migration suite.

One trap found by reading rather than assuming: `getFold()` **silently restamps any version
mismatch back to the current constant** (`store.js:44-46`, `fold.v = FOLD_SCHEMA_VERSION` with
`FOLD_SCHEMA_VERSION = 1` at `store.js:18`) — so under today's code a v2 blob would be relabelled
v1 without conversion, and the version field is currently decoration. The migration phase
replaces that restamp with the real dispatch: `v < 2` → run `migrate()`, `v > current` → refuse
to write (an older fold must never scribble on a newer chat's state). Rollback safety comes from
migration writing new keys (`cast`, `threads`) beside the old (`entities`, `clocks`) and deleting
the old only after the first successful v2 commit; unknown paths under `fold` are untouched by
`resolve()` and the pruners, which only address their own tables (`store.js:56-68, :482-498` in
`chronicle.js`).

---

## 10. Implementation plan

Ordered, independently shippable; each phase names its measurable gate **on the real chats and
the observe counters** (baseline in the header table above). Standing constraints for every
phase: `npm run test:unit --prefix tests` green (787 + new), `npm run lint` green (restore
eslint with `npm i --no-save eslint@^8` after any `start.sh` run; verify
`./node_modules/.bin/eslint --version` → 8.x), port 8420 only, user settings untouched.

**Phase A — Nothing is billed twice** *(window high-water split; pinned `ledgerBlock()` into the
extraction prompt; `reject:already-recorded`; head-token `canonicalItemName`; contacts → reach)*
Pure-layer work in `extract.js`, `state-table.js`, `block-parse.js`, plus the shared renderer.
Gate: a replay fixture built from the real mids-46..58 window sequence produces each of
{phone exchange, candy, knife} **exactly once**; `fold-calibrate.mjs` gains a duplicate-beat
detector reporting 0 on the fixture and ≥3 on the v1 ledger; live, `extract:delta-empty` stops
climbing relative to `extract:ok` (today 17 vs 11 — most "empty" passes are the model correctly
declining to re-report, at the cost of a call that taught us nothing).

> **LANDED 2026-08-08, gate verified independently.** 834/834 tests (787 + 47), lint clean on
> eslint 8.57.1; duplicate beats on the real ledger copy **9 → 0** — the detector also caught
> three beats nobody had reported (the whole purchase haul re-billed at mids 66/68, including
> `darkwood staff ×3` and `mana-shackle bracers ×3`). Replay refusals: `already-recorded` 7,
> `not-mentioned` 7, `not-an-item` 2. Accepted deviations, documented in the code's docblocks:
> the pure split lives in new `extract-table.js` (extract.js imports script.js and cannot be
> unit-tested); the high-water mark is `(mid, key)` not bare mid (a bare mid is defeated by a
> swipe — content changes, index doesn't); `ledgerBlock()` returns `{text, shown}` so the
> already-recorded gate refuses only what the model was actually shown (`isFresh` still hides,
> until Phase C); `windowText` for the mention gate is the new half only — that scoping, not the
> ledger gate, is what kills the mid-52/54/58 duplicates; `isMentioned` and canonicalization now
> share one `itemHead` (two definitions of "what is this called" briefly made the gate refuse
> the very knife its window was about). **Known cost, asserted in a test rather than hidden:** a
> genuine same-name re-acquisition is refused — the bracers destroyed at mid 38 and re-bought at
> 66 stay at ledger 1 where the old rules said 3; nothing in `{item, dq, at}` distinguishes
> re-buy from re-report, and Phase C's directed money question is the designed recovery (a
> refused credit with a payment in the window is exactly its trigger shape).

**Findings carried out of Phase A, assigned:**
- **The ₩9,999 root is deeper than the missing `at`** — `merge_qty` reads `nu?.at ?? old?.at`,
  but `bumpQty` hands it `{dq}` with no `at` and the stored shape is `{qty}`, so *any*
  dq-sourced money clamps at `MAX_QTY` even when tagged `at: "money"`; only the `setQty` path
  reads the place off the key. Until fixed, the pinned `Money:` line lies for dq-sourced
  balances. → **Phase C scope** (it owns `state-table.js`), fix + regression test.
- `MAX_CHANGES_PER_TURN` (12) now **BINDS** — observed max 13 on the live chat. → Phase C
  raises it with the measurement in the docblock, house style.
- The pinned block's "report only CHANGES" header sits above the cast list too; if the model
  obeys it for people, presence re-reports starve. → Phase C watch item: the review probe is
  the designed replacement for re-report-driven presence, and its counters must confirm that.

**Phase B — One table for what's at stake** *(threads = leads ∪ clocks ∪ tracks; dial
`kind ∈ {doom, progress}` — §4 polarity; `moot`; `aka` on threads; migration v2 — existing
clocks default `doom`, with the §0.1-3 inverted-clock case as the test that polarity migrates
right; `castAt` keeps UNPLACED three-valued to the consumers, panel hedges it — §0.1-1; panel
renders doom as clock faces and progress as bars, Progress never under Pressure; fix the
ecs.slang docblock while touching entity-table)*
Gate: migration replay over all three chat copies passes every §9 invariant; the residency lead
and clock migrate to two threads **flagged as an identity-question pair** (§9 forbids the
auto-merge; the single 1/20 rendering lands when Phase C's review confirms it); a fixture
containing one doom and one progress dial renders and injects them under different headings —
the §0.1-3 pair is the fixture; an UNPLACED person appears hedged, never plainly asserted; the
unit suites for entity-table and clock-table port over with zero semantic changes to untouched
behaviour.

> **LANDED 2026-08-08, gate measured.** 886/886 unit tests (834 + 52), lint clean on eslint
> 8.57.1 at both roots. Migration replay over **four** chat copies (Solo Leveling, Evil Hero Party,
> Raccoon City, Nora — the fourth added because it is a fourth campaign with real fold state):
> every §9 invariant holds on all four. Cast 9/14/0/5 preserved exactly; threads 11 = 10 leads + 1
> clock, 15 = 15 + 0, 1 = 0 + 0 + 1 routed from block prose, 5 = 5 + 0; derived money ₩210,000
> unchanged; derived item multiset unchanged; locks and chronicle byte-identical. The residency
> lead and clock migrate to **two** threads flagged as an identity-question pair, no merge. The
> detector also found two real, previously invisible splits in Evil Hero Party — `Paulette` /
> `Paulette Le Maltildis` and `Lillian` / `Lillian Everard` — with **zero** false positives across
> all four chats.
>
> Accepted deviations, each documented in the code's docblocks:
> **(1)** The migration lives in new pure `migrate.js`, not in `store.js`, for Phase A's reason —
> `store.js` imports `script.js` and cannot be unit-tested or replayed.
> **(2)** `nearIdentity`'s "same head token" is satisfied by the FIRST token for the substitution
> branch and by EITHER end for the subset branch. Measured: first-token-only cannot see
> `broker` / `scarred broker` (an English noun phrase heads last), last-token-only cannot see
> `Kang` / `Kang Min-seo` or `squad` / `team`, and accepting either end for BOTH branches asks
> whether Lord Everard is Lillian Everard. The asymmetry catches all three measured pairs and
> nothing else.
> **(3)** §2's detector provably cannot reach the residency pair — `{hunter, residency, twenty,
> d-rank, raids}` against `{residency, window, closes}` is neither a subset nor one substitution —
> because two tables that were never keyed against each other have no reason to word a stake alike.
> Migration therefore adds a second, migration-only trigger: a dial thread and a dial-less thread
> sharing a distinctive token in `name`/`about`. (`open` was tried first and produced a false pair;
> where a thread stands is not what it is about.)
> **(4)** Polarity is flagged for review on **every** migrated dial rather than only on
> "win-shaped" ones. Detecting win-shaped `about` prose means an enumerated word list, which §11
> forbids with a standing measurement; the cost of the honest version is one question per migrated
> clock, and the measured population is one across four campaigns.
> **(5)** A block-shadow context field is deleted only when at least one of its clauses routed into
> a thread, and everything the exposition gate refused is kept verbatim under
> `state.migrated.dropped`. On Raccoon City extraction never ran, so that field is not a duplicate
> of a structured row — it is the only row, and §9's "never carried into v2 context" must not mean
> "destroyed".
> **(6)** Threads carry `detail` AND `about` rather than one prose field: for a doom, "the
> sponsorship lapses" is the consequence, not a description, and a renderer that cannot tell them
> apart writes the consequence as though it had already happened.
> **(7)** The `contacts` rows become `reach` on the named cast rows, but they still DERIVE from the
> ledger, because removing them from the derived inventory needs a read rule in `deriveState` —
> Phase C's file. The replay asserts the checkable half (multiset unchanged, every contacts row
> landed as a reach) and prints the residual.
>
> **Found while measuring, not fixed here:** `UNSETTLED` (`entity-table.js:533-543`) has no word
> boundaries, so `isExposition` accepts "RPD data **show**s escalating incidents" on the `how`
> inside "shows". That is the one Raccoon City clause that routed. It is the same class as the
> `isNegation` bug in §0.1-4 and belongs with Phase C's demotion of those lists, not with a quiet
> regex patch here.
>
> **Not measured:** the panel assertions are written as `tests/frontend/fold-panel-threads.e2e.js`
> and were **not executed** — this machine's Playwright chromium install extracts exactly one file
> and then reports success, both before and after a forced reinstall. The pure layer's half of that
> gate (three-valued `castAt`, `renderEntities` hedging and never asserting) is unit-tested and
> green. The staged e2e run moves to Phase F's gate, which owns Playwright work.
>
> **Orchestrator verification, 2026-08-08:** replay re-run independently over all four copies —
> exit 0, every §9 invariant holds; 886/886 tests and lint confirmed at both roots. The migration
> numbers above match the replay output line for line.
>
> **Live confirmation, same day, unplanned:** the working tree IS the user's live install, and
> the migration ran on the real Solo Leveling chat mid-session — the header now reads `v: 2`
> with the cast intact and ten threads routed, while the user played on to message 87. The
> post-A/B pipeline captured a brand-new character cleanly (Park Min-ji: correct place, aka,
> `wants: "company, a break from routine loneliness"`, `knows` filled — turn 16, no duplicate
> row). The same session also minted a fresh duplicate thread pair, `bug bounty payout` /
> `bug bounty payment` — a one-token substitution, i.e. the near-identity detector's exact case
> — which becomes live ground truth for Phase C's merge gate. Operational note for every later
> phase: landing code in `public/` goes live at the user's next page reload; phases must land
> whole, never half.

**Phase C — Everything can close** *(the review probe; closure events; identity questions over
cast rows AND threads with the near-identity trigger of §2; unplaced-person questions;
contested-lock mechanics — §5, `lock:contested`; block-field routing into structured pipelines —
§5, `reject:block-shadow`; the directed money question — §5 fix 1; delete `isFresh` hiding;
`review:settled/moot/kept/merged` counters)*
Gate: `cap:stale-hidden` retired (0 by construction); the broker pair AND the
`Kang's squad`/`Kang's team` thread pair (§0.1-6) each merge on the first review pass over a
fixture reconstructing the pre-repair2 header; a fixture replay of mids 59–72 settles T3 (the
weapon thread) within one pass **and lands the ₩120,000 debit** via the directed money question
(the credits-without-debit trigger fires on the recorded mid-60/62 events); a fixture of the
locked-location sequence (turn 10 lock, 7 blocked writes) shows `lock:contested` raised by the
third disagreement and the panel state carrying the narrative's value for one-click acceptance;
a block containing `leads`/`health`/`pressure` fields routes into thread/mark proposals with
zero new context keys; no thread in any live chat remains open more than 2 passes after its
closing text (checked by hand against the logs once, then by the counters).

> **LANDED 2026-08-08, gate measured.** 985/985 unit tests (886 + 99), lint clean on eslint 8.57.1
> at both roots. Migration replay re-run over all four chat copies: every §9 invariant holds, and
> the contacts residual Phase B printed is **2 → 0** (the rows are in the ledger and no longer in
> derived state). `cap:stale-hidden` is retired **by construction**: `isFresh` is deleted, no code
> path can increment the counter, and a unit test reads the source to prove it — the previously
> hidden knife/licence/pamphlet class renders again. On a fixture rebuilt from the pre-repair2
> header, the broker pair AND `Kang's squad`/`Kang's team` each merge on the first pass from canned
> `same` answers, with an audit event each; a canned `different` is stored and `outstanding()` never
> re-asks it, in either pair order. The mids 59–72 fixture settles the weapon thread in one pass;
> the credits-without-debit trigger fires on the recorded mid-60/62 deltas; a canned "₩120,000"
> validates as an ordinary money delta and the derived balance moves ₩330,000 → ₩210,000. The
> locked-location sequence raises `lock:contested` on the third of its seven blocked writes, once,
> and the snapshot carries `{lockedValue, narrativeValue, count}`. The pre-repair2 `leads`/`pressure`
> /`health` fields route with **zero** context keys left behind, refusals kept verbatim. Pinned block
> on the worst header: 28 lines, 4,196 characters.
>
> Accepted deviations, each documented in the code's docblocks:
> **(1)** Two new modules, for Phase A's and B's reason (anything importing `script.js` cannot be
> unit-tested): pure `review-table.js` (what to ask, what an answer means) beside impure `review.js`
> (storage, writes), and pure `absorb-table.js` for the block-routing rule. `state.js` needs
> `review.pending()` to build the block and `review.js` needs `validateDelta` to bank a payment —
> a cycle — so the validator is a PARAMETER, exactly as `chronicle.applyExtraction` already takes it.
> **(2)** Closure shape: **stored table, read-time overlay** (`thread-table.js` `overlayClosures`),
> as recommended. Closure events carry `d.threads: [{key, status}]` anchored on the newest live
> message; every thread READ path composes stored rows with `chronicle.threadClosures()`; every
> WRITE path takes `load()`. Swipe the closing turn → content key changes → `liveEvents()` drops the
> event → the stored row, never edited, reads open again. The two rejected alternatives (write the
> status; move threads wholly into the ledger) are recorded with their arguments.
> **(3)** Identity merges are WRITES, not overlays, and the asymmetry is argued: `merge_entity`'s
> alias set is the Set face — a name someone was called does not stop having been used for them —
> and the swipe that would retract a merge also removes the sentence containing both names. Each
> merge leaves an audit event.
> **(4)** The review sees `clocks.reviewable()`, **not** `clocks.sections()`. Found by the hand-check,
> not by reasoning: `threadsByKind` drops non-local and stale threads, so the Goblin-Market-trip class
> — a stake bound to a place you have left — could never reach the block and therefore could never
> close. THREAD_STALE still hides threads from the narrator's block; it no longer decides what can
> close, which is the condition its own "on borrowed time" note set.
> **(5)** The review section **replaces** the `Pressure:`/`Progress:`/`Threads:` lines in the
> extraction prompt rather than sitting under them. Printing both put every open thread in the block
> twice, in two representations — the defect §5 spends its longest paragraph on. Measured: 30 lines
> and 6,173 characters before, 28 and 4,196 after. The narrator's `render()` is untouched.
> **(6)** `MAX_QUESTIONS = 8` sits INSIDE the observed maximum, against the house convention, and the
> docblock argues why: this bound caps a QUEUE, not data. Ten questions are outstanding on the worst
> observed first pass (pre-repair2 Solo Leveling: six identity pairs, two polarity flags, one lock,
> one money); nothing that does not fit is lost, because every source re-raises it next pass. The
> countervailing risk is §12's rubber-stamping, which is unmeasured. Ordering is fixed so the two
> pairs this gate names are always asked first.
> **(7)** `MAX_CHANGES_PER_TURN` 12 → 26 (twice Phase A's observed 13), AND the counting was wrong:
> `accepted.length` included restated totals, so the message-72 reconciliation's 30 restatements
> would have starved any genuine change queued behind the twelfth — the exact starvation the comment
> beside the check already argued against. The budget now counts changes.
> **(8)** `bumpQty` reads the place off the key, so a `{item:"won",dq:360000,at:"money"}` delta folds
> to 360,000. ⚠ The event actually recorded at mid 46 carries **no** `at`, so it keys as a carried
> "won" and is still capped at MAX_QTY — correctly, since a carried object is not a balance. Both
> halves are asserted in the suite rather than one being hidden; routing a bare currency name to the
> money place would need a word list, which §11 forbids.
> **(9)** `HEALTH_LABELS` is duplicated into `state-table.js` from a private set in `block-parse.js`
> (read-only this phase, Phase D's file), with a test that drives the real `classifyBlock` with every
> member and fails the moment they disagree.
>
> **Found while measuring, not by a test:** printing the real pinned block caught two live defects —
> the migration pairs' own `kind: 'thread'` overwrote the question kind, so four of ten questions
> rendered as blank lines with live ids behind them; and hidden dials printed their fill on the
> review block, leaking the number `renderPressure` deliberately withholds. Both fixed, both now
> under regression tests. This is the second phase running in which the log, not the suite, found
> the defect.
>
> **Known limits, named rather than papered over:** `nearIdentity` still cannot see
> `Dealing with Lord Tavish` / `Lord Tavish matter` (Evil Hero Party — different first token,
> different last token, more than one substitution) or the block-routed `Kang's squad — next D-raid
> pending` beside `Next raid with Kang's squad`. Both are one stake as two rows; the review can close
> them separately but will not merge them. Every miss stays recoverable by hand merge, which is the
> standing terms of §11's ban on similarity metrics.

> **Orchestrator verification of Phase C, 2026-08-08:** 985/985 tests and lint confirmed;
> migration replay re-run — every §9 invariant holds on all four copies, contacts residual
> **2 → 0**; `isFresh` grep confirms zero callers; `cap:stale-hidden` survives only as the
> registered zero and its tombstone comments (`observe.js:161`, `state.js:769`). The Evil Hero
> hand-check finding (three fiction-closed threads sitting reviewable with in-window evidence)
> is the strongest pre-live validation the review mechanism has; its first live confirmation
> comes from the user's next session. Two detector-unreachable duplicate pairs are named in the
> LANDED note as hand-merge territory — correctly left to the UI rather than loosened rules.

**Phase D — Every change has an owner** *(`who` on `st`/`vit`; marks on cast rows; `conditions`
out of scene — `panel.js:56`/`scene.js:67-70` retargeted; reassurance judged by the probe with
`isNegation`/`splitConditions` demoted to read-time healing — §3, §0.1-4; adversary `threat`;
`verdict.js:192` hurt fix; **relationship trails** — bounded Graph-face history of
`feels`/`wants`/`knows` changes per cast row, stamped with the pass's anchor mid, recorded from
this phase on so the §8 Relationships tab has data by the time Phase F renders it)*
Gate: unit fixtures reproducing the mid-30 events yield Lee and Park rows with owned marks and a
clean player; the panel header contains no body-state; a scripted raid fixture shows five wounded
as five rows; the *"bruised but functional"* block line yields exactly one mark and the
`fatigued`/`mild fatigue` pair folds to one owned mark on the legacy-healing path.

> **LANDED 2026-08-08, gate measured; orchestrator verified same day** (1040/1040 tests, 26
> suites; lint clean both roots; migration replay exit 0 on all copies with the marks/facts
> lines printed and every §9 invariant plus three new ones holding). Storage decision: **marks
> are owned `st` events, folded — no stored field at all.** A wound is the *result of an event*,
> which is what the ledger holds; swipe the wounding message and the fold never sees it, swipe
> the healing and the wound returns — recorded beside Phase C's closure analysis, with the
> stored-row alternative rejected because a mark that survives its swiped-away cause changes
> what the adjudicator does on every later attempt. Migration seeds pre-ledger marks first, so
> any real event about the same subject supersedes them.
> Gate numbers: mid-30 replay — Lee 1 mark, Park 1, pov 0, `hurtOf` 0; raid fixture 5 wounded →
> 5 owned rows, pov absent from the cast line; *"bruised but functional"* → exactly 1 mark;
> `fatigued`+`mild fatigue` one owner → 1, two owners → 2; verdict standing severe+minor = 3
> with other people's marks contributing exactly 0; solo context keys
> `…conditions,rank,mana…` → `time,date,location,weather,pov` with facts
> `rank`/`mana` never aging.
> Notable deviations, argued in code: `conditions` routes on **provenance** (see the §9 row
> above); `splitConditions` no longer splits on "and" — measured across all four chats, every
> "and" joins a compound predicate about one wound and none separates two; the reassurance
> branch of `isNegation` is anchored so "winded but unhurt" keeps the wound; fourth wound
> escalates-or-displaces rather than being refused (a refused wound is retraction-by-silence
> with a counter); adversary `threat` is the **one sanctioned silence-is-retraction** — the
> probe is asked for it on every person every pass, so a re-report of 0 is an answer, argued in
> its docblock; mark-merge questions deliberately not shipped (`statusKeyFor` now stems, and
> §2's detector provably cannot see the remaining pair-shape — a question that cannot fire
> costs budget the rubber-stamp risk cannot afford); relationship trails seeded in `foldEntity`
> with `MAX_TRAIL = 12`. Known legacy artifact, named: Raccoon City's ownerless
> `hangover faded [moderate]` mark — legacy healing preserves what the old flags said, and that
> chat has no cast rows to own it; the review clears it the first time that chat is played.
> `index.js` touched by 2 lines (fence deviation, reported): scene probe now receives the pass
> context, `clearMark` injected into the review like `validateDelta`.

**Phase W — The world moves** *(§7: `faction` kind; `steps`/`per` on threads; calendar fronts
ticked in code from `parseElapsed`; the world fragment armed on time-skip/scene-break passes;
rooted-move validation; hidden-state reveal contract in `ledgerBlock()`; `world:moved`,
`world:idle`, `reject:unrooted-move` counters)*
Gate, all offline against copies: (1) the reconstructed Solo Leveling ledger at mid 56 plus a
declared *"one week later"* fixture message produces, through the real extraction pass on the
cheap profile, ≥1 accepted move rooted in {Kang's `wants`, Jin-Woo's `wants`} and **0 accepted
unrooted moves**; (2) the residency front carrying `per: "1 month"` ticks 1/20 → deterministic
dial advance when the fixture clock crosses a month boundary, with **no model call involved in
that tick**; (3) the request count for the pass is unchanged from Phase C's baseline — the world
fragment provably rides the existing call (assert one request in the harness); (4) a renderer
unit test proves no `seen: hidden` event's content appears in the player-assertable region of
the injection, and locality flips it assertable when the fixture scene moves to the event's
`where`.

> **LANDED 2026-08-08.** 27 suites green (1053 tests at the time Phase E closes: Phase W added 25 —
> 8 calendar-tick, 2 money-precedent, 15 world); lint clean on eslint 8.57.1;
> migration replay re-run over all four chat copies (Solo Leveling RPG, Evil Hero Party, Raccoon
> City, Nora) — every §9 invariant holds.
>
> Gate results, all offline:
> - **(1) Rooted moves.** `planWorld` (`world-table.js`, the pure half; `world.js` the impure half)
>   resolves each proposed move's `who` against the entity table with `resolveEntity` — person first,
>   then faction — so a move naming a tracked actor is accepted and rooted at its key while a move
>   naming nobody is refused and counted `reject:unrooted-move`. A fixture mixing two rooted moves
>   (Kang Min-seo, Jin-Woo) with one unrooted splits 2 accepted / 1 rejected.
> - **(2) Calendar fronts tick in code.** `tickCalendar` was already written (as inert scaffolding in
>   an earlier phase) but had **zero tests and zero callers** — the residency window, "a pure
>   calendar condition that nothing in fold can tick," still could not tick. Eight tests added
>   (boundary crossing, fire-and-forget idempotency, first-sight anchoring, remainder held, the
>   deliberate non-application of MAX_TICK to player-declared elapse, hidden-stays-hidden, and
>   closed/full/dial-less untouched), and it is now called from `state.noteElapsed` the instant a
>   player-declared elapse moves the clock. No model involved in the tick.
> - **(3) One request.** The world fragment is the sixth probe on the one shared extraction call;
>   `runExtraction` still issues a single request. The caller's `decision.why` is threaded into the
>   pass context, and `world.applyExtraction` ignores every proposed move unless
>   `why ∈ WORLD_TRIGGERS` — the armed gate is in code, not the prompt.
> - **(4) Reveal contract.** `renderWorldEvents` + `revealContract` carry the recent `src: 'world'`
>   events into `ledgerBlock()`. A hidden event away from its `where` renders `(off-screen: <who>)`
>   — named, never asserted (the hidden-dial pattern of `thread-table.js` generalised to the world) —
>   and locality flips it assertable when the scene reaches its `where`. Both gate cases are
>   regression-tested.
>
> Accepted deviations, each argued where it lives:
> - World moves land as ordinary ledger events `src: 'world'`, `k: USER_ANCHOR` (always-live), with
>   `seen`/`where`/`who` carried in a `d.world` delta the fold ignores (no `inv`/`st`, so it mutates
>   nothing; `hasDelta` keeps it from being the first evicted). Not swipe-retractable, for the same
>   argued reason as `tickCalendar`: the span the player declared happened, and the world that moved
>   during it stays consistent with the clock that moved it.
> - The `world:unarmed` counter is added beside the gate's three: it counts a conversational pass
>   where the model proposed a move anyway — the prompt said nothing and the code gate refused.
> - A separate production bug surfaced this session (the user's live "money capped at 9,999"): an
>   untagged delta for an item already tracked under the `money` place now joins that row by
>   **precedent**, reading fold's own state rather than a name word-list — §11-compliant, and it does
>   not touch the `troops x10000` civilisation-scale case. Two tests. (Root cause: a no-`at` money
>   delta keying as carried and clamping at MAX_QTY; the mid-46 event of the live chat is the
>   permanent exhibit.)
> - `steps` (named front portents) stays stored-but-unrendered — Phase F owns the front UI (§8); the
>   dial behaviour (polarity, `per` ticking, `about` doom) is live. `faction` is admitted by the
>   product key and resolvable by the world probe, but renders like a `person` in the cast until
>   Phase F's faction card.
> - Not measured, stated as such: the end-to-end extraction-pass harness (gate 1 "through the real
>   extraction pass") is stubbed by pure-layer fixtures because this machine's model network is not
>   exercised offline; the armed-gate and event-writing paths are unit-tested up to the network
>   boundary, and the honest end-to-end confirmation is the user's next time-skip in play.

**Phase E — The judge plays** *(ledger into `classify`; targeted SETBACK ticks; COST write-back;
verdict surfaced on the strip; `tests/util/fold-verdict-replay.mjs`)*
Gate: the replay harness runs every user message of the Solo Leveling log through
classify+adjudicate against the reconstructed ledger at that point (one cheap-model pass,
offline): the message-35 leap and the crate-kill band non-CLEAR; shopping dialogue stays
uncontested; live, `verdict:cost + verdict:setback ≥ 1` within the first session of real play
and `uncontested` stops being 100% of contested-gate passes.

> **LANDED 2026-08-08.** 27 suites green (1053 tests, +9 verdict-table), lint clean on eslint
> 8.57.1; migration replay re-run over all four chat copies — every §9 invariant holds.
>
> Gate results:
> - **Ledger into `classify`.** `verdict.js` `classify` now hands the classifier `state.ledgerBlock()`
>   — marks, threat integers, momentum, feels/wants/knows, live threads — alongside the transcript,
>   so `supported` ("does anything on record make this possible?") is answered WITH the record.
>   §6's "it judges blind" is closed; `precedentFor` is no longer the only tracked fact that reaches
>   the verdict.
> - **Targeted SETBACK ticks.** New pure `matchThread` (`verdict-table.js`): the dial the attempt's
>   keywords/`against` actually match advances, weighted toward the thread about the person being
>   fought, and a setback with no matching thread ticks NOTHING — "a mis-aimed tick is worse than no
>   tick". Replaces the globally-first-non-full-clock victim. `verdict:setback-aimed` counts an aimed
>   tick.
> - **COST write-back.** A COST verdict calls `notePendingCost`; the next extraction pass takes it
>   (`takePendingCost`, read-and-delete so it can never be read twice) and is told to record the cost
>   as a delta — the loop §6 says used to rely on the narrator's prose happening to re-extract.
> - **Replay harness** `tests/util/fold-verdict-replay.mjs`. Reconstructs the standing (momentum,
>   hurt, precedent) from the real chat's own chronicle and reports the deterministic band for the
>   §6 fixtures: the mid-35 leap → **SETBACK**, the crate-kill → **COST**, both non-CLEAR, on
>   standing read from the live ledger (leap standing −8..−6, crate-kill −2..0). Also replays the
>   gate across all 74 user messages so the gate's true shape — a permissive pre-filter on whether
>   to spend a call — is visible rather than assumed.
>
> Accepted deviations / honest limits, each argued where it lives:
> - "Shopping stays uncontested" is the CLASSIFIER's `contested:false`, not the gate — `verdict.js`
>   `judge` already returns `uncontested` on that flag. The gate replay therefore shows the permissive
>   pre-filter and the harness states that the contestedness half is the live play confirmation, not
>   something the offline instrument can assert.
> - The end-to-end "one cheap-model pass" (classify through a real model) is not exercised offline:
>   `verdict.js` imports the SillyTavern runtime. The deterministic half — the band arithmetic and the
>   targeted-tick placement — is unit-tested against the §6 fixtures with standings read from the real
>   ledger; the live half is `verdict:cost + verdict:setback ≥ 1` and `uncontested` ceasing to be 100%
>   in the next real session, exactly as the gate states.
> - The verdict surfaced on the ambient strip (§6's fourth line) is Phase F's UI work, not E's; the
>   strip is specified in §8 and built there.

**Phase F — The three altitudes** *(strip; glance restructure; sheet drawer with the
**Relationships tab** as specified in §8 — present band + navigable history band + relationship
cards with the `feels` trail; edit/lock everywhere; cause-link jumps via `mid` on contributors
and on relationship trails)*
Gate: zero new settings (settings.html diff shows none); Playwright specs on 8420 for
edit-commits-as-ledger-events, lock round-trip including the `(fixed)` marker reaching the
prompt, and value→trail→message jump; the e2e suite additions live in
`tests/frontend/fold-*.e2e.js`. **Inherited debt:** repair this machine's broken Playwright
chromium install (extracts one file, reports success — Phase B's LANDED note) and run the four
staged assertions in `fold-panel-threads.e2e.js` as part of this gate.

> **LANDED 2026-08-08.** Unit suite green (1054), lint clean on eslint 8.57.1; **the fold e2e
> suite runs for the first time since Phase B** — 31 tests across `fold-chronicle`, `fold-steer`,
> `fold-panel-threads` and the new `fold-ui`, all passing via the system Chrome fallback.
>
> Gate results:
> - **Zero new settings.** `settings.html` untouched (mtime unchanged); the strip and the edits
>   add no controls, per §8's "zero mandatory configuration" measured against RPG Companion's 51
>   checkboxes.
> - **Edit-commits-as-ledger-events.** Inventory quantities (carried counts and money) are
>   editable in place (`contenteditable`, commit on blur/Enter). Each commit is a chronicle USER
>   event via `state.adjustItem` — which gained an `at` parameter so a money edit lands its delta
>   on the balance, not in a pocket (the mid-46 clamp lesson). Playwright asserts the chronicle
>   gains the `usr:` event carrying the delta.
> - **Lock round-trip with `(fixed)` reaching the prompt.** Locked scene fields render `(fixed)`
>   in the narrator's injected block (`state.render()`), the §8 lock-serialization: the narrator
>   is TOLD the field is pinned instead of silently overridden. Playwright locks `location` and
>   asserts `Location: … (fixed)` in the block.
> - **Value→trail→message jump.** Contributors carry their anchor `mid` from the ledger
>   (`deriveState`), and a trail row with a `mid` is a click that scrolls to `.mes[mesid]` and
>   flashes it. Playwright asserts the flash lands on the causing message.
> - **Inherited debt cleared.** The broken chromium install (stuck extracting, "one file then
>   success") is bypassed with `PW_CHANNEL=chrome` against the system Chrome 150, which the specs
>   use. Running the previously-staged `fold-panel-threads.e2e.js` surfaced and fixed two real
>   latent bugs the never-run spec would have hit all along: `t(badge)` crashed the renderer when
>   a NEW/UPDATED/RESOLVED badge was non-empty (`t` is a template tag; a bare string has no
>   `.reduce`), and `extractNow`/the "Extract Now" button never stamped the auto-cadence, so the
>   next reply always fired a duplicate automatic extraction (`runExtraction` now calls
>   `noteExtracted`, idempotent with the auto path).
>
> Altitudes landed this session:
> - **Altitude 1 — the ambient strip** (`#fold_strip`): time · place · money · most urgent doom
>   dial, empty segments collapsed, click opens the panel; a transient band-coloured flash on
>   verdicts (`panel.flashVerdict`, wired into the adjudicator). Rendered on every panel pass even
>   when the panel is collapsed; follows the RPG-mode switch.
> - **Altitude 2 — the glance restructure.** The §8 order: **You** (identity, vitals, marks,
>   money — money is a balance under You, not a row in Stuff) → deadline alert → Pressure →
>   Progress → Here → Elsewhere → **Stuff** (deferred to after the world) → Threads → Settled →
>   aside → shadow. The contested-lock amber state, UNPLACED hedging and edit-in-place ride the
>   reordered rows.
>
> **Not landed: the sheet drawer (altitude 3)** — the full-height drawer with the Relationships /
>   Threads / Ledger / Instruments tabs. It is not part of the Phase F gate (the gate is the three
>   Playwright specs + zero settings + the staged e2e), and this session's budget went to making
>   the e2e suite actually run for the first time. The data it needs is already stored: `feels`
>   trails are seeded by Phase D (`MAX_TRAIL = 12`), threads carry `steps`/`about`/status, and
>   contributors now carry `mid` for the cause-link jumps. It is the natural Phase F follow-up,
>   not a design gap.

**Phase G — debts** *(the missing theorem: `(last_seen, place)` under `merge_max` read through a
co-location predicate — convergent, non-monotone-in-time membership; verified this session as
still absent from the corpus, `KeyResolution.lean` being aliasing only; plus a calibration
re-baseline of every constant this redesign touched)*
Gate: lands in `sanguine/proof/` behind the existing `check-roots.py`/`check-citations.py`
gates; `fold-calibrate.mjs` re-run on all three chats with the new counters as the recorded
baseline in this file's header table.

A and B are independent; C needs both; D is independent of C but shares files with B (order
B→D); **W needs B (threads) and C (the pinned ledger and the armed-fragment machinery) and is
independent of D**; E needs C+D for an honest gate and is richer after W (off-screen
consequences are exactly the discoverable stakes a verdict should be able to spend); F needs
everything's data but can start its shell after B.

---

## 11. What this design is NOT doing, and why

House style: deleted approaches stay recorded with the measurement that killed them. The two in
`trigger-table.js:31-45` and `:144-170` (movement-verb gate: fired on 23/24 narrator messages;
attempt-verb list: ~50% precision and English-only) remain deleted and remain documented.

- **No usage dice / resource dice.** The plan floated Black Hack dice for consumables. Measured
  across all three chats: quantity-decrement noise is zero — every inventory defect was
  *duplication* (candy ×4, knife ×2, phones ×3) or a missing debit, never drift from counting.
  A die-size word solves a problem these campaigns don't have and adds a vocabulary the model
  must round-trip. Revisit only if a campaign shows decrement noise the ratio gate
  (`state-table.js:241-253`) can't hold.
- **No SWN faction *economy* — but off-screen world motion is IN (§7), and the first draft of
  this bullet is preserved as a warning.** It read: *"No faction-turn engine. Zero off-screen
  faction actions in ~180 turns of logs."* That measurement was invalid for that conclusion —
  the logs cannot exhibit a feature the system has never had, so the zero was evidence about the
  missing machinery, not about the value (§7.1 records the error in full). What stays dropped,
  on grounds that survive the correction, is SWN's bookkeeping layer: FacCreds, asset
  maintenance, faction hit points and the fixed action menu exist so a human GM can resolve a
  sector without judgement calls; fold has a model for the judgement and a ledger to bound it,
  and one actor should cost one cast row, not a balance sheet.
- **No calendar config.** Scribe's `CalendarConfig` is genuinely good and *not needed yet*:
  "Monday, ten years After Gates" and "Thursday, September 24, 1998" both live happily as
  versioned strings, and nothing in any log ever needed day-of-week arithmetic. Port it when a
  multi-year campaign actually asks what day it is.
- **No numeric meters for anything social.** `trust: 62` is the drift-prone shape; the
  disposition ladder (`entity-table.js:71-88`) stays words. The corpus reason is
  `merge_B_order_matters` (`OntologyClosure.lean:136-139`) plus the round-trip argument already
  in the docblock.
- **No fate-point economy.** Decided in the plan, still right: degenerate with one LLM as banker,
  prosecutor and beneficiary.
- **No similarity metrics for identity.** Token-subset detection only *raises the question*;
  the model answers it (§2). The `canonicalKey` docblock's argument (`entity-table.js:348-356`)
  was right about "Hero"≠"Solomon" and wrong to generalise; we keep the argument and fix the scope.
- **No per-message state snapshots.** Content-key liveness (`chronicle.js:59-84`) already makes
  swipes consistent by construction — the RPG Companion #148 class of bug can't occur. Scribe's
  per-variant snapshots solve a problem fold's derivation already dissolved.
- **No retrieval-driven memory expansion.** The chronicle/RRF machinery stays at its current
  size; the redesign spends its complexity budget on closing state, not growing it. The plan's
  "callback rate" metric stays the north star and is computable from the ledger as-is.
- **No second extraction call.** Review, dedup, closures, identity questions all ride the one
  existing pass. The user's stated enemy is dozens of tool calls; the design adds zero.
- **No decay.** `zero_residual_is_fixed` (`BayesFilter.lean:80-81`): absent a residual, belief
  holds. Retraction is evidence-driven (review reads the text) or nothing. `STALE_THRESHOLD`
  survives only as the context-band width for *scene* fields, the one place a "has the present
  moved on" question is honest. This is also why contested locks (§5) get a disagreement signal
  rather than an expiry — a lock that times out is decay wearing a UI.
- **No more enumerated judgement lists.** The deleted movement-verb gate (23/24 false-positive
  rate) and attempt-verb list (~50% precision, English-only) have a still-live sibling the
  second repair caught: `isNegation`'s reassurance vocabulary kept `functional` as a status flag
  because the word was not on the list (§0.1-4, `block-parse.js:404`). The rule
  `trigger-table.js:158-169` states — fold's own protocol vocabulary may be English; *reading
  the narrative is never fold's job* — now applies with no standing exceptions: `isNegation` and
  `splitConditions` are demoted to read-time healing of legacy rows (§3), and any future "just a
  small word list" proposal answers to this bullet.

## 12. Open questions, and the measurement that settles each

1. **Review reliability**: will a small model answer disposition questions honestly, or
   rubber-stamp `still: open`? Settled by the Phase C counters (`review:settled/kept` ratio) on
   one real session; if it rubber-stamps, the fallback is asking only about lines whose subject
   tokens appear in the new window (cheap pre-filter, same shape as the mention gate).
2. **`ledgerBlock()` size discipline**: the pinned block must stay under a screenful in a
   40-row campaign (Evil Hero Party already has 29 rows, 15 of them open leads). The renderer enforces the budget the
   schema promises (Here + open threads + marks + money; Elsewhere and archive never injected);
   Phase A's gate includes a rendered-size assertion over the Evil Hero Party header.
3. **Adversary `threat` extraction**: can the pass reliably open/step/close threat integers
   mid-combat? No live combat has run under the new schema; Phase D ships it behind the same
   review mechanism and the first real fight is the measurement. If it fails, threat falls back
   to a hand-set value on the row (the edit affordance makes that one click).
4. **Whether the injection helps at all** — the plan's unmeasured assumption, still unmeasured.
   The A/B it called for is now cheap (one renderer, one toggle in code): run one session with
   `ledgerBlock()` withheld from the narrator and compare verdict/callback behaviour. Scheduled
   with Phase E's harness work, because that harness is the instrument.
