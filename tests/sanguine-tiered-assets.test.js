/**
 * sanguine-tiered-assets, the tiered asset model (FOLD-REDESIGN.md §7.2, 7.6).
 *
 * Wave 1 landed the place RECORD: a house, its rooms as places whose parent is the house, and a
 * fail-open resolver that answers `null` for the free-text place strings every existing chat is
 * made of. This is the rest of it, and it is four claims:
 *
 *   §7.2  a sword's enchantments are NOT rooms. Composition is a side table keyed by `itemKey`
 *         (`part-table.js`), out of the qty fold entirely, each component carrying its own turn and
 *         its own anchor so a change is visible at the tier where it happened.
 *   §7.3  a description is DERIVED, destruction CASCADES and never deletes, items at a destroyed
 *         place become UNREACHABLE rather than vanishing, and injection is tiered by proximity.
 *   §7.5  `itemKey` is `who␀place␀name`, so rename and move both move it, and the two-half delta
 *         builders carry only the arithmetic, silently orphaning every side-table row addressed by
 *         the old key. `flows` has had the identical exposure since it landed.
 *   §7.6  resolution FAILS OPEN. No chat on disk has a place record, so nothing here may change what
 *         any of them does.
 *
 * The last two describes are the owner's own acceptance stories, run end to end over the pure folds
 * rather than asserted piecemeal, build a home room by room, then blow it up.
 *
 * The storage halves (`places.js`, `parts.js`) import `store.js`, which imports `script.js`, so jest
 * cannot load them; what is load-bearing and checkable is read from the source, the way
 * `sanguine-place-table.js` and `sanguine-edit-writers.js` already do for the same reason.
 */

import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAX_PARTS,
    MAX_PARTS_PER_ITEM,
    dropParts,
    foldPart,
    orphanParts,
    partFaces,
    partKey,
    partsOf,
    rekeyParts,
    renderParts,
    splitPartKey,
} from '../public/scripts/extensions/sanguine/part-table.js';
import {
    PLACE_DESTROYED,
    PLACE_STALE,
    cascadeRetirement,
    descendantsOf,
    destroyPlace,
    foldPlace,
    isGone,
    placeKey,
    prunePlaces,
    renderPlace,
    renderPlaces,
    resolvePlace,
    samePlaceResolved,
    sealedBy,
    unreachableBy,
    withinPlace,
} from '../public/scripts/extensions/sanguine/place-table.js';
import { rekeyPlan } from '../public/scripts/extensions/sanguine/edit-table.js';
import {
    MAX_ITEMS,
    deriveState,
    itemKey,
    renderState,
} from '../public/scripts/extensions/sanguine/state-table.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGUINE = path.join(HERE, '..', 'public', 'scripts', 'extensions', 'sanguine');
const read = name => fs.readFileSync(path.join(SANGUINE, name), 'utf8');

/**
 * A ledger event in the shape `deriveState` folds.
 * @param {number} t Order.
 * @param {number} mid The message it came from.
 * @param {object} d The delta.
 * @param {string} [s] The summary.
 * @returns {object} The event.
 */
const event = (t, mid, d, s = '') => ({ t, mid, s, d });

/** The house, built room by room across several turns, §7.1's own case. @returns {Map} The table. */
function farmhouse() {
    const places = new Map();
    foldPlace(places, { name: 'the farmhouse', aka: 'home', facts: 'two storeys, north-facing', turn: 1, mid: 10 });
    foldPlace(places, { name: 'the kitchen', place: 'the farmhouse', detail: 'the stove is lit', turn: 3, mid: 14 });
    foldPlace(places, { name: 'the cellar', place: 'the kitchen', facts: 'reached by a trapdoor', turn: 5, mid: 20 });
    return places;
}

// §7.2, components.

