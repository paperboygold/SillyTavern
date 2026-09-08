/**
 * fold/world-table.js: the world moves while you are not looking (pure half).
 *
 * The off-screen world-turn: on a pass triggered by a declared time skip or scene break, the model
 * is asked which of the standing agendas plausibly advanced during the elapsed span, and how. The
 * answer is a set of moves, each rooted in an actor fold already tracks. Nothing here touches
 * storage or the extraction call; that is `world.js`. FOLD-REDESIGN.md §7.
 *
 * Why rooted, and why rootedness stopped needing a rule.
 *
 * §7.4: "a proposed move must be rooted: it names an existing row's `wants` or an existing front's
 * next step. Unrooted inventions are refused." The world probe may ADVANCE the world fold knows
 * about, never AUTHOR a new one, new actors and fronts arrive the normal way, by being established
 * on-screen. That intent is unchanged and the enforcement is gone, because it became unnecessary:
 * the probe is no longer asked to NAME an actor, it is handed numbered lines fold printed and asked
 * to answer them. An id can only come from the block, so an unrooted advance is not refused, it is
 * unsayable: the class made impossible by construction rather than caught by a gate, and
 * `unrooted-move` retired with the shape that needed it.
 *
 * And why it is a form rather than a question.
 *
 * Measured across a completed campaign: armed 107 times by real elapsed spans, 107 empty answers,
 * zero rejections, nothing was ever proposed for a gate to refuse. On those same passes the
 * review's numbered disposition lines drew 3319 answers from the same model. The subject was not
 * the problem and neither was the model; `moves: []` was always valid and the instruction spent two
 * of its six clauses granting permission to use it. See `worldBlock`.
 */

import { table_entries } from './lib/hash.js';
import { windowSnippet } from './diag.js';
import {
    ACTOR_KINDS, MAX_DRIVE, MIN_DRIVE, agendaSpan, agendaStable, aliasKeys, needsDriveJudgement,
    normalizeEntityName, splitEntityKey,
} from './entity-table.js';
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
 * Off-screen has no mention gate, that is what off-screen MEANS, so the elapsed span is the only
 * evidence, and it cannot distinguish one step from five. One step per skip makes a long ambition
 * take many skips, which is the pacing a campaign wants anyway, and bounds what a compliant model
 * can do if it decides everything advanced at once.
 */
export const MAX_WORLD_TICK = 1;

/** Line-id prefix, mirroring `review-table.js`'s per-kind prefixes. */
const ASK_PREFIX = 'W';

/**
 * Line-id prefix for the nomination half.
 *
 * Distinct from `W` so one index can carry both sections without collision, the same trick
 * `reconcile-table.js` `PREFIX` uses to let one answer list address four tables. An answer that
 * quotes `N2` can only be about a nomination, so the router never guesses.
 */
const NOMINATE_PREFIX = 'N';

/**
 * How many agendas one armed pass may put to the model for judgement.
 *
 * Three, and the corpus is why it is not eight.
 *
 * `nominates` deliberately optimises for recall, so the candidate pool is large: MEASURED over the
 * corpus, 102 nominations across 165 actor rows, and 23 in the biggest single save. Posing all of
 * them would spend an entire prompt on one question, on the same pass where the world turn also has
 * advances to ask about.
 *
 * Three is chosen against how the queue DRAINS rather than how the block looks. A judgement is
 * asked once per agenda (`needsDriveJudgement`), not once per skip, so the pool is a backlog that
 * empties rather than a recurring cost. At three per armed pass: the largest campaign save in the
 * corpus is fully judged in 8 armed passes, Solo Leveling in 4, and every other campaign in 1 to 3.
 * Since an armed pass is a declared time skip, that is a handful of skips to have an opinion about
 * the whole cast, against three extra lines on a prompt that already carries eight world lines.
 *
 * Ordered by neglect the way `worldAsks` is, so a row that misses the cut comes up next time rather
 * than sitting at the back forever.
 */
export const MAX_NOMINATIONS = 3;

