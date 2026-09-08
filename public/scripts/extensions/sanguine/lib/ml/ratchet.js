// RATCHET, auto's flagship closed loop, ported from `modelfold/src/auto/ratchet.rs`: guard,
// deopt, re-record, recompile. A stream of inputs arrives; the current compiled unit (if any)
// fast-paths whatever it admits; whatever it deopts goes to a supplied oracle (in production, the
// real LLM call, this port never guesses at that boundary), the observation gets recorded, and
// the unit periodically recompiles on the growing witness set. The measurable claim this exists
// to demonstrate: the oracle-call ("deopt") rate should decay as the unit incorporates more of
// the stream.
//
// For SanguineTavern's identity resolver this is the LIFECYCLE itself: the LLM answers the first
// N `[same?]`/`[merge?]` pairs; the ratchet recompiles a distilled unit on those answers; and the
// unit gradually fast-paths near-paraphrases of already-witnessed pairs without a new LLM call,
// the pure-LLM → trained-resolver handoff, measured by the deopt rate.

import { AutoUnit, DistillConfig, Witness } from './distill.js';
import { Contract } from './contract.js';

/** The ratchet's hyperparameters, the gate a recompiled unit must clear before it replaces the
 * currently-active one ("the recompile's own gate"). */
export class RatchetConfig {
    /**
     * @param {object} [o] Overrides.
     * @param {DistillConfig} [o.distill] The distillation config.
     * @param {number} [o.recompileEvery=15] Recompile once this many NEW witnesses have
     *   accumulated since the last recompile.
     * @param {Contract} [o.contract] The gate a recompiled unit must clear before going live.
     *   `Contract` default (all-zero) declares no checks and trivially passes.
     */
    constructor(o = {}) {
        this.distill = o.distill ?? new DistillConfig();
        this.recompileEvery = o.recompileEvery ?? 15;
        this.contract = o.contract ?? new Contract();
    }
}

/** What happened for one stream item. */
export const StepOutcome = {
    /** The current unit admitted and answered, no oracle call. */
    FastPath: 'FastPath',
    /** No unit yet, or the guard tripped, the oracle was called and the answer recorded. */
    Deopted: 'Deopted',
};

/** The closed loop itself: unit + witness ledger + the recompile bookkeeping. */
export class Ratchet {
    /**
     * @param {RatchetConfig} cfg The config.
     */
    constructor(cfg) {
        this.unit = null;
        this.witnesses = [];
        this.pendingSinceRecompile = 0;
        this.cfg = cfg;
        this.recompileCount = 0;
        this.rejectedRecompileCount = 0;
    }

    /**
     * Process one input. Fast-paths through the current unit when it admits; otherwise calls
     * `oracle` for the ground truth, records it as a new witness, and recompiles once enough
     * have accumulated since the last recompile.
     * @param {string} text The input text.
     * @param {(text: string) => number} oracle The ground-truth answer (the LLM call).
     * @returns {{outcome: string, class?: number, proba?: number, recompiled: boolean}}
     */
    step(text, oracle) {
        if (this.unit !== null) {
            const d = this.unit.decide(text);
            if (d.kind === 'FastPath') {
                return { outcome: StepOutcome.FastPath, class: d.class, proba: d.proba, recompiled: false };
            }
        }
        const klass = oracle(text);
        this.witnesses.push(new Witness(text, klass));
        this.pendingSinceRecompile += 1;

        let recompiled = false;
        if (this.pendingSinceRecompile >= this.cfg.recompileEvery) {
            // A failed distill (e.g. still fewer than 2 classes witnessed) just keeps the prior
            // unit (or stays unit-less) rather than erroring the whole stream out. A unit that
            // DOES distill but fails ITS OWN contract check is a separate, distinct rejection,
            // "the recompile's own gate", and is likewise never swapped in.
            try {
                const newUnit = AutoUnit.distill(this.witnesses, this.cfg.distill);
                const verdict = this.cfg.contract.verify(newUnit, this.witnesses);
                if (verdict.blocksEmit()) {
                    this.rejectedRecompileCount += 1;
                } else {
                    this.unit = newUnit;
                    recompiled = true;
                    this.recompileCount += 1;
                }
            } catch {
                // distill failed (NoWitnesses / FewerThanTwoClasses): keep the prior unit.
            }
            this.pendingSinceRecompile = 0;
        }
        return { outcome: StepOutcome.Deopted, class: klass, recompiled };
    }