describe('components are a side table keyed by itemKey, not places inside things', () => {
    const sword = itemKey('longsword', 'carried');

    test('a component is keyed by the row it is about, and its name is the key', () => {
        const parts = new Map();
        const written = foldPart(parts, { on: sword, name: 'Flame Rune', value: 'sets a struck target alight', turn: 4, mid: 44 });
        expect(written.key).toBe(partKey(sword, 'flame rune'));
        expect(splitPartKey(written.key)).toEqual({ on: sword, name: 'flame rune' });
        // The row itself is the value and its two stamps. The name is not stored twice, the budget
        // is the binding constraint on this whole wave.
        expect(parts.get(written.key)).toEqual({ value: 'sets a struck target alight', turn: 4, mid: 44 });
    });

    test('the value is opaque, so a setting can grade a thing however it likes', () => {
        const parts = new Map();
        for (const [name, value] of [
            ['enchantment', '+2 vs undead'],
            ['calibre', '9x19mm Parabellum'],
            ['refinement', '三品 (third grade)'],
            ['serial', 'U447-1120'],
        ]) {
            expect(foldPart(parts, { on: sword, name, value, turn: 1 }).reason).toBe('');
        }
        // Four readings from four genres, and nothing in the fold compared any of them.
        expect(partsOf(parts, sword).map(row => row.value))
            .toEqual(expect.arrayContaining(['+2 vs undead', '三品 (third grade)']));
    });

    test('each component carries its own turn and its own anchor', () => {
        const parts = new Map();
        foldPart(parts, { on: sword, name: 'flame rune', value: 'burns', turn: 4, mid: 44 });
        foldPart(parts, { on: sword, name: 'notch', value: 'a hand from the tip', turn: 9, mid: 61 });
        // Freshest first: adding a component lights THAT component's rail, and the click-through
        // goes to the message that added it rather than to anything about the sword.
        expect(partsOf(parts, sword).map(row => [row.name, row.turn, row.mid]))
            .toEqual([['notch', 9, 61], ['flame rune', 4, 44]]);
    });

    test('a restatement is silence wearing a value, so the rail does not light', () => {
        const parts = new Map();
        foldPart(parts, { on: sword, name: 'flame rune', value: 'burns', turn: 4, mid: 44 });
        const again = foldPart(parts, { on: sword, name: 'flame rune', value: 'burns', turn: 9, mid: 61 });
        expect(again).toEqual({ key: '', reason: 'no-change' });
        expect(parts.get(partKey(sword, 'flame rune')).turn).toBe(4);
    });

    test('a late-arriving older claim never overwrites a fresher one', () => {
        const parts = new Map();
        foldPart(parts, { on: sword, name: 'flame rune', value: 'burns hotter', turn: 9 });
        foldPart(parts, { on: sword, name: 'flame rune', value: 'burns', turn: 4 });
        expect(parts.get(partKey(sword, 'flame rune')).value).toBe('burns hotter');
    });

    test('a name with nothing after it is a word, not a component', () => {
        const parts = new Map();
        expect(foldPart(parts, { on: sword, name: 'runed', value: '', turn: 1 }).reason).toBe('no-change');
        expect(foldPart(parts, { on: sword, name: '  ', value: 'x', turn: 1 }).reason).toBe('unusable-name');
        expect(foldPart(parts, { on: '', name: 'runed', value: 'x', turn: 1 }).reason).toBe('unusable-name');
        expect(parts.size).toBe(0);
    });

    test('components stay OUT of the qty fold, MAX_ITEMS and deriveState\'s arithmetic', () => {
        const events = [event(1, 10, { inv: [{ item: 'longsword', dq: 1 }] })];
        const before = deriveState(events, {});
        const parts = new Map();
        for (let n = 0; n < MAX_PARTS_PER_ITEM; n++) {
            foldPart(parts, { on: sword, name: `rune ${n}`, value: `reading ${n}`, turn: n + 1 });
        }
        const after = deriveState(events, {});
        // Byte-identical, because nothing in `deriveState` can see this table at all.
        expect([...after.inv]).toEqual([...before.inv]);
        expect(after.inv.get(sword)).toEqual({ qty: 1 });
        expect(after.inv.size).toBe(1);
        expect(parts.size).toBeLessThanOrEqual(MAX_ITEMS);
        // And the fold's own source cannot reach them: no import, no read, no cap shared.
        expect(read('state-table.js')).not.toContain('part-table.js\';\nimport { deriveState');
        expect(read('part-table.js')).not.toContain('from \'./state-table.js\'');
    });

    test('one row\'s components render as one line, the shape renderPlace already uses', () => {
        const parts = new Map();
        foldPart(parts, { on: sword, name: 'flame rune', value: 'sets a struck target alight', turn: 4 });
        foldPart(parts, { on: sword, name: 'notch', value: 'a hand from the tip', turn: 9 });
        expect(renderParts(parts, sword)).toBe('notch: a hand from the tip; flame rune: sets a struck target alight');
        expect(partFaces(parts).get(sword)).toContain('flame rune: sets a struck target alight');
        expect(renderParts(parts, itemKey('rope', 'carried'))).toBe('');
    });
});

// §7.4, the bounds.

describe('the component bounds refuse rather than evict, and say which bound it was', () => {
    test('one row cannot spend the whole table', () => {
        const parts = new Map();
        const sword = itemKey('longsword', 'carried');
        for (let n = 0; n < MAX_PARTS_PER_ITEM; n++) {
            expect(foldPart(parts, { on: sword, name: `rune ${n}`, value: `${n}`, turn: 1 }).reason).toBe('');
        }
        const refused = foldPart(parts, { on: sword, name: 'one more', value: 'x', turn: 1 });
        expect(refused).toEqual({ key: '', reason: 'parts-full', held: MAX_PARTS_PER_ITEM });
        // Another row still has room: the per-item bound is not the table bound.
        expect(foldPart(parts, { on: itemKey('shield', 'carried'), name: 'boss', value: 'dented', turn: 1 }).reason).toBe('');
    });

    test('and the table cap binds across rows, reported with the count', () => {
        const parts = new Map();
        for (let n = 0; n < MAX_PARTS; n++) {
            foldPart(parts, { on: itemKey(`thing ${n}`, 'carried'), name: 'mark', value: `${n}`, turn: 1 });
        }
        expect(parts.size).toBe(MAX_PARTS);
        const refused = foldPart(parts, { on: itemKey('one too many', 'carried'), name: 'mark', value: 'x', turn: 1 });
        expect(refused).toEqual({ key: '', reason: 'parts-full', held: MAX_PARTS });
    });

    test('an EXISTING component is always revisable, however full the table is', () => {
        const parts = new Map();
        const first = itemKey('thing 0', 'carried');
        for (let n = 0; n < MAX_PARTS; n++) {
            foldPart(parts, { on: itemKey(`thing ${n}`, 'carried'), name: 'mark', value: `${n}`, turn: 1 });
        }
        // A cap that froze the rows it already holds would make the last thing said about them
        // permanent, which is the opposite of what a last-write field is for.
        expect(foldPart(parts, { on: first, name: 'mark', value: 'chipped', turn: 2 }).reason).toBe('');
        expect(parts.size).toBe(MAX_PARTS);
    });
});

