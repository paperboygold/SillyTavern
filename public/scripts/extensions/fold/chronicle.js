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
import * as cold from './cold-store.js';
import * as ledger from './ledger.js';
import { PRUNE_MEMORY, commit, loadTable, registerPruner } from './store.js';

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

/**
 * The event table.
 *
 * ── One chokepoint, so the substrate can change without touching eight mutation sites ──
 *
 * Every read in the extension comes through here and every write goes through `saveEvents` below.
 * That pair is why the durable ledger could be introduced without rewriting `applyExtraction`,
 * `amend`, `forget`, the three `record*Event` functions or the pruners: they all still speak in
 * whole tables, and the two functions underneath decide where the bytes live.
 *
 * When the ledger is hydrated it is the authority. Otherwise this falls back to `chat_metadata`,
 * which is what keeps a chat playable when the server is unreachable, when the hydrate failed, and
 * for every chat written before the ledger existed.
 *
 * @returns {Map<string, import('./chronicle-table.js').ChronicleEvent>} The ledger.
 */
export function loadEvents() {
    // ── A COPY, because `loadTable` returns one and callers rely on it ──
    //
    // `loadTable` rebuilds a fresh Map from the stored object on every call (`store.js:158-168`), so
    // every site here treats what it gets as its own: `retireDeltas` calls `insert_with` straight
    // onto the result, `forget` deletes from it, the pruners rebuild it. Handing back the live cache
    // would break that contract twice over — callers would mutate hydrated state directly, and
    // `saveEvents` would then diff the cache against itself, find nothing changed, and emit no ops
    // at all. The ledger would look healthy and record nothing.
    return ledger.isHydrated() ? new Map(table_entries(ledger.events())) : loadTable(EVENTS_PATH);
}

/**
 * Move a chat's existing events into its ledger, once.
 *
 * ── Without this, turning the ledger on empties the chronicle ──
 *
 * `loadEvents` prefers the ledger the moment it hydrates. A chat played before the ledger existed
 * has its events in `chat_metadata` and nothing on disk, so the first hydrate would swap 230 events
 * for zero and every read — the panel, the prompt, the fold — would agree the campaign never
 * happened. Nothing would be lost on disk, but everything would be lost on screen, which is the same
 * thing to the person playing.
 *
 * Runs only when the ledger is genuinely empty, so it cannot re-seed a campaign that already has
 * history, and reads the RAW metadata table rather than `loadEvents` — which by then is answering
 * from the very ledger being seeded.
 *
 * @returns {number} How many events were carried over.
 */
export function seedLedger() {
    if (!ledger.isHydrated() || ledger.events().size) {
        return 0;
    }
    const stored = loadTable(EVENTS_PATH);
    if (!stored.size) {
        return 0;
    }
    const ops = table_entries(stored).map(([key, event]) => ({ op: 'ev', k: key, e: event }));
    ledger.emit(ops);
    observe.note('ledger:seeded', ops.length);
    console.debug(`[fold] seeded ledger with ${ops.length} existing event(s)`);
    return ops.length;
}

/**
 * Persist an event table, emitting the ops that describe how it changed.
 *
 * ── The diff is derived, not remembered ──
 *
 * The alternative was to emit an op at each of the eight sites that mutate events. That spreads a
 * correctness requirement — "every mutation must also emit" — across code whose authors have no
 * reason to know the ledger exists, and the failure mode is silent: an event that changes in memory,
 * renders correctly all session, and is simply absent after a reload. Diffing the table the caller
 * hands back cannot miss a mutation, because the mutation is the only thing it looks at.
 *
 * A changed row emits a whole-row `ev` rather than an `amend`. `amend` is a byte optimisation for a
 * summary rewrite; `ev` is last-write on the key and is correct for any change, so the reader keeps
 * understanding `amend` (older lines, other writers) while the writer only ever needs one op.
 *
 * @param {Map<string, object>} next The table as it should now be.
 */
