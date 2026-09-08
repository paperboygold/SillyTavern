# FOLD-EQUATIONS, the reconciliation equations, in their three media

The same reconciliation problem has now failed in three programs: Scribe, rpg-companion, and fold
(this repo). Each held a tracked state, read a narrative, and tried to fold the second into the
first. Each failed in a way that looked local and was not, the failures repeat across the media
because they are the same algebraic shape wearing different clothes.

This document is the equation catalogue for that problem. The equations are the split-complex
algebra's, taken from the machine-checked corpus (`../sanguine/proof/`), the OS that instantiates
it (`../song/docs/DESIGN.md`), the rebuild that re-derived it (`../sanguine-apeiron/theory/`), and
the fold's own measured failures (this repo). Every claim carries its grade the way the corpus
grades its own: **proved** (machine-checked), **anchor** (a reading of the algebra onto the world),
**open** (named, not established). A docblock that overclaims is a defect equal to wrong code, so
each section says what is proved and what is declared.

Read order: §1 (the cell) → §2 (the universal equation) → §3 (the dial) → §4 (the
instantiations) → §5 (the measured failures) → §6 (what the equations say is wrong).

---

## 1. The one algebra, the Null cell, `ℝ[j]/(j²−1)`

The primitive everything else stands on. Two real dimensions `(a, b)` written `a + b·j`, the
split-complex twin of ℂ: the same two dimensions, the opposite sign in the square.

| equation | statement | theorem / file |
|---|---|---|
| the cell | `NCell = ℝ × ℝ` | `abbrev NCell`, `NullCell.lean:105` |
| the product | `(a+bj)(c+dj) = (ac+bd) + (ad+bc)j` | `nmul`, `NullCell.lean:110` |
| the norm | `N(a+bj) = a² − b²`: **indefinite**, signature `(1,1)` | `nNorm`, `NullCell.lean:115`; `ncell_indefinite:153` |
| `j² = +1` | the boost, where ℂ has the rotor `i² = −1` | `nj_sq`, `NullCell.lean:132` |
| multiplicative norm | `N(zw) = N(z)·N(w)`: a composition algebra | `nNorm_mul`, `NullCell.lean:139` |
| the null cone | `N(1+j) = 0`, `1+j ≠ 0`: a whole cone of zero divisors | `nNull_norm`, `NullCell.lean:159` |
| zero divisors | `(1+j)(1−j) = 0` | `null_times_mirror`, `NullCell.lean:172` |
| `/` singular | `¬ ∃ w, (1+j)·w = 1`: **no inverse on the cone** | `null_not_invertible`, `NullCell.lean:178` |
| the pair | `⟪1+j, 1−j⟫ = 2 ≠ 0`: two null directions span a nondegenerate `(1,1)` plane | `nNull_pairing`, `NullCell.lean:197` |
| boost halves | `z = a(1+j) + b(1−j)`, `a = (z₁+z₂)/2`, `b = (z₁−z₂)/2` | `cell_is_two_boost_halves`, `NullCell.lean:208` |
| the idempotents | `e₊² = e₊`, `e₋² = e₋`, `e₊·e₋ = 0`: two independent channels | `ePlus_idem`/`eMinus_idem`/`e_orthogonal`, `NullCell.lean:293-303` |

The three equations that do the work in this document:

1. **`N(zw) = N(z)N(w)`**, the cone is closed under multiplication. Once a factor is null,
   every product lands on the cone and nothing carries it off. `NullCell.lean:139`.
2. **`¬∃w, (1+j)·w = 1`**, the unit is unreachable from the cone. Division has no inverse on
   the null set; you cannot recover the thing that fell in. `NullCell.lean:178`.
3. **`e₊e₋ = 0`**, the cell is two independent channels under the product, not an entangling
   rotation. What lands on one channel never crosses to the other. `NullCell.lean:302`.

The cell is characterised as a whole, two-dimensional, `j² = +1`, indefinite norm, a real null
cone, `/` singular on it, in `null_cell_characterization` (`NullCell.lean:269`). The monad `1`
is the unit both cells share, on neither side.

**What is proved vs read.** Proved: all of the above. Anchor: that this cell is "the −1
timelike slot of the d = 26 descent" and that "time" is a word for its `(1,1)`. The corpus says
so in its own header (`NullCell.lean:11-12`). Nothing below depends on the physics reading.

