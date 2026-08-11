import { describe, expect, test } from '@jest/globals';

import { Contract } from '../public/scripts/extensions/fold/lib/ml/contract.js';
import { Ratchet, RatchetConfig, StepOutcome, self_test } from '../public/scripts/extensions/fold/lib/ml/ratchet.js';

/**
 * ratchet.js is the JS mirror of modelfold/src/auto/ratchet.rs — the closed loop that gives the
 * whole identity-resolver lifecycle its point: guard, deopt, re-record, recompile. The claim it
 * demonstrates: the oracle-call ("deopt") rate decays as the unit absorbs the stream.
 */
describe('ratchet.js — the gradual LLM→resolver takeover loop', () => {
    /**
     * Two lexically distinct phrasing sets per class, plus a hard distribution SHIFT at
     * `shiftAt` from phase-A wording to phase-B wording — auto's own H1 benchmark design.
     */
    const stream = (n, shiftAt) => {
        const BILLING_A = ['why was I charged twice for order', 'my invoice is wrong for order', 'refund request for overcharge on order', 'billing dispute regarding order'];
        const BUG_A = ['the app crashes when I open order', 'getting an error page for order', 'nothing loads on the order page for', 'a 500 error happens loading order'];
        const FEATURE_A = ['please add CSV export for order', 'requesting dark mode near order', 'can you add search filters for order', 'it would help to add tags to order'];
        const BILLING_B = ['payment processed incorrectly on ticket', 'double debit needs reversing for ticket', 'account statement discrepancy for ticket', 'subscription fee dispute on ticket'];
        const BUG_B = ['console throws a stack trace for ticket', 'the build fails to load for ticket', 'session drops unexpectedly on ticket', 'the widget freezes the page for ticket'];
        const FEATURE_B = ['wishlist idea: bulk actions for ticket', 'would love keyboard nav support, ticket', 'suggest adding a timeline view, ticket', 'roadmap ask: multi-language support, ticket'];
        return Array.from({ length: n }, (_, i) => {
            const phaseB = i >= shiftAt;
            const templates = phaseB
                ? [BILLING_B, BUG_B, FEATURE_B][i % 3]
                : [BILLING_A, BUG_A, FEATURE_A][i % 3];
            return [templates[i % templates.length] + ' ' + (10000 + i), i % 3];
        });
    };

    test('self_test() holds', () => {
        expect(self_test()).toBe('ratchet.js: the deopt rate decays, spikes, and recovers');
    });

    test('deopt rate decays then recovers after a distribution shift', () => {
        const cfg = new RatchetConfig({ recompileEvery: 15 });
        const ratchet = new Ratchet(cfg);
        const items = stream(240, 120);

        const windowDeopts = [];
        let currentWindow = 0;
        const WINDOW = 30;
        for (let i = 0; i < items.length; i++) {
            const [text, klass] = items[i];
            const { outcome } = ratchet.step(text, () => klass);
            if (outcome === StepOutcome.Deopted) {
                currentWindow += 1;
            }
            if ((i + 1) % WINDOW === 0) {
                windowDeopts.push(currentWindow);
                currentWindow = 0;
            }
        }

        expect(ratchet.recompileCountValue()).toBeGreaterThanOrEqual(2);
        const preShiftLast = windowDeopts[3]; // last window before the shift: near-zero
        const atShift = windowDeopts[4];      // first window after the shift: spike
        const postShiftLast = windowDeopts[7]; // last window: recovered back down
        expect(atShift).toBeGreaterThan(preShiftLast);
        expect(postShiftLast).toBeLessThan(atShift);
    });

    test('fast pathed predictions agree with the oracle on the witnessed pattern', () => {
        const cfg = new RatchetConfig({ recompileEvery: 12 });
        const ratchet = new Ratchet(cfg);
        const items = stream(120, Number.MAX_SAFE_INTEGER); // no shift

        let fastpathCorrect = 0;
        let fastpathTotal = 0;
        for (const [text, klass] of items) {
            const { outcome, class: predicted } = ratchet.step(text, () => klass);
            if (outcome === StepOutcome.FastPath) {
                fastpathTotal += 1;
                if (predicted === klass) {
                    fastpathCorrect += 1;
                }
            }
        }
        expect(fastpathTotal).toBeGreaterThan(0);
        expect(fastpathCorrect / fastpathTotal).toBeGreaterThan(0.8);
    });

    test('an unreachable contract rejects every recompile and never installs a unit', () => {
        const cfg = new RatchetConfig({
            recompileEvery: 15,
            contract: new Contract({ minDifferentialAgreementMilli: 1001 }), // >100%, unreachable
        });
        const ratchet = new Ratchet(cfg);
        for (const [text, klass] of stream(60, Number.MAX_SAFE_INTEGER)) {
            ratchet.step(text, () => klass);
        }
        expect(ratchet.hasUnit()).toBe(false);
        expect(ratchet.rejectedRecompileCountValue()).toBeGreaterThan(0);
        expect(ratchet.recompileCountValue()).toBe(0);
    });

    test('a reachable contract still lets the ratchet recompile normally', () => {
        const cfg = new RatchetConfig({
            recompileEvery: 12,
            contract: new Contract({ minDifferentialAgreementMilli: 1000 }), // exact replay
        });
        const ratchet = new Ratchet(cfg);
        for (const [text, klass] of stream(120, Number.MAX_SAFE_INTEGER)) {
            ratchet.step(text, () => klass);
        }
        expect(ratchet.hasUnit()).toBe(true);
        expect(ratchet.rejectedRecompileCountValue()).toBe(0);
    });
});