// §7.3, cascade.

describe('destruction cascades to children and never deletes', () => {
    test('every room inside a destroyed house is retired, at any depth', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the farmhouse', status: 'destroyed', turn: 30, mid: 512 });
        for (const name of ['the farmhouse', 'the kitchen', 'the cellar']) {
            expect(isGone(places.get(placeKey(name)))).toBe(true);
        }
        // The cellar is inside the KITCHEN, not inside the house. Depth is not a special case.
        expect(descendantsOf(places, placeKey('the farmhouse')).map(row => row.row.name))
            .toEqual(expect.arrayContaining(['the kitchen', 'the cellar']));
    });

    test('nothing is deleted, every record keeps its name, its facts and its parent', () => {
        const places = farmhouse();
        const before = places.size;
        destroyPlace(places, placeKey('the farmhouse'), { status: 'destroyed', turn: 30, mid: 512 });
        expect(places.size).toBe(before);
        const cellar = places.get(placeKey('the cellar'));
        expect(cellar.name).toBe('the cellar');
        expect(cellar.facts).toBe('reached by a trapdoor');
        expect(cellar.place).toBe('the kitchen');
    });

    test('the change is on the trail, with the anchor that makes the click-through work', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { status: 'destroyed', turn: 30, mid: 512 });
        for (const name of ['the farmhouse', 'the kitchen', 'the cellar']) {
            const last = places.get(placeKey(name)).trail.at(-1);
            expect(last).toMatchObject({ field: 'status', from: '', to: 'destroyed', turn: 30, mid: 512 });
        }
    });

    test('re-reading the same window does not stack six identical trail entries', () => {
        const places = farmhouse();
        for (let n = 0; n < 6; n++) {
            foldPlace(places, { name: 'the farmhouse', status: 'destroyed', turn: 30 + n, mid: 512 });
        }
        expect(places.get(placeKey('the kitchen')).trail.filter(row => row.field === 'status')).toHaveLength(1);
    });

    test('a retired child stops being something the parent CONTAINS, and still has a record', () => {
        const places = farmhouse();
        expect(renderPlace(places, placeKey('the farmhouse'))).toContain('contains the kitchen');
        destroyPlace(places, placeKey('the kitchen'), { status: 'ruined', turn: 30 });
        expect(renderPlace(places, placeKey('the farmhouse'))).not.toContain('contains');
        // Still there, still says what it is, and says out loud what happened to it.
        expect(renderPlace(places, placeKey('the kitchen'))).toContain('ruined');
    });

    test('a word that is not a retirement cascades nothing', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the farmhouse', status: 'flooded', turn: 30 });
        expect(places.get(placeKey('the kitchen')).status).toBe('');
        expect(cascadeRetirement(places, placeKey('the farmhouse'), { status: 'flooded', turn: 31 })).toEqual([]);
    });

    test('rebuilding is a change TO the destroyed record, which stays legal', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { turn: 30, mid: 512 });
        expect(unreachableBy(places, 'the cellar')).toBeTruthy();
        // A status is prose, so a rebuild is any word that is not a retirement, `merge_entity`
        // reads `''` as silence, so the extractor cannot clear a field by omitting it and does not
        // need to. `places.patch` is the hand path that CAN write an empty one.
        for (const name of ['the farmhouse', 'the kitchen', 'the cellar']) {
            foldPlace(places, { name, status: 'rebuilt', turn: 40, mid: 600 });
        }
        expect(unreachableBy(places, 'the cellar')).toBeNull();
    });

    test('but a revival does NOT cascade, and the asymmetry is the honest one', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { turn: 30, mid: 512 });
        foldPlace(places, { name: 'the farmhouse', status: 'rebuilt', turn: 40, mid: 600 });
        // Destruction propagates because containment makes it true: burn the house and the kitchen
        // burned. Repair does not: rebuilding the shell says nothing about whether the cellar under
        // it was dug out again, and asserting that it was would be fold inventing the work.
        expect(places.get(placeKey('the kitchen')).status).toBe('destroyed');
        expect(unreachableBy(places, 'the cellar').row.name).toBe('the cellar');
    });
});

