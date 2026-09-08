import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    deriveState,
    itemKey,
    validateInventory,
    validateVitals,
} from '../public/scripts/extensions/sanguine/state-table.js';

/**
 * Zero is silence, and it has to be true everywhere rather than where somebody remembered.
 *
 * OpenAI strict mode requires EVERY property of an object to appear in `required`, so fold's delta
 * schema cannot offer an optional number. The instructions ask for omission anyway, `max` was
 * literally described as "send only when newly established, then omit afterwards", and a model
 * that cannot omit sends 0. Every numeric field on a delta therefore has a value that means
 * "nothing was said", and fold has to read it that way or it reads noise as data.
 *
 * It got this right once and wrong once, three months apart:
 *
 *   `set: 0`   "nothing is held at zero, and strict mode forces the field into every row, so a
 *              0/null `set` on an ordinary delta must read as 'not a restatement'", handled.
 *   `max: 0`   taken as a ceiling of zero. `cur` clamps to it, so the reported change was destroyed
 *              on arrival, and `implausible-max` then bounded every repair at `0 * 0.5` and refused
 *              it. The live My Hero Academia RP read `Mana 0/0` from mid 94 to the end of the
 *              campaign: in an RP whose whole subject is output percentages and hold durations.
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
        // documented, it is how a hand edit empties a row. What makes it safe is that no model
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

    test('and a zero that means "no movement" is still a real answer, the rank-up', () => {
        // The distinction the whole gate rests on, and the third instance of the class it found.
        // `rank` exists so "a skill that goes F->E->D is one row whose rank changes, not three
        // rows". Strict mode forces `set` into the delta, so a grade change arrives as
        // `{dq: 0, set: 0, rank: "D"}`: and the no-change refusal read that as silence, while the
        // fold, had it ever seen one, read `set: 0` as a restated total of zero and deleted the
        // ability outright. The feature had never once fired.
        //
        // Through the real path: the validator accepts it, carries the grade, and strips the `set`
        // that would have destroyed the row.
        // Capabilities are their own table now (`state-table.js` `foldAbility`) and keep their key,
        // so the row the grade lands on arrives through `abilities` rather than `inv`. The gate is
        // unchanged: a grade needs a row that already exists, and `set: 0` is still not a total.
        const held = new Map([[itemKey('quarterstaff proficiency', 'abilities'), { name: 'quarterstaff proficiency', who: '', rank: 'E' }]]);
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            abilities: held,
            deltas: [{ item: 'quarterstaff proficiency', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'abilities', rank: 'D' }],
            windowText: 'Aizawa marks the quarterstaff proficiency up to D',
            mentioned: new Set(['quarterstaff proficiency']),
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([{ item: 'quarterstaff proficiency', dq: 0, at: 'abilities', rank: 'D' }]);

        const { inv, abilities } = deriveState([
            ev(1, { inv: [{ item: 'quarterstaff proficiency', dq: 1, at: 'abilities', rank: 'E' }] }),
            ev(2, { inv: accepted }),
        ]);
        expect(inv.size).toBe(0);
        expect(abilities.get(itemKey('quarterstaff proficiency', 'abilities')))
            .toEqual({ who: '', name: 'quarterstaff proficiency', rank: 'D' });
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

/*
 * The no-op rows the model actually sent, and the clause that was missing.
 *
 * MEASURED over 2256 traced extraction passes (`sanguine-traces` + `fold-traces`): 102 of 1607
 * proposed inventory rows, 6.3%, reached `validateInventory` carrying no `dq`, no `set > 0` and
 * no `rank`, and every one was refused `no-change`. That is the whole of the live Wuxia chat's
 * `no-change` count (12) and the whole of the corpus's. Three shapes:
 *
 *   69  a bare mention of something already held, `{item: "spear", dq: 0, at: "carried"}`,
 *       24 of them a currency at `at: "money"`
 *   24  `same_as` set to the entry's OWN item string, "the coins are the same as the coins"
 *    9  a rename asserted with no quantity, `{item: "shotgun", same_as: "mossberg 590", dq: 0}`
 *
 * The vital half of the same rule has never fired: 70 vital rows in the corpus, 4 with `dcur: 0`,
 * all 4 carrying a real `max`. So this is one producer, not two.
 *
 * The gate is right and does not move, a no-op that lands is worse than one refused, because it
 * writes a mention into the ledger as an acquisition. What was missing is upstream: nothing in the
 * schema or the instruction ever said an entry needs a REASON to exist. `dq` read "positive gained,
 * negative lost" and said nothing about 0, and strict mode requires the field, so 0 was the free
 * way to fill it in. These pin both halves.
 */
