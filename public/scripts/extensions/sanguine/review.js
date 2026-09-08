/**
 * fold/review.js: the review pass, persisted.
 *
 * The pure half is `review-table.js`: what to ask, and what an answer means. This half owns the
 * three things that have to survive a reload, which questions have already been answered, which
 * acquisitions are still waiting on a price, and the ledger events a closure becomes, plus the
 * writes themselves.
 *
 * Why this is a separate module from `state.js`.
 *
 * `state.js` builds the pinned block, so it needs to know what questions are outstanding; applying
 * an answer needs `validateDelta`, which lives in `state.js`. That is a cycle, and the way out is
 * the one `chronicle.applyExtraction` already uses: the validator is a PARAMETER. `state.js` imports
 * this module for `pending()`; this module imports nothing from `state.js` and takes the validator
 * from its caller. `index.js` is the only place that knows about both, which is what `index.js` is.
 */

import { insert_with, lookup, merge_b, table_entries } from './lib/hash.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import { CARRIED, MONEY, splitItemKey } from './state-table.js';
import { PERSON, resolveEntity } from './entity-table.js';
import { resolveThread } from './thread-table.js';
import { DIFFERENT, SAME, askableOwed, describePlan, outstanding, pairKey, planReview, resolveCurrencyKey, suspectedPairs } from './review-table.js';
import { commit, loadTable, loadValue, commitValue } from './store.js';

/**
 * Identity questions already answered, and how.
 *
 * Remembering `different` is as load-bearing as remembering `same`.
 *
 * A confirmed merge never has to be re-asked because the rows are one row afterwards, the question
 * cannot be generated again. A confirmed `different` leaves both rows standing, so the detector
 * raises the same pair on every single pass forever unless the answer is stored. The detector is
 * deliberately loose (`thread-table.js` `nearIdentity`: "a trigger for a question, never a
 * decision"), which means false pairs are expected and a mechanism that re-asks them is a mechanism
 * the reader learns to ignore. `Lord Everard` / `Lillian Everard` is the measured example, a
 * family, not a person, and the detector's docblock says so.
 */
const ANSWERS_PATH = 'state.answers';

/** The credits-without-debit question, waiting for the next pass to ask it. */
const OWED_PATH = 'state.owed';

/** Migration's own questions, written once by `migrate.js` and consumed here. */
const MIGRATED_PATH = 'state.migrated';

/**
 * Pairs the model volunteered, waiting to be asked back.
 *
 * `nearIdentity` can only raise a restatement, it is a token-subset test, correctly so, and
 * measured at ZERO pairs over 231 on the live New Eldoria table. The model reads the same list and
 * can say "these two are one stake" about names sharing no tokens; `same_thread`/`same_person`
 * collect that. It lands HERE rather than in `plan.merges` because a merge rewrites a table and a
 * wrong one cannot be undone by silence (`entities.js`), so a volunteered pair is asked back with
 * an id and merged only once confirmed.
 *
 * `outstanding` already drops anything `state.answers` has settled, so nothing here needs clearing:
 * a pair answered either way stops being surfaced on the next pass and ages out under the bound.
 */
const SUSPECTED_PATH = 'state.suspected';

/**
 * How many volunteered pairs are kept.
 *
 * The Graph face, bounded, oldest dropped first, the same shape and the same reasoning as
 * `MAX_TRAIL` and `MAX_SHADOW`. A pair that is never confirmed is a pair the model stopped
 * believing in; holding a hundred of them would spend the review's budget on suspicions instead of
 * on the stakes. Twelve is the review's own question budget twice over.
 */
export const MAX_SUSPECTED = 24;

/** @returns {Map<string, object>} pair key -> `{of, a, b, at}`. */
export function suspected() {
    return loadTable(SUSPECTED_PATH);
}

/**
 * Keep the pairs the model volunteered this pass.
 *
 * Keyed by the pair itself, so a model that names the same two lines every turn occupies one slot
 * rather than flushing the table, `noteShadow`'s rule, for the same reason.
 *
 * @param {Array<{of: string, a: string, b: string}>} pairs From `planReview`'s `suspected`.
 */