describe('items at a destroyed place are unreachable, not gone', () => {
    const ledger = [
        event(1, 14, { inv: [{ item: 'iron pot', dq: 1, at: 'the kitchen' }] }),
        event(2, 20, { inv: [{ item: 'crowbar', dq: 1, at: 'the cellar' }] }),
        event(3, 22, { inv: [{ item: 'preserves', dq: 12, at: 'the cellar' }] }),
    ];

    test('the quantities do not change, because destruction touches no item at all', () => {
        const places = farmhouse();
        const before = deriveState(ledger, {});
        destroyPlace(places, placeKey('the farmhouse'), { turn: 30, mid: 512 });
        const after = deriveState(ledger, {});
        expect([...after.inv]).toEqual([...before.inv]);
        expect(after.inv.get(itemKey('crowbar', 'the cellar'))).toEqual({ qty: 1 });
    });

    test('they render, with the reason attached, the cap:stale-hidden lesson', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { status: 'destroyed', turn: 30, mid: 512 });
        const block = renderState({ ...deriveState(ledger, {}), places, here: 'home' });
        expect(block).toContain('Stored (cellar: unreachable, destroyed): crowbar, preserves x12');
        expect(block).toContain('Stored (kitchen: unreachable, destroyed): iron pot');
        // 540 silent hidings in Raccoon City is what the alternative measured at.
        expect(block).toContain('crowbar');
    });

    test('the reason is derived on every read, so a rebuild frees them with no rewrite', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { turn: 30 });
        expect(unreachableBy(places, 'cellar').row.name).toBe('the cellar');
        for (const name of ['the cellar', 'the kitchen', 'the farmhouse']) {
            foldPlace(places, { name, status: 'rebuilt', turn: 40 });
        }
        const block = renderState({ ...deriveState(ledger, {}), places, here: 'home' });
        expect(block).toContain('Stored (cellar): crowbar, preserves x12');
    });

    test('a change INSIDE a destroyed place is refused; a change TO it is not', () => {
        const places = farmhouse();
        destroyPlace(places, placeKey('the farmhouse'), { turn: 30 });
        // The room is sealed: something containing it is gone. The NEAREST such ancestor is the
        // answer, because that is the one whose name explains it, the kitchen, which the cascade
        // retired one hop up.
        expect(sealedBy(places, placeKey('the cellar')).row.name).toBe('the kitchen');
        // The house itself is not sealed by anything, which is how it gets rebuilt.
        expect(sealedBy(places, placeKey('the farmhouse'))).toBeNull();
        expect(PLACE_DESTROYED).toBe('place-destroyed');
    });
});

// §7.3, a description is derived, never frozen.

describe('a place\'s description is derived, and detail is last-write on a persisted record', () => {
    test('detail carries forward across turns with nothing re-asserting it', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the farmhouse', detail: 'the east wing is rubble', turn: 12, mid: 90 });
        // Twenty turns of writes that never mention the farmhouse's condition.
        for (let n = 13; n < 33; n++) {
            foldPlace(places, { name: 'the kitchen', detail: `turn ${n}`, turn: n });
        }
        expect(places.get(placeKey('the farmhouse')).detail).toBe('the east wing is rubble');
        expect(renderPlace(places, placeKey('the farmhouse'))).toContain('the east wing is rubble');
    });

    test('and the children summary is the rooms that exist NOW, never a stored list', () => {
        const places = farmhouse();
        expect(renderPlace(places, placeKey('the farmhouse'))).toBe(
            'the farmhouse (two storeys, north-facing; contains the kitchen)');
        foldPlace(places, { name: 'the east wing', place: 'the farmhouse', detail: 'unfinished', turn: 9 });
        expect(renderPlace(places, placeKey('the farmhouse'))).toContain('contains the east wing, the kitchen');
        foldPlace(places, { name: 'the east wing', status: 'destroyed', turn: 11 });
        expect(renderPlace(places, placeKey('the farmhouse'))).toContain('contains the kitchen');
    });
});

// §7.3, injection is tiered by proximity.

describe('injection is tiered by proximity', () => {
    test('the place you are in renders in full, with its rooms named', () => {
        const places = farmhouse();
        expect(renderPlaces(places, { here: 'home' }))
            .toBe('Here: the farmhouse (two storeys, north-facing; contains the kitchen)');
    });

    test('a place merely mentioned gets a name and one line', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the barn', facts: 'timber, one storey', detail: 'the doors are off their hinges', turn: 6 });
        const block = renderPlaces(places, { here: 'home', mentioned: ['the barn'] });
        expect(block).toContain('Elsewhere: the barn, the doors are off their hinges');
        // The far tier does NOT get the full description, that is what the tier is for.
        expect(block).not.toContain('timber, one storey');
    });

    test('what is already in the near tier is not restated in the far one', () => {
        const places = farmhouse();
        const block = renderPlaces(places, { here: 'home', mentioned: ['the kitchen', 'the farmhouse'] });
        expect(block).not.toContain('Elsewhere');
    });

    test('nothing resolves, nothing is injected, which is every chat on disk', () => {
        expect(renderPlaces(new Map(), { here: 'the goblin market', mentioned: ['nowon'] })).toBe('');
        expect(renderPlaces(farmhouse(), { here: 'a street in Raccoon City' })).toBe('');
    });

    test('renderState without a place table is byte-identical to what it has always been', () => {
        const events = [
            event(1, 10, { inv: [{ item: 'crowbar', dq: 1 }] }),
            event(2, 12, { inv: [{ item: 'medkit', dq: 1, at: 'the suv' }] }),
        ];
        const state = deriveState(events, {});
        const plain = renderState({ ...state });
        expect(plain).toBe(renderState({ ...state, places: null, parts: new Map(), here: 'the suv' }));
        expect(plain).not.toContain('Here:');
        expect(plain).not.toContain('unreachable');
    });

    test('components ride the item line, at the tier where they belong', () => {
        const events = [event(1, 10, { inv: [{ item: 'longsword', dq: 1 }] })];
        const parts = new Map();
        foldPart(parts, { on: itemKey('longsword', 'carried'), name: 'flame rune', value: 'burns', turn: 4, mid: 44 });
        const block = renderState({ ...deriveState(events, {}), parts: partFaces(parts) });
        expect(block).toContain('Carrying: longsword (flame rune: burns)');
    });
});

