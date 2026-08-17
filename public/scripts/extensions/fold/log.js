/**
 * fold/log.js — the diagnostics log.
 *
 * ── Why this exists ──
 *
 * The observe counters say WHAT happened (6 rejections, 7 empty passes) but never WHAT was rejected
 * or which pass failed, so a number like `rejected` is a cliff you have to guess at the edge of.
 * This is the other half: a bounded, per-chat record of the specific events worth diagnosing —
 * every rejected change (item + reason) and every extraction pass that failed to produce usable
 * JSON (and whether the failure smells like budget or structure).
 *
 * It is a log, not a tally: append-only, newest first, and it can be clicked to jump to the message
 * a rejection was anchored on. It is bounded (`LOG_LIMIT`) and prunes when the fold blob is over
 * budget, because it rides in `chat_metadata` like everything else and a debug surface is not
 * allowed to outgrow the thing it debugs.
 *
 * ── What distinguishes a budget failure from a structural one ──
 *
 * The whole point of the surface. A pass that returns `empty` ran its allowance down thinking and
 * never answered — raising the token budget is the fix. A pass that returns `unparseable` produced
 * JSON the parser could not read — that is prompt, schema or model, and no budget fixes it. The
 * reason is recorded verbatim and the panel shows it beside the kind tag, so the difference is
 * visible without reading code.
 */

import { insert_with, merge_b, table_entries } from './lib/hash.js';
import { PRUNE_DIAGNOSTICS, commit, loadTable, registerPruner } from './store.js';

const LOG_PATH = 'state.log';

/** How many entries the log keeps, newest first. */
export const LOG_LIMIT = 120;

/** Key uniqueness within one millisecond (a pass can reject several things at once). */
let seq = 0;

/**
 * Append a diagnostics entry.
 * @param {object} entry The entry.
 * @param {'reject'|'extract'} [entry.kind] What kind of event this was.
 * @param {string} [entry.reason] Machine reason — the same token the observe counters use.
 * @param {string} [entry.item] The thing proposed (item, flag, thread, or a hint for passes).
 * @param {number|null} [entry.mid] The anchor message index, for the cause-link jump.
 * @param {number|null} [entry.turn] The turn the pass ran on.
 * @param {string} [entry.detail] A human hint — chiefly for extraction failures.
 * @param {string} [entry.raw] The raw proposed value, serialized — the caret-level "offending token".
 * @param {string} [entry.snippet] The narrative window excerpt the model was reading.
 */
export function note(entry) {
    const table = loadTable(LOG_PATH);
    const key = `${Date.now()}:${seq++}`;
    insert_with(table, merge_b, key, {
        t: Date.now(),
        kind: String(entry?.kind ?? ''),
        reason: String(entry?.reason ?? ''),
        item: String(entry?.item ?? '').slice(0, 120),
        mid: Number.isFinite(entry?.mid) ? entry.mid : null,
        turn: Number.isFinite(entry?.turn) ? entry.turn : null,
        detail: String(entry?.detail ?? '').slice(0, 240),
        raw: String(entry?.raw ?? '').slice(0, 200),
        snippet: String(entry?.snippet ?? '').slice(0, 200),
    });
    trim(table);
    commit(LOG_PATH, table);
}

/** Keep only the newest `LOG_LIMIT` entries. */
function trim(table) {
    const entries = table_entries(table).sort((a, b) => (a[0] > b[0] ? -1 : 1));
    for (const [key] of entries.slice(LOG_LIMIT)) {
        table.delete(key);
    }
}

/** Every entry, newest first. @returns {Array<object>} */
export function load() {
    return table_entries(loadTable(LOG_PATH))
        .sort((a, b) => (a[0] > b[0] ? -1 : 1))
        .map(([, value]) => value);
}

/** Drop the log entirely. */
export function clear() {
    commit(LOG_PATH, new Map());
}

// Over-budget pruning: a debug surface must yield before the state it debugs does.
registerPruner((overBy) => {
    const table = loadTable(LOG_PATH);
    if (!table.size) return;
    // Shed the oldest half, then trim to the cap; repeated passes converge.
    const kept = Math.min(Math.floor(table.size / 2), LOG_LIMIT);
    const entries = table_entries(table).sort((a, b) => (a[0] > b[0] ? -1 : 1));
    for (const [key] of entries.slice(kept)) {
        table.delete(key);
    }
    commit(LOG_PATH, table);
    console.debug(`[fold] diagnostics log pruned to ${kept} entry/entries to fit the metadata budget`);
}, PRUNE_DIAGNOSTICS);
