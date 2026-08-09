/**
 * fold/chronicle.js — the append-only event ledger.
 *
 * SillyTavern's summarize extension is the Map face of the table: `getLatestMemoryFromChat` walks
 * backwards and returns the first summary it finds, so the newest write is the only one that
 * survives and everything older is unreachable. The chronicle is the same table under
 * `merge_graph` instead: every significant event is retained and retrieved by relevance. The old
 * behaviour is still available as one read off this table, so nothing regresses.
 *
 * Storage goes through store.js; the pure ranking, dedup and eviction logic is in
 * chronicle-table.js. This module is the glue that knows about SillyTavern.
 */

import { chat, substituteParams } from '../../../script.js';
import { getStringHash } from '../../utils.js';
import { insert_with, lookup, merge_b, merge_bu, merge_nb, table_entries } from './lib/hash.js';
import {
    buildKeywordIndex,
    applyEvents,
    hasDelta,
    livenessKey,
    MAX_EVENTS,
    MAX_KEYWORDS,
    normalizeEvent,
    pruneEvents,
    rankEvents,
    renderEvents,
} from './chronicle-table.js';
import * as observe from './observe.js';
import { commit, loadTable, registerPruner } from './store.js';

const EVENTS_PATH = 'chronicle.events';
const HITS_PATH = 'chronicle.hits';

/** Liveness key for user-authored events, which are live on every branch. */
export const USER_ANCHOR = 'usr';

/**
 * Disambiguates user events recorded within the same millisecond. `Date.now()` alone is not a
 * unique key — several edits in one tick collided and silently overwrote each other.
 */
let userEventSeq = 0;
let worldEventSeq = 0;

/** Cached derived index, rebuilt whenever the ledger changes or the chat does. */
let keywordIndex = null;

/**
 * The identity of a piece of chat content.
 *
 * Deliberately the content hash and not `{messageId, swipeId}`: swipe indices shift under
 * MESSAGE_SWIPE_DELETED and message ids shift when history is edited, but content is stable.
 * It is also the exact expression the vectors extension uses (vectors/index.js:829), which is
 * what will let a later recall layer recognise a chronicle event and a vector hit on the same
 * message as the same evidence.
 *
 * @param {string} text Message text.
 * @returns {string} The content key.
 */
export function contentKey(text) {
    return String(getStringHash(substituteParams(String(text ?? ''))));
}

/**
 * The set of content keys currently present in the chat — the Set face.
 *
 * This one lookup is the entire branch-awareness mechanism. An event extracted from swipe 2 keys
 * on swipe 2's content; navigate to swipe 1 and that key is no longer live, so the event becomes
 * invisible without being destroyed. Navigate back and it returns.
 *
 * @returns {Map<string, boolean>} Live content keys.
 */
export function liveHashes() {
    const table = new Map();
    // User-authored events are always live. Liveness asks "did the turn this was extracted from
    // survive the branch", which is not a question about something the user asserted directly —
    // and anchoring a hand edit to the last message would kill it the moment that message was
    // swiped away, or immediately if the chat was empty when it was made.
    insert_with(table, merge_nb, USER_ANCHOR, true);
    for (const message of chat ?? []) {
        if (!message?.mes) continue;
        insert_with(table, merge_nb, contentKey(message.mes), true);
    }
    return table;
}

/** @returns {Map<string, import('./chronicle-table.js').ChronicleEvent>} The ledger. */
export function loadEvents() {
    return loadTable(EVENTS_PATH);
}

/**
 * Who wrote the ledger.
 *
 * ── Why this is worth surfacing ──
 *
 * A chat ran to 29 turns with 28 events and ZERO from extraction, and nothing anywhere said so.
 * The cause was a setting — `interval: 999`, written into real settings by a test harness — and
 * every visible symptom was downstream of it: no item placements, no people, no leads, everything
 * filed as carried. A subsystem that never runs produces no errors, no rejections and no log line,
 * so the only way to notice is to ask what it has contributed.
 *
 * @returns {{user: number, llm: number, total: number}} Events by source.
 */
export function sources() {
    let user = 0;
    let llm = 0;
    for (const [, event] of table_entries(loadEvents())) {
        if (event?.src === 'llm') llm++;
        else user++;
    }
    return { user, llm, total: user + llm };
}

/** @returns {Map<string, number>} Retrieval hit counts. */
export function loadHits() {
    return loadTable(HITS_PATH);
}

/**
 * Drop the cached keyword index. Call on chat change.
 */
export function invalidateIndex() {
    keywordIndex = null;
}

