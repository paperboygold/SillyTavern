import { describe, expect, test } from '@jest/globals';

import {
    BY_CLOCK,
    BY_TURN,
    MAX_FLOWS,
    MAX_PERIODS,
    accrue,
    applyFlows,
    emptyIn,
    flowFace,
    flowRuler,
    foldFlow,
    netRate,
    normalizeFlow,
    parseFlow,
    periodsOf,
    renderFlows,
    resumeFrom,
} from '../public/scripts/extensions/sanguine/flow-table.js';
import { itemKey } from '../public/scripts/extensions/sanguine/state-table.js';

const DAY = 1440;
const WEEK = DAY * 7;

/** A flow table holding one row. */
const table = (...rows) => {
    const map = new Map();
    for (const row of rows) foldFlow(map, row);
    return map;
};

/** The canonical weekly rent. */
const rent = (over = {}) => ({ label: 'rent', item: 'gold', at: 'money', dq: -400, per: '1 week', from: 0, ...over });

/** An inventory in the shape `deriveState` returns. */
const inv = (rows) => new Map(Object.entries(rows).map(([key, qty]) => [key, { qty }]));

describe('normalizeFlow, exactly one ruler, never two and never none', () => {
    test('a span-denominated rate is read against the clock', () => {
        const row = normalizeFlow(rent());
        expect(row.per).toBe('1 week');
        expect(row.every).toBeUndefined();
        expect(flowRuler(row)).toEqual({ coord: BY_CLOCK, size: WEEK });
    });

    test('a turn-denominated rate is read against exchanges', () => {
        const row = normalizeFlow({ label: 'training', item: 'qi', dq: 18, every: 4 });
        expect(row.every).toBe(4);
        expect(row.per).toBeUndefined();
        expect(flowRuler(row)).toEqual({ coord: BY_TURN, size: 4 });
    });

    test('both rulers at once is refused, that is a row with two rates', () => {
        expect(normalizeFlow({ label: 'rent', item: 'gold', dq: -400, per: '1 week', every: 4 })).toBeNull();
    });

    test('neither ruler is refused, that is a row that silently never fires', () => {
        expect(normalizeFlow({ label: 'rent', item: 'gold', dq: -400 })).toBeNull();
        // An unparseable span is not a span, so it does not satisfy the union either.
        expect(normalizeFlow({ label: 'rent', item: 'gold', dq: -400, per: 'whenever' })).toBeNull();
    });

    test('a row with no name and a row with no item are both refused', () => {
        expect(normalizeFlow({ label: '', item: 'gold', dq: -1, per: '1 day' })).toBeNull();
        expect(normalizeFlow({ label: 'rent', item: '', dq: -1, per: '1 day' })).toBeNull();
    });

    test('the story\'s own casing survives, as it does for an inventory row', () => {
        expect(normalizeFlow({ label: 'the SIG', item: 'SIG P226 rounds', dq: -1, every: 3 }))
            .toMatchObject({ item: 'sig p226 rounds', display: 'SIG P226 rounds' });
    });
});

