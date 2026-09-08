/**
 * fold/audit.js: the deep audit pass (app half).
 *
 * The pure half is `audit-table.js` (the exact detectors + the block + the router). This layer runs
 * the detectors over the rows table, spends ONE model call on the shortlist, routes the answers
 * back through the fold, and records what it did in the ledger.
 *
 * Why the detectors, not "is anything wrong?".
 *
 * The review probe's "still true?" question measured 0.14% closure (`reconcile-table.js:13`). The
 * audit never asks that. It computes violations by arithmetic, staleness from the `seen` clock,
 * capacity from a count, identity from nearIdentity containment, conservation from a stated `set`,
 * duplicates from refused `new`s, and only then spends a call on the shortlist, one question per
 * anomaly, with the evidence already attached.
 *
 * Never in fiction.
 *
 * The audit's findings are not narrative. They are the clickable reconcile surface: the player
 * answers keep/gone/move/same or not at all, and the not-at-all is the answer (a row stays). No
 * prose is generated about the machinery.
 */

import { loadValue, commitValue } from './store.js';
import { deserialize, serialize, applyOps, nearIdentity } from './rows-table.js';
import { ensureSeed, resolvePlaceOps, trackPlacedLocations } from './rows-probe.js';
import { recordRowsEvent, liveEvents } from './chronicle.js';
import { chat } from '../../../script.js';
import { requestExtraction } from './extract.js';
import { analyzeExtraction } from './json-parse.js';
import * as observe from './observe.js';
import {
    auditBlock, auditInstruction, schema, planAudit,
    stalenessSuspects, capacitySuspects, identitySuspects,
    conservationSuspects, duplicateSuspects, namePollutionSuspects,
    questionKey, opForVerdict, unposedFindings,
} from './audit-table.js';
import { projectDelta } from './rows-table.js';

const ROWS_PATH = 'state.rows';
const AUDIT_PATH = 'state.audit';
/** Where the pending, player-answerable questions live. */
const QUESTIONS_PATH = 'state.audit.questions';

/** How many audit questions one call may pose. Bounds the blast radius of a single line. */
export const MAX_AUDIT_QUESTIONS = 12;

/** The pass context: what the audit reads. Seeds from the legacy state when the table is empty. */
function loadRows() {
    let table = deserialize(loadValue(ROWS_PATH, null));
    if (!table.rows.size) {
        const seeded = ensureSeed();
        if (seeded) {
            table = seeded;
            // The seed must PERSIST here, the audit reads `state.rows` directly, and nothing else
            // runs until it does. Without this, `/fold-audit` seeds in memory, poses questions, and
            // the seeded table is gone by the next run.
            commitValue(ROWS_PATH, serialize(table));
        }
    }
    return table;
}

/** The pending exact findings the probe persisted. */
function pending() {
    return loadValue(AUDIT_PATH, { diffs: [], errors: [] });
}

/**
 * Retain only the pending findings the audit did NOT pose this run.
 *
 * The shortlist is capped at `MAX_AUDIT_QUESTIONS`; the conservation diffs and duplicate refusals
 * past the cap must survive for the next run, clearing them all would silently lose findings the
 * pass never even asked about (staleness re-derives, a `set` diff does not).
 *
 * @param {Iterable<string>} posedIds The row ids this run actually posed.
 */
function retainUnposed(posedIds) {
    const kept = unposedFindings(pending(), posedIds);
    commitValue(AUDIT_PATH, kept);
}

/** The pending questions a player can answer by hand. */
export function questions() {
    return Array.isArray(loadValue(QUESTIONS_PATH, [])) ? loadValue(QUESTIONS_PATH, []) : [];
}

/** Persist the pending questions, keyed stably, bounded. */
function saveQuestions(list) {
    const seen = new Set();
    const deduped = [];
    for (const q of Array.isArray(list) ? list : []) {
        const key = questionKey(q);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(q);
        if (deduped.length >= 40) break;
    }
    commitValue(QUESTIONS_PATH, deduped);
}

/** Remove one or more questions by their stable keys. */
function dropQuestions(keys) {
    const drop = new Set(keys);
    saveQuestions(questions().filter(q => !drop.has(questionKey(q))));
}

/**
 * The shortlist: run every exact detector over the rows table and the pending findings.
 *
 * @param {object} table The rows table.
 * @param {number} now The current turn/mid.
 * @returns {Array<object>} The suspects, detector order.
 */
export function detect(table, now) {
    const p = pending();
    return [
        ...namePollutionSuspects(table.rows),
        ...stalenessSuspects(table.rows, now),
        ...capacitySuspects(table.rows),
        ...identitySuspects(table.rows, nearIdentity),
        ...conservationSuspects(p.diffs),
        ...duplicateSuspects(p.errors, table.rows),
    ];
}

/**
 * Apply the audit's ops through the fold, exactly as the per-turn probe does, and record the
 * projected delta so the legacy readers stay in step.
 *
 * @param {object} table The rows table.
 * @param {Array<object>} ops The fold ops from `planAudit`.
 * @param {{mid: number}} [ctx] The pass anchor.
 * @returns {{applied: number, diffs: Array<object>}} What the fold did.
 */
export function applyAudit(table, ops, ctx = {}) {
    const before = new Map();
    for (const op of ops) {
        if (op.op === 'new' || !op.id) continue;
        const row = table.rows.get(op.id);
        if (row) before.set(op.id, { kind: row.kind, name: row.name, place: row.place, qty: row.qty, who: row.who, rank: row.rank });
    }
    const { diffs } = applyOps(table, resolvePlaceOps(ops), ctx.mid ?? 0);
    trackPlacedLocations(ops);
    const delta = projectDelta(before, ops);
    if (delta.inv?.length || delta.vit?.length || delta.st?.length) {
        recordRowsEvent({ summary: 'Deep audit applied', delta, srcKey: '', mid: ctx.mid });
    }
    commitValue(ROWS_PATH, serialize(table));
    return { applied: ops.length, diffs };
}

