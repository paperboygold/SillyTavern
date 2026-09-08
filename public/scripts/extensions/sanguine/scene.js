/**
 * fold/scene.js: the scene and its protagonist, read from the narrative rather than from a block.
 *
 * Why this file exists.
 *
 * Every scene field fold knew about arrived one way: a card wrote a status block, `absorb.js`
 * parsed it, `state.setContext` stored it. That works beautifully for cards built to emit one and
 * produces literally nothing for every other card. A chat ran thirty-eight turns with a location,
 * a time of day, a named protagonist and an injured shin in plain view of the model, and the panel
 * showed none of them, because no line in the transcript started with "Location:".
 *
 * The narrative always contained the answer. Nothing was ever asked.
 *
 * So this is the same information from a second source. It is not as good, a block is the
 * narrator asserting the scene in its own words, this is fold inferring it, and the table records
 * which is which rather than pretending they are equivalent. `merge_context` ranks them: a card
 * that restates its block every turn is never overridden, and one that has gone quiet for longer
 * than the clock's staleness window gives way to what the prose actually says.
 *
 * The protagonist.
 *
 * Fold had no notion of whose story this is, which is why the point-of-view character was listed
 * under People as though he were a bystander in his own scene.
 *
 * `name1`/`name2` cannot settle it. The common setup has the card as the co-star and the persona as
 * the protagonist; the setup that exposed this had the card *as* the protagonist, with the model
 * narrating everyone else. Both are ordinary, and the difference is invisible from the metadata,
 * it lives in how the prose is written. The extraction model is already reading that prose, so it
 * is asked, and the answer goes through the same field lock as everything else: get it wrong once
 * and `/fold-lock pov` settles it permanently.
 *
 * The place record's producer lives here, because this is where the answer already was.
 *
 * `place-table.js` and `places.js` are a full place record, containment, standing facts, current
 * detail, a destruction cascade, a trail, and `state.places` was length 0 in all 22 chats on disk.
 * The record had exactly one writer, hand entry in the Assets tab, and nobody hand-enters a house.
 *
 * The information was never missing. This probe answered `location` on 2064 of 2164 passes in the
 * trace archive, and 463 of the 964 distinct strings it produced (48%) encode a containment in
 * prose: "RPD break room", "Nine-Tails Inn, common room", "ramyeon shop in Sanggye-dong",
 * "Association clinic, Room 3". The hierarchy was worked out every pass and flattened into a display
 * string every pass. So the same reading is asked for in parts as well, `place_name`,
 * `place_within`, `place_facts`, `place_detail`: and the parts become rows.
 *
 * `location` is untouched by all of it. It is what the panel header and `presenceOf` read, both were
 * repaired recently against its exact current behaviour, and a display string and a record key want
 * different things from the same sentence. Asking twice is cheaper than making one field serve both.
 */

import { NARRATIVE, loadClock, noteSceneElapsed, recordMarks, setContext } from './state.js';
import { setChoices } from './choices.js';
import { formatClock } from './clock.js';
import { MAX_MARKS, SEVERITIES } from './state-table.js';
import { MAX_DETAIL } from './entity-table.js';
// No cycle: `places.js` reaches entities, the entity/place tables, the cold store, `observe` and
// `store`: and none of those, at any depth, reaches back here. `index.js` is the only importer of
// this file. The edge is also already implied, since `state.js` (imported above) imports `places.js`.
import * as places from './places.js';

/**
 * A finite integer from the model, or NaN for anything else. The schema constrains these fields to
 * integers (and -1 for "no clock"), so this only guards against a non-compliant answer.
 * @param {any} value A proposed integer.
 * @returns {number} The value, or NaN when it is not a finite number.
 */
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * Fields this probe can establish. Deliberately the ones a scene has, not everything a card writes.
 *
 * `conditions` left this list in Phase D, and the reason is a measurement.
 *
 * It used to sit here and be written into scene context like a location, so the panel rendered it
 * inside the scene header joined to the weather (`panel.js`, `[conditions, weather].join('; ')`),
 * which is how *"Bandaged calf"* came to read as a property of the Goblin Market
 * (`FOLD-REDESIGN.md` §0, §3). A body is not a place. The probe still answers the question; the
 * answer now becomes marks on the point-of-view character's row, and the header shows where, when
 * and what the weather is doing, and nothing about anybody's body.
 */
