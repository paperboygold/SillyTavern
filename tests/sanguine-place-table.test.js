import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAX_PLACES,
    MAX_PLACE_TRAIL,
    PLACE_STALE,
    ancestorsOf,
    childrenOf,
    foldPlace,
    foldPlaces,
    placeKey,
    prunePlaces,
    renderPlace,
    resolvePlace,
    rootsOf,
    wouldCycle,
} from '../public/scripts/extensions/sanguine/place-table.js';
import { migrate } from '../public/scripts/extensions/sanguine/migrate.js';

/**
 * A place table holding rows, folded in order.
 * @param {...object} rows Observations.
 * @returns {Map<string, object>} The table.
 */
const table = (...rows) => {
    const map = new Map();
    for (const row of rows) {
        foldPlace(map, row);
    }
    return map;
};

/** The house, built room by room, the case §7.1 exists for. */
const farmhouse = () => table(
    { name: 'the farmhouse', aka: 'home, Solomon\'s place', facts: 'two storeys, north-facing', turn: 1 },
    { name: 'the kitchen', place: 'the farmhouse', detail: 'the stove is lit', turn: 2 },
    { name: 'the cellar', place: 'the kitchen', facts: 'reached by a trapdoor', turn: 3 },
    { name: 'the east wing', place: 'the farmhouse', detail: 'unfinished', turn: 4 },
);

describe('nesting, a room is a place whose parent is the house', () => {
    test('a parent resolves to its record, and depth falls out of repeated resolution', () => {
        const places = farmhouse();
        const cellar = placeKey('the cellar');
        const chain = ancestorsOf(places, cellar).map(step => step.row.name);
        expect(chain).toEqual(['the kitchen', 'the farmhouse']);
    });

    test('children are derived by scanning, never stored', () => {
        const places = farmhouse();
        const kids = childrenOf(places, placeKey('the farmhouse')).map(child => child.row.name);
        // Freshest first: the east wing was written at turn 4, the kitchen at 2.
        expect(kids).toEqual(['the east wing', 'the kitchen']);
        // The cellar is inside the kitchen, not inside the house, one hop, not transitive.
        expect(kids).not.toContain('the cellar');
        expect(childrenOf(places, placeKey('the kitchen')).map(c => c.row.name)).toEqual(['the cellar']);
    });

    test('depth is arbitrary, because nothing enumerates the levels', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the strongbox nook', place: 'the cellar', turn: 5 });
        expect(ancestorsOf(places, placeKey('the strongbox nook')).map(step => step.row.name))
            .toEqual(['the cellar', 'the kitchen', 'the farmhouse']);
    });

    test('the house is the only root, and a place with no parent is one too', () => {
        const places = farmhouse();
        expect(rootsOf(places).map(root => root.row.name)).toEqual(['the farmhouse']);
        foldPlace(places, { name: 'Arklay County', facts: 'forested, two hours out', turn: 6 });
        expect(rootsOf(places).map(root => root.row.name).sort())
            .toEqual(['Arklay County', 'the farmhouse']);
    });

    test('a parent that names no record leaves the row a root, rather than erroring', () => {
        // The fail-open case one level up: the string is kept verbatim on the record and simply
        // resolves to nothing, which is what every place string in every existing chat does.
        const places = table({ name: 'the safehouse', place: 'somewhere in Seoul', turn: 1 });
        const row = places.get(placeKey('the safehouse'));
        expect(row.place).toBe('somewhere in Seoul');
        expect(ancestorsOf(places, placeKey('the safehouse'))).toEqual([]);
        expect(rootsOf(places)).toHaveLength(1);
    });
});

describe('aliases, one house, however the story words it', () => {
    test('every declared name reaches the one record', () => {
        const places = farmhouse();
        const key = placeKey('the farmhouse');
        for (const said of ['the farmhouse', 'farmhouse', 'home', 'Solomon\'s place']) {
            expect(resolvePlace(places, said)?.key).toBe(key);
        }
    });

    test('a later sighting under an alias lands on the record rather than beside it', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'home', detail: 'the power is out', turn: 9 });
        expect(places.size).toBe(4);
        const row = places.get(placeKey('the farmhouse'));
        expect(row.detail).toBe('the power is out');
        // Silence is not a retraction: the standing fact the alias sighting never mentioned stands.
        expect(row.facts).toBe('two storeys, north-facing');
    });

    test('an alias resolves a parent too, so a room can name the house any way it likes', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the porch', place: 'home', turn: 7 });
        expect(ancestorsOf(places, placeKey('the porch')).map(step => step.row.name))
            .toEqual(['the farmhouse']);
        expect(childrenOf(places, placeKey('the farmhouse')).map(c => c.row.name))
            .toContain('the porch');
    });
});

