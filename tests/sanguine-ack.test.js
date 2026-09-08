import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    GUARD,
    LEDGER,
    MAX_ACK_MARKS,
    WASTE,
    ackSpans,
    countsOf,
    excessMarkKeys,
    newRejects,
    newerThan,
    perTurn,
    shedMarkKeys,
    sortAckKeys,
} from '../public/scripts/extensions/sanguine/reject-table.js';

/*
 * Acknowledgement: clearing a chip without destroying the measurement.
 *
 * The panel footer shows "94 rejected" on the live Wuxia chat and shows it forever, because
 * `state.rejects` is cumulative from turn one. That is the correct shape for the tally, the
 * deletion arguments in `observe.js` and half the docblocks in this extension cite lifetime figures
 * by name, and the wrong shape for a chip whose job is to say "something new happened".
 *
 * The obvious implementation is to zero the counters, and it is the one that must never ship. So
 * acknowledgement is a WATERMARK: a copy of the counts as they stood, subtracted from the live ones.
 * Every property below is a way that subtraction can quietly produce a wrong number, and each one is
 * reachable from a real blob rather than invented:
 *
 *   · counters go DOWN. `repairs.revertPass` restores a whole blob snapshot around these tables and
 *     `store.js` pruners shed. A negative must not subtract from an unrelated reason.
 *   · reasons APPEAR. `unusable-steps 7` sits in the live Wuxia blob under a reason string no file
 *     in the extension raises any more, which proves the set is not fixed in either direction.
 *   · the log ROTATES. `LOG_LIMIT` is 120 and its pruner sheds half, so a stored count of extraction
 *     failures decays into a lie while a timestamp does not.
 *   · spans have LENGTH. A raw delta over sixty turns and one over twelve are not comparable, which
 *     is the whole reason the rate exists, and a span of zero turns has no rate at all.
 *
 * The figures used below are the live Wuxia World RPG blob of 2026-08-20 at turn 149, read from
 * `data/default-user/chats`: 94 refusals over eight reasons, 127,765 B of `MAX_FOLD_BYTES` 131,072.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGUINE = path.join(HERE, '../public/scripts/extensions/sanguine');

/** The live Wuxia tally at turn 149, exactly as the blob carries it. */
const WUXIA = [
    { reason: 'unknown-id', count: 24 },
    { reason: 'already-recorded', count: 20 },
    { reason: 'remove-unknown', count: 15 },
    { reason: 'not-mentioned', count: 13 },
    { reason: 'no-change', count: 12 },
    { reason: 'unusable-steps', count: 7 },
    { reason: 'invariant:partition-contradiction', count: 2 },
    { reason: 'already-held', count: 1 },
];

const total = (rows) => rows.reduce((sum, row) => sum + row.count, 0);

