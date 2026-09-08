/**
 * sanguine/edits.js: the player's own hand on the record (app half).
 *
 * The pure half is `edit-table.js`. This is the layer that actually writes, and the whole of its
 * job is to route an edit to the right substrate. There are two, and confusing them is the bug this
 * file exists to make impossible:
 *
 *   · DERIVED, inventory, vitals, marks. A fold over the append-only ledger. There is no cell to
 *     assign to, so an edit is an appended `src: 'user'` event (`chronicle.recordUserEvent`,
 *     anchored at `USER_ANCHOR` so it survives every branch). The correction lands in the same
 *     trail as the narrator's claims and shows in the row's audit disclosure.
 *   · STORED, threads, cast, the clock. Ordinary tables, written directly through the writers
 *     that already exist (`clocks.set`, `entities.setPlace`, …). No event, because there is no
 *     fold to re-derive them from.
 *
 * Two deletes, per row.
 *
 * `remove*` records that the thing LEFT, dropped, sold, healed, resolved. A real event, kept in
 * the trail, undone by a swipe like anything else.
 *
 * `forget*` says it was never true: the model asserted a row that never existed, and recording a
 * loss to cancel it would put fiction in the audit trail to correct fiction on the panel. It erases
 * the asserting events through the ledger's own `forget` op. Only derived rows can be forgotten,
 * a stored row has no originating event, so its delete is simply a delete.
 */

import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as flows from './flows.js';
import * as observe from './observe.js';
import * as components from './parts.js';
import * as places from './places.js';
import { derive, isPoi, loadClock } from './state.js';
import {
    abilityDelta,
    abilityRankDelta,
    deletionDelta,
    editSummary,
    eventsTouching,
    moveDelta,
    rekeyPlan,
    renameDelta,
    splitDelta,
    vitalDelta,
    withoutTarget,
} from './edit-table.js';
import { PLACE_DESTROYED } from './place-table.js';
import { ABILITIES, itemKey, normalizeItemName, normalizePlace, splitItemKey } from './state-table.js';

/**
 * Append a hand edit, counting it so the diagnostics can say how much of the record is the
 * player's rather than the model's.
 *
 * @param {string} summary What to write in the trail.
 * @param {string[]} keywords Keywords for recall.
 * @param {object} delta The delta.
 * @param {string} rule The counter to bump.
 * @returns {boolean} Whether it was recorded.
 */
function append(summary, keywords, delta, rule) {
    const recorded = chronicle.recordUserEvent({ summary, keywords, delta });
    if (recorded) {
        observe.note(rule);
    }
    return Boolean(recorded);
}

/** @returns {{qty: number}|null} What the fold currently holds for a key. */
function held(key) {
    return derive().inv.get(key) ?? null;
}

/** @returns {{name: string, rank?: string}|null} The capability row for a key, or null. */
function known(key) {
    return derive().abilities.get(key) ?? null;
}

// Re-keying: the side tables the ledger's own transfer does not move (§7.5).

/**
 * Point every flow that was aimed at one row at the row it has become.
 *
 * The latent half of the same defect.
 *
 * A flow does not store an item key; it stores `item`, `at` and `who`, and `accrue`, `netRate` and
 * every panel that groups by target rebuild the key with `itemKey(flow.item, flow.at, flow.who)`.
 * That is one spelling of the key, correctly, and it means a rename or a move leaves the rate aimed
 * at a row that has stopped existing. The shop keeps earning, `applyFlows` credits a key nothing
 * renders, and the money is invisible on every surface while still being in the ledger's arithmetic.
 * Nothing has ever reported it, because from the flow's side nothing is wrong.
 *
 * Routed through `flows.set`, which is the table's only writer: it re-normalises, keeps `from` when
 * the ruler has not changed (so a retarget bills for nothing it was not already owed), and reports
 * `flow:edited` like any other edit.
 *
 * @param {string} from The key as it stood.
 * @param {string} to The key it now stands under.
 * @returns {number} How many rates were retargeted.
 */
function retargetFlows(from, to) {
    if (!from || !to || from === to) {
        return 0;
    }
    const clock = loadClock();
    const landed = splitItemKey(to);
    let moved = 0;
    for (const flow of flows.list(clock)) {
        if (itemKey(flow.item, flow.at, flow.who) !== from) {
            continue;
        }
        if (flows.set(flow.label, { item: landed.name, at: landed.place, who: landed.who }, clock)) {
            moved++;
        }
    }
    return moved;
}

