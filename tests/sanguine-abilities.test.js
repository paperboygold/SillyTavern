import { describe, expect, test } from '@jest/globals';

import {
    ABILITIES,
    MAX_ABILITIES,
    deriveState,
    foldAbility,
    isDisposable,
    itemKey,
    maxQty,
    renderLedger,
    renderState,
    validateInventory,
} from '../public/scripts/extensions/sanguine/state-table.js';
import { abilityDelta, abilityRankDelta, eventsTouching, withoutTarget } from '../public/scripts/extensions/sanguine/edit-table.js';

/*
 * "The inventory has 'abilities' which really seems to me like a different class entirely".
 *
 * The owner is right, and `ABILITIES` was a value of the same field as `carried`, `assets`, `money`
 * and "the car boot", so a technique was stored as a thing with a quantity that lives somewhere.
 * Every consequence followed mechanically:
 *
 *   · `tier 3 access ×1` on the live Raccoon City panel. There is no ×2 of a clearance level, and
 *     the extraction proposed exactly that (mids 83 and 86 of that chat both report the grant).
 *   · `Stored (abilities): …` in the narrator's block, beside `Stored (the SUV)`.
 *   · `isDisposable` had to be taught by hand to exclude the place, after the review destroyed five
 *     of the six techniques a Wuxia campaign ever learned by asking "are you still carrying this?"
 *   · One ceiling of 64 rows shared between a pack and a skill tree.
 *
 * `foldAbility` is the separation. The KEY is deliberately unchanged, which is what makes it cost no
 * migration: the events on disk are byte-identical and every one of them re-derives into the new
 * table on the next read.
 */

const ev = (mid, inv) => ({ t: mid, mid, s: `event ${mid}`, d: { inv } });
const key = (name, who = '') => itemKey(name, ABILITIES, who);

describe('a capability is not a thing in a bag', () => {
    test('an ability delta lands in `abilities` and never in `inv`', () => {
        // The live Raccoon City grant, verbatim from the chat file.
        const state = deriveState([ev(83, [{ item: 'tier 3 access', dq: 1, at: 'abilities' }])]);
        expect(state.inv.size).toBe(0);
        expect(state.abilities.get(key('tier 3 access'))).toEqual({ who: '', name: 'tier 3 access' });
    });

    test('presence, not a count, the same grant twice is one capability', () => {
        // Raccoon City proposed `tier 3 access` at mid 83 AND at mid 86. Under the count face that
        // is `×2`, which is the category error made arithmetic.
        const state = deriveState([
            ev(83, [{ item: 'tier 3 access', dq: 1, at: 'abilities' }]),
            ev(86, [{ item: 'tier 3 access', dq: 1, at: 'abilities' }]),
        ]);
        expect(state.abilities.size).toBe(1);
        expect(state.abilities.get(key('tier 3 access')).qty).toBeUndefined();
    });

    test('a revocation removes it, the live `tier 4 access` at mid 120', () => {
        const state = deriveState([
            ev(98, [{ item: 'tier 4 access', dq: 1, at: 'abilities' }]),
            ev(120, [{ item: 'tier 4 access', dq: -1, at: 'abilities' }]),
        ]);
        expect(state.abilities.size).toBe(0);
        expect(state.inv.size).toBe(0);
    });

    test('a revocation of something never granted is not a retraction', () => {
        const state = deriveState([ev(1, [{ item: 'flight', dq: -1, at: 'abilities' }])]);
        expect(state.abilities.size).toBe(0);
        expect(state.contributors.size).toBe(0);
    });

    test('the grade is last-write and survives a silent re-report', () => {
        // The Isekai defect this closes at the source: `Quarterstaff Proficiency (F) → (E)` then
        // `(E) → (D)`, reported sometimes with the grade and sometimes without.
        const state = deriveState([
            ev(4, [{ item: 'quarterstaff proficiency', dq: 1, at: 'abilities', rank: 'E' }]),
            ev(46, [{ item: 'quarterstaff proficiency', dq: 0, at: 'abilities', rank: 'D' }]),
            ev(60, [{ item: 'quarterstaff proficiency', dq: 1, at: 'abilities' }]),
        ]);
        expect(state.abilities.get(key('quarterstaff proficiency')).rank).toBe('D');
    });

    test('a grade for something nobody has never invents the row', () => {
        const state = deriveState([ev(1, [{ item: 'necromancy', dq: 0, at: 'abilities', rank: 'S' }])]);
        expect(state.abilities.size).toBe(0);
    });

    test('a restated total is presence too: >0 grants, 0 revokes', () => {
        expect(deriveState([ev(1, [{ item: 'flight', set: 1, at: 'abilities' }])]).abilities.size).toBe(1);
        expect(deriveState([
            ev(1, [{ item: 'flight', set: 1, at: 'abilities' }]),
            ev(2, [{ item: 'flight', set: 0, at: 'abilities' }]),
        ]).abilities.size).toBe(0);
    });

    test('an owner keeps their own capabilities', () => {
        const state = deriveState([
            ev(1, [{ item: 'sword arts', dq: 1, at: 'abilities' }]),
            ev(2, [{ item: 'sword arts', dq: 1, at: 'abilities', who: 'Vexia' }]),
        ]);
        expect(state.abilities.size).toBe(2);
        expect(state.abilities.get(key('sword arts', 'Vexia')).who).toBe('vexia');
    });
});

