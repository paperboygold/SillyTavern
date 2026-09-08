import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/*
 * The place record had no producer, and the audit is the point of this file.
 *
 * `place-table.js` and `places.js` are ~63 KB of tested code implementing containment, per-place
 * facts and detail, a destruction cascade, a trail and drives, and `state.places` was length 0 in
 * all 22 chats in `data/default-user/chats`, because the only writer was hand entry in the Assets
 * tab. Six probes were registered and none of them wrote a place.
 *
 * Meanwhile the scene probe produced a location string on 2064 of 2164 passes in the trace archive
 * and threw its structure away: 463 of the 964 distinct strings (48%) encode a containment in prose
 *, "RPD break room", "Nine-Tails Inn, common room", "Association clinic, Room 3". This is the test
 * for the wiring that keeps it.
 *
 * `store.js` reaches the browser (`script.js`, `extensions.js`), so it is replaced with an in-memory
 * blob. Everything else on the path is real: `places.js`, `place-table.js`, `entity-table.js`,
 * `cold-store.js`, `observe.js`. `entities.js` is mocked only because it reaches `lore.js`, which
 * reaches `world-info.js`; `places.js` uses one function from it.
 */

const BLOB = { fold: {} };
let TURN = 1;

/** Walk a dotted path in the fake blob. @returns {{parent: object, key: string}|null} The site. */
function site(path, create) {
    const parts = String(path).split('.');
    let parent = BLOB.fold;
    for (const part of parts.slice(0, -1)) {
        if (!parent[part]) {
            if (!create) {
                return null;
            }
            parent[part] = {};
        }
        parent = parent[part];
    }
    return { parent, key: parts[parts.length - 1] };
}

const PRUNERS = [];

jest.unstable_mockModule('../public/scripts/extensions/sanguine/store.js', () => ({
    PRUNE_ARCHIVE: 2,
    PRUNE_DIAGNOSTICS: 1,
    registerPruner: (fn, at) => PRUNERS.push({ fn, at }),
    loadTable: (path) => {
        const found = site(path, false);
        const stored = found ? found.parent[found.key] : null;
        const table = new Map();
        if (stored && typeof stored === 'object') {
            for (const [key, value] of Object.entries(stored)) {
                table.set(key, value);
            }
        }
        return table;
    },
    commit: (path, table) => {
        const found = site(path, true);
        found.parent[found.key] = Object.fromEntries(table.entries());
    },
    loadValue: (path, dflt) => {
        const found = site(path, false);
        const value = found ? found.parent[found.key] : undefined;
        return value === undefined ? dflt : value;
    },
    commitValue: (path, value) => {
        const found = site(path, true);
        found.parent[found.key] = value;
    },
    foldByteSize: () => JSON.stringify(BLOB.fold).length,
}));

jest.unstable_mockModule('../public/scripts/extensions/sanguine/entities.js', () => ({
    turn: () => TURN,
    load: () => new Map(),
}));

// `scene.js` reaches `state.js`, which is the whole app. Only the five bindings it imports are
// needed, and the three that write are recorded so the schema half of the probe can be asserted
// without any of the clock or mark machinery running.
const setContext = jest.fn();
const recordMarks = jest.fn(() => 0);
const noteSceneElapsed = jest.fn(() => ({ skipped: false, minutes: 0 }));

jest.unstable_mockModule('../public/scripts/extensions/sanguine/state.js', () => ({
    NARRATIVE: 'narrative',
    loadClock: () => null,
    noteSceneElapsed,
    recordMarks,
    setContext,
}));

const places = await import('../public/scripts/extensions/sanguine/places.js');
const scene = await import('../public/scripts/extensions/sanguine/scene.js');
const { MAX_PLACES, ancestorsOf, childrenOf, placeKey } = await import('../public/scripts/extensions/sanguine/place-table.js');

/** A scene fragment with only the place fields filled. @returns {object} The fragment. */
function pass({ name = '', within = '', facts = '', detail = '' } = {}) {
    return {
        pov: '', location: name, time: '', date: '', weather: '', conditions: [],
        elapsed_days: 0, elapsed_minutes: 0, phase: '', clock_hour: -1, clock_minute: -1,
        date_changed: false,
        place_name: name, place_within: within, place_facts: facts, place_detail: detail,
    };
}