/**
 * Carry everything addressed by an item key across to the key the row now lives under.
 *
 * Called from `editItem` at the one seam where both keys exist. `faces`, `contributors` and `since`
 * need nothing: they are rebuilt by every `derive()` from the events, which the transfer already
 * moved. What is stored has to be moved by hand, and this is the whole list of it.
 *
 * @param {string} from The key as it stood.
 * @param {string} to The key it now stands under.
 */
function carryKey(from, to) {
    if (!from || !to || from === to) {
        return;
    }
    components.rekey(from, to);
    retargetFlows(from, to);
}

/**
 * The destroyed place a proposed destination is inside, if any.
 *
 * Fail-open: a place with no record answers null, which is every place in every existing chat.
 *
 * @param {string} place A place, as written.
 * @returns {{key: string, row: object}|null} The retired record, or null.
 */
function shutAway(place) {
    return places.unreachable(place);
}

/**
 * Refuse a write that would put something inside a place that no longer stands, and say so.
 *
 * @param {string} what The thing being written, for the log.
 * @param {string} place The destination place, as written.
 * @returns {boolean} True when the write must not happen.
 */
function refusedByDestruction(what, place) {
    const shut = shutAway(place);
    if (!shut) {
        return false;
    }
    observe.noteRejections([{
        item: String(what ?? ''),
        reason: PLACE_DESTROYED,
        raw: { place, record: shut.row?.name ?? shut.key, status: shut.row?.status ?? '' },
    }]);
    return true;
}

// Inventory.

/**
 * Add a row the story did not record.
 * @returns {boolean} Whether it was recorded.
 */
export function addItem(rawName, qty = 1, place = '') {
    const parsed = normalizeItemName(rawName);
    const amount = Math.trunc(Number(qty) || 0);
    if (!parsed || amount <= 0) return false;
    const at = place ? normalizePlace(place) : '';
    // Nothing is put down somewhere the record says no longer stands. Refused rather than written,
    // because the alternative is a row fold immediately renders as unreachable, a thing you own and
    // cannot get at, created by the act of recording it.
    if (at && refusedByDestruction(parsed.name, at)) return false;
    return append(
        editSummary('Added', `${amount > 1 ? `${amount} ` : ''}${parsed.name}`, at && at !== 'carried' ? `at ${at}` : ''),
        [parsed.name],
        { inv: [{ item: parsed.name, dq: amount, ...(at && at !== 'carried' ? { at } : {}) }] },
        'edit:item-added',
    );
}

/**
 * Set a row to an exact count, as the difference from what is held.
 * @returns {boolean} Whether it was recorded.
 */
export function setItemQty(key, qty) {
    const row = held(key);
    const want = Math.trunc(Number(qty) || 0);
    if (!row || want < 0) return false;
    const delta = want - row.qty;
    if (!delta) return false;
    const { name, place, who } = splitItemKey(key);
    return append(
        editSummary(delta > 0 ? 'Gained' : 'Lost', `${Math.abs(delta)} ${name}`),
        [name],
        { inv: [{ item: name, dq: delta, ...(place && place !== 'carried' ? { at: place } : {}), ...(who ? { who } : {}) }] },
        'edit:item-qty',
    );
}

/** Rename a row, carrying its count. @returns {boolean} Whether it was recorded. */
export function renameItem(key, to) {
    const row = held(key);
    const delta = row && renameDelta(key, to, row.qty);
    if (!delta) return false;
    return append(editSummary('Renamed', splitItemKey(key).name, `to ${normalizeItemName(to).name}`),
        [splitItemKey(key).name, normalizeItemName(to).name], delta, 'edit:item-renamed');
}

/** Move a row to another place. @returns {boolean} Whether it was recorded. */
export function moveItemTo(key, place) {
    const row = held(key);
    const delta = row && moveDelta(key, place, row.qty);
    if (!delta) return false;
    if (refusedByDestruction(splitItemKey(key).name, place)) return false;
    return append(editSummary('Moved', splitItemKey(key).name, `to ${normalizePlace(place)}`),
        [splitItemKey(key).name], delta, 'edit:item-moved');
}