describe('resolution FAILS OPEN, a chat with no place records behaves exactly as it does today', () => {
    test('an empty table resolves nothing and throws nothing', () => {
        const empty = new Map();
        for (const said of ['the goshiwon room', 'carried', '', null, undefined, 'unknown']) {
            expect(resolvePlace(empty, said)).toBeNull();
        }
    });

    test('a string no record names resolves to null even when the table is full of places', () => {
        const places = farmhouse();
        expect(resolvePlace(places, 'the Nowon gate')).toBeNull();
        expect(resolvePlace(places, 'Arklay County')).toBeNull();
        // And null is the ONLY way it says so. Nothing is invented, nothing near-matches: "the
        // kitchen" exists, "the kitchen window" does not.
        expect(resolvePlace(places, 'the kitchen window')).toBeNull();
    });

    test('the free-text places fold already carries are untouched by any of this', () => {
        // The four fields that hold a place string today, an item's `at`, a cast row's `place`, a
        // thread's `where`, the scene's `location`: are strings and stay strings. Asked about one
        // with no record, the resolver answers null and the caller keeps the string it had.
        const places = table({ name: 'the farmhouse', turn: 1 });
        const scene = { location: 'the goshiwon room' };
        const resolved = resolvePlace(places, scene.location);
        expect(resolved).toBeNull();
        expect(resolved?.row?.name ?? scene.location).toBe('the goshiwon room');
    });
});

describe('cycles, a place must not contain itself, directly or transitively', () => {
    test('a place cannot be its own parent', () => {
        const places = table({ name: 'the farmhouse', turn: 1 });
        expect(wouldCycle(places, placeKey('the farmhouse'), 'the farmhouse')).toBe(true);
        const outcome = foldPlace(places, { name: 'the farmhouse', place: 'farmhouse', turn: 2 });
        expect(outcome.reason).toBe('place-cycle');
        // The sighting still landed; only the parent was refused. Omitting the field is silence, so
        // the parent the record already had, none, stands.
        expect(outcome.key).toBe(placeKey('the farmhouse'));
        expect(places.get(outcome.key).place).toBe('');
    });

    test('a transitive loop is refused three levels up', () => {
        const places = farmhouse();
        const house = placeKey('the farmhouse');
        expect(wouldCycle(places, house, 'the cellar')).toBe(true);
        const outcome = foldPlace(places, { name: 'the farmhouse', place: 'the cellar', detail: 'quiet', turn: 8 });
        expect(outcome.reason).toBe('place-cycle');
        // The rest of the observation survives, the refusal costs the parent, not the sighting.
        expect(places.get(house).detail).toBe('quiet');
        expect(places.get(house).place).toBe('');
    });

    test('the two-row loop that closes on the write being checked', () => {
        // The case a walk over the STORED table alone cannot see: the house already points at a
        // kitchen that does not exist yet, so the walk stops, until this very write creates it.
        const places = table({ name: 'the house', place: 'the kitchen', turn: 1 });
        expect(ancestorsOf(places, placeKey('the house'))).toEqual([]);
        const outcome = foldPlace(places, { name: 'the kitchen', place: 'the house', turn: 2 });
        expect(outcome.reason).toBe('place-cycle');
        // A brand-new row simply has no parent field; an existing one keeps the '' it had. Both are
        // the same silence, and `resolvePlace` reads them the same way.
        expect(places.get(placeKey('the kitchen')).place).toBeUndefined();
        // Containment survives in the one direction the stored data actually claimed, the house is
        // inside the kitchen, which is odd and is what was written, and the loop does not close.
        expect(ancestorsOf(places, placeKey('the kitchen'))).toEqual([]);
        expect(ancestorsOf(places, placeKey('the house')).map(step => step.row.name))
            .toEqual(['the kitchen']);
    });

    test('the same loop declared through an alias is refused too', () => {
        const places = table({ name: 'the farmhouse', aka: 'home', turn: 1 });
        expect(wouldCycle(places, placeKey('the farmhouse'), 'home', 'home')).toBe(true);
        expect(foldPlace(places, { name: 'the farmhouse', aka: 'home', place: 'home', turn: 2 }).reason)
            .toBe('place-cycle');
    });

    test('a legitimate re-parent is not a cycle', () => {
        const places = farmhouse();
        // The cellar turns out to be under the east wing, not the kitchen. Nothing loops.
        expect(wouldCycle(places, placeKey('the cellar'), 'the east wing')).toBe(false);
        const outcome = foldPlace(places, { name: 'the cellar', place: 'the east wing', turn: 9 });
        expect(outcome.reason).toBe('');
        expect(ancestorsOf(places, placeKey('the cellar')).map(step => step.row.name))
            .toEqual(['the east wing', 'the farmhouse']);
    });

    test('a table that already contains a loop is walked once, not forever', () => {
        // Hand-written damage, or data from before the guard. `ancestorsOf` terminates and
        // `wouldCycle` refuses to spread it to an unrelated row.
        const places = new Map();
        places.set(placeKey('a'), { name: 'a', place: 'b', turn: 1 });
        places.set(placeKey('b'), { name: 'b', place: 'a', turn: 1 });
        expect(ancestorsOf(places, placeKey('a')).map(step => step.row.name)).toEqual(['b']);
        expect(wouldCycle(places, placeKey('c'), 'a')).toBe(false);
    });
});

