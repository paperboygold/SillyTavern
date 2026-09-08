import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { ELSEWHERE, HERE, MAX_DETAIL, MAX_DOSSIER, MAX_WEARING, PERSON, TRAILED, clampDossierFields, foldEntities, foldEntity, presenceOf, renderEntities } from '../public/scripts/extensions/sanguine/entity-table.js';

/*
 * What a person LOOKS like.
 *
 * The complaint this file is the regression gate for, in the owner's words: "I see almost no
 * physical descriptors for anyone, no idea what they're wearing or what they look like."
 *
 * Measured on the live Raccoon City cast at turn 141, sixteen rows, one field (`facts`) doing all of
 * appearance, clothing, rank and standing truth in 120 characters:
 *
 *     facts: "officer"
 *     facts: "mid-forties, civilian clothes, bloody arm wrapped in torn shirt"
 *     facts: ""                                                        (7 of the 16)
 *
 * Four fields replace that one. Two of them, `look` and `bearing`, are PERMANENT and must not
 * churn when somebody changes a coat; one, `wearing`, is CURRENT and must churn; one, `history`
 *, is what the story has revealed about where they came from. `bearing` and `history` are carried
 * only by a person of interest, because the largest live chat's metadata blob sits at 96% of
 * `MAX_FOLD_BYTES` and four long fields on 48 rows is 68 KB.
 *
 * Three tiers, and each is tested here:
 *
 *   · what the FOLD stores, flagged rows get the long form, nobody else does
 *   · what the PROMPT carries, flagged AND present gets the dossier, elsewhere gets nothing
 *   · what the PROBE asks for, the four fields exist in the schema and are `required`
 */

/** @returns {Map<string, object>} A table with one person in one room. */
function room() {
    return new Map();
}

/** A probe answer with every description field over-long, so the caps are what decides. */
const overlong = {
    kind: PERSON,
    name: 'Martinez',
    aka: 'the officer',
    place: 'break room',
    turn: 1,
    look: 'L'.repeat(MAX_DOSSIER * 2),
    wearing: 'W'.repeat(MAX_DOSSIER * 2),
    bearing: 'B'.repeat(MAX_DOSSIER * 2),
    history: 'H'.repeat(MAX_DOSSIER * 2),
};

