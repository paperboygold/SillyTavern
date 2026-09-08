import { describe, expect, test } from '@jest/globals';

import {
    fuse,
    isNearDuplicate,
    jaccard,
    rankFused,
    renderEvidence,
    RRF_K,
    selectEvidence,
} from '../public/scripts/extensions/sanguine/recall-table.js';

/** Cost one token per word, so budgets in tests are readable. */
const wordCost = (_key, text) => String(text).split(/\s+/).filter(Boolean).length;

/**
 * Build a metadata map from [key, text, anchor?, source?] tuples.
 * @param {Array<[string, string, string?, string?]>} rows Rows.
 * @returns {Map<string, object>} Metadata.
 */
function metaOf(rows) {
    return new Map(rows.map(([key, text, anchor, source]) => [key, { text, anchor, source: source ?? 'test' }]));
}

describe('fuse, RRF is the Accumulator face', () => {
    test('a single source scores by reciprocal rank', () => {
        const fused = fuse([{ keys: ['a', 'b'] }]);
        expect(fused.get('a').sum).toBeCloseTo(1 / (RRF_K + 1));
        expect(fused.get('b').sum).toBeCloseTo(1 / (RRF_K + 2));
        expect(fused.get('a').n).toBe(1);
    });

    test('contributions from several sources accumulate', () => {
        const fused = fuse([{ keys: ['a'] }, { keys: ['a'] }]);
        expect(fused.get('a').sum).toBeCloseTo(2 / (RRF_K + 1));
        // n is the free agreement signal that falls out of the pair monoid.
        expect(fused.get('a').n).toBe(2);
    });

    test('weights scale a source contribution', () => {
        const fused = fuse([{ keys: ['a'], weight: 0.5 }]);
        expect(fused.get('a').sum).toBeCloseTo(0.5 / (RRF_K + 1));
    });

    test('an item found by two sources can outrank a rank-1 item found by one', () => {
        // This is the property that makes fusion worth doing at all.
        const fused = fuse([
            { keys: ['solo', 'shared'] },
            { keys: ['other', 'shared'] },
        ]);
        const ranked = rankFused(fused);
        expect(ranked[0].key).toBe('shared');
        expect(ranked[0].n).toBe(2);
    });

    test('is total over empty and malformed input', () => {
        expect(fuse([]).size).toBe(0);
        expect(fuse([{ keys: [] }]).size).toBe(0);
        expect(fuse([{}]).size).toBe(0);
    });
});

describe('rankFused', () => {
    test('orders by score, breaking ties toward multi-source agreement', () => {
        const fused = new Map([
            ['low', { sum: 0.1, n: 3 }],
            ['high_solo', { sum: 0.5, n: 1 }],
            ['high_shared', { sum: 0.5, n: 2 }],
        ]);
        expect(rankFused(fused).map(r => r.key)).toEqual(['high_shared', 'high_solo', 'low']);
    });
});

describe('jaccard / isNearDuplicate', () => {
    test('identical texts overlap fully', () => {
        expect(jaccard('the dragon was slain', 'the dragon was slain')).toBe(1);
    });

    test('unrelated texts do not overlap', () => {
        expect(jaccard('the dragon was slain', 'she bought bread')).toBe(0);
    });

    test('empty input never counts as a duplicate', () => {
        expect(jaccard('', 'anything at all')).toBe(0);
        expect(isNearDuplicate('text here', [])).toBe(false);
    });

    test('near-identical restatements are caught', () => {
        expect(isNearDuplicate(
            'The party defeated the ancient dragon',
            ['The party defeated the ancient dragon today'],
        )).toBe(true);
    });
});

