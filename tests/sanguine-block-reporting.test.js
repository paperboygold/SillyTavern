import { describe, expect, test } from '@jest/globals';

import { blockReport } from '../public/scripts/extensions/sanguine/clock.js';

/*
 * Three states, because "turns since a status block" has meant three different things and the footer
 * printed all of them the same way.
 *
 * MEASURED, live Raccoon City campaign: the card's narrator emitted status blocks through turn 12
 * and never again. At turn 96 the footer read "84 turns unreported", true, and rendered in the same
 * register as a fault, about a feature the chat had simply stopped using. sanguine extracts from
 * prose; a narrator that stops restating its block costs it nothing.
 *
 * The distinction between a GAP and a STOP is derived rather than dialled, per the corpus's rule
 * that constants come from the geometry: blocks were arriving up to turn `block`, so a silence
 * longer than the entire span over which they ever arrived is a change of behaviour, not a pause.
 * A chat whose blocks ran to turn 50 and is 10 turns quiet is in a gap worth flagging; one whose
 * blocks stopped at 12 and is 84 turns quiet is not.
 */
describe('a narrator that stopped is not a gap', () => {
    test('no block has ever arrived, so there is nothing to report', () => {
        expect(blockReport({ block: NaN, seen: 40 })).toMatchObject({ state: 'never', gap: 0 });
        expect(blockReport({ block: 0, seen: 40 })).toMatchObject({ state: 'never' });
        expect(blockReport({})).toMatchObject({ state: 'never' });
    });

    test('a short silence is current, not worth a line', () => {
        expect(blockReport({ block: 12, seen: 13 })).toMatchObject({ state: 'current', gap: 1 });
    });

    test('a real gap is counted, because the tracker may be missing updates', () => {
        expect(blockReport({ block: 50, seen: 60 })).toMatchObject({ state: 'gap', gap: 10 });
    });

    test('a silence longer than the span blocks ever covered is a stop', () => {
        // The live case: blocks through turn 12, quiet ever since.
        expect(blockReport({ block: 12, seen: 96 })).toMatchObject({ state: 'stopped', gap: 84 });
    });

    test('the boundary is the span itself, and it is derived not dialled', () => {
        expect(blockReport({ block: 20, seen: 40 }).state).toBe('gap');
        expect(blockReport({ block: 20, seen: 41 }).state).toBe('stopped');
    });

    test('a clock that never advanced reports no gap rather than a negative one', () => {
        expect(blockReport({ block: 12, seen: 5 })).toMatchObject({ state: 'current', gap: 0 });
    });

    test('is total over junk', () => {
        expect(blockReport(null).state).toBe('never');
        expect(blockReport({ block: 'x', seen: 'y' }).state).toBe('never');
    });
});
