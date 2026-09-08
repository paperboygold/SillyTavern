/**
 * sanguine-rule-triage: the rules with no producer left, pinned so the finding cannot rot.
 *
 * What this file is for.
 *
 * `observe.neverFired()` reports every declared rule that has never bound in a chat. Across the
 * corpus (21 live chats, 24 ledger files) 87 of 192 declared rules have never fired anywhere, and
 * that tally was about to be used as a deletion list. It cannot be: a rule reads zero for four
 * different reasons, and only one of them means the code is dead.
 *
 *   BROKEN       a producer exists, but the call cannot be reached, or is reached with an argument
 *                that can never satisfy it. `recall.js` gated `cap:recall-budget` on
 *                `selection.skipped?.length` where `skipped` is an object with no `length`, so the
 *                condition was `undefined` on every generation ever run. Fix candidate.
 *   UNREACHABLE  no producer exists at all any more; the rule outlived a rename or a deletion.
 *   INERT        the producer is correct and reachable and the condition has not occurred in 21
 *                campaigns by one player in one style. A validation gate that has never refused
 *                anything because nothing has ever been wrong is a gate doing its job quietly.
 *   UNPROVABLE   not determinable from source and corpus.
 *
 * A broken instrument and dead code are indistinguishable FROM THE TALLY. This test pins only the
 * half of the triage that is structural, the UNREACHABLE verdicts, which are claims about the
 * source and nothing else. INERT is deliberately NOT pinned: it is a statement about play, it will
 * change the first time somebody runs a long fight or fills an inventory, and a test asserting that
 * a working gate stays unused would be a test demanding the gate never work.
 *
 * Why this must be a source scan and not a list.
 *
 * The verdicts below were reached by reading the producers once, by hand. Between now and whenever
 * somebody acts on them, a producer can come back, a rename reinstated, a retired gate rewired,
 * and the triage would go stale silently, in the direction that deletes working code. So each
 * UNREACHABLE verdict is re-derived from the source on every run. If a producer reappears, the rule
 * is no longer a deletion candidate and this test says so by failing.
 *
 * The tripwire, because a source scan that matches nothing PASSES.
 *
 * This is the same failure mode `sanguine-observe.test.js` documents: rename `note` to `count`, or
 * move the raise sites behind a helper, and an extractor built on the old shape reports success over
 * an empty set forever. So every pattern this file uses is first asserted to FIND something, on
 * rules whose producers were read by hand and are named here as controls. A pattern that stops
 * finding its control has stopped working, and the UNREACHABLE verdicts it produces mean nothing.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGUINE = path.join(HERE, '../public/scripts/extensions/sanguine');

/**
 * Remove comments, so prose about a retired rule is not read as the rule's producer.
 *
 * This matters more here than anywhere else in the suite. Every rule below is retired, and this
 * codebase documents its retirements at length, `world-table.js` explains why `unrooted-move` left,
 * `observe.js` explains why `stale-hidden` is kept in the list after `isFresh` was deleted. Those
 * paragraphs name the rule repeatedly. A scan that counted them would find a "producer" for every
 * single UNREACHABLE verdict and pass over an empty finding.
 *
 * @param {string} text Source.
 * @returns {string} Source with block comments and whole-line comments blanked.
 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

/**
 * Every single-quoted string literal in a source file, as a real scan.
 *
 * Copied in shape from `sanguine-observe.test.js`, for the reason stated there: `/'([^']+)'/g` pairs
 * quotes in sequence, so one unmatched apostrophe earlier in the file shifts every pairing after it
 * and the collection silently becomes garbage.
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
 * Every source file of the extension, including `lib/`.
 *
 * `observe.js` is excluded from producer scanning by the callers below: it holds `KNOWN_RULES`,
 * which names every rule in the project and would answer "yes, a producer exists" for all of them.
 *
 * @returns {Array<{name: string, text: string}>} Name relative to the extension root, and source.
 */
