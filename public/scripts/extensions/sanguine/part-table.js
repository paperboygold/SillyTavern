/**
 * sanguine/part-table.js: what a thing is MADE OF, as distinct from where it is.
 *
 * Pure, and testable without touching storage. `parts.js` is the half that owns the table, the same
 * split `place-table.js`/`places.js` and `flow-table.js`/`flows.js` already use.
 *
 * A sword has enchantments; a house has rooms. Those are different.
 *
 * Wave 1 gave fold a place RECORD, and nesting fell out of it as a field: a room is a place whose
 * parent is the house (`place-table.js`). It is tempting to reach for the same mechanism one tier
 * down and file an enchantment as a place inside the sword, and it is wrong in the way that costs
 * you later:
 *
 *   a room    is somewhere you can STAND. You can walk into it, leave things in it, and destroy it
 *             on its own while the house still stands. It has a location, it has contents, and every
 *             one of `resolvePlace`'s callers, an item's `at`, a cast row's `place`, a thread's
 *             `where`: can legitimately name it.
 *   a part    is none of those. Nobody stands in "+2 vs undead". It has no contents, it cannot be
 *             somewhere, and an `at` field naming it would be a category error the key space would
 *             cheerfully accept and never recover from.
 *
 * So containment is a place field and composition is a SIDE TABLE, keyed by the row it is about.
 * That is `flows`' shape exactly (`flow-table.js`): the ledger is a fold with no record to hang
 * anything on, so the richer data lives beside it under the same `itemKey`, along with `faces`,
 * `contributors` and `since`.
 *
 * `{name, value}`, opaque, and that is the discipline that makes it portable.
 *
 * A component is the `standing` shape (`state.js` `deltaSchema`): the writer says what is being
 * described and what it currently reads, and fold stores an opaque pair. No enum, no ordering, no
 * units. That is the same decision `rank` made one tier up and the reason `rank` works identically
 * across F/E/D/C/B/A/S, "Amateur", "47/100" and "Lv. 12" without fold learning a single one of them.
 * An enchantment, a serial number, a calibre, a cultivation grade, a mounted scope and a curse are
 * all one field here, and fold never compares two of them.
 *
 * OUT of the qty fold, and that is load-bearing rather than tidy.
 *
 * Nothing in this file is reachable from `deriveState`. Components are not folded, not counted, not
 * clamped by `maxQty`, and not bounded by `MAX_ITEMS`. Three reasons, in ascending order of weight:
 *
 *   1. A quantity is arithmetic over an append-only ledger and a component is a last-write claim.
 *      Mixing them would put a string in a sum.
 *   2. `MAX_ITEMS` is 64 against an observed 11. Spending those slots on the attributes of the rows
 *      already in them is the two-kinds-under-one-cap mistake `migrate.js` exists to undo, and the
 *      identical argument `MAX_PLACES` makes for not filing rooms among the cast.
 *   3. Each component carries its OWN `turn` and `mid`, so it gets its own recency rail and its own
 *      cause-link. Adding an enchantment lights that component's rail and jumps to the message that
 *      added it; it does not restate the sword's quantity or disturb the sword's trail. The change
 *      is visible at the tier where it happened, which is the whole point of a tier.
 *
 * The name lives in the KEY and nowhere else.
 *
 * A row is `{value, turn, mid}`. The component's name is the second half of its key and is recovered
 * by `splitPartKey`, exactly as `splitItemKey` recovers an item's name, place and owner rather than
 * storing them three times. `standing` stores its `name` beside the key and can afford to; this
 * table cannot make the same shrug, because the metadata budget is the binding constraint on this
 * whole wave, three of twenty-one live chats sit above 90% of `MAX_FOLD_BYTES` and the largest is
 * at 96%, of which 80 KiB is chronicle. Every byte spent here is a campaign memory evicted, so the
 * ten bytes a duplicated name would cost per row are ten bytes not taken.
 */

import { MAX_DETAIL } from './entity-table.js';
import { insert_with, lookup, table_entries } from './lib/hash.js';