describe('an inventory row must move something to be worth sending', () => {
    const src = name => fs.readFileSync(
        path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine', name), 'utf8');

    test('the bare mention, 69 of the 102, is refused', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map([[itemKey('silver', 'money'), { qty: 40 }]]),
            deltas: [{ item: 'silver', same_as: '', dq: 0, set: 0, magnitude: 0, at: 'money', rank: '', who: '' }],
            windowText: 'he counts the silver in his palm and says nothing',
            mentioned: new Set(['silver']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'no-change' })]);
    });

    test('an entry whose only content is `same_as` is refused, 24 of them named themselves', () => {
        // "the coins are the same as the coins" is not a delta. It is the identity instruction read
        // as a request to confirm, and taking it would let a mention become an acquisition.
        const { accepted, rejected } = validateInventory({
            inv: new Map([[itemKey('coins', 'money'), { qty: 12 }]]),
            deltas: [{ item: 'coins', same_as: 'coins', dq: 0, set: 0, magnitude: 0, at: 'money', rank: '', who: '' }],
            windowText: 'the coins are still in the pouch',
            mentioned: new Set(['coins']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'no-change' })]);
    });

    test('and a rename asserted with no quantity is refused too, the other 9', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map([[itemKey('mossberg 590'), { qty: 1 }]]),
            deltas: [{ item: 'shotgun', same_as: 'mossberg 590', dq: 0, set: 0, magnitude: 0, at: 'carried', rank: '', who: '' }],
            windowText: 'the shotgun is slung across his back',
            mentioned: new Set(['shotgun']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'no-change' })]);
    });

    test('the three legal reasons for a zero-quantity row still pass', () => {
        // The gate refuses silence, never a real answer wearing a zero. A stated total and a new
        // grade are both changes; the rank case has its own test above.
        const { accepted, rejected } = validateInventory({
            inv: new Map([[itemKey('silver', 'money'), { qty: 40 }]]),
            deltas: [{ item: 'silver', same_as: '', dq: 0, set: 120, magnitude: 120, at: 'money', rank: '', who: '' }],
            windowText: 'the pouch holds a hundred and twenty silver',
            mentioned: new Set(['silver']),
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([expect.objectContaining({ item: 'silver', set: 120 })]);
    });

    test('the schema says an entry needs a reason to exist, on the array and on `dq`', () => {
        // Both, because "may I send this row?" is read off the array description and off the field,
        // not out of the prose block. This is the same one-sided-permission defect that produced
        // every world `unknown-id`: see `world-table.js` `NO_LINES`.
        const state = src('state.js');
        expect(state).toMatch(/Every entry must MOVE something/);
        expect(state).toMatch(/0 means nothing moved/);
        expect(state).toMatch(/never repeat the "item" name here/);
        expect(state).toMatch(/it is not a change by itself/);
    });

    test('and the instruction says what to DO about it, which is send no row', () => {
        // "nothing merely mentioned, held over, or unchanged" was already there and was not enough:
        // it describes what not to record, never what to put in the required fields when the answer
        // is nothing. The answer is not zeros, it is omission.
        expect(src('state.js')).toMatch(/An entry with dq 0, no stated total and no new rank changes nothing/);
    });

    test('the vital half carries the same clause, against a defect it has never had', () => {
        // 0 firings in 2256 passes. Stated anyway because the two arrays are read side by side, and
        // a rule on one and not the other is exactly how `advances` and `nominations` drifted.
        expect(src('state.js')).toMatch(/0 means the level did not move/);
    });
});
