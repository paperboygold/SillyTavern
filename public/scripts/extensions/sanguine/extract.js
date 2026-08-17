/**
 * fold/extract.js — the shared extraction pass.
 *
 * One LLM call per cycle serves every probe. Chronicle registers one probe; a later state probe
 * registers another. Two calls would double latency and cost for the same narrative window, and
 * the model is being asked to read that window either way.
 *
 * The pass is fire-and-forget: it never blocks a reply. That means it can finish after the user
 * has swiped, edited, or changed chat entirely, so results are re-validated against the live
 * chat before anything is written.
 */

import { chat, generateRaw, getCurrentChatId } from '../../../script.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { contentKey, liveHashes } from './chronicle.js';
import { analyzeExtraction } from './json-parse.js';

/** @type {Array<{schemaKey: string, schema: () => object, instruction: () => string, apply: Function}>} */
const probes = [];

let busy = false;

/**
 * Register a probe in the shared extraction call.
 * @param {object} probe The probe.
 * @param {string} probe.schemaKey Property name for this probe's fragment.
 * @param {() => object} probe.schema Returns a JSON Schema fragment.
 * @param {() => string} probe.instruction Returns prompt guidance for this probe.
 * @param {(fragment: any, context: object) => any} probe.apply Applies the fragment.
 */
export function registerProbe(probe) {
    probes.push(probe);
}

/** @returns {boolean} Whether an extraction is in flight. */
export function isExtracting() {
    return busy;
}

/**
 * Build the JSON schema covering every registered probe.
 *
 * Probe fragments must satisfy OpenAI's strict structured-output rules, which apply to EVERY
 * object in the schema and not just the root: each needs `additionalProperties: false` and every
 * property listed in `required`. A fragment that omits either fails the whole request with a 400,
 * taking the other probes down with it.
 *
 * @returns {object} A JSON Schema object.
 */
function buildSchema() {
    const properties = {};
    for (const probe of probes) {
        properties[probe.schemaKey] = probe.schema();
    }
    return {
        name: 'fold_extract',
        strict: true,
        // Deliberately true: with `false`, SillyTavern replaces anything it cannot parse with the
        // string "{}" before we see it, discarding output that our own parser could still recover
        // (a fenced block, or an object wrapped in a preamble). Taking the raw text and running
        // parseLooseJson over it recovers those, and genuinely unusable output still ends up as
        // null, which abandons the cycle exactly as before.
        returnInvalid: true,
        value: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
    };
}

/**
 * The window of recent messages to extract from, with their content keys.
 * @param {number} size How many trailing messages to include.
 * @returns {{text: string, sources: Array<{key: string, mid: number}>}} The window.
 */
export function buildWindow(size) {
    const messages = (chat ?? [])
        .map((message, mid) => ({ message, mid }))
        .filter(({ message }) => message?.mes && !message.is_system)
        .slice(-Math.max(1, size));

    return {
        text: messages.map(({ message }) => `${message.name ?? 'Unknown'}: ${message.mes}`).join('\n\n'),
        sources: messages.map(({ message, mid }) => ({ key: contentKey(message.mes), mid })),
    };
}

const SYSTEM_PROMPT = [
    'You are a narrative archivist. You read a transcript excerpt and return structured JSON.',
    'You never write prose, never address the user, and never invent facts that are not in the excerpt.',
].join(' ');

/**
 * Send the extraction request, either through a dedicated connection profile or through the
 * chat's own model.
 *
 * Extraction is a mechanical summarization job, so running it on whatever large model the user
 * chose for roleplay is a waste of money and latency. A connection profile lets it run on
 * something small and cheap while the conversation keeps its own model.
 *
 * @param {object} params Parameters.
 * @param {string} params.prompt The user-role prompt.
 * @param {number} params.responseLength Token budget.
 * @param {object} params.schema The JSON schema.
 * @param {string} [params.profileId] Connection profile to use; falls back to the chat's model.
 * @returns {Promise<any>} Raw result: a string, or already-parsed content.
 */