---

## 2. The universal equation, `x = B/U`

The one generative equation of the corpus: state is the pointwise ratio of a boundary `B` over a
drag `U` (`../sanguine/proof/Substrate/Algebra/Bulk/UniversalEquation.lean`).

| equation | statement | theorem / file |
|---|---|---|
| the state | `x = B/U` | `state`, `UniversalEquation.lean:94` |
| the bulk differential | `d(B/U) = (U·dB − B·dU) / U²`: the ratio shatters into two opposite-sign terms | `bulk_differential`, `UniversalEquation.lean:115` |
| stationary phase | `d(B/U) = 0 ↔ U·dB = B·dU`: the boundary's gradient and the drag's stand in the same ratio as `B` and `U` | `stationary_phase`, `UniversalEquation.lean:140` |
| log form | `dB/B = dU/U`: at stationarity `B` and `U` change at the same *relative* rate | `stationary_phase_log_form`, `UniversalEquation.lean:163` |
| boundary composition | `state(composeB) = B₀ / (U₀·U_outer)`: drags accumulate multiplicatively, the boundary survives | `composeB_state`, `UniversalEquation.lean:201` |
| drag composition | `state(composeU) = B_outer·U₀ / B₀` | `composeU_state`, `UniversalEquation.lean:212` |

The abstract version, any derivation on any field, is `AbstractBulkDifferential`; this is its
real-analysis realisation (`UniversalEquation.lean:13`).

**Why the quotient rule is the reconciliation shadow.** Before `d`, `B/U` is one featureless
scalar. After `d`, it is a difference of two terms with opposite signs, the algebraic shadow of
having differentiated a quotient (`UniversalEquation.lean:36-38`). Reconciliation is a quotient:
the record divided by the narrative, the state divided by the observation. The decomposition that
shatters out of it is the two-way pull, the boundary's term against the drag's term, and every
place a reconciliation system chooses one term and ignores the other, it produces the measured
failures of §5.

---

## 3. The dial, the trichotomy `σ ∈ {−1, 0, +1}`

The apeiron-rebuild (`../sanguine-apeiron/theory/STRUCTURE.md`) re-derives the algebra from the
one parameter: **every two-dimensional unital commutative associative ℝ-algebra is `mul σ` for
`σ ∈ {−1, 0, 1}`** (`classification`, `proof/Apeiron/Trichotomy/Basic.lean`; `quotient_classification`
for `ℝ[X]/(X²−σ)`). "The dial is the whole freedom, and the trichotomy is not a taxonomy someone
imposed, it is what completing the square leaves" (`STRUCTURE.md:21-23`).

| dial | channels | the bulk |
|---|---|---|
| `σ > 0` | two, and only two, `two_channels_iff_disc_pos` | a projective line with two marked points |
| `σ = 0` | one, the two readings coincide, `upper_eq_lower_of_disc_zero` | the line has collapsed |
| `σ < 0` | none, `no_channel_of_disc_neg` | there is no reading to take a ratio of |

(`STRUCTURE.md:65-71`; each cited theorem in `proof/Apeiron/Trichotomy/`.)

The load-bearing equations for the reconciliation question:

- **`normForm σ z = upper σ z · lower σ z`**, the size is the product of the two channel
  readings, so `normForm = 0` exactly when one channel reads zero (`normForm_eq_upper_mul_lower`,
  `normForm_zero_iff_channel_zero`; `STRUCTURE.md:60-63`). The degenerate locus is two lines, one
  per channel, not a region.
- **`ratio σ z = upper σ z / lower σ z`**, the projective coordinate `[upper : lower]`, the
  only non-commutative and non-associative operation in the corpus (`ratio_order`,
  `ratio_bracket`; `STRUCTURE.md:54,73-74`).
- **`node_faithful_iff_disc_pos`**, a node reads its two subtrees faithfully **exactly when
  `σ > 0`**. **`state_node_of_disc_nonpos`**, at zero or below every node reads `0` or `1`,
  whatever its subtrees hold (`STRUCTURE.md:81-87`). Branching exists above zero and collapses
  below, and the theorem is an iff.
- **`hasZeroDivisor_iff_disc_nonneg`**, non-zero things whose product degenerates exist
  exactly when `0 ≤ σ` (`STRUCTURE.md:100-103`).

