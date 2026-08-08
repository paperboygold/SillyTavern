/**
 * fold — Scribe's ideas, ported onto the hashtrinity basis.
 *
 * One structure (the K -> V table), one operation (`insert_with`), and the merge is the only
 * freedom. See ./lib/hash.js for the algebra and SCRIBE-PORT.md for what is being ported and why.
 *
 * Shipping: Pillar C (directed retry) and Pillar D (the chronicle ledger).
 * Designed, not yet built: recall fusion (Accumulator face), status & inventory.
 */

import {
    chat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
} from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { ConnectionManagerRequestService } from '../shared.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { self_test } from './lib/hash.js';
import { initSteerUi } from './ui.js';
import { registerFoldSlashCommands } from './slash-commands.js';
import * as chronicle from './chronicle.js';
import * as recall from './recall.js';
import * as state from './state.js';
import * as entities from './entities.js';
import * as scene from './scene.js';
import * as clocks from './clocks.js';
import * as observe from './observe.js';
import * as review from './review.js';
import { reviewInstruction, reviewSchema } from './review-table.js';
import { looksLikeAttempt, nextInterval, shouldExtract } from './trigger-table.js';
import * as verdict from './verdict.js';
import * as world from './world.js';
import * as plot from './plot.js';
import * as panel from './panel.js';
import { initPanel } from './panel.js';
import { absorbStateBlock } from './absorb.js';
import { registerProbe, runExtraction } from './extract.js';

export const MODULE_NAME = 'fold';

/**
 * Injection key. `getExtensionPrompt` sorts keys alphabetically, which is why the built-ins are
 * numbered (1_memory, 2_floating_prompt, 3_vectors, 4_vectors_data_bank). 5_ puts the chronicle
 * after them. When recall fusion lands it takes over the contents of this same key.
 */
const RECALL_INJECT_KEY = '5_fold_recall';

/**
 * The overall story direction sorts BEFORE recall and state — 4_ puts it ahead of 5_, and it is
 * injected at a deep depth so the arc survives wherever the current scene falls in the window.
 * The per-message steer is forgotten the moment a reply lands; this is the direction that is not.
 */
const PLOT_INJECT_KEY = '4_fold_plot';

/**
 * How deep the story direction is injected. Depth 0: read immediately before generation, AFTER the
 * [Scene] state block (depth 1). The scene establishes what the characters actually know; the
 * direction arrives last as the hidden hand. A deeper depth would inject the arc outline far back
 * in the history, where it primes the whole scene-read with future knowledge — the metagaming
 * channel that made every character act as if they had read the synopsis.
 */
const PLOT_DEPTH = 0;

/**
 * State sits closer to the response than recall does — 6_ sorts after 5_, and it is injected at a
 * shallower depth. What the character is carrying right now matters more to the next sentence
 * than what happened three scenes ago.
 */
const STATE_INJECT_KEY = '6_fold_state';

/**
 * The verdict. Sorted last of fold's three keys and injected at depth 0, because a ruling has to be
 * the most recent thing the model reads — the whole point is that it cannot be weighed against
 * forty messages of fiction and quietly lost.
 */
const VERDICT_INJECT_KEY = '7_fold_verdict';

const DEFAULT_STEER_TEMPLATE = '[Instruction for the next reply: {{instruction}}]';
const DEFAULT_CHRONICLE_TEMPLATE = 'Relevant past events:\n{{text}}';

/**
 * Floor for the extraction budget.
 *
 * Reasoning tokens are charged against the same `max_tokens` as the answer, so this has to cover
 * the model's deliberation AND three probes' worth of JSON. Below it the observed behaviour is not
 * a partial answer but no answer: `extract:empty`, every cycle, silently.
 */
const MIN_RESPONSE_LENGTH = 2400;

const defaultSettings = Object.freeze({
    enabled: true,
    /** Whether the tracker panel is on screen. */
    panel: false,
    steer: Object.freeze({
        enabled: true,
        template: DEFAULT_STEER_TEMPLATE,
        remember_last: true,
        last_instruction: '',
        show_badge: true,
    }),
    state: Object.freeze({
        // Off by default alongside the chronicle: it rides the same extraction call.
        enabled: false,
        depth: 1,
        /**
         * Adjudicate contested attempts automatically, before the narrator writes. The gate is in
         * code and conservative — see `looksLikeAttempt` — so ordinary conversation costs nothing.
         */
        adjudicate: true,
        /**
         * Lift a card's own trailing state block out of the reply, fold its contents into tracked
         * state, and let fold's single injected block replace it. Stops the block being shown to
         * the reader and stops every past copy being re-sent on every turn.
         */
        absorb_block: true,
    }),
    chronicle: Object.freeze({
        // Off by default: extraction spends tokens on whichever model is answering.
        enabled: false,
        // Connection profile to run extraction on. Empty means "use the chat's own model", which
        // is rarely what you want — extraction is mechanical summarization and belongs on
        // something small and cheap.
        profile: '',
        interval: 4,
        window: 6,
        top_k: 3,
        depth: 4,
        // Hard cap on the injected block. Also capped at 5% of the real context size at
        // injection time, whichever is smaller.
        budget: 512,
        template: DEFAULT_CHRONICLE_TEMPLATE,
        // ── Sized for a REASONING model, because that is what people are running ──
        //
        // This was 800, chosen against a non-reasoning model emitting one probe's worth of JSON.
        // Both halves of that assumption have since failed. There are three probes now, and a
        // reasoning model is charged for its thinking out of the same allowance — so 800 bought a
        // few hundred tokens of deliberation and no answer at all. A chat ran nine turns and
        // extracted nothing, twice out of two attempts, with the panel never once updating.
        response_length: MIN_RESPONSE_LENGTH,
    }),
});