/**
 * Separator between the row a component is about and the component's own name.
 *
 * NOT the NUL that `itemKey` and `entityKey` use, and the distinctness is what makes re-keying a
 * pure prefix operation: a part key is exactly one `itemKey` plus this byte plus a name, so
 * `splitPartKey` is a single `indexOf` and can never be confused by the NULs inside the owner half.
 * U+0001 is untypeable for the same reason NUL is, so it cannot collide with anything a model wrote.
 */
export const PART_SEP = '\u0001';

/**
 * How many components one chat may hold, across every row.
 *
 * A serialisation guard on the 128 KiB metadata blob (`store.js` `MAX_FOLD_BYTES`), not a play
 * limit, and stated as UNMEASURED: no chat in the corpus has a component in it, because until now
 * there was no such thing. The number to replace this with comes from `tests/util/fold-calibrate.mjs`
 * once there is something to calibrate against.
 *
 * Deliberately small, and MEASURED rather than guessed. A full row serialises to 99 B
 * (`"carried␀sig p226␁flame rune":{"value":"sets a struck target alight","turn":41,"mid":512}`),
 * so a table at this cap is 2,309 B, 1.76% of `MAX_FOLD_BYTES`. The binding number is the corpus:
 * Raccoon City sits at 126,072 B, which leaves 5,000 B of headroom, so a component table that is
 * completely full still fits inside what the worst chat has spare. A cap twice this size would not.
 * Instrument: the byte probe in this wave's notes; re-runnable with `partKey` and `TextEncoder`.
 */
export const MAX_PARTS = 24;

/**
 * How many components one row may carry.
 *
 * The per-item bound exists so one over-described sword cannot spend the whole table. Six, from the
 * same place `MAX_PLACE_TRAIL` gets six: it is twice what any single observed thing has ever needed
 * to say about itself, and small enough that the list stays readable at a glance rather than
 * becoming a spec sheet nobody scrolls.
 */
export const MAX_PARTS_PER_ITEM = 6;

/**
 * A component's stable table key.
 *
 * @param {string} on The `itemKey` of the row it is about.
 * @param {string} name What the component is called.
 * @returns {string} The key, or '' when either half is unusable.
 */
export function partKey(on, name) {
    const owner = String(on ?? '');
    // Deliberately the same normalisation shape `normalizeKey` applies and NOT an import of it:
    // `state-table.js` would be a cycle, since it is the module that would read this table's faces.
    // Kept to the clauses that decide identity, case, whitespace, trailing punctuation, length,
    // which is the copy `samePlace` is allowed (`place-table.js:60`): six lines of equality may be
    // copied, a judgement that took a measurement to tune may not.
    const said = String(name ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/[.,;:]+$/, '')
        .trim()
        .slice(0, 64);
    return owner && said ? `${owner}${PART_SEP}${said}` : '';
}

/**
 * Split a component key back into the row it is about and its own name.
 *
 * One `indexOf`, because the owner half is an `itemKey` that may itself contain NULs and must not be
 * parsed here, `splitItemKey` owns that shape and nothing else may re-derive it.
 *
 * @param {string} key A table key.
 * @returns {{on: string, name: string}} The parts.
 */
export function splitPartKey(key) {
    const said = String(key ?? '');
    const at = said.indexOf(PART_SEP);
    return at < 0 ? { on: '', name: said } : { on: said.slice(0, at), name: said.slice(at + 1) };
}

/**
 * Last-write, versioned by turn.
 *
 * `merge_b` would be plain last-write and would let an extraction pass that arrives out of order
 * overwrite a fresher claim with a stale one, the ordering hazard `merge_entity` solves for the
 * cast and `merge_place` inherits. A component is a claim about the present state of one attribute,
 * so the newest claim wins and an older one arriving late is news from the past.
 *
 * @param {object} nu Incoming row.
 * @param {object} old Existing row.
 * @returns {object} The row to keep.
 */
export const merge_part = (nu, old) => {
    if (!old) {
        return nu;
    }
    return (Number(nu?.turn) || 0) >= (Number(old?.turn) || 0) ? nu : old;
};

