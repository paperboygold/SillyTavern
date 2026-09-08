/**
 * fold/absorb.js: taking over the card's own state block.
 *
 * Cards in the simulation genre routinely instruct the narrator to end every reply with a status
 * line. It is a good transport and a bad artefact: the reader did not ask for a spreadsheet, and
 * because SillyTavern builds the prompt from `mes` (display only substitutes `extra.display_text`),
 * every one of those blocks is re-sent on every subsequent turn. Twenty replies in, the model is
 * reading twenty status blocks, nineteen of them stale, and paying for all of them.
 *
 * So fold absorbs it: parse the block, remove it from the message, keep the raw text on the message
 * for recoverability, and let fold's own validated block (one copy, injected at a fixed depth) be
 * the thing the model actually reads.
 *
 * The narrator keeps its continuity. The reader gets prose. The context stops growing.
 */

import { chat, saveChatDebounced, updateMessageBlock } from '../../../script.js';
import { classifyBlock, parseStateBlock, stripStateBlock, restateInventory } from './block-parse.js';
import { SHADOW, routeBlockFields } from './absorb-table.js';
import * as chronicle from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import { table_entries } from './lib/hash.js';
import * as observe from './observe.js';
import { normalizeItemName, splitItemKey, validateInventory } from './state-table.js';
import * as state from './state.js';

/**
 * Absorb the state block from a message: strip it, record it, and fold its contents into state.
 *
 * @param {number} messageId Index into `chat`.
 * @param {object} [options] Options.
 * @param {boolean} [options.trackState] Whether to fold the contents into tracked state.
 * @returns {{absorbed: boolean, applied: number, rejected: number}} What happened.
 */
export function absorbStateBlock(messageId, { trackState = true } = {}) {
    const message = chat?.[messageId];
    if (!message?.mes || message.is_user || message.is_system) {
        return { absorbed: false, applied: 0, rejected: 0 };
    }

    const fields = parseStateBlock(message.mes);
    if (!fields) {
        return { absorbed: false, applied: 0, rejected: 0 };
    }

    const stripped = stripStateBlock(message.mes);
    // A block with nothing before it is the whole message; removing it would leave a blank reply,
    // so keep the message as-is and take the data only.
    const canStrip = stripped.trim().length > 0;

    if (canStrip) {
        message.extra = message.extra ?? {};
        // Kept so the transform is reversible and the original is never simply destroyed.
        message.extra.sanguine_block = message.mes.slice(stripped.length);
        message.mes = stripped;

        // The swipe array holds its own copy of the text; leaving it unstripped would restore the
        // block the moment the user swiped away and back.
        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
            message.swipes[message.swipe_id] = stripped;
        }

        updateMessageBlock(messageId, message);
        saveChatDebounced();
    }

    if (!trackState) {
        return { absorbed: canStrip, applied: 0, rejected: 0 };
    }

    const outcome = foldBlockIntoState(fields, message.mes);
    return { absorbed: canStrip, ...outcome };
}

/**
 * Fold a parsed block's contents into tracked state, through the same validator everything else
 * goes through.
 *
 * The narrative window for the mention gate is the message the block came from, which is exactly
 * right, because the block is that message's own report about itself.
 *
 * @param {Map<string, string>} fields Parsed block fields.
 * @param {string} windowText The message text, for the mention gate.
 * @returns {{applied: number, rejected: number}} What happened.
 */
