import { describe, expect, test } from '@jest/globals';

import {
    deriveState,
    isFresh,
    isMentioned,
    MAX_DELTA,
    normalizeItemName,
    normalizeKey,
    renderState,
    STALE_THRESHOLD,
    validateInventory,
    validateStatus,
    validateVitals,
} from '../public/scripts/extensions/fold/state-table.js';

/**
 * Build an event carrying a delta.
 * @param {number} t Timestamp.
 * @param {object} d Delta.
 * @param {string} [s] Summary.
 * @returns {object} An event.
 */
const ev = (t, d, s = 'something happened') => ({ s, kw: [], t, src: 'llm', d });

describe('normalizeItemName', () => {
    test('lowercases and trims', () => {
        expect(normalizeItemName('  Healing Potion  ')).toEqual({ name: 'healing potion', qty: null });
    });

    test('strips the decoration models actually emit', () => {
        for (const raw of ['**Sword**', '- Sword', '1. Sword', '`Sword`', '"Sword"', '[Sword]', '* Sword']) {
            expect(normalizeItemName(raw)?.name).toBe('sword');
        }
    });

    test('pulls a leading quantity out of the name', () => {
        // Models write "3x potion" at least as often as they fill in a quantity field.
        expect(normalizeItemName('3x Healing Potion')).toEqual({ name: 'healing potion', qty: 3 });
        expect(normalizeItemName('2 gold coins')).toEqual({ name: 'gold coins', qty: 2 });
    });

    test('pulls a trailing quantity out of the name', () => {
        expect(normalizeItemName('Healing Potion x3')).toEqual({ name: 'healing potion', qty: 3 });
    });

    test('rejects nothing-shaped and dangerous names', () => {
        for (const raw of ['', '   ', null, undefined, 'None', '__proto__', 'constructor', 'prototype']) {
            expect(normalizeItemName(raw)).toBeNull();
        }
    });

    test('caps absurd lengths', () => {
        expect(normalizeItemName('x'.repeat(500)).name.length).toBeLessThanOrEqual(64);
    });
});

describe('normalizeKey', () => {
    test('normalizes and rejects the same way', () => {
        expect(normalizeKey('  Health  ')).toBe('health');
        expect(normalizeKey('__proto__')).toBeNull();
        expect(normalizeKey('')).toBeNull();
    });
});

describe('isMentioned — the mention gate', () => {
    test('matches on the head of the noun phrase', () => {
        expect(isMentioned('healing potion', 'she drank the potion')).toBe(true);
        expect(isMentioned('iron sword', 'he drew his sword')).toBe(true);
    });

    test('ignores parenthetical qualifiers', () => {
        expect(isMentioned('potion (minor)', 'she drank the potion')).toBe(true);
    });

    test('rejects what the narrative never mentions', () => {
        expect(isMentioned('dragon egg', 'she walked to the river')).toBe(false);
    });

    test('a modifier alone does not smuggle an item past the gate', () => {
        // Any-token matching let "dragon egg" through a scene that only mentioned a Dragon Keep,
        // which is precisely how a model invents an item while looking like it is grounded.
        expect(isMentioned('dragon egg', 'they travelled to the Dragon Keep')).toBe(false);
        expect(isMentioned('silver crown', 'she counted the silver coins')).toBe(false);
    });

    test('matches the full phrase when it appears verbatim', () => {
        expect(isMentioned('dragon egg', 'a dragon egg lay in the nest')).toBe(true);
    });

    test('matches a plural in the narrative', () => {
        expect(isMentioned('silver coin', 'he handed over three silver coins')).toBe(true);
    });

    test('is total over empty input', () => {
        expect(isMentioned('sword', '')).toBe(false);
        expect(isMentioned('', 'anything')).toBe(false);
    });
});

