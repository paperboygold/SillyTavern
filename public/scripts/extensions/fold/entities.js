/**
 * fold/entities.js — people and leads, persisted and folded.
 *
 * The pure logic is in entity-table.js; this file is the half that touches storage and the
 * extraction pass.
 *
 * ── Why these are stored rather than derived ──
 *
 * Inventory is a fold over the chronicle because every change to it was caused by an event. People
 * and leads are not like that. "Maria is reachable by email" is not the *result* of anything that
 * happened; it is a standing fact about the world that a turn happened to reveal. Folding it would
 * mean inventing an event whose only content is that something was mentioned, which inflates the
 * ledger with non-events and makes the audit trail worse rather than better.
 *
 * The cost is honest and worth naming: this table is not branch-aware. Swipe away the turn that
 * introduced Adele Ricci and she stays on the panel. That matches how scene context already
 * behaves, and the alternative — an event per mention — buys correctness on a rare case by
 * degrading the common one.
 */

import { lookup, table_entries } from './lib/hash.js';
import {
    ENTITY_STALE,
    LEAD,
    MAX_THREAT,
    PERSON,
    castAt,
    foldEntities,
    foldEntity,
    mergeEntities,
    normalizeEntityName,
    renderEntities,
    resolveEntity,
    splitEntityKey,
    threatOf,
} from './entity-table.js';
// The join between the cast table and the marks table happens here and only here: `state-table.js`
// imports `entity-table.js` (to normalise owner names), so the reverse import would be a cycle, and
// this file already depends on both halves.
import { markPhrases } from './state-table.js';
import { identityPairs } from './thread-table.js';
import { noteCoverage } from './coverage.js';
import * as cold from './cold-store.js';
import * as observe from './observe.js';
import { commit, loadTable, loadValue } from './store.js';

/**
 * Where the cast lives under v2.
 *
 * Renamed from `state.entities` by the migration (`migrate.js`), and the rename is not cosmetic:
 * the old table held two kinds of thing under one key space, and half of them — leads — are now
 * threads. `cast` is what is left once that is true, and a key that means one thing is a key a
 * reader can trust. The v1 key survives beside this one until the v2 blob has come back off disk
 * (FOLD-REDESIGN.md §9), so a rollback loses nothing.
 */
const ENTITIES_PATH = 'state.cast';
const TURN_PATH = 'state.turn';

/** @returns {Map<string, object>} The entity table. */
export function load() {
    return loadTable(ENTITIES_PATH);
}

/**
 * The turn counter used for staleness.
 *
 * Stored rather than taken from `chat.length`, because a chat can be trimmed, branched or loaded
 * mid-way and an entity's age must not jump when that happens.
 *
 * @returns {number} The current turn.
 */
export function turn() {
    const value = Number(lookup(loadTable(TURN_PATH), 'n', 0));
    return Number.isFinite(value) ? value : 0;
}

/**
 * Advance the turn counter.
 * @returns {number} The new turn.
 */
export function advanceTurn() {
    const next = turn() + 1;
    const table = loadTable(TURN_PATH);
    table.set('n', next);
    commit(TURN_PATH, table);
    return next;
}