const FIELDS = ['location', 'time', 'date', 'weather'];

/**
 * The schema fragment for the scene probe.
 *
 * Every property is required and `additionalProperties` is false, because OpenAI's strict mode
 * demands both on every object in the shared schema and one omission fails every probe at once.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'The present scene, as the narration establishes it.',
        properties: {
            pov: {
                type: 'string',
                description: 'The character whose point of view the story is told from, the one the reader is meant to be. Same name as in the people list. Empty if the narration does not settle on one.',
            },
            location: {
                type: 'string',
                description: 'Where the scene is happening right now: "the stableyard", "Paulette\'s inn, upstairs". Empty if the excerpt does not say. The place as the STORY names it, if the text shows a name followed by a parenthesized translation, pinyin or gloss ("浣熊市警察局 (Raccoon City Police Department)"), report only the name the story itself uses, never the gloss.',
            },
            // The same answer again, in parts, because the parts are a record and the string is not.
            //
            // `location` is one line of display prose and stays exactly that: it is what the panel
            // header and `presenceOf` read, and both were repaired against its current behaviour.
            // What it cannot be is a place. Measured over the whole trace archive, 2064 passes with
            // a location, 964 distinct strings, 463 of them (48%) encode a containment in prose:
            // "RPD break room", "Nine-Tails Inn, common room", "ramyeon shop in Sanggye-dong",
            // "Association clinic, Room 3", "Ground Beta, south building, third floor". Every one of
            // those is a hierarchy the model had already worked out and had nowhere to put, so it
            // was flattened into a string and thrown away, and `state.places` stayed empty in all 22
            // chats on disk.
            //
            // These four fields are that same reading, kept. `place_name` and `place_within` become
            // two rows and a parent link (`places.upsert`); `place_facts` and `place_detail` become
            // the record's two prose columns, split the way `entity-table.js` splits a person's
            // permanent facts from what is true of them now, and for the same reason, that one
            // field asked for two kinds of thing ends up answering for neither.
            place_name: {
                type: 'string',
                description: 'The INNERMOST place the scene is in, bare and worded as the story words it: "break room", "upstairs", "the stableyard". Just that place, never the compound "RPD break room", never "Paulette\'s inn, upstairs". A scene is always somewhere: answer this whenever "location" is answered.',
            },
            place_within: {
                type: 'string',
                description: 'The place that CONTAINS "place_name", bare: "RPD", "Paulette\'s inn", "Thornwood compound". Report it whenever the excerpt puts the room inside a building, the building inside a district, the deck inside a ship, this is what lets a house be described room by room. A place named after its owner is ONE place, not a room inside a person: "Paulette\'s inn" and "Gorak\'s office" are names, so never answer "Paulette" or "Gorak" here. Empty when the excerpt establishes no container, a guessed one is worse than none.',
            },
            place_facts: {
                type: 'string',
                description: `Standing truths about "place_name" that do not change from scene to scene: "concrete stairwell, no windows, one steel door", "two storeys, north-facing, always cold". What would still be true next week. Give this the first time the excerpt describes the place and whenever it adds to or contradicts what is already recorded; otherwise empty. A few words, at most ${MAX_DETAIL} characters. Never what is happening there, never who is there.`,
            },
            place_detail: {
                type: 'string',
                description: `What is true of "place_name" RIGHT NOW and was not always: "barricaded with a filing cabinet, lights flickering", "the east wing is rubble". The state the story has put it in, which the next scene may change. Empty when nothing has changed about the place itself. At most ${MAX_DETAIL} characters.`,
            },
            time: {
                type: 'string',
                description: 'The time of day, as written: "just after dawn", "3:15 PM". Empty if not stated or implied.',
            },
            date: {
                type: 'string',
                description: 'The date or day of the week, as written: "Wednesday", "the 3rd of autumn", "mid-October". Only when the narrative names a day that differs from the last scene\'s. Empty otherwise.',
            },
            elapsed_days: {
                type: 'integer',
                description: 'How many WHOLE days passed since the last scene: "a week" is 7, "overnight" and "come morning" are 1, "three hours" is 0. Time is continuous, so count the passage the narrative implies even when it writes no duration, only a truly frozen moment (an instant, a time-stop) is 0.',
            },
            elapsed_minutes: {
                type: 'integer',
                description: 'How many MINUTES beyond whole days passed since the last scene: "three hours" is 180, "half an hour" is 30, "a week" is 0. The narrative usually covers minutes: a single line of dialogue or one quick exchange is about 1, a fight or a longer conversation is several, a trek is hours. 0 only for a frozen instant or when only whole days passed.',
            },
            phase: {
                type: 'string',
                enum: ['', 'morning', 'afternoon', 'evening', 'night'],
                description: 'The part of a day the scene has moved TO, when the narrative used a transition marker: "come morning", "first light", "overnight" and "the early morning" are "morning"; "dusk" is "evening". Empty when the narrative names no part of a day.',
            },
            clock_hour: {
                type: 'integer',
                description: 'The hour the clock reads now, 0-23, as the narrative states it: "3:15 PM" is 15, "just after dawn" is 6. -1 when the narrative states no clock time.',
            },
            clock_minute: {
                type: 'integer',
                description: 'The minute the clock reads now, 0-59. -1 when the narrative states no clock time.',
            },
            date_changed: {
                type: 'boolean',
                description: 'True when the narrative names a new day that differs from the last scene\'s, "Wednesday" after "Tuesday", "the 3rd" after "the 2nd". This is what moves the calendar forward a full day when no duration or marker said so.',
            },
            weather: {
                type: 'string',
                description: 'Weather or ambient conditions, if established. Empty otherwise.',
            },
            conditions: {
                type: 'array',
                description: `What is physically wrong with the point-of-view character right now, injuries, exhaustion, pain. One entry per affliction, at most ${MAX_MARKS}, worst first. Empty if nothing is wrong.`,
                items: {
                    type: 'object',
                    properties: {
                        phrase: {
                            type: 'string',
                            description: 'The affliction as a short lowercase phrase: "bruised left arm", "exhausted". The affliction, never the reassurance, "bruised but functional" is ONE entry. Never report that they are fine.',
                        },
                        severity: {
                            type: 'string',
                            enum: SEVERITIES,
                            description: 'minor (stings), moderate (hinders), severe (could end the scene).',
                        },
                        turns: {
                            type: 'integer',
                            description: 'How many exchanges it lasts on its own, "rested for a couple of hours" has a few, a hangover a handful. 0 for a wound or anything that needs treatment or time, which stays until the story clears it.',
                        },
                    },
                    required: ['phrase', 'severity', 'turns'],
                    additionalProperties: false,
                },
            },
            choices: {
                type: 'array',
                description: '2-4 things the point-of-view character could plausibly do or say NEXT, short phrases in the story\'s voice, the kind of thing the player might pick or type. Not a recap of what already happened. Empty when nothing stands out.',
                items: { type: 'string' },
            },
        },
        required: ['pov', 'location', 'place_name', 'place_within', 'place_facts', 'place_detail', 'time', 'date', 'elapsed_days', 'elapsed_minutes', 'phase', 'clock_hour', 'clock_minute', 'date_changed', 'weather', 'conditions', 'choices'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the probe.
 *
 * The player's name is passed in when fold is running with a persona, and only then does the
 * `pov` guidance carry it. The probe must not be told the persona's name when there is none, a
 * fabricated "player" would bias `pov` toward a name the story never uses, but when there is one,
 * it is the single most reliable signal for who the narration follows, because the persona is
 * defined as the reader's character.
 *
 * @param {object} [options] Options.
 * @param {string} [options.player] The player character's name, from the persona.
 * @returns {string} Prompt guidance for the probe.
 */