/**
 * Record that a row left the story.
 *
 * Its components go with it. An enchantment is a claim ABOUT a thing, so keeping it once the thing
 * is gone would leave the table asserting a property of nothing, and `orphanParts` would sweep it
 * anyway, later and less honestly. Dropped here, where the intent is explicit.
 *
 * @returns {boolean} Whether it was recorded.
 */
export function removeItem(key) {
    const row = held(key);
    const delta = row && deletionDelta(key, row.qty);
    if (!delta) return false;
    const done = append(editSummary('No longer has', splitItemKey(key).name), [splitItemKey(key).name], delta, 'edit:item-removed');
    if (done) components.drop(key);
    return done;
}

/**
 * Set the grade the story gave a row.
 *
 * A change that moves no quantity.
 *
 * `deriveState` has carried this since ranks were introduced: an `inv` delta of `{dq: 0, rank}`
 * against a row that already exists writes the grade and nothing else, which is what makes
 * `Quarterstaff proficiency (E) → (D)` one row whose grade changed rather than two abilities. Every
 * writer of that shape was the extraction model; the player had no way to state a grade at all, so
 * the one per-item attribute fold tracks was readable on the panel and unwritable from it.
 *
 * An EMPTY grade is refused rather than recorded. The fold applies a rank only when it is truthy, so
 * an empty one would append an event that changes nothing and then sit in the trail claiming it did
 *, the `no-change` refusal the extraction path already gives the model, applied to the player.
 *
 * @param {string} key The inventory key.
 * @param {string} rank The grade, in whatever system the setting uses.
 * @returns {boolean} Whether it was recorded.
 */
export function setItemRank(key, rank) {
    const row = held(key);
    const grade = String(rank ?? '').trim();
    if (!row || !grade || grade === String(row.rank ?? '').trim()) return false;
    const { name, place, who } = splitItemKey(key);
    return append(
        editSummary('Graded', name, grade),
        [name],
        { inv: [{ item: name, dq: 0, rank: grade, ...(place && place !== 'carried' ? { at: place } : {}), ...(who ? { who } : {}) }] },
        'edit:item-ranked',
    );
}

/**
 * Break one row into the things it actually was.
 *
 * The repair the owner had to perform four dialogs at a time on the live Raccoon City ledger, see
 * `splitDelta` for the case and for why it is one transfer rather than a delete and three adds.
 *
 * @param {string} key The inventory key.
 * @param {Array<{name: string, qty?: number}>} parts What it actually is.
 * @returns {string[]} The keys the parts landed under, or [] if nothing was recorded.
 */
export function splitItem(key, parts) {
    const row = held(key);
    const delta = row && splitDelta(key, parts, row.qty);
    if (!delta) return [];
    const { name, place, who } = splitItemKey(key);
    const credits = delta.inv.slice(1);
    const recorded = append(
        editSummary('Split', name, credits.map(c => `${c.item}${c.dq > 1 ? ` x${c.dq}` : ''}`).join(', ')),
        [name, ...credits.map(c => c.item)],
        delta,
        'edit:item-split',
    );
    return recorded ? credits.map(c => itemKey(c.item, place, who)) : [];
}

// Abilities.
//
// A capability is not a thing with a count in a place (`state-table.js` `foldAbility`), so it gets
// writers that say so: granted, revoked, re-graded, renamed. There is no `setAbilityQty` and there
// never will be, that is the whole point of the separation.

/**
 * Record a capability the story gave and fold missed.
 * @returns {boolean} Whether it was recorded.
 */
export function addAbility(rawName, rank = '', who = '') {
    const parsed = normalizeItemName(rawName);
    if (!parsed) return false;
    const key = itemKey(parsed.name, ABILITIES, who);
    return append(
        editSummary('Learned', parsed.name, String(rank ?? '').trim()),
        [parsed.name],
        abilityDelta(key, true, rank),
        'edit:ability-added',
    );
}

/** Record that a capability was lost or revoked. @returns {boolean} Whether it was recorded. */
export function removeAbility(key) {
    if (!known(key)) return false;
    const { name } = splitItemKey(key);
    return append(editSummary('No longer has', name), [name], abilityDelta(key, false), 'edit:ability-removed');
}

