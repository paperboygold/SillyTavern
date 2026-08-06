/**
 * fold/state.js — inventory, vitals and status, derived from the chronicle.
 *
 * There is no state table. A chronicle event may carry a `d` (delta) describing what it did to the
 * world, and the current state is a fold over the events that are live on this branch. See
 * state-table.js for why, and for the three merges that do the folding.
 *
 * The only thing persisted here is the rejection tally, which is not derivable from the ledger —
 * a rejected delta is by definition one that never became an event.
 */

import { insert_with, merge_bu, table_entries } from './lib/hash.js';
import * as chronicle from './chronicle.js';
import {
    deriveState,
    isFresh,
    MAX_CHANGES_PER_TURN,
    normalizeItemName,
    renderState,
    STALE_THRESHOLD,
    validateInventory,
    validateStatus,
    validateVitals,
} from './state-table.js';
import { commit, loadTable } from './store.js';

const REJECTS_PATH = 'state.rejects';

/** @returns {Map<string, number>} Rejection reason counts. */
export function loadRejects() {
    return loadTable(REJECTS_PATH);
}

/**
 * Current state, folded from the live events of this branch.
 * @returns {{inv: Map, vitals: Map, status: Map, since: Map, contributors: Map}} Derived state.
 */
export function derive() {
    return deriveState(chronicle.liveEvents());
}

/**
 * The schema fragment describing what a delta may say.
 *
 * Every object carries `additionalProperties: false` and lists every property in `required`,
 * because OpenAI's strict structured output demands it on EVERY object in the schema — a fragment
 * that omits it fails the whole shared call for every probe.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function deltaSchema() {
    return {
        type: 'object',
        description: 'What this event changed about the character. Omit anything it did not change.',
        properties: {
            inv: {
                type: 'array',
                description: 'Items gained or lost by this event, as changes in quantity.',
                items: {
                    type: 'object',
                    properties: {
                        item: { type: 'string', description: 'Item name, singular, lowercase.' },
                        dq: { type: 'integer', description: 'Change in quantity: positive gained, negative lost.' },
                    },
                    required: ['item', 'dq'],
                    additionalProperties: false,
                },
            },
            vit: {
                type: 'array',
                description: 'Changes to health, stamina or similar tracked levels.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Vital name, lowercase.' },
                        dcur: { type: 'number', description: 'Change in the current value.' },
                        max: { type: 'number', description: 'Maximum value, only when newly established.' },
                    },
                    required: ['name', 'dcur', 'max'],
                    additionalProperties: false,
                },
            },
            st: {
                type: 'array',
                description: 'Status effects that started or ended.',
                items: {
                    type: 'object',
                    properties: {
                        flag: { type: 'string', description: 'Short lowercase label, e.g. poisoned.' },
                        on: { type: 'boolean', description: 'True if it started, false if it ended.' },
                    },
                    required: ['flag', 'on'],
                    additionalProperties: false,
                },
            },
        },
        required: ['inv', 'vit', 'st'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the delta field.
 * @returns {string} Instruction text.
 */
export function deltaInstruction() {
    return [
        'For each event, also record what it CHANGED, as changes rather than totals:',
        'dq is how many were gained or lost by that event, not how many are held afterwards.',
        'Picking up two coins is dq 2, even if the character now has fifty.',
        'Record nothing for things merely mentioned, described or looked at.',
        'Use empty arrays when an event changed nothing.',
    ].join(' ');
}

/**
 * Validate a proposed delta against the narrative and the state as currently derived.
 *
 * Called when an event is being recorded. Anything that survives is stored on the event and will
 * be folded from then on; anything rejected never enters the ledger, which is what keeps the fold
 * a pure sum.
 *
 * @param {any} raw The delta the model proposed for one event.
 * @param {object} context Context.
 * @param {string} [context.windowText] Narrative window, for the mention gate.
 * @param {object} [context.state] Pre-derived state, to avoid re-folding per event.
 * @returns {{delta: object|null, rejected: object[]}} The accepted delta, or null if empty.
 */
export function validateDelta(raw, { windowText = '', state = null } = {}) {
    const current = state ?? derive();

    const inventory = validateInventory({
        inv: current.inv,
        deltas: raw?.inv,
        windowText,
        budget: MAX_CHANGES_PER_TURN,
    });
    const vitals = validateVitals({ vitals: current.vitals, deltas: raw?.vit, windowText });
    const status = validateStatus({ status: current.status, deltas: raw?.st, windowText });

    const rejected = [...inventory.rejected, ...vitals.rejected, ...status.rejected];
    const delta = {};
    if (inventory.accepted.length) delta.inv = inventory.accepted;
    if (vitals.accepted.length) delta.vit = vitals.accepted;
    if (status.accepted.length) delta.st = status.accepted;

    return { delta: Object.keys(delta).length ? delta : null, rejected };
}

/**
 * Record rejections so the UI can show them. A rejection layer nobody can see is one nobody
 * trusts, and one that gets ripped out the first time the state looks wrong.
 * @param {object[]} rejections Rejections from validateDelta.
 */
export function noteRejections(rejections) {
    if (!rejections?.length) {
        return;
    }
    const rejects = loadRejects();
    for (const rejection of rejections) {
        insert_with(rejects, merge_bu, rejection.reason, 1);
    }
    commit(REJECTS_PATH, rejects);
}

/**
 * Render current state for the prompt.
 * @returns {string} The block, or '' when there is nothing to say.
 */
export function render() {
    const { inv, vitals, status, since } = derive();
    return renderState({ inv, vitals, status, since });
}

/**
 * Everything the UI panel needs, including the audit trail.
 * @returns {object} A snapshot.
 */
export function snapshot() {
    const { inv, vitals, status, since, contributors } = derive();
    return {
        inventory: table_entries(inv).map(([name, item]) => ({
            name,
            qty: item?.qty ?? 0,
            since: since.get(name) ?? 0,
            fresh: isFresh(name, since),
            // Why you have this: the events that produced the quantity.
            from: (contributors.get(name) ?? []).map(c => ({ dq: c.dq, summary: c.summary })),
        })),
        vitals: table_entries(vitals).map(([name, v]) => ({ name, cur: v?.cur ?? 0, max: v?.max ?? 0 })),
        status: table_entries(status).filter(([, v]) => v?.on).map(([flag]) => flag),
        rejects: table_entries(loadRejects()).map(([reason, count]) => ({ reason, count })),
        staleThreshold: STALE_THRESHOLD,
    };
}

/**
 * Manually adjust an item by recording a user-authored event.
 *
 * State is a fold over the ledger, so the only honest way to change it is to add to the ledger.
 * That keeps the audit trail complete: a hand-edited quantity is visibly a hand edit.
 *
 * @param {string} rawName Item name.
 * @param {number} dq Quantity change.
 * @returns {boolean} True if an event was recorded.
 */
export function adjustItem(rawName, dq) {
    const parsed = normalizeItemName(rawName);
    if (!parsed || !Number.isFinite(dq) || !dq) {
        return false;
    }
    const delta = Math.trunc(dq);
    return chronicle.recordUserEvent({
        summary: `${delta > 0 ? 'Gained' : 'Lost'} ${Math.abs(delta)} ${parsed.name}`,
        keywords: [parsed.name],
        delta: { inv: [{ item: parsed.name, dq: delta }] },
    });
}