export function instruction({ player = '' } = {}) {
    const pov = player
        ? `For "pov", name the character the narration follows, the one whose thoughts and sensations are described from the inside. The reader's character is "${player}"; when the excerpt follows the reader's character, report that name exactly.`
        : 'For "pov", name the character the narration follows, the one whose thoughts and sensations are described from the inside.';
    return [
        'The scene as it stands at the END of the excerpt, not as it was at the start.',
        'Only what the excerpt establishes. Leave a field empty rather than carrying one forward or guessing.',
        pov,
        // Worded against the two fields that measured 100% empty.
        //
        // `moves: []` came back on 107 of 107 passes and `drive_size: 0` on 288 of 288, both because
        // the schema made silence free. `place_name` is protected from that by being tied to a field
        // the model already answers on 95% of passes: it is not a new judgement, it is `location`
        // with the container taken off. `place_within` is stated as the thing the whole section is
        // for, with the one invention it invites, reading a possessive as a container, named and
        // refused, so "empty" stays cheap for the case that warrants it and only that case.
        'For "place_name", answer the place itself with nothing wrapped around it: when "location" is "RPD break room", "place_name" is "break room" and "place_within" is "RPD"; when it is "Nine-Tails Inn, common room", they are "common room" and "Nine-Tails Inn". When the location is already a bare place, repeat it in "place_name" and leave "place_within" empty.',
        'Answer "place_within" whenever the excerpt puts this place inside another one, a room in a building, a building in a compound, a hold in a ship. This is what lets a house be recorded room by room instead of as a dozen unrelated names. Leave it empty when the excerpt has not established a container; never infer one from a name, since "Paulette\'s inn" is a place called that and not a room inside Paulette.',
        'For "place_facts" and "place_detail", keep the standing truths apart from the current state: "concrete stairwell, no windows, one steel door" is what the place IS and belongs in "place_facts"; "barricaded with a filing cabinet, lights flickering" is what has been done to it and belongs in "place_detail". Give "place_facts" the first time the excerpt describes the place and whenever it adds to or contradicts what is recorded, in the narration\'s own voice; leaving it empty says nothing new was described, and what is already recorded stands.',
        'When a place is already listed in the State block, reuse its EXACT name in "place_name" or "place_within" rather than a new wording of it, a second spelling opens a second record for one room.',
        'For "elapsed_days" and "elapsed_minutes", say how much time the scene covered. Time is continuous: the excerpt is not a freeze-frame, so when it shows any action, dialogue or movement, some time has passed even if no duration is written. Scale it to what the scene actually spans: a single line of dialogue or one quick exchange is about a minute; a walk, a fight or a longer conversation is minutes; a trek or a vigil is hours. "a week" is 7 days, "overnight" and "come morning" are 1 day, "three hours" is 180 minutes. 0 only when the moment is truly frozen, an instant, a single beat, an explicit time-stop.',
        'For "phase", report the part of a day the scene moved TO when a transition marker names one, "come morning", "first light" and "overnight" land on "morning", "dusk" on "evening". Empty when the story names no part of a day.',
        'For "clock_hour" and "clock_minute", report the clock as the narrative reads it now when it states one, "3:15 PM" is hour 15 minute 15. -1 when the narrative states no clock time.',
        'For "date", name the day only when the narrative states a new one outright, "the next morning" belongs in "elapsed_days", a named day ("Wednesday", "the 3rd") belongs here, and "date_changed" is true then.',
        'For "date_changed", set it true exactly when the story names a day different from the last scene\'s, this is the one unambiguous signal a full day has passed even when no duration says so.',
        '"conditions" is about that character\'s body only: what hurts, what is exhausted, what is impaired. Not mood, not clothes, not weather.',
        'Report every affliction still true, not only the new ones, this list replaces what was recorded before it.',
        'For "turns", give a temporary condition how long it lasts in exchanges, a rest, a hangover, a short stun. 0 for anything that needs treatment or time, a wound, a poison, which stays until the story clears it.',
        'For "choices", suggest what the point-of-view character could plausibly do or say NEXT, 2-4 short phrases in the story\'s voice, the kind of thing the player might pick or type. Not a recap of what already happened. Empty when nothing stands out.',
    ].join(' ');
}

