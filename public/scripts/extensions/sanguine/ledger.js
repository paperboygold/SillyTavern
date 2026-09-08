/**
 * fold/ledger.js: the client half of the durable event ledger.
 *
 * `src/endpoints/sanguine-ledger.js` is the transport, `ledger-table.js` is the replay algebra, and
 * this is the glue that knows about SillyTavern: which campaign a chat belongs to, when to hydrate,
 * and how an op gets from a mutation to disk.
 *
 * The problem this module exists to solve.
 *
 * `chronicle.loadEvents()` is synchronous and called on every render, every prompt build, every
 * fold. The ledger is a file behind an HTTP round trip. Those cannot be reconciled by making reads
 * async: that would touch every consumer in the extension and turn a fold into a promise.
 *
 * So the ledger is read ONCE per chat, into an in-memory table, and every synchronous read is served
 * from that table. Writes go both ways at once: the table is updated immediately (so the next render
 * is correct) and the op is queued for the server (so the next reload is correct). This is the same
 * shape `chat_metadata` already had, an in-memory object plus a debounced save, with the debounce
 * replaced by an append that cannot lose earlier writes.
 *
 * Identity: a campaign is not a chat.
 *
 * `chat_metadata.fold.campaign` is a UUID minted here on first use and carried in the chat file, the
 * same way SillyTavern mints `chat_metadata.integrity` (`public/script.js:7610-7611`). It survives
 * rename and file moves, which the existing `sanguine-traces` store does not, that one keys on the chat
 * FILENAME (`src/endpoints/sanguine-trace.js:36`), so a renamed chat silently orphans its own traces.
 *
 * A copied chat inherits the same `campaign` in its metadata, which is exactly the fork signal:
 * `chatId` records which chat file owns the campaign, so a chat whose `chatId` no longer matches the
 * file it is loaded from is a branch, and forks rather than writing into its parent's timeline.
 *
 * What this module deliberately does NOT do.
 *
 * No rewind, no fork UI, no ST branch hooks. Those are the timeline layer and they belong on top of
 * a ledger that is already carrying the ops correctly. This module's job is to make the op stream
 * exist and be durable; nothing here decides what a point in time means.
 */

import { chat, chat_metadata, getCurrentChatId, getRequestHeaders } from '../../../script.js';
import { uuidv4 } from '../../utils.js';
import { effectiveOps, replay } from './ledger-table.js';
import { SANGUINE_METADATA_KEY } from './metadata-key.js';
import * as observe from './observe.js';

const LEDGER_API = '/api/sanguine-ledger';

/**
 * Hydrated state for the chat currently loaded.
 *
 * Keyed by campaign so a chat switch cannot serve the previous chat's events for the window between
 * the switch and the hydrate, the guard is identity, not a boolean, because a boolean would be
 * true for the wrong campaign during exactly that window.
 *
 * @type {{campaign: string, events: Map<string, object>, hits: Map<string, number>, at: number, damaged: number}|null}
 */
let hydrated = null;

/** Ops appended locally but not yet acknowledged by the server, oldest first. */
let queue = [];
let flushing = false;

/**
 * The blob this chat persists under.
 *
 * The key is IMPORTED, never spelled here. It was spelled here once, and when the extension was
 * renamed the definition moved and this copy did not: `campaignId()` began reading a property
 * nothing writes, returned `''` for every chat, and the ledger stopped hydrating and stopped
 * appending without a single error. `metadata-key.js` is a leaf precisely so this import is
 * available: a missed import fails at load, a missed literal fails for a month.
 *
 * @returns {object} The sanguine blob, or null when this chat has none.
 */
function foldBlob() {
    const blob = chat_metadata?.[SANGUINE_METADATA_KEY];
    return blob && typeof blob === 'object' ? blob : null;
}

/**
 * The campaign this chat belongs to, minting one if it has none.
 *
 * @param {boolean} [create] Mint when absent. Reads pass false so a query cannot dirty a chat.
 * @returns {string} The campaign id, or '' when there is no chat or none exists.
 */
export function campaignId(create = false) {
    const blob = foldBlob();
    if (!blob) {
        return '';
    }
    if (!blob.campaign && create) {
        blob.campaign = uuidv4();
        blob.chatId = String(getCurrentChatId() ?? '');
    }
    return String(blob.campaign ?? '');
}