function sources() {
    const out = [];
    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full, `${prefix}${entry.name}/`);
            } else if (entry.name.endsWith('.js')) {
                out.push({ name: `${prefix}${entry.name}`, text: fs.readFileSync(full, 'utf8') });
            }
        }
    };
    walk(SANGUINE, '');
    return out;
}

/** @returns {Array<{name: string, code: string}>} Every source but `observe.js`, uncommented. */
function producerFiles() {
    return sources()
        .filter(file => file.name !== 'observe.js')
        .map(file => ({ name: file.name, code: stripComments(file.text) }));
}

/**
 * The declared rules, read out of the `KNOWN_RULES` array in `observe.js`.
 * @returns {string[]} Rule names, in declaration order.
 */
function declaredRules() {
    const text = stripComments(fs.readFileSync(path.join(SANGUINE, 'observe.js'), 'utf8'));
    const start = text.indexOf('KNOWN_RULES = Object.freeze([');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n]);', start);
    expect(end).toBeGreaterThan(start);
    return singleQuoted(text.slice(start, end));
}

/**
 * Where a `reject:<reason>` rule is raised, if anywhere.
 *
 * A rejection reason almost never appears at an `observe` call. It is DATA: a validator pushes
 * `{ item, reason: 'rate-limited', raw, snippet }` onto an array, the array travels up to a caller,
 * and `observe.noteRejections` turns each reason into `reject:<reason>`. So the producer to look for
 * is the field write, in any of the shapes this codebase uses:
 *
 *   `rejected.push({ item: name, reason: 'rate-limited', raw, snippet })`   state-table.js
 *   `plan.rejected.push({ item: '', reason: 'sheet-unnamed', raw, snippet })`   review-table.js
 *   `return { key: '', reason: 'places-full' }`                            place-table.js
 *   `reason: 'clock-reversed',` on its own line                            state.js
 *   `export const PLACES_FULL = 'places-full';`                            place-table.js
 *
 * The last shape is the newest and the tripwire is what found it: `PLACES_FULL` became a named
 * export the moment a second file needed to TEST for the reason (`places.js` answers a full table by
 * demoting the stalest leaf and folding again), and the two `reason:` patterns stopped matching
 * anything. A named constant holding the literal is a producer, it is where the reason is spelled,
 * so it is matched here rather than papered over at the call site with a duplicate string.
 *
 * Anchoring on `reason:` is what keeps `diagnostics-view.js` out of the result. That file holds a
 * lookup of human explanations KEYED by reason, `'negation': 'a reassurance … is not a condition.'`
 *, where the rule name is a property key rather than a value. It is a read surface, not a producer,
 * and a scan for the bare literal would count it and turn every UNREACHABLE verdict here into a
 * false negative.
 *
 * @param {string} reason The reason, unprefixed.
 * @returns {string[]} `file:line` for each producer.
 */
function rejectProducers(reason) {
    const escaped = reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asField = new RegExp(`reason:\\s*['"]${escaped}['"]`);
    const asNote = new RegExp(`observe\\.note\\(\\s*['"]reject:${escaped}['"]`);
    const asConstant = new RegExp(`^\\s*(?:export )?const [A-Z_]+ = ['"]${escaped}['"]`);
    const found = [];
    for (const { name, code } of producerFiles()) {
        code.split('\n').forEach((line, at) => {
            if (asField.test(line) || asNote.test(line) || asConstant.test(line)) {
                found.push(`${name}:${at + 1}`);
            }
        });
    }
    return found;
}

/**
 * Where a `cap:<rule>` counter is raised, if anywhere.
 *
 * Two shapes, both live: `observe.noteCap('field-locked')`, which adds the namespace for its caller,
 * and the fully namespaced literal `'cap:threads-full'`, which `migrate.js` uses because it writes
 * through its own `note(state, rule, times)` helper rather than importing `observe.js`.
 *
 * @param {string} rule The rule, unprefixed.
 * @returns {string[]} `file:line` for each producer.
 */