// Assistant turns since the last extraction now come from `state.turnsSinceExtract()`, which reads
// the per-chat turn counter rather than a module variable. The variable could not survive a reload
// and was reset by every CHAT_CHANGED, so switching between two chats starved extraction outright.

/**
 * The retrieval plan computed by the current generation's interceptor, held so the World Info
 * handler can re-run selection once it knows what World Info is contributing.
 * @type {object|null}
 */
let pendingPlan = null;

/**
 * Event keys already credited with a retrieval hit during the current generation. The block can be
 * written twice — once by the interceptor, once after World Info reports in — and without this the
 * same retrieval would count twice, inflating exactly the signal that decides what survives eviction.
 * @type {Set<string>}
 */
let creditedThisGeneration = new Set();

/**
 * Accessor for this extension's settings bag, guaranteed to be fully populated.
 * @returns {typeof defaultSettings} The settings object (live, mutable).
 */
export function foldSettings() {
    return extension_settings[MODULE_NAME];
}

/**
 * Is swipe steering currently available?
 * @returns {boolean} True if both the extension and the steer feature are enabled.
 */
export function isSteerEnabled() {
    const settings = foldSettings();
    return !!settings?.enabled && !!settings?.steer?.enabled;
}

/**
 * Is the chronicle currently active?
 * @returns {boolean} True if both the extension and the chronicle are enabled.
 */
export function isChronicleEnabled() {
    const settings = foldSettings();
    return !!settings?.enabled && !!settings?.chronicle?.enabled;
}

/**
 * Is state tracking active?
 * @returns {boolean} True if both the extension and state tracking are enabled.
 */
export function isStateEnabled() {
    const settings = foldSettings();
    return !!settings?.enabled && !!settings?.state?.enabled;
}

/**
 * Does anything need the shared extraction pass to run?
 * @returns {boolean} True if any probe is active.
 */
export function isExtractionNeeded() {
    return isChronicleEnabled() || isStateEnabled();
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    for (const key of ['enabled', 'panel']) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    // ── A value the control cannot produce was never a choice ──
    //
    // `settings.html` declares the interval as `type="number" min="1" max="50"`. A stored 999 is
    // therefore not a user preference; it is damage — in this case from an e2e suite that sets it
    // high to stop automatic extraction interfering, written into real settings back when the
    // Playwright config still reused a server on the default port.
    //
    // It cost sixty-eight turns of silence. Extraction never fired, so item places, people, leads,
    // lead provenance and condition durations were all dormant, and none of them could report that
    // because a subsystem that never runs raises nothing. Out-of-range goes back to the default and
    // says so, rather than being clamped to a max that would fire once every fifty replies.
    const stored = Number(settings.chronicle?.interval);
    if (Number.isFinite(stored) && (stored < 1 || stored > 50)) {
        console.warn(`[fold] chronicle interval ${stored} is outside the settings control's own range (1-50); `
            + `restoring the default of ${defaultSettings.chronicle.interval}. Extraction could not have run.`);
        settings.chronicle.interval = defaultSettings.chronicle.interval;
    }

    // ── A budget too small to answer in is not a budget ──
    //
    // Same shape of damage, different cause: 800 was the old default, saved into real settings
    // before there were three probes and before reasoning models charged their thinking to the same
    // allowance. Raising the default alone would not have reached anyone who had already run fold
    // once, and the failure is invisible from the panel — extraction returns a complete, empty,
    // well-formed nothing and the tracker simply never moves.
    const budget = Number(settings.chronicle?.response_length);
    if (Number.isFinite(budget) && budget < MIN_RESPONSE_LENGTH) {
        console.warn(`[fold] extraction budget ${budget} is below the ${MIN_RESPONSE_LENGTH} a reasoning `
            + 'model needs to think and still answer; raising it. Extraction was returning empty.');
        settings.chronicle.response_length = MIN_RESPONSE_LENGTH;
    }

    for (const section of ['steer', 'chronicle', 'state']) {
        if (!settings[section] || typeof settings[section] !== 'object') {
            settings[section] = {};
        }
        for (const [key, value] of Object.entries(defaultSettings[section])) {
            if (settings[section][key] === undefined) {
                settings[section][key] = value;
            }
        }
    }
}

