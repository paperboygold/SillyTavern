/**
 * fold/scene.js — the scene and its protagonist, read from the narrative rather than from a block.
 *
 * ── Why this file exists ──
 *
 * Every scene field fold knew about arrived one way: a card wrote a status block, `absorb.js`
 * parsed it, `state.setContext` stored it. That works beautifully for cards built to emit one and
 * produces literally nothing for every other card. A chat ran thirty-eight turns with a location,
 * a time of day, a named protagonist and an injured shin in plain view of the model, and the panel
 * showed none of them, because no line in the transcript started with "Location:".
 *
 * The narrative always contained the answer. Nothing was ever asked.
 *
 * So this is the same information from a second source. It is not as good — a block is the
 * narrator asserting the scene in its own words, this is fold inferring it — and the table records
 * which is which rather than pretending they are equivalent. `merge_context` ranks them: a card
 * that restates its block every turn is never overridden, and one that has gone quiet for longer
 * than the clock's staleness window gives way to what the prose actually says.
 *
 * ── The protagonist ──
 *
 * Fold had no notion of whose story this is, which is why the point-of-view character was listed
 * under People as though he were a bystander in his own scene.
 *
 * `name1`/`name2` cannot settle it. The common setup has the card as the co-star and the persona as
 * the protagonist; the setup that exposed this had the card *as* the protagonist, with the model
 * narrating everyone else. Both are ordinary, and the difference is invisible from the metadata —
 * it lives in how the prose is written. The extraction model is already reading that prose, so it
 * is asked, and the answer goes through the same field lock as everything else: get it wrong once
 * and `/fold-lock pov` settles it permanently.
 */