function capProducers(rule) {
    const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asNoteCap = new RegExp(`noteCap\\(\\s*['"]${escaped}['"]`);
    const asLiteral = new RegExp(`['"]cap:${escaped}['"]`);
    const found = [];
    for (const { name, code } of producerFiles()) {
        code.split('\n').forEach((line, at) => {
            if (asNoteCap.test(line) || asLiteral.test(line)) {
                found.push(`${name}:${at + 1}`);
            }
        });
    }
    return found;
}

/**
 * Where an `extract:on-<token>` counter could come from.
 *
 * These are assembled rather than written: `index.js` raises
 * `` observe.note(`extract:on-${decision.why.replace(/\s+/g, '-')}`) ``, and `decision.why` is a
 * plain English phrase produced by `trigger-table.js` (`'interval'`, `'state block'`,
 * `'scene break'`, `'time skipped'`) or by `index.js`'s own force path (`'unread'`). So the producer
 * of `extract:on-state-block` is the literal `'state block'`, and a rule in this family is
 * unreachable exactly when no literal anywhere kebab-cases to its token.
 *
 * @param {string} token The part after `extract:on-`.
 * @returns {string[]} `file:line` for each literal that would produce it.
 */
function extractWhyProducers(token) {
    const found = [];
    for (const { name, code } of producerFiles()) {
        code.split('\n').forEach((line, at) => {
            for (const literal of singleQuoted(line)) {
                if (literal.trim().replace(/\s+/g, '-') === token) {
                    found.push(`${name}:${at + 1}`);
                }
            }
        });
    }
    return found;
}

/**
 * The witness kinds that `checkInvariants` files as VIOLATIONS rather than as questions.
 *
 * `state.js` turns each violation into a rejection named `` `invariant:${row.kind}` ``, so a kind in
 * this set has a producer for `reject:invariant:<kind>` and a kind outside it does not. The
 * distinction is the whole of the triage for four declared rules: `invariant-table.js` builds
 * `split-name`, `split-currency` and `unbacked-debit` rows, but files them under `witnesses`, which
 * `state.js` returns to the review pass as identity QUESTIONS and never hands to `noteRejections`.
 * That is deliberate, "a token overlap is a QUESTION", per `checkInvariants`' own header, and it
 * means those three rejection rules can never be raised however much evidence the ledger holds.
 *
 * Derived rather than listed, so promoting a witness to a violation retires the verdict by itself.
 *
 * @returns {Set<string>} The kinds that reach the rejection tally.
 */
function violationKinds() {
    const text = stripComments(fs.readFileSync(path.join(SANGUINE, 'invariant-table.js'), 'utf8'));
    const start = text.indexOf('const violations = [');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    const spread = [...text.slice(start, end).matchAll(/\.\.\.(\w+)\(/g)].map(match => match[1]);
    expect(spread.length).toBeGreaterThan(0);

    const kinds = new Set();
    for (const fn of spread) {
        const at = text.indexOf(`export function ${fn}(`);
        if (at < 0) {
            continue;
        }
        const next = text.indexOf('\nexport function ', at + 1);
        const body = text.slice(at, next < 0 ? text.length : next);
        for (const match of body.matchAll(/kind:\s*'([^']+)'/g)) {
            kinds.add(match[1]);
        }
    }
    return kinds;
}

/**
 * The UNREACHABLE verdicts: a declared rule with no producer left anywhere in the extension.
 *
 * Each carries the reason it went, because the reason is what says whether the NAME is safe to
 * delete or whether something else went with it that should not have.
 */
