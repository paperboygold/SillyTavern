import { describe, expect, test } from '@jest/globals';
import {
    ancestorsOf,
    childrenOf,
    foldPlace,
    resolvePlace,
} from '../public/scripts/extensions/sanguine/place-table.js';

/*
 * The contract the panel's location block reads through.
 *
 * `panel.js` `locationBlock` renders the scene's place at whatever depth the record supports:
 * a breadcrumb of containers, the place's standing `facts`, its current `detail`, and the live
 * places inside it, the "guest room, kitchen" split the owner asked for.
 *
 * `panel.js` imports `script.js` and cannot be loaded here, so this pins the three helpers it
 * reads and the exact SHAPES it reads them at. Every assertion below corresponds to a line of
 * that function, and all three were got wrong on the first attempt:
 *
 *   · `resolvePlace` answers `{key, row}`, not a bare key. Passing its result to `table.get`
 *     yields undefined, which fails open, so the feature would have rendered nothing, forever,
 *     and looked like "the record is still empty" rather than like a bug.
 *   · `childrenOf` answers `{key, row}` wrappers, so a child's name is one level down.
 *   · `ancestorsOf` walks NEAREST first, so the two worth showing are at the front, not the back.
 *
 * The fail-open case is the one that matters most in practice: all 22 live chats hold zero place
 * rows, so every one of them takes that path on every render.
 */

/** The owner's own example: a home built room by room. */
function farmhouse() {
    const table = new Map();
    foldPlace(table, { name: 'the farmhouse', facts: 'two storeys, north-facing, always cold', turn: 1 });
    foldPlace(table, { name: 'the kitchen', place: 'the farmhouse', facts: 'flagstone floor', detail: 'bread proving on the counter', turn: 2 });
    foldPlace(table, { name: 'the guest room', place: 'the farmhouse', facts: 'narrow bed, sloped ceiling', turn: 2 });
    foldPlace(table, { name: 'the cellar', place: 'the farmhouse', turn: 2 });
    foldPlace(table, { name: 'the pantry', place: 'the kitchen', facts: 'no window', turn: 3 });
    return table;
}

/** The breadcrumb `locationBlock` builds, as one string. */
function crumb(table, said) {
    const found = resolvePlace(table, said);
    if (!found) {
        return '';
    }
    const chain = ancestorsOf(table, found.key).slice(0, 2).reverse();
    return [...chain.map(up => up.row?.name ?? ''), found.row.name].join(' ▸ ');
}

/** The `inside:` line `locationBlock` builds, as one string. */
function inside(table, said) {
    const found = resolvePlace(table, said);
    if (!found) {
        return '';
    }
    return childrenOf(table, found.key)
        .filter(child => !String(child.row?.status ?? '').trim())
        .slice(0, 6)
        .map(child => child.row?.name ?? '')
        .filter(Boolean)
        .join(' · ');
}

describe('the location block reads the place record', () => {
    test('resolvePlace answers a {key, row} pair, not a bare key', () => {
        const found = resolvePlace(farmhouse(), 'the kitchen');
        expect(typeof found).toBe('object');
        expect(typeof found.key).toBe('string');
        expect(found.row.name).toBe('the kitchen');
    });

    test('a room names the house that contains it', () => {
        expect(crumb(farmhouse(), 'the kitchen')).toBe('the farmhouse ▸ the kitchen');
    });

    test('the breadcrumb keeps the NEAREST two containers, read outside-in', () => {
        // Three deep. Nearest-first order would have shown the farmhouse and dropped the kitchen,
        // exactly backwards, since the kitchen is the one you need to know you are in.
        expect(crumb(farmhouse(), 'the pantry')).toBe('the farmhouse ▸ the kitchen ▸ the pantry');
    });

    test('a house lists the rooms inside it', () => {
        expect(inside(farmhouse(), 'the farmhouse')).toBe('the kitchen · the guest room · the cellar');
    });

    test('a room lists what is inside IT, not its siblings', () => {
        expect(inside(farmhouse(), 'the kitchen')).toBe('the pantry');
    });

    test('standing facts and current detail are separate fields', () => {
        const kitchen = resolvePlace(farmhouse(), 'the kitchen').row;
        expect(kitchen.facts).toBe('flagstone floor');
        expect(kitchen.detail).toBe('bread proving on the counter');
    });

    test('a destroyed room is not offered as somewhere to go', () => {
        const table = farmhouse();
        foldPlace(table, { name: 'the cellar', place: 'the farmhouse', status: 'destroyed', turn: 4 });
        expect(inside(table, 'the farmhouse')).toBe('the kitchen · the guest room');
    });

    test('fail-open: a place with no record resolves to nothing', () => {
        // The path every one of the 22 live chats takes today, on every render. The block falls
        // back to the plain scene line, which is exactly what it drew before the record existed.
        expect(resolvePlace(farmhouse(), 'RPD break room')).toBeNull();
        expect(crumb(farmhouse(), 'RPD break room')).toBe('');
        expect(inside(farmhouse(), 'RPD break room')).toBe('');
    });

    test('fail-open: an empty record answers nothing for everything', () => {
        const empty = new Map();
        expect(resolvePlace(empty, 'the kitchen')).toBeNull();
        expect(ancestorsOf(empty, 'anything')).toEqual([]);
        expect(childrenOf(empty, 'anything')).toEqual([]);
    });
});
