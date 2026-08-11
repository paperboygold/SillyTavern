/**
 * fold/chronicle-table.js — the pure data layer for the chronicle ledger.
 *
 * Imports nothing but ./lib/hash.js, so it runs in plain Node and is unit-testable. Everything
 * needing the app graph (chat, generateRaw, storage) lives in chronicle.js.
 *
 * The ledger is the Graph face of the table: events accumulate under a chat rather than
 * overwriting each other, which is the whole difference between this and a rolling summary.
 * The keyword index is a second Graph face derived from it, and is deliberately NOT persisted —
 * a fold over the events is correct by construction every time, where a stored index can drift
 * out of sync through eviction or a partial write and needs repair code nobody will write.
 */

import { fold, insert_with, lookup, merge_b, merge_bu, merge_graph, table_entries } from './lib/hash.js';

/** Upper bounds, enforced on write. Keeps the JSONL blob bounded and the prompt cheap. */
/*
 * ── Bounds, measured ──
 * Instrument: `tests/util/fold-calibrate.mjs`. Corpus: "Raccoon City First Day", 2026-08-06 —
 * 28 assistant turns, 20 events.
 */
export const MAX_SUMMARY_CHARS = 200;   // observed max 91, p95 91 (n=20) — 2.2x headroom
/**
 * Keywords kept per event.
 *
 * Observed max 6, p95 6 (n=20) — saturating. That reads as a binding cap and is NOT one: the
 * extraction prompt asks for "two to MAX_KEYWORDS", so the model is obeying rather than fold
 * clipping, and calibration cannot separate the two. `chronicle.js` interpolates this constant into
 * that prompt so there is one number instead of two agreeing copies.
 */
export const MAX_KEYWORDS = 6;
export const MAX_KEYWORD_CHARS = 32;    // observed max 23, p95 20 (n=46) — 1.4x headroom
/**
 * Events retained before eviction.
 *
 * Observed 20 events over 28 assistant turns — 0.71 events/turn, so 300 is roughly 420 turns of
 * history. Stated as a turn horizon because that is the quantity a player has intuition about;
 * `cap:events-evicted` in `/fold-calibrate` reports if it is ever reached.
 */
export const MAX_EVENTS = 300;

/**
 * Events within this many positions of each other are candidates for semantic dedup.
 *
 * ⚠ Unmeasured. The corpus recorded 20 events with no near-duplicate pair, so the data cannot say
 * whether 8 is right, generous or useless — `cap:duplicate-suppressed` never fired. Named rather
 * than papered over.
 */
export const DUPLICATE_WINDOW = 8;

/**
 * @typedef {object} ChronicleEvent
 * @property {string} s Summary text.
 * @property {string[]} kw Normalized keywords.
 * @property {number} t Epoch ms when recorded.
 * @property {string} src Origin: 'llm' | 'user'.
 * @property {number} [mid] Message id it came from — advisory only, never identity.
 */

/**
 * Split text into retrieval tokens.
 *
 * ── No stoplist ──
 *
 * A stopword list was an English word-list applied to prose — the class this codebase forbids. It
 * was also unnecessary: the events carry MODEL-CHOSEN keywords (`kw`, any language), and the query
 * tokenizer only produces candidate terms to look up in the index. A function word like "the" or
 * "went" never matches an event keyword, so it contributes nothing to any score. The only filter
 * that survives is structural — token length — which means the same thing in every language.
 *
 * @param {string} text Input text.
 * @returns {string[]} Lowercased tokens of more than two characters.
 */
export function tokenize(text) {
    return String(text ?? '')
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter(token => token.length > 2);
}