/**
 * Has this chat been copied away from the campaign it holds?
 *
 * SillyTavern's branch and checkpoint actions copy the chat file wholesale, metadata included, so
 * the child arrives holding its parent's campaign id and would otherwise append into the parent's
 * timeline: two stories writing one history. `chatId` is the tell: it records the file that owned
 * the campaign when the id was minted, so a mismatch means this metadata arrived by copy.
 *
 * Reported rather than acted on. Forking is the timeline layer's decision and needs a point to fork
 * AT, which this module does not compute.
 *
 * NOTHING CALLS THIS YET, and it is kept anyway: it is the only implementation of the branch-copy
 * test in the codebase, and the hazard it detects, two stories appending to one campaign's
 * timeline: is silent and unrecoverable if it happens. Deleting it would not remove dead code, it
 * would remove the only thing that could ever notice.
 *
 * @returns {boolean} True when the loaded chat is not the campaign's owner.
 */
export function isBranched() {
    const blob = foldBlob();
    const here = String(getCurrentChatId() ?? '');
    return !!blob?.campaign && !!blob?.chatId && !!here && blob.chatId !== here;
}

/** @returns {boolean} True when reads should be served from the ledger rather than `chat_metadata`. */
export function isHydrated() {
    return !!hydrated && hydrated.campaign === campaignId();
}

/** @returns {Map<string, object>} The hydrated event table; empty when not hydrated. */
export function events() {
    return isHydrated() ? hydrated.events : new Map();
}

/**
 * The hydrated retrieval counts; empty when not hydrated.
 *
 * Uncalled today, and kept on purpose. This is the read side of the ledger's `hit` op, and the
 * counter it exposes has a LIVE consumer: `chronicle-table.js` `selectEvictions` scores an event's
 * retention as `hits × 10` against recency. That consumer is currently fed from
 * `chat_metadata.chronicle.hits` (written by `chronicle.noteHit`), which lives inside the 128 KiB
 * blob whose eviction pressure is the entire reason this ledger exists, so the durable copy is one
 * `emit({op:'hit'})` in `noteHit` away, and this is the accessor it would be read through. An
 * unfinished wire, not a dead end.
 *
 * @returns {Map<string, number>} The hydrated retrieval counts; empty when not hydrated.
 */
export function hits() {
    return isHydrated() ? hydrated.hits : new Map();
}

/** @returns {number} How many unreadable lines the hydrate found. Non-zero means do not trust state. */
export function damaged() {
    return hydrated?.damaged ?? 0;
}

/** Drop the hydrated table. Call on chat change, before the new chat's hydrate. */
export function reset() {
    hydrated = null;
    queue = [];
}

/**
 * The newest message index in the chat right now.
 *
 * This is `fmid`: the frontier the conversation stood at when an op was appended, and the only
 * join between a message coordinate and a `seq`. Deliberately NOT the event's own `mid`: that is the
 * event's ANCHOR, which points backwards for a review closure settling an old thread and is absent
 * entirely for a world move, so anchors cannot order a timeline.
 *
 * @returns {number} The frontier, or -1 for an empty chat.
 */
export function frontier() {
    return Array.isArray(chat) ? chat.length - 1 : -1;
}

/**
 * Read the campaign's ops and fold them into memory.
 *
 * Idempotent per campaign: calling it again for a campaign already hydrated is a no-op, because the
 * cost is a full replay and the caller (a chat-load event) can fire more than once.
 *
 * @returns {Promise<boolean>} True when the ledger is now serving reads.
 */
