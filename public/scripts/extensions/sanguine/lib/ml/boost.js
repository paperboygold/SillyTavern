// BOOST, the gradient-boosting leaf/split primitive as one `x = B/U` fold, ported from
// `modelfold/src/boost/mod.rs` (`boostfold`).
//
// Three independently-engineered libraries (XGBoost, LightGBM, CatBoost) each hand-derive the
// same closed form for a leaf's value: accumulate `(Σgrad, Σhess)` over the leaf's rows, then
// divide, `-Σgrad/(Σhess+λ)`: a Newton step on the per-leaf loss. That formula is not a
// tree-specific trick, it is the `d=e=1` weighted-ridge head at the constant feature. This
// module is that fold in JS: the `(Σgrad, Σhess)` ledger ([`LeafStat`]), a feature's per-bin
// ledgers ([`histogram`]), the greedy split scan ([`bestSplit`]), a full greedy tree
// ([`growTree`]), and the boosting rounds ([`trainGbm`]), on top of the shared `lib/hash.js`
// trinity rather than a hand-rolled accumulator array.
//
// Only the pieces SanguineTavern's identity resolver needs are ported: logistic-loss binary
// boosting over quantile-binned hashed-trigram features, and the tree forward pass. The GPU
// flatten/ensemble forms, L1 (`value_l1`) / missing-value routing, categorical target stats and
// the multiclass softmax ensemble are deliberately NOT carried over, they exist for the Rust
// crate's serving and bench surfaces, which this self-contained extension does not have.

import { insert_with } from '../hash.js';

/** The Accumulator (B/U) merge for a leaf ledger, componentwise `+`, the monoid's combine. */
const merge_leaf = (nu, old) => new LeafStat(nu.grad + old.grad, nu.hess + old.hess);

/**
 * The per-row/per-bin `(Σgrad, Σhess)` ledger, a leaf's accumulated first- and second-order
 * statistics. A commutative monoid: folding rows in any order lands the same ledger.
 */
export class LeafStat {
    /**
     * @param {number} grad The accumulated first-order gradient `Σgrad`.
     * @param {number} hess The accumulated second-order Hessian `Σhess`.
     */
    constructor(grad, hess) {
        this.grad = grad;
        this.hess = hess;
    }

    /** @returns {LeafStat} The identity ledger (0, 0). */
    static identity() {
        return new LeafStat(0.0, 0.0);
    }

    /** Combine two ledgers, the monoid's `+`. @param {LeafStat} other @returns {LeafStat} */
    add(other) {
        return new LeafStat(this.grad + other.grad, this.hess + other.hess);
    }

    /**
     * Exact removal, `(rest + flaw) - flaw = rest`. The `-` face: a sibling histogram derived
     * by subtraction instead of a rebuild.
     * @param {LeafStat} other The ledger to subtract.
     * @returns {LeafStat} This ledger minus `other`.
     */
    sub(other) {
        return new LeafStat(this.grad - other.grad, this.hess - other.hess);
    }

    /**
     * The Newton leaf value `-Σgrad/(Σhess+λ)`: the division every gradient-boosting engine
     * hand-derives (XGBoost `CalcWeight`, LightGBM `CalculateSplittedLeafOutput`, CatBoost
     * `SolveNewtonEquation`).
     * @param {number} lambda The ridge/L2 regularizer.
     * @returns {number} The closed-form leaf value.
     */
    value(lambda) {
        return -this.grad / (this.hess + lambda);
    }

    /**
     * The split gain `(Σgrad)²/(Σhess+λ)`: XGBoost's `CalcGain`: the loss reduction a leaf's
     * Newton step buys, before regularization's linear term.
     * @param {number} lambda The ridge/L2 regularizer.
     * @returns {number} The gain.
     */
    gain(lambda) {
        return (this.grad * this.grad) / (this.hess + lambda);
    }
}

/** Fold a stream of `(grad, hess)` rows into one leaf ledger, schedule-free. */
export const foldLeaf = (rows) => {
    let out = LeafStat.identity();
    for (const [grad, hess] of rows) {
        out = out.add(new LeafStat(grad, hess));
    }
    return out;
};