function noteSuspected(pairs) {
    const list = (Array.isArray(pairs) ? pairs : []).filter(pair => pair?.a && pair?.b);
    if (!list.length) {
        return;
    }
    const table = suspected();
    for (const pair of list) {
        insert_with(table, merge_b, pairKey(pair.a, pair.b), { of: pair.of, a: pair.a, b: pair.b, at: Date.now() });
    }
    const kept = [...table_entries(table)].slice(-MAX_SUSPECTED);
    commit(SUSPECTED_PATH, new Map(kept));
}

/** @returns {Map<string, object>} pair key -> `{answer, at}`. */
export function answers() {
    return loadTable(ANSWERS_PATH);
}

/**
 * Record how an identity pair was answered.
 * @param {string} a One key.
 * @param {string} b Another.
 * @param {string} answer SAME or DIFFERENT.
 */
function remember(a, b, answer) {
    const table = answers();
    insert_with(table, merge_b, pairKey(a, b), { answer, at: Date.now() });
    commit(ANSWERS_PATH, table);
}

/**
 * The credits-without-debit question, or null when there is none or it has gone stale.
 *
 * Expiry is applied on READ rather than by a sweep, for the reason every bound in this codebase is:
 * a question nobody asks costs nothing to leave on disk, and a pruner that has to run for
 * correctness is a pruner that will one day not have run. The horizon and the measurement behind it
 * are `review-table.js` `askableOwed`, which is where a decision about what to ask belongs.
 *
 * @param {number} [now] The turn to age against; defaults to the live one.
 * @returns {object|null} The question, or null.
 */
export function owed(now = entities.turn()) {
    return askableOwed(loadValue(OWED_PATH, null), now);
}

/**
 * Note that a pass recorded a purchase with nothing paid.
 *
 * Called with what the pass ACCEPTED and what it REFUSED, because both are evidence: `reject:
 * already-recorded` refuses a genuine same-name re-buy and the refusal plus a payment in the window
 * is exactly the trigger shape (`state-table.js` `creditsWithoutDebit`, which now also decides that
 * the model called the thing a purchase before either counts).
 *
 * The balance is captured here rather than at ask time, and deliberately: the question is about a
 * moment, *these were bought, and this is what you had*, and re-deriving the balance a pass later
 * would print a number that has since moved for unrelated reasons.
 *
 * The accumulation survives the trigger fix, and it survives it stronger.
 *
 * The merge was justified by a purchase narrated over several turns: the Goblin Market haul was
 * billed at mids 60, 66 and 68, and asking only about the newest slice would let the earlier items
 * slip past unpriced. It was a bad bargain while the list was mostly loot, an accreting list of
 * things nobody bought is a question that gets *less* answerable the longer it runs, and the corpus
 * shows exactly that: Solo Leveling asked "won, darkwood staff, shortsword, bracers, greaves,
 * gloves, trauma kit, coagulant" for ten passes, eight items at the cap, one of them the currency
 * itself. Every member of that list is now something the model said it PAID for, which is the case
 * the merge was written for and the only case it holds.
 *
 * What does not survive is the unbounded lifetime. A stale question is replaced rather than merged
 * into, so an expired list cannot resurrect itself by accreting one fresh item, the mechanism that
 * kept `torch` on screen for eleven passes. See `OWED_TURNS` for the distribution behind the bound.
 *
 * @param {object} params Parameters.
 * @param {string[]} params.items Items bought with no debit; empty leaves the question alone.
 * @param {number} params.balance The balance on record right now.
 * @param {string} params.currency What the balance is denominated in.
 * @param {number} [params.turn] The turn this was raised on, for the horizon.
 */
export function noteCredits({ items = [], balance = 0, currency = '', turn = entities.turn() } = {}) {
    if (!items.length) {
        return;
    }
    const held = owed(turn);
    const merged = [...new Set([...(held?.items ?? []), ...items])].slice(0, 8);
    commitValue(OWED_PATH, { items: merged, balance, currency, turn, at: Date.now() });
}

