/**
 * fold/state-table.js — the pure logic for tracked character state.
 *
 * Imports nothing but ./lib/hash.js, so it runs in plain Node and is unit-testable.
 *
 * ── State is a FOLD OVER THE CHRONICLE, not a table beside it ──
 *
 * Both implementations this was ported from keep inventory as a parallel structure the model has
 * to remember to keep in sync. RPG Companion has the model restate the whole list each turn, so an
 * item it forgets to mention silently disappears. Scribe has the model propose a whole new state
 * and then trusts it — its `rejected` vector is never populated, and reconciliation ends with
 * `inventory = new.inventory.clone()` under a comment reading "Trust LLM output".
 *
 * Here there is no parallel structure. A chronicle event may carry a delta describing what it did
 * to the world, and the current state is a fold over the live events:
 *
 *     state = fold(liveEvents, empty, applyDelta)
 *
 * Four things fall out of that, none of which needed building:
 *
 *   · One source of truth. "What happened" and "what you have" cannot disagree.
 *   · Branch-awareness for free. Fold only events that are live on this swipe — the mechanism
 *     already built for retrieval — and swiping away a turn un-does its inventory changes.
 *   · An audit trail. Every quantity traces to the event that caused it.
 *   · Corrections propagate. Edit or delete an event and the state re-derives.
 *
 * Three merges do the folding:
 *
 *   inventory  norm(item)  merge_qty     Count      quantities add, floored at 0
 *   vitals     norm(name)  merge_vital   Count×Map  clamp(cur + dcur, 0, max)
 *   status     norm(flag)  merge_b       Map        last write wins
 *
 * `status` is the Map face and NOT the Set face, deliberately. `merge_nb` is `nu || old` — once
 * true, always true — and status effects have to be able to clear. Calling it a Set because it
 * looks like a set of flags would be exactly the decorative labelling this basis exists to avoid.
 *
 * ── Why DELTAS and not totals ──
 *
 * If the model hands back a complete inventory, your only options are to accept it wholesale or to
 * diff it and guess which differences were intentional. A delta is a proposition with a magnitude,
 * and a magnitude can be bounds-checked. The Count face is chosen because it is the representation
 * in which hallucination is *detectable*, not because counting is tidy. Validation happens once,
 * at write time (`validateInventory` and friends), so the fold itself stays a pure sum.
 */

import { fold, insert_with, lookup, merge_b, merge_graph, table_entries } from './lib/hash.js';

/** Bounds. Generous enough for real play, tight enough to bound the metadata blob. */
export const MAX_ITEM_NAME = 64;
export const MAX_ITEMS = 64;
export const MAX_VITALS = 12;
export const MAX_FLAGS = 32;
export const MAX_QTY = 9999;
/** Largest plausible single-turn quantity change for a non-currency item. */
export const MAX_DELTA = 20;
/** Applied changes allowed per turn, before the rest are dropped. */
export const MAX_CHANGES_PER_TURN = 8;
/** Turns an unmentioned item survives before it stops being rendered. */
export const STALE_THRESHOLD = 12;

/**
 * Keys that would collide with object internals once a table is serialized to JSON.
 * Lifted from the reference extension, which hit this in the wild.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Strip the formatting models actually emit.
 * @param {string} raw Raw text.
 * @returns {string} Cleaned text.
 */
