/**
 * fold/migrate.js: v1 → v2, in place, once, without guessing.
 *
 * Pure over the fold blob and the tables it converts. No storage, no `chat_metadata`, no imports
 * that reach SillyTavern, `store.js` cannot be unit-tested because it imports `script.js`, which
 * is the same reason Phase A put its window split in `extract-table.js` rather than `extract.js`.
 * This file is what the replay harness (`tests/util/fold-migrate-replay.mjs`) runs against copies
 * of the real chats, and running the migration the app runs is the only kind of replay worth
 * having.
 *
 * The constraint.
 *
 * The Solo Leveling campaign is mid-flight, with two hand repairs and a lock in it, and must load
 * unchanged in MEANING. So every rule below is one of three shapes:
 *
 *   move      the same information under a new key, field-preserving  (entities → cast)
 *   split     one v1 field into two v2 fields whose distinction v1 could not express
 *             (a clock becomes a thread with a `doom` dial; a lead becomes a thread with none)
 *   ask       a case where two records MIGHT be one thing, recorded as a question, never merged
 *
 * There is deliberately no fourth shape. Anything this file cannot do by rule it flags for the
 * review pass (Phase C) rather than deciding, because a wrong merge at migration time is
 * unrecoverable without another hand repair, and the whole point of this redesign is to stop
 * needing those.
 *
 * The staged remainder, executed in Phase D.
 *
 * Phase B left `state.context.conditions`, `health`, `rank` and `mana` exactly where they were, and
 * said why on the record: §9 sends conditions to pov marks and the permanent facts to a `facts`
 * field, and neither marks nor facts existed yet. A destination invented ahead of the code that
 * reads it is how `state.context.leads` became a prose fossil in the first place (§0.1-5). Both
 * destinations exist now (`state-table.js` `seedMarks`, `entity-table.js` `facts`), so
 * `migrateBody` and `migrateFacts` below finish the job. This is why `migrate()` is keyed on the
 * PRESENCE of old keys rather than on a version number alone: a chat already stamped v2 by Phase B
 * still has these keys, and still gets them routed.
 *
 * Idempotence.
 *
 * Every step tests for its own output before writing, so a second run is a no-op, and the old keys
 * survive the first v2 write. They are deleted only on a LATER load, once `state.cast` and
 * `state.threads` have come back off disk, which is the only evidence available in a browser that
 * the v2 blob was actually persisted. Rollback in between costs nothing: v1 readers find v1 keys
 * exactly as they left them (§9).
 */

import {
    LEAD,
    LEAD_LABELS,
    MAX_DETAIL,
    PERSON,
    PERSON_LABELS,
    resolveEntity,
    splitEntityKey,
} from './entity-table.js';
import { splitConditions } from './block-parse.js';
import {
    BLOCK,
    HEALTH_LABELS,
    NARRATIVE,
    MODERATE,
    itemKey,
    normalizeItemName,
} from './state-table.js';
import {
    DOOM,
    MAX_THREAD_TEXT,
    foldThreads,
    identityPairs,
    normalizeSize,
    normalizeThreadName,
    threads as readThreads,
} from './thread-table.js';

/** The version this file produces. `store.js` owns the dispatch; this owns the conversion. */
export const V2 = 2;

/** Where the v2 tables live, beside the v1 ones rather than on top of them. */
export const CAST_PATH = 'cast';
export const THREADS_PATH = 'threads';

/**
 * Context labels whose prose duplicates a structured table.
 *
 * `leads` and `pressure` are the measured ones: the Solo Leveling card began emitting a status
 * block whose free-text `leads` and `pressure` fields restated the thread table and the clock
 * table, arriving `src: 'block'`, which outranks narrative for a window of turns
 * (`state-table.js:1305-1313`, applied at `:1332-1339`), so the least structured representation won on trust and the
 * residency stake existed in three places at once (FOLD-REDESIGN.md §0.1-5).
 *
 * `health` is NOT here. It shadows marks, and marks are Phase D; routing it now would drop it into
 * a table that does not exist.
 */
const THREAD_LABELS = new Set([...LEAD_LABELS, 'pressure', 'threats', 'dangers']);