/** Forget the money question, it has been answered, or a debit landed on its own. */
export function clearOwed() {
    commitValue(OWED_PATH, null);
}

/**
 * The questions this pass should ask, already filtered against what is on record.
 *
 * @returns {{identity: object[], polarity: object[], owed: object|null}} Outstanding questions.
 */
/**
 * A readable name for an inventory key, for the question text.
 *
 * The key carries the place ("money", "carried") and the place is what makes the question
 * answerable: "are money/silver and carried/silver wen the same?" is a different question from
 * "are silver and silver wen the same?", and the model needs the first one.
 *
 * @param {string} key An inventory key.
 * @returns {string} The label.
 */
function itemLabel(key) {
    const { place, name } = splitItemKey(String(key ?? ''));
    return place && place !== 'carried' ? `${name} (${place})` : name;
}

export function pending({ itemQuestions = [] } = {}) {
    const settled = answers();
    const cast = new Map(table_entries(entities.load()));
    const threadRows = new Map(table_entries(clocks.load()));

    const identity = outstanding([
        ...entities.questions().map(pair => ({ ...pair, of: 'cast' })),
        ...clocks.questions().map(pair => ({ ...pair, of: 'thread' })),
        // Item questions, and the only source that costs nothing to find.
        //
        // Threads and cast raise identity pairs from a detector walking their tables. Inventory has
        // no table to walk, it is a fold over the chronicle (`state.deriveState`), so items were
        // never asked about at all, which is why `money silver` and `carried silver wen` can sit as
        // two rows of one currency for 277 messages with nothing ever questioning it.
        //
        // `state.auditLedger()` supplies them from the conservation check instead: a token overlap
        // between a money row and another row is a QUESTION, raised for free during play. Answered
        // `same` it names the split; answered `different` it is a minority label, which is the class
        // the resolver's witness set has three of in seventy-six.
        ...itemQuestions.map(pair => ({ ...pair, of: 'item' })),
        // The pairs the model volunteered, the fifth source, and the only one that can raise
        // a pair sharing no tokens. Resolution is pure (`suspectedPairs`); the tables are ours.
        ...suspectedPairs(suspected(), {
            resolve: (of, name) => (of === 'cast'
                ? resolveEntity(cast, PERSON, name)?.key ?? null
                : resolveThread(threadRows, name)?.key ?? null),
        }),
        // Migration's questions, including the cross-table one the §2 detector provably cannot
        // reach, `{hunter, residency, twenty, d-rank, raids}` against `{residency, window, closes}`
        // is neither a subset nor one substitution, because two tables that were never keyed
        // against each other have no reason to word a stake alike (`migrate.js` identityQuestions).
        ...migrated().identity.map(pair => ({ ...pair, of: pair.kind === 'cast' ? 'cast' : 'thread' })),
    ], {
        answers: settled,
        // Item pairs are inventory KEYS, and inventory is derived rather than stored, so there is no
        // table to test membership against. The audit only raises pairs it just read off the
        // derived ledger, so they exist by construction.
        exists: (pair, side) => (pair.of === 'item'
            ? true
            : (pair.of === 'cast' ? cast : threadRows).has(pair[side])),
    })
        .map(pair => ({
            ...pair,
            names: pair.of === 'item'
                ? [itemLabel(pair.a), itemLabel(pair.b)]
                : pair.of === 'cast'
                    ? [cast.get(pair.a)?.name ?? pair.a, cast.get(pair.b)?.name ?? pair.b]
                    : [threadRows.get(pair.a)?.name ?? pair.a, threadRows.get(pair.b)?.name ?? pair.b],
        }));

    const polarity = migrated().polarity
        .filter(flag => threadRows.has(flag.thread))
        .map(flag => ({ ...flag, name: threadRows.get(flag.thread)?.name ?? flag.thread }));

    return { identity, polarity, owed: owed() };
}

/** @returns {{identity: object[], polarity: object[]}} The migration's outstanding questions. */
function migrated() {
    const stored = loadValue(MIGRATED_PATH, null);
    return {
        identity: Array.isArray(stored?.identity) ? stored.identity : [],
        polarity: Array.isArray(stored?.polarity) ? stored.polarity : [],
    };
}