/**
 * The scene probe's PER-PASS state, kept out of `instruction()` so the instruction block can be
 * cached.
 *
 * The clock already on record, frame elapsed as ADVANCE beyond it, so a pass that re-reads
 * "the next morning" in context does not re-count the same night as a fresh day. Measured in
 * the Wuxia RP: one overnight sleep was reported as `elapsed_days: 1` on three consecutive
 * turns (17, 18, 19), rolling day 1 -> 2 -> 3 for a single night, because the model had no
 * anchor for "previous scene" other than the window's own phrasing.
 *
 * This clause used to live inside `instruction()`, where it was the ONLY thing that moved between
 * consecutive passes, and by moving it made the whole 2700-token instruction block differ every
 * pass, so 70% of consecutive passes shared no cacheable prefix at all (measured over 563 traces).
 * Same words, same position in the prompt relative to the data; only the side of the cache
 * breakpoint changed.
 *
 * @returns {string} The per-pass clock line, or empty when no clock is set.
 */
export function context() {
    const clockNow = loadClock();
    return Number.isFinite(clockNow?.minutes)
        ? `The clock already reads day ${clockNow.day} at ${formatClock(clockNow.minutes)}, count elapsed time BEYOND that, never the passage that is already on record.`
        : '';
}

/**
 * Apply a probe fragment.
 *
 * Empty strings are dropped rather than written. A model that does not know where the scene is says
 * so by leaving the field empty, and storing that would erase a location nothing in the story
 * retracted: the same asymmetry that makes a block evidence of what it states and not of what it
 * omits.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} [context] Context from the extraction pass.
 * @param {string} [context.windowText] The new half of the window.
 * @param {Array<{key: string, mid: number}>} [context.sources] Window sources, newest last.
 * @returns {{fields: number, marks: number, place: string}} How many fields were established, and
 *   the place key the pass landed on.
 */