async function requestExtraction({ prompt, responseLength, schema, profileId }) {
    if (!profileId) {
        return await generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength, jsonSchema: schema });
    }

    const result = await ConnectionManagerRequestService.sendRequest(
        profileId,
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt },
        ],
        responseLength,
        {
            extractData: true,
            // Deliberately not inheriting the profile's presets. Extraction wants low variance and
            // no instruct wrapping; the schema does the shaping. A roleplay preset's temperature
            // and penalties actively work against structured output.
            includePreset: false,
            includeInstruct: false,
        },
        { json_schema: schema },
    );

    return result?.content;
}

/**
 * Run one extraction cycle.
 * @param {object} [options] Options.
 * @param {number} [options.windowSize] Trailing messages to read.
 * @param {number} [options.responseLength] Token budget for the reply.
 * @param {string} [options.profileId] Connection profile to run extraction on.
 * @returns {Promise<{ok: boolean, reason?: string, results?: object}>} Outcome.
 */
export async function runExtraction({ windowSize = 6, responseLength = 800, profileId = '' } = {}) {
    if (busy) {
        return { ok: false, reason: 'busy' };
    }
    if (!probes.length) {
        return { ok: false, reason: 'no probes registered' };
    }

    const chatIdAtStart = getCurrentChatId();
    const window = buildWindow(windowSize);
    if (!window.sources.length) {
        return { ok: false, reason: 'empty window' };
    }

    busy = true;
    try {
        const instructions = probes.map(p => `- ${p.schemaKey}: ${p.instruction()}`).join('\n');
        const prompt = [
            'Transcript excerpt:',
            '---',
            window.text,
            '---',
            '',
            'Extract the following:',
            instructions,
            '',
            'Respond with JSON only.',
        ].join('\n');

        const schema = buildSchema();
        let analysis = analyzeExtraction(await requestExtraction({ prompt, responseLength, schema, profileId }));

        // Truncated is a different failure from garbage, and the only one worth retrying: the
        // model ran out of budget mid-structure rather than refusing or rambling. Thinking models
        // hit this routinely, spending the allowance on reasoning before emitting any JSON.
        if (!analysis.value && analysis.truncated) {
            console.debug('[fold] extraction was cut off mid-structure; retrying with a larger budget');
            analysis = analyzeExtraction(await requestExtraction({
                prompt,
                responseLength: responseLength * 2,
                schema,
                profileId,
            }));
        }

        const parsed = analysis.value;
        if (!parsed) {
            console.warn('[fold] extraction produced no usable JSON; abandoning this cycle');
            return { ok: false, reason: analysis.truncated ? 'truncated' : 'unparseable' };
        }

        // The call is async and unblocking, so the world may have moved. Applying results from a
        // different chat, or from a swipe the user has since navigated away from, would write
        // history that never happened on this branch.
        if (getCurrentChatId() !== chatIdAtStart) {
            return { ok: false, reason: 'chat changed' };
        }
        const live = liveHashes();
        const sources = window.sources.filter(source => live.get(source.key));
        if (!sources.length) {
            return { ok: false, reason: 'sources no longer live' };
        }

        const results = {};
        const now = Date.now();
        for (const probe of probes) {
            try {
                // windowText is what the state probe's mention gate checks against: a model
                // cannot invent a change to something the excerpt never mentions.
                results[probe.schemaKey] = probe.apply(parsed[probe.schemaKey], { sources, now, windowText: window.text });
            } catch (error) {
                console.error(`[fold] probe "${probe.schemaKey}" failed to apply`, error);
            }
        }
        return { ok: true, results };
    } catch (error) {
        console.error('[fold] extraction failed', error);
        return { ok: false, reason: String(error?.message ?? error) };
    } finally {
        busy = false;
    }
}