/**
 * Drop questions the migration raised once they have been answered.
 * @param {object} params What was answered.
 * @param {Array<{a: string, b: string}>} [params.pairs] Identity pairs.
 * @param {string[]} [params.threads] Thread keys whose polarity is settled.
 */
function retireMigrated({ pairs = [], threads = [] } = {}) {
    const stored = loadValue(MIGRATED_PATH, null);
    if (!stored || typeof stored !== 'object') {
        return;
    }
    const asked = new Set(pairs.map(pair => pairKey(pair.a, pair.b)));
    const done = new Set(threads);
    commitValue(MIGRATED_PATH, {
        ...stored,
        identity: (Array.isArray(stored.identity) ? stored.identity : []).filter(pair => !asked.has(pairKey(pair.a, pair.b))),
        polarity: (Array.isArray(stored.polarity) ? stored.polarity : []).filter(flag => !done.has(flag.thread)),
    });
}

/**
 * Apply a review fragment.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {Map<string, object>} [context.review] The id index the pinned block built this pass.
 * @param {Array<{key: string, mid: number}>} [context.sources] Window sources, newest last.
 * @param {string} [context.windowText] The new half of the window.
 * @param {number} [context.turn] Turn counter.
 * @param {Function|null} [context.validateDelta] `state.validateDelta`, injected, see the header.
 * @param {Function|null} [context.onContest] Called with each lock answer.
 * @param {Function} [context.ledgerKeys] Returns the inventory keys the ledger holds, for resolving
 *   a currency name the model reported to the row it names. Injected for the same reason
 *   `validateDelta` is: the derived ledger lives in `state.js`, which imports THIS module.
 * @returns {object} What was applied.
 */