**The two dead ends that bound the claim** (`../sanguine-apeiron/theory/DEAD_ENDS.md`):

- **Merges are not classified by the discriminant.** The strong claim, "the dial classifies
  merge functions in general", was refuted (`DEAD_ENDS.md`, "Merge functions classified by the
  discriminant"). A merge is a binary operation on an arbitrary type; a two-dimensional real
  algebra is a different object and there is no map between them for a discriminant to be
  preserved by. What survives is `idempotent_classification`: the dial fixes how many idempotents
  the algebra has, four above zero and two at or below, how many independent Boolean channels.
- **Application is not an algebraic operation on the carrier.** Commutative multiplication
  cannot be application (`mul_comm` forces `φ(app S K) = φ(app K S)`), and `(ℝ, /)` has no `K`
  combinator (`(k/x)/y = x` forces `k = x²y`, which depends on `x`). Combinatory application is
  non-associative by construction, so no associative operation on any carrier can be it.
  `DEAD_ENDS.md` "Combinators as elements", "Division standing in for application".

The third dead end is the one that names the fold's disease. The table layer was originally built
as `HMap K V = K → V` with a merge, and **"the dial turned out to be a spectator in it.**
`build_gauge_invariance_mul` proves itself from `mul_comm`/`mul_assoc` alone, so it reads the same
for the integers or for any commutative monoid. That is not a missing lemma, it is the wrong
carrier. **A total function has no degeneracy, so there is nothing for a discriminant to be
about.**" (`STRUCTURE.md:8-12`). This sentence is the hinge of §6.

---

## 4. The instantiations, song, Scribe, fold

### 4.1 song, the collapse and the table (`../song/docs/DESIGN.md`)

The OS instantiates the algebra as **safety = a collapse, not a check**: a total map whose image
is the safe set, destroying the information that would name an unsafe state. Three axes
(`DESIGN.md` §3.1):

| axis | map | image | theorem |
|---|---|---|---|
| spatial | `k ↦ base + (k and 2ᵏ−1)` | `[base, base+2ᵏ)` | `access_in_region`, `MandalaMemory.lean` |
| temporal | `live ↦ spent`, `spent ↦ spent` | spent absorbs | `use_once_is_the_cone`, `NullCell/LinearResource.lean` |
| carrier | cross-carrier merge ↦ residue | one carrier | `mismatch_is_null`, `NullCell/BoundaryTyping.lean` |

Graded honestly in `DESIGN.md:106-121`: **the shape is `anchor`; the three rows are `L1`.** Each
theorem is real and holds as quoted; what is not proved is that the three axes are one object.
`MandalaMemory.lean` imports `Mathlib.Data.Nat.Bitwise` and nothing from `NCell`; `BoundaryTyping.lean:23`
says in its own words "This is **NOT a Null Cell derivation**." What the axes share is a design
move, and that is enough to organise the work; it is not a theorem and does not license citing one
axis's result for another.

The state is **one table, one operation** (`DESIGN.md` §3.5):

```
insertWith f k v m        the only mutation. f merges the new value with the old
get m k                   the only read
```

| face | merge | is |
|---|---|---|
| Set | idempotent, `a or b` | membership, occupancy, presence |
| Map | replace, last write | lookup, the value |
| Accumulator | a monoid, `+` | counting, combining, the field |
| Graph | `++` over keys | links, adjacency |