/**
 * The schema fragment for the entity probe.
 *
 * Every nested object carries `additionalProperties: false` and lists every property in `required`,
 * because OpenAI's strict mode demands it on EVERY object and one omission fails the shared call
 * for every probe at once.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'People and leads the excerpt establishes.',
        properties: {
            people: {
                type: 'array',
                description: 'People the excerpt places somewhere — in the scene or elsewhere. Not people merely talked about.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'The person\'s name, or a short description if unnamed.' },
                        aka: {
                            type: 'string',
                            description: 'Every OTHER name or title for this same person, comma-separated. Empty if only ever called one thing. Never repeat the name itself.',
                        },
                        place: {
                            type: 'string',
                            description: 'The bare place name where they are now, worded as the narration words it: "the stableyard", "manor bedroom". No prepositions, no activity. Empty only if the excerpt truly does not say.',
                        },
                        detail: {
                            type: 'string',
                            description: 'What they are doing right now, as a short phrase: "sparring with Marote". NOT where they are (that is "place").',
                        },
                        reach: {
                            type: 'string',
                            description: 'How the point-of-view character can contact them at a distance: "phone number", "reachable by email". A standing capability, never an item.',
                        },
                        feels: {
                            type: 'string',
                            enum: ['hostile', 'wary', 'neutral', 'friendly', 'devoted', ''],
                            description: 'How they currently regard the point-of-view character, from how they act. Empty if no sign. Change only when the narration gives a reason.',
                        },
                        wants: {
                            type: 'string',
                            description: 'What they are trying to get, as a short phrase: "supplies for the northern march". Their goal, not the player\'s. Empty if no agenda is revealed.',
                        },
                        knows: {
                            type: 'string',
                            description: 'What they know about the point-of-view character that matters: a secret, a debt, a suspicion. Empty if nothing.',
                        },
                        status: {
                            type: 'string',
                            enum: ['present', 'remote', 'unreachable', 'gone'],
                            description: 'present if in the scene, remote if contactable at a distance, unreachable if not, gone ONLY if they left the story for good. Someone who walked into another room is still present.',
                        },
                        threat: {
                            type: 'integer',
                            description: `How dangerous RIGHT NOW, 1 to ${MAX_THREAT}, while actively hostile. 0 for anyone who is not currently a threat (nearly everyone), and 0 again the moment a fight ends.`,
                        },
                        facts: {
                            type: 'string',
                            description: 'Standing truths that do not change with the scene — a rank, a bloodline: "E-rank hunter". Never mood, location or activity.',
                        },
                    },
                    required: ['name', 'aka', 'place', 'detail', 'reach', 'feels', 'wants', 'knows', 'status', 'threat', 'facts'],
                    additionalProperties: false,
                },
            },
            // ── Coverage, not a substring proxy ([ROUTER]) ──
            //
            // The mention gate used to decide "did the window mention this person?" by token-matching
            // the window text, which fails on paraphrase and on any language fold did not spell out.
            // The model already READ the window; it is the authority on what it names. `mentions`
            // is that reading, returned structurally — the names the new excerpt actually uses — and
            // fold admits a proposal only when its name is in this set. Admission by coverage.
            mentions: {
                type: 'array',
                description: 'Every name or title the NEW excerpt actually uses for a person, exactly as written — "the woman", "the widow", "Vesk", "Sol". One entry per distinct name, including the aliases. This is what proves the excerpt was about someone; a name absent here was not in the excerpt.',
                items: { type: 'string' },
            },
        },
        required: ['people', 'mentions'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the entity probe.
 *
 * `leads` left this probe in Phase B. A lead was only ever a thread nobody could measure, and it
 * now shares a table — and a probe fragment — with clocks and progress tracks, because the live
 * chat carried one stake as a lead AND as a clock and neither could close (FOLD-REDESIGN.md §4).
 * See `clocks.js` `schema()`.
 *
 * @returns {string} Prompt guidance for the probe.
 */
export function instruction() {
    return [
        'The people the excerpt places somewhere, as objects rather than a list of phrases.',
        'One person, one entry: name in "name", the bare place name in "place" (worded exactly as the narration words it — a differently-worded place makes a person vanish from the room), what they are doing in "detail", how to contact them in "reach".',
        'Give "feels" (how they regard the point-of-view character), "wants" (their own agenda), "knows" (what they know about him that matters). These drive behaviour and are worth more than any description of their clothes.',
        'A character called by a title and a name — "the Hero" and "Solomon" — is ONE person: proper name in "name", every other form in "aka".',
        'Put EVERY name this excerpt actually uses for them in "aka", exactly as written — "the woman", "the widow", "Elin\'s mother" — because an alias is how the reader proves the excerpt was about them. A person whose spoken name is "the woman" and whose stored name is "the widow" is not mentioned unless the alias carries it.',
        'Give "place" for anyone whose position the excerpt establishes; if they walked out, give the place they walked TO. Do not mark them "gone" unless they left the story for good.',
        'Give "reach" whenever the excerpt establishes a way to contact someone — a number exchanged, an address. Contact details are never items.',
        'Give "threat" only while someone is actively dangerous, and set it back to 0 the moment they stop being — defeated, fled, calmed down. Everyone else is 0.',
        'Report ONLY people the NEW excerpt names or places — never someone merely carried over from the already-recorded block. A person the new text does not name is not reported, whatever the record shows. Use an empty array when the new excerpt establishes nobody.',
        'List EVERY name the NEW excerpt actually uses for anyone — including people you do not otherwise report — in "mentions", exactly as written: "the woman", "Vesk", "Gorak". A name the excerpt does not contain is never listed. This is the coverage proof: only a name in "mentions" may be changed.',
    ].join(' ');
}