/**
 * The scene probe's own body-state field, and the one context label whose meaning depends on where
 * it came from.
 *
 * Why provenance and not the label.
 *
 * §9 sends `state.context.conditions` to pov marks. Read as a rule about the LABEL, that is wrong on
 * a real chat: Raccoon City's `conditions` reads *"cool, dry night; dim CRT-lit apartment"*, a
 * card's own `Conditions:` heading meaning the weather and the light, which would migrate into three
 * marks claiming the protagonist is suffering from a CRT. Solo Leveling's reads *"calf scabbed and
 * rebandaged, left arm bruised shoulder to elbow"* and Evil Hero Party's reads *"tired"*, both of
 * which are exactly what §9 means.
 *
 * What separates them is not the words, judging "is this a body" from the words is the enumerated
 * judgement §11 bans, it is WHO WROTE IT. `src: 'narrative'` means the scene probe, whose schema
 * has always defined this field as "how the point-of-view character is physically doing right now"
 * (`scene.js`). `src: 'block'`, or no `src` at all on a chat that predates the tagging, means a card
 * chose the heading and fold has no idea what it meant by it. Measured across the four live chats:
 * narrative-sourced on Solo Leveling and Evil Hero Party, untagged on Raccoon City, absent on Nora.
 * The rule routes the first two and keeps the third verbatim, which is the right answer in all four.
 *
 * `health`-family labels (`HEALTH_LABELS`) need no such test: that label set is fold's own structured
 * domain for body state (`absorb-table.js` `domainOf`), and a card writing `Health:` has said what it
 * means.
 */
const BODY_LABEL = 'conditions';

/** Labels another table already owns, so `migrateFacts` never mistakes one for a standing truth. */
const CLAIMED = new Set([
    ...THREAD_LABELS, ...HEALTH_LABELS, ...PERSON_LABELS, BODY_LABEL,
    'location', 'time', 'date', 'weather', 'pov',
]);

/**
 * Contact details are never items.
 *
 * The delta schema says so outright, and the entity probe reports a way to reach someone as the
 * structured `reach` field on the person (`entities.js`). The v1 rows that were filed under the
 * `contacts` place are legacy data, and the read-heal that keeps them out of derived inventory is
 * keyed on the exact keys this migration records, fold's OWN output, never an English word list.
 */

/**
 * Migrate a fold blob in place.
 *
 * @param {object} fold The blob at `chat_metadata.fold`, mutated.
 * @returns {{from: number, to: number, counts: object, flags: object, retired: string[],
 *   changed: boolean}} A report. `changed` is false when this call found nothing to do, so a caller
 *   that runs the migration on every load can skip persisting a blob it did not touch.
 */
/**
 * Phase 1 shape repair: strip the reserved category places off rows that cannot bear them.
 *
 * The rows fold used to default every `new` to `carried`, so a thread or a person created before
 * `placeFor` (rows-table.js) rendered `, carried` in the ledger and projected into the legacy
 * inventory as a carried item. One-time and keyed on the damage: a non-item row at a category
 * place is the damage, so a second run finds none.
 *
 * @param {object} state The fold state.
 * @returns {number} How many rows were corrected.
 */
function healRowsPlaces(state) {
    const table = state && typeof state === 'object' ? state.rows : null;
    const rows = table && Array.isArray(table.rows) ? table.rows : [];
    const CATEGORY_PLACES = new Set(['carried', 'money', 'assets', 'abilities']);
    let fixed = 0;
    for (const row of rows) {
        if (!row || typeof row !== 'object' || row.kind === 'item') continue;
        const place = String(row.place ?? '').toLowerCase();
        if (!place) continue;
        if (row.kind === 'person') {
            if (CATEGORY_PLACES.has(place)) {
                row.place = '';
                fixed++;
            }
            continue;
        }
        row.place = '';
        fixed++;
    }
    return fixed;
}