/**
 * What a section prints when this pass has nothing to ask under it.
 *
 * The measurement: a required array with no block to answer gets filled with invention.
 *
 * Traced over 1855 world fragments across the whole corpus (`sanguine-traces` + `fold-traces`):
 *
 *   both sections posed          19 passes, cross-filed ids: 0
 *   `W` section only             69 passes, `nominations` answered anyway: 13 passes, 38 answers
 *   `N` section only              2 passes, `advances` answered anyway: 0
 *
 * The model has NEVER once cross-filed when both sections were on the page. Every `unknown-id` the
 * world probe has ever recorded, 15 of the live Wuxia chat's 16, all on armed passes, came from a
 * pass where the STANDING AGENDAS block was not rendered at all and `nominations` was answered
 * regardless: 20 of the 38 phantom answers invented `N` ids that were never posed, the other 18
 * copied the `W` ids down from the block that WAS on the page.
 *
 * The asymmetry with `advances` (0 phantoms in 1765 blockless passes) is in the prompt, not the
 * model. `instruction()` granted the empty-array permission once, "use an empty array only when
 * the block listed no lines", and it sat among the advance clauses, so the advance half had it and
 * the nomination half did not. Meanwhile `schema()` lists both arrays in `required` and the
 * instruction describes both blocks on every pass. A model told to answer a block it cannot find,
 * into an array it must emit, answers with the only ids in front of it.
 *
 * So the absent section now PRINTS, with its heading and this line. The block the instruction names
 * is always on the page, and what it says there is that the array is empty. Two lines, and only on
 * the ~5% of passes that render a block at all, `worldBlock` still returns '' when both are empty.
 */
export const NO_LINES = 'none this pass';

/** @param {string} field The answer array this section files into. @returns {string} The marker line. */
const noLines = field => `  (${NO_LINES}, "${field}" is [])`;

/**
 * Render the recent off-screen world for the pinned block, honouring the reveal contract.
 *
 * Discovery, not bulletins (§7.5).
 *
 * The panel and the injection "never tell the player what their character has not learned, and never
 * pretend nothing is happening." A world event whose `seen` is hidden AND whose `where` is not the
 * current scene renders the way a hidden dial does today, NAMED, never asserted: the actor is
 * named so the narrator knows the world is moving, but the content (what they did) is withheld,
 * because asserting it would hand the player a fact their character could not know.
 *
 * Locality is the gate that flips it: the same `local` predicate that scopes clocks decides when a
 * changed place becomes assertable. Walk back to the event's `where` and the pinned block may now
 * assert what changed there, the "walk back to the Nowon gate site" case §7.5 names.
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
 * the player), and this line is the instruction that keeps it from leaking, the same
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
 * Always present in the shared schema, the model returns `world: {moves: []}` on every pass, but
 * the instruction tells it to fill moves only when the excerpt declares elapsed time or a scene
 * break, and `apply` enforces arming in code (`world.js`). A prompt line is trusted for nothing
 * (FOLD-REDESIGN.md §6); the code gate is the one that stops an unarmed pass from writing world.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'What the people and factions already on the cast did while the camera was elsewhere. Off-screen only, never events the excerpt showed directly.',
        properties: {
            advances: {
                type: 'array',
                description: `One entry for EVERY numbered line in the "WHAT MOVED WHILE YOU WERE AWAY" block, in order. Answer every line, including the ones that did not move. Empty, and only empty, when that block prints "(${NO_LINES})".`,
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
            nominations: {
                type: 'array',
                // The permission the advance half already had and this one did not. 13 traced
                // passes answered this array against a block that was not on the page, see
                // `NO_LINES`. Stated here as well as in `instruction()` because this is the field
                // description attached to the array itself, which is where "may this be empty?" is
                // read from.
                description: `One entry for EVERY numbered line in the "STANDING AGENDAS" block, in order. Answer every line. Empty, and only empty, when that block prints "(${NO_LINES})". Never answer this array with ids from the other block.`,
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: 'The line id exactly as printed, e.g. "N1". Never an id the block did not print.',
                        },
                        completes: {
                            type: 'boolean',
                            description: 'true if there is a state of the world where this is FINISHED and the actor stops pursuing it. false if it is a role, a routine or a condition they maintain, most people, and every shopkeeper, guard and passer-by. false is the common answer and the right one.',
                        },
                        steps: {
                            type: 'integer',
                            description: `How many off-screen advances it takes to finish, ${MIN_DRIVE} to ${MAX_DRIVE}, when "completes" is true. One advance is one time skip, so 6 means roughly six skips of story, an arc, not a scene. 0 when "completes" is false.`,
                        },
                    },
                    required: ['id', 'completes', 'steps'],
                    additionalProperties: false,
                },
            },
        },
        required: ['advances', 'nominations'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the probe.
 *
 * The nomination clauses are the load-bearing part, and they are built from the corpus.
 *
 * The failure this replaces was reflexive zeros: `drive_size` was answered 0 in 288 of 288 traced
 * proposals because it was asked too early. The symmetrical failure, reflexive `true`, every
 * shopkeeper handed a six-step drive, is just as available, and what prevents it is not sternness
 * but a stated CRITERION plus permission to use the negative side of it.
 *
 * The criterion is completion: is there a state of the world where the actor stops? That is the one
 * property that separates the agendas worth tracking from the ones that are not, and it is why the
 * examples below are the corpus's own strings rather than invented ones. Every distinct `wants` in
 * the corpus was labelled by hand for this, and the four classes it fell into are what the examples
 * teach:
 *
 *   completes: `win the Foundation Building Pill`, `break the seal and discover what is buried`,
 *                `find Ben Bertolucci`, `sell the prototype to a buyer on Coruscant`
 *   routine: `Run her inn`, `sell goods for a fair price`, `serve the sect and obey master`,
 *                `process candidates efficiently`   (41 of 125 rows)
 *   condition: `survive`, `get to safety`, `safety for child`, `to be left alone`  (17 rows)
 *   scene-only: `make a sale`, `to find a seat`, `lead raid`, `conversation`  (36 rows)
 *
 * 25% of the corpus is the first class. So `false` is not a fallback here, it is the majority answer,
 * and the instruction says so in as many words, the same reason `MAX_WORLD_TICK`'s clause insists 0
 * is a real answer for the advance half.
 *
 * @returns {string} Prompt guidance for the probe.
 */