/**
 * Every component of one row, freshest first.
 *
 * A scan rather than an index, for `childrenOf`'s reason: a stored index is a second copy of the key
 * and the two disagree the first time something writes one without knowing about the other. The scan
 * is over a table capped at `MAX_PARTS`.
 *
 * @param {Map<string, object>} table The component table.
 * @param {string} on An `itemKey`.
 * @returns {Array<{key: string, name: string, value: string, turn: number, mid: number}>} The rows.
 */
export function partsOf(table, on) {
    const owner = String(on ?? '');
    const out = [];
    if (!owner) {
        return out;
    }
    for (const [key, row] of table_entries(table ?? new Map())) {
        const parsed = splitPartKey(key);
        if (parsed.on !== owner) {
            continue;
        }
        out.push({
            key,
            name: parsed.name,
            value: String(row?.value ?? ''),
            turn: Number(row?.turn) || 0,
            mid: Number.isFinite(row?.mid) ? row.mid : -1,
        });
    }
    return out.sort((a, b) => b.turn - a.turn);
}

/**
 * Fold one observed component into a table.
 *
 * The cap refuses rather than evicting, and says which cap it was.
 *
 * Both bounds answer with the same reason, `parts-full`, because they are the same sentence to the
 * person reading the log: there is no room for another component. The rejection record carries the
 * counts, so the diagnostics can say whether it was this sword or the whole chat that was full
 * without a second gate name to explain.
 *
 * @param {Map<string, object>} table The component table, mutated.
 * @param {object} observed The observation.
 * @param {string} observed.on The `itemKey` of the row it is about.
 * @param {string} observed.name What the component is called.
 * @param {string} observed.value What it reads now, opaque, never interpreted.
 * @param {number} [observed.turn] Turn counter: the merge version and the recency rail.
 * @param {number} [observed.mid] Anchor mid, for this component's own cause-link.
 * @returns {{key: string, reason: string, held?: number}} The key written (or '' when nothing was)
 *   and the reason something was refused (or '' when nothing was).
 */
export function foldPart(table, { on, name, value = '', turn = 0, mid } = {}) {
    const key = partKey(on, name);
    if (!key) {
        return { key: '', reason: 'unusable-name' };
    }
    const said = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
    // A component with no reading is not a component; it is a word. `standing` refuses the same
    // shape for the same reason, a name with nothing after it says only that somebody typed.
    // An unchanged reading is silence wearing a value, which is `placeIsNews`' rule verbatim.
    const held = lookup(table, key, null);
    if (!said || said === String(held?.value ?? '')) {
        return { key: '', reason: 'no-change' };
    }

    if (!held) {
        const mine = partsOf(table, on).length;
        if (table.size >= MAX_PARTS) {
            return { key: '', reason: 'parts-full', held: table.size };
        }
        if (mine >= MAX_PARTS_PER_ITEM) {
            return { key: '', reason: 'parts-full', held: mine };
        }
    }

    insert_with(table, merge_part, key, {
        value: said,
        turn: Number(turn) || 0,
        // Omitted-when-absent, never defaulted, `foldPlace`'s rule, and for its reason: `0` is a
        // real mid and `-1` is the record's own word for "this write had no anchor".
        ...(Number.isFinite(mid) ? { mid } : {}),
    });
    return { key, reason: '' };
}

/**
 * Move every component from one row key to another.
 *
 * The repair §7.5 is about.
 *
 * `itemKey` encodes `who␀place␀name`, so a rename and a move BOTH change it. The two-half delta
 * builders in `edit-table.js` carry `item`, `dq`, `at` and `who` and nothing else, which is correct
 * for the ledger, the arithmetic is the whole of what a transfer means, and silently orphans every
 * side-table row addressed by the old key. `flows` has had the identical exposure since it landed.
 *
 * A destination that already carries a component of the same name keeps the FRESHER of the two,
 * through the ordinary merge. That is the only case where a re-key can lose anything, and losing the
 * stale half of a collision is what last-write already means everywhere else in this codebase.
 *
 * @param {Map<string, object>} table The component table, mutated.
 * @param {string} from The key as it stood.
 * @param {string} to The key it now stands under.
 * @returns {number} How many components moved.
 */