describe('the position law, a pure reading, recomputed whole every fold', () => {
    test('a flow with no origin contributes nothing, rather than everything', () => {
        // `from` is written when the row is created. A row that never got one must not be read as
        // having run since the beginning of time.
        const flows = table(rent({ from: undefined }));
        expect(accrue(flows, { clock: 400 * DAY, seen: 90 }).wants.size).toBe(0);
    });

    test('accrual is a pure reading, the same input twice gives the same answer', () => {
        // This is what REPLACES an idempotence argument rather than restating one. The first design
        // advanced each row as it paid, which is a write on a path that runs on every panel render;
        // nothing is advanced now, so running twice cannot mean anything different from running
        // once. Idempotence is the absence of the write, not a property argued about it.
        const flows = table(rent());
        const key = itemKey('gold', 'money', '');
        expect(accrue(flows, { clock: 3 * WEEK, seen: 0 }).wants.get(key).want).toBe(-1200);
        expect(accrue(flows, { clock: 3 * WEEK, seen: 0 }).wants.get(key).want).toBe(-1200);
        // And the row it read is untouched, no position moved, nothing to commit.
        expect(flows.get('rent')).toEqual(normalizeFlow(rent()));
    });

    test('the contribution is the WHOLE history, so it grows with the clock', () => {
        const flows = table(rent());
        const key = itemKey('gold', 'money', '');
        expect(accrue(flows, { clock: WEEK, seen: 0 }).wants.get(key).want).toBe(-400);
        expect(accrue(flows, { clock: 12 * WEEK, seen: 0 }).wants.get(key).want).toBe(-4800);
        expect(accrue(flows, { clock: 100 * WEEK, seen: 0 }).wants.get(key).want).toBe(-40000);
    });

    test('a long skip settles in ONE contribution, not one per period', () => {
        const out = accrue(table(rent()), { clock: 12 * WEEK, seen: 0 });
        expect(out.wants.size).toBe(1);
    });

    test('a part-period owes nothing, and the remainder is not lost', () => {
        expect(accrue(table(rent()), { clock: WEEK - 1, seen: 0 }).wants.size).toBe(0);
        expect(periodsOf(normalizeFlow(rent()), { clock: WEEK + 3 * DAY })).toBe(1);
        // The three days in hand still count toward the next period, because the origin never moved.
        expect(periodsOf(normalizeFlow(rent()), { clock: 2 * WEEK })).toBe(2);
    });

    test('a ruler that goes BACKWARDS re-prices on the spot, and never owes a negative', () => {
        // `setClockByHand` deliberately bypasses the monotone guards, because a player correcting a
        // drift is often correcting it downwards. With no stored position there is nothing left over
        // to disagree with the correction: the whole accrual is simply recomputed smaller.
        const flows = table(rent({ from: 5 * WEEK }));
        expect(accrue(flows, { clock: 2 * WEEK, seen: 0 }).wants.size).toBe(0);
        expect(periodsOf(flows.get('rent'), { clock: 2 * WEEK })).toBe(0);
        // The Raccoon City repair, in miniature: a clock corrected from day 11 back to day 3 must
        // shrink what the ledger claims, not freeze it.
        expect(periodsOf(flows.get('rent'), { clock: 11 * WEEK })).toBe(6);
        expect(periodsOf(flows.get('rent'), { clock: 7 * WEEK })).toBe(2);
    });

    test('MAX_PERIODS is a backstop against nonsense, far above real play', () => {
        // The corpus reaches day 12,985 legitimately, thirty years genuinely pass in one campaign,
        // so a bound that refused that would be refusing the premise. This only stops arithmetic.
        expect(periodsOf(normalizeFlow(rent()), { clock: 12985 * DAY })).toBe(1855);
        const out = accrue(table(rent()), { clock: MAX_PERIODS * WEEK * 4, seen: 0 });
        expect(out.capped).toHaveLength(1);
        expect(out.wants.get(itemKey('gold', 'money', '')).want).toBe(-400 * MAX_PERIODS);
    });
});