/**
 * The keyword index, derived from the ledger rather than stored.
 *
 * Rebuilding is a fold over at most MAX_EVENTS x MAX_KEYWORDS entries — microseconds — and it
 * cannot drift out of sync with the ledger the way a persisted index can. That trade is not close.
 *
 * @returns {Map<string, string[]>} keyword -> event keys.
 */
export function getKeywordIndex() {
    if (!keywordIndex) {
        keywordIndex = buildKeywordIndex(loadEvents());
    }
    return keywordIndex;
}

/**
 * The JSON schema fragment this probe contributes to the shared extraction call.
 *
 * @param {object} [options] Options.
 * @param {object|null} [options.deltaSchema] Schema for the per-event state delta, when state
 *   tracking is on. State is a fold over these deltas, so they belong ON the event rather than in
 *   a parallel structure the model has to keep in sync.
 * @returns {object} A JSON Schema fragment.
 */
export function extractionSchema({ deltaSchema = null } = {}) {
    const properties = {
        summary: {
            type: 'string',
            description: 'One sentence, past tense, naming who did what. No commentary.',
        },
        keywords: {
            type: 'array',
            // Derived, not restated. The prompt and the slice in `normalizeEvent` were two copies
            // of one number, and calibration cannot tell a model obeying "at most six" from fold
            // clipping at six — the observed max was exactly 6 either way. One source, no ambiguity.
            description: `Two to ${MAX_KEYWORDS} lowercase search keywords: names, places, objects, actions.`,
            items: { type: 'string' },
        },
    };
    if (deltaSchema) {
        properties.delta = deltaSchema;
    }

    return {
        type: 'array',
        description: 'Significant narrative events worth remembering. Empty if nothing of consequence happened.',
        items: {
            type: 'object',
            properties,
            // Strict structured output requires EVERY property to be listed, so this must track
            // `properties` exactly rather than naming a fixed subset.
            required: Object.keys(properties),
            // Also required by OpenAI on EVERY object in the schema, not just the root. Omitting
            // it fails the whole request with a 400, taking every other probe down with it.
            additionalProperties: false,
        },
    };
}

/**
 * The instruction fragment describing what to extract.
 * @returns {string} Prompt text.
 */
export function extractionInstruction() {
    return [
        'Record only events with lasting consequence: decisions, revelations, changes in',
        'relationship or location, promises, injuries, acquisitions. Ignore small talk,',
        'descriptions of scenery, and anything already obvious from the immediate context.',
        'Return an empty array if nothing of consequence happened.',
    ].join(' ');
}

/**
 * Apply an extracted batch to the ledger.
 *
 * @param {any} fragment The `events` array from the model.
 * @param {object} context Context.
 * @param {Array<{key: string, mid: number}>} context.sources Content keys the batch came from.
 * @param {number} context.now Timestamp.
 * @param {string} [context.windowText] Narrative window, for delta validation.
 * @param {Function|null} [context.validateDelta] Validator supplied by the state module when state
 *   tracking is on. Passed in rather than imported so this module has no dependency on state —
 *   state depends on the chronicle, not the other way round.
 * @param {Function|null} [context.onRejections] Sink for rejected deltas.
 * @param {Set<string>|null} [context.shown] Inventory keys the pinned ledger showed the model this
 *   pass. Passed straight through to the validator; this module never inspects it, for the same
 *   reason it takes `validateDelta` as an argument rather than importing it — the chronicle knows
 *   nothing about state.
 * @returns {{added: number, replaced: number, duplicates: number, deltas: number, rejected: number}} What happened.
 */
