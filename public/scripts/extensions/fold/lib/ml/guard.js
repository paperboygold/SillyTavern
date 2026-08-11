// GUARD — the split-conformal admission guard, ported from `modelfold/src/guard/mod.rs`
// (itself a re-standing of RightNow-AI/auto ADR-0007 → ADR-0014, `arxiv.org/abs/2607.04542`).
//
// SanguineTavern's fold is self-contained: the JS mirror of the fold workspace's `guardfold`,
// exactly as `lib/hash.js` mirrors HashTrinity.lean. The job this exists for is the identity
// resolver's THIRD step — decide, per new input, whether the distilled fast path is trustworthy
// or the request should fall back to the LLM. It is a **distribution-free, exchangeability-
// conditional coverage test, not a learned classifier** — a gradient-boosted model's output is a
// probability, not a nonconformity score, so `calibrate` wraps the DISTANCE itself (Jaccard over
// a trigram-hash sketch) rather than any model's confidence, keeping the coverage guarantee
// intact regardless of what decides the fast path underneath.
//
// ## The exact calibration rule (auto ADR-0014, split-conformal prediction)
//
// 1. **Nonconformity score** for witness `i` = its *leave-one-out* Jaccard distance to its
//    nearest OTHER witness (never itself).
// 2. **Threshold** = the k-th smallest such score, `k = ceil((n+1)(1-alpha))` — the standard
//    split-conformal quantile with the finite-sample `(n+1)` correction (Angelopoulos & Bates,
//    arXiv:2107.07511). Two pinned edge cases: `n == 1` → threshold `0.0` (maximally
//    conservative — only an exact match is admitted); `k > n` (too few witnesses for the
//    requested α) → truncate to the MAXIMUM leave-one-out score, never "admit everything".
// 3. **Decision**: `distance(new_input, nearest_witness) <= threshold` → admit (run the fast
//    path); else → trip (deopt to the fallback).
//
// The guarantee this buys, stated precisely (not oversold): *if* a future input is exchangeable
// with the witnesses, it is admitted with probability >= `1 - alpha`. This is **not** an
// out-of-distribution detector — there is no coverage bound for OOD traffic, and none is
// claimed. Tripping is always the safe direction (one deopt, never a wrong fast-path answer).

/**
 * FNV-1a-32, the one hash the sketch runs on — public so a companion featurizer (the distilled
 * model's hashed-trigram-bucket features) hashes trigrams the SAME way the guard does, rather
 * than defining its own hash for the same primitive. `>>> 0` keeps the 32-bit unsigned state;
 * the multiply wraps mod 2^32 exactly as Rust's `wrapping_mul`.
 * @param {number[]|Uint8Array} bytes The bytes to hash.
 * @returns {number} A 32-bit unsigned FNV-1a hash.
 */
export const fnv1a32 = (bytes) => {
    let h = 0x811c_9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x0100_0193) >>> 0;
    }
    return h >>> 0;
};

/** Encode a JS string's UTF-8 bytes (the sketch is over UTF-8 bytes, like Rust's `as_bytes`). */
const utf8 = (text) => new TextEncoder().encode(text);

/**
 * A text's fingerprint: the sorted, deduplicated set of its lowercase char-trigram FNV-1a-32
 * hashes — a set, not a hashed/bucketed count vector (that variant is the featurizer's, in
 * `distill.js`). A sorted Array rather than a Set: a merge over two sorted lists computes
 * Jaccard intersection/union without needing a set at all.
 */
export class Sketch {
    /** @param {number[]} hashes Sorted, deduplicated trigram hashes. */
    constructor(hashes) {
        this.hashes = hashes;
    }

    /**
     * Fingerprint one text: lowercase, slide a 3-byte window, hash each trigram, sort+dedup.
     * @param {string} text The text to fingerprint.
     * @returns {Sketch} The sorted, deduplicated trigram-hash set.
     */
    static of(text) {
        const bytes = utf8(String(text).toLowerCase());
        const hashes = [];
        if (bytes.length >= 3) {
            for (let i = 0; i <= bytes.length - 3; i++) {
                hashes.push(fnv1a32(bytes.slice(i, i + 3)));
            }
        }
        hashes.sort((a, b) => a - b);
        return new Sketch([...new Set(hashes)]);
    }

    /** @returns {boolean} True when this sketch has no trigrams (text under 3 bytes). */
    is_empty() {
        return this.hashes.length === 0;
    }
}

/**
 * Jaccard distance `1 - |A∩B|/|A∪B|` via a merge over the two sorted trigram-hash lists —
 * O(|A|+|B|), no hash set needed. Pinned edge cases (auto's own): both empty -> `0.0`
 * (identical-nothing); exactly one empty -> `1.0` (maximally distant).
 * @param {Sketch} a One fingerprint.
 * @param {Sketch} b Another.
 * @returns {number} The Jaccard distance in `[0, 1]`.
 */
export const jaccardDistance = (a, b) => {
    if (a.is_empty() && b.is_empty()) {
        return 0.0;
    }
    if (a.is_empty() !== b.is_empty()) {
        return 1.0;
    }
    const xs = a.hashes;
    const ys = b.hashes;
    let i = 0;
    let j = 0;
    let inter = 0;
    let uni = 0;
    while (i < xs.length && j < ys.length) {
        if (xs[i] === ys[j]) {
            inter += 1;
            uni += 1;
            i += 1;
            j += 1;
        } else if (xs[i] < ys[j]) {
            uni += 1;
            i += 1;
        } else {
            uni += 1;
            j += 1;
        }
    }
    uni += (xs.length - i) + (ys.length - j);
    return 1.0 - (inter / uni);
};

