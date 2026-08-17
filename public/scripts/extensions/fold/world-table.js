/**
 * fold/world-table.js — the world moves while you are not looking (pure half).
 *
 * The off-screen world-turn: on a pass triggered by a declared time skip or scene break, the model
 * is asked which of the standing agendas plausibly advanced during the elapsed span, and how. The
 * answer is a set of moves, each rooted in an actor fold already tracks. Nothing here touches
 * storage or the extraction call; that is `world.js`. FOLD-REDESIGN.md §7.
 *
 * ── Why rooted, and why rootedness stopped needing a rule ──
 *
 * §7.4: "a proposed move must be rooted: it names an existing row's `wants` or an existing front's
 * next step. Unrooted inventions are refused." The world probe may ADVANCE the world fold knows
 * about, never AUTHOR a new one — new actors and fronts arrive the normal way, by being established
 * on-screen. That intent is unchanged and the enforcement is gone, because it became unnecessary:
 * the probe is no longer asked to NAME an actor, it is handed numbered lines fold printed and asked
 * to answer them. An id can only come from the block, so an unrooted advance is not refused, it is
 * unsayable — the class made impossible by construction rather than caught by a gate, and
 * `unrooted-move` retired with the shape that needed it.
 *
 * ── And why it is a form rather than a question ──
 *
 * Measured across a completed campaign: armed 107 times by real elapsed spans, 107 empty answers,
 * zero rejections — nothing was ever proposed for a gate to refuse. On those same passes the
 * review's numbered disposition lines drew 3319 answers from the same model. The subject was not
 * the problem and neither was the model; `moves: []` was always valid and the instruction spent two
 * of its six clauses granting permission to use it. See `worldBlock`.
 */

import { table_entries } from './lib/hash.js';
import { windowSnippet } from './diag.js';
import { ACTOR_KINDS, splitEntityKey } from './entity-table.js';
import { HIDDEN, OPEN, dialOf, samePlace } from './thread-table.js';

/** How many recent world events the pinned block may carry. */
export const MAX_WORLD_LINES = 3;

/**
 * How many agendas one off-screen turn may ask about.
 *
 * The block is a form to fill in, and a form nobody finishes is a form that was too long. Bounded
 * the way `MAX_ITEM_LINES` bounds the review's half; what does not fit is asked on a later skip,
 * and `worldAsks` orders by how long each has gone unmoved so the queue drains.
 */
export const MAX_WORLD_ASKS = 8;

/**
 * The most one agenda may advance on one pass.
 *
 * Off-screen has no mention gate — that is what off-screen MEANS — so the elapsed span is the only
 * evidence, and it cannot distinguish one step from five. One step per skip makes a long ambition
 * take many skips, which is the pacing a campaign wants anyway, and bounds what a compliant model
 * can do if it decides everything advanced at once.
 */
export const MAX_WORLD_TICK = 1;

/** Line-id prefix, mirroring `review-table.js`'s per-kind prefixes. */
const ASK_PREFIX = 'W';

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
            advances: {
                type: 'array',
                description: 'One entry for EVERY numbered line in the "WHAT MOVED WHILE YOU WERE AWAY" block, in order. Answer every line, including the ones that did not move.',
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The line id exactly as printed, e.g. "W1". Never an id the block did not print.',
                        },
                        tick: {
                            type: 'integer',
                            description: `How far it advanced during the elapsed span: 0 if nothing happened, 1 if it moved. At most ${MAX_WORLD_TICK} per span. 0 is a real answer and the right one for a short gap or an agenda nothing served.`,
                        },
                        what: {
                            type: 'string',
                            description: 'One phrase saying how it advanced: "ran two D-rank raids", "bought out the eastern pill stalls". Empty when the tick is 0.',
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
                    required: ['id', 'tick', 'what', 'where', 'seen'],
                    additionalProperties: false,
                },
            },
        },
        required: ['advances'],
        additionalProperties: false,
    };
}