function saveEvents(next) {
    // `chat_metadata` is still written while the ledger is the authority. It is one small table, it
    // is what a downgrade or a failed hydrate falls back to, and the wall this design removes is the
    // chronicle's GROWTH — a mirror that the pruner is free to shed costs nothing to keep correct.
    commit(EVENTS_PATH, next);

    if (!ledger.isHydrated()) {
        return;
    }
    const before = ledger.events();
    const ops = [];
    for (const [key, event] of table_entries(next)) {
        if (lookup(before, key, null) !== event) {
            ops.push({ op: 'ev', k: key, e: event });
        }
    }
    for (const [key] of table_entries(before)) {
        if (!next.has(key)) {
            ops.push({ op: 'forget', k: key });
        }
    }
    if (ops.length) {
        // Fire-and-forget: the local tables are already correct, and a queued op survives a failure
        // to be retried. Awaiting here would make every event write block a render on the network.
        ledger.emit(ops);
    }
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
        mentions: {
            type: 'array',
            // ── Coverage, not a substring proxy ([ROUTER]) ──
            //
            // The delta mention gates used to decide "did the window name this item?" by token
            // matching the window, which fails on paraphrase and on any language fold did not spell
            // out. The model already READ the window; `mentions` is its structural answer for what
            // the excerpt actually names. A delta is admitted only when its item appears in this
            // set — the model's own report of what it saw, in any language.
            // The wording rule is the protocol half of the coverage fix (`state-table.js`
            // `validateInventory`): fold no longer compares a delta's item name to this list, so
            // the two only agree if the model makes them agree. Asking for one spelling costs a
            // clause and removes every reason fold would ever need to guess at the correspondence.
            description: 'Every item, vital or condition the NEW excerpt actually names, exactly as written: "silver", "the spear", "ribs". One entry per distinct name. An item the excerpt does not name is never listed. When this event also carries a delta, word the delta\'s "item" or "name" EXACTLY as you write it here — one spelling for one thing, in both places.',
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
 * @param {Set<number>|null} [context.visible] The mids this pass displayed. Passed through for
 *   `shown`'s reason exactly: the already-recorded gate may only refuse a re-tell of something the
 *   model can still see, and only the caller that built the window knows what that was.
 * @returns {{added: number, replaced: number, duplicates: number, deltas: number, rejected: number}} What happened.
 */
export function applyExtraction(fragment, { sources = [], now = Date.now(), windowText = '', validateDelta = null, onRejections = null, shown = null, visible = null } = {}) {
    const raw = Array.isArray(fragment) ? fragment : [];
    if (!raw.length || !sources.length) {
        return { added: 0, replaced: 0, duplicates: 0, deltas: 0, rejected: 0 };
    }

    // Events are attributed to the newest source in the window: that is the turn whose content
    // the extraction is really about, and it is the key that goes stale first when the user
    // swipes it away — which is the behaviour we want.
    const anchor = sources[sources.length - 1];

    // ── Coverage by the model's own report, never a substring proxy ([ROUTER]) ──
    //
    // Every event's `mentions` names what the model says the excerpt actually touched. Fold
    // builds one coverage set across the batch and hands it to the delta validator, which admits
    // an item/vital/mark only when its name is in it — replacing the token-match mention gate
    // that failed on paraphrase and on any language fold did not spell out.
    const mentioned = new Set(
        raw.flatMap(candidate => Array.isArray(candidate?.mentions) ? candidate.mentions : [])
            .map(name => String(name ?? '').trim().toLowerCase())
            .filter(Boolean),
    );

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
                const outcome = validateDelta(candidate.delta, { windowText, shown, mentioned, visible });
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

    // ── With a durable ledger, MAX_EVENTS bounds what is HOT, not what exists ──
    //
    // `pruneEvents` decides what the chronicle forgets forever, and `saveEvents` turns a missing key
    // into a `forget` op. Run against a hydrated ledger that combination is a permanent deletion
    // from disk to satisfy a cap that only ever existed because the metadata blob was the store.
    //
    // So the cap becomes a view: every event stays, and what gets ranked into a prompt is already
    // bounded by `topK` at retrieval. That is the hot/cold split moving from storage to selection,
    // and it is what makes a year-long campaign hold its whole history — measured at 8k events the
    // fold is single-digit milliseconds, so keeping them costs nothing worth saving.
    const bounded = !ledger.isHydrated();
    const { events: pruned, evicted } = bounded
        ? pruneEvents({
            events: outcome.events,
            hits: loadHits(),
            liveHashes: liveHashes(),
            max: MAX_EVENTS,
        })
        : { events: outcome.events, evicted: [] };

    // Both of these used to happen silently. MAX_EVENTS decides what the chronicle forgets and
    // DUPLICATE_WINDOW decides what it declines to remember; neither left any evidence that it had
    // acted, so neither number could be judged. See observe.js.
    if (evicted?.length) {
        // ── Evicted events demote, they do not vanish ──
        //
        // An event past MAX_EVENTS is archived to the cold store with its summary and keywords
        // intact, so recall can still find it by subject ([EVICT]: selection cannot bound a store).
        // `events-evicted` now means "demoted", and the cold store's own ceiling is the only place
        // an event can truly be dropped.
        demoteEvents(evicted, outcome.events);
        observe.noteCap('events-evicted', evicted.length);
    }
    if (outcome.duplicates.length) {
        observe.noteCap('duplicate-suppressed', outcome.duplicates.length);
    }

    saveEvents(pruned);
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
        // ── The tiebreak, because `t` alone is not a total order ──
        //
        // `t` is a millisecond stamp and one extraction pass records several events inside one
        // tick, so same-tick events compare equal and their order falls through to whatever order
        // the table happened to enumerate. Nothing guarantees that across a reload: the table is
        // rebuilt from a plain object each time the chat loads.
        //
        // The fold cares. `deriveState` applies a restated total as last-write and the duplicate
        // guard compares against what it has already seen, so two same-tick deltas on one key can
        // land in either order and produce different quantities from identical events. The key is
        // content-derived and stable, which is exactly what a tiebreak needs — it carries no
        // meaning, it just has to be the same every time. (When ops carry a server `seq`, that
        // becomes the better second term: it is the clock `merge_max_converges` asks for, where
        // this is only a deterministic stand-in.)
        .sort(([keyA, a], [keyB, b]) => ((a?.t ?? 0) - (b?.t ?? 0)) || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
        .map(([, event]) => event);
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
    saveEvents(events);
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
    saveEvents(events);
    invalidateIndex();
    return true;
}

/**
 * Append an event recording how an adjudicated attempt went.
 *
 * ── Why this exists, and why it carries the outcome as STRUCTURE ──
 *
 * `verdict-table.js` `precedentFor` used to read the outcome of past attempts off the summary's
 * English — regex-ing for "fail|refused|could not|unable|lost|denied" — which is the same
 * language-dependent guess the scene clock used to make before the scene probe reported `elapsed`.
 * The verdict is decided in CODE, so it can record its own outcome as data: a `worked`/`failed`
 * field beside the attempt's keywords, read by the next `precedentFor` without parsing prose. The
 * summary is kept for the trail and the keywords are kept for the overlap match; only the
 * guess-from-English is gone.
 *
 * Always-live, like a world move: a verdict is a fact about the attempt, not a claim about one
 * message's content, so swiping the attempt's own message should not retract the fact that it was
 * adjudicated. The audit `src: 'verdict'` keeps it distinguishable from world moves and hand edits.
 *
 * @param {object} params The event.
 * @param {string} params.summary Summary text.
 * @param {string[]} [params.keywords] Keywords describing the attempt.
 * @param {'worked'|'failed'} params.outcome How it went.
 * @returns {boolean} True if it was recorded.
 */
export function recordVerdictEvent({ summary, keywords = [], outcome = null }) {
    if (outcome !== 'worked' && outcome !== 'failed') {
        return false;
    }
    const now = Date.now();
    const event = normalizeEvent({ summary, keywords }, {
        now, src: 'verdict', srcKey: USER_ANCHOR,
        // The outcome rides the delta the way a thread closure does — a structured fact the fold
        // can read without touching the summary.
        delta: { outcome },
    });
    if (!event) {
        return false;
    }
    const { dropped, ...stored } = event;
    if (dropped) {
        observe.noteCap('keywords-dropped', dropped);
    }
    const events = loadEvents();
    insert_with(events, merge_b, `verdict:${now}:${worldEventSeq++}`, stored);
    saveEvents(events);
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
    saveEvents(events);
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
        saveEvents(events);
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
    saveEvents(events);
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
    saveEvents(events);
    invalidateIndex();
}

/** Called with the keys about to be demoted, so their deltas can be carried forward. */
let onEvict = null;

/**
 * Register the hook that carries evicted deltas into the state baseline.
 * @param {(evicted: string[], before: Map<string, object>) => void} fn The hook.
 */
export function onEviction(fn) {
    onEvict = fn;
}

// Over-budget pruning: shed the least valuable events until the blob fits.
registerPruner((overBy) => {
    // ── The MIRROR is pruned here, never the ledger ──
    //
    // `loadEvents()` answers from the ledger once it hydrates, and `saveEvents` diffs whatever it is
    // handed against that ledger and emits `forget` ops for anything missing. So reading through
    // either of them here would have made the budget pruner DELETE events from the durable store —
    // to fit a metadata budget the durable store exists to escape. Read and write the raw table.
    const stored = loadTable(EVENTS_PATH);
    if (!stored.size) return;
    // Roughly 150 bytes per event; always drop at least a few so repeated passes converge.
    const target = Math.max(5, Math.ceil(overBy / 150));

    if (ledger.isHydrated()) {
        // ── Cache mode: shedding is free, because the ledger already holds these ──
        //
        // With a durable copy on disk, the metadata table stops being the chronicle and becomes a
        // convenience: what a failed hydrate falls back to, and what a chat export carries. Both
        // want RECENT memory, so this keeps the newest and drops the oldest — the opposite of
        // `pruneEvents`, which ranks by retrieval value because it was choosing what to forget
        // forever. Nothing is forgotten here, so value does not enter into it.
        //
        // No cold demote and no `carryForward`: both exist to survive an eviction that destroys
        // data, and this one destroys none.
        const keep = table_entries(stored)
            .sort((a, b) => (a[1]?.t ?? 0) - (b[1]?.t ?? 0))
            .slice(target);
        const shed = stored.size - keep.length;
        if (!shed) return;
        commit(EVENTS_PATH, new Map(keep));
        observe.noteCap('mirror-shed', shed);
        console.debug(`[fold] shed ${shed} mirrored event(s); the ledger still holds them`);
        return;
    }

    // ── Authority mode: no ledger, so the mirror IS the chronicle ──
    //
    // Unchanged, and it has to stay: an event shed to fit the blob is archived to the cold store,
    // not destroyed ([EVICT]), and its deltas are carried into the state baseline first.
    const { events: pruned, evicted } = pruneEvents({
        events: stored,
        hits: loadHits(),
        liveHashes: liveHashes(),
        max: Math.max(0, stored.size - target),
    });
    if (!evicted.length) return;
    demoteEvents(evicted, stored);
    observe.noteCap('events-evicted', evicted.length);
    commit(EVENTS_PATH, pruned);
    invalidateIndex();
    console.debug(`[fold] chronicle pruned ${evicted.length} event(s) to fit the metadata budget`);
}, PRUNE_MEMORY);

/**
 * Archive a list of evicted events to the cold store, whole.
 *
 * `evicted` is a list of table keys (`chronicle-table.js` `pruneEvents`); each key is looked up in
 * the pre-prune map so the row is archived exactly as it was stored, then the cold store keeps it
 * with its summary and keywords intact. The key used for cold storage is the event's own key, so a
 * later pass that re-proposes the same beat can dedupe against it.
 *
 * @param {string[]} evicted Event keys that left the hot ledger.
 * @param {Map<string, object>} before The ledger BEFORE pruning, to read the rows from.
 */
function demoteEvents(evicted, before) {
    // ── Last chance to keep what the fold is about to lose ──
    //
    // The rows below carry `s`, `kw`, `t` and `src` into cold and drop `d`. That is right for
    // recall, which wants the summary, and wrong for state, which IS the deltas: once this runs the
    // contribution is unrecoverable and the balance quietly rewinds. Injected rather than imported
    // because `state.js` imports this module, the same direction `validateDelta` already runs.
    try {
        onEvict?.(evicted, before);
    } catch (error) {
        // A failure here must not stop the eviction, or a chat over budget can never get under it.
        // Losing the carry-forward is bad; refusing to prune is unrecoverable.
        console.error('[fold] failed to carry evicted deltas forward', error);
    }
    for (const key of evicted) {
        const event = before.get(key);
        if (!event) {
            continue;
        }
        cold.demote({
            kind: 'event',
            key,
            row: {
                s: event.s,
                kw: Array.isArray(event.kw) ? event.kw : [],
                t: event.t,
                src: event.src,
            },
            at: event.t ?? 0,
        });
    }
}