/**
 * Set the grade the story gave a capability.
 *
 * The same rule `setItemRank` keeps and for the same reason: an empty grade is refused rather than
 * recorded, because the fold applies a rank only when it is truthy and an empty one would append an
 * event that changes nothing while claiming it did.
 *
 * @returns {boolean} Whether it was recorded.
 */
export function setAbilityRank(key, rank) {
    const row = known(key);
    const grade = String(rank ?? '').trim();
    if (!row || !grade || grade === String(row.rank ?? '').trim()) return false;
    const { name } = splitItemKey(key);
    return append(editSummary('Graded', name, grade), [name], abilityRankDelta(key, grade), 'edit:ability-ranked');
}

/**
 * Rename a capability, carrying its grade.
 *
 * Two halves of a transfer, exactly as `renameItem` is, a revocation of the old name and a grant of
 * the new one, in one event, so a swipe takes both. The grade rides the granting half, which is what
 * `renameDelta` cannot do for an item and is why `editItem` has to restate it afterwards.
 *
 * @returns {boolean} Whether it was recorded.
 */
export function renameAbility(key, to) {
    const row = known(key);
    const parsed = normalizeItemName(to);
    const { name, who } = splitItemKey(key);
    if (!row || !parsed || parsed.name === name) return false;
    const grade = String(row.rank ?? '').trim();
    return append(
        editSummary('Renamed', name, `to ${parsed.name}`),
        [name, parsed.name],
        {
            inv: [
                ...abilityDelta(key, false).inv,
                ...abilityDelta(itemKey(parsed.name, ABILITIES, who), true, grade).inv,
            ],
        },
        'edit:ability-renamed',
    );
}

/**
 * Apply a capability row's edits, in the order that survives the key moving.
 *
 * `editItem`'s argument, minus the two columns an ability does not have. A rename retargets the key,
 * so it goes first and the grade is restated afterwards on the key as it finally stands.
 *
 * @param {string} key The ability key as it stands now.
 * @param {object} fields Changed columns, as `ABILITY_FIELDS` names them.
 * @returns {string} The key the row now lives under, or '' if nothing was recorded.
 */
export function editAbility(key, { name, rank } = {}) {
    let at = String(key ?? '');
    let changed = false;
    const grade = typeof rank === 'string' ? rank : String(known(at)?.rank ?? '');

    if (typeof name === 'string' && name.trim() && renameAbility(at, name)) {
        const parts = splitItemKey(at);
        at = itemKey(normalizeItemName(name)?.name ?? parts.name, ABILITIES, parts.who);
        changed = true;
    }
    if (setAbilityRank(at, grade)) {
        changed = true;
    }
    return changed ? at : '';
}

/** Forget a capability. @returns {number} Events erased. */
export function forgetAbility(key) {
    return forgetRow({ kind: 'ability', key });
}

/**
 * Apply a whole row's worth of edits, in the only order that survives.
 *
 * Why the order is load-bearing.
 *
 * There is no item record. Each of these four columns is a separate appended event, and two of them
 * CHANGE THE KEY the next one would be addressed with: a move retargets the place half, a rename
 * retargets the name half. Applying them in spec order would send the second edit to a key that
 * stopped existing one event ago, and `held()` would return null, and the edit would look like it
 * saved and did nothing, the exact class `tests/sanguine-edit-writers.test.js` was written for.
 *
 * So: move, rename, count, grade.
 *
 *   · Move and rename go FIRST and while the count is still whole, because both are transfers of
 *     the held quantity between two keys and `renameDelta`/`moveDelta` refuse a row at zero.
 *   · The count goes after them, so setting a row to 0, which retires the key, cannot strand the
 *     move and the rename that were asked for in the same breath.
 *   · The grade goes LAST, on the key as it finally stands. This is also the repair for a standing
 *     defect: a rename is two halves of a transfer, and the receiving half arrives as a fresh row
 *     with no grade, so a rename used to silently drop it. Re-applying the grade at the end carries
 *     it across.
 *
 * Only fields that are present are touched, so a dialog that changed one line does not restamp the
 * other three.
 *
 * @param {string} key The inventory key as it stands now.
 * @param {object} fields Changed columns, as `ITEM_FIELDS` names them.
 * @param {string} [fields.name] New name.
 * @param {string} [fields.rank] New grade.
 * @param {string|number} [fields.qty] The exact count to land on.
 * @param {string} [fields.place] Where it should be.
 * @returns {string} The key the row now lives under, or '' if nothing was recorded.
 */
