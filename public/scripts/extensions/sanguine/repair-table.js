/**
 * sanguine/repair-table.js: the repair bay, as data (pure half).
 *
 * The app half is `repairs.js`; nothing here touches storage, the chronicle or the DOM.
 *
 * The measurement that produced this file.
 *
 * `reconcile:asked: 80`, `reconcile:declined: 2`, `reconcile:applied: 0`. Two runs ever, across 22
 * campaigns, both cancelled. The old gate (`reconcile.js` `confirm`) priced Apply at up to forty
 * blind fiction-recall judgements over a modal that covered the record being judged, and Cancel at
 * one click for no visible loss. Cancel wins that trade every time, and no amount of typography
 * changes the sign of it.
 *
 * Two structural couplings produced the zero, and only one of them is about cost:
 *
 *   1. ALL-OR-NOTHING. One gate guarded the whole plan, so the three obviously-good repairs were
 *      hostage to the two frightening ones until the batch was declined entire.
 *   2. VALUE ROUTED THROUGH THE GATE. Every unit of value the pass could deliver needed the gate
 *      pressed, and the gate is pressed zero times. Lowering the per-decision cost multiplies a
 *      coefficient that is measured at zero.
 *
 * So the split below is not a UI refinement. It is the answer to a different question: how much of
 * the pass's value lands when the player answers NOTHING AT ALL?
 *
 * The line is conservation of substance, not invertibility.
 *
 * A CONSERVING repair changes what the record calls a thing, where it puts it, or at what
 * granularity it holds it. Afterwards the world contains exactly the same stuff. Those apply on
 * sight, into a ledger, reversibly.
 *
 * A NON-CONSERVING repair changes how much of the world exists. Those ask, one card each, durably.
 *
 * Note what the line is NOT. `amount` is trivially invertible, `edits.setItemQty(key, from)`, and
 * is still the single most dangerous verdict in the vocabulary, because a wrong number is SILENT:
 * nothing on the panel announces that 2,944 gold became 340. The axis is noticeability ×
 * recoverability, not invertibility:
 *
 *   rename   conserves · loud (the name is on the panel)   · inverse edit exists      → AUTO
 *   move     conserves · loud (the place is on the panel)  · inverse edit exists      → AUTO
 *   split    conserves · very loud (1 row becomes 3)       · snapshot window only     → AUTO
 *   merge    destroys  · somewhat loud                     · NO INVERSE OPERATOR      → ASK
 *   gone     destroys  · silent (absence is invisible)     · snapshot window only     → ASK
 *   amount   rewrites  · SILENT (numbers do not announce)  · inverse exists, unnoticed → ASK
 *
 * `split` is the one judgement call. It destroys its source row, so on a pure "does a row die"
 * reading it would ask. It is auto anyway for three reasons that outweigh that: quantity is
 * conserved by construction (`edit-table.js` `splitDelta` credits every part in full and clamps the
 * debit to what the row can pay), it is the loudest possible edit (the panel visibly grows), and a
 * BAD split degrades to "right stuff, wrong labels", repairable by the next pass's renames and
 * merges. It is also the pass's flagship fix, the `ammunition x29` case the owner repaired four
 * dialogs at a time by hand; putting the flagship behind the gate that is never pressed is the same
 * as not shipping it.
 */

import { AMOUNT, GONE, MERGE, MOVE, RENAME, SPLIT } from './reconcile-table.js';

/** Lands on sight, into the ledger. */
export const AUTO = 'auto';
/** Becomes a durable question, answerable never. */
export const ASK = 'ask';

/**
 * Which lane each verdict takes.
 *
 * Keyed off the verdict constants rather than bare strings so a rename in `reconcile-table.js`
 * cannot silently drop a verdict out of the table and into the unknown-op default below.
 */
export const TIER_OF = Object.freeze({
    [RENAME]: AUTO,
    [MOVE]: AUTO,
    [SPLIT]: AUTO,
    [GONE]: ASK,
    [MERGE]: ASK,
    [AMOUNT]: ASK,
});

/**
 * How many passes of ledger are retained.
 *
 * Three, because the blob is nearly full.
 *
 * `store.js` `MAX_FOLD_BYTES` is 128 KiB and the fold blob rides inside the chat's JSONL file. Three
 * live chats are already over 90% of that budget, the largest at 96%. A ledger is machinery, it
 * exists so an applied repair can be seen and undone shortly after it lands, and its value decays
 * fast: a pass from six passes ago is history, not an undo affordance. Three keeps "what did the
 * last run do to my record" answerable while costing a few hundred bytes rather than a few thousand.
 */
export const MAX_LEDGER_PASSES = 3;

/**
 * The separator, matching every other composite key in this extension.
 *
 * `entity-table.js`:139 and `state-table.js`:137 both use NUL for the same reason: it is the one
 * byte a name, a place or a phrase cannot contain, so a key built from two fields cannot be
 * ambiguous however the story spells them.
 */
