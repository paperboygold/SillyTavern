/**
 * sanguine/edit-table.js: what a hand edit means, as data (pure half).
 *
 * The app half is `edits.js`; nothing here touches storage, the chronicle or the DOM.
 *
 * Why an edit is not an assignment.
 *
 * RPG Companion edits its inventory by splicing an array and re-serialising the string it lives in
 * (`src/systems/interaction/inventoryActions.js:238` `removeItem`, `inventoryEdit.js:22`
 * `updateInventoryItem`). That is the right shape for a value held in settings, and the wrong one
 * here: sanguine's inventory, vitals and marks are a FOLD over an append-only ledger, so there is
 * no cell to assign to. `state.inv` is a projection, and writing to a projection is writing to a
 * shadow: the next derive would overwrite it.
 *
 * So a hand edit is an EVENT, appended like any other (`chronicle.recordUserEvent`, anchored at
 * `USER_ANCHOR` so it stays live on every branch). The player's correction lands in the same trail
 * as the narrator's claims, is visible in the row's audit disclosure, and survives a swipe.
 *
 * Two deletes, because "gone" is two different facts.
 *
 * Asked what deleting a row should mean, the answer was both, chosen per row, and the ledger
 * already had both primitives:
 *
 *   · the thing LEFT the story, dropped, sold, broken. That is a real event and belongs in the
 *     trail: an appended delta that takes the quantity to zero. `deletionDelta` builds it.
 *   · the thing was NEVER TRUE, the model hallucinated a row you never owned. Recording "lost 1
 *     phantom sword" would put fiction in the audit trail to correct fiction on the panel. The
 *     honest operation is to remove the events that asserted it, which is the ledger's `forget`.
 *     `eventsTouching` finds them.
 *
 * Neither is a superset of the other, which is why picking one silently would have been wrong.
 */

import { ABILITIES, CARRIED, itemKey, splitItemKey, normalizeItemName, normalizePlace, MONEY } from './state-table.js';
import { markKey } from './state-table.js';

/**
 * What a hand edit can be about. Each names a different fold, not a different table.
 *
 * `ability` joined them when capabilities stopped being inventory (`state-table.js` `foldAbility`).
 * It is a separate target rather than a flavour of `item` because the two answer different questions
 *, an item edit is about a count and a place, and an ability has neither, but they address rows
 * the same way, because `foldAbility` deliberately kept `itemKey(name, ABILITIES, who)`.
 */
export const TARGETS = Object.freeze(['item', 'ability', 'vital', 'mark']);

/**
 * The event keys whose delta asserts something about a target.
 *
 * `contributors` carries `{at, dq, summary, mid}` and deliberately no event key, it exists to
 * explain a quantity, not to address the events behind it. Forgetting needs the address, so it is
 * recovered here by matching on fold's OWN keys: an item's `itemKey`, a vital's normalised name, a
 * mark's `markKey`. No prose is read, and the match is exact rather than fuzzy, a `forget` that
 * guessed would erase a neighbour.
 *
 * Takes `[key, event]` PAIRS, not bare events. An event's own `k` field is its anchor, the content
 * hash of the message it came from, or `USER_ANCHOR` for a hand edit, and several events share
 * one. Addressing `forget` with it silently deletes nothing while reporting success, which is what
 * the first cut of this did.
 *
 * @param {Array<[string, object]>} entries Live entries, as `chronicle.liveEntries()` returns them.
 * @param {{kind: string, key?: string, name?: string}} target What to look for.
 * @returns {string[]} TABLE keys, oldest first.
 */
export function eventsTouching(entries, target) {
    const kind = String(target?.kind ?? '');
    const wanted = String(target?.key ?? '');
    const found = [];

    for (const [tableKey, event] of Array.isArray(entries) ? entries : []) {
        const delta = event?.d;
        if (!delta || !tableKey) continue;
        let touches = false;

        if (kind === 'item' || kind === 'ability') {
            for (const change of delta.inv ?? []) {
                const parsed = normalizeItemName(change?.item);
                if (!parsed) continue;
                if (itemKey(parsed.name, change?.at, change?.who) === wanted) {
                    touches = true;
                    break;
                }
            }
        } else if (kind === 'vital') {
            for (const change of delta.vit ?? []) {
                if (String(change?.name ?? '').trim().toLowerCase() === wanted) {
                    touches = true;
                    break;
                }
            }
        } else if (kind === 'mark') {
            for (const change of delta.st ?? []) {
                const subject = String(change?.subject ?? '') || String(change?.flag ?? '');
                if (markKey(change?.who ?? '', subject) === wanted) {
                    touches = true;
                    break;
                }
            }
        }

        if (touches) found.push(tableKey);
    }

    return found;
}