/**
 * Reflect the enabled state onto <body>, which is what the CSS visibility rules key off.
 * Doing this in CSS rather than JS means the controls survive addOneMessage() re-rendering
 * the message template on every swipe, with no per-message bookkeeping.
 */
export function syncSteerBodyClass() {
    document.body.classList.toggle('fold-steer-enabled', isSteerEnabled());
}

/**
 * Text used to retrieve against: the tail of the conversation.
 * @param {object[]} messages The chat array.
 * @param {number} [count] How many trailing messages to use.
 * @returns {string} Query text.
 */
function buildQueryText(messages, count = 2) {
    return (messages ?? [])
        .filter(message => message?.mes && !message.is_system)
        .slice(-count)
        .map(message => substituteParams(message.mes))
        .join('\n');
}

/**
 * Is automatic adjudication on?
 * @returns {boolean} True when the extension, state tracking and adjudication are all enabled.
 */
export function isAdjudicationEnabled() {
    const settings = foldSettings();
    return !!settings?.enabled && !!settings?.state?.enabled && !!settings?.state?.adjudicate;
}

/**
 * Adjudicate the player's last message, if it was an attempt at something contested.
 *
 * Runs inside the interceptor, so the verdict is decided BEFORE the narrator is asked to write and
 * is handed over as a ruling rather than as evidence. That ordering is the entire mechanism: asking
 * a model whether the player succeeded reliably returns yes, and the bias strengthens with context
 * length, so the question is answered in code and the answer is not up for discussion.
 */