export function applyExtraction(fragment, {
    review = new Map(), sources = [], windowText = '', turn = 0, validateDelta = null,
    onContest = null, onClearMark = null, ledgerKeys = () => new Set(), onClassify = null,
    visible = null,
} = {}) {
    if (!review.size) {
        // Nothing was asked, so nothing can be answered. Distinguished from "asked and ignored",
        // which is the measurement §12 wants: a review that is never posed and one that is posed
        // and rubber-stamped are different failures with different remedies.
        observe.note('review:none');
        return { asked: 0, settled: 0, merged: 0 };
    }
    observe.note('review:asked', review.size);

    // `windowText` so every refusal carries the excerpt it was read from, the same diagnostic
    // the inventory and mark validators have always attached.
    const plan = planReview(fragment, review, { windowText });
    const threadTable = clocks.load();
    const names = new Map(table_entries(threadTable).map(([key, row]) => [key, row?.name ?? key]));

    // Closures first, and as ONE event.
    //
    // Anchored on the newest live message this pass read, which is what makes a swipe undo it:
    // that message's content key is the event's liveness key, and `overlayClosures` sees only the
    // closures whose events are live (`thread-table.js`, the swipe scenario in full).
    const anchor = sources[sources.length - 1];
    if (plan.closures.length && anchor?.key) {
        chronicle.recordReviewEvent({
            summary: describePlan(plan, names) || 'Review settled tracked lines',
            keywords: plan.closures.map(closure => names.get(closure.key) ?? closure.key),
            delta: { threads: plan.closures.map(({ key, status }) => ({ key, status })) },
            srcKey: anchor.key,
            mid: anchor.mid,
        });
        for (const closure of plan.closures) {
            observe.note(closure.status === 'moot' ? 'review:moot' : 'review:settled');
        }
    }
    if (plan.advanced.length) {
        observe.note('review:advanced', plan.advanced.length);
    }
    if (plan.kept) {
        observe.note('review:kept', plan.kept);
    }

    // Merges are writes, and each leaves an audit event.
    let merged = 0;
    const castTable = entities.load();
    for (const merge of plan.merges) {
        // An item `same` is applied by the FOLD, not by a table rewrite.
        //
        // Cast and thread merges rewrite a stored table. Inventory has none: it is a fold over the
        // chronicle, so merging two item keys means relabelling the event stream. `remember` is
        // therefore the whole of the write, `crosswalk.js` reads `state.answers` on every derive
        // and relabels the keys as it folds (`KeyResolution.relabel`, sound late because quantities
        // sum). The next render shows one row.
        //
        // Still `continue`, and not because the answer is being deferred: falling through to
        // `clocks.merge` with an inventory key would look up a thread that does not exist.
        if (merge.of === 'item') {
            remember(merge.a, merge.b, SAME);
            observe.note('review:item-same');
            continue;
        }
        const done = merge.of === 'cast'
            ? entities.merge(merge.a, merge.b)
            : clocks.merge(merge.a, merge.b);
        remember(merge.a, merge.b, SAME);
        if (!done) {
            continue;
        }
        merged++;
        observe.note('review:merged');
        chronicle.recordReviewEvent({
            summary: `Confirmed one ${merge.of === 'cast' ? 'person' : 'thread'}: ${labelOf(merge, castTable, names)}`,
            keywords: [String(done.key).split('\u0000').pop(), String(done.dropped).split('\u0000').pop()],
            srcKey: anchor?.key,
            mid: anchor?.mid,
        });
    }
    for (const pair of plan.different) {
        remember(pair.a, pair.b, DIFFERENT);
        observe.note('review:different');
    }
    // Volunteered pairs, kept for the next pass to ask with an id. Counted, because a field that
    // never fires and a field that fires and resolves to nothing are the same silence otherwise.
    if (plan.suspected?.length) {
        noteSuspected(plan.suspected);
        observe.note('review:suspected', plan.suspected.length);
    }
    // What each card-invented status field is. Injected like `validateDelta`, for the same reason:
    // the sheet lives in `state.js`, which imports THIS module.
    if (plan.sheet?.length && onClassify) {
        observe.note('review:classified', onClassify(plan.sheet));
    }
    retireMigrated({
        pairs: [...plan.merges, ...plan.different],
        threads: plan.polarity.map(flag => flag.key),
    });

    // Where an unplaced person actually is. The answer to the question `castAt` used to answer by
    // guessing (`entity-table.js`, the three-valued note): a place on the row is a place the
    // presence predicate can compare, so the next render puts them in the room or out of it on
    // evidence rather than on a default.
    // The currency reading, remembered as an item verdict.
    //
    // `plan.currency` is the model's answer to the one identity question fold cannot raise for
    // itself: it read the pinned Money block and named two lines as one currency. Recorded under
    // the same keys the ledger uses, which is what the crosswalk relabels on, and counted so
    // `/fold-calibrate` can say whether the field ever fires.
    //
    // This one costs no question slot at all, unlike every other identity answer, it was
    // volunteered rather than asked, so it is the cheapest label fold receives.
    //
    // The name has to be resolved against the ledger, not assumed to be at `money`.
    //
    // This loop used to key both sides `itemKey(name, MONEY)`, on the reasoning that the Money block
    // only renders money-place rows so both names must be money-place. Measured on a live replay,
    // that reasoning is wrong twice over:
    //
    //   · The model answered `{"a":"silver wen","b":"silver"}` on a pass whose prompt had NO Money
    //     line at all, only `Carrying: dagger, bow`. It read the story, not the block. The answer
    //     was correct, and the assumption that produced the key was not.
    //   · Wuxia's real split holds `silver wen` at `carried` and `silver` at `money`. Forcing both to
    //     `money` produced `money␀silver wen`, a key the ledger has never held, so the crosswalk's
    //     `known` filter dropped the correct answer on the floor, silently, which is the worst way
    //     to be wrong.
    //
    // So the name is looked up in fold's own key space instead: exact equality against the normalized
    // item names the ledger actually holds. That is STRUCTURE, no tokenizing, no substring, no
    // morphology, and it means the same thing in every script. `money` wins a tie because a currency
    // belongs there, and a name held at two other places at once is ambiguous and refused outright:
    // an unresolvable answer must not become a confident merge.
    const keys = ledgerKeys();
    for (const pair of plan.currency ?? []) {
        const a = resolveCurrencyKey(pair.a, keys);
        const b = resolveCurrencyKey(pair.b, keys);
        if (!a || !b || a === b) {
            // Counted, because a field that fires and resolves to nothing is indistinguishable from
            // a field that never fires, and the difference decides whether the instruction or the
            // lookup is at fault.
            observe.note('review:currency-unresolved');
            continue;
        }
        remember(a, b, SAME);
        observe.note('review:currency-same');
    }

    for (const placement of plan.places) {
        if (entities.setPlace(placement.key, placement.place, turn)) {
            observe.note('review:placed');
        }
    }

    for (const flag of plan.polarity) {
        if (clocks.set(names.get(flag.key) ?? flag.key, { kind: flag.kind, turn })) {
            observe.note('review:polarity');
        }
    }

    // A healed mark is an event, not a deletion.
    //
    // Marks derive from the ledger (`state-table.js` `deriveState`, the swipe argument), so the
    // review clears one by APPENDING an `st` delta with `on: false`, anchored on the same message as
    // the closures above. Swipe that message and the healing un-happens with the turn that described
    // it, the same property `overlayClosures` buys threads, with no overlay needed. The writer is
    // injected for the header's reason: `state.js` owns `validateDelta` and imports this module.
    // A disposal is an EVENT, for the same reason clearing a mark is.
    //
    // Inventory derives from the ledger, so the review removes an item by appending a negative
    // delta anchored on the message that showed it going, not by editing a table. Swipe that turn
    // and the character has the thing again, which is the property `deriveState` buys everywhere
    // else and the reason nothing here writes state directly.
    //
    // The Azure Dragon sword is the case: taken at mid 88, laid down with the disciple at mid 92,
    // and on the ledger ever since because no mechanism existed to take it off.
    let dropped = 0;
    for (const item of plan.dropped ?? []) {
        const { place, name } = splitItemKey(item.key);
        const proposed = { inv: [{ item: name, dq: -Math.abs(item.qty ?? 1), ...(place === CARRIED ? {} : { at: place }) }] };
        // The gate text carries the item and the note, for `applyMoney`'s reason: the mention gate
        // asks whether the excerpt names the thing, and a review answer IS the naming.
        const gate = `${windowText}\n${name} ${item.note ?? ''}`;
        const outcome = validateDelta ? validateDelta(proposed, { windowText: gate }) : { delta: proposed, rejected: [] };
        if (outcome.rejected?.length) {
            observe.noteRejections(outcome.rejected);
        }
        if (!outcome.delta) {
            continue;
        }
        chronicle.recordReviewEvent({
            summary: `No longer carrying ${name}${item.note ? ` (${item.note})` : ''}`.slice(0, 200),
            keywords: [name],
            delta: outcome.delta,
            srcKey: anchor?.key,
            mid: anchor?.mid,
        });
        dropped++;
        observe.note('review:dropped');
    }

    let cleared = 0;
    for (const mark of plan.cleared) {
        if (onClearMark?.({ ...mark, srcKey: anchor?.key, mid: anchor?.mid })) {
            cleared++;
            observe.note('review:mark-cleared');
        }
    }

    // A fight that ended. The row survives, a beaten adversary is still a person, possibly a
    // prisoner or a corpse the scene has to deal with, and only the integer goes to zero. Whether
    // they are still IN the room stays the presence predicate's question, which is the one part of
    // this table that was already right (`entity-table.js` `presenceOf`).
    let disarmed = 0;
    for (const row of plan.disarmed) {
        if (entities.setThreat(row.key, 0, turn)) {
            disarmed++;
            observe.note('review:threat-cleared');
        }
    }

    for (const contest of plan.locks) {
        onContest?.(contest.field, contest.value);
    }

    const paid = applyMoney(plan.money, { validateDelta, windowText, anchor, visible });

    if (plan.rejected.length) {
        observe.noteRejections(plan.rejected);
    }

    return {
        asked: review.size,
        settled: plan.closures.length,
        advanced: plan.advanced.length,
        kept: plan.kept,
        merged,
        placed: plan.places.length,
        dropped,
        cleared,
        disarmed,
        paid,
        rejected: plan.rejected,
    };
}

