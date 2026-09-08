/**
 * sanguine/lore-table.js: the entity ↔ lorebook link, as data.
 *
 * Pure and dependency-free apart from ./lib/hash.js, so jest can hold all of it. The half that
 * touches World Info and `chat_metadata` is `lore.js`.
 *
 * What a link is for.
 *
 * `/fold-lore` has always written a cast row OUT to a World Info entry, and the write was the whole
 * feature: the entry was re-found by matching the string `fold: <name>` in its `comment`, so
 * renaming the person orphaned it and the next write opened a duplicate, and nothing ever read an
 * entry BACK. That second half is the valuable one. The owner's cards are already lorebook-grade
 * dossiers: "Almond-brown eyes, straight brows, sharp cheekbones, pale-gold skin. Black bob cut" is
 * authored, on disk, in `Raccoon City.json`, and sanguine was extracting a pale copy of it beside
 * the original. A link says: this row and that entry are the same person. Authored beats extracted.
 *
 * The three properties this file exists to make true.
 *
 *   1. NEVER OVERWRITE what sanguine did not author. `mayOverwrite` is the only gate, and it wants
 *      two independent yeses: the link must have been recorded as ours AND the entry must still
 *      carry our stamp. Either alone is a way to clobber a hand-written card, which is the worst
 *      outcome this feature has available to it.
 *   2. SURVIVE A RENAME, both sides. The link is `{book, uid}`, the entry's stable identity,
 *      never a name and never the comment string. Rename the entry's comment, rewrite its keys,
 *      change the person's display name: the link is untouched. `rekeyLink` moves it when the
 *      TABLE key changes, which happens exactly once, in `mergeEntities`.
 *   3. FAIL OPEN. `resolveLink` returns a state, never throws and never blanks: a missing book or a
 *      deleted uid reads as `stale`, and every caller treats stale as unlinked.
 *
 * Size.
 *
 * Three of the owner's 21 chats sit above 90% of `MAX_FOLD_BYTES`, the largest at 125,853 bytes,
 * 5 KB of headroom before the pruners start shedding chronicle events. So the row is four short
 * keys and the off states are absences, not stored falsies: `state.poi`'s lesson, which measured two
 * inert `false` rows an hour after it shipped. A link costs about 55 bytes; sixteen cost under a
 * kilobyte. Entry CONTENT is never cached here, it is read from the lorebook on demand, because
 * one copy of Ada Wong's entry alone would be 4 KB of a 5 KB budget.
 */

import { lookup, table_entries } from './lib/hash.js';

/** Where the link table lives in the fold blob. */
export const LORE_PATH = 'state.lore';

/**
 * The stamp that marks an entry as sanguine's own work.
 *
 * `fold: ` rather than `sanguine: ` although the extension was renamed, because entries written by
 * the old `/fold-lore` are on disk in the owner's worlds right now and a new prefix would declare
 * every one of them somebody else's, read-only forever, and duplicated by the next write. The
 * rename is not worth that. `SANGUINE_STAMPS` accepts both so a future writer may change its mind.
 */
export const LORE_STAMP = 'fold: ';

/** Prefixes that mean "sanguine wrote this entry". */
export const SANGUINE_STAMPS = Object.freeze(['fold: ', 'sanguine: ']);

/**
 * How much authored content one present character may put in the prompt.
 *
 * Ada Wong's entry in the live Raccoon City book is 4,096 characters, a full dossier with a USE IN
 * PLAY section and a stat sheet. All of it is worth reading and none of it is worth paying for on
 * every turn she is in the room, so the head of it goes in and the cut lands on a paragraph or a
 * sentence boundary. The head is the right end: authored dossiers open with identity and appearance,
 * which is exactly what the complaint was about.
 */
export const MAX_LORE_ENTRY = 1200;

/** Ceiling on the whole block, across every present linked character. */
export const MAX_LORE_BLOCK = 3600;

/**
 * The identity of one lorebook entry, as a comparable string.
 *
 * NUL-separated for `entityKey`'s reason: it is the one byte a world name and a uid cannot contain,
 * so the join is injective and `"Raccoon City" 15` can never collide with a book called
 * `"Raccoon City 1"` holding entry 5. Every id in this module goes through here, an id built two
 * ways in two files is a set membership test that silently never matches, which is exactly the bug
 * this function was extracted to fix.
 *
 * @param {string} book The world name.
 * @param {any} uid The entry uid.
 * @returns {string} The id.
 */