// §7.5, re-keying.

describe('rename and move change the key, and the side tables move with it', () => {
    test('rekeyPlan is one definition of where a row lands', () => {
        const key = itemKey('ammunition', 'the suv');
        expect(rekeyPlan(key, { name: '9mm magazines' })).toEqual({
            from: key, to: itemKey('9mm magazines', 'the suv'), moved: true,
        });
        expect(rekeyPlan(key, { place: 'carried' })).toEqual({
            from: key, to: itemKey('ammunition', 'carried'), moved: true,
        });
        // An edit that changes neither is not a move, so nothing is carried anywhere.
        expect(rekeyPlan(key, { rank: 'E' }).moved).toBe(false);
        expect(rekeyPlan(key, { place: 'the suv' }).moved).toBe(false);
    });

    test('the owner half survives a rename, which is what makes a companion\'s gear stay theirs', () => {
        const key = itemKey('branch', 'carried', 'Kaelira');
        const plan = rekeyPlan(key, { name: 'ironwood branch' });
        expect(plan.to).toBe(itemKey('ironwood branch', 'carried', 'Kaelira'));
    });

    test('components follow the row rather than being orphaned', () => {
        const parts = new Map();
        const was = itemKey('longsword', 'carried');
        foldPart(parts, { on: was, name: 'flame rune', value: 'burns', turn: 4, mid: 44 });
        foldPart(parts, { on: was, name: 'notch', value: 'a hand from the tip', turn: 9, mid: 61 });

        const plan = rekeyPlan(was, { name: 'flamebrand' });
        expect(rekeyParts(parts, plan.from, plan.to)).toBe(2);
        expect(partsOf(parts, was)).toEqual([]);
        // Everything, including each component's own anchor, the cause-link must survive the move.
        expect(partsOf(parts, plan.to).map(row => [row.name, row.mid]))
            .toEqual([['notch', 61], ['flame rune', 44]]);
    });

    test('a collision at the destination keeps the fresher claim', () => {
        const parts = new Map();
        const was = itemKey('longsword', 'carried');
        const to = itemKey('longsword', 'the cellar');
        foldPart(parts, { on: was, name: 'notch', value: 'a hand from the tip', turn: 4 });
        foldPart(parts, { on: to, name: 'notch', value: 'filed out', turn: 9 });
        rekeyParts(parts, was, to);
        expect(partsOf(parts, to).map(row => row.value)).toEqual(['filed out']);
    });

    test('a row that leaves takes its components with it', () => {
        const parts = new Map();
        const sword = itemKey('longsword', 'carried');
        foldPart(parts, { on: sword, name: 'flame rune', value: 'burns', turn: 4 });
        expect(dropParts(parts, sword)).toBe(1);
        expect(parts.size).toBe(0);
    });

    test('a split refuses to guess, so its components are reported as orphans rather than divided', () => {
        const parts = new Map();
        const ammo = itemKey('ammunition', 'the suv');
        foldPart(parts, { on: ammo, name: 'calibre', value: 'mixed', turn: 4 });
        // The live Raccoon City repair: one row that was really three things. Which of them inherits
        // "mixed" is a judgement about the fiction, so nothing here makes it.
        const live = new Set([
            itemKey('9mm magazines', 'the suv'),
            itemKey('buckshot shells', 'the suv'),
            itemKey('box of birdshot', 'the suv'),
        ]);
        expect(orphanParts(parts, live)).toEqual([partKey(ammo, 'calibre')]);
        // …and a row that is still there is never an orphan.
        expect(orphanParts(parts, new Set([ammo]))).toEqual([]);
    });

    test('the writers carry both stored side tables, the gate for the class', () => {
        // `edits.js` is a storage module and cannot be imported here. What is checkable is the seam:
        // `editItem` must route through `rekeyPlan` and must carry BOTH stored tables, or a rename
        // silently orphans components and silently points a rate at a row that stopped existing.
        const edits = read('edits.js');
        expect(edits).toContain('rekeyPlan');
        expect(edits).toContain('function carryKey(');
        expect(edits).toContain('components.rekey(from, to)');
        expect(edits).toContain('retargetFlows(from, to)');
        // The flows half specifically: the identical latent exposure, fixed through the flow table's
        // own writer so there is still exactly one path into it.
        expect(edits).toContain('flows.set(flow.label, { item: landed.name, at: landed.place, who: landed.who }');
        // And both deletes drop what they are deleting the components of.
        expect(edits).toContain('components.drop(key)');
    });

    test('and every place the key moves goes through the plan, never through a hand-built key', () => {
        const edits = read('edits.js');
        const body = edits.slice(edits.indexOf('export function editItem('), edits.indexOf('// Vitals.'));
        // The two old hand-built `itemKey(...)` recomputations are what the plan replaced: two
        // spellings of one destination is two chances to disagree about it.
        expect(body).not.toContain('itemKey(parts.name, normalizePlace(place)');
        expect(body.match(/carryKey\(plan\.from, plan\.to\)/g)).toHaveLength(2);
    });
});