describe('foldAbility, on its own', () => {
    test('reports what moved so the trail records grants and revocations only', () => {
        const table = new Map();
        expect(foldAbility(table, key('flight'), { dq: 1 })).toEqual({ dq: 1, touched: true });
        // A re-grant touches the row (the story just mentioned it) and moves nothing.
        expect(foldAbility(table, key('flight'), { dq: 1 })).toEqual({ dq: 0, touched: true });
        expect(foldAbility(table, key('flight'), { dq: 0, rank: 'B' })).toEqual({ dq: 0, touched: true });
        expect(foldAbility(table, key('flight'), { dq: -1 })).toEqual({ dq: -1, touched: true });
        expect(foldAbility(table, key('flight'), { dq: -1 })).toEqual({ dq: 0, touched: false });
    });

    test('silence about a grade never erases the grade already known', () => {
        const table = new Map();
        foldAbility(table, key('lockpicking'), { dq: 1, rank: 'Amateur' });
        foldAbility(table, key('lockpicking'), { dq: 1 });
        expect(table.get(key('lockpicking')).rank).toBe('Amateur');
    });
});

describe('the prompt says what the character can DO, not where it is kept', () => {
    const state = () => deriveState([
        ev(1, [{ item: 'quarterstaff proficiency', dq: 1, at: 'abilities', rank: 'D' }]),
        ev(2, [{ item: 'crowbar', dq: 1 }]),
    ]);

    test('the narrator block gets an `Abilities:` line and no place', () => {
        const text = renderState(state());
        expect(text).toContain('Abilities: quarterstaff proficiency D');
        expect(text).not.toContain('Stored (abilities)');
        expect(text).toContain('Carrying: crowbar');
    });

    test('the pinned ledger says the same thing and puts the key in `shown`', () => {
        // `already-recorded` may only refuse a re-report of a line the model was actually told
        // about, so a rendered capability has to be in the set.
        const { lines, shown } = renderLedger(state());
        expect(lines.join('\n')).toContain('Abilities: quarterstaff proficiency D');
        expect(shown.has(key('quarterstaff proficiency'))).toBe(true);
    });

    test('there is no count on the line, because there is nothing to count', () => {
        const twice = deriveState([
            ev(1, [{ item: 'flight', dq: 1, at: 'abilities' }]),
            ev(2, [{ item: 'flight', dq: 1, at: 'abilities' }]),
        ]);
        expect(renderState(twice)).toContain('Abilities: flight');
        expect(renderState(twice)).not.toContain('x2');
    });

    test('somebody else\'s capability stays off the player\'s line', () => {
        const state2 = deriveState([ev(1, [{ item: 'sword arts', dq: 1, at: 'abilities', who: 'Vexia' }])]);
        expect(renderState({ ...state2, pov: '' })).not.toContain('sword arts');
        expect(renderLedger({ ...state2, pov: '' }).lines.join('\n')).not.toContain('sword arts');
    });
});