beforeEach(() => {
    BLOB.fold = {};
    TURN = 1;
    PRUNERS.length = 0;
    setContext.mockClear();
    recordMarks.mockClear();
});

/*
 * Strict mode is not a style preference. OpenAI's structured output demands `additionalProperties:
 * false` and a complete `required` on every object in the SHARED schema, and one omission fails
 * every probe in the pass at once, the events, the threads and the review with it.
 */
describe('the scene probe asks for a place', () => {
    const schema = scene.schema();

    test('all four place fields are present, typed and required', () => {
        for (const field of ['place_name', 'place_within', 'place_facts', 'place_detail']) {
            expect(schema.properties[field]?.type).toBe('string');
            expect(schema.required).toContain(field);
        }
    });

    test('every property is required and nothing extra is allowed', () => {
        expect(schema.additionalProperties).toBe(false);
        expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    });

    test('`location` is untouched, it is the display and presence string', () => {
        // Presence was recently broken and repaired against this field's exact behaviour
        // (`state.js` `sceneLocation`, the Raccoon City measurement: scene said "RPD break room",
        // cast said "break room", `here` was empty for nine people standing in it).
        expect(schema.properties.location.description).toContain('"the stableyard"');
        expect(schema.required).toContain('location');
    });

    test('the instruction names the compound case the traces actually produce', () => {
        const said = scene.instruction();
        expect(said).toContain('RPD break room');
        expect(said).toContain('Nine-Tails Inn');
        // The one invention `place_within` invites: reading a possessive name as a container.
        expect(said).toContain('Paulette');
    });
});

/*
 * The producer, end to end, against the real table.
 */
describe('a pass lands a place record', () => {
    test('a bare location opens one row and nothing else', () => {
        const out = scene.applyExtraction(pass({ name: 'the stableyard', facts: 'eight stalls, dirt floor' }));
        expect(out.place).toBe(placeKey('the stableyard'));
        const table = places.load();
        expect(table.size).toBe(1);
        expect(table.get(out.place).facts).toBe('eight stalls, dirt floor');
    });

    test('a container becomes a real parent link, not a dangling string', () => {
        // The failure this guards: `place` holds a NAME, and every reader resolves it. A parent with
        // no row of its own resolves to null, so the containment would be stored and invisible,
        // `ancestorsOf` would answer [] and the room would sit at the top of the tree as a root.
        scene.applyExtraction(pass({ name: 'break room', within: 'RPD', detail: 'barricaded with a filing cabinet' }));
        const table = places.load();
        const key = placeKey('break room');
        expect(table.size).toBe(2);
        expect(ancestorsOf(table, key).map(up => up.row.name)).toEqual(['RPD']);
        expect(childrenOf(table, placeKey('RPD')).map(child => child.row.name)).toEqual(['break room']);
    });

    test('the seeded container is bare, nothing narrated its facts', () => {
        scene.applyExtraction(pass({ name: 'common room', within: 'Nine-Tails Inn', facts: 'low beams, one hearth' }));
        const inn = places.load().get(placeKey('Nine-Tails Inn'));
        expect(inn.name).toBe('Nine-Tails Inn');
        expect(inn.facts).toBe('');
        expect(inn.detail).toBe('');
    });

    test('a house is built room by room across passes', () => {
        scene.applyExtraction(pass({ name: 'guest room', within: 'the house', facts: 'single bed, dormer window' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'kitchen', within: 'the house', facts: 'wood stove, stone sink' }));
        const table = places.load();
        expect(childrenOf(table, placeKey('the house')).map(child => child.row.name).sort())
            .toEqual(['guest room', 'kitchen']);
    });

    test('`here` follows the scene, so the panel never has to parse the location string', () => {
        scene.applyExtraction(pass({ name: 'break room', within: 'RPD' }));
        expect(places.here()?.row?.name).toBe('break room');
        TURN = 2;
        scene.applyExtraction(pass({ name: 'bullpen', within: 'RPD' }));
        expect(places.here()?.row?.name).toBe('bullpen');
    });

    test('a pass that says nothing about where writes no place at all', () => {
        expect(scene.applyExtraction(pass({ name: '' })).place).toBe('');
        expect(places.load().size).toBe(0);
    });
});

