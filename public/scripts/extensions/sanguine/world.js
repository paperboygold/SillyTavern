/**
 * fold/world.js: the off-screen world-turn, wired to storage and the extraction pass.
 *
 * The pure logic, the schema, the instruction, the rooted-move validation, is in `world-table.js`;
 * this half owns the armed gate, the chronicle writes and the counters. FOLD-REDESIGN.md §7.
 *
 * Why the world fragment rides the existing call and is armed in code.
 *
 * §11 forbids a second extraction call; §7.4 arms the world fragment "only when the pass was
 * triggered by a time skip or scene break". The trigger reason arrives in the pass context as `why`
 * (the same `why` the caller already counted as `extract:on-time-skipped` / `extract:on-scene-break`),
 * and `WORLD_TRIGGERS` is the one definition of those reasons, imported from `trigger-table.js`
 * because a reason compared by literal in two files is a feature that breaks silently on a reword.
 *
 * The schema is always present, the model returns `world: {moves: []}` every pass, but the
 * instruction tells it to fill moves only on elapsed time, and `apply` ignores anything proposed on
 * an unarmed pass. A prompt line is trusted for nothing (§6); the code gate is what stops an unarmed
 * pass from writing world.
 */

import { instruction as worldInstruction, nominationAsks, planNominations, planWorld, schema as worldSchema, worldAsks, worldBlock } from './world-table.js';
import { WORLD_TRIGGERS } from './trigger-table.js';
import { HIDDEN, threads as threadRows } from './thread-table.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as observe from './observe.js';

/**
 * The block this pass actually posed, kept from `context()` for `applyExtraction` to resolve against.
 *
 * The rebuild was not deterministic, and the arithmetic says so.
 *
 * `applyExtraction` used to rebuild the ask list from the live tables and trust that `W3` still
 * named the same row. Two things break that between the question going out and the answer coming
 * back, and both are in the code rather than hypothetical:
 *
 *   · THE TURN MOVES. `context()` orders by `age` computed from `entities.turn()`; `extract.js:587`
 *     then runs `const turn = entities.advanceTurn()` AFTER the model call and hands that number to
 *     every `apply`. So the rebuild sorts on `turn + 1`. Actor age is `turn - row.turn` and thread
 *     age is `thread.stale`, which does not move with the turn, so the +1 shifts actors past
 *     threads they were tied with, and a mixed queue re-orders. `W2` and `W3` swap rows.
 *
 *   · THE TABLE MOVES. The cast probe is registered BEFORE this one (`index.js`), so
 *     `entities.applyExtraction` has already folded this pass's sightings by the time the world
 *     probe applies. `merge_entity` last-writes `turn`, which resets a sighted row's age to 0 and
 *     sends it to the back of both queues; `first`/`turn` widen `agendaSpan`, which can push a row
 *     over `DRIVE_SPAN` and ADD it to `nominationAsks`; and a new `wants` trail entry can flip
 *     `needsDriveJudgement`. Membership and order both change under the ids.
 *
 * A shifted index is silent: every id still resolves, so nothing is refused and the tick lands on
 * the neighbouring actor. That is strictly worse than the `unknown-id` this module was being blamed
 * for, which at least refuses. It has not been caught in the traces because every advance in the
 * corpus answered `tick: 0`: there is no write yet for the shift to corrupt, and that is luck, not
 * safety.
 *
 * So the index the model was shown is the index its answer is read against. This is the shape
 * `extract.js` already uses for the review probe, "the id index the pinned block built this pass…
 * only the caller that built the prompt knows which lines those were or what ids they carried",
 * held here rather than threaded, because `registerProbe`'s `context()` hook returns a string and
 * generalising it to return an index would change every probe for one caller's benefit.
 *
 * Safe as module state because `extract.js` holds a `busy` flag: one extraction at a time, and
 * `context()` runs on every pass that reaches prompt assembly, so the stash is refreshed before it
 * is read. `applyExtraction` falls back to a rebuild when there is none, direct callers (tests,
 * replay) never posed a block, and rebuilding is what they already expected.
 *
 * @type {{index: Map<string, object>, nominated: number}|null}
 */
let posed = null;

/** @returns {object} A JSON Schema fragment. */
export function schema() {
    return worldSchema();
}

/** @returns {string} Prompt guidance for the probe. */
export function instruction() {
    return worldInstruction();
}