describe('the gates still hold, against the right table', () => {
    const abilities = new Map([[key('tier 4 access'), { who: '', name: 'tier 4 access', rank: 'IV' }]]);

    test('you cannot lose a capability you never had', () => {
        const { rejected } = validateInventory({
            inv: new Map(),
            abilities: new Map(),
            deltas: [{ item: 'tier 4 access', dq: -1, at: 'abilities' }],
            windowText: 'the badge stops working',
        });
        expect(rejected).toEqual([expect.objectContaining({ reason: 'remove-unknown' })]);
    });

    test('…and you can lose one you have', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            abilities,
            deltas: [{ item: 'tier 4 access', dq: -1, at: 'abilities' }],
            windowText: 'the badge stops working',
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([{ item: 'tier 4 access', dq: -1, at: 'abilities' }]);
    });

    test('a re-grade finds its row through the ability table', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            abilities,
            deltas: [{ item: 'tier 4 access', dq: 0, set: 0, at: 'abilities', rank: 'V' }],
            windowText: 'promoted to tier V',
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([{ item: 'tier 4 access', dq: 0, at: 'abilities', rank: 'V' }]);
    });

    test('a full pack does not stop you learning, and a full skill tree does not stop you carrying', () => {
        // One ceiling of 64 rows shared between the two was the arithmetic consequence of one table.
        const inv = new Map();
        for (let at = 0; at < 64; at++) {
            inv.set(itemKey(`thing ${at}`), { qty: 1 });
        }
        const learn = validateInventory({
            inv,
            abilities: new Map(),
            deltas: [{ item: 'flight', dq: 1, at: 'abilities' }],
            windowText: 'he learns to fly',
        });
        expect(learn.rejected).toEqual([]);

        const many = new Map();
        for (let at = 0; at < MAX_ABILITIES; at++) {
            many.set(key(`skill ${at}`), { who: '', name: `skill ${at}` });
        }
        const more = validateInventory({
            inv: new Map(),
            abilities: many,
            deltas: [{ item: 'flight', dq: 1, at: 'abilities' }],
            windowText: 'he learns to fly',
        });
        expect(more.rejected).toEqual([expect.objectContaining({ reason: 'abilities-full' })]);
        // …and the pack is unaffected by a full skill tree.
        const pack = validateInventory({
            inv: new Map(),
            abilities: many,
            deltas: [{ item: 'crowbar', dq: 1 }],
            windowText: 'he picks up a crowbar',
        });
        expect(pack.rejected).toEqual([]);
    });

    test('the ability place holds one of a thing, by construction', () => {
        expect(maxQty(ABILITIES)).toBe(1);
    });

    test('a caller with no ability table refuses nothing extra, the honest degradation', () => {
        // The same fail-open `cast` and `shown` already take: a caller that cannot say what is held
        // must not be allowed to refuse on it.
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'flight', dq: 1, at: 'abilities' }],
            windowText: 'he learns to fly',
        });
        expect(accepted).toEqual([{ item: 'flight', dq: 1, at: 'abilities' }]);
    });

    test('the review never poses a capability as a pack question', () => {
        // `isDisposable`'s reason is unchanged and now redundant by construction, which is the point:
        // the row is not in the table the disposal question is asked about at all.
        expect(isDisposable(key('flight'))).toBe(false);
        expect(isDisposable(itemKey('crowbar'))).toBe(true);
    });
});