/**
 * Whether one change inside a delta is about a target.
 *
 * The addressing `eventsTouching` does, per change rather than per event, same keys, same exactness,
 * so the two can never disagree about what "this row" means.
 *
 * @param {string} kind The target kind.
 * @param {string} wanted The target key.
 * @param {string} array Which delta array the change came from.
 * @param {object} change One proposed change.
 * @returns {boolean} True when the change is about the target.
 */
function changeHits(kind, wanted, array, change) {
    if ((kind === 'item' || kind === 'ability') && array === 'inv') {
        const parsed = normalizeItemName(change?.item);
        return !!parsed && itemKey(parsed.name, change?.at, change?.who) === wanted;
    }
    if (kind === 'vital' && array === 'vit') {
        return String(change?.name ?? '').trim().toLowerCase() === wanted;
    }
    if (kind === 'mark' && array === 'st') {
        const subject = String(change?.subject ?? '') || String(change?.flag ?? '');
        return markKey(change?.who ?? '', subject) === wanted;
    }
    return false;
}

/**
 * A delta with one row's claims cut out of it, and everything else left standing.
 *
 * Why forgetting a row must not forget the turn it arrived in.
 *
 * `forgetRow` used to delete every event `eventsTouching` returned, whole. That is the MAXIMAL
 * incision: it does retract the belief (`full_removal_is_an_incision`,
 * `sanguine/proof/Substrate/Algebra/Security/BeliefContraction.lean:361`) and it destroys every
 * belief carried only by the bystanders, which a minimal cut provably keeps
 * (`maximal_removal_overshoots`, `:579`).
 *
 * That is not a theoretical cost. MEASURED on the live Raccoon City campaign: 6 of 19
 * inventory-bearing events carry more than one row, and the largest carries ten, the SUV glovebox
 * turn, holding maps, flashlight, ammunition, notebook, pen, gum, tactical bag, clothes, med kit and
 * shotgun shells. Pressing × on Gum destroyed the other nine, silently.
 *
 * `removal_succeeds_iff` (`:308`) names the operator: a removal retracts a belief iff it cuts every
 * KERNEL, every minimal support. The kernel of "the pack holds gum" is the `inv` entry naming gum,
 * not the event that happened to carry it, so the cut is per change.
 *
 * Needs no new ledger op: `chronicle.saveEvents` diffs the table and emits `ev` for any event whose
 * value changed, so a revised delta rides the existing protocol.
 *
 * @param {object} delta An event's delta.
 * @param {{kind: string, key?: string}} target What to cut out.
 * @returns {object|null} The remaining delta, or null when nothing survives the cut.
 */
export function withoutTarget(delta, target) {
    const kind = String(target?.kind ?? '');
    const wanted = String(target?.key ?? '');
    if (!delta || typeof delta !== 'object') {
        return null;
    }

    const rest = {};
    let cut = false;
    for (const [array, value] of Object.entries(delta)) {
        if (!Array.isArray(value)) {
            rest[array] = value;
            continue;
        }
        const kept = value.filter(change => !changeHits(kind, wanted, array, change));
        if (kept.length !== value.length) {
            cut = true;
        }
        // An emptied array is dropped rather than left as `[]`: every reader treats a missing array
        // and an empty one alike, and a delta of empty arrays would read as an event that did
        // something.
        if (kept.length) {
            rest[array] = kept;
        }
    }

    if (!Object.keys(rest).length) {
        // Nothing but the target was in here. Null is the signal to forget the event outright,
        // where there are no bystanders, the minimal incision and the deletion are the same cut.
        return null;
    }
    return cut ? rest : delta;
}

/**
 * The delta that removes a held row as a story event.
 *
 * An exact negative of what is held, so the fold lands on zero and `deriveState` drops the row,
 * the same path a narrated loss takes. Not a `set: 0`: a zero restatement is read as "not a
 * restatement" throughout this codebase (strict mode forces the field into every row), so it would
 * silently do nothing.
 *
 * @param {string} key The inventory key.
 * @param {number} held How many are held.
 * @returns {{inv: object[]}|null} A delta, or null when there is nothing to remove.
 */
export function deletionDelta(key, held) {
    const qty = Math.trunc(Number(held) || 0);
    if (!key || qty <= 0) {
        return null;
    }
    const { place, name, who } = splitItemKey(key);
    return {
        inv: [{
            item: name,
            dq: -qty,
            ...(place && place !== 'carried' ? { at: place } : {}),
            ...(who ? { who } : {}),
        }],
    };
}

