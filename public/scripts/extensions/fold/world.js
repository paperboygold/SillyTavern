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

import { instruction as worldInstruction, planWorld, schema as worldSchema } from './world-table.js';
import { WORLD_TRIGGERS } from './trigger-table.js';
import * as chronicle from './chronicle.js';
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
 * Apply a world fragment.
 *
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {string} [context.why] The reason this pass ran — armed when it is a `WORLD_TRIGGERS` entry.
 * @returns {{accepted: number, rejected: object[], armed: boolean}} What was applied.
 */
export function applyExtraction(fragment, { why = '' } = {}) {
    const armed = WORLD_TRIGGERS.includes(why);

    // Not armed: the fragment is expected empty. Anything the model proposed here was proposed on a
    // conversational turn with no declared elapse, and writing it would be the world moving on a
    // turn the story said nothing moved — the exact `extract:on-interval`-is-not-elapsed trap.
    if (!armed) {
        if (Array.isArray(fragment?.moves) && fragment.moves.length) {
            observe.note('world:unarmed');
        } else {
            observe.note('world:idle');
        }
        return { accepted: 0, rejected: [], armed: false };
    }

    const { accepted, rejected } = planWorld(fragment, { entities: entities.load() });
    observe.noteRejections(rejected);

    // World moves land as ordinary ledger events (`src: 'world'`), so they fold forward, surface in
    // recall, and stay auditable like everything else (§7.3). The summary is the assertion the model
    // made; the keywords are the actor and the place, so a later scene set there can callback to it.
    // `seen`/`where` ride the delta so the reveal contract (`world-table.js` `renderWorldEvents`)
    // can tell the narrator what the character could and could not know (§7.5). The fold ignores a
    // `world`-only delta — no `inv`/`st`, so it mutates nothing — but `hasDelta` keeps the event
    // from being the first evicted, which is the right priority for recent world motion.
    for (const move of accepted) {
        const summary = `${move.who} ${move.what}`.trim();
        const keywords = [move.who, move.where].filter(Boolean);
        chronicle.recordWorldEvent({
            summary,
            keywords,
            delta: { world: { who: move.who, where: move.where, seen: move.seen } },
        });
    }

    observe.note(accepted.length ? 'world:moved' : 'world:idle');
    return { accepted: accepted.length, rejected, armed: true };
}
