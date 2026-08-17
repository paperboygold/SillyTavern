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
    ACTOR_KINDS,
    DISPOSITIONS,
    ENTITY_STALE,
    FACTION,
    LEAD,
    MAX_DRIVE,
    MAX_THREAT,
    PERSON,
    actorKind,
    castAt,
    foldEntities,
    foldEntity,
    mergeEntities,
    normalizeEntityName,
    renderEntities,
    contestedAliases,
    dispositionRank,
    resolveEntity,
    splitEntityKey,
    threatOf,
} from './entity-table.js';
// The join between the cast table and the marks table happens here and only here: `state-table.js`
// imports `entity-table.js` (to normalise owner names), so the reverse import would be a cycle, and
// this file already depends on both halves.
import { itemPhrases, markPhrases } from './state-table.js';
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
                        // ── An organisation that acts is an actor, and had no way to say so ──
                        //
                        // fold has held a `faction` kind for as long as it has held `person`, and
                        // nothing ever wrote one because this field did not exist and the fold
                        // hardcoded `person` on the way in. Measured in a completed Xianxia
                        // campaign: 26 cast rows, all `person`, while three trading houses and a
                        // cultivator alliance ran the entire mid-game economy — present in the
                        // record only as substrings inside some shopkeeper's `wants`.
                        //
                        // An enum, because the alternative is fold deciding "万通商行 sounds like a
                        // company", which is a judgement about a name in one language. The model
                        // classifies; `actorKind` checks the answer is a vocabulary member.
                        // No empty member: Google's schema converter rejects one outright
                        // (`src/prompt-converters.js` `toGeminiSchema`), and there is no third
                        // answer worth having — an unsure model should say `person`.
                        kind: {
                            type: 'string',
                            enum: [PERSON, FACTION],
                            description: `"${FACTION}" for a group that acts as one — a guild, sect, company, crew, house, agency. "${PERSON}" for an individual, including a creature or a named beast. When unsure, say "${PERSON}".`,
                        },
                        aka: {
                            type: 'string',
                            // ── This asked about the EXCERPT, and the excerpt is the wrong scope ──
                            //
                            // Cast aliasing's commonest shape by far is a person described before
                            // they are named: "the tiefling fighter" for ten turns, then "Kaelira".
                            // The two share no tokens, so `nearIdentity` is structurally blind to
                            // the pair and can never raise it — verified against the shipped
                            // detector on all three pairs in a live chat.
                            //
                            // The model was not blind. Measured on that chat's trace: at mid 0 it
                            // reported `tiefling fighter` with `aka: "the fighter, the tiefling,
                            // the first woman"` — using this field exactly as written. At mid 4 it
                            // reported `Kaelira` with `aka: ""`, while the pinned People list in
                            // that same prompt still read "tiefling fighter (…)". It answered the
                            // question asked: within that excerpt she IS only called one thing.
                            // The result was three people stored twice, 55 people reported across
                            // 19 passes and 3 non-empty `aka` values, all from the first pass.
                            //
                            // So the field now points at fold's own list, the way the delta
                            // schema's `same_as` points at the State block. That is the difference
                            // between "what else did this excerpt call her" and "who is this, of
                            // the people you already hold" — and only the second one merges.
                            description: 'Other names for this same person, comma-separated. TWO kinds, and the second matters most: (1) other names or titles the excerpt itself uses; (2) the EXACT name this person is listed under in the people list above, when the excerpt has revealed who a previously-described person is — a name learned for someone recorded only by description ("the tall guard" turning out to be "Marek") goes here as "the tall guard". Empty only when neither applies. Never repeat the name itself.',
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
                        // ── The agenda's LENGTH, asked once, so it can have a position at all ──
                        //
                        // `wants` says what they are after and is overwritten every sighting;
                        // this says how many steps it takes, and once it is non-zero the actor
                        // appears on the off-screen turn's list and can advance while the camera is
                        // elsewhere. 0 for the overwhelming majority — a shopkeeper minding a
                        // counter is not pursuing anything the story will track across a campaign.
                        //
                        // Asked here rather than on the world probe because this is a fact about
                        // WHO SOMEBODY IS, established when they are first understood to have an
                        // ambition. The world probe only moves the position; it never invents the
                        // agenda, the same division the delta schema keeps between establishing a
                        // gauge's ceiling and moving its current value.
                        drive_size: {
                            type: 'integer',
                            description: `How many steps their standing ambition takes to achieve, 2 to ${MAX_DRIVE}. 0 for anyone with no long-running ambition — most people, and every shopkeeper, guard and passer-by. Set this only for an actor whose goal the story will follow across scenes: a rival cultivator seeking a breakthrough, a trading house cornering a market, a sect pressing a claim. Send the same number every time once set.`,
                        },
                        threat: {
                            type: 'integer',
                            description: `How dangerous RIGHT NOW, 1 to ${MAX_THREAT}, while actively hostile. 0 for anyone who is not currently a threat (nearly everyone), and 0 again the moment a fight ends.`,
                        },
                        facts: {
                            type: 'string',
                            // ── Appearance lives here, and it was never asked for ──
                            //
                            // The field's own worked example has always been `facts: "burly dwarf,
                            // singed apron"` — half of which is a physical description — but the
                            // instruction only named a rank and a bloodline, so models recorded
                            // ranks and bloodlines. The consequence is the one the owner reports:
                            // the narrator forgets what people look like and re-invents them,
                            // because nothing in the record ever said.
                            //
                            // `facts` is the right home rather than a new field: it is already
                            // rendered on every present cast line (`renderEntities`), already
                            // merged field-wise so a turn that says only where someone is standing
                            // cannot erase it, and already bounded. Appearance is exactly what the
                            // field means — a standing truth that does not change with the scene.
                            description: 'Standing truths that do not change with the scene. Include what they LOOK like the first time they are described — build, hair, face, dress, anything that would let someone pick them out of a crowd — and any rank, role or bloodline: "shaved head, broad through the chest, second-year". A few words each, not a paragraph. Never mood, location or activity.',
                        },
                    },
                    required: ['name', 'kind', 'aka', 'place', 'detail', 'reach', 'feels', 'wants', 'knows', 'status', 'drive_size', 'threat', 'facts'],
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

    // `kind` LAST and resolved, not spread-over. This line used to end `{ ...entry, kind: PERSON }`,
    // which overwrote whatever the probe answered — so the faction kind, complete on the read side
    // since it was declared, could never be written. `actorKind` checks the answer against
    // `ACTOR_KINDS` and falls back to `PERSON`, so a mis-tagged actor is still an actor.
    const people = foldEntities(
        table,
        (fragment?.people ?? []).map(entry => ({
            ...entry,
            kind: actorKind(entry?.kind),
            // `drive_size` on the wire, `driveSize` on the row. Only threaded when the probe sent a
            // usable number, so `foldEntity` can omit the field and a quiet sighting stays quiet.
            ...(Number.isFinite(entry?.drive_size) ? { driveSize: entry.drive_size } : {}),
        })),
        { windowText, turn: at, mid, mentioned });

    // ── Stale entities demote, they do not vanish ──
    //
    // `prune` returns the rows it shed; each is archived to the cold store whole, so a person or
    // lead the story has outrun is preserved for recall rather than destroyed (cold-store.js,
    // [EVICT]: selection cannot bound a store, so eviction is demotion).
    const shed = prune(table, at);
    for (const dropped of shed) {
        // Any ACTOR kind archives to the cast bucket, not just `person`. Keyed off `ACTOR_KINDS`
        // rather than a PERSON comparison, or a shed faction would be filed away as a thread.
        const kind = ACTOR_KINDS.includes(splitEntityKey(dropped.key).kind) ? 'person' : 'thread';
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
    const table = load();
    const people = table_entries(table).filter(([key]) => splitEntityKey(key).kind === PERSON);
    const pairs = identityPairs(people.map(([key, row]) => ({ key, name: row?.name ?? '' })));

    // ── A contested alias is a stronger signal than a token subset, and it was invisible ──
    //
    // `identityPairs` compares NAMES by token containment, so `broker` ⊂ `scarred broker` raises and
    // `Grimble` against `Armorer` never can. But those two both answer to "the dwarf" — the model
    // itself put the word on both rows — and `canonicalKey` now refuses to resolve it either way
    // rather than coin-flip. Refusing silently would leave the ambiguity standing forever, so the
    // pair is asked. Measured: three such collisions across the live chats, none of which any
    // name-based test could ever have raised.
    const seen = new Set(pairs.map(pair => `${pair.a}${pair.b}`));
    for (const [alias, keys] of contestedAliases(table, PERSON)) {
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                const [a, b] = [keys[i], keys[j]].sort();
                if (seen.has(`${a}${b}`)) continue;
                seen.add(`${a}${b}`);
                pairs.push({ a, b, why: `both answer to "${alias}"` });
            }
        }
    }
    return pairs;
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
export function render({ exclude = '', at = '', marks = null, inv = null } = {}) {
    return renderEntities(load(), turn(), {
        exclude,
        at,
        hurt: marks ? name => markPhrases(marks, name) : null,
        holds: inv ? name => itemPhrases(inv, name) : null,
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
 * Advance an actor's standing agenda, because time passed and somebody used it.
 *
 * Writes the whole record for `setThreat`'s reason: `drive` is a number, and `merge_entity` treats
 * only `''`/null/undefined as silence, so a field-wise write of `0` would be indistinguishable from
 * a sighting that said nothing about it. The full write also stamps `turn`, which is what
 * `worldAsks` orders its queue by — an agenda that just moved goes to the back.
 *
 * Clamped at the size: a drive stops at full and does not wrap. What a FULL drive means is the
 * caller's business — `world.js` records it as an event the narrator has to reckon with — because
 * "the guild finished what it was doing" is a story beat, not a table operation.
 *
 * @param {string} key The cast row's key.
 * @param {number} steps How far to advance. Clamped to the row's remaining room.
 * @param {number} [at] The turn.
 * @returns {{filled: number, size: number, full: boolean}|null} The new position, or null if the
 *   row is missing, has no agenda, or did not move.
 */
export function advanceDrive(key, steps, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const size = Number(row?.driveSize) || 0;
    const move = Math.trunc(Number(steps) || 0);
    if (!row || size <= 0 || move <= 0) {
        return null;
    }
    const before = Math.max(0, Number(row.drive) || 0);
    const filled = Math.min(size, before + move);
    if (filled === before) {
        return null;
    }
    table.set(key, { ...row, drive: filled, turn: at });
    commit(ENTITIES_PATH, table);
    return { filled, size, full: filled >= size };
}

/**
 * Move somebody's disposition by one step, because of something that just happened.
 *
 * ── A social cost has to land on the person, or it did not happen ──
 *
 * A verdict against a named person could already cost "someone's trust" — in the directive, as
 * prose, for the narrator to write and the next extraction to maybe re-read. That is a cost that
 * evaporates: after twenty verdicts the trust-dings are wallpaper, and nothing in the record ever
 * moved, so the next verdict against the same person starts from the same disposition as the first.
 *
 * Stepping the scale here makes it stick. It is one step, never more, and it is arithmetic over
 * `DISPOSITIONS` — fold's own enum, an index moved by one — so nothing here reads narrative text.
 * WHY it moved is prose and stays the model's job: the trail carries the cause the entity probe
 * records on the next pass.
 *
 * Clamped at both ends: a hostile person cannot become more hostile through a scale that has no
 * word for it, and the ceiling is `devoted`.
 *
 * @param {string} key The cast row's key.
 * @param {number} steps How far to move, positive or negative. Rounded and clamped to ±1.
 * @param {number} [at] The turn.
 * @returns {string} The new disposition, or '' when nothing moved.
 */
export function stepFeels(key, steps, at = turn()) {
    const table = load();
    const row = lookup(table, key, null);
    const move = Math.sign(Number(steps) || 0);
    if (!row || !move || !row.feels) {
        return '';
    }
    const next = DISPOSITIONS[Math.max(0, Math.min(DISPOSITIONS.length - 1, dispositionRank(row.feels) + move))];
    if (next === row.feels) {
        return '';
    }
    table.set(key, { ...row, feels: next, turn: at });
    commit(ENTITIES_PATH, table);
    return next;
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
