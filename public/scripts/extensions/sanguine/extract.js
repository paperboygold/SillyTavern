/**
 * fold/extract.js: the shared extraction pass.
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
import { oai_settings } from '../../openai.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { contentKey, liveEvents, liveHashes } from './chronicle.js';
import * as entities from './entities.js';
import {
    BACKFILL_CHUNK,
    backfillStamp,
    chunkRead,
    extractionSettled,
    missingProbes,
    planBackfill,
    splitWindow,
    withoutDeltas,
} from './extract-table.js';
import { analyzeExtraction } from './json-parse.js';
import * as observe from './observe.js';
import { extractMark, ledgerBlock, noteExtracted, noteExtractedWindow, setSync } from './state.js';
import { commitValue, loadValue } from './store.js';
import * as log from './log.js';
import { peekPendingCost, takePendingCost } from './verdict.js';
import * as trace from './trace.js';

/**
 * How much bigger the retry's budget is than the first attempt's.
 *
 * Doubling is not enough when the shortfall is reasoning rather than output: a model that spent its
 * entire allowance thinking will spend twice as much thinking too, and the retry fails identically.
 * Tripling clears the reasoning and leaves room for the answer.
 */
export const RETRY_GROWTH = 3;

/**
 * Consecutive JSON failures before the read mark advances anyway.
 *
 * The mark is the one piece of state that, set wrongly, silently skips messages forever, so a
 * single failure must never move it. But a window the model simply cannot parse (a reasoning model
 * whose budget the scene outgrew, a profile gone wrong) would otherwise freeze the ledger at that
 * point and re-read the same unreadable stretch every interval, forever. After this many failures
 * in a row the stretch is established as unreadable by the CURRENT model, and the mark is advanced
 * past it with a warning: the ledger goes stale either way, and a stale ledger that can still see
 * the future is strictly better than one that cannot move. The budget raise is the real cure; this
 * is the safety so a misbehaving model cannot wedge the whole extension.
 */
export const FAILURE_BACKSTOP = 5;

/** Failure reasons that mean "the model could not produce usable JSON", which feed the backstop. */
const JSON_FAILURES = new Set(['empty', 'truncated', 'unparseable']);

/** Consecutive passes that failed to produce usable JSON, for the backstop above. */
let consecutiveFailures = 0;

/**
 * The probes a BACKFILL pass is allowed to run.
 *
 * Every other probe answers "what is true now", and an old message is not evidence of that.
 *
 * The chronicle is the one table whose entries are dated. An event says a thing happened, carries
 * the mid it happened at, and is retrieved by keyword, recovering the opening's events is exactly
 * what makes the premise, the starting kit and the people in it findable again, which is the whole
 * point of reading the messages at all.
 *
 * The others are all present-tense and were each considered and refused:
 *
 *   `scene`     sets where and when the story IS. A chunk from message 12 would move the character
 *               back to the village they left two hundred messages ago.
 *   `review`    reads the pinned ledger back and closes what the excerpt settles. Old text closing a
 *               currently-open thread is the failure it exists to prevent, run backwards.
 *   `threads`   opens and advances stakes. Opening one the story has since resolved is worse than
 *               not knowing about it: nothing will ever close it.
 *   `world`     moves the off-screen world. Arming that from the past is incoherent.
 *   `entities`  the near miss, and the one worth stating. `merge_entity` versions field-wise on
 *               `turn` and treats an older record as "news from the past" that may fill a silence
 *               but never overwrite (`entity-table.js:930,964-966`), which is precisely the rule a
 *               backfill wants. But `turn` is ALSO the row's freshness, and `prune` sheds anything
 *               older than `ENTITY_STALE * 2` = 40 turns (`entities.js:586`). So a recovered
 *               sighting stamped low enough to be safe is stamped stale enough to be archived by the
 *               next live pass, and one stamped fresh enough to survive can overwrite the present.
 *               There is no third value. Splitting precedence from freshness is a change to
 *               `entity-table.js`, and it is the obvious next phase for this.
 */
const BACKFILL_PROBES = new Set(['events']);

/** Where the backfill's own frontier lives: `{to, done}`, per chat. Never the extraction mark. */
const BACKFILL_PATH = 'state.backfill';


/** @type {Array<{schemaKey: string, schema: () => object, instruction: () => string, apply: Function}>} */
const probes = [];

let busy = false;

/** Set by `stopBackfill`, read between chunks. See `runBackfill`. */
let stopping = false;

/**
 * Register a probe in the shared extraction call.
 *
 * `instruction()` is the probe's STATIC guidance and `context()` is its per-pass state, and the
 * split is the whole reason the second hook exists. Measured over 563 traced passes: the
 * instruction blocks are 90% byte-identical sentence mass (2449 of 2727 tokens), yet only 30% of
 * consecutive passes produced an IDENTICAL block, and the entire difference was one interpolated
 * clause, the scene probe's "The clock already reads day 3 at 12:00". A prefix cache is
 * all-or-nothing up to its breakpoint, so one moving clause in a 2700-token block costs the whole
 * block every pass. Anything a probe interpolates per pass belongs in `context()`, below the
 * breakpoint, where it costs only itself.
 *
 * @param {object} probe The probe.
 * @param {string} probe.schemaKey Property name for this probe's fragment.
 * @param {() => object} probe.schema Returns a JSON Schema fragment.
 * @param {() => string} probe.instruction Returns STATIC prompt guidance, no per-pass state.
 * @param {() => string} [probe.context] Returns per-pass state, if the probe has any.
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
function buildSchema(active = probes) {
    const properties = {};
    for (const probe of active) {
        properties[probe.schemaKey] = probe.schema();
    }
    return {
        name: 'sanguine_extract',
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
 * `source` exists for the replay driver (`slash-commands.js` `/fold-replay`) and nothing else.
 * `splitWindow` takes the LAST `size` messages, so a pass can only ever read the chat's tail,
 * which means re-running history requires restricting what the pass can see. The alternative was
 * splicing the live `chat` array, and SillyTavern persists that array to the chat file on its own
 * events: a driver that truncated it could truncate the user's transcript on disk. An explicit
 * source is the same restriction with none of that reach.
 *
 * @param {number} size How many trailing messages to include.
 * @param {{mid: number, key: string}} [mark] The persisted high-water mark.
 * @param {Array<object>|null} [source] Messages to read instead of the live chat. `null` = live.
 * @returns {{text: string, newText: string, sources: Array<{key: string, mid: number}>,
 *   context: number, mark: number|null}} The window.
 */