const SEP = '\u0000';

/**
 * Stable identity for a pending ask.
 *
 * Kind AND key, because the keys are only unique within their table, a thread and a mark can
 * legitimately share a string, and a supersession keyed on the string alone would have one pass's
 * question about a stake overwrite another's about a wound.
 *
 * @param {{kind: string, key: string}} ask A pending ask, or a ledger row.
 * @returns {string} The identity.
 */
export function askKey(ask) {
    return `${String(ask?.kind ?? '')}${SEP}${String(ask?.key ?? '')}`;
}

/**
 * Stable identity for a cluster card.
 *
 * @param {string} op The verdict.
 * @param {string} kind The row kind.
 * @returns {string} The identity.
 */
export function clusterKey(op, kind) {
    return `${String(op ?? '')}${SEP}${String(kind ?? '')}`;
}

/**
 * Split a plan's repairs into the two lanes.
 *
 * An unknown verdict asks.
 *
 * `TIER_OF` is exhaustive over `VERDICTS` today, and a verdict outside it would be a vocabulary that
 * grew without this file noticing. The safe direction for that is ASK: an unrecognised repair that
 * lands unreviewed is the exact failure mode this whole redesign exists to make impossible, whereas
 * an unrecognised repair that becomes a card the player never answers costs nothing.
 *
 * @param {Array<object>} repairs The plan's repairs.
 * @returns {{auto: Array<object>, ask: Array<object>}} The two lanes, each in the order posed.
 */
export function tierRepairs(repairs) {
    const auto = [];
    const ask = [];
    for (const repair of Array.isArray(repairs) ? repairs : []) {
        if (!repair?.op) {
            continue;
        }
        (TIER_OF[repair.op] === AUTO ? auto : ask).push(repair);
    }
    return { auto, ask };
}

/**
 * Group asks that share `(op, kind)` into cluster cards.
 *
 * The cluster is real, not a hypothetical bulk affordance.
 *
 * The live Raccoon City record carries three cast rows that are dead where they fell, `infected
 * man` ("dead on the floor"), `mechanic in the coveralls` ("dead, hatchet in skull"), `two other
 * figures` ("dead, killed by Solomon"). Those are one judgement wearing three cards: the player
 * decides once whether the pass is reading death correctly. Grouping is how bulk stays cheap
 * WITHOUT becoming a blind select-all, because the blast radius of one interaction is still one
 * shape of repair rather than the whole plan.
 *
 * Singletons come back as clusters of one so the caller has a single shape to render and a single
 * shape to apply. Order of first appearance is preserved: the asks are already in the order the
 * block posed them, and re-sorting would move cards under a player who is reading them.
 *
 * @param {Array<object>} asks Pending asks.
 * @returns {Array<{op: string, kind: string, members: Array<object>, key: string, count: number}>}
 *   The cards.
 */
export function clusterAsks(asks) {
    /** @type {Map<string, {op: string, kind: string, members: Array<object>, key: string, count: number}>} */
    const cards = new Map();
    for (const ask of Array.isArray(asks) ? asks : []) {
        if (!ask?.op) {
            continue;
        }
        const key = clusterKey(ask.op, ask.kind);
        if (!cards.has(key)) {
            cards.set(key, { op: ask.op, kind: String(ask.kind ?? ''), members: [], key, count: 0 });
        }
        const card = cards.get(key);
        card.members.push(ask);
        card.count = card.members.length;
    }
    return [...cards.values()];
}

/**
 * Which undo mechanism a landed repair has.
 *
 * Three mechanisms, and the surface must print which one it has.
 *
 *   `inverse`   just an edit, so it never expires. `rename` renames back, `move` moves back,
 *               `amount` sets the count to the `from` the ledger recorded.
 *   `snapshot`  only while the pass snapshot is still honest, `split` and `gone` have no operator
 *               that reassembles what they took apart. `gone` in particular is a recorded EVENT
 *               ("it left the story"), and the inverse of an event is not an un-event.
 *   `none`      `merge`. `mergeEntities` accumulates aliases and has no inverse anywhere in this
 *               codebase (`reconcile-table.js`:107), `mergeThreads` keeps the more advanced dial and
 *               discards the other row, and the item merge is one transfer that sums two piles with
 *               nothing recording how they divided. That asymmetry is WHY merge is an ask: the
 *               tiering line and the undo story are the same fact seen from two sides.
 *
 * The reason this is a function and not a comment: an undo that quietly expires is a lie, and the
 * only way a surface can decline to lie is to be told which of the three it is holding.
 *
 * @param {string} op The verdict that landed.
 * @returns {'inverse'|'snapshot'|'none'} The mechanism.
 */
export function undoKindOf(op) {
    if (op === RENAME || op === MOVE || op === AMOUNT) {
        return 'inverse';
    }
    if (op === SPLIT || op === GONE) {
        return 'snapshot';
    }
    return 'none';
}
