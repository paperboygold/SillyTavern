import { describe, expect, test } from '@jest/globals';

import {
    deletionDelta,
    editSummary,
    eventsTouching,
    isMoney,
    withoutTarget,
    moveDelta,
    renameDelta,
    vitalDelta,
} from '../public/scripts/extensions/sanguine/edit-table.js';
import { deriveState, itemKey, markKey, MONEY } from '../public/scripts/extensions/sanguine/state-table.js';

const ev = (t, d, k = `k${t}`) => ({ s: 'something happened', kw: [], t, src: 'llm', k, d });
/* `eventsTouching` takes [tableKey, event] pairs. An event's own `k` is its ANCHOR, the content
 * hash of the message it came from, or USER_ANCHOR for a hand edit, and several events share one,
 * so addressing `forget` with it deletes nothing while looking like it worked. */
const entry = (key, event) => [key, event];

/*
 * A hand edit is an event, not an assignment. RPG Companion can splice its array and re-serialise
 * (`inventoryActions.js:238`) because its inventory IS the stored value; sanguine's is a fold over
 * an append-only ledger, so a write to `state.inv` is a write to a shadow that the next derive
 * overwrites. These gates pin the deltas that stand in for assignment.
 */
describe('a hand edit is a delta, and the fold is the judge of it', () => {
    test('deleting a held row takes it to zero and the fold drops it', () => {
        const events = [ev(1, { inv: [{ item: 'sword', dq: 3 }] })];
        const key = itemKey('sword');
        const { inv } = deriveState(events);
        expect(inv.get(key).qty).toBe(3);

        const delta = deletionDelta(key, inv.get(key).qty);
        const after = deriveState([...events, ev(2, delta)]);
        expect(after.inv.has(key)).toBe(false);
    });

    test('the deletion is a negative delta, never a zero restatement', () => {
        // `set: 0` reads as "not a restatement" throughout the fold, strict mode forces the field
        // into every row, so a zeroing set would silently do nothing.
        const delta = deletionDelta(itemKey('sword'), 3);
        expect(delta.inv[0]).toEqual({ item: 'sword', dq: -3 });
        expect(delta.inv[0].set).toBeUndefined();
    });

    test('deleting nothing is nothing', () => {
        expect(deletionDelta(itemKey('sword'), 0)).toBeNull();
        expect(deletionDelta('', 3)).toBeNull();
    });

    test('a place rides the delta so the fold lands on the right row', () => {
        const delta = deletionDelta(itemKey('anvil', 'sanguine'), 1);
        expect(delta.inv[0]).toEqual({ item: 'anvil', dq: -1, at: 'sanguine' });
    });

    test('a move is a loss here and a gain there, which is one event', () => {
        const events = [ev(1, { inv: [{ item: 'anvil', dq: 1 }] })];
        const from = itemKey('anvil');
        const delta = moveDelta(from, 'the estate', 1);
        const { inv } = deriveState([...events, ev(2, delta)]);
        expect(inv.has(from)).toBe(false);
        expect(inv.get(itemKey('anvil', 'the estate')).qty).toBe(1);
    });

    test('a move to where it already is changes nothing', () => {
        expect(moveDelta(itemKey('anvil', 'vault'), 'vault', 1)).toBeNull();
    });

    test('a rename carries the quantity to the new name and leaves no ghost', () => {
        const events = [ev(1, { inv: [{ item: 'iron sword', dq: 2 }] })];
        const from = itemKey('iron sword');
        const { inv } = deriveState([...events, ev(2, renameDelta(from, 'Steel Sword', 2))]);
        expect(inv.has(from)).toBe(false);
        expect(inv.get(itemKey('steel sword')).qty).toBe(2);
    });

    test('a rename to the same name is refused rather than recorded', () => {
        expect(renameDelta(itemKey('sword'), 'Sword', 1)).toBeNull();
        expect(renameDelta(itemKey('sword'), '   ', 1)).toBeNull();
    });

    test('setting a gauge sends the difference, because dcur is a change', () => {
        const events = [ev(1, { vit: [{ name: 'hp', dcur: 0, max: 100 }] }), ev(2, { vit: [{ name: 'hp', dcur: -20 }] })];
        const { vitals } = deriveState(events);
        expect(vitals.get('hp')).toMatchObject({ cur: 80, max: 100 });

        const delta = vitalDelta('hp', { cur: 95 }, vitals.get('hp'));
        expect(delta.vit[0].dcur).toBe(15);
        const after = deriveState([...events, ev(3, delta)]);
        expect(after.vitals.get('hp').cur).toBe(95);
    });

    test('a ceiling rides only when it moves, because max 0 means "not stated"', () => {
        const held = { cur: 80, max: 100 };
        expect(vitalDelta('hp', { cur: 80, max: 100 }, held)).toBeNull();
        expect(vitalDelta('hp', { cur: 80, max: 120 }, held).vit[0].max).toBe(120);
        expect(vitalDelta('hp', { cur: 90, max: 100 }, held).vit[0].max).toBeUndefined();
    });

    test('money is recognised by its place, not by its name', () => {
        expect(isMoney(itemKey('spirit stones', MONEY))).toBe(true);
        expect(isMoney(itemKey('spirit stones'))).toBe(false);
    });
});

