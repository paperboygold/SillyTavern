// DISTILL, AutoUnit, ported from `modelfold/src/auto/mod.rs` (`autofold`), itself a re-standing
// of RightNow-AI/auto (`arxiv.org/abs/2607.04542`) with its distillation model swapped for
// boostfold's own GBM.
//
// auto's pipeline has three separable roles:
// 1. **The admission guard** (`guard.js`), a distribution-free, exchangeability-conditional
//    coverage test over a trigram-Jaccard distance. Swapping a learned model in for that test
//    would silently drop the coverage guarantee (a GBM's output is a probability, not a
//    calibrated nonconformity score).
// 2. **The distillation model**, the GBM (`boost.js`). THIS is where "offload the LLM's job to
//    a trained fast path" lands: the identity resolver's `[same?]`/`[merge?]` pairs and their
//    LLM answers are the witnesses; the distilled unit answers near-paraphrases without a new
//    LLM call.
// 3. **The judge role** (auto's ADR-0021 judged differential) is the SAME slot as (2): a
//    classifier predicting "accept" from witnessed (divergent-pair, accept/reject) observations.
//
// The decision at request time is: **guard trips -> deopt (fall back to the real LLM, never
// guessed here); guard admits -> read the distilled GBM (argmax over one-vs-rest
// probabilities)**, never both, and the GBM is never asked to cover a request the guard didn't
// already vouch for.

import { applyQuantileEdges, fitQuantileEdges, GbmModel, Loss, trainGbm } from './boost.js';
import { fnv1a32, Guard, Sketch } from './guard.js';

/**
 * Auto's ADR-0009 featurizer, verbatim: lowercase text, sliding 3-byte window, FNV-1a-32 hash,
 * `hash % nBuckets`, occurrence COUNT as the feature value (not a 0/1 presence bit, a repeated
 * trigram is a stronger signal). The SAME hash `Sketch` uses, so a witness's guard membership and
 * its GBM features are readings of the one fingerprint, not two.
 * @param {string} text The input text.
 * @param {number} nBuckets The feature-space bucket count.
 * @returns {number[]} A count vector of length `nBuckets`.
 */
export const featurize = (text, nBuckets) => {
    const counts = new Array(nBuckets).fill(0);
    const bytes = new TextEncoder().encode(String(text).toLowerCase());
    if (bytes.length >= 3) {
        for (let i = 0; i <= bytes.length - 3; i++) {
            const bucket = fnv1a32(bytes.slice(i, i + 3)) % nBuckets;
            counts[bucket] += 1.0;
        }
    }
    return counts;
};

/** One recorded observation: the request text and which of `nClasses` outcomes the reference
 * (an LLM call, a human reaction, whatever recorded it) resolved to. Binary tasks
 * (the identity resolver's same/different) are `nClasses == 2`. */
export class Witness {
    /**
     * @param {string} text The request/response text.
     * @param {number} klass The class id it resolved to.
     */
    constructor(text, klass) {
        this.text = text;
        this.class = klass;
    }
}

/**
 * Hyperparameters for both the featurizer and the GBM, the values this port declares once and
 * overridable, matching auto's "the contract declares the budgets/thresholds, the mechanism
 * doesn't bake them in" discipline.
 */
export class DistillConfig {
    /**
     * @param {object} [o] Overrides.
     * @param {number} [o.alphaMilli=100] Split-conformal guard alpha, in thousandths
     *   (auto's default `100` = alpha 0.1).
     * @param {number} [o.nBuckets=64] Hashed-trigram feature-space bucket count.
     * @param {number} [o.nBins=16] GBM quantile-bin count per feature.
     * @param {number} [o.maxDepth=3] GBM max tree depth.
     * @param {number} [o.nRounds=100] GBM boosting rounds.
     * @param {number} [o.learningRate=0.1] GBM learning rate.
     * @param {number} [o.holdoutFrac=0.0] Fraction of witnesses held back to measure
     *   generalization before accepting the distilled unit; `0.0` disables the check entirely.
     * @param {number} [o.minHoldoutAccuracy=0.0] The accuracy floor the holdout split must clear
     *   for `AutoUnit.distill` to succeed. Ignored when `holdoutFrac == 0.0`.
     */
    constructor(o = {}) {
        this.alphaMilli = o.alphaMilli ?? 100;
        this.nBuckets = o.nBuckets ?? 64;
        this.nBins = o.nBins ?? 16;
        this.maxDepth = o.maxDepth ?? 3;
        this.nRounds = o.nRounds ?? 100;
        this.learningRate = o.learningRate ?? 0.1;
        this.holdoutFrac = o.holdoutFrac ?? 0.0;
        this.minHoldoutAccuracy = o.minHoldoutAccuracy ?? 0.0;
    }
}