export function applyExtraction(fragment, { sources = [], now = Date.now(), windowText = '', validateDelta = null, onRejections = null, shown = null } = {}) {
    const raw = Array.isArray(fragment) ? fragment : [];
    if (!raw.length || !sources.length) {
        return { added: 0, replaced: 0, duplicates: 0, deltas: 0, rejected: 0 };
    }

    // Events are attributed to the newest source in the window: that is the turn whose content
    // the extraction is really about, and it is the key that goes stale first when the user
    // swipes it away — which is the behaviour we want.
    const anchor = sources[sources.length - 1];

    const rejections = [];
    // Every accepted inventory change this pass made, flattened across its events. Returned rather
    // than acted on: the credits-without-debit trigger is a question about the PASS, not about any
    // one event (`FOLD-REDESIGN.md` §5 fix 1, `state-table.js` creditsWithoutDebit), and this is the
    // only layer that sees a whole pass's accepted deltas in one place.
    const credited = [];
    let deltaCount = 0;

    const incoming = raw
        .map((candidate, index) => {
            // Deltas are validated once, here, against the state as currently derived. Anything
            // rejected never enters the ledger, which is what lets the fold stay a pure sum.
            let delta = null;
            if (validateDelta && candidate?.delta) {
                const outcome = validateDelta(candidate.delta, { windowText, shown });
                delta = outcome.delta;
                rejections.push(...outcome.rejected);
                if (delta) {
                    deltaCount++;
                    credited.push(...(delta.inv ?? []));
                } else if (!outcome.rejected.length) {
                    // ── "Proposed nothing" is not the same fact as "was never asked" ──
                    //
                    // An event whose delta is all empty arrays validates to null with no rejection,
                    // so it stored silently and no counter anywhere moved. That made a chat with
                    // one delta in nineteen events indistinguishable from a chat where the delta
                    // schema never reached the request — and two rounds of diagnosis went into
                    // telling them apart by hand. A model correctly reporting that a conversation
                    // changed nothing is behaving well; it should still leave a trace.
                    observe.note('extract:delta-empty');
                }
            } else if (!validateDelta) {
                observe.note('extract:delta-off');
            }

            const event = normalizeEvent(candidate, { now, mid: anchor?.mid, src: 'llm', srcKey: anchor.key, delta });
            if (!event) {
                // The model proposed something and it never became an event — no summary, or no
                // keyword that could ever retrieve it. Counted, because an unusable candidate and a
                // candidate that was never proposed used to look identical from the data, and that
                // ambiguity is the one this whole instrument exists to remove.
                observe.noteCap('event-unusable');
                return null;
            }
            // `MAX_KEYWORDS` reads as saturated in calibration — max 6, p95 6, verdict BINDS — and
            // that is an artefact of the instrument, not a finding: the extraction prompt asks for
            // "Two to 6" keywords, so a model returning exactly 6 is obeying, not being clipped.
            // Only a genuine clip is counted, which is what makes the two distinguishable at last.
            const { dropped, ...stored } = event;
            if (dropped) {
                observe.noteCap('keywords-dropped', dropped);
            }
            // Distinct table keys within a batch, but every event carries `k` = the anchor's
            // content key, which is what liveness is judged on. Deriving liveness from the table
            // key instead would make every multi-event batch invisible the moment it was written.
            const key = raw.length === 1 ? anchor.key : `${anchor.key}:${index}`;
            return { key, event: stored };
        })
        .filter(Boolean);

    const current = loadEvents();
    const outcome = applyEvents({ events: current, incoming });

    const { events: pruned, evicted } = pruneEvents({
        events: outcome.events,
        hits: loadHits(),
        liveHashes: liveHashes(),
        max: MAX_EVENTS,
    });

    // Both of these used to happen silently. MAX_EVENTS decides what the chronicle forgets and
    // DUPLICATE_WINDOW decides what it declines to remember; neither left any evidence that it had
    // acted, so neither number could be judged. See observe.js.
    if (evicted?.length) {
        observe.noteCap('events-evicted', evicted.length);
    }
    if (outcome.duplicates.length) {
        observe.noteCap('duplicate-suppressed', outcome.duplicates.length);
    }

    commit(EVENTS_PATH, pruned);
    invalidateIndex();

    if (rejections.length && onRejections) {
        // Anchor every refusal to the message the pass was reading, so the log's cause-link can
        // jump a rejection to the narrative that prompted it.
        onRejections(rejections.map(rejection => ({ ...rejection, mid: anchor.mid })));
    }

    return {
        added: outcome.added.length,
        replaced: outcome.replaced.length,
        duplicates: outcome.duplicates.length,
        deltas: deltaCount,
        rejected: rejections.length,
        // The pass's whole accepted inventory movement, and the refusals beside it. A refused
        // `already-recorded` credit is evidence of an acquisition too — Phase A's known cost, and
        // the shape the directed money question was designed to recover.
        accepted: credited,
        refusals: rejections,
    };
}

/**
 * Every event that is live on the current branch, oldest first.
 *
 * This is what state folds over: pass only live events and swipe-awareness is automatic, because
 * an event whose source content is no longer in the chat stops contributing to the fold.
 *
 * @returns {Array<import('./chronicle-table.js').ChronicleEvent>} Live events in chronological order.
 */
export function liveEvents() {
    const live = liveHashes();
    return table_entries(loadEvents())
        .filter(([key, event]) => lookup(live, livenessKey(key, event), false))
        .map(([, event]) => event)
        .sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0));
}

/**
 * Append a user-authored event. Hand edits go through the ledger like everything else, so the
 * audit trail stays complete and the fold stays the single source of truth.
 *
 * @param {object} params The event.
 * @param {string} params.summary Summary text.
 * @param {string[]} [params.keywords] Keywords.
 * @param {object} [params.delta] State delta.
 * @returns {boolean} True if it was recorded.
 */
