/**
 * sanguine-gloss/lexicon.js — Three-Tier Glossary Resolution Engine.
 *
 * Three tiers of context, mirroring sanguinehost.com's `glossEntry(term, ctx)`:
 *   - Tier 1: Scene & Card Context (Active Lorebook / Character Card / Custom User Terms)
 *   - Tier 2: Wuxia & Xianxia Cultivation Domain Lexicon
 *   - Tier 3: General Chinese Vocabulary & Component Ideographs
 *
 * One structure (the K -> V table), one operation (`insert_with`), and `merge_b` for lookup.
 */

import { insert_with, lookup, merge_b } from './lib/hash.js';
import { createTrieNode, insertTrie, segmentText } from './trie.js';
import { WUXIA_LEXICON } from './data/wuxia-lexicon.js';
import { COMMON_LEXICON } from './data/common-lexicon.js';

/** @type {Map<string, object>} */
const tier1Context = new Map();

/** @type {Map<string, object>} */
const tier2Domain = new Map();

/** @type {Map<string, object>} */
const tier3Common = new Map();

/** @type {object} */
let activeTrie = createTrieNode();

/**
 * Initialize base lexicons into their respective Map tables.
 */
function initBaseLexicons() {
    for (const [term, entry] of Object.entries(WUXIA_LEXICON)) {
        insert_with(tier2Domain, merge_b, term, entry);
    }
    for (const [term, entry] of Object.entries(COMMON_LEXICON)) {
        insert_with(tier3Common, merge_b, term, entry);
    }
}
initBaseLexicons();

/**
 * Resolves a glossary term across the three tiers in order.
 * @param {string} term The Chinese term or character.
 * @returns {object|null} The resolved entry { say, mean, more } or null.
 */
export function getGlossEntry(term) {
    if (!term) return null;
    return lookup(tier1Context, term)
        || lookup(tier2Domain, term)
        || lookup(tier3Common, term)
        || null;
}

/**
 * Register a context-specific or user-defined term (Tier 1).
 * @param {string} term The Hanzi term.
 * @param {{ say?: string, mean: string, more?: string }} entry The gloss entry.
 */
export function registerContextTerm(term, entry) {
    if (!term || !entry) return;
    insert_with(tier1Context, merge_b, term, entry);
    insertTrie(activeTrie, term, entry);
}

/**
 * Register a batch of context terms (e.g. from Lorebook entries or character card).
 * @param {Record<string, { say?: string, mean: string, more?: string }>} entries
 */
export function registerBatchContext(entries) {
    if (!entries || typeof entries !== 'object') return;
    for (const [term, entry] of Object.entries(entries)) {
        registerContextTerm(term, entry);
    }
}

/**
 * Clear the ephemeral context tier (e.g., when changing chats).
 */
export function clearContextTerms() {
    tier1Context.clear();
    rebuildActiveTrie();
}

/**
 * Rebuilds the search Trie from the active tiers according to extension options.
 * @param {object} [options]
 * @param {boolean} [options.enableWuxia] Whether to include Tier 2 Wuxia lexicon (default true).
 * @param {boolean} [options.enableCommon] Whether to include Tier 3 Common lexicon (default true).
 * @param {Map<string, object>|Record<string, object>} [options.customTerms] User custom dictionary terms.
 */
export function rebuildActiveTrie({ enableWuxia = true, enableCommon = true, customTerms = null } = {}) {
    const root = createTrieNode();

    // 1. Tier 3: Common Chinese words (Lowest priority)
    if (enableCommon) {
        for (const [term, entry] of tier3Common.entries()) {
            insertTrie(root, term, entry);
        }
    }

    // 2. Tier 2: Wuxia & Xianxia domain terms (Overrides common)
    if (enableWuxia) {
        for (const [term, entry] of tier2Domain.entries()) {
            insertTrie(root, term, entry);
        }
    }

    // 3. User custom terms from settings
    if (customTerms) {
        const iterable = customTerms instanceof Map ? customTerms.entries() : Object.entries(customTerms);
        for (const [term, entry] of iterable) {
            insertTrie(root, term, entry);
        }
    }

    // 4. Tier 1: Chat / Card active context (Highest priority)
    for (const [term, entry] of tier1Context.entries()) {
        insertTrie(root, term, entry);
    }

    activeTrie = root;
}

// Initial build
rebuildActiveTrie();

/**
 * Segments and glosses a text string using the current active Trie.
 * @param {string} text Input text.
 * @returns {Array<{ type: 'gloss'|'text', text: string, entry?: object }>}
 */
export function segmentAndGloss(text) {
    return segmentText(activeTrie, text);
}

/**
 * Access the active trie root directly.
 * @returns {object}
 */
export function getActiveTrie() {
    return activeTrie;
}