export function applyExtraction(fragment, { windowText = '', sources = [] } = {}) {
    const context = new Map();

    for (const field of FIELDS) {
        const value = String(fragment?.[field] ?? '').replace(/\s+/g, ' ').trim();
        if (value) {
            context.set(field, value);
        }
    }

    const pov = String(fragment?.pov ?? '').replace(/\s+/g, ' ').trim();
    if (pov) {
        context.set('pov', pov);
    }

    if (context.size) {
        // The clock is advanced once, below, from the probe's `elapsed` AND `time` together
        // (`advanceSceneClock`). `setContext` must not fold `time` in again on the same pass, two
        // writers on one clock is exactly the defect that froze the face at 19:45 while the day
        // rolled. `skipClock` stores the display fields without touching the clock.
        setContext(context, { source: NARRATIVE, skipClock: true });
    }

    // The clock moves on the model's own reading.
    //
    // `elapsed_days`/`elapsed_minutes`/`phase` are the model's comprehension answers to "how much
    // time passed and what part of the day is it now", and `clock_hour`/`clock_minute` are the
    // clock as it reads. This is the structure the clock should have been reading all along: before
    // it, the clock parsed the narrator's phrasing out of free text with English regexes, and a
    // Korean or Chinese player's "come morning" never moved it. The model reads the prose already;
    // it is asked, not matched. Anchored to nothing (the arithmetic is fold's own, not an event),
    // so a swipe that removes the passage cannot be retracted by the ledger. That is deliberate:
    // time that passed stays passed, and the clock is a running position that only moves forward,
    // a swipe rewrites the future, not the past. Double-counting is prevented structurally by the
    // window gate in `extract.js`: a pass runs only on messages past the high-water mark, so the
    // same passage is never read twice.
    const elapsed = {
        days: num(fragment?.elapsed_days),
        minutes: num(fragment?.elapsed_minutes),
        phase: String(fragment?.phase ?? '').trim().toLowerCase(),
        clockHour: num(fragment?.clock_hour),
        clockMinute: num(fragment?.clock_minute),
        dateChanged: fragment?.date_changed === true,
        // The day the probe actually read, so a restatement of a day already on record cannot roll
        // the clock a second time (`clock.js` `advanceSceneClock`).
        date: String(fragment?.date ?? '').trim(),
    };
    if (elapsed.days || elapsed.minutes || elapsed.phase || elapsed.clockHour >= 0 || elapsed.dateChanged) {
        try {
            const outcome = noteSceneElapsed(elapsed);
            if (outcome.skipped) {
                console.debug(`[sanguine] the clock moved to ${formatClock(outcome.minutes)} on the scene probe's reading`);
            }
        } catch (error) {
            console.error('[sanguine] failed to advance the clock from the scene probe', error);
        }
    }

    // The body goes to the ledger, not to the header.
    //
    // Marks are events (`state-table.js` `deriveState`, the swipe argument), so the answer to "what
    // is wrong with him" is recorded the way everything else that happened is recorded: one event,
    // anchored on the newest live message this pass read, retracted by the swipe that removes it.
    // `who` is left empty, which `validateStatus` reads as the point-of-view character, this probe
    // is the one that establishes who that is, in the very same fragment.
    const marks = recordMarks(
        (Array.isArray(fragment?.conditions) ? fragment.conditions : [])
            .map(entry => ({ phrase: entry?.phrase, severity: entry?.severity, turns: entry?.turns })),
        { windowText, sources, summary: 'Condition' });

    // What the player could do next, for the state card's CYOA buttons. Transient by design, the
    // answer describes a moment, not the record, so it lives in the choices store rather than the
    // ledger.
    setChoices(fragment?.choices);

    return { fields: context.size, marks, place: recordPlace(fragment, sources) };
}