export function buildWindow(size, mark = {}, source = null) {
    return splitWindow(readableMessages(source), { size, mark });
}

/**
 * The chat as the extraction layer reads it: non-system messages with content, keyed by content.
 *
 * Split out of `buildWindow` because backfill needs the same list over a different range, and two
 * copies of the filter is how the mention gate and the billing rule come to disagree about which
 * messages exist.
 *
 * @param {Array<object>|null} [source] Messages to read instead of the live chat. `null` = live.
 * @returns {Array<{mid: number, key: string, name: string, text: string}>} Oldest first.
 */
export function readableMessages(source = null) {
    return (source ?? chat ?? [])
        .map((message, mid) => ({ message, mid }))
        .filter(({ message }) => message?.mes && !message.is_system)
        .map(({ message, mid }) => ({
            mid,
            key: contentKey(message.mes),
            name: message.name ?? 'Unknown',
            // The card's own status block is preserved verbatim on the message and is prose in the
            // card's language, the model must read it, not fold. `absorb` strips it from `mes` for
            // display, so it is re-attached here for the extraction pass.
            text: message.extra?.sanguine_block ? `${message.mes}\n${message.extra.sanguine_block}` : message.mes,
        }));
}

const SYSTEM_PROMPT = [
    'You are a narrative archivist. You read a transcript excerpt and return structured JSON.',
    'You never write prose, never address the user, and never invent facts that are not in the excerpt.',
].join(' ');

/**
 * How long an extraction request may take before it is abandoned.
 *
 * There is no timeout on `generateRaw`/`sendRequest`, and a request that never resolves leaves
 * `busy` true forever, the pass never finishes, the sync chip pulses `syncing` indefinitely, and
 * every later trigger bails on `busy`. That is what made the chip a liar. This bounds the call so
 * extraction ALWAYS terminates: a hang becomes a failure (red chip, next turn retries) instead of
 * an eternal spinner.
 *
 * The underlying request is aborted, not just given up on. Before the abort, a timed-out pass left
 * its request running in the background, a hung provider wedged the connection and the next
 * generation queued behind it until a page reload (measured in the Royal Succession chat, where a
 * provider hang left extraction `failed/stalled` and the connection stuck until reload). Aborting
 * frees the connection the moment the budget is spent, so the next turn retries cleanly.
 */
export const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Race a promise against a timeout, aborting the underlying request when it fires.
 *
 * The abort hook is called exactly once, on the timeout, so the caller can release the connection
 * instead of leaving a zombie request holding it. The timeout is cleared when the promise settles
 * either way.
 *
 * @param {Promise<any>} promise The request.
 * @param {number} ms Budget.
 * @param {Function} [onTimeout] Abort hook, called once when the budget expires.
 * @returns {Promise<any>} The settled value.
 */