export function linkId(book, uid) {
    return `${book}\u0000${uid}`;
}

/**
 * Does this entry carry sanguine's stamp?
 *
 * The `comment` is a display label the user can retype at will, so this is never used to FIND an
 * entry: only to refuse a write. A user who renames the comment of an entry sanguine authored has
 * taken it over, and sanguine stops writing to it. That failure direction is the safe one.
 *
 * @param {object} entry A World Info entry.
 * @returns {boolean} True when sanguine authored it.
 */
export function isSanguineEntry(entry) {
    const comment = String(entry?.comment ?? '');
    return SANGUINE_STAMPS.some(prefix => comment.startsWith(prefix));
}

/**
 * The comment sanguine stamps on entries it creates.
 * @param {string} name The person's display name.
 * @returns {string} The stamp.
 */
export function stampFor(name) {
    return `${LORE_STAMP}${String(name ?? '').trim()}`;
}

/**
 * May sanguine write over this entry?
 *
 * Two independent yeses, and the redundancy is deliberate. The link's `mine` bit says what sanguine
 * believed when the link was made; the stamp says what the FILE says now. They disagree exactly when
 * the user has adopted an entry sanguine created, renamed its comment, made it theirs, and in that
 * disagreement the file wins.
 *
 * @param {object|null} link An unpacked link.
 * @param {object|null} entry The World Info entry it resolved to.
 * @returns {boolean} True only when both halves agree sanguine owns it.
 */
export function mayOverwrite(link, entry) {
    return Boolean(link?.mine) && Boolean(entry) && isSanguineEntry(entry);
}

/**
 * Pack a link for storage.
 *
 * Short keys, and the off states are omitted rather than stored: `p: 0` is 6 bytes per row saying
 * nothing, in a blob whose pruners shed campaign memory when it fills.
 *
 * @param {object} link The link.
 * @param {string} link.book The world name.
 * @param {number|string} link.uid The entry's uid within that world.
 * @param {boolean} [link.mine] Whether sanguine authored the entry.
 * @param {boolean} [link.present] Whether to carry the entry while the person is in the scene.
 * @returns {{b: string, u: number|string, m?: 1, p?: 1}|null} The stored shape, or null if unusable.
 */
export function packLink({ book, uid, mine = false, present = false } = {}) {
    const b = String(book ?? '').trim();
    // `uid` is a number in every entry SillyTavern writes, but `createWorldInfoEntry` only promises
    // uniqueness within the file, so it is carried as given and compared loosely on the way out.
    if (!b || uid === undefined || uid === null || uid === '') {
        return null;
    }
    return { b, u: uid, ...(mine ? { m: 1 } : {}), ...(present ? { p: 1 } : {}) };
}

/**
 * Unpack a stored link.
 * @param {any} raw The stored row.
 * @returns {{book: string, uid: any, mine: boolean, present: boolean}|null} The link, or null.
 */
export function unpackLink(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const book = String(raw.b ?? '').trim();
    if (!book || raw.u === undefined || raw.u === null || raw.u === '') {
        return null;
    }
    return { book, uid: raw.u, mine: Boolean(raw.m), present: Boolean(raw.p) };
}

/**
 * The link for one entity key.
 * @param {Map<string, any>} table The link table.
 * @param {string} key An entity key.
 * @returns {{book: string, uid: any, mine: boolean, present: boolean}|null} The link.
 */
export function linkFor(table, key) {
    return unpackLink(lookup(table, String(key ?? ''), null));
}

/**
 * Find a link's entry in a book that has already been loaded.
 *
 * Loose comparison on the uid, because `loadWorldInfo` keys `data.entries` by the STRING form of
 * the uid while the entry's own `uid` field is a number, and a link round-tripped through JSON has
 * been both. A link that can be broken by `===` is not a link.
 *
 * @param {object|null} data A world file as `loadWorldInfo` returns it.
 * @param {any} uid The entry uid.
 * @returns {object|null} The entry, or null.
 */
export function entryIn(data, uid) {
    const entries = data?.entries;
    if (!entries || typeof entries !== 'object' || uid === undefined || uid === null) {
        return null;
    }
    const direct = entries[String(uid)];
    if (direct && typeof direct === 'object') {
        return direct;
    }
    // eslint-disable-next-line eqeqeq
    return Object.values(entries).find(entry => entry && entry.uid == uid) ?? null;
}