/**
 * Apply a probe fragment.
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {string} [context.windowText] Narrative window, for the mention gate.
 * @returns {{people: number, rejected: object[]}} What was applied.
 */
export function applyExtraction(fragment, { windowText = '', turn: at = turn(), sources = [] } = {}) {
    const table = load();

    // The anchor mid of this pass, stamped onto every relationship change the fold records
    // (`entity-table.js` `changesBetween`). Newest live source, the same anchor the review's closure
    // events use, so a trail entry and a closure written by one pass point at one message.
    const mid = sources[sources.length - 1]?.mid;

    // ── Coverage by the model's own report, never a substring proxy ([ROUTER]) ──
    //
    // The model read the window; `mentions` is its structural answer for what the new excerpt
    // actually names. Fold admits a proposal only when its name (or an alias) is in that set. The
    // mention gate that used to token-match the window text — failing on paraphrase and on any
    // language fold did not spell out — is replaced by membership in this report. The report is
    // also persisted, so the NEXT pass's review hot set and presence questions read it instead of
    // token-matching the window themselves.
    //
    // Members are normalized through the same `normalizeEntityName` the alias keys use, so a
    // report of "the hooded figure" matches the alias key "hooded figure" — the article mismatch
    // that otherwise splits one person into two.
    const mentioned = new Set((fragment?.mentions ?? [])
        .map(name => normalizeEntityName(String(name ?? ''))?.key)
        .filter(Boolean));
    noteCoverage('cast', mentioned);

    // ── Re-promotion by coverage: a cold person the report names comes home ──
    //
    // Same rule as the thread table (clocks.js): a person archived by staleness is written back the
    // moment the window mentions them — a WRITE into the tracked state, never a paste
    // ([AC-PRODUCT]), admitted by coverage, not a confidence score ([ROUTER]). The coverage is the
    // model's own `mentions` report, not a substring test of the window.
    const restored = cold.covered(mentioned, cold.ofKind('person'));
    for (const item of restored) {
        if (cold.promote('person', item.key, item.row, table, at)) {
            observe.note('cast:recalled');
        }
    }

    const people = foldEntities(
        table,
        (fragment?.people ?? []).map(entry => ({ ...entry, kind: PERSON })),
        { windowText, turn: at, mid, mentioned });

    // ── Stale entities demote, they do not vanish ──
    //
    // `prune` returns the rows it shed; each is archived to the cold store whole, so a person or
    // lead the story has outrun is preserved for recall rather than destroyed (cold-store.js,
    // [EVICT]: selection cannot bound a store, so eviction is demotion).
    const shed = prune(table, at);
    for (const dropped of shed) {
        const kind = splitEntityKey(dropped.key).kind === PERSON ? 'person' : 'thread';
        cold.demote({ kind, key: dropped.key, row: dropped.row, at });
        observe.noteCap(kind === 'person' ? 'cast-archived' : 'threads-archived');
    }
    commit(ENTITIES_PATH, table);

    // Route this probe's refusals into the shared rejections sink like every other probe's —
    // `unknown-owner` etc. were previously returned and never observed, invisible in both the
    // tally and the diagnostics log. Anchor them to the pass's newest source.
    observe.noteRejections(people.rejected.map(rejection => ({
        ...rejection,
        mid: sources[sources.length - 1]?.mid,
        turn: at,
    })));

    return { people: people.accepted, rejected: people.rejected };
}