/*
 * Forgetting: for the row that was never true.
 *
 * Recording "lost 1 phantom sword" to remove a row the model hallucinated would put fiction in the
 * audit trail in order to correct fiction on the panel. `forget` erases the events that asserted
 * it instead, and `contributors` deliberately carries no event key, so the address is recovered by
 * matching on fold's own keys.
 */
describe('finding the events behind a row, so forgetting can be exact', () => {
    test('an item is matched by its full key, place and owner included', () => {
        const events = [
            ev(1, { inv: [{ item: 'sword', dq: 1 }] }, 'a'),
            ev(2, { inv: [{ item: 'sword', dq: 1, at: 'vault' }] }, 'b'),
            ev(3, { inv: [{ item: 'shield', dq: 1 }] }, 'c'),
        ];
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'item', key: itemKey('sword') })).toEqual(['t0']);
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'item', key: itemKey('sword', 'vault') })).toEqual(['t1']);
    });

    test('every event that touched the row is returned, oldest first', () => {
        const events = [
            ev(1, { inv: [{ item: 'coin', dq: 5, at: MONEY }] }, 'a'),
            ev(2, { inv: [{ item: 'bread', dq: 1 }] }, 'b'),
            ev(3, { inv: [{ item: 'coin', dq: -2, at: MONEY }] }, 'c'),
        ];
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'item', key: itemKey('coin', MONEY) })).toEqual(['t0', 't2']);
    });

    test('a gauge is matched by its normalised name', () => {
        const events = [ev(1, { vit: [{ name: 'HP', dcur: -5 }] }, 'a'), ev(2, { vit: [{ name: 'stamina', dcur: -1 }] }, 'b')];
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'vital', key: 'hp' })).toEqual(['t0']);
    });

    test('a mark is matched by owner and subject together', () => {
        const events = [
            ev(1, { st: [{ who: 'lee', subject: 'ribs', flag: 'cracked ribs', on: true }] }, 'a'),
            ev(2, { st: [{ who: 'mara', subject: 'ribs', flag: 'bruised ribs', on: true }] }, 'b'),
        ];
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'mark', key: markKey('lee', 'ribs') })).toEqual(['t0']);
    });

    test('a near miss is not a match, forgetting a neighbour is worse than not forgetting', () => {
        const events = [ev(1, { inv: [{ item: 'iron sword', dq: 1 }] }, 'a')];
        expect(eventsTouching(events.map((e, i) => entry(`t${i}`, e)), { kind: 'item', key: itemKey('sword') })).toEqual([]);
    });

    test('events with no delta and unknown kinds are skipped, not thrown at', () => {
        expect(eventsTouching([entry('t0', { k: 'a', s: 'no delta' })], { kind: 'item', key: 'x' })).toEqual([]);
        expect(eventsTouching(null, { kind: 'item', key: 'x' })).toEqual([]);
        expect(eventsTouching([entry('t0', ev(1, { inv: [{ item: 'x', dq: 1 }] }))], { kind: 'nonsense', key: 'x' })).toEqual([]);
    });

    test('forgetting every source leaves the fold with no row at all', () => {
        // The property that makes this the right primitive for a hallucinated row: nothing is
        // recorded as having happened, because nothing did.
        // Both events share one anchor, as every hand edit does, which is precisely why the
        // address must be the table key.
        const events = [ev(1, { inv: [{ item: 'phantom', dq: 1 }] }, 'usr'), ev(2, { inv: [{ item: 'real', dq: 1 }] }, 'usr')];
        const entries = events.map((e, i) => entry(`t${i}`, e));
        const doomed = new Set(eventsTouching(entries, { kind: 'item', key: itemKey('phantom') }));
        expect(doomed).toEqual(new Set(['t0']));
        const { inv } = deriveState(entries.filter(([k]) => !doomed.has(k)).map(([, e]) => e));
        expect(inv.has(itemKey('phantom'))).toBe(false);
        expect(inv.has(itemKey('real'))).toBe(true);
    });
});

