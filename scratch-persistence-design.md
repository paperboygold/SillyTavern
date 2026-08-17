# fold persistence — design

Status: proposal, rev 2. Research-phase measurements were taken read-only over
`data/default-user/chats/*.jsonl` on 2026-08-13 with the shipped code; every fold I ran used the
shipped `deriveState` imported from `state-table.js`, never a reimplementation. Every claim about
existing code carries `path:line`. Paths are relative to `/home/socol/Workspace/SillyTavern`
unless they start with `../`.

Rev 2 incorporates the owner's answers: **the ledger is a timeline** — restore to any point in a
conversation with the information restored, and fork from that point, arbitrarily — is a
first-class requirement, not a branch policy (§4, §6). `tier` ops are cut (Q3, owner deferred to
my recommendation; the hot set is recomputed, §5 R2). The hydration bar is "faster than the
current panel", which is measured and cleared in §8.

---

## 1. The decision

Split fold's persistence by mutation pattern, not by module:

1. **The chronicle becomes a server-side, per-campaign, append-only JSONL ledger** at
   `data/<user>/extensions/fold/<campaignId>/ledger.jsonl`, written through a new
   `src/endpoints/fold-ledger.js` modeled on the shipped `fold-trace` endpoint
   (`src/endpoints/fold-trace.js:70-89`, mounted at `src/server-startup.js:148`) — but with true
   O(1) `fs.appendFile` per record, not fold-trace's read-whole-file-and-rewrite
   (`src/endpoints/fold-trace.js:45-50`). Every event row is durable **forever, with its delta**.
   The 128 KiB wall (`store.js:22`) stops applying to the thing that grows.

2. **`chat_metadata.fold` stays**, shrunk to the small per-branch mutable tables — cast, threads,
   answers, observed, clock, coverage, context, diagnostics log — plus two new scalars:
   `campaign` (a fold-minted UUID, the join key to the ledger) and `chatId` (the chat file name
   that owns this metadata, for branch/rename detection, §6). Measured today, those tables total
   ≤ ~30 KiB on the worst chat once chronicle + cold + their duplicates leave the blob (§2), and
   every one of them is already capped by its own table logic. The existing budget loop and pruner
   ordering (`store.js:38-40, 257-282`) stay as a backstop that should never fire again.

3. **Hot/cold becomes a view distinction, not a storage distinction.** `MAX_EVENTS = 300`
   (`chronicle-table.js:40`) keeps bounding what is *pinned into prompts and ranked for retrieval*;
   the hot set is recomputed from events+hits (it is already a pure function, `pruneEvents`), and
   the demoted row keeps `d`. The current `demoteEvents` drop of the delta (`chronicle.js:721-752`
   — the cold row is `{s, kw, t, src}`, built at `:743-748`) exists only because bytes were
   scarce; with the ledger, `derive()` folds over **all** live events. That is the fidelity the
   owner asked for: at year scale every quantity still traces to the event that caused it.

4. **`baseline`/`carryForward` (`state.js:720-780`) retirement is MANDATORY, not incidental.**
   The timeline requirement forbids them outright: `carryForward` folds evicted deltas into a
   flat key→qty table with no seq and no provenance (`state.js:766-778`), and mass absorbed there
   cannot be un-accumulated — a rewound view would read HEAD's balance at every earlier point.
   Rule: **on a ledger campaign, `carryForward` never runs and `state.baseline` is never
   written.** It has nothing left to rescue (R4: deltas are durable) and anything it wrote would
   be a hole in the timeline. Chats that already carry a baseline (all nine do or may): the
   importer pins it as a **pre-timeline seed** — a synthetic always-live event at seq 0,
   `fmid 0`, whose delta carries the accumulated quantities (§9). Its provenance is already
   destroyed, so the timeline before the import point is flat by construction: every restore
   target at or before the seed reads the seed's totals. Stated, not hidden.

Migration of the nine existing campaigns is explicitly **not** a gate (owner's correction,
2026-08-13: they are test data). A cheap importer falls out anyway (§9). New campaigns start on
the new format; old chats keep working read-only on the old path until touched.

Why not IndexedDB, SQLite, or localStorage: the browser stores die with the browser profile and
are invisible to `data/` backups; SQLite adds a native dependency ST does not have. Everything ST
treats as durable lives as files under `data/<user>/` (chats: `src/endpoints/chats.js:476`;
extension files: `src/endpoints/fold-trace.js:28-32`, and fold-traces is already 47 MB on this
machine without anyone noticing — the precedent that per-chat server files at MB scale are free).
The ledger goes in the same tree, so one backup of `data/` carries chats and ledgers together.

Why not "just raise MAX_FOLD_BYTES": the blob rides the chat JSONL header
(`public/script.js:7372-7387`), and **every** debounced fold commit already rewrites the whole
chat file — `store.js:182` → `saveMetadataDebounced` (`public/scripts/extensions.js:89-96`) →
`saveMetadata` → `saveChatConditional` → `saveChat` POSTs `[header, ...chat]`
(`public/script.js:7351-7392`) and the server rewrites the full file
(`src/endpoints/chats.js:457-467`). At 3,650 messages that is a multi-MB rewrite per extraction
pass, forever. A ledger append is ~300 B. Raising the cap makes the wrong thing bigger.

---

## 2. What was measured

Blob composition (my script over the live chat headers; sizes in bytes, cap = 131,072):

