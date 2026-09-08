import { describe, expect, test } from '@jest/globals';

import { AutoUnit, DistillConfig, Witness, featurize, self_test } from '../public/scripts/extensions/sanguine/lib/ml/distill.js';

/**
 * distill.js is the JS mirror of modelfold/src/auto/mod.rs (autofold). These tests pin the
 * auto lifecycle behaviors: guard admits near-paraphrases, deopts novelty, refuses empty and
 * single-class witness sets, and the holdout floor gate refuses rather than silently shipping.
 */
describe('distill.js, AutoUnit, the distilled resolver', () => {
    /** A realistic tool-routing witness set (binary: class 1 = refund, class 0 = tracking). */
    const refundWitnesses = () => [
        ['I would like a refund for order 1029', 1],
        ['please refund my purchase, order 5521', 1],
        ['can I get my money back for order 88', 1],
        ['refund request for order number 771', 1],
        ['I want a refund on order 42', 1],
        ['what is the status of my order 1029', 0],
        ['when will order 5521 ship', 0],
        ['can you track order 88 for me', 0],
        ['update the shipping address for order 771', 0],
        ['what items are in order 42', 0],
    ].map(([text, klass]) => new Witness(text, klass));

    /** Auto's own flagship shape: a 3-class ticket router (billing/bug/feature). */
    const ticketWitnesses = () => [
        ['why was I charged twice for my subscription this month', 0],
        ['my invoice shows the wrong amount, please fix billing', 0],
        ['I want a refund on my last payment, overcharged', 0],
        ['the credit card on file is being billed incorrectly', 0],
        ['the app crashes every time I open the settings page', 1],
        ['clicking save throws an error and loses my changes', 1],
        ['the page is completely broken on mobile, nothing loads', 1],
        ['getting a 500 error whenever I try to upload a file', 1],
        ['it would be great if you added dark mode support', 2],
        ['please add the ability to export data as CSV', 2],
        ['can you add a keyboard shortcut for search', 2],
        ['requesting support for two factor authentication', 2],
    ].map(([text, klass]) => new Witness(text, klass));

    test('self_test() holds', () => {
        expect(self_test()).toBe('distill.js: all lifecycle edge cases hold');
    });

    test('near paraphrase of a witnessed family admits and predicts correctly', () => {
        const unit = AutoUnit.distill(refundWitnesses(), new DistillConfig({ alphaMilli: 200 }));
        const refund = unit.decide('I need a refund for order 9981');
        expect(refund.kind).toBe('FastPath');
        expect(refund.class).toBe(1);
        const track = unit.decide('please track my order 9981 for me');
        expect(track.kind).toBe('FastPath');
        expect(track.class).toBe(0);
    });

    test('genuinely novel request trips the guard, not guessed by the GBM', () => {
        const unit = AutoUnit.distill(refundWitnesses(), new DistillConfig());
        const d = unit.decide('I forgot my password, please help me reset my account credentials');
        expect(d.kind).toBe('Deopt');
    });

    test('empty witness set refuses rather than producing a useless unit', () => {
        expect(() => AutoUnit.distill([], new DistillConfig())).toThrow();
        let kind = null;
        try {
            AutoUnit.distill([], new DistillConfig());
        } catch (e) {
            kind = e.kind;
        }
        expect(kind).toBe('NoWitnesses');
    });

    test('single class witness set refuses', () => {
        const ws = [
            new Witness('always the same thing', 0),
            new Witness('still the same thing', 0),
        ];
        let kind = null;
        try {
            AutoUnit.distill(ws, new DistillConfig());
        } catch (e) {
            kind = e.kind;
        }
        expect(kind).toBe('FewerThanTwoClasses');
    });

    test('three class ticket routing works', () => {
        const unit = AutoUnit.distill(ticketWitnesses(), new DistillConfig());
        expect(unit.n_classes()).toBe(3);
        const billing = unit.decide('I got double charged on my card, why?');
        expect(billing.kind).toBe('FastPath');
        expect(billing.class).toBe(0);
        const bug = unit.decide('the settings page throws an error and crashes');
        expect(bug.kind).toBe('FastPath');
        expect(bug.class).toBe(1);
        const feature = unit.decide('could you add support for dark mode please');
        expect(feature.kind).toBe('FastPath');
        expect(feature.class).toBe(2);
    });

    test('holdout gate refuses when floor is unreachable', () => {
        const cfg = new DistillConfig({ holdoutFrac: 0.5, minHoldoutAccuracy: 1.01 });
        let kind = null;
        try {
            AutoUnit.distill(refundWitnesses(), cfg);
        } catch (e) {
            kind = e.kind;
        }
        expect(kind).toBe('BelowAccuracyFloor');
    });

    test('holdout gate passes and reports accuracy when floor is reasonable', () => {
        const cfg = new DistillConfig({ holdoutFrac: 0.3, minHoldoutAccuracy: 0.0 });
        const unit = AutoUnit.distill(ticketWitnesses(), cfg);
        expect(unit.holdout_accuracy()).not.toBeNull();
    });

    test('featurize counts repeated trigrams, not just presence', () => {
        // 'aaaa' has two 'aaa' trigrams -> the bucket count for that trigram is 2.
        const feat = featurize('aaaa', 64);
        expect(feat.reduce((a, b) => a + b, 0)).toBe(2);
    });
});