describe('validateInventory — the model proposes, the merge disposes', () => {
    const base = { inv: new Map(), windowText: 'she picked up a rope and two coins' };

    test('accepts a mentioned, plausible gain', () => {
        const result = validateInventory({ ...base, deltas: [{ item: 'rope', dq: 1 }] });
        expect(result.accepted).toEqual([{ item: 'rope', dq: 1 }]);
        expect(result.rejected).toEqual([]);
    });

    test('rejects a change to something the narrative never mentions', () => {
        // The strongest rule: a model cannot invent state changes for things nobody talked about.
        const result = validateInventory({ ...base, deltas: [{ item: 'dragon egg', dq: 1 }] });
        expect(result.accepted).toEqual([]);
        expect(result.rejected[0].reason).toBe('not-mentioned');
    });

    test('rejects an implausible magnitude', () => {
        const result = validateInventory({ ...base, deltas: [{ item: 'rope', dq: MAX_DELTA + 1 }] });
        expect(result.rejected[0].reason).toBe('implausible-delta');
    });

    test('rejects removing something never held', () => {
        const result = validateInventory({ ...base, deltas: [{ item: 'rope', dq: -1 }] });
        expect(result.rejected[0].reason).toBe('remove-unknown');
    });

    test('clamps underflow rather than rejecting it', () => {
        // Our count may simply be behind; the narrative is the better authority on what happened.
        const inv = new Map([['rope', { qty: 1 }]]);
        const result = validateInventory({ ...base, inv, deltas: [{ item: 'rope', dq: -5 }] });
        expect(result.accepted).toEqual([{ item: 'rope', dq: -5 }]);
        expect(result.rejected[0].reason).toBe('clamped-underflow');
    });

    test('uses a quantity baked into the name when no delta was given', () => {
        const result = validateInventory({ ...base, deltas: [{ item: '2 coins', dq: 0 }] });
        expect(result.accepted).toEqual([{ item: 'coins', dq: 2 }]);
    });

    test('rate-limits a flood of changes', () => {
        const deltas = Array.from({ length: 20 }, () => ({ item: 'rope', dq: 1 }));
        const result = validateInventory({ ...base, deltas });
        expect(result.accepted.length).toBeLessThanOrEqual(8);
        expect(result.rejected.some(r => r.reason === 'rate-limited')).toBe(true);
    });

    test('is total over junk', () => {
        expect(validateInventory({ ...base, deltas: null }).accepted).toEqual([]);
        expect(validateInventory({ ...base, deltas: [null, {}] }).accepted).toEqual([]);
    });
});

describe('validateVitals', () => {
    test('accepts a mentioned change', () => {
        const result = validateVitals({
            vitals: new Map(), deltas: [{ name: 'health', dcur: -10, max: 50 }],
            windowText: 'the blow cost her health',
        });
        expect(result.accepted[0]).toMatchObject({ name: 'health', dcur: -10, max: 50 });
    });

    test('rejects a max that moves more than half in one turn', () => {
        const vitals = new Map([['health', { cur: 40, max: 50 }]]);
        const result = validateVitals({
            vitals, deltas: [{ name: 'health', dcur: 0, max: 500 }],
            windowText: 'her health held steady',
        });
        expect(result.rejected[0].reason).toBe('implausible-max');
    });
});

describe('validateStatus', () => {
    test('accepts a mentioned flag and rejects an invented one', () => {
        const result = validateStatus({
            status: new Map(),
            deltas: [{ flag: 'poisoned', on: true }, { flag: 'cursed', on: true }],
            windowText: 'the venom left her poisoned',
        });
        expect(result.accepted).toEqual([{ flag: 'poisoned', on: true }]);
        expect(result.rejected[0].reason).toBe('not-mentioned');
    });
});