export function instruction() {
    return [
        'The "WHAT MOVED WHILE YOU WERE AWAY" block lists standing agendas by id. Answer EVERY line once, in order.',
        `"tick" is 0 if that agenda did not advance during the elapsed span, ${MAX_WORLD_TICK} if it did. 0 is a real answer: a short gap, or nobody served that agenda, and most lines on most passes are 0.`,
        'Judge only the span the excerpt says has passed, and only what happened OFF-SCREEN. If the excerpt showed it directly, the other probes already recorded it and the tick is 0.',
        'When a line ticks, "what" says in one phrase how it advanced, rooted in what that actor or stake is after.',
        `Say whether the point-of-view character could plausibly learn of it ("${OPEN}") or not ("${HIDDEN}"). Default "${HIDDEN}" for anything they would have to be told about and were not.`,
        'The "STANDING AGENDAS, DOES THIS COMPLETE?" block is a separate question about different people. Answer EVERY line there too, in order, using its own ids.',
        'An agenda COMPLETES if there is a state of the world where it is finished and the actor stops pursuing it: winning the tournament, breaking the seal, cornering the market, finding a named person, selling the prototype. Answer true and give the number of steps.',
        'Running an inn, selling goods, serving a sect, processing paperwork, staying alive, keeping a child safe, being left alone, these are roles and conditions the actor MAINTAINS, not goals they finish. Answer false with 0 steps. So is anything that resolves inside one scene: making a sale, finding a seat, leading one raid, having a conversation.',
        'false is the ordinary answer and most lines deserve it, roughly three quarters of the people a story tracks are doing a job or staying alive, not pursuing something that ends.',
        `When it does complete, "steps" is how many time skips of story it takes, ${MIN_DRIVE} to ${MAX_DRIVE}. Judge it against the scale of the whole campaign, not the next scene.`,
        // The routing rule, stated last because it governs both halves.
        //
        // This clause replaces "Use an empty array only when the block listed no lines", which said
        // the right thing to the wrong half: it sat among the advance clauses, so `advances` had
        // permission to be empty and `nominations` did not. Measured consequence in `NO_LINES`:
        // 13 traced passes answered `nominations` against a block that was not printed, 38 phantom
        // answers, and every world `unknown-id` on record. Both blocks are always printed now, so
        // the marker is a thing the model can actually look at.
        `Each block answers into its OWN array: "WHAT MOVED WHILE YOU WERE AWAY" into "advances" using its ${ASK_PREFIX} ids, "STANDING AGENDAS" into "nominations" using its ${NOMINATE_PREFIX} ids. A block printed as "(${NO_LINES})" has nothing to answer: its array is empty, and that is the only reason either array is empty. Never carry ids from one block into the other array, and never answer an id that is not printed above.`,
    ].join(' ');
}