/** Nearest-witness distance: `min` over every witness's Jaccard distance to `input`. */
const nearestDistance = (witnesses, input) => {
    let best = Infinity;
    for (const w of witnesses) {
        const d = jaccardDistance(input, w);
        if (d < best) {
            best = d;
        }
    }
    return best;
};

/**
 * A calibrated split-conformal guard: a witness set plus the one scalar threshold their
 * leave-one-out distances imply at the declared `alpha`.
 */
export class Guard {
    /**
     * @param {Sketch[]} witnesses The witness sketches.
     * @param {number} threshold The calibrated admission threshold.
     * @param {number} alphaMilli α in thousandths (e.g. `100` = α = 0.1, auto's default).
     */
    constructor(witnesses, threshold, alphaMilli) {
        this.witnesses = witnesses;
        this.threshold = threshold;
        this.alphaMilli = alphaMilli;
    }

    /**
     * Calibrate from a witness set at `alphaMilli` (α in thousandths, e.g. `100` = α = 0.1) —
     * the exact rule in this module's own doc comment. `n == 0` yields an always-tripping guard
     * (no witnesses, no coverage claim is possible).
     * @param {Sketch[]} witnesses The witness sketches.
     * @param {number} alphaMilli α in thousandths.
     * @returns {Guard} The calibrated guard.
     */
    static calibrate(witnesses, alphaMilli) {
        const n = witnesses.length;
        if (n <= 1) {
            return new Guard(witnesses, 0.0, alphaMilli);
        }
        const scores = witnesses.map((w, i) => {
            let best = Infinity;
            for (let j = 0; j < n; j++) {
                if (j === i) {
                    continue;
                }
                const d = jaccardDistance(w, witnesses[j]);
                if (d < best) {
                    best = d;
                }
            }
            return best;
        });
        scores.sort((a, b) => a - b);

        const alpha = alphaMilli / 1000.0;
        let k = Math.ceil((n + 1) * (1.0 - alpha));
        let threshold;
        if (k === 0) {
            threshold = 0.0;
        } else if (k > n) {
            threshold = scores[scores.length - 1]; // truncate to max LOO score
        } else {
            threshold = scores[k - 1]; // k-th smallest, 1-indexed
        }
        return new Guard(witnesses, Math.min(Math.max(threshold, 0.0), 1.0), alphaMilli);
    }

    /**
     * The admission decision: nearest-witness distance `<=` threshold. Fails closed (no
     * witnesses -> never admits, since no coverage claim exists without at least one).
     * @param {Sketch} input The new input's sketch.
     * @returns {boolean} True when the guard admits the input to the fast path.
     */
    admits(input) {
        if (this.witnesses.length === 0) {
            return false;
        }
        return nearestDistance(this.witnesses, input) <= this.threshold;
    }

    /** @returns {number} The calibrated threshold. */
    threshold_value() {
        return this.threshold;
    }

    /** @returns {number} The α in thousandths. */
    alpha_milli() {
        return this.alphaMilli;
    }

    /** @returns {number} The number of witness sketches. */
    witness_count() {
        return this.witnesses.length;
    }
}

// ───────── the self-test (mirrors guard/mod.rs §tests, runnable: import { self_test }) ─────────

/**
 * The guard's own verification, mirroring the Rust suite's pinned edge cases.
 * @returns {string} An acknowledgement that every assertion held.
 */
export const self_test = () => {
    const near = (a, b, eps = 1e-12) => Math.abs(a - b) < eps;
    if (jaccardDistance(Sketch.of('the quick brown fox'), Sketch.of('the quick brown fox')) !== 0.0) {
        throw new Error('guard.js: identical_sketches_have_zero_distance');
    }
    if (jaccardDistance(Sketch.of(''), Sketch.of('ab')) !== 0.0) {
        throw new Error('guard.js: both_empty_is_zero');
    }
    if (jaccardDistance(Sketch.of(''), Sketch.of('the quick brown fox')) !== 1.0) {
        throw new Error('guard.js: one_empty_is_one');
    }
    if (!(jaccardDistance(Sketch.of('aaaaaaaaaa'), Sketch.of('the quick brown fox jumps over the lazy dog')) > 0.9)) {
        throw new Error('guard.js: completely_disjoint_text_is_near_distance_one');
    }
    const w = Sketch.of('get user profile by id');
    const single = Guard.calibrate([w], 100);
    if (single.threshold_value() !== 0.0 || !single.admits(w) || single.admits(Sketch.of('completely different request text'))) {
        throw new Error('guard.js: single_witness_threshold_is_zero_and_only_exact_match_admits');
    }
    if (Guard.calibrate([], 100).admits(Sketch.of('anything'))) {
        throw new Error('guard.js: no_witnesses_never_admits');
    }
    const cluster = Guard.calibrate([
        Sketch.of('get the user profile for id 42'),
        Sketch.of('get the user profile for id 17'),
        Sketch.of('get the user profile for id 9001'),
        Sketch.of('fetch the user profile for id 3'),
        Sketch.of('get the user profile for id 256'),
    ], 100);
    if (!cluster.admits(Sketch.of('get the user profile for id 77'))) {
        throw new Error('guard.js: tight_cluster_admits_near_paraphrase');
    }
    if (cluster.admits(Sketch.of('delete the payment record for order 555'))) {
        throw new Error('guard.js: tight_cluster_rejects_other_family');
    }
    const pair = [Sketch.of('alpha one two three'), Sketch.of('beta four five six')];
    const truncated = Guard.calibrate(pair.slice(), 1);
    if (!near(truncated.threshold_value(), jaccardDistance(pair[0], pair[1]))) {
        throw new Error('guard.js: k_greater_than_n_truncates_to_max_loo');
    }
    return 'guard.js: all admission edge cases hold';
};
