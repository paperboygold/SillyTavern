/**
 * sanguine/lore.js: entity ↔ lorebook links, and the read direction they unlock.
 *
 * The pure half is `lore-table.js`; this file is the half that touches World Info, `chat_metadata`
 * and the prompt.
 *
 * The read direction is the point.
 *
 * `/fold-lore` wrote a cast row out to a World Info entry and stopped there. The owner's cards are
 * already dossiers, "Slim, toned frame built for speed and precision. Almond-brown eyes, straight
 * brows, sharp cheekbones, pale-gold skin. Black bob cut" is on disk in `Raccoon City.json`, uid 15,
 * written by hand, and sanguine was extracting a thinner copy of that beside it and showing the
 * copy. A link makes the authored text the record's, three ways:
 *
 *   1. The dossier SHOWS it, marked authored rather than extracted (`overlay-cast.js`).
 *   2. The extractor is TOLD who is already described, so it stops re-deriving a face
 *      (`entities.context`, via `authoredNames`).
 *   3. A linked, flagged, PRESENT character's canon reaches the narrator whether or not a keyword
 *      fired: the unlock, because World Info can only fire on words somebody happened to say and
 *      sanguine already knows who is standing in the room.
 *
 * What this module refuses to do.
 *
 * It never toggles `constant` on an entry to force it in. That would rewrite a curated world file on
 * every message, and these are the owner's own hand-written cards. Sanguine injects the content from
 * its own extension prompt and leaves the file alone; the price of that choice is the possibility of
 * saying the same thing twice, which is what the covered set exists to prevent.
 *
 * It never writes over an entry it did not author. `mayOverwrite` wants the link to claim ownership
 * AND the file to still carry the stamp; a user who renames the comment has taken the entry back,
 * and sanguine stops writing to it.
 */

import {
    characters,
    chat_metadata,
    extension_prompt_roles,
    extension_prompt_types,
    getCurrentChatId,
    saveMetadata,
    setExtensionPrompt,
    this_chid,
} from '../../../script.js';
import {
    METADATA_KEY,
    createNewWorldInfo,
    createWorldInfoEntry,
    loadWorldInfo,
    saveWorldInfo,
    selected_world_info,
    world_names,
} from '../../world-info.js';
import { lookup, table_entries } from './lib/hash.js';
import { PERSON, castAt, resolveEntity } from './entity-table.js';
import {
    LORE_PATH,
    activatedSet,
    authoredNames as authoredNamesOf,
    dropDeadLinks,
    entryBody,
    entryIn,
    entryKeys,
    isSanguineEntry,
    linkFor,
    linkId,
    mayOverwrite,
    packLink,
    rekeyLink,
    renderAuthored,
    resolveLink,
    selectAuthored,
    stampFor,
    unpackLink,
} from './lore-table.js';
import { PRUNE_ARCHIVE, commit, loadTable, registerPruner } from './store.js';

/** The cast table's path. Duplicated from `entities.js` on purpose, importing it would be a cycle:
 * `entities.js` reads this module for the probe clause. The constant has one writer and has not
 * moved since the v2 migration named it. */
const CAST_PATH = 'state.cast';
const TURN_PATH = 'state.turn';
/** Scene fields, for the location the presence test compares against. Read directly for CAST_PATH's
 * reason: `state.js` imports `entities.js`, which imports this module. */
const CONTEXT_PATH = 'state.context';

/**
 * Injection key.
 *
 * `5_sanguine_lore` sorts before `5_sanguine_recall` and `6_sanguine_state`: standing canon, then
 * what happened, then what is true right now. Depth 1 puts it with the state block, close enough to
 * the reply that a face the narrator is about to describe is the last thing he read about.
 */
const LORE_INJECT_KEY = '5_sanguine_lore';
const LORE_DEPTH = 1;

/**
 * This generation's candidates, kept between the interceptor and the World Info scan.
 *
 * The same ordering problem `recall.js` documents: generation interceptors run BEFORE the World Info
 * scan, so the covered set at injection time is a turn stale. Retrieval is already done here (the
 * books are loaded, the entries resolved); only the filtering changes, so the candidates are held and
 * re-selected when `WORLD_INFO_ACTIVATED` fires.
 *
 * @type {Array<{name: string, book: string, uid: any, text: string}>}
 */