/**
 * The agendas this pass may ask about: every dial that can move while the camera is away.
 *
 * Actors and threads arrive from different tables and leave as one list, because the question is
 * the same for both, an integer with a position, and something that would move it. Size 0 is "no
 * standing agenda", and an actor with none is simply not asked about.
 *
 * Ordered by how long each has gone unmoved, so a queue longer than `MAX_WORLD_ASKS` drains instead
 * of asking about the same eight forever.
 *
 * The size is stored state, authored by the model, and this half only reads it.
 *
 * It reads `Number(row?.driveSize) || 0` and it did once try to be cleverer. The number used to come
 * from the entity probe answering "how many steps does their standing ambition take" on a sighting,
 * 0 in 288 of 288 traced proposals, hence `driveSize > 0` on 0 of 165 rows and an actor half that
 * never ran. The repair after that was to DERIVE the size from the row's own history, and that was
 * measured too: against a 25% baseline of agendas that can actually complete, the derivation scored
 * 28% precision, which is to say it selected nothing (`entity-table.js` `nominates` carries the full
 * table). It admitted eleven Wuxia shopkeepers and missed `open the sealed door`.
 *
 * So the size stopped being a reading and became an authored fact: `nominationAsks` below shortlists
 * candidates, the model judges them on this same probe, and `world.js` writes the answer to the row.
 * A stored size is now the ONLY source, which is what makes this expression simple again, and it is
 * also why the 40 rows carrying a literal `driveSize: 0` are correctly skipped here while
 * `needsDriveJudgement` still re-nominates them: absence of a judgement is tracked in `driveAsked`,
 * not inferred from the size.
 *
 * And the point-of-view character is not part of the world that moves without you.
 *
 * The player's own row is on the cast with a `wants` and a span of up to 192 turns, which makes it
 * one of the strongest-scoring rows there is, it would sort to the FRONT of the queue and the
 * model would be asked what the player got up to while the player was away. That is not an
 * off-screen world turn; it is the extension writing the player's actions for them. Matched on the
 * canonical key over `name` and every `aka` the row answers to, because the pov is stored as a
 * display name and the row that IS the pov is exactly the row most likely to have collected
 * aliases.
 *
 * @param {object} params Parameters.
 * @param {Map<string, object>} [params.entities] The cast table.
 * @param {Array<object>} [params.threads] Thread rows, as `threads()` returns them.
 * @param {number} [params.turn] Current turn, for ordering.
 * @param {string} [params.pov] The point-of-view character's name, excluded from the queue. Passed
 *   in rather than read, because this is the pure half, `state.js` is the app-coupled side and an
 *   import of it here would make this file untestable and cyclic.
 * @returns {Array<object>} Eligible agendas, most-neglected first.
 */