export function editItem(key, { name, rank, qty, place } = {}) {
    let at = String(key ?? '');
    let changed = false;

    // Read before anything moves. A move and a rename are each two halves of a transfer, and the
    // RECEIVING half is a fresh row carrying a quantity and nothing else, so the grade dies at the
    // transfer unless it is re-stated afterwards. What the player typed wins; what the row already
    // had is what gets carried when they typed nothing.
    const grade = typeof rank === 'string' ? rank : String(held(at)?.rank ?? '');

    // The key moves, and the stored side tables move with it.
    //
    // `rekeyPlan` is the single definition of where the row lands, shared with the delta builders so
    // the two cannot spell the destination differently. `carryKey` moves what the transfer does not:
    // the components (`state.parts`) and the rates aimed at the row (`state.flows`). Everything else
    // addressed by an item key, `faces`, `contributors`, `since`, is rebuilt by the next `derive()`
    // out of the events the transfer already moved.
    if (typeof place === 'string' && place.trim() && moveItemTo(at, place)) {
        const plan = rekeyPlan(at, { place });
        carryKey(plan.from, plan.to);
        at = plan.to;
        changed = true;
    }
    if (typeof name === 'string' && name.trim() && renameItem(at, name)) {
        const plan = rekeyPlan(at, { name });
        carryKey(plan.from, plan.to);
        at = plan.to;
        changed = true;
    }
    // `''` is "the player cleared the box", which is not a count; only an actual number is a claim
    // about how many. Read through Number so '007' and ' 7 ' are both seven.
    if (qty !== undefined && qty !== null && String(qty).trim() !== '') {
        const want = Number(qty);
        if (Number.isFinite(want) && setItemQty(at, want)) changed = true;
    }
    if (setItemRank(at, grade)) {
        changed = true;
    }
    return changed ? at : '';
}

// Vitals.

/** Set a gauge to an exact reading. @returns {boolean} Whether it was recorded. */
export function setVital(name, want) {
    const gauge = String(name ?? '').trim().toLowerCase();
    const delta = vitalDelta(gauge, want, derive().vitals.get(gauge) ?? {});
    if (!delta) return false;
    const reading = [want?.cur, want?.max].filter(v => Number.isFinite(Number(v))).join('/');
    return append(editSummary('Set', gauge, reading), [gauge], delta, 'edit:vital-set');
}

// Marks.

/** Record that a condition has cleared. @returns {boolean} Whether it was recorded. */
export function clearMark(key) {
    const mark = derive().marks.get(key);
    if (!mark) return false;
    const subject = String(mark.subject ?? '') || String(mark.phrase ?? '');
    return append(
        editSummary('Cleared', mark.phrase || subject),
        [subject].filter(Boolean),
        { st: [{ who: mark.who ?? '', subject, flag: mark.phrase || subject, on: false }] },
        'edit:mark-cleared',
    );
}

// Forgetting: the row that was never true.

/**
 * Erase the events that asserted a derived row.
 *
 * @param {{kind: string, key: string}} target An `edit-table.js` target.
 * @returns {number} How many events were forgotten.
 */
export function forgetRow(target) {
    const entries = chronicle.liveEntries();
    const doomed = eventsTouching(entries, target);
    const deltas = new Map(entries);
    // Counted by what was actually CHANGED, not by what matched. The first cut returned the match
    // count, so a `forget` addressed with the wrong key reported two successes and changed nothing.
    let erased = 0;
    for (const key of doomed) {
        // Cut the row, not the turn.
        //
        // Deleting the whole event is lawful and overshoots: it destroys every row that happened to
        // arrive in the same turn. On the live Raccoon City campaign the SUV glovebox event carried
        // ten items, so one × on Gum took the ammunition and the med kit with it. `withoutTarget`
        // computes what survives the cut; null means the event carried nothing else, and there the
        // minimal incision and the deletion are the same operation.
        const rest = withoutTarget(deltas.get(key)?.d, target);
        const changed = rest === null ? chronicle.forget(key) : chronicle.reviseDelta(key, rest);
        if (changed) erased++;
    }
    if (erased) {
        observe.note('edit:forgotten', erased);
    }
    return erased;
}

