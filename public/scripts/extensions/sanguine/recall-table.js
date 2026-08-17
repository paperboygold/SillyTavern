/**
 * fold/recall-table.js — the pure fusion layer.
 *
 * Imports nothing but ./lib/hash.js, so it runs in plain Node and is unit-testable.
 *
 * Reciprocal Rank Fusion IS the Accumulator face. Each source contributes `1/(k + rank)` for the
 * items it returns, and those contributions accumulate under `merge_acc` — the pair monoid. The
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
 */

/**
 * Fuse ranked lists into one scored table.
 * @param {EvidenceSource[]} sources Ranked lists.
 * @param {number} [k] RRF constant.
 * @returns {Map<string, {sum: number, n: number}>} key -> fused score and source count.
 */
export function fuse(sources, k = RRF_K) {
    return fold(sources, new Map(), (acc, source) =>
        fold(source?.keys ?? [], acc, (table, key, rank) =>
            insert_with(table, merge_acc, key, { sum: (source.weight ?? 1) / (k + rank + 1), n: 1 })));
}

/**
 * Order a fused table best-first.
 *
 * Ties on score break toward items that more than one source surfaced — that is what `n` is for,
 * and it is the whole reason the pair monoid is the right merge rather than a plain sum.
 *
 * @param {Map<string, {sum: number, n: number}>} fused A fused table.
 * @returns {Array<{key: string, sum: number, n: number}>} Ranked entries.
 */
export function rankFused(fused) {
    return table_entries(fused)
        .map(([key, score]) => ({ key, sum: score.sum, n: score.n }))
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
 * text that another system has already put in the prompt — activated World Info entries — so fold
 * never pays tokens to say something the model is about to be told anyway.
 *
 * @param {object} params Parameters.
 * @param {Array<{key: string}>} params.ranked Ranked keys from rankFused.
 * @param {Map<string, {text: string, anchor?: string, source: string}>} params.meta Item metadata.
 * @param {string[]} [params.covered] Texts already present in the prompt from other sources.
 * @param {number} params.budget Token budget for the whole block.
 * @param {(key: string, text: string) => number} params.costOf Token cost of an item.
 * @param {number} [params.maxItems] Hard cap on item count.
 * @returns {{items: Array<{key: string, text: string, source: string}>, tokens: number, skipped: object}} Selection.
 */
export function selectEvidence({ ranked, meta, covered = [], budget, costOf, maxItems = 20 }) {
    const seen = new Map();
    // Source messages already represented, split by how. A summary and the raw message it came
    // from are redundant with each other, so whichever wins suppresses the other. But two
    // summaries of the same message are NOT redundant — they say different things — so they must
    // not suppress each other just for sharing an anchor.
    const rawAccepted = new Map();
    const summarizedAccepted = new Map();
    const accepted = [];
    const items = [];
    const skipped = { covered: 0, duplicate: 0, budget: 0, missing: 0 };
    let tokens = 0;

    for (const { key } of ranked) {
        if (items.length >= maxItems) {
            break;
        }

        const entry = meta.get(key);
        if (!entry?.text) {
            skipped.missing++;
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
            continue;
        }

        if (isNearDuplicate(entry.text, covered)) {
            skipped.covered++;
            continue;
        }

        if (isNearDuplicate(entry.text, accepted)) {
            skipped.duplicate++;
            continue;
        }

        const cost = costOf(key, entry.text);
        if (tokens + cost > budget) {
            skipped.budget++;
            continue;
        }

        insert_with(seen, merge_nb, key, true);
        if (anchor) {
            insert_with(isRaw ? rawAccepted : summarizedAccepted, merge_nb, anchor, true);
        }
        accepted.push(entry.text);
        tokens += cost;
        items.push({ key, text: entry.text, source: entry.source });
    }

    return { items, tokens, skipped };
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