describe('summaries', () => {
    test('a summary names the verb and the subject, and is bounded', () => {
        expect(editSummary('Removed', 'iron sword')).toBe('Removed iron sword');
        expect(editSummary('Renamed', 'sword', 'to steel sword')).toBe('Renamed sword, to steel sword');
        expect(editSummary('Removed', 'x'.repeat(500)).length).toBeLessThanOrEqual(200);
    });
});

/*
 * Forgetting a row must not forget its neighbours.
 *
 * `eventsTouching` finds every event that asserted a row, and `forgetRow` deleted each one WHOLE.
 * That is the maximal incision: lawful, and strictly more than was asked for.
 *
 * MEASURED, live Raccoon City campaign: 6 of 19 inventory-bearing events carry more than one row,
 * and the largest carries TEN,
 *
 *   "Solomon searches the SUV's glovebox and center console…"
 *   maps · flashlight · ammunition · notebook · pen · gum ·
 *   tactical bag · change of clothes · med kit · shotgun shells
 *
 * so pressing × on Gum ("Never had it, erases the events that claimed it") silently destroyed the
 * ammunition, the med kit and seven other things.
 *
 * The corpus states both halves. `full_removal_is_an_incision`
 * (`sanguine/proof/Substrate/Algebra/Security/BeliefContraction.lean:361`), deleting everything
 * does retract the belief. `maximal_removal_overshoots` (`:579`), and it destroys every belief
 * carried only by bystander events, which a minimal cut provably keeps. `removal_succeeds_iff`
 * (`:308`) names the right operator: cut every kernel, and nothing else.
 *
 * Here the kernel of "the pack holds gum" is the `inv` entry naming gum, not the event around it.
 */
describe('a minimal incision cuts the row, not the turn it arrived in', () => {
    const glovebox = {
        inv: [
            { item: 'maps', dq: 1 }, { item: 'flashlight', dq: 1 }, { item: 'gum', dq: 1 },
            { item: 'med kit', dq: 1 }, { item: 'shotgun shells', dq: 1 },
        ],
    };

    test('the bystanders survive', () => {
        const rest = withoutTarget(glovebox, { kind: 'item', key: itemKey('gum') });
        expect(rest.inv.map(c => c.item)).toEqual(['maps', 'flashlight', 'med kit', 'shotgun shells']);
    });

    test('and the fold agrees: nine items in, eight out, gum gone', () => {
        const events = [ev(1, glovebox)];
        expect(deriveState(events).inv.size).toBe(5);
        const cut = deriveState([ev(1, withoutTarget(glovebox, { kind: 'item', key: itemKey('gum') }))]);
        expect(cut.inv.size).toBe(4);
        expect(cut.inv.has(itemKey('gum'))).toBe(false);
        expect(cut.inv.get(itemKey('med kit')).qty).toBe(1);
    });

    test('an event that carried only the target is left with nothing, and says so', () => {
        // null is the signal to `forget` the event outright, the incision and the deletion agree
        // when the event has no bystanders.
        expect(withoutTarget({ inv: [{ item: 'gum', dq: 1 }] }, { kind: 'item', key: itemKey('gum') })).toBeNull();
    });

    test('a place is part of the address, so a pocket copy is not the pack copy', () => {
        const both = { inv: [{ item: 'gum', dq: 1 }, { item: 'gum', dq: 2, at: 'the van' }] };
        const rest = withoutTarget(both, { kind: 'item', key: itemKey('gum') });
        expect(rest.inv).toEqual([{ item: 'gum', dq: 2, at: 'the van' }]);
    });

    test('vitals and marks cut the same way, and leave the other arrays alone', () => {
        const mixed = {
            inv: [{ item: 'rope', dq: 1 }],
            vit: [{ name: 'hp', dcur: -3 }, { name: 'mana', dcur: -1 }],
            st: [{ who: 'lee', subject: 'ribs', flag: 'cracked ribs', on: true }],
        };
        const noHp = withoutTarget(mixed, { kind: 'vital', key: 'hp' });
        expect(noHp.vit).toEqual([{ name: 'mana', dcur: -1 }]);
        expect(noHp.inv).toEqual([{ item: 'rope', dq: 1 }]);
        expect(noHp.st).toHaveLength(1);

        const noMark = withoutTarget(mixed, { kind: 'mark', key: markKey('lee', 'ribs') });
        expect(noMark.st).toBeUndefined();
        expect(noMark.vit).toHaveLength(2);
    });

    test('a delta the target never touched comes back unchanged', () => {
        expect(withoutTarget(glovebox, { kind: 'item', key: itemKey('anvil') })).toEqual(glovebox);
    });

    test('is total over junk', () => {
        expect(withoutTarget(null, { kind: 'item', key: 'x' })).toBeNull();
        expect(withoutTarget({}, { kind: 'item', key: 'x' })).toBeNull();
    });
});
