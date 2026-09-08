/**
 * sanguine/reconcile.js: the reconcile pass (app half).
 *
 * The pure half is `reconcile-table.js`, which owns the block, the schema and the routing. This
 * layer gathers the live record, spends one model call on a long stretch of the story, and then
 * splits what comes back into two lanes with different physics.
 *
 * The gate is gone, and the measurement is why.
 *
 * `reconcile:asked: 80`, `reconcile:declined: 2`, `reconcile:applied: 0`. Two runs ever, across 22
 * campaigns, both cancelled. The modal that used to live here priced Apply at up to forty blind
 * fiction-recall judgements over a popup covering the record being judged, and Cancel at one click
 * for no visible loss, and, worse, coupled every good repair to every frightening one, so the whole
 * plan was forfeited to avoid two rows of it.
 *
 * `repair-table.js` argues the replacement in full. The short of it: repairs that CONSERVE the
 * record's substance (`rename`, `move`, `split`) apply on sight into a visible, undoable ledger;
 * repairs that do not (`gone`, `merge`, `amount`) become durable pending asks, one decision each,
 * answerable never. Closing the surface now loses nothing, which removes the exact incentive
 * gradient that produced 80 asked and 0 applied.
 *
 * Repair, and only through operators that already exist.
 *
 * Every verdict routes to a writer `edits.js`, `entities.js` or `clocks.js` already exports and the
 * panel already uses by hand. That routing now lives in `repairs.js`, because an accepted ask has to
 * be the same write as the auto lane's, the only difference between the two lanes is who
 * authorised it, and a second code path would be a second set of bugs.
 *
 * One writer is absent on purpose: `forget`. A `gone` is always the "it left the story" operation,
 * an appended event or a status change, never an erasure of the events that asserted the row. A
 * pass may repair the record; only the player may decide something was never true.
 */

import { chat } from '../../../script.js';
import { t } from '../../i18n.js';

import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import * as repairs from './repairs.js';
import { requestExtraction } from './extract.js';
import { analyzeExtraction } from './json-parse.js';
import { derive, pov } from './state.js';
import {
    AMOUNT, GONE, MERGE, MOVE, RENAME, SPLIT,
    instruction, planReconcile, reconcileAsks, reconcileBlock, schema,
} from './reconcile-table.js';
import { askKey, tierRepairs } from './repair-table.js';
import { splitItemKey } from './state-table.js';
import { commitValue, loadValue, snapshotFold } from './store.js';

/** How many of the newest messages the pass reads. The point of the pass is a long look. */
export const RECONCILE_WINDOW = 60;

/** Where the last pass stopped in the record, so the next one continues rather than repeating. */
const OFFSET_PATH = 'state.reconciled';

/**
 * Response budget. One line of JSON per posed row, plus its evidence.
 *
 * Raised from 2400 when `with` and `parts` joined the schema. Strict mode puts every property on
 * every line whether or not the verdict uses it, so the floor per line grew by `"with":"","parts":[]`
 *, about ten tokens across `MAX_RECONCILE_LINES` of forty, plus headroom for the one or two lines
 * that actually carry parts. A budget that truncates mid-array loses the whole answer, not the tail.
 */
const RESPONSE_LENGTH = 3200;

// No system prompt of its own: `requestExtraction` carries extraction's, which already says "answer
// with the requested JSON and nothing else". A second voice arguing the same point is prompt weight
// for no behaviour, and the schema does the shaping either way.

/**
 * The live record, as askable rows.
 *
 * Reads the same projections the panel renders, so what is posed is what the player can see. A row
 * the panel hides is a row the player has not been asked to trust.
 *
 * @returns {Array<object>} Rows for `reconcileAsks`.
 */
export function liveRows() {
    const state = derive();
    const rows = [];

    for (const [key, held] of state.inv) {
        const parts = splitItemKey(key);
        rows.push({ kind: 'item', key, name: parts.name, qty: held?.qty ?? 0, place: parts.place || 'carried' });
    }
    for (const [key, mark] of state.marks) {
        if (!mark?.on) continue;
        rows.push({ kind: 'mark', key, name: mark.phrase || key, who: mark.who ?? '' });
    }
    // The pov, which this call was not actually excluding.
    //
    // The comment here used to say "the pov is already excluded by `snapshot`". It is not:
    // `snapshot({})` defaults `pov` to '', `resolveEntity` answers null for an empty name, and
    // `notSelf` is `!self || person.key !== self`: so an empty pov passes EVERYBODY
    // (`entities.js`:863-864). Every other caller supplies one (`panel.js`:1846,
    // `overlay-cast.js`:869, `state.js`:1618); this one did not, so the protagonist was posed like
    // anyone else and a `gone` on him was one tick away. `state.pov()` reads the same context field
    // the panel does.
    //
    // The location is still deliberately not passed, but the old reason for it was wrong. Where
    // somebody is standing IS what this pass audits now, `face()` prints `, last placed: X` and
    // `MOVE` corrects it. The reason is narrower: `at` only decides which of `castAt`'s three
    // buckets a row lands in (`entity-table.js`:1600), and the loop below unions all three, so
    // passing a location cannot change which rows are posed or what `place` they carry. It would
    // add a dependency on the current scene for no difference in coverage.
    const cast = entities.snapshot({ pov: pov() });
    for (const person of [...cast.people, ...cast.unplaced, ...cast.elsewhere]) {
        rows.push({ kind: 'cast', key: person.key, name: person.name, place: person.place ?? '' });
    }
    // `view()` is the thread TABLE with closures overlaid, so it iterates as [key, row] pairs.
    for (const [key, thread] of clocks.view()) {
        if (String(thread?.status ?? '') !== 'open') continue;
        rows.push({ kind: 'thread', key, name: thread?.name ?? key });
    }
    return rows;
}

