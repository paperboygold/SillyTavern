import { describe, expect, test } from '@jest/globals';

import {
    deriveState,
    itemKey,
    validateInventory,
    validateVitals,
} from '../public/scripts/extensions/fold/state-table.js';

/**
 * ── Zero is silence, and it has to be true everywhere rather than where somebody remembered ──
 *
 * OpenAI strict mode requires EVERY property of an object to appear in `required`, so fold's delta
 * schema cannot offer an optional number. The instructions ask for omission anyway — `max` was
 * literally described as "send only when newly established, then omit afterwards" — and a model
 * that cannot omit sends 0. Every numeric field on a delta therefore has a value that means
 * "nothing was said", and fold has to read it that way or it reads noise as data.
 *
 * It got this right once and wrong once, three months apart:
 *
 *   `set: 0`   "nothing is held at zero, and strict mode forces the field into every row, so a
 *              0/null `set` on an ordinary delta must read as 'not a restatement'"  — handled.
 *   `max: 0`   taken as a ceiling of zero. `cur` clamps to it, so the reported change was destroyed
 *              on arrival, and `implausible-max` then bounded every repair at `0 * 0.5` and refused
 *              it. The live My Hero Academia RP read `Mana 0/0` from mid 94 to the end of the
 *              campaign — in an RP whose whole subject is output percentages and hold durations.
 *
 * Not every zero is silence, and the difference is whether the field measures a CHANGE or states a
 * FACT. `dq: 0` and `dcur: 0` mean "no movement", which is a real answer and already handled by the
 * no-change refusal. `set`, `max` and `magnitude` assert something about the world, and zero is not
 * an assertion any story makes.
 *
 * This is the gate rather than another instance fixed: an all-zero delta must be inert.
 */

const ev = (t, d) => ({ s: 'x', kw: [], t, src: 'llm', d });

describe('a delta of nothing but zeroes changes nothing', () => {
    test('inventory: every numeric field zeroed is refused, not applied', () => {
        // Exactly what strict mode makes a model send when the excerpt changed no quantity.
        const inv = new Map([[itemKey('rope'), { qty: 3 }]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'rope', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'carried', rank: '', who: '' }],
            windowText: 'the rope is coiled by the fire',
            mentioned: new Set(['rope']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'rope', reason: 'no-change' })]);
    });

    test('inventory: the validator never lets a zeroed `set` reach the fold', () => {
        // The fold DOES read `set: 0` as a restated total of zero, and that is deliberate and
        // documented — it is how a hand edit empties a row. What makes it safe is that no model
        // delta can carry one: `validateInventory` refuses a zeroed `set` before it is stored, and
        // `state.adjustItem` writes only `dq`. So the removal branch is reachable by intent and
        // never by accident. This pins the half that keeps it that way.
        const { accepted } = validateInventory({
            inv: new Map([[itemKey('rope'), { qty: 3 }]]),
            deltas: [{ item: 'rope', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'carried', rank: '' }],
            windowText: 'the rope is coiled by the fire',
            mentioned: new Set(['rope']),
        });
        expect(accepted).toEqual([]);
        expect(accepted.some(d => 'set' in d)).toBe(false);
    });

    test('vitals: a zeroed ceiling leaves the one on record alone', () => {
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'hp', dcur: 0, max: 70 }] }),
            ev(2, { vit: [{ name: 'hp', dcur: -26, max: 0 }] }),
        ]);
        expect(vitals.get('hp')).toEqual({ max: 70, cur: 44 });
    });

    test('vitals: an all-zero vital is refused rather than seeding a row', () => {
        const { accepted, rejected } = validateVitals({
            vitals: new Map(),
            deltas: [{ name: 'mana', dcur: 0, max: 0 }],
            windowText: 'his mana is steady',
            mentioned: new Set(['mana']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'mana', reason: 'no-change' })]);
    });

    test('and a zero that means "no movement" is still a real answer — the rank-up', () => {
        // The distinction the whole gate rests on, and the third instance of the class it found.
        // `rank` exists so "a skill that goes F->E->D is one row whose rank changes, not three
        // rows". Strict mode forces `set` into the delta, so a grade change arrives as
        // `{dq: 0, set: 0, rank: "D"}` — and the no-change refusal read that as silence, while the
        // fold, had it ever seen one, read `set: 0` as a restated total of zero and deleted the
        // ability outright. The feature had never once fired.
        //
        // Through the real path: the validator accepts it, carries the grade, and strips the `set`
        // that would have destroyed the row.
        const held = new Map([[itemKey('quarterstaff proficiency', 'abilities'), { qty: 1, rank: 'E' }]]);
        const { accepted, rejected } = validateInventory({
            inv: held,
            deltas: [{ item: 'quarterstaff proficiency', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'abilities', rank: 'D' }],
            windowText: 'Aizawa marks the quarterstaff proficiency up to D',
            mentioned: new Set(['quarterstaff proficiency']),
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([{ item: 'quarterstaff proficiency', dq: 0, at: 'abilities', rank: 'D' }]);

        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'quarterstaff proficiency', dq: 1, at: 'abilities', rank: 'E' }] }),
            ev(2, { inv: accepted }),
        ]);
        expect(inv.get(itemKey('quarterstaff proficiency', 'abilities'))).toEqual({ qty: 1, rank: 'D' });
    });

    test('a grade for something nobody has is still nothing', () => {
        // `deriveState` keeps this rule and the validator now matches it: inventing a row from a
        // passing mention of a skill would let the mention become the skill.
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'sword saint technique', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'abilities', rank: 'S' }],
            windowText: 'the sword saint technique is spoken of as an S-grade art',
            mentioned: new Set(['sword saint technique']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'no-change' })]);
    });
});