/**
 * Write the pass's place into the place record.
 *
 * One `upsert`, not an upsert and a `setParent`.
 *
 * `foldPlace` already takes the parent as a field and already owes it the cycle check
 * (`wouldCycle`), dropping the PARENT rather than the sighting when a loop would close. Calling
 * `places.setParent` after the upsert would run the same check a second time, against a table that
 * had just been written, and commit twice for one observation.
 *
 * Silence is the whole safety argument here, and it is `merge_entity`'s.
 *
 * This probe fires on every pass that lands, and 95% of them answer `location`. So the overwhelmingly
 * common shape is a pass that says only WHERE, `place_name` filled, `place_facts` empty, and it
 * must not touch the facts an earlier pass established. It does not: `foldPlace` writes `facts: ''`,
 * `merge_entity` reads `''`, null and undefined identically as "said nothing", and the earlier value
 * stands. The same rule carries the parent, so a pass that mentions the room without re-establishing
 * the building does not release the room from it.
 *
 * The one field that is NOT protected by that rule is `driveSize`, where 0 is a real value and a
 * falsy one, which is exactly why this passes neither drive field and `places.setDrive` writes them
 * whole (`places.js`, and `entity-table.js:797-811` for the original).
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {Array<{key: string, mid: number}>} sources Window sources, newest last.
 * @returns {string} The place key written, or '' when the pass established none.
 */
function recordPlace(fragment, sources) {
    const name = String(fragment?.place_name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) {
        return '';
    }
    try {
        const outcome = places.upsert({
            name,
            place: String(fragment?.place_within ?? '').replace(/\s+/g, ' ').trim(),
            facts: String(fragment?.place_facts ?? '').replace(/\s+/g, ' ').trim(),
            detail: String(fragment?.place_detail ?? '').replace(/\s+/g, ' ').trim(),
            source: NARRATIVE,
            // The newest live message this pass read, so the trail entry a change writes can scroll
            // back to the message that caused it, the same anchor `recordMarks` uses above.
            ...(Number.isFinite(sources?.[sources.length - 1]?.mid) ? { mid: sources[sources.length - 1].mid } : {}),
        });
        // Recorded even when the parent was refused for a cycle: the sighting landed, and the
        // panel's Location section is about where the scene IS, not about whether the containment
        // this pass proposed was legal.
        if (outcome.key) {
            places.setHere(outcome.key);
        }
        return outcome.key;
    } catch (error) {
        console.error('[sanguine] failed to record the scene\'s place', error);
        return '';
    }
}