describe('the fold stores the long form only for a person of interest', () => {
    test('an unflagged row keeps appearance and clothing, at the ordinary cap', () => {
        const table = room();
        const key = foldEntity(table, overlong, { poi: new Set() });
        expect(table.get(key).look).toHaveLength(MAX_DETAIL);
        expect(table.get(key).wearing).toHaveLength(MAX_DETAIL);
    });

    // Not stored empty, ABSENT. `merge_entity` reads `''` and a missing key identically, so an
    // empty string is bytes spent to say nothing, and the blob is the thing under pressure.
    test('an unflagged row carries no manner and no background at all', () => {
        const table = room();
        const key = foldEntity(table, overlong, { poi: new Set() });
        expect(Object.keys(table.get(key))).not.toContain('bearing');
        expect(Object.keys(table.get(key))).not.toContain('history');
    });

    test('a flagged row carries all four, at the dossier caps', () => {
        const table = room();
        const key = foldEntity(table, { ...overlong }, { poi: null });
        // Flag by key, then re-report: the flag table is keyed by exactly what `foldEntity` returns.
        foldEntity(table, { ...overlong, turn: 2 }, { poi: new Set([key]) });
        expect(table.get(key).look).toHaveLength(MAX_DOSSIER);
        expect(table.get(key).wearing).toHaveLength(MAX_WEARING);
        expect(table.get(key).bearing).toHaveLength(MAX_DOSSIER);
        expect(table.get(key).history).toHaveLength(MAX_DOSSIER);
    });

    // The flag is set on the canonical key. A story that goes on to call her "the officer" must not
    // silently drop her back to the short form, that is exactly the aliasing defect the alias set
    // exists to close, and it would land on the one row somebody cared enough to flag.
    test('the flag is resolved through the alias set, not the raw name', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Martinez', aka: 'the officer', turn: 1 });
        const wrote = foldEntity(table, {
            kind: PERSON, name: 'the officer', aka: 'Martinez', turn: 2, bearing: 'dry, says less than she knows',
        }, { poi: new Set([key]) });
        expect(wrote).toBe(key);
        expect(table.get(key).bearing).toBe('dry, says less than she knows');
    });

    // Flagging late costs nothing, which is what makes the storage tier honest rather than merely
    // cheap: the fields are re-derived from prose on every sighting, so the next one fills them.
    test('flagging somebody late loses nothing, the next sighting fills the long form', () => {
        const table = room();
        const key = foldEntity(table, overlong, { poi: new Set() });
        expect(table.get(key).bearing).toBeUndefined();
        foldEntity(table, { ...overlong, turn: 2 }, { poi: new Set([key]) });
        expect(table.get(key).bearing).toHaveLength(MAX_DOSSIER);
    });

    // The tier decides what a write MAY carry, never what the row already holds. `setPlace`,
    // `absorb-table.js` and `migrate.js` all reach `foldEntity` with no flag set at all, and a
    // review answering "she is in the hallway" must not quietly demote a flagged person's dossier.
    // It cannot, because an empty field is silence and the tier only bounds what arrives.
    test('a place-only write with no flag set in sight leaves a stored dossier alone', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 1 });
        foldEntity(table, { ...overlong, turn: 2 }, { poi: new Set([key]) });
        foldEntity(table, { kind: PERSON, name: 'Martinez', place: 'the hallway', turn: 3 });
        expect(table.get(key).bearing).toHaveLength(MAX_DOSSIER);
        expect(table.get(key).look).toHaveLength(MAX_DOSSIER);
        expect(table.get(key).place).toBe('the hallway');
    });

    test('foldEntities forwards the flag set to every observation it accepts', () => {
        const table = room();
        const first = foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 1 });
        foldEntities(table, [{ ...overlong, name: 'Martinez' }], {
            windowText: 'Martinez raised the pistol.', turn: 2, poi: new Set([first]),
        });
        expect(table.get(first).history).toHaveLength(MAX_DOSSIER);
    });
});

describe('permanent and current are different fields because they change differently', () => {
    /** @returns {{table: Map<string, object>, key: string}} Somebody fully described. */
    function described() {
        const table = room();
        const key = foldEntity(table, {
            kind: PERSON, name: 'Martinez', place: 'break room', turn: 1,
            look: 'brown eyes, dark hair scraped back',
            wearing: 'RPD uniform, sleeve knotted above the elbow',
        });
        return { table, key };
    }

    // The whole reason this is two fields. Under one field the coat rewrites the face.
    test('a sighting that only says what they are wearing leaves the face alone', () => {
        const { table, key } = described();
        foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 2, wearing: 'a borrowed jacket' });
        expect(table.get(key).look).toBe('brown eyes, dark hair scraped back');
        expect(table.get(key).wearing).toBe('a borrowed jacket');
    });

    test('silence is still silence, an empty description never retracts one', () => {
        const { table, key } = described();
        foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 2, place: 'the hallway' });
        expect(table.get(key).look).toBe('brown eyes, dark hair scraped back');
        expect(table.get(key).wearing).toBe('RPD uniform, sleeve knotted above the elbow');
        expect(table.get(key).place).toBe('the hallway');
    });

    // A description is not an edge. `hasEdge` decides whether a row is a person or scenery, and the
    // answer is meant to be "does anything connect them to the story", a face does not.
    test('being described does not make a row connected to the story', () => {
        const table = room();
        const key = foldEntity(table, {
            kind: PERSON, name: 'the man in coveralls', turn: 1,
            look: 'heavyset, grey coveralls, hatchet still in the skull',
        });
        expect(table.get(key).wants).toBe('');
        expect(table.get(key).knows).toBe('');
    });
});

