import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import {
    CAP,
    GUARD,
    LEDGER,
    WASTE,
    classifiedReasons,
    classifyRejects,
    rejectClass,
    rejectHelp,
} from '../public/scripts/extensions/sanguine/reject-table.js';

/*
 * The refusal-class gate.
 *
 * `rejectClass` answers what a refusal MEANS: the record was protected (GUARD), an answer was lost
 * to how fold asked (WASTE), a table was full (CAP), or the ledger contradicts itself with no model
 * involved (LEDGER). Only WASTE has a fix on this side of the wire.
 *
 * Unknown reasons fall back to GUARD, which is the safe default for a reader, "nothing to do",
 * and exactly the wrong default for a maintainer, because a genuinely wasteful new gate would hide
 * inside the reassuring bucket forever. This gate is what makes the fallback safe: every reason
 * `rejectHelp` bothers to explain must also declare what it means.
 *
 * The measurement that motivated the split, live Wuxia chat 2026-08-20 at turn 76: 51 refusals, of
 * which 22 were guards protecting the record and 16 were one confusing block throwing answers away.
 * One total, one colour, and the reader is pointed at the wrong half.
 */

const SANGUINE = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');

/** Every reason literal fold actually files, read out of the source. */
function reasonsInSource() {
    const found = new Set();
    for (const file of fs.readdirSync(SANGUINE).filter(name => name.endsWith('.js'))) {
        const text = fs.readFileSync(path.join(SANGUINE, file), 'utf8');
        for (const hit of text.matchAll(/reason:\s*'([a-z][a-z0-9:-]+)'/g)) {
            found.add(hit[1]);
        }
    }
    return found;
}

describe('every refusal declares what it means', () => {
    test('each explained reason has a class, the GUARD fallback cannot swallow a new gate', () => {
        const declared = new Set(classifiedReasons());
        const explained = [...reasonsInSource()].filter(reason =>
            // A reason with no help line is its own (pre-existing) gap and not this gate's business;
            // one that fold bothered to explain is one a reader will meet.
            rejectHelp(reason) !== rejectHelp('__no_such_reason__'));
        const undeclared = explained.filter(reason => !declared.has(reason) && !reason.startsWith('invariant:'));
        expect(undeclared).toEqual([]);
    });

    test('the source-scan is still finding reasons, so the gate above is not vacuous', () => {
        const found = reasonsInSource();
        expect(found.size).toBeGreaterThan(15);
        expect(found).toContain('already-recorded');
        expect(found).toContain('unknown-id');
    });
});

describe('the four classes say different things about what to do', () => {
    test('a guard protected the record and asks nothing of anyone', () => {
        // Its docblock cites the spear billed twice, the room twice, the locket twice.
        expect(rejectClass('already-recorded')).toBe(GUARD);
        expect(rejectClass('remove-unknown')).toBe(GUARD);
        expect(rejectClass('not-mentioned')).toBe(GUARD);
    });

    test('waste is the only class whose fix is on this side of the wire', () => {
        expect(rejectClass('unknown-id')).toBe(WASTE);
        expect(rejectClass('no-change')).toBe(WASTE);
        expect(rejectClass('duplicate-id')).toBe(WASTE);
    });

    test('a cap is a budget signal, not a bad answer', () => {
        expect(rejectClass('threads-full')).toBe(CAP);
        expect(rejectClass('inventory-full')).toBe(CAP);
        expect(rejectClass('rate-limited')).toBe(CAP);
    });

    test('an invariant had no model in it at all, whatever the witness is called', () => {
        expect(rejectClass('invariant:overdraw')).toBe(LEDGER);
        // The namespace, not the list: a witness kind added later is still a ledger contradiction.
        expect(rejectClass('invariant:some-witness-added-later')).toBe(LEDGER);
    });

    test('an unknown reason reads as GUARD, nothing to do, rather than as an accusation', () => {
        expect(rejectClass('a-gate-nobody-classified')).toBe(GUARD);
        expect(rejectClass('')).toBe(GUARD);
        expect(rejectClass(undefined)).toBe(GUARD);
    });
});

describe('the split, on the measurement that motivated it', () => {
    test('the live Wuxia tally divides 51 into 22 protecting and 16 wasted', () => {
        const split = classifyRejects([
            { reason: 'unknown-id', count: 16 },
            { reason: 'already-recorded', count: 15 },
            { reason: 'no-change', count: 12 },
            { reason: 'remove-unknown', count: 4 },
            { reason: 'not-mentioned', count: 3 },
            { reason: 'invariant:partition-contradiction', count: 1 },
        ]);
        expect(split.total).toBe(51);
        expect(split[GUARD]).toBe(22);
        expect(split[WASTE]).toBe(28);
        expect(split[LEDGER]).toBe(1);
        expect(split[CAP]).toBe(0);
    });

    test('an empty tally is all zeroes rather than a crash', () => {
        expect(classifyRejects([]).total).toBe(0);
        expect(classifyRejects(undefined).total).toBe(0);
    });
});
