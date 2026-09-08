/**
 * sanguine/repairs.js: the repair bay (app half).
 *
 * The pure half is `repair-table.js`, which owns the tiering line, the clustering and the undo
 * taxonomy, and argues from the measurement why any of it exists. This layer owns three things the
 * pure half cannot: the writers every repair routes through, the two persisted tables, and the one
 * piece of session state that makes "Revert this pass" able to tell the truth.
 *
 * Every repair still goes through an operator that already exists.
 *
 * Unchanged from `reconcile.js`, and load-bearing: `removeItem`, `clearMark`, `closeThread`,
 * `renameItem`, `setItemQty`, `moveItemTo`, `splitItem`, `editCast`, `entities.merge`,
 * `clocks.merge`. Nothing here writes to a table directly and nothing here is a new kind of write,
 * which is what keeps a repair as trailed and as swipe-undoable as the same edit made by hand.
 *
 * `forget` is absent on purpose. A `gone` is always "it left the story", an appended event or a
 * status change, never an erasure of the events that asserted the row. A pass may repair the
 * record; only the player may decide something was never true.
 *
 * Two tables, and a budget that will not accommodate a third.
 *
 * `state['repair-asks']`   the pending questions, keyed by `askKey`, superseded by a newer pass.
 * `state['repair-ledger']` at most `MAX_LEDGER_PASSES` passes of what actually landed.
 *
 * `MAX_FOLD_BYTES` is 128 KiB and three live chats are already over 90% of it, the largest at 96%.
 * That number decides two designs outright:
 *
 *   · The pass snapshot is held IN MEMORY. A copy of the blob stored inside the blob doubles it, so
 *     for the chats that need the budget most it is not a tradeoff, it is impossible. The cost is
 *     that a revert does not survive a reload, and the cost is PAID rather than hidden, because
 *     `snapshotValid` answers false and the surface prints the expiry instead of offering a button
 *     that would do nothing.
 *   · A pruner is registered at `PRUNE_REPAIRS`, between the diagnostics log and the cold archive.
 *     This is machinery: a queue of questions and a receipt. It goes before the campaign's own
 *     displaced memory does.
 */

import * as clocks from './clocks.js';
import * as edits from './edits.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import { table_entries } from './lib/hash.js';
import { AMOUNT, GONE, MERGE, MOVE, RENAME, SPLIT } from './reconcile-table.js';
import { MAX_LEDGER_PASSES, askKey, clusterAsks, undoKindOf } from './repair-table.js';
import { itemKey, normalizeItemName, normalizePlace, splitItemKey } from './state-table.js';
import {
    PRUNE_REPAIRS, commit, commitValue, getFold, loadTable, loadValue, registerPruner, replaceFold,
    writeMark,
} from './store.js';

const ASKS_PATH = 'state.repair-asks';
const LEDGER_PATH = 'state.repair-ledger';

/**
 * How many unanswered questions may stand at once.
 *
 * A block poses at most `MAX_RECONCILE_LINES` (40) rows, so one pass can raise at most forty asks.
 * Sixty lets this pass's questions stand beside the previous pass's unanswered ones, which is the
 * normal state of a record being walked, without letting twenty passes over a large record build a
 * queue nobody will ever read. The oldest pass's asks go first: an ask the player has walked past
 * for several runs is one they have answered by not answering.
 */
const MAX_PENDING_ASKS = 60;

/**
 * The snapshot of the blob as it stood before a pass's auto lane, and the mark it was taken at.
 *
 * Why a module variable and not a field on the pass.
 *
 * See the budget note above: it cannot go on disk. What CAN go on disk is the pass id, so the two
 * are matched by id and `snapshotValid` answers for exactly one pass, the newest, and only until
 * something else writes.
 *
 * `fold` holds the blob OBJECT this snapshot belongs to. SillyTavern parses a fresh one on every
 * chat load (`store.js` `getFold` uses the same fact for its migration guard), so identity is the
 * honest test for "is this still the chat the snapshot was taken from", and a snapshot from another
 * chat must never be offered, whatever the write counter says.
 *
 * @type {{pass: number, blob: object, fold: object, mark: number}|null}
 */
let held = null;