describe('the trail records relationships, and appearance is deliberately not one', () => {
    // MEASURED, live Raccoon City, Martinez's row: her trail is FULL at twelve, and one of the
    // twelve is `wants: "…before the generator runs out" → "…before generator runs out"`: an
    // article removed. A 400-character prose field on that list would evict the disposition history
    // `MAX_TRAIL` was sized for, inside a handful of turns, on paraphrase alone.
    test('the trailed fields are the three relational ones and no others', () => {
        expect(TRAILED).toEqual(['feels', 'wants', 'knows']);
    });

    test('a haircut writes no trail entry', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 1, look: 'dark hair scraped back' });
        foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 2, look: 'hair cropped to the skull' });
        expect(table.get(key).look).toBe('hair cropped to the skull');
        expect((table.get(key).trail ?? []).some(entry => entry.field === 'look')).toBe(false);
    });

    test('and a change of heart still does', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 1, feels: 'wary' });
        foldEntity(table, { kind: PERSON, name: 'Martinez', turn: 2, feels: 'friendly', wearing: 'a borrowed jacket' });
        const fields = (table.get(key).trail ?? []).map(entry => entry.field);
        expect(fields).toContain('feels');
        expect(fields).not.toContain('wearing');
    });
});

describe('the prompt is tiered by the flag AND by presence', () => {
    /**
     * One fully-described person in one room.
     * @returns {{table: Map<string, object>, key: string}} The table and her key.
     */
    function dossier() {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Martinez', aka: 'the officer', turn: 1 });
        foldEntity(table, {
            kind: PERSON, name: 'Martinez', place: 'break room', turn: 2,
            look: 'brown eyes, dark hair scraped back.',
            wearing: 'RPD uniform, sleeve knotted above the elbow.',
            bearing: 'calm and dry, says less than she knows.',
            history: 'eight years RPD, two of them under Irons.',
        }, { poi: new Set([key]) });
        return { table, key };
    }

    test('an unflagged present person is told what they look like and nothing more', () => {
        const { table } = dossier();
        const line = renderEntities(table, 2, { at: 'break room' });
        expect(line).toContain('looks: brown eyes, dark hair scraped back');
        expect(line).not.toContain('wearing');
        expect(line).not.toContain('manner:');
        expect(line).not.toContain('history:');
    });

    test('a flagged present person is told all of it', () => {
        const { table, key } = dossier();
        const line = renderEntities(table, 2, { at: 'break room', poi: new Set([key]) });
        expect(line).toContain('also known as the officer');
        expect(line).toContain('looks: brown eyes, dark hair scraped back');
        expect(line).toContain('wearing RPD uniform, sleeve knotted above the elbow');
        expect(line).toContain('manner: calm and dry, says less than she knows');
        expect(line).toContain('history: eight years RPD, two of them under Irons');
    });

    // `the_insert_law` (`InsertEmission.lean:277-283`): an insert at full weight can PROJECT a
    // departed character back into the room. A reading preference must never buy its way past that.
    test('a flagged person who is elsewhere reaches the prompt not at all', () => {
        const { table, key } = dossier();
        expect(presenceOf(table.get(key), 'the hallway')).toBe(ELSEWHERE);
        const line = renderEntities(table, 2, { at: 'the hallway', poi: new Set([key]) });
        expect(line).toBe('');
    });

    test('and while they are here, they are here', () => {
        const { table, key } = dossier();
        expect(presenceOf(table.get(key), 'break room')).toBe(HERE);
    });

    // The hedge survives the flag: `castAt` returns a third value for "the evidence cannot decide",
    // and a fuller description of somebody is not evidence about where they are standing.
    test('an unplaced flagged person keeps the hedge and gains the dossier', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Solomon', turn: 1 });
        foldEntity(table, { kind: PERSON, name: 'Solomon', turn: 2, bearing: 'quiet, watchful' },
            { poi: new Set([key]) });
        const line = renderEntities(table, 2, { at: 'break room', poi: new Set([key]) });
        expect(line).toContain('Whereabouts unstated');
        expect(line).toContain('manner: quiet, watchful');
    });

    test('a row with nothing described reads identically flagged or not', () => {
        const table = room();
        const key = foldEntity(table, { kind: PERSON, name: 'Maria', place: 'the study', turn: 1 });
        expect(renderEntities(table, 1, { at: 'the study', poi: new Set([key]) }))
            .toBe(renderEntities(table, 1, { at: 'the study' }));
    });

    // These four fields are the only ones on the line written as SENTENCES, and the line joins with
    // commas. Left alone they read "…scraped back., wearing RPD uniform", which is a punctuation
    // error in the middle of a prompt somebody is being asked to write prose from.
    test('a sentence-final full stop does not collide with the comma that follows it', () => {
        const { table, key } = dossier();
        const line = renderEntities(table, 2, { at: 'break room', poi: new Set([key]) });
        expect(line).not.toContain('., ');
        expect(line).toContain('scraped back, wearing');
    });
});