describe('selectEvidence', () => {
    const ranked = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

    test('selects in rank order within the budget', () => {
        const meta = metaOf([['a', 'one two'], ['b', 'three four'], ['c', 'five six']]);
        const result = selectEvidence({ ranked, meta, budget: 4, costOf: wordCost });
        expect(result.items.map(i => i.key)).toEqual(['a', 'b']);
        expect(result.tokens).toBe(4);
        expect(result.skipped.budget).toBe(1);
    });

    test('a summary suppresses the raw message it came from', () => {
        // A chronicle event and a vector hit on the same message are one piece of evidence; the
        // event is the cheaper way to say it.
        const meta = metaOf([
            ['evt:1', 'A pact was sworn', 'msg:99', 'chronicle'],
            ['msg:99', 'User: we swore a pact at dawn today', 'msg:99', 'vectors'],
        ]);
        const result = selectEvidence({
            ranked: [{ key: 'evt:1' }, { key: 'msg:99' }],
            meta, budget: 100, costOf: wordCost,
        });
        expect(result.items.map(i => i.key)).toEqual(['evt:1']);
        expect(result.skipped.duplicate).toBe(1);
    });

    test('a raw message suppresses a summary of it, whichever ranks first', () => {
        const meta = metaOf([
            ['msg:99', 'User: we swore a pact at dawn today', 'msg:99', 'vectors'],
            ['evt:1', 'A pact was sworn', 'msg:99', 'chronicle'],
        ]);
        const result = selectEvidence({
            ranked: [{ key: 'msg:99' }, { key: 'evt:1' }],
            meta, budget: 100, costOf: wordCost,
        });
        expect(result.items.map(i => i.key)).toEqual(['msg:99']);
    });

    test('two summaries of the same message are both kept', () => {
        // One extraction pass routinely yields several events from one turn. They share an anchor
        // but say different things, so suppressing one for the other loses real information.
        const meta = metaOf([
            ['evt:1:0', 'A pact was sworn', 'msg:99', 'chronicle'],
            ['evt:1:1', 'The sword remained buried', 'msg:99', 'chronicle'],
        ]);
        const result = selectEvidence({
            ranked: [{ key: 'evt:1:0' }, { key: 'evt:1:1' }],
            meta, budget: 100, costOf: wordCost,
        });
        expect(result.items.map(i => i.key)).toEqual(['evt:1:0', 'evt:1:1']);
        expect(result.skipped.duplicate).toBe(0);
    });

    test('drops evidence already covered by World Info', () => {
        const meta = metaOf([['a', 'The Dragon Keep sits above the river']]);
        const result = selectEvidence({
            ranked: [{ key: 'a' }],
            meta,
            covered: ['The Dragon Keep sits above the river'],
            budget: 100,
            costOf: wordCost,
        });
        expect(result.items).toEqual([]);
        expect(result.skipped.covered).toBe(1);
    });

    test('drops near-duplicates of already-accepted items', () => {
        const meta = metaOf([
            ['a', 'The party defeated the ancient dragon'],
            ['b', 'The party defeated the ancient dragon today'],
        ]);
        const result = selectEvidence({
            ranked: [{ key: 'a' }, { key: 'b' }],
            meta, budget: 100, costOf: wordCost,
        });
        expect(result.items.map(i => i.key)).toEqual(['a']);
        expect(result.skipped.duplicate).toBe(1);
    });

    test('keeps scanning past an over-budget item in case a smaller one fits', () => {
        const meta = metaOf([['a', 'one two three four five'], ['b', 'six']]);
        const result = selectEvidence({
            ranked: [{ key: 'a' }, { key: 'b' }],
            meta, budget: 2, costOf: wordCost,
        });
        expect(result.items.map(i => i.key)).toEqual(['b']);
    });

    test('respects maxItems', () => {
        const meta = metaOf([['a', 'x'], ['b', 'y'], ['c', 'z']]);
        const result = selectEvidence({ ranked, meta, budget: 100, costOf: wordCost, maxItems: 2 });
        expect(result.items).toHaveLength(2);
    });

    test('counts items whose metadata is missing rather than crashing', () => {
        const result = selectEvidence({
            ranked: [{ key: 'ghost' }], meta: new Map(), budget: 100, costOf: wordCost,
        });
        expect(result.items).toEqual([]);
        expect(result.skipped.missing).toBe(1);
    });

    test('a zero budget selects nothing', () => {
        const meta = metaOf([['a', 'one']]);
        expect(selectEvidence({ ranked, meta, budget: 0, costOf: wordCost }).items).toEqual([]);
    });
});