export function worldAsks({ entities = new Map(), threads = [], turn = 0, pov = '' } = {}) {
    const asks = [];
    const player = normalizeEntityName(pov)?.key ?? '';

    for (const [key, row] of table_entries(entities)) {
        const named = splitEntityKey(key);
        if (!ACTOR_KINDS.includes(named.kind)) {
            continue;
        }
        // The key's own name half as well as the row's aliases: a row reached under an alias is
        // stored under whichever spelling opened it, so neither side alone catches every shape.
        if (player && (named.name === player || aliasKeys(row).includes(player))) {
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
 * The agendas this pass will ask the model to JUDGE, with the evidence each judgement needs.
 *
 * A different question, asked at a different time, about a pre-filtered candidate.
 *
 * The retired `drive_size` property asked "does this person have a long-running ambition?" on a
 * sighting and got 0 in 288 of 288 traced proposals. This is not that question re-opened. Three
 * things changed and each one is load-bearing:
 *
 *   · WHEN. Asked on an armed pass, a declared time skip, about somebody the story has already
 *     returned to for `DRIVE_SPAN` turns, rather than the turn they walked on.
 *   · WHAT. "Does this agenda complete?" rather than "how many steps is it?" A shopkeeper's answer
 *     is `false` and that is a real, expected answer rather than a shrug, see `instruction`.
 *   · WITH WHAT. The line carries the evidence: how long the agenda has held and whether it has been
 *     restated. A model asked "does `Run her inn` complete, held unchanged for 55 turns" has the
 *     fact that made the question answerable, which the sighting probe never did.
 *
 * The candidate set comes from `entity-table.js` `nominates`, which optimises for recall on purpose
 *, arithmetic cannot tell a routine from an ambition (25% baseline, no gate above 39%), so it does
 * not try, and hands over a generous shortlist instead. `needsDriveJudgement` is what keeps that
 * shortlist from being asked twice.
 *
 * The pov is excluded here for the same reason it is in `worldAsks` and one more: the player's own
 * `wants` is the most quest-shaped string on the cast, so it would be judged `true` with a long size
 * and then the world turn would start advancing the protagonist's personal quest off-screen.
 *
 * @param {object} params Parameters.
 * @param {Map<string, object>} [params.entities] The cast table.
 * @param {number} [params.turn] Current turn, for ordering.
 * @param {string} [params.pov] The point-of-view character's name, excluded.
 * @param {number} [params.budget] How many to pose. Defaults to `MAX_NOMINATIONS`.
 * @returns {Array<object>} Candidates, most-neglected first.
 */
export function nominationAsks({ entities = new Map(), turn = 0, pov = '', budget = MAX_NOMINATIONS } = {}) {
    const player = normalizeEntityName(pov)?.key ?? '';
    const asks = [];

    for (const [key, row] of table_entries(entities)) {
        const named = splitEntityKey(key);
        if (!ACTOR_KINDS.includes(named.kind)) {
            continue;
        }
        if (player && (named.name === player || aliasKeys(row).includes(player))) {
            continue;
        }
        if (!needsDriveJudgement(row)) {
            continue;
        }
        asks.push({
            kind: 'nomination',
            key,
            name: String(row?.name ?? ''),
            about: String(row?.wants ?? ''),
            // The evidence, as two facts rather than a sentence: how long this has held, and
            // whether it is the same wording throughout. `worldBlock` turns them into the phrase.
            span: agendaSpan(row),
            steady: agendaStable(row),
            age: Math.max(0, turn - (Number(row?.turn) || 0)),
        });
    }

    return asks
        .filter(ask => ask.key && ask.name && ask.about)
        .sort((a, b) => b.age - a.age || b.span - a.span || a.name.localeCompare(b.name))
        .slice(0, Math.max(0, budget));
}

/**
 * Render the off-screen turn as numbered lines the model files against.
 *
 * The measurement this replaces an open invitation with.
 *
 * The probe used to be handed a free `moves` array and asked what advanced. Across a completed
 * campaign it was armed 107 times by real elapsed spans and returned an empty list 107 times, with
 * zero rejections, the model never proposed anything for a gate to refuse. In the same campaign,
 * on the same passes, the review's numbered disposition lines drew 3319 answers.
 *
 * The difference is not the model and not the subject. A form gets filled in and an open question
 * gets skipped, and the schema made skipping free: `moves: []` is always valid, and the instruction
 * spent two of its six clauses granting permission to use it.
 *
 * So the world turn is a form now. One line per agenda, each with an id, and an answer per id.
 *
 * Addressing by id retires `unrooted-move`.
 *
 * The old shape asked the model to NAME its actor, which meant a name could miss, the whole point
 * of the rootedness rule and its `unrooted-move` refusal. An id can only come from the block fold
 * just printed, so an unrooted move is no longer refused, it is unsayable. That is the class made
 * impossible by construction rather than caught by a gate, and it is why the rule leaves with the
 * shape that needed it. `unknown-id` remains for a garbled or invented id, which is a different and
 * much narrower failure.
 *
 * Two sections, two prefixes, one index.
 *
 * The second section asks a different question about a different set of rows: not "did this
 * advance" but "is this a standing agenda at all, and how long is it". They share a block because
 * they share an armed pass and §11 forbids a second extraction call, and they share an index
 * because `W` and `N` cannot collide, an id names its own section, so `planWorld` and
 * `planNominations` each read only what belongs to them.
 *
 * That part works. Measured over 19 traced passes where both sections were on the page: zero
 * cross-filed ids, in either direction. The prefixes are doing their job and the sections do not
 * need separating, merging or re-tokenising.
 *
 * An empty section still renders, and that is the whole fix.
 *
 * What did not work was a section being ABSENT. `schema()` requires both arrays on every pass and
 * `instruction()` describes both blocks on every pass, so a pass with nothing to nominate told the
 * model to answer a block it could not find, and it answered anyway, 13 times out of 69, with
 * invented `N` ids or with the `W` ids copied down. See `NO_LINES` for the full count.
 *
 * So both headings print whenever the block prints at all, and the one with no rows says so in the
 * words the instruction and the schema both quote. A campaign whose whole cast has been judged now
 * shows an empty STANDING AGENDAS heading rather than no heading; a campaign with no sized drives
 * yet, the state every chat in the corpus starts in, shows an empty WHAT MOVED heading.
 *
 * When BOTH are empty nothing renders and the probe is silent, which is 1765 of the 1855 traced
 * passes. The two extra lines are paid only on the ~5% that ask anything.
 *
 * @param {object} params Parameters.
 * @param {Array<object>} [params.asks] Rows from `worldAsks`.
 * @param {Array<object>} [params.nominations] Rows from `nominationAsks`.
 * @param {string} [params.elapsed] How much time the excerpt says passed, for the heading.
 * @returns {{text: string, index: Map<string, object>}} The block and its id lookup.
 */
export function worldBlock({ asks = [], nominations = [], elapsed = '' } = {}) {
    const index = new Map();

    // Nothing to ask on either side: the probe says nothing at all. `context()` filters '' out, so
    // the 1765 passes with no agendas and no candidates pay nothing for the block OR the markers.
    if (!asks.length && !nominations.length) {
        return { text: '', index };
    }

    const advances = asks.map((ask, at) => {
        const id = `${ASK_PREFIX}${at + 1}`;
        index.set(id, { ...ask, id });
        const face = ask.kind === 'actor' ? 'drive' : (ask.polarity || 'dial');
        const about = ask.about ? `, ${ask.about}` : '';
        return `  ${id} [${face} ${ask.filled}/${ask.size}] ${ask.name}${about}`;
    });

    const judgements = nominations.map((ask, at) => {
        const id = `${NOMINATE_PREFIX}${at + 1}`;
        index.set(id, { ...ask, id });
        // The evidence is the whole difference between this question and the one that got 288
        // zeros. "Held unchanged for 40 turns" is the fact that makes standing-ness observable;
        // "restated since" is the honest version for a row whose `wants` has been re-worded,
        // and saying so is better than printing a number the trail contradicts.
        const held = ask.steady
            ? `held unchanged for ${ask.span} turns`
            : `on the cast ${ask.span} turns, restated since`;
        return `  ${id} ${ask.name}, "${ask.about}" (${held})`;
    });

    const span = String(elapsed ?? '').trim();
    return {
        text: [
            [
                `WHAT MOVED WHILE YOU WERE AWAY${span ? ` (${span})` : ''}`,
                ...(advances.length ? advances : [noLines('advances')]),
            ].join('\n'),
            [
                'STANDING AGENDAS, DOES THIS COMPLETE?',
                ...(judgements.length ? judgements : [noLines('nominations')]),
            ].join('\n'),
        ].join('\n\n'),
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
        // The index carries both sections. An advance quoting an `N` id is answering the OTHER
        // question, "does this complete", and taking it would tick a drive on the strength of a
        // judgement about whether the drive should exist. The prefix makes that detectable rather
        // than plausible, the same way `planNominations` refuses a `W` id.
        if (!ask || ask.kind === 'nomination') {
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
            // must be GIVEN, an absent array no longer stands in for "I considered them all".
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


/**
 * Turn the answered nominations into the drive judgements fold will store.
 *
 * Every answer is a result, including the negative one.
 *
 * `completes: false` is not a refusal and is not dropped: it is the answer that says "this is a
 * routine", and it has to be RECORDED or the same shopkeeper is nominated again on the next skip
 * forever. So a false lands in `accepted` with `size: 0`, and `world.js` writes `driveAsked` for it
 * without writing a size. The distinction the caller acts on is `size`, not acceptance.
 *
 * This is the same shape `planWorld` uses for `tick: 0`, a first-class answer rather than silence,
 * and for the same reason: the failure being designed against is a model that finds it cheaper to
 * say nothing, and a schema where saying nothing is free will get exactly that (288 zeros, 107
 * empty `moves` arrays).
 *
 * What is refused.
 *
 * An id the block never printed, an id answered twice, and a `completes: true` whose step count is
 * unusable. The last one matters: a true with 0 steps is a drive with no length, which `foldEntity`
 * would clamp to 2 and quietly invent an agenda the model did not size. Refusing it leaves the row
 * unjudged so the next armed pass can ask again, which is the honest outcome for a garbled answer.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} params Parameters.
 * @param {Map<string, object>} params.index The id lookup `worldBlock` returned.
 * @param {string} [params.windowText] Narrative window, for the diagnostics snippet.
 * @returns {{accepted: Array<object>, rejected: Array<object>}} Judgements to store, and refusals.
 */
export function planNominations(fragment, { index = new Map(), windowText = '' } = {}) {
    const accepted = [];
    const rejected = [];
    const snippet = windowSnippet(windowText);
    const answered = new Set();

    for (const verdict of Array.isArray(fragment?.nominations) ? fragment.nominations : []) {
        const id = String(verdict?.id ?? '').trim().toUpperCase();
        const ask = index.get(id);
        // `index` carries both sections. A nomination answer quoting a `W` id is answering the
        // wrong question, and the prefix is what makes that detectable rather than plausible.
        //
        // This gate was never the bug, and it is not being loosened.
        //
        // It refused 16 answers in the live Wuxia chat, 31% of that chat's refusals, and every one
        // of them deserved it: all 16 arrived on passes where no STANDING AGENDAS rows were posed
        // (`NO_LINES` has the trace counts), so they were about nothing, 20 invented `N` ids and
        // 18 `W` ids copied down from the other block, corpus-wide. There is no answer here to
        // recover and no write that was wrongly withheld. The remedy is upstream, in the block that
        // now prints an empty section rather than vanishing; this stays exactly as strict, because
        // a prompt line is trusted for nothing (§6) and the next model will find a new way to be
        // creative.
        if (!ask || ask.kind !== 'nomination') {
            rejected.push({ item: id || String(verdict?.id ?? ''), reason: 'unknown-id', raw: verdict, snippet });
            continue;
        }
        if (answered.has(id)) {
            rejected.push({ item: id, reason: 'duplicate-id', raw: verdict, snippet });
            continue;
        }
        answered.add(id);

        if (verdict?.completes !== true) {
            // A routine. Recorded so it stops being asked, with no size, the row keeps whatever
            // `driveSize` it had, which for every row reaching here is nothing or a legacy zero.
            accepted.push({ id, key: ask.key, name: ask.name, about: ask.about, completes: false, size: 0 });
            continue;
        }

        // Below the floor is clamped, exactly as above the ceiling already was.
        //
        // This refused anything under two and re-sought the answer. Measured across 143 nomination
        // answers on record, that produced seven refusals, and all seven fall in three CONSECUTIVE
        // passes (mids 246, 248, 250) against slots N1/N2/N3, which is not seven judgements, it is
        // two or three rows asked over and over. A refusal never reaches `entities.judgeDrive`
        // (`world.js`), so `driveAsked` is never stamped, so `needsDriveJudgement` answers true
        // again on the next armed pass, forever. The queue could not drain past them.
        //
        // That also contradicted this file's own rule one branch down, "Clamped rather than
        // refused at the top end: a model that says 40 has answered the question correctly and
        // overshot the scale". A model that says 1 has answered correctly and UNDERSHOT it. Same
        // class of error, and it was handled two different ways.
        //
        // So `1` clamps up to the floor the schema declares, and the judgement it carries survives.
        const steps = Math.trunc(Number(verdict?.steps) || 0);
        if (steps <= 0) {
            // Zero or less WHILE claiming it completes is not an undershoot, it is a contradiction:
            // the schema spends `0` on "does not complete", so the two fields disagree. Recorded as
            // a routine, no drive invented out of an answer that argues with itself, but recorded,
            // which is the part that matters. `driveAsked` remembers the question, not just a
            // positive answer, and a row nobody stamps is a row asked about for the life of the
            // campaign.
            accepted.push({ id, key: ask.key, name: ask.name, about: ask.about, completes: false, size: 0, contradictory: true });
            continue;
        }

        accepted.push({
            id,
            key: ask.key,
            name: ask.name,
            about: ask.about,
            completes: true,
            // Clamped at BOTH ends, and the argument is the same one in both directions: a model
            // that says 40 has answered the question correctly and overshot the scale; a model that
            // says 1 has answered correctly and undershot it. Neither is a failure to understand
            // the question, so neither costs the answer.
            size: Math.min(MAX_DRIVE, Math.max(MIN_DRIVE, steps)),
        });
    }

    return { accepted, rejected };
}