describe('suspension is an expiry you can undo', () => {
    test('a suspended flow freezes at what it had earned, it does not keep running', () => {
        const flow = normalizeFlow(rent({ on: false, offAt: 3 * WEEK }));
        expect(periodsOf(flow, { clock: 3 * WEEK })).toBe(3);
        expect(periodsOf(flow, { clock: 50 * WEEK })).toBe(3);
    });

    test('and it does not lose what it had earned either', () => {
        // The trap in the simple version: reset the origin on resume and the ten weeks of rent that
        // were genuinely paid before the shop shut for winter silently vanish.
        const key = itemKey('gold', 'money', '');
        const out = accrue(table(rent({ on: false, offAt: 10 * WEEK })), { clock: 40 * WEEK, seen: 0 });
        expect(out.wants.get(key).want).toBe(-4000);
    });

    test('resuming shifts the origin by exactly the span it sat out', () => {
        const flow = normalizeFlow(rent({ on: false, offAt: 10 * WEEK }));
        // Off for six weeks. The origin moves forward six weeks, so the gap is free and the next
        // period falls due one week after resuming rather than immediately.
        expect(resumeFrom(flow, 16 * WEEK)).toBe(6 * WEEK);
        const back = normalizeFlow(rent({ from: resumeFrom(flow, 16 * WEEK) }));
        expect(periodsOf(back, { clock: 16 * WEEK })).toBe(10);
        expect(periodsOf(back, { clock: 17 * WEEK })).toBe(11);
    });

    test('suspended for ten weeks then resumed pays for none of them', () => {
        // The gate the whole horizon design exists for. Ten weeks off must cost nothing and earn
        // nothing; the counter picks up exactly where it stopped.
        const flow = normalizeFlow(rent({ on: false, offAt: 2 * WEEK }));
        const resumed = normalizeFlow(rent({ from: resumeFrom(flow, 12 * WEEK) }));
        expect(periodsOf(resumed, { clock: 12 * WEEK })).toBe(2);
    });

    test('a suspended row with no suspension point earns nothing, the safe reading', () => {
        expect(periodsOf(normalizeFlow(rent({ on: false })), { clock: 50 * WEEK })).toBe(0);
    });
});

describe('expiry clamps the horizon, and needs no cleanup pass', () => {
    test('a flow that ended pays the periods it was ALIVE for during a later catch-up', () => {
        const out = accrue(table(rent({ until: 4 * WEEK })), { clock: 10 * WEEK, seen: 0 });
        expect(out.wants.get(itemKey('gold', 'money', '')).want).toBe(-1600);
    });

    test('and then stops forever, by arithmetic and with no cleanup pass', () => {
        const flow = normalizeFlow(rent({ until: 4 * WEEK }));
        expect(periodsOf(flow, { clock: 99 * WEEK })).toBe(4);
        expect(periodsOf(flow, { clock: 9999 * WEEK })).toBe(4);
        // The row survives as a legible record of what it was, rather than being swept away.
        expect(flow.label).toBe('rent');
    });

    test('a part-period at the end does not pay', () => {
        const out = accrue(table(rent({ until: 4 * WEEK + 3 * DAY })), { clock: 99 * WEEK, seen: 0 });
        expect(out.wants.get(itemKey('gold', 'money', '')).want).toBe(-1600);
    });
});

describe('both rulers answer the same law', () => {
    const clockRow = { label: 'rations', item: 'rations', at: 'carried', dq: -2, per: '1 day', from: 0 };
    const turnRow = { label: 'rations', item: 'rations', at: 'carried', dq: -2, every: 8, from: 0 };

    test('eight exchanges is to a turn-flow what one day is to a clock-flow', () => {
        const byClock = accrue(table(clockRow), { clock: 5 * DAY, seen: 0 });
        const byTurn = accrue(table(turnRow), { clock: 0, seen: 40 });
        const key = itemKey('rations', 'carried', '');
        expect(byClock.wants.get(key).want).toBe(-10);
        expect(byTurn.wants.get(key).want).toBe(-10);
    });

    test('a turn-flow ignores the clock entirely, and a clock-flow ignores the turns', () => {
        // The point of carrying both: the corpus spans four orders of magnitude of narrative time
        // per message, so a montage campaign and a four-day siege need different rulers.
        expect(accrue(table(turnRow), { clock: 900 * DAY, seen: 0 }).wants.size).toBe(0);
        expect(accrue(table(clockRow), { clock: 0, seen: 900 }).wants.size).toBe(0);
    });

    test('a missing ruler reading is skipped rather than treated as zero', () => {
        expect(accrue(table(clockRow), { clock: NaN, seen: 40 }).wants.size).toBe(0);
        expect(accrue(table(turnRow), { clock: 5 * DAY, seen: NaN }).wants.size).toBe(0);
    });
});