/**
 * Read one fold source file.
 * @param {string} file A filename under the extension directory.
 * @returns {string} Its text.
 */
function source(file) {
    return fs.readFileSync(
        path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine', file), 'utf8');
}

/**
 * The first match of a pattern, or the empty string.
 *
 * Hoisted out of the test bodies deliberately: the assertions below are about what the probe SAYS,
 * and a `?? ''` inside an assertion is a branch a reader has to hold while reading the claim.
 *
 * @param {string} text The haystack.
 * @param {RegExp} pattern The pattern.
 * @param {number} [group] Which capture to take.
 * @returns {string} The match.
 */
function grab(text, pattern, group = 0) {
    return text.match(pattern)?.[group] ?? '';
}

describe('the probe asks for it, which was the half that was missing', () => {
    const SOURCE = source('entities.js');

    // OpenAI strict mode applies to EVERY object in the schema: a property missing from `required`
    // fails the whole shared call with a 400 and takes the other five probes down with it. This is
    // the cheapest possible gate on the one mistake that is easy to make and expensive to find.
    test('every new field is both a property and required', () => {
        const required = grab(SOURCE, /required: \[([^\]]*'facts'[^\]]*)\]/, 1);
        for (const field of ['look', 'wearing', 'bearing', 'history']) {
            expect(SOURCE).toContain(`${field}: {\n                            type: 'string',`);
            expect(required).toContain(`'${field}'`);
        }
    });

    // `facts` was asked for appearance for a while and answered with one clause. It goes back to
    // being what it says it is; the fields above take the rest. Two fields asking for the same thing
    // is how the first one came to answer for neither.
    test('facts no longer claims appearance', () => {
        const facts = grab(SOURCE, /facts: \{[\s\S]*?\n {24}\},/);
        expect(facts).toContain('Never mood, location, activity, appearance or clothing.');
    });

    test('the instruction tells the model to write in the narration\'s register and never invent', () => {
        const instruction = grab(SOURCE, /export function instruction\(\)[\s\S]*?\n}/);
        expect(instruction).toContain('same register the narration is written in');
        expect(instruction).toContain('Never invent any of it.');
    });

    // Per-pass, not static: `registerProbe`'s docblock has the measurement, one interpolated clause
    // in a 2,700-token instruction block costs the whole block's prefix cache every pass. A list of
    // names the player edits by hand is exactly such a clause.
    test('the flagged names ride the per-pass context hook, not the static instruction', () => {
        // Matched loosely on purpose. The first version pinned the exact parameter list, which broke
        // the moment `context` gained `at` (the scene's location, so the entities probe words a room
        // the same way the scene probe did). What this test is about is WHERE the flag list lives,
        // not the shape of the signature, pinning the latter makes every future parameter a failure.
        expect(SOURCE).toMatch(/export function context\(\{[^)]*poi = null/);
        const instruction = grab(SOURCE, /export function instruction\(\)[\s\S]*?\n}/);
        // "poi" is a substring of "point-of-view", which the instruction says several times. The
        // thing that must not be up there is the flagged-name clause itself.
        expect(instruction).not.toContain('People of interest');
        expect(grab(SOURCE, /export function context\([\s\S]*?\n}/))
            .toContain('People of interest, the player has asked for these characters in full');
    });

    test('the probe is wired to both hooks with the flag set injected', () => {
        const probe = grab(source('index.js'), /registerProbe\(\{\s*\n\s*schemaKey: 'entities'[\s\S]*?\n {4}\}\);/);
        expect(probe).toMatch(/context: \(\) => entities\.context\(\{[^)]*poi: new Set\(state\.poiKeys\(\)\)/);
        expect(probe).toContain('poi: new Set(state.poiKeys())');
    });
});