describe('the cap, a place table cannot eat the metadata blob', () => {
    test('a new place past MAX_PLACES is refused, and an existing one still updates', () => {
        const places = new Map();
        for (let i = 0; i < MAX_PLACES; i++) {
            expect(foldPlace(places, { name: `room ${i}`, turn: 1 }).key).toBeTruthy();
        }
        expect(places.size).toBe(MAX_PLACES);

        const refused = foldPlace(places, { name: 'the cellar', turn: 2 });
        expect(refused).toEqual({ key: '', reason: 'places-full' });
        expect(places.size).toBe(MAX_PLACES);

        // A row already in the table is not a new row, so the cap never blocks an edit.
        expect(foldPlace(places, { name: 'room 0', detail: 'flooded', turn: 3 }).reason).toBe('');
        expect(places.get(placeKey('room 0')).detail).toBe('flooded');
    });

    test('the batch reports every refusal with the raw proposal', () => {
        const places = new Map();
        for (let i = 0; i < MAX_PLACES; i++) {
            foldPlace(places, { name: `room ${i}`, turn: 1 });
        }
        const { accepted, rejected } = foldPlaces(places, [
            { name: 'the cellar' },
            { name: '   ' },
            { name: 'room 0', place: 'room 0' },
        ], { turn: 4, windowText: 'the trapdoor is shut' });
        expect(accepted).toBe(1);
        expect(rejected.map(r => r.reason)).toEqual(['places-full', 'unusable-name', 'place-cycle']);
        // The no-raw-reject gate's contract: every refusal carries what was proposed.
        expect(rejected.every(r => r.raw)).toBe(true);
    });
});