describe('coalescing, one target, one movement, whatever the map order', () => {
    const income = { label: 'the tea house', item: 'gold', at: 'money', dq: 1000, per: '1 week', from: 0 };
    const levy = { label: 'the war levy', item: 'gold', at: 'money', dq: -300, per: '1 week', from: 0 };

    test('two rows on one target net out into a single change', () => {
        const out = accrue(table(income, levy), { clock: WEEK, seen: 0 });
        expect(out.wants.size).toBe(1);
        expect(out.wants.get(itemKey('gold', 'money', '')).want).toBe(700);
    });

    test('and the answer does not depend on which was written first', () => {
        const forward = accrue(table(income, levy), { clock: WEEK, seen: 0 });
        const backward = accrue(table(levy, income), { clock: WEEK, seen: 0 });
        const key = itemKey('gold', 'money', '');
        expect(forward.wants.get(key).want).toBe(backward.wants.get(key).want);
    });

    test('both contributors are named, so the panel can explain the number', () => {
        const out = accrue(table(income, levy), { clock: WEEK, seen: 0 });
        expect(out.wants.get(itemKey('gold', 'money', '')).labels.sort()).toEqual(['the tea house', 'the war levy']);
    });

    test('two rows on different beats still coalesce into one movement', () => {
        // A weekly income and a monthly levy fall due on different boundaries. That is correct and
        // it is why a "net rate" is only ever a rendering, but whatever they owe at a given instant
        // is still one change to one row, or the zero-floor decides the answer by map order.
        const monthly = { label: 'the war levy', item: 'gold', at: 'money', dq: -900, per: '1 month', from: 0 };
        const out = accrue(table(income, monthly), { clock: 30 * DAY, seen: 0 });
        expect(out.wants.size).toBe(1);
        expect(out.wants.get(itemKey('gold', 'money', '')).want).toBe(4 * 1000 - 900);
    });
});

describe('applyFlows, a debit takes what is there, and the rest is reported', () => {
    const key = itemKey('gold', 'money', '');

    test('an affordable debit lands whole', () => {
        const held = inv({ [key]: 1000 });
        const { shorts } = applyFlows(held, accrue(table(rent()), { clock: WEEK, seen: 0 }).wants);
        expect(held.get(key).qty).toBe(600);
        expect(shorts).toEqual([]);
    });

    test('an unaffordable debit is clamped HERE, and the shortfall is its own kind of thing', () => {
        // The clamp must not be left to `merge_qty`'s floor: `deriveState` would record an
        // `overdrawn` entry, and `invariant-table.js unbackedDebits` reads those as "a credit landed
        // under another key" and poses a merge question. Expected arrears are not a fold error, and
        // manufacturing one every period would refill the 120-slot diagnostics log.
        const held = inv({ [key]: 100 });
        const { shorts } = applyFlows(held, accrue(table(rent()), { clock: WEEK, seen: 0 }).wants);
        expect(held.has(key)).toBe(false);
        expect(shorts).toHaveLength(1);
        expect(shorts[0]).toMatchObject({ paid: -100, short: -300, labels: ['rent'] });
    });

    test('a debit against nothing held reports the whole amount', () => {
        const held = inv({});
        const { shorts } = applyFlows(held, accrue(table(rent()), { clock: WEEK, seen: 0 }).wants);
        expect(shorts[0].short).toBe(-400);
        expect(held.size).toBe(0);
    });

    test('a credit past the ceiling is reported rather than silently swallowed', () => {
        const rations = itemKey('rations', 'carried', '');
        const held = inv({ [rations]: 9998 });
        const flows = table({ label: 'harvest', item: 'rations', at: 'carried', dq: 50, per: '1 day', from: 0 });
        const { overs } = applyFlows(held, accrue(flows, { clock: DAY, seen: 0 }).wants);
        expect(held.get(rations).qty).toBe(9999);
        expect(overs).toHaveLength(1);
        expect(overs[0].over).toBe(49);
    });

    test('a row emptied exactly is dropped, the way the fold drops one', () => {
        const held = inv({ [key]: 400 });
        applyFlows(held, accrue(table(rent()), { clock: WEEK, seen: 0 }).wants);
        expect(held.has(key)).toBe(false);
    });

    test('a credit creates the row it targets', () => {
        const held = inv({});
        const flows = table({ label: 'wage', item: 'gold', at: 'money', dq: 25, per: '1 day', from: 0 });
        applyFlows(held, accrue(flows, { clock: 2 * DAY, seen: 0 }).wants);
        expect(held.get(key).qty).toBe(50);
    });
});