/**
 * The per-pass half: the numbered lines this pass is asking about.
 *
 * Lives in `context()` rather than `instruction()` for the reason `registerProbe` documents, the
 * instruction is 90% byte-identical across passes and a prefix cache is all-or-nothing up to its
 * breakpoint, so anything interpolated per pass belongs below it. These lines change whenever an
 * agenda moves, which is exactly the shape that would otherwise cost the whole block every turn.
 *
 * Rendered on every pass, not only armed ones. `context()` has no access to the trigger reason, and
 * the alternative, plumbing `why` up into prompt assembly, would buy a few lines of prompt at the
 * cost of a new coupling. The instruction already tells the model to judge only the span the
 * excerpt declares, and `applyExtraction` discards anything answered on an unarmed pass regardless,
 * so a conversational turn that answers the block changes nothing.
 *
 * `pov` arrives as an argument, and must be the SAME argument `applyExtraction` gets.
 *
 * The point-of-view character is skipped (`world-table.js` `worldAsks`), and the exclusion has to
 * be identical on both sides of the round trip. Pose the block with a pov and read the answer
 * without one, and `W3` addresses a different row coming back than it did going out: every answer
 * after the player's row silently shifts by one and the world turn advances the wrong actors.
 *
 * The index this call builds is now HELD (`posed`) and handed to `applyExtraction` directly, which
 * closes that hole and two larger ones the rebuild had, the turn advancing between the calls, and
 * the cast probe folding sightings before this probe applies. `pov` still has to match on the
 * fallback path, where a direct caller rebuilds. That is a correctness requirement, not tidiness.
 *
 * Passed in rather than imported. `state.js` owns `pov()` and importing it here would couple the
 * world turn to the store for one string; `why`, `turn`, `sources` and `windowText` all already
 * travel this way.
 *
 * @param {string} [pov] The point-of-view character's name, excluded from the queue.
 * @returns {string} The block, or '' when no agenda is eligible.
 */
/*
 * `clocks.view()` is a Map, and `worldAsks` requires an Array.
 *
 * `world-table.js` reads its thread half as `for (const thread of Array.isArray(threads) ? threads
 * : [])`. `clocks.view()` returns `overlayClosures(load(), …)`: a Map. So the guard was false on
 * every call this module has ever made, and the thread half of the world block was skipped
 * silently, for the whole life of the feature.
 *
 * Measured before the fix, across 21 live chats and 293 traced extraction passes: the instruction
 * prose "WHAT MOVED WHILE YOU WERE AWAY" appears in all 293 prompts and the block's own row marker
 * `W1 [` appears in ZERO of them. `worldBlock` returned '' every time; `world.advances` came back
 * empty 293/293; and five counters (`world:moved`, `:placed`, `:ticked`, `:achieved`, `:declined`)
 * have never fired. `world:idle` at 292 was counting an empty form.
 *
 * This is why the audit's "the world turn is inert, delete it" was the wrong conclusion from the
 * right measurement: the feature has never once been given its input. `threads()` is the array
 * producer over the same table, and it attaches the `key` and `dial` that `worldAsks` reads.
 */
export function context(pov = '') {
    const turn = entities.turn();
    const table = entities.load();
    const asks = worldAsks({ entities: table, threads: threadRows(clocks.view(), turn), turn, pov });
    const nominations = nominationAsks({ entities: table, turn, pov });
    const { text, index } = worldBlock({ asks, nominations });
    // Held for `applyExtraction`, which must resolve the answer against the lines that were shown
    // and not against a table two probes have written to since, see `posed`. `nominated` travels
    // with it because `world:nominated` counts what was ASKED, which is a property of the block.
    posed = { index, nominated: nominations.length };
    return text;
}

/**
 * Forget the posed block.
 *
 * For tests and for any caller that wants `applyExtraction` back on its rebuild path. Nothing in
 * the extension calls it, `context()` overwrites the stash on every pass.
 */
export function forgetBlock() {
    posed = null;
}

/**
 * Apply a world fragment.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {string} [context.why] The reason this pass ran, armed when it is a `WORLD_TRIGGERS` entry.
 * @param {string} [context.pov] The point-of-view character's name. Used only on the fallback
 *   rebuild path (no block was posed); when it is used it MUST be the same value `context()` was
 *   called with, or the ids will not mean the same rows, see `posed` and `context()`.
 * @returns {{accepted: number, rejected: object[], armed: boolean}} What was applied.
 */
