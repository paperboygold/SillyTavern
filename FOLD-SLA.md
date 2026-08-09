# fold — definition of done and the extraction SLA

*What "the companion is up to date at all times" means, operationally, and the numbers that prove
it. Companion to `FOLD-REDESIGN.md` (the design) and `FOLD-RPG-GAP.md` (the problem statement).
This document does not restate their research; it commits to targets and to the gates that measure
them.*

## 1. Definition of done

The fold companion is **done** when all three of these hold, measured on a live campaign, not on a
fixture:

1. **The ledger never lies about the present.** At every instant the player can see, the derived
   state (vitals, inventory, marks, threads, money, presence) matches the fiction up to the most
   recent message that has been *processed*. A value the narrative has already superseded is
   never shown as current.
2. **Nothing is silent.** Every stage of the update lifecycle is visible: a message is acknowledged,
   extraction is in flight, it succeeded, or it failed — and a failure says what failed and offers
   the fix. A state that is wrong and invisible is the one defect class this project will not ship.
3. **Corrections are the product, not the workflow.** The player never has to hand-edit state or
   wait for a repair pass to keep playing. When the model gets something wrong, the ledger is
   self-healing (retraction, closure, review) or the failure is caught and surfaced before it
   compounds.

"Done" is not a feature list. A feature that ships without 1–3 is not done; it is a liability in
the tree.

## 2. The extraction SLA

The SLA is three promises with one underlying lever: **extraction is the only writer of state**, so
every promise is a property of the extraction pass.

### 2.1 Freshness — no delays

| promise | target | gate |
|---|---|---|
| Every exchange is extracted | extraction runs for **every** assistant message that arrives while the panel is on | `extract:ok` + `extract:no-events` + `extract:delta-empty` together cover 100% of `extract:on-*` triggers; zero triggers fall through to `extract:waiting` for a scene that moved |
| The delay is bounded | from the moment a message renders to the moment the ledger reflects it: **≤ 20 s** p95, on the extraction model the user has configured | a timestamped `state.sync` record (`syncing` → `up-to-date`) whose elapsed is logged per pass |
| The panel never shows a lie while waiting | while extraction is pending or in flight, the strip/panel show `acknowledged`/`syncing`, never a stale value presented as current | `state.sync` rendered in the strip on every pass |

### 2.2 Accuracy — as close to 100% as the model permits

| promise | target | gate |
|---|---|---|
| Every change is captured | **100%** of state-changing beats in the narrative produce a delta, and no beat is billed twice | `reject:already-recorded` fires only for a *true* re-report, never for a genuine re-acquisition (the Phase A known cost must be driven to a measured near-zero) |
| Nothing invented | **0** accepted deltas that the narrative does not support | `reject:not-mentioned` / `reject:implausible-*` ≥ any accepted hallucination; the rejects tally is audited against the log each session |
| The ledger is current | the derived state at message N equals the fold of everything through N, with no unprocessed gap | `state.sync.mid` equals the newest live message mid after each successful pass |

### 2.3 Failure — visible, self-explanatory, retried

| promise | target | gate |
|---|---|---|
| Every failure is shown | an extraction that returns `empty`/`truncated`/`unparseable` sets `state.sync = failed` with the reason and the fix; the chip is red and stays until the next success | the caret log records the pass (reason, mid, raw reply, budget-vs-structural hint); the chip renders it |
| Failures retry, never wedge | a pass that returns nothing is retried **in-pass, up to 3 attempts with backoff** (transient rate-limit/hiccup failures are absorbed there), and a pass that still fails is retried on the next eligible turn; the read mark advances after `FAILURE_BACKSTOP` consecutive failures so the ledger cannot freeze | `extract:retry-1`/`retry-2` counters; `extract:retry-*` visible; `FAILURE_BACKSTOP` counters |
| Failures are diagnostic | every failure is attributable to budget, transient, or structure — the log says which, and records the raw reply | `FOLD-SLA.md` §3 classification, per pass |

## 3. The failure classification (budget vs model vs structure)

Every extraction failure is one of three cures, and the diagnosis is recorded at the pass:

| symptom | cure | how it reads in the log |
|---|---|---|
| `empty` / `truncated` | raise the token budget — a reasoning model spent its allowance thinking | "no JSON — raise the extraction token budget" |
| empty at the tripled retry too | **transient — rate limit or provider hiccup.** Retry with backoff (done in-pass, up to 3 attempts); the raw reply distinguishes an empty body from a rate-limit envelope | "no JSON after 3 attempts — likely transient; see the raw reply" |
| `unparseable` | prompt, schema or model mismatch — structural | "JSON present but unusable — prompt, schema or model, not a budget issue" |

The first is fixed in code (`MIN_RESPONSE_LENGTH`). The second is the measured reality for a
flash model (median 34 thinking tokens): it does not think itself into starvation, so a pass that
still returns nothing after the budget-bump retry is transient, and the in-pass backoff retries are
the cure — with the raw reply logged so a persistent transient becomes visible as a rate limit
rather than an invisible `empty`. The third is a schema contract issue and is fixed in the schema,
not the budget.

## 4. What is explicitly NOT in the SLA

- **Sub-second extraction.** A model call takes seconds; the SLA bounds the delay, it does not
  pretend the call is free. What is bounded is *visibility*: the wait is never silent.
- **Fixing the model's prose.** The narrator may still contradict itself in text (a wrong HP line,
  a lost pelt count). The SLA is that fold does not *endorse* the contradiction — it captures what
  happened and the review/adjudicator resolves conflicts — and that the contradiction itself is
  logged when fold can see it.
- **Zero manual correction ever.** The edit-in-place and review passes exist for the residual
  cases. The SLA is that corrections are *rare, visible, and one click* — not a repair workflow.

## 5. Gates

Every phase that touches extraction or the panel re-runs these on the real chat:

1. `state.sync` reaches `up-to-date` within 20 s of every message, p95, over a session.
2. `extract:ok + no-events + delta-empty` == `extract:on-*` (no silent falls-through).
3. The rejects tally, opened through the diagnostics log, shows no accepted hallucination in the
   session's last 20 rejections.
4. The strip shows `failed` (red) within one pass of any empty/truncated/unparseable outcome, and
   clears on the next success.
5. No chat is left with a frozen read mark (`extractMid` behind the newest message for more than
   `FAILURE_BACKSTOP` consecutive failures without advancing).
