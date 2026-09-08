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
import { CHAR_FLOOR } from './data/char-floor.js';

/** @type {Map<string, object>} */
const tier1Context = new Map();

/** @type {Map<string, object>} */
const tier2Domain = new Map();

/** @type {Map<string, object>} */
const tier3Common = new Map();

/**
 * Tier 4: every ideograph, from Unicode's own data.
 *
 * ── The tier that makes coverage a property rather than a percentage ──
 *
 * The three tiers above hold what somebody curated. Measured against a completed campaign that was
 * 187 entries reaching 37.6% of the hanzi on screen, and 134 of 1123 distinct characters — 989
 * characters had no hover at all, including both halves of the player character's own name.
 *
 * This tier is not "more entries". `segmentText` emits plain text only when NOTHING matches at a
 * position, and the shortest possible match is one character; once every character is present the
 * segmenter cannot fail to match. That is the same move as making an unrooted world move
 * unsayable: close the class by construction instead of chasing its tail.
 *
 * Entries carry `floor: true` so the renderer can mark them quietly. A gloss that paints every
 * character gold has not improved reading — it has replaced a signal with wallpaper.
 */
const tier4Floor = new Map();

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
    for (const [term, entry] of Object.entries(CHAR_FLOOR)) {
        insert_with(tier4Floor, merge_b, term, { ...entry, floor: true });
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
        || lookup(tier4Floor, term)
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
export function rebuildActiveTrie({ enableWuxia = true, enableCommon = true, enableFloor = true, customTerms = null } = {}) {
    const root = createTrieNode();

    // 0. Tier 4: the per-character floor (lowest priority of all). Inserted first so every richer
    // tier overrides it, and so longest-match still prefers a real word over its component
    // characters — a single char only wins when nothing longer starts there.
    if (enableFloor) {
        for (const [term, entry] of tier4Floor.entries()) {
            insertTrie(root, term, entry);
        }
    }

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