The proved theorems (from `../sanguine/proof/Substrate/Algebra/Security/HashTrinityCore.lean`):
`merge_is_the_only_freedom` (`:98`: two pointwise-equal merges build the same map), `get_build_acc`
(`:171`: reading a built table at a key is a fold of the merge over that key's values),
`build_gauge_invariance` (`:195`: for a commutative-associative merge any permutation of the
insertion stream builds the same function). **The ordering licence is the merge's proved
properties, not its face name**: "idempotent" does not imply commutative (`f a b = a`), and "a
monoid" does not either (`++` is the design's own non-commutative monoid) (`DESIGN.md:306-309`).
This is the first face-mismatch warning: a build over a merge that is not commutative-associative
is not gauge-invariant, and neither is the record built over it.

The accumulator face, applied to estimation, is the Kalman filter: the estimate is
`μ = η/τ = B/U` (information over precision), fusion is the commutative monoid `fuse`, and the
update `x̂ = x̄ + K(y−x̄)` with gain `K = τ₂/(τ₁+τ₂)` is recovered from the merge
(`kalman_update_from_merge`, `HashTrinityCore.lean:246`). The count-confidence weight
`w = n/(n+α)` is the BLUP identically (`blup_is_countWeight`, `:298`), is the unique risk
minimiser, and every count deflation `m < n` is strictly worse (`deflation_strictly_suboptimal`,
`:408`); every `n`-independent deflation is only `α ↦ α/φ` (`deflation_is_reparametrisation`,
`:429`); the design-effect deflation caps the weight at `(1+α)/(1+2α) < 1` forever
(`deflated_weight_ceiling`, `:494`). **An `n`-independent correction of the count is a
reparametrisation, not a fix.** The fold measured that ceiling: the deflated form converged to
`9/17 = 0.529` at `α = 8` against the BLUP's `0.9992` at `n = 10⁴` (`HashTrinityCore.lean:62-65`).

### 4.2 Scribe, propose, dispose (`SCRIBE-PORT.md` §12, §12b)

Scribe's game state was the same one table, each subsystem a merge
(`SCRIBE-PORT.md:418-425`): inventory = `merge_bu` (quantities add), vitals = add-then-clamp
(`(current + delta).clamp(0.0, max)`, `game_state_service.rs:203`), quests/location/time =
`merge_b` (last write), NPC states = `merge_graph`, flags = `merge_nb`. **`StateChange` is not an
enum of eleven special cases, it is a key plus a choice of `f`, and `reconcile` is
`insert_with`** (`SCRIBE-PORT.md:427-428`).

The design property worth stealing, and the authority model fold later rebuilt:
`reconcile(current_state, new_state, player_action)` has the model propose a *complete* new state,
then validates it against the current one and **rejects impossible changes** (`ReconciliationResult`
carries `applied_changes`, `rejected_changes`, `warnings`). "The model proposes; the merge
disposes. That inversion is what keeps a hallucinated 'you now have 900 gold' out of the ledger,
and it is the hashtrinity thesis applied to game state, **the authority is `f`, not the
generator**" (`SCRIBE-PORT.md:451-456`). Its `staleness_count` (each cycle increments a counter on
every item the narrative did *not* mention; past a threshold it is a removal candidate) is the
Count face used as decay (`SCRIBE-PORT.md:458-462`).

**What Scribe learned the hard way, recorded as a general lesson:** a model counting n-grams can
tell you text is *unusual*; it cannot tell you it is *important*, bits/byte measured vocabulary
novelty, not narrative significance (the filler/event separation was an artefact of the test
cases; `SCRIBE-PORT.md:561-582`). Anything wanting "something happened" needs semantics, i.e. a
reader.

### 4.3 fold, the reconcile pass (`public/scripts/extensions/sanguine/`)

The current medium. The state is the hashmap trinity in JS (`lib/hash.js`): one operation
`insert_with(m, f, k, v)`, the merge `f` the only freedom, four merges (`merge_nb`/`merge_b`/
`merge_bu`/`merge_graph`, `hash.js:23-45`). The inventory table's own merge
(`state-table.js:1203`):

```
merge_qty = (nu, old) => ({
  qty: max(0, min(maxQty(nu.at ?? old.at), (old.qty ?? 0) + (nu.dq ?? 0))),
})
```

, an accumulator with a ceiling that depends on the place (`maxQty` reads `at` off the key).
The ceiling itself is a place-tagged serialization guard, not a play limit (`state-table.js:372-389`).

The reconciliation vocabulary, the shared extraction probe's delta schema
(`state.js:1332-1430`), carries **identity** and **the merge** as separate fields:

```
item        the thing, in the story's own words, never a category several things were summed into
same_as     the EXACT held name this is a different spelling of; empty otherwise
dq          change in quantity (positive gained, negative lost)
set         the absolute total now held, ONLY when the story states it outright
magnitude   the quantity the narrative actually states; 0 when none
at          carried | a place | assets | abilities | money
how         bought | given | found | taken | made | lost
who         whose, when not the viewpoint character's
rank        the grade, copied exactly as written, fold never orders two ranks
```

The two safety properties of the whole design (`reconcile-table.js:33-53`):