/** Why `AutoUnit.distill` refused to produce a unit, an honest refusal, not a worse artifact. */
export class DistillError extends Error {
    /**
     * @param {string} kind 'NoWitnesses' | 'FewerThanTwoClasses' | 'BelowAccuracyFloor'.
     * @param {object} [detail] `{measured, required, holdoutN}` for the floor refusal.
     */
    constructor(kind, detail = {}) {
        super(kind);
        this.kind = kind;
        this.measured = detail.measured;
        this.required = detail.required;
        this.holdoutN = detail.holdoutN;
    }
}

/**
 * Train one one-vs-rest GBM per class plus its shared quantile-bin edges, the one training
 * routine both the gate-check pass and the final full-data pass call, so they can never silently
 * diverge in method.
 * @param {Witness[]} witnesses The fit-set witnesses.
 * @param {number} nClasses The number of classes.
 * @param {DistillConfig} cfg The config.
 * @returns {{classifiers: GbmModel[], edges: number[][]}} One GBM per class + per-feature edges.
 */
const trainOneVsRest = (witnesses, nClasses, cfg) => {
    const feats = witnesses.map((w) => featurize(w.text, cfg.nBuckets));
    const n = feats.length;
    const cols = [];
    for (let j = 0; j < cfg.nBuckets; j++) {
        const col = [];
        for (let i = 0; i < n; i++) {
            col.push(feats[i][j]);
        }
        cols.push(col);
    }
    const edges = cols.map((c) => fitQuantileEdges(c, cfg.nBins));
    const bins = cols.map((c, j) => applyQuantileEdges(c, edges[j]));

    const classifiers = [];
    for (let c = 0; c < nClasses; c++) {
        const labels = witnesses.map((w) => (w.class === c ? 1.0 : 0.0));
        classifiers.push(trainGbm(bins, labels, cfg.nBins, 1.0, cfg.maxDepth, 1, cfg.nRounds, cfg.learningRate, Loss.Logistic));
    }
    return { classifiers, edges };
};

/**
 * Predict one text's class: featurize, bin against the shared edges, argmax over the one-vs-rest
 * GBMs' calibrated probabilities.
 * @param {GbmModel[]} classifiers One GBM per class.
 * @param {number[][]} edges Per-feature quantile edges.
 * @param {string} text The input text.
 * @param {number} nBuckets The bucket count.
 * @returns {[number, number]} `[argmaxClass, probability]`.
 */
const predictClass = (classifiers, edges, text, nBuckets) => {
    const feat = featurize(text, nBuckets);
    const rowBins = feat.map((v, j) => applyQuantileEdges([v], edges[j])[0]);
    let best = -1;
    let bestP = -Infinity;
    for (let c = 0; c < classifiers.length; c++) {
        const p = classifiers[c].predictProbaRow(rowBins);
        if (p > bestP) {
            bestP = p;
            best = c;
        }
    }
    return [best, bestP];
};

/**
 * A distilled unit: the calibrated guard plus one GBM per class (one-vs-rest), built from the
 * SAME witness set in one pass, the guard reads the witnesses' sketches, the classifiers read
 * their hashed-trigram features; neither is a fresh re-derivation of the other.
 */
export class AutoUnit {
    /**
     * @param {Guard} guard The calibrated guard.
     * @param {GbmModel[]} classifiers One GBM per class.
     * @param {number[][]} edges Per-feature quantile edges.
     * @param {number} nBuckets The bucket count.
     * @param {number|null} holdoutAccuracy The measured holdout accuracy, if a check ran.
     * @param {number|null} [holdoutN] How many held-out examples that accuracy rests on.
     */
    constructor(guard, classifiers, edges, nBuckets, holdoutAccuracy, holdoutN = null) {
        this.guard = guard;
        this.classifiers = classifiers;
        this.edges = edges;
        this.nBuckets = nBuckets;
        this.holdoutAccuracy = holdoutAccuracy;
        // The sample size the accuracy rests on, not just the accuracy. `DistillError` already
        // carries `holdoutN` on the refusal path; a unit that succeeded is no less entitled to say
        // how much evidence its number has behind it, and a caller weighing that number against a
        // prior (`contract.js` `earnedAccuracyFloor`) cannot do so without it.
        this.holdoutN = holdoutN;
    }

