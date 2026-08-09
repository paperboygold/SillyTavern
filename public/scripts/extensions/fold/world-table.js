/**
 * fold/world-table.js — the world moves while you are not looking (pure half).
 *
 * The off-screen world-turn: on a pass triggered by a declared time skip or scene break, the model
 * is asked which of the standing agendas plausibly advanced during the elapsed span, and how. The
 * answer is a set of moves, each rooted in an actor fold already tracks. Nothing here touches
 * storage or the extraction call; that is `world.js`. FOLD-REDESIGN.md §7.
 *
 * ── Why rooted, and why the root is a cast row ──
 *
 * §7.4: "a proposed move must be rooted: it names an existing row's `wants` or an existing front's
 * next step. Unrooted inventions are refused." The world probe may ADVANCE the world fold knows
 * about, never AUTHOR a new one — new actors and fronts arrive the normal way, by being established
 * on-screen. A move citing no tracked person or faction is the model inventing state, which is the
 * one thing this probe exists to stop (FOLD-REDESIGN.md §7.4, anti-pattern: "rule hallucination").
 *
 * Rootedness is resolved with the SAME machinery the rest of the codebase uses for entity identity
 * (`resolveEntity`), not a similarity metric: §11 bans those for reading the narrative, and a name
 * match against the cast is identity resolution against fold's own state, which is the sanctioned
 * shape. The cheapest layer — a person with a `wants` who acts between scenes — needs no faction
 * kind at all, and per §7.3 it covers most of the value (Kang and Jin-Woo are people, not factions).
 */

import { FACTION, PERSON, resolveEntity } from './entity-table.js';
import { HIDDEN, OPEN, samePlace } from './thread-table.js';

/** How many recent world events the pinned block may carry. */
export const MAX_WORLD_LINES = 3;

/**
 * Render the recent off-screen world for the pinned block, honouring the reveal contract.
 *
 * ── Discovery, not bulletins (§7.5) ──
 *
 * The panel and the injection "never tell the player what their character has not learned, and never
 * pretend nothing is happening." A world event whose `seen` is hidden AND whose `where` is not the
 * current scene renders the way a hidden dial does today — NAMED, never asserted: the actor is
 * named so the narrator knows the world is moving, but the content (what they did) is withheld,
 * because asserting it would hand the player a fact their character could not know.
 *
 * Locality is the gate that flips it: the same `local` predicate that scopes clocks decides when a
 * changed place becomes assertable. Walk back to the event's `where` and the pinned block may now
 * assert what changed there — the "walk back to the Nowon gate site" case §7.5 names.
 *
 * @param {object[]} events The live ledger (already liveness-filtered).
 * @param {string} [at] The scene's location.
 * @returns {string} A `World:` line for the injected block, or '' when nothing to say.
 */
export function renderWorldEvents(events, at = '') {
    const recent = (Array.isArray(events) ? events : [])
        .filter(event => event?.src === 'world')
        .slice(-MAX_WORLD_LINES);
    if (!recent.length) {
        return '';
    }

    const parts = recent.map(event => {
        const meta = event?.d?.world ?? {};
        const who = String(meta.who ?? '').trim();
        const where = String(meta.where ?? '').trim();
        const hidden = meta.seen === HIDDEN;
        const local = !where || samePlace(where, at);
        if (hidden && !local) {
            // Named, never asserted: the world is moving and the character cannot see how.
            return who ? `(off-screen: ${who})` : '(something stirs off-screen)';
        }
        return String(event?.s ?? '').trim() || who;
    }).filter(Boolean);

    return parts.length ? `World: ${parts.join('; ')}` : '';
}

/**
 * The reveal contract handed to the narrator alongside the rendered world.
 *
 * §7.5: "these things are true and the character does not know them; reveal them only through what
 * the character could perceive." The ledger block carries full hidden state for the NARRATOR (unlike
 * the player), and this line is the instruction that keeps it from leaking — the same
 * lock-serialization insight applied to knowledge: tell the model the constraint instead of hoping
 * omission implies it.
 *
 * @returns {string} A sentence appended under the world section.
 */
