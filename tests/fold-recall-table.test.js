import { describe, expect, test } from '@jest/globals';

import {
    fuse,
    isNearDuplicate,
    jaccard,
    rankFused,
    renderEvidence,
    RRF_K,
    selectEvidence,
} from '../public/scripts/extensions/fold/recall-table.js';

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

describe('fuse — RRF is the Accumulator face', () => {
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