export async function hydrate() {
    // Minting here is what starts the ledger at all.
    //
    // This read `campaignId()` without creating, and the result was a deadlock nothing could break:
    // hydrate needs a campaign, only `emit` minted one, and `chronicle.saveEvents` only calls `emit`
    // once hydrated. A chat that had never written to the ledger therefore never could. Measured on
    // the live Wuxia chat after wiring: `isHydrated() === false`, `campaignId() === ''`, 230 events
    // in metadata and zero on disk.
    //
    // A campaign id costs one field in `chat_metadata`, the same way SillyTavern mints
    // `chat_metadata.integrity` on load, and a chat that is opened and never played simply owns an
    // empty ledger.
    const campaign = campaignId(true);
    if (!campaign) {
        // No fold blob at all, a chat fold has never touched. Nothing to hydrate and nothing to mint.
        return false;
    }
    if (hydrated?.campaign === campaign) {
        return true;
    }
    try {
        const response = await fetch(`${LEDGER_API}/${encodeURIComponent(campaign)}`, {
            method: 'GET',
            headers: getRequestHeaders(),
        });
        if (!response.ok) {
            return false;
        }
        const body = await response.json();
        const { ops } = effectiveOps(body?.ops ?? []);
        const tables = replay(ops);
        hydrated = {
            campaign,
            events: tables.events,
            hits: tables.hits,
            at: tables.at,
            damaged: Number(body?.damaged) || 0,
        };
        // A torn tail is expected after a crash and is not damage, the op was never acknowledged.
        // A damaged line in the middle IS: ops after it were acknowledged, so the fold is missing an
        // event and cannot say which. Surfaced loudly rather than folded over quietly.
        if (hydrated.damaged) {
            observe.note('ledger:damaged', hydrated.damaged);
            console.error(`[sanguine] ledger for campaign ${campaign} has ${hydrated.damaged} unreadable line(s); state is incomplete`);
        }
        observe.note('ledger:hydrated', ops.length);
        return true;
    } catch (error) {
        // A ledger that will not load must not take the chat down with it: reads fall back to
        // `chat_metadata` and the chat stays playable on whatever it still holds.
        console.error('[sanguine] ledger hydrate failed; falling back to chat metadata', error);
        return false;
    }
}

/**
 * Append ops to the campaign's ledger.
 *
 * Applied to the in-memory tables FIRST, so the next synchronous read is correct whether or not the
 * network is. The server assigns the real `seq`; the optimistic local numbers are provisional and
 * are replaced wholesale by the next hydrate. That is safe because `seq` is only ever compared
 * within one hydration, nothing persists a local seq.
 *
 * @param {Array<object>} ops Ops without envelope fields; `opId`/`fmid` are added here.
 * @returns {Promise<boolean>} True when the server acknowledged.
 */
export async function emit(ops) {
    const campaign = campaignId(true);
    if (!campaign || !Array.isArray(ops) || !ops.length) {
        return false;
    }
    const fmid = frontier();
    const stamped = ops.map(op => ({ ...op, opId: uuidv4(), fmid, chat: String(getCurrentChatId() ?? '') }));

    // Optimistic local apply. Provisional seq numbers continue from whatever is hydrated, so the
    // ordering within this session is right even before the server answers.
    if (isHydrated()) {
        const local = stamped.map((op, index) => ({ ...op, seq: hydrated.at + index + 1 }));
        const tables = replay(local, hydrated);
        hydrated.events = tables.events;
        hydrated.hits = tables.hits;
        hydrated.at = tables.at;
    }

    queue.push({ campaign, ops: stamped });
    return flush();
}

/**
 * Send queued ops, oldest first, stopping at the first failure.
 *
 * Order matters and a hole is worse than a delay: skipping a failed batch to send a later one would
 * put ops on the timeline in an order that never happened. `opId` makes a retry idempotent
 * (`ledger-table.js` `effectiveOps` dedupes on it), so re-sending after an ambiguous failure is
 * always safe, which is what lets this retry at all rather than guessing whether the write landed.
 *
 * @returns {Promise<boolean>} True when the queue drained.
 */
export async function flush() {
    if (flushing) {
        return false;
    }
    flushing = true;
    try {
        while (queue.length) {
            const batch = queue[0];
            const response = await fetch(`${LEDGER_API}/${encodeURIComponent(batch.campaign)}`, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(batch.ops),
            });
            if (!response.ok) {
                observe.note('ledger:deferred', queue.length);
                return false;
            }
            queue.shift();
        }
        return true;
    } catch (error) {
        console.error('[sanguine] ledger append failed; ops held for retry', error);
        return false;
    } finally {
        flushing = false;
    }
}

// A `pending()` accessor, `queue.reduce((n, b) => n + b.ops.length, 0)`, used to sit here for a
// "N ops unsent" chip nobody built. Removed: it had no caller, no unique logic, and the queue
// already reports the only condition that matters (a failed append) through `console.error` in
// `flush` above. `isBranched` and `hits` above are also uncalled and deliberately KEPT, see their
// notes; the difference is that they carry logic or a mechanism nothing else provides, and this
// carried neither.