export function migrate(fold) {
    const blob = fold && typeof fold === 'object' ? fold : {};
    const from = Number(blob.v) || 1;
    const state = blob.state && typeof blob.state === 'object' ? blob.state : (blob.state = {});
    const counts = {
        cast: 0, threadsFromLeads: 0, threadsFromClocks: 0, threadsFromContext: 0,
        reach: 0, blockShadow: 0, full: 0, marks: 0, facts: 0, factsFull: 0,
    };
    const flags = { identity: [], polarity: [] };

    // Retirement first, so a blob that has already converted spends no time re-testing the rules
    // below. See the header: the old keys go only once the new ones have survived a load.
    const retired = retire(state);

    // The v2 pass runs on what is THERE; only the v1 conversion may create a table.
    //
    // These used to be materialised unconditionally, and once `store.js` calls this on every load
    // (see the `from >= V2` branch below) that writes `cast: {}` and `threads: {}` into every blob
    // that has neither. MEASURED: two of the twenty-one live chats, both Royal Succession, gain 23
    // bytes of empty tables and nothing else, on a blob under a hard 128 KiB cap, and the write is
    // pure noise because a chat with no cast has no row to own a mark or a fact anyway. The v1 path
    // below genuinely needs somewhere to put its output, so it still creates them.
    const existingCast = state[CAST_PATH] && typeof state[CAST_PATH] === 'object' ? state[CAST_PATH] : null;
    const existingThreads = state[THREADS_PATH] && typeof state[THREADS_PATH] === 'object' ? state[THREADS_PATH] : null;
    const dropped = [];

    // Phase B's staged remainder, and it runs on a v2 blob too.
    //
    // A chat Phase B already stamped `v: 2` still carries `conditions`, `health`, `rank` and `mana`
    // in its context, because those two rules did not exist yet. Version alone therefore cannot say
    // whether there is work to do; the PRESENCE of the keys can, and both routines test for their
    // own output, so a second run is a no-op (the invariant the replay harness asserts).
    //
    // AFTER the cast exists, in both paths: marks and facts belong to the point-of-view character's
    // row, and on a v1 blob that row does not exist until `migrateEntities` has run.
    //
    // This branch has never executed, and the caller is why.
    //
    // `store.js` `getFold` invokes `migrate()` only when `version < V2 || pending?.length`. Every
    // chat in the corpus is stamped `v: 2` with nothing pending, so the two routines below, and the
    // two counters under them, have never run once in the life of this build. That is not a
    // theoretical gap: opening the gate rescues twelve block-written facts on the Isekai RPG chat
    // and shrinks its blob by 634 bytes, work `contextBand` is currently paying for every turn by
    // dropping those labels as stale. The caller's condition needs to become the once-per-blob
    // `!migrated.has(fold)` guard alone, and `changed` below exists so it can still skip the save
    // when a load found nothing to do.
    if (from >= V2) {
        const castHere = existingCast ?? {};
        const castTableHere = new Map(Object.entries(castHere));
        migrateBody(state, castHere, castTableHere, counts);
        migrateFacts(state, castHere, castTableHere, counts);
        note(state, 'cap:migrate-marks', counts.marks);
        note(state, 'cap:migrate-facts', counts.facts);
        note(state, 'cap:migrate-facts-full', counts.factsFull);
        // The rows table is post-v2, so this heal belongs on the v2 path only. `changed` carries it
        // so a load that only corrected row places still saves.
        const fixedRows = healRowsPlaces(state);
        if (fixedRows) note(state, 'cap:rows-places', fixedRows);
        // `castHere` is `state.cast` itself whenever there was one, so the writes above are already
        // persisted. When there was none it is a throwaway, and it is necessarily still empty:
        // `resolveEntity` over an empty table returns no owner, so neither routine can have written.
        const changed = !!(retired.length || counts.marks || counts.facts || fixedRows);
        return { from, to: V2, counts, flags, retired, changed };
    }

    const cast = existingCast ?? (state[CAST_PATH] = {});
    const threads = existingThreads ?? (state[THREADS_PATH] = {});
    const table = new Map(Object.entries(threads));
    const castTable = new Map(Object.entries(cast));

    migrateEntities(state, cast, castTable, table, counts);
    const reachKeys = new Set();
    migrateContacts(Object.values(blob?.chronicle?.events ?? {}), reachKeys, counts);
    migrateClocks(state, table, counts, flags);
    migrateContext(state, table, counts, dropped);
    migrateBody(state, cast, castTable, counts);
    migrateFacts(state, cast, castTable, counts);

    for (const [key, value] of table) {
        threads[key] = value;
    }

    // The identity question, asked and never answered here.
    //
    // The residency stake exists twice in the live chat, the lead "Hunter residency: twenty
    // D-rank raids" and the clock "The residency window closes", and §9 forbids merging them on
    // token overlap, because that is exactly the guess this design refuses. So migration produces
    // TWO threads and one question.
    flags.identity.push(...identityQuestions(table, castTable));

    state.migrated = {
        // Preserved rather than replaced: `migrateBody` above may already have parked seeds here,
        // and this assignment runs after it.
        ...(state.migrated ?? {}),
        at: Date.now(),
        from,
        counts: { ...counts },
        // The exact item keys of legacy contact rows, recorded so `deriveState`'s read-heal can
        // skip them. Keyed on this migration's OWN output, never an English place word.
        reachKeys: [...reachKeys],
        // What the exposition gate refused, verbatim. §9 says block-shadow fields are never carried
        // into v2 context; it does not say they are unrecoverable, and a migration that destroys
        // the only record of five story facts (Raccoon City, where extraction never ran) would be
        // the silent loss this redesign exists to stop.
        dropped: [...(state.migrated?.dropped ?? []), ...dropped],
        identity: flags.identity,
        polarity: flags.polarity,
        pending: [ENTITIES_KEY, CLOCKS_KEY].filter(key => state[key]),
    };

    note(state, 'cap:migrate-cast', counts.cast);
    note(state, 'cap:migrate-threads', counts.threadsFromLeads + counts.threadsFromClocks + counts.threadsFromContext);
    note(state, 'cap:migrate-reach', counts.reach);
    note(state, 'cap:migrate-flagged', flags.identity.length + flags.polarity.length);
    note(state, 'reject:block-shadow', counts.blockShadow);
    note(state, 'cap:threads-full', counts.full);
    note(state, 'cap:migrate-marks', counts.marks);
    note(state, 'cap:migrate-facts', counts.facts);
    note(state, 'cap:migrate-facts-full', counts.factsFull);

    blob.v = V2;
    // A v1 conversion always changed something: the version stamp itself moved.
    return { from, to: V2, counts, flags, retired, changed: true };
}