async function adjudicateLastAttempt() {
    const last = [...(chat ?? [])].reverse().find(message => message?.mes && !message.is_system);
    if (!last?.is_user) {
        return;
    }

    const gate = looksLikeAttempt(last.mes);
    if (!gate.attempt) {
        observe.note('verdict:skipped');
        return;
    }

    try {
        const settings = foldSettings();
        const outcome = await verdict.judge(last.mes, {
            window: settings.chronicle.window,
            profileId: settings.chronicle.profile,
            responseLength: settings.chronicle.response_length,
        });
        if (!outcome.ok) {
            // Declining beats guessing: a verdict built on a failed classification is arithmetic
            // over defaults wearing the clothes of a ruling.
            return;
        }
        setExtensionPrompt(VERDICT_INJECT_KEY, outcome.directive, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        console.debug(`[fold] ${verdict.explain(outcome.verdict)}`);
        // The strip flashes in the verdict's band colour (§8, altitude 1) — a transient cue, the
        // same band vocabulary the verdict uses, gone after a few seconds.
        panel.flashVerdict(outcome.verdict.band);
    } catch (error) {
        console.error('[fold] adjudication failed', error);
        observe.note('verdict:error');
    }
}

/**
 * Generation interceptor: inject relevant chronicle events before the prompt is assembled.
 *
 * Registered through manifest.generate_interceptor, the same mechanism the vectors extension uses.
 * Unlike that one, this never mutates the chat array — it only sets an extension prompt.
 *
 * @param {object[]} messages The chat, as passed by the interceptor pipeline.
 * @param {number} contextSize Current context size in tokens.
 * @param {Function} abort Abort callback.
 * @param {string} type Generation type.
 */
export async function interceptGeneration(messages, contextSize, abort, type) {
    const settings = foldSettings();
    // Always clear first, so a stale block can never survive into a generation that should not
    // have one. The plan and hit ledger are per-generation state and reset with it.
    setExtensionPrompt(PLOT_INJECT_KEY, '', extension_prompt_types.IN_CHAT, PLOT_DEPTH, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(RECALL_INJECT_KEY, '', extension_prompt_types.IN_CHAT, settings.chronicle.depth, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(STATE_INJECT_KEY, '', extension_prompt_types.IN_CHAT, settings.state.depth, false, extension_prompt_roles.SYSTEM);
    pendingPlan = null;
    creditedThisGeneration = new Set();

    // ── The story direction, injected before recall and state ──
    //
    // The plot guide is the one thing that must survive regardless of enablement toggles: it is
    // the arc the fiction follows, orthogonal to state and chronicle. When no guide is set the
    // block is empty and the prompt is exactly what it was.
    try {
        const direction = plot.render();
        if (direction) {
            setExtensionPrompt(PLOT_INJECT_KEY, direction, extension_prompt_types.IN_CHAT, PLOT_DEPTH, false, extension_prompt_roles.SYSTEM);
        }
    } catch (error) {
        console.error('[fold] plot guide injection failed', error);
    }

    // ── Adjudication, automatic ──
    //
    // This used to require `/try`, which put the burden of noticing a risky moment on the player —
    // exactly the bookkeeping this whole design exists to remove. The gate is code, cheap and
    // conservative: an unmistakable attempt at something contested runs the adjudicator, everything
    // else passes through untouched. It is conservative rather than eager because this call BLOCKS
    // the reply, and a verdict imposed on a conversation is worse than no verdict at all.
    setExtensionPrompt(VERDICT_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

    if (type === 'quiet') {
        return;
    }

    if (isAdjudicationEnabled()) {
        await adjudicateLastAttempt();
    }

    if (isStateEnabled()) {
        try {
            setExtensionPrompt(STATE_INJECT_KEY, state.render(), extension_prompt_types.IN_CHAT, settings.state.depth, false, extension_prompt_roles.SYSTEM);
        } catch (error) {
            console.error('[fold] state injection failed', error);
        }
    }

    if (!isChronicleEnabled()) {
        return;
    }

    try {
        // The real context size arrives as the interceptor's second argument, so the cap is a
        // fraction of what the model can actually hold rather than a guess.
        const budget = Math.max(0, Math.min(
            settings.chronicle.budget,
            Math.floor((Number(contextSize) || 0) * 0.05) || settings.chronicle.budget,
        ));

        const result = await recall.gather({
            messages,
            queryText: buildQueryText(messages),
            budget,
            topK: settings.chronicle.top_k,
            template: settings.chronicle.template,
        });

        // Kept so the World Info handler can re-select without repeating the vector query.
        pendingPlan = result.plan;
        applyRecallBlock(result);
    } catch (error) {
        console.error('[fold] recall injection failed', error);
    }
}

/**
 * Write the recall block into the prompt and record which events earned their place.
 * @param {{text: string, items: object[]}} result A selection result.
 */
function applyRecallBlock(result) {
    const settings = foldSettings();

    // scan:false is deliberate. checkWorldInfo feeds every extension prompt with scan:true into
    // its scan buffer, so scanning our own output would let injected evidence activate World Info
    // entries, which change the next retrieval — a feedback loop.
    setExtensionPrompt(RECALL_INJECT_KEY, result.text ?? '', extension_prompt_types.IN_CHAT, settings.chronicle.depth, false, extension_prompt_roles.SYSTEM);

    // Retrieval feeds retention: events that keep proving useful outlive ones that never surface.
    // Only chronicle items carry a hit count, and only once per generation.
    const fresh = (result.items ?? [])
        .filter(item => item.source === 'chronicle')
        .map(item => item.key.replace(/^evt:/, ''))
        .filter(key => !creditedThisGeneration.has(key));

    fresh.forEach(key => creditedThisGeneration.add(key));
    chronicle.noteHit(fresh);
}

/**
 * Count assistant turns and run an extraction once enough have accumulated.
 * Deliberately not awaited by anything: the reply must never wait on it.
 */
/**
 * Absorb a card's own state block from a reply, if it has one.
 *
 * Runs before any extraction bookkeeping: it is free (no request), and when a card reports its own
 * state there is far less for the extraction pass to work out.
 *
 * @param {number} messageId The message that just arrived.
 */
function onMessageForBlock(messageId) {
    const settings = foldSettings();
    if (!settings?.enabled || !settings.state?.absorb_block) {
        return;
    }
    // ── Count the turn BEFORE looking for a block ──
    //
    // Staleness used to advance only when a block arrived, which made it blind in exactly the case
    // it existed for. Measured on a real chat: blocks land in bursts — `.BB......BBBBBBBBBBBB.BBB....`
    // over 29 assistant turns, 17 with, 12 without. Across a gap the clock froze AND read as fresh,
    // because nothing had been "seen". A turn is a turn whether or not the narrator restated itself.
    try {
        state.noteTurn();
    } catch (error) {
        console.error('[fold] failed to advance the turn counter', error);
    }
    try {
        const outcome = absorbStateBlock(Number(messageId), { trackState: isStateEnabled() });
        if (outcome.absorbed) {
            console.debug('[fold] absorbed a state block from the reply', outcome);
            panel.render();
        }
    } catch (error) {
        console.error('[fold] failed to absorb the state block', error);
    }
}

/**
 * The latest exchange, for movement evidence.
 *
 * Both halves: the player may announce the travel ("we ride for three days") or the narrator may
 * perform it, and either is grounds to look again.
 *
 * @returns {string} The last two messages' text.
 */
function lastExchange() {
    return (chat ?? [])
        .filter(message => message?.mes && !message.is_system)
        .slice(-2)
        .map(message => message.mes)
        .join('\n');
}

async function onAssistantMessage() {
    // ── The caller had the same defect the pass did ──
    //
    // `runExtraction` was instrumented so every decline left a trace, and it worked: a chat's
    // counters said `extract:unparseable` and that was enough to find a budget bug three layers
    // down. But the two early returns HERE were never counted, so when a chat advanced seven turns
    // and no counter moved at all, the data could not distinguish "the pass declined" from "the
    // pass was never called" — and the second is the one that was happening.
    //
    // A gate that can stop the whole subsystem has to say when it does.
    if (!isExtractionNeeded()) {
        observe.note('extract:disabled');
        return;
    }
    const settings = foldSettings();
    // ── The interval is a ceiling, not a schedule ──
    //
    // A turn is not a quantity of change: one reply can cross a continent and skip a year, the next
    // is two lines in the same room. Scheduling by turn count treated those identically, so a scene
    // that moved stayed wrong on the panel for up to `interval` turns — measured on a live chat,
    // the location read "the hobgoblin's chamber" three turns after the party had left it.
    const decision = shouldExtract({
        since: state.turnsSinceExtract(),
        // The adaptive interval, not the configured one: the setting is the starting point and the
        // ceiling, while the actual cadence is set by whether the last look found anything.
        interval: state.extractInterval(),
        text: lastExchange(),
        block: state.turnsSinceBlock() === 0,
    });
    if (!decision.run) {
        observe.note('extract:waiting');
        return;
    }
    observe.note(`extract:on-${decision.why.replace(/\s+/g, '-')}`);
    // Stamped before the call, not after. The pass is async and takes seconds; without this, every
    // reply that lands while it is in flight sees the old stamp, passes the gate, and piles up
    // against the `busy` guard.
    state.noteExtracted();

    const result = await runExtraction({
        windowSize: settings.chronicle.window,
        responseLength: settings.chronicle.response_length,
        profileId: settings.chronicle.profile,
        // The reason this pass ran arms the world fragment: only a declared time skip or scene
        // break lets the off-screen world move (FOLD-REDESIGN.md §7.4). The same `why` was already
        // counted above as `extract:on-…`; this is its load-bearing use.
        why: decision.why,
    });
    if (result.ok) {
        // Let the answer set the next question. A pass that found the scene had moved earns a
        // tighter cadence; one that found nothing earns a longer wait.
        const moved = !!result.results?.scene?.fields;
        state.setExtractInterval(nextInterval({ current: state.extractInterval(), changed: moved }));
        const applied = result.results?.events;
        console.debug('[fold] chronicle extraction', applied);
        await eventSource.emit('fold_chronicle_updated', applied);
        return;
    }
    // The missing `else`. A decline is not an error, but it is not nothing either — and silence is
    // how a pass that never succeeded went unnoticed for seventy-four turns.
    console.warn(`[fold] extraction declined: ${result.reason}`);
}

async function renderSettingsUi() {
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $('#fold_container').append(html);

    const settings = foldSettings();

    const bindCheckbox = (selector, get, set) => {
        $(selector).prop('checked', get()).on('input', function () {
            set(!!$(this).prop('checked'));
            saveSettingsDebounced();
        });
    };
    const bindNumber = (selector, get, set) => {
        $(selector).val(get()).on('input', function () {
            const value = Number($(this).val());
            if (Number.isFinite(value)) {
                set(value);
                saveSettingsDebounced();
            }
        });
    };

    $('#fold_rpg_mode').prop('checked', isChronicleEnabled() && isStateEnabled()).on('input', async function () {
        await setRpgMode(!!$(this).prop('checked'));
    });
    bindCheckbox('#fold_panel', () => settings.panel, v => {
        settings.panel = v;
        panel.setVisible(v);
        // The sidebar mounts whenever the state track is on OR the panel is wanted — the expanded
        // panel is the player's own choice, the collapsed rail follows the state switch.
        panel.setStripVisible(isStateEnabled() || v);
    });
    bindCheckbox('#fold_enabled', () => settings.enabled, v => { settings.enabled = v; syncSteerBodyClass(); });
    bindCheckbox('#fold_steer_enabled', () => settings.steer.enabled, v => { settings.steer.enabled = v; syncSteerBodyClass(); });
    bindCheckbox('#fold_steer_remember', () => settings.steer.remember_last, v => { settings.steer.remember_last = v; });
    bindCheckbox('#fold_steer_badge', () => settings.steer.show_badge, v => { settings.steer.show_badge = v; });
    bindCheckbox('#fold_chronicle_enabled', () => settings.chronicle.enabled, v => { settings.chronicle.enabled = v; });

    // The Connection Manager owns profiles, and throws rather than returning when it is disabled.
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#fold_chronicle_profile',
            settings.chronicle.profile,
            (profile) => {
                settings.chronicle.profile = profile?.id ?? '';
                saveSettingsDebounced();
            },
        );
    } catch (error) {
        console.warn('[fold] connection profiles unavailable; extraction will use the chat model', error);
        $('#fold_chronicle_profile_block').hide();
    }

    bindCheckbox('#fold_state_enabled', () => settings.state.enabled, v => { settings.state.enabled = v; });
    bindCheckbox('#fold_state_absorb', () => settings.state.absorb_block, v => { settings.state.absorb_block = v; });
    bindNumber('#fold_state_depth', () => settings.state.depth, v => { settings.state.depth = v; });
    bindNumber('#fold_chronicle_interval', () => settings.chronicle.interval, v => { settings.chronicle.interval = v; });
    bindNumber('#fold_chronicle_window', () => settings.chronicle.window, v => { settings.chronicle.window = v; });
    bindNumber('#fold_chronicle_topk', () => settings.chronicle.top_k, v => { settings.chronicle.top_k = v; });
    bindNumber('#fold_chronicle_depth', () => settings.chronicle.depth, v => { settings.chronicle.depth = v; });

    $('#fold_steer_template').val(settings.steer.template).on('input', function () {
        settings.steer.template = String($(this).val());
        saveSettingsDebounced();
    });
    $('#fold_steer_template_restore').on('click', function () {
        settings.steer.template = DEFAULT_STEER_TEMPLATE;
        $('#fold_steer_template').val(DEFAULT_STEER_TEMPLATE);
        saveSettingsDebounced();
    });
    // The story direction — the one thing that must not be forgotten on the next message. Stored
    // per chat in the fold blob (`plot.js`); editing here or via /fold-plot writes the same field.
    $('#fold_plot_guide').val(plot.text()).on('input', function () {
        plot.set({ text: String($(this).val()), source: 'manual' });
    });
    $('#fold_chronicle_template').val(settings.chronicle.template).on('input', function () {
        settings.chronicle.template = String($(this).val());
        saveSettingsDebounced();
    });
    $('#fold_chronicle_extract_now').on('click', async function () {
        const button = $(this);
        button.prop('disabled', true);
        try {
            const result = await runExtraction({
                windowSize: settings.chronicle.window,
                responseLength: settings.chronicle.response_length,
                profileId: settings.chronicle.profile,
            });
            const applied = result.results?.events;
            toastr.info(result.ok
                ? `Chronicle: +${applied?.added ?? 0} new, ${applied?.duplicates ?? 0} duplicate(s)`
                : `Chronicle extraction did not run: ${result.reason}`);
            await eventSource.emit('fold_chronicle_updated', applied);
        } finally {
            button.prop('disabled', false);
        }
    });
    $('#fold_state_view').on('click', function () {
        const snap = state.snapshot();
        const lines = [];

        if (snap.vitals.length) {
            lines.push('VITALS', ...snap.vitals.map(v => `  ${v.name}  ${Math.round(v.cur)}/${Math.round(v.max)}`), '');
        }
        if (snap.status.length) {
            lines.push('STATUS', `  ${snap.status.join(', ')}`, '');
        }

        lines.push('CARRYING');
        for (const item of snap.inventory) {
            lines.push(`  ${item.fresh ? ' ' : '·'} ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''}`
                + (item.fresh ? '' : `   (stale: ${item.since} events since last mention)`));
            // The audit trail: every quantity traces to the events that produced it, which is what
            // deriving state from the ledger buys over storing it.
            for (const source of item.from) {
                lines.push(`        ${source.dq > 0 ? '+' : ''}${source.dq}  ${source.summary}`);
            }
        }
        if (!snap.inventory.length) {
            lines.push('  (empty)');
        }

        if (snap.rejects.length) {
            lines.push('', 'REJECTED PROPOSALS (the model asked, the merge declined)');
            for (const reject of snap.rejects) {
                lines.push(`  ${String(reject.count).padStart(4)}  ${reject.reason}`);
            }
        }

        toastr.info(`${snap.inventory.length} item(s) carried. See console for the full state.`);
        console.log('[fold] state, derived from the live chronicle\n' + lines.join('\n'));
    });

    $('#fold_state_clear').on('click', async function () {
        const confirmed = await callGenericPopup(
            'Clear tracked state? This removes the deltas from chronicle events, so the summaries stay but the inventory resets.',
            POPUP_TYPE.CONFIRM, '', { okButton: 'Clear', cancelButton: 'Cancel' });
        if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
            chronicle.clearDeltas();
            toastr.info('Tracked state cleared.');
        }
    });

    $('#fold_chronicle_view').on('click', function () {
        const snapshot = chronicle.snapshot();
        const lines = snapshot.events.map(e =>
            `${e.live ? '•' : '◦'} ${e.summary}  [${e.keywords.join(', ')}]${e.hits ? ` ×${e.hits}` : ''}`);
        toastr.info(`${snapshot.live}/${snapshot.total} events live on this branch. See console for the list.`);
        console.log(`[fold] chronicle (${snapshot.total} events, ${snapshot.live} live on this branch)\n` + (lines.join('\n') || '(empty)'));
    });
}

/**
 * Turn everything on with one switch.
 *
 * The failure mode this exists to prevent: a feature that technically works but takes six toggles,
 * a connection profile and four turns before it shows you anything. Everything below is a default
 * that can be changed afterwards, not a decision the user has to make first.
 *
 * @param {boolean} on Whether to enable RPG mode.
 */
export async function setRpgMode(on) {
    const settings = foldSettings();
    settings.enabled = true;
    settings.chronicle.enabled = on;
    settings.state.enabled = on;
    settings.panel = on;

    if (on) {
        // Extract after every reply rather than every fourth, so the panel fills in while the
        // user is still looking at it. Cheap when extraction runs on a small model.
        settings.chronicle.interval = 1;

        // Auto-pick an extraction model so the user is never blocked on setting one up. Prefer
        // something small and cheap — this is mechanical summarization, not roleplay — and fall
        // back to the chat's own model, which always works.
        if (!settings.chronicle.profile) {
            settings.chronicle.profile = pickCheapProfile() ?? '';
        }
    }

    syncSteerBodyClass();
    panel.setVisible(on);
    // The collapsed rail is the panel folded to the right edge (FOLD-REDESIGN.md §8); it follows
    // the mode switch — a folded panel is still a glance away.
    panel.setStripVisible(on);
    saveSettingsDebounced();
    refreshSettingsUi();
}

/**
 * Find a connection profile that looks like a cheap, fast model.
 * @returns {string} A profile id, or '' if none is obviously suitable.
 */
function pickCheapProfile() {
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        const cheap = /mini|nano|flash|lite|haiku|small|turbo/i;
        const match = profiles.find(profile => cheap.test(String(profile.model ?? '')));
        return match?.id ?? '';
    } catch {
        // Connection Manager disabled: extraction falls back to the chat model, which is fine.
        return '';
    }
}