export function foldBlockIntoState(fields, windowText) {
    const { items, context } = classifyBlock(fields);
    const current = state.derive();
    // Routing before anything else, because it decides what is left for `setContext` below.
    //
    // The rule and its measurement are `absorb-table.js`; this is the storage half. Threads are
    // loaded rather than viewed, deliberately: a block proposal is a WRITE, and committing an
    // overlaid table would turn this branch's review closures into stored statuses no swipe could
    // undo (`clocks.js` `view()`).
    const threads = clocks.load();
    const routing = routeBlockFields(context, threads, { turn: entities.turn() });
    const shadow = routing.shadow;
    if (routing.routed) {
        clocks.commitTable(threads);
    }
    // `reject:block-shadow` counts prose a card wrote into a structured field that could not be
    // parsed into that structure. Migration raises it once per chat; this raises it live.
    const refused = shadow.filter(entry => entry.reason === SHADOW);
    if (refused.length) {
        observe.noteRejections(refused);
    }

    // Item names go through the same normalizer as everything else, so "2x Herb" and "**Herb**"
    // land on the same key as a plain "herb".
    const listed = items
        .map(raw => normalizeItemName(raw))
        .filter(Boolean)
        .flatMap(parsed => Array.from({ length: parsed.qty ?? 1 }, () => parsed.name));

    // The bare-name view a block can be matched against.
    //
    // `current.inv` is keyed `place␀name`; a block lists bare names. Diffing one against the other
    // means every lookup misses, every restatement of the same coat looks like a fresh coat, and
    // the quantity climbs by one per turn until the panel reports four flat caps.
    const held = new Map();
    for (const [key, item] of table_entries(current.inv)) {
        const { place, name } = splitItemKey(key);
        // Every place, not just carried. A block lists what you HAVE; where each thing is was
        // established elsewhere and the block has no opinion on it.
        held.set(name, { ...item, at: place });
    }
    // Capabilities too, or a card that relists one turns it into luggage.
    //
    // `restateInventory` carries the PLACE forward from what is held, and defaults to `carried` when
    // it finds nothing. Capabilities used to be in `current.inv` and are not any more
    // (`state-table.js` `foldAbility`), so a block whose `Inventory:` line happens to name a
    // technique the character knows would have proposed it as a fresh carried object, the exact
    // "shelf of groceries reads as luggage" failure that argument was written to stop, one table
    // over. They are added under their own place so the restatement lands back on the row it came
    // from and `foldAbility` reads it as the presence it is.
    for (const [key, row] of table_entries(current.abilities ?? new Map())) {
        const { place, name } = splitItemKey(key);
        if (!held.has(name)) {
            held.set(name, { ...row, qty: 1, at: place });
        }
    }

    const proposed = restateInventory({ held, listed });

    // The block is the narrator restating its own turn, so the mention gate would reject
    // everything if it checked only the prose. Checking against the block text as well is correct
    // and still refuses items that appear from nowhere.
    const gateText = `${windowText}\n${Array.from(fields.values()).join(' ')}`;

    const inventory = validateInventory({
        inv: current.inv,
        // Two tables since capabilities stopped being inventory, and the gates need both: a block
        // restating a technique the character already has must read as the no-op it is rather than
        // as a fresh grant, and one restating it at zero must be able to find the row to retract.
        abilities: current.abilities,
        // So the `same_as` candidate set can include the name the story actually wrote. A card's
        // block is where a face most often differs from the key, `Ka-Bar` against `ka-bar knife`.
        faces: current.faces,
        deltas: proposed,
        windowText: gateText,
    });
    // The card's health block stays PROSE, never marks.
    //
    // It used to become OWNED marks on the point-of-view character: `splitConditions` treated any
    // non-empty health value as a condition list, so "Health: Uninjured" minted an `uninjured`
    // mark, every block mark arrived with the `moderate` severity default and `turns: 0`, and the
    // panel read "Uninjured (moderate)" forever. Distinguishing "uninjured" (reassurance) from
    // "bleeding" (a condition), and ranking either, is a reading of the card's language that
    // RULE 1 reserves for the model. The scene probe reads the same block text and reports the
    // real afflictions with severity and duration; the block's own wording stays verbatim in
    // context, and the panel renders it as prose whenever the fold has no marks of its own.
    const delta = {};
    if (inventory.accepted.length) delta.inv = inventory.accepted;

    const rejected = inventory.rejected;
    state.noteRejections(rejected);

    // An event per block, even when the totals match what is already held. Staleness is derived
    // from the ledger and nothing else, so an item the narrator keeps listing has to keep
    // producing events or it goes stale and stops being sent back. The no-op totals cost a few
    // bytes and add no rows to the audit trail, since `deriveState` records a contributor only when
    // the quantity actually moved.
    if (Object.keys(delta).length) {
        const summary = describeBlock(context) || 'The scene moved on';
        chronicle.recordUserEvent({
            summary,
            keywords: listed.slice(0, 4),
            delta,
        });
    }

    // Context fields are carried verbatim so the injected block can show them without fold needing
    // to model them, but ONLY the ones fold has no structure for, which was always this table's
    // stated job (`panel.js` "shown as given rather than dropped for not fitting a schema").
    // `routeBlockFields` has already taken the ones that shadow a structured table.
    state.setContext(routing.keep);
    if (shadow.length) {
        state.noteShadow(shadow);
    }

    return {
        applied: inventory.accepted.length,
        rejected: rejected.length + refused.length,
        routed: routing.routed,
    };
}

/**
 * A one-line summary of where the scene is, for the chronicle entry.
 * @param {Map<string, string>} context Context fields.
 * @returns {string} A summary, or ''.
 */
function describeBlock(context) {
    const place = context.get('location');
    const time = context.get('time');
    if (place && time) {
        return `${place}, ${time}`;
    }
    return place || time || '';
}