const ENTITIES_KEY = 'entities';
const CLOCKS_KEY = 'clocks';

/**
 * Delete v1 keys once the v2 ones have come back off disk.
 *
 * The condition is the strongest one a browser can offer: the blob currently in memory was loaded
 * from the chat file, and it already contains the v2 tables, so the v2 write reached the disk.
 * Deleting in the same session that wrote them would mean deleting on the strength of an
 * in-memory object and a debounced save (`store.js` `commit`), which is not evidence.
 *
 * @param {object} state The `fold.state` object, mutated.
 * @returns {string[]} Keys deleted.
 */
function retire(state) {
    const pending = state?.migrated?.pending;
    if (!Array.isArray(pending) || !pending.length) {
        return [];
    }
    if (!state[CAST_PATH] && !state[THREADS_PATH]) {
        return [];
    }
    const gone = [];
    for (const key of pending) {
        if (state[key]) {
            delete state[key];
            gone.push(key);
        }
    }
    state.migrated.pending = [];
    return gone;
}

/**
 * `state.entities` splits by kind: person rows become cast rows, lead rows become dial-less
 * threads.
 *
 * The cast key is preserved BYTE FOR BYTE, NUL separator and all. Rekeying would put every stored
 * row through `normalizeEntityName` again, and a normalizer that has changed since a row was
 * written would silently merge two people or split one, `KeyResolution.lean`'s
 * `resolution_breaks_key_independence` is the general statement, and the Kang bug
 * (`FOLD-RPG-GAP.md` §2) is the specific one. A migration is the worst possible moment to re-run a
 * resolver.
 *
 * @param {object} state The `fold.state` object.
 * @param {object} cast The v2 cast table, mutated.
 * @param {Map<string, object>} castTable The same, as a Map.
 * @param {Map<string, object>} table The v2 thread table, mutated.
 * @param {object} counts Counters, mutated.
 */
function migrateEntities(state, cast, castTable, table, counts) {
    const entities = state[ENTITIES_KEY];
    if (!entities || typeof entities !== 'object') {
        return;
    }
    for (const [key, row] of Object.entries(entities)) {
        const { kind } = splitEntityKey(key);
        if (kind === LEAD) {
            const parsed = normalizeThreadName(row?.name);
            if (!parsed || table.has(parsed.key)) {
                continue;
            }
            // Written directly rather than through `foldThreads`, because the exposition gate is a
            // filter on PROPOSALS. A lead already in a chat was accepted once, possibly before the
            // gate existed, and re-judging stored rows on a rule they never faced is how a
            // migration turns into a purge. (`entities.js` `prune` already deletes the pre-gate
            // rows on its own terms; this is not the place to repeat it.)
            table.set(parsed.key, {
                name: parsed.display,
                first: row?.first ?? row?.turn ?? 0,
                aka: text(row?.aka),
                open: text(row?.open),
                detail: text(row?.detail),
                about: '',
                status: row?.status === 'closed' ? 'closed' : 'open',
                seen: 'open',
                where: '',
                source: text(row?.source),
                turn: row?.turn ?? 0,
            });
            counts.threadsFromLeads++;
            continue;
        }
        if (cast[key]) {
            continue;
        }
        const row2 = { ...row };
        // `reach` is the entity probe's structural answer now, not something a migration guesses
        // from English contact verbs in `detail`. The v1 row's detail is preserved verbatim; the
        // probe re-reads the same narrative on the next extraction pass and reports reach in any
        // language.
        cast[key] = row2;
        castTable.set(key, row2);
        counts.cast++;
    }
}

/**
 * Contact rows become `reach`, recorded by exact key.
 *
 * The delta schema says contact details are never items and the entity probe reports `reach`
 * structurally. A v1 row under the `contacts` place is legacy data whose meaning only the model
 * can re-state, so this migration does not guess ownership from English possessives or reach
 * from English verbs. It records the EXACT item keys of the legacy contact rows it found, and the
 * read-heal in `deriveState` skips those exact keys, keyed on the migration's own output, never
 * a word list.
 *
 * The chronicle is NOT rewritten. State is a fold over live events (`state-table.js`
 * `deriveState`), so an event is the record of what happened and stays that.
 *
 * @param {object[]} events The chronicle's events.
 * @param {Set<string>} reachKeys Exact normalized item names of contact rows, mutated.
 * @param {object} counts Counters, mutated.
 */
