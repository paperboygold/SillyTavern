import { describe, expect, test } from '@jest/globals';

import { HEALTH_PROSE, SHADOW, domainOf, readDial, routeBlockFields } from '../public/scripts/extensions/fold/absorb-table.js';
import { classifyBlock, parseStateBlock } from '../public/scripts/extensions/fold/block-parse.js';
import { HEALTH_LABELS } from '../public/scripts/extensions/fold/state-table.js';
import { DOOM, PRESSURE_LABELS, threadsByKind } from '../public/scripts/extensions/fold/thread-table.js';
import { LEAD_LABELS } from '../public/scripts/extensions/fold/entity-table.js';

/*
 * Block fields that shadow structured tables are routed, never parked — FOLD-REDESIGN.md §5.
 *
 * The measured defect: at message 72 of the live Solo Leveling chat the residency stake existed in
 * THREE representations at once — a lead row, a clock row, and `pressure: "19 raids remaining in
 * twelve-month window"` — and the prose copy outranked the structured ones on trust, because
 * `src: block` wins for CONTEXT_OVERRIDE_AFTER turns. The fixture below is that header's own
 * `leads`, `pressure` and `health` fields, copied out of `solo-leveling.backup2.jsonl`.
 */

/** The three shadowing fields the pre-repair2 header actually carried. */
const HEADER = new Map([
    ['leads', 'bug bounty submitted, awaiting payment; Kang\'s squad — next D-raid pending; Jin-Woo — IT offer pending his decision; 1 of 20 D-rank raids logged; residency window open, sponsorship active'],
    ['pressure', '19 raids remaining in twelve-month window'],
    ['health', 'lacerations cleaned and bandaged, left arm heavily bruised but functional, mild fatigue, possible infection monitored'],
    ['location', 'the broker\'s shop'],
    ['rank', 'E-Rank Hunter (Class undetermined)'],
]);

describe('zero new context keys for a label that names a structured domain', () => {
    test('leads, pressure and health all leave context; everything else stays', () => {
        const table = new Map();
        const { keep, shadow } = routeBlockFields(HEADER, table, { turn: 14 });

        expect([...keep.keys()]).toEqual(['location', 'rank']);
        expect(keep.has('leads')).toBe(false);
        expect(keep.has('pressure')).toBe(false);
        expect(keep.has('health')).toBe(false);
        // Nothing routed silently vanished: everything refused is in `shadow`, verbatim.
        expect(shadow.length).toBeGreaterThan(0);
    });

    test('the leads field becomes threads through the exposition gate', () => {
        const table = new Map();
        const { routed } = routeBlockFields(HEADER, table, { turn: 14 });
        expect(routed).toBeGreaterThan(0);

        const open = threadsByKind(table, 14).open.map(row => row.name);
        // "bug bounty submitted, awaiting payment" carries `awaiting`; "Jin-Woo — IT offer pending
        // his decision" carries `pending`. Both name something genuinely unsettled.
        expect(open.join(' | ')).toContain('awaiting payment');
        expect(open.join(' | ')).toContain('pending');
        // And every routed thread says where it came from, so a reader can tell a card's claim from
        // the model's reading of the prose.
        expect(threadsByKind(table, 14).open.every(row => row.source === 'card block, leads')).toBe(true);
    });

    test('what the gate refuses is kept verbatim, not truncated to its key', () => {
        const table = new Map();
        const { shadow } = routeBlockFields(HEADER, table, { turn: 14 });
        const refused = shadow.filter(entry => entry.reason === SHADOW).map(entry => entry.text);
        // The pressure clause is refused for stating no dial position — a structural refusal, not a
        // word judgement ("19 raids remaining in twelve-month window" contains two numbers and no
        // dial; guessing which is the fill is the inference that produced the inverted residency
        // clock). The card's DECLARED leads are honored: `leads:` is a protocol field, and whether a
        // stated lead duplicates a tracked thread is the identity/review question, not a word list's.
        expect(refused).toEqual(['19 raids remaining in twelve-month window']);
        // The rejection reports a name `normalizeThreadName` has already truncated to
        // MAX_THREAD_NAME; what is preserved has to be the clause the card actually wrote, which is
        // why every refusal is a substring of the field the card emitted.
        expect(refused.every(text => HEADER.get('leads').includes(text) || HEADER.get('pressure').includes(text))).toBe(true);
    });

    test('the pressure field is refused because it states no position', () => {
        // "19 raids remaining in twelve-month window" contains two numbers and no dial. Guessing
        // which one is the fill is the inference that produced the inverted residency clock
        // (FOLD-REDESIGN.md §0.1-3), so it is refused and kept for the review to look at.
        const table = new Map();
        const { shadow } = routeBlockFields(new Map([['pressure', HEADER.get('pressure')]]), table, { turn: 14 });
        expect(table.size).toBe(0);
        expect(shadow).toEqual([{ label: 'pressure', reason: SHADOW, text: '19 raids remaining in twelve-month window' }]);
    });

    test('a pressure field that DOES state a position becomes a doom dial', () => {
        // The two clocks the first hand repair deleted: "goblin nest counterattacks 1/4" and
        // "the party is overwhelmed 1/6" (FOLD-RPG-GAP.md §0).
        const table = new Map();
        const { routed, shadow } = routeBlockFields(
            new Map([['pressure', 'goblin nest counterattacks 1/4; the party is overwhelmed 1/6']]),
            table, { turn: 3 });
        expect(routed).toBe(2);
        expect(shadow).toEqual([]);
        const dials = threadsByKind(table, 3).pressure;
        expect(dials.map(row => `${row.name} ${row.filled}/${row.dial.size}`).sort())
            .toEqual(['goblin nest counterattacks 1/4', 'the party is overwhelmed 1/6']);
        expect(dials.every(row => row.dial.kind === DOOM)).toBe(true);
    });

    test('a restated dial position is idempotent, which a tick could never be', () => {
        // The `setQty` argument applied to dials: a block is re-sent every turn, so folding the same
        // stated total twice has to be a no-op. `foldTicks` refuses zero as `no-change` and
        // accumulates everything else, which is the wrong face for a restatement.
        const table = new Map();
        const field = new Map([['pressure', 'goblin nest counterattacks 2/4']]);
        routeBlockFields(field, table, { turn: 3 });
        routeBlockFields(field, table, { turn: 4 });
        routeBlockFields(field, table, { turn: 5 });
        expect(table.get('goblin nest counterattacks').filled).toBe(2);
    });

    test('the health field routes to the status pipeline and is not ALSO parked', () => {
        const table = new Map();
        const { keep, shadow } = routeBlockFields(new Map([['health', HEADER.get('health')]]), table, { turn: 14 });
        expect(keep.size).toBe(0);
        // Kept verbatim all the same: `splitConditions` drops reassurances and long statements, and
        // "bruised but functional" says something a set of flags cannot.
        expect(shadow).toEqual([{ label: 'health', reason: HEALTH_PROSE, text: HEALTH_LABELS.has('health') ? HEADER.get('health') : '' }]);
    });

    test('inventory is untouched — it already has the restated-totals path', () => {
        const table = new Map();
        const { keep } = routeBlockFields(new Map([['inventory', 'knife, licence, pamphlet']]), table, { turn: 1 });
        // `classifyBlock` takes inventory labels before this function ever sees them, so an
        // inventory label reaching here at all would be a bug in the caller, not in the routing.
        expect(domainOf('inventory')).toBe('');
        expect(keep.has('inventory')).toBe(true);
    });
});

