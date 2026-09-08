import { describe, expect, test } from '@jest/globals';

import { AutoUnit, DistillConfig, Witness } from '../public/scripts/extensions/sanguine/lib/ml/distill.js';
import {
    Contract,
    Verdict,
    baselineShare,
    cellAdmits,
    cellPosterior,
    countWeight,
    differentialReplay,
    differentialReplayThresholded,
    earnedAccuracyFloor,
    earnedBaselineCheck,
    regexScopeCheck,
    self_test,
} from '../public/scripts/extensions/sanguine/lib/ml/contract.js';

/**
 * contract.js is the JS mirror of modelfold/src/auto/contract.rs, the verification gate a
 * distilled unit must clear before it's trusted in place of the LLM. The three-valued verdict is
 * the trinity {Pass, Fail, Inconclusive}; Fail beats Inconclusive beats Pass, and both block emit.
 */
describe('contract.js, the recompile gate', () => {
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
        // non-empty, which silently dropped a Fail{reasons: []} (a real, producible case: a
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

/**
 * The earned floor is this tree's addition, not part of the auto port: the accuracy a unit must
 * clear is DERIVED from its own witness set rather than declared as a number.
 * `countWeight` is the BLUP posterior weight, `blup_is_countWeight`
 * (sanguine `proof/Substrate/Algebra/Security/HashTrinityCore.lean:298`) proves the identity, and
 * `countWeight_strict_mono` (`:335`) proves it strictly increasing in the count.
 */
describe('contract.js, the earned accuracy floor', () => {
    /** A witness set skewed the way a real identity corpus is: mostly `same`. */
    const skewed = (n, minority) => {
        const ws = [];
        for (let i = 0; i < n - minority; i++) {
            ws.push(new Witness(`pair ${i} restated at greater length ${i}`, 0));
        }
        for (let i = 0; i < minority; i++) {
            ws.push(new Witness(`unrelated thing ${i} versus another thing ${i}`, 1));
        }
        return ws;
    };

    test('the baseline is the majority share, which is what a constant answer scores', () => {
        expect(baselineShare(skewed(35, 3))).toBeCloseTo(32 / 35, 10);
        expect(baselineShare([])).toBe(0);
    });

    test('the weight is strictly increasing in the count (countWeight_strict_mono)', () => {
        const alpha = 4;
        expect(countWeight(alpha, 0)).toBe(0);
        expect(countWeight(alpha, 4)).toBeCloseTo(0.5, 10);
        for (let n = 1; n < 50; n++) {
            expect(countWeight(alpha, n)).toBeGreaterThan(countWeight(alpha, n - 1));
        }
        expect(countWeight(alpha, 1e9)).toBeGreaterThan(0.999);
    });

    test('with no evidence the floor is perfection, and it falls to the baseline as evidence accrues', () => {
        const ws = skewed(35, 3);
        const baseline = baselineShare(ws);
        // n = 0: nothing is earned, so nothing short of perfect is admissible.
        expect(earnedAccuracyFloor(ws, 0, 4)).toBeCloseTo(1, 10);
        // The floor descends monotonically toward the baseline, never below it.
        let previous = 1;
        for (let n = 1; n <= 500; n++) {
            const floor = earnedAccuracyFloor(ws, n, 4);
            expect(floor).toBeLessThan(previous);
            expect(floor).toBeGreaterThan(baseline);
            previous = floor;
        }
        expect(earnedAccuracyFloor(ws, 1e7, 4)).toBeCloseTo(baseline, 5);
    });

    test('a unit that is worse than the constant answer fails the floor', () => {
        // The measured case this check exists for: fold's real identity corpus scored 81.3% by
        // leave-one-out against a 91.4% majority baseline. An absolute `minHoldoutAccuracy` below
        // 0.81 passes that unit; the earned floor does not.
        const ws = skewed(35, 3);
        const unit = AutoUnit.distill(ws, new DistillConfig());
        unit.holdoutAccuracy = 0.813;
        unit.holdoutN = 32;
        const verdict = earnedBaselineCheck(unit, ws, 4);
        expect(verdict.kind).toBe('Fail');
        expect(verdict.reasons[0]).toContain('earned floor');
    });

    test('beating the constant is not enough when the evidence is thin', () => {
        // 92.0% beats the 91.4% constant, but on n=32 the earned floor is 92.4%: the margin is
        // smaller than this much evidence can distinguish from noise.
        const ws = skewed(35, 3);
        const unit = AutoUnit.distill(ws, new DistillConfig());
        unit.holdoutAccuracy = 0.920;
        unit.holdoutN = 32;
        expect(earnedBaselineCheck(unit, ws, 4).kind).toBe('Fail');
        // The same accuracy on ten times the evidence clears it, nothing changed but the count.
        unit.holdoutN = 320;
        expect(earnedBaselineCheck(unit, ws, 4).kind).toBe('Pass');
    });

    test('no holdout measurement is inconclusive, never a pass', () => {
        const ws = skewed(35, 3);
        const unit = AutoUnit.distill(ws, new DistillConfig());
        expect(unit.holdout_accuracy()).toBeNull();
        expect(unit.holdout_n()).toBeNull();
        const verdict = earnedBaselineCheck(unit, ws, 4);
        expect(verdict.kind).toBe('Inconclusive');
        expect(verdict.blocksEmit()).toBe(true);
    });

    test('a distilled unit reports how many held-out examples its accuracy rests on', () => {
        const ws = skewed(20, 6);
        const unit = AutoUnit.distill(ws, new DistillConfig({ holdoutFrac: 0.25 }));
        expect(unit.holdout_n()).toBe(5);
        expect(unit.holdout_accuracy()).not.toBeNull();
    });

    test('a thin cell cannot outvote the prior; an evidenced one can', () => {
        const base = 0.83;
        // n=1 disagreeing with the prior stays at the prior, the weight is 1/5.
        expect(cellPosterior(1, 0, base, 4)).toBeGreaterThan(0.5);
        // The same 0% same-rate at n=40 flips it.
        expect(cellPosterior(40, 0, base, 4)).toBeLessThan(0.5);
        // n=0 is exactly the prior, never a guess.
        expect(cellPosterior(0, 1, base, 4)).toBeCloseTo(base, 10);
        // Monotone: more evidence for `different` moves the posterior down, never up.
        let previous = 1;
        for (let n = 1; n <= 60; n++) {
            const p = cellPosterior(n, 0, base, 4);
            expect(p).toBeLessThan(previous);
            previous = p;
        }
    });

    test('admission and shrinkage are both required, either alone was measured to fail', () => {
        const base = 0.83;
        // A pure, well-evidenced cell answers.
        expect(cellAdmits(26, 0.96, base, 4)).toBe(true);
        expect(cellAdmits(12, 1.0, base, 4)).toBe(true);
        // The 67%-pure cell does not, however many ways it is informative: on fold's corpus,
        // answering it took the model from 88.1% (clearing an 84.4% floor) to 78.9% (below 83.8%).
        expect(cellAdmits(9, 0.67, base, 4)).toBe(false);
        // Nothing is answered on no evidence.
        expect(cellAdmits(0, 1.0, base, 4)).toBe(false);
        expect(cellAdmits(2, 0.5, base, 4)).toBe(false);
    });

    test('the check is opt-in, the default contract still declares nothing', () => {
        const ws = skewed(35, 3);
        const unit = AutoUnit.distill(ws, new DistillConfig());
        expect(new Contract().baselineAlpha).toBeNull();
        expect(new Contract().verify(unit, ws).kind).toBe('Pass');
        // Opting in with no holdout measurement blocks emit rather than waving it through.
        expect(Contract.earnedBaseline().verify(unit, ws).blocksEmit()).toBe(true);
    });
});