/** The stretch of story the pass checks the record against. */
function windowText(size = RECONCILE_WINDOW) {
    return (chat ?? [])
        .filter(message => message?.mes && !message.is_system)
        .slice(-size)
        .map(message => `${message?.name ?? ''}: ${message.mes}`)
        .join('\n\n');
}

/**
 * Run the pass and return what it proposes. Writes nothing but the offset.
 *
 * The span is reported, not only walked.
 *
 * `reconcileBlock` already returned how far it reached, and nothing read it except the offset
 * commit. The Repairs surface renders it as a coverage strip, because an all-clear that does not say
 * WHAT it covered reads as "your record is correct" when it means "the forty rows we looked at are
 * correct", and on the live Raccoon City record, 40 of 88, those are very different claims.
 *
 * `end` may exceed `total`. That is the walk WRAPPING: `reconcileBlock` poses `min(budget, rows)`
 * lines from the offset and runs off the end onto row 1 rather than posing a short block, so a span
 * of 61, 100 over 88 rows means 61, 88 and then 1, 12. Reported raw rather than clamped, because
 * clamping would silently drop the wrapped tail from a figure whose entire job is honesty about
 * what was checked.
 *
 * @param {object} [options] Options.
 * @param {number} [options.size] How many messages to read.
 * @param {string} [options.profileId] Connection profile, if extraction has one.
 * @returns {Promise<{plan: object, index: Map<string, object>, posed: number,
 *   covered: {start: number, end: number, total: number}}>} The proposal.
 */
export async function propose({ size = RECONCILE_WINDOW, profileId = '' } = {}) {
    const asks = reconcileAsks(liveRows());
    // Where the last pass stopped, so a record bigger than the block gets walked rather than
    // re-posed. Persisted per chat like everything else fold remembers.
    const { text, index, covered } = reconcileBlock({ asks, offset: loadValue(OFFSET_PATH, 0) });
    const span = { start: index.size ? covered - index.size + 1 : 0, end: index.size ? covered : 0, total: asks.length };
    if (!index.size) {
        // The same shape `planReconcile` returns. It used to answer `{retract: []}`, a key that
        // exists nowhere else in this file, inert only because `apply` reads `plan.repairs ?? []`
        // and `posed` of 0 skips the diff entirely, which is a trap rather than a design.
        return { plan: { repairs: [], held: 0, rejected: [] }, index, posed: 0, covered: span };
    }
    const prompt = [windowText(size), '', text, '', instruction()].join('\n');
    observe.note('reconcile:asked', index.size);

    const raw = await requestExtraction({ prompt, responseLength: RESPONSE_LENGTH, schema: schema(), profileId });
    const fragment = analyzeExtraction(raw).value;
    const plan = planReconcile(fragment, { index });

    // The offset advances only once a plan exists.
    //
    // It used to commit BEFORE the await above, which meant a model call that threw, timed out or
    // returned nothing still moved the walk on by a full block. Those rows are then unreachable
    // until the offset wraps the whole record, so the failure mode was not "the pass did nothing",
    // it was "the pass silently skipped forty rows it never looked at", and the next run would
    // report full coverage of a record with a hole in it.
    //
    // Committing here makes a failed pass a no-op on the walk, which is the honest reading: nothing
    // was judged, so nothing was covered. The offset is the one piece of state `propose` writes, and
    // a function that writes nothing else has no business writing this before it has an answer.
    commitValue(OFFSET_PATH, covered);

    observe.note('reconcile:held', plan.held);
    if (plan.repairs.length) observe.note('reconcile:repairs', plan.repairs.length);
    // Parts past `MAX_SPLIT_PARTS`. Counted as well as shown in the diff, because the diff is read
    // once and the counter is what says afterwards whether the bound is the right size.
    const overflow = plan.repairs.reduce((sum, repair) => sum + (repair.dropped ?? 0), 0);
    if (overflow) observe.noteCap('reconcile-parts', overflow);
    for (const rejection of plan.rejected) {
        observe.note(`reconcile:${rejection.reason}`);
    }
    return { plan, index, posed: index.size, covered: span };
}

