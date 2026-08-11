/**
 * fold/coverage.js — the model's reported coverage of the window, persisted.
 *
 * ── Coverage, not a substring proxy ([ROUTER]) ──
 *
 * The entity and thread probes answer `mentions: string[]` — the names the new excerpt actually
 * used, in any language. Those are the coverage authority: admission to the review hot set, the
 * presence questions and cold recall is by membership in this report, never by fold token-matching
 * the window itself.
 *
 * But the review hot set (`reviewableWindow`) and the presence questions are built BEFORE the pass
 * sends its request, so they cannot read the SAME pass's answer. They read the PREVIOUS pass's —
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
 * leaves both available to the review until they age out — a thread posed this pass may have been
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