/**
 * Resolve a link against the books that could be loaded.
 *
 * Fail open, and say so.
 *
 * Three outcomes and they are three different things to render. `none` is a person nobody linked.
 * `stale` is a link whose book or entry is gone, the user deleted the world, or the entry inside
 * it: and it must behave in every respect like `none` while still saying out loud that it is
 * broken, because a dossier that silently loses its authored half looks like sanguine forgot.
 * `ok` carries the entry.
 *
 * Never throws. A caller that has to try/catch a resolution will eventually forget to.
 *
 * @param {object|null} link An unpacked link.
 * @param {Map<string, object|null>|null} books Loaded world files, by name. A name absent from the
 *   map is treated as a book that could not be opened.
 * @returns {{state: 'none'|'stale'|'ok', entry: object|null, book: string, uid: any}} The outcome.
 */
export function resolveLink(link, books) {
    if (!link) {
        return { state: 'none', entry: null, book: '', uid: null };
    }
    const data = books?.get?.(link.book) ?? null;
    const entry = entryIn(data, link.uid);
    return {
        state: entry ? 'ok' : 'stale',
        entry,
        book: link.book,
        uid: link.uid,
    };
}

/**
 * The trigger keys sanguine writes on an entry it authors.
 *
 * Their names ARE the trigger: `aka` is the alias set the fold already maintains for exactly this
 * question, so an authored entry fires on "the shaved-head boy" as well as on "Takeda".
 *
 * @param {object} row A cast row.
 * @returns {string[]} Keys, deduplicated, display order preserved.
 */
export function entryKeys(row) {
    const seen = new Set();
    const out = [];
    for (const part of [row?.name, ...String(row?.aka ?? '').split(',')]) {
        const key = String(part ?? '').trim();
        const fold = key.toLowerCase();
        if (key && !seen.has(fold)) {
            seen.add(fold);
            out.push(key);
        }
    }
    return out;
}

/**
 * The body sanguine writes into an entry it authors.
 *
 * Standing truths first, then appearance, then the social state, the order the panel and the
 * injected block both use: what they are, what they look like, then what they want from you.
 *
 * The four description fields are here now, and they were the omission.
 *
 * This body was `facts`/`wants`/`knows`/`reach` when the cast row had nowhere else to put a face.
 * `look`, `wearing`, `bearing` and `history` exist now, and an exported entry that drops them writes
 * a WORSE dossier than the record it was exported from, which is the same "pale copy" failure in
 * the other direction.
 *
 * @param {object} row A cast row.
 * @returns {string} The entry body.
 */
export function entryBody(row) {
    const said = value => String(value ?? '').trim();
    return [
        said(row?.facts),
        said(row?.look) && `Appearance: ${said(row.look)}`,
        said(row?.bearing) && `Manner: ${said(row.bearing)}`,
        said(row?.history) && `Background: ${said(row.history)}`,
        said(row?.wants) && `Wants: ${said(row.wants)}`,
        said(row?.knows) && `Knows about you: ${said(row.knows)}`,
        said(row?.reach) && `Reachable: ${said(row.reach)}`,
    ].filter(Boolean).join('. ').replace(/\.\.$/, '.');
}

/**
 * Cut text to a length, on a boundary a reader would have chosen.
 *
 * Paragraph first, then sentence, then a hard cut with an ellipsis. Authored prose reaches the
 * narrator as prose or it reaches him as evidence that the tracker mangles things.
 *
 * @param {string} raw The text.
 * @param {number} max Maximum length.
 * @returns {string} The clipped text.
 */
export function clip(raw, max) {
    const text = String(raw ?? '').trim();
    if (text.length <= max) {
        return text;
    }
    const head = text.slice(0, max);
    const paragraph = head.lastIndexOf('\n');
    if (paragraph > max * 0.5) {
        return head.slice(0, paragraph).trim();
    }
    const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sentence > max * 0.5) {
        return head.slice(0, sentence + 1).trim();
    }
    return `${head.trim()}…`;
}

/**
 * The identity of an activated World Info entry, for the double-injection test.
 *
 * `world` is set by `getSortedEntries` on every entry it gathers, so it is present on everything
 * `WORLD_INFO_ACTIVATED` reports. It is still treated as optional: a uid alone is not an identity,
 * two books both number their first entry 0, so an entry with no world contributes no id and is
 * caught by the content test instead.
 *
 * @param {object} entry An activated entry.
 * @returns {string} An id, or '' when the entry cannot be identified.
 */