    /**
     * Distill a witness set under `cfg`. Fails closed per `DistillError` rather than ever
     * returning a unit whose measured generalization is worse than the caller declared
     * acceptable: auto's "holdout accuracy is provenance, never acceptance" made into an actual
     * gate on whether the value exists.
     * @param {Witness[]} witnesses The recorded observations.
     * @param {DistillConfig} cfg The config.
     * @returns {AutoUnit} The distilled unit.
     * @throws {DistillError} On `NoWitnesses`, `FewerThanTwoClasses`, or `BelowAccuracyFloor`.
     */
    static distill(witnesses, cfg) {
        if (witnesses.length === 0) {
            throw new DistillError('NoWitnesses');
        }
        let nClasses = 0;
        const seen = new Set();
        for (const w of witnesses) {
            if (w.class > nClasses) {
                nClasses = w.class;
            }
            seen.add(w.class);
        }
        nClasses += 1;
        if (seen.size < 2) {
            throw new DistillError('FewerThanTwoClasses');
        }

        let holdoutAccuracy = null;
        let holdoutN = null;
        if (cfg.holdoutFrac > 0.0) {
            const cut = Math.min(Math.max(Math.floor(witnesses.length * (1.0 - cfg.holdoutFrac)), 1), witnesses.length - 1);
            const fitSet = witnesses.slice(0, cut);
            const heldSet = witnesses.slice(cut);
            const { classifiers, edges } = trainOneVsRest(fitSet, nClasses, cfg);
            let correct = 0;
            for (const w of heldSet) {
                if (predictClass(classifiers, edges, w.text, cfg.nBuckets)[0] === w.class) {
                    correct += 1;
                }
            }
            const measured = correct / heldSet.length;
            if (measured < cfg.minHoldoutAccuracy) {
                throw new DistillError('BelowAccuracyFloor', {
                    measured,
                    required: cfg.minHoldoutAccuracy,
                    holdoutN: heldSet.length,
                });
            }
            holdoutAccuracy = measured;
            holdoutN = heldSet.length;
        }

        // The gate passed (or was skipped), train the deployed model on every witness.
        const sketches = witnesses.map((w) => Sketch.of(w.text));
        const guard = Guard.calibrate(sketches, cfg.alphaMilli);
        const { classifiers, edges } = trainOneVsRest(witnesses, nClasses, cfg);
        return new AutoUnit(guard, classifiers, edges, cfg.nBuckets, holdoutAccuracy, holdoutN);
    }

    /**
     * The request-time decision: admit-then-read, or trip-then-deopt, never a blend of both.
     * @param {string} text The input text.
     * @returns {{kind: 'Deopt'}|{kind: 'FastPath', class: number, proba: number}}
     */
    decide(text) {
        if (!this.guard.admits(Sketch.of(text))) {
            return { kind: 'Deopt' };
        }
        const [klass, proba] = predictClass(this.classifiers, this.edges, text, this.nBuckets);
        return { kind: 'FastPath', class: klass, proba };
    }

    /** @returns {Guard} The calibrated guard. */
    guard_value() {
        return this.guard;
    }

    /** @returns {number|null} The measured holdout accuracy, if a check ran. */
    holdout_accuracy() {
        return this.holdoutAccuracy;
    }

    /** @returns {number|null} How many held-out examples that accuracy rests on, if a check ran. */
    holdout_n() {
        return this.holdoutN;
    }

    /** @returns {number} The number of classes this unit discriminates. */
    n_classes() {
        return this.classifiers.length;
    }
}

// the self-test (mirrors auto/mod.rs §tests, runnable: import { self_test }).

/** The self-test's binary witness set (class 1 = refund, class 0 = tracking). */
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

/**
 * The distilled resolver's own verification, mirroring the Rust suite's lifecycle assertions.
 * @returns {string} An acknowledgement that every assertion held.
 */
export const self_test = () => {
    const unit = AutoUnit.distill(refundWitnesses(), new DistillConfig({ alphaMilli: 200 }));
    const refund = unit.decide('I need a refund for order 9981');
    if (refund.kind !== 'FastPath' || refund.class !== 1) {
        throw new Error('distill.js: near_refund_paraphrase_admits_and_predicts');
    }
    const track = unit.decide('please track my order 9981 for me');
    if (track.kind !== 'FastPath' || track.class !== 0) {
        throw new Error('distill.js: near_track_paraphrase_admits_and_predicts');
    }
    if (unit.decide('I forgot my password, please help me reset my account credentials').kind !== 'Deopt') {
        throw new Error('distill.js: genuinely_novel_request_trips_the_guard');
    }
    let kind = null;
    try {
        AutoUnit.distill([], new DistillConfig());
    } catch (e) {
        kind = e.kind;
    }
    if (kind !== 'NoWitnesses') {
        throw new Error('distill.js: empty_witness_set_refuses');
    }
    kind = null;
    try {
        AutoUnit.distill([new Witness('same thing', 0), new Witness('same again', 0)], new DistillConfig());
    } catch (e) {
        kind = e.kind;
    }
    if (kind !== 'FewerThanTwoClasses') {
        throw new Error('distill.js: single_class_witness_set_refuses');
    }
    kind = null;
    try {
        AutoUnit.distill(refundWitnesses(), new DistillConfig({ holdoutFrac: 0.5, minHoldoutAccuracy: 1.01 }));
    } catch (e) {
        kind = e.kind;
    }
    if (kind !== 'BelowAccuracyFloor') {
        throw new Error('distill.js: holdout_gate_refuses_when_floor_unreachable');
    }
    return 'distill.js: all lifecycle edge cases hold';
};
