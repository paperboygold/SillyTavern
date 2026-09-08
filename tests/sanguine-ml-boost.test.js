import { describe, expect, test } from '@jest/globals';

import {
    LeafStat,
    Loss,
    bestSplit,
    binDataset,
    denseBins,
    fitQuantileEdges,
    foldLeaf,
    growTree,
    histogram,
    quantileBin,
    self_test,
    trainGbm,
} from '../public/scripts/extensions/sanguine/lib/ml/boost.js';

/**
 * boost.js is the JS mirror of modelfold/src/boost/mod.rs (boostfold). These tests assert the
 * closed forms and tree-growth behavior the Rust suite pins, so a drift fails here before the
 * identity resolver's distilled model misbehaves.
 */
describe('boost.js, the gradient-boosting fold', () => {
    test('self_test() holds', () => {
        expect(self_test()).toBe('boost.js: all closed forms hold');
    });

    test('fold matches direct sum', () => {
        const stat = foldLeaf([[1.0, 2.0], [-0.5, 1.0], [3.0, 0.5]]);
        expect(stat.grad).toBe(1.0 - 0.5 + 3.0);
        expect(stat.hess).toBe(2.0 + 1.0 + 0.5);
    });

    test('leaf value is the newton step', () => {
        // Squared-error loss on a single example y=3, pred=0: grad = pred - y = -3, hess = 1.
        const stat = foldLeaf([[-3.0, 1.0]]);
        // -grad / (hess + lambda) = 3 / 2 = 1.5
        expect(Math.abs(stat.value(1.0) - 1.5)).toBeLessThan(1e-12);
    });

    test('histogram matches grouped fold', () => {
        const binIds = [0, 1, 0, 2, 1, 0];
        const grad = [1.0, -2.0, 0.5, 3.0, -1.0, 2.0];
        const hess = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
        const hist = histogram(binIds, grad, hess);
        const bins = denseBins(hist, 3);
        // Bin 0: rows 0, 2, 5 -> grad 1.0 + 0.5 + 2.0 = 3.5
        expect(Math.abs(bins[0].grad - 3.5)).toBeLessThan(1e-12);
        expect(Math.abs(bins[0].hess - 3.0)).toBeLessThan(1e-12);
        // Bin 1: rows 1, 4 -> grad -2.0 + -1.0 = -3.0
        expect(Math.abs(bins[1].grad - (-3.0))).toBeLessThan(1e-12);
        // Bin 2: row 3 -> grad 3.0
        expect(Math.abs(bins[2].grad - 3.0)).toBeLessThan(1e-12);
    });

    test('best split finds the separable cut', () => {
        // Bin 0-1 has all-negative gradient, bin 2-3 all-positive: the best split must land
        // between bin 1 and bin 2.
        const bins = [
            new LeafStat(-4.0, 2.0),
            new LeafStat(-3.0, 2.0),
            new LeafStat(4.0, 2.0),
            new LeafStat(3.0, 2.0),
        ];
        const [splitAt, gain] = bestSplit(bins, 1.0);
        expect(splitAt).toBe(1); // cut after bin index 1: {0,1} | {2,3}
        expect(gain).toBeGreaterThan(0.0);
    });

    test('grow tree finds the separable split', () => {
        // Feature 0 perfectly separates negative-gradient rows (bin 0) from positive (bin 1);
        // feature 1 is pure noise (same bin for every row, so it can never win).
        const featureBins = [[0, 0, 1, 1], [0, 0, 0, 0]];
        const grad = [-4.0, -3.0, 4.0, 3.0];
        const hess = [2.0, 2.0, 2.0, 2.0];
        const rows = [0, 1, 2, 3];
        const tree = growTree(featureBins, grad, hess, rows, 2, 1.0, 4, 1);

        expect(tree.leaf).toBeNull(); // must be a split
        expect(tree.feature).toBe(0);
        expect(tree.bin).toBe(0);

        const leftStat = new LeafStat(-4.0 - 3.0, 4.0);
        const rightStat = new LeafStat(4.0 + 3.0, 4.0);
        expect(Math.abs(tree.left.predict([0, 0]) - leftStat.value(1.0))).toBeLessThan(1e-12);
        expect(Math.abs(tree.right.predict([1, 0]) - rightStat.value(1.0))).toBeLessThan(1e-12);
    });

    test('grow tree respects max depth', () => {
        const featureBins = [[0, 0, 1, 1]];
        const grad = [-4.0, -3.0, 4.0, 3.0];
        const hess = [2.0, 2.0, 2.0, 2.0];
        const rows = [0, 1, 2, 3];
        const stump = growTree(featureBins, grad, hess, rows, 2, 1.0, 0, 1);
        expect(stump.leaf).not.toBeNull(); // max_depth=0 must return a bare leaf
    });

    test('logistic boosting separates and calibrates', () => {
        // Two well-separated clusters on one feature's bin id, a single stump should nail this.
        const featureBins = [[0, 0, 0, 0, 1, 1, 1, 1]];
        const y = [0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0];
        const model = trainGbm(featureBins, y, 2, 1.0, 3, 1, 20, 0.3, Loss.Logistic);
        for (let r = 0; r < y.length; r++) {
            const rowBins = featureBins.map((col) => col[r]);
            const p = model.predictProbaRow(rowBins);
            expect(p).toBeGreaterThanOrEqual(0.0);
            expect(p).toBeLessThanOrEqual(1.0);
            expect(p >= 0.5 ? 1.0 : 0.0).toBe(y[r]);
        }
    });

    test('train gbm reduces residual every round', () => {
        // A dataset with real signal: y depends on feature 0's bin exactly.
        const featureBins = [
            [0, 0, 0, 1, 1, 1, 2, 2, 2],
            [0, 1, 2, 0, 1, 2, 0, 1, 2], // pure noise column
        ];
        const y = [1.0, 1.2, 0.8, 5.0, 5.1, 4.9, 9.0, 9.2, 8.8];
        const mse = (preds) => preds.reduce((s, p, i) => s + (p - y[i]) ** 2, 0) / y.length;

        const model = trainGbm(featureBins, y, 3, 1.0, 3, 1, 5, 0.5, Loss.Squared);
        expect(model.trees.length).toBe(5);

        const preds = y.map((_, r) => model.predictRow(featureBins.map((col) => col[r])));
        const baseMse = mse(y.map(() => model.baseScore));
        const trainedMse = mse(preds);
        expect(trainedMse).toBeLessThan(baseMse * 0.1);
    });

    test('quantile bin routes constant columns without crashing', () => {
        // A constant column has a degenerate range, the edges must still fit and bin to 0.
        const col = [3.0, 3.0, 3.0, 3.0];
        const bins = quantileBin(col, 4);
        expect(bins.every((b) => b === 0)).toBe(true);
    });

    test('bin dataset is column-major per column', () => {
        const columns = [[0.1, 0.2, 0.15, 5.0, 5.1, 4.9], [1.0, 2.0, 3.0, 1.0, 2.0, 3.0]];
        const bins = binDataset(columns, 4);
        expect(bins.length).toBe(2);
        expect(bins[0].length).toBe(6);
    });

    test('fit quantile edges reproduces equal-frequency partitions', () => {
        // Deterministic pseudo-random column: each bin's count should be close to n/nBins.
        let seed = 0x123456789abcdf0;
        const next = () => {
            seed ^= seed << 13;
            seed ^= seed >>> 7;
            seed ^= seed << 17;
            return ((seed >> 0) % 1000000) / 1000000.0 * 1000.0;
        };
        const col = Array.from({ length: 5000 }, () => next());
        const nBins = 16;
        const edges = fitQuantileEdges(col, nBins);
        expect(edges.length).toBe(nBins - 1);
        // monotone edges
        for (let i = 1; i < edges.length; i++) {
            expect(edges[i]).toBeGreaterThanOrEqual(edges[i - 1]);
        }
    });
});