/**
 * Turn an answered money question into an ordinary validated delta.
 *
 * The trigger is code; the answer is an ordinary delta.
 *
 * Nothing here is a special path into state. The amount goes through `validateDelta` like every
 * other proposal, the mention gate, the growth ratio, the corroboration rule, because a review
 * answer is a model's reading and gets the same scrutiny a model's reading always gets. What it is
 * checked AGAINST is the window plus the answer itself, which is the same widening `absorb.js:112`
 * makes for a status block: the block is the narrator restating its own turn, and a review answer is
 * the model quoting a price it just read. Without it the gate would refuse the currency's own name
 * whenever the excerpt wrote "120k" and not "won".
 *
 * The debit has to face the already-recorded gate, and it could not.
 *
 * `validateInventory` refuses a re-tell by finding the SAME delta already on the contributor trail
 * at a mid the model can still see. That last clause is the RC1 bound, and it is expressed as a
 * `visible` set of mids, so a caller that passes none refuses nothing, ever, however plainly the
 * ledger already carries the payment.
 *
 * This was that caller. MEASURED in the live Isekai chat: mid 42 recorded `gold -1` from "Ike
 * Kōtoku gives Brenn a gold coin for a bottle of cheap red wine", and three messages later the
 * `paid?` question was answered "1 gold" and billed it AGAIN, "Paid 1 gold for gold", at mid 45.
 * One coin, two debits, 15 to 13 on a purchase of one. The trail held the matching -1 the whole
 * time and the gate could not look at it, because `visible` was null and every candidate failed the
 * in-sight test.
 *
 * It is threaded from the pass context, which has carried it to every probe since the window began
 * reporting `seen` (`extract.js`), the review simply never read it.
 *
 * @param {object|null} money The plan's money answer.
 * @param {object} params Parameters.
 * @param {Function|null} params.validateDelta The validator.
 * @param {string} params.windowText The new half of the window.
 * @param {object} [params.anchor] The newest live source, for liveness.
 * @param {Set<number>|null} [params.visible] Every mid this pass displayed, for the re-tell gate.
 * @returns {number} The amount debited, 0 when nothing was.
 */