export function applyExtraction(fragment, { why = '', turn = 0, sources = [], windowText = '', pov = '' } = {}) {
    const armed = WORLD_TRIGGERS.includes(why);

    // Not armed: the fragment is expected empty. Anything the model proposed here was proposed on a
    // conversational turn with no declared elapse, and writing it would be the world moving on a
    // turn the story said nothing moved, the exact `extract:on-interval`-is-not-elapsed trap.
    if (!armed) {
        if (Array.isArray(fragment?.advances) && fragment.advances.some(a => Number(a?.tick) > 0)) {
            observe.note('world:unarmed');
        } else {
            observe.note('world:idle');
        }
        return { accepted: 0, rejected: [], armed: false };
    }

    // The ids are resolved against the block that was POSED, not against a fresh rebuild.
    //
    // This used to rebuild the ask list here and trust that `worldAsks` was deterministic across
    // the round trip. It is not: the turn counter advances between the two calls and the cast probe
    // folds this pass's sightings before this one runs, so both the ORDER and the MEMBERSHIP of the
    // queue can differ from what the model was shown. `posed` carries the whole argument.
    //
    // The rebuild survives as the fallback for callers that never posed a block, a test or a
    // replay driving `applyExtraction` directly, and it is what they already got. The `pov`
    // argument still matters on that path for the reason it always did: filter one rebuild and not
    // the other and the player's row rejoins the list, shifting every id after it by one.
    let index = posed?.index;
    let nominated = posed?.nominated ?? 0;
    if (!index) {
        const table = entities.load();
        const asks = worldAsks({ entities: table, threads: threadRows(clocks.view(), turn), turn, pov });
        const nominations = nominationAsks({ entities: table, turn, pov });
        index = worldBlock({ asks, nominations }).index;
        nominated = nominations.length;
    }
    const { accepted, rejected: refused, declined } = planWorld(fragment, { index, windowText });
    const judged = planNominations(fragment, { index, windowText });
    // Anchored here, RECORDED by the caller, see `clocks.js` for the full account.
    //
    // Same double-count this probe shared with the thread and cast probes: this file called
    // `observe.noteRejections` directly AND `index.js` called `state.noteRejections` on the
    // `rejected` this function returns, which forwards to `observe.noteRejections` again. Two
    // increments and two log lines per refusal, against one for the state probe. The anchor is
    // still made here, nothing downstream knows which message this pass read, but it now travels
    // out on the returned rows instead of being written from here, so `state.noteRejections` is the
    // single recorder and `state.rejects` (the panel's table) stops missing world refusals.
    const mid = (sources ?? [])[sources.length - 1]?.mid;
    const rejected = [...refused, ...judged.rejected].map(rejection => ({ ...rejection, mid, turn }));

    // World moves land as ordinary ledger events (`src: 'world'`), so they fold forward, surface in
    // recall, and stay auditable like everything else (§7.3). The summary is the assertion the model
    // made; the keywords are the actor and the place, so a later scene set there can callback to it.
    // `seen`/`where` ride the delta so the reveal contract (`world-table.js` `renderWorldEvents`)
    // can tell the narrator what the character could and could not know (§7.5). The fold ignores a
    // `world`-only delta, no `inv`/`st`, so it mutates nothing, but `hasDelta` keeps the event
    // from being the first evicted, which is the right priority for recent world motion. The state
    // change that makes an OPEN move real is the `setPlace` below, not this record.
    let placed = 0;
    let ticked = 0;
    for (const move of accepted) {
        const summary = `${move.who} ${move.what}`.trim();
        const keywords = [move.who, move.where].filter(Boolean);
        chronicle.recordWorldEvent({
            summary,
            keywords,
            delta: { world: { who: move.who, where: move.where, seen: move.seen } },
        });

        // An OPEN move updates where the person IS, which is the difference between the world
        //    moving and the world being narrated at.
        //
        // The event above is a record; this is the state change. Without it a faction agent could
        // cross the map every session and their cast row would still say where they stood in act
        // one, so the presence predicate, the pinned block and the panel all keep describing a
        // world that stopped. `planWorld` has already resolved `who` to a real cast row and hands
        // back its key, and `setPlace` folds through `foldEntity`, so this is a versioned write to
        // fold's own table, no prose is read here or anywhere upstream of it.
        //
        // HIDDEN moves are deliberately NOT written, and this is the reveal contract rather than
        // caution. `renderWorldEvents` exists to tell the narrator what the pov could and could not
        // know; a hidden move whose destination landed on the cast row would appear in the panel the
        // player reads and in the block the narrator writes from, which is precisely the leak the
        // `seen` field was added to prevent. The move is still recorded, still recalled, and still
        // reaches the narrator through the contract, it just does not become common knowledge.
        if (move.seen !== HIDDEN && move.where && entities.setPlace(move.root, move.where, turn)) {
            placed++;
        }

        // The advance itself: an integer that survives the scene it happened in.
        //
        // Recording the event and moving nothing is what the old shape did, and it is why a year of
        // estate production left the record holding a summary and no state. A tick lands on the
        // dial the line was posed FROM, a `drive` on a cast row, or the thread dial that already
        // has ticking, firing and closing built (`clocks.js`). Neither path is new machinery; the
        // world turn simply became a caller of both.
        //
        // A HIDDEN move still ticks. `seen` governs what the NARRATOR may assert to the player, not
        // whether the world is allowed to happen, a guild that only moves when you are watching is
        // the thing this subsystem exists to stop being true.
        const moved = move.kind === 'actor'
            ? entities.advanceDrive(move.root, move.tick, turn)
            : clocks.advance(move.root, move.tick, turn);
        if (moved) {
            ticked++;
            if (moved.full) {
                // A full agenda is a story beat, not a table operation: the narrator has to reckon
                // with a faction that finished what it set out to do. Counted here and left for the
                // pinned block to surface, exactly as a filled dial already is.
                observe.note('world:achieved');
            }
        }
    }

    if (placed) {
        observe.note('world:placed', placed);
    }
    if (ticked) {
        observe.note('world:ticked', ticked);
    }
    // Split from `world:idle` deliberately. Idle meant two different things, nobody asked, and
    // nobody answered, and the campaign that motivated this could not tell them apart: 192 idles
    // covering 107 armed passes that returned nothing and 85 unarmed ones that were never meant to.
    // `declined` is the honest count of "asked, and the model said nothing moved".
    if (declined) {
        observe.note('world:declined', declined);
    }
    // The judgements, applied immediately and visibly rather than behind an approval.
    //
    // The plan reserved a landing spot for model-proposed rates "suspended behind a ticked diff",
    // and the corpus argued against it. `reconcile` is the one pass built that way, and across every
    // live chat its counters read `asked: 80, declined: 2` with no `applied` at all, two runs in
    // the entire record, both cancelled. A second approval surface would be a second unused one, and
    // a drive that has to be confirmed is a drive that never exists.
    //
    // So a judgement takes effect on the pass that made it. What makes that safe is not a gate, it
    // is reversibility and visibility: the size lands on the cast row where the panel renders it,
    // the Entities tab can edit or zero it, and the write goes through the ordinary fold, so a
    // swipe undoes it exactly like any other extraction result.
    //
    // `completes: false` is written too, with no size. That is the answer meaning "this is a
    // routine", and recording it is what stops the same shopkeeper being re-posed on every skip for
    // the life of the campaign, `driveAsked` remembers the QUESTION, not just a positive answer.
    let sized = 0;
    let routine = 0;
    let unsized = 0;
    for (const verdict of judged.accepted) {
        if (!entities.judgeDrive(verdict.key, { size: verdict.size, at: turn })) {
            continue;
        }
        if (verdict.completes) {
            sized++;
        } else if (verdict.contradictory) {
            // Said it completes and then gave it no length. Filed as a routine because that is what
            // the record can safely hold, but counted apart from one: a real routine is the model
            // judging well, and this is the model disagreeing with itself. Reading them as one
            // number would let the second hide inside the first, which is how `drive_size: 0`
            // stayed invisible for 288 passes.
            unsized++;
        } else {
            routine++;
        }
    }
    if (nominated) {
        observe.note('world:nominated', nominated);
    }
    if (sized) {
        observe.note('world:sized', sized);
    }
    if (routine) {
        // Counted rather than treated as a non-event. The failure this whole shape is designed
        // against is a model that finds silence cheaper than an answer, and its mirror image is a
        // model that rubber-stamps `true`. A healthy ratio here, most nominations coming back
        // false, matching the corpus's 25% terminal rate, is the evidence the taxonomy is landing.
        observe.note('world:routine', routine);
    }
    if (unsized) {
        observe.note('world:unsized', unsized);
    }
    observe.note(accepted.length ? 'world:moved' : 'world:idle');
    return { accepted: accepted.length, rejected, armed: true, placed, ticked, declined, sized, routine, unsized };
}