/** @returns {string} Prompt guidance for the probe. */
export function instruction() {
    return [
        'The "WHAT MOVED WHILE YOU WERE AWAY" block lists standing agendas by id. Answer EVERY line once, in order.',
        `"tick" is 0 if that agenda did not advance during the elapsed span, ${MAX_WORLD_TICK} if it did. 0 is a real answer: a short gap, or nobody served that agenda, and most lines on most passes are 0.`,
        'Judge only the span the excerpt says has passed, and only what happened OFF-SCREEN. If the excerpt showed it directly, the other probes already recorded it and the tick is 0.',
        'When a line ticks, "what" says in one phrase how it advanced, rooted in what that actor or stake is after.',
        `Say whether the point-of-view character could plausibly learn of it ("${OPEN}") or not ("${HIDDEN}"). Default "${HIDDEN}" for anything they would have to be told about and were not.`,
        'Use an empty array only when the block listed no lines.',
    ].join(' ');
}

/**
 * The agendas this pass may ask about: every dial that can move while the camera is away.
 *
 * Actors and threads arrive from different tables and leave as one list, because the question is
 * the same for both — an integer with a position, and something that would move it. `driveSize: 0`
 * is "no standing agenda", which is every cast row in every chat written before drives existed, so
 * a campaign that has never set one asks nothing and behaves exactly as it did.
 *
 * Ordered by how long each has gone unmoved, so a queue longer than `MAX_WORLD_ASKS` drains instead
 * of asking about the same eight forever.
 *
 * @param {object} params Parameters.
 * @param {Map<string, object>} [params.entities] The cast table.
 * @param {Array<object>} [params.threads] Thread rows, as `threads()` returns them.
 * @param {number} [params.turn] Current turn, for ordering.
 * @returns {Array<object>} Eligible agendas, most-neglected first.
 */
export function worldAsks({ entities = new Map(), threads = [], turn = 0 } = {}) {
    const asks = [];

    for (const [key, row] of table_entries(entities)) {
        if (!ACTOR_KINDS.includes(splitEntityKey(key).kind)) {
            continue;
        }
        const size = Number(row?.driveSize) || 0;
        if (size <= 0) {
            continue;
        }
        asks.push({
            kind: 'actor',
            key,
            name: String(row?.name ?? ''),
            about: String(row?.wants ?? ''),
            filled: Math.max(0, Number(row?.drive) || 0),
            size,
            age: Math.max(0, turn - (Number(row?.turn) || 0)),
        });
    }

    for (const thread of Array.isArray(threads) ? threads : []) {
        const dial = dialOf(thread);
        if (!dial) {
            continue;
        }
        asks.push({
            kind: 'thread',
            key: String(thread?.key ?? ''),
            name: String(thread?.name ?? ''),
            about: String(thread?.about ?? thread?.open ?? ''),
            filled: dial.filled,
            size: dial.size,
            polarity: dial.kind,
            age: Math.max(0, Number(thread?.stale) || 0),
        });
    }

    return asks
        .filter(ask => ask.key && ask.name)
        .sort((a, b) => b.age - a.age || a.name.localeCompare(b.name))
        .slice(0, MAX_WORLD_ASKS);
}

/**
 * Render the off-screen turn as numbered lines the model files against.
 *
 * ── The measurement this replaces an open invitation with ──
 *
 * The probe used to be handed a free `moves` array and asked what advanced. Across a completed
 * campaign it was armed 107 times by real elapsed spans and returned an empty list 107 times, with
 * zero rejections — the model never proposed anything for a gate to refuse. In the same campaign,
 * on the same passes, the review's numbered disposition lines drew 3319 answers.
 *
 * The difference is not the model and not the subject. A form gets filled in and an open question
 * gets skipped, and the schema made skipping free: `moves: []` is always valid, and the instruction
 * spent two of its six clauses granting permission to use it.
 *
 * So the world turn is a form now. One line per agenda, each with an id, and an answer per id.
 *
 * ── Addressing by id retires `unrooted-move` ──
 *
 * The old shape asked the model to NAME its actor, which meant a name could miss — the whole point
 * of the rootedness rule and its `unrooted-move` refusal. An id can only come from the block fold
 * just printed, so an unrooted move is no longer refused, it is unsayable. That is the class made
 * impossible by construction rather than caught by a gate, and it is why the rule leaves with the
 * shape that needed it. `unknown-id` remains for a garbled or invented id, which is a different and
 * much narrower failure.
 *
 * @param {object} params Parameters.
 * @param {Array<object>} [params.asks] Rows from `worldAsks`.
 * @param {string} [params.elapsed] How much time the excerpt says passed, for the heading.
 * @returns {{text: string, index: Map<string, object>}} The block and its id lookup.
 */