// §7.6, resolution fails open.

describe('place-string resolution fails open, so no existing chat changes', () => {
    test('an item\'s `at` reaches the record the story wrote, article and all', () => {
        const places = farmhouse();
        // `normalizePlace` strips the article for the key and `normalizeEntityName` strips it for the
        // record, so the two meet without either knowing about the other.
        expect(itemKey('crowbar', 'the cellar')).toBe(itemKey('crowbar', 'cellar'));
        expect(resolvePlace(places, 'cellar').key).toBe(placeKey('the cellar'));
        expect(resolvePlace(places, 'home').key).toBe(placeKey('the farmhouse'));
    });

    test('a string with no record is the string it is, and behaves exactly as today', () => {
        const places = farmhouse();
        expect(resolvePlace(places, 'the goblin market')).toBeNull();
        expect(unreachableBy(places, 'the goblin market')).toBeNull();
        expect(withinPlace(places, 'the goblin market', 'the farmhouse')).toBe(false);
        expect(samePlaceResolved(places, 'the goblin market', 'the farmhouse')).toBe(false);
        // Equality still decides when there is no record on either side, which is every comparison
        // in every chat that exists.
        expect(samePlaceResolved(new Map(), 'The Goblin Market', 'the goblin market ')).toBe(true);
    });

    test('containment answers the question samePlace never could', () => {
        const places = farmhouse();
        expect(withinPlace(places, 'the cellar', 'the farmhouse')).toBe(true);
        expect(withinPlace(places, 'the cellar', 'home')).toBe(true);
        // Asymmetric on purpose: the farmhouse is not in the cellar.
        expect(withinPlace(places, 'the farmhouse', 'the cellar')).toBe(false);
        // And two names for one record are one place.
        expect(samePlaceResolved(places, 'home', 'the farmhouse')).toBe(true);
    });
});

// ACCEPTANCE.

describe('ACCEPTANCE, build a home room by room', () => {
    /**
     * The whole story, played out: establish a house, add rooms across several turns, store items in
     * specific rooms, leave, and come back.
     * @returns {object} The places, the ledger and the cold store at the end.
     */
    function played() {
        const places = new Map();
        const ledger = [];
        const cold = new Map();

        // Turn 1: the house.
        foldPlace(places, { name: 'the farmhouse', aka: 'home', facts: 'two storeys, north-facing', turn: 1, mid: 10 });
        // Turn 3: a room, and something left in it.
        foldPlace(places, { name: 'the kitchen', place: 'the farmhouse', detail: 'the stove is lit', turn: 3, mid: 14 });
        ledger.push(event(1, 14, { inv: [{ item: 'iron pot', dq: 1, at: 'the kitchen' }] }, 'hung a pot'));
        // Turn 5: a room inside that room.
        foldPlace(places, { name: 'the cellar', place: 'the kitchen', facts: 'reached by a trapdoor', turn: 5, mid: 20 });
        ledger.push(event(2, 20, { inv: [{ item: 'crowbar', dq: 1, at: 'the cellar' }] }, 'left the crowbar below'));
        ledger.push(event(3, 22, { inv: [{ item: 'preserves', dq: 12, at: 'the cellar' }] }, 'shelved preserves'));
        // Turn 9: another room, much later.
        foldPlace(places, { name: 'the east wing', place: 'the farmhouse', detail: 'unfinished', turn: 9, mid: 30 });

        return { places, ledger, cold };
    }

    test('the hierarchy holds, at every depth, across the turns it was built over', () => {
        const { places } = played();
        expect(renderPlace(places, placeKey('the farmhouse')))
            .toBe('the farmhouse (two storeys, north-facing; contains the east wing, the kitchen)');
        expect(renderPlace(places, placeKey('the kitchen')))
            .toBe('the kitchen (in the farmhouse; the stove is lit; contains the cellar)');
        expect(descendantsOf(places, placeKey('the farmhouse')).map(row => row.row.name))
            .toEqual(expect.arrayContaining(['the kitchen', 'the east wing', 'the cellar']));
    });

    test('items resolve to their rooms', () => {
        const { places, ledger } = played();
        const state = deriveState(ledger, {});
        const where = new Map();
        for (const key of state.inv.keys()) {
            const parts = key.split('\0');
            where.set(key, resolvePlace(places, parts[parts.length - 2])?.row?.name ?? '');
        }
        expect([...where.values()]).toEqual(['the kitchen', 'the cellar', 'the cellar']);
    });

    test('the injected description is the rooms that exist NOW', () => {
        const { places, ledger } = played();
        const block = renderState({ ...deriveState(ledger, {}), places, here: 'home' });
        expect(block).toBe([
            '[State]',
            'Here: the farmhouse (two storeys, north-facing; contains the east wing, the kitchen)',
            'Stored (kitchen): iron pot',
            'Stored (cellar): crowbar, preserves x12',
        ].join('\n'));
    });

    test('a room the story left is archived rather than deleted, and its parent is pinned', () => {
        const { places, cold } = played();
        // The staleness prune, at a turn far past `PLACE_STALE`. `prunePlaces` hands the row up
        // whole; `places.prune` demotes it to the cold store, which is inlined here for
        // `sanguine-cold-store.test.js`' stated reason.
        const shed = prunePlaces(places, 9 + PLACE_STALE * 2 + 1);
        for (const row of shed) {
            cold.set(row.key, row.row);
        }
        expect(shed.map(row => row.row.name).sort()).toEqual(['the cellar', 'the east wing']);
        // Containment pins a record: nobody says "the farmhouse" while standing in the kitchen of it.
        expect(places.has(placeKey('the farmhouse'))).toBe(true);
        expect(places.has(placeKey('the kitchen'))).toBe(true);
        expect(cold.get(placeKey('the cellar')).facts).toBe('reached by a trapdoor');
    });

    test('and is promoted back, whole, when the story names it again', () => {
        const { places, ledger, cold } = played();
        for (const row of prunePlaces(places, 9 + PLACE_STALE * 2 + 1)) {
            cold.set(row.key, row.row);
        }
        // Admission by COVERAGE, the model's own `mentions` report, never a substring ([ROUTER]).
        const mentioned = new Set(['cellar']);
        for (const [key, row] of cold) {
            if (mentioned.has(row.name.replace(/^the /, ''))) {
                places.set(key, { ...row, turn: 400 });
            }
        }
        expect(resolvePlace(places, 'the cellar').row.facts).toBe('reached by a trapdoor');
        // Back in the tree, in the right room, with its contents resolving to it again.
        expect(renderPlace(places, placeKey('the kitchen'))).toContain('contains the cellar');
        expect(renderState({ ...deriveState(ledger, {}), places, here: 'home' }))
            .toContain('Stored (cellar): crowbar, preserves x12');
    });
});

