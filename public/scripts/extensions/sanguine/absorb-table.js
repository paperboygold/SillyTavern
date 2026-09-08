/**
 * fold/absorb-table.js: the pure half of block absorption.
 *
 * `absorb.js` imports `script.js` to strip a block out of a message, so it cannot be unit-tested;
 * this is the rule it applies, in a file that can. Same split, same reason, as `extract-table.js`
 * (Phase A) and `migrate.js` (Phase B).
 *
 * What lives here and why it is one rule.
 *
 * The card now emits a status block, and absorption grew `context` three free-text fields, `leads`,
 * `pressure`, `health`, that are prose duplicates of the thread table and the marks, sitting where
 * nothing can act on them **and outranking narrative on trust**, because `src: block` wins for
 * CONTEXT_OVERRIDE_AFTER turns (`state-table.js` `merge_context`). Measured on the live Solo
 * Leveling header at message 72: the residency stake existed in three representations at once, a
 * lead row, a clock row, and `pressure: "19 raids remaining in twelve-month window"`, and every
 * consumer rendered all three (`FOLD-REDESIGN.md` §0.1-5, §5).
 *
 * The rule that fixes the class: a block field whose label names a structured domain is parsed into
 * that domain's own validation pipeline, or refused. Trust ranking then applies within ONE
 * representation instead of across two. Context keeps only labels fold has no structure for, which
 * was always its stated job (`panel.js`, "shown as given rather than dropped for not fitting a
 * schema").
 */

import { LEAD_LABELS } from './entity-table.js';
import { HEALTH_LABELS } from './state-table.js';
import {
    DOOM,
    PRESSURE_LABELS,
    foldThread,
    foldThreads,
    normalizeSize,
    normalizeThreadName,
} from './thread-table.js';

/**
 * Reason kept on a refused clause. Counted as `reject:block-shadow`; see `observe.js`.
 *
 * The ONLY reason this table ever files. A second one (`health-prose`) used to ride here for a
 * routed field with a residual, and the panel (which cannot tell one reason from another) showed
 * it under "Not parsed" as though the extension had failed. Shadow means refused. Anything that
 * routed successfully has no business in it.
 */
export const SHADOW = 'block-shadow';

/** A dial written in prose: `‹name› n/m`, with the common spellings of the slash. */
const DIAL_SHAPE = /^\s*(.*?)\s*[([]?\s*(\d{1,2})\s*(?:\/|of|out of)\s*(\d{1,2})\s*[)\]]?\s*$/i;

/**
 * Read a dial out of a prose clause.
 *
 * Narrow on purpose. A card writes `goblin nest counterattacks 1/4` and that is a dial with a
 * stated position; it writes `19 raids remaining in twelve-month window` and that is a sentence
 * containing two numbers and no position. Guessing which number is the fill is the kind of inference
 * that produced the inverted residency clock (`FOLD-REDESIGN.md` §0.1-3), so anything not of the
 * form `‹name› n/m` is refused and kept verbatim for the review to look at.
 *
 * @param {string} clause One clause from a pressure field.
 * @returns {{name: string, filled: number, size: number}|null} The dial, or null.
 */
export function readDial(clause) {
    const match = String(clause ?? '').match(DIAL_SHAPE);
    if (!match) {
        return null;
    }
    const parsed = normalizeThreadName(match[1]);
    const [filled, size] = [Number(match[2]), Number(match[3])];
    if (!parsed || !Number.isFinite(size) || size < 2 || filled > size) {
        return null;
    }
    return { name: parsed.display, filled, size };
}

/**
 * Route block fields that shadow a structured table into that table's own pipeline.
 *
 *   leads     → thread proposals through the exposition gate. A "lead" with nothing unresolved in it
 *               is lore, and `isExposition` (`entity-table.js`) is the rule that says so.
 *   pressure  → dial proposals, and only where the prose states a POSITION. Written absolutely
 *               rather than as a tick, for `setQty`'s reason (`state-table.js`): a restated total is
 *               a last-write assertion about the present, so folding the same one twice has to be a
 *               no-op, exactly the property `foldTicks` cannot offer and a re-sent block needs.
 *   health    → kept verbatim in context. It used to split into `conditions` for `validateStatus`,
 *               which minted a mark for any non-empty value, "Health: Uninjured" included, always
 *               `moderate` and permanent; ranking and reassurance are the model's to read, and the
 *               scene probe reports the real afflictions from the same block text.
 *   inventory → untouched. It already has the restated-totals path (`restateInventory`).
 *
 * Refusals are kept verbatim, and that is what makes the deletion unconditional.
 *
 * Phase B refused to delete a shadowed context key unless at least one clause routed, because on
 * Raccoon City extraction never ran and the field was the only record of five story facts: §9's
 * "never carried into v2 context" must not mean "destroyed" (`migrate.js` `migrateContext`, LANDED
 * deviation 5). The same worry, answered more strongly: everything refused comes back in `shadow`,
 * verbatim, and the caller preserves it (`state.js` `noteShadow`) and shows it (`panel.js`, "Not
 * parsed"). So the key can always be removed without losing a word the card wrote.
 *
 * @param {Map<string, string>} context Context fields. NOT mutated; the caller applies `keep`.
 * @param {Map<string, object>} table Thread table, mutated with whatever routed.
 * @param {object} [options] Options.
 * @param {number} [options.turn] Turn counter.
 * @returns {{keep: Map<string, string>, shadow: object[], routed: number}} The context fields that
 *   survive, the clauses that did not parse, and how many proposals landed.
 */
