/**
 * sanguine/store.js — the only module that touches `chat_metadata`.
 *
 * Everything sanguine persists lives under `chat_metadata.sanguine` (with backwards compatibility
 * for `chat_metadata.fold`), which rides inside the chat's own JSONL file. That file is rewritten
 * wholesale on every save, so size discipline is not optional:
 * `enforceBudget()` runs after every commit and hands control to registered pruners once the blob
 * crosses MAX_SANGUINE_BYTES.
 *
 * Tables are `Map`s in memory and plain objects on disk. This module is the only place that
 * conversion happens, so no other module has to think about it.
 */

import { chat_metadata } from '../../../script.js';
import { saveMetadataDebounced } from '../../extensions.js';
import { table_entries } from './lib/hash.js';

export const SANGUINE_METADATA_KEY = 'sanguine';
export const FOLD_METADATA_KEY = SANGUINE_METADATA_KEY;
export const SANGUINE_SCHEMA_VERSION = 1;
export const FOLD_SCHEMA_VERSION = SANGUINE_SCHEMA_VERSION;

/** Hard ceiling on the serialized sanguine blob. Past this, pruners run until it fits. */
export const MAX_SANGUINE_BYTES = 128 * 1024;
export const MAX_FOLD_BYTES = MAX_SANGUINE_BYTES;

/** @type {Array<(overBy: number) => void>} */
const pruners = [];

/**
 * Register a pruner, called when the sanguine blob exceeds its budget. Pruners should remove the
 * least valuable entries they own and commit the result.
 * @param {(overBy: number) => void} pruner Called with how many bytes over budget we are.
 */
export function registerPruner(pruner) {
    pruners.push(pruner);
}

/**
 * The sanguine blob for the current chat, created on first use.
 * @returns {object} The mutable sanguine blob.
 */
export function getSanguine() {
    if (!chat_metadata[SANGUINE_METADATA_KEY] || typeof chat_metadata[SANGUINE_METADATA_KEY] !== 'object') {
        if (chat_metadata.fold && typeof chat_metadata.fold === 'object') {
            chat_metadata[SANGUINE_METADATA_KEY] = chat_metadata.fold;
        } else {
            chat_metadata[SANGUINE_METADATA_KEY] = { v: SANGUINE_SCHEMA_VERSION };
        }
    }
    const sanguine = chat_metadata[SANGUINE_METADATA_KEY];
    if (sanguine.v !== SANGUINE_SCHEMA_VERSION) {
        sanguine.v = SANGUINE_SCHEMA_VERSION;
    }
    return sanguine;
}
export const getFold = getSanguine;

/**
 * Resolve a dotted path inside the sanguine blob, creating intermediate objects.
 * @param {string} path Dotted path, e.g. 'chronicle.events'.
 * @param {boolean} create Whether to create missing containers.
 * @returns {{parent: object, key: string}|null} The owning object and final key.
 */
function resolve(path, create) {
    const parts = String(path).split('.');
    let node = getSanguine();
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!node[part] || typeof node[part] !== 'object') {
            if (!create) return null;
            node[part] = {};
        }
        node = node[part];
    }
    return { parent: node, key: parts[parts.length - 1] };
}

/**
 * Load a persisted table as a Map. Absent paths read as an empty Map, so callers never branch
 * on existence — the same total-read discipline `lookup` gives within a table.
 * @param {string} path Dotted path inside the fold blob.
 * @returns {Map<string, any>} The table.
 */
export function loadTable(path) {
    const site = resolve(path, false);
    const stored = site ? site.parent[site.key] : null;
    const table = new Map();
    if (stored && typeof stored === 'object') {
        for (const [key, value] of Object.entries(stored)) {
            table.set(key, value);
        }
    }
    return table;
}

/**
 * Persist a table, replacing whatever was at that path, and schedule a save.
 * @param {string} path Dotted path inside the fold blob.
 * @param {Map<string, any>} table The table to write.
 */
export function commit(path, table) {
    const site = resolve(path, true);
    site.parent[site.key] = Object.fromEntries(table_entries(table));
    saveMetadataDebounced();
    enforceBudget();
}

/**
 * Read a scalar from the fold blob.
 * @param {string} path Dotted path.
 * @param {any} dflt Value to return when absent.
 * @returns {any} The stored value or the default.
 */
export function loadValue(path, dflt) {
    const site = resolve(path, false);
    if (!site) return dflt;
    const value = site.parent[site.key];
    return value === undefined ? dflt : value;
}

/**
 * Write a scalar into the fold blob and schedule a save.
 * @param {string} path Dotted path.
 * @param {any} value The value.
 */
export function commitValue(path, value) {
    const site = resolve(path, true);
    site.parent[site.key] = value;
    saveMetadataDebounced();
}

/**
 * Serialized size of the fold blob in bytes.
 * @returns {number} Byte length of the JSON encoding.
 */
export function foldByteSize() {
    try {
        return new TextEncoder().encode(JSON.stringify(getFold())).length;
    } catch {
        return 0;
    }
}

/** Guards against the commit -> enforceBudget -> pruner -> commit cycle re-entering itself. */
let enforcing = false;

/**
 * Run registered pruners while the fold blob is over budget.
 *
 * Bounded to a few passes: a pruner that cannot free anything must not spin. Being slightly over
 * budget is survivable; an infinite loop in a save path is not.
 *
 * Pruners persist their work through `commit`, which calls back into here — so without the
 * reentrancy guard each eviction would open a fresh nested budget loop, and the outer loop's
 * size bookkeeping would be measuring work its own callees had already done.
 *
 * @returns {number} The final byte size.
 */
export function enforceBudget() {
    if (enforcing) {
        return foldByteSize();
    }
    enforcing = true;
    try {
        return runBudgetPasses();
    } finally {
        enforcing = false;
    }
}

/**
 * The budget loop proper.
 * @returns {number} The final byte size.
 */
function runBudgetPasses() {
    let size = foldByteSize();
    for (let pass = 0; pass < 4 && size > MAX_FOLD_BYTES && pruners.length; pass++) {
        const overBy = size - MAX_FOLD_BYTES;
        for (const pruner of pruners) {
            try {
                pruner(overBy);
            } catch (error) {
                console.error('[fold] pruner failed', error);
            }
        }
        const next = foldByteSize();
        if (next >= size) break;
        size = next;
    }
    return size;
}

/**
 * Discard everything fold has stored for the current chat.
 */
export function clearFold() {
    delete chat_metadata[FOLD_METADATA_KEY];
    saveMetadataDebounced();
}
