import { describe, expect, test } from '@jest/globals';

import {
    canonicalItemName,
    deriveState,
    itemKey,
    renderLedger,
    renderState,
    validateInventory,
} from '../public/scripts/extensions/sanguine/state-table.js';
import { readParts, splitDelta } from '../public/scripts/extensions/sanguine/edit-table.js';

/*
 * "I specifically said there was 63 9mm rounds instead of just 'ammunition'".
 *
 * The owner's report, and the live Raccoon City ledger carries every step of how it happened.
 *
 *   1. mid 40. The narration: "a Sig P226 with three magazines and a Mossberg 590 with twenty-five
 *      rounds of buckshot plus a box of birdshot". The extraction reported ONE row,
 *      `{item: "ammunition", dq: 28}`: three different, non-interchangeable things summed into a
 *      mass noun. (Trace: `Raccoon City First Day …`, turn 23.)
 *   2. mid 146, 150, 168. The model then tries to correct itself, repeatedly:
 *      `{item: "9mm rounds", same_as: "ammunition"}`, `same_as: "ammunition x29"`. The first
 *      resolves and credits `ammunition`; the second cannot resolve at all, because `ammunition x29`
 *      is what the LEDGER printed and not what fold keys by.
 *   3. The owner repairs it by hand. `9mm rounds x63` and `.45 rounds x15` are `src: 'user'` events
 *      in the shipped chat, and so are the three rows the mid-40 purchase should have produced.
 *
 * Three defects, and this file is the two that live in `state-table.js` and `edit-table.js`. The
 * third: the schema calling for an item name "singular, lowercase" with no clause asking for the
 * story's own words, which is what produced `ammunition` from "twenty-five rounds of buckshot",
 * is in `state.js` `deltaSchema` and is reported rather than changed here.
 */

const ev = (mid, inv) => ({ t: mid, mid, s: '', d: { inv } });
const held = rows => new Map(rows.map(([name, row, place]) => [itemKey(name, place), row]));

describe('same_as is answered against what the ledger PRINTED', () => {
    // MEASURED over every trace file on disk: 1,543 inventory deltas, 215 carrying a `same_as`, and
    // 25 of those (11.6%) unmatched by construction. Every one is the model quoting the rendered
    // line back, the count, the grade, or the story's casing. Each case below is a real string from
    // that sweep, named with the campaign it came from.

    test('a count copied off the ledger line still resolves, Raccoon City, `ammunition x29`', () => {
        const inv = held([['ammunition', { qty: 29 }]]);
        expect(canonicalItemName(inv, '9mm rounds', 'carried', 'ammunition x29')).toBe('ammunition');
    });

    test('…and so does the multiplication sign, which is what `renderState` actually prints', () => {
        const inv = held([['low-grade spirit stone', { qty: 3 }]]);
        expect(canonicalItemName(inv, 'spirit stone', 'carried', 'low-grade spirit stone ×3'))
            .toBe('low-grade spirit stone');
    });

    test('the story\'s own casing resolves, Wuxia, `Basic Iron Sword`', () => {
        const inv = held([['basic iron sword', { qty: 1 }]]);
        expect(canonicalItemName(inv, 'sword', 'carried', 'Basic Iron Sword')).toBe('basic iron sword');
    });

    test('the GRADE the ledger appends resolves, Wuxia, `misty moon lotus Tier-1`', () => {
        // `renderLedger` prints `‹name› ‹rank›`, so the model copies the grade back as part of the
        // name. The row is found by rebuilding the exact label fold itself printed.
        const inv = held([['misty moon lotus', { qty: 1, rank: 'Tier-1' }]]);
        expect(canonicalItemName(inv, 'lotus', 'carried', 'misty moon lotus Tier-1'))
            .toBe('misty moon lotus');
    });

    test('a face the ledger printed resolves, even when the key is lowercase', () => {
        const inv = held([['sig p226', { qty: 1 }]]);
        const faces = new Map([[itemKey('sig p226'), 'SIG P226']]);
        expect(canonicalItemName(inv, 'handgun', 'carried', 'SIG P226', '', faces)).toBe('sig p226');
    });

    test('and none of this invents a merge, an unheld name is still its own row', () => {
        // The whole set is EXACT equality against strings fold itself wrote down. Nothing here is a
        // stemmer, a stopword list or a similarity score, so a name fold has never seen stays new.
        const inv = held([['ammunition', { qty: 29 }]]);
        expect(canonicalItemName(inv, 'shotgun shells', 'carried', 'buckshot x25')).toBe('shotgun shells');
        expect(canonicalItemName(inv, 'rope', 'carried', '')).toBe('rope');
    });

    test('scoped to the owner, because "the one you already have" is about one person\'s things', () => {
        const inv = new Map([[itemKey('ironwood branch', 'carried', 'Kaelira'), { qty: 1 }]]);
        expect(canonicalItemName(inv, 'branch', 'carried', 'ironwood branch x1')).toBe('branch');
        expect(canonicalItemName(inv, 'branch', 'carried', 'ironwood branch x1', 'Kaelira'))
            .toBe('ironwood branch');
    });
});