function migrateContacts(events, reachKeys, counts) {
    for (const event of events) {
        for (const change of event?.d?.inv ?? []) {
            if (change?.at !== 'contacts') {
                continue;
            }
            const name = normalizeItemName(change?.item)?.name;
            if (!name) {
                continue;
            }
            // Keyed on the same item key `deriveState` folds, so a row that ALSO sits in a pocket
            // (carried) is untouched, only the contact row itself is healed.
            const key = itemKey(name, change?.at);
            if (!reachKeys.has(key)) {
                reachKeys.add(key);
                counts.reach++;
            }
        }
    }
}

/**
 * `state.clocks` becomes threads with a doom dial.
 *
 * Why every migrated dial is flagged, and none is guessed.
 *
 * §9 says a v1 clock whose `about` reads as the player WINNING is exactly the case migration must
 * not guess, and must stay `doom` until a review confirms. The obvious implementation is a word
 * list, "gains", "completes", "succeeds", and it is refused on the standing rule
 * (FOLD-REDESIGN.md §11): every enumerated-vocabulary judgement in this codebase has been measured
 * and deleted, most recently `isNegation` keeping `functional` as a live status flag because the
 * word was not on the list (§0.1-4).
 *
 * So the flag is unconditional. Every dial that predates polarity is flagged for the first review
 * pass, which asks a model that can actually read the sentence. The cost is exactly one question
 * per migrated clock, and the measured population is one clock across all four live chats.
 *
 * @param {object} state The `fold.state` object.
 * @param {Map<string, object>} table The v2 thread table, mutated.
 * @param {object} counts Counters, mutated.
 * @param {object} flags Flags, mutated.
 */
function migrateClocks(state, table, counts, flags) {
    const clocks = state[CLOCKS_KEY];
    if (!clocks || typeof clocks !== 'object') {
        return;
    }
    for (const [key, row] of Object.entries(clocks)) {
        const parsed = normalizeThreadName(row?.name ?? key);
        if (!parsed || table.has(parsed.key)) {
            continue;
        }
        const size = normalizeSize(row?.size, DOOM);
        const filled = Math.max(0, Math.min(Number(row?.filled) || 0, size));
        const record = {
            name: parsed.display,
            first: row?.first ?? row?.turn ?? 0,
            aka: '',
            open: '',
            detail: '',
            about: text(row?.about),
            kind: DOOM,
            filled,
            size,
            // A full clock has already happened. `closed` rather than `moot`: it fired, and the
            // difference between "it fired" and "it stopped mattering" is the distinction `moot`
            // was added to keep.
            status: filled >= size ? 'closed' : 'open',
            seen: row?.seen === 'hidden' ? 'hidden' : 'open',
            where: text(row?.where),
            source: '',
            turn: row?.turn ?? 0,
        };
        table.set(parsed.key, record);
        counts.threadsFromClocks++;
        flags.polarity.push({ thread: parsed.key, why: 'predates-polarity', about: record.about });
    }
}

/**
 * Context fields that shadow the thread table are routed into thread proposals.
 *
 * Through the exposition gate, which is the point: these are prose the card wrote, and the gate is
 * the rule that separates a thread from a fact about the world. Whatever the gate refuses is
 * counted `reject:block-shadow` and kept verbatim under `state.migrated.dropped`: see the note
 * there. The context key itself is removed only when at least one clause survived, so a chat whose
 * only record of its leads is this field does not lose it to a rule that produced nothing.
 *
 * @param {object} state The `fold.state` object, mutated.
 * @param {Map<string, object>} table The v2 thread table, mutated.
 * @param {object} counts Counters, mutated.
 * @param {object[]} dropped Refused clauses, appended to.
 */
