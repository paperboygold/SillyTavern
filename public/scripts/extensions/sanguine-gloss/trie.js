/**
 * sanguine-gloss/trie.js — Prefix tree (Trie) for longest-match Hanzi & compound segmentation.
 *
 * Scans continuous Chinese prose in O(N) time and greedily extracts the longest matching
 * compound words or single characters against the loaded glossary tiers.
 *
 * Zero dependencies, pure ESM.
 */

import { insert_with, lookup, merge_b } from './lib/hash.js';

/**
 * Creates an empty Trie node.
 * @returns {object} A fresh Trie root/node.
 */
export function createTrieNode() {
    return {
        /** @type {Map<string, object>} */
        next: new Map(),
        /** @type {object|null} */
        entry: null,
    };
}

/**
 * Inserts a phrase or character into the Trie with its glossary payload.
 * @param {object} root The Trie root node.
 * @param {string} phrase The Chinese string (e.g. '金丹').
 * @param {object} entry The glossary payload { say, mean, more, ... }.
 */
export function insertTrie(root, phrase, entry) {
    if (!phrase || typeof phrase !== 'string') return;
    let node = root;
    for (let i = 0; i < phrase.length; i++) {
        const char = phrase[i];
        let nextNode = lookup(node.next, char);
        if (!nextNode) {
            nextNode = createTrieNode();
            insert_with(node.next, merge_b, char, nextNode);
        }
        node = nextNode;
    }
    node.entry = entry;
}

/**
 * Finds the longest matching phrase in the Trie starting at `startIndex` of `text`.
 * @param {object} root The Trie root.
 * @param {string} text The full text string.
 * @param {number} startIndex Index to start scanning from.
 * @returns {{ phrase: string, entry: object, length: number } | null}
 */
export function findLongestMatch(root, text, startIndex = 0) {
    let node = root;
    let longestMatch = null;
    let currentLength = 0;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        const nextNode = lookup(node.next, char);
        if (!nextNode) {
            break;
        }
        currentLength++;
        node = nextNode;
        if (node.entry) {
            longestMatch = {
                phrase: text.slice(startIndex, startIndex + currentLength),
                entry: node.entry,
                length: currentLength,
            };
        }
    }

    return longestMatch;
}

/**
 * Regular expression matching CJK Unified Ideographs & Extension A/B.
 */
export const CJK_CHAR_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/**
 * Segments a string of text into an array of gloss tokens and plain text tokens.
 * @param {object} root The Trie root populated with glossary terms.
 * @param {string} text The input text to segment.
 * @returns {Array<{ type: 'gloss'|'text', text: string, entry?: object }>}
 */
export function segmentText(root, text) {
    if (!text) return [];
    const tokens = [];
    let i = 0;
    let plainBuffer = '';

    while (i < text.length) {
        const match = findLongestMatch(root, text, i);
        if (match) {
            if (plainBuffer.length > 0) {
                tokens.push({ type: 'text', text: plainBuffer });
                plainBuffer = '';
            }
            tokens.push({
                type: 'gloss',
                text: match.phrase,
                entry: match.entry,
            });
            i += match.length;
        } else {
            plainBuffer += text[i];
            i++;
        }
    }

    if (plainBuffer.length > 0) {
        tokens.push({ type: 'text', text: plainBuffer });
    }

    return tokens;
}