describe('the subtraction, on the live tally', () => {
    test('with no mark at all, everything is new', () => {
        expect(total(newRejects(WUXIA, undefined))).toBe(94);
        expect(total(newRejects(WUXIA, {}))).toBe(94);
    });

    test('a mark taken at the current counts leaves nothing outstanding', () => {
        // This is the ask, in one line: acknowledge, and the chip has nothing to draw.
        expect(newRejects(WUXIA, countsOf(WUXIA))).toEqual([]);
    });

    test('only the increase since the mark counts, per reason', () => {
        const mark = countsOf(WUXIA);
        const later = WUXIA.map(row => (row.reason === 'unknown-id'
            ? { ...row, count: row.count + 6 }
            : row));
        expect(newRejects(later, mark)).toEqual([{ reason: 'unknown-id', count: 6 }]);
    });

    test('a reason that did not exist at the mark counts in FULL', () => {
        // `unusable-steps` is the live proof that the reason set is not fixed: it sits in the blob
        // at 7 while no file raises it any more. The reverse, a gate added after a mark, is the
        // case here, and a baseline of "absent" must mean zero rather than "ignore this reason".
        const mark = countsOf(WUXIA.filter(row => row.reason !== 'unknown-id'));
        const fresh = newRejects(WUXIA, mark);
        expect(fresh).toContainEqual({ reason: 'unknown-id', count: 24 });
        expect(total(fresh)).toBe(24);
    });

    test('a counter that went DOWN floors at zero and cannot borrow from its neighbours', () => {
        // A restored blob is the real case. `already-recorded` collapses from 20 to 3; if the
        // subtraction were done on totals, that -17 would silently cancel seventeen genuinely new
        // `unknown-id` refusals and the chip would report nothing at all.
        const mark = countsOf(WUXIA);
        const pruned = WUXIA.map((row) => {
            if (row.reason === 'already-recorded') return { ...row, count: 3 };
            if (row.reason === 'unknown-id') return { ...row, count: row.count + 17 };
            return row;
        });
        const fresh = newRejects(pruned, mark);
        expect(fresh).toEqual([{ reason: 'unknown-id', count: 17 }]);
        expect(total(fresh)).toBe(17);
        expect(fresh.every(row => row.count > 0)).toBe(true);
    });

    test('every count going down leaves zero, never a negative sum', () => {
        const mark = countsOf(WUXIA);
        const halved = WUXIA.map(row => ({ ...row, count: Math.floor(row.count / 2) }));
        expect(newRejects(halved, mark)).toEqual([]);
        expect(total(newRejects(halved, mark))).toBe(0);
    });

    test('malformed rows are dropped rather than counted as zero-reason refusals', () => {
        expect(newRejects([{ reason: '', count: 9 }, { count: 4 }, null], {})).toEqual([]);
        expect(newRejects(null, {})).toEqual([]);
    });
});

describe('the log watermark, which has to survive rotation', () => {
    /*
     * `log.js` keeps 120 entries and its pruner sheds the oldest half whenever the blob is over
     * budget. A stored COUNT of extraction failures would therefore decay: shed the seven that were
     * acknowledged and the live count falls below the baseline, so the difference reads zero, or,
     * after the next failure, reads one when two arrived. A timestamp has no such decay.
     */
    const entries = [
        { kind: 'extract', t: 1000 },
        { kind: 'extract', t: 2000 },
        { kind: 'extract', t: 3000 },
        { kind: 'extract', t: 4000 },
    ];

    test('an entry written at the mark itself is already seen', () => {
        expect(newerThan(entries, 2000)).toHaveLength(2);
    });

    test('rotation of the acknowledged entries does not change what is new', () => {
        const before = newerThan(entries, 2000).length;
        // The pruner sheds the oldest half; both survivors are newer than the mark.
        const rotated = entries.slice(2);
        expect(newerThan(rotated, 2000).length).toBe(before);
        expect(before).toBe(2);
    });

    test('rotation that eats UNSEEN entries under-reports rather than inventing new ones', () => {
        // The honest failure direction: an entry shed before it was read is a refusal nobody sees,
        // which is a known cost of a bounded log. What must never happen is the opposite, an old
        // entry reappearing as new, and a timestamp cannot produce that.
        expect(newerThan(entries.slice(0, 3), 2000)).toHaveLength(1);
    });

    test('no mark means every entry is new, and a junk watermark does not hide them', () => {
        expect(newerThan(entries, 0)).toHaveLength(4);
        expect(newerThan(entries, undefined)).toHaveLength(4);
        expect(newerThan(entries, NaN)).toHaveLength(4);
    });
});