/**
 * Push current settings back into the settings controls, after RPG mode changes several at once.
 */
function refreshSettingsUi() {
    const settings = foldSettings();
    $('#fold_rpg_mode').prop('checked', isChronicleEnabled() && isStateEnabled());
    $('#fold_chronicle_enabled').prop('checked', settings.chronicle.enabled);
    $('#fold_state_enabled').prop('checked', settings.state.enabled);
    $('#fold_panel').prop('checked', !!settings.panel);
    $('#fold_chronicle_interval').val(settings.chronicle.interval);
    $('#fold_chronicle_profile').val(settings.chronicle.profile ?? '');
}

/**
 * Extension entry point, named in manifest.json's hooks.activate.
 */
export async function init() {
    loadSettings();
    await renderSettingsUi();
    syncSteerBodyClass();
    initSteerUi();
    registerFoldSlashCommands();
    initPanel({
        // Closing the panel is a decision, so make the setting follow rather than having it
        // reappear on the next redraw.
        onClose: () => {
            foldSettings().panel = false;
            $('#fold_panel').prop('checked', false);
            saveSettingsDebounced();
        },
        onOpen: () => {
            foldSettings().panel = true;
            $('#fold_panel').prop('checked', true);
            saveSettingsDebounced();
        },
    });
    panel.setVisible(!!foldSettings().panel);
    panel.setStripVisible(isStateEnabled() || !!foldSettings().panel);

    // One probe, not two. State is a fold over the chronicle's own events, so the delta rides on
    // the event that caused it rather than arriving as a parallel structure to be reconciled.
    registerProbe({
        schemaKey: 'events',
        schema: () => chronicle.extractionSchema({
            deltaSchema: isStateEnabled() ? state.deltaSchema() : null,
        }),
        instruction: () => [
            chronicle.extractionInstruction(),
            isStateEnabled() ? state.deltaInstruction() : '',
        ].filter(Boolean).join(' '),
        apply: (fragment, context) => {
            const outcome = chronicle.applyExtraction(fragment, {
                ...context,
                validateDelta: isStateEnabled() ? state.validateDelta : null,
                onRejections: state.noteRejections,
            });
            // ── The credits-without-debit trigger, and why it lives HERE ──
            //
            // It is a question about the whole pass, not about any one event: six items credited
            // across three events with no money delta anywhere is the shape, and only the layer that
            // sees every accepted delta at once can detect it (`state-table.js`
            // `creditsWithoutDebit`). The question is asked on the NEXT pass, because this one has
            // already sent its prompt and a second call is the thing `FOLD-REDESIGN.md` §11 forbids.
            if (isStateEnabled()) {
                state.noteCredits({ accepted: outcome.accepted, refused: outcome.refusals });
            }
            return outcome;
        },
    });

    // A second probe, and the one exception to "state rides on the event that caused it".
    //
    // People and leads are not the *result* of anything that happened — "Maria is reachable by
    // email" is a standing fact a turn happened to reveal — so folding them would mean inventing
    // events whose only content is that something was mentioned. They ride the same extraction
    // call, which costs nothing extra: the model is reading the window either way.
    // A third probe, for the scene itself. Everything fold knew about where and when the story was
    // happening came from parsing a status block, so a card that does not write one produced an
    // empty panel however much the narration established. The prose always had it.
    registerProbe({
        schemaKey: 'scene',
        schema: () => scene.schema(),
        instruction: () => scene.instruction(),
        // Takes the pass context now: the probe's `conditions` answer becomes marks on the pov's
        // row, and a mark is an event, so it needs the window (for the gate) and the newest live
        // source (for the anchor that makes a swipe retract it) — `scene.js` applyExtraction.
        apply: (fragment, context) => scene.applyExtraction(fragment, context),
    });

    // A fourth probe: what is at stake. Rides the same call, so the whole feature costs no extra
    // latency and no extra money — the model is reading the window for the other three regardless.
    //
    // Named `threads` rather than `pressure` since Phase B, because it now answers for the whole
    // stakes table: dials that fill toward trouble, dials that fill toward what the characters
    // want, and threads with no dial at all. `leads` moved off the entity probe into this one for
    // the same reason (`clocks.js` `schema()`).
    registerProbe({
        schemaKey: 'threads',
        schema: () => clocks.schema(),
        instruction: () => clocks.instruction(),
        apply: (fragment, context) => {
            const outcome = clocks.applyExtraction(fragment, context);
            state.noteRejections(outcome.rejected);
            return outcome;
        },
    });

    // The fifth probe, and the centre of the redesign: extraction becomes REVIEW.
    //
    // Every other probe is write-only — asked what is true, with silence about a tracked line
    // meaning nothing. Across all four live chat files, 31 lead rows in three campaigns and ~180
    // assistant turns produced not one `closed` status, because the retraction event is something a
    // narrator never bothers to say (`FOLD-RPG-GAP.md` §1). This one reads the pinned ledger back
    // and returns a disposition per line. Same call as the other four; no new request.
    //
    // Registered LAST so the id index the pinned block built is at its most useful: `ledgerBlock()`
    // runs once per pass before any probe applies, so ordering does not affect the index — but a
    // reader looking for "what closes things" should find it after everything that opens them.
    registerProbe({
        schemaKey: 'review',
        schema: () => reviewSchema(),
        instruction: () => reviewInstruction(),
        apply: (fragment, context) => review.applyExtraction(fragment, {
            ...context,
            // Injected rather than imported, because `review.js` cannot import `state.js` — the
            // pinned block needs `review.pending()`, so the dependency already runs the other way.
            validateDelta: isStateEnabled() ? state.validateDelta : null,
            onContest: state.noteContestAnswer,
            // Same injection, same reason: clearing a mark appends an `st` event through
            // `state.js`, which this module cannot import.
            onClearMark: isStateEnabled() ? state.clearMark : null,
        }),
    });

    registerProbe({
        schemaKey: 'entities',
        schema: () => entities.schema(),
        instruction: () => entities.instruction(),
        apply: (fragment, context) => {
            const outcome = entities.applyExtraction(fragment, context);
            state.noteRejections(outcome.rejected);
            return outcome;
        },
    });

    // The sixth probe, and the one that makes the world move while the player is not watching.
    //
    // Registered LAST so the cast is current when it reads an entity's `wants` at apply time.
    // Rides the same shared call like every other probe; adds no new request — the arming gate
    // in `world.applyExtraction` ignores moves on conversational passes, and the schema is
    // always present so the model returns `{moves: []}` (FOLD-REDESIGN.md §7.4, Gate 3).
    registerProbe({
        schemaKey: 'world',
        schema: () => world.schema(),
        instruction: () => world.instruction(),
        apply: (fragment, context) => {
            const outcome = world.applyExtraction(fragment, context);
            state.noteRejections(outcome.rejected);
            return outcome;
        },
    });

    // The player's own elision moves the clock. Measured: three of twenty-nine player turns skip
    // time explicitly and nothing acted on any of them.
    eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
        if (!isStateEnabled()) {
            return;
        }
        try {
            const outcome = state.noteElapsed(chat?.[Number(messageId)]?.mes ?? '');
            if (outcome.skipped) {
                console.debug(`[fold] the clock advanced ${outcome.minutes} minutes on the player's own say-so`);
                panel.render();
            }
        } catch (error) {
            console.error('[fold] failed to advance the clock', error);
        }
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => {
        onMessageForBlock(messageId);
        void onAssistantMessage();
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        // Nothing to reset any more — the extraction schedule lives in the chat's own metadata, so
        // it follows the chat instead of being cleared by the act of opening one.
        chronicle.invalidateIndex();
        recall.clearActivatedWorldInfo();
    });

    // The plot guide is per-chat, but renderSettingsUi binds the textarea once at page load —
    // potentially before the chat (and its chat_metadata.fold.plot) has arrived. Re-populate the
    // field whenever a chat loads or changes so it never shows stale or empty text. Skip if the
    // user is actively editing it.
    const refreshPlotGuideInput = () => {
        const input = $('#fold_plot_guide');
        if (input.length && document.activeElement !== input[0]) {
            input.val(plot.text());
        }
    };
    eventSource.on(event_types.CHAT_LOADED, refreshPlotGuideInput);
    eventSource.on(event_types.CHAT_CHANGED, refreshPlotGuideInput);

    // World Info tells us what it is about to inject so recall can avoid paying tokens to repeat
    // it. This is the real activation set for the real scan — never trigger a scan of our own.
    //
    // It fires *after* generation interceptors, so the block written there was selected against a
    // stale covered set. Re-select now, while there is still time before the prompt is assembled.
    // The event does not fire when nothing activates, in which case there is nothing to suppress
    // and the interceptor's block already stands.
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, (entries) => {
        recall.noteActivatedWorldInfo(entries);
        if (pendingPlan && isChronicleEnabled()) {
            try {
                applyRecallBlock(recall.select(pendingPlan));
            } catch (error) {
                console.error('[fold] recall re-selection failed', error);
            }
        }
    });

    // A free boot assertion that the vendored mirror of HashTrinity.lean still holds.
    // If the algebra ever drifts, this is the first thing that says so.
    console.debug(`[${MODULE_NAME}]`, self_test());
}

// Named in manifest.generate_interceptor.
globalThis.fold_interceptGeneration = interceptGeneration;
