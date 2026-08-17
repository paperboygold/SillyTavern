/**
 * Sanguine — Scribe's ideas, ported onto the hashtrinity basis.
 *
 * One structure (the K -> V table), one operation (`insert_with`), and the merge is the only
 * freedom. See ./lib/hash.js for the algebra and SCRIBE-PORT.md for what is being ported and why.
 *
 * Shipping: Pillar C (directed retry) and Pillar D (the chronicle ledger).
 * Designed, not yet built: recall fusion (Accumulator face), status & inventory.
 */

import {
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
import { registerFoldSlashCommands, registerSanguineSlashCommands } from './slash-commands.js';
import * as chronicle from './chronicle.js';
import * as recall from './recall.js';
import * as state from './state.js';
import * as panel from './panel.js';
import { initPanel } from './panel.js';
import { registerProbe, runExtraction } from './extract.js';

export const MODULE_NAME = 'sanguine';

/**
 * Injection key. `getExtensionPrompt` sorts keys alphabetically, which is why the built-ins are
 * numbered (1_memory, 2_floating_prompt, 3_vectors, 4_vectors_data_bank). 5_ puts the chronicle
 * after them. When recall fusion lands it takes over the contents of this same key.
 */
const RECALL_INJECT_KEY = '5_sanguine_recall';

/**
 * State sits closer to the response than recall does — 6_ sorts after 5_, and it is injected at a
 * shallower depth. What the character is carrying right now matters more to the next sentence
 * than what happened three scenes ago.
 */
const STATE_INJECT_KEY = '6_sanguine_state';

const DEFAULT_STEER_TEMPLATE = '[Instruction for the next reply: {{instruction}}]';
const DEFAULT_CHRONICLE_TEMPLATE = 'Relevant past events:\n{{text}}';

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
        response_length: 800,
    }),
});

/** Assistant messages seen since the last extraction, for the current chat. */
let sinceExtract = 0;

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
export function sanguineSettings() {
    return extension_settings[MODULE_NAME];
}
export const foldSettings = sanguineSettings;

/**
 * Is swipe steering currently available?
 * @returns {boolean} True if both the extension and the steer feature are enabled.
 */
export function isSteerEnabled() {
    const settings = sanguineSettings();
    return !!settings?.enabled && !!settings?.steer?.enabled;
}

/**
 * Is the chronicle currently active?
 * @returns {boolean} True if both the extension and the chronicle are enabled.
 */
export function isChronicleEnabled() {
    const settings = sanguineSettings();
    return !!settings?.enabled && !!settings?.chronicle?.enabled;
}

/**
 * Is state tracking active?
 * @returns {boolean} True if both the extension and state tracking are enabled.
 */
export function isStateEnabled() {
    const settings = sanguineSettings();
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
        extension_settings[MODULE_NAME] = extension_settings.fold && typeof extension_settings.fold === 'object'
            ? { ...extension_settings.fold }
            : {};
    }
    const settings = extension_settings[MODULE_NAME];
    for (const key of ['enabled', 'panel']) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
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
    const enabled = isSteerEnabled();
    document.body.classList.toggle('sanguine-steer-enabled', enabled);
    document.body.classList.toggle('fold-steer-enabled', enabled);
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
    setExtensionPrompt(RECALL_INJECT_KEY, '', extension_prompt_types.IN_CHAT, settings.chronicle.depth, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(STATE_INJECT_KEY, '', extension_prompt_types.IN_CHAT, settings.state.depth, false, extension_prompt_roles.SYSTEM);
    pendingPlan = null;
    creditedThisGeneration = new Set();

    if (type === 'quiet') {
        return;
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
async function onAssistantMessage() {
    if (!isExtractionNeeded()) {
        return;
    }
    const settings = foldSettings();
    sinceExtract += 1;
    if (sinceExtract < Math.max(1, settings.chronicle.interval)) {
        return;
    }
    sinceExtract = 0;

    const result = await runExtraction({
        windowSize: settings.chronicle.window,
        responseLength: settings.chronicle.response_length,
        profileId: settings.chronicle.profile,
    });
    if (result.ok) {
        const applied = result.results?.events;
        console.debug('[fold] chronicle extraction', applied);
        await eventSource.emit('fold_chronicle_updated', applied);
    }
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
    bindCheckbox('#fold_panel', () => settings.panel, v => { settings.panel = v; panel.setVisible(v); });
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
    registerSanguineSlashCommands();
    initPanel({
        // Closing the panel is a decision, so make the setting follow rather than having it
        // reappear on the next redraw.
        onClose: () => {
            sanguineSettings().panel = false;
            $('#fold_panel, #sanguine_panel').prop('checked', false);
            saveSettingsDebounced();
        },
    });
    panel.setVisible(!!sanguineSettings().panel);

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
        apply: (fragment, context) => chronicle.applyExtraction(fragment, {
            ...context,
            validateDelta: isStateEnabled() ? state.validateDelta : null,
            onRejections: state.noteRejections,
        }),
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => void onAssistantMessage());
    eventSource.on(event_types.CHAT_CHANGED, () => {
        sinceExtract = 0;
        chronicle.invalidateIndex();
        recall.clearActivatedWorldInfo();
    });

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
                console.error('[sanguine] recall re-selection failed', error);
            }
        }
    });

    // A free boot assertion that the vendored mirror of HashTrinity.lean still holds.
    // If the algebra ever drifts, this is the first thing that says so.
    console.debug(`[${MODULE_NAME}]`, self_test());
}

// Named in manifest.generate_interceptor.
globalThis.sanguine_interceptGeneration = interceptGeneration;
globalThis.fold_interceptGeneration = interceptGeneration;
