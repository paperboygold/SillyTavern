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
import * as entities from './entities.js';
import { splitWindow } from './extract-table.js';
import { analyzeExtraction } from './json-parse.js';
import * as observe from './observe.js';
import { extractMark, ledgerBlock, noteExtracted, noteExtractedWindow } from './state.js';
import { takePendingCost } from './verdict.js';

/**
 * How much bigger the retry's budget is than the first attempt's.
 *
 * Doubling is not enough when the shortfall is reasoning rather than output: a model that spent its
 * entire allowance thinking will spend twice as much thinking too, and the retry fails identically.
 * Tripling clears the reasoning and leaves room for the answer.
 */
export const RETRY_GROWTH = 3;

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
 * The window of recent messages to extract from, split at the high-water mark.
 *
 * The reading of the chat lives here; the splitting rule lives in `extract-table.js`, where it is
 * pure and testable and carries the argument for itself.
 *
 * @param {number} size How many trailing messages to include.
 * @param {{mid: number, key: string}} [mark] The persisted high-water mark.
 * @returns {{text: string, newText: string, sources: Array<{key: string, mid: number}>,
 *   context: number, mark: number|null}} The window.
 */
export function buildWindow(size, mark = {}) {
    const messages = (chat ?? [])
        .map((message, mid) => ({ message, mid }))
        .filter(({ message }) => message?.mes && !message.is_system)
        .map(({ message, mid }) => ({ mid, key: contentKey(message.mes), name: message.name ?? 'Unknown', text: message.mes }));

    return splitWindow(messages, { size, mark });
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
 * @param {string} [options.why] The reason this pass ran — arms the world fragment on a time skip.
 * @returns {Promise<{ok: boolean, reason?: string, results?: object}>} Outcome.
 */
export async function runExtraction({ windowSize = 6, responseLength = 800, profileId = '', why = '' } = {}) {
    // ── Every outcome is recorded, including the ones that are not errors ──
    //
    // A chat ran to 74 turns with zero extracted events and NOTHING in the data said why. The pass
    // has half a dozen ways to decline — busy, empty window, unparseable reply, a chat that changed
    // underneath it — and each returned a reason string that went straight to a caller with no
    // `else`. So a subsystem that never succeeded was indistinguishable from one that was never
    // asked, and two rounds of diagnosis were spent inferring from absence.
    //
    // The bounds have had this since observe.js existed. The pass itself did not.
    const outcome = (reason) => {
        observe.note(`extract:${reason}`);
        return { ok: false, reason };
    };

    if (busy) {
        return outcome('busy');
    }
    if (!probes.length) {
        return outcome('no-probes');
    }

    const chatIdAtStart = getCurrentChatId();
    // Stamp the auto-cadence so a MANUAL extraction (the "Extract Now" button, the calibrate tool)
    // also resets it — otherwise the very next reply sees `turnsSinceExtract` at the ceiling and
    // fires a duplicate automatic pass. The auto path already stamps before calling, so this is a
    // no-op there; it is the missing half for every other caller.
    noteExtracted();
    const window = buildWindow(windowSize, extractMark());
    if (!window.sources.length) {
        // Distinct from `empty-window`, and the distinction is the whole point of the split: an
        // empty chat and a chat where nothing has been said since the last look are different
        // facts with different remedies, and a pass that runs on nothing but context would
        // re-propose everything in it.
        return outcome(window.context ? 'nothing-new' : 'empty-window');
    }

    busy = true;
    try {
        const instructions = probes.map(p => `- ${p.schemaKey}: ${p.instruction()}`).join('\n');
        // ── The ledger is pinned, not retrieved ──
        //
        // Everything fold believes fits in a screenful by design (`FOLD-REDESIGN.md` §1), so the
        // model can simply be shown it. That is what makes "report only changes" an instruction it
        // can follow rather than a hope: a model shown "Carrying: kang's phone number" has no
        // reason to propose gaining it a third time, which is exactly what happened at mids 50, 52
        // and 54 of the live chat when it was shown nothing.
        const ledger = ledgerBlock({ windowText: window.newText });
        // ── The adjudicator's COST, written back ──
        //
        // A COST verdict from last turn left a pending note (`verdict.js` `notePendingCost`); it is
        // taken here — read and cleared — and the extractor is told to record what the cost consumed
        // as a delta. This is the loop §6 closes: the concrete cost the judge imposed no longer has
        // to happen to survive the narrator's prose into re-extraction.
        const pendingCost = takePendingCost();
        const prompt = [
            'Transcript excerpt:',
            '---',
            window.text,
            '---',
            '',
            ...(ledger.text ? ['Already recorded — report only CHANGES to this, never restate it:', ledger.text, ''] : []),
            'Extract the following:',
            instructions,
            ...(pendingCost ? ['', `Note: the last attempt succeeded at a cost — ${pendingCost}. Record what it cost as a delta (money, an item, a mark) in the events below.`] : []),
            '',
            'Respond with JSON only.',
        ].join('\n');

        const schema = buildSchema();
        let analysis = analyzeExtraction(await requestExtraction({ prompt, responseLength, schema, profileId }));

        // Budget failures are a different thing from garbage, and the only ones worth retrying: the
        // model ran out of allowance rather than refusing or rambling. Thinking models hit this
        // routinely, spending the whole budget on reasoning before emitting any JSON.
        //
        // `empty` belongs here alongside `truncated`, and leaving it out cost a chat every one of
        // its extractions. Reasoning tokens are charged against the same `max_tokens` as the answer,
        // so an under-budgeted reasoning model does not return a half-written object — it returns
        // nothing at all, which has no unterminated structure for `looksTruncated` to find. Measured
        // on a real chat: `extract:unparseable` 6, `extract:ok` 3, and a second chat that was 2 for 2
        // failures with the panel never updating once. The retry existed and could not fire.
        if (!analysis.value && (analysis.truncated || analysis.empty)) {
            console.debug(`[fold] extraction came back ${analysis.empty ? 'empty' : 'cut off'}; retrying with a larger budget`);
            observe.note(`extract:retry-${analysis.empty ? 'empty' : 'truncated'}`);
            analysis = analyzeExtraction(await requestExtraction({
                prompt,
                responseLength: responseLength * RETRY_GROWTH,
                schema,
                profileId,
            }));
        }

        const parsed = analysis.value;
        if (!parsed) {
            console.warn('[fold] extraction produced no usable JSON; abandoning this cycle');
            // Three distinct failures, counted separately. They have different remedies — raise the
            // budget, change the model, fix the prompt — and one bucket cannot tell you which.
            return outcome(analysis.empty ? 'empty' : analysis.truncated ? 'truncated' : 'unparseable');
        }

        // The call is async and unblocking, so the world may have moved. Applying results from a
        // different chat, or from a swipe the user has since navigated away from, would write
        // history that never happened on this branch.
        if (getCurrentChatId() !== chatIdAtStart) {
            return outcome('chat-changed');
        }
        const live = liveHashes();
        const sources = window.sources.filter(source => live.get(source.key));
        if (!sources.length) {
            return outcome('sources-not-live');
        }

        const results = {};
        const now = Date.now();
        // The newest message this pass actually read and that is still live on this branch. Written
        // after the probes have applied, so a pass that dies partway never claims to have read
        // anything — the mark is the one piece of fold's state that, set wrongly, causes messages
        // to be silently skipped forever.
        const read = sources[sources.length - 1];
        // ── One tick per pass, read by every probe ──
        //
        // This counter used to be advanced inside `entities.applyExtraction`, which made it the
        // entity probe's private business. Every probe registered before it therefore stamped its
        // records with the PREVIOUS tick while the entity probe stamped the next one — so a clock
        // that had just advanced read as a turn stale, and anything asking "did this change this
        // turn?" got the wrong answer for three of the four probes. A shared clock belongs to the
        // pass, not to whichever probe happens to own the storage.
        const turn = entities.advanceTurn();
        for (const probe of probes) {
            try {
                // windowText is what the state probe's mention gate checks against: a model
                // cannot invent a change to something the excerpt never mentions.
                // windowText is the NEW half only. It is what the state probe's mention gate checks
                // against (`isMentioned`, `state-table.js`), and the gate has to agree with the
                // billing rule: if a beat narrated only in the context half cannot be recorded,
                // then the excerpt that licenses a change must be the same half that may anchor it.
                results[probe.schemaKey] = probe.apply(parsed[probe.schemaKey], {
                    sources,
                    now,
                    turn,
                    windowText: window.newText,
                    shown: ledger.shown,
                    // The id index the pinned block built this pass. Threaded for `shown`'s exact
                    // reason: an answer is about a line the model was shown, and only the caller
                    // that built the prompt knows which lines those were or what ids they carried.
                    review: ledger.review,
                    // The reason this pass ran, so the world fragment can arm only on a declared
                    // elapse or scene break (FOLD-REDESIGN.md §7.4). One definition of those reasons
                    // lives in `trigger-table.js` `WORLD_TRIGGERS`; `world.js` imports it.
                    why,
                });
            } catch (error) {
                console.error(`[fold] probe "${probe.schemaKey}" failed to apply`, error);
            }
        }
        // Succeeding and producing nothing are different facts. A model that reads six messages and
        // finds no event of consequence is behaving correctly; one that never returns anything is
        // not, and only the counts can tell them apart.
        observe.note(results?.events?.added ? 'extract:ok' : 'extract:no-events');
        // Success includes "read six messages, found nothing worth recording". That is the case the
        // mark most needs to cover: re-reading a quiet stretch on the next pass is how a window
        // comes to be read three times, and the model declining to re-report it is the behaviour
        // that shows up as `extract:delta-empty` rather than as a saving.
        noteExtractedWindow(read);
        return { ok: true, results };
    } catch (error) {
        console.error('[fold] extraction failed', error);
        observe.note('extract:error');
        return { ok: false, reason: String(error?.message ?? error) };
    } finally {
        busy = false;
    }
}
