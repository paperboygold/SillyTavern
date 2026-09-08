import { describe, expect, test } from '@jest/globals';

import {
    fold,
    insert_with,
    lookup,
    merge_acc,
    merge_b,
    merge_bu,
    merge_graph,
    merge_nb,
    self_test,
    table_entries,
    table_from,
    table_values,
} from '../public/scripts/extensions/sanguine/lib/hash.js';

/**
 * hash.js is vendored verbatim from the Sanguine proof corpus, it is the JavaScript mirror of
 * proof/Substrate/Algebra/HashTrinity.lean and lyrium's src/hash.rs. These tests assert the
 * properties that define each merge, so that if the vendored copy ever drifts from the mirror,
 * this file fails before anything downstream misbehaves.
 */
describe('hash.js, the vendored mirror', () => {
    test('self_test() holds', () => {
        expect(self_test()).toBe('hash.js: all merges hold');
    });

    test('insert_with returns the same Map instance it was given', () => {
        const m = new Map();
        expect(insert_with(m, merge_b, 'k', 1)).toBe(m);
    });

    test('lookup floors absent keys', () => {
        const m = new Map();
        const sentinel = Symbol('floor');
        expect(lookup(m, 'nope', sentinel)).toBe(sentinel);
        expect(lookup(m, 'nope', 0)).toBe(0);
        expect(lookup(m, 'nope', [])).toEqual([]);
    });
});

describe('the trinity of merges', () => {
    test('NB / Set, idempotent: once in, in', () => {
        const s = new Map();
        insert_with(s, merge_nb, 'x', true);
        insert_with(s, merge_nb, 'x', false);
        expect(lookup(s, 'x', false)).toBe(true);
        // f(v, v) === v is the defining property.
        expect(merge_nb(true, true)).toBe(true);
    });

    test('B / Map, last write wins', () => {
        const m = new Map();
        insert_with(m, merge_b, 'k', 1);
        insert_with(m, merge_b, 'k', 9);
        expect(lookup(m, 'k', null)).toBe(9);
    });

    test('B/U / Count, associative accumulation', () => {
        const a = new Map();
        [1, 2, 3].forEach(n => insert_with(a, merge_bu, 'k', n));
        expect(lookup(a, 'k', 0)).toBe(6);
        // Associativity: the fold order must not matter.
        const b = new Map();
        [3, 2, 1].forEach(n => insert_with(b, merge_bu, 'k', n));
        expect(lookup(b, 'k', 0)).toBe(lookup(a, 'k', 0));
    });

    test('B/U / Accumulator, the pair monoid combines componentwise', () => {
        const acc = new Map();
        insert_with(acc, merge_acc, 'f', { sum: 3, n: 1 });
        insert_with(acc, merge_acc, 'f', { sum: 5, n: 1 });
        expect(lookup(acc, 'f', { sum: 0, n: 0 })).toEqual({ sum: 8, n: 2 });
    });

    test('Graph, ++ over keys PRESERVES INSERTION ORDER', () => {
        // Load-bearing for fold's swipe steering: swipe N's instruction must stay attached to
        // swipe N, which only holds because merge_graph is old.concat(nu) and not the reverse.
        const g = new Map();
        insert_with(g, merge_graph, 'a', ['b']);
        insert_with(g, merge_graph, 'a', ['c']);
        insert_with(g, merge_graph, 'a', ['d']);
        expect(lookup(g, 'a', [])).toEqual(['b', 'c', 'd']);
    });
});

describe('recursor helpers', () => {
    test('fold floors null/undefined/empty to the zero', () => {
        const add = (z, x) => z + x;
        expect(fold([], 7, add)).toBe(7);
        expect(fold(null, 7, add)).toBe(7);
        expect(fold(undefined, 7, add)).toBe(7);
        expect(fold([1, 2, 3], 0, add)).toBe(6);
    });

    test('fold passes the index, so callbacks can key by position', () => {
        const seen = [];
        fold(['a', 'b'], null, (_z, x, i) => void seen.push([x, i]));
        expect(seen).toEqual([['a', 0], ['b', 1]]);
    });

    test('table_from groups by key under the graph merge', () => {
        const by = table_from(['aa', 'b', 'ac'], x => x[0], x => [x]);
        expect(lookup(by, 'a', [])).toEqual(['aa', 'ac']);
        expect(lookup(by, 'b', [])).toEqual(['b']);
        expect(lookup(by, 'z', [])).toEqual([]);
    });

    test('table_from accepts a different merge, the merge is the only freedom', () => {
        const counts = table_from(['aa', 'b', 'ac'], x => x[0], () => 1, merge_bu);
        expect(lookup(counts, 'a', 0)).toBe(2);
        expect(lookup(counts, 'b', 0)).toBe(1);
    });

    test('table_values and table_entries return arrays in insertion order', () => {
        const m = new Map();
        insert_with(m, merge_b, 'first', 1);
        insert_with(m, merge_b, 'second', 2);
        expect(table_values(m)).toEqual([1, 2]);
        expect(table_entries(m)).toEqual([['first', 1], ['second', 2]]);
    });
});
