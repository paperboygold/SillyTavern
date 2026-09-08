/**
 * sanguine/parts.js: where the components live, and everything that writes one.
 *
 * The storage half of `part-table.js`, mirroring `places.js` and `flows.js`: the pure module owns
 * the law, this owns the table, the refusals and the budget.
 *
 * Keyed by `itemKey`, because there is no item record to put a column on.
 *
 * Inventory is a FOLD over an append-only ledger (`state-table.js` `deriveState`), so there is no
 * row to assign an enchantment to. Everything richer than a quantity already lives beside the fold
 * under the same key, `faces` (the name the story wrote), `contributors` (the audit trail), `since`
 * (the recency rail) and `flows` (what time is doing to it). This is the fifth, and the first one
 * that is persisted rather than recomputed, which is why it is the first that has to be pruned and
 * the first that has to be re-keyed when the key moves.
 *
 * What is refused, and what merely fails open.
 *
 * Two gates, and they are different kinds of thing:
 *
 *   `parts-full`      a bound. The table is at `MAX_PARTS`, or this row is at `MAX_PARTS_PER_ITEM`.
 *                     Refused with the count, so the log can say which.
 *   `place-destroyed` a contradiction. The item is inside somewhere the record says no longer
 *                     stands, so a claim about its components is a claim about something that
 *                     cannot be reached. Refused rather than written, because writing it would put
 *                     fold on both sides of a fact it is holding.
 *
 * Both reasons travel as DATA through `observe.noteRejections`, the way `places.js` already reports
 * `place-cycle` and `places-full`: the diagnostics tab's `undeclared()` reports them on a live chat
 * until `KNOWN_RULES` learns their names.
 *
 * Everything else fails open. An item whose place has no record has no place record, which is the
 * state of every row in every chat that exists, and nothing here is consulted for an answer it
 * cannot give.
 */

import { turn } from './entities.js';
import { lookup, table_entries } from './lib/hash.js';
import {
    MAX_PARTS,
    MAX_PARTS_PER_ITEM,
    dropParts,
    foldPart,
    orphanParts,
    partFaces,
    partsOf,
    rekeyParts,
    splitPartKey,
} from './part-table.js';
import { PLACE_DESTROYED } from './place-table.js';
import { splitItemKey } from './state-table.js';
import * as observe from './observe.js';
import * as places from './places.js';
import { PRUNE_ARCHIVE, commit, loadTable, registerPruner } from './store.js';

/** Where the components live. */
const PARTS_PATH = 'state.parts';

/** The component table as stored. @returns {Map<string, object>} The table. */
export function load() {
    return loadTable(PARTS_PATH);
}

/**
 * The destroyed place an item is sealed inside, if any.
 *
 * Fail-open by construction: `places.unreachable` answers null for a place string with no record,
 * and null means the string is just a string.
 *
 * @param {string} key An `itemKey`.
 * @returns {{key: string, row: object}|null} The retired record, or null.
 */
export function sealed(key) {
    return places.unreachable(splitItemKey(String(key ?? '')).place);
}

/**
 * Every component of one row, freshest first, with its own recency rail.
 *
 * `since` is counted in TURNS rather than in ledger events, unlike an item's own `since`. The two
 * clocks are different on purpose: a quantity moves when an event moves it, and a component is a
 * standing claim whose age is measured against the story, the same rail `places.snapshot` uses.
 *
 * @param {string} key An `itemKey`.
 * @returns {Array<object>} The components, with `since` attached.
 */
export function list(key) {
    const now = turn();
    return partsOf(load(), key).map(row => ({ ...row, since: Math.max(0, now - row.turn) }));
}

/**
 * Every row's components as one line each, for the injected block and the panel.
 *
 * The same face `faces` has, `Map<itemKey, string>`, so `renderState` can print components without
 * importing `part-table.js`, which would be a cycle. See `partFaces`.
 *
 * @returns {Map<string, string>} Item key -> its components.
 */
export function faces() {
    return partFaces(load());
}

/**
 * Create or revise a component.
 *
 * The one writer. Field-wise is not a question here, a component IS one field, so this is a
 * straight fold with the turn stamped, and an unchanged reading is refused as `no-change` rather
 * than written, because a restatement that moves nothing must not light the recency rail.
 *
 * @param {string} key The `itemKey` of the row it is about.
 * @param {string} name What the component is called.
 * @param {string} value What it reads now.
 * @param {object} [options] Options.
 * @param {number} [options.at] Turn counter.
 * @param {number} [options.mid] Anchor mid, for this component's own cause-link.
 * @returns {{key: string, reason: string}} What was written, and why nothing was.
 */
export function set(key, name, value, { at = turn(), mid } = {}) {
    const shut = sealed(key);
    if (shut) {
        observe.noteRejections([{
            item: String(name ?? ''),
            reason: PLACE_DESTROYED,
            raw: { on: key, place: shut.row?.name ?? shut.key, status: shut.row?.status ?? '' },
            turn: at,
        }]);
        return { key: '', reason: PLACE_DESTROYED };
    }

    const table = load();
    const outcome = foldPart(table, { on: key, name, value, turn: at, mid });
    if (outcome.reason && outcome.reason !== 'no-change') {
        observe.noteRejections([{
            item: String(name ?? ''),
            reason: outcome.reason,
            raw: { on: key, held: outcome.held ?? 0, cap: MAX_PARTS, per: MAX_PARTS_PER_ITEM },
            turn: at,
        }]);
    }
    if (outcome.key) {
        commit(PARTS_PATH, table);
    }
    return { key: outcome.key, reason: outcome.reason };
}