const UNREACHABLE = Object.freeze([
    {
        rule: 'reject:negation',
        find: () => rejectProducers('negation'),
        why: 'the reassurance gate ("otherwise unhurt" is not a condition) is now the review pass '
            + 'asking directly (`review-table.js`), and `isNegation` no longer refuses anything.',
    },
    {
        rule: 'reject:clocks-full',
        find: () => rejectProducers('clocks-full'),
        why: 'renamed to `threads-full` when the cap began bounding leads and dials together. '
            + '`observe.js` keeps it on the argument that live chats still carry counts under the '
            + 'old name, measured across the corpus under BOTH metadata keys, none do.',
    },
    {
        rule: 'reject:not-an-item',
        find: () => rejectProducers('not-an-item'),
        why: 'the contacts-are-not-items refusal; nothing pushes the reason any more.',
    },
    {
        rule: 'reject:unrooted-move',
        find: () => rejectProducers('unrooted-move'),
        why: 'retired with the shape that needed it. The world turn addresses agendas by id now, so '
            + 'an unrooted move is unsayable rather than refused (`world-table.js`, `unknown-id`).',
    },
    {
        rule: 'cap:stale-hidden',
        find: () => capProducers('stale-hidden'),
        why: 'retired to zero by construction in Phase C, `isFresh` is deleted. `observe.js` says '
            + 'keeping it is deliberate and `neverFired()` naming it is the success criterion, so '
            + 'this pin records the success rather than proposing the deletion.',
    },
    {
        rule: 'cap:summary-truncated',
        find: () => capProducers('summary-truncated'),
        why: 'no summary truncation exists anywhere in the extension.',
    },
    {
        rule: 'cap:migrate-unowned',
        find: () => capProducers('migrate-unowned'),
        why: 'the migration `counts` object has no `unowned` field; `migrateContacts` only ever '
            + 'increments `counts.reach`. The counter outlived the field it counted.',
    },
    {
        rule: 'extract:on-travel',
        find: () => extractWhyProducers('travel'),
        why: 'no `why` value anywhere kebab-cases to `travel`; the reasons a pass can run are '
            + 'interval, state block, scene break, time skipped and unread.',
    },
    {
        rule: 'reject:invariant:split-name',
        find: () => (violationKinds().has('split-name') ? ['invariant-table.js violations'] : []),
        why: 'a duplicated non-money name is filed as a WITNESS, not a violation, so it reaches the '
            + 'review as an identity question and never reaches `noteRejections`.',
    },
    {
        rule: 'reject:invariant:split-currency',
        find: () => (violationKinds().has('split-currency') ? ['invariant-table.js violations'] : []),
        why: 'same: a token overlap between a money row and another row is a question, by design, '
            + '"three of the five raised on the live chats are a silver ring and a silver moon '
            + 'locket sharing a token with the balance".',
    },
    {
        rule: 'reject:invariant:unbacked-debit',
        find: () => (violationKinds().has('unbacked-debit') ? ['invariant-table.js violations'] : []),
        why: 'the negative balance itself is the proven violation and is already counted as '
            + '`reject:invariant:overdraw`; WHICH row funded it is suspected, so it leaves as a '
            + 'witness.',
    },
]);

/**
 * Rules whose producers were read by hand and confirmed present, one per scanning pattern.
 *
 * These are the tripwire. They are NOT part of the triage, every one is INERT or BROKEN, and none
 * is a deletion candidate. They are here so that a pattern which has stopped matching anything
 * fails loudly instead of manufacturing UNREACHABLE verdicts.
 */
