/**
 * fold/world.js — the off-screen world-turn, wired to storage and the extraction pass.
 *
 * The pure logic — the schema, the instruction, the rooted-move validation — is in `world-table.js`;
 * this half owns the armed gate, the chronicle writes and the counters. FOLD-REDESIGN.md §7.
 *
 * ── Why the world fragment rides the existing call and is armed in code ──
 *
 * §11 forbids a second extraction call; §7.4 arms the world fragment "only when the pass was
 * triggered by a time skip or scene break". The trigger reason arrives in the pass context as `why`
 * (the same `why` the caller already counted as `extract:on-time-skipped` / `extract:on-scene-break`),
 * and `WORLD_TRIGGERS` is the one definition of those reasons, imported from `trigger-table.js`
 * because a reason compared by literal in two files is a feature that breaks silently on a reword.
 *
 * The schema is always present — the model returns `world: {moves: []}` every pass — but the
 * instruction tells it to fill moves only on elapsed time, and `apply` ignores anything proposed on
 * an unarmed pass. A prompt line is trusted for nothing (§6); the code gate is what stops an unarmed
 * pass from writing world.
 */

import { instruction as worldInstruction, planWorld, schema as worldSchema, worldAsks, worldBlock } from './world-table.js';
import { WORLD_TRIGGERS } from './trigger-table.js';
import { HIDDEN } from './thread-table.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as observe from './observe.js';

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
 * Lives in `context()` rather than `instruction()` for the reason `registerProbe` documents — the
 * instruction is 90% byte-identical across passes and a prefix cache is all-or-nothing up to its
 * breakpoint, so anything interpolated per pass belongs below it. These lines change whenever an
 * agenda moves, which is exactly the shape that would otherwise cost the whole block every turn.
 *
 * Rendered on every pass, not only armed ones. `context()` has no access to the trigger reason, and
 * the alternative — plumbing `why` up into prompt assembly — would buy a few lines of prompt at the
 * cost of a new coupling. The instruction already tells the model to judge only the span the
 * excerpt declares, and `applyExtraction` discards anything answered on an unarmed pass regardless,
 * so a conversational turn that answers the block changes nothing.
 *
 * @returns {string} The block, or '' when no agenda is eligible.
 */
export function context() {
    const asks = worldAsks({ entities: entities.load(), threads: clocks.view(), turn: entities.turn() });
    return worldBlock({ asks }).text;
}

/**
 * Apply a world fragment.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {string} [context.why] The reason this pass ran — armed when it is a `WORLD_TRIGGERS` entry.
 * @returns {{accepted: number, rejected: object[], armed: boolean}} What was applied.
 */
export function applyExtraction(fragment, { why = '', turn = 0, sources = [], windowText = '' } = {}) {
    const armed = WORLD_TRIGGERS.includes(why);

    // Not armed: the fragment is expected empty. Anything the model proposed here was proposed on a
    // conversational turn with no declared elapse, and writing it would be the world moving on a
    // turn the story said nothing moved — the exact `extract:on-interval`-is-not-elapsed trap.
    if (!armed) {
        if (Array.isArray(fragment?.advances) && fragment.advances.some(a => Number(a?.tick) > 0)) {
            observe.note('world:unarmed');
        } else {
            observe.note('world:idle');
        }
        return { accepted: 0, rejected: [], armed: false };
    }

    // ── The block is rebuilt here, and that is what makes an id trustworthy ──
    //
    // `worldAsks` is deterministic over the same tables the prompt was rendered from, so `W3` means
    // the same row when the answer comes back as it did when the question went out. Rebuilding
    // rather than stashing the index keeps this pass stateless the way every other probe is: there
    // is nothing to go stale between the ask and the answer.
    const { index } = worldBlock({ asks: worldAsks({ entities: entities.load(), threads: clocks.view(), turn }) });
    const { accepted, rejected, declined } = planWorld(fragment, { index, windowText });
    // Anchor refusals to the newest message the pass read, for the log's cause-link.
    observe.noteRejections(rejected.map(rejection => ({
        ...rejection,
        mid: (sources ?? [])[sources.length - 1]?.mid,
        turn,
    })));

    // World moves land as ordinary ledger events (`src: 'world'`), so they fold forward, surface in
    // recall, and stay auditable like everything else (§7.3). The summary is the assertion the model
    // made; the keywords are the actor and the place, so a later scene set there can callback to it.
    // `seen`/`where` ride the delta so the reveal contract (`world-table.js` `renderWorldEvents`)
    // can tell the narrator what the character could and could not know (§7.5). The fold ignores a
    // `world`-only delta — no `inv`/`st`, so it mutates nothing — but `hasDelta` keeps the event
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

        // ── An OPEN move updates where the person IS, which is the difference between the world
        //    moving and the world being narrated at ──
        //
        // The event above is a record; this is the state change. Without it a faction agent could
        // cross the map every session and their cast row would still say where they stood in act
        // one, so the presence predicate, the pinned block and the panel all keep describing a
        // world that stopped. `planWorld` has already resolved `who` to a real cast row and hands
        // back its key, and `setPlace` folds through `foldEntity`, so this is a versioned write to
        // fold's own table — no prose is read here or anywhere upstream of it.
        //
        // HIDDEN moves are deliberately NOT written, and this is the reveal contract rather than
        // caution. `renderWorldEvents` exists to tell the narrator what the pov could and could not
        // know; a hidden move whose destination landed on the cast row would appear in the panel the
        // player reads and in the block the narrator writes from, which is precisely the leak the
        // `seen` field was added to prevent. The move is still recorded, still recalled, and still
        // reaches the narrator through the contract — it just does not become common knowledge.
        if (move.seen !== HIDDEN && move.where && entities.setPlace(move.root, move.where, turn)) {
            placed++;
        }

        // ── The advance itself: an integer that survives the scene it happened in ──
        //
        // Recording the event and moving nothing is what the old shape did, and it is why a year of
        // estate production left the record holding a summary and no state. A tick lands on the
        // dial the line was posed FROM — a `drive` on a cast row, or the thread dial that already
        // has ticking, firing and closing built (`clocks.js`). Neither path is new machinery; the
        // world turn simply became a caller of both.
        //
        // A HIDDEN move still ticks. `seen` governs what the NARRATOR may assert to the player, not
        // whether the world is allowed to happen — a guild that only moves when you are watching is
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
    // Split from `world:idle` deliberately. Idle meant two different things — nobody asked, and
    // nobody answered — and the campaign that motivated this could not tell them apart: 192 idles
    // covering 107 armed passes that returned nothing and 85 unarmed ones that were never meant to.
    // `declined` is the honest count of "asked, and the model said nothing moved".
    if (declined) {
        observe.note('world:declined', declined);
    }
    observe.note(accepted.length ? 'world:moved' : 'world:idle');
    return { accepted: accepted.length, rejected, armed: true, placed, ticked, declined };
}