describe('ACCEPTANCE, blow it up', () => {
    /**
     * The house, its rooms, what is in them, and a fire at message 512.
     * @returns {object} Everything the story needs.
     */
    function burned() {
        const places = farmhouse();
        foldPlace(places, { name: 'the east wing', place: 'the farmhouse', detail: 'unfinished', turn: 9, mid: 30 });
        const ledger = [
            event(1, 14, { inv: [{ item: 'iron pot', dq: 1, at: 'the kitchen' }] }),
            event(2, 20, { inv: [{ item: 'crowbar', dq: 1, at: 'the cellar' }] }),
            event(3, 22, { inv: [{ item: 'preserves', dq: 12, at: 'the cellar' }] }),
            event(4, 24, { inv: [{ item: 'sig p226', dq: 1 }] }),
        ];
        // The fire, reported by the extraction pass that read message 512.
        foldPlace(places, {
            name: 'the farmhouse',
            detail: 'a burnt shell; the roof is gone',
            status: 'destroyed',
            turn: 30,
            mid: 512,
        });
        return { places, ledger };
    }

    test('detail changes, and STAYS changed with nothing re-asserting it', () => {
        const { places } = burned();
        const house = placeKey('the farmhouse');
        expect(places.get(house).detail).toBe('a burnt shell; the roof is gone');
        // Fifty later turns, none of which mention the house at all.
        for (let n = 31; n < 81; n++) {
            foldPlace(places, { name: 'the kitchen', detail: `ash, turn ${n}`, turn: n });
        }
        expect(places.get(house).detail).toBe('a burnt shell; the roof is gone');
        expect(places.get(house).status).toBe('destroyed');
        expect(renderPlace(places, house)).toContain('a burnt shell; the roof is gone');
    });

    test('child rooms cascade to destroyed', () => {
        const { places } = burned();
        for (const name of ['the kitchen', 'the cellar', 'the east wing']) {
            expect(places.get(placeKey(name)).status).toBe('destroyed');
        }
        // At every depth: the cellar is inside the kitchen, not inside the house.
        expect(places.get(placeKey('the cellar')).place).toBe('the kitchen');
    });

    test('items inside become unreachable rather than vanishing', () => {
        const { places, ledger } = burned();
        const state = deriveState(ledger, {});
        // Every count is exactly what it was: destruction touched no item.
        expect(state.inv.get(itemKey('crowbar', 'the cellar'))).toEqual({ qty: 1 });
        expect(state.inv.get(itemKey('preserves', 'the cellar'))).toEqual({ qty: 12 });
        expect(state.inv.get(itemKey('iron pot', 'the kitchen'))).toEqual({ qty: 1 });

        const block = renderState({ ...state, places, here: 'home' });
        expect(block).toBe([
            '[State]',
            'Here: the farmhouse (two storeys, north-facing; a burnt shell; the roof is gone; destroyed)',
            // Grouped in the order the places first appear in the ledger, which `renderState` has
            // always done and which this wave does not change.
            'Stored (kitchen: unreachable, destroyed): iron pot',
            'Stored (cellar: unreachable, destroyed): crowbar, preserves x12',
            'Carrying: sig p226',
        ].join('\n'));
        // What is on the character is untouched, the fire was in a building, not in his pockets.
        expect(block).toContain('Carrying: sig p226');
    });

    test('the trail shows the change, with a working click-through on every row it reached', () => {
        const { places } = burned();
        for (const name of ['the farmhouse', 'the kitchen', 'the cellar', 'the east wing']) {
            const status = places.get(placeKey(name)).trail.filter(row => row.field === 'status');
            expect(status).toHaveLength(1);
            expect(status[0]).toMatchObject({ from: '', to: 'destroyed', turn: 30, mid: 512 });
            // `mid >= 0` is what `overlay-assets.js` draws the jump button on; `-1` means no anchor.
            expect(status[0].mid).toBeGreaterThanOrEqual(0);
        }
        // The house's own trail carries the description change beside the destruction, both anchored
        // at the message that caused them.
        expect(places.get(placeKey('the farmhouse')).trail.filter(row => row.field === 'detail').at(-1))
            .toMatchObject({ to: 'a burnt shell; the roof is gone', mid: 512 });
    });

    test('and nothing was deleted, every record is still there to be pointed at', () => {
        const { places } = burned();
        expect(places.size).toBe(4);
        expect(unreachableBy(places, 'cellar')).toBeTruthy();
        expect(unreachableBy(places, 'carried')).toBeNull();
    });
});

