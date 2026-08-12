/**
 * fold/invariant-table.js — what the ledger can prove wrong about itself, with no ground truth.
 *
 * Pure, like every `-table.js`: a fold over derived state, no storage and no app graph, so it is
 * unit-testable and replayable.
 *
 * ── Why this exists ──
 *
 * Fidelity over a year-long campaign cannot be checked by comparing the ledger against the truth,
 * because nobody has the truth written down. It CAN be checked against itself. A negative quantity
 * of a physical object is impossible. One currency occupying two rows is a keying fault, not a
 * fact about the world. A `different` verdict inside a component the `same` verdicts already
 * merged is a contradiction. None of these need a label, a model call, or a human.
 *
 * Measured over the live chats the day this was written, by running this module over them:
 *
 *   Time Stop          PROVEN     silver −11, silver moon locket −1
 *   Solo Leveling      PROVEN     painkillers −1
 *   Wuxia              suspected  carried `silver wen` 21 against money `silver` 76
 *   Isekai (67 msgs)   suspected  money `copper coins` 14 against money `copper` 0
 *
 * Four of nine campaigns, and the Isekai one appeared inside 67 messages — this is not a
 * long-campaign problem that can be deferred.
 *
 * A hand-rolled version of this check reported `marks −8500` for Royal Succession, and that was an
 * artifact of summing `dq` while ignoring `set`: an absolute restatement is not a change. This
 * module applies both and Royal Succession is clean. Recorded because the wrong number was said out
 * loud before the right one.
 *
 * ── The second job: violations are WITNESSES ──
 *
 * `lib/ml/` exists to take over identity resolution by test-time training — the `Ratchet`
 * recompiles an `AutoUnit` as witnesses accumulate, and the witnesses have always been LLM answers
 * to `[same?]`, which cost a question slot each and arrive at roughly three per thousand messages.
 * That is why the corpus is 76 pairs after a week of play.
 *
 * A split-currency violation is a witness the SYSTEM produced. Two money rows whose names share a
 * token are either one currency (a `same` label) or a genuine pair the story keeps apart (a
 * `different` label), and the conservation check flags the pair for free, during play, without an
 * LLM call and without a question slot. The invariant checker is therefore both the correctness
 * gate and the label source the learner was always short of.
 *
 * `witnesses` is deliberately separate from `violations` and never decides: a flagged pair is a
 * QUESTION, exactly as `nearIdentity` raises one. Fold does not merge on a token overlap. RULE 1's
 * STRUCTURE clause is what licenses the grouping — token algebra on fold's own keys, no morphology
 * and no word list — and the answer stays the model's.
 */

import { CARRIED, MONEY, splitItemKey } from './state-table.js';

/** Split a key's name into tokens. Language-neutral: every non-alphanumeric is a separator, and
 * the class spans U+00C0–U+FFFF so Han, Hangul and Cyrillic are token characters, not gaps. */
const tokens = (name) => new Set(String(name ?? '').toLowerCase().split(/[^0-9a-zÀ-￿]+/i).filter(Boolean));

/**
 * Quantities that have gone below zero.
 *
 * A ledger that is a fold over signed deltas can go negative two ways, and both are defects: a
 * debit was double-counted, or a debit was keyed to a row that never held the credit. Time Stop's
 * `silver −11` is the second — the spends landed on `money␀silver` while the credits landed on
 * `carried␀silver wen`.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory, keyed by `itemKey`.
 * @returns {Array<{kind: string, key: string, place: string, name: string, qty: number}>} Violations.
 */
export function negativeQuantities(inv) {
    const out = [];
    for (const [key, row] of inv ?? []) {
        const qty = Number(row?.qty);
        if (Number.isFinite(qty) && qty < 0) {
            const { place, name } = splitItemKey(key);
            out.push({ kind: 'negative-quantity', key, place, name, qty });
        }
    }
    return out;
}

/**
 * One currency occupying more than one row.
 *
 * SUSPECTED, never proven, and the measurement says why. Of the five splits this raises on the live
 * chats, Wuxia's (`carried silver wen` against `money silver`) is a real one currency in two rows,
 * and three of Time Stop's are not — a silver ring and a silver moon locket sharing the token with
 * the balance. `{silver} ⊂ {silver, wen}` and `{silver} ⊂ {silver, moon, locket}` are the same
 * relation, so no language-neutral rule tells a denomination from an object made of the metal, and
 * fold must not guess. It raises the pair; the model answers.
 *
 * The false positives are the point rather than a cost: a suspected split answered `different` is a
 * `different` LABEL, which is the class the corpus has three of in seventy-six, and it was raised
 * without spending a question slot on a pair nobody had thought to ask about.
 *
 * Grouping is by shared token, not by similarity: no threshold, no embedding, no distance. That
 * matters beyond RULE 1 — `LeverClassification.defining_metric_is_the_ceiling` (sanguine) says a
 * metric cannot be validated against a label it defines, and iText2KG's published answer to this
 * exact problem (cosine similarity at a hand-set 0.7) inherits that. A token overlap is a
 * structural fact about fold's own keys and decides nothing.
 *
 * @param {Map<string, {qty?: number}>} inv Derived inventory.
 * @returns {Array<{kind: string, token: string, rows: Array<{key: string, place: string, name: string, qty: number}>}>} Violations.
 */
