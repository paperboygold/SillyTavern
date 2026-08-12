import { describe, expect, test } from '@jest/globals';

import {
    checkInvariants,
    negativeQuantities,
    partitionContradictions,
    splitCurrency,
} from '../public/scripts/extensions/fold/invariant-table.js';
import { itemKey, MONEY } from '../public/scripts/extensions/fold/state-table.js';

const PAIR_SEP = String.fromCharCode(1);

/**
 * invariant-table.js is what the ledger can prove wrong about ITSELF — no labels, no model call,
 * no human. The cases below are the live ones, taken off the chats rather than invented.
 */
describe('invariant-table — contradictions provable without ground truth', () => {
    test('a negative quantity of a physical thing is impossible', () => {
        // Time Stop's real state: the spends landed on money/silver while the credits landed on
        // carried/silver wen, so the balance folded to -11.
        const inv = new Map([
            [itemKey('silver', MONEY), { qty: -11 }],
            [itemKey('rope'), { qty: 1 }],
        ]);
        const found = negativeQuantities(inv);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: 'negative-quantity', name: 'silver', qty: -11 });
    });

    test('one currency in two rows is a keying fault, and it is flagged across places', () => {
        // Wuxia's real state.
        const inv = new Map([
            [itemKey('silver wen'), { qty: 21 }],
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const found = splitCurrency(inv);
        expect(found).toHaveLength(1);
        expect(found[0].token).toBe('silver');
        expect(found[0].rows.map(r => r.name).sort()).toEqual(['silver', 'silver wen']);
    });

    test('two carried objects sharing a word are two objects, not a split balance', () => {
        // The discrimination that keeps this from firing on everything: no money row, no flag.
        // Time Stop really does hold both of these.
        const inv = new Map([
            [itemKey('silver ring'), { qty: 1 }],
            [itemKey('silver moon locket'), { qty: 1 }],
        ]);
        expect(splitCurrency(inv)).toEqual([]);
    });

    test('a `different` inside a merged component is a contradiction', () => {
        // a=b and b=c, so a and c are one thing; calling them different cannot be meant.
        const answers = new Map([
            [`a${PAIR_SEP}b`, { answer: 'same' }],
            [`b${PAIR_SEP}c`, { answer: 'same' }],
            [`a${PAIR_SEP}c`, { answer: 'different' }],
        ]);
        const found = partitionContradictions(answers);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: 'partition-contradiction' });
    });

    test('the live corpus shape is consistent, which is what makes the closure free', () => {
        // Measured across seven campaigns and 76 verdicts: zero contradictions. That is the
        // condition under which transitivity may be taken as fact rather than hypothesis.
        const answers = new Map([
            [`temple discovery${PAIR_SEP}temple mystery`, { answer: 'same' }],
            [`temple mystery${PAIR_SEP}temple secrets`, { answer: 'same' }],
            [`garrison integration${PAIR_SEP}garrison loyalty`, { answer: 'different' }],
        ]);
        expect(partitionContradictions(answers)).toEqual([]);
    });

    test('a split raises a QUESTION and never a merge — and that question is a free witness', () => {
        // The point of the second return value. `lib/ml/` has been starved of witnesses because
        // every one cost an LLM question slot; this one is produced by conservation, during play,
        // at no marginal cost. It is still only a question: fold does not merge on a token overlap.
        const inv = new Map([
            [itemKey('silver wen'), { qty: 21 }],
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const { violations, suspected, witnesses } = checkInvariants({ inv });
        // A split is SUSPECTED, never proven: fold cannot tell `silver wen` from `silver moon
        // locket` structurally, so it raises the question and reports no defect.
        expect(violations).toEqual([]);
        expect(suspected.some(v => v.kind === 'split-currency')).toBe(true);
        expect(witnesses).toHaveLength(1);
        expect(witnesses[0]).toMatchObject({ of: 'item', why: 'split-currency' });
        // The witness names the two KEYS, so a resolver answer can be applied to the right rows.
        expect([witnesses[0].a, witnesses[0].b].every(k => typeof k === 'string' && k.length)).toBe(true);
    });

    test('a clean ledger reports nothing', () => {
        const inv = new Map([
            [itemKey('rope'), { qty: 1 }],
            [itemKey('silver', MONEY), { qty: 30 }],
        ]);
        expect(checkInvariants({ inv, answers: [] })).toEqual({ violations: [], suspected: [], witnesses: [] });
    });
});
