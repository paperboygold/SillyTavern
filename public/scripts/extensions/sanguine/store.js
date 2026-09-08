/**
 * fold/store.js: the only module that touches `chat_metadata`.
 *
 * Everything fold persists lives under `chat_metadata.fold`, which rides inside the chat's own
 * JSONL file. That file is rewritten wholesale on every save, so size discipline is not optional:
 * `enforceBudget()` runs after every commit and hands control to registered pruners once the blob
 * crosses MAX_FOLD_BYTES.
 *
 * Tables are `Map`s in memory and plain objects on disk. This module is the only place that
 * conversion happens, so no other module has to think about it.
 */

import { chat_metadata, saveMetadata } from '../../../script.js';
import { saveMetadataDebounced } from '../../extensions.js';
import { table_entries } from './lib/hash.js';
import { SANGUINE_METADATA_KEY } from './metadata-key.js';
import { migrate } from './migrate.js';

// Re-exported because this module has always been where the rest of the extension reached for it.
// The DEFINITION moved to a leaf so `harvest.js`: node-side, and unable to import anything that
// pulls in `script.js`: can share it instead of keeping the copy that went stale in the rename.
export { SANGUINE_METADATA_KEY };
export const SANGUINE_SCHEMA_VERSION = 2;

/** Hard ceiling on the serialized fold blob. Past this, pruners run until it fits. */
export const MAX_FOLD_BYTES = 128 * 1024;

/**
 * What a pruner costs the player, low to high. The budget loop runs them in this order and stops as
 * soon as the blob fits, so the cheapest thing to lose is always the first thing lost.
 *
 * Order was import order, and that cost campaign memory to save diagnostics.
 *
 * `log.js` has always said "a debug surface must yield before the state it debugs does", and nothing
 * implemented it: `runBudgetPasses` called every registered pruner on every over-budget pass, so the
 * chronicle shed events in the same pass the log shed entries, whether or not the log alone would
 * have been enough. Measured on the live chats, that was not a marginal difference, the diagnostics
 * log was 35 KiB of Wuxia's 117 KiB blob (30%) and 29 KiB of Time Stop's 73 KiB (40%). Shedding it
 * first is enough on its own to keep both under budget, which means every chronicle eviction those
 * chats have taken was avoidable.
 */
export const PRUNE_DIAGNOSTICS = 10;
/**
 * Repair-pass bookkeeping: pending asks and the applied ledger.
 *
 * Between the debug log and the cold archive, and the placement is an argument about what each thing
 * IS. The diagnostics log goes first because it is a debug surface. Repair state goes second because
 * it is machinery too, a queue of questions and a receipt for edits already made, where the
 * archive below it is the campaign's own displaced memory: cast rows, threads and places that a
 * story happened in. Losing "which three rows the pass wanted to ask about" costs the player a
 * re-run of a pass that is explicitly re-runnable. Losing an archived person costs them the person.
 */
export const PRUNE_REPAIRS = 20;
export const PRUNE_ARCHIVE = 50;
export const PRUNE_MEMORY = 100;

/** @type {Array<{run: (overBy: number) => void, order: number}>} */
const pruners = [];

/**
 * How many writes this session has made into the fold blob.
 *
 * An undo that silently expires is a lie, and this is the one honest way to know.
 *
 * `snapshotFold` copies the blob; `restoreFold` puts it back. That pair is only truthful while
 * NOTHING ELSE HAS WRITTEN, an extraction fold, a hand edit, a background pass, because a restore
 * discards everything the blob has learned since the copy was taken. Nothing anywhere recorded that,
 * so the only implementations available to a caller were "offer the button forever and sometimes
 * destroy a turn of play" or "never offer it".
 *
 * A monotonic counter is the cheapest honest signal: a caller records the mark beside its snapshot
 * and compares. Deliberately in MEMORY rather than on the blob, it costs zero of the 128 KiB
 * budget, and its lifetime (this session, this load) already matches the lifetime of the only thing
 * that reads it, since a snapshot too big to persist cannot outlive the session either.
 *
 * Every write counts, not only the ones that change a record the player can see. That is the
 * conservative direction: over-reporting "the record has moved on" costs an undo the player could
 * have had, while under-reporting costs them a turn of play they cannot get back.
 */
let writes = 0;

/**
 * The write counter, as a comparable mark.
 * @returns {number} Writes so far this session.
 */
export function writeMark() {
    return writes;
}

