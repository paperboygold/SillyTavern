import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { CHAR_FLOOR } from '../public/scripts/extensions/sanguine-gloss/data/char-floor.js';
import { WUXIA_LEXICON } from '../public/scripts/extensions/sanguine-gloss/data/wuxia-lexicon.js';
import { getGlossEntry, rebuildActiveTrie, segmentAndGloss } from '../public/scripts/extensions/sanguine-gloss/lexicon.js';

const HAN = /\p{Script=Han}/u;

/*
 * Coverage as a property, not a percentage.
 *
 * Before this tier the gloss held 187 curated entries and, measured over a completed campaign,
 * reached 37.6% of the hanzi on screen and 134 of 1123 distinct characters. 989 characters could
 * never be hovered, including 池 and 德, the two halves of the player character's own name, which
 * appeared 664 times each.
 *
 * The fix is not a bigger pile of entries. `segmentText` emits plain text only when NOTHING matches
 * at a position, and the shortest possible match is a single character; once every character has an
 * entry the segmenter cannot fail. These gates pin that, so a future edit that drops the floor
 * fails here rather than silently returning the product to 37%.
 */
describe('the character floor, every ideograph resolves', () => {
    test('the floor is present and covers the BMP CJK block', () => {
        assert.ok(Object.keys(CHAR_FLOOR).length > 20000);
        // Spot checks across the range, including the two that motivated this.
        for (const ch of ['池', '德', '一', '龍', '龟', '中', '炁']) {
            assert.ok(CHAR_FLOOR[ch], `missing ${ch}`);
        }
    });

    test('every floor entry carries something worth showing', () => {
        for (const [ch, entry] of Object.entries(CHAR_FLOOR)) {
            assert.ok(entry.say || entry.mean, `${ch} has neither reading nor gloss`);
        }
    });

    test('segmentation cannot leave a Han character bare', () => {
        // The guarantee, stated as the property it is. Any Han character in any order.
        const sample = '池光德凌香赤焰居烈阳城修為龍龜炁氣一二三';
        for (const piece of segmentAndGloss(sample)) {
            if (HAN.test(piece.text)) {
                assert.equal(piece.type, 'gloss', `left bare: ${piece.text}`);
            }
        }
    });

    test('a character nobody curated still resolves', () => {
        // 龘 is not in any hand-written tier here; the floor is the only thing that can answer.
        const entry = getGlossEntry('龘');
        assert.ok(entry);
        assert.equal(entry.floor, true);
    });

    test('the floor never outranks a real word', () => {
        // Longest-match must still prefer a multi-character term. A floor hit is what happens when
        // nothing longer starts here, never a replacement for the curated tiers.
        //
        // Taken from the shipped lexicon rather than guessed: picking a character by hand got this
        // wrong once already (修 turned out to be curated, so the assertion tested nothing).
        const multi = Object.keys(WUXIA_LEXICON).find(term => [...term].length > 1);
        assert.ok(multi, 'the domain lexicon has no multi-character term to test with');
        const pieces = segmentAndGloss(multi);
        assert.equal(pieces.length, 1, `${multi} was split into components`);
        assert.equal(pieces[0].text, multi);
        assert.notEqual(pieces[0].entry?.floor, true);
    });

    test('floor entries are marked, so the renderer can keep the gold meaningful', () => {
        // Painting every character gold would replace a signal with wallpaper.
        assert.equal(getGlossEntry('龘').floor, true);
        // A curated entry is not marked.
        assert.notEqual(getGlossEntry('的')?.floor, true);
    });

    test('the floor can be turned off without breaking the other tiers', () => {
        rebuildActiveTrie({ enableFloor: false });
        const bare = segmentAndGloss('龘').some(p => p.type === 'text');
        assert.equal(bare, true);
        rebuildActiveTrie();
        assert.equal(segmentAndGloss('龘').every(p => p.type === 'gloss'), true);
    });

    test('non-Han text is untouched', () => {
        const pieces = segmentAndGloss('Chí Guāngdé walked in.');
        assert.equal(pieces.every(p => p.type === 'text'), true);
    });
});