/*
 * THE data-corruption risk, and the reason it is tested first among the merge rules.
 *
 * This probe fires on every landed pass and answered `location` on 95% of them, so the common shape
 * is a pass that says only WHERE. If an empty `place_facts` were a write, the facts a previous pass
 * established would be erased within one turn of establishing them, on every place, forever.
 */
describe('silence is not a retraction', () => {
    test('a later pass with empty facts leaves the earlier facts standing', () => {
        scene.applyExtraction(pass({
            name: 'break room',
            facts: 'concrete stairwell, no windows, one steel door',
            detail: 'lights flickering',
        }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'break room' }));
        const row = places.load().get(placeKey('break room'));
        expect(row.facts).toBe('concrete stairwell, no windows, one steel door');
        expect(row.detail).toBe('lights flickering');
    });

    test('twenty silent passes in a row still leave them standing', () => {
        scene.applyExtraction(pass({ name: 'the study', facts: 'oak desk, south window' }));
        for (let i = 0; i < 20; i++) {
            TURN = 2 + i;
            scene.applyExtraction(pass({ name: 'the study' }));
        }
        expect(places.load().get(placeKey('the study')).facts).toBe('oak desk, south window');
    });

    test('a pass that omits the container does not release the room from it', () => {
        scene.applyExtraction(pass({ name: 'common room', within: 'Nine-Tails Inn' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'common room' }));
        expect(ancestorsOf(places.load(), placeKey('common room')).map(up => up.row.name))
            .toEqual(['Nine-Tails Inn']);
    });

    test('a pass that DOES say something new supersedes it', () => {
        scene.applyExtraction(pass({ name: 'break room', detail: 'lights flickering' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'break room', detail: 'barricaded with a filing cabinet' }));
        const row = places.load().get(placeKey('break room'));
        expect(row.detail).toBe('barricaded with a filing cabinet');
        // The trail is what makes the change legible afterwards, the whole reason a place is a
        // record rather than a string.
        expect(row.trail.some(entry => entry.field === 'detail' && entry.from === 'lights flickering')).toBe(true);
    });
});

/*
 * A loop is the one thing a parent FIELD cannot refuse by construction.
 */
describe('containment refuses a cycle without losing the sighting', () => {
    test('the parent is dropped and everything else the pass said is kept', () => {
        scene.applyExtraction(pass({ name: 'the house', within: 'the village' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'kitchen', within: 'the house' }));
        TURN = 3;
        // The model now claims the house is inside its own kitchen.
        scene.applyExtraction(pass({ name: 'the house', within: 'kitchen', detail: 'shutters banging' }));

        const table = places.load();
        expect(ancestorsOf(table, placeKey('the house')).map(up => up.row.name)).toEqual(['the village']);
        expect(table.get(placeKey('the house')).detail).toBe('shutters banging');
    });

    test('a place is never made its own parent', () => {
        scene.applyExtraction(pass({ name: 'the cave', within: 'the cave' }));
        const table = places.load();
        expect(table.size).toBe(1);
        expect(ancestorsOf(table, placeKey('the cave'))).toEqual([]);
    });

    test('the two-row case: a loop that closes only once the second row exists', () => {
        scene.applyExtraction(pass({ name: 'the house', within: 'the kitchen' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'the kitchen', within: 'the house' }));
        const table = places.load();
        // Whichever way the walk runs, it terminates and nobody is inside themselves.
        expect(ancestorsOf(table, placeKey('the kitchen')).length).toBeLessThan(MAX_PLACES);
        expect(ancestorsOf(table, placeKey('the house')).length).toBeLessThan(MAX_PLACES);
    });
});

/*
 * The cap, and the failure giving the record a producer would otherwise have created.
 *
 * Twelve of the twenty-four chats in the trace archive produce more than MAX_PLACES = 32 distinct
 * place keys and the largest produces 202. `prunePlaces` cannot relieve that: it fires at 200 turns
 * and the longest chat ever reached 193. Before the relief below, the table filled and then refused
 * every place the campaign moved to for the rest of its life.
 */