| chat | msgs | fold total | chronicle | state.log | state.cold | cast+threads+answers+rest |
|---|---|---|---|---|---|---|
| Royal Succession | 297 | 130,535 (100%) | 58,973 | 844 | 47,225 | ~23,500 |
| Wuxia | 277 | 121,238 (92%) | 67,689 | 36,537 | 0 | ~16,900 |
| Solo Leveling | 207 | 120,539 (92%) | 85,299 | 10,192 | 4,298 | ~20,700 |
| Time Stop | 101 | 74,441 (57%) | 24,511 | 29,431 | 0 | ~20,500 |

The growers are exactly chronicle events (up to 85 KiB, 286 events ≈ 298 B/event), the cold store
(47 KiB on Royal Succession — which is *demoted chronicle*, i.e. the same data again), and the
diagnostics log. What remains after moving chronicle + cold out is 17–24 KiB of capped tables.
Growth on the three biggest chats is 438–582 B/msg; at ~1.5 events/msg a year of daily play is
roughly 5,000–8,000 events ≈ **1.5–2.5 MB of ledger**. Disk-trivial; the design problem is only
where those bytes live and how they are read.

Read-path costs, measured with the **shipped** `deriveState` imported from `state-table.js`
(pure-Node importable; its dep chain `clock.js`/`entity-table.js`/`diag.js` has zero imports):

| | today (221–286 events) | year scale (3,600 events) |
|---|---|---|
| `deriveState` | 0.05–0.67 ms | 1.3–6.5 ms |
| `liveHashes`-equivalent (re-hash all messages, `chronicle.js:74-86`) | <0.5 ms | 3.6 ms (3,650 msgs × 1,055 chars avg) |
| `JSON.stringify(fold)` (runs per commit, `store.js:218-224`) | 0.4–0.6 ms | n/a — retired for chronicle writes |

Conclusion that shapes everything below: **the fold itself is not the bottleneck and never was.**
Synchronous derive survives a year of events with single-digit milliseconds. The ceiling is purely
the substrate.

---

## 3. Substrate (what survives what)

**Identity.** A campaign is identified by `chat_metadata.fold.campaign`, a UUID minted by fold the
first time it writes to a chat. It lives *inside* the chat file's metadata header, so it follows
the chat through everything the file survives — exactly the trick ST core already uses for its
`integrity` slug (`public/script.js:7610-7611`, checked server-side at
`src/endpoints/chats.js:316-335`). The ledger directory is keyed by that UUID, never by the chat
file name. `getCurrentChatId()` returns the file name (`public/script.js:540-546`) and rename
copies the file to a new name (`src/endpoints/chats.js:559-571`) — which is why the shipped
fold-traces, keyed by chat id (`trace.js:69-73`), orphan on rename. The campaign UUID does not.

**Layout.**

```
data/<user>/extensions/fold/<campaignId>/
  manifest.json        # { format: 1, campaign, parent: {campaign, forkSeq} | null,
                       #   chats: [names seen], createdAt }   — atomic-rewrite, tiny
  ledger.jsonl         # append-only ops, one JSON object per line
  checkpoint.json      # optional derived cache (§5); atomic-rewrite; deletable at any time
```

**Survival table.**

| event | fold blob (metadata) | ledger |
|---|---|---|
| chat rename | survives (rides the file) | survives (keyed by campaign, not name; manifest gains the new name; §6 adopt path) |
| chat copy / branch / checkpoint | copied with the file — ST merges branch metadata over the full `chat_metadata` (`public/scripts/bookmarks.js:199,231` + `public/script.js:7351`), so `campaign`+`chatId` arrive in the copy | fork-on-first-write: child campaign with `parent: {campaign, forkSeq}`, `forkSeq` cut at the branch point, not parent HEAD (§6.3) |
| swipe navigation | n/a | no storage action at all — liveness is content-keyed at read (`chronicle.js:61-86`), unchanged |
| ST upgrade | survives (upgrades do not touch `data/`) | survives (same) |
| `data/` backup restore | survives | survives **iff the backup includes `data/<user>/extensions/`** — it is the same tree, but a chats-only restore leaves metadata pointing at a missing ledger; detected via the cursor (§7), surfaced, not fatal |
| two tabs on one chat | last-writer-wins, as today — ST's integrity slug does not catch this case because both tabs share the same stable UUID (`src/endpoints/chats.js:333-334`) | both tabs' appends survive and interleave; strictly better (§7) |

**Versioning discipline.** `manifest.format` reuses `store.js`'s asymmetric rule verbatim
(`store.js:64-116, 127-130`): older format → convert; **newer format → hydrate read-only and
refuse to append**, because an old build cannot know what a new one meant. Every ledger line also
carries the op-schema version so a mixed-version file is readable line by line.

**RULE 1 compliance** (`AGENTS.md:6-29`): the storage layer never inspects prose. The only
content-derived value is `contentKey` — a hash, which is STRUCTURE under the rule, and it is the
same expression the liveness mechanism already uses (`chronicle.js:61-63`).

---

## 4. The ledger: format and replay semantics

