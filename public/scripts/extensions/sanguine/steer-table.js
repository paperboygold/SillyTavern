/**
 * fold/steer-table.js: the pure data layer for swipe steering.
 *
 * This module imports NOTHING but ./lib/hash.js: no jQuery, no DOM, no script.js.
 * That is deliberate, it is the half of Pillar C that can be unit-tested in plain
 * Node (see tests/fold-steer-table.test.js). Anything that needs the app graph
 * belongs in steer.js instead.
 *
 * The algebra: a message's swipe list IS the Graph face keyed by message id.
 * `merge_graph` is `old.concat(nu)`, which is exactly "append a swipe", and its
 * insertion-order guarantee is what keeps swipe N's instruction attached to swipe N.
 * Reads go through `lookup` with an explicit floor, so "this swipe was never steered"
 * is a first-class value rather than `undefined`.
 */

import { insert_with, lookup, merge_graph, fold } from './lib/hash.js';

/** How a given swipe came to exist. */
export const FOLD_STEER_DIRECTION = Object.freeze({
    /** Generated under an explicit user instruction. */
    STEER: 'steer',
    /** A plain swipe, the floor, never written to disk. */
    RETRY: 'retry',
    /** Reserved for OVERSWIPE_BEHAVIOR.EDIT_GENERATE. */
    EDIT: 'edit',
});

/**
 * The absent-value floor for the Map-face read. Un-steered swipes cost zero bytes
 * on disk precisely because this is materialised on read instead of being stored.
 * @type {Readonly<FoldSteer>}
 */
export const STEER_FLOOR = Object.freeze({
    text: '',
    direction: FOLD_STEER_DIRECTION.RETRY,
});

/**
 * @typedef {object} FoldSteer
 * @property {string} text The raw user instruction, verbatim.
 * @property {'steer'|'retry'|'edit'} direction How this swipe was produced.
 * @property {number} [at] Epoch ms at which the instruction was issued.
 * @property {string} [template] The steering template in effect at the time.
 * @property {string} [source] Which surface issued it: 'ui' | 'slash' | 'swipe_cmd'.
 */

/**
 * Build the Graph face over a chat: message id -> ordered steer records, one per swipe.
 *
 * Messages without a `swipe_info` array contribute no key at all (absent reads as `[]`
 * via `lookup`, so callers never branch on existence).
 *
 * @param {object[]} chat The chat array.
 * @returns {Map<number, FoldSteer[]>} mesId -> steer record per swipe, in swipe order.
 */
export function buildSteerTable(chat) {
    return fold(chat, new Map(), (table, message, mesId) => {
        if (!Array.isArray(message?.swipe_info)) {
            return table;
        }
        return fold(message.swipe_info, table, (acc, info) =>
            insert_with(acc, merge_graph, mesId, [normalizeSteer(info?.extra?.sanguine_steer)]));
    });
}

/**
 * Total read off the Graph face: the steer record for one swipe of one message.
 * `lookup` supplies the `[]` floor for messages that contributed no key, so callers
 * never branch on existence.
 *
 * @param {Map<number, FoldSteer[]>} table A table from buildSteerTable.
 * @param {number} mesId Message id.
 * @param {number} swipeId Index into that message's swipes.
 * @returns {FoldSteer} The record, or STEER_FLOOR if this swipe was never steered.
 */
export function steerForSwipe(table, mesId, swipeId) {
    return lookup(table, mesId, [])[swipeId] ?? STEER_FLOOR;
}

/**
 * Single-message accessor, for the UI's hot path where building a whole table to read
 * one cell would be wasteful.
 *
 * This is a plain property read with a floor, NOT a table operation, and deliberately
 * not dressed up as one. `steerForSwipe` above is the table read; this is the shortcut.
 *
 * @param {object} message A chat message.
 * @param {number} swipeId Index into the message's swipes.
 * @returns {FoldSteer} The record, or STEER_FLOOR if this swipe was never steered.
 */
export function steerForMessage(message, swipeId) {
    return normalizeSteer(message?.swipe_info?.[swipeId]?.extra?.sanguine_steer);
}

/**
 * Coerce anything read off disk into a well-formed record. Chat files are user-editable
 * and travel between installs, so a malformed `sanguine_steer` must degrade to the floor
 * rather than propagate `undefined` into the UI.
 *
 * @param {any} value Raw value from swipe_info[i].extra.sanguine_steer.
 * @returns {FoldSteer} A well-formed record.
 */
export function normalizeSteer(value) {
    if (!value || typeof value !== 'object' || typeof value.text !== 'string' || !value.text.trim()) {
        return STEER_FLOOR;
    }
    const direction = Object.values(FOLD_STEER_DIRECTION).includes(value.direction)
        ? value.direction
        : FOLD_STEER_DIRECTION.STEER;
    return {
        text: value.text,
        direction,
        at: Number.isFinite(value.at) ? value.at : undefined,
        template: typeof value.template === 'string' ? value.template : undefined,
        source: typeof value.source === 'string' ? value.source : undefined,
    };
}

/**
 * Was this swipe produced under an explicit instruction?
 * @param {FoldSteer} steer A steer record.
 * @returns {boolean} True if steered.
 */
export function isSteered(steer) {
    return steer?.direction === FOLD_STEER_DIRECTION.STEER && !!steer?.text?.trim();
}

/**
 * Render the user's steering template. An empty instruction yields an empty string,
 * we never emit a bare template with nothing in it, because that would silently
 * instruct the model with a hollow directive.
 *
 * @param {string} template Template containing {{instruction}}.
 * @param {string} instruction The user's raw instruction.
 * @returns {string} The rendered instruction, or '' if there is nothing to say.
 */
export function renderSteerTemplate(template, instruction) {
    const text = String(instruction ?? '').trim();
    if (!text) {
        return '';
    }
    const shape = String(template ?? '').trim();
    if (!shape || !shape.includes('{{instruction}}')) {
        return text;
    }
    return shape.replaceAll('{{instruction}}', text);
}
