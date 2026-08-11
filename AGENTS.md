# SillyTavern — agent rules

Rules for working in this repository. These are gates, not suggestions; a rule you can nod at is not a
gate, and the failures below each rule are the measured reasons it exists.

## RULE 1 — FOLD: never judge the narrative with hardcoded strings

The fold extension (`public/scripts/extensions/fold/`) runs an LLM over every chat window. The whole
point is that the model already read the prose — in whatever language it was written — so fold must
never re-read it with English regexes, word lists, stoplists, or substring matches.

The governing law, stated in the code's own words (`trigger-table.js:178-189`):

> **fold's own vocabulary — category names, enum values, the outcome bands — may be English. Those are
> a PROTOCOL between fold and the model, and the schema defines them. Reading the NARRATIVE is never
> fold's job. The model already read it, in whatever language it was written. Ask it.**

The line:

- **PROSE (player/assistant message text) — a hardcoded English judgement is a DEFECT.** No regex,
  word-list, stoplist, or substring test may be applied to message text to decide what the story
  means. If the decision needs language understanding, the model answers it (schema field on the
  existing shared extraction pass — never a new request). If the decision is about fold's own data,
  use the hash trinity or coverage algebra.
- **PROTOCOL (schema enums, category names, outcome bands, table keys, block-field labels) — allowed.**
  These are the contract between fold and the model; the model is instructed to emit them.
- **STRUCTURE / FORMAT (punctuation shape, `Intl.Segmenter` word counts, number parsing, markdown
  stripping, JSON repair, pure token-subset algebra on fold's own keys) — allowed.** These mean the
  same thing in every language fold renders.

### The sanctioned techniques (from `../fold/STATE-ARCHIVE.md`)

- **Ask the model** — extend the shared extraction probe with a structured field (`elapsed_minutes`,
  `status: 'open'`, `mentions: [...]`). One call serves every probe (`extract.js` `registerProbe`);
  a new field is free, a new request is forbidden.
- **Coverage, not confidence** (`[ROUTER]`): "the missing quantity is coverage, not confidence."
  Admission is by whether the model reports the window mentions a tracked line — never a similarity
  or substring proxy. The probes answer `mentions: string[]`; `coverage.js` persists that report and
  the review hot set, presence questions and cold recall (`cold.covered`) all admit by it, one pass
  behind where the prompt is built before the request.
- **Re-promotion is a WRITE, never a paste** (`[AC-PRODUCT]`).
- **Demote, never delete** (`[EVICT]`).
- **The hot set scales with the window** (`[TLB]`).
- **The hash trinity** — one table, one operation (`insert_with`), the merge is the only freedom
  (Set / Map / Accumulator / Graph faces, `lib/hash.js`).

### Measured failures this rule closes

- The `UNSETTLED` exposition gate (`entity-table.js`) was an English interrogative word-list. It
  wrongly dropped "Survive the fight — the fight has just started" from the Star Wars chat as
  "exposition", because an ongoing fight was phrased as a status rather than a question. The fix was
  a schema status enum, not more words.
- `clock.js` carried ~20 English regexes (SPANS, NAMED, MONTHS, DAYS, MARKER_PHASE, parseElapsed
  gates) that could only read English time phrases. A Korean or Chinese player's "come morning" never
  moved the clock.
- The `not-mentioned` noise across live chats is the substring mention gate (`isMentioned`,
  `mentions`, `mentionsDial`) refusing prose it cannot token-match. The model can read the window;
  the gate cannot.

### Enforcement

A prose-regex audit list lives in `tests/fold-no-prose-regex.test.js`. It reads every `.js` file in
`public/scripts/extensions/fold/` and fails if a new hardcoded prose-matching pattern appears. Before
adding any regex/word-list to the fold extension, ask: **does this read PROSE?** If yes, put it in a
schema and ask the model.

**What the live path now guarantees:** every decision that reads the narrative — time passage, the
exposition gate, review dispositions, the mention gates, item place/magnitude/subject — is answered
by a schema field the model fills, in any language.

**Identity is the model's answer, never fold's.** Whether two spellings name one thing ("m-65
jacket" vs "m-65 military jacket", "the bedroom" vs "in his bedroom") is a record-linkage decision.
The delta schema's `same_as` field lets the model name the exact held item when it is restating one;
fold merges only on that word. When the model does not resolve a pair, fold keys under exactly what
was reported and the review probe asks `[same?]` — the model answers `same`/`different`, and the
persisted `state.answers` table is the training set a learned resolver will consume later. The
identity detector (`nearIdentity`) is a language-neutral token-subset trigger that only raises a
question; it never decides. **No English morphology (prepositions, articles, stopwords, head-noun
truncation) survives in the identity path.**

**The learned resolver is in-tree, self-contained.** `lib/ml/` is the JavaScript mirror of the fold
workspace's `modelfold/src/{guard,boost,auto/{distill,contract,ratchet}}` — the split-conformal
admission guard, the gradient-boosted classifier, the distilled `AutoUnit`, the `Contract`
recompile gate, and the `Ratchet` gradual-takeover loop. The lifecycle `state.answers` was built
for: the LLM answers the first N `[same?]`/`[merge?]` pairs; `AutoUnit.distill` trains a fast path
on those answers; the `Ratchet` recompiles as the witness set grows, and the unit gradually answers
near-paraphrases of already-witnessed pairs without a new LLM call. The guard is a
distribution-free exchangeability-conditional coverage test over a trigram-Jaccard distance — it is
NOT a classifier, and must never be swapped for one (a GBM's output is a probability, not a
nonconformity score). Its `admit`/`deopt` decision is the ONLY thing that may short-circuit a
review question: guard admits → read the distilled model; guard trips → the LLM is asked, exactly
as today. These modules are pure data, no prose judgement: featurizing a pair's text for the GBM is
structure, and the model's own answers are the labels.

**The block path is the model's too.** A card's own status block (`Inventory:`, `Health:`,
`Leads:`) is preserved verbatim and fed to the extraction probe, so the model reads its VALUES in
any language; `absorb` strips it for display only. `splitConditions`/`splitItems` split on
punctuation (structure), never on English verbs or emptiness words; `isNegation`, `FINITE_VERB`,
`EMPTY_VALUES`, `REACHABLE`/`OWNED` are deleted. Migration is one-time shape repair that preserves
v1 rows verbatim; the probes rebuild `reach`, leads and conditions structurally on the next pass.

**Contact details and empty names are the schema's contract.** The delta instruction says contact
details are never items and the entity probe reports `reach`; fold stores what the model reports.
The read-heal for legacy `contacts` rows is keyed on the migration's OWN recorded `reachKeys` (exact
item keys), never an English place word.

## Working discipline

- Before editing, read the file's docblocks whole — this codebase argues with itself, and the
  argument is usually load-bearing (a list exists because a measurement or a deleted alternative
  lives in its comment).
- Verify against the committed tree when in doubt; a worktree edit that was never re-staged is not a
  change.
- Tests live in `tests/`, run with jest from `tests/` (see `tests/package.json`):
  `node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.json fold`.
- Lint with `tests/node_modules/.bin/eslint`.
- Never commit unless explicitly asked.