    /** @returns {number} Recompiles that distilled fine but failed their own contract gate. */
    rejectedRecompileCountValue() {
        return this.rejectedRecompileCount;
    }

    /** @returns {number} The number of recorded witnesses. */
    witnessCount() {
        return this.witnesses.length;
    }

    /** @returns {number} The number of successful recompiles. */
    recompileCountValue() {
        return this.recompileCount;
    }

    /** @returns {boolean} True when a unit is currently active. */
    hasUnit() {
        return this.unit !== null;
    }
}

// the self-test (mirrors auto/ratchet.rs §tests, runnable: import { self_test }).

/**
 * The ratchet's own verification: the deopt rate decays, spikes at a distribution shift, then
 * recovers: the whole point of the loop, asserted in miniature.
 * @returns {string} An acknowledgement that every assertion held.
 */
export const self_test = () => {
    const BILLING_A = ['why was I charged twice for order', 'my invoice is wrong for order', 'refund request for overcharge on order', 'billing dispute regarding order'];
    const BUG_A = ['the app crashes when I open order', 'getting an error page for order', 'nothing loads on the order page for', 'a 500 error happens loading order'];
    const FEATURE_A = ['please add CSV export for order', 'requesting dark mode near order', 'can you add search filters for order', 'it would help to add tags to order'];
    const BILLING_B = ['payment processed incorrectly on ticket', 'double debit needs reversing for ticket', 'account statement discrepancy for ticket', 'subscription fee dispute on ticket'];
    const BUG_B = ['console throws a stack trace for ticket', 'the build fails to load for ticket', 'session drops unexpectedly on ticket', 'the widget freezes the page for ticket'];
    const FEATURE_B = ['wishlist idea: bulk actions for ticket', 'would love keyboard nav support, ticket', 'suggest adding a timeline view, ticket', 'roadmap ask: multi-language support, ticket'];
    const ratchet = new Ratchet(new RatchetConfig({ recompileEvery: 15 }));
    const WINDOW = 30;
    let currentWindow = 0;
    const windows = [];
    for (let i = 0; i < 240; i++) {
        const phaseB = i >= 120;
        const templates = phaseB
            ? [BILLING_B, BUG_B, FEATURE_B][i % 3]
            : [BILLING_A, BUG_A, FEATURE_A][i % 3];
        const text = templates[i % templates.length] + ' ' + (10000 + i);
        const klass = i % 3;
        const { outcome } = ratchet.step(text, () => klass);
        if (outcome === StepOutcome.Deopted) {
            currentWindow += 1;
        }
        if ((i + 1) % WINDOW === 0) {
            windows.push(currentWindow);
            currentWindow = 0;
        }
    }
    // windows: [0..30) [30..60) [60..90) [90..120) [120..150) [150..180) [180..210) [210..240)
    const preShiftLast = windows[3];
    const atShift = windows[4];
    const postShiftLast = windows[7];
    if (!(ratchet.recompileCountValue() >= 2)) {
        throw new Error('ratchet.js: both phases should each force a recompile');
    }
    if (!(atShift > preShiftLast)) {
        throw new Error('ratchet.js: the shift should spike deopts');
    }
    if (!(postShiftLast < atShift)) {
        throw new Error('ratchet.js: the ratchet should recover after the shift');
    }
    return 'ratchet.js: the deopt rate decays, spikes, and recovers';
};