/**
 * Run the pass: detect → block → one call → route → apply.
 *
 * @param {object} [options] Options.
 * @param {number} [options.now] The current turn/mid.
 * @param {string} [options.profileId] Connection profile for the call.
 * @returns {Promise<{posed: number, applied: number, rejected: number, shortlist: Array<object>}>}
 */
/**
 * The history the model reads: the FULL chronicle (every recorded event's summary) PLUS the raw
 * transcript's recent tail.
 *
 * The chronicle alone is NOT enough, it is fold's condensed record, and it misses retractions
 * (measured: "leave most of the food and other supplies in the car" at Raccoon City mid 228-229
 * never became an event, so the record kept a man carrying a carload). The model must read the
 * RAW narrative where placements are actually shown, not only fold's record of it.
 *
 * No keyword pre-filtering. The model reads the whole history and answers semantically; fold does
 * not decide which events are relevant with a token index that cannot match "the knife" against
 * "the ka-bar knife" or "the woman in red" against "Ada Wong".
 *
 * @returns {string} The history block.
 */
function historyBlock() {
    const events = liveEvents();
    const chronicleLines = events
        .filter(e => e?.s)
        .map(e => `- ${e.s}`);
    const tail = (chat ?? [])
        .filter(m => m?.mes && !m.is_system)
        .slice(-60)
        .map(m => `- ${m.name ?? ''}: ${String(m.mes).replace(/\s+/g, ' ').trim()}`);
    return [
        ...chronicleLines,
        ...(tail.length ? ['', 'Recent conversation (raw, the placements, drops and hand-offs live here):', ...tail] : []),
    ].join('\n');
}

export async function run({ now = 0, profileId = '' } = {}) {
    const table = loadRows();
    const shortlist = detect(table, now);

    // Everything except the capacity WARNING goes to the model, and the model reads the WHOLE
    // history itself, the questions are answered from its own semantic reading, never from a fold
    // keyword slice. Staleness and identity read the history; capacity is a warning card, not a
    // question.
    const modelQ = shortlist.filter(s => s.resolver === 'model');
    const playerQ = shortlist.filter(s => s.resolver !== 'model');

    if (!modelQ.length) {
        observe.note('audit:posed', playerQ.length);
        saveQuestions(playerQ);
        return { posed: playerQ.length, applied: 0, rejected: 0, shortlist, player: playerQ.length };
    }

    const truncated = modelQ.length > MAX_AUDIT_QUESTIONS;
    const posedIds = new Set(modelQ.slice(0, MAX_AUDIT_QUESTIONS).map(s => s.id));
    const posed = truncated ? modelQ.slice(0, MAX_AUDIT_QUESTIONS) : modelQ;

    const { text, index } = auditBlock(posed);
    observe.note('audit:posed', index.size + playerQ.length);
    if (truncated) observe.noteCap('audit:deferred', modelQ.length - MAX_AUDIT_QUESTIONS);

    const history = historyBlock();
    const prompt = [
        history ? `History fold recorded (the story's events, oldest first):\n${history}` : '',
        text,
        auditInstruction(),
    ].filter(Boolean).join('\n\n');
    let fragment;
    try {
        const raw = await requestExtraction({ prompt, responseLength: 2000, schema: schema(), profileId });
        fragment = analyzeExtraction(raw).value;
    } catch (error) {
        console.error('[sanguine] deep audit failed', error);
        observe.note('audit:failed');
        // The questions remain for the player to answer by hand.
        saveQuestions([...modelQ, ...playerQ]);
        return { posed: index.size + playerQ.length, applied: 0, rejected: 0, shortlist, player: playerQ.length };
    }

    const { ops, rejected } = planAudit(fragment, index);
    const outcome = ops.length ? applyAudit(table, ops, { mid: now }) : { applied: 0 };
    retainUnposed(posedIds);

    observe.note('audit:applied', outcome.applied);
    if (rejected.length) observe.note('audit:rejected', rejected.length);
    // What the model resolved is gone; what it refused stays for the player.
    const answered = new Set(ops.map(op => op.id));
    saveQuestions([...playerQ, ...modelQ.filter(s => !answered.has(s.id))]);
    return { posed: index.size + playerQ.length, applied: outcome.applied, rejected: rejected.length, shortlist, player: playerQ.length };
}

/**
 * Answer one pending question by hand, the clickable reconcile surface. The same write the model
 * call makes (`opForVerdict`), through the same fold.
 *
 * @param {string} key The stable `questionKey`.
 * @param {string} verdict One of `VERDICTS`.
 * @param {{at?: string, target?: string, evidence?: string, now?: number}} [fields] The answer's
 *   fields; `now` is the current turn for the trail, defaulting to the row's last-seen.
 * @returns {boolean} Whether anything changed.
 */
export function resolveQuestion(key, verdict, fields = {}) {
    const suspect = questions().find(q => questionKey(q) === key);
    if (!suspect) return false;
    const r = opForVerdict(suspect, verdict, fields);
    if (r.error) return false;
    const table = loadRows();
    // An audit resolution is the record's current truth, anchored to the turn it was answered,
    // not to when the row was last seen (a wrong mid would let a swipe of an old message retract
    // a resolution that was made later).
    const mid = Number(fields.now) || Number(suspect.seen) || 0;
    const outcome = applyAudit(table, [r.op], { mid });
    dropQuestions([key]);
    observe.note('audit:applied', outcome.applied);
    return outcome.applied > 0;
}