/**
 * The delta that moves a row from one place to another.
 *
 * Two halves of one transfer, which is exactly how the delta schema already tells the model to
 * express a move ("moving between places is a loss in one and a gain in the other"). Expressing it
 * as a rename would lose the arithmetic; expressing it as two events would let a swipe keep one.
 *
 * @param {string} key The inventory key now.
 * @param {string} to Destination place.
 * @param {number} held How many are held.
 * @returns {{inv: object[]}|null} A delta, or null when the move is a no-op.
 */
export function moveDelta(key, to, held) {
    const qty = Math.trunc(Number(held) || 0);
    const destination = normalizePlace(to);
    if (!key || qty <= 0) return null;
    const { place, name, who } = splitItemKey(key);
    if (destination === place) return null;
    const owner = who ? { who } : {};
    return {
        inv: [
            { item: name, dq: -qty, ...(place && place !== 'carried' ? { at: place } : {}), ...owner },
            { item: name, dq: qty, ...(destination !== 'carried' ? { at: destination } : {}), ...owner },
        ],
    };
}

/**
 * The delta that renames a row, as a move between names.
 *
 * The crosswalk exists to MERGE two names the model used for one thing, and is the right mechanism
 * when both spellings are the story's. A hand rename is a different intent, "call it this", and
 * routing it through the crosswalk would make it a claim about identity that a later verdict could
 * overturn. Two halves of a transfer keeps it a fact about quantity.
 *
 * @param {string} key The inventory key now.
 * @param {string} to The new name.
 * @param {number} held How many are held.
 * @returns {{inv: object[]}|null} A delta, or null when the rename is a no-op.
 */
export function renameDelta(key, to, held) {
    const qty = Math.trunc(Number(held) || 0);
    const parsed = normalizeItemName(to);
    if (!key || qty <= 0 || !parsed) return null;
    const { place, name, who } = splitItemKey(key);
    if (parsed.name === name) return null;
    const at = place && place !== 'carried' ? { at: place } : {};
    const owner = who ? { who } : {};
    return {
        inv: [
            { item: name, dq: -qty, ...at, ...owner },
            { item: parsed.name, dq: qty, ...at, ...owner },
        ],
    };
}

/**
 * The delta that breaks one row into several, as the story clarifies what it was.
 *
 * The operation the record could not express, in the owner's own words.
 *
 * > "I've just gone through and manually changed ammo to make a bit more sense. But they still
 * > don't really. Like I specifically said there was 63 9mm rounds instead of just 'ammunition'."
 *
 * The live Raccoon City ledger holds the shape of it. At mid 40 the narration says Solomon bought
 * "a Sig P226 with three magazines and a Mossberg 590 with twenty-five rounds of buckshot plus a box
 * of birdshot", and the extraction reported one row: `{item: "ammunition", dq: 28}`: three
 * different, non-interchangeable things summed into a mass noun. Repairing that by hand took FOUR
 * operations: delete the row, then add `9mm magazines x3`, `buckshot shells x25` and
 * `box of birdshot x1` one dialog at a time. Three of those four survive in the chat as `src: 'user'`
 * events, which is what a missing affordance looks like in a ledger.
 *
 * Why it is a transfer and not a rename or a delete.
 *
 * A split is `renameDelta` with more than one destination, and it is expressed the same way for the
 * same reason: two halves of a transfer, so the arithmetic stays a sum and a swipe takes the whole
 * operation or none of it. Recording it as a delete plus three adds would work and would lose the
 * fact that they are one correction, the audit trail would say the ammunition was lost and, in an
 * unrelated event, some magazines appeared.
 *
 * The debit is the SUM of the parts, clamped to what is held. That is what makes it a split rather
 * than an invention: a leftover stays under the old name and says so on the panel, which is honest
 * about a player who accounted for 28 of 30. When the parts cover the whole row the source empties
 * and `deriveState` drops it, exactly as a narrated loss does.
 *
 * And the model can do this too, with nothing new.
 *
 * The delta schema already lets one event carry several `inv` entries, so
 * `[{item: "ammunition", dq: -25}, {item: "buckshot shells", dq: 25}]` is expressible today and
 * passes every gate (the debit is against a held row, the credit is a first sighting). What was
 * missing was that nothing ever told it to. That is a `deltaInstruction` change and lives in
 * `state.js`; this is the same operation for the hand that has to clean up when it does not happen.
 *
 * @param {string} key The inventory key now.
 * @param {Array<{name: string, qty?: number}>} parts What it actually is.
 * @param {number} held How many are held.
 * @returns {{inv: object[]}|null} A delta, or null when nothing would move.
 */