/**
 * Coerce a raw extracted event into a well-formed, bounded record.
 * Returns null when there is nothing usable, so callers can filter in one pass.
 * @param {any} raw Candidate event from the model.
 * @param {object} [context] Context.
 * @param {number} [context.now] Timestamp to stamp.
 * @param {number} [context.mid] Originating message id.
 * @param {string} [context.src] Origin marker.
 * @param {string} [context.srcKey] Content key of the message this came from.
 * @param {object} [context.delta] Validated state delta this event caused.
 * @returns {ChronicleEvent|null} The normalized event, or null if unusable.
 */
export function normalizeEvent(raw, { now = 0, mid, src = 'llm', srcKey, delta } = {}) {
    const rawSummary = raw?.summary ?? raw?.s;
    // Must be an actual string: a model returning a number or an object would otherwise be
    // coerced into a nonsense summary like "42" or "[object Object]".
    if (typeof rawSummary !== 'string') {
        return null;
    }
    const summary = rawSummary.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) {
        return null;
    }

    const rawKeywords = Array.isArray(raw?.keywords) ? raw.keywords : Array.isArray(raw?.kw) ? raw.kw : [];
    const keywords = [];
    let clipped = 0;
    for (const candidate of rawKeywords) {
        if (keywords.length >= MAX_KEYWORDS) {
            // Counted, not silently dropped. See `dropped` on the returned event: without this,
            // "the model offered more than we kept" and "the model offered exactly the cap" are
            // indistinguishable, and the calibration instrument reports a binding cap either way.
            clipped++;
            continue;
        }
        const word = String(candidate ?? '').trim().toLowerCase().slice(0, MAX_KEYWORD_CHARS);
        if (word && !keywords.includes(word)) {
            keywords.push(word);
        }
    }

    // Fall back to the summary's own salient tokens so a keywordless event stays retrievable.
    if (!keywords.length) {
        keywords.push(...tokenize(summary).slice(0, MAX_KEYWORDS));
    }

    // If even that yields nothing, the event can never be retrieved by any query — it would sit
    // in the ledger consuming budget and surfacing to no one. Reject it instead.
    if (!keywords.length) {
        return null;
    }

    return {
        // Not persisted — stripped before the event reaches the ledger. It exists only so the
        // impure caller can count the clip; a bound that leaves no trace is the one failure mode
        // observe.js exists to prevent.
        dropped: clipped,
        s: summary,
        kw: keywords,
        t: Number.isFinite(now) ? now : 0,
        src: String(src),
        ...(Number.isInteger(mid) ? { mid } : {}),
        // The content key this was extracted from. A batch of several events shares one source,
        // so their table keys must differ while their liveness is decided by this one value.
        ...(srcKey ? { k: String(srcKey) } : {}),
        // What this event did to the world. State is a fold over these, so an event carrying one
        // is load-bearing in a way a bare summary is not — see hasDelta and selectEvictions.
        ...(delta && Object.keys(delta).length ? { d: delta } : {}),
    };
}

/**
 * Does this event carry a state delta?
 * @param {ChronicleEvent} event An event.
 * @returns {boolean} True if it changed the world.
 */
export function hasDelta(event) {
    return !!event?.d && Object.keys(event.d).length > 0;
}

/**
 * The content key that decides whether an event is still on the live branch.
 * Falls back to the table key for events stored before `k` existed.
 * @param {string} key Table key.
 * @param {ChronicleEvent} event The event.
 * @returns {string} The liveness key.
 */
export function livenessKey(key, event) {
    return event?.k ?? key;
}

/**
 * The semantic identity of an event: its keyword set, order-independent.
 * @param {ChronicleEvent} event An event.
 * @returns {string} A signature string.
 */
export function eventSignature(event) {
    return [...(event?.kw ?? [])].map(String).sort().join('|');
}

/**
 * Build the keyword index — the Graph face over the ledger, term -> event keys.
 *
 * Keywords are indexed by their constituent tokens, not verbatim. Models routinely return
 * multi-word keywords ("silver coins", "the dragon keep"), and queries are tokenized into single
 * words, so a verbatim index would leave every multi-word keyword permanently unreachable.
 *
 * @param {Map<string, ChronicleEvent>} events The event table.
 * @returns {Map<string, string[]>} term -> event keys.
 */