export function revealContract() {
    return 'World events marked "(off-screen)" are true and the point-of-view character does not know them; reveal them only through what they could perceive.';
}

/**
 * The schema fragment for the world probe.
 *
 * Always present in the shared schema — the model returns `world: {moves: []}` on every pass — but
 * the instruction tells it to fill moves only when the excerpt declares elapsed time or a scene
 * break, and `apply` enforces arming in code (`world.js`). A prompt line is trusted for nothing
 * (FOLD-REDESIGN.md §6); the code gate is the one that stops an unarmed pass from writing world.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'What the people and factions already on the cast did while the camera was elsewhere. Off-screen only — never events the excerpt showed directly.',
        properties: {
            moves: {
                type: 'array',
                description: 'Advances of standing agendas during the elapsed span. Empty when the span was short, nothing plausibly moved, or the excerpt showed the events directly.',
                items: {
                    type: 'object',
                    properties: {
                        who: {
                            type: 'string',
                            description: 'The person or faction making the move, BY NAME as it appears in the cast above. Must be someone already tracked there — never a new actor.',
                        },
                        what: {
                            type: 'string',
                            description: 'One phrase: how their agenda advanced: "ran two D-rank raids", "moved on the border".',
                        },
                        where: {
                            type: 'string',
                            description: 'The bare place name where this happened, when tied to one. Empty if it follows the actor anywhere.',
                        },
                        seen: {
                            type: 'string',
                            enum: [OPEN, HIDDEN],
                            description: `${OPEN} if the point-of-view character could plausibly learn of this, ${HIDDEN} if beyond their knowledge. Default ${HIDDEN} for anything they would have to be told about and were not.`,
                        },
                    },
                    required: ['who', 'what', 'where', 'seen'],
                    additionalProperties: false,
                },
            },
        },
        required: ['moves'],
        additionalProperties: false,
    };
}

/** @returns {string} Prompt guidance for the probe. */
export function instruction() {
    return [
        'What the people and factions already on the cast did while the camera was elsewhere, given the time the excerpt says has passed.',
        'A move must name a person or faction FROM THE CAST ABOVE — never invent a new actor. fold advances the world it knows; new actors arrive only on-screen.',
        'Root each move in that actor\'s stated wants where one is recorded. An agenda with no advance contributes no move.',
        `Say whether the point-of-view character could plausibly learn of it ("${OPEN}") or not ("${HIDDEN}"). Default "${HIDDEN}" for anything they would have to be told about and were not.`,
        'Off-screen only. If the excerpt showed an event directly, the other probes already recorded it.',
        'Use an empty array when the span was short, nothing plausibly advanced, or the pass was not triggered by elapsed time.',
    ].join(' ');
}

/**
 * Turn a world fragment into the moves fold will record, refusing the unrooted ones.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.entities The entity table (the cast; read-only here).
 * @returns {{accepted: Array<{who: string, what: string, where: string, seen: string, root: string}>, rejected: Array<{who: string, reason: string}>}}
 *   What fold will advance, and what was refused for being unrooted.
 */
export function planWorld(fragment, { entities } = {}) {
    const accepted = [];
    const rejected = [];

    for (const move of Array.isArray(fragment?.moves) ? fragment.moves : []) {
        const who = String(move?.who ?? '').trim();
        const what = String(move?.what ?? '').trim();
        if (!who || !what) {
            rejected.push({ who, reason: 'no-change' });
            continue;
        }
        // The root is a cast row, resolved the way everything in fold resolves identity — against
        // the entity table, not by reading the move's prose. A person first (the cheap layer that
        // covers Kang and Jin-Woo), then a faction. No match is the model inventing an actor.
        const root = resolveEntity(entities, PERSON, who) || resolveEntity(entities, FACTION, who);
        if (!root) {
            rejected.push({ who, reason: 'unrooted-move' });
            continue;
        }
        const where = String(move?.where ?? '').trim();
        const seen = move?.seen === HIDDEN ? HIDDEN : OPEN;
        accepted.push({ who: root.entity.name || who, what, where, seen, root: root.key });
    }

    return { accepted, rejected };
}