export function worldBlock({ asks = [], elapsed = '' } = {}) {
    const index = new Map();
    if (!asks.length) {
        return { text: '', index };
    }

    const lines = asks.map((ask, at) => {
        const id = `${ASK_PREFIX}${at + 1}`;
        index.set(id, { ...ask, id });
        const face = ask.kind === 'actor' ? 'drive' : (ask.polarity || 'dial');
        const about = ask.about ? ` — ${ask.about}` : '';
        return `  ${id} [${face} ${ask.filled}/${ask.size}] ${ask.name}${about}`;
    });

    const span = String(elapsed ?? '').trim();
    return {
        text: [
            `WHAT MOVED WHILE YOU WERE AWAY${span ? ` (${span})` : ''}`,
            ...lines,
        ].join('\n'),
        index,
    };
}

/**
 * Turn the answered lines into the moves fold will record.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.index The id lookup `worldBlock` returned.
 * @param {string} [params.windowText] Narrative window, for the diagnostics snippet.
 * @returns {{accepted: Array<object>, rejected: Array<object>, declined: number}} What fold will
 *   advance, what was refused, and how many lines were answered "nothing moved".
 */
export function planWorld(fragment, { index = new Map(), windowText = '' } = {}) {
    const accepted = [];
    const rejected = [];
    const snippet = windowSnippet(windowText);
    let declined = 0;
    const answered = new Set();

    for (const advance of Array.isArray(fragment?.advances) ? fragment.advances : []) {
        const id = String(advance?.id ?? '').trim().toUpperCase();
        const ask = index.get(id);
        if (!ask) {
            // Narrower than `unrooted-move` ever was: not "you named somebody I do not know" but
            // "you answered a question I did not ask".
            rejected.push({ item: id || String(advance?.id ?? ''), reason: 'unknown-id', raw: advance, snippet });
            continue;
        }
        // One answer per line. A second is not evidence of two advances; it is the same line filed
        // twice, and taking both would let one agenda outrun the per-pass cap by repetition.
        if (answered.has(id)) {
            rejected.push({ item: id, reason: 'duplicate-id', raw: advance, snippet });
            continue;
        }
        answered.add(id);

        const tick = Math.trunc(Number(advance?.tick) || 0);
        if (tick <= 0) {
            // A first-class answer, and the honest one for a short span. What changed is that it
            // must be GIVEN — an absent array no longer stands in for "I considered them all".
            declined++;
            continue;
        }

        const what = String(advance?.what ?? '').trim();
        if (!what) {
            // A tick with nothing to say is a number with no fiction under it. The summary is what
            // makes the advance recallable later, so an advance without one is not worth recording.
            rejected.push({ item: ask.name, reason: 'no-change', raw: advance, snippet });
            continue;
        }

        accepted.push({
            id,
            kind: ask.kind,
            root: ask.key,
            who: ask.name,
            what,
            where: String(advance?.where ?? '').trim(),
            seen: advance?.seen === HIDDEN ? HIDDEN : OPEN,
            tick: Math.min(MAX_WORLD_TICK, tick),
            filled: ask.filled,
            size: ask.size,
        });
    }

    return { accepted, rejected, declined };
}