export function splitCurrency(inv) {
    const byToken = new Map();
    for (const [key, row] of inv ?? []) {
        const { place, name } = splitItemKey(key);
        if (place !== MONEY && place !== CARRIED) {
            continue;
        }
        for (const token of tokens(name)) {
            if (!byToken.has(token)) {
                byToken.set(token, []);
            }
            byToken.get(token).push({ key, place, name, qty: Number(row?.qty) || 0 });
        }
    }
    const out = [];
    for (const [token, rows] of byToken) {
        // A split needs two DISTINCT rows, and at least one of them at `money` — two carried items
        // sharing a word ("silver ring", "silver moon locket") are two objects, not one balance.
        const distinct = [...new Map(rows.map(r => [r.key, r])).values()];
        if (distinct.length > 1 && distinct.some(r => r.place === MONEY)) {
            out.push({ kind: 'split-currency', token, rows: distinct });
        }
    }
    return out;
}

/**
 * A `different` verdict inside a component the `same` verdicts merged.
 *
 * Identity is an equivalence relation, so `same` is transitive: union the `same` edges and any
 * `different` edge landing inside one component is a contradiction the model cannot have meant.
 * Measured across seven campaigns and 76 verdicts this count is ZERO, which is what licenses
 * treating the transitive closure as fact — 63 asked edges imply 73 pairs, so ten labels come from
 * algebra. If it ever goes non-zero the closure stops being free and this says so.
 *
 * @param {Map<string, {answer?: string}>|Iterable<[string, {answer?: string}]>} answers
 *   Persisted identity answers, keyed by `pairKey`.
 * @param {string} pairSep The separator `pairKey` joins on.
 * @returns {Array<{kind: string, a: string, b: string}>} Violations.
 */
export function partitionContradictions(answers, pairSep = String.fromCharCode(1)) {
    const parent = new Map();
    const find = (x) => {
        if (!parent.has(x)) {
            parent.set(x, x);
        }
        while (parent.get(x) !== x) {
            parent.set(x, parent.get(parent.get(x)));
            x = parent.get(x);
        }
        return x;
    };
    const pairs = [];
    for (const [key, value] of answers ?? []) {
        const [a, b] = String(key).split(pairSep);
        if (!a || !b) {
            continue;
        }
        pairs.push({ a, b, answer: value?.answer });
        if (value?.answer === 'same') {
            const [ra, rb] = [find(a), find(b)];
            if (ra !== rb) {
                parent.set(ra, rb);
            }
        }
    }
    return pairs
        .filter(pair => pair.answer === 'different' && find(pair.a) === find(pair.b))
        .map(pair => ({ kind: 'partition-contradiction', a: pair.a, b: pair.b }));
}

/**
 * Every invariant, and the witnesses the violations imply.
 *
 * @param {object} params Parameters.
 * @param {Map<string, {qty?: number}>} params.inv Derived inventory.
 * @param {Map<string, {answer?: string}>|Iterable} [params.answers] Persisted identity answers.
 * @returns {{violations: object[], suspected: object[],
 *   witnesses: Array<{a: string, b: string, of: string, why: string}>}}
 *   Proven defects, suspected splits, and the identity questions those raise — never answers.
 */
export function checkInvariants({ inv, answers = [] }) {
    // PROVEN against SUSPECTED, and the distinction is load-bearing. A negative quantity and a
    // contradicted partition are defects: no reading of the story makes them right. A token overlap
    // is a QUESTION — `carried/silver moon locket` shares "silver" with `money/silver` and is not
    // the same thing, while `carried/silver wen` shares it and is. Those two are structurally
    // identical (both a strict token subset), so nothing language-neutral separates them and fold
    // must not call either a defect.
    //
    // Measured on the live chats: of five suspected splits, the Wuxia one (`silver wen` / `silver`)
    // is real and the three Time Stop ones (a locket and a ring against the balance) are not. That
    // is not a failure of the check. A suspected split the model answers `different` is a
    // `different` LABEL — the minority class the corpus has three of in seventy-six — and it cost
    // no question slot to raise. Both answers are worth having, which is why they are witnesses.
    const splits = splitCurrency(inv);
    const violations = [
        ...negativeQuantities(inv),
        ...partitionContradictions(answers),
    ];
    const suspected = splits;
    // A split raises one question per pair of rows in the group. `of: 'item'` because the review
    // has no item identity source yet — this is the first one, and it arrives free.
    const witnesses = [];
    for (const split of splits) {
        for (let i = 0; i < split.rows.length; i++) {
            for (let j = i + 1; j < split.rows.length; j++) {
                witnesses.push({
                    a: split.rows[i].key,
                    b: split.rows[j].key,
                    of: 'item',
                    why: 'split-currency',
                });
            }
        }
    }
    return { violations, suspected, witnesses };
}