/**
 * Build a feature's histogram, one streaming pass, one accumulate per row, keyed by the row's
 * discretized bin id. The split-finder's inner loop in every boosting engine, on the shared
 * `Map` face of `lib/hash.js` (`merge_bu` = the counter, the Accumulator form).
 * @param {number[]} binIds Each row's bin id.
 * @param {number[]} grad Each row's gradient.
 * @param {number[]} hess Each row's Hessian.
 * @returns {Map<number, LeafStat>} Bin id -> ledger.
 */
export const histogram = (binIds, grad, hess) => {
    const t = new Map();
    for (let i = 0; i < binIds.length; i++) {
        insert_with(t, merge_leaf, binIds[i], new LeafStat(grad[i], hess[i]));
    }
    return t;
};

/**
 * Read a histogram out in bin order `0..numBins`, absent bins as the identity ledger, the dense
 * array a split scan needs, off the sparse map.
 * @param {Map<number, LeafStat>} hist The histogram.
 * @param {number} numBins The number of bins.
 * @returns {LeafStat[]} Ledger per bin, identity for absent bins.
 */
export const denseBins = (hist, numBins) => {
    const out = [];
    for (let b = 0; b < numBins; b++) {
        out.push(hist.get(b) ?? LeafStat.identity());
    }
    return out;
};

/**
 * Scan a feature's bins (already in split order) for the best single threshold, the greedy
 * split-finder every boosting engine runs, as one gain-maximizing fold over the cumulative
 * left/right ledgers. Returns `(bin index of the best left/right cut, gain over the unsplit
 * parent)`, or `null` if there are fewer than two bins.
 * @param {LeafStat[]} bins The per-bin ledgers.
 * @param {number} lambda The ridge/L2 regularizer.
 * @returns {[number, number]|null} `[cutBin, gain]` or null when unsplittable.
 */
export const bestSplit = (bins, lambda) => {
    if (bins.length < 2) {
        return null;
    }
    let total = LeafStat.identity();
    for (const b of bins) {
        total = total.add(b);
    }
    const parentGain = total.gain(lambda);
    let left = LeafStat.identity();
    let best = null;
    for (let i = 0; i < bins.length - 1; i++) {
        left = left.add(bins[i]);
        const right = total.sub(left);
        const gain = left.gain(lambda) + right.gain(lambda) - parentGain;
        if (best === null || gain > best[1]) {
            best = [i, gain];
        }
    }
    return best;
};

/**
 * A greedy regression tree, general (possibly asymmetric) shape. Inference (`predict`) is a
 * per-row forward pass with no separate "train" mechanism, the tree, once grown, IS the model.
 */
export class TreeNode {
    /**
     * @param {object} spec `{leaf: number}` or `{feature, bin, left, right}`.
     */
    constructor(spec) {
        this.leaf = spec.leaf ?? null;   // non-null => a leaf
        this.feature = spec.feature ?? -1; // split feature index
        this.bin = spec.bin ?? -1;         // split cut bin
        this.left = spec.left ?? null;     // left subtree
        this.right = spec.right ?? null;   // right subtree
    }

    /**
     * The forward pass for one row, walk from the root using the row's own already-binned
     * feature values (`rowBins[feature]`), return the leaf's value.
     * @param {number[]} rowBins The row's per-feature bin ids.
     * @returns {number} The leaf value this row lands in.
     */
    predict(rowBins) {
        let node = this;
        while (node.leaf === null) {
            node = rowBins[node.feature] <= node.bin ? node.left : node.right;
        }
        return node.leaf;
    }
}

/**
 * Grow one greedy regression tree to `maxDepth`: each node folds `bestSplit` over its own row
 * subset, partitions by the winner, and recurses left/right. The recursion bottoms out at a leaf
 * whose value is the Newton step.
 *
 * `featureBins[f][r]` is feature `f`'s bin id for row `r` (column-major, pre-binned).
 * @param {number[][]} featureBins Column-major per-feature bin ids.
 * @param {number[]} grad Each row's gradient.
 * @param {number[]} hess Each row's Hessian.
 * @param {number[]} rows The row indices in this node's partition.
 * @param {number} nBins The number of bins per feature.
 * @param {number} lambda The ridge/L2 regularizer.
 * @param {number} maxDepth Maximum tree depth.
 * @param {number} minRowsLeaf Minimum rows per leaf.
 * @returns {TreeNode} The grown tree.
 */
