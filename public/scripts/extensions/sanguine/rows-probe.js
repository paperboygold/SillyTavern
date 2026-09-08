/**
 * fold/rows-probe.js: the unified state probe (Phase 1).
 *
 * One probe, one table, one contract. The model reads the pinned ledger, every row with its
 * stable opaque id, and answers with operations ON ids. The fold (`rows-table.js`) is the only
 * write. Built from `FOLD-CENSUS.md`: identity by ID (row 1), one-thing-one-row (row 2), `set` as
 * a first-class conservation input (rows 3, 7), a subject on every change (row 5), retraction as
 * an op (row 4), coverage by ID (row 7).
 *
 * The apply half folds the ops, checks coverage against the model's own by-id `mentions` report
 * (exact membership, the RULE 1 language-neutral gate), and persists the table.
 */

import { loadValue, commitValue } from './store.js';
import { deserialize, serialize, applyOps, renderLedger, ledgerInstruction, withCoverage, projectDelta } from './rows-table.js';
import { rowsFromLegacy } from './rows-seed.js';
import { liveEvents } from './chronicle.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import * as places from './places.js';

/** The reserved place categories, fold's own vocabulary, not locations. */
const CATEGORY_PLACES = new Set(['carried', 'money', 'assets', 'abilities']);

/**
 * Resolve each placement's destination against the tracked places, so "the car", "my SUV" and
 * "the jeep" are ONE stored location. Fail-open: an unresolved string stays as written, a chat
 * with no place record behaves exactly as it does today.
 *
 * @param {Array<object>} ops The cleaned ops, mutated in place.
 * @returns {Array<object>} The ops.
 */
export function resolvePlaceOps(ops) {
    for (const op of Array.isArray(ops) ? ops : []) {
        const place = String(op.op === 'new' ? (op.place ?? op.at) : op.at ?? '').trim();
        if (!place || CATEGORY_PLACES.has(place)) continue;
        const canonical = places.resolve(place)?.row?.name;
        if (canonical) {
            if (op.op === 'new') op.place = canonical;
            else op.at = canonical;
        }
    }
    return ops;
}

/**
 * A placement to a real location makes that location a tracked place.
 *
 * The rpg-companion on-person/stored model: "I left the food in the car" is not a string, the car
 * (or the jeep, the house, the school locker) becomes a tracked place that holds the stored items,
 * so the block renders `Stored (car): food, water` and the same location under any spelling
 * resolves to one record. The reserved categories are fold's own (`carried`/`money`/`assets`/
 * `abilities`), a real named destination is a place.
 *
 * @param {Array<object>} ops The ops that were applied.
 */
export function trackPlacedLocations(ops) {
    for (const op of Array.isArray(ops) ? ops : []) {
        const place = String(op.op === 'new' ? (op.place ?? op.at) : op.at ?? '').trim();
        if (!place || CATEGORY_PLACES.has(place)) continue;
        places.upsert({ name: place, source: 'rows' });
    }
}

/** Where the row table lives in the fold blob. */
const ROWS_PATH = 'state.rows';

/** Where the deep audit's pending exact findings live (diffs, refused duplicates). */
const AUDIT_PATH = 'state.audit';

/** The ops the model may emit. */
export const OPS = Object.freeze(['new', 'gain', 'spend', 'set', 'move', 'change', 'close', 'same_as', 'none']);

/**
 * The unified schema. Every property is required (OpenAI strict mode); empty string / 0 is how a
 * field says "not used by this op".
 * @returns {object} A JSON schema fragment.
 */
export function schema() {
    return {
        rows: {
            type: 'array',
            description: 'One entry per row that changed this turn, referencing rows by their id from the "State:" block. Omit rows that did not change.',
            items: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: [...OPS], description: '"new" when the story introduced something not in the block. "gain"/"spend" for a quantity change (dq). "set" ONLY when the story states a current total outright. "move" for a change of place. "change" for a new rank or name. "close" for a thread or condition that resolved. "same_as" when this is a different spelling of a row already in the block, put the held row\'s id in "target". "none" for a row you checked and kept.' },
                    id: { type: 'string', description: 'The row\'s id, exactly as in the "State:" block, e.g. "R2". Empty for "new".' },
                    target: { type: 'string', description: 'For "same_as", the id of the held row this is a spelling of. Empty otherwise.' },
                    kind: { type: 'string', enum: ['item', 'vital', 'mark', 'person', 'thread', 'clock', 'scene'], description: 'For "new", the kind of row. Empty otherwise.' },
                    name: { type: 'string', description: 'For "new" (or a "change" of name), the name the story uses, in the story\'s own words. Never a category you summarised several things into: "9mm magazines", "buckshot shells" and "birdshot" are three rows, not one "ammunition". Empty otherwise.' },
                    dq: { type: 'integer', description: 'For "gain"/"spend", the change in quantity. Positive gained, negative lost. 0 otherwise.' },
                    set: { type: 'integer', description: 'For "set", the absolute total the story states OUTRIGHT, "the treasury holds 12,400 marks", "your HP is 38". A stated total is the one thing that catches a missed event, so report it every time the story names a current count or balance. When it disagrees with the record, that becomes a question to resolve, never estimate, never convert. 0 otherwise.' },
                    at: { type: 'string', description: 'For "new" or "move" of an ITEM, where it is: "carried", "money", "assets", "abilities", or a place name. EMPTY for a thread, condition, person, scene or clock, they have no place. Empty otherwise.' },
                    who: { type: 'string', description: 'Whose it is, when not the point-of-view character\'s. Empty for the point-of-view character.' },
                    rank: { type: 'string', description: 'For "new" or "change", the grade the story gives, copied exactly as written, "E", "Amateur", "47/100". The name must NOT contain the rank. Empty otherwise.' },
                    qty: { type: 'integer', description: 'For "new", the initial quantity when the story states one; 1 is the default. Empty otherwise.' },
                    evidence: { type: 'string', description: 'Required for every op except "none": what in the text shows it. Quote or paraphrase the moment. If you cannot, the op is "none".' },
                },
                required: ['op', 'id', 'target', 'kind', 'name', 'dq', 'set', 'at', 'who', 'rank', 'qty', 'evidence'],
                additionalProperties: false,
            },
        },
        mentions: {
            type: 'array',
            description: 'The rows this excerpt actually names or touches, by id, exactly as written in the "State:" block. Never an empty-string member.',
            items: { type: 'string' },
        },
    };
}