export function splitDelta(key, parts, held) {
    const qty = Math.trunc(Number(held) || 0);
    if (!key || qty <= 0) {
        return null;
    }
    const { place, name, who } = splitItemKey(key);
    const at = place && place !== CARRIED ? { at: place } : {};
    const owner = who ? { who } : {};

    const credits = [];
    let taken = 0;
    for (const part of Array.isArray(parts) ? parts : []) {
        const parsed = normalizeItemName(part?.name);
        if (!parsed || parsed.name === name) {
            continue;
        }
        // The count comes from the field when there is one and from the name when the player wrote
        // it there ("3x rations"), `normalizeItemName` pulls it out either way, which is the same
        // courtesy `addItem` already extends.
        const want = Math.trunc(Number(part?.qty ?? NaN));
        const amount = Number.isFinite(want) && want > 0 ? want : (parsed.qty ?? 1);
        taken += amount;
        credits.push({ item: parsed.name, dq: amount, ...at, ...owner });
    }

    if (!credits.length) {
        return null;
    }
    // Every part is credited in full and the DEBIT is what the row can pay. The player is the
    // authority on how many of a thing they have, `setItemQty` already takes their number over
    // fold's, so a split that adds up to more than the row held is them correcting two numbers at
    // once, not an error to swallow. Clamping the parts instead was tried and silently dropped the
    // box of birdshot out of the Raccoon City repair, because the three magazines and the
    // twenty-five shells had already used the row up.
    return { inv: [{ item: name, dq: -Math.min(taken, qty), ...at, ...owner }, ...credits] };
}

/**
 * Read the parts of a split out of one text box.
 *
 * One per line, and the count may be written either way round, `3x 9mm magazines`,
 * `9mm magazines x3`, or a bare name for one. That is not a new parser: `normalizeItemName` has
 * pulled a baked-in quantity out of a name since the day models started writing "2 gold coins"
 * instead of filling in the field, and this is the same courtesy `addItem` already extends to a
 * player typing into a name box.
 *
 * A textarea rather than n name/count pairs because the number of parts is not known until it is
 * typed, and a form that makes you press "add another row" three times to correct one row is worse
 * than the four dialogs it replaces.
 *
 * @param {string} text One part per line.
 * @returns {Array<{name: string, qty: number}>} The parts, in the order written.
 */
export function readParts(text) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
        const parsed = normalizeItemName(line);
        if (parsed) {
            out.push({ name: parsed.name, qty: parsed.qty ?? 1 });
        }
    }
    return out;
}

/**
 * The delta that grants or revokes a capability.
 *
 * Presence, which is the whole reason abilities left the item table.
 *
 * `deletionDelta` builds "an exact negative of what is held" because an item has a count to zero
 * out. A capability does not: `foldAbility` reads any positive `dq` as "has it" and any negative one
 * as "does not", so ±1 says everything there is to say. Sending `dq: -qty` here would be arithmetic
 * about a quantity that does not exist.
 *
 * @param {string} key The ability key, as `itemKey(name, ABILITIES, who)` builds it.
 * @param {boolean} on True to grant, false to revoke.
 * @param {string} [rank] The grade, when the story gave one.
 * @returns {{inv: object[]}|null} A delta, or null when the key is unusable.
 */
export function abilityDelta(key, on, rank = '') {
    const { name, who } = splitItemKey(String(key ?? ''));
    if (!name) {
        return null;
    }
    const grade = String(rank ?? '').trim();
    return {
        inv: [{
            item: name,
            dq: on ? 1 : -1,
            at: ABILITIES,
            ...(grade ? { rank: grade } : {}),
            ...(who ? { who } : {}),
        }],
    };
}

/**
 * The delta that re-grades a capability without granting or revoking it.
 *
 * `dq: 0` with a grade is the shape `foldAbility` applies to a row that already exists, the
 * F→E→D case that `rank` was introduced for. Kept apart from `abilityDelta` because a grant and a
 * re-grade are different claims and only one of them can create a row.
 *
 * @param {string} key The ability key.
 * @param {string} rank The grade, in whatever system the setting uses.
 * @returns {{inv: object[]}|null} A delta, or null when there is no grade to state.
 */