export function rekeyParts(table, from, to) {
    const was = String(from ?? '');
    const now = String(to ?? '');
    if (!was || !now || was === now) {
        return 0;
    }
    let moved = 0;
    for (const row of partsOf(table, was)) {
        const next = partKey(now, row.name);
        if (!next) {
            continue;
        }
        table.delete(row.key);
        insert_with(table, merge_part, next, {
            value: row.value,
            turn: row.turn,
            ...(row.mid >= 0 ? { mid: row.mid } : {}),
        });
        moved++;
    }
    return moved;
}

/**
 * Forget every component of one row.
 *
 * For the two deletes (`edits.js`): a row that LEFT the story takes its enchantments with it, and a
 * row that was NEVER TRUE never had any. Neither is a case where keeping the components would be
 * telling the truth about something.
 *
 * @param {Map<string, object>} table The component table, mutated.
 * @param {string} on An `itemKey`.
 * @returns {number} How many went.
 */
export function dropParts(table, on) {
    let gone = 0;
    for (const row of partsOf(table, on)) {
        if (table.delete(row.key)) {
            gone++;
        }
    }
    return gone;
}

/**
 * Components whose row is not in the ledger any more.
 *
 * Why this is swept rather than prevented.
 *
 * Rename and move have exactly one destination each, so they re-key (`rekeyParts`). A SPLIT does
 * not: one row becomes several, and which of "9mm magazines", "buckshot shells" and "box of
 * birdshot" inherits "+2 vs undead" is a judgement about the fiction that fold is not entitled to
 * make. Carrying the components to all three would be an invention; carrying them to the first would
 * be an invention with a coin flip in it.
 *
 * So the third action: leave them addressed to a row that no longer holds anything, make them
 * VISIBLE as exactly that, and shed them first when the budget bites. That is `presenceOf`'s
 * UNPLACED answer applied one table over, in the band where the evidence cannot decide, take a
 * third action rather than a default nothing warrants.
 *
 * @param {Map<string, object>} table The component table.
 * @param {Iterable<string>} liveKeys The keys the ledger currently holds.
 * @returns {string[]} Orphaned component keys.
 */
export function orphanParts(table, liveKeys) {
    const live = new Set(liveKeys ?? []);
    const out = [];
    for (const [key] of table_entries(table ?? new Map())) {
        const { on } = splitPartKey(key);
        if (on && !live.has(on)) {
            out.push(key);
        }
    }
    return out;
}

/**
 * One row's components as a single line.
 *
 * `name: value`, joined, the same `a; b; c` shape `renderPlace` uses, because the two end up beside
 * each other in whatever reads them and one shape is one thing for a model to parse.
 *
 * @param {Map<string, object>} table The component table.
 * @param {string} on An `itemKey`.
 * @returns {string} The line, or '' when the row has no components.
 */
export function renderParts(table, on) {
    return partsOf(table, on)
        .map(row => (row.value ? `${row.name}: ${row.value}` : row.name))
        .join('; ');
}

/**
 * Every row that has components, as rendered lines.
 *
 * Deliberately the same face `faces` has, `Map<itemKey, string>`, so `renderState` can take it
 * without importing this module. That is not a convenience: `part-table.js` would have to import
 * `state-table.js` for the key algebra and `state-table.js` would have to import this to print it,
 * which is a cycle. Handing over a rendered map is the same seam `flows.contribute` uses to stay out
 * of `deriveState`, and for the same reason.
 *
 * @param {Map<string, object>} table The component table.
 * @returns {Map<string, string>} Item key -> its components, as one line.
 */
export function partFaces(table) {
    const out = new Map();
    for (const [key, row] of table_entries(table ?? new Map())) {
        const { on, name } = splitPartKey(key);
        if (!on) {
            continue;
        }
        const said = String(row?.value ?? '');
        const line = said ? `${name}: ${said}` : name;
        out.set(on, out.has(on) ? `${out.get(on)}; ${line}` : line);
    }
    return out;
}