const CONTROLS = Object.freeze([
    { rule: 'reject:rate-limited', find: () => rejectProducers('rate-limited') },
    { rule: 'reject:vitals-full', find: () => rejectProducers('vitals-full') },
    { rule: 'reject:entities-full', find: () => rejectProducers('entities-full') },
    { rule: 'reject:places-full', find: () => rejectProducers('places-full') },
    { rule: 'reject:clock-reversed', find: () => rejectProducers('clock-reversed') },
    { rule: 'reject:sheet-unnamed', find: () => rejectProducers('sheet-unnamed') },
    { rule: 'cap:condition-expired', find: () => capProducers('condition-expired') },
    { rule: 'cap:span-clamped', find: () => capProducers('span-clamped') },
    { rule: 'cap:probe-truncated', find: () => capProducers('probe-truncated') },
    { rule: 'cap:calendar-ticked', find: () => capProducers('calendar-ticked') },
    { rule: 'cap:places-archived', find: () => capProducers('places-archived') },
    // `migrate.js` writes the namespaced literal through its own helper rather than `noteCap`, so
    // this control is the one that proves the second half of `capProducers` still matches.
    { rule: 'cap:threads-full', find: () => capProducers('threads-full') },
    { rule: 'extract:on-state-block', find: () => extractWhyProducers('state-block') },
    { rule: 'extract:on-unread', find: () => extractWhyProducers('unread') },
    { rule: 'extract:on-time-skipped', find: () => extractWhyProducers('time-skipped') },
]);

describe('the triage tripwire: every scanning pattern still finds a producer it is meant to find', () => {
    /*
     * If any of these fails, STOP. The UNREACHABLE assertions below are derived by the same patterns
     * and are worthless until this passes, an empty match reads exactly like "no producer exists",
     * which is the verdict that gets code deleted.
     */
    for (const control of CONTROLS) {
        test(`${control.rule} still has a producer`, () => {
            expect(control.find()).not.toEqual([]);
        });
    }

    test('and the extension source is actually being read', () => {
        const files = producerFiles();
        expect(files.length).toBeGreaterThan(50);
        expect(files.some(file => file.name === 'state-table.js')).toBe(true);
        expect(files.some(file => file.name === 'observe.js')).toBe(false);
    });

    /*
     * The control for the violations/witnesses reader. If `violationKinds()` came back empty, a
     * renamed array, a refactor into a helper, it would report every witness kind as unreachable,
     * which is three deletion candidates manufactured out of a broken scan.
     */
    test('and the violations array still names the kinds that DO reach the rejection tally', () => {
        const kinds = violationKinds();
        expect(kinds.has('negative-quantity')).toBe(true);
        expect(kinds.has('partition-contradiction')).toBe(true);
    });
});

describe('UNREACHABLE: a declared rule with no producer left', () => {
    const declared = new Set(declaredRules());

    /*
     * Seven of these have now been acted on, and this is what that looks like.
     *
     * The original form asserted every UNREACHABLE rule was STILL DECLARED, so that deleting a name
     * failed here and whoever did it found out. That worked exactly as intended on 2026-08-20, when
     * seven were retired.
     *
     * The assertion is now the other way round for those seven, which is the more useful pin: a
     * retired name must STAY retired. Re-declaring one without a producer would put the tally back
     * in the state this whole triage existed to get it out of, a denominator counting names nobody
     * raises. The rules still listed as candidates keep the original assertion.
     */
    const RETIRED = new Set([
        'extract:on-travel', 'cap:summary-truncated', 'cap:migrate-unowned',
        'reject:clocks-full', 'reject:unrooted-move', 'reject:negation', 'reject:not-an-item',
    ]);

    for (const entry of UNREACHABLE) {
        if (RETIRED.has(entry.rule)) {
            test(`${entry.rule} stays retired`, () => {
                expect(declared.has(entry.rule)).toBe(false);
            });
            continue;
        }
        test(`${entry.rule} is still declared in KNOWN_RULES`, () => {
            expect(declared.has(entry.rule)).toBe(true);
        });
    }

    /*
     * The verdict itself. A producer reappearing is not a test failure to route around: it means the
     * rule stopped being a deletion candidate, and the fix is to remove its entry from `UNREACHABLE`
     * above: never to weaken the scan.
     */
    for (const entry of UNREACHABLE) {
        test(`${entry.rule} has no producer`, () => {
            expect(entry.find()).toEqual([]);
            expect(entry.why.length).toBeGreaterThan(0);
        });
    }
});