1. **A value reaches the record only through a diff the player ticks.** The first cut forbade
   values entirely (an enum and an id, never a number) on the Xianxia measurement: 25 absolute
   `set` against 12 relative `dq`, and narrator-stated balances agreeing with the ledger 33% of
   the time, worst gap 2604. But that measurement condemns values adopted *silently*; a value
   that is proposed, evidenced, and applied only on confirmation is a different mechanism, and it
   is the only one that reaches the faults removal cannot fix (`reconcile-table.js:35-42`).
2. **Every non-`keep` verdict needs positive evidence.** There is no "never true" in the
   vocabulary: a model failing to find something in a window is not evidence it never happened,
   and that distinction has a body count: `cap:stale-hidden` fired 540 times hiding items that
   were in the character's pockets, and was retired on exactly this reasoning, **citing
   `BayesFilter.zero_residual_is_fixed`** (`reconcile-table.js:44-49`). "Silence is a zero
   residual." Fold never *reads* the evidence; a non-empty string is structure, judged by the
   player in the diff.

The verdict vocabulary (`reconcile-table.js:76-83`): `keep`, `gone`, `rename`, `amount`, `move`,
`merge`, `split`: deliberately no "this was never true": *"A pass may repair the record; only
the player may `forget` it"* (`reconcile-table.js:73-74`).

The reconcile pass itself (`reconcile.js`): reads a 60-message window, poses the live record as
numbered lines (`STILL TRUE?`), asks the model to justify **keeping** each row rather than
dropping it, the prior is inverted because a per-turn review "defaults to keeping, which is what
the 0.14% closure rate costs" (`reconcile.js:27-31`). Repairs route through the writers that
already exist; the order is the dependency order, not the answer order: SPLIT first (creates
rows), then MERGE (collapses), then RENAME/MOVE/AMOUNT (field edits on the survivor, so "the
story's number wins over the arithmetic"), then GONE last (retractions land on keys that still
exist) (`reconcile.js:245-265`).

---

## 5. The measured failures, the reconciliation wall

Every failure below is a measurement, with its instrument named. Each is the same algebraic shape
as a failure in another medium, and each maps to an equation in §1, §3.

| # | failure | measured | medium | the equation it sits on |
|---|---|---|---|---|
| 1 | **ammunition x29**, three magazines, twenty-five buckshot shells and a box of birdshot summed into one mass noun | `{"item":"ammunition","dq":28}` at turn 23 (`state.js:1342-1343`); the player unpicked it by hand | fold | `merge_bu` applied before identity was resolved, an accumulator merge assumed one key was one thing. The schema's own fix: "9mm magazines, buckshot shells and 9mm rounds are three items, not one ammunition" (`state.js:1347`) |
| 2 | **re-assertion double-count**, phone numbers landed twice (carried and contacts), the goblin knife twice, because overlapping windows re-read the same beat | mids 50/52/54, `FOLD-RPG-GAP.md` §4 | fold | `merge_bu` on a presence restatement, the merge face for "still held" is Set (idempotent), not Accumulator. "An entry with dq 0... changes nothing: omit both" (`state.js:1576`) |
| 3 | **money ₩9,999**, a ₩360,000 raid share clamped to the item ceiling | `{"item":"won","dq":360000}` with no `at` (`state-table.js:1231-1236`); `MAX_MONEY` correct and unreachable | fold | `merge_qty`'s ceiling reads `at` off the key; a missing `at` made the money path unreachable. A tagging failure, not arithmetic, the delta instruction's job, "not a currency word list here" |
| 4 | **review closure 4/2,840 (0.14%)**, the per-turn review never closes a thread | 16 of 16 threads still open | fold | the review is the Set face: `merge_nb` is monotone, membership cannot be retracted. The reconcile pass exists because the record "goes wrong in ways no per-turn mechanism reaches" (`reconcile-table.js:8-11`) |
| 5 | **Kang twice**, `"kang" ≠ "kang min-seo"`, exact-string keys, alias scan short-circuited once both keys exist | `person␀c-rank team leader` and `person␀kang`, two places, both wrong (`FOLD-RPG-GAP.md` §2) | fold | identity resolved by the total-function key *before* the merge, no collision, nothing for a discriminant to be about (`STRUCTURE.md:8-12`). The corpus's law: a carrier map preserves state iff it is a merge homomorphism (`map_state`); an arbitrary renaming is not one |
| 6 | **stale-hidden 540**, carried items hidden after 12 turns of silence | `cap:stale-hidden: 97` in the Solo Leveling chat, 540 over the campaign (`FOLD-RPG-GAP.md` §4) | fold | `zero_residual_is_fixed` (`BayesFilter.lean:91`, `kalmanUpdate x K x = x`), absent new evidence, belief holds **exactly**. Silence is a zero residual; treating it as a retraction is dividing by zero on the cone (`null_not_invertible`) |
| 7 | **narrator balances agree 33%, worst gap 2604**, 25 absolute `set` against 12 relative `dq` | Xianxia retrospective (`reconcile-table.js:36-41`) | fold / Scribe | `set` (Map face, replace) and `dq` (Accumulator face, add) are different merges. The model's absolute numbers disagreed with the fold's accumulated ones; `build_gauge_invariance` does not license reordering a replace |
| 8 | **80 asked, 0 applied**, the reconcile modal priced Apply at up to forty blind fiction-recall judgements over the record it was judging, Cancel at one click for no visible loss | `reconcile:asked: 80, reconcile:declined: 2, reconcile:applied: 0` (`reconcile.js:8-14`) | fold | the retraction path gated behind a one-way door, the cost gradient killed it. The fix: conserving repairs (rename/move/split) apply on sight into a visible undoable ledger; destructive ones (gone/merge/amount) become single durable asks |
| 9 | **nothing can be closed**, nine leads that cannot close, seven people who cannot leave, two clocks that cannot stop | `FOLD-RPG-GAP.md` §1 | fold | the temporal axis (`use_once_is_the_cone`) is the only axis with a residue; every other table is a stored monotone membership. "The retraction event is something a narrator never bothers to say", derive, don't store |
| 10 | **Scribe's `rejected` vector went dead; staleness became decay** | `SCRIBE-PORT.md` §12, §19 | Scribe | propose/dispose without the merge being the authority drifts; a decay that is a one-way door is the same error as fold's stale-hidden |
| 11 | **Marinara's tags trusted**, every transition legal, no validator | `state-machine.service.ts` is 21 lines, `isValidTransition` returns true for any pair (`SCRIBE-PORT.md` §19) | adjacent | the DSL is a transport optimisation; without the propose/dispose validator it is the same failure as Scribe's dead `rejected` vector, arrived at from the other direction |

