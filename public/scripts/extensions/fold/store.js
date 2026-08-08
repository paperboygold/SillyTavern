/**
 * fold/store.js — the only module that touches `chat_metadata`.
 *
 * Everything fold persists lives under `chat_metadata.fold`, which rides inside the chat's own
 * JSONL file. That file is rewritten wholesale on every save, so size discipline is not optional:
 * `enforceBudget()` runs after every commit and hands control to registered pruners once the blob
 * crosses MAX_FOLD_BYTES.
 *
 * Tables are `Map`s in memory and plain objects on disk. This module is the only place that
 * conversion happens, so no other module has to think about it.
 */

import { chat_metadata } from '../../../script.js';
import { saveMetadataDebounced } from '../../extensions.js';
import { table_entries } from './lib/hash.js';
import { migrate } from './migrate.js';

export const FOLD_METADATA_KEY = 'fold';
export const FOLD_SCHEMA_VERSION = 2;

/** Hard ceiling on the serialized fold blob. Past this, pruners run until it fits. */
export const MAX_FOLD_BYTES = 128 * 1024;

/** @type {Array<(overBy: number) => void>} */
const pruners = [];

/** Fold blobs this session has already run the migration over. See `getFold`. */
const migrated = new WeakSet();

/**
 * Register a pruner, called when the fold blob exceeds its budget. Pruners should remove the
 * least valuable entries they own and commit the result.
 * @param {(overBy: number) => void} pruner Called with how many bytes over budget we are.
 */
export function registerPruner(pruner) {
    pruners.push(pruner);
}

/**
 * The fold blob for the current chat, created on first use.
 *
 * ── The version field was decoration, and this is where it stops being ──
 *
 * The earlier body of this function read:
 *
 *     if (fold.v !== FOLD_SCHEMA_VERSION) { fold.v = FOLD_SCHEMA_VERSION; }
 *
 * — a restamp. Any mismatch, in either direction, was relabelled to the current constant without
 * converting anything, so a v2 blob opened by a v1 build would be renamed v1 and then written to
 * under v1's rules. Found by reading rather than by a bug report, because nothing in a browser ever
 * complains about this: the state simply becomes wrong.
 *
 * The real dispatch has two directions and they are not symmetric:
 *
 *   older blob   convert it. `migrate()` is keyed on the presence of old keys, so it is safe to
 *                run more than once and safe to run on a blob a later phase will convert further.
 *   newer blob   REFUSE to write. An older fold cannot know what a newer one meant by a key it has
 *                never heard of, and the failure mode of guessing is a chat quietly downgraded
 *                while its owner is playing. Reads still work — a stale panel is recoverable, a
 *                scribbled-on chat is not.
 *
 * @returns {object} The mutable fold blob.
 */
export function getFold() {
    if (!chat_metadata[FOLD_METADATA_KEY] || typeof chat_metadata[FOLD_METADATA_KEY] !== 'object') {
        chat_metadata[FOLD_METADATA_KEY] = { v: FOLD_SCHEMA_VERSION };
    }
    const fold = chat_metadata[FOLD_METADATA_KEY];
    const version = Number(fold.v) || 1;
    if (version > FOLD_SCHEMA_VERSION) {
        return fold;
    }
    // ── Once per loaded blob, not once per call ──
    //
    // `getFold()` runs on every read and every write, so a version test alone would re-enter the
    // migration hundreds of times a session — and, worse, would let the retirement step fire in the
    // same session that wrote the v2 keys, which is exactly the thing §9 stages against. Identity
    // of the blob OBJECT is the honest marker of "this came off disk": SillyTavern parses a fresh
    // one on every chat load, so a new object is a new load and nothing else is.
    if (!migrated.has(fold) && (version < FOLD_SCHEMA_VERSION || fold.state?.migrated?.pending?.length)) {
        migrated.add(fold);
        try {
            const report = migrate(fold);
            if (report.from < report.to) {
                console.debug('[fold] migrated', report.from, '→', report.to, report.counts);
            }
            saveMetadataDebounced();
        } catch (error) {
            // A migration that throws must not take the chat down with it. The blob is left at its
            // old version, so the next load tries again rather than half-converting forever.
            console.error('[fold] migration failed; state left at v' + version, error);
        }
    }
    return fold;
}

/**
 * Is the current chat's fold state newer than this build understands?
 *
 * Checked on every write rather than cached, because the chat can change under us and a cached
 * answer would be about a chat nobody is looking at.
 *
 * @returns {boolean} True when writes must be refused.
 */
export function isReadOnly() {
    const fold = chat_metadata[FOLD_METADATA_KEY];
    return !!fold && typeof fold === 'object' && (Number(fold.v) || 1) > FOLD_SCHEMA_VERSION;
}

/**
 * Resolve a dotted path inside the fold blob, creating intermediate objects.
 * @param {string} path Dotted path, e.g. 'chronicle.events'.
 * @param {boolean} create Whether to create missing containers.
 * @returns {{parent: object, key: string}|null} The owning object and final key.
 */
function resolve(path, create) {
    const parts = String(path).split('.');
    let node = getFold();
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
    if (isReadOnly()) {
        console.warn(`[fold] refusing to write ${path}: this chat's state is newer than this build`);
        return;
    }
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
    if (isReadOnly()) {
        console.warn(`[fold] refusing to write ${path}: this chat's state is newer than this build`);
        return;
    }
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