describe('the face: the story\'s own casing, which fold has been discarding since faces existed', () => {
    test('a name with capitals reaches the fold and the block', () => {
        // `normalizeItemName` has always returned `{name, display}`, `deriveState` has always kept a
        // `faces` map, and `snapshot` has always read it. None of it ran: the accepted delta carried
        // `item: canonical`, the lowercase KEY, so the casing died at the write and the map was
        // never written at all. Read straight off the live Raccoon City ledger: `{"item":"sig p226"}`.
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'SIG P226', same_as: '', dq: 1, set: 0, magnitude: 1, at: 'carried', rank: '', who: '' }],
            windowText: 'Dale slides the SIG P226 across the counter.',
            mentioned: new Set(['SIG P226']),
        });
        expect(accepted).toEqual([{ item: 'sig p226', dq: 1, face: 'SIG P226' }]);

        const state = deriveState([ev(1, accepted)]);
        expect(state.faces.get(itemKey('sig p226'))).toBe('SIG P226');
        expect(renderState(state)).toContain('SIG P226');
        expect(renderLedger(state).lines.join('\n')).toContain('SIG P226');
    });

    test('an all-lowercase name carries no face at all, so nothing is spent saying nothing', () => {
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'gum', same_as: '', dq: 1, set: 0, magnitude: 1, at: 'carried', rank: '', who: '' }],
            windowText: 'a packet of gum',
            mentioned: new Set(['gum']),
        });
        expect(accepted).toEqual([{ item: 'gum', dq: 1 }]);
    });

    test('a same_as merge does NOT rename the row, and the Time Stop ledger is why', () => {
        // The tempting extension is to take the model's word whenever `same_as` resolved, so
        // `{item: "9mm rounds", same_as: "ammunition"}` re-labels what it merged into. The identical
        // shape carries the opposite intent one campaign over: Time Stop's
        // `{item: "locket", same_as: "silver moon locket"}` is a SHORTHAND for a row fold names
        // better than the model just did. Nothing in `{item, same_as}` separates a refinement from an
        // abbreviation without reading the two names, which fold does not do, so `same_as` stays an
        // identity claim and renaming is left to something that says so outright.
        const inv = held([['silver moon locket', { qty: 1 }]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'locket', same_as: 'silver moon locket', dq: -1 }],
            windowText: 'you place the locket in her palm',
            mentioned: new Set(['locket']),
        });
        expect(accepted).toEqual([{ item: 'silver moon locket', dq: -1 }]);

        const generic = validateInventory({
            inv: held([['ammunition', { qty: 29 }]]),
            deltas: [{ item: '9mm rounds', same_as: 'ammunition', dq: 1 }],
            windowText: 'a box of 9mm rounds in the glovebox',
            mentioned: new Set(['9mm rounds']),
        });
        expect(generic.accepted).toEqual([{ item: 'ammunition', dq: 1 }]);
    });
});

