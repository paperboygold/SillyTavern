import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createTrieNode,
    findLongestMatch,
    insertTrie,
    segmentText,
} from '../public/scripts/extensions/sanguine-gloss/trie.js';

describe('sanguine-gloss trie — longest match tokenizer', () => {
    test('inserts and finds single character and multi-character matches', () => {
        const root = createTrieNode();
        insertTrie(root, '金', { say: 'jīn', mean: 'gold' });
        insertTrie(root, '金丹', { say: 'jīn dān', mean: 'Golden Core' });
        insertTrie(root, '金丹期', { say: 'jīn dān qī', mean: 'Golden Core Stage' });

        const match1 = findLongestMatch(root, '金丹期修士', 0);
        assert.ok(match1);
        assert.equal(match1.phrase, '金丹期');
        assert.equal(match1.entry.mean, 'Golden Core Stage');
        assert.equal(match1.length, 3);

        const match2 = findLongestMatch(root, '金丹大圆满', 0);
        assert.ok(match2);
        assert.equal(match2.phrase, '金丹');
        assert.equal(match2.entry.mean, 'Golden Core');

        const match3 = findLongestMatch(root, '金光闪闪', 0);
        assert.ok(match3);
        assert.equal(match3.phrase, '金');
        assert.equal(match3.entry.mean, 'gold');
    });

    test('segments mixed Chinese and English text preserving plain spans', () => {
        const root = createTrieNode();
        insertTrie(root, '筑基', { say: 'zhù jī', mean: 'Foundation Establishment' });
        insertTrie(root, '灵气', { say: 'líng qì', mean: 'Spiritual Qi' });

        const text = 'At the edge of the forest, the 筑基 cultivator absorbed 灵气 rapidly.';
        const tokens = segmentText(root, text);

        assert.equal(tokens.length, 5);
        assert.deepEqual(tokens[0], { type: 'text', text: 'At the edge of the forest, the ' });
        assert.equal(tokens[1].type, 'gloss');
        assert.equal(tokens[1].text, '筑基');
        assert.equal(tokens[1].entry.mean, 'Foundation Establishment');
        assert.deepEqual(tokens[2], { type: 'text', text: ' cultivator absorbed ' });
        assert.equal(tokens[3].type, 'gloss');
        assert.equal(tokens[3].text, '灵气');
        assert.deepEqual(tokens[4], { type: 'text', text: ' rapidly.' });
    });

    test('handles empty text and non-matching text safely', () => {
        const root = createTrieNode();
        insertTrie(root, '丹田', { say: 'dān tián', mean: 'Dantian' });

        assert.deepEqual(segmentText(root, ''), []);
        assert.deepEqual(segmentText(root, 'Hello world!'), [{ type: 'text', text: 'Hello world!' }]);
    });
});
