import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { castTerms, formsOf } from '../public/scripts/extensions/sanguine-gloss/cast-terms.js';

/*
 * Rows below are copied from the cast table of a completed Xianxia campaign. The three most
 * frequently un-glossed runs on screen were 池 (664x), 德 (664x) and 凌香 (200x), the player's own
 * name and his companion's. No dictionary contains those; the tracker already did.
 */
const CAST = {
    'a': { name: 'Chí Guāngdé', aka: '池光德', facts: 'Middle Nascent Soul cultivator', turn: 146 },
    'b': { name: '凌香', aka: 'Líng Xiāng, Ling Xiang, soaring fragrance, 凌香仙子', facts: 'ancient spirit in the jade pendant', turn: 145 },
    'c': { name: '钱管事', aka: 'Manager Qian, Qián Guǎnshì', facts: 'middle-aged appraiser', turn: 120 },
    'd': { name: 'clerk', aka: 'elderly clerk', facts: 'wears copper-rimmed spectacles', turn: 100 },
};

describe('cast terms, the story\'s own names become glossary entries', () => {
    test('the Han form is the term and the romanisation is the reading', () => {
        const terms = castTerms(CAST);
        assert.equal(terms['池光德'].say, 'Chí Guāngdé');
        assert.equal(terms['凌香'].say, 'Líng Xiāng');
    });

    test('it works whichever field holds which script', () => {
        // 池光德 has the Han in `aka`; 凌香 has it in `name`. Both must resolve.
        const a = formsOf({ name: 'Chí Guāngdé', aka: '池光德' });
        const b = formsOf({ name: '凌香', aka: 'Líng Xiāng' });
        assert.deepEqual(a.terms, ['池光德']);
        assert.deepEqual(a.readings, ['Chí Guāngdé']);
        assert.deepEqual(b.terms, ['凌香']);
        assert.deepEqual(b.readings, ['Líng Xiāng']);
    });

    test('a translated alternate becomes the meaning', () => {
        const terms = castTerms(CAST);
        assert.equal(terms['钱管事'].mean, 'Manager Qian');
        assert.equal(terms['钱管事'].say, 'Qián Guǎnshì');
    });

    test('every Han alias of one row is glossable, longest first', () => {
        const terms = castTerms(CAST);
        // 凌香仙子 is an alias in the same row and must not be shadowed by its own prefix 凌香.
        assert.ok(terms['凌香仙子']);
        assert.ok(terms['凌香']);
    });

    test('a row with no Han form contributes nothing, no inventing', () => {
        const terms = castTerms({ a: { name: 'clerk', aka: 'elderly clerk', turn: 1 } });
        assert.deepEqual(Object.keys(terms), []);
    });

    test('a non-CJK story produces an empty harvest', () => {
        assert.deepEqual(castTerms({ a: { name: 'Maria', aka: 'the widow', turn: 1 } }), {});
        assert.deepEqual(castTerms(null), {});
    });

    test('the cap keeps whoever the story touched most recently', () => {
        const terms = castTerms(CAST, 1);
        assert.deepEqual(Object.keys(terms), ['池光德']);
    });

    test('a Map is accepted as readily as a plain object', () => {
        const asMap = new Map(Object.entries(CAST));
        assert.ok(castTerms(asMap)['池光德']);
    });
});