export function abilityRankDelta(key, rank) {
    const { name, who } = splitItemKey(String(key ?? ''));
    const grade = String(rank ?? '').trim();
    if (!name || !grade) {
        return null;
    }
    return { inv: [{ item: name, dq: 0, at: ABILITIES, rank: grade, ...(who ? { who } : {}) }] };
}

/**
 * The delta that sets a gauge to an exact reading.
 *
 * `dcur` is a CHANGE and `max` a ceiling, so setting a gauge to a number means sending the
 * difference: the same arithmetic `validateVitals` expects from the narrator. Sending an absolute
 * would be read as a change of that size and land the gauge somewhere nobody asked for.
 *
 * @param {string} name The gauge name.
 * @param {{cur?: number, max?: number}} want The reading to land on.
 * @param {{cur?: number, max?: number}} held What it reads now.
 * @returns {{vit: object[]}|null} A delta, or null when nothing would change.
 */
export function vitalDelta(name, want, held = {}) {
    const gauge = String(name ?? '').trim();
    if (!gauge) return null;

    const nowCur = Number(held?.cur);
    const nowMax = Number(held?.max);
    const wantCur = Number.isFinite(Number(want?.cur)) ? Math.trunc(Number(want.cur)) : null;
    const wantMax = Number.isFinite(Number(want?.max)) ? Math.trunc(Number(want.max)) : null;

    const dcur = wantCur === null ? 0 : wantCur - (Number.isFinite(nowCur) ? nowCur : 0);
    const setMax = wantMax !== null && wantMax > 0 && wantMax !== nowMax;
    if (!dcur && !setMax) return null;

    return {
        vit: [{
            name: gauge,
            dcur,
            // Only when it actually moves: `max: 0` reads as "not stated" everywhere in the fold,
            // and re-sending an unchanged ceiling is noise in the trail.
            ...(setMax ? { max: wantMax } : {}),
        }],
    };
}

/**
 * Where a row LANDS when its name or its place changes.
 *
 * The one definition, because there are now three things that have to agree.
 *
 * `itemKey` encodes `who␀place␀name`, so a move retargets the place half and a rename retargets the
 * name half. `moveDelta` and `renameDelta` express that as two halves of a transfer, which is the
 * whole of what the LEDGER means by it, and the ledger is not the only thing addressed by that key.
 * Four side maps are:
 *
 *   `faces`         the name the story wrote. Derived per fold, so it re-keys for free.
 *   `contributors`  the audit trail. Derived per fold, so it re-keys for free.
 *   `since`         the recency rail. Derived per fold, so it re-keys for free.
 *   `flows`         a stored rate, addressed by `itemKey(flow.item, flow.at, flow.who)`.
 *   `parts`         a stored component (`part-table.js`), keyed by the item key outright.
 *
 * The last two are STORED, and neither moves when the delta does. A rename therefore silently
 * orphaned every component and silently pointed every flow at a row that had stopped existing, the
 * shop kept earning into a key nothing rendered. `flows` has had that exposure since it landed; this
 * is the repair for both, and it is one function rather than two so that the destination the delta
 * transfers TO and the destination the side tables move TO are the same string by construction. Two
 * spellings of that key is two chances to disagree about it, which is the class `itemHead` exists to
 * close.
 *
 * Pure, so the arithmetic is gated rather than asserted; `edits.editItem` applies it.
 *
 * @param {string} key The inventory key as it stands.
 * @param {object} [changed] The columns the edit is changing.
 * @param {string} [changed.place] The destination place, when the edit moves it.
 * @param {string} [changed.name] The new name, when the edit renames it.
 * @returns {{from: string, to: string, moved: boolean}} The two keys, and whether they differ.
 */
export function rekeyPlan(key, { place, name } = {}) {
    const from = String(key ?? '');
    const parts = splitItemKey(from);
    const renamed = typeof name === 'string' && name.trim() ? normalizeItemName(name) : null;
    const at = typeof place === 'string' && place.trim() ? normalizePlace(place) : parts.place;
    const to = itemKey(renamed?.name ?? parts.name, at, parts.who);
    return { from, to, moved: from !== to };
}

/**
 * A readable summary for the trail, built from fold's own keys rather than from prose.
 *
 * @param {string} verb What happened.
 * @param {string} subject What it happened to.
 * @param {string} [detail] Anything worth carrying.
 * @returns {string} A summary line.
 */
export function editSummary(verb, subject, detail = '') {
    return [`${verb} ${subject}`.trim(), detail].filter(Boolean).join(', ').slice(0, 200);
}

/** Whether a place is a money balance, which several editors treat differently. */
export function isMoney(key) {
    return splitItemKey(String(key ?? '')).place === MONEY;
}