describe('the record, silence, the trail, and the falsy-number trap', () => {
    test('an omitted field is silence, so a later write never erases what it did not mention', () => {
        const places = table({ name: 'the farmhouse', facts: 'two storeys', detail: 'intact', turn: 1 });
        foldPlace(places, { name: 'the farmhouse', detail: 'the east wing is rubble', turn: 2 });
        const row = places.get(placeKey('the farmhouse'));
        expect(row.facts).toBe('two storeys');
        expect(row.detail).toBe('the east wing is rubble');
    });

    test('the trail records what each write replaced, and only what changed', () => {
        const places = table({ name: 'the farmhouse', facts: 'two storeys', detail: 'intact', turn: 1 });
        foldPlace(places, { name: 'the farmhouse', detail: 'the east wing is rubble', turn: 2 });
        const trail = places.get(placeKey('the farmhouse')).trail;
        expect(trail).toEqual([
            { field: 'facts', from: '', to: 'two storeys', turn: 1, mid: -1 },
            { field: 'detail', from: '', to: 'intact', turn: 1, mid: -1 },
            { field: 'detail', from: 'intact', to: 'the east wing is rubble', turn: 2, mid: -1 },
        ]);
    });

    test('a restatement in different casing is not a change', () => {
        const places = table({ name: 'the farmhouse', detail: 'intact', turn: 1 });
        foldPlace(places, { name: 'the farmhouse', detail: 'Intact', turn: 2 });
        expect(places.get(placeKey('the farmhouse')).trail).toHaveLength(1);
    });

    test('the trail is bounded, oldest first out', () => {
        const places = table({ name: 'the farmhouse', detail: 'state 0', turn: 1 });
        for (let i = 1; i <= MAX_PLACE_TRAIL + 4; i++) {
            foldPlace(places, { name: 'the farmhouse', detail: `state ${i}`, turn: i + 1 });
        }
        const trail = places.get(placeKey('the farmhouse')).trail;
        expect(trail).toHaveLength(MAX_PLACE_TRAIL);
        expect(trail[trail.length - 1].to).toBe(`state ${MAX_PLACE_TRAIL + 4}`);
    });

    test('a re-parent is on the trail, because what a place is inside is part of its history', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the cellar', place: 'the east wing', turn: 9 });
        expect(places.get(placeKey('the cellar')).trail).toContainEqual(
            { field: 'place', from: 'the kitchen', to: 'the east wing', turn: 9, mid: -1 },
        );
    });

    test('driveSize is omitted when absent, so a quiet write cannot zero a standing change', () => {
        const places = table({ name: 'the mine', driveSize: 6, drive: 2, turn: 1 });
        expect(places.get(placeKey('the mine'))).toMatchObject({ driveSize: 6, drive: 2 });
        foldPlace(places, { name: 'the mine', detail: 'the pumps are running', turn: 2 });
        const row = places.get(placeKey('the mine'));
        expect(row.driveSize).toBe(6);
        expect(row.drive).toBe(2);
    });

    test('a write that never mentioned a number never writes one', () => {
        const places = table({ name: 'the mine', turn: 1 });
        expect('driveSize' in places.get(placeKey('the mine'))).toBe(false);
        expect('drive' in places.get(placeKey('the mine'))).toBe(false);
    });

    test('first is the earliest claim, whatever order the writes arrive in', () => {
        const places = table({ name: 'the farmhouse', turn: 7 });
        foldPlace(places, { name: 'the farmhouse', detail: 'seen earlier', turn: 3 });
        expect(places.get(placeKey('the farmhouse')).first).toBe(3);
    });
});

describe('the prune, containment pins a record', () => {
    test('a stale leaf is shed and returned whole for the cold store', () => {
        const places = table({ name: 'the safehouse', facts: 'two rooms over a laundry', turn: 1 });
        const shed = prunePlaces(places, PLACE_STALE * 2 + 2);
        expect(shed).toHaveLength(1);
        expect(shed[0].row.facts).toBe('two rooms over a laundry');
        expect(places.size).toBe(0);
    });

    test('a place with children survives, however long nobody names it', () => {
        const places = farmhouse();
        // The kitchen is walked into every turn; nobody says "the farmhouse" while standing in it.
        foldPlace(places, { name: 'the kitchen', detail: 'the stove is lit', turn: 400 });
        const shed = prunePlaces(places, 400);
        expect(shed.map(row => row.row.name).sort()).toEqual(['the cellar', 'the east wing']);
        // The house stays: dropping it would silently change what the kitchen is inside.
        expect(places.has(placeKey('the farmhouse'))).toBe(true);
        expect(ancestorsOf(places, placeKey('the kitchen')).map(step => step.row.name))
            .toEqual(['the farmhouse']);
    });

    test('nothing is shed inside the window', () => {
        const places = farmhouse();
        expect(prunePlaces(places, PLACE_STALE)).toEqual([]);
        expect(places.size).toBe(4);
    });
});