describe('the mark history is bounded, and bounded in write order', () => {
    const keys = (n, ts = 1000) => Array.from({ length: n }, (_, i) => `${ts}:${i}`);

    test('nothing is dropped until the bound is passed', () => {
        expect(MAX_ACK_MARKS).toBe(5);
        expect(excessMarkKeys(keys(MAX_ACK_MARKS))).toEqual([]);
    });

    test('past the bound the OLDEST go, so the watermark is always what remains', () => {
        const over = keys(8);
        const dropped = excessMarkKeys(over);
        expect(dropped).toHaveLength(3);
        expect(dropped).toEqual(['1000:0', '1000:1', '1000:2']);
        expect(dropped).not.toContain('1000:7');
    });

    test('keys sort as NUMBERS, a lexicographic sort drops the wrong three at ten marks', () => {
        // '1000:10' sorts before '1000:9' as a string, so a string sort would call the tenth mark
        // the oldest and shed the watermark. Every span in the rate view is a subtraction between
        // two adjacent marks, so a wrong order is not a cosmetic defect.
        const scrambled = ['1000:10', '1000:2', '1000:9', '1000:1', '1000:11'];
        expect(sortAckKeys(scrambled)).toEqual(['1000:1', '1000:2', '1000:9', '1000:10', '1000:11']);
    });

    test('marks written in different milliseconds order by the millisecond first', () => {
        expect(sortAckKeys(['2000:0', '1000:9', '1500:3'])).toEqual(['1000:9', '1500:3', '2000:0']);
    });
});

describe('the pruner sheds history and never the watermark', () => {
    const keys = (n) => Array.from({ length: n }, (_, i) => `1000:${i}`);

    test('one mark is never shed, that one IS the feature', () => {
        expect(shedMarkKeys(keys(1))).toEqual([]);
        expect(shedMarkKeys([])).toEqual([]);
    });

    test('the oldest half of the history goes, and repeated passes converge on one', () => {
        let remaining = keys(5);
        const shed = [];
        for (let pass = 0; pass < 6; pass++) {
            const drop = shedMarkKeys(remaining);
            shed.push(drop.length);
            remaining = remaining.filter(key => !drop.includes(key));
        }
        // Three passes to converge, and the three after them free nothing, which is what stops
        // `store.js` runBudgetPasses spinning on a table it can no longer shed.
        expect(shed).toEqual([2, 1, 1, 0, 0, 0]);
        expect(remaining).toEqual(['1000:4']);
    });

    test('what it sheds is always the front of the write order', () => {
        expect(shedMarkKeys(keys(5))).toEqual(['1000:0', '1000:1']);
    });
});

describe('the pruner sits between the diagnostics log and repair state', () => {
    /*
     * Read out of the source rather than asserted against a copy of the number, because the whole
     * argument is a RELATIVE placement: the diagnostics log goes first because it is large and
     * regenerating (35 KiB of Wuxia's 117 KiB blob, refilled by the next pass), and a mark goes
     * after it because it does not regenerate at all, the counters are cumulative, so "the tally
     * stood at 94 when I looked" exists only because somebody wrote it down at that moment.
     */
    const store = fs.readFileSync(path.join(SANGUINE, 'store.js'), 'utf8');
    const state = fs.readFileSync(path.join(SANGUINE, 'state.js'), 'utf8');
    const constant = (text, name) => {
        const hit = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text);
        expect(hit).not.toBeNull();
        return Number(hit[1]);
    };

    test('the source still declares the three orders this gate compares', () => {
        expect(constant(store, 'PRUNE_DIAGNOSTICS')).toBe(10);
        expect(constant(store, 'PRUNE_REPAIRS')).toBe(20);
        expect(constant(store, 'PRUNE_ARCHIVE')).toBe(50);
    });

    test('acknowledgement marks yield after the debug log and before repair state', () => {
        const marks = constant(state, 'PRUNE_ACK_MARKS');
        expect(marks).toBeGreaterThan(constant(store, 'PRUNE_DIAGNOSTICS'));
        expect(marks).toBeLessThan(constant(store, 'PRUNE_REPAIRS'));
        expect(marks).toBeLessThan(constant(store, 'PRUNE_ARCHIVE'));
    });

    test('and state.js actually registers a pruner at that order', () => {
        expect(state).toMatch(/registerPruner\([\s\S]*?\}, PRUNE_ACK_MARKS\);/);
        // The storage half must use the tested decision, not a second copy of it inline.
        expect(state).toMatch(/shedMarkKeys\(/);
    });
});