function migrateContext(state, table, counts, dropped) {
    const context = state.context;
    if (!context || typeof context !== 'object') {
        return;
    }
    for (const [label, field] of Object.entries(context)) {
        if (!THREAD_LABELS.has(String(label).toLowerCase())) {
            continue;
        }
        const value = String(field?.v ?? '');
        // Punctuation split only, the old `splitClauses` used the `FINITE_VERB` English verb list
        // to decide which comma fragment was its own lead. Whether a clause is a separate lead is a
        // reading the threads probe answers structurally from the same block text.
        const clauses = value.split(/\s*[;,，、；]\s*/).map(part => part.trim()).filter(Boolean);
        if (!clauses.length) {
            continue;
        }
        const turn = Number(field?.t) || 0;
        // A rejection reports the NAME it refused, which `normalizeThreadName` has already
        // truncated to MAX_THREAD_NAME. What is preserved for the review has to be the clause the
        // card actually wrote, so the truncated form is only ever a lookup key here.
        const byName = new Map(clauses.map(clause => [normalizeThreadName(clause)?.display, clause]));
        const before = table.size;
        const { rejected } = foldThreads(table, clauses.map(clause => ({
            // The clause is both the title and the open question, because a prose lead has no
            // other structure to take a title from. `normalizeThreadName` truncates the key; the
            // full clause survives in `open`.
            name: clause,
            open: clause,
            source: `card block, ${label}`,
        })), { turn });
        const accepted = table.size - before;
        counts.threadsFromContext += accepted;
        counts.blockShadow += rejected.length;
        counts.full += rejected.filter(entry => entry.reason === 'threads-full').length;
        for (const entry of rejected) {
            dropped.push({ label, reason: entry.reason, text: byName.get(entry.item) ?? entry.item });
        }
        if (accepted) {
            delete context[label];
        }
    }
}

/**
 * `state.context.conditions` and `health` become marks on the point-of-view character's row.
 *
 * §9's read-time healing, run once, because the probe is not available at migration time.
 *
 * `FOLD-REDESIGN.md` §9: conditions "split on `splitConditions`; severity defaults *moderate*;
 * negations dropped (`isNegation`, already the read rule)". Those two functions are demoted in
 * Phase D to exactly this, legacy prose that fold never asked for in mark shape (`block-parse.js`,
 * both docblocks). This is the one job they keep at migration time, and it is unavoidable: the
 * probes that judge afflictions properly read a narrative window, and a migration has no window,
 * only a string somebody's card wrote turns ago.
 *
 * Severity is `moderate` for everything, and that is a refusal rather than a guess: ranking a wound
 * from its wording is precisely the enumerated judgement §11 bans, the review can lower or raise it
 * (`review-table.js`, the M-lines), and the middle rank is the one that is never confidently wrong.
 *
 * Marks land on the pov's cast row when there is one, and in `state.migrated.marks` when there is
 * not: Raccoon City has body-state prose and an empty entity table, and a migration that invents a
 * cast row to hold it would break the one invariant the replay checks hardest (cast count preserved).
 *
 * @param {object} state The `fold.state` object, mutated.
 * @param {object} cast The v2 cast table, mutated.
 * @param {Map<string, object>} castTable The same, as a Map.
 * @param {object} counts Counters, mutated.
 */
function migrateBody(state, cast, castTable, counts) {
    const context = state.context;
    if (!context || typeof context !== 'object') {
        return;
    }
    const povName = text(context.pov?.v);
    const owner = povName ? resolveEntity(castTable, PERSON, povName) : null;

    for (const [label, field] of Object.entries(context)) {
        const said = String(label).toLowerCase();
        const body = HEALTH_LABELS.has(said)
            || (said === BODY_LABEL && String(field?.src ?? '') === NARRATIVE);
        if (!body) {
            continue;
        }
        // The same demoted reader the card block path uses, and its refusals are the same:
        // "otherwise uninjured" is not a wound (`block-parse.js` `isNegation`).
        // NOT truncated to MAX_MARKS here. The consequence-slot rule belongs to the fold
        // (`state-table.js` `placeMark`), which displaces the mildest or escalates it rather than
        // dropping anything, and a migration that silently cut the fourth clause would be the
        // retraction-by-silence this redesign exists to delete. Measured on the pre-repair2 header:
        // four clauses in one `health` field, of which the fold presents three.
        const phrases = splitConditions(String(field?.v ?? ''));
        if (!phrases.length) {
            // Nothing routed. The key stays, for `migrateContext`'s reason: a rule that produced
            // nothing must not be allowed to destroy the only record of what a card said.
            continue;
        }
        const marks = phrases.map(phrase => ({
            who: owner ? String(owner.entity?.name ?? povName) : '',
            phrase,
            severity: MODERATE,
            t: Number(field?.t) || 0,
            from: label,
        }));
        if (owner) {
            const row = { ...owner.entity, marks: [...(owner.entity?.marks ?? []), ...marks] };
            cast[owner.key] = row;
            castTable.set(owner.key, row);
        } else {
            // Where a mark lands when there is no pov row to own it. Raccoon City is the measured
            // case: `health: "hangover faded; mild fatigue"` and an entity table with nobody in it,
            // because extraction never ran there. `entities.markSeeds` reads both places.
            state.migrated = {
                ...(state.migrated ?? {}),
                marks: [...(state.migrated?.marks ?? []), ...marks],
            };
        }
        counts.marks += marks.length;
        delete context[label];
    }
}

