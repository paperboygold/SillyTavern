/**
 * fold/recall-table.js: the pure fusion layer.
 *
 * Imports nothing but ./lib/hash.js, so it runs in plain Node and is unit-testable.
 *
 * Reciprocal Rank Fusion IS the Accumulator face. Each source contributes `1/(k + rank)` for the
 * items it returns, and those contributions accumulate under `merge_acc`: the pair monoid. The
 * `sum` component is the fused score; the `n` component falls out for free and counts how many
 * independent sources surfaced the item, which is a genuine agreement signal used as the tiebreak.
 *
 * Rank fusion rather than score fusion is not a stylistic choice: SillyTavern's vector endpoints
 * compute similarity server-side and strip it before responding, so rank is the only signal that
 * actually crosses the wire. RRF consumes ordinal position and nothing else.
 */

import { fold, insert_with, lookup, merge_acc, merge_nb, table_entries } from './lib/hash.js';

/** The RRF constant from Cormack et al. Dampens the advantage of rank-1 items. */
export const RRF_K = 60;

/** Jaccard overlap above which two texts are treated as the same evidence. */
export const NEAR_DUPLICATE_THRESHOLD = 0.8;

/**
 * @typedef {object} EvidenceSource
 * @property {string[]} keys Item keys in rank order, best first.
 * @property {number} [weight] Relative trust in this source. Defaults to 1.
 * @property {string} [label] What to call this source when reporting why an item ranked. Defaults
 *   to its position (`s0`, `s1`, …), so an unlabelled caller still gets provenance rather than
 *   nothing.
 */

/**
 * The fused accumulator, extended with provenance.
 *
 * Why the pair monoid becomes a triple.
 *
 * `merge_acc` is `{sum, n}` under componentwise addition. `by` is a third component under
 * "keep the better rank", `min` over the naturals, which is a commutative idempotent monoid with
 * identity +∞, lifted pointwise over the label keys. So the merge is still a monoid merge and
 * `fuse` is still the Accumulator face; there is simply one more coordinate in it.
 *
 * It exists because the score alone cannot answer the only question a reader actually has when
 * they see a retrieved memory: *why did this one come up?* `sum` says "0.031", which is not an
 * answer. `by` says "the chronicle ranked it 1st and recency ranked it 4th", which is.
 *
 * @param {{sum: number, n: number, by?: Record<string, number>}} nu The incoming contribution.
 * @param {{sum: number, n: number, by?: Record<string, number>}} old What is already there.
 * @returns {{sum: number, n: number, by: Record<string, number>}} The merged accumulator.
 */
function mergeProvenance(nu, old) {
    const { sum, n } = merge_acc(nu, old);
    const by = { ...(old.by ?? {}) };
    for (const [label, rank] of Object.entries(nu.by ?? {})) {
        // A source that lists the same key twice is malformed, but it still has a best rank, and
        // `min` is the only merge that reports it rather than whichever copy came last.
        by[label] = label in by ? Math.min(by[label], rank) : rank;
    }
    return { sum, n, by };
}

/**
 * Fuse ranked lists into one scored table.
 * @param {EvidenceSource[]} sources Ranked lists.
 * @param {number} [k] RRF constant.
 * @returns {Map<string, {sum: number, n: number, by: Record<string, number>}>} key -> fused score,
 *   source count, and the zero-based rank each source gave it.
 */
export function fuse(sources, k = RRF_K) {
    return fold(sources, new Map(), (acc, source, index) =>
        fold(source?.keys ?? [], acc, (table, key, rank) =>
            insert_with(table, mergeProvenance, key, {
                sum: (source.weight ?? 1) / (k + rank + 1),
                n: 1,
                by: { [source?.label || `s${index}`]: rank },
            })));
}

/**
 * Order a fused table best-first.
 *
 * Ties on score break toward items that more than one source surfaced, that is what `n` is for,
 * and it is the whole reason the pair monoid is the right merge rather than a plain sum.
 *
 * @param {Map<string, {sum: number, n: number, by?: Record<string, number>}>} fused A fused table.
 * @returns {Array<{key: string, sum: number, n: number, by: Record<string, number>}>} Ranked entries.
 */
export function rankFused(fused) {
    return table_entries(fused)
        .map(([key, score]) => ({ key, sum: score.sum, n: score.n, by: score.by ?? {} }))
        .sort((a, b) => b.sum - a.sum || b.n - a.n);
}

/**
 * Word set of a text, for overlap comparison.
 * @param {string} text Input.
 * @returns {Set<string>} Lowercased words.
 */
export function wordSet(text) {
    return new Set(String(text ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length > 2));
}

/**
 * Jaccard overlap of two texts.
 * @param {string} a First text.
 * @param {string} b Second text.
 * @returns {number} Overlap in [0, 1].
 */
export function jaccard(a, b) {
    const left = wordSet(a);
    const right = wordSet(b);
    if (!left.size || !right.size) {
        return 0;
    }
    let shared = 0;
    for (const word of left) {
        if (right.has(word)) shared++;
    }
    return shared / (left.size + right.size - shared);
}

/**
 * Is this text already represented among the accepted ones?
 * @param {string} text Candidate text.
 * @param {string[]} accepted Already-accepted texts.
 * @param {number} [threshold] Overlap threshold.
 * @returns {boolean} True if a near-duplicate exists.
 */
export function isNearDuplicate(text, accepted, threshold = NEAR_DUPLICATE_THRESHOLD) {
    return accepted.some(other => jaccard(text, other) >= threshold);
}