import { NARRATIVE, loadClock, noteSceneElapsed, recordMarks, setContext } from './state.js';
import { formatClock } from './clock.js';
import { MAX_MARKS, SEVERITIES } from './state-table.js';

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
 * ── `conditions` left this list in Phase D, and the reason is a measurement ──
 *
 * It used to sit here and be written into scene context like a location, so the panel rendered it
 * inside the scene header joined to the weather (`panel.js`, `[conditions, weather].join('; ')`) —
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
                description: 'The character whose point of view the story is told from — the one the reader is meant to be. Same name as in the people list. Empty if the narration does not settle on one.',
            },
            location: {
                type: 'string',
                description: 'Where the scene is happening right now: "the stableyard", "Paulette\'s inn, upstairs". Empty if the excerpt does not say.',
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
                description: 'How many WHOLE days passed since the last scene: "a week" is 7, "overnight" and "come morning" are 1, "three hours" is 0. Time is continuous, so count the passage the narrative implies even when it writes no duration — only a truly frozen moment (an instant, a time-stop) is 0.',
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
                description: 'True when the narrative names a new day that differs from the last scene\'s — "Wednesday" after "Tuesday", "the 3rd" after "the 2nd". This is what moves the calendar forward a full day when no duration or marker said so.',
            },
            weather: {
                type: 'string',
                description: 'Weather or ambient conditions, if established. Empty otherwise.',
            },
            conditions: {
                type: 'array',
                description: `What is physically wrong with the point-of-view character right now — injuries, exhaustion, pain. One entry per affliction, at most ${MAX_MARKS}, worst first. Empty if nothing is wrong.`,
                items: {
                    type: 'object',
                    properties: {
                        phrase: {
                            type: 'string',
                            description: 'The affliction as a short lowercase phrase: "bruised left arm", "exhausted". The affliction, never the reassurance — "bruised but functional" is ONE entry. Never report that they are fine.',
                        },
                        severity: {
                            type: 'string',
                            enum: SEVERITIES,
                            description: 'minor (stings), moderate (hinders), severe (could end the scene).',
                        },
                    },
                    required: ['phrase', 'severity'],
                    additionalProperties: false,
                },
            },
        },
        required: ['pov', 'location', 'time', 'date', 'elapsed_days', 'elapsed_minutes', 'phase', 'clock_hour', 'clock_minute', 'date_changed', 'weather', 'conditions'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the probe.
 *
 * The player's name is passed in when fold is running with a persona, and only then does the
 * `pov` guidance carry it. The probe must not be told the persona's name when there is none — a
 * fabricated "player" would bias `pov` toward a name the story never uses — but when there is one,
 * it is the single most reliable signal for who the narration follows, because the persona is
 * defined as the reader's character.
 *
 * @param {object} [options] Options.
 * @param {string} [options.player] The player character's name, from the persona.
 * @returns {string} Prompt guidance for the probe.
 */
export function instruction({ player = '' } = {}) {
    const pov = player
        ? `For "pov", name the character the narration follows — the one whose thoughts and sensations are described from the inside. The reader's character is "${player}"; when the excerpt follows the reader's character, report that name exactly.`
        : 'For "pov", name the character the narration follows — the one whose thoughts and sensations are described from the inside.';
    return [
        'The scene as it stands at the END of the excerpt, not as it was at the start.',
        'Only what the excerpt establishes. Leave a field empty rather than carrying one forward or guessing.',
        pov,
        'For "elapsed_days" and "elapsed_minutes", say how much time the scene covered. Time is continuous: the excerpt is not a freeze-frame, so when it shows any action, dialogue or movement, some time has passed even if no duration is written. Scale it to what the scene actually spans: a single line of dialogue or one quick exchange is about a minute; a walk, a fight or a longer conversation is minutes; a trek or a vigil is hours. "a week" is 7 days, "overnight" and "come morning" are 1 day, "three hours" is 180 minutes. 0 only when the moment is truly frozen — an instant, a single beat, an explicit time-stop.',
        'For "phase", report the part of a day the scene moved TO when a transition marker names one — "come morning", "first light" and "overnight" land on "morning", "dusk" on "evening". Empty when the story names no part of a day.',
        'For "clock_hour" and "clock_minute", report the clock as the narrative reads it now when it states one — "3:15 PM" is hour 15 minute 15. -1 when the narrative states no clock time.',
        'For "date", name the day only when the narrative states a new one outright — "the next morning" belongs in "elapsed_days", a named day ("Wednesday", "the 3rd") belongs here, and "date_changed" is true then.',
        'For "date_changed", set it true exactly when the story names a day different from the last scene\'s — this is the one unambiguous signal a full day has passed even when no duration says so.',
        '"conditions" is about that character\'s body only: what hurts, what is exhausted, what is impaired. Not mood, not clothes, not weather.',
        'Report every affliction still true, not only the new ones — this list replaces what was recorded before it.',
    ].join(' ');
}

/**
 * The scene probe's PER-PASS state, kept out of `instruction()` so the instruction block can be
 * cached.
 *
 * The clock already on record — frame elapsed as ADVANCE beyond it, so a pass that re-reads
 * "the next morning" in context does not re-count the same night as a fresh day. Measured in
 * the Wuxia RP: one overnight sleep was reported as `elapsed_days: 1` on three consecutive
 * turns (17, 18, 19), rolling day 1 -> 2 -> 3 for a single night, because the model had no
 * anchor for "previous scene" other than the window's own phrasing.
 *
 * This clause used to live inside `instruction()`, where it was the ONLY thing that moved between
 * consecutive passes — and by moving it made the whole 2700-token instruction block differ every
 * pass, so 70% of consecutive passes shared no cacheable prefix at all (measured over 563 traces).
 * Same words, same position in the prompt relative to the data; only the side of the cache
 * breakpoint changed.
 *
 * @returns {string} The per-pass clock line, or empty when no clock is set.
 */
export function context() {
    const clockNow = loadClock();
    return Number.isFinite(clockNow?.minutes)
        ? `The clock already reads day ${clockNow.day} at ${formatClock(clockNow.minutes)} — count elapsed time BEYOND that, never the passage that is already on record.`
        : '';
}

/**
 * Apply a probe fragment.
 *
 * Empty strings are dropped rather than written. A model that does not know where the scene is says
 * so by leaving the field empty, and storing that would erase a location nothing in the story
 * retracted — the same asymmetry that makes a block evidence of what it states and not of what it
 * omits.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} [context] Context from the extraction pass.
 * @param {string} [context.windowText] The new half of the window.
 * @param {Array<{key: string, mid: number}>} [context.sources] Window sources, newest last.
 * @returns {{fields: number, marks: number}} How many fields were established.
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
        // (`advanceSceneClock`). `setContext` must not fold `time` in again on the same pass — two
        // writers on one clock is exactly the defect that froze the face at 19:45 while the day
        // rolled. `skipClock` stores the display fields without touching the clock.
        setContext(context, { source: NARRATIVE, skipClock: true });
    }

    // ── The clock moves on the model's own reading ──
    //
    // `elapsed_days`/`elapsed_minutes`/`phase` are the model's comprehension answers to "how much
    // time passed and what part of the day is it now", and `clock_hour`/`clock_minute` are the
    // clock as it reads. This is the structure the clock should have been reading all along: before
    // it, the clock parsed the narrator's phrasing out of free text with English regexes, and a
    // Korean or Chinese player's "come morning" never moved it. The model reads the prose already;
    // it is asked, not matched. Anchored to nothing (the arithmetic is fold's own, not an event),
    // so a swipe that removes the passage cannot be retracted by the ledger. That is deliberate:
    // time that passed stays passed, and the clock is a running position that only moves forward —
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
    };
    if (elapsed.days || elapsed.minutes || elapsed.phase || elapsed.clockHour >= 0 || elapsed.dateChanged) {
        try {
            const outcome = noteSceneElapsed(elapsed);
            if (outcome.skipped) {
                console.debug(`[fold] the clock moved to ${formatClock(outcome.minutes)} on the scene probe's reading`);
            }
        } catch (error) {
            console.error('[fold] failed to advance the clock from the scene probe', error);
        }
    }

    // ── The body goes to the ledger, not to the header ──
    //
    // Marks are events (`state-table.js` `deriveState`, the swipe argument), so the answer to "what
    // is wrong with him" is recorded the way everything else that happened is recorded: one event,
    // anchored on the newest live message this pass read, retracted by the swipe that removes it.
    // `who` is left empty, which `validateStatus` reads as the point-of-view character — this probe
    // is the one that establishes who that is, in the very same fragment.
    const marks = recordMarks(
        (Array.isArray(fragment?.conditions) ? fragment.conditions : [])
            .map(entry => ({ phrase: entry?.phrase, severity: entry?.severity })),
        { windowText, sources, summary: 'Condition' });

    return { fields: context.size, marks };
}