/** The static instruction. Per-pass state (the pinned ledger) rides in `context()`. */
export function instruction() {
    return ledgerInstruction();
}

/** How many rows the pinned ledger shows. Live rows (carried/money/vitals/open) come first. */
const LEDGER_LIMIT = 60;

/** The pinned ledger, the rows the model sees this pass. */
export function context() {
    const ledger = renderLedger(load(), LEDGER_LIMIT);
    return ledger ? `State:\n${ledger}` : '';
}

/** Load the persisted table, seeding it from the legacy state on the first read. */
function load() {
    let table = deserialize(loadValue(ROWS_PATH, null));
    if (!table.rows.size) {
        // A chat played before the Phase 1 schema has no `state.rows`. Seed once from the state
        // the legacy fold already renders, so the pinned ledger and the audit see the record.
        const seeded = ensureSeed();
        if (seeded) {
            table = seeded;
            save(table);
        }
    }
    return table;
}

/**
 * Seed the persisted rows table from a legacy chat's own state, once.
 *
 * Reads the same folds the old panel rendered, `liveEvents` + `deriveState` for the inventory,
 * the stored thread and cast tables, and persists the result. Returns null when the legacy state
 * is itself empty, so the probe does not reseed an empty table on every pass. Exported for the
 * audit, which reads `state.rows` directly and must seed too or it finds an empty table on a chat
 * that predates the rows schema.
 *
 * @returns {object|null} The seeded rows table, or null.
 */
export function ensureSeed() {
    const table = rowsFromLegacy({
        events: liveEvents(),
        threads: clocks.load(),
        cast: entities.load(),
        turn: entities.turn(),
    });
    return table.rows.size ? table : null;
}

/** Persist the table. */
function save(table) {
    commitValue(ROWS_PATH, serialize(table));
}

/**
 * Apply the probe's fragment: fold the ops, enforce by-id coverage, persist.
 *
 * Coverage (census R7): an op that touches a held row is refused unless the model's own `mentions`
 * report names that row, the model cannot change a row its own report says the window did not
 * touch. A `new` is its own mention (the story named the thing). Exact set membership on fold's
 * own ids: no language, no fuzzy match, any script.
 *
 * @param {object} fragment The parsed probe fragment.
 * @param {object} ctx The pass context.
 * @returns {{applied: number, diffs: Array<object>, errors: Array<object>}} What the fold did.
 */
export function apply(fragment, ctx) {
    const raw = Array.isArray(fragment?.rows) ? fragment.rows : [];
    const table = load();

    // Structure only: the mention gate and the evidence clause, before the fold sees an op.
    const clean = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const op = {
            op: String(r.op ?? '').trim().toLowerCase(),
            id: String(r.id ?? '').trim(),
            target: String(r.target ?? '').trim(),
            kind: String(r.kind ?? '').trim().toLowerCase(),
            name: String(r.name ?? '').trim(),
            dq: Number(r.dq) || 0,
            set: Number(r.set) || 0,
            at: String(r.at ?? '').trim(),
            who: String(r.who ?? '').trim(),
            rank: String(r.rank ?? '').trim(),
            qty: Number(r.qty) || 0,
            evidence: String(r.evidence ?? '').trim(),
        };
        if (op.op === 'none') {
            clean.push(op);
            continue;
        }
        if (!op.evidence) continue;
        clean.push(op);
    }

    const covered = withCoverage(clean, fragment?.mentions ?? []);
    // Snapshot the rows the ops touch, before the fold, `move` and `set` projection need the
    // before state.
    const before = new Map();
    for (const op of covered) {
        if (op.op === 'new' || !op.id) continue;
        const row = table.rows.get(op.id);
        if (row) before.set(op.id, { kind: row.kind, name: row.name, place: row.place, qty: row.qty, who: row.who, rank: row.rank });
    }
    const { diffs, errors } = applyOps(table, resolvePlaceOps(covered), ctx?.mid ?? 0);
    trackPlacedLocations(covered);
    const delta = projectDelta(before, covered);
    save(table);
    // Persist the exact findings for the deep audit: conservation diffs and refused duplicates.
    // Accumulated across passes so a quiet stretch does not erase them before the audit reads them;
    // bounded so a pathological record cannot grow the blob.
    const pending = loadValue(AUDIT_PATH, { diffs: [], errors: [] });
    const max = 40;
    commitValue(AUDIT_PATH, {
        diffs: [...(Array.isArray(pending.diffs) ? pending.diffs : []), ...diffs].slice(-max),
        errors: [...(Array.isArray(pending.errors) ? pending.errors : []), ...errors].slice(-max),
    });
    return { applied: covered.length, diffs, errors, delta };
}