function stripDecoration(raw) {
    return String(raw ?? '')
        // Paired markdown first: stripping leading list markers earlier would eat the opening
        // `**` of `**Sword**` and leave the closing pair stranded.
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/~~(.+?)~~/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/^[\s>*\-•]+/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^["'[{(]+/, '')
        .replace(/["'\]})]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalize an item name, pulling out any quantity the model baked into it.
 *
 * Models write "3x Healing Potion", "Healing Potion x3", and "2 gold coins" at least as often as
 * they fill in a separate quantity field. Parsing it out of the name means those turns produce a
 * correct delta instead of silently adding one of something.
 *
 * @param {string} raw Raw item name.
 * @returns {{name: string, qty: number|null}|null} Normalized name and embedded quantity, or null.
 */
export function normalizeItemName(raw) {
    let text = stripDecoration(raw).toLowerCase();
    if (!text) {
        return null;
    }

    let qty = null;

    // Leading "3x " / "3 × " / "3 "
    const leading = text.match(/^(\d{1,5})\s*(?:x|×)?\s+(.*)$/);
    if (leading) {
        qty = Number(leading[1]);
        text = leading[2].trim();
    } else {
        // Trailing " x3" / " ×3"
        const trailing = text.match(/^(.*?)\s*(?:x|×)\s*(\d{1,5})$/);
        if (trailing) {
            qty = Number(trailing[2]);
            text = trailing[1].trim();
        }
    }

    text = text.replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);

    if (!text || text === 'none' || UNSAFE_KEYS.has(text)) {
        return null;
    }

    return { name: text, qty: Number.isFinite(qty) && qty > 0 ? Math.min(qty, MAX_QTY) : null };
}

/**
 * Normalize a vital or flag name.
 * @param {string} raw Raw name.
 * @returns {string|null} Normalized name, or null if unusable.
 */
export function normalizeKey(raw) {
    const text = stripDecoration(raw).toLowerCase().replace(/[.,;:]+$/, '').trim().slice(0, MAX_ITEM_NAME);
    if (!text || text === 'none' || UNSAFE_KEYS.has(text)) {
        return null;
    }
    return text;
}

/** Count face: quantities add, floored at zero and capped. */
export const merge_qty = (nu, old) => ({
    qty: Math.max(0, Math.min(MAX_QTY, (old?.qty ?? 0) + (nu?.dq ?? 0))),
});

/**
 * Add a quantity delta to an inventory table.
 *
 * `insert_with` stores the incoming value verbatim when the key is absent and only calls the merge
 * on collision — so handing it `{dq}` would store `{dq}` for the first sighting of an item, with
 * no quantity at all. Seeding the key first means the merge runs every time and the stored shape
 * is always `{qty}`.
 *
 * @param {Map<string, {qty: number}>} table Inventory table, mutated.
 * @param {string} name Normalized item name.
 * @param {number} dq Quantity change.
 * @returns {number} The resulting quantity.
 */
export function bumpQty(table, name, dq) {
    if (!table.has(name)) {
        table.set(name, { qty: 0 });
    }
    insert_with(table, merge_qty, name, { dq });
    return lookup(table, name, { qty: 0 }).qty;
}

/**
 * Count × Map: `cur` accumulates and clamps, `max` is last-write.
 * The clamp rule is the reference implementation's, verbatim: clamp(cur + delta, 0, max).
 */
export const merge_vital = (nu, old) => {
    const max = Number.isFinite(nu?.max) ? nu.max : (old?.max ?? 100);
    const base = Number.isFinite(old?.cur) ? old.cur : max;
    return { max, cur: Math.max(0, Math.min(max, base + (nu?.dcur ?? 0))) };
};

/**
 * Does the narrative window actually talk about this thing?
 *
 * The strongest and cheapest rejection rule: a model cannot invent a state change for something
 * nobody mentioned.
 *
 * Matching is on the HEAD of the noun phrase — the last significant token — not on any token.
 * Any-token matching is too permissive in exactly the way that matters: a model can smuggle an
 * invented item past the gate by reusing one word from the scene, so "dragon egg" sails through a
 * narrative that only ever mentioned a "Dragon Keep". Head matching still keeps the leniency that
 * motivated it, because "healing potion (minor)" heads on "potion" and matches a narrative that
 * just says potion.
 *
 * @param {string} name Normalized name.
 * @param {string} windowText The narrative window, lowercased by this function.
 * @returns {boolean} True if mentioned.
 */
export function isMentioned(name, windowText) {
    const haystack = String(windowText ?? '').toLowerCase();
    const needle = String(name ?? '').toLowerCase().trim();
    if (!haystack || !needle) {
        return false;
    }
    if (haystack.includes(needle)) {
        return true;
    }
    // Parentheticals are qualifiers, not the thing itself: "potion (minor)" heads on "potion".
    const tokens = needle.replace(/\(.*?\)/g, ' ').split(/[^a-z0-9']+/).filter(t => t.length > 2);
    // Short names ("axe", "hp") have no token long enough to be discriminating, so the whole-string
    // check above is all they get.
    return tokens.length ? haystack.includes(tokens[tokens.length - 1]) : false;
}

/**
 * Validate proposed inventory deltas against the narrative and the current state.
 *
 * Runs once, when an event is recorded — not on every fold. Rejected deltas never reach the
 * ledger, so the fold is a pure sum over changes that were already justified.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory as currently derived.
 * @param {Array<{item: string, dq: number}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window, for the mention gate.
 * @param {number} [params.budget] Accepted changes allowed.
 * @returns {{accepted: Array<{item: string, dq: number}>, rejected: object[]}} Outcome.
 */
export function validateInventory({ inv, deltas, windowText, budget = MAX_CHANGES_PER_TURN }) {
    const accepted = [];
    const rejected = [];
    const projected = new Map(inv);

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const parsed = normalizeItemName(raw?.item);
        if (!parsed) {
            rejected.push({ item: String(raw?.item ?? ''), reason: 'unusable-name' });
            continue;
        }

        const { name } = parsed;
        // A quantity baked into the name ("3x potion") wins only when no explicit delta was given.
        const dq = Number.isFinite(raw?.dq) && raw.dq !== 0 ? Math.trunc(raw.dq) : (parsed.qty ?? 0);

        if (!dq) {
            rejected.push({ item: name, reason: 'no-change' });
            continue;
        }
        if (accepted.length >= budget) {
            rejected.push({ item: name, reason: 'rate-limited' });
            continue;
        }
        // The strongest and cheapest rule: a model cannot invent a change to something the
        // excerpt never mentions.
        if (!isMentioned(name, windowText)) {
            rejected.push({ item: name, reason: 'not-mentioned' });
            continue;
        }
        if (Math.abs(dq) > MAX_DELTA) {
            rejected.push({ item: name, reason: 'implausible-delta' });
            continue;
        }

        const held = lookup(projected, name, null);
        if (!held && dq < 0) {
            rejected.push({ item: name, reason: 'remove-unknown' });
            continue;
        }
        if (!held && projected.size >= MAX_ITEMS) {
            rejected.push({ item: name, reason: 'inventory-full' });
            continue;
        }

        // Underflow clamps rather than rejects: our count may simply be behind, and the narrative
        // is the more trustworthy source about what just happened.
        if ((held?.qty ?? 0) + dq < 0) {
            rejected.push({ item: name, reason: 'clamped-underflow' });
        }

        bumpQty(projected, name, dq);
        accepted.push({ item: name, dq });
    }

    return { accepted, rejected };
}

/**
 * Validate proposed vital changes.
 * @param {object} params Parameters.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals as currently derived.
 * @param {Array<{name: string, dcur?: number, max?: number}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window.
 * @returns {{accepted: object[], rejected: object[]}} Outcome.
 */
export function validateVitals({ vitals, deltas, windowText }) {
    const accepted = [];
    const rejected = [];

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const name = normalizeKey(raw?.name);
        if (!name) {
            rejected.push({ item: String(raw?.name ?? ''), reason: 'unusable-name' });
            continue;
        }
        if (!isMentioned(name, windowText)) {
            rejected.push({ item: name, reason: 'not-mentioned' });
            continue;
        }

        const held = lookup(vitals, name, null);
        if (!held && vitals.size + accepted.length >= MAX_VITALS) {
            rejected.push({ item: name, reason: 'vitals-full' });
            continue;
        }
        // A max that moves by more than half in one turn is a hallucination, not a level-up.
        if (held && Number.isFinite(raw?.max) && Math.abs(raw.max - held.max) > held.max * 0.5) {
            rejected.push({ item: name, reason: 'implausible-max' });
            continue;
        }

        const entry = { name, dcur: Number.isFinite(raw?.dcur) ? raw.dcur : 0 };
        if (Number.isFinite(raw?.max)) {
            entry.max = raw.max;
        }
        if (!entry.dcur && entry.max === undefined) {
            rejected.push({ item: name, reason: 'no-change' });
            continue;
        }
        accepted.push(entry);
    }

    return { accepted, rejected };
}

/**
 * Validate proposed status flag changes.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.status Status as currently derived.
 * @param {Array<{flag: string, on: boolean}>} params.deltas Proposed changes.
 * @param {string} params.windowText Narrative window.
 * @returns {{accepted: object[], rejected: object[]}} Outcome.
 */
export function validateStatus({ status, deltas, windowText }) {
    const accepted = [];
    const rejected = [];

    for (const raw of Array.isArray(deltas) ? deltas : []) {
        const flag = normalizeKey(raw?.flag);
        if (!flag) {
            rejected.push({ item: String(raw?.flag ?? ''), reason: 'unusable-name' });
            continue;
        }
        if (!isMentioned(flag, windowText)) {
            rejected.push({ item: flag, reason: 'not-mentioned' });
            continue;
        }
        if (!status.has(flag) && status.size + accepted.length >= MAX_FLAGS) {
            rejected.push({ item: flag, reason: 'flags-full' });
            continue;
        }
        accepted.push({ flag, on: !!raw?.on });
    }

    return { accepted, rejected };
}

/**
 * Derive current state by folding the deltas carried by a sequence of events.
 *
 * This is the whole state model. Pass only the events that are live on the current branch and
 * swipe-awareness is automatic; pass them in chronological order and the arithmetic is the same
 * arithmetic the narrative described, in the order it described it.
 *
 * `since` counts how many events have passed since each item was last touched — staleness,
 * derived rather than stored, because it is a function of the ledger and nothing else.
 *
 * @param {Array<{t?: number, d?: object}>} events Events, live ones only.
 * @returns {{inv: Map, vitals: Map, status: Map, since: Map, contributors: Map}} Derived state.
 */
export function deriveState(events) {
    const ordered = [...(events ?? [])].sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
    const inv = new Map();
    const vitals = new Map();
    const status = new Map();
    const lastTouch = new Map();
    /** @type {Map<string, Array<{at: number, dq: number, summary: string}>>} */
    const contributors = new Map();

    ordered.forEach((event, index) => {
        const delta = event?.d;
        if (!delta) {
            return;
        }

        for (const change of delta.inv ?? []) {
            const name = String(change?.item ?? '');
            const dq = Number(change?.dq ?? 0);
            if (!name || !dq) continue;

            const qty = bumpQty(inv, name, dq);
            insert_with(lastTouch, merge_b, name, index);
            // The audit trail: every quantity traces to the events that produced it.
            insert_with(contributors, merge_graph, name, [{ at: event.t ?? 0, dq, summary: event.s ?? '' }]);

            if (qty <= 0) {
                inv.delete(name);
                lastTouch.delete(name);
                contributors.delete(name);
            }
        }

        for (const change of delta.vit ?? []) {
            const name = String(change?.name ?? '');
            if (!name) continue;
            insert_with(vitals, merge_vital, name, {
                dcur: Number(change?.dcur ?? 0),
                max: Number.isFinite(change?.max) ? change.max : undefined,
            });
        }

        for (const change of delta.st ?? []) {
            const flag = String(change?.flag ?? '');
            if (!flag) continue;
            insert_with(status, merge_b, flag, { on: !!change?.on, t: event.t ?? 0 });
        }
    });

    const total = ordered.length;
    const since = fold(table_entries(lastTouch), new Map(), (acc, [name, index]) =>
        insert_with(acc, merge_b, name, Math.max(0, total - 1 - index)));

    return { inv, vitals, status, since, contributors };
}

/**
 * Is this item still worth spending prompt tokens on?
 *
 * Staleness soft-hides rather than deletes: the item stops being rendered but stays in the ledger,
 * so nothing is lost and the effect on prompt size is visible. The reference implementation
 * defined exactly this counter and never incremented it anywhere — which is how a feature that
 * sounds obviously useful becomes dead code.
 *
 * @param {string} name Item name.
 * @param {Map<string, number>} since Events since each item was last touched.
 * @returns {boolean} True if fresh enough to render.
 */
export function isFresh(name, since) {
    return lookup(since, name, 0) < STALE_THRESHOLD;
}

/**
 * Render tracked state as a compact prompt block.
 *
 * Sections with nothing in them are omitted, and an entirely empty state renders '' so nothing is
 * injected at all — an empty header spends tokens telling the model nothing.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty: number}>} params.inv Inventory.
 * @param {Map<string, {cur: number, max: number}>} params.vitals Vitals.
 * @param {Map<string, {on: boolean}>} params.status Status flags.
 * @param {Map<string, number>} [params.since] Events since each item was last touched.
 * @returns {string} The block, or ''.
 */
export function renderState({ inv, vitals, status, since = new Map() }) {
    const lines = [];

    const vitalParts = table_entries(vitals)
        .map(([name, v]) => `${name} ${Math.round(v.cur)}/${Math.round(v.max)}`);
    if (vitalParts.length) {
        lines.push(`Vitals: ${vitalParts.join(' · ')}`);
    }

    const flags = table_entries(status).filter(([, v]) => v?.on).map(([flag]) => flag);
    if (flags.length) {
        lines.push(`Status: ${flags.join(', ')}`);
    }

    const carried = table_entries(inv)
        .filter(([name]) => isFresh(name, since))
        .map(([name, item]) => (item.qty > 1 ? `${name} x${item.qty}` : name));
    if (carried.length) {
        lines.push(`Carrying: ${carried.join(', ')}`);
    }

    return lines.length ? `[State]\n${lines.join('\n')}` : '';
}
