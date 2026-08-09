/**
 * fold/cold-store.js — what the hot path outgrew, kept instead of deleted.
 *
 * ── Why this exists (STATE-ARCHIVE.md [EVICT]) ──
 *
 * The hot tables (threads, cast, chronicle events) are bounded by caps — MAX_THREADS, staleness,
 * MAX_EVENTS — and every cap used to be a `table.delete`: a thread that outlived its relevance
 * vanished, an old event was dropped past the budget, a person nobody mentioned for two stale
 * windows ceased to exist. That is the exact failure the [EVICT] measurement names: selection
 * CANNOT bound a store, because what is "relevant" is per-query, and the union over queries is
 * dense (55%+ of everything was heavy for SOME query at SOME point). A hard delete by relevance
 * is permanent and query-blind — the one thing a store must never be.
 *
 * So eviction becomes DEMOTION. When a hot table sheds a row, it moves here — lossless, keyed by
 * kind, carrying the row as it was. Recall (Stage 3) reads this store by COVERAGE — does the
 * window mention the subject? — and re-promotes a cold row back to its hot table, because
 * re-promotion into the tracked state is not the same as pasting prose into the window
 * ([AC-PRODUCT]: the routed vote was catastrophic).
 *
 * The only hard deletion left is the metadata blob's own ceiling. `enforceBudget` calls registered
 * pruners; this module registers one that sheds the OLDEST cold rows at a far higher ceiling than
 * any hot cap, so a cold store that truly outgrows the blob yields before the hot state does.
 */

import { registerPruner } from './store.js';
import { loadTable, commit, foldByteSize } from './store.js';
import { table_entries } from './lib/hash.js';
import { isMentioned } from './state-table.js';

/** Where the cold rows live. */
export const COLD_PATH = 'state.cold';

/**
 * How much the cold store may hold before it sheds the oldest rows.
 *
 * Deliberately far above the hot caps: demotion exists to make the hot caps cheap, and the cold
 * store should swallow a long campaign without ever pruning. This is not [EVICT]'s "never evict" —
 * that was about relevance selection. This is a storage budget: when the blob itself is full,
 * something has to go, and the oldest cold row is the least likely to be recalled. Hitting this
 * ceiling is the finding (a chat this long outgrew its metadata), not a routine event.
 */
export const MAX_COLD_ROWS = 2000;

/** How big the cold store must be before the pruner even looks. Guards the per-commit cost. */
const PRUNE_THRESHOLD_BYTES = 48 * 1024;

/**
 * The cold store: `kind\0key` -> `{ row, demotedAt }`.
 *
 * Keyed by kind so a thread and an event with the same natural key never collide, and so recall can
 * address one table without scanning the others.
 * @returns {Map<string, {row: object, demotedAt: number}>} The store.
 */
export function load() {
    return loadTable(COLD_PATH);
}

/** @param {Map<string, object>} table The cold store. */
export function save(table) {
    commit(COLD_PATH, table);
}

/**
 * Demote a row from a hot table into the cold store.
 *
 * The pure table functions decide WHAT to shed and return it; this is the storage layer's move. The
 * row is kept whole — a demoted thread is still a thread, an evicted event is still an event — so
 * recall can restore it and the chronicle can still be audited.
 *
 * @param {object} params Parameters.
 * @param {string} params.kind The table it came from: 'thread' | 'person' | 'event'.
 * @param {string} params.key The key it was stored under.
 * @param {object} params.row The row as it was stored.
 * @param {number} [params.at] Turn (or tick) it was demoted at, for the audit trail.
 * @returns {boolean} True if it landed in the cold store.
 */
export function demote({ kind = '', key = '', row = null, at = 0 } = {}) {
    if (!kind || !key || row === null || row === undefined) {
        return false;
    }
    const table = load();
    table.set(`${kind}\0${key}`, { row, demotedAt: at });
    save(table);
    return true;
}

/**
 * The cold row a kind and key maps to, if any.
 * @param {string} kind The table it came from.
 * @param {string} key The key it was stored under.
 * @returns {{row: object, demotedAt: number}|null} The stored row, or null.
 */
export function find(kind, key) {
    return load().get(`${kind}\0${key}`) ?? null;
}

/**
 * Remove a cold row — used when recall re-promotes it back to its hot table.
 * @param {string} kind The table it came from.
 * @param {string} key The key it was stored under.
 * @returns {boolean} True if it existed and was removed.
 */
export function remove(kind, key) {
    const table = load();
    const removed = table.delete(`${kind}\0${key}`);
    if (removed) {
        save(table);
    }
    return removed;
}

/**
 * Every cold row of one kind, for recall's coverage scan.
 * @param {string} kind The table to read.
 * @returns {Array<{key: string, row: object, demotedAt: number}>} Its cold rows.
 */
