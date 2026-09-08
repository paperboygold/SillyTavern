import { describe, expect, test } from '@jest/globals';

import {
    CLOCK_SIZES,
    DEFAULT_CLOCK_SIZE,
    HIDDEN,
    MAX_CLOCKS,
    MAX_TICK,
    OPEN,
    clocks,
    foldClock,
    foldClocks,
    isFull,
    merge_clock,
    normalizeClockName,
    normalizeSize,
    renderClocks,
} from '../public/scripts/extensions/sanguine/clock-table.js';

/*
 * Pressure. The tracker showed state at rest, seven nouns, nine nouns, a clock, and nothing that
 * said what was about to happen. "You die if you play dumb" only works if you can watch the noose
 * tighten; being told after the fact that you failed is an announcement, not a consequence.
 */
describe('the Count face, filling is accumulation', () => {
    test('ticks add, which is what merge_bu is', () => {
        const table = new Map();
        foldClock(table, { name: 'the Blight reaches Briarwood', tick: 1, size: 6, turn: 1 });
        foldClock(table, { name: 'the Blight reaches Briarwood', tick: 2, turn: 2 });
        expect(clocks(table, 2)[0].filled).toBe(3);
    });

    test('order does not matter, because addition is commutative', () => {
        const forward = new Map();
        foldClock(forward, { name: 'x', tick: 1, size: 6, turn: 1 });
        foldClock(forward, { name: 'x', tick: 2, turn: 2 });
        const backward = new Map();
        foldClock(backward, { name: 'x', tick: 2, size: 6, turn: 2 });
        foldClock(backward, { name: 'x', tick: 1, turn: 1 });
        expect(clocks(forward, 2)[0].filled).toBe(clocks(backward, 2)[0].filled);
    });

    test('a clock can be pushed back', () => {
        const table = new Map();
        foldClock(table, { name: 'x', tick: 3, size: 6, turn: 1 });
        foldClock(table, { name: 'x', tick: -2, turn: 2 });
        expect(clocks(table, 2)[0].filled).toBe(1);
    });

    test('it never overfills or goes negative', () => {
        const table = new Map();
        foldClock(table, { name: 'x', tick: 3, size: 4, turn: 1 });
        foldClock(table, { name: 'x', tick: 3, turn: 2 });
        expect(clocks(table, 2)[0].filled).toBe(4);
        foldClock(table, { name: 'x', tick: -99, turn: 3 });
        expect(clocks(table, 3)[0].filled).toBe(0);
    });

    test('a tick that says only "+1" does not erase what the clock is about', () => {
        const table = new Map();
        foldClock(table, { name: 'x', tick: 1, size: 6, about: 'the village is abandoned', turn: 1 });
        foldClock(table, { name: 'x', tick: 1, turn: 2 });
        expect(clocks(table, 2)[0].about).toBe('the village is abandoned');
    });

    test('a re-description does not reset the fill', () => {
        const table = new Map();
        foldClock(table, { name: 'x', tick: 2, size: 6, turn: 1 });
        foldClock(table, { name: 'x', tick: 0, about: 'now with feeling', turn: 2 });
        expect(clocks(table, 2)[0].filled).toBe(2);
    });
});

describe('sizes and names', () => {
    test('a size off the vocabulary rounds to the nearest one', () => {
        expect(normalizeSize(5)).toBe(4);
        expect(normalizeSize(7)).toBe(6);
        expect(normalizeSize(100)).toBe(8);
        for (const size of CLOCK_SIZES) expect(normalizeSize(size)).toBe(size);
    });

    test('a missing size falls back rather than producing NaN segments', () => {
        expect(normalizeSize(undefined)).toBe(DEFAULT_CLOCK_SIZE);
        expect(normalizeSize('nonsense')).toBe(DEFAULT_CLOCK_SIZE);
    });

    test('names key case-insensitively and keep their display form', () => {
        expect(normalizeClockName('  The **Blight** spreads. ')).toEqual({
            key: 'the blight spreads', display: 'The Blight spreads',
        });
    });

    test('the ways a model says there is no clock', () => {
        for (const junk of ['', 'none', 'N/A', null]) {
            expect(normalizeClockName(junk)).toBeNull();
        }
    });
});

