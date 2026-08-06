/**
 * fold/recall.js — fusing every retrieval source into one ranked evidence block.
 *
 * SillyTavern already retrieves from several places, but they never meet: World Info scans
 * keywords and injects at its own depth, the vectors extension runs a similarity query and
 * injects at another, the summarize extension injects a third block. Three budgets, three
 * injections, no cross-ranking, and guaranteed duplication when the same fact lives in a lorebook
 * entry *and* the vector store. This module fuses what it can and suppresses what it cannot.
 *
 * ⚠ NEVER CALL `checkWorldInfo` FROM HERE. `WorldInfoBuffer.resetExternalEffects()` inside it is
 * not guarded by the dry-run flag, so an extra call silently wipes `externalActivations` and kills
 * the vectors extension's World Info force-activation for the real scan that follows. Activated
 * entries come from the WORLD_INFO_ACTIVATED event instead, which is emitted for the real scan.
 */

import { getCurrentChatId, substituteParams } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { getStringHash } from '../../utils.js';
import * as chronicle from './chronicle.js';
import { fuse, rankFused, renderEvidence, selectEvidence } from './recall-table.js';

/** Relative trust per source, feeding the RRF weight. */
export const SOURCE_WEIGHTS = {
    chronicle: 1.0,
    vectors: 1.0,
};

/** Text of World Info entries activated for this generation, refreshed per scan. */
let coveredTexts = [];

/**
 * Record what World Info is about to put in the prompt.
 *
 * Activated entries are already going to be shown to the model, so fold's job is not to rank them
 * — it is to avoid paying tokens to repeat them. Constant entries are skipped: they are
 * unconditional by author intent and say nothing about this turn's topic.
 *
 * @param {Array<object>} entries Activated World Info entries.
 */
export function noteActivatedWorldInfo(entries) {
    coveredTexts = (Array.isArray(entries) ? entries : [])
        .filter(entry => entry && !entry.constant)
        .map(entry => String(entry.content ?? ''))
        .filter(Boolean);
}

/** Forget the covered set, e.g. on chat change. */
export function clearActivatedWorldInfo() {
    coveredTexts = [];
}

/**
 * Query the vector store for related chat messages.
 *
 * Routed through `/api/vector/query-multi` rather than `/query`, because the single-collection
 * route builds `hashes` from the unfiltered result set while building `metadata` from the
 * threshold-filtered one — the two are not index-aligned, and `score_threshold` silently does
 * nothing. The multi route filters before grouping, so it is correct.
 *
 * @param {string} queryText Query text.
 * @param {number} topK Maximum hits.
 * @returns {Promise<string[]>} Content keys in rank order.
 */
export async function queryVectors(queryText, topK) {
    const vectorSettings = extension_settings.vectors;
    if (!vectorSettings?.enabled_chats) {
        return [];
    }

    const chatId = getCurrentChatId();
    if (!chatId) {
        return [];
    }

    try {
        const { queryMultipleCollections } = await import('../vectors/index.js');
        const results = await queryMultipleCollections([String(chatId)], queryText, topK);
        const hashes = results?.[String(chatId)]?.hashes ?? [];
        // The vectors extension hashes message text the same way, so these keys line up with
        // chronicle event anchors and cross-source dedup works.
        return hashes.map(String);
    } catch (error) {
        console.warn('[fold] vector query failed; continuing without it', error);
        return [];
    }
}

/**
 * Gather evidence from every source, fuse it, and render one block.
 *
 * @param {object} params Parameters.
 * @param {object[]} params.messages The chat, as handed to the generation interceptor.
 * @param {string} params.queryText Text to retrieve against.
 * @param {number} params.budget Token budget for the block.
 * @param {number} [params.topK] Per-source retrieval depth.
 * @param {string} [params.template] Render template.
 * @returns {Promise<{text: string, items: object[], tokens: number, skipped: object}>} The block.
 */
export async function gather({ messages, queryText, budget, topK = 5, template }) {
    /** @type {Map<string, {text: string, anchor?: string, source: string}>} */
    const meta = new Map();

    // Chronicle: already branch-filtered and ranked by keyword overlap.
    const events = chronicle.query(queryText, topK);
    for (const { key, event } of events) {
        meta.set(`evt:${key}`, {
            text: event.s,
            // The anchor is the content key of the message this was extracted from, which is
            // exactly the key a vector hit on that message carries. That is what lets the two
            // recognise each other as one piece of evidence.
            anchor: `msg:${event.k ?? key}`,
            source: 'chronicle',
        });
    }

    // Vectors: past chat messages, rank-only.
    const vectorKeys = await queryVectors(queryText, topK);
    const byHash = new Map();
    for (const message of messages ?? []) {
        if (!message?.mes) continue;
        byHash.set(String(getStringHash(substituteParams(message.mes))), message);
    }
    const usableVectorKeys = [];
    for (const hash of vectorKeys) {
        const message = byHash.get(hash);
        if (!message) continue;
        const key = `msg:${hash}`;
        meta.set(key, {
            text: `${message.name ?? ''}: ${message.mes}`.trim(),
            anchor: key,
            source: 'vectors',
        });
        usableVectorKeys.push(key);
    }

    const fused = fuse([
        { keys: events.map(e => `evt:${e.key}`), weight: SOURCE_WEIGHTS.chronicle },
        { keys: usableVectorKeys, weight: SOURCE_WEIGHTS.vectors },
    ]);

    const ranked = rankFused(fused);

    // Token counting is async in SillyTavern, so cost every candidate up front and hand the
    // selector a synchronous lookup — that keeps the selection logic pure and testable.
    const costs = new Map();
    await Promise.all(ranked.map(async ({ key }) => {
        const text = meta.get(key)?.text;
        if (text) {
            costs.set(key, await getTokenCountAsync(text));
        }
    }));

    const plan = { ranked, meta, costs, budget, template };
    return { ...select(plan), plan };
}

/**
 * Run the selection step of an existing plan against the current covered set.
 *
 * Split out from `gather` because of an ordering problem: generation interceptors run before the
 * World Info scan, so at injection time the covered set is a turn stale. Re-selecting when
 * WORLD_INFO_ACTIVATED fires fixes that without repeating the vector query — retrieval and
 * scoring are already done, only the filtering changes.
 *
 * @param {object} plan A plan from gather().
 * @returns {{text: string, items: object[], tokens: number, skipped: object}} The block.
 */
export function select({ ranked, meta, costs, budget, template }) {
    const selection = selectEvidence({
        ranked,
        meta,
        covered: coveredTexts,
        budget,
        // Roughly four characters per token is the fallback when counting failed for an item.
        costOf: (key, text) => costs.get(key) ?? Math.ceil(text.length / 4),
    });

    return {
        text: renderEvidence(selection.items, template),
        items: selection.items,
        tokens: selection.tokens,
        skipped: selection.skipped,
    };
}