// The two tables.

/** @returns {Array<object>} The stored ledger, newest first, without the computed fields. */
function rawLedger() {
    const stored = loadValue(LEDGER_PATH, []);
    return Array.isArray(stored) ? stored : [];
}

/**
 * Write the ledger, absorbing this write into the held mark when it is the only thing that happened.
 *
 * Bookkeeping about a snapshot must not invalidate the snapshot.
 *
 * Every write bumps `writeMark()`, including these two. Without the absorption below, recording the
 * ledger pass would invalidate the very snapshot it is recording, and "Revert this pass" would be
 * dead on arrival every single time.
 *
 * The absorption is conditional and that condition is the whole safety of it: the mark is only
 * carried forward when NOTHING had written since it was taken. So the sequence in `applyAsk`:
 * write the record, then rewrite the ask table, cannot re-validate a snapshot the record write has
 * already expired, because by then the mark has already moved and `fresh` is false.
 *
 * @param {Array<object>} passes The ledger to store, newest first.
 */
function saveLedger(passes) {
    const fresh = Boolean(held) && held.mark === writeMark();
    commitValue(LEDGER_PATH, passes.slice(0, MAX_LEDGER_PASSES));
    if (fresh) held.mark = writeMark();
}

/**
 * Write the ask table, under the same absorption rule as the ledger.
 * @param {Map<string, object>} table The asks.
 */
function saveAsks(table) {
    const fresh = Boolean(held) && held.mark === writeMark();
    commit(ASKS_PATH, table);
    if (fresh) held.mark = writeMark();
}

/**
 * The pending asks, newest pass first.
 *
 * @returns {Array<object>} The asks.
 */
export function asks() {
    return table_entries(loadTable(ASKS_PATH))
        .map(([, ask]) => ask)
        .sort((a, b) => (Number(b?.pass) || 0) - (Number(a?.pass) || 0));
}

/**
 * The ledger, newest pass first, each pass told whether its snapshot is still honest.
 *
 * `snapshotValid` is COMPUTED on read and never stored. A stored flag would be a claim made at write
 * time about a condition that changes afterwards, which is precisely the silent expiry this whole
 * mechanism exists to refuse.
 *
 * @returns {Array<object>} The passes.
 */
export function ledger() {
    return rawLedger().map(pass => ({ ...pass, snapshotValid: snapshotValid(pass?.pass) }));
}

/**
 * How much of the record the last pass actually checked.
 *
 * The strip is what keeps "nothing needs changing" from overclaiming.
 *
 * The block poses at most 40 of the live rows and offset-walks the rest (`reconcile-table.js`
 * `reconcileBlock`), measured on the live Raccoon City campaign at 88 live rows against a budget of
 * 40. Without this, an all-clear reads as "your record is correct" when it means "the 40 rows we
 * looked at are correct", and the player has no way to tell the two apart.
 *
 * A failed pass records no ledger row at all, so it shows the span as NOT covered, which is the
 * honest reading, since nothing was judged.
 *
 * @param {number|null} [total] The live row count now, when the caller has one. Absent, the total is
 *   the one the last pass measured, which is right as of that pass and never invented.
 * @returns {{start: number, end: number, total: number}} 1-based, inclusive.
 */
export function coverage(total = null) {
    const covered = rawLedger()[0]?.covered;
    // `Number(null)` is 0 and 0 is finite, so an absent argument has to be tested for as an absence
    // rather than as an unusable number, otherwise "the caller did not say" reads as "zero rows".
    const said = total === null || total === undefined ? null : Number(total);
    const rows = Number.isFinite(said) ? Math.max(0, Math.trunc(said)) : null;
    if (!covered) {
        return { start: 0, end: 0, total: rows ?? 0 };
    }
    return {
        start: Number(covered.start) || 0,
        end: Number(covered.end) || 0,
        total: rows ?? (Number(covered.total) || 0),
    };
}

// Writing: one repair, through the operator it already had.

