/**
 * sanguine-observe: the instrument that measures the instruments has to be complete.
 *
 * Why this is a test and not a report.
 *
 * `observe.js` counts every bound that changes an outcome, and `KNOWN_RULES` is the hand-written
 * list of the bounds it knows about. That list is the denominator for `neverFired()`, and
 * `neverFired()` is about to be used to decide WHAT CODE GETS DELETED: a rule that has never fired
 * across a corpus of live chats is either dead code or a gate that works, and the whole argument for
 * looking is that the two can be told apart.
 *
 * A hand-written denominator drifts. Measured: a corpus audit over 21 live chats and 24 ledger files
 * found 22 rules firing that `KNOWN_RULES` never declared, the busiest counter in the entire
 * corpus, `cap:mirror-shed` at 40,480, among them. An undeclared rule is invisible in BOTH
 * directions: it cannot appear in the fired report under a name anybody recognises, and it cannot
 * appear in the never-fired list either, because nothing knows it exists. Every deletion decision
 * taken against that list was therefore partial, and nothing said so.
 *
 * So the drift is a build failure now. Add a counter without declaring it and this test goes red.
 *
 * Why the gate reads the SOURCE rather than a fixture of rules known to fire.
 *
 * Three reasons, in order of weight:
 *
 *   1. It must fail on drift WITHOUT a live chat. A fixture of "rules seen firing" only fails after
 *      somebody has played long enough to fire the new rule and then remembered to update the
 *      fixture: which is the same forgetting this gate exists to catch, one indirection later.
 *   2. A fixture is a second hand-maintained list of exactly the kind that just drifted. It would
 *      fail silently by passing: a stale fixture is indistinguishable from a complete one.
 *   3. The call sites are the ground truth. `observe.note('x')`, `noteMax('x')` and `noteCap('x')`
 *      name their rule as a string literal at the point of use, so reading them is exact, no
 *      sampling, no guessing, and no dependence on which chats happen to be on disk.
 *
 * `observe.js` cannot be imported here (it reaches the browser app through `store.js`), so
 * `KNOWN_RULES` is read out of the source the same way `sanguine-review-table.test.js` reads it for
 * `cap:stale-hidden`. Comments are stripped before any string literal is matched, the array is
 * heavily commented and those comments contain apostrophes ("fold's", "the model's own"), which pair
 * with the next quote and corrupt every literal after them. That is not hypothetical: it was the
 * first version of this extractor, and it invented eighteen false failures.
 *
 * What this gate cannot see, stated rather than implied.
 *
 * A rule assembled at runtime is invisible to a reader of literals. Four such emitters exist:
 *
 *   · `observe.noteRejections(outcome.rejected)`: validator refusals, where the reason travels in
 *     a variable from the table that refused (`state.js`, `entities.js`, `clocks.js`, `world.js`,
 *     `absorb.js`, `places.js`).
 *   · `` reason: `invariant:${row.kind}` `` (`state.js`), covered below by a second gate, because
 *     the witness kinds ARE enumerable from `invariant-table.js`.
 *   · `` observe.note(`audit:${rejection.reason}`) `` (`audit.js`).
 *   · `` observe.note(`reconcile:${rejection.reason}`) `` (`reconcile.js`).
 *
 * The first is the large one and it is not closable by reading source: the reasons are produced by
 * validators that return them as data. What closes it is the running instrument, `observe.undeclared()`
 * reports any rule that fired and was never declared, and the Diagnostics tab renders that list on a
 * live chat. Source gate for what can be read, live gate for what cannot; neither pretends to be the
 * other.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGUINE = path.join(HERE, '../public/scripts/extensions/sanguine');

/**
 * Remove comments, so a prose apostrophe cannot be read as the start of a string literal.
 *
 * Only used ahead of the ANCHORED patterns below, where a match begins at `observe.note(` and a
 * mispaired quote elsewhere in the file cannot shift it. Free-floating literal collection uses
 * `singleQuoted` instead, which is a real scan rather than a pair of substitutions.
 *
 * @param {string} text Source.
 * @returns {string} Source with block and whole-line comments blanked.
 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

/**
 * Every single-quoted string literal in a source file.
 *
 * Why this is a scanner and not a regex.
 *
 * `/'([^']+)'/g` pairs quotes in sequence, so ONE unmatched apostrophe anywhere earlier in the file
 *, in a trailing `// the model's own`, in a double-quoted string, in a template literal, shifts
 * every pairing after it and the collection silently becomes garbage. Measured on `edits.js`: the
 * regex found 64 literals and none of the twelve `edit:*` rule names that are plainly there. A gate
 * built on that would have passed over an empty set forever, which is the exact failure it exists
 * to prevent, so the scanner tracks what it is inside of instead.
 *
 * @param {string} text Source.
 * @returns {string[]} The literals, in order.
 */