/** Forget one component. @param {string} key Its table key. @returns {boolean} Whether it went. */
export function remove(key) {
    const table = load();
    if (!table.delete(key)) {
        return false;
    }
    commit(PARTS_PATH, table);
    return true;
}

/**
 * Carry a row's components to the key it now lives under.
 *
 * The §7.5 repair, at the one seam that knows both keys.
 *
 * A rename and a move are each two halves of a transfer in the ledger, and the ledger is the only
 * thing they move. `edits.editItem` is where the old key and the new one coexist, so it is where the
 * side tables are carried across, see `edit-table.js` `rekeyPlan`, which is the single definition
 * of where a row lands, shared by the delta and by this, so the two cannot disagree.
 *
 * @param {string} from The key as it stood.
 * @param {string} to The key it now stands under.
 * @returns {number} How many components moved.
 */
export function rekey(from, to) {
    const table = load();
    const moved = rekeyParts(table, from, to);
    if (moved) {
        commit(PARTS_PATH, table);
    }
    return moved;
}

/**
 * Forget every component of a row.
 * @param {string} key An `itemKey`.
 * @returns {number} How many went.
 */
export function drop(key) {
    const table = load();
    const gone = dropParts(table, key);
    if (gone) {
        commit(PARTS_PATH, table);
    }
    return gone;
}

/**
 * Components whose row is not in the ledger, for the panel to show rather than hide.
 * @param {Iterable<string>} liveKeys The keys the ledger holds.
 * @returns {Array<{key: string, on: string, name: string, value: string}>} The orphans.
 */
export function orphans(liveKeys) {
    const table = load();
    return orphanParts(table, liveKeys).map((key) => {
        const parsed = splitPartKey(key);
        return { key, on: parsed.on, name: parsed.name, value: String(lookup(table, key, {})?.value ?? '') };
    });
}

/** Forget every component. */
export function clear() {
    commit(PARTS_PATH, new Map());
}

/**
 * Over-budget pruning: shed the SURPLUS before shedding the last thing a row says about itself.
 *
 * Priced with the archive pruners, behind the places.
 *
 * `PRUNE_ARCHIVE`, registered after `places.js`, so within the band a component goes before a place
 * does. That ordering is the honest one: a place is somewhere the player built and pointed rows at,
 * and a component is an attribute of one of those rows. Both go after the diagnostics log and before
 * the chronicle, because an evicted chronicle event is gone with its delta and cannot be rebuilt
 * from anything.
 *
 * What it sheds, in order:
 *
 *   1. THE STALEST SURPLUS. Every row carrying more than one component loses its oldest, keeping the
 *      newest. What a thing most recently became is what anybody is looking for, and a row that
 *      still says one thing about itself still has a component; a row reduced to none has lost the
 *      feature. This is the cheapest possible loss and it is where the bytes are, a sword described
 *      six ways is six rows against one.
 *   2. WHOLE COMPONENT SETS, stalest first. Priced at ~90 bytes a row, and at least one is always
 *      is always taken, so the loop cannot spin.
 *
 * Orphans need no stage of their own. A component addressed to a row the ledger no longer holds is
 * by definition not being refreshed, so it is the oldest thing its row has and stage one takes it
 * first: and the panel lists them under "Parts with no row" so the player can take them sooner.
 *
 * Deletion rather than demotion, stated plainly for `places.js`' reason: the cold store is INSIDE
 * the blob this is trying to shrink, so demoting here would free nothing and the budget loop would
 * spin until `runBudgetPasses` gave up.
 */
registerPruner((overBy) => {
    const table = load();
    if (!table.size) {
        return;
    }

    // Stage one: the oldest component of every row that has more than one.
    const byRow = new Map();
    for (const [key, row] of table_entries(table)) {
        const { on } = splitPartKey(key);
        byRow.set(on, [...(byRow.get(on) ?? []), { key, turn: Number(row?.turn) || 0 }]);
    }
    let trimmed = 0;
    for (const rows of byRow.values()) {
        if (rows.length < 2) {
            continue;
        }
        const oldest = rows.sort((a, b) => a.turn - b.turn)[0];
        table.delete(oldest.key);
        trimmed++;
    }
    if (trimmed) {
        commit(PARTS_PATH, table);
        observe.noteCap('parts-trimmed', trimmed);
        console.debug(`[sanguine] trimmed ${trimmed} surplus component(s) to fit the metadata budget`);
        return;
    }

    // Stage two: whole rows, stalest first. A row is 99 bytes; always take one.
    const stalest = table_entries(table).sort((a, b) => (a[1]?.turn ?? 0) - (b[1]?.turn ?? 0));
    const target = Math.max(1, Math.ceil(overBy / 99));
    let dropped = 0;
    for (const [key] of stalest) {
        if (dropped >= target) {
            break;
        }
        table.delete(key);
        dropped++;
    }
    if (dropped) {
        commit(PARTS_PATH, table);
        observe.noteCap('parts-shed', dropped);
        console.debug(`[sanguine] shed ${dropped} component(s) to fit the metadata budget`);
    }
}, PRUNE_ARCHIVE);