/**
 * Whether a thread key still names a row.
 *
 * The one kind whose writers do not already fail safe on a dead key. `edits.removeItem`,
 * `clearMark` and `setItemQty` all read the fold first and answer false; `editCast` checks
 * `entities.load().has(key)`. But `closeThread` routes to `clocks.set`, which takes a NAME and folds
 * it: so closing a thread that an earlier merge already collapsed would CREATE it again, as a
 * closed row, out of nothing. `load()` rather than `view()` because this is a question about the
 * stored table, which is what the writers write to.
 *
 * @param {string} key The thread key.
 * @returns {boolean} Whether the row is still there.
 */
function threadLives(key) {
    return clocks.load().has(key);
}

/**
 * Collapse two rows the pass judged to be one thing, through each table's own merge.
 *
 * @param {object} repair One planned `merge`.
 * @returns {boolean} Whether anything changed.
 */
function applyMerge(repair) {
    if (repair.kind === 'item') {
        // One transfer event rather than a delete and an add: `renameDelta` debits the source's
        // whole quantity and credits it under the survivor's name at the same place and owner, and
        // `deriveState` sums it onto the row already there. The plan has already refused any pair
        // whose place or owner differs, which is the condition that makes the credit land on the
        // target key rather than beside it.
        return edits.renameItem(repair.key, repair.withName);
    }
    if (repair.kind === 'cast') {
        return Boolean(entities.merge(repair.key, repair.with));
    }
    if (repair.kind === 'thread') {
        return threadLives(repair.key) && threadLives(repair.with) && Boolean(clocks.merge(repair.key, repair.with));
    }
    // A mark has no merge operator and cannot be given one, see `OPS_FOR`. What it has is the
    // duplicate coming off, which is the same write a `gone` performs. The difference is not the
    // write, it is the QUESTION: the player is asked "is this the same condition as that one?"
    // rather than "did this heal?", and answering the second about a duplicate is how a condition
    // that is still true gets cleared.
    return edits.clearMark(repair.key);
}

/**
 * Where a cast row says it is, right now.
 *
 * Read at apply time rather than carried on the repair, because the repair carries what the BLOCK
 * posed and the block may be several turns old by the time an ask is answered. An inverse undo has
 * to restore what was actually there, not what the pass was told was there.
 *
 * @param {string} key The cast key.
 * @returns {string} The place, or ''.
 */
function castPlace(key) {
    return String(entities.load().get(key)?.place ?? '');
}

/**
 * Apply one repair, and report what it takes to undo it.
 *
 * The `from` is captured here because here is the only place both readings exist.
 *
 * A per-row inverse needs the value the row held BEFORE the write, and by the time the ledger row is
 * built the record has already moved. `amount` and `split` get theirs from the planner (`repair.from`
 * is the quantity the block posed); `rename` and `move` do not, and are read off the live record a
 * line before they are overwritten.
 *
 * And the key is reported because two of these MOVE the row.
 *
 * An item key is `who\0place\0name` (`state-table.js` `itemKey`), so renaming or moving an item
 * re-keys it. An inverse addressed at `repair.key` would be addressed at a row that no longer
 * exists, and would silently do nothing, an undo button that reports success and changes nothing
 * being strictly worse than no button.
 *
 * @param {object} repair One repair, from `planReconcile` or from the ask table.
 * @returns {{changed: boolean, key: string, from: (string|number)}} What happened.
 */