describe('validation, a clock that leaps has skipped the story', () => {
    test('an implausible tick is refused and counted', () => {
        const table = new Map();
        const { accepted, rejected } = foldClocks(table, [
            { name: 'x', tick: MAX_TICK + 1, size: 6 },
        ], { turn: 1 });
        expect(accepted).toBe(0);
        expect(rejected[0].reason).toBe('implausible-tick');
    });

    test('a zero tick is not a change', () => {
        const { rejected } = foldClocks(new Map(), [{ name: 'x', tick: 0 }], { turn: 1 });
        expect(rejected[0].reason).toBe('no-change');
    });

    test('the table is bounded, and the bound is reported', () => {
        const table = new Map();
        for (let i = 0; i < MAX_CLOCKS; i++) {
            foldClock(table, { name: `clock ${i}`, tick: 1, size: 6, turn: 1 });
        }
        const { rejected } = foldClocks(table, [{ name: 'one too many', tick: 1 }], { turn: 1 });
        expect(rejected[0].reason).toBe('threads-full');
    });
});

describe('firing, the consequence lands exactly once', () => {
    test('the tick that completes a clock reports it', () => {
        const table = new Map();
        foldClocks(table, [{ name: 'x', tick: 3, size: 4, about: 'the village is abandoned' }], { turn: 1 });
        const { fired } = foldClocks(table, [{ name: 'x', tick: 1 }], { turn: 2 });
        expect(fired.map(c => c.about)).toEqual(['the village is abandoned']);
    });

    test('a full clock does not fire again on every later tick', () => {
        const table = new Map();
        foldClocks(table, [{ name: 'x', tick: 3, size: 4 }], { turn: 1 });
        foldClocks(table, [{ name: 'x', tick: 1 }], { turn: 2 });
        expect(foldClocks(table, [{ name: 'x', tick: 1 }], { turn: 3 }).fired).toEqual([]);
    });

    test('isFull is the read the panel and the prompt share', () => {
        expect(isFull({ filled: 4, size: 4 })).toBe(true);
        expect(isFull({ filled: 3, size: 4 })).toBe(false);
        expect(isFull(null)).toBe(false);
    });
});

describe('what the narrator is told', () => {
    test('most urgent first, by PROPORTION rather than segments left', () => {
        // A 4-clock at 3 is closer to firing than an 8-clock at 3, and the fraction is what tells
        // you how worried to be.
        const table = new Map();
        foldClock(table, { name: 'slow', tick: 3, size: 8, turn: 1 });
        foldClock(table, { name: 'imminent', tick: 3, size: 4, turn: 1 });
        expect(clocks(table, 1).map(c => c.name)).toEqual(['imminent', 'slow']);
    });

    test('an open clock is quantified', () => {
        const table = new Map();
        foldClock(table, { name: 'the Blight reaches Briarwood', tick: 2, size: 6, about: 'the village is abandoned', seen: OPEN, turn: 1 });
        expect(renderClocks(table, 1))
            .toBe('Pressure: the Blight reaches Briarwood 2/6, the village is abandoned');
    });

    test('a hidden clock is NAMED but never quantified', () => {
        // The panel must not tell the narrator what the character cannot perceive, but it must not
        // pretend nothing is happening either.
        const table = new Map();
        foldClock(table, { name: 'the traitor moves', tick: 2, size: 6, seen: HIDDEN, turn: 1 });
        const rendered = renderClocks(table, 1);
        expect(rendered).toContain('closing in');
        expect(rendered).not.toContain('2/6');
    });

    test('a filled clock stops being pressure, it has already happened', () => {
        const table = new Map();
        foldClock(table, { name: 'x', tick: 4, size: 4, turn: 1 });
        expect(renderClocks(table, 1)).toBe('');
    });

    test('no clocks, nothing injected', () => {
        expect(renderClocks(new Map(), 0)).toBe('');
    });
});

describe('merge_clock directly', () => {
    test('an absent prior is taken, clamped to its own size', () => {
        expect(merge_clock({ filled: 9, size: 4 }, undefined).filled).toBe(4);
    });

    test('later descriptions win but the fill still accumulates', () => {
        const merged = merge_clock(
            { filled: 1, about: 'newer', size: 6, turn: 2 },
            { filled: 2, about: 'older', size: 6, turn: 1 });
        expect(merged).toMatchObject({ about: 'newer', filled: 3 });
    });
});