export function ofKind(kind) {
    const prefix = `${kind}\0`;
    return table_entries(load())
        .filter(([coldKey]) => coldKey.startsWith(prefix))
        .map(([coldKey, entry]) => ({
            key: coldKey.slice(prefix.length),
            row: entry?.row ?? null,
            demotedAt: entry?.demotedAt ?? 0,
        }))
        .filter(item => item.row !== null);
}

/**
 * The cold rows whose subject the window mentions.
 *
 * ── Why coverage, never confidence ([ROUTER]) ──
 *
 * The served router's failure was substituting a CONFIDENCE proxy for the oracle: entropy looked
 * like it should work and was wrong on 84% of the tokens it routed, because low entropy meant a
 * small peaked support, not a correct one. The missing quantity is COVERAGE — does the ledger hold
 * evidence bearing on this input? For fold, coverage is a mention test: the window literally
 * contains the thread's name or a discriminating content token. A mention is a fact, not an
 * estimate; a similarity score would be a confidence proxy and would inherit the router's failure.
 *
 * The mention test is the cast's own (`state-table.js` `isMentioned`), imported rather than copied —
 * two copies of a judgement diverge, and this is the same judgement the presence questions already
 * make. Each subject — name, aka, about, keywords — is tested as a name, so a possessive
 * ("the courier's death") is recalled by a window that says "the courier".
 *
 * @param {string} windowText The narrative window.
 * @param {Array<{key: string, row: object}>} rows Cold rows to test.
 * @returns {Array<{key: string, row: object}>} The rows whose subject is in the window.
 */
export function covered(windowText, rows) {
    const out = [];
    for (const item of Array.isArray(rows) ? rows : []) {
        const row = item?.row ?? null;
        if (!row) continue;
        const subjects = [
            row.name,
            row.aka,
            row.about,
            ...(Array.isArray(row.kw) ? row.kw : []),
        ].filter(Boolean);
        if (subjects.some(subject => isMentioned(subject, windowText))) {
            out.push(item);
        }
    }
    return out;
}

/**
 * Re-promote a cold row back into its hot table.
 *
 * ── Why this is a write, not a paste ([AC-PRODUCT]) ──
 *
 * The routed VOTE — pasting retrieved material into the window — was catastrophic: 11/12 → 3/12,
 * self-repetition 5.7% → 17.9%. Re-promotion is the opposite: the cold row is written back into the
 * tracked state (the thread table, the cast), where it renders as a normal tracked line and is
 * reviewable, settled, merged — never as injected prose. A cold thread the window mentions is
 * returned to the table so the story's return to it is seen, not recited.
 *
 * The recalled row's `turn` is bumped to the caller's turn, so the eviction rule (stalest first)
 * treats it as fresh: the story just returned to it, and a table that is full must evict something
 * genuinely older rather than immediately re-shedding the thread that was just brought home.
 *
 * @param {string} kind The table it belongs to: 'thread' | 'person'.
 * @param {string} key The cold key.
 * @param {object} row The cold row.
 * @param {Map<string, object>} hot The hot table, mutated.
 * @param {number} [turn] The turn it was recalled on, stamped onto the restored row.
 * @returns {boolean} True if it was written into the hot table.
 */
export function promote(kind, key, row, hot, turn = 0) {
    if (!hot || typeof hot.set !== 'function') {
        return false;
    }
    hot.set(key, { ...row, restored: true, turn: Number.isFinite(turn) ? turn : (row?.turn ?? 0) });
    remove(kind, key);
    return true;
}

/**
 * Over-budget pruning: shed the OLDEST cold rows until the blob fits again.
 *
 * Runs only when the blob is actually over budget — guarded by both the registerPruner contract
 * (called with overBy > 0) and a size floor so a small store never pays the sort cost. The order is
 * demotion time, which is the honest proxy: an old demotion is the least likely to be recalled.
 * This is the ONLY hard delete left in fold's storage, and it exists to protect the hot state, not
 * to judge the cold rows' relevance.
 */
registerPruner((overBy) => {
    const size = foldByteSize();
    if (size <= PRUNE_THRESHOLD_BYTES) {
        return;
    }
    const table = load();
    if (!table.size) {
        return;
    }
    // A cold row is a few hundred bytes; drop enough to make room, always at least one.
    const target = Math.max(1, Math.ceil(overBy / 300));
    const sorted = table_entries(table).sort((a, b) => (a[1]?.demotedAt ?? 0) - (b[1]?.demotedAt ?? 0));
    let dropped = 0;
    for (const [key] of sorted) {
        if (dropped >= target) break;
        table.delete(key);
        dropped++;
    }
    if (dropped) {
        commit(COLD_PATH, table);
        console.debug(`[fold] cold store shed ${dropped} old row(s) to fit the metadata budget`);
    }
});