describe('the table is bounded, and the bound is honest about being a guard', () => {
    test('a full table refuses a new row but still accepts edits to the ones it holds', () => {
        const map = new Map();
        for (let at = 0; at < MAX_FLOWS; at++) {
            expect(foldFlow(map, { label: `flow ${at}`, item: 'gold', at: 'money', dq: 1, per: '1 day' })).not.toBeNull();
        }
        expect(foldFlow(map, { label: 'one too many', item: 'gold', at: 'money', dq: 1, per: '1 day' })).toBeNull();
        expect(foldFlow(map, { label: 'flow 0', item: 'gold', at: 'money', dq: 99, per: '1 day' })).not.toBeNull();
        expect(map.get('flow 0').dq).toBe(99);
    });
});

describe('the readouts', () => {
    test('netRate sums the live rows on a target and names them', () => {
        const flows = table(
            { label: 'the tea house', item: 'gold', at: 'money', dq: 1000, per: '1 week', from: 0 },
            { label: 'the war levy', item: 'gold', at: 'money', dq: -300, per: '1 week', from: 0 },
        );
        const net = netRate(flows, itemKey('gold', 'money', ''));
        expect(net.perMinute).toBeCloseTo(700 / WEEK);
        expect(net.rows).toHaveLength(2);
    });

    test('a suspended row contributes nothing to the net', () => {
        const flows = table({ label: 'shut for winter', item: 'gold', at: 'money', dq: 1000, per: '1 week', on: false });
        expect(netRate(flows, itemKey('gold', 'money', '')).perMinute).toBe(0);
    });

    test('emptyIn is periods of the current drain, and never divides by zero', () => {
        expect(emptyIn(14, -2)).toBe(7);
        expect(emptyIn(14, 0)).toBeNull();
        expect(emptyIn(14, 3)).toBeNull();
        expect(emptyIn(0, -2)).toBeNull();
    });

    test('parseFlow reads back exactly what flowFace prints', () => {
        for (const row of [
            { label: 'a', item: 'gold', at: 'money', dq: -400, per: '1 week' },
            { label: 'b', item: 'gold', at: 'money', dq: 1000, per: '1 week' },
            { label: 'c', item: 'qi', dq: 18, every: 4 },
        ]) {
            const flow = normalizeFlow(row);
            const read = parseFlow(flowFace(flow));
            expect(read.dq).toBe(flow.dq);
            expect(read.per ?? null).toBe(flow.per ?? null);
            expect(read.every ?? null).toBe(flow.every ?? null);
        }
    });

    test('parseFlow refuses what is not a rate, rather than guessing one', () => {
        expect(parseFlow('')).toBeNull();
        expect(parseFlow('a thousand a week')).toBeNull();
        expect(parseFlow('1000')).toBeNull();
        expect(parseFlow('0/week')).toBeNull();
        expect(parseFlow('+50/fortnight')).toBeNull();
    });

    test('parseFlow accepts the minus sign the panel actually renders', () => {
        expect(parseFlow('−400/1 week')).toEqual({ dq: -400, per: '1 week' });
    });

    test('a chat with no flows renders no line at all', () => {
        expect(renderFlows(new Map())).toBe('');
        expect(renderFlows(table(rent({ on: false })))).toBe('');
    });

    test('and one with flows says what is moving, once', () => {
        expect(renderFlows(table(rent()))).toBe('Running: gold −400/1 week');
    });
});