/** One part of a split, as it will read on the panel afterwards. */
function partFace(part) {
    return part.count > 1 ? `${part.count} ${part.name}` : part.name;
}

/**
 * One repair, in the player's terms rather than the schema's.
 *
 * A merge does not always say "into", because it is not always up to this pass.
 *
 * For an item and for a mark the direction is ours: the row that was answered is the one that goes,
 * and the row named in `with` is the one that survives. For a cast row and a thread it is NOT, both
 * tables pick their own keeper and neither reads argument order. `mergeEntities` keeps the LONGER
 * name (`entity-table.js`:1859), which for `Ada Wong` against `the woman in red` keeps the
 * description; `mergeThreads` keeps whichever row bears the more advanced dial
 * (`thread-table.js`:1459), on the measured argument that a name-length tie-break once wound the
 * Karr clock backwards from 7/8 to 1/6. Those rules are right and are not this pass's to override,
 * so the diff says "with" rather than promising a direction it does not control.
 *
 * Exported for the tests, which run under `testEnvironment: node` and so cannot reach `confirm`'s
 * DOM. What a repair SAYS is still half of it: an ask nobody can read is an ask nobody can answer,
 * and a ledger row nobody can read is an undo nobody will reach for.
 *
 * @param {object} repair One planned repair.
 * @returns {string} The line the player reads.
 */
export function describeRepair(repair) {
    if (repair.op === GONE) return t`Remove ${repair.name}`;
    if (repair.op === RENAME) return t`Rename ${repair.name} to ${repair.to}`;
    if (repair.op === MOVE) return t`Move ${repair.name} to ${repair.to}`;
    if (repair.op === AMOUNT) return t`Set ${repair.name} to ${repair.count} (from ${repair.from})`;
    if (repair.op === MERGE) {
        return repair.kind === 'cast' || repair.kind === 'thread'
            ? t`Merge ${repair.name} with ${repair.withName}, one row`
            : t`Merge ${repair.name} into ${repair.withName}`;
    }
    if (repair.op === SPLIT) {
        const was = repair.from > 1 ? `${repair.name} x${repair.from}` : repair.name;
        const into = (repair.parts ?? []).map(partFace).join(', ');
        return repair.dropped
            ? t`Split ${was} into ${into} (${repair.dropped} further parts refused, the limit is six)`
            : t`Split ${was} into ${into}`;
    }
    return repair.name;
}

/**
 * The order repairs are applied in.
 *
 * A flat loop was correct only while every op was independent.
 *
 * It no longer is. A split destroys a row and creates several; a merge destroys a row and grows
 * another; the rest edit a row that has to still be there. So the plan is sorted before it is
 * applied, and the order is the dependency order rather than the answer order:
 *
 *   1. SPLIT   creates rows. It runs first so that nothing else has already emptied the source,
 *              `splitDelta` refuses a row at zero, so a `gone` or an `amount: 0` ahead of it would
 *              turn the split into a silent no-op.
 *   2. MERGE   collapses rows. After the splits, so a merge target that was going to be broken up
 *              no longer exists to merge into, `settleMerges` refuses that pair outright, and this
 *              ordering is what makes that refusal the only way it can happen.
 *   3. RENAME / MOVE / AMOUNT   field edits, on the survivor. After the merge deliberately: the
 *              merge sums the two piles and the amount then states the story's total, so the story's
 *              number wins over the arithmetic. (`repair.from` in the diff is the pre-merge reading,
 *              which is what the player was shown and what the block posed.)
 *   4. GONE    retractions last, so a row can be repaired and then removed in one pass without the
 *              repairs landing on a key that stopped existing.
 *
 * Stable within a step, so two answers about the same kind still apply in the order they were posed.
 */
const APPLY_ORDER = Object.freeze([SPLIT, MERGE, RENAME, MOVE, AMOUNT, GONE]);


/**
 * Apply a plan through the ordinary edit operators.
 *
 * The routing for one repair lives in `repairs.js`, so that an accepted ask is byte-for-byte the
 * same write as an auto-lane repair. What stays here is the ORDER, which is a property of a plan
 * rather than of a repair, an ask answered on its own has no siblings to be ordered against.
 *
 * @param {object} plan The plan.
 * @param {Array<object>|null} [landed] Collects a ledger row per repair that changed something.
 * @returns {number} How many rows were changed.
 */