/**
 * Forget an inventory row.
 *
 * A row that was NEVER TRUE never had components either, so they go with the events that claimed it.
 * Not a `sweep`: this is not an orphan whose owner left, it is a correction to something that was
 * always fiction.
 *
 * @returns {number} Events erased.
 */
export function forgetItem(key) {
    const erased = forgetRow({ kind: 'item', key });
    if (erased) components.drop(key);
    return erased;
}

/** Forget a gauge. @returns {number} Events erased. */
export function forgetVital(name) {
    return forgetRow({ kind: 'vital', key: String(name ?? '').trim().toLowerCase() });
}

/** Forget a condition. @returns {number} Events erased. */
export function forgetMark(key) {
    return forgetRow({ kind: 'mark', key });
}

// Stored tables: threads, cast, clock.

/**
 * Edit a thread in place.
 *
 * Stored rather than derived, so this is a table write and not an event, `clocks.set` is the same
 * writer the extraction pass uses, which keeps one path into the table.
 *
 * @returns {boolean} Whether anything changed.
 */
export function editThread(name, fields) {
    // `clocks.set` takes a NAME and normalises it to the key itself, it is the same GM override
    // the panel has always had, and routing through it keeps one path into the thread table.
    return Boolean(clocks.set(name, { ...fields, turn: entities.turn() }));
}

/** Close a thread by hand, the way the review would. @returns {boolean} Whether it changed. */
export function closeThread(name, status = 'closed') {
    return editThread(name, { status });
}

/** Drop a thread that should never have been one. @returns {boolean} Whether it was removed. */
export function deleteThread(key) {
    const gone = clocks.remove(key);
    if (gone) observe.note('edit:thread-deleted');
    return gone;
}

/**
 * Edit a cast row in place.
 *
 * Routed through `entities.merge`-adjacent writers where they exist so the trail and the versioned
 * merge keep working; `foldEntity` is field-wise last-write, so an omitted field is silence rather
 * than an erasure.
 *
 * @returns {boolean} Whether anything changed.
 */
export function editCast(key, fields) {
    if (!entities.load().has(key)) return false;
    let changed = false;
    if (typeof fields?.place === 'string' && entities.setPlace(key, fields.place)) changed = true;
    if (Number.isFinite(Number(fields?.threat)) && entities.setThreat(key, Number(fields.threat))) changed = true;
    // The prose columns go through `entities.patch`, the sibling of `clocks.set`. The four dossier
    // columns are included, so the row editor can correct a description rather than only the fields
    // that predate it, `patch` clamps them to whichever tier this row is on.
    const columns = ['name', 'aka', 'detail', 'reach', 'wants', 'knows', 'facts', 'status',
        'look', 'wearing', 'bearing', 'history'];
    const wanted = {};
    for (const column of columns) {
        if (typeof fields?.[column] === 'string') wanted[column] = fields[column];
    }
    if (entities.patch(key, wanted, { flagged: isPoi(key) })) changed = true;
    if (changed) observe.note('edit:cast-edited');
    return changed;
}

/** Drop a cast row that should never have been one. @returns {boolean} Whether it was removed. */
export function deleteCast(key) {
    const gone = entities.remove(key);
    if (gone) observe.note('edit:cast-deleted');
    return gone;
}

/**
 * Revert one trail change: write the superseded value back.
 * The trail entry already carries what the field used to be (`from`), so undo is a compensating
 * write down the same hand path a row edit takes, and `entities.patch` records the reversal as a
 * trail entry of its own, so the history shows both directions and undoing the undo restores the
 * newer value.
 *
 * @param {string} key The entity key.
 * @param {object} change The trail entry, `{field, from}`.
 * @returns {boolean} True if a write landed.
 */
export function undoCastChange(key, change) {
    const field = String(change?.field ?? '').trim();
    const from = String(change?.from ?? '').trim();
    if (!field) return false;
    const reverted = entities.patch(key, { [field]: from }, { flagged: isPoi(key) });
    if (reverted) observe.note('edit:cast-undone');
    return reverted;
}