export function recordUserEvent({ summary, keywords = [], delta = null }) {
    const now = Date.now();
    const event = normalizeEvent({ summary, keywords }, { now, src: 'user', srcKey: USER_ANCHOR, delta });
    if (!event) {
        return false;
    }
    const { dropped, ...stored } = event;
    if (dropped) {
        observe.noteCap('keywords-dropped', dropped);
    }
    const events = loadEvents();
    insert_with(events, merge_b, `usr:${now}:${userEventSeq++}`, stored);
    commit(EVENTS_PATH, events);
    invalidateIndex();
    return true;
}

/**
 * Append an off-screen world event — a move the world-turn probe attributed to a tracked actor
 * while the camera was elsewhere (FOLD-REDESIGN.md §7).
 *
 * ── Why always-live, like a hand edit and unlike a review closure ──
 *
 * A world move is a narrative assertion the model made about elapsed time the player declared, not a
 * claim ABOUT a specific message's content. Anchoring it to the time-skip message would retract it
 * on a swipe of that message — and `tickCalendar` deliberately does not retract either, for the same
 * reason: the calendar and the world both moved during a span the player asserted happened, and the
 * arithmetic/judgement stays consistent with the clock that moved it. The audit `src: 'world'`
 * distinguishes these from hand edits in the trail without changing their liveness.
 *
 * @param {object} params The event.
 * @param {string} params.summary Summary text.
 * @param {string[]} [params.keywords] Keywords.
 * @param {object} [params.delta] State delta.
 * @returns {boolean} True if it was recorded.
 */
export function recordWorldEvent({ summary, keywords = [], delta = null }) {
    const now = Date.now();
    const event = normalizeEvent({ summary, keywords }, { now, src: 'world', srcKey: USER_ANCHOR, delta });
    if (!event) {
        return false;
    }
    const { dropped, ...stored } = event;
    if (dropped) {
        observe.noteCap('keywords-dropped', dropped);
    }
    const events = loadEvents();
    insert_with(events, merge_b, `world:${now}:${worldEventSeq++}`, stored);
    commit(EVENTS_PATH, events);
    invalidateIndex();
    return true;
}

/**
 * Append an event the review pass authored.
 *
 * ── Why a closure is an event at all ──
 *
 * `FOLD-REDESIGN.md` §2 promises that nothing is deleted in place and that swiping away the closing
 * turn un-closes the thread. Both fall out of putting the closure in the ledger and anchoring it to
 * the message that closed it: liveness is content-keyed (`liveHashes` above), so the closure exists
 * on exactly the branches where its evidence exists. `thread-table.js` `overlayClosures` is the read
 * side and carries the scenario in full.
 *
 * Distinct from `recordUserEvent` in exactly one respect that matters: the anchor. A hand edit is
 * always live because the user asserted it directly and anchoring it to a message would kill it on
 * the next swipe; a review closure is a claim ABOUT a message and must die with it.
 *
 * @param {object} params The event.
 * @param {string} params.summary Summary text.
 * @param {string[]} [params.keywords] Keywords.
 * @param {object} [params.delta] State delta, including `threads` closures.
 * @param {string} [params.srcKey] Content key of the message this reviewed; falls back to
 *   USER_ANCHOR when the pass has no live source, which makes the closure permanent rather than
 *   dropping it — a closure with nowhere to anchor is still a fact somebody read.
 * @param {number} [params.mid] Message index, for the audit trail.
 * @returns {boolean} True if it was recorded.
 */
export function recordReviewEvent({ summary, keywords = [], delta = null, srcKey = '', mid } = {}) {
    const now = Date.now();
    const event = normalizeEvent({ summary, keywords }, {
        now, mid, src: 'review', srcKey: srcKey || USER_ANCHOR, delta,
    });
    if (!event) {
        return false;
    }
    const { dropped, ...stored } = event;
    if (dropped) {
        observe.noteCap('keywords-dropped', dropped);
    }
    const events = loadEvents();
    // Its own key space, and never the anchor's bare content key: `applyExtraction` uses that for a
    // single-event batch, so a review firing on the same message would silently overwrite the
    // extraction's own event.
    insert_with(events, merge_b, `rev:${now}:${userEventSeq++}`, stored);
    commit(EVENTS_PATH, events);
    invalidateIndex();
    return true;
}