One line per op. Server assigns `seq` — monotone per campaign, one Node process = one total
order. **`seq` is the timeline coordinate** (§6). Client supplies `opId` (UUID) for idempotent
retry and `chat` (the writing chat's file name) for provenance and the fork rules in §6.

**Envelope**, identical for every op:

```
{ seq, v: 1, opId, chat, at, fmid, ...op-specific fields }
```

`fmid` is the **frontier message index at append time** — the newest message index in the writing
chat when the op was appended, `-1` for an empty chat. It is envelope-level and unconditional
(unlike `e.mid`, the event's *anchor*, which can point at an older message for review closures,
`chronicle.js:515-535`, or be absent for world moves). `fmid` exists for exactly one purpose: it
is the join between the conversation's coordinate (a message index) and the ledger's coordinate
(`seq`) — §6's `restoreSeq`.

**Ops** — five, and this is the whole vocabulary:

```
{ op: 'ev',     k, e: {s, kw, t, mid, src, k, d} }  // event put — the full row, delta included
{ op: 'amend',  k, s }                              // summary rewrite (chronicle.js:660-673)
{ op: 'forget', k }                                 // tombstone     (chronicle.js:644-653)
{ op: 'hit',    keys: [...] }                       // retrieval credits (chronicle.js:584-591)
{ op: 'rewind', to: seqT }                          // timeline truncation, §6 — seqT < seq
```

`tier` ops are cut (owner deferred; my Q3 recommendation stands): the hot set is a pure function
of events+hits (`pruneEvents`), and under the timeline requirement a persisted tier would be one
more thing that has to be correct *at every seq* while being derivable at every seq. Recompute.

Reserved for stage 2, same envelope, not emitted in v1: `{op:'put', tbl, k, v}` /
`{op:'del', tbl, k}` mirroring `store.js`'s `commit` chokepoint (`store.js:175-184`) so the
probe-maintained tables (cast, threads, clock, …) can join the timeline later (§6, "exact vs
carried"; §10). Readers MUST skip unknown ops (the `#[serde(default)]` lesson,
`../legacy_archive/scribe/backend/src/models/game_state.rs:16-49`).

**Replay** is two stages, both pure:

1. **Effective sequence.** Walk the raw lines in `seq` order, deduping on `opId`, maintaining a
   list `L`: a non-`rewind` op appends to `L`; `rewind to=T` truncates — `L = [x ∈ L : x.seq ≤ T]`.
   Total by construction, whatever rewinds nest or cross.
2. **Fold.** Left-fold `L` into the tables: events by `insert_with(merge_b)` on `k` (later seq
   wins), `amend` rewrites `s`, tombstones delete, hits accumulate with `merge_bu`.

State **at** seq `s` — the time-travel read — is the same fold over `[x ∈ L : x.seq ≤ s]`.
Recovery and checkpointing compose for free: `replay(base, xs ++ ys) = replay(replay(base, xs),
ys)` is proved with **no algebraic condition at all** — it is `List.foldl_append`
(`../sanguine/proof/Closures/Applied/AIOperationSurface.lean:142-145`) — so a checkpoint is a
prefix fold and hydration is checkpoint + suffix, always equal to the full replay. One new
caveat `rewind` introduces: a checkpoint covering seq ≤ `c` is **invalid** if any later line is a
`rewind` with `to < c` — the covered prefix is no longer the effective prefix. Detection is one
comparison per rewind line in the suffix; on hit, discard the checkpoint and fold from scratch
(always available, R1).

The corpus also says precisely where reordering is and is not safe, and the format obeys it:

- `hit` (counter face) commutes — reorderable, shard-safe
  (`build_gauge_invariance`, `../sanguine/proof/Substrate/Algebra/Security/HashTrinityCore.lean:195`;
  `converges`, `../sanguine/proof/Closures/Applied/OntologyClosure.lean:117-120`).
- `ev`/`amend` are last-write (`merge_b`), which **diverges without a clock**
  (`merge_B_order_matters`, `.../OntologyClosure.lean:136-140`). The server-assigned `seq` is the
  clock; replay by max-seq is the versioned last-write that provably converges
  (`merge_max_converges`, `.../OntologyClosure.lean:152-156`). This is also why the read side gains
  a determinism fix: `liveEvents` today sorts by `t` alone (`chronicle.js:373-376`) and same-tick
  events tie; sorting by `(t, seq)` makes the fold order total.
- **Raw keys only, forever.** The identity crosswalk (`same_as`/`[same?]` verdicts,
  `state.js:696-713`) is applied at read time over the settled stream and is never baked into a
  stored row, a checkpoint, or a compaction. The corpus proves both directions of this rule: a
  resolver that reads the prefix breaks checkpoint+suffix replay even when the merge is a
  commutative monoid — no versioning repairs it
  (`incremental_resolution_breaks_the_split`,
  `../sanguine/proof/Substrate/Algebra/Security/IncrementalResolution.lean:130-136`) — and a
  prefix-blind second pass IS `relabel`, inheriting every soundness theorem
  (`relabelInc_const`, `.../IncrementalResolution.lean:99-105`). The shipped code already knows
  this failure by name — a carried-forward row "would fossilize under its old name"
  (`state.js:705-707`); the design rule generalizes it: **fold under raw keys; resolve at read.**
  (That file's counterexample block literally cites fold as its live instance:
  `.../IncrementalResolution.lean:53-58`.)

What Scribe's storage teaches here, from its own code: it stored an event log AND a
reconciled-blob state, and the blob was never replayed from events — the LLM proposed a complete
state and three sub-objects were copied in wholesale under "trust LLM output"
(`../legacy_archive/scribe/backend/src/services/game_state_service.rs:116-130, 268-285`). Its
event log had **no compaction path at all**, and its rich 8-field event ontology was ripped out by
a migration seven weeks after shipping
(`../legacy_archive/scribe/backend/migrations/2025-08-09-083724_simplify_chronicle_events/up.sql:1-20`).
fold already has the right shape (state = fold over events, `state-table.js:1-27`); the ledger
keeps it and refuses Scribe's parallel-blob pattern. The one Scribe storage idea worth keeping —
`#[serde(default)]`-everywhere blob tolerance as the versioning strategy that actually held
(`../legacy_archive/scribe/backend/src/models/game_state.rs:16-49`) — maps to: every replay reader
treats missing fields as defaults, so old lines stay readable under new code.

---

## 5. Tiers, and the eviction policy as rules

R1. **The ledger is append-only.** No code path rewrites or deletes a line. Segments may rotate at
    4 MB for hygiene; nothing deletes them. The only sanctioned data loss is the user deleting the
    campaign directory. (This retires the last hard delete in fold's storage — the cold-store
    pruner that sheds oldest rows under byte pressure, `cold-store.js:199-229`.)

R2. **Hot** = the ≤ `MAX_EVENTS` rows the existing ranking keeps (`pruneEvents`, unchanged),
    **recomputed** at hydrate and on ledger change — never persisted (no `tier` op, §4). Rule,
    not vibe: *a row leaves hot when the ranking says so; leaving hot changes which prompts it
    can be pinned into and nothing else.* Under the timeline this is forced, not just preferred:
    the hot set at seq `s` is derivable from the prefix ≤ `s`, so a persisted tier would be
    redundant at HEAD and wrong at every other `s`.

R3. **Cold** = every non-hot, non-tombstoned row. In memory, in full, with deltas. Recall by
    coverage (`cold-store.js:148-165`) reads this view unchanged; `MAX_COLD_ROWS = 2000`
    (`cold-store.js:41`) stops being a deletion threshold and becomes at most a recall-scan bound.

R4. **Deltas are never dropped, and the baseline is never fed.** `derive()` folds all live events
    (hot and cold), so demotion no longer rewinds balances. On a ledger campaign `carryForward`
    MUST NOT run and `state.baseline` MUST NOT be written — a provenance-free accumulator is a
    hole in the timeline (§1.4). The `baseline` option of `deriveState` stays supported only to
    read the seq-0 seed the importer writes for pre-existing chats (§9).

R5. **Metadata blob**: existing caps per table; the budget loop and pruner order
    (`store.js:38-40`) remain as backstop. A pruner firing post-migration is a defect signal —
    counted via `observe`, not silently absorbed.

R6. **Checkpoint** (`checkpoint.json`): derived, never authoritative, written server-side when
    > 4,096 ops have accrued since the last one. Contents: the materialized tables (raw keys), the
    covered `seq`, and a chained hash of the covered prefix. A chained-hash accumulator provably
    fingerprints the prefix (`chain_hash_identifies`,
    `../sanguine/proof/Closures/Engineering/SharedFold.lean:60-82`); on hash mismatch — or on any
    later `rewind` targeting below the covered seq (§4) — the checkpoint is discarded and the
    full log replayed, always available because of R1. Incremental checkpointing that never
    rewrites the covered prefix is the proved-safe shape if it is ever needed (`genEncode_append`,
    `../sanguine/proof/Substrate/Algebra/Security/GoldenStorage.lean:197-202`).
    **Not built in v1**: hydrating 5,000 lines is a one-time ~2 MB read+parse per chat load;
    checkpoints earn their keep around ~30k events (multi-year).

---

## 6. The timeline: restore anywhere, fork anywhere

Owner requirement, verbatim: *"a full timeline where we can go back to any point in a
conversation with the information restored, and fork from that point arbitrarily."* This section
is the spec for that. The substrate already implies it — state at any point is the fold of a
prefix, and `replay_append`
(`../sanguine/proof/Closures/Applied/AIOperationSurface.lean:142-145`) is exactly that statement
— so what follows is coordinates, three operations (view, rewind, fork), and the liveness
interaction.

### 6.1 Coordinates: mapping "a point in the conversation" to a point in the ledger

The ledger is op-indexed (`seq`); the request is message-indexed (`mid`). The join is the
envelope's `fmid` (§4):

```
restoreSeq(M) = max { x.seq : x ∈ effective sequence, x.fmid ≤ M }, or 0 if the set is empty
```

- Several ops sharing one message (a multi-event batch, `chronicle.js:308`; the batch's `hit`
  credits) share one `fmid` and land inside the same restore target. Ordering *within* a frontier
  is by `seq` — the timeline can also be cut mid-message if the UI ever wants to.
- A message whose pass produced no ops maps to the previous frontier's last `seq` — the max over
  a smaller set. The mapping is total; there are no unrepresentable points.
- **Ambiguity, stated:** after an in-place rewind (§6.2) the frontier revisits old indices, so
  "message 40" names more than one moment. `restoreSeq` is computed over the *effective*
  sequence (§4), in which rewound ops no longer exist — so it resolves to "the most recent time
  the conversation stood at M", which is the only reading consistent with what the chat file now
  contains.

**View (restore without fork) is a read, not a storage op.** `deriveAt(M)` = fold the effective
ops with `seq ≤ restoreSeq(M)`, then apply liveness against messages `0..M` under their current
swipe selections. Pure, synchronous, ~6.5 ms worst case (§2) — time-travel browsing costs one
derive per scrub position. Approximation, stated: swipe selections are as they stand *now*; the
ledger does not record which swipe was showing at a past moment, so a swipe changed since then is
viewed in its current position. (Recording swipe selection per op would close this; it is not in
v1 — §11.)

### 6.2 Rewind in place

When the user deletes messages back to M and keeps playing in the same chat, fold appends
`{op:'rewind', to: restoreSeq(M)}` on detecting the frontier regress — one new listener on ST's
message-deletion event beside the render/`CHAT_CHANGED` hooks fold already registers
(`index.js:1056-1069`), or equivalently a frontier check on the next write (`fmid` less than the
last acked `fmid`), which needs no new event at all. Prefer the frontier check: it is total,
including deletions that happened while fold was not loaded. Replay truncates the effective sequence (§4);
subsequent ops append after. This is the one thing content liveness could never do: always-live
user/world/verdict events recorded in the deleted span (`USER_ANCHOR`, `chronicle.js:37, 80-85,
389-488`) die with the span, because their ops leave the effective sequence. Nothing is deleted
on disk (R1); a rewind is itself a timeline event and the pre-rewind ops remain viewable by
scrubbing the raw sequence.

### 6.3 Fork

A fork is `manifest.parent = { campaign, forkSeq }`, copy-on-write, no bytes copied. Reads are
defined recursively:

```
hydrate(c)   = fold( effectiveSequence( rawPrefix(c.parent) ++ rawOps(c) ) )
rawPrefix(nil)    = ∅
rawPrefix({p, s}) = rawPrefix(p.parent) ++ [ raw lines of p with seq ≤ s ]
```

The effective sequence (§4 stage 1) runs over the *concatenated* stream, so a child `rewind` with
`to ≤ forkSeq` legally truncates into the inherited prefix — rewinding past the fork point inside
the child chat works, and only the child's view moves (its rewind line lives in its own file).

- **Composes to arbitrary depth**: `replay_append` splits the fold at every fork boundary, and
  induction over the ancestor chain does the rest; sharing the prefix is sound because a fold
  over a shared prefix is identical whatever follows (`prefix_fold_memo`,
  `../sanguine/proof/Closures/Engineering/SharedFold.lean:52-55`). The parent-linked identity is
  the same shape as song's content-addressed store (`../song/src/kernel/lake.slang:197-212`).
- **A fork is a true snapshot.** Parent lines with `seq ≤ forkSeq` are immutable (R1), and
  anything the parent does later — including a later parent `rewind` targeting below `forkSeq` —
  has `seq > forkSeq` and is outside the child's prefix. Parent history cannot reach into a
  child, in either direction.
- **What bounds the chain**: depth = number of ancestor forks; hydration cost = total effective
  ops along the chain, each ancestor read once. If chains ever get deep, **flatten** = the child
  materializes its inherited prefix into its own checkpoint (licensed by `replay_append`; safe
  because that prefix is immutable, so R6's rewind-invalidation cannot fire on it). Not built in
  v1.
- Each child assigns its own `seq` starting at `forkSeq + 1` in its own file; `(campaign, seq)`
  is globally unambiguous.

**Protocol with ST branching.** ST's branch/checkpoint copies the truncated chat plus the full
current metadata (`public/scripts/bookmarks.js:199,231` merged at `public/script.js:7351`), so a
fresh branch arrives carrying its parent's `campaign` and `chatId`. On the first fold write in a
chat whose `fold.chatId ≠` current file name:

- owner chat still exists (checkable via the listing `getExistingChatNames` uses,
  `public/scripts/bookmarks.js:214`) → **fork**, with
  `forkSeq = restoreSeq(child's last message index)` computed against the parent's timeline —
  **not** the parent's HEAD seq. This is the correction the timeline requirement forces: ST
  already truncated the chat to the branch point (`public/script.js:7366-7370`), and the ledger
  must cut at the same conversational moment, or every always-live op recorded after the branch
  message leaks into the child (§6.4 case i).
- owner chat gone → **rename**: adopt in place (update `fold.chatId`, append the name to
  `manifest.chats`). Same campaign.

"Fork from any point, arbitrarily" therefore needs no new chat machinery: ST branch at message M
(any M, any swipe — `createBranch` takes both, `public/scripts/bookmarks.js:186-243`) plus the
first-write protocol yields a campaign forked at `restoreSeq(M)`. A `/fold-fork [mid]` command is
sugar over `createBranch`. Fork triggers on first *write*, so opening an old copy read-only never
mints identities.

Why fork rather than branches sharing one log: content-keyed liveness hides the other branch's
*extracted* events but not the always-live class; under a shared log a world turn recorded in
branch A after the split would apply to branch B — the cross-branch contamination Scribe classed
as a correctness bug and fixed by tagging every artifact with the variant that produced it and
filtering reads
(`../legacy_archive/scribe/backend/migrations/2026-01-17-100000_add_message_variant_id_to_cognitive_tables/up.sql:2-11`,
read filter `../legacy_archive/scribe/backend/src/services/chronicle_service.rs:1038-1043`).

### 6.4 seq-truncation × content-keyed liveness: complementary, and who wins

Liveness is untouched: `liveEvents` filters hydrated events by `contentKey` against the messages
actually present (`chronicle.js:61-86, 371-377`); an event from an abandoned swipe is hydrated,
not live, and returns when the swipe does. The two mechanisms answer different questions:

- **`seq` defines EXISTENCE**: which ops are in this timeline at this point. Restore, rewind and
  fork move this boundary.
- **liveness defines VISIBILITY**: of the events that exist, which have their evidence on the
  branch currently being looked at. Swipe navigation moves this one.

Each covers a case the other cannot. Liveness distinguishes swipes of the *same* message — same
`mid`, same `fmid`, different content — where seq is blind. Seq removes always-live events from a
truncated timeline — where liveness is blind by design, since `USER_ANCHOR` rows are live on
every branch (`chronicle.js:80-85`).

**They can disagree, in exactly two cases, and existence wins both:**

1. **Always-live ops past the cut.** A world move recorded after message M is live under
   `liveHashes` (anchored `usr`) but has `seq > restoreSeq(M)`. Liveness says visible; the
   timeline says it does not exist yet. Timeline wins: at M, that op had not happened.
2. **Duplicate content across the cut.** `contentKey` is deliberately a content hash
   (`chronicle.js:52-58`), so a post-cut event whose anchor text is byte-identical to some
   pre-cut message ("Yes.", a regenerated identical reply) reads as live in the truncated chat.
   Liveness says visible; the timeline says it was extracted from a message that is not in this
   past. Timeline wins.

**Rule: existence is evaluated first; liveness filters within the existing set.** Concretely:
every read that today starts from `loadEvents()` starts from the effective prefix ≤ the current
timeline point instead, and *then* applies `liveHashes`. The order cannot be reversed: liveness
asks a question that presupposes the event is in the timeline at all, and evaluating it first
resurrects ops from a future the restored timeline never had. The converse composition is the
normal case and shows they are complementary, not redundant: a pre-fork event whose anchor the
child later swipes away exists in both timelines, stays visible in the parent, goes invisible in
the child, and returns if the child swipes back — today's behavior (`chronicle.js:69-73`),
preserved verbatim. For plain extracted events under ST's truncated branch chats the two are
*nearly* redundant — post-branch anchors are not in the child's messages — which is why today's
fold works at all; "nearly" breaks on exactly the two cases above, and before `seq` existed
neither had a correct answer.

### 6.5 What restore is exact for, and what is carried

Exact at every seq: everything event-sourced — chronicle rows, derived inventory/vitals/marks,
and thread closures, which ride live events (`threadClosures`, `chronicle.js:546-548`). Carried,
not restored, in v1: the probe-maintained metadata tables (cast, thread table rows, clock,
coverage, observed) ride the chat-file copy, which ST takes from HEAD metadata at branch-creation
time (`public/scripts/bookmarks.js:231` + `public/script.js:7351`) — a fork from an old point
gets cast/clock as of *now*, not as of M. v1 marks these rows as carried (panel affordance) and
lets the probes re-heal them over subsequent passes; stage 2's `put`/`del` ops (§4) event-source
those tables and close the gap, at which point `chat_metadata.fold` shrinks to
`{v, campaign, chatId, cursor}`.

---

## 7. Recovery and integrity

**Torn append / crash mid-save.** Appends go through one per-campaign promise queue in the single
Node process, one `write()` per line. A torn write can only damage the final line; hydration
parses line-by-line, skips an unparseable tail, and reports the count (the fold-trace reader
already tolerates this shape, `src/endpoints/fold-trace.js:58-67`). The corpus is explicit that
decode-accepts-what-encode-never-wrote is the unproved region of any serialization
(`../sanguine/proof/Substrate/SeedCore.lean:48-53`) and that it owns no durability results at all
(`../sanguine/theory/THE_ONTOLOGY_ECOSYSTEM.md:81-82`) — so detection is fold's own framing:
JSONL line atomicity + the seq chain. A gap in `seq` on hydrate = lost middle (should be
impossible under the queue; loudly reported); tail loss = client cursor ahead of log tail.
`fold.cursor` (highest acked seq, debounce-written into metadata) is the cheap detector.
`manifest.json` and `checkpoint.json` are whole-file atomic rewrites via the same
`write-file-atomic` ST already uses everywhere (`src/util.js:1491-1498`,
`src/endpoints/fold-trace.js:23`).

**Crash between the two stores.** A chat save and a ledger append are separate writes; no
cross-store transaction exists. Both orders are survivable and stated:
- event landed, message did not → the event's source key never appears in any live message →
  permanently not-live → invisible. Liveness self-heals this; the row is inert, not wrong.
- message landed, append lost → one extraction missing; visible as cursor/turn disagreement; the
  re-extraction machinery (`/fold-replay`, `store.js:293-341`) already covers rebuilds.

**Retry duplication.** Client retries an unacked append with the same `opId`; replay dedupes on
`opId` (Set-face membership — idempotence by construction). This closes the two non-idempotent
cases, `hit` increments and `rewind` (a doubled rewind with a fresh opId would truncate again —
harmlessly, to the same `to`, but the dedup makes it a non-question).

**Two tabs, one chat.** Today the fold blob is whole-blob last-writer-wins, and ST's integrity
check cannot catch it — both tabs load the same persistent slug
(`public/script.js:7610-7611`; comparison `src/endpoints/chats.js:333-334`), so the second save
silently destroys the first tab's chronicle writes. Under the ledger, both tabs' appends land and
interleave; replay converges because event identity is per-key and order is total by `seq`.
Remaining anomalies, stated: `hit` counts from both tabs both count (harmless); each tab's
in-memory view is stale w.r.t. the other until reload (equal to today); the *metadata* tables keep
today's last-writer-wins. Net: strictly better, not fully solved.

**Server unreachable.** Appends queue in memory and retry with backoff; the panel shows a
non-silent "N unsaved ledger ops" indicator (the trace's silent-false pattern,
`trace.js:108-111`, is right for evidence and wrong for state). If the tab dies with the queue
non-empty, those ops are lost — the same blast radius as a failed `saveMetadataDebounced` today,
but now visible before it happens. Note ST is unusable without its server anyway (every chat save
is a POST, `public/script.js:7392`), so this is not a new dependency class.

---

## 8. The read path's latency budget

`derive()` stays synchronous. The budget, from §2's measurements:

| stage | when | cost at year scale | mitigation |
|---|---|---|---|
| hydrate (GET + parse + replay into Maps) | once per chat switch | ~2 MB, tens of ms, off the render path | async at `CHAT_CHANGED`; panel shows "hydrating" until resolved — **the one new async boundary**. Today the blob arrives with the chat load itself (`public/script.js:7598-7602`), so this is a real, visible change; it buys the removal of the per-commit full-chat rewrite. |
| timeline scrub (`deriveAt`, §6.1) | per scrub position, on demand | one derive ≈ 6.5 ms + one liveness pass over `0..M` | pure read over the already-hydrated ledger; no I/O |
| `liveHashes` | per derive/snapshot call | 3.6 ms | cache keyed on a liveness revision bumped by the message events fold already hooks (`index.js:1056-1069`); today it re-hashes every message on every call (`chronicle.js:74-86`) with no cache — this becomes worth fixing at year scale independent of storage |
| `deriveState` over all live events | per render, on cache miss | 1.3–6.5 ms | memo keyed on `(ledgerRev, livenessRev, answersRev)`. Invalidation is exactly: a ledger op landed; the chat's message set / swipe changed; an identity verdict landed. The memo key must close over *every* input the fold reads — the corpus makes that an iff, not advice (`memo_key_closure`, `../sanguine/proof/Closures/Engineering/SharedFold.lean:88-91`). The shipped no-cache stance (`state.js:690-693`) is correct at 300 events and stops being free at 8,000. |
| per-write cost | per commit | ~300 B POST, O(1) append | replaces stringify-the-blob (`store.js:218-224`) + whole-chat rewrite per chronicle commit |

Between invalidations, renders read the memo at zero cost. Worst-case synchronous recompute
(~10 ms at year five) is inside a frame budget miss but not a stall; if it ever matters, R6's
checkpoint shape extends to derived state — but a *state* checkpoint is only valid per
answers-table version (§4's raw-keys rule), which is why it is deferred, not designed in.

**The hydration bar (owner's Q2 answer): "faster than the current panel", not sub-100 ms.**
Checked against what actually paces the panel today: the "pending"/"behind" chips are the
*extraction lifecycle* rendered from the persisted `state.sync` record (`panel.js:502-511`) —
`acknowledged` is an intentional resting state that persists for the whole interval cadence
(`panel.js:523-530`), a healthy `syncing` is bounded by the extraction timeout, and the staleness
tripwire is 150 s (`panel.js:539`). The panel's slowest-updating information is therefore gated
on LLM passes measured in seconds-to-minutes; hydration is one local read of ~2 MB worst-case,
tens of milliseconds. Hydration beats the current cadence by two to three orders of magnitude
and will not be the pacing item; the headline-snapshot mitigation stays cut.

---

## 9. Implementation order, and the importer that falls out

1. `src/endpoints/fold-ledger.js` — append (queued, seq-assigning, opId-dedup), read-all,
   manifest read/write. ~150 lines; the fold-trace router is the template. (In progress by the
   coordinator, per the rev-2 handoff.)
2. `ledger.js` client module — hydrate-on-`CHAT_CHANGED` (recursive over `manifest.parent`),
   effective-sequence replay, in-memory Maps, write-behind queue, cursor, `fmid` stamping.
   `chronicle.js` swaps `loadTable/commit` for it; `cold-store.js` shrinks to the coverage-recall
   view; `demoteEvents` keeps `d` and stops persisting anything (R2: hot set recomputed).
   `carryForward` gated off for ledger campaigns (§1.4).
3. Timeline operations: `restoreSeq`/`deriveAt` (§6.1), rewind detection + append (§6.2),
   fork/adopt protocol with `forkSeq = restoreSeq(branch point)` (§6.3), `/fold-fork` sugar.
4. Retire the chronicle/cold pruners; keep the metadata backstop; add the derive memo.
5. Tests, in `tests/` per `AGENTS.md:113-115`: torn-tail hydrate; opId dedup (incl. doubled
   rewind); (t,seq) fold determinism; `restoreSeq` totality (empty passes, multi-op frontiers,
   post-rewind frontier regress); rewind masking vs checkpoint invalidation (R6); fork snapshot
   isolation (later parent rewind below forkSeq does not reach the child); the two §6.4
   disagreement cases resolving to existence-first.

Importer (nice-to-have, ~30 lines inside step 2): on first write to a chat whose blob has
`chronicle.events` but no `campaign`, append every stored event row (and each `state.cold` event
row, `cold-store.js:116-126`) as `ev` ops, and the blob's `baseline` (`state.js:720-722`) as the
**pre-timeline seed** — one synthetic always-live event pinned at seq 0 / `fmid 0` whose delta
carries the accumulated quantities (§1.4) — then strip the migrated keys from the blob. Raw keys
throughout; verdicts stay in `state.answers` and keep applying at read. Reversible trivially
because the source blob is untouched until the strip, and the strip is the same staged-retirement
pattern `migrate.js` already uses (`store.js:95-115`). Consequence, stated: for imported chats
the timeline starts at the import point — every earlier restore target reads the seed's totals,
because the provenance `carryForward` destroyed cannot be reinvented.

---

## 10. What this does NOT solve

- **Prompt budget.** What fits in the model's context is untouched; the hot set and its ranking
  still decide what gets pinned. This design only guarantees the *ledger* stops forgetting.
- **Exact time travel for the probe-maintained tables in v1.** Cast, thread rows, clock,
  coverage, observed are carried from HEAD on fork, not restored to the fork point (§6.5); exact
  restoration waits on stage 2's `put`/`del` ops.
- **Past swipe positions.** `deriveAt` views history under *current* swipe selections (§6.1); the
  ledger does not record which swipe was showing at a past moment.
- **Live cross-tab coherence.** Two tabs converge on disk but not on screen until reload.
- **Extraction quality and re-extraction.** A lost or never-run extraction is still lost; the
  ledger preserves what was extracted, not what should have been.
- **Replayability of the LLM itself.** Replay is pure over recorded outputs; the corpus's
  condition for replaying a *program* (`replay_quotient_sound` — the step must depend on nothing
  but the class) is deliberately not engineered; the trace (`trace.js`) keeps the prompt→output
  pairs instead.
- **Diagnostics log growth** (`state.log`, 36 KiB on Wuxia) stays metadata-bound under
  `PRUNE_DIAGNOSTICS`; moving it out is cheap later but is not state and not this design.
- **Encryption at rest.** SCRIBE-PORT's deferral stands (`SCRIBE-PORT.md:524-536`); Scribe's own
  per-field crypto bought silent plaintext-fallback bugs
  (`../legacy_archive/scribe/backend/src/models/chronicle_event.rs:93-115`).
- **Group chats**: `getCurrentChatId` returns a group chat id (`public/script.js:540-546`) and the
  campaign mechanism should carry over, but group metadata save is a different path
  (`public/scripts/group-chats.js:276-278`) and is untested here. Unknown, stated as such.

## 11. Open questions for the owner

(Rev 1's three questions are answered and folded in: Q1 → §6 is now the timeline spec; Q2 → §8's
hydration bar; Q3 → `tier` cut, §4/§5 R2.)

1. **Should the ledger record the showing swipe?** One envelope field (`swipe` beside `fmid`)
   would make `deriveAt` exact under swipe changes instead of approximating with current
   selections (§6.1). Cheap now, a format addition later. My recommendation: add the field now,
   leave the read-side exactness for later — recording is cheap, reconstruction is not.
2. **Stage 2 priority — event-sourcing the probe tables** (`put`/`del`, §4): how much does he
   care that a fork's cast/clock arrive carried-from-HEAD rather than restored (§6.5)? If the
   answer is "a lot", stage 2 moves ahead of the derive memo in §9's ordering. Evidence that
   settles it: whether carried cast rows visibly mislead him in the first forked campaign.
3. **Flatten threshold** (§6.3): fork chains are unbounded by design; at what ancestor depth or
   hydration cost should a child auto-flatten its inherited prefix into a checkpoint? Default
   proposal: never automatic in v1, manual `/fold-flatten`, revisit with real fork usage.

## 12. What I read

- fold: `store.js`, `chronicle.js`, `cold-store.js`, `trace.js`, `state.js` (derive/baseline/
  carryForward), heads of `state-table.js`/`chronicle-table.js`, `harvest.js` head, `index.js`
  event hooks, `panel.js:496-540` (the sync-chip lifecycle, for §8's hydration bar) — all under
  `public/scripts/extensions/fold/`.
- ST core: `public/script.js` (getCurrentChatId, saveChat, chat load, integrity, saveMetadata),
  `public/scripts/extensions.js` (saveMetadataDebounced), `public/scripts/bookmarks.js`
  (createBranch/createNewBookmark), `src/endpoints/chats.js` (save/integrity/rename/delete),
  `src/endpoints/fold-trace.js`, `src/server-startup.js:148`, `src/util.js:1491-1498`,
  `AGENTS.md`, `SCRIBE-PORT.md` (all 683 lines).
- Measurements: my scripts in the session scratchpad (`measure.mjs`, `bench.mjs`, `hashbench.mjs`)
  over `data/default-user/chats/*` read-only; `deriveState` imported from the shipped
  `state-table.js`.
- `../legacy_archive/scribe`: via a cited survey of `AGENTS.md`, `docs/` (CONCEPT,
  agent_memory_architecture, ENCRYPTION_ARCHITECTURE, MESSAGE_VARIANT_DESIGN, agents/architecture),
  `backend/migrations/*` (chronicle, variants, cognitive, simplify, cascade fixes),
  `backend/src/{models,services,db,vector_db}` storage paths; load-bearing lines spot-verified
  directly (`game_state_service.rs:116-130, 268-285`, `chronicle_service.rs:1038-1043`,
  `simplify_chronicle_events/up.sql:1-20`).
- `../sanguine`: via a cited survey of `proof/Scribe.lean`, `theory/THE_SCRIBE.md`,
  `HashTrinityCore/KeyResolution/IncrementalResolution/OntologyClosure/SharedFold/
  AIOperationSurface/GoldenStorage/SeedCore/StructuralFriction`, `THE_ONTOLOGY_ECOSYSTEM.md`;
  load-bearing theorems spot-verified directly (`replay_append`, `relabelInc_const`,
  `incremental_resolution_breaks_the_split`, `merge_B_order_matters`, `merge_max_converges`,
  `prefix_fold_memo`, `chain_hash_identifies`, `memo_key_closure`, ecosystem gap `:81-82`).
- `../song`: via a cited survey — relevant only as design precedent: `lake.slang`
  (parent-linked versions, commit-refuses-partial `:187-195`), `bridge.slang` (validated
  append-only log, replay as left fold `:68-81`); it ships no durability primitives itself.