function singleQuoted(text) {
    const out = [];
    let at = 0;
    let buffer = null;
    while (at < text.length) {
        const char = text[at];
        const next = text[at + 1];
        if (buffer !== null) {
            if (char === '\\') { buffer += next ?? ''; at += 2; continue; }
            if (char === '\'') { out.push(buffer); buffer = null; at++; continue; }
            buffer += char; at++; continue;
        }
        if (char === '/' && next === '/') { while (at < text.length && text[at] !== '\n') at++; continue; }
        if (char === '/' && next === '*') { at += 2; while (at < text.length && !(text[at] === '*' && text[at + 1] === '/')) at++; at += 2; continue; }
        if (char === '"' || char === '`') { at++; while (at < text.length && text[at] !== char) { if (text[at] === '\\') at++; at++; } at++; continue; }
        if (char === '\'') { buffer = ''; at++; continue; }
        at++;
    }
    return out;
}

/**
 * The shape of a rule name: one of the namespaces `observe` counts under, then a kebab-case token.
 *
 * Deliberately a closed list of namespaces rather than `\w+:`, because this pattern is used to find
 * rule literals that never appear at an `observe.note` call, and a pattern that matched any
 * colon-separated string would collect selectors, mime types and i18n keys along with them.
 */
const RULE_SHAPE = /^(cap|reject|extract|edit|ledger|reconcile|audit|review|world|verdict|pressure|threads|cast|places|clock|flow|lock|money):[a-z0-9][a-z0-9-]*$/;

/** @returns {Array<{name: string, text: string}>} Every source file of the extension. */
function sources() {
    return fs.readdirSync(SANGUINE)
        .filter(name => name.endsWith('.js'))
        .map(name => ({ name, text: fs.readFileSync(path.join(SANGUINE, name), 'utf8') }));
}

/** @returns {string} `observe.js`, uncommented. */
function observeSource() {
    return stripComments(fs.readFileSync(path.join(SANGUINE, 'observe.js'), 'utf8'));
}

/**
 * The declared rules, read out of the `KNOWN_RULES` array.
 * @returns {string[]} Rule names, in declaration order.
 */
function declaredRules() {
    const text = observeSource();
    const start = text.indexOf('KNOWN_RULES = Object.freeze([');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n]);', start);
    expect(end).toBeGreaterThan(start);
    return singleQuoted(text.slice(start, end));
}

/**
 * Every rule named by a literal at an observation call site, and where it is named.
 *
 * `observe.js` itself is excluded: it holds the definitions of these functions and the declaration
 * list, neither of which is a call site.
 *
 * @returns {Map<string, Set<string>>} Rule -> the files that raise it.
 */