export const growTree = (featureBins, grad, hess, rows, nBins, lambda, maxDepth, minRowsLeaf) => {
    const stat = foldLeaf(rows.map((r) => [grad[r], hess[r]]));
    const leaf = () => new TreeNode({ leaf: stat.value(lambda) });

    if (maxDepth === 0 || rows.length < minRowsLeaf * 2) {
        return leaf();
    }
    // The per-node best feature: for each feature, its histogram over this node's rows, then the
    // best split, then the best over features.
    let best = null;
    for (let f = 0; f < featureBins.length; f++) {
        const cols = featureBins[f];
        const hist = histogram(rows.map((r) => cols[r]), rows.map((r) => grad[r]), rows.map((r) => hess[r]));
        const bins = denseBins(hist, nBins);
        const split = bestSplit(bins, lambda);
        if (split === null) {
            continue;
        }
        const [bin, gain] = split;
        if (best === null || gain > best[2]) {
            best = [f, bin, gain];
        }
    }
    if (best === null) {
        return leaf();
    }
    const [feature, bin, gain] = best;
    if (gain <= 0.0) {
        return leaf();
    }
    const leftRows = [];
    const rightRows = [];
    for (const r of rows) {
        if (featureBins[feature][r] <= bin) {
            leftRows.push(r);
        } else {
            rightRows.push(r);
        }
    }
    if (leftRows.length < minRowsLeaf || rightRows.length < minRowsLeaf) {
        return leaf();
    }
    const left = growTree(featureBins, grad, hess, leftRows, nBins, lambda, maxDepth - 1, minRowsLeaf);
    const right = growTree(featureBins, grad, hess, rightRows, nBins, lambda, maxDepth - 1, minRowsLeaf);
    return new TreeNode({ feature, bin, left, right });
};

// Quantile binning, raw f64 columns into discrete bin ids.

/** Coarse coordinate-histogram resolution for `fitQuantileEdges`'s CDF read-off. */
const COARSE_BUCKETS = 1 << 16;

/**
 * Fit quantile bin edges for one column, the boundaries `quantileBin` derives internally,
 * exposed so a caller can bin HELD-OUT data with the SAME edges training fit, via
 * `applyQuantileEdges`. Closed-form, no sort: `(min, max)` reduce, coarse coordinate histogram,
 * then the `nBins-1` quantile edges interpolated off that histogram's prefix-sum CDF.
 * @param {number[]} col The raw column values.
 * @param {number} nBins The number of bins.
 * @returns {number[]} The `nBins-1` quantile edges (empty for an all-NaN column).
 */
export const fitQuantileEdges = (col, nBins) => {
    let lo = Infinity;
    let hi = -Infinity;
    let nPresent = 0;
    for (const v of col) {
        if (Number.isNaN(v)) {
            continue;
        }
        nPresent += 1;
        if (v < lo) {
            lo = v;
        }
        if (v > hi) {
            hi = v;
        }
    }
    if (nPresent === 0) {
        return [];
    }
    const range = Math.max(hi - lo, Number.MIN_VALUE);
    const scale = COARSE_BUCKETS / range;
    const coord = (v) => Math.min(Math.floor((v - lo) * scale), COARSE_BUCKETS - 1);

    const counts = new Array(COARSE_BUCKETS).fill(0);
    for (const v of col) {
        if (!Number.isNaN(v)) {
            counts[coord(v)] += 1;
        }
    }

    const prefix = new Array(COARSE_BUCKETS + 1).fill(0);
    let cum = 0;
    for (let b = 0; b < COARSE_BUCKETS; b++) {
        cum += counts[b];
        prefix[b + 1] = cum;
    }
    const total = prefix[COARSE_BUCKETS];

    const edges = [];
    for (let i = 1; i < nBins; i++) {
        const target = (i * total) / nBins;
        // partition_point: first index where prefix > target, minus one.
        let b = 0;
        while (b < COARSE_BUCKETS && prefix[b] <= target) {
            b += 1;
        }
        b = Math.min(b - 1, COARSE_BUCKETS - 1);
        const bucketLo = lo + b / scale;
        const bucketWidth = 1.0 / scale;
        const within = counts[b] > 0 ? (target - prefix[b]) / counts[b] : 0.0;
        edges.push(bucketLo + within * bucketWidth);
    }
    return edges;
};