describe('the rate, which is the only comparable form', () => {
    const mark = (at, counts, caps = 0) => ({ ts: at * 1000, at, r: counts, c: caps });

    test('a rate is a division, and a span of no turns is not one', () => {
        expect(perTurn(12, 24)).toBeCloseTo(0.5, 10);
        expect(perTurn(0, 24)).toBe(0);
        // Acknowledging twice without playing between is one click and a second thought. `null`
        // rather than Infinity or 0 because both of those read as measurements and neither is one.
        expect(perTurn(12, 0)).toBeNull();
        expect(perTurn(12, -4)).toBeNull();
        expect(perTurn(12, undefined)).toBeNull();
    });

    test('the oldest span runs from turn zero, so the first mark has a baseline to be one against', () => {
        const marks = [mark(76, { 'unknown-id': 16, 'already-recorded': 15 })];
        const live = mark(149, countsOf(WUXIA), 204);
        const spans = ackSpans(marks, live);
        expect(spans).toHaveLength(2);
        // Newest first.
        expect(spans[0].open).toBe(true);
        expect(spans[0].turns).toBe(73);
        expect(spans[1].open).toBe(false);
        expect(spans[1].turns).toBe(76);
        expect(spans[1].split.total).toBe(31);
        expect(perTurn(spans[1].split.total, spans[1].turns)).toBeCloseTo(31 / 76, 10);
    });

    test('a delta is not comparable across spans and the rate is, the whole point', () => {
        // 41 refusals over 60 turns, then 12 over 12. The second span is the smaller number and
        // nearly twice the rate; a surface showing deltas would report an improvement.
        const marks = [mark(60, { 'no-change': 41 }), mark(72, { 'no-change': 53 })];
        const live = mark(72, { 'no-change': 53 });
        const spans = ackSpans(marks, live);
        const closed = spans.filter(span => !span.open);
        expect(closed.map(span => span.split.total)).toEqual([12, 41]);
        expect(perTurn(41, 60)).toBeCloseTo(0.68, 2);
        expect(perTurn(12, 12)).toBeCloseTo(1.00, 2);
    });

    test('the open span carries a zero-turn rate rather than dividing by zero', () => {
        const marks = [mark(149, countsOf(WUXIA), 204)];
        const live = mark(149, countsOf(WUXIA), 204);
        const spans = ackSpans(marks, live);
        expect(spans[0].open).toBe(true);
        expect(spans[0].turns).toBe(0);
        expect(spans[0].split.total).toBe(0);
        expect(perTurn(spans[0].split.total, spans[0].turns)).toBeNull();
        expect(Number.isNaN(perTurn(spans[0].split.total, spans[0].turns))).toBe(false);
    });

    test('a restored blob moving the turn backwards cannot invert a rate', () => {
        const marks = [mark(149, {})];
        const live = mark(40, { 'no-change': 5 });
        const spans = ackSpans(marks, live);
        expect(spans[0].turns).toBe(0);
        expect(perTurn(spans[0].split.total, spans[0].turns)).toBeNull();
    });

    test('caps are floored in aggregate, which is what one stored integer can promise', () => {
        const marks = [mark(76, {}, 204)];
        // A pruned or restored blob: the cap counters came down. Nothing negative reaches the view.
        expect(ackSpans(marks, mark(149, {}, 40))[0].dropped).toBe(0);
        expect(ackSpans(marks, mark(149, {}, 605))[0].dropped).toBe(401);
    });

    test('with no marks at all there is exactly one span, and no comparison is implied', () => {
        const spans = ackSpans([], mark(149, countsOf(WUXIA), 204));
        expect(spans).toHaveLength(1);
        expect(spans[0].open).toBe(true);
        expect(spans[0].split.total).toBe(94);
    });
});