describe('renderEvidence', () => {
    test('renders a bulleted block through the template', () => {
        expect(renderEvidence([{ text: 'A' }, { text: 'B' }], 'Past:\n{{text}}'))
            .toBe('Past:\n- A\n- B');
    });

    test('renders nothing when there is nothing to say', () => {
        expect(renderEvidence([], 'Past:\n{{text}}')).toBe('');
    });
});

describe('provenance, carried, and inert', () => {
    /*
     * The Chronicle tab's Recall view has to answer "why did THIS memory come up", which the fused
     * score cannot: 0.0312 is not a reason. So `fuse` now carries the rank each source gave each
     * item and `selectEvidence` passes it through.
     *
     * The whole risk in that change is that it quietly alters what gets injected. These tests exist
     * to pin that down: provenance is ADDED, and the selection is byte-identical without it.
     */

    /** Strip provenance from a ranking, leaving what `selectEvidence` used to be given. */
    const bare = ranked => ranked.map(({ key, sum, n }) => ({ key, sum, n }));

    test('labelling a source changes neither its score nor the order', () => {
        const keys = { a: ['x', 'y', 'z'], b: ['z', 'q'] };
        const labelled = rankFused(fuse([
            { label: 'chronicle', keys: keys.a, weight: 1.0 },
            { label: 'recency', keys: keys.b, weight: 0.5 },
        ]));
        const unlabelled = rankFused(fuse([
            { keys: keys.a, weight: 1.0 },
            { keys: keys.b, weight: 0.5 },
        ]));
        expect(labelled.map(r => r.key)).toEqual(unlabelled.map(r => r.key));
        expect(labelled.map(r => r.sum)).toEqual(unlabelled.map(r => r.sum));
        expect(labelled.map(r => r.n)).toEqual(unlabelled.map(r => r.n));
    });

    test('a source reports the rank it gave each item, one entry per source that found it', () => {
        const fused = fuse([
            { label: 'chronicle', keys: ['evt:1', 'evt:2'] },
            { label: 'vectors', keys: ['msg:9', 'evt:2'] },
        ]);
        expect(fused.get('evt:1').by).toEqual({ chronicle: 0 });
        expect(fused.get('evt:2').by).toEqual({ chronicle: 1, vectors: 1 });
        expect(fused.get('msg:9').by).toEqual({ vectors: 0 });
    });

    test('an unlabelled source is named by its position rather than going unreported', () => {
        expect(fuse([{ keys: ['a'] }, { keys: ['a'] }]).get('a').by).toEqual({ s0: 0, s1: 0 });
    });

    test('a source listing a key twice reports its best rank', () => {
        // Malformed input, but `min` is the only merge that answers it usefully, and it keeps the
        // third component a commutative monoid, which is what makes the merge a monoid merge.
        expect(fuse([{ label: 'chronicle', keys: ['a', 'b', 'a'] }]).get('a').by).toEqual({ chronicle: 0 });
    });

    test('selection is unchanged by the presence of provenance', () => {
        // Every gate in `selectEvidence` fires at least once here: an anchor suppression, a
        // near-duplicate, a World Info cover, and the budget.
        const meta = metaOf([
            ['evt:1', 'A pact was sworn at dawn', 'msg:99', 'chronicle'],
            ['msg:99', 'User: we swore a pact at dawn', 'msg:99', 'vectors'],
            ['evt:2', 'The Dragon Keep sits above the river', 'msg:12', 'chronicle'],
            ['evt:3', 'The heir was named before the court', 'msg:14', 'chronicle'],
            ['evt:4', 'The heir was named before the court today', 'msg:15', 'chronicle'],
            ['evt:5', 'A long and expensive digression nobody can afford to inject here', 'msg:16', 'chronicle'],
            ['ghost', ''],
        ]);
        const ranked = rankFused(fuse([
            { label: 'chronicle', keys: ['evt:1', 'evt:2', 'evt:3', 'evt:4', 'evt:5', 'ghost'] },
            { label: 'vectors', keys: ['msg:99', 'evt:3'] },
            { label: 'recency', keys: ['evt:5', 'evt:4', 'evt:3'], weight: 0.5 },
        ]));
        const args = { meta, covered: ['The Dragon Keep sits above the river'], budget: 9, costOf: wordCost };

        const withProvenance = selectEvidence({ ranked, ...args });
        const without = selectEvidence({ ranked: bare(ranked), ...args });

        expect(withProvenance.items.map(i => i.key)).toEqual(without.items.map(i => i.key));
        expect(withProvenance.items.map(i => i.text)).toEqual(without.items.map(i => i.text));
        expect(withProvenance.tokens).toBe(without.tokens);
        expect(withProvenance.skipped).toEqual(without.skipped);
        // And it did exercise every gate, or the claim above is worthless.
        expect(withProvenance.skipped).toEqual({ covered: 1, duplicate: 1, budget: 3, missing: 1 });
    });

    test('an injected item carries the ranks that put it there', () => {
        const meta = metaOf([['evt:1', 'A pact was sworn', 'msg:99', 'chronicle']]);
        const ranked = rankFused(fuse([
            { label: 'chronicle', keys: ['evt:1'] },
            { label: 'recency', keys: ['evt:1'], weight: 0.5 },
        ]));
        const [item] = selectEvidence({ ranked, meta, budget: 100, costOf: wordCost }).items;
        expect(item.by).toEqual({ chronicle: 0, recency: 0 });
        expect(item.agree).toBe(2);
        expect(item.rank).toBe(0);
        expect(item.cost).toBe(4);
        // The two fields the prompt path reads are untouched by all of the above.
        expect(item.text).toBe('A pact was sworn');
        expect(item.source).toBe('chronicle');
    });

    test('every skip is explained once, and the tally is the count of the explanations', () => {
        const meta = metaOf([
            ['a', 'The party defeated the ancient dragon'],
            ['b', 'The party defeated the ancient dragon today'],
            ['c', 'one two three four five six'],
            ['d', 'covered text here'],
        ]);
        const result = selectEvidence({
            ranked: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'gone' }],
            meta,
            covered: ['covered text here'],
            budget: 6,
            costOf: wordCost,
        });
        const counted = reason => result.dropped.filter(d => d.reason === reason).length;
        expect(counted('duplicate')).toBe(result.skipped.duplicate);
        expect(counted('budget')).toBe(result.skipped.budget);
        expect(counted('covered')).toBe(result.skipped.covered);
        expect(counted('missing')).toBe(result.skipped.missing);
        expect(result.dropped.map(d => d.key)).toEqual(['b', 'c', 'd', 'gone']);
    });

    test('the item cap reports its tail instead of dropping it silently', () => {
        const meta = metaOf([['a', 'x'], ['b', 'y'], ['c', 'z']]);
        const result = selectEvidence({
            ranked: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
            meta, budget: 100, costOf: wordCost, maxItems: 2,
        });
        expect(result.items.map(i => i.key)).toEqual(['a', 'b']);
        expect(result.dropped).toEqual([expect.objectContaining({ key: 'c', reason: 'capped' })]);
        // A cap is not a skip: the four-integer tally is untouched, so no counter shifts meaning.
        expect(result.skipped).toEqual({ covered: 0, duplicate: 0, budget: 0, missing: 0 });
    });
});

describe('recency as a third ranking, RRF fuses rankings, so it needs no new mechanism', () => {
    test('an event that is both topical and recent outranks one that is only topical', () => {
        // The agreement signal falls out: it appears in two lists, so n = 2.
        const fused = fuse([
            { keys: ['a', 'b'], weight: 1.0 },
            { keys: ['b'], weight: 0.5 },
        ]);
        const ranked = rankFused(fused);
        expect(ranked[0].key).toBe('b');
        expect(ranked[0].n).toBe(2);
    });

    test('recency alone does not bury a directly relevant memory', () => {
        // Weighted at 0.5 on purpose: whatever happened last must not outrank what was asked about.
        const fused = fuse([
            { keys: ['topical'], weight: 1.0 },
            { keys: ['recent'], weight: 0.5 },
        ]);
        expect(rankFused(fused)[0].key).toBe('topical');
    });

    test('an empty ranking contributes nothing', () => {
        const withEmpty = rankFused(fuse([{ keys: ['a'], weight: 1.0 }, { keys: [], weight: 0.5 }]));
        const without = rankFused(fuse([{ keys: ['a'], weight: 1.0 }]));
        expect(withEmpty).toEqual(without);
    });
});