/**
 * Cast rows whose names raise the identity question.
 *
 * Data only, in this phase: the pairs are computed and handed to whoever asks, and nothing merges
 * anything. `person␀broker` and `person␀scarred broker` are one man behind one counter and became
 * two rows in a live chat within 48 hours of being hand-fixed (FOLD-REDESIGN.md §0.1); the merge
 * itself waits for the review pass, because "one name containing another is not identity"
 * (`FOLD-RPG-GAP.md` §4) and a wrong merge cannot be undone by silence.
 *
 * @returns {Array<{a: string, b: string, why: string}>} Pairs, by table key.
 */
export function questions() {
    return identityPairs(table_entries(load())
        .filter(([key]) => splitEntityKey(key).kind === PERSON)
        .map(([key, row]) => ({ key, name: row?.name ?? '' })));
}

/**
 * Drop entities nothing has mentioned for long enough that they will never render again.
 *
 * Soft-hiding is the right default while an entity might come back — `entitiesOfKind` already stops
 * rendering at ENTITY_STALE — but a table that only ever grows eventually dominates the metadata
 * blob. Deletion is at double the hide threshold, so anything the panel could still show survives.
 *
 * @param {Map<string, object>} table Entity table, mutated.
 * @param {number} at Current turn.
 */
function prune(table, at) {
    const dropped = [];
    let legacy = 0;
    for (const [key, value] of table_entries(table)) {
        if (at - (value?.turn ?? 0) > ENTITY_STALE * 2) {
            dropped.push({ key, row: value });
            table.delete(key);
            continue;
        }
        // ── One-time heal for leads written before the exposition gate existed ──
        //
        // Asked for "information worth acting on", extraction returned lore: what a holy mark
        // grants, what a brand permits, what someone was told to do and then did. All true, none of
        // them threads. Those chats still hold them.
        //
        // The test is exact rather than heuristic. `foldEntities` now rejects any lead with an
        // empty `open`, so every lead written since carries a non-empty one; a lead without it can
        // only predate the gate. Done here rather than in `entitiesOfKind` deliberately — filtering
        // on read would re-judge records that already passed the gate, so a genuine lead whose
        // `open` the model happened to omit would vanish on every repaint with no way back.
        if (splitEntityKey(key).kind === LEAD && !value?.open) {
            dropped.push({ key, row: value });
            table.delete(key);
            legacy++;
        }
    }
    if (legacy) {
        observe.noteCap('leads-ungated', legacy);
    }
    // ENTITY_STALE decides who the panel forgets. Counted, so the number can be judged.
    if (dropped.length) {
        observe.noteCap('entities-pruned', dropped.length);
    }
    // The rows that lost their slots are RETURNED, not lost: the caller demotes them to the cold
    // store, so a person the story left behind is still there to be recalled the moment they return
    // (cold-store.js, [EVICT]).
    return dropped;
}

/**
 * Render entities into the injected block.
 * @returns {string} Lines, or ''.
 */
export function render({ exclude = '', at = '', marks = null } = {}) {
    return renderEntities(load(), turn(), {
        exclude,
        at,
        hurt: marks ? name => markPhrases(marks, name) : null,
    });
}

/**
 * Marks parked on cast rows by the migration, as seeds for the fold.
 *
 * The only reader of `row.marks`, and `migrate.js` is the only writer — see `state-table.js`
 * `seedMarks` for why a mark that predates the ledger cannot be an event. Live marks never come
 * from here.
 *
 * @returns {object[]} Seed marks, each carrying the owner's name.
 */
export function markSeeds() {
    const out = [];
    for (const [, row] of table_entries(load())) {
        for (const mark of Array.isArray(row?.marks) ? row.marks : []) {
            out.push({ ...mark, who: mark?.who ?? row?.name ?? '' });
        }
    }
    // The other half: marks a migration had nowhere to put, because the chat has body-state prose
    // and no cast row for whoever it is about. Raccoon City is the measured case — `health:
    // "hangover faded; mild fatigue"` with an empty entity table, since extraction never ran there
    // (`migrate.js` `migrateBody`). They carry `who: ''`, which the fold reads as the pov's.
    for (const mark of loadValue('state.migrated', null)?.marks ?? []) {
        out.push({ ...mark, who: mark?.who ?? '' });
    }
    return out;
}