/** Fold blobs this session has already run the migration over. See `getFold`. */
const migrated = new WeakSet();

/**
 * Register a pruner, called when the fold blob exceeds its budget. Pruners should remove the
 * least valuable entries they own and commit the result.
 *
 * @param {(overBy: number) => void} pruner Called with how many bytes over budget we are.
 * @param {number} [order] What losing this costs the player; lower runs first. Defaults to
 *   `PRUNE_MEMORY`, so an unclassified pruner is treated as expensive rather than cheap.
 */
export function registerPruner(pruner, order = PRUNE_MEMORY) {
    pruners.push({ run: pruner, order });
    pruners.sort((a, b) => a.order - b.order);
}

/**
 * The fold blob for the current chat, created on first use.
 *
 * The version field was decoration, and this is where it stops being.
 *
 * The earlier body of this function read:
 *
 *     if (fold.v !== SANGUINE_SCHEMA_VERSION) { fold.v = SANGUINE_SCHEMA_VERSION; }
 *
 *, a restamp. Any mismatch, in either direction, was relabelled to the current constant without
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
 *                while its owner is playing. Reads still work, a stale panel is recoverable, a
 *                scribbled-on chat is not.
 *
 * @returns {object} The mutable fold blob.
 */
export function getFold() {
    if (!chat_metadata[SANGUINE_METADATA_KEY] || typeof chat_metadata[SANGUINE_METADATA_KEY] !== 'object') {
        chat_metadata[SANGUINE_METADATA_KEY] = { v: SANGUINE_SCHEMA_VERSION };
    }
    const fold = chat_metadata[SANGUINE_METADATA_KEY];
    const version = Number(fold.v) || 1;
    if (version > SANGUINE_SCHEMA_VERSION) {
        return fold;
    }
    // Once per loaded blob, not once per call.
    //
    // `getFold()` runs on every read and every write, so a version test alone would re-enter the
    // migration hundreds of times a session, and, worse, would let the retirement step fire in the
    // same session that wrote the v2 keys, which is exactly the thing §9 stages against. Identity
    // of the blob OBJECT is the honest marker of "this came off disk": SillyTavern parses a fresh
    // one on every chat load, so a new object is a new load and nothing else is.
    //
    // The version test defeated the branch that exists for already-v2 chats.
    //
    // `migrate()` has a `from >= V2` arm whose own docblock argues the case: "Version alone
    // therefore cannot say whether there is work to do; the PRESENCE of the keys can." But the
    // caller only entered on `version < V2 || pending.length`, so on the corpus, every chat `v: 2`
    // with nothing pending, `migrateBody` and `migrateFacts` could never run, and their two
    // counters could never fire. The callee's contract and the caller's gate disagreed, and the
    // caller won silently.
    //
    // The identity guard above is what makes entering unconditionally safe: it is already
    // once-per-loaded-blob, which is exactly the cadence the branch wants. `report.changed` is new,
    // so a pass that finds nothing to do no longer marks the metadata dirty.
    if (!migrated.has(fold)) {
        migrated.add(fold);
        try {
            const report = migrate(fold);
            if (report.from < report.to) {
                console.debug('[sanguine] migrated', report.from, '→', report.to, report.counts);
            }
            if (report.changed) {
                saveMetadataDebounced();
            }
        } catch (error) {
            // A migration that throws must not take the chat down with it. The blob is left at its
            // old version, so the next load tries again rather than half-converting forever.
            console.error('[sanguine] migration failed; state left at v' + version, error);
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
    const fold = chat_metadata[SANGUINE_METADATA_KEY];
    return !!fold && typeof fold === 'object' && (Number(fold.v) || 1) > SANGUINE_SCHEMA_VERSION;
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
 * on existence, the same total-read discipline `lookup` gives within a table.
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
        console.warn(`[sanguine] refusing to write ${path}: this chat's state is newer than this build`);
        return;
    }
    const site = resolve(path, true);
    site.parent[site.key] = Object.fromEntries(table_entries(table));
    writes++;
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
        console.warn(`[sanguine] refusing to write ${path}: this chat's state is newer than this build`);
        return;
    }
    const site = resolve(path, true);
    site.parent[site.key] = value;
    writes++;
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
 * Pruners persist their work through `commit`, which calls back into here, so without the
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
        const before = size;
        // Cheapest first, and STOP as soon as it fits. The inner re-measure is the whole repair:
        // without it every pruner fired on every over-budget pass, so a blob that the diagnostics
        // log alone would have rescued lost chronicle events too, permanently, since a demoted
        // event keeps its summary and loses its delta.
        for (const pruner of pruners) {
            if (size <= MAX_FOLD_BYTES) {
                break;
            }
            try {
                pruner.run(size - MAX_FOLD_BYTES);
            } catch (error) {
                console.error('[sanguine] pruner failed', error);
            }
            size = foldByteSize();
        }
        // No pruner in a whole pass could shed anything, so another pass cannot either.
        if (size >= before) {
            break;
        }
    }
    return size;
}