describe('the MAX_PLACES cap holds without jamming', () => {
    /** Fill the table with `n` unrelated leaf places, each on its own turn. */
    const fill = (n) => {
        for (let i = 0; i < n; i++) {
            TURN = i + 1;
            scene.applyExtraction(pass({ name: `room ${i}`, facts: `fact ${i}` }));
        }
    };

    test('the table never exceeds the cap', () => {
        fill(MAX_PLACES + 12);
        expect(places.load().size).toBeLessThanOrEqual(MAX_PLACES);
    });

    test('a full table still accepts the place the story just moved to', () => {
        fill(MAX_PLACES);
        expect(places.load().size).toBe(MAX_PLACES);
        TURN = 500;
        const out = scene.applyExtraction(pass({ name: 'the drowned chapel', facts: 'flooded to the knee' }));
        expect(out.place).toBe(placeKey('the drowned chapel'));
        expect(places.load().get(out.place).facts).toBe('flooded to the knee');
    });

    test('the row that gives up its slot is the stalest, and it is demoted rather than deleted', () => {
        fill(MAX_PLACES);
        TURN = 500;
        scene.applyExtraction(pass({ name: 'the drowned chapel' }));
        expect(places.load().has(placeKey('room 0'))).toBe(false);
        // [EVICT]: selection cannot bound a store, so eviction is demotion. Walking back in brings
        // the record home with the facts the campaign established, rather than opening a blank one.
        TURN = 501;
        scene.applyExtraction(pass({ name: 'room 0' }));
        expect(places.load().get(placeKey('room 0'))?.facts).toBe('fact 0');
    });

    test('containment pins a record: the stalest row is skipped when something is inside it', () => {
        // The farmhouse is the oldest row in the table and is never mentioned again, nobody says
        // "the farmhouse" while standing in the cellar of it. Evicting it would silently change what
        // the cellar IS, so `makeRoom` takes the stalest LEAF instead, exactly as `prunePlaces` does.
        TURN = 1;
        scene.applyExtraction(pass({ name: 'cellar', within: 'the farmhouse' }));
        fill(MAX_PLACES - 2);
        expect(places.load().size).toBe(MAX_PLACES);
        TURN = 100;
        scene.applyExtraction(pass({ name: 'cellar', within: 'the farmhouse' }));
        TURN = 101;
        scene.applyExtraction(pass({ name: 'the drowned chapel' }));

        const table = places.load();
        expect(table.has(placeKey('the farmhouse'))).toBe(true);
        expect(table.has(placeKey('room 0'))).toBe(false);
        expect(ancestorsOf(table, placeKey('cellar')).map(up => up.row.name)).toEqual(['the farmhouse']);
    });
});

/*
 * Alias resolution, which is what stops one room becoming two records the first time the story
 * changes its wording. Measured in the archive, this is the dominant source of key churn: "the
 * chamber", "tomb chamber" and "burial chamber" are three strings and one room.
 */
describe('a second spelling lands on the record that exists', () => {
    test('a leading article is not an identity', () => {
        scene.applyExtraction(pass({ name: 'the study', facts: 'oak desk' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'study', detail: 'papers everywhere' }));
        const table = places.load();
        expect(table.size).toBe(1);
        const row = table.get(placeKey('study'));
        expect(row.facts).toBe('oak desk');
        expect(row.detail).toBe('papers everywhere');
    });

    test('case and spacing do not open a second row', () => {
        scene.applyExtraction(pass({ name: 'Gym Gamma', facts: 'reinforced concrete' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: '  gym   gamma ', detail: 'rubble field reset' }));
        expect(places.load().size).toBe(1);
    });

    test('the container resolves through the same machinery', () => {
        scene.applyExtraction(pass({ name: 'the common room', within: 'the Nine-Tails Inn' }));
        TURN = 2;
        scene.applyExtraction(pass({ name: 'corner table', within: 'Nine-Tails Inn' }));
        const table = places.load();
        // Three rows, not four: "the Nine-Tails Inn" and "Nine-Tails Inn" are one building.
        expect(table.size).toBe(3);
        expect(childrenOf(table, placeKey('Nine-Tails Inn')).map(child => child.row.name).sort())
            .toEqual(['corner table', 'the common room']);
    });
});