export function buildKeywordIndex(events) {
    return fold(table_entries(events), new Map(), (index, [key, event]) =>
        fold(event?.kw ?? [], index, (acc, keyword) =>
            fold(indexTerms(keyword), acc, (inner, term) =>
                // Guard against one keyword listing the same event twice ("dragon dragon"),
                // which would double its overlap score.
                lookup(inner, term, []).includes(key)
                    ? inner
                    : insert_with(inner, merge_graph, term, [key]))));
}

/**
 * The terms a keyword should be findable under: its tokens, plus the whole keyword when it is a
 * single token that tokenize() would otherwise discard as too short.
 * @param {string} keyword A keyword.
 * @returns {string[]} Index terms.
 */
export function indexTerms(keyword) {
    const tokens = tokenize(keyword);
    return tokens.length ? tokens : [String(keyword ?? '').trim().toLowerCase()].filter(Boolean);
}

/**
 * Rank events against a query.
 *
 * Scoring is keyword overlap accumulated in the Count face, tie-broken by recency. Events whose
 * key is not in `liveHashes` are dropped: an event extracted from a swipe you have navigated away
 * from is not part of the current branch's history.
 *
 * @param {object} params Parameters.
 * @param {Map<string, ChronicleEvent>} params.events The event table.
 * @param {Map<string, string[]>} params.kwIndex Keyword index from buildKeywordIndex.
 * @param {string} params.queryText Text to match against.
 * @param {Map<string, boolean>} [params.liveHashes] Keys currently present in the chat.
 * @param {number} [params.topK] Maximum results.
 * @returns {Array<{key: string, event: ChronicleEvent, overlap: number}>} Ranked, best first.
 */
export function rankEvents({ events, kwIndex, queryText, liveHashes = null, topK = 5 }) {
    const scores = fold(tokenize(queryText), new Map(), (acc, token) =>
        fold(lookup(kwIndex, token, []), acc, (inner, key) =>
            insert_with(inner, merge_bu, key, 1)));

    return table_entries(scores)
        .filter(([key]) => events.has(key)
            && (!liveHashes || lookup(liveHashes, livenessKey(key, events.get(key)), false)))
        .map(([key, overlap]) => ({ key, event: events.get(key), overlap }))
        .sort((a, b) => b.overlap - a.overlap || (b.event?.t ?? 0) - (a.event?.t ?? 0))
        .slice(0, Math.max(0, topK));
}

/**
 * Decide what a batch of freshly extracted events does to the ledger.
 *
 * Two dedup layers, two faces:
 *  - exact: the Map merge on the source hash, so re-extracting the same swipe overwrites rather
 *    than duplicating. This IS the dedup, not a check wrapped around it.
 *  - semantic: the Set merge on the keyword signature, first write wins, within a recency window.
 *
 * Pure: returns a decision rather than mutating, so the caller owns persistence.
 *
 * @param {object} params Parameters.
 * @param {Map<string, ChronicleEvent>} params.events Existing ledger.
 * @param {Array<{key: string, event: ChronicleEvent}>} params.incoming Candidates.
 * @returns {{events: Map<string, ChronicleEvent>, added: string[], replaced: string[], duplicates: string[]}} Outcome.
 */