function firedRules() {
    /** @type {Map<string, Set<string>>} */
    const found = new Map();
    const add = (rule, file) => {
        if (!found.has(rule)) found.set(rule, new Set());
        found.get(rule).add(file);
    };
    for (const { name, text } of sources()) {
        if (name === 'observe.js') {
            continue;
        }
        const code = stripComments(text);
        // The Count face and the high-water face both take the rule already namespaced.
        for (const match of code.matchAll(/observe\.note\(\s*'([^']+)'/g)) add(match[1], name);
        for (const match of code.matchAll(/observe\.noteMax\(\s*'([^']+)'/g)) add(match[1], name);
        // `noteCap` adds the namespace for its caller, so the declared name carries the prefix.
        for (const match of code.matchAll(/observe\.noteCap\(\s*'([^']+)'/g)) add(`cap:${match[1]}`, name);
        // An inline rejection: `noteRejections([{ item, reason: 'x' }])`. Only the literal form is
        // readable here; the variable form is the blind spot named in the docblock.
        for (const match of code.matchAll(/observe\.noteRejections\(\[\{[^\]]*?reason:\s*'([^']+)'/gs)) {
            add(`reject:${match[1]}`, name);
        }
    }
    return found;
}

/**
 * Rule-shaped literals in observe-importing files that no declaration accounts for.
 *
 * A literal is accounted for if it is declared, or if its `reject:` form is, the second case is a
 * REJECTION REASON (`state.js` holds `'money:drift'`, which reaches the table as
 * `reject:money:drift`), which is the one false positive this pattern can produce. Exempting by the
 * rule it becomes rather than by name keeps that exemption from growing into an allowlist.
 *
 * @param {string[]} declared The declared rules.
 * @returns {string[]} Each undeclared literal with the files that name it.
 */
function undeclaredLiterals(declared) {
    const known = new Set(declared);
    /** @type {Map<string, Set<string>>} */
    const candidates = new Map();
    for (const { name, text } of sources()) {
        if (name === 'observe.js' || !text.includes('from \'./observe.js\'')) {
            continue;
        }
        for (const literal of singleQuoted(text)) {
            if (!RULE_SHAPE.test(literal) || known.has(literal) || known.has(`reject:${literal}`)) {
                continue;
            }
            if (!candidates.has(literal)) candidates.set(literal, new Set());
            candidates.get(literal).add(name);
        }
    }
    return [...candidates.entries()]
        .map(([rule, files]) => `${rule} (named in ${[...files].sort().join(', ')})`)
        .sort();
}

describe('KNOWN_RULES is the denominator, so it has to be complete', () => {
    const declared = declaredRules();
    const fired = firedRules();

    /*
     * The gate itself is source-scanning, and a source-scanning gate that matches nothing PASSES.
     * That failure mode is silent and permanent: rename `note` to `count`, or move the calls behind
     * a helper, and this file would go on reporting success over an empty set forever. So the
     * extractor's own yield is asserted first, and the floors are set well under the current numbers
     * (95 call-site rules, 186 declared) rather than at them, this is a tripwire for "the extractor
     * stopped working", not a second thing to update on every edit.
     */
    test('the extractor still finds the call sites it is supposed to read', () => {
        expect(declared.length).toBeGreaterThan(120);
        expect(fired.size).toBeGreaterThan(60);
        // The names it read are rules, not fragments of something else that happened to be quoted.
        for (const rule of fired.keys()) {
            expect(rule).toMatch(/^[a-z][a-z0-9-]*(:[a-z0-9-]+)+$/);
        }
    });

    test('every rule raised by a literal call site is declared', () => {
        const known = new Set(declared);
        const undeclared = [...fired.entries()]
            .filter(([rule]) => !known.has(rule))
            .map(([rule, files]) => `${rule} (raised in ${[...files].sort().join(', ')})`)
            .sort();
        /*
         * If this fails, the fix is one line in `KNOWN_RULES` in `observe.js`: a rule name and a
         * sentence saying what a zero on it would prove. Do not delete the counter to make the test
         * pass, and do not weaken the gate: an undeclared counter is worse than no counter, because
         * it consumes the metadata budget while appearing in neither half of the report.
         */
        expect(undeclared).toEqual([]);
    });

    /*
     * The indirection the anchored reader cannot see.
     *
     * `edits.js` does not call `observe.note('edit:item-added')`. It calls a local helper,
     * `append(summary, keywords, delta, 'edit:item-added')`: which calls `observe.note(rule)` once
     * the event is recorded. The rule is a literal in the file, in a namespace `observe` counts
     * under, and it is invisible to a reader anchored on the call. Eight rules hid in exactly that
     * shape while four of their siblings in the same file were declared, which is what makes this
     * worth a second gate rather than a note.
     *
     * The one false positive this pattern can produce is a REJECTION REASON: `state.js` holds the
     * literal `'money:drift'`, which is a reason and reaches the table as `reject:money:drift`. That
     * is exempted by the rule it becomes rather than by name, a literal is fine if its `reject:`
     * form is declared, so the exemption cannot quietly grow into an allowlist of forgotten rules.
     */
    test('rules named as literals but raised indirectly are declared too', () => {
        expect(undeclaredLiterals(declared)).toEqual([]);
    });

    test('and nothing is declared twice', () => {
        const seen = new Set();
        const duplicates = declared.filter(rule => (seen.has(rule) ? true : (seen.add(rule), false)));
        expect(duplicates).toEqual([]);
    });
});

describe('the invariant witnesses, which reach the tally through a template', () => {
    /*
     * `state.js` maps each audit witness to a rejection: two kinds have hand-written reasons
     * (`drift` -> `money:drift`, `overdraw` -> `invariant:overdraw`) and every other kind is passed
     * through as `` `invariant:${row.kind}` ``. That template is invisible to the literal reader
     * above, but the KINDS are enumerable, `invariant-table.js` names each one where it builds the
     * witness: so this hole can be closed by reading the producer instead of the caller.
     *
     * Both of these fired on the live Raccoon City chat (`reject:invariant:overdraw` twice,
     * `reject:invariant:partition-contradiction` once) while being declared nowhere.
     */
    const declared = new Set(declaredRules());
    const witnesses = fs.readFileSync(path.join(SANGUINE, 'invariant-table.js'), 'utf8');
    const kinds = [...new Set([...stripComments(witnesses).matchAll(/kind:\s*'([^']+)'/g)].map(m => m[1]))];

    test('invariant-table still names its witness kinds where the reader can see them', () => {
        expect(kinds.length).toBeGreaterThan(3);
    });

    test('every witness kind has a declared rejection rule', () => {
        const missing = kinds.map(kind => `reject:invariant:${kind}`).filter(rule => !declared.has(rule));
        expect(missing).toEqual([]);
    });

    test('and so do the two kinds state.js renames on the way through', () => {
        // `overdraw` is a `state-table.js` witness rather than an `invariant-table.js` one, and
        // `drift` is raised in `state.js` itself; neither is reachable from the loop above.
        expect(declared.has('reject:invariant:overdraw')).toBe(true);
        expect(declared.has('reject:money:drift')).toBe(true);
    });
});