/*
 * The dossier tier on the HAND path.
 *
 * `foldEntity` clamps what the model proposes, and for a while that was the whole enforcement,
 * `entities.patch`, which is what the row editor writes through, took whatever string it was given.
 * The tier is not cosmetic: it is the only thing keeping the long form off 48 rows in a blob that is
 * 96% full on the largest live chat, where going over makes the store shed chronicle events.
 */
describe('the dossier tier holds against a hand edit, not only against the model', () => {
    test('an unflagged row cannot be given the flagged-only columns at all', () => {
        const out = clampDossierFields({ bearing: 'x'.repeat(500), history: 'y'.repeat(500) }, false);
        // Dropped, not emptied, `merge_entity` reads '' and absence identically, and an empty
        // string is bytes that buy nothing in a blob this close to its ceiling.
        expect(Object.hasOwn(out, 'bearing')).toBe(false);
        expect(Object.hasOwn(out, 'history')).toBe(false);
    });

    test('an unflagged row keeps look and wearing, clamped to the ordinary cap', () => {
        const out = clampDossierFields({ look: 'x'.repeat(500), wearing: 'y'.repeat(500) }, false);
        expect(out.look).toHaveLength(MAX_DETAIL);
        expect(out.wearing).toHaveLength(MAX_DETAIL);
    });

    test('a flagged row gets the dossier caps, and wearing stays half of them', () => {
        const out = clampDossierFields({
            look: 'x'.repeat(900), wearing: 'y'.repeat(900),
            bearing: 'z'.repeat(900), history: 'w'.repeat(900),
        }, true);
        expect(out.look).toHaveLength(MAX_DOSSIER);
        expect(out.bearing).toHaveLength(MAX_DOSSIER);
        expect(out.history).toHaveLength(MAX_DOSSIER);
        expect(out.wearing).toHaveLength(MAX_WEARING);
    });

    test('columns the tier says nothing about pass through untouched', () => {
        const out = clampDossierFields({ name: 'Martinez', facts: 'officer' }, false);
        expect(out).toEqual({ name: 'Martinez', facts: 'officer' });
    });

    // Read as source, not imported: `edit-form.js` pulls in the popup layer, which wants a DOM.
    test('the row editor offers the new columns, and facts no longer claims appearance', () => {
        const spec = grab(source('edit-form.js'), /export const CAST_FIELDS[\s\S]*?\n\]\);/);
        for (const column of ['look', 'wearing', 'bearing', 'history']) {
            expect(spec).toContain(`key: '${column}'`);
        }
        // The claim, not the word. The current hint says facts are true "regardless of appearance",
        // which mentions it in order to disclaim it, an earlier version of this test banned the
        // substring and failed on correct copy.
        const factsLine = spec.split('\n').find(line => line.includes('key: \'facts\''));
        expect(factsLine).not.toContain('appearance and standing truths');
        const lookLine = spec.split('\n').find(line => line.includes('key: \'look\''));
        expect(lookLine).toMatch(/build|features/i);
    });

    test('the writer passes the flag, or every hand edit would be treated as unflagged', () => {
        expect(source('edits.js')).toMatch(/entities\.patch\(key, wanted, \{ flagged: isPoi\(key\) \}\)/);
    });
});
