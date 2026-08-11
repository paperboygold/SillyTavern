import { describe, expect, test } from '@jest/globals';

import { AutoUnit, DistillConfig, Witness } from '../public/scripts/extensions/fold/lib/ml/distill.js';
import {
    Contract,
    Verdict,
    differentialReplay,
    differentialReplayThresholded,
    regexScopeCheck,
    self_test,
} from '../public/scripts/extensions/fold/lib/ml/contract.js';

/**
 * contract.js is the JS mirror of modelfold/src/auto/contract.rs — the verification gate a
 * distilled unit must clear before it's trusted in place of the LLM. The three-valued verdict is
 * the trinity {Pass, Fail, Inconclusive}; Fail beats Inconclusive beats Pass, and both block emit.
 */
describe('contract.js — the recompile gate', () => {
    const ticketWitnesses = () => [
        ['why was I charged twice for my card', 0],
        ['my invoice shows the wrong amount', 0],
        ['the app crashes when I open settings', 1],
        ['clicking save throws an error', 1],
        ['please add dark mode support', 2],
        ['add an export to CSV option', 2],
    ].map(([text, klass]) => new Witness(text, klass));

    test('self_test() holds', () => {
        expect(self_test()).toBe('contract.js: the trinity verdicts hold');
    });

    test('a units own witnesses pass exact differential replay', () => {
        const ws = ticketWitnesses();
        const unit = AutoUnit.distill(ws, new DistillConfig());
        expect(differentialReplay(unit, ws).kind).toBe('Pass');
    });

    test('no witnesses is inconclusive not pass or fail', () => {
        const ws = ticketWitnesses();
        const unit = AutoUnit.distill(ws, new DistillConfig());
        expect(differentialReplay(unit, []).kind).toBe('Inconclusive');
    });

    test('contract exact replay requires exact replay and passes on witnessed data', () => {
        const ws = ticketWitnesses();
        const unit = AutoUnit.distill(ws, new DistillConfig());
        const contract = Contract.exactReplay();
        expect(contract.verify(unit, ws).kind).toBe('Pass');
        expect(contract.verify(unit, ws).blocksEmit()).toBe(false);
    });

    test('contract default disables every check and trivially passes', () => {
        const ws = ticketWitnesses();
        const unit = AutoUnit.distill(ws, new DistillConfig());
        expect(new Contract().verify(unit, ws).kind).toBe('Pass');
    });

    test('contract with unreachable holdout floor fails and blocks emit', () => {
        const ws = ticketWitnesses();
        const cfg = new DistillConfig({ holdoutFrac: 0.3, minHoldoutAccuracy: 0.0 });
        const unit = AutoUnit.distill(ws, cfg);
        const contract = new Contract({ minDifferentialAgreementMilli: 1000, minHoldoutAccuracy: 1.01 });
        const verdict = contract.verify(unit, ws);
        expect(verdict.kind).toBe('Fail');
        expect(verdict.blocksEmit()).toBe(true);
    });

    test('regex scope check passes when every class witness matches', () => {
        const ws = ticketWitnesses();
        expect(regexScopeCheck(ws, 0, 'charged|invoice|payment|card').kind).toBe('Pass');
    });

    test('regex scope check fails on a witness outside the declared pattern', () => {
        const ws = ticketWitnesses();
        ws.push(new Witness('what a lovely sunny day today', 0));
        expect(regexScopeCheck(ws, 0, 'charged|invoice|payment|card').kind).toBe('Fail');
    });

    test('regex scope check is inconclusive when the class has no witnesses', () => {
        const ws = ticketWitnesses();
        expect(regexScopeCheck(ws, 99, 'anything').kind).toBe('Inconclusive');
    });

    test('fail beats inconclusive when combined', () => {
        const combined = Verdict.combine([
            new Verdict('Inconclusive', { reason: 'no data' }),
            new Verdict('Fail', { reasons: ['mismatch'] }),
            new Verdict('Pass'),
        ]);
        expect(combined.kind).toBe('Fail');
    });

    test('a fail with empty reasons still blocks emit when combined', () => {
        // Regression: combine used to infer "was there a Fail?" from whether reasons were
        // non-empty — which silently dropped a Fail{reasons: []} (a real, producible case: a
        // >100% threshold with perfect agreement has nothing to name, yet still fails).
        const combined = Verdict.combine([new Verdict('Pass'), new Verdict('Fail', { reasons: [] })]);
        expect(combined.kind).toBe('Fail');
        expect(combined.blocksEmit()).toBe(true);
    });

    test('an unreachable threshold fails even with perfect agreement and names why', () => {
        const ws = ticketWitnesses();
        const unit = AutoUnit.distill(ws, new DistillConfig());
        const verdict = differentialReplayThresholded(unit, ws, 1001);
        expect(verdict.kind).toBe('Fail');
        expect(verdict.reasons.length).toBeGreaterThan(0);
    });
});
