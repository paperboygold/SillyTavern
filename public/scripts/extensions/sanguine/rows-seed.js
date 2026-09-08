/**
 * fold/rows-seed.js: seed the rows table from a legacy chat's existing state.
 *
 * The rows table is populated by the rows probe on NEW extraction passes. A chat played before the
 * Phase 1 schema has no `state.rows`, so the audit reads an empty table and `/fold-audit` answers
 * "nothing to audit" even though the record holds 300+ chronicle events. This seeds the table from
 * what the legacy state already folds to, one-time, lazily, on the first read.
 *
 * The seed is a READ of the existing state, not a new judgement: `deriveState` over the chronicle
 * gives the inventory/vitals/marks the old pipeline already computed, and the thread and cast
 * tables are stored verbatim. Rows get `seen = current turn` so nothing is immediately flagged
 * stale; the audit then runs its exact detectors over a populated table exactly as it would over a
 * live one.
 *
 * The pure half is `rowsFromLegacy`; the app half (`ensureRows`) loads the store pieces and
 * persists when the table is empty.
 */

import { makeTable } from './rows-table.js';
import { deriveState, splitItemKey } from './state-table.js';

/**
 * Build a rows table from the legacy state's own folds.
 *
 * @param {object} source The legacy state.
 * @param {Array<object>} source.events The chronicle events (with `d` deltas).
 * @param {Map<string, object>} source.threads The thread table (`clocks.load()`).
 * @param {Map<string, object>} source.cast The entity table (`entities.load()`).
 * @param {number} source.turn The current turn, for the staleness clock.
 * @param {number} [source.now] Wall clock for `born`/`seen` when turn is not meaningful.
 * @returns {object} A rows table (never empty unless the source is).
 */
export function rowsFromLegacy({ events, threads = new Map(), cast = new Map(), turn = 0 }) {
    const table = makeTable();
    const seen = Math.max(0, Number(turn) || 0);
    const derived = deriveState(Array.isArray(events) ? events : []);

    for (const [key, v] of derived.inv) {
        const { who, place, name } = splitItemKey(key);
        if (!name) continue;
        addRow(table, {
            kind: 'item', name, place: place || 'carried', who: who ?? '',
            qty: Math.max(0, Number(v?.qty) || 0), rank: String(v?.rank ?? '').trim(),
            born: 0, seen,
        });
    }
    for (const [name, v] of derived.abilities) {
        const parts = splitItemKey(name);
        addRow(table, {
            kind: 'item', name: parts.name || name, place: 'abilities', who: parts.who ?? '',
            qty: 1, rank: String(v?.rank ?? '').trim(), born: 0, seen,
        });
    }
    for (const [name, v] of derived.vitals) {
        addRow(table, {
            kind: 'vital', name, place: '', who: '',
            qty: Math.max(0, Number(v?.cur ?? v?.v ?? 0) || 0),
            rank: String(v?.max ?? '').trim(), born: 0, seen,
        });
    }
    for (const v of derived.marks.values()) {
        // The derived mark value carries the display name in `phrase` (normalized for the key).
        const flag = v?.phrase ?? v?.flag;
        if (flag == null) continue;
        addRow(table, {
            kind: 'mark', name: String(flag), place: '', who: String(v.who ?? ''),
            qty: v.on ? 1 : 0, rank: '', born: 0, seen,
            status: v.on ? 'open' : 'closed',
        });
    }
    for (const v of threads.values()) {
        if (!v?.name) continue;
        addRow(table, {
            kind: 'thread', name: String(v.name), place: '', who: '',
            qty: 0, rank: '', born: Number(v.first) || 0, seen,
            status: v.status === 'closed' ? 'closed' : 'open',
        });
    }
    for (const v of cast.values()) {
        if (!v?.name) continue;
        addRow(table, {
            kind: 'person', name: String(v.name), place: String(v.place ?? '').trim(), who: '',
            qty: 0, rank: '', born: Number(v.first) || 0, seen,
            status: 'open',
        });
    }
    return table;
}

/** Insert a row, deduped by kind+name+place+who (the seed source keys are already unique). */
function addRow(table, row) {
    for (const existing of table.rows.values()) {
        if (existing.kind === row.kind && existing.name === row.name
            && existing.place === row.place && existing.who === row.who) {
            return;
        }
    }
    const id = `R${table.nextId++}`;
    table.rows.set(id, {
        id, kind: row.kind, name: row.name, place: row.place,
        who: row.who, qty: row.qty, rank: row.rank,
        status: row.status ?? 'open',
        born: row.born ?? 0, seen: row.seen ?? 0,
        dqSinceSet: 0, stated: null,
    });
}