describe('the renderer, facts, current state, and what is in it', () => {
    test('a place reads as one line with its live children named', () => {
        const places = farmhouse();
        expect(renderPlace(places, placeKey('the farmhouse')))
            .toBe('the farmhouse (two storeys, north-facing; contains the east wing, the kitchen)');
    });

    test('the current state carries forward beside the standing truth', () => {
        const places = farmhouse();
        foldPlace(places, { name: 'the east wing', detail: 'rubble; the roof is gone', status: 'destroyed', turn: 10 });
        expect(renderPlace(places, placeKey('the east wing')))
            .toBe('the east wing (in the farmhouse; rubble; the roof is gone; destroyed)');
        // A destroyed place stops being something the house CONTAINS and does not stop existing,
        // rows still point at it.
        expect(renderPlace(places, placeKey('the farmhouse')))
            .toBe('the farmhouse (two storeys, north-facing; contains the kitchen)');
    });

    test('a place with no record renders as nothing at all', () => {
        expect(renderPlace(new Map(), placeKey('the moon'))).toBe('');
    });
});

describe('the storage half, what a source gate can pin about places.js', () => {
    // `places.js` imports `store.js`, which imports `script.js`, so jest cannot load it, the same
    // constraint `sanguine-cold-store.test.js` records for the cold store's browser half. What is
    // load-bearing and checkable is read from the source, in the shape `sanguine-no-raw-reject`
    // uses: the budget pruner must EXIST or the blob silently evicts chronicle events instead, and
    // the table must not be the cast's.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
        path.join(here, '..', 'public', 'scripts', 'extensions', 'sanguine', 'places.js'), 'utf8');

    test('places live at state.places, and never share the cast\'s 48 slots', () => {
        expect(source).toContain('\'state.places\'');
        // The prose says `state.cast` and says why; no PATH in this file may be it.
        expect(source).not.toContain('\'state.cast\'');
    });

    test('a pruner is registered, priced with the archive pruners', () => {
        expect(source).toContain('registerPruner((overBy) => {');
        expect(source).toContain('}, PRUNE_ARCHIVE);');
    });

    test('shed places demote into their own cold-store domain', () => {
        expect(source).toContain('cold.demote({ kind: COLD_KIND');
        expect(source).toContain('const COLD_KIND = \'place\';');
    });
});

describe('migration, the place table is new, and a second run is a no-op', () => {
    /**
     * A v1 blob carrying a place table, which no real v1 blob has, the point being that migration
     * neither invents places nor destroys them.
     * @returns {object} The blob.
     */
    const blob = () => ({
        v: 1,
        state: {
            entities: {
                'person solomon': { kind: 'person', name: 'Solomon', place: 'the farmhouse', turn: 4, first: 1 },
            },
            context: { location: { v: 'the farmhouse', t: 4, src: 'narrative' } },
            places: {
                'place farmhouse': {
                    name: 'the farmhouse', aka: 'home', facts: 'two storeys, north-facing',
                    detail: 'the east wing is rubble', status: '', source: '', first: 1, turn: 4,
                },
            },
        },
        chronicle: { events: {} },
    });

    test('no place record is fabricated from the free-text locations a v1 chat is full of', () => {
        // The whole fail-open promise, at migration time: a chat whose scene location and cast rows
        // are strings comes out of the migration with those strings and no place table at all.
        const fold = { ...blob(), state: { ...blob().state, places: undefined } };
        delete fold.state.places;
        migrate(fold);
        expect(fold.state.places).toBeUndefined();
        expect(fold.state.context.location.v).toBe('the farmhouse');
    });

    test('a place table already on the blob survives the migration verbatim', () => {
        const fold = blob();
        const before = JSON.stringify(fold.state.places);
        migrate(fold);
        expect(JSON.stringify(fold.state.places)).toBe(before);
    });

    test('running the migration again changes nothing', () => {
        const fold = blob();
        migrate(fold);
        const afterFirst = structuredClone(fold);
        migrate(fold);
        const afterSecond = structuredClone(fold);
        migrate(fold);
        expect(JSON.stringify(fold.state.places)).toBe(JSON.stringify(afterFirst.state.places));
        // The v1 keys retire on the run AFTER the v2 write (§9), so the blob settles from the
        // second run on, which is the invariant a third run pins.
        expect(afterSecond).toEqual(fold);
    });
});