export function routeBlockFields(context, table, { turn = 0 } = {}) {
    const keep = new Map();
    const shadow = [];
    let routed = 0;

    for (const [label, value] of context ?? new Map()) {
        const kind = domainOf(label);
        if (!kind) {
            keep.set(label, value);
            continue;
        }

        if (kind === 'health') {
            // Kept verbatim, never turned into marks here.
            //
            // This used to split the field into `conditions` for `validateStatus` (`absorb.js`), and
            // splitConditions treated any non-empty value as a condition list: a card saying
            // `Health: Uninjured` minted an `uninjured` mark, always `moderate` and permanent. The
            // raw field is a reading of the card's language, and RULE 1 reserves that reading for
            // the model, which does it in the scene probe (`scene.js` `conditions`, severity and
            // duration included) from the same block text. Here the value simply survives, so the
            // panel renders it verbatim under Condition whenever the fold has no marks of its own.
            keep.set(label, value);
            continue;
        }

        // Punctuation split only. The old `splitClauses` judged which comma-separated fragment was
        // its own statement with the `FINITE_VERB` English verb list, a grammar that could only
        // read one language. Whether a fragment is a separate lead is a reading the model answers
        // (the threads probe reports leads structurally from the same block text); this fallback
        // only routes on shape.
        const clauses = String(value ?? '').split(/\s*[;,，、；]\s*/).map(part => part.trim()).filter(Boolean);
        if (!clauses.length) {
            continue;
        }

        if (kind === 'pressure') {
            for (const clause of clauses) {
                const dial = readDial(clause);
                if (!dial) {
                    // No position stated, so there is no dial here, only a sentence. A dial-less
                    // thread would be the tempting fallback and is wrong: `pressure` names a
                    // measurable stake, and turning "19 raids remaining" into a thread re-creates
                    // the residency duplicate this rule exists to stop.
                    shadow.push({ label, reason: SHADOW, text: clause });
                    continue;
                }
                const written = foldThread(table, {
                    name: dial.name,
                    kind: DOOM,
                    size: dial.size,
                    // `foldThread` accumulates, so an absolute position is the difference from
                    // where the dial stands, the same arithmetic `clocks.set` does by hand.
                    tick: dial.filled - (table.get(normalizeThreadName(dial.name)?.key ?? '')?.filled ?? 0),
                    about: '',
                    source: `card block, ${label}`,
                    turn,
                });
                if (written) {
                    // Clamped to its own size on the way in, so a block that restates `4/4` twice
                    // does not overfill. `normalizeSize` is the same rounding the probe uses.
                    const row = table.get(written.key);
                    row.filled = Math.min(row.filled ?? 0, normalizeSize(row.size, row.kind));
                    routed++;
                } else {
                    shadow.push({ label, reason: SHADOW, text: clause });
                }
            }
            continue;
        }

        const before = table.size;
        const byName = new Map(clauses.map(clause => [normalizeThreadName(clause)?.display, clause]));
        const { rejected } = foldThreads(table, clauses.map(clause => ({
            // The clause is both the title and the open question, because a prose lead has no other
            // structure to take a title from. `migrate.js` `migrateContext` made the same choice for
            // the same reason, and the two paths stay identical on purpose.
            name: clause,
            open: clause,
            source: `card block, ${label}`,
        })), { turn });
        routed += table.size - before;
        for (const entry of rejected) {
            // The rejection reports the NAME it refused, which `normalizeThreadName` has already
            // truncated. What is preserved has to be the clause the card actually wrote.
            // The reason the THREAD pipeline gave, not a blanket `block-shadow`. `foldThreads`
            // refuses for three distinct causes, `unusable-name`, `exposition`, `threads-full`,
            // and overwriting them all meant a card block that overflowed the thread table was
            // reported as prose that could not be parsed, which sends the reader looking at the
            // card instead of at the cap.
            shadow.push({ label, reason: entry.reason ?? SHADOW, text: byName.get(entry.item) ?? entry.item });
        }
    }

    return { keep, shadow, routed };
}

/**
 * Which structured domain, if any, a block label names.
 * @param {string} label A block field label.
 * @returns {string} 'leads', 'pressure', 'health', or '' for a label fold has no structure for.
 */
export function domainOf(label) {
    const said = String(label ?? '').trim().toLowerCase();
    if (LEAD_LABELS.includes(said)) return 'leads';
    if (PRESSURE_LABELS.includes(said)) return 'pressure';
    if (HEALTH_LABELS.has(said)) return 'health';
    return '';
}