let pending = [];

/**
 * Names whose canon is authored, cached for the probe clause.
 *
 * `entities.context()` is synchronous, it is called while the extraction prompt is being assembled
 *, and reading a lorebook is not. So the answer is computed whenever a link changes or a generation
 * prepares, and read from here. A cache that is one turn stale costs the model one redundant
 * description; a synchronous file read costs the prompt.
 *
 * @type {{chat: string, names: string[]}}
 */
let authoredCache = { chat: '', names: [] };

/** @returns {Map<string, any>} The link table. */
export function load() {
    return loadTable(LORE_PATH);
}

/** @returns {Map<string, object>} The cast table. */
function cast() {
    return loadTable(CAST_PATH);
}

/** @returns {number} The turn counter, as `entities.turn()` reports it. */
function turn() {
    const value = Number(lookup(loadTable(TURN_PATH), 'n', 0));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Where the scene is, as `state.snapshot()` would report it.
 *
 * An empty answer is honest and it degrades the gate rather than breaking it: `presenceOf` returns
 * UNPLACED for everyone when the location is unknown, and UNPLACED people are candidates, so a chat
 * whose narration stops naming rooms falls back to "recently in the cast" rather than to nobody.
 * That is the same hedge the panel makes on the same data.
 *
 * @returns {string} The location, or ''.
 */
function sceneAt() {
    const field = lookup(loadTable(CONTEXT_PATH), 'location', null);
    return String((field && typeof field === 'object' ? field.v : field) ?? '').trim();
}

/**
 * The link for one entity, unpacked.
 * @param {string} key An entity key.
 * @returns {{book: string, uid: any, mine: boolean, present: boolean}|null} The link.
 */
export function linkOf(key) {
    return linkFor(load(), key);
}

/**
 * Record a link.
 * @param {string} key An entity key.
 * @param {object} link The link, see `packLink`.
 * @returns {boolean} Whether it was stored.
 */
export function setLink(key, link) {
    const id = String(key ?? '').trim();
    const packed = packLink(link);
    if (!id || !packed) {
        return false;
    }
    const table = load();
    table.set(id, packed);
    commit(LORE_PATH, table);
    void refreshAuthored();
    return true;
}

/**
 * Forget a link. Deletion, never a stored falsy, `state.poi`'s rule, and the reason is the same
 * 5 KB of headroom the largest live chat has left.
 *
 * @param {string} key An entity key.
 * @returns {boolean} Whether a link was removed.
 */
export function unlink(key) {
    const table = load();
    if (!table.delete(String(key ?? '').trim())) {
        return false;
    }
    commit(LORE_PATH, table);
    void refreshAuthored();
    return true;
}

/**
 * Turn presence-gated injection on or off for a link.
 * @param {string} key An entity key.
 * @param {boolean} [want] Desired state; omitted toggles.
 * @returns {boolean} The new state.
 */
export function setPresent(key, want) {
    const table = load();
    const id = String(key ?? '').trim();
    const link = linkFor(table, id);
    if (!link) {
        return false;
    }
    const next = want === undefined ? !link.present : Boolean(want);
    table.set(id, packLink({ ...link, present: next }));
    commit(LORE_PATH, table);
    return next;
}

/**
 * Move a link when a merge changes the entity key it hangs on.
 * @param {string} from The old key.
 * @param {string} to The new key.
 * @returns {boolean} True when a link moved.
 */
export function rekey(from, to) {
    const table = load();
    if (!rekeyLink(table, from, to)) {
        return false;
    }
    commit(LORE_PATH, table);
    return true;
}

/**
 * The worlds this chat can see, newest-scoped first.
 *
 * Not `getSortedEntries()`, although that is the canonical gatherer: it emits an event other
 * extensions listen to, strips decorators out of the content it returns, and does four file loads
 * whether or not the caller needs them. This module wants the BOOK LIST, and the book list is three
 * plain facts about the current chat.
 *
 * @returns {string[]} World names that exist on disk.
 */
export function booksInPlay() {
    const chatBook = chat_metadata?.[METADATA_KEY];
    const charBook = characters?.[this_chid]?.data?.extensions?.world;
    const names = [chatBook, charBook, ...(selected_world_info ?? [])]
        .map(name => String(name ?? '').trim())
        .filter(Boolean);
    return [...new Set(names)].filter(name => world_names.includes(name));
}

/**
 * Load several books at once, tolerating every one of them being gone.
 *
 * Fail open is the whole contract here: `loadWorldInfo` returns null for a world that no longer
 * exists and throws for one whose file is unreadable, and neither may reach a caller. A book that
 * cannot be opened is a book with no entries, which resolves every link into it as `stale`.
 *
 * @param {string[]} names World names.
 * @returns {Promise<Map<string, object|null>>} Loaded files by name.
 */
export async function loadBooks(names) {
    const wanted = [...new Set((names ?? []).map(name => String(name ?? '').trim()).filter(Boolean))];
    const out = new Map();
    await Promise.all(wanted.map(async (name) => {
        try {
            out.set(name, await loadWorldInfo(name));
        } catch (error) {
            console.warn(`[sanguine] could not open lorebook "${name}"; treating its links as stale`, error);
            out.set(name, null);
        }
    }));
    return out;
}

/**
 * Everything the Entities tab needs to draw one row's lorebook state.
 *
 * Never throws, never returns null. `state` is the three-valued answer the UI renders: `none` for
 * an unlinked row, `stale` for a link whose book or entry is gone, `ok` for a live one. A stale link
 * carries the book and uid it was pointing at, because "the entry sanguine had is gone" is a
 * different thing to say than "nobody linked this person".
 *
 * @param {string} key An entity key.
 * @returns {Promise<{state: string, book: string, uid: any, mine: boolean, present: boolean,
 *   writable: boolean, content: string, comment: string, keys: string[]}>} The link's state.
 */
export async function dossier(key) {
    const blank = {
        state: 'none', book: '', uid: null, mine: false, present: false,
        writable: false, content: '', comment: '', keys: [],
    };
    try {
        const link = linkOf(key);
        if (!link) {
            return blank;
        }
        const books = await loadBooks([link.book]);
        const resolved = resolveLink(link, books);
        if (resolved.state !== 'ok') {
            return { ...blank, state: 'stale', book: link.book, uid: link.uid, mine: link.mine, present: link.present };
        }
        const entry = resolved.entry;
        return {
            state: 'ok',
            book: link.book,
            uid: link.uid,
            mine: link.mine,
            present: link.present,
            // The FILE decides, not the stored bit. See `mayOverwrite`.
            writable: mayOverwrite(link, entry),
            content: String(entry.content ?? ''),
            comment: String(entry.comment ?? ''),
            keys: (Array.isArray(entry.key) ? entry.key : []).map(String),
        };
    } catch (error) {
        console.warn('[sanguine] lore lookup failed; treating the link as stale', error);
        return { ...blank, state: 'stale' };
    }
}

/**
 * Every entry the chat's books hold, for the link picker.
 *
 * Sorted by book then by label, and the label is the entry's comment falling back to its first key,
 * an entry with neither is shown by uid rather than as a blank row, because a blank row in a picker
 * is a row nobody can choose deliberately.
 *
 * @returns {Promise<Array<{book: string, uid: any, label: string, mine: boolean, keys: string[]}>>}
 *   The entries.
 */
export async function entryIndex() {
    const books = await loadBooks(booksInPlay());
    const out = [];
    for (const [book, data] of books) {
        for (const entry of Object.values(data?.entries ?? {})) {
            if (!entry || typeof entry !== 'object') {
                continue;
            }
            const keys = (Array.isArray(entry.key) ? entry.key : []).map(String).filter(Boolean);
            out.push({
                book,
                uid: entry.uid,
                label: String(entry.comment ?? '').trim() || keys[0] || `#${entry.uid}`,
                mine: isSanguineEntry(entry),
                keys,
            });
        }
    }
    return out.sort((a, b) => a.book.localeCompare(b.book) || a.label.localeCompare(b.label));
}

/**
 * Link an entity to an entry that already exists.
 *
 * The stamp decides `mine`, so linking to a hand-written card produces a READ-ONLY link and the UI
 * says so. Nothing is written to the book here, a link is a fact sanguine stores about itself.
 *
 * @param {string} key An entity key.
 * @param {string} book The world name.
 * @param {any} uid The entry uid.
 * @returns {Promise<{ok: boolean, mine: boolean, reason: string}>} What happened.
 */
export async function linkExisting(key, book, uid) {
    const books = await loadBooks([book]);
    const entry = entryIn(books.get(String(book ?? '').trim()), uid);
    if (!entry) {
        return { ok: false, mine: false, reason: 'missing' };
    }
    const mine = isSanguineEntry(entry);
    const stored = setLink(key, { book, uid: entry.uid ?? uid, mine, present: linkOf(key)?.present ?? false });
    return { ok: stored, mine, reason: stored ? '' : 'refused' };
}

/**
 * The chat's own lorebook, created and bound if it has none.
 *
 * Never an existing world the player curates for something else: if the chat has no book, a new one
 * named after the chat is made and bound to it, which is the only book sanguine is entitled to
 * create entries in unasked.
 *
 * @returns {Promise<string>} The book name, or '' if one could not be made.
 */
export async function chatBook() {
    const bound = chat_metadata?.[METADATA_KEY];
    if (bound && world_names.includes(bound)) {
        return bound;
    }
    const name = `fold, ${getCurrentChatId() ?? 'campaign'}`.replace(/[^\w \-, ]/g, '_').slice(0, 64);
    if (!world_names.includes(name)) {
        await createNewWorldInfo(name);
    }
    if (!world_names.includes(name)) {
        return '';
    }
    chat_metadata[METADATA_KEY] = name;
    await saveMetadata();
    return name;
}

/**
 * Write a cast row out to a lorebook entry, and link it.
 *
 * Three paths, and the middle one is the safety property:
 *
 *   · linked and OURS      update the entry in place.
 *   · linked and THEIRS    write nothing, say so. A hand-written card is never touched.
 *   · not linked           create a new entry in the chat's book and link to it by uid.
 *
 * The old `/fold-lore` re-found its entry by matching `comment === "fold: <name>"`, which is what
 * made a rename orphan the entry and the next write duplicate it. The link is stored by uid instead,
 * so the comment is free to be anything.
 *
 * @param {string} key An entity key.
 * @param {object} row The cast row.
 * @returns {Promise<{ok: boolean, book: string, uid: any, created: boolean, reason: string}>} What
 *   happened.
 */
export async function writeOut(key, row) {
    const link = linkOf(key);
    const body = entryBody(row) || String(row?.name ?? '');
    const keys = entryKeys(row);

    if (link) {
        const books = await loadBooks([link.book]);
        const data = books.get(link.book);
        const entry = entryIn(data, link.uid);
        if (!entry) {
            // Fail open: the link is stale, so behave as an unlinked entity does, but drop the dead
            // link first, or the next write would resolve it again and fail again forever.
            unlink(key);
            return writeOut(key, row);
        }
        if (!mayOverwrite(link, entry)) {
            return { ok: false, book: link.book, uid: link.uid, created: false, reason: 'read-only' };
        }
        Object.assign(entry, { key: keys, content: body, comment: stampFor(row?.name), disable: false });
        await saveWorldInfo(link.book, data, true);
        return { ok: true, book: link.book, uid: link.uid, created: false, reason: '' };
    }

    const book = await chatBook();
    if (!book) {
        return { ok: false, book: '', uid: null, created: false, reason: 'no-book' };
    }
    const data = await loadWorldInfo(book);
    if (!data) {
        return { ok: false, book, uid: null, created: false, reason: 'no-book' };
    }
    const entry = createWorldInfoEntry(book, data);
    if (!entry) {
        return { ok: false, book, uid: null, created: false, reason: 'no-entry' };
    }
    Object.assign(entry, { key: keys, content: body, comment: stampFor(row?.name), disable: false });
    await saveWorldInfo(book, data, true);
    setLink(key, { book, uid: entry.uid, mine: true, present: false });
    return { ok: true, book, uid: entry.uid, created: true, reason: '' };
}

/**
 * Resolve a display name to a cast row, the way `/fold-lore` always has.
 * @param {string} said A name or any alias.
 * @returns {{key: string, entity: object}|null} The row.
 */
export function findPerson(said) {
    return resolveEntity(cast(), PERSON, said);
}

/**
 * Recompute which linked characters have authored canon, for the probe clause.
 *
 * Awaited by nobody on the hot path. It is called when a link changes and once per generation, and
 * an answer that lands a moment late costs one redundant description in one extraction pass.
 *
 * @returns {Promise<string[]>} The names.
 */
export async function refreshAuthored() {
    try {
        const table = load();
        if (!table.size) {
            authoredCache = { chat: String(getCurrentChatId() ?? ''), names: [] };
            return [];
        }
        const books = await loadBooks([...new Set(table_entries(table)
            .map(([, raw]) => unpackLink(raw)?.book)
            .filter(Boolean))]);
        // Only links whose entry actually SAYS something count. An empty entry is not a description,
        // and telling the model "Ada Wong is already described" when nothing describes her is how a
        // face stops being extracted and never starts being authored.
        const describes = new Set();
        for (const [, raw] of table_entries(table)) {
            const link = unpackLink(raw);
            const entry = link ? entryIn(books.get(link.book), link.uid) : null;
            if (entry && String(entry.content ?? '').trim()) {
                describes.add(linkId(link.book, link.uid));
            }
        }
        const names = authoredNamesOf(table, cast(), describes);
        authoredCache = { chat: String(getCurrentChatId() ?? ''), names };
        return names;
    } catch (error) {
        console.warn('[sanguine] could not refresh the authored-canon list', error);
        return authoredCache.names;
    }
}

/**
 * Characters the extractor should be told are already described.
 *
 * Stamped with the chat it was computed in and refused when that no longer matches, `recall.lastSelection`'s
 * discipline, and for the same reason: a stale stamp reads as "nothing yet", where a missed
 * `CHAT_CHANGED` would name the previous campaign's cast in this campaign's prompt.
 *
 * @returns {string[]} Display names.
 */
export function authoredNames() {
    return authoredCache.chat === String(getCurrentChatId() ?? '') ? authoredCache.names : [];
}

/**
 * Build this generation's candidates and inject them.
 *
 * Called once from the interceptor. Clears the block first on every path, including the quiet one,
 * so a block built for a real generation can never survive into one that should not have it.
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.quiet] True for a quiet generation, which gets nothing.
 * @param {string} [options.at] The scene location, for the presence test. Defaults to the stored one.
 * @returns {Promise<number>} How many entries were injected.
 */
export async function prepare({ quiet = false, at = sceneAt() } = {}) {
    pending = [];
    inject('');
    if (quiet) {
        return 0;
    }
    try {
        const table = load();
        if (!table.size) {
            return 0;
        }
        // Refreshed here, and here rather than further down, because the extraction pass reads
        // `authoredNames()` synchronously and every path below this line can return early. A chat
        // with links but nobody present still has characters whose face the probe must not re-derive.
        void refreshAuthored();

        // Presence by the same predicate the panel and `renderEntities` use, so a person sanguine
        // says is in the room is the person the rest of the extension says is in the room. `here`
        // and `unplaced` only: `castAt` keeps ELSEWHERE out of the prompt entirely, and a flagged
        // character in another city must never buy their way back in, `the_insert_law`'s rule,
        // which this feature would otherwise be the loudest violation of.
        const scene = castAt(cast(), turn(), at);
        const present = new Map();
        for (const person of [...scene.here, ...scene.unplaced]) {
            present.set(person.key, person);
        }
        if (!present.size) {
            return 0;
        }

        const wanted = [];
        for (const [key, raw] of table_entries(table)) {
            const link = unpackLink(raw);
            if (link?.present && present.has(key)) {
                wanted.push({ key, link, name: present.get(key).name ?? '' });
            }
        }
        if (!wanted.length) {
            return 0;
        }

        const books = await loadBooks(wanted.map(item => item.link.book));
        for (const item of wanted) {
            const resolved = resolveLink(item.link, books);
            const text = String(resolved.entry?.content ?? '').trim();
            // A stale link contributes nothing and says nothing. Failing open here means the
            // narrator's prompt is exactly what it was before anyone linked anything.
            if (resolved.state === 'ok' && text && !resolved.entry.disable) {
                pending.push({ name: item.name, book: item.link.book, uid: item.link.uid, text });
            }
        }

        // Selected against an empty covered set, because the World Info scan has not run yet. This
        // is the answer that stands only if nothing activates, `reselect` replaces it otherwise.
        const chosen = selectAuthored({ candidates: pending });
        inject(renderAuthored(chosen.rows));
        return chosen.rows.length;
    } catch (error) {
        console.error('[sanguine] authored-canon injection failed', error);
        return 0;
    }
}

/**
 * Re-select against what World Info actually activated.
 *
 * The double-injection guard. `WORLD_INFO_ACTIVATED` fires after the interceptor and before the
 * prompt is assembled, which is the one window where the real covered set is known and there is
 * still time to act on it, the same window `recall.select` uses.
 *
 * @param {Array<object>} entries Activated World Info entries.
 * @returns {number} How many entries survived the filter.
 */
export function reselect(entries) {
    if (!pending.length) {
        return 0;
    }
    try {
        const chosen = selectAuthored({ candidates: pending, activated: activatedSet(entries) });
        inject(renderAuthored(chosen.rows));
        if (chosen.covered) {
            console.debug(`[sanguine] World Info already fired for ${chosen.covered} linked entr${chosen.covered === 1 ? 'y' : 'ies'}; not repeating them`);
        }
        return chosen.rows.length;
    } catch (error) {
        console.error('[sanguine] authored-canon re-selection failed', error);
        return 0;
    }
}

/**
 * Set the block, or clear it.
 *
 * `scan: false` for `applyRecallBlock`'s reason: `checkWorldInfo` feeds every extension prompt with
 * `scan: true` into its own scan buffer, so scanning this block would let an injected dossier
 * activate further World Info entries, and this block exists precisely because World Info's
 * activation is not the authority on who is in the room.
 *
 * @param {string} text The block.
 */
function inject(text) {
    setExtensionPrompt(
        LORE_INJECT_KEY,
        String(text ?? ''),
        extension_prompt_types.IN_CHAT,
        LORE_DEPTH,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

/** What the last generation put in the prompt, for diagnostics. @returns {object[]} Candidates. */
export function lastCandidates() {
    return pending.map(item => ({ name: item.name, book: item.book, uid: item.uid, chars: item.text.length }));
}

// Links outlive the people and the entries they name.
//
// A cast row is pruned past `ENTITY_STALE * 2`; a lorebook entry is deleted by whoever owns the
// book. Either leaves a link pointing at nothing, and nothing was clearing them, the same leak
// `state.poi` measured, in a table with a strictly larger key space.
//
// `PRUNE_ARCHIVE` rather than `PRUNE_DIAGNOSTICS`: a link the player made by hand is worth more than
// a log line and less than the chronicle. Orphans only. This pruner never sheds a LIVE link, because
// unlike a person-of-interest flag a link is not re-derivable, it is a pairing the player made
// between two files, and losing it silently to a byte count is losing work.
registerPruner((overBy) => {
    const table = load();
    if (!table.size) {
        return;
    }
    const live = new Set(table_entries(cast()).map(([key]) => key));
    const dropped = dropDeadLinks(table, live);
    if (dropped) {
        commit(LORE_PATH, table);
        console.debug(`[sanguine] dropped ${dropped} orphaned lorebook link(s) to fit the metadata budget (over by ${overBy})`);
    }
}, PRUNE_ARCHIVE);