/**
 * Bin a column against previously-fit edges, the portable half: apply TRAIN-fit boundaries to
 * any data so it lands in the SAME bin coordinates a trained model's trees were grown against.
 * @param {number[]} col The raw column values.
 * @param {number[]} edges The fit quantile edges.
 * @returns {number[]} The bin id per value.
 */
export const applyQuantileEdges = (col, edges) => col.map((v) => {
    if (Number.isNaN(v)) {
        return 0; // NaN values: leave at bin 0 (this resolver never feeds missing features)
    }
    let b = 0;
    while (b < edges.length && edges[b] < v) {
        b += 1;
    }
    return b;
});

/** Bin one column, `fitQuantileEdges` then `applyQuantileEdges` against itself. */
export const quantileBin = (col, nBins) => applyQuantileEdges(col, fitQuantileEdges(col, nBins));

/** Bin every feature column (column-major) with the same per-column edges as `quantileBin`. */
export const binDataset = (columns, nBins) => columns.map((col) => quantileBin(col, nBins));

// The loss and the ensemble.

/**
 * The loss boosting minimizes, determines each round's `(grad, hess)` from `(pred, y)`, and how
 * a trained model's raw score becomes a prediction.
 */
export const Loss = {
    /** `grad = pred - y`, `hess = 1`: regression; usable but uncalibrated for 0/1 targets. */
    Squared: 'squared',
    /** `grad = sigmoid(pred) - y`, `hess = p(1-p)`: binomial deviance's Newton step. `pred` is
     * the LOGIT throughout; `predictProbaRow` applies the sigmoid once, at read time. */
    Logistic: 'logistic',
};

/** The round-0 constant prediction: the mean for squared error, the mean's LOG-ODDS for logistic. */
const baseScore = (y, loss) => {
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    if (loss === Loss.Squared) {
        return mean;
    }
    const p = Math.min(Math.max(mean, 1e-6), 1.0 - 1e-6);
    return Math.log(p / (1.0 - p));
};

/** One row's `(grad, hess)` at the current raw score `pred` against target `y`. */
const gradHess = (pred, y, loss) => {
    if (loss === Loss.Squared) {
        return [pred - y, 1.0];
    }
    const p = 1.0 / (1.0 + Math.exp(-pred));
    return [p - y, Math.max(p * (1.0 - p), 1e-6)];
};

/**
 * A trained gradient-boosted ensemble, `baseScore` plus `learningRate`-scaled trees. This IS
 * the model: no separate weights tensor, the trees themselves are the seed.
 */
export class GbmModel {
    /**
     * @param {TreeNode[]} trees The grown trees, in boosting order.
     * @param {number} learningRate The shrinkage applied to every tree's contribution.
     * @param {number} baseScore The initial constant prediction.
     * @param {string} loss The `Loss` this model was trained under.
     */
    constructor(trees, learningRate, baseScore, loss) {
        this.trees = trees;
        this.learningRate = learningRate;
        this.baseScore = baseScore;
        this.loss = loss;
    }

    /**
     * The forward pass for one row: `baseScore + learningRate * Σ tree.predict(row)`. The RAW
     * SCORE: under `Loss.Logistic` that is the logit, not a probability, use `predictProbaRow`.
     * @param {number[]} rowBins The row's per-feature bin ids.
     * @returns {number} The raw score.
     */
    predictRow(rowBins) {
        let sum = 0;
        for (const t of this.trees) {
            sum += t.predict(rowBins);
        }
        return this.baseScore + this.learningRate * sum;
    }

    /**
     * The calibrated `[0,1]` prediction, `predictRow` unchanged under `Loss.Squared`, sigmoid'd
     * under `Loss.Logistic`.
     * @param {number[]} rowBins The row's per-feature bin ids.
     * @returns {number} A probability in `[0, 1]`.
     */
    predictProbaRow(rowBins) {
        const s = this.predictRow(rowBins);
        if (this.loss === Loss.Squared) {
            return s;
        }
        return 1.0 / (1.0 + Math.exp(-s));
    }
}