describe('splitting the row that turned out to be several things', () => {
    test('readParts takes a count from either side of the name, or neither', () => {
        expect(readParts('9mm magazines x3\n25x buckshot shells\nbox of birdshot'))
            .toEqual([
                { name: '9mm magazines', qty: 3 },
                { name: 'buckshot shells', qty: 25 },
                { name: 'box of birdshot', qty: 1 },
            ]);
    });

    test('blank lines and decoration are not parts', () => {
        expect(readParts('\n  \n**rope**\n')).toEqual([{ name: 'rope', qty: 1 }]);
    });

    test('the Raccoon City repair, as ONE transfer instead of four dialogs', () => {
        // `ammunition x28` is really three magazines, twenty-five buckshot shells and a box of
        // birdshot. The debit is the sum, so the source empties and `deriveState` drops it, and the
        // whole correction is one event, which a swipe takes or leaves as a unit.
        const parts = readParts('9mm magazines x3\nbuckshot shells x25\nbox of birdshot');
        const delta = splitDelta(itemKey('ammunition'), parts, 28);
        expect(delta.inv[0]).toEqual({ item: 'ammunition', dq: -28 });
        expect(delta.inv.slice(1)).toEqual([
            { item: '9mm magazines', dq: 3 },
            { item: 'buckshot shells', dq: 25 },
            { item: 'box of birdshot', dq: 1 },
        ]);

        const state = deriveState([ev(1, [{ item: 'ammunition', dq: 28 }]), ev(2, delta.inv)]);
        expect(state.inv.get(itemKey('ammunition'))).toBeUndefined();
        expect(state.inv.get(itemKey('9mm magazines')).qty).toBe(3);
        expect(state.inv.get(itemKey('buckshot shells')).qty).toBe(25);
    });

    test('the DEBIT is bounded by the row; the parts are the player\'s own count', () => {
        // The row can only pay what it holds, so the debit clamps and `merge_qty`'s floor is never
        // reached. The credits are not clamped: `setItemQty` already treats the player's number as
        // authoritative, and clamping the parts instead silently dropped the box of birdshot out of
        // the Raccoon City repair, because the magazines and the shells had used the row up first.
        const delta = splitDelta(itemKey('ammunition'), [{ name: 'flares', qty: 40 }], 10);
        expect(delta.inv).toEqual([{ item: 'ammunition', dq: -10 }, { item: 'flares', dq: 40 }]);
    });

    test('a leftover keeps the old name and says so on the panel', () => {
        // Honest about a player who accounted for 25 of 28 rather than silently zeroing the row.
        const delta = splitDelta(itemKey('ammunition'), [{ name: 'buckshot shells', qty: 25 }], 28);
        const state = deriveState([ev(1, [{ item: 'ammunition', dq: 28 }]), ev(2, delta.inv)]);
        expect(state.inv.get(itemKey('ammunition')).qty).toBe(3);
        expect(state.inv.get(itemKey('buckshot shells')).qty).toBe(25);
    });

    test('the place and the owner ride across every part', () => {
        // Read back off the key, so they arrive already normalised, `the suv` keyed as `suv`, and
        // `Danny` as the owner key the cast table uses. A split must not quietly move a companion's
        // supplies into the player's pack.
        const delta = splitDelta(itemKey('supplies', 'the suv', 'Danny'), [{ name: 'rations', qty: 2 }], 5);
        expect(delta.inv).toEqual([
            { item: 'supplies', dq: -2, at: 'suv', who: 'danny' },
            { item: 'rations', dq: 2, at: 'suv', who: 'danny' },
        ]);
    });

    test('a split into the name it already has, or into nothing, is not a split', () => {
        expect(splitDelta(itemKey('ammunition'), [{ name: 'ammunition', qty: 5 }], 28)).toBeNull();
        expect(splitDelta(itemKey('ammunition'), [], 28)).toBeNull();
        expect(splitDelta(itemKey('ammunition'), [{ name: 'flares' }], 0)).toBeNull();
    });

    test('the model can already express the same thing, with no schema change', () => {
        // A split is two halves of a transfer and the delta schema has always allowed several `inv`
        // entries per event, so this passes every gate as it stands: the debit is against a held row
        // and the credit is a first sighting. What is missing is the INSTRUCTION telling it to, which
        // is `state.js` `deltaInstruction` and is reported rather than changed here.
        const { accepted, rejected } = validateInventory({
            inv: held([['ammunition', { qty: 28 }]]),
            deltas: [
                { item: 'ammunition', same_as: '', dq: -25, set: 0, magnitude: 25, at: 'carried', rank: '', who: '' },
                { item: 'buckshot shells', same_as: '', dq: 25, set: 0, magnitude: 25, at: 'carried', rank: '', who: '' },
            ],
            windowText: 'twenty-five of them are buckshot shells',
            mentioned: new Set(['ammunition', 'buckshot shells']),
        });
        expect(rejected).toEqual([]);
        expect(accepted).toEqual([
            { item: 'ammunition', dq: -25 },
            { item: 'buckshot shells', dq: 25 },
        ]);
    });
});