/**
 * Discard everything fold has stored for the current chat.
 */
export function clearFold() {
    delete chat_metadata[SANGUINE_METADATA_KEY];
    saveMetadataDebounced();
}

/**
 * A deep copy of the current chat's fold blob, or `null` when there is none.
 *
 * Exists for `/fold-replay`, which rebuilds the ledger from turn zero over a chat somebody is
 * actually playing. A structural copy rather than a reference: the replay mutates the live blob in
 * place through every normal write path, so a reference would be the same object it is trying to
 * preserve and "restore" would restore the damage.
 *
 * @returns {object|null} The copy.
 */
export function snapshotFold() {
    const fold = chat_metadata[SANGUINE_METADATA_KEY];
    if (!fold || typeof fold !== 'object') {
        return null;
    }
    return structuredClone(fold);
}

/**
 * Put a snapshot back in the chat the player is looking at, without waiting for disk.
 *
 * Why this is not `restoreFold`.
 *
 * `restoreFold` awaits an UNDEBOUNCED `saveMetadata()`, and its docblock explains the measured
 * disaster that forced it: a batch replay restores six chats and changes chat between each, so a
 * debounced write is measured against metadata that no longer belongs to the chat it came from and
 * never lands. That is a property of BATCH work.
 *
 * An interactive revert is the opposite shape. It happens in the chat on screen, in response to a
 * click, and the chat cannot change underneath it, and it must be synchronous, because the surface
 * that called it has to re-render against the restored record in the same tick rather than paint one
 * frame of the record it just undid. So it takes the same debounced save every other sanguine write
 * takes (`commit`, `commitValue`), which is the discipline the rest of the extension already runs on.
 *
 * Counted as a write, because it is the largest one there is: everything holding a mark from before
 * this call is now describing a blob that no longer exists.
 *
 * @param {object|null} snapshot A blob from `snapshotFold`.
 */
export function replaceFold(snapshot) {
    if (snapshot === null || snapshot === undefined) {
        delete chat_metadata[SANGUINE_METADATA_KEY];
    } else {
        chat_metadata[SANGUINE_METADATA_KEY] = structuredClone(snapshot);
    }
    writes++;
    saveMetadataDebounced();
}

/**
 * Put a snapshot back, discarding whatever is there now.
 *
 * The other half of `snapshotFold`. `null` restores "no fold state at all", which is a real state a
 * chat can be in and is distinct from an empty blob, a chat that fold has never touched must not
 * come back from a replay looking like one it touched and found nothing in.
 *
 * The save is AWAITED, and the first version of this function was not.
 *
 * `saveMetadataDebounced` schedules a write; it does not perform one. A caller that restores and
 * then immediately changes chat, which is exactly what a batch replay does, leaves the debounce
 * pending against metadata that no longer belongs to the chat it was measured from, and the
 * restored blob never reaches disk. MEASURED, on live chats: a six-chat replay run restored every
 * blob in memory and persisted none of them. Royal Succession went from 18 persisted identity
 * verdicts to 10 and Elizabeth from 4 to 3, the replay's own rebuilt state was saved by the chat
 * change instead. The verdicts were recoverable only because they had been harvested to a corpus
 * file first.
 *
 * So this returns a promise and `saveMetadata()` is the undebounced write. A caller that does not
 * await it gets the same bug back.
 *
 * @param {object|null} snapshot A blob from `snapshotFold`.
 * @returns {Promise<void>} Resolves once the restored blob is on disk.
 */
export async function restoreFold(snapshot) {
    if (snapshot === null || snapshot === undefined) {
        delete chat_metadata[SANGUINE_METADATA_KEY];
    } else {
        chat_metadata[SANGUINE_METADATA_KEY] = structuredClone(snapshot);
    }
    await saveMetadata();
}