Rows 1 and 2 are the same defect twice: the accumulator merge applied where identity was
unresolved or presence was re-asserted. Rows 4 and 9 are the same defect: the Set face, monotone,
cannot retract. Rows 6 and 10 are the same defect: a zero residual read as a licence to forget.
Row 5 is the load-bearing one: the total-function carrier erases the collision before the
decision can be made.

---

## 6. What the equations say is wrong

Three proved facts about the reconciliation operation, then one reading. Each medium failed
because it picked the wrong one of these to solve.

**1. The merge is the only freedom, and a wrong merge is a different program.**
`merge_is_the_only_freedom` (`HashTrinityCore.lean:98`): the table is fixed, `f` is the meaning.
`reinterpret_breaks_meaning` (`BoundaryTyping.lean:180`) proves by computation that a
non-homomorphic reinterpret changes the answer, `state (·*·) (map id (K 2 3)) = 6 ≠ 5`. Rows 1, 3
and 7 are face mismatches: an accumulator merge applied to distinct items, to presence
restatements, to a balance whose `at` tag was missing. None of these is a bug in the merge; each
is the wrong choice of `f`, which the schema now forces the model to make field by field (`dq`
vs `set` vs `same_as`).

**2. The reconciliation decision lives on the null cone, and division is singular there.**
`x = B/U` is the state; `d(B/U) = 0 ↔ U·dB = B·dU` is the stationary point, the record and the
narrative agree. The failure is when they cannot be brought to a ratio: the cone, where
`N = 0` and **`¬∃w, (1+j)·w = 1`** (`NullCell.lean:178`). The cone is closed under the product
(`nNorm_mul`), so once a thing is on it, nothing carries it off (`spend_stays_on_cone`). The
failures are all incommensurability read as division: silence read as retraction (row 6), a
different spelling read as a different row (row 5), a distinct item read as a quantity (row 1).
`zero_residual_is_fixed` is the exact statement the fold cites for this: a zero residual is
*fixed*, never free (`BayesFilter.lean:91`).