describe('the class split travels with every span', () => {
    /*
     * Guard and waste move for different reasons, a guard firing more often is the model getting
     * sloppier, waste firing more often is fold asking worse, so a combined rate can hold a waste
     * regression flat under a guard improvement and show no change at all. The live Wuxia tally is
     * the case in point: 36 of its 94 are waste and 56 are guards, and only the 36 have a fix on
     * this side of the wire.
     */
    test('the live tally splits 36 wasted / 56 guarded / 2 ledger', () => {
        const spans = ackSpans([], { ts: 0, at: 149, r: countsOf(WUXIA), c: 204 });
        expect(spans[0].split[WASTE]).toBe(36);
        expect(spans[0].split[GUARD]).toBe(56);
        expect(spans[0].split[LEDGER]).toBe(2);
        expect(spans[0].split.total).toBe(94);
        expect(spans[0].reasons).toBe(8);
    });

    test('a waste regression under a guard improvement is invisible in the combined rate', () => {
        // 30 guards become 10 while 6 wasted answers become 26: the total is unchanged at 36, and
        // the one number a reader could act on has quadrupled.
        const before = { 'already-recorded': 30, 'unknown-id': 6 };
        const after = { 'already-recorded': 40, 'unknown-id': 32 };
        const spans = ackSpans([{ ts: 0, at: 10, r: before, c: 0 }], { ts: 0, at: 20, r: after, c: 0 });
        expect(spans[0].split.total).toBe(36);
        expect(spans[0].split[WASTE]).toBe(26);
        expect(spans[0].split[GUARD]).toBe(10);
        expect(perTurn(spans[0].split[WASTE], spans[0].turns)).toBeCloseTo(2.6, 10);
    });
});

describe('countsOf, which is what a mark stores', () => {
    test('rows in, baseline out, and back again through newRejects', () => {
        expect(countsOf(WUXIA)['unknown-id']).toBe(24);
        expect(Object.keys(countsOf(WUXIA))).toHaveLength(8);
        expect(newRejects(WUXIA, countsOf(WUXIA))).toEqual([]);
    });

    test('junk in a stored blob does not become a reason', () => {
        expect(countsOf([{ reason: '', count: 3 }, null, undefined])).toEqual({});
        expect(countsOf(null)).toEqual({});
        expect(countsOf([{ reason: 'x' }])).toEqual({ x: 0 });
    });
});

describe('a mark fits the budget it rides in', () => {
    /*
     * `store.js` MAX_FOLD_BYTES is 128 KiB and the live Wuxia blob is 127,765 B of it, 3,307 bytes
     * of headroom on the fullest chat in the corpus. Five marks have to fit inside that without
     * evicting anything, or the feature pays for itself with the chronicle it is measuring.
     */
    test('five marks of the live tally cost under a fifth of that chat\'s remaining headroom', () => {
        const mark = { ts: 1755000000000, at: 149, r: countsOf(WUXIA), c: 204 };
        const one = Buffer.byteLength(JSON.stringify(mark));
        const table = Object.fromEntries(
            Array.from({ length: MAX_ACK_MARKS }, (_, i) => [`${1755000000000 + i}:${i}`, mark]));
        const five = Buffer.byteLength(JSON.stringify(table));
        expect(one).toBeLessThan(400);
        // 3,307 bytes is the measured headroom on Wuxia 2026-08-20. Under half of it, with the
        // pruner able to take four fifths of what is left back at any time.
        expect(five).toBeLessThan(1650);
    });

    test('a per-rule cap baseline would have cost more than the reasons do', () => {
        // Why `c` is one integer: the caps population is rendered as ONE figure and never per rule,
        // so per-rule baselines would be storage nothing reads. The nine cap rules on the same live
        // chat measure the size of that choice.
        const perRule = {
            'cap:opening-unread': 97, 'cap:places-archived': 27, 'cap:threads-pruned': 26,
            'cap:entities-pruned': 18, 'cap:cast-archived': 18, 'cap:context-stale': 11,
            'cap:keywords-dropped': 5, 'cap:duplicate-suppressed': 1, 'cap:mirror-shed': 1,
        };
        expect(Buffer.byteLength(JSON.stringify(perRule)))
            .toBeGreaterThan(Buffer.byteLength(JSON.stringify({ c: 204 })) * 10);
    });
});