/**
 * Train a gradient-boosted ensemble under the given `loss`: `nRounds` trees, each fit to the
 * current round's `(grad, hess)`: the state-evolution recursion `preds_t = U(preds_{t-1})`,
 * where `U` fits a fresh tree to the current residual and adds its scaled forward pass.
 * @param {number[][]} featureBins Column-major per-feature bin ids.
 * @param {number[]} y The targets (0/1 under logistic).
 * @param {number} nBins The number of bins per feature.
 * @param {number} lambda The ridge/L2 regularizer.
 * @param {number} maxDepth Maximum tree depth.
 * @param {number} minRowsLeaf Minimum rows per leaf.
 * @param {number} nRounds The number of boosting rounds.
 * @param {number} learningRate The shrinkage.
 * @param {string} loss The `Loss`.
 * @returns {GbmModel} The trained ensemble.
 */
export const trainGbm = (featureBins, y, nBins, lambda, maxDepth, minRowsLeaf, nRounds, learningRate, loss) => {
    const nRows = y.length;
    const b0 = baseScore(y, loss);
    let preds = new Array(nRows).fill(b0);
    const trees = [];
    const allRows = [];
    for (let r = 0; r < nRows; r++) {
        allRows.push(r);
    }
    for (let round = 0; round < nRounds; round++) {
        const grad = new Array(nRows);
        const hess = new Array(nRows);
        for (let r = 0; r < nRows; r++) {
            const [g, h] = gradHess(preds[r], y[r], loss);
            grad[r] = g;
            hess[r] = h;
        }
        const tree = growTree(featureBins, grad, hess, allRows, nBins, lambda, maxDepth, minRowsLeaf);
        trees.push(tree);
        const next = new Array(nRows);
        for (let r = 0; r < nRows; r++) {
            const rowBins = featureBins.map((col) => col[r]);
            next[r] = preds[r] + learningRate * tree.predict(rowBins);
        }
        preds = next;
    }
    return new GbmModel(trees, learningRate, b0, loss);
}

// the self-test (mirrors boost/mod.rs §tests, runnable: import { self_test }).

/**
 * The boosting fold's own verification, mirroring the Rust suite's pinned closed forms.
 * @returns {string} An acknowledgement that every assertion held.
 */
export const self_test = () => {
    const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;
    const stat = foldLeaf([[1.0, 2.0], [-0.5, 1.0], [3.0, 0.5]]);
    if (stat.grad !== 1.0 - 0.5 + 3.0 || stat.hess !== 2.0 + 1.0 + 0.5) {
        throw new Error('boost.js: sanguine_matches_direct_sum');
    }
    const newton = foldLeaf([[-3.0, 1.0]]);
    if (!near(newton.value(1.0), 1.5)) {
        throw new Error('boost.js: leaf_value_is_the_newton_step');
    }
    const bins = [
        new LeafStat(-4.0, 2.0),
        new LeafStat(-3.0, 2.0),
        new LeafStat(4.0, 2.0),
        new LeafStat(3.0, 2.0),
    ];
    const [splitAt, gain] = bestSplit(bins, 1.0);
    if (splitAt !== 1 || !(gain > 0.0)) {
        throw new Error('boost.js: best_split_finds_the_separable_cut');
    }
    const tree = growTree([[0, 0, 1, 1], [0, 0, 0, 0]], [-4.0, -3.0, 4.0, 3.0], [2.0, 2.0, 2.0, 2.0], [0, 1, 2, 3], 2, 1.0, 4, 1);
    if (tree.leaf !== null && tree.feature !== 0 && tree.bin !== 0) {
        throw new Error('boost.js: grow_tree_finds_the_separable_split');
    }
    const featureBins = [[0, 0, 0, 0, 1, 1, 1, 1]];
    const y = [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
    const model = trainGbm(featureBins, y, 2, 1.0, 3, 1, 20, 0.3, Loss.Logistic);
    for (let r = 0; r < y.length; r++) {
        const rowBins = featureBins.map((col) => col[r]);
        const p = model.predictProbaRow(rowBins);
        if (p < 0.0 || p > 1.0 || (p >= 0.5 ? 1.0 : 0.0) !== y[r]) {
            throw new Error('boost.js: logistic_boosting_separates_and_calibrates');
        }
    }
    const constant = quantileBin([3.0, 3.0, 3.0, 3.0], 4);
    if (!constant.every((b) => b === 0)) {
        throw new Error('boost.js: quantile_bin_handles_constant_columns');
    }
    return 'boost.js: all closed forms hold';
};;