// The storage halves, read as source.

describe('the storage half, what a source gate can pin about parts.js and places.js', () => {
    test('components live at state.parts, and nowhere near the ledger', () => {
        const source = read('parts.js');
        expect(source).toContain('\'state.parts\'');
        // It never folds the ledger and never reaches the item table: the only thing it borrows from
        // `state-table.js` is the key split, which is how it knows which place a row is in.
        expect(source).not.toContain('deriveState(');
        expect(source).toContain('import { splitItemKey } from \'./state-table.js\';');
    });

    test('a pruner is registered, priced with the archive pruners', () => {
        const source = read('parts.js');
        expect(source).toContain('registerPruner((overBy) => {');
        expect(source).toContain('}, PRUNE_ARCHIVE);');
    });

    test('it sheds the stalest SURPLUS before it sheds the last thing a row says about itself', () => {
        const source = read('parts.js');
        const pruner = source.slice(source.indexOf('registerPruner((overBy)'));
        // Stage one keeps one component per row; stage two takes whole rows, stalest first.
        expect(pruner).toContain('if (rows.length < 2) {');
        expect(pruner).toContain('rows.sort((a, b) => a.turn - b.turn)[0]');
        expect(pruner).toContain('Math.max(1, Math.ceil(overBy / 99))');
    });

    test('the two new refusals exist and travel as data, like every other validator reason', () => {
        expect(read('parts.js')).toContain('reason: PLACE_DESTROYED');
        expect(read('places.js')).toContain('reason: PLACE_DESTROYED');
        expect(read('edits.js')).toContain('reason: PLACE_DESTROYED');
        // `parts-full` is raised by the pure fold and reported by the storage half as data.
        expect(read('part-table.js')).toContain('reason: \'parts-full\'');
    });

    test('every column the component dialog offers has a writer that accepts it', () => {
        // The gate `sanguine-edit-writers.js` keeps for the other four specs, for the fifth. A field
        // in the form that the writer does not take is accepted by the dialog, returned by
        // `editRow`, and dropped on the floor, twice already in this codebase (`clocks.set`
        // dropping `open`/`source`/`where`, then `per`).
        const form = read('edit-form.js');
        const at = form.indexOf('export const COMPONENT_FIELDS');
        const offered = [...form.slice(at, form.indexOf(']);', at)).matchAll(/\{\s*key:\s*'([^']+)'/g)]
            .map(hit => hit[1]);
        expect(offered).toEqual(['name', 'value']);
        // …and the two an item has that a component does not, for `ABILITY_FIELDS`' reason.
        expect(offered).not.toContain('qty');
        expect(offered).not.toContain('place');
        expect(read('parts.js')).toContain('export function set(key, name, value,');
        expect(read('overlay-inventory.js')).toContain('components.set(item.key, wanted.name, wanted.value)');
    });

    test('there is exactly one path from a place record to the prompt', () => {
        // `renderState` takes the TABLE and renders the tiers. A second `render()` on the storage
        // half would be a second definition of what the narrator is told about where it is standing,
        // and the panel and the prompt would eventually describe the same house differently.
        expect(read('places.js')).not.toContain('export function render(');
        expect(read('state-table.js')).toContain('renderPlaces(places, { here, mentioned })');
    });

    test('places gained a destroy writer that cascades and a resolver that fails open', () => {
        const source = read('places.js');
        expect(source).toContain('export function destroy(');
        expect(source).toContain('export function unreachable(');
        expect(source).toContain('export function within(');
        // And a hand edit that types "destroyed" into the status box cascades like the probe's does.
        expect(source).toContain('cascadeRetirement(table, key, { status: patched.status, turn: at })');
    });
});