export function apply(plan, landed = null) {
    const ordered = [...(plan.repairs ?? [])]
        .map((repair, at) => ({ repair, at }))
        .sort((a, b) => (APPLY_ORDER.indexOf(a.repair.op) - APPLY_ORDER.indexOf(b.repair.op)) || (a.at - b.at))
        .map(entry => entry.repair);

    let done = 0;
    for (const repair of ordered) {
        if (repair.skip) continue;
        const result = repairs.applyRepair(repair);
        if (!result.changed) continue;
        done++;
        if (landed) landed.push(repairs.ledgerRow(repair, result));
    }
    if (done) observe.note('reconcile:applied', done);
    return done;
}

/**
 * How the run reports itself, without demanding anything.
 *
 * A toast, and deliberately not the surface.
 *
 * The overlay is NOT force-opened here. A forced surface is the modal's DNA, the whole defect being
 * repaired is that value routed through a gate the player had to dispatch before they could carry on
 * playing: and re-introducing it as a tab that opens itself would be the same mechanism wearing a
 * different shirt. The toast says what happened and the panel's badge keeps saying it; the player
 * goes to the Repairs tab when the questions are worth their attention, or never.
 *
 * @param {number} applied How many repairs landed.
 * @param {number} asked How many questions are pending.
 * @param {{start: number, end: number, total: number}} covered The span.
 */
function announce(applied, asked, covered) {
    const span = covered.total
        ? t`rows ${covered.start}, ${covered.end} of ${covered.total}`
        : t`nothing to check`;
    if (!applied && !asked) {
        toastr.info(t`Reconcile: nothing needs changing · ${span}.`);
        return;
    }
    const fixed = t`${applied} repairs applied`;
    const questions = asked ? t` · ${asked} questions` : '';
    toastr.info(t`Reconcile: ${fixed}${questions} · ${span}.`);
}

/**
 * The whole pass: propose, land the conserving half, store the questions.
 *
 * Nothing here waits for an answer.
 *
 * The auto lane is bracketed by `snapshotFold()` so the whole pass can be reverted while the record
 * has not moved on; the ask lane becomes durable state. Neither blocks. A player who closes
 * everything and keeps playing has still received every conserving repair the pass found, which is
 * the success criterion `repair-table.js` states: how much of the pass's value lands when the player
 * answers nothing at all?
 *
 * A failed pass writes NOTHING, `propose` commits the offset only after a plan exists, so the rows
 * it never judged stay reachable, and no ledger row is recorded, so the coverage strip goes on
 * showing that span as unchecked.
 *
 * @param {object} [options] Options.
 * @returns {Promise<{applied: number, asked: number, covered: {start: number, end: number,
 *   total: number}, failed: boolean}>} What the pass did.
 */
export async function run(options = {}) {
    let proposal;
    try {
        proposal = await propose(options);
    } catch (error) {
        console.error('[sanguine] reconcile failed', error);
        toastr.error(t`The reconcile pass failed. Nothing was changed.`);
        // A failure is a pass, and the ledger says so.
        //
        // The toast is gone the moment it fades, and the question it leaves behind, "I pressed the
        // button and nothing happened; did it check anything?", is exactly what the Repairs tab
        // exists to answer. Recording it marks the span as NOT covered, which is true: the offset
        // commits only after a plan exists, so a failed call advances nothing.
        //
        // It costs a ledger slot out of `MAX_LEDGER_PASSES`, and that is the honest price. A failure
        // that quietly left no trace would let the surface show the previous pass's successes as the
        // most recent thing that happened, which reads as "the run went fine".
        const covered = repairs.coverage();
        repairs.record({ applied: [], asked: [], covered, failed: true });
        return { applied: 0, asked: 0, covered, failed: true };
    }

    const { plan, index, posed, covered } = proposal;
    if (!posed) {
        announce(0, 0, covered);
        return { applied: 0, asked: 0, covered, failed: false };
    }

    const { auto, ask } = tierRepairs(plan.repairs);
    // Before a single write, and only when there is something to bracket. `restoreFold` is the other
    // half; `repairs.snapshotValid` is what stops it being offered once it would destroy a turn.
    const snapshot = auto.length ? snapshotFold() : null;
    const landed = [];
    const applied = apply({ repairs: auto }, landed);
    if (applied) observe.note('reconcile:auto', applied);

    repairs.record({
        applied: landed,
        asked: ask,
        // Every row this pass actually looked at. `repairs.record` uses it to withdraw a standing ask
        // about a row the model has now re-read and left alone, the only set of asks this pass has
        // earned the right to drop.
        posed: new Set([...index.values()].map(askKey)),
        covered,
        snapshot: applied ? snapshot : null,
        // What the planner refused, so the Repairs tab's refusals disclosure has a source. Shown as
        // a per-reason count, never as an action, they exist so the pass can show its rejects,
        // which is the same trust argument that makes the coverage strip print what it did NOT read.
        rejected: plan.rejected,
    });

    announce(applied, ask.length, covered);
    return { applied, asked: ask.length, covered, failed: false };
}