function applyMoney(money, { validateDelta, windowText, anchor, visible = null }) {
    if (!money) {
        return 0;
    }
    const question = owed();
    // Answered either way, "nothing" is a real answer and clears the question, or the debit lands
    // and the question is no longer outstanding. Left standing, it would be asked every pass.
    clearOwed();
    if (!money.amount || !question) {
        observe.note('review:unpaid');
        return 0;
    }

    const currency = String(money.currency || question.currency || '').trim();
    const proposed = { inv: [{ item: currency, dq: -Math.abs(money.amount), at: MONEY }] };
    const gate = `${windowText}\n${currency} ${money.amount} ${money.note ?? ''}`;
    const outcome = validateDelta
        ? validateDelta(proposed, { windowText: gate, visible })
        : { delta: proposed, rejected: [] };
    if (outcome.rejected?.length) {
        observe.noteRejections(outcome.rejected);
    }
    if (!outcome.delta) {
        return 0;
    }
    chronicle.recordReviewEvent({
        summary: `Paid ${money.amount} ${currency} for ${question.items.join(', ')}`.slice(0, 200),
        keywords: [currency, ...question.items.slice(0, 3)],
        delta: outcome.delta,
        srcKey: anchor?.key,
        mid: anchor?.mid,
    });
    observe.note('review:paid');
    return money.amount;
}

/**
 * A readable label for a merge, for the audit event.
 * @param {object} merge The merge.
 * @param {Map<string, object>} cast Cast table.
 * @param {Map<string, string>} names Thread key -> name.
 * @returns {string} The label.
 */
function labelOf(merge, cast, names) {
    const said = key => (merge.of === 'cast' ? (lookup(cast, key, null)?.name ?? key) : (names.get(key) ?? key));
    return `${said(merge.a)} = ${said(merge.b)}`;
}