export function entryId(entry) {
    const world = String(entry?.world ?? '').trim();
    const uid = entry?.uid;
    return world && uid !== undefined && uid !== null ? linkId(world, uid) : '';
}

/**
 * What World Info is already putting in the prompt, as a suppression set.
 *
 * Two channels, because one of them can fail. The ids are exact and cheap. The contents are the
 * fallback for an entry that arrived without a `world`, and they are also the honest test: if the
 * same words are already in the prompt, sanguine must not pay for them again whatever the uids say.
 *
 * Constant entries are NOT excluded here, and that is the difference from `recall.noteActivatedWorldInfo`.
 * Recall skips them because a constant entry says nothing about this turn's topic; this module is
 * asking a narrower question, "are these exact words already going in?", and a constant entry's
 * words are going in.
 *
 * @param {Array<object>} entries Activated World Info entries.
 * @returns {{ids: Set<string>, texts: Set<string>}} The suppression set.
 */
export function activatedSet(entries) {
    const ids = new Set();
    const texts = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const id = entryId(entry);
        if (id) {
            ids.add(id);
        }
        const content = String(entry?.content ?? '').trim();
        if (content) {
            texts.add(content);
        }
    }
    return { ids, texts };
}

/**
 * Is this candidate already covered by World Info's own activation?
 * @param {{book: string, uid: any, text: string}} candidate A candidate row.
 * @param {{ids: Set<string>, texts: Set<string>}|null} activated The suppression set.
 * @returns {boolean} True when World Info already fired for it.
 */
export function isCovered(candidate, activated) {
    if (!activated) {
        return false;
    }
    const id = candidate.book && candidate.uid !== undefined && candidate.uid !== null
        ? linkId(candidate.book, candidate.uid)
        : '';
    return (Boolean(id) && activated.ids.has(id)) || activated.texts.has(String(candidate.text ?? '').trim());
}

/**
 * Choose which authored entries reach the prompt this turn.
 *
 * Why suppression happens HERE and not by asking World Info to stand down.
 *
 * The obvious implementation is to flip `constant` on the linked entry whenever the person is in
 * the room. It rewrites the user's lorebook file on every message, a curated world file churning
 * under an extension nobody asked to edit it, so it is not available. Sanguine injects the content
 * itself, from its own extension prompt, and leaves the file alone.
 *
 * The cost of that choice is exactly one risk: World Info fires on a keyword, sanguine fires on
 * presence, and a turn where both are true would put the same dossier in the prompt twice. So the
 * covered set decides, the same way `recall.select` decides, and for the same reason, the
 * interceptor runs BEFORE the World Info scan, so the first answer is always computed against a
 * stale covered set and re-computed when `WORLD_INFO_ACTIVATED` says what really fired.
 *
 * @param {object} options Options.
 * @param {Array<{name: string, book: string, uid: any, text: string}>} options.candidates Present,
 *   linked, flagged people with their entry text, in the order they should be read.
 * @param {{ids: Set<string>, texts: Set<string>}|null} [options.activated] The suppression set.
 * @param {number} [options.budget] Character ceiling for the whole block.
 * @param {number} [options.perEntry] Character ceiling for one entry.
 * @returns {{rows: Array<{name: string, text: string}>, covered: number, dropped: number}} The
 *   selection: what goes in, how many World Info already had, how many the budget could not fit.
 */
export function selectAuthored({ candidates, activated = null, budget = MAX_LORE_BLOCK, perEntry = MAX_LORE_ENTRY } = {}) {
    const rows = [];
    let covered = 0;
    let dropped = 0;
    let spent = 0;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const text = clip(candidate?.text, perEntry);
        if (!text) {
            continue;
        }
        if (isCovered({ ...candidate, text: String(candidate?.text ?? '') }, activated) || isCovered({ ...candidate, text }, activated)) {
            covered++;
            continue;
        }
        const cost = text.length + String(candidate?.name ?? '').length + 2;
        if (spent + cost > budget) {
            dropped++;
            continue;
        }
        spent += cost;
        rows.push({ name: String(candidate?.name ?? '').trim(), text });
    }
    return { rows, covered, dropped };
}