**3. Retraction is not expressible in the merge.** The four faces have no inverse. `insertWith`
is not invertible, and the only place "removal" exists in the algebra is the temporal axis,
`spent` absorbs, `reuse_is_null`, `use_once_is_the_cone` (`LinearResource.lean`). The cone is a
one-way door. That is why every per-turn write gate fails to repair an already-wrong record, why
the review never closes (rows 4, 9), and why the reconcile pass had to exist: the record "goes
wrong in ways no per-turn mechanism reaches" (`reconcile-table.js:8-11`). The only media
invention that closes the door's cost is the two-lane reconcile: conserving repairs land on sight,
destructive ones wait as single answers (`reconcile.js:14-19`).

**The strongest form, stated as a reading.** The apeiron-rebuild's finding that "a total function
has no degeneracy, so there is nothing for a discriminant to be about" (`STRUCTURE.md:8-12`) is a
description of the fold's record, Scribe's record, and every hand-rolled inventory. A total
function resolves identity before the type exists: every spelling is already its own key,
collisions are resolved by the key constructor, and any commutative monoid then merges
"identically." Rows 1 and 5 are not merge bugs; they are the degeneracy the total-function
carrier erases. The reconciliation decision, *are these the same thing*, cannot live in a
carrier with no degeneracy, so each medium rebuilt it as a bolted-on discriminator: `canonicalKey`
exact-string sets (which Kang defeated, row 5), `same_as` (which works because the model resolves
it, `state-table.js:1246-1251`), the review probe's `[same?]`, the coverage report. **The model
is the discriminant the total-function table lacks.** That is the corpus's own answer,
"Identity is the model's answer, never fold's" (`state-table.js:1246`), and the algebra's own
law: the only meaning-preserving crossing is a homomorphism (`map_state`), and choosing the
homomorphism is choosing the identity.

The candidate that fixes the carrier rather than bolting on a discriminator, from the rebuild
itself, is not built: **the key is a path, the table is a Tower, a collision is two paths reaching
the same value** (`STRUCTURE.md:93-107`), and `state_node_of_disc_nonpos`: at `σ ≤ 0` every node
reads `0` or `1` whatever its subtrees, is exactly what the fold's monotone tables are: total
collision, no information. Under that reading, the split-complex cone is not the failure of
reconciliation; it is the mechanism of it, the degenerate table is where two paths that mean one
thing land, and the model (the only reader of the language) is what resolves which. The measure
of a reconciliation system is not how well it merges; it is **whether it can lose, without being
able to lie**, whether the one-way door has a separate, cheap, human-authorized exit, and whether
identity is decided by the reader of the language rather than by the key constructor.

---

## 7. Grades, what is proved, what is read, what is open

**Proved (machine-checked, cited above):** the cell's equations (§1), the universal equation and
its differential/stationary consequences (§2), the trichotomy classification and the channel
theorems (§3), the hashmap trinity's `merge_is_the_only_freedom` / `get_build_acc` /
`build_gauge_invariance` (§4.1), the Kalman/BLUP identities including the deflation ceiling,
`map_state` / `mismatch_is_null` / `reinterpret_breaks_meaning` (§1, §2), `use_once_is_the_cone`
and the aliasing boundary (`LinearAliasing.lean`), `zero_residual_is_fixed`.

**Anchor (readings, stated as readings):** that the null cell is the "−1 timelike slot" and the
word "time" is a dictionary for its `(1,1)` (`NullCell.lean:11-12`); that "type-safety is a
corollary of the Term/merge/null structure" (`BoundaryTyping.lean:23-26`: its own SCOPE block
says it is NOT a cell derivation); that song's three collapse axes are one design move and not one
theorem (`DESIGN.md:106-121`); that "the model is the discriminant the total-function table
lacks" and "the table is a Tower, the key a path" (§6, from `STRUCTURE.md:93-107`).

**Open, named:** that a Tower-based table (collision as the algebra's own degeneracy) actually
fixes the fold's failures, `STRUCTURE.md:105-107` says in its own words "None of the previous two
paragraphs is a theorem... This is the next thing to build." Also open: the claim that the
reconciliation problem is *only* an identity problem, the measured failures also include
real arithmetic errors (row 3), which no identity resolution fixes.

**The one docblock known to be wrong, recorded rather than erased** (`invariant-table.js:29`):
the invariant record carries the two wrong numbers it published, as the corpus's rule that a
docblock that turns out wrong is a defect equal to wrong code, corrected in place.
