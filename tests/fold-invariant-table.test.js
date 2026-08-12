import { describe, expect, test } from '@jest/globals';

import {
    checkInvariants,
    negativeQuantities,
    partitionContradictions,
    splitCurrency,
    unbackedDebits,
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

    test('the token test is script-dependent, and this pins which scripts it fails', () => {
        // The claim "language-neutral" was made and was wrong. Splitting on non-alphanumerics needs
        // whitespace between words; Han, Hangul and Kana do not use it, and inflecting languages
        // change the stem. Pinned so the limitation cannot be forgotten again.
        const split = (a, b) => splitCurrency(new Map([
            [itemKey(a), { qty: 21 }],
            [itemKey(b, MONEY), { qty: 76 }],
        ])).length > 0;
        expect(split('silver wen', 'silver')).toBe(true);
        expect(split('二十银两', '银两')).toBe(false);
        expect(split('銀貨二十枚', '銀貨')).toBe(false);
        expect(split('은화스무닢', '은화')).toBe(false);
        expect(split('серебряных монет', 'серебро')).toBe(false);
    });

    test('an unbacked debit finds the split with NO text at all', () => {
        // The language-invariant half: money was spent from a row holding nothing, so the credit is
        // under another key. Pure arithmetic on fold's own numbers — this works in every script,
        // including the four the token test above misses.
        const inv = new Map([
            [itemKey('银两', MONEY), { qty: -11 }],
            [itemKey('二十银两', MONEY), { qty: 40 }],
            [itemKey('金', MONEY), { qty: 3 }],
        ]);
        const found = unbackedDebits(inv);
        expect(found).toHaveLength(1);
        expect(found[0].name).toBe('银两');
        // Every funded row is a candidate; fold picks none of them.
        expect(found[0].candidates.map(c => c.name).sort()).toEqual(['二十银两', '金']);
    });

    test('the two detectors cover different halves, and both become witnesses', () => {
        const inv = new Map([
            [itemKey('银两', MONEY), { qty: -11 }],      // unbacked: found with no text at all
            [itemKey('二十银两', MONEY), { qty: 40 }],    // the funded row the credit is likely in
            [itemKey('silver wen'), { qty: 21 }],        // overlap: found by the token supplement
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const { violations, suspected, witnesses } = checkInvariants({ inv });
        expect(violations.some(v => v.kind === 'negative-quantity')).toBe(true);
        expect(suspected.some(v => v.kind === 'unbacked-debit')).toBe(true);
        expect(suspected.some(v => v.kind === 'split-currency')).toBe(true);
        expect(witnesses.some(w => w.why === 'unbacked-debit')).toBe(true);
        expect(witnesses.some(w => w.why === 'split-currency')).toBe(true);
    });

    test('an unbacked debit offers only MONEY rows as candidates, and that is deliberate', () => {
        // Wuxia's real split is cross-place: `carried silver wen` holds the credit for a debit at
        // `money silver`. With no text there is nothing to narrow carried rows by, so offering all
        // of them would pair a negative balance against the dagger, the bow, the map and the rest —
        // a flood of obviously-different questions spending the review's eight slots on noise.
        //
        // So the text-free detector stays precise and money-only, and the cross-place case is the
        // token supplement's job wherever the script separates words. Where it does not (Han,
        // Hangul, Kana, inflected Slavic), a cross-place split is currently UNCAUGHT — the honest
        // boundary of both detectors, and the reason the schema field is the real answer.
        const inv = new Map([
            [itemKey('silver', MONEY), { qty: -11 }],
            [itemKey('dagger'), { qty: 1 }],
            [itemKey('bow'), { qty: 1 }],
        ]);
        const found = unbackedDebits(inv);
        expect(found).toHaveLength(1);
        expect(found[0].candidates).toEqual([]);
    });

    test('a clean ledger reports nothing', () => {
        const inv = new Map([
            [itemKey('rope'), { qty: 1 }],
            [itemKey('silver', MONEY), { qty: 30 }],
        ]);
        expect(checkInvariants({ inv, answers: [] })).toEqual({ violations: [], suspected: [], witnesses: [] });
    });
});
