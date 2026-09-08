/**
 * fold/coverage.js: the model's reported coverage of the window, persisted.
 *
 * Coverage, not a substring proxy ([ROUTER]).
 *
 * The entity and thread probes answer `mentions: string[]`: the names the new excerpt actually
 * used, in any language. Those are the coverage authority: admission to the review hot set, the
 * presence questions and cold recall is by membership in this report, never by fold token-matching
 * the window itself.
 *
 * But the review hot set (`reviewableWindow`) and the presence questions are built BEFORE the pass
 * sends its request, so they cannot read the SAME pass's answer. They read the PREVIOUS pass's,
 * stored here, one pass behind. That is exactly right: the window only shifts a little between
 * passes, and last pass's report is this pass's prior. It is the model answering "what did the
 * excerpt name", in any language, instead of fold guessing with an English word list.
 *
 * This module exists so both `entities.js` and `clocks.js` (which write the reports) and
 * `state.js` (which reads them to build the review) can share it without a cycle: `state.js`
 * imports the probe modules, so the probe modules must not import `state.js` back.
 */

import { commitValue, loadValue } from './store.js';

const COVERAGE_PATH = 'state.coverage';

/**
 * The wording half of the coverage rule, in one place because it is one rule.
 *
 * Why the ask, and not a matcher.
 *
 * Coverage admits a proposal when the model's own `mentions` report names it. That leaves fold
 * holding two strings the same model wrote in the same call, needing to know whether they are the
 * same thing, record linkage, which RULE 1 forbids solving with a similarity metric and which no
 * metric could solve anyway across scripts: `Zhāng Lín` and `张林` share not one character, so edit
 * distance, token overlap and substring tests all correctly report two unrelated strings. The
 * information that they are one man exists only in the model's head, so it is asked for directly,
 * the same argument `entity-table.js` `canonicalKey` makes for having an alias field at all.
 *
 * Why it is a function and not three sentences.
 *
 * `chronicle.js` has asked for exactly this discipline between an event's `mentions` and its
 * delta's `item` since the coverage rule landed, and it is the clause that works. The cast and
 * thread probes did not have it, and the live Wuxia campaign is what that cost: the cast probe
 * answered `name: "Zhāng Lín"` against its own `mentions: [… "张林" …]` and the person was refused;
 * the thread probe refused 7 of 8 proposed ticks the same way. Three probes with three separately
 * worded versions of one rule is how they come to mean three different things after the next edit,
 * so there is one sentence and three callers.
 *
 * @param {object} params Which field must agree, and what it names.
 * @param {string} params.field The other field, quoted as the schema quotes it.
 * @param {string} params.thing The noun: "person", "stake", "thing".
 * @returns {string} One sentence, to be appended to a `mentions` description or instruction.
 */
export function oneSpelling({ field, thing }) {
    return `Word ${field} EXACTLY as you write it here, one spelling for one ${thing}, in both places.`;
}

/** How many names to keep per kind. A window has a few dozen names at most; this bounds the blob. */
const MAX_NAMES = 64;

/**
 * The persisted coverage: the names each probe reported the last window used.
 * @returns {{cast: Set<string>, threads: Set<string>}} Lowercased names per probe kind.
 */
function coverage() {
    const stored = loadValue(COVERAGE_PATH, null);
    return {
        cast: new Set(Array.isArray(stored?.cast) ? stored.cast : []),
        threads: new Set(Array.isArray(stored?.threads) ? stored.threads : []),
    };
}

/**
 * Persist one probe's coverage report.
 *
 * Accumulated rather than replaced, so a report that names "Vesk" one pass and "Gorak" the next
 * leaves both available to the review until they age out, a thread posed this pass may have been
 * named the pass before. Bounded to MAX_NAMES per kind.
 *
 * @param {'cast'|'threads'} kind Which probe reported it.
 * @param {Iterable<string>} names The names it reported the window used.
 */
export function noteCoverage(kind, names) {
    const current = coverage();
    commitValue(COVERAGE_PATH, {
        ...current,
        [kind]: [...new Set(
            [...current[kind], ...(names ?? [])]
                .map(name => String(name ?? '').toLowerCase().trim())
                .filter(Boolean),
        )].slice(-MAX_NAMES),
    });
}

/** @returns {Set<string>} The cast names the model reported the last window used. */
export function coveredCast() {
    return coverage().cast;
}

/** @returns {Set<string>} The thread names the model reported the last window used. */
export function coveredThreads() {
    return coverage().threads;
}