export function applyRepair(repair) {
    const kind = repair?.kind;
    const { place, who } = splitItemKey(repair?.key ?? '');
    let changed = false;
    let landed = String(repair?.key ?? '');
    let from = repair?.from ?? 0;

    if (repair.op === GONE) {
        // Always the "it left the story" operation, never `forget`. A pass may repair the
        // record; only the player may decide something was never true.
        if (kind === 'item') changed = edits.removeItem(repair.key);
        else if (kind === 'mark') changed = edits.clearMark(repair.key);
        else if (kind === 'thread') changed = threadLives(repair.key) && edits.closeThread(repair.name);
        else if (kind === 'cast') changed = edits.editCast(repair.key, { status: 'gone' });
    } else if (repair.op === RENAME) {
        // No thread branch, and that is the fix rather than an omission. `editThread(name, …)`
        // routes to `clocks.set`, which KEYS BY NAME, so the call this used to make,
        // `editThread(repair.name, {about: repair.to})`, renamed nothing and overwrote the
        // thread's description with the proposed name while the diff said "Rename X to Y".
        // The thread table has no re-key operator anywhere, so `rename` is off `OPS_FOR.thread`.
        from = repair.name;
        if (kind === 'item') {
            changed = edits.renameItem(repair.key, repair.to);
            if (changed) landed = itemKey(normalizeItemName(repair.to)?.name ?? repair.to, place, who);
        } else if (kind === 'cast') {
            changed = edits.editCast(repair.key, { name: repair.to });
        }
    } else if (repair.op === AMOUNT) {
        changed = edits.setItemQty(repair.key, repair.count);
    } else if (repair.op === MOVE) {
        // `editCast` routes a place through `entities.setPlace`, which folds it as a versioned
        // sighting and answers false when the row already says so (`placeIsNews`).
        if (kind === 'cast') {
            from = castPlace(repair.key);
            changed = edits.editCast(repair.key, { place: repair.to });
        } else {
            from = place;
            changed = edits.moveItemTo(repair.key, repair.to);
            if (changed) landed = itemKey(splitItemKey(repair.key).name, normalizePlace(repair.to), who);
        }
    } else if (repair.op === MERGE) {
        changed = applyMerge(repair);
    } else if (repair.op === SPLIT) {
        // `splitItem` takes `qty`, not `count`, and answers with the keys the parts landed
        // under, [] when the row could not pay for any of them.
        changed = edits.splitItem(repair.key, (repair.parts ?? []).map(part => ({ name: part.name, qty: part.count }))).length > 0;
    }

    return { changed, key: changed ? landed : String(repair?.key ?? ''), from };
}

/** One part of a split, as it will read on the ledger afterwards. */
function partFace(part) {
    return part.count > 1 ? `${part.count} ${part.name}` : part.name;
}

/**
 * A landed repair, in the shape the ledger stores and the surface renders.
 *
 * `to` is uniformly "what it became", the new name, the new place, the row it was folded into, or
 * the parts a split produced. One field rather than five keeps the row small, and the row is stored
 * per repair per pass in a blob that is already at 96% on the largest live chat.
 *
 * @param {object} repair The repair.
 * @param {{key: string, from: (string|number)}} done What `applyRepair` reported.
 * @returns {object} The ledger row.
 */
export function ledgerRow(repair, done) {
    let became = String(repair.to ?? '');
    if (repair.op === MERGE) became = String(repair.withName ?? '');
    if (repair.op === SPLIT) became = (repair.parts ?? []).map(partFace).join(', ');
    return {
        op: repair.op,
        kind: repair.kind,
        key: done.key,
        name: repair.name,
        to: became,
        from: done.from,
        count: Number(repair.count) || 0,
        // Already clamped to 200 by `planReconcile`. Not re-clamped and never re-read: sanguine
        // checks that evidence EXISTS and never what it says, and it is stored so a person can.
        evidence: String(repair.evidence ?? ''),
        undo: undoKindOf(repair.op),
    };
}

// Recording a pass.

/**
 * Store what a pass did and what it wants to ask, and hold its snapshot.
 *
 * Supersession has two halves, and the second one is what stops the queue rotting.
 *
 * A newer pass proposing the same `askKey` replaces the older ask: same question, fresher evidence.
 * That much is obvious. The half that matters more is the DROP: a row this pass posed and did NOT
 * propose a repair for has an ask that the pass has just, implicitly, withdrawn, the model looked
 * again and said keep. Leaving it would make the queue a place where refuted questions accumulate,
 * and the offset walk guarantees that most rows are not posed in any given pass, so "drop everything
 * not re-proposed" would be wrong in the other direction. Posed-and-not-proposed is the only set
 * this pass has actually earned an opinion about.
 *
 * @param {object} params Parameters.
 * @param {Array<object>} [params.applied] Ledger rows for the auto lane that landed.
 * @param {Array<object>} [params.asked] Ask-lane repairs to store.
 * @param {Set<string>} [params.posed] `askKey` of every row the block posed this pass.
 * @param {{start: number, end: number, total: number}} params.covered What the pass reached.
 * @param {object|null} [params.snapshot] The blob as it stood before the auto lane.
 * @param {Array<{item: string, reason: string}>} [params.rejected] Answers the planner refused.
 * @param {boolean} [params.failed] Whether the call itself failed and nothing was written.
 * @returns {object} The pass as stored.
 */
