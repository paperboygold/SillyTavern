# SCRIBE → SILLYTAVERN PORT CATALOGUE

What is worth lifting out of `../legacy_archive/scribe` (Rust/Axum + SvelteKit, "a fast reactive
alternative to SillyTavern"), and what shape it takes once it is re-expressed on the basis that came
out of Scribe: **hashtrinity** (`../fold/hashtrinity`, JS mirror `../sanguinehost.com/public/hash.js`)
and the **fold** mechanism vocabulary (`../fold/INDEX.md`).

Survey date 2026-08-06. Scribe backend `backend/src` ≈ 21 service modules / 21 route modules;
frontend SvelteKit. SillyTavern at `release` @ `8172dcd0e`.

---

## 0. The basis, and what it buys us

`hash.js` is 87 lines, zero deps, already ESM — it drops into ST's frontend unchanged. It says:

> There is ONE data structure (the `K → V` table) and ONE operation, `insert_with(m, f, k, v)`.
> The merge `f` is the only freedom.

| face | merge | absent reads as | what it is |
|---|---|---|---|
| Set | `merge_nb` (idempotent) | `false` | membership · dedup · occupancy |
| Map | `merge_b` (last write) | `undefined` | lookup · the value · the seed |
| Count | `merge_bu` (`+`) / `merge_acc` (`{sum,n}`) | `0` | scoring · counting · the field |
| Graph | `merge_graph` (`++`) | `[]` | adjacency · the ledger |

This is not decoration. Two of the biggest design decisions below fall straight out of it:

- **ST's summarize extension is the Map face.** `mes.extra.memory` +
  `getLatestMemoryFromChat()` (`public/scripts/extensions/memory/index.js:357`) walks backwards and
  returns the *first* summary it finds. Last write wins; everything older is unreachable.
- **Scribe's Chronicle is the Graph face.** Every significant event is appended under the chronicle
  key and retrieved by relevance, not by recency.

Same table, different merge. That single substitution *is* the port — items 2, 3 and 4 below are
consequences of it. Everything else in this catalogue is named by its merge so the port lands as one
structure rather than eleven bespoke ones.

**fold column.** Where a Scribe mechanism already has a name in `../fold`, it is given, because the
Rust side is the reference implementation and we should not invent a second vocabulary:
`absorb` (ingest into the store), `recall_spans_keyed` / `recall_votes` (keyed multi-strategy read),
`resonance_*` (scoring), `spinor_bias` (order/recency-aware bias on evidence),
`SERVEFOLD_TTL_SURPRISE` (surprise-gated retention), `CountLM` (train-by-counting, exact unlearn).

---

## 0.5 Agreed scope — four pillars

Narrowed 2026-08-06. Four things matter; everything else in this catalogue is optional surface.

| pillar | section | face / merge | status |
|---|---|---|---|
| **A. Recall** | §2 | Accumulator (`merge_acc`) — RRF | **BUILT** |
| **B. Character status & inventory** | §12, narrowed | Count + Map | **BUILT** — as a fold over the chronicle, not a table beside it |
| **C. Directed retry / variant steering** | §18 (new) | Graph (`merge_graph`) on `swipe_info` | **BUILT** — not a Scribe port; ST core had the plumbing, unwired |
| **D. Chronicle** | §3 (+ §4 dedup, §9 branch-awareness) | Graph (`merge_graph`) | **BUILT** — the thesis |

Two findings changed the plan:

1. **Pillar C is ~90% already in ST core, and it is dead code.** `Generate('regenerate', …)`
   already accepts a steering instruction via `buildOrFillAdditionalArgs` (`public/script.js:11527`),
   which forwards `customData.additionalPrompt` as `quiet_prompt` with `quietToLoud: true` — wired to
   `option_regenerate` (:11578), `option_impersonate` (:11584) and `option_continue` (:11598).
   Nothing in the shipped codebase ever passes `additionalPrompt`; a grep across `public/` returns
   zero callers. The generation path works today. What is missing is a UI affordance, a slash
   command, and persistence of the direction. See §18.
2. **Scribe cannot help with pillar C.** Its `message_variants.rs` is plain swipes —
   `get`/`create`/`select`/`delete` by index, no direction, no guidance field. This one is a build,
   not a port. Scribe's contribution to variants is elsewhere: making *memory* variant-aware (§9).

Pillars A and D are one system — A is useless without something to recall *from*, D is useless
without fusion to surface it. Build them together. B and C are independent and can proceed in
parallel or be dropped without affecting A/D.

### What building C and D actually taught us

Read this before starting A or B; each item cost real debugging time.

- **OpenAI strict structured output requires `additionalProperties: false` on *every* object in
  the schema, not just the root**, and every property in `required`. A probe fragment that omits
  it fails the whole shared extraction call with a 400 — taking the other probes down with it.
  This is the single most likely way the state probe breaks on first run.
- **Ask SillyTavern for the raw text, not its pre-parsed JSON.** `generateRaw` with
  `jsonSchema.returnInvalid: false` replaces anything ST cannot parse with the string `"{}"`,
  discarding fenced blocks and preambled objects that are perfectly recoverable. fold sets
  `returnInvalid: true` and runs `json-parse.js` over the raw text instead.
- **Gemini 2.5 Flash returns an empty reply if the token budget is small** — it spends the whole
  allowance on thinking tokens before emitting text. Set `reasoning_effort: 'min'` and a generous
  `responseLength`, or extraction silently yields nothing.
- **Models return multi-word keywords** ("silver coins"). Queries are tokenized into single words,
  so the keyword index must index by *token*, or every multi-word keyword is permanently
  unreachable. Found only by testing against a real model.
- **Liveness must follow the event's source key, not its table key.** A batch of several events
  from one message needs distinct table keys but shares one content hash; judging liveness by the
  table key made every multi-event batch invisible the moment it was written.
- **`merge_nb` is `nu || old` — idempotent only for booleans.** Using it to store a non-boolean
  (an event key, a label) silently gives last-write-wins, not first. It is the *membership* merge;
  if the value is not `true`, the Set face is the wrong face. This killed one function outright.
- **The extraction pass is a second request.** Any test asserting on "the last prompt the model
  saw" must either disable the interval or account for the extraction call landing after the
  reply. Marinara Engine avoids this entirely by having the roleplay model emit inline DSL tags
  (`[bg:]`, `[state:]`, speaker, expression) in its own reply — one call per turn, parsed
  server-side. See §19 for why that transport is attractive and what it costs.
- **A greedy `/\{[\s\S]*\}/` is not good enough to find JSON in prose.** It spans from the first
  brace to the LAST one anywhere in the reply, so an object followed by an emoticon — or two
  objects in one reply — both produce invalid JSON and abandon a cycle that had usable output in
  it. Replaced with a brace-depth scan that tracks string and escape state.
- **Truncated is not the same failure as garbage.** A reply cut off mid-structure means the model
  ran out of budget and is worth one retry at a larger allowance; prose refusing the task is not.
  Without the distinction both read as "no usable JSON" and the only available response is to give
  up. `looksTruncated` separates them and `runExtraction` retries once on the first.
- **Extraction runs on its own connection profile, not the chat model.** It is mechanical
  summarization; putting it on whatever large model the user picked for roleplay is a waste.
  `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, custom,
  overridePayload)` is the mechanism, with `{ json_schema }` in the override payload and
  `includePreset: false` so a roleplay preset's temperature does not fight structured output.
  Note the two paths return different shapes — `generateRaw` gives a string, a profile request
  with a schema gives already-parsed content — which is what `coerceExtraction` normalizes.
- **World Info activates AFTER generation interceptors.** Interceptors run at `script.js:4505`;
  `WORLD_INFO_ACTIVATED` fires around `:4576`. A block written in the interceptor is therefore
  selected against last turn's activation set. fold keeps the retrieval plan and re-runs only the
  selection step when the event fires — retrieval and scoring are already done, so this costs
  nothing and does not repeat the vector query. Anything writing an extension prompt that depends
  on what World Info contributed has this same problem.
- **Writing the block twice means counting retrieval hits twice.** The interceptor writes it, then
  the World Info handler rewrites it. Hits feed eviction, so double-counting inflates precisely
  the signal that decides what survives. fold tracks which keys were credited per generation.
- **An anchor links a summary to its source message, not summaries to each other.** One extraction
  pass routinely yields several events from one turn, all sharing an anchor. Suppressing them
  against each other silently drops real information; only summary-vs-raw-message is redundant.
- **`custom-request.js` did not apply OpenAI's `max_completion_tokens` quirk.** `openai.js`
  rewrites `max_tokens` for `o1/o3/o4` and `gpt-5*` on the main chat path, but
  `ChatCompletionService.createRequestData` did not — so *any* connection profile pointing at a
  reasoning-style model failed with "Unsupported parameter: 'max_tokens'". Fixed in
  `custom-request.js#applyModelParameterQuirks`; this affected the Connection Manager's own test
  message too, not just fold.

---

## 1. What SillyTavern already has — do not re-port

Checked, present, and in most cases *better* than Scribe's:

| capability | ST location | verdict |
|---|---|---|
| V2/V3 character cards, PNG/CHARX/BYAF | `src/character-card-parser.js`, `charx.js`, `byaf.js` | ST wins |
| Lorebook / World Info with keyword scan, recursion, sticky/cooldown/delay timed effects, probability, budget | `public/scripts/world-info.js` (6289 ln) | ST wins decisively — Scribe has no timed effects |
| Vector RAG w/ 12 embedding backends, chunking, Data Bank, file ingest | `public/scripts/extensions/vectors/` + `src/vectors/` | ST wins on backends, loses on fusion (§2) |
| Tokenizers, local + remote | `src/tokenizers.js`, `src/endpoints/tokenizers.js` | ST wins → skip Scribe's `hybrid_token_counter.rs` |
| Personas | `public/scripts/personas.js` | parity |
| Prompt/context templates, instruct mode, presets | `PromptManager.js`, `instruct-mode.js`, `preset-manager.js` | ST wins → skip `prompt_templates.rs`, `template_preference_service.rs` (45k ln combined) |
| Swipes | core | partial — see §9, memory is not swipe-aware in either |
| Author's Note, quick replies, regex, extensions/plugins | various | ST wins |

**Never port:** `routes/payment.rs` (174k ln), `routes/auth.rs` (69k), email/verification, Diesel
schemas (3 × ~35k ln), Qdrant/LanceDB clients, `mistralrs_adapter.rs`, the Tauri desktop shell, the
compliance docs. All of it is Scribe-as-a-SaaS, not Scribe-as-an-idea.

---

## 2. ⭐ Hybrid recall with Reciprocal Rank Fusion

**Scribe:** `services/cognitive/recall.rs` (517 ln), `services/embeddings/retrieval.rs`.
Multi-strategy retrieval — semantic (vector), keyword, entity graph — fused via RRF, per
`docs/agent_memory_architecture.md`.

**ST today:** the strategies exist but **never meet**. World Info does keyword scanning and injects
at its own depth; the vectors extension does a similarity query and injects at *its* depth
(`rearrangeChat`, `index.js:776`); the summarize extension injects a third block. Three independent
budgets, three independent injections, no cross-ranking, guaranteed duplication when the same fact
is in a lorebook entry *and* the vector store. `grep -ri "RRF\|reciprocal"` over `public/` and
`src/` returns nothing.

**Port:** one `recall(query, strategies[])` that runs the existing retrievers, fuses their ranked
lists, dedups, and returns a single ordered evidence list for one budget.

**Hashtrinity form — RRF *is* the Count face, exactly:**

```js
import { insert_with, merge_bu, merge_nb, table_entries } from './hash.js';
const K = 60;
const fuse = (rankedLists) => {
  const score = new Map();                                   // Count face
  for (const list of rankedLists)
    list.forEach((id, r) => insert_with(score, merge_bu, id, 1 / (K + r + 1)));
  return table_entries(score).sort((a, b) => b[1] - a[1]);
};
```

Cross-strategy dedup is `merge_nb` on the content hash. Per-source provenance ("this came from WI
*and* vectors") is `merge_graph` on the same key. Three merges, one table, ~40 lines.
**fold:** `recall_spans_keyed` + `recall_votes`; recency weighting is `spinor_bias`.

**Lands:** new `public/scripts/extensions/fold/recall.js`, consumed by the vectors extension's
`rearrangeChat` and by WI's activation pass.
**Effort:** small (~200 ln). **Risk:** low — additive, can run shadow-mode and log deltas first.
**This is the highest value-to-effort item in the catalogue.**

---

## 3. ⭐ Chronicle — the event ledger

**Scribe:** `services/chronicle_service.rs` (90k ln, mostly CRUD/encryption),
`models/chronicle_event.rs`, `routes/chronicles.rs`. The *design* is in
`docs/SIMPLIFIED_AGENT_DESIGN.md` and is deliberately tiny — they explicitly threw away an 8-field
ontology (actors/causality/valence) for:

```rust
ChronicleEvent { summary: String, keywords: Vec<String>, timestamp, event_type, source, chat_session_id, message_variant_id }
```

`EventSource` includes a `GameApi` variant so an external game can append events.

**ST today:** nothing comparable. The summarize extension is destructive by construction (§0).

**Port:** an append-only per-chat/per-character event ledger stored in chat metadata (or
`data/<user>/chronicles/`), with a keyword index, and wired as a retrieval source into §2.

**Hashtrinity form — one ledger, three derived indices, four merges:**

```js
insert_with(events,  merge_graph, chronicleId, [event]);        // Graph — the ledger, append-only
insert_with(byKw,    merge_graph, keyword,     [event.id]);     // Graph — the keyword index
insert_with(seen,    merge_nb,    contentHash, true);           // Set   — dedup on write (§4)
insert_with(latest,  merge_b,     chronicleId, event);          // Map   — the "current state" read
```

Note the last line: ST's existing summarize behaviour is recoverable as *one read* off the same
table. The port is strictly a superset — nothing regresses.
**fold:** `absorb`.

**Lands:** `public/scripts/extensions/fold/chronicle.js` + a `chronicles` slash command; optionally
`src/endpoints/chronicles.js` for server-side persistence.
**Effort:** medium (~600 ln + UI). **Risk:** low. **Depends on:** §2 to be useful.

---

## 4. Deduplication on write and on read

**Scribe:** `services/chronicle_deduplication_service.rs` (467 ln) — `DeduplicationConfig`,
`DuplicateDetectionResult`, semantic + keyword-overlap near-duplicate detection. Plus dedup-on-read
in `recall.rs`: opinions are grouped by `perspective_hash` and only the latest survives.

**ST today:** none. Re-summarizing the same stretch of chat produces near-identical vector entries
that then compete for the same budget.

**Hashtrinity form:** exact dedup is `merge_nb` on a content hash (the Set face — this is what
`FreqMap` is in the Rust crate: keeps no key, 2⁻⁶⁴ false positives, purpose-built for dedup at
scale). Near-dup scoring is `merge_bu` over shared keywords. Dedup-on-read is `merge_b` keyed by a
perspective hash — verbatim the pattern at `recall.rs:120-140`.

**Effort:** small (~150 ln), largely free once §3 exists. **Risk:** low.

---

## 5. ⭐ Surprise-gated retention

**Scribe:** `docs/agent_memory_architecture.md` §2.2 — a two-stage loop. Stage 1 extracts 2–5 facts
per turn and computes a **surprise score** against the current Core Memory; Stage 2 (the expensive
reflect/reconcile call) fires **only** when surprise > ~0.7. `narrative_intelligence_service.rs:614
should_process_session` is the gate. Lineage: TITANS test-time memorization + MIRAS Huber-style
coping for outliers.

**ST today:** the summarize extension fires on a fixed message interval or word count
(`onPromptIntervalAutoClick`, `promptWords`). It summarizes ten turns of "…" with the same
enthusiasm as a plot twist, at the same token cost.

**Port:** replace interval-triggering with a surprise gate. Cheap version needs no extra LLM call —
score the new turn against the current memory with keyword/embedding divergence and only escalate to
a generation call above threshold.

**Hashtrinity form:** Core Memory is the Map face (one key, `merge_b` — "the seed" in hash.js's own
words). Surprise is a read of the new turn against the Count face accumulated so far.
**fold:** this is `SERVEFOLD_TTL_SURPRISE` — fold's server already has surprise-gated retention on
its TTL path, so the Rust reference behaviour exists and can be A/B'd against the JS port.

**Effort:** small (~150 ln) as a patch to the existing memory extension. **Risk:** low, opt-in flag.
**Payoff:** directly cuts summarization API spend and stops memory drift on filler turns.

---

## 6. Unified context budget with priority scoring

**Scribe:** `services/rag_budget_manager.rs` (397 ln) — `ContextBudgetPlanner::new_for_model`,
`ContentPriority::calculate(chunk, query_timestamp)` (recency × similarity), `DynamicRagSelector`,
`is_approaching_threshold`. Plus middle-out strategic truncation in `prompt_builder.rs`: head
(system/character/persona) and tail (recent turns) protected, middle truncated first — justified by
"lost in the middle" attention behaviour. Documented in `docs/CONTEXT_MANAGEMENT_ARCHITECTURE.md`
(200k total / 150k history / 50k RAG, with RAG budget = `min(rag_budget, total − actual_history)`).

**ST today:** WI has a budget %, vectors has `insert`/`query`/`protect` counts, memory has its own
depth — but **no single authority** and no priority scoring. Whoever injects last wins the tail.

**Port:** one budget planner over all injection sources, allocating by `ContentPriority`, with
dynamic reallocation of unused history budget to retrieval.

**Hashtrinity form:** source → tokens is the Count face; selection is a knapsack over it. `merge_acc`
({sum, n}) gives per-source running means for the "approaching threshold" telemetry.

**Effort:** medium (~400 ln) — touches the prompt assembly path, which is the riskiest area in ST.
**Risk:** medium. **Sequence after** §2 (fusion makes a shared budget meaningful).

---

## 7. Agentic enrichment loop + tool registry

**Scribe:** `services/agentic/` — `agent_runner.rs` (1714 ln), `context_enrichment_agent.rs`
(1322 ln), `narrative_tools.rs` (2942 ln), `registry.rs` (54 ln), `factory.rs`, `persona_context.rs`.
Seven tools: `CreateChronicleEventTool`, `AnalyzeTextSignificanceTool`, `CreateLorebookEntryTool`,
`CreateBatchLorebookEntriesTool`, `UpdateLorebookEntryTool`, `AnalyzeLorebookTool`,
`SearchKnowledgeBaseTool`, `QueryRulesTool`. Runs **after** the response, off the critical path
(+1–3 s async, never blocking the reply).

**ST today:** has function-calling for chat-completion backends and STscript, but no background
post-turn agent.

**Port:** a narrow runner — post-response, opt-in per chat, with 4 of the 8 tools
(`analyze_significance`, `create_chronicle_event`, `create_lorebook_entry`, `search_knowledge_base`).
Resist the other 4 until the first four earn their keep; Scribe's own docs record that they already
deleted a 7000-line perception agent for exactly this reason.

**Hashtrinity form:** the tool registry is the Map face keyed by tool name — `registry.rs` is 54
lines and becomes ~15 in JS on `insert_with(tools, merge_b, name, tool)`.

**Effort:** large (~1000 ln + UI). **Risk:** medium (API spend, user trust in background writes —
must be visibly opt-in with a review queue). **Depends on:** §3, §5.

---

## 8. Auto-lorebook extraction from chat

**Scribe:** `services/lorebook/chat_extraction.rs` (`extract_entries_from_chat`), plus the batch and
analyze tools above. Detects new world-building elements mid-conversation and writes lorebook
entries with keywords.

**ST today:** World Info entries are created by hand, one at a time. This is the single most
frequently hand-rolled workflow in the ST community (people paste chats into a separate LLM tab and
copy entries back).

**Port:** highly self-contained — prompt + JSON schema + write into ST's existing WI format. Can
ship *before* §7 as a manual "extract lorebook entries from this chat" button, no agent required.

**Hashtrinity form:** ST's WI is already the Graph face — `key[]` → entry `uid`. The port just names
it and reuses the same index for §2's keyword strategy.

**Effort:** medium (~400 ln). **Risk:** low if gated behind a review-before-commit dialog.
**Second-best value-to-effort item after §2.**

---

## 9. Branch-aware memory (`active_variant_id`)

**Scribe:** `services/chat/message_variants.rs` (36k ln); crucially, `active_variant_id` is threaded
all the way into retrieval — `recall_context(..., active_variant_id)` filters facts and opinions to
the live branch (`recall.rs:33`).

**ST today:** swipes exist; memory does not know about them. Vector entries and summaries created
under swipe A stay retrievable after you swipe to B, quietly contaminating a branch you abandoned.
This is a real, currently-unfixed correctness bug class in ST's memory story, not a feature request.

**Port:** tag every chronicle event / vector entry with the `(message_id, swipe_id)` that produced
it; filter on read.

**Hashtrinity form:** Graph face keyed by variant id; the read is a Set-face membership test against
the active branch's ancestry.

**Effort:** small-medium (~250 ln), but touches §2/§3 storage schema — **decide this before
shipping §3**, retrofitting is worse.

---

## 10. Metric-aware chunking

**Scribe:** `text_processing/chunking.rs` (1990 ln) — `ChunkConfig`, `ChunkingMetric` (words / chars
/ tokens), overlap, boundary preservation, `chunk_messages` for conversational input.

**ST today:** `splitByChunks` / `overlapChunks` / `getChunkDelimiters` in the vectors extension —
character-count based with a delimiter list. Adequate for files, crude for chat.

**Port:** the token-metric mode and `chunk_messages` (chunk on turn boundaries, never mid-message).
**Hashtrinity form:** n/a — this is a pure function, no table.
**Effort:** small (~250 ln). **Risk:** low. Nice-to-have, not a headline.

---

## 11. Character generation & enhancement

**Scribe:** `services/character_generation/` — `field_generator.rs` (1368 ln, per-field generation
with field-specific prompts), `full_character_generator.rs` (285), `structured_output.rs` (424,
JSON-schema-constrained output), `tools.rs` (384), `types.rs` (625), `enhancement_service.rs` (132,
improve an existing field). Total ~3200 ln, and it is almost all prompt engineering + schema.

**ST today:** nothing built in. Third-party extensions exist and are uneven.

**Port:** the cleanest lift in the catalogue — no state, no storage, no schema migration. Prompts and
schemas transfer nearly verbatim; only the API call layer is rewritten.

**Hashtrinity form:** n/a (stateless). Included because it is cheap and visible.
**Effort:** medium (~600 ln + UI), almost entirely UI. **Risk:** very low.

---

## 12. Game state + reconciliation (the big one)

**Scribe:** `services/game_state_service.rs` (70k ln), `services/agentic/state_manager_agent.rs`
(2004 ln), `services/reconciliation_detector.rs` (`ReconciliationAction`), `models/game_state.rs` —
`GameState`, `Location`, `GameTime` + `CalendarConfig`, `InventoryItem`, `Vital`, `Quest` +
`QuestObjective` + `QuestStatus`, `NpcState`, `EnvironmentState`; a `StateChange` enum of 11
variants; and `GameStateService::reconcile`, which detects when narrative text contradicts tracked
state and repairs it.

**ST today:** nothing. RPG-mode users hand-roll inventories with World Info entries and regex
scripts, and it does not survive contact with a long chat.

**Hashtrinity form — this is the cleanest demonstration in the whole catalogue that the trinity is
load-bearing and not a mood.** The entire game state is one table; each subsystem is a merge:

| subsystem | key | merge | face |
|---|---|---|---|
| inventory | item id | `merge_bu` (quantities add) | Count |
| vitals | vital name | domain merge (add-then-clamp) | Count |
| quests | quest id | `merge_b` (status last-write) | Map |
| location / time / environment | field | `merge_b` | Map |
| NPC states | npc id | `merge_graph` | Graph |
| visited / flags | flag | `merge_nb` | Set |

`StateChange` is not an enum of eleven special cases — it is a key plus a choice of `f`, and
`reconcile` is `insert_with`. **fold:** `absorb` with a domain merge; the surprise/contradiction
detector is the same gate as §5.

**Effort:** large (~1500 ln + substantial UI). **Risk:** medium-high (scope creep is the failure
mode — Scribe's own history is a warning). **Sequence last**, but design the merge table above
early, because it is what stops this becoming another 7000-line perception agent.

---

## 12b. Pillar B narrowed — status & inventory only

Cut `Quest`, `NpcState`, `GameTime`/`CalendarConfig`, `EnvironmentState`, `inventory_stored`,
`assets`, `custom_data`. Keep exactly three tables:

```js
insert_with(inventory,  merge_bu, itemId,      qty);       // Count — quantities add, 0 = absent
insert_with(vitals,     clampAdd, vitalName,   delta);     // Count with a domain merge
insert_with(status,     merge_nb, effectName,  true);      // Set   — "poisoned", "blessed"
```

`clampAdd` is Scribe's own rule, lifted verbatim from `game_state_service.rs:203`:
`(current + delta).clamp(0.0, max)`. Additive-then-clamp — a merge, not a setter.

**The design property worth stealing, and the reason this is safe to build:** Scribe's
`reconcile(current_state, new_state, player_action)` has the LLM propose a *complete* new state,
then validates it against the current one and **rejects impossible changes** (`ReconciliationResult`
carries `applied_changes`, `rejected_changes`, `warnings`). The model proposes; the merge disposes.
That inversion is what keeps a hallucinated "you now have 900 gold" out of the ledger, and it is the
hashtrinity thesis applied to game state — the authority is `f`, not the generator.

**Steal also `staleness_count`** (`models/game_state.rs:288`): each reconciliation cycle increments a
counter on every item the narrative did *not* mention; past a threshold the item is a removal
candidate. That is the Count face used as decay, and it is the same mechanism as fold's
`SERVEFOLD_TTL_DECAY`. It is what stops the inventory accreting forever — the failure mode of every
hand-rolled WI inventory in the wild.

**Lands:** `public/scripts/extensions/fold/state.js`, rendered as a panel + injected as a compact
block at low depth. **Effort:** medium (~500 ln + UI) at this scope, versus large for full §12.
**Risk:** low-medium. Re-expanding to quests/NPCs later is additive — one more key, one more merge.

---

## 18. ⭐ Pillar C — directed retry / variant steering

**Not a Scribe port.** Scribe has no equivalent; ST has most of it already and never exposed it.

**What exists in ST today (verified):**

- `Generate('regenerate' | 'continue' | 'impersonate', { quiet_prompt, quietToLoud: true })` —
  a one-shot steering instruction injected at `inject_ids.QUIET_PROMPT`
  (`public/script.js:4564`), rendered into the prompt at :4973–4977 with instruct-mode formatting.
- `buildOrFillAdditionalArgs` (:11527) already threads `customData.additionalPrompt` into all three.
- `swipe_info[i].extra` is a free-form object per swipe (`createSwipeInfo`, :6802), already
  backfilled and validated by core (:6809–6823).
- `/inject … ephemeral=true` gives a second, more general route (`slash-commands.js:2892`).

**What is missing:** anything that calls it. No button, no slash command, no persistence.

**Port/build:**

1. A steer affordance on the swipe control — type a direction, get a new swipe generated under it.
2. `/retry <direction>` and `/swipe <direction>` slash commands passing `additionalPrompt`.
3. **Persist the direction into `swipe_info[i].extra.direction`.** This is the part that makes it
   more than a convenience: the chat file then records *why* each variant exists.

**Hashtrinity form:** the swipe set becomes the Graph face — `insert_with(variants, merge_graph,
messageId, [{ text, direction }])` — where today it is an array with no provenance. Once directions
are recorded, `merge_bu` over them gives the obvious downstream read: which steering phrasings
actually produce swipes you keep. That is a genuinely new capability, not a UI tweak.

**Interaction with pillar D:** a directed retry is a *high-surprise* event by construction — the user
just told you the model got it wrong. That signal should feed §5's gate directly, and the direction
text is a first-class chronicle input. Wire this before §7 and the agent gets a supervision channel
for free.

**Effort:** small (~250 ln, mostly UI) — by far the cheapest of the four pillars.
**Risk:** low. Core plumbing is already there and already exercised by the three `option_*` paths.
**Sequence: first.** It is a standalone win, it validates the extension scaffold, and it starts
producing the steering corpus that §5 and §7 later consume.

---

## 13. Background task runner

**Scribe:** `services/edm/` — `task_store.rs` (7167 ln), `worker.rs`, `workflow.rs`,
`otel_propagation.rs`. Queues the enrichment work so the chat reply never waits on it.

**ST today:** background work is ad-hoc in the browser tab; close it mid-summarize and the work is
lost.

**Hashtrinity form:** task id → task is the Map face; retry counts are the Count face; the queue is
the Graph face keyed by state.
**Effort:** small-medium (~300 ln). **Risk:** low. Only needed once §7 exists.

---

## 14. At-rest encryption — flagged, not recommended to lead with

**Scribe:** `crypto.rs` (18k ln), `services/encryption_service.rs`, `SessionDek`, password-derived
keys, per-field encrypted columns (`summary_encrypted` / `summary_nonce` / `keywords_encrypted`).

**ST today:** multi-user accounts with optional passwords, but chats/characters sit as plaintext
files under `data/<user>/`.

**Assessment:** technically portable, but ST's plaintext-file model *is* its ecosystem — every
backup script, every third-party tool, every "just copy the JSONL" workflow depends on it. An opt-in
DEK for chronicles only (a new store, no legacy data) is the sane subset if this is wanted at all.
**Recommendation: defer.** Listed for completeness because it was Scribe's headline feature and its
absence here should be a decision, not an oversight.

---

## 15. CountLM for significance scoring — TRIED, MEASURED, REJECTED

The idea: `hashtrinity`'s `CountLM` trains by the accumulate merge in one pass and `unfold` is
**exact** unlearning, so a locally-folded model of the chat could score how *surprising* a turn is
and gate the expensive extraction call — replacing the fixed interval, and getting swipe-awareness
for free because an abandoned branch can simply be subtracted.

It was ported to JS in full (order-k byte n-grams, Kneser–Ney with Chen–Goodman discounts read off
the count-of-counts, merge/unfold as the ℤ-group operations) and tested. **The port worked. The
idea did not.** It has been removed; this section records why so it is not re-litigated.

**What held up.** Exact unlearning is real and works in the *distribution*, not merely the ledger:
merge a branch, unfold it, and held-out bits/byte returns to its prior value bit-identically
(`4.1371 → 1.1088 → 4.1371`). Residue keys sitting at count 0 have to be skipped on the read side
or the floor skews — that one detail is the difference between "counts restored" and "predictions
restored".

**What failed.** The first measurement looked decisive — filler 1.55–2.97 bits, events 3.69–3.94,
cleanly separable. That result was an artefact of the test cases: filler had been written in plain
words and events in new ones, confounding vocabulary novelty with narrative significance. Pulling
those apart:

| turn | vocabulary | bits/byte |
|---|---|---|
| filler | plain words | 1.628 |
| filler | exotic words | **4.472** — the highest of anything tested |
| event | new words | 3.680 |
| event | plain words | **2.880** — lower than the filler above |
| event | plain, injury | 3.047 |

Overlap of 1.592 bits: no single threshold separates them. **Bits-per-byte measures vocabulary
novelty, which is not what "something happened" means.** The absolute scale also drifts as the
corpus grows (4.297 → 3.697 for the same probe over one conversation), so a fixed threshold rots.

**The one use that survives, unbuilt:** a conservative *skip* filter rather than a trigger. The
costs are asymmetric — a false positive wastes one extraction call, a false negative loses an event
permanently — so a deliberately low threshold that only skips obviously-redundant turns is safe.
That is cost optimisation, not intelligence, and it needs tuning against a real chat rather than
synthetic cases. Not worth carrying the module until someone wants that.

**The general lesson, which does transfer:** an n-gram count model can tell you that text is
*unusual*. It cannot tell you that it is *important*. Anything wanting the second needs semantics.

---

## 19. Marinara Engine — surveyed, partially taken

`../Marinara-Engine-2.4.1`, AGPL-3.0, same licence as this fork, so code may be lifted with
attribution rather than reimplemented from the idea.

**Taken:** the brace-depth scanning approach in `jsonish.ts`, reimplemented in `json-parse.js`
(see the parser findings above).

**The interesting architectural difference — the inline DSL.** Their roleplay model emits command
tags in its own reply:

```
[bg: Argent Mine — Assay Office]
[ambient: stamp-mill thuds, creaking hoist chains]
[Dain Rusk] [main] [smirk]: "State your business. Keep it brief."
[state: dialogue]
```

Background, ambient, speaker, sprite layer, expression and the state transition all ride out on
the reply that was being generated anyway. One call per turn where fold makes two.

**But the tags are trusted.** `state-machine.service.ts` is 21 lines and `isValidTransition`
returns `true` for any pair of valid states — every transition is legal. There is no equivalent of
`validateDelta`: whatever the narrator asserts about the world becomes the world. That is the same
failure Scribe's dead `rejected` vector represents, arrived at from a different direction.

**So the two designs compose rather than compete.** The DSL is a *transport* optimisation; the
propose/dispose validator is an *authority* model. Taking the transport and keeping the validator
gives one call per turn AND a gate. It would also remove the "extraction is a second request"
trap from the testing notes, because there would be no trailing call to account for.

**What it costs, and this is underpriced in the obvious framing:**

- Inline tags cannot use strict structured output. fold already runs its own parser over raw text
  rather than trusting ST's, so the loss is smaller than it looks — but schema *enforcement* on
  chat-completion backends is a real quality lever to give up.
- The roleplay model must be instructed to emit tags, which means prompt real estate on **every**
  turn, competing with the character card and the user's preset. Extraction currently pollutes
  nothing, because it runs as a separate call with its own system prompt.
- Tag emission becomes a hard dependency on model compliance in the *creative* path. A model that
  forgets the tags loses the state update; today a model that returns bad JSON loses only the
  extraction, and the reply is unaffected.
- fold extracts over a *window* of several messages and attributes events to a source content
  hash. Inline tags describe only the turn being generated, so the anchoring that makes
  branch-awareness work would need rethinking.

**Verdict:** worth building as an *option* for users on models that follow instructions well, not
as a replacement. The second request is the honest default.

**Their resolution layer** (`services/game/`, ~1,700 lines, verified free of model calls) —
combat with initiative and boss triggers, elemental aura/gauge reactions, d20 skill checks, dice,
morale, loot — is the piece fold has no equivalent of, because fold *tracks* state and never
*resolves* anything. That is a genuine product decision, not an oversight: resolution turns a
memory layer into a game system. Their `StatusEffect` is `{name, modifier, stat, turns}`, which is
strictly richer than fold's `status → merge_b` and still expressible as a merge —
decrement-and-drop-at-zero is just another `f`. That one is cheap and worth taking if durations
are wanted.

**Do not take:** `game.routes.ts` (13,091 lines of HTTP handlers, prompt building and
orchestration) and `gm-prompts.ts` (73KB of prompt text — read it, do not port it).

---

## 16. Recommended sequence

Pillar-driven. Phases 0–4 are the agreed scope; 5+ is optional surface.

| # | phase | items | pillar | effort | why here |
|---|---|---|---|---|---|
| 0 | **Vendor the basis** | copy `hash.js` → `public/scripts/lib/hash.js`, wire `self_test()` into `tests/`; stand up the `fold` extension shell | — | ~1 h | zero-dep ESM, already matches ST's module style; everything below imports it |
| 1 | **Directed retry** | §18 | **C** | small | cheapest pillar, core plumbing already exists and is unwired; validates the scaffold; starts the steering corpus §5/§7 need |
| 2 | **Decide the schema** | §9 branch-awareness | D | small | must precede §3 or it becomes a migration; §18's `swipe_info.extra` lands in the same place |
| 3 | **The ledger** | §3 chronicle + §4 dedup | **D** | medium | Map face → Graph face; the actual thesis |
| 4 | **Fuse what exists** | §2 RRF recall | **A** | small | needs §3 to have a third source worth fusing; shadow-mode testable against current behaviour |
| 5 | **Status & inventory** | §12b | **B** | medium | independent of A/D — can run in parallel from phase 1 if there is a second pair of hands |
| 6 | **Stop paying for filler** | §5 surprise gate | D | small | cuts spend immediately; consumes §18's directed retries as a supervision signal |
| 7 | **One budget** | §6 budget planner | A | medium | now that sources are fused, a shared budget is coherent |
| 8 | **Visible wins** | §8 lorebook extraction, §11 character gen | — | medium | user-facing, low risk |
| 9 | **Automate** | §7 agent loop + §13 task runner | — | large | only after §3/§5 prove out |
| 10 | **Re-expand** | §12 quests, NPCs, time | B | large | additive to §12b — one more key, one more merge |

Note the change from the first draft: **recall now follows the chronicle rather than leading it.**
Fusing two existing sources is a marginal win; fusing three, one of which is a real event ledger, is
the point. §18 moves to the front because it is cheap, standalone, and produces data the later
phases consume.

Phases 0–4 are roughly a working week and deliver pillars A, C and D. Pillar B (phase 5) is
independent and parallelisable.

---

## 17. Deliberately omitted

`hybrid_token_counter.rs`, `prompt_templates.rs`, `template_preference_service.rs`,
`user_persona_service.rs`, `character_parser.rs`, `history_manager.rs` (a single
`manage_history(history, strategy, limit)` doing naive truncation — ST's context handling is
better), all payment/auth/email, all Diesel schemas, all vector-DB clients, the desktop
shell, the compliance docs. In each case ST's existing implementation is equal or better, or the
capability is Scribe-as-SaaS rather than Scribe-as-idea.