export function applyEvents({ events, incoming }) {
    const next = new Map(events);
    const added = [];
    const replaced = [];
    const duplicates = [];

    for (const { key, event } of incoming) {
        if (!key || !event) continue;

        if (next.has(key)) {
            // ── A replacement that mentions no delta has not retracted one ──
            //
            // Extraction runs on overlapping windows, so the same message is often read twice. The
            // second reading may summarise the event without proposing the state change the first
            // one caught — and under plain last-write that silently un-does the change, with the
            // state fold quietly disagreeing with the story that produced it. Same asymmetry as
            // everywhere else here: evidence of what it states, not of what it omits.
            const previous = lookup(next, key, null);
            insert_with(next, merge_b, key, previous?.d && !event.d ? { ...event, d: previous.d } : event);
            replaced.push(key);
            continue;
        }

        // Semantic dedup against the tail of the ledger only. Older events with the same keyword
        // set are usually a genuine recurrence, not a duplicate extraction.
        const signature = eventSignature(event);
        const recent = table_entries(next).slice(-DUPLICATE_WINDOW);
        const clash = recent.find(([, existing]) => eventSignature(existing) === signature);
        if (clash) {
            duplicates.push(key);
            continue;
        }

        insert_with(next, merge_b, key, event);
        added.push(key);
    }

    return { events: next, added, replaced, duplicates };
}

/**
 * Choose which events to evict, least valuable first.
 *
 * Retention score is retrieval hits weighted against recency: an event that keeps proving useful
 * outlives a newer one that never surfaces. Events no longer live on the current branch rank
 * last, because they are the ones least likely to be needed again.
 *
 * Events carrying a state delta are effectively pinned. Inventory is a fold over them, so evicting
 * one does not merely forget a summary — it silently changes what the character is holding. The
 * honest consequence is that inventory depth is bounded by the event cap: a chat that overruns it
 * entirely with delta-bearing events will start dropping the oldest of them, and the fold will
 * shift. That is a real limit, not a hidden one.
 *
 * @param {object} params Parameters.
 * @param {Map<string, ChronicleEvent>} params.events The ledger.
 * @param {Map<string, number>} params.hits Retrieval counts.
 * @param {Map<string, boolean>} [params.liveHashes] Keys present in the current chat.
 * @param {number} params.count How many to evict.
 * @returns {string[]} Keys to remove.
 */
export function selectEvictions({ events, hits, liveHashes = null, count }) {
    if (count <= 0) return [];

    const ordered = table_entries(events)
        .map(([key, event], index) => {
            const live = !liveHashes || lookup(liveHashes, livenessKey(key, event), false);
            const keep = lookup(hits, key, 0) * 10
                + index
                + (live ? 1000 : 0)
                + (hasDelta(event) ? 100000 : 0);
            return { key, keep };
        })
        .sort((a, b) => a.keep - b.keep);

    return ordered.slice(0, count).map(x => x.key);
}

/**
 * Prune a ledger down to a maximum size.
 * @param {object} params Parameters.
 * @param {Map<string, ChronicleEvent>} params.events The ledger.
 * @param {Map<string, number>} params.hits Retrieval counts.
 * @param {Map<string, boolean>} [params.liveHashes] Keys present in the current chat.
 * @param {number} [params.max] Maximum events to keep.
 * @returns {{events: Map<string, ChronicleEvent>, evicted: string[]}} The pruned ledger.
 */
export function pruneEvents({ events, hits, liveHashes = null, max = MAX_EVENTS }) {
    const excess = events.size - max;
    if (excess <= 0) {
        return { events, evicted: [] };
    }
    const evicted = selectEvictions({ events, hits, liveHashes, count: excess });
    const next = new Map(events);
    for (const key of evicted) {
        next.delete(key);
    }
    return { events: next, evicted };
}

/**
 * Render events as a prompt block. Returns '' when there is nothing to say — an empty header is
 * worse than no header, because it spends tokens telling the model nothing.
 * @param {Array<{event: ChronicleEvent}>} ranked Ranked events.
 * @param {string} [template] Template containing {{text}}.
 * @returns {string} The rendered block.
 */
export function renderEvents(ranked, template = 'Relevant past events:\n{{text}}') {
    const lines = ranked.map(({ event }) => `- ${event.s}`).filter(Boolean);
    if (!lines.length) {
        return '';
    }
    return String(template).replaceAll('{{text}}', lines.join('\n'));
}