export function record({ applied = [], asked = [], posed = new Set(), covered, snapshot = null, rejected = [], failed = false } = {}) {
    const passes = rawLedger();
    const id = (Number(passes[0]?.pass) || 0) + 1;
    // `rejected` and `failed` are stored because the surface has two states that need them.
    //
    // The Repairs tab renders a failure state ("The pass failed. Nothing was changed.") and a
    // refusals disclosure, and neither had a source: the pass carried `covered` and `applied` only,
    // so both branches were unreachable and would have rendered the populated state over a pass that
    // wrote nothing. That is precisely the "reads as though everything was checked" defect the
    // coverage strip exists to prevent, one level up.
    //
    // Reasons only, `{item, reason}`, never the model's raw answer. The refused answer is not
    // evidence of anything and storing it would put unbounded model output in a blob at 96% of its
    // cap on three live chats. The reasons are the `REJECTIONS` constants, which is what the
    // per-reason breakdown counts.
    const pass = {
        pass: id,
        at: Date.now(),
        covered,
        applied,
        failed: Boolean(failed),
        rejected: (Array.isArray(rejected) ? rejected : []).map(entry => ({
            item: String(entry?.item ?? '').slice(0, 80),
            reason: String(entry?.reason ?? ''),
        })),
    };
    saveLedger([pass, ...passes]);

    const table = loadTable(ASKS_PATH);
    const proposed = new Set(asked.map(askKey));
    for (const key of [...table.keys()]) {
        if (posed.has(key) && !proposed.has(key)) {
            table.delete(key);
        }
    }
    const turn = entities.turn();
    for (const ask of asked) {
        table.set(askKey(ask), {
            op: ask.op,
            kind: ask.kind,
            key: ask.key,
            name: ask.name,
            who: String(ask.who ?? ''),
            evidence: String(ask.evidence ?? ''),
            to: String(ask.to ?? ''),
            // `with` is not decoration beside `withName`.
            //
            // `withName` is what the card reads. `with` is the survivor's KEY, and it is what
            // `entities.merge` and `clocks.merge` take, a merge stored without it is a question
            // that cannot be answered, only dismissed.
            with: String(ask.with ?? ''),
            withName: String(ask.withName ?? ''),
            count: Number(ask.count) || 0,
            from: ask.from ?? 0,
            turn,
            pass: id,
        });
    }
    saveAsks(trimAsks(table));

    // Taken LAST, after this function's own two writes, so the mark it records is the mark that
    // means "and nothing has happened since".
    //
    // A pass with no snapshot does NOT clear the one already held. A run that finds nothing to fix
    // wrote nothing to the record, so it has not made an earlier pass's revert dishonest, and
    // clearing it would mean "press Reconcile twice and lose the undo for the first one", which is
    // the silent expiry this whole mechanism exists to refuse, arriving by a different door.
    if (snapshot) {
        held = { pass: id, blob: snapshot, fold: getFold(), mark: writeMark() };
    }
    return pass;
}

/**
 * Drop the oldest passes' asks when the queue runs past its bound.
 * @param {Map<string, object>} table The asks.
 * @returns {Map<string, object>} The same table.
 */
function trimAsks(table) {
    if (table.size <= MAX_PENDING_ASKS) {
        return table;
    }
    const ordered = table_entries(table).sort((a, b) => (Number(b[1]?.pass) || 0) - (Number(a[1]?.pass) || 0));
    for (const [key] of ordered.slice(MAX_PENDING_ASKS)) {
        table.delete(key);
    }
    return table;
}

// Answering an ask.

/**
 * Append a landed repair to the pass it belongs to.
 *
 * The ask's own pass when that pass is still in the ledger, because an accepted ask is part of what
 * that run did to the record; the newest pass otherwise, because the alternative, a fresh pass per
 * accepted ask, would evict two real passes to make room for three one-line receipts.
 *
 * @param {object} ask The ask.
 * @param {object} row The ledger row.
 */