/**
 * Block-only truths about the character stop aging and become `facts` on the pov's row.
 *
 * The measured defect.
 *
 * `rank: "E-Rank Hunter (Class undetermined)"` and `mana: "negligible (E-rank)"` sat in Solo
 * Leveling's scene context, and `contextBand` (`state-table.js`) dropped them from the prompt every
 * time they aged past the band, a large share of `cap:context-stale` was fold repeatedly
 * discarding two facts the fiction says are FIXED AT AWAKENING (`FOLD-REDESIGN.md` §0). Permanence
 * was inexpressible, so it was billed as staleness. `facts` on the cast row has no `t` to age
 * against, which is the whole of the fix.
 *
 * The rule, and the risk it carries.
 *
 * A context field qualifies when the CARD wrote it (`src: 'block'`) and no structured table claims
 * its label. Provenance again, for `BODY_LABEL`'s reason: the scene probe writes what the narration
 * establishes about a moment, and a card's block writes what the sheet says about a character. There
 * is no structural test that separates `rank` from a hypothetical `mood`, and inventing a word list
 * to try is the thing §11 forbids, so the honest statement of the risk is this: a card that writes
 * a volatile label into its block will have that label frozen once, under the label it used. What
 * makes that acceptable rather than a fossil-in-the-making is that `facts` is field-wise
 * last-write and the entity probe now writes it too (`entities.js` `schema`), so the next sighting
 * corrects it, and the label is preserved in the value, so a reader can see exactly what was
 * rescued and from where.
 *
 * Measured across the four live chats: this routes exactly `rank` and `mana`, both on Solo Leveling,
 * and nothing at all on the other three.
 *
 * @param {object} state The `fold.state` object, mutated.
 * @param {object} cast The v2 cast table, mutated.
 * @param {Map<string, object>} castTable The same, as a Map.
 * @param {object} counts Counters, mutated.
 */
function migrateFacts(state, cast, castTable, counts) {
    const context = state.context;
    if (!context || typeof context !== 'object') {
        return;
    }
    const povName = text(context.pov?.v);
    const owner = povName ? resolveEntity(castTable, PERSON, povName) : null;
    if (!owner) {
        // Nowhere to put a standing truth about a character fold cannot name. Left in context,
        // where it is at least still visible, rather than parked in a bucket nothing reads.
        return;
    }

    const rescued = [];
    for (const [label, field] of Object.entries(context)) {
        if (String(field?.src ?? '') !== BLOCK || CLAIMED.has(String(label).toLowerCase())) {
            continue;
        }
        const value = text(field?.v);
        if (!value) {
            continue;
        }
        rescued.push({ label, line: `${label}: ${value}` });
    }
    if (!rescued.length) {
        return;
    }

    // A label is deleted from context only once its text is safely INSIDE `facts`.
    //
    // This used to delete every qualifying label first, join them all, and then
    // `.slice(0, MAX_DETAIL)` the result, which is a silent delete of everything past 120
    // characters. MEASURED on the Isekai RPG chat the moment the `store.js` gate opens: twelve
    // block labels leave context, seven and a half survive the cut, and `skills`, `abilities`,
    // `bonds`, `quests` and `status effect` are destroyed outright. Five story facts, gone, with the
    // context copy already deleted and the ledger holding nothing, which is the exact loss
    // `migrateContext` refuses two hundred lines above ("a migration that destroys the only record
    // of five story facts ... would be the silent loss this redesign exists to stop").
    //
    // So the cut moves BEFORE the delete. Each line is admitted only if the whole string still fits,
    // and a label that does not fit keeps its context entry: still rendered, still aging, exactly as
    // it is today. Worse than being frozen as a fact, far better than being deleted. Greedy rather
    // than stop-at-first-overflow so a short label is not lost behind a long one, and the whole pass
    // stays idempotent, a later run re-offers the leftovers, re-measures them against the same
    // `facts`, and skips them again without writing.
    let facts = text(owner.entity?.facts);
    let taken = 0;
    let overflowed = 0;
    for (const { label, line } of rescued) {
        const next = facts ? `${facts}; ${line}` : line;
        if (next.length > MAX_DETAIL) {
            overflowed++;
            continue;
        }
        facts = next;
        delete context[label];
        taken++;
    }
    if (!taken) {
        // Nothing moved, so nothing was left behind BY THIS PASS, the leftovers were already
        // counted by the pass that filled `facts`. Counting them again on every load is how an
        // idempotent routine grows an unbounded counter: `note` is additive, so a re-entrant
        // `factsFull` would climb by six on every open of the Isekai chat forever.
        return;
    }
    counts.factsFull += overflowed;
    const row = { ...owner.entity, facts };
    cast[owner.key] = row;
    castTable.set(owner.key, row);
    counts.facts += taken;
}