/**
 * Render the authored block.
 *
 * The heading does one job: tell the narrator this is not sanguine's guess.
 *
 * Everything else sanguine injects is derived, a fold over events, a table it maintains. This is
 * the one block whose words the user wrote, and the narrator has to know that, or he weighs an
 * authored face against an extracted one and averages them. Two sentences. The rejected empty state
 * was four paragraphs; a prompt header has less excuse than an empty state does.
 *
 * @param {Array<{name: string, text: string}>} rows The selection.
 * @returns {string} The block, or '' when there is nothing to say.
 */
export function renderAuthored(rows) {
    const lines = (Array.isArray(rows) ? rows : [])
        .filter(row => row && row.text)
        .map(row => (row.name ? `${row.name}: ${row.text}` : row.text));
    if (!lines.length) {
        return '';
    }
    return [
        'Established canon for people in this scene. Authored setting material, not a summary, write them as described rather than inventing details.',
        ...lines,
    ].join('\n');
}

/**
 * Move a link when the entity key it hangs on changes.
 *
 * A cast row's key is derived from its name, so `mergeEntities` folding `Kang` into `Kang Min-seo`
 * deletes the key a link was filed under. Without this the link is an orphan the pruner collects and
 * the user's careful pairing of a person to their dossier is gone because two rows became one.
 *
 * The survivor's own link wins a collision: it is the row that survived, and it is the link the user
 * made most recently against the name the table kept.
 *
 * @param {Map<string, any>} table The link table, mutated.
 * @param {string} from The old entity key.
 * @param {string} to The new entity key.
 * @returns {boolean} True when a link moved.
 */
export function rekeyLink(table, from, to) {
    const source = String(from ?? '');
    const target = String(to ?? '');
    if (!source || !target || source === target || !table?.has?.(source)) {
        return false;
    }
    const moved = table.get(source);
    table.delete(source);
    if (!table.has(target)) {
        table.set(target, moved);
        return true;
    }
    return false;
}

/**
 * Drop links whose entity is gone, and, if that was not enough, links whose entry is gone too.
 *
 * `state.poi`'s shape, and its reasoning: orphans are free to lose, because the row they pointed at
 * no longer exists and the link can never affect anything again. Cast rows ARE pruned, `entities.prune`
 * deletes past `ENTITY_STALE * 2`: so a long campaign accumulates dead links exactly the way it
 * accumulated dead flags.
 *
 * Stale links (book or entry gone) are shed in the same sweep, since a link that fails open is a
 * link that already behaves as though it were not there.
 *
 * @param {Map<string, any>} table The link table, mutated.
 * @param {Set<string>|null} live Entity keys that still exist. Null skips the orphan test.
 * @param {Set<string>|null} [resolvable] Link ids (`book\0uid`) that still resolve. Null skips it.
 * @returns {number} How many links were dropped.
 */
export function dropDeadLinks(table, live, resolvable = null) {
    let dropped = 0;
    for (const [key, raw] of table_entries(table)) {
        const link = unpackLink(raw);
        if (!link) {
            table.delete(key);
            dropped++;
            continue;
        }
        if (live && !live.has(key)) {
            table.delete(key);
            dropped++;
            continue;
        }
        if (resolvable && !resolvable.has(linkId(link.book, link.uid))) {
            table.delete(key);
            dropped++;
        }
    }
    return dropped;
}

/**
 * The names the extractor should be told are already described.
 *
 * The point of the whole read direction, stated as a set: a character whose appearance the user
 * authored must not be re-derived from a job title. `entities.context` turns this into one clause
 * below the prefix-cache breakpoint.
 *
 * @param {Map<string, any>} table The link table.
 * @param {Map<string, object>} cast The cast table.
 * @param {Set<string>|null} [describes] Link ids whose entry actually carries content. Null means
 *   every link counts, which is what a caller that has not loaded the books must assume.
 * @returns {string[]} Display names, deduplicated.
 */
export function authoredNames(table, cast, describes = null) {
    const out = [];
    const seen = new Set();
    for (const [key, raw] of table_entries(table)) {
        const link = unpackLink(raw);
        if (!link) {
            continue;
        }
        if (describes && !describes.has(linkId(link.book, link.uid))) {
            continue;
        }
        const name = String(lookup(cast, key, null)?.name ?? '').trim();
        if (name && !seen.has(name.toLowerCase())) {
            seen.add(name.toLowerCase());
            out.push(name);
        }
    }
    return out;
}