function land(ask, row) {
    const passes = rawLedger();
    if (!passes.length) {
        return;
    }
    const at = passes.findIndex(pass => pass?.pass === ask?.pass);
    const target = at < 0 ? 0 : at;
    passes[target] = { ...passes[target], applied: [...(passes[target].applied ?? []), row] };
    saveLedger(passes);
}

/**
 * Answer one ask with yes.
 *
 * Routes through the same writers the auto lane does, so an accepted ask is the same write as the
 * repair it was, the only difference between the lanes is who authorised it.
 *
 * @param {string} key An `askKey`.
 * @returns {boolean} Whether the record changed.
 */
export function applyAsk(key) {
    const table = loadTable(ASKS_PATH);
    const ask = table.get(key);
    if (!ask) {
        return false;
    }
    const done = applyRepair(ask);
    table.delete(key);
    // Deleted either way. A write that answered false is a row that has already moved on, sold,
    // merged, retracted by another pass, and re-posing a question about it forever is the queue rot
    // the supersession rule above exists to prevent.
    saveAsks(table);
    if (!done.changed) {
        return false;
    }
    observe.note('reconcile:applied');
    observe.note('reconcile:ask-applied');
    land(ask, ledgerRow(ask, done));
    return true;
}

/**
 * Answer one ask with no.
 *
 * Nothing is written to the record, which is the point. A dismissal is not a verdict that the row
 * is right, only that the player declines this question; the next pass may pose it again with better
 * evidence, and that is the design working rather than failing.
 *
 * @param {string} key An `askKey`.
 * @returns {boolean} Whether there was an ask to dismiss.
 */
export function dismissAsk(key) {
    const table = loadTable(ASKS_PATH);
    if (!table.delete(key)) {
        return false;
    }
    saveAsks(table);
    observe.note('reconcile:ask-dismissed');
    return true;
}

/**
 * Answer a whole cluster card with yes.
 *
 * Every member of a cluster shares `(op, kind)`, so there is no ordering hazard within one: the
 * dependency order `reconcile.js` `APPLY_ORDER` enforces is between DIFFERENT ops, and a cluster is
 * one op by construction.
 *
 * @param {string} key A cluster key from `clusterAsks`.
 * @returns {number} How many landed.
 */
export function applyCluster(key) {
    const members = clusterAsks(asks()).filter(card => card.key === key).flatMap(card => card.members);
    let done = 0;
    for (const member of members) {
        if (applyAsk(askKey(member))) done++;
    }
    return done;
}

// Undoing.

/**
 * Whether a pass's snapshot would still restore the record rather than damage it.
 *
 * Three conditions, and all three are necessary:
 *
 *   · the snapshot is HERE, it lives in memory, so a reload is an expiry;
 *   · it belongs to THIS pass, only the newest pass can have one;
 *   · nothing has written since, `store.js` `writeMark` counts every write, and a restore
 *     discards everything the blob learned after the copy was taken.
 *
 * The fold identity check catches the case the counter cannot: a chat change loads a fresh blob
 * object, and a snapshot of another chat's record must never be offered whatever the counter says.
 *
 * @param {number} passId The pass.
 * @returns {boolean} Whether `revertPass` would work.
 */
export function snapshotValid(passId) {
    return Boolean(held) && held.pass === passId && held.fold === getFold() && held.mark === writeMark();
}

/**
 * Undo one landed repair with its inverse edit.
 *
 * These never expire, because they are not a restore, they are ordinary edits, recorded in the
 * trail like any other, and they work whatever else has happened to the record since.
 *
 * @param {object} row A ledger row.
 * @returns {boolean} Whether the record changed.
 */
function invert(row) {
    if (row.op === RENAME) {
        return row.kind === 'cast'
            ? edits.editCast(row.key, { name: String(row.from ?? '') })
            : edits.renameItem(row.key, String(row.from ?? ''));
    }
    if (row.op === MOVE) {
        return row.kind === 'cast'
            ? edits.editCast(row.key, { place: String(row.from ?? '') })
            : edits.moveItemTo(row.key, String(row.from ?? ''));
    }
    if (row.op === AMOUNT) {
        return edits.setItemQty(row.key, Number(row.from) || 0);
    }
    return false;
}