describe('the duplicated health list agrees with block-parse, which owns it', () => {
    /*
     * `HEALTH_LABELS` is a second copy of a private set in `block-parse.js` — that file is Phase D's
     * and exporting from it now would put a shared symbol in two phases at once. A duplicated list
     * is only permissible with a test that fails the moment the two disagree, so this drives the
     * real `classifyBlock` with every member.
     */
    test('every label in the copy routes to conditions in the original', () => {
        for (const label of HEALTH_LABELS) {
            const head = label[0].toUpperCase() + label.slice(1);
            const fields = parseStateBlock(`He sits down.\n\n[${head}: poisoned]`);
            expect(fields).not.toBeNull();
            const { conditions, context } = classifyBlock(fields);
            expect(conditions).toContain('poisoned');
            // And the second half of the defect: `classifyBlock` ALSO parks it, which is what
            // `routeBlockFields` now undoes. Asserted so a change to either side is visible here.
            expect(context.has(label)).toBe(true);
        }
    });

    test('and a label that is not in it does not', () => {
        const fields = parseStateBlock('He sits down.\n\n[Weather: overcast]');
        expect(classifyBlock(fields).conditions).toEqual([]);
    });
});

describe('readDial is narrow on purpose', () => {
    test('it reads the shapes a card actually writes', () => {
        expect(readDial('goblin nest counterattacks 1/4')).toEqual({ name: 'goblin nest counterattacks', filled: 1, size: 4 });
        expect(readDial('the party is overwhelmed (1/6)')).toEqual({ name: 'the party is overwhelmed', filled: 1, size: 6 });
        expect(readDial('twenty raids logged 1 of 20')).toEqual({ name: 'twenty raids logged', filled: 1, size: 20 });
    });

    test('and refuses everything else rather than guessing which number is the fill', () => {
        expect(readDial('19 raids remaining in twelve-month window')).toBeNull();
        expect(readDial('the gate closes soon')).toBeNull();
        expect(readDial('5/2')).toBeNull();
        expect(readDial('')).toBeNull();
    });
});

describe('domainOf covers the label sets the design names', () => {
    test('each set maps to its own domain', () => {
        expect(LEAD_LABELS.every(label => domainOf(label) === 'leads')).toBe(true);
        expect(PRESSURE_LABELS.every(label => domainOf(label) === 'pressure')).toBe(true);
        expect([...HEALTH_LABELS].every(label => domainOf(label) === 'health')).toBe(true);
    });

    test('a label fold has no structure for falls through, which was always context\'s job', () => {
        expect(domainOf('weather')).toBe('');
        expect(domainOf('mana')).toBe('');
        expect(domainOf('')).toBe('');
    });
});