function withTimeout(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (typeof onTimeout === 'function') {
                try {
                    onTimeout();
                } catch (error) {
                    console.error('[sanguine] abort hook failed after extraction timeout', error);
                }
            }
            reject(new Error(`extraction timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
        );
    });
}

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
 * @param {boolean} [params.reasoning] Allow the model's full reasoning; default disables it.
 * @returns {Promise<any>} Raw result: a string, or already-parsed content.
 */
export async function requestExtraction({ prompt, responseLength, schema, profileId, reasoning = false }) {
    // Abort the underlying request when the budget expires. A timed-out pass used to leave its
    // request running in the background, a hung provider wedged the connection and the next
    // generation queued behind it until a page reload. Aborting frees the connection the moment
    // the budget is spent.
    const controller = new AbortController();

    if (!profileId) {
        // Disable reasoning for extraction.
        //
        // Measured against the real API: deepseek-v4-flash spends ~3,500-10,000 tokens THINKING on
        // the extraction task, and at a 4096 budget that reasoning consumed the whole allowance and
        // `content` came back empty. `reasoning_effort` is not honored by this model (low made it
        // think MORE). But `show_thoughts: false` → the server sends `thinking: {type: "disabled"}`
        // → the model skips reasoning entirely and still returns valid extraction JSON (verified).
        // This saves most of the latency and makes the budget matter far less. The chat's own
        // `show_thoughts` setting is saved and restored around the call.
        const previousShowThoughts = oai_settings?.show_thoughts;
        if (oai_settings && !reasoning) {
            oai_settings.show_thoughts = false;
        }
        try {
            // The chat's own model path. `generateRaw` does not accept an external signal, so the
            // request cannot be aborted in-flight; the timeout still bounds the pass and `busy` is
            // cleared in the caller's `finally`, so the next turn retries cleanly. A global
            // `GENERATION_STOPPED` emit would risk aborting a main generation the user started
            // while extraction was timing out, so it is deliberately NOT used here.
            return await withTimeout(
                generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, responseLength, jsonSchema: schema }),
                EXTRACT_TIMEOUT_MS);
        } finally {
            if (oai_settings && previousShowThoughts !== undefined) {
                oai_settings.show_thoughts = previousShowThoughts;
            }
        }
    }

    const result = await withTimeout(
        ConnectionManagerRequestService.sendRequest(
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
                // Abort the request when `withTimeout` fires, this is what frees the connection so
                // the next turn retries cleanly instead of queuing behind a hung provider.
                signal: controller.signal,
            },
            { json_schema: schema },
        ),
        EXTRACT_TIMEOUT_MS,
        () => controller.abort());

    return result?.content;
}

/**
 * Run one extraction cycle.
 * @param {object} [options] Options.
 * @param {number} [options.windowSize] Trailing messages to read.
 * @param {number} [options.responseLength] Token budget for the reply.
 * @param {string} [options.profileId] Connection profile to run extraction on.
 * @param {string} [options.why] The reason this pass ran, arms the world fragment on a time skip.
 * @param {object} [options.window] A prebuilt window over an OLD span (`planBackfill`). Its presence
 *   is what makes this pass a backfill: see `BACKFILL_PROBES` for everything that changes.
 * @returns {Promise<{ok: boolean, reason?: string, results?: object}>} Outcome.
 */
export async function runExtraction({ windowSize = 6, responseLength = 800, profileId = '', why = '', reasoning = false, source = null, staticFirst = true, window: given = null } = {}) {
    // Every outcome is recorded, including the ones that are not errors.
    //
    // A chat ran to 74 turns with zero extracted events and NOTHING in the data said why. The pass
    // has half a dozen ways to decline, busy, empty window, unparseable reply, a chat that changed
    // underneath it, and each returned a reason string that went straight to a caller with no
    // `else`. So a subsystem that never succeeded was indistinguishable from one that was never
    // asked, and two rounds of diagnosis were spent inferring from absence.
    //
    // The bounds have had this since observe.js existed. The pass itself did not.
    const outcome = (reason) => {
        observe.note(`extract:${reason}`);
        // A decline that was not the model failing to produce JSON breaks the run of failures.
        if (!JSON_FAILURES.has(reason)) {
            consecutiveFailures = 0;
        }
        return { ok: false, reason };
    };

    // A backfill pass is the same pass pointed at the past, minus everything that means "now".
    //
    // Sharing `runExtraction` rather than writing a second driver is deliberate: the retry loop, the
    // budget growth, the abort, the JSON repair, the failure backstop and the trace are all things a
    // recovered chunk needs exactly as much as a live turn does, and a parallel implementation of
    // them would drift. What a recovered chunk must NOT do is claim to be current, so every write
    // that says "this is where the story is" is gated below on this one flag.
    const backfill = !!given;

    if (busy) {
        return outcome('busy');
    }
    const active = backfill ? probes.filter(probe => BACKFILL_PROBES.has(probe.schemaKey)) : probes;
    if (!active.length) {
        return outcome('no-probes');
    }

    const chatIdAtStart = getCurrentChatId();
    // Stamp the auto-cadence so a MANUAL extraction (the "Extract Now" button, the calibrate tool)
    // also resets it, otherwise the very next reply sees `turnsSinceExtract` at the ceiling and
    // fires a duplicate automatic pass. The auto path already stamps before calling, so this is a
    // no-op there; it is the missing half for every other caller. A backfill does not stamp it: it
    // reads old messages and has said nothing about whether the tail needs looking at.
    if (!backfill) {
        noteExtracted();
    }
    const window = given ?? buildWindow(windowSize, extractMark(), source);
    // A mark that stopped resolving is corrected here, once.
    //
    // `readFrontier` (`extract-table.js`) recovers the frontier from the messages that survive, and
    // this is what stops the recovery being re-derived on every pass forever: the stale mid is
    // written back as the mid it actually resolves to, so the next pass takes the `stood` path. The
    // measurement is in that docblock, ten duplicate events in one Raccoon City pass, and 145 and
    // 97 written into `cap:opening-unread` by two chats that had been read from message 1.
    if (window.heal) {
        observe.note('extract:mark-healed');
        console.warn('[sanguine] the extraction mark named a message this chat no longer has '
            + `(messages were deleted or the branch is shorter); recovering it at mid ${window.heal.mid}.`);
        noteExtractedWindow(window.heal);
    }
    if (!window.sources.length) {
        // Distinct from `empty-window`, and the distinction is the whole point of the split: an
        // empty chat and a chat where nothing has been said since the last look are different
        // facts with different remedies, and a pass that runs on nothing but context would
        // re-propose everything in it.
        return outcome(window.context ? 'nothing-new' : 'empty-window');
    }

    // A chat fold was switched on halfway through says so, once, and now leaves a work order.
    //
    // The first pass reaches back to the opening (`FIRST_WINDOW`), but it is bounded, so enabling
    // fold at message 266 of 277 leaves 261 messages nothing will ever read.
    //
    // That USED to be the end of it: "not a defect to repair, a fact about this ledger". It is a
    // defect, and the repair is `runBackfill`. What the pass cannot reach it now also RECORDS,
    // `sanguine.backfill.to` is the oldest mid this pass read, which is the exclusive ceiling of the
    // hole, so the hole can be filled later by the only mechanism that knows where it starts. A
    // counter is a report; this is the same fact in a form something can act on.
    if (window.unread) {
        observe.noteCap('opening-unread', window.unread);
        const ceiling = window.seen?.[0];
        if (Number.isFinite(ceiling) && !Number.isFinite(Number(loadValue(BACKFILL_PATH, {})?.to))) {
            commitValue(BACKFILL_PATH, { to: ceiling, done: -1 });
        }
    }

    busy = true;
    try {
        // FOLD-SLA §2.1: the wait must be visible. Extraction is in flight. A backfill deliberately
        // leaves the chip alone: it is reading the past, and the chip answers "is the ledger current
        // with the newest message", which a recovered chunk neither improves nor spoils.
        if (!backfill) {
            setSync('syncing', { mid: window.sources[window.sources.length - 1]?.mid });
        }
        const instructions = active.map(p => `- ${p.schemaKey}: ${p.instruction()}`).join('\n');
        // The ledger is pinned, not retrieved.
        //
        // Everything fold believes fits in a screenful by design (`FOLD-REDESIGN.md` §1), so the
        // model can simply be shown it. That is what makes "report only changes" an instruction it
        // can follow rather than a hope: a model shown "Carrying: kang's phone number" has no
        // reason to propose gaining it a third time, which is exactly what happened at mids 50, 52
        // and 54 of the live chat when it was shown nothing.
        //
        // Not pinned for a backfill, and that is a decision rather than a saving. The block says
        // "already recorded, report only CHANGES to this", which is exactly wrong to say about a
        // message from before any of it was true: the greeting's storage ring would be refused as a
        // restatement of the sword the ledger already holds, and the opening would stay unrecorded
        // for the second time. The chronicle's own semantic dedup (`chronicle-table.js:285-292`)
        // still catches a genuine duplicate.
        const ledger = backfill ? { text: '', shown: null, review: null } : ledgerBlock({ windowText: window.newText });
        // The adjudicator's COST, written back.
        //
        // A COST verdict from last turn left a pending note (`verdict.js` `notePendingCost`); it is
        // taken here, read and cleared, and the extractor is told to record what the cost consumed
        // as a delta. This is the loop §6 closes: the concrete cost the judge imposed no longer has
        // to happen to survive the narrator's prose into re-extraction.
        // Not read by a backfill: the pending cost is the adjudicator's verdict on the LAST live
        // turn, and a chunk from message 12 cannot be where it landed. `takePendingCost` is likewise
        // not called below, so the note survives for the live pass it belongs to.
        const pendingCost = backfill ? '' : peekPendingCost();
        const probeContext = active
            .map(p => (typeof p.context === 'function' ? String(p.context() ?? '').trim() : ''))
            .filter(Boolean)
            .join('\n');
        // Static first, or transcript first.
        //
        // The two orderings carry the same content; they differ only in what a prefix cache can
        // reach. The instruction block is ~2.7k tokens of 90% static sentence mass and the
        // transcript and ledger the pass is actually ABOUT are ~1.9k, so with the transcript
        // first, every pass differs from byte zero and the stable majority sits behind the moving
        // minority where a cache is worth nothing.
        //
        // MEASURED against the provider rather than modelled. DeepSeek (the configured profile)
        // caches automatically on the common prefix in 64-token blocks, no `cache_control` marker,
        // no message-array change. Reading `prompt_cache_hit_tokens` back for real extraction
        // prompts pulled from the trace:
        //
        //   original ordering    hit 0/4175, 0/4103, 0/4006, 0/4045, never once, at any point
        //   staticFirst          hit 2560/4072, 2560/4516, 63% once the prefix is warm
        //
        // At DeepSeek's ~10x cache discount that is 1512 + 2560*0.1 = 1768 against 4072, ~57%
        // cheaper per pass. This comment previously put the base at ~9.4k tokens by measuring the
        // schema as chars/4; the provider reports ~4072 `prompt_tokens` for the same pass, so that
        // figure was inflated and the schema's billing is simply unmeasured, corrected here rather
        // than left standing.
        //
        // The quality half was settled BEFORE the cost half, with an A/A control, because exact
        // fragment agreement between the two orderings (0-10% per probe) means nothing without
        // knowing what the SAME prompt scores against itself: 0-16%. The metric is saturated by the
        // model's own sampling variance, so the reorder sits inside the noise, which is "exact
        // equality cannot see a change here", not "there is no change". `compare.js` runs both.
        //
        // Hence the default. `staticFirst: false` still builds the original ordering, because an
        // A/B against the pre-change traces needs it.
        const transcript = [
            'Transcript excerpt:',
            '---',
            window.text,
            '---',
            '',
            ...(ledger.text ? ['Already recorded, report only CHANGES to this, never restate it:', ledger.text, ''] : []),
        ];
        const perPass = [
            ...(probeContext ? [probeContext, ''] : []),
            ...(pendingCost ? [`Note: the last attempt succeeded at a cost, ${pendingCost}. Record what it cost as a delta (money, an item, a mark) in the events below.`, ''] : []),
        ];
        // What the model is told about reading the past.
        //
        // Without this the excerpt reads as the present, and the model answers as if it were: it
        // proposes deltas for things long since spent, and writes summaries in the present tense
        // that read back as breaking news. The deltas are dropped either way (`withoutDeltas`), so
        // this is mostly about not paying for output that is thrown away, but the tense matters to
        // whoever reads the chronicle afterwards.
        const preamble = backfill
            ? ['This excerpt is from EARLIER in the story than everything already recorded. Report what happened in it, plainly and in the past tense. Do not report state changes, quantities gained or lost, or the current situation: those are already accounted for by later passes.', '']
            : [];
        const prompt = (staticFirst
            ? [...preamble, 'Extract the following:', instructions, '', ...transcript, ...perPass, 'Respond with JSON only.']
            : [...preamble, ...transcript, 'Extract the following:', instructions, ...perPass.length ? ['', ...perPass] : [''], 'Respond with JSON only.']
        ).join('\n');

        const schema = buildSchema(active);

        // Retry the model call, not just the budget.
        //
        // One retry with a tripled budget absorbs a budget shortfall and nothing else. The measured
        // reality of this model (median 34 thinking tokens) says most `empty` passes are NOT budget
        // starvation, they are transient: a rate limit right after the main generation, a provider
        // hiccup, a momentarily empty `content`. Those are absorbed by RETRYING THE SAME CALL after
        // a short backoff, not by spending more tokens. So the loop below retries up to
        // `MAX_EXTRACT_ATTEMPTS` times: the budget grows once on an empty/truncated first pass (the
        // one genuinely budget-shaped case), and every other retry waits a beat and asks again.
        //
        // `unparseable` is NOT retried, a reply the parser cannot read is a structural problem
        // (schema, prompt, model) and a retry returns the same garbage. It fails immediately.
        const MAX_EXTRACT_ATTEMPTS = 3;
        const backoffMs = (attempt) => 500 * attempt;  // 0.5s, 1s, 1.5s
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        let rawReply = '';
        let analysis = null;
        let lastError = null;
        // The best partial reply any attempt produced. A repaired-truncated reply no longer ends the
        // loop, so without this a pass whose retries all truncated would end with nothing at all,
        // strictly worse than the behaviour being fixed.
        let fallback = null;
        for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
            // A budget-shaped failure (empty/truncated) earns the tripled budget on the retries;
            // anything else, the transient case, retries at the same budget.
            const budget = attempt > 1 && (analysis?.empty || analysis?.truncated)
                ? responseLength * RETRY_GROWTH
                : responseLength;
            try {
                rawReply = String(await requestExtraction({ prompt, responseLength: budget, schema, profileId, reasoning }) ?? '');
            } catch (error) {
                // A hung request (now bounded by `EXTRACT_TIMEOUT_MS`) is not fixed by retrying the
                // same call in-pass, fail it and let the next turn try. This is what keeps `busy`
                // from wedging and the sync chip from pulsing forever.
                lastError = error;
                console.error('[sanguine] extraction request failed or timed out', error);
                break;
            }
            analysis = analyzeExtraction(rawReply);
            // Success, or a failure that is NOT budget-shaped (empty/truncated), a reply the parser
            // cannot read at all is structural and a retry returns the same garbage. The one case
            // this used to get wrong is the REPAIRED-truncated reply, which carries a usable value
            // and was therefore accepted whole; `extractionSettled` states the rule and its gates
            // pin it. The repaired value is not thrown away, it is held as the fallback below, so
            // the worst case is what shipped before and the common case earns its retry.
            if (analysis.value && !fallback) {
                fallback = analysis.value;
            }
            if (extractionSettled(analysis)) {
                break;
            }
            if (attempt < MAX_EXTRACT_ATTEMPTS) {
                observe.note(`extract:retry-${attempt}`);
                console.debug(`[sanguine] extraction returned nothing on attempt ${attempt}; retrying in ${backoffMs(attempt)}ms`);
                await sleep(backoffMs(attempt));
            }
        }
        if (analysis?.truncated || analysis?.empty) {
            observe.note(`extract:retry-${analysis.empty ? 'empty' : 'truncated'}`);
        }

        const parsed = analysis?.value ?? fallback;
        if (!parsed) {
            console.warn('[sanguine] extraction produced no usable JSON; abandoning this cycle');
            // The distinct failures, counted separately. They have different remedies, raise the
            // budget, change the model, fix the prompt, and one bucket cannot tell you which.
            const reason = lastError ? 'error'
                : analysis?.empty ? 'empty'
                    : analysis?.truncated ? 'truncated'
                        : 'unparseable';
            observe.note(`extract:${reason}`);
            // FOLD-SLA §2.3: a failure is shown, named, and given its fix, never silent.
            const detail = lastError
                ? `extraction request failed: ${lastError.message}, the pass was abandoned, not stuck; the next turn retries.`
                : reason === 'empty'
                    ? `no JSON after ${MAX_EXTRACT_ATTEMPTS} attempts (budget + backoff retries), for this model (median 34 thinking tokens) that is a transient failure, likely a rate limit; see the raw reply below.`
                    : reason === 'truncated'
                        ? 'reply cut off mid-JSON across retries, a structural ceiling, not transient.'
                        : 'JSON present but unusable across retries, prompt, schema or model, not a budget issue.';
            if (!backfill) {
                setSync('failed', { mid: window.sources[window.sources.length - 1]?.mid, reason, detail });
            }
            // The diagnostics log distinguishes the two cures: an EMPTY reply ran its allowance down
            // thinking and never answered (raise the token budget); UNPARSEABLE produced JSON the
            // parser could not read (prompt/schema/model, no budget fixes it); TRUNCATED was cut
            // off and unrecoverable (budget). This is the surface for "is it the budget or is it
            // structural?".
            //
            // The RAW reply is recorded so the next failure shows WHAT the API actually returned,
            // empty content, a rate-limit body, an error envelope, or prose that failed to parse.
            // The measurement of this model (median 34 thinking tokens) says the "spent its
            // allowance thinking" theory is wrong for the common case; only the raw reply settles it.
            const rawReplyText = String(rawReply ?? '');
            log.note({
                kind: 'extract',
                reason,
                mid: window.sources[window.sources.length - 1]?.mid,
                detail,
                raw: rawReplyText ? `reply: ${rawReplyText}` : 'reply: (empty string)',
            });
            // The trace keeps the FAILING pass too, the unparseable reply is exactly the
            // prompt bug the resolver's data cannot afford to lose.
            trace.record({
                // READ the turn here; do not advance it.
                //
                // This said `turn`, which is `const turn = entities.advanceTurn()` further down the
                // SAME block. So every unusable-JSON pass threw a TDZ ReferenceError on this line,
                // and everything below it, `consecutiveFailures++` and the whole `FAILURE_BACKSTOP`
                // block, was unreachable. The backstop exists precisely so a window the model
                // cannot parse does not freeze the ledger forever, and it had never once run.
                //
                // `entities.turn()` rather than hoisting the advance: a pass that produced nothing
                // must not consume a tick, or every probe's staleness clock drifts on failures.
                turn: entities.turn(),
                mid: window.sources[window.sources.length - 1]?.mid,
                why,
                profileId,
                responseLength,
                prompt,
                schema,
                raw: rawReplyText,
                parsed: null,
                ok: false,
                reason,
            });
            // The backstop: a window the model cannot parse must not freeze the ledger.
            //
            // A backfill chunk is exempt: its own driver advances its own frontier past a chunk the
            // model could not read (`runBackfill`), so an unreadable stretch of history cannot wedge
            // the run either, and the forward mark, which is what this advances, has nothing to do
            // with it.
            consecutiveFailures++;
            if (!backfill && consecutiveFailures >= FAILURE_BACKSTOP) {
                const read = window.sources[window.sources.length - 1];
                console.warn(`[sanguine] extraction failed ${consecutiveFailures} times in a row for this window; `
                    + 'advancing the read mark so the ledger does not stay frozen on an unreadable stretch.');
                noteExtractedWindow(read);
                consecutiveFailures = 0;
            }
            return { ok: false, reason };
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
        // Where a recovered event lands in a ledger ordered by wall clock.
        //
        // `deriveState` folds by `t` (`state-table.js:2373`) and `t` is when the pass ran, so a
        // recovered event stamped now would be the newest thing the chronicle knows about a message
        // from an hour before any of it. `backfillStamp` interpolates it into the ledger's own
        // mid→t anchors instead. See its docblock; the arithmetic half of the same hazard is
        // answered by `withoutDeltas` below, which is the load-bearing one.
        const now = backfill
            ? backfillStamp(
                liveEvents().map(event => ({ mid: event?.mid, t: event?.t })),
                window.sources[window.sources.length - 1]?.mid)
            : Date.now();
        // The newest message this pass actually read and that is still live on this branch. Written
        // after the probes have applied, so a pass that dies partway never claims to have read
        // anything, the mark is the one piece of fold's state that, set wrongly, causes messages
        // to be silently skipped forever.
        const read = sources[sources.length - 1];
        // One tick per pass, read by every probe.
        //
        // This counter used to be advanced inside `entities.applyExtraction`, which made it the
        // entity probe's private business. Every probe registered before it therefore stamped its
        // records with the PREVIOUS tick while the entity probe stamped the next one, so a clock
        // that had just advanced read as a turn stale, and anything asking "did this change this
        // turn?" got the wrong answer for three of the four probes. A shared clock belongs to the
        // pass, not to whichever probe happens to own the storage.
        //
        // A backfill READS the turn and does not advance it. The counter is what every staleness
        // clock in the extension is measured against (`ENTITY_STALE`, `entities.js:586`, which sheds
        // a row at 40), so nine recovered chunks would age the whole cast by nine turns for a story
        // that has not moved, and archive anyone who was already thirty-two turns quiet.
        const turn = backfill ? entities.turn() : entities.advanceTurn();
        // A probe whose key never arrived is named, not left to look like silence.
        //
        // A cut-off reply loses the TAIL, always: the model emits properties in schema order and the
        // probes assemble in registration order. The apply loop below reads `parsed[schemaKey]` and
        // a missing key no-ops, which is byte-identical to a probe that legitimately had nothing to
        // report. So the most expensive failure in the pass was also the only invisible one.
        const missing = missingProbes(parsed, active.map(probe => probe.schemaKey));
        if (missing.length) {
            observe.noteCap('probe-truncated', missing.length);
            log.note({
                kind: 'extract',
                reason: 'partial',
                detail: `the reply ended before these probes were answered: ${missing.join(', ')}`,
                raw: `answered: ${probes.map(probe => probe.schemaKey).filter(key => !missing.includes(key)).join(', ') || '(none)'}`,
            });
        }
        for (const probe of active) {
            // Backfill is additive to the RECORD and never to the ARITHMETIC.
            //
            // The whole argument is in `withoutDeltas`. The short version: the forward ledger has
            // already absorbed the CONSEQUENCES of the unread span through later mentions, so
            // crediting the origin now double-counts, and no stamp can fix it because a sum does not
            // care what order it is taken in. Stripped here, at the last point before the fold sees
            // it, so a probe cannot opt back in by accident.
            const fragment = backfill ? withoutDeltas(parsed[probe.schemaKey]) : parsed[probe.schemaKey];
            try {
                // windowText is what the state probe's mention gate checks against: a model
                // cannot invent a change to something the excerpt never mentions.
                // windowText is the NEW half only. It is what the state probe's mention gate checks
                // against (`isMentioned`, `state-table.js`), and the gate has to agree with the
                // billing rule: if a beat narrated only in the context half cannot be recorded,
                // then the excerpt that licenses a change must be the same half that may anchor it.
                results[probe.schemaKey] = probe.apply(fragment, {
                    sources,
                    now,
                    turn,
                    windowText: window.newText,
                    shown: ledger.shown,
                    // Every mid this pass displayed, both halves.
                    //
                    // `sources` above is the new half, what may anchor an event. This is what the
                    // model could be RE-telling, and it is the only thing the already-recorded gate
                    // is allowed to refuse on (`state-table.js` `validateInventory`). Built from the
                    // window that was actually rendered, not from the mark or the size, because a
                    // refusal has to be about the text the model was handed.
                    visible: new Set(window.seen ?? []),
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
                console.error(`[sanguine] probe "${probe.schemaKey}" failed to apply`, error);
            }
        }
        // Succeeding and producing nothing are different facts. A model that reads six messages and
        // finds no event of consequence is behaving correctly; one that never returns anything is
        // not, and only the counts can tell them apart.
        observe.note(backfill
            ? (results?.events?.added ? 'backfill:ok' : 'backfill:no-events')
            : (results?.events?.added ? 'extract:ok' : 'extract:no-events'));
        // The pass succeeded, the model was actually shown the pending-cost note and the probes
        // have applied. Only now is the note cleared; a note consumed by a failing pass would have
        // been a cost the judge imposed and the ledger never saw (nine costs lost to empty passes
        // in one fight). The failure path above deliberately leaves it for a pass that can read it.
        if (!backfill) {
            takePendingCost();
        }
        // A success, even an empty one, breaks any run of JSON failures.
        consecutiveFailures = 0;
        // FOLD-SLA §2.1/2.2: the ledger now reflects `read`. If a newer message rendered while the
        // pass was in flight, say so, the next pass covers the gap, rather than claiming current.
        //
        // Neither of these is a backfill's to touch.
        //
        // The mark is the FORWARD frontier: the newest message read. A recovered chunk's newest
        // message is older than everything, so writing it here would drag the mark backwards and the
        // next live pass would re-read, and re-bill, the entire campaign since. The backfill's own
        // frontier is a separate number, advanced by `runBackfill` (`sanguine.backfill.done`),
        // exactly so these two can never be confused for one another.
        if (!backfill) {
            const newestMid = (chat ?? []).reduce((last, m, i) => (m?.mes && !m.is_system ? i : last), -1);
            setSync(read.mid >= newestMid ? 'up-to-date' : 'behind', { mid: read.mid });
            // Success includes "read six messages, found nothing worth recording". That is the case
            // the mark most needs to cover: re-reading a quiet stretch on the next pass is how a
            // window comes to be read three times, and the model declining to re-report it is the
            // behaviour that shows up as `extract:delta-empty` rather than as a saving.
            noteExtractedWindow(read);
        }
        // The trace: the exact prompt, the raw reply, and the parsed fragment, the full
        // input->output pair of this pass, kept for training and later analysis. Fire-and-forget:
        // a failed trace write must not fail the pass it records.
        trace.record({
            turn,
            mid: read.mid,
            why,
            profileId,
            responseLength,
            prompt,
            schema,
            raw: String(rawReply ?? ''),
            parsed,
            ok: true,
            reason: '',
        });
        return { ok: true, results };
    } catch (error) {
        console.error('[sanguine] extraction failed', error);
        observe.note('extract:error');
        return { ok: false, reason: String(error?.message ?? error) };
    } finally {
        busy = false;
    }
}

/**
 * ══ Backfill: the driver ══
 *
 * `planBackfill` (`extract-table.js`) decides what to read and in what order; this spends the money.
 * Three properties it must have, because the thing being spent is the owner's API credit on his own
 * campaign:
 *
 *   stated first     `backfillPlan()` answers what a run would cost without calling anything, and
 *                    the slash command runs it by default. A run only happens on an explicit word.
 *   resumable        the frontier is persisted after EVERY chunk, so a run stopped by a closed tab,
 *                    a stop, or a `limit` picks up at the next unread message rather than the start.
 *   interruptible    `stopBackfill()` is checked between chunks, never mid-request: a chunk already
 *                    paid for is allowed to finish and be recorded.
 */

/** @returns {{to: number, done: number}} The backfill frontier for this chat. */
export function backfillState() {
    const stored = loadValue(BACKFILL_PATH, {});
    return {
        to: Number(stored?.to ?? NaN),
        done: Number.isFinite(Number(stored?.done)) ? Number(stored.done) : -1,
    };
}

/**
 * Forget what has been backfilled, so the span can be read again.
 * @param {object} [next] Fields to keep. Absent fields reset.
 */
export function resetBackfill({ to = NaN, done = -1 } = {}) {
    commitValue(BACKFILL_PATH, { ...(Number.isFinite(to) ? { to } : {}), done });
}

/** Ask a run in progress to stop after the chunk it is on. */
export function stopBackfill() {
    stopping = true;
}

/**
 * What a backfill would read, and what it would cost, without calling anything.
 *
 * Why the ceiling is never guessed, and never taken from `cap:opening-unread`.
 *
 * The ceiling is the oldest mid the forward pass has read. Get it wrong on the high side and the
 * backfill re-reads messages that are already in the ledger, spending money to write duplicates with
 * fresh anchors that neither dedup can see, which is precisely the damage the mark-loss bug did by
 * accident (`extract-table.js` `readFrontier`: ten duplicate events in one Raccoon City pass).
 *
 * So there are exactly two sources, both exact:
 *
 *   · `to=`, from the owner, who can read his own chat.
 *   · `sanguine.backfill.to`, written by the first pass that MEASURED a hole, the oldest mid it
 *     read, recorded at the same site that reports `unread`.
 *
 * `cap:opening-unread` is deliberately NOT a third. In the only two chats that carry it, it is not a
 * hole at all: both were extracted from message 1 and the counts are a mark that stopped resolving.
 * A ceiling derived from it would have sent a backfill over 145 already-read messages.
 *
 * `hint` is offered instead, the oldest mid anything in the ledger is anchored on, so a chat that
 * predates the recording can be given a `to=` its owner can check rather than one fold invented.
 *
 * @param {object} [options] Options.
 * @param {number} [options.to] Exclusive ceiling override.
 * @param {number} [options.chunk] Messages billed per call.
 * @param {Array<object>|null} [options.source] Messages to read instead of the live chat.
 * @returns {object} The plan, plus `hint` and `source` naming where the ceiling came from.
 */
export function backfillPlan({ to = NaN, chunk = BACKFILL_CHUNK, source = null } = {}) {
    const messages = readableMessages(source);
    const stored = backfillState();
    const ceiling = Number.isFinite(Number(to)) ? Number(to) : stored.to;
    const anchored = liveEvents().map(event => event?.mid).filter(Number.isFinite);
    const hint = anchored.length ? Math.min(...anchored) : NaN;
    const plan = planBackfill(messages, { to: ceiling, done: stored.done, chunk });
    return {
        ...plan,
        hint,
        done: stored.done,
        // Which of the two exact sources this ceiling came from, so the report can say so rather
        // than presenting a number with no provenance.
        source: Number.isFinite(Number(to)) ? 'stated' : Number.isFinite(stored.to) ? 'recorded' : 'none',
    };
}

/**
 * Read a span the forward pass never reached, chunk by chunk.
 *
 * Every chunk is one model call through the same `runExtraction` the live turn uses, with `window`
 * set: see the `backfill` flag there for everything that behaves differently. The frontier advances
 * after each chunk whether it succeeded or not: a chunk the model could not parse is a hole in the
 * recovery, not a reason to spend the same money on it again on the next run, and `backfill:failed`
 * counts them so a run that recovered half of what it read says so.
 *
 * @param {object} [options] Options.
 * @param {number} [options.to] Exclusive ceiling override.
 * @param {number} [options.chunk] Messages billed per call.
 * @param {number} [options.limit] Stop after this many chunks.
 * @param {number} [options.responseLength] Token budget per chunk.
 * @param {string} [options.profileId] Connection profile.
 * @param {boolean} [options.reasoning] Allow the model's reasoning.
 * @param {(done: number, total: number) => void} [options.onProgress] Progress callback.
 * @param {Array<object>|null} [options.source] Messages to read instead of the live chat.
 * @returns {Promise<object>} What was read: chunks run, chunks that produced a fragment, events.
 */
export async function runBackfill({
    to = NaN, chunk = BACKFILL_CHUNK, limit = Infinity, responseLength = 800,
    profileId = '', reasoning = false, onProgress = null, source = null,
} = {}) {
    const plan = backfillPlan({ to, chunk, source });
    if (plan.reason) {
        observe.note(`backfill:${plan.reason}`);
        return { ...plan, ran: 0, ok: 0, added: 0, stopped: false, aborted: plan.reason, remaining: 0 };
    }

    stopping = false;
    const cap = Number(limit) > 0 ? Number(limit) : Infinity;
    let ran = 0;
    let ok = 0;
    let added = 0;
    let aborted = '';
    for (const window of plan.chunks) {
        if (ran >= cap || stopping) {
            break;
        }
        const result = await runExtraction({
            window, responseLength, profileId, reasoning, why: 'backfill',
        });
        // A chunk that never reached the model must not advance the frontier.
        //
        // `chunkRead` (`extract-table.js`) carries the rule and the argument. The short version: a
        // decline that happened before the request, a live pass holding `busy`, the user changing
        // chat mid-run, has read nothing, and counting it as read would silently skip exactly what
        // this exists to recover while looking like a completed run. The run stops there instead,
        // with everything before it kept and resumable.
        if (!chunkRead(result)) {
            aborted = String(result?.reason ?? '');
            break;
        }
        ran += 1;
        if (result?.ok) {
            ok += 1;
            added += Number(result.results?.events?.added ?? 0);
        } else {
            // A call was spent and produced nothing usable. Counted, and the frontier still moves:
            // the alternative is a chunk the model cannot read blocking every later chunk forever,
            // at one wasted call per attempt.
            observe.note('backfill:failed');
        }
        const read = window.sources[window.sources.length - 1]?.mid;
        if (Number.isFinite(read)) {
            // Persisted per chunk, which is what makes this resumable at all.
            commitValue(BACKFILL_PATH, { to: plan.to, done: read });
        }
        onProgress?.(ran, Math.min(plan.calls, cap));
    }
    const stopped = stopping;
    stopping = false;
    observe.note('backfill:run');
    return { ...plan, ran, ok, added, stopped, aborted, remaining: Math.max(0, plan.calls - ran) };
}