/**
 * Choose which fused items to actually inject.
 *
 * Three filters, in cost order: identity (cheap), near-duplicate against what is already in the
 * prompt or already accepted (moderate), then the token budget (needs a counter). `covered` holds
 * text that another system has already put in the prompt, activated World Info entries, so fold
 * never pays tokens to say something the model is about to be told anyway.
 *
 * The skipped tally counts; `dropped` explains.
 *
 * `skipped` has always been four integers, which is enough to notice that retrieval threw six
 * things away and not enough to ever find out what they were. `dropped` is the same decisions with
 * the candidate attached, in the order they were made, so a reader can see that the budget stopped
 * at the fifth-ranked memory rather than only that "budget: 1". It is derived from the same branch
 * that increments the tally, there is no second code path that could disagree with it.
 *
 * @param {object} params Parameters.
 * @param {Array<{key: string, sum?: number, n?: number, by?: Record<string, number>}>} params.ranked
 *   Ranked keys from rankFused.
 * @param {Map<string, {text: string, anchor?: string, source: string}>} params.meta Item metadata.
 * @param {string[]} [params.covered] Texts already present in the prompt from other sources.
 * @param {number} params.budget Token budget for the whole block.
 * @param {(key: string, text: string) => number} params.costOf Token cost of an item.
 * @param {number} [params.maxItems] Hard cap on item count.
 * @returns {{items: Array<object>, tokens: number, skipped: object, dropped: Array<object>}} Selection.
 */
export function selectEvidence({ ranked, meta, covered = [], budget, costOf, maxItems = 20 }) {
    const seen = new Map();
    // Source messages already represented, split by how. A summary and the raw message it came
    // from are redundant with each other, so whichever wins suppresses the other. But two
    // summaries of the same message are NOT redundant, they say different things, so they must
    // not suppress each other just for sharing an anchor.
    const rawAccepted = new Map();
    const summarizedAccepted = new Map();
    const accepted = [];
    const items = [];
    const skipped = { covered: 0, duplicate: 0, budget: 0, missing: 0 };
    /** @type {Array<object>} Every candidate that did not make it, and the gate that stopped it. */
    const dropped = [];
    let tokens = 0;

    /**
     * Everything known about a candidate at the moment it was judged.
     * @param {object} candidate The ranked entry.
     * @param {number} at Its zero-based position in the ranking.
     * @param {object|undefined} entry Its metadata, if any.
     * @returns {object} A provenance record.
     */
    const provenance = (candidate, at, entry) => ({
        key: candidate.key,
        rank: at,
        score: candidate.sum ?? 0,
        agree: candidate.n ?? 0,
        by: candidate.by ?? {},
        text: entry?.text ?? '',
        source: entry?.source ?? '',
    });

    for (const [at, candidate] of ranked.entries()) {
        const key = candidate.key;
        if (items.length >= maxItems) {
            // `continue` rather than `break`: nothing more can be accepted either way, so the
            // selection is identical, but the tail is reported instead of vanishing. A cap that
            // leaves no trace is exactly what `observe.js` exists to stop.
            dropped.push({ ...provenance(candidate, at, meta.get(key)), reason: 'capped' });
            continue;
        }

        const entry = meta.get(key);
        if (!entry?.text) {
            skipped.missing++;
            dropped.push({ ...provenance(candidate, at, entry), reason: 'missing' });
            continue;
        }

        const anchor = entry.anchor;
        // An item whose key IS its anchor is the raw source; anything else is derived from it.
        const isRaw = !anchor || anchor === key;
        const redundant = isRaw
            ? (lookup(rawAccepted, anchor, false) || lookup(summarizedAccepted, anchor, false))
            : lookup(rawAccepted, anchor, false);

        if (lookup(seen, key, false) || redundant) {
            skipped.duplicate++;
            dropped.push({ ...provenance(candidate, at, entry), reason: 'duplicate', of: anchor ?? key });
            continue;
        }

        if (isNearDuplicate(entry.text, covered)) {
            skipped.covered++;
            dropped.push({ ...provenance(candidate, at, entry), reason: 'covered' });
            continue;
        }

        if (isNearDuplicate(entry.text, accepted)) {
            skipped.duplicate++;
            dropped.push({ ...provenance(candidate, at, entry), reason: 'duplicate' });
            continue;
        }

        const cost = costOf(key, entry.text);
        if (tokens + cost > budget) {
            skipped.budget++;
            dropped.push({ ...provenance(candidate, at, entry), reason: 'budget', cost });
            continue;
        }

        insert_with(seen, merge_nb, key, true);
        if (anchor) {
            insert_with(isRaw ? rawAccepted : summarizedAccepted, merge_nb, anchor, true);
        }
        accepted.push(entry.text);
        tokens += cost;
        // The provenance rides along with the item. `text` and `source` are what the prompt needs;
        // everything else is what a reader needs to believe the prompt.
        items.push({ ...provenance(candidate, at, entry), cost });
    }

    return { items, tokens, skipped, dropped };
}

/**
 * Render selected evidence as a prompt block, or '' when there is nothing to say.
 * @param {Array<{text: string}>} items Selected items.
 * @param {string} [template] Template containing {{text}}.
 * @returns {string} The block.
 */
export function renderEvidence(items, template = 'Relevant past events:\n{{text}}') {
    const lines = items.map(item => `- ${item.text}`).filter(Boolean);
    if (!lines.length) {
        return '';
    }
    return String(template).replaceAll('{{text}}', lines.join('\n'));
}