/**
 * Set or clear a cast row's threat integer.
 *
 * Written whole rather than merged, because 0 is falsy and `merge_entity` reads a falsy field as
 * silence — which is right for an ordinary sighting that simply does not mention danger, and wrong
 * for the review saying a fight is over. `FOLD-REDESIGN.md` §3: an adversary's row is closed by the
 * review, and this is where that lands.
 *
 * @param {string} key The cast row's table key.
 * @param {number} threat The new value; 0 clears it.
 * @param {number} [at] Turn counter.
 * @returns {boolean} True if anything changed.
 */
export function setThreat(key, threat, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    if (!row) {
        return false;
    }
    const value = threatOf(threat);
    if ((row.threat ?? 0) === value) {
        return false;
    }
    table.set(key, { ...row, threat: value, turn: at });
    commit(ENTITIES_PATH, table);
    return true;
}

/**
 * Cast rows that are currently a threat, for the review to close.
 * @returns {Array<{key: string, name: string, threat: number}>} Active adversaries.
 */
export function threats() {
    return table_entries(load())
        .filter(([key, row]) => splitEntityKey(key).kind === PERSON && (row?.threat ?? 0) > 0)
        .map(([key, row]) => ({ key, name: row?.name ?? key, threat: row.threat }));
}

/**
 * Everything the panel needs.
 * @returns {{people: object[], unplaced: object[], elsewhere: object[]}} The lists, freshest first.
 */
export function snapshot({ at = '', pov = '' } = {}) {
    const table = load();
    const now = turn();
    const cast = castAt(table, now, at);
    // Resolved here rather than in the panel, so the panel never has to know that a name and a
    // title can be the same person.
    const self = resolveEntity(table, PERSON, pov)?.key ?? '';
    const notSelf = person => !self || person.key !== self;
    return {
        povKey: self,
        // The current tick, so the panel can tell a change from a restatement.
        turn: now,
        // Split rather than filtered. The people who have walked out are still known, still worth
        // showing, and still where the story left them — they are simply not in the room. Deleting
        // them would lose the one thing that makes a returning character feel remembered.
        people: cast.here.filter(notSelf),
        // Kept as its own list all the way to the renderer. The panel shows them inside Here,
        // dimmed and marked "whereabouts unstated", because merging them into `people` here would
        // be the same collapse `castAt` used to perform one layer down (FOLD-REDESIGN.md §0.1-1).
        unplaced: cast.unplaced.filter(notSelf),
        elsewhere: cast.elsewhere.filter(notSelf),
    };
}

/**
 * Merge two cast rows the review confirmed are one person.
 *
 * The rule and its argument live in `entity-table.js` `mergeEntities`; this is the storage half.
 * Kang existed twice for the whole of the live Solo Leveling chat and could not stop
 * (`FOLD-RPG-GAP.md` §2), and the broker pair reopened within 48 hours of being hand-fixed — both
 * are one confirmed answer away from being one row, and this is where that answer lands.
 *
 * @param {string} a One table key.
 * @param {string} b Another.
 * @returns {{key: string, dropped: string}|null} What survived, or null if nothing merged.
 */
export function merge(a, b) {
    const table = load();
    const done = mergeEntities(table, a, b);
    if (done) {
        commit(ENTITIES_PATH, table);
    }
    return done;
}

/**
 * Record where an unplaced person actually is.
 *
 * The other half of the three-valued `castAt` (`entity-table.js`): the derivation keeps UNPLACED as
 * a distinct answer all the way to the consumers, the renderers hedge it, and the review resolves
 * it. A place written here is a place the presence predicate can compare, which is the whole reason
 * `place` is its own field rather than prose.
 *
 * @param {string} key The cast row's table key.
 * @param {string} place The place, as the story words it.
 * @param {number} [at] Turn counter.
 * @returns {boolean} True if it was written.
 */
export function setPlace(key, place, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const said = String(place ?? '').trim();
    if (!row || !said) {
        return false;
    }
    // Through `foldEntity` rather than by assignment, so the write is versioned and merges with a
    // concurrent sighting the way any other observation would. A bare assignment would be the one
    // write in this table that `resolution_max_converges` does not cover.
    return !!foldEntity(table, { ...row, place: said, turn: at }) && (commit(ENTITIES_PATH, table), true);
}

/** Forget everything. */
export function clear() {
    commit(ENTITIES_PATH, new Map());
}
