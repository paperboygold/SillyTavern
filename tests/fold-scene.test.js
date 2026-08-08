import { describe, expect, test } from '@jest/globals';

import {
    BLOCK,
    CONTEXT_ANNOTATE_AFTER,
    CONTEXT_DROP_AFTER,
    CONTEXT_OVERRIDE_AFTER,
    NARRATIVE,
    STALE_THRESHOLD,
    contextBand,
    merge_context,
} from '../public/scripts/extensions/fold/state-table.js';

/*
 * Context has two sources now, and they are not equally good. A status block is the narrator
 * asserting the scene in its own words; a narrative reading is fold inferring it. The chat that
 * forced this ran thirty-eight turns with a location, a time and a named protagonist in plain
 * view and showed none of them, because no line began with "Location:".
 */
describe('merge_context — trust first, then recency', () => {
    const block = (v, t) => ({ v, t, src: BLOCK });
    const prose = (v, t) => ({ v, t, src: NARRATIVE });

    test('a card that restates its block every turn is never overridden', () => {
        expect(merge_context(prose('the stableyard', 10), block('the inn', 10)).v).toBe('the inn');
        expect(merge_context(block('the inn', 10), prose('the stableyard', 10)).v).toBe('the inn');
    });

    test('a block that has gone quiet gives way to what the prose says', () => {
        const stale = block('the inn', 1);
        const fresh = prose('the stableyard', 1 + CONTEXT_OVERRIDE_AFTER + 1);
        expect(merge_context(fresh, stale).v).toBe('the stableyard');
        expect(merge_context(stale, fresh).v).toBe('the stableyard');
    });

    test('within the window the block still wins, however fresh the reading', () => {
        const b = block('the inn', 1);
        const p = prose('the stableyard', 1 + CONTEXT_OVERRIDE_AFTER);
        expect(merge_context(p, b).v).toBe('the inn');
    });

    test('same source falls back to recency', () => {
        expect(merge_context(prose('b', 5), prose('a', 4)).v).toBe('b');
        expect(merge_context(prose('a', 4), prose('b', 5)).v).toBe('b');
    });

    test('converges regardless of arrival order — extraction is async', () => {
        // The reason this is not merge_b. A narrative reading of turn 9 can land after a block from
        // turn 10; last-write cannot see that, because it only knows which call arrived second.
        const pairs = [[block('inn', 10), prose('yard', 9)], [prose('yard', 9), block('inn', 10)]];
        const [first, second] = pairs.map(([a, b]) => merge_context(a, b).v);
        expect(first).toBe(second);
    });

    test('an absent prior is simply taken', () => {
        expect(merge_context(prose('yard', 1), undefined).v).toBe('yard');
    });
});

/*
 * The prompt and the panel are two products with one data source. A reader discounts a value
 * labelled "(as of 9 exchanges ago)"; a model does not. `InsertEmission.the_insert_law` makes a
 * stale assertion a projection that can absorb the emission — it overrides what the model would
 * otherwise have written, rather than merely failing to inform it.
 */
describe('contextBand — what the PROMPT may assert', () => {
    test('fresh facts are asserted plainly', () => {
        expect(contextBand(0)).toBe('assert');
        expect(contextBand(CONTEXT_ANNOTATE_AFTER - 1)).toBe('assert');
    });

    test('ageing facts carry their age, which turns a claim into a question', () => {
        // The repair that stopped fold freezing the clock at 1:03 PM through a whole afternoon.
        expect(contextBand(CONTEXT_ANNOTATE_AFTER)).toBe('annotate');
        expect(contextBand(CONTEXT_DROP_AFTER)).toBe('annotate');
    });

    test('past the horizon the prompt stops asserting a scene the story has left', () => {
        expect(contextBand(CONTEXT_DROP_AFTER + 1)).toBe('drop');
        expect(contextBand(999)).toBe('drop');
    });

    test('the bands are ordered and exhaustive', () => {
        const seen = new Set();
        let last = 'assert';
        const rank = { assert: 0, annotate: 1, drop: 2 };
        for (let age = 0; age <= CONTEXT_DROP_AFTER + 5; age++) {
            const band = contextBand(age);
            seen.add(band);
            // Monotone: warrant never comes back.
            expect(rank[band]).toBeGreaterThanOrEqual(rank[last]);
            last = band;
        }
        expect([...seen].sort()).toEqual(['annotate', 'assert', 'drop']);
    });

    test('junk ages do not fall through to drop', () => {
        for (const junk of [undefined, null, NaN, -5]) {
            expect(contextBand(junk)).toBe('assert');
        }
    });

    test('the drop horizon is single-sourced from STALE_THRESHOLD', () => {
        // Same question — "has this stopped being part of the present scene?" — so the same number.
        // A duplicated threshold is a second thing to retune, and retuning one is how a bound comes
        // to mean two things.
        expect(CONTEXT_DROP_AFTER).toBe(STALE_THRESHOLD);
    });
});