describe('nothing migrates, because nothing stored changed', () => {
    test('a ledger written before the split derives into the new table unchanged', () => {
        // The exact three events in the shipped Raccoon City chat, in order. No migration step ran;
        // the read rule is the whole of it.
        const legacy = [
            ev(83, [{ item: 'tier 3 access', dq: 1, at: 'abilities' }]),
            ev(98, [{ item: 'tier 4 access', dq: 1, at: 'abilities' }]),
            ev(120, [{ item: 'tier 4 access', dq: -1, at: 'abilities' }]),
        ];
        const state = deriveState(legacy);
        expect([...state.abilities.keys()]).toEqual([key('tier 3 access')]);
        expect(state.inv.size).toBe(0);
        // Folding the same ledger twice is the same answer, it is a fold, so a "second run" is
        // simply another read and there is no step that could fail to be a no-op.
        expect([...deriveState(legacy).abilities]).toEqual([...state.abilities]);
    });

    test('a carried-forward baseline keeps a capability as presence, never as a count', () => {
        // An evicted grant leaves its contribution in the baseline. Seeding that as `qty` would put
        // the count back the moment the ledger got long enough to shed the event.
        const state = deriveState([], { baseline: new Map([[key('flight'), { qty: 1 }]]) });
        expect(state.inv.size).toBe(0);
        expect(state.abilities.get(key('flight'))).toEqual({ who: '', name: 'flight' });
    });

    test('the trail still explains a capability, because the key never moved', () => {
        const state = deriveState([ev(83, [{ item: 'tier 3 access', dq: 1, at: 'abilities' }])]);
        expect(state.contributors.get(key('tier 3 access'))).toEqual([
            expect.objectContaining({ dq: 1, mid: 83, summary: 'event 83' }),
        ]);
        expect(state.since.get(key('tier 3 access'))).toBe(0);
    });
});

describe('the hand edits speak the same language', () => {
    test('a grant and a revocation are ±1, never a count', () => {
        expect(abilityDelta(key('flight'), true, 'B')).toEqual({ inv: [{ item: 'flight', dq: 1, at: ABILITIES, rank: 'B' }] });
        expect(abilityDelta(key('flight'), false)).toEqual({ inv: [{ item: 'flight', dq: -1, at: ABILITIES }] });
        expect(abilityDelta(key('sword arts', 'Vexia'), true)).toEqual({
            inv: [{ item: 'sword arts', dq: 1, at: ABILITIES, who: 'vexia' }],
        });
    });

    test('a re-grade moves nothing and cannot create a row', () => {
        expect(abilityRankDelta(key('flight'), 'A')).toEqual({ inv: [{ item: 'flight', dq: 0, at: ABILITIES, rank: 'A' }] });
        expect(abilityRankDelta(key('flight'), '   ')).toBeNull();
        // `foldAbility` is the enforcement: a `dq: 0` grade against nothing stays nothing.
        expect(deriveState([ev(1, abilityRankDelta(key('flight'), 'A').inv)]).abilities.size).toBe(0);
    });

    test('forgetting a capability addresses the same events an item edit would', () => {
        // `foldAbility` kept `itemKey`, so `eventsTouching` and `withoutTarget` need only to accept
        // the new target kind, the addressing is identical and cannot drift from the item path.
        const entries = [
            ['e1', { d: { inv: [{ item: 'tier 3 access', dq: 1, at: 'abilities' }, { item: 'crowbar', dq: 1 }] } }],
            ['e2', { d: { inv: [{ item: 'crowbar', dq: 1 }] } }],
        ];
        const target = { kind: 'ability', key: key('tier 3 access') };
        expect(eventsTouching(entries, target)).toEqual(['e1']);
        // Minimal incision: the crowbar that happened to arrive in the same turn survives.
        expect(withoutTarget(entries[0][1].d, target)).toEqual({ inv: [{ item: 'crowbar', dq: 1 }] });
    });
});