/**
 * Pairs that might be one thing, for the first review pass to settle.
 *
 * Two triggers, and they are not the same rule:
 *
 *   1. The §2 near-identity detector over names, within each table. It catches the measured pairs
 *      it was built for: `next raid with Kang's squad` / `…team` (one substitution) and
 *      `broker` / `scarred broker` (subset).
 *   2. A migration-only trigger across the lead/clock boundary: a thread that came from a lead and
 *      a thread that came from a clock which share a distinctive content token. This is looser,
 *      and it exists because the detector in (1) provably does NOT catch the pair §9 names,
 *      measured on the live chat, "Hunter residency: twenty D-rank raids" tokenises to
 *      {hunter, residency, twenty, d-rank, raids} and "The residency window closes" to
 *      {residency, window, closes}: different head tokens, neither a subset, more than one
 *      substitution apart. The two tables were never keyed against each other, so the names of a
 *      lead and a clock about one stake have no reason to resemble each other at all, only their
 *      subject does.
 *
 * Both only ever ASK. Nothing here merges anything.
 *
 * @param {Map<string, object>} table The thread table.
 * @param {Map<string, object>} castTable The cast table.
 * @returns {Array<{a: string, b: string, why: string, kind: string}>} Questions.
 */
function identityQuestions(table, castTable) {
    const rows = readThreads(table, 0);
    const questions = identityPairs(rows).map(pair => ({ ...pair, kind: 'thread' }));
    questions.push(...identityPairs([...castTable].map(([key, row]) => ({ key, name: row?.name ?? '' })))
        .map(pair => ({ ...pair, kind: 'cast' })));

    const asked = new Set(questions.map(pair => `${pair.a}\u0000${pair.b}`));
    const dialled = rows.filter(row => row.dial);
    const plain = rows.filter(row => !row.dial);
    for (const dial of dialled) {
        for (const thread of plain) {
            const shared = [...subjectTokens(dial)].filter(token => subjectTokens(thread).has(token));
            if (!shared.length) {
                continue;
            }
            const id = `${thread.key}\u0000${dial.key}`;
            if (asked.has(id)) {
                continue;
            }
            asked.add(id);
            questions.push({ a: thread.key, b: dial.key, why: `shared-subject:${shared[0]}`, kind: 'thread' });
        }
    }
    return questions;
}

/**
 * The distinctive words a thread is about.
 *
 * Long tokens only (five characters and up), because the short ones are the ones every sentence
 * shares. This is a question-raiser, not a matcher: it is allowed to be crude in the direction of
 * asking too often, and is never allowed to decide.
 *
 * `name` and `about` only, deliberately NOT `open`, which was the first version and was measured
 * wrong on the live chat: the thread "Jin-Woo's family" carries `open: "…Jin-Woo raids to cover
 * the gap"`, which shares "raids" with the residency clock's `about` and produced a question about
 * two threads that have nothing to do with each other. `name` and `about` state what a thread IS;
 * `open` states where it currently stands, and where something stands is not what it is about.
 *
 * @param {object} thread A thread record.
 * @returns {Set<string>} Tokens.
 */
function subjectTokens(thread) {
    const source = `${thread?.name ?? ''} ${thread?.about ?? ''}`;
    return new Set(String(source).toLowerCase()
        .split(/[^\p{L}\p{N}'-]+/u)
        .filter(word => word.length >= 5));
}

/**
 * Trim a stored string to the thread table's bound.
 * @param {any} raw Anything.
 * @returns {string} A bounded string.
 */
function text(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_THREAD_TEXT);
}

/**
 * Record a migration count into the observe table, in the blob, without importing storage.
 *
 * `observe.js` writes through `store.js`, and `store.js` is what calls this file, so calling back
 * into it would be a cycle at the exact moment the blob is half-converted. The observe table is a
 * plain Count table on disk (`state.observed`, rule → integer), so incrementing it here is the
 * same operation `merge_bu` performs, applied where it is safe.
 *
 * @param {object} state The `fold.state` object, mutated.
 * @param {string} rule A namespaced rule.
 * @param {number} times How many.
 */
function note(state, rule, times) {
    if (!times) {
        return;
    }
    const observed = state.observed && typeof state.observed === 'object' ? state.observed : (state.observed = {});
    observed[rule] = (Number(observed[rule]) || 0) + times;
}

// Exported so the replay harness and the tests assert against the rules the app applies rather
// than against copies of them.
export { THREAD_LABELS, CLAIMED, BODY_LABEL };
