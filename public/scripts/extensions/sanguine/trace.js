/**
 * fold/trace.js: the prompt->output trace.
 *
 * Every extraction pass (`extract.js`) builds one prompt (narrative window + pinned ledger +
 * probe instructions) and gets one raw reply. On success only the parsed fragments survive in
 * the ledger; the exact prompt string and the model's raw words are gone, so nothing can later
 * answer "what input produced this output?", and the resolver (`lib/ml/`) cannot be trained on
 * the real pairs that produced the verdicts in `state.answers`. This module is the durable
 * record of the pair: one line per pass, appended to a per-chat JSONL on the server
 * (`data/<user>/extensions/sanguine-traces/<chat>.jsonl`), off the 128KB `chat_metadata` budget.
 *
 * It is a trace, not a tally: append-only, full-fidelity (prompt + schema + raw reply + parsed),
 * and deliberately out-of-band from `log.js` (which keeps the last N failures/rejections for the
 * panel), the trace keeps EVERYTHING, bounded only by disk, for later training and analysis.
 */

import { getCurrentChatId } from '../../../script.js';
import { getRequestHeaders } from '../../../script.js';

/** The endpoint namespace (mounted in `src/server-startup.js`). */
const TRACE_API = '/api/sanguine-trace';

/**
 * The latest pass this session, kept in memory so the panel can render it synchronously (the
 * panel's `render()` is a pure fold over `snapshot`, and the trace lives on the server). Set on
 * every `record()`, restored once at init by `hydrate()`. Never the whole trace, just the last
 * line, which is the one "what just happened" asks about.
 * @type {object|null}
 */
let lastRecord = null;

/** @returns {object|null} The latest recorded pass, or null if none yet this session. */
export function last() {
    return lastRecord;
}

/**
 * Restore the latest pass from the server (the panel wants it even across a reload). Called once
 * at init; fire-and-forget.
 * @returns {Promise<void>}
 */
export async function hydrate() {
    const records = await load();
    if (records.length) {
        lastRecord = records[records.length - 1];
    }
}

/**
 * Record one completed extraction pass.
 * @param {object} rec The record.
 * @param {number} [rec.t] Epoch ms (defaults to now).
 * @param {number} [rec.turn] fold's turn counter for this pass.
 * @param {number|null} [rec.mid] The newest message index this pass read.
 * @param {string} [rec.why] Why the pass ran (world trigger, interval, manual).
 * @param {string} [rec.profileId] Connection profile, if extraction used one.
 * @param {number} [rec.responseLength] The token budget this attempt used.
 * @param {string} [rec.prompt] The exact user-role prompt sent.
 * @param {object} [rec.schema] The JSON schema sent.
 * @param {string} [rec.raw] The raw model reply (even unparseable ones).
 * @param {object} [rec.parsed] The parsed fragment, if one was produced.
 * @param {boolean} [rec.ok] Whether the pass succeeded.
 * @param {string} [rec.reason] The failure reason, when `ok` is false.
 * @returns {Promise<boolean>} True when the trace was written; false on any failure (a trace
 *   write must never break the pass it records).
 */
export async function record(rec) {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) {
            return false;
        }
        const response = await fetch(`${TRACE_API}/${encodeURIComponent(chatId)}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                t: rec?.t ?? Date.now(),
                turn: Number.isFinite(rec?.turn) ? rec.turn : null,
                mid: Number.isFinite(rec?.mid) ? rec.mid : null,
                why: String(rec?.why ?? ''),
                profileId: String(rec?.profileId ?? ''),
                responseLength: Number.isFinite(rec?.responseLength) ? rec.responseLength : null,
                prompt: String(rec?.prompt ?? ''),
                schema: rec?.schema ?? null,
                raw: String(rec?.raw ?? ''),
                parsed: rec?.parsed ?? null,
                ok: !!rec?.ok,
                reason: String(rec?.reason ?? ''),
            }),
        });
        if (response.ok) {
            lastRecord = {
                t: rec?.t ?? Date.now(),
                turn: Number.isFinite(rec?.turn) ? rec.turn : null,
                mid: Number.isFinite(rec?.mid) ? rec.mid : null,
                why: String(rec?.why ?? ''),
                profileId: String(rec?.profileId ?? ''),
                responseLength: Number.isFinite(rec?.responseLength) ? rec.responseLength : null,
                prompt: String(rec?.prompt ?? ''),
                schema: rec?.schema ?? null,
                raw: String(rec?.raw ?? ''),
                parsed: rec?.parsed ?? null,
                ok: !!rec?.ok,
                reason: String(rec?.reason ?? ''),
            };
        }
        return response.ok;
    } catch {
        // The trace is evidence, not a gate: a network hiccup must not fail the pass it records.
        return false;
    }
}

/**
 * Load every recorded pass for the current chat, oldest first.
 * @returns {Promise<Array<object>>} The trace records.
 */
export async function load() {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) {
            return [];
        }
        const response = await fetch(`${TRACE_API}/${encodeURIComponent(chatId)}`, {
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            return [];
        }
        return await response.json();
    } catch {
        return [];
    }
}
