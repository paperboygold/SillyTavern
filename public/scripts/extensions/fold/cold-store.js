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
