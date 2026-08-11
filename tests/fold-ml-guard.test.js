import { describe, expect, test } from '@jest/globals';

import { Guard, Sketch, fnv1a32, jaccardDistance, self_test } from '../public/scripts/extensions/fold/lib/ml/guard.js';

/**
 * guard.js is the JS mirror of modelfold/src/guard/mod.rs (guardfold), auto's split-conformal
 * admission guard. These tests assert the pinned edge cases the Rust suite pins, so a drift from
 * the mirror fails here before the identity resolver misbehaves.
 */
describe('guard.js — the split-conformal admission guard', () => {
    test('self_test() holds', () => {
        expect(self_test()).toBe('guard.js: all admission edge cases hold');
    });

    test('identical sketches have zero distance', () => {
        const a = Sketch.of('the quick brown fox');
        const b = Sketch.of('the quick brown fox');
        expect(jaccardDistance(a, b)).toBe(0.0);
    });

    test('both empty is zero, one empty is one', () => {
        const empty = Sketch.of('');
        const short = Sketch.of('ab'); // < 3 bytes -> also empty sketch
        const real = Sketch.of('the quick brown fox');
        expect(jaccardDistance(empty, short)).toBe(0.0);
        expect(jaccardDistance(empty, real)).toBe(1.0);
    });

    test('completely disjoint text is near distance one', () => {
        const a = Sketch.of('aaaaaaaaaa');
        const b = Sketch.of('the quick brown fox jumps over the lazy dog');
        expect(jaccardDistance(a, b)).toBeGreaterThan(0.9);
    });

    test('single witness threshold is zero and only exact match admits', () => {
        const w = Sketch.of('get user profile by id');
        const g = Guard.calibrate([w], 100);
        expect(g.threshold_value()).toBe(0.0);
        expect(g.admits(w)).toBe(true); // exact match: distance 0 <= 0
        expect(g.admits(Sketch.of('completely different request text'))).toBe(false);
    });

    test('no witnesses never admits', () => {
        const g = Guard.calibrate([], 100);
        expect(g.admits(Sketch.of('anything'))).toBe(false);
    });

    test('tight cluster of witnesses admits a near paraphrase', () => {
        // A realistic tool-call-argument cluster: near-duplicate phrasings of the same request.
        const witnesses = [
            Sketch.of('get the user profile for id 42'),
            Sketch.of('get the user profile for id 17'),
            Sketch.of('get the user profile for id 9001'),
            Sketch.of('fetch the user profile for id 3'),
            Sketch.of('get the user profile for id 256'),
        ];
        const g = Guard.calibrate(witnesses, 100);
        expect(g.admits(Sketch.of('get the user profile for id 77'))).toBe(true);
        expect(g.admits(Sketch.of('delete the payment record for order 555'))).toBe(false);
    });

    test('k greater than n truncates to max LOO score not infinite admission', () => {
        // n=2, alpha_milli=1 (alpha ~ 0.001) -> k = ceil(3 * 0.999) = 3 > n=2: must truncate to
        // the max LOO score, not silently admit everything.
        const witnesses = [
            Sketch.of('alpha one two three'),
            Sketch.of('beta four five six'),
        ];
        const g = Guard.calibrate(witnesses.slice(), 1);
        const maxLoo = jaccardDistance(witnesses[0], witnesses[1]);
        expect(g.threshold_value()).toBe(maxLoo);
    });

    test('fnv1a32 matches the pinned Rust test vector', () => {
        // FNV-1a-32('abc') = 0x1a47e90b — the canonical reference vector, confirming the hash
        // (and hence every sketch/feature built on it) is the same arithmetic as the Rust.
        const bytes = new TextEncoder().encode('abc');
        const h = fnv1a32(bytes);
        expect(h >>> 0).toBe(0x1a47_e90b);
    });
});