/**
 * Every thread closure live on this branch, oldest first.
 *
 * Read by `clocks.view()` and by nothing else. Flattened rather than grouped because the overlay
 * applies them in order and the last writer wins — a thread closed at turn 40 and re-opened by a
 * later review at turn 44 reads open.
 *
 * @returns {Array<{key: string, status: string}>} Closure records.
 */
export function threadClosures() {
    return liveEvents().flatMap(event => (Array.isArray(event?.d?.threads) ? event.d.threads : []));
}

/**
 * Retrieve events relevant to a query, restricted to the live branch.
 * @param {string} queryText Text to match.
 * @param {number} [topK] Maximum results.
 * @returns {Array<{key: string, event: import('./chronicle-table.js').ChronicleEvent, overlap: number}>} Ranked events.
 */
export function query(queryText, topK = 5) {
    const events = loadEvents();
    if (!events.size) {
        return [];
    }
    return rankEvents({
        events,
        kwIndex: getKeywordIndex(),
        queryText,
        liveHashes: liveHashes(),
        topK,
    });
}

/**
 * Render ranked events as a prompt block.
 * @param {Array<{event: object}>} ranked Ranked events.
 * @param {string} [template] Template with {{text}}.
 * @returns {string} The block, or '' if empty.
 */
export function render(ranked, template) {
    return renderEvents(ranked, template);
}

/**
 * Record that events proved useful, so retrieval feeds retention.
 * @param {string[]} keys Event keys that made it into a prompt.
 */
export function noteHit(keys) {
    if (!keys?.length) return;
    const hits = loadHits();
    for (const key of keys) {
        insert_with(hits, merge_bu, key, 1);
    }
    commit(HITS_PATH, hits);
}

/**
 * Everything the UI needs to show the ledger.
 * @returns {{total: number, live: number, events: Array<object>}} A snapshot.
 */
export function snapshot() {
    const events = loadEvents();
    const hits = loadHits();
    const live = liveHashes();
    const rows = table_entries(events).map(([key, event]) => ({
        key,
        summary: event?.s ?? '',
        keywords: event?.kw ?? [],
        at: event?.t ?? 0,
        hits: lookup(hits, key, 0),
        live: lookup(live, livenessKey(key, event), false),
        delta: hasDelta(event) ? event.d : null,
    }));
    return {
        total: rows.length,
        live: rows.filter(r => r.live).length,
        events: rows.reverse(),
    };
}

/**
 * Strip every state delta from the ledger, leaving the summaries intact.
 *
 * State is a fold over these, so this is what "reset the inventory" means here — there is no
 * separate table to clear, and the narrative record survives.
 */
export function clearDeltas() {
    const events = loadEvents();
    let changed = false;
    for (const [key, event] of events) {
        if (hasDelta(event)) {
            const { d, ...rest } = event;
            void d;
            insert_with(events, merge_b, key, rest);
            changed = true;
        }
    }
    if (changed) {
        commit(EVENTS_PATH, events);
        invalidateIndex();
    }
}

/**
 * Remove a single event.
 * @param {string} key Event key.
 */
export function forget(key) {
    const events = loadEvents();
    if (!events.delete(key)) return;
    commit(EVENTS_PATH, events);
    const hits = loadHits();
    if (hits.delete(key)) {
        commit(HITS_PATH, hits);
    }
    invalidateIndex();
}

/**
 * Replace an event's summary, keeping its identity and keywords.
 * @param {string} key Event key.
 * @param {string} summary New summary.
 */
export function amend(key, summary) {
    const events = loadEvents();
    const event = events.get(key);
    if (!event) return;
    const updated = normalizeEvent({ summary, keywords: event.kw }, { now: event.t, mid: event.mid, src: 'user', srcKey: event.k });
    if (!updated) return;
    const { dropped, ...stored } = updated;
    if (dropped) {
        observe.noteCap('keywords-dropped', dropped);
    }
    insert_with(events, merge_b, key, stored);
    commit(EVENTS_PATH, events);
    invalidateIndex();
}

// Over-budget pruning: shed the least valuable events until the blob fits.
registerPruner((overBy) => {
    const events = loadEvents();
    if (!events.size) return;
    // Roughly 150 bytes per event; always drop at least a few so repeated passes converge.
    const target = Math.max(5, Math.ceil(overBy / 150));
    const { events: pruned, evicted } = pruneEvents({
        events,
        hits: loadHits(),
        liveHashes: liveHashes(),
        max: Math.max(0, events.size - target),
    });
    if (!evicted.length) return;
    observe.noteCap('events-evicted', evicted.length);
    commit(EVENTS_PATH, pruned);
    invalidateIndex();
    console.debug(`[fold] chronicle pruned ${evicted.length} event(s) to fit the metadata budget`);
});