describe('deriveState — state is a fold over the ledger', () => {
    test('quantities accumulate across events', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }),
            ev(2, { inv: [{ item: 'coin', dq: 2 }] }),
        ]);
        expect(inv.get('coin')).toEqual({ qty: 5 });
    });

    test('an item spent down to zero leaves the inventory', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }),
            ev(2, { inv: [{ item: 'coin', dq: -3 }] }),
        ]);
        expect(inv.has('coin')).toBe(false);
    });

    test('events fold in chronological order regardless of array order', () => {
        const out = deriveState([
            ev(2, { inv: [{ item: 'coin', dq: -1 }] }),
            ev(1, { inv: [{ item: 'coin', dq: 5 }] }),
        ]);
        expect(out.inv.get('coin')).toEqual({ qty: 4 });
    });

    test('dropping an event un-does its effect — branch-awareness for free', () => {
        // This is the payoff of deriving rather than storing: pass only the events live on this
        // swipe and the inventory is automatically the inventory of this branch.
        const all = [
            ev(1, { inv: [{ item: 'rope', dq: 1 }] }),
            ev(2, { inv: [{ item: 'sword', dq: 1 }] }),
        ];
        expect(deriveState(all).inv.has('sword')).toBe(true);
        expect(deriveState(all.slice(0, 1)).inv.has('sword')).toBe(false);
    });

    test('vitals clamp to their maximum and floor at zero', () => {
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'health', dcur: 0, max: 50 }] }),
            ev(2, { vit: [{ name: 'health', dcur: -80 }] }),
        ]);
        expect(vitals.get('health')).toEqual({ cur: 0, max: 50 });

        const healed = deriveState([
            ev(1, { vit: [{ name: 'health', dcur: 0, max: 50 }] }),
            ev(2, { vit: [{ name: 'health', dcur: -20 }] }),
            ev(3, { vit: [{ name: 'health', dcur: 999 }] }),
        ]);
        expect(healed.vitals.get('health')).toEqual({ cur: 50, max: 50 });
    });

    test('status flags clear, because status is the Map face and not the Set face', () => {
        const { status } = deriveState([
            ev(1, { st: [{ flag: 'poisoned', on: true }] }),
            ev(2, { st: [{ flag: 'poisoned', on: false }] }),
        ]);
        expect(status.get('poisoned').on).toBe(false);
    });

    test('records the audit trail for every quantity', () => {
        const { contributors } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }, 'Found three coins'),
            ev(2, { inv: [{ item: 'coin', dq: -1 }] }, 'Paid the toll'),
        ]);
        expect(contributors.get('coin')).toEqual([
            { at: 1, dq: 3, summary: 'Found three coins' },
            { at: 2, dq: -1, summary: 'Paid the toll' },
        ]);
    });

    test('staleness is derived from position in the ledger, not stored', () => {
        const events = [
            ev(1, { inv: [{ item: 'rope', dq: 1 }] }),
            ev(2, { inv: [{ item: 'coin', dq: 1 }] }),
            ev(3, {}),
            ev(4, {}),
        ];
        const { since } = deriveState(events);
        expect(since.get('rope')).toBe(3);
        expect(since.get('coin')).toBe(2);
    });

    test('ignores events with no delta, and is total over junk', () => {
        expect(deriveState([]).inv.size).toBe(0);
        expect(deriveState(null).inv.size).toBe(0);
        expect(deriveState([{ s: 'no delta', t: 1 }]).inv.size).toBe(0);
    });
});

describe('isFresh / renderState', () => {
    test('an item stops rendering once it goes stale, but stays in the ledger', () => {
        const inv = new Map([['lantern', { qty: 1 }]]);
        const stale = new Map([['lantern', STALE_THRESHOLD]]);
        expect(isFresh('lantern', stale)).toBe(false);
        expect(renderState({ inv, vitals: new Map(), status: new Map(), since: stale })).toBe('');
        // Still held — soft-hidden, not deleted.
        expect(inv.has('lantern')).toBe(true);
    });

    test('renders a compact block', () => {
        const block = renderState({
            inv: new Map([['rope', { qty: 1 }], ['coin', { qty: 42 }]]),
            vitals: new Map([['health', { cur: 34, max: 50 }]]),
            status: new Map([['poisoned', { on: true }], ['blessed', { on: false }]]),
        });
        expect(block).toContain('Vitals: health 34/50');
        expect(block).toContain('Status: poisoned');
        expect(block).not.toContain('blessed');
        expect(block).toContain('Carrying: rope, coin x42');
    });

    test('renders nothing at all when there is nothing to say', () => {
        expect(renderState({ inv: new Map(), vitals: new Map(), status: new Map() })).toBe('');
    });
});
