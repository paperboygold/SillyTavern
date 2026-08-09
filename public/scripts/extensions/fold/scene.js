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

import { NARRATIVE, recordMarks, setContext } from './state.js';
import { MAX_MARKS, SEVERITIES } from './state-table.js';

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
const FIELDS = ['location', 'time', 'weather'];

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
        required: ['pov', 'location', 'time', 'weather', 'conditions'],
        additionalProperties: false,
    };
}

/** @returns {string} Prompt guidance for the probe. */
export function instruction() {
    return [
        'The scene as it stands at the END of the excerpt, not as it was at the start.',
        'Only what the excerpt establishes. Leave a field empty rather than carrying one forward or guessing.',
        'For "pov", name the character the narration follows — the one whose thoughts and sensations are described from the inside.',
        '"conditions" is about that character\'s body only: what hurts, what is exhausted, what is impaired. Not mood, not clothes, not weather.',
        'Report every affliction still true, not only the new ones — this list replaces what was recorded before it.',
    ].join(' ');
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
        setContext(context, { source: NARRATIVE });
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