/**
 * Undo one row of a pass.
 *
 * Only the `inverse` rows. `split` and `gone` have no operator that reassembles what they took
 * apart, and `merge` has no inverse anywhere in this codebase, offering a button for those would be
 * the lie the whole design refuses. `undoKindOf` is what the surface reads to know which of the
 * three it is holding, and this refuses the other two rather than trusting it to.
 *
 * The row is REMOVED from the ledger on success, so the ledger keeps meaning "what currently stands
 * because of this pass" rather than accumulating a history of its own corrections.
 *
 * @param {number} passId The pass.
 * @param {string} rowKey `askKey` of the ledger row.
 * @returns {boolean} Whether the record changed.
 */
export function undoRow(passId, rowKey) {
    const passes = rawLedger();
    const at = passes.findIndex(pass => pass?.pass === passId);
    if (at < 0) {
        return false;
    }
    const rows = passes[at].applied ?? [];
    const row = rows.find(entry => askKey(entry) === rowKey);
    if (!row || undoKindOf(row.op) !== 'inverse' || !invert(row)) {
        return false;
    }
    passes[at] = { ...passes[at], applied: rows.filter(entry => entry !== row) };
    saveLedger(passes);
    observe.note('reconcile:undone');
    return true;
}

/**
 * Restore the record as it stood before a pass's auto lane.
 *
 * What a wholesale restore must NOT take with it.
 *
 * The snapshot is the entire fold blob, so putting it back also puts back the pending asks, the
 * ledger and the counters as they were before the pass. All three are wrong to roll back:
 *
 *   · the ASKS are questions, not writes, reverting the repairs that landed says nothing about
 *     whether the player still wants to be asked about the ones that did not;
 *   · the LEDGER's other passes were never part of this snapshot's story;
 *   · the COUNTERS are the instrument. `reconcile:auto` recording six and `reconcile:reverted`
 *     recording one are both true and both needed. A design whose case rests on `asked: 80 /
 *     applied: 0` cannot let an undo quietly rewrite its successor's numbers.
 *
 * So all three are carried across the restore by hand.
 *
 * @param {number} passId The pass.
 * @returns {boolean} Whether the record was restored.
 */
export function revertPass(passId) {
    if (!snapshotValid(passId)) {
        return false;
    }
    const blob = held.blob;
    const carriedAsks = loadTable(ASKS_PATH);
    const carriedLedger = rawLedger().filter(pass => pass?.pass !== passId);
    const carriedCounters = observe.load();

    held = null;
    replaceFold(blob);
    observe.restore(carriedCounters);
    commit(ASKS_PATH, carriedAsks);
    commitValue(LEDGER_PATH, carriedLedger);
    observe.note('reconcile:reverted');
    return true;
}

/** Discard every pending ask and the whole ledger. */
export function clear() {
    held = null;
    commit(ASKS_PATH, new Map());
    commitValue(LEDGER_PATH, []);
}

// The budget.

/*
 * Repair state is machinery, so it yields before the campaign's own memory does, but the two halves
 * are not worth the same and are shed in order. The LEDGER goes first: it is a receipt for edits that
 * have already landed and are already in the chronicle's trail, so losing it costs an undo
 * affordance and nothing else. The ASKS go second: they are questions the player has not answered
 * yet, and losing them costs a re-run of a pass that is explicitly re-runnable.
 *
 * One shed per call. `store.js` `runBudgetPasses` re-measures between pruners and stops the moment
 * the blob fits, so shedding both at once would take the asks in a pass the ledger alone would have
 * rescued: the exact defect that ordering loop was written to fix.
 */
registerPruner(() => {
    if (rawLedger().length) {
        held = null;
        commitValue(LEDGER_PATH, []);
        console.debug('[sanguine] repair ledger dropped to fit the metadata budget');
        return;
    }
    const table = loadTable(ASKS_PATH);
    if (!table.size) {
        return;
    }
    commit(ASKS_PATH, new Map());
    console.debug(`[sanguine] ${table.size} pending repair question(s) dropped to fit the metadata budget`);
}, PRUNE_REPAIRS);
