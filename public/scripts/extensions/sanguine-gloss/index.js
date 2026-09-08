/**
 * sanguine-gloss — Interactive character/compound hover translation & reading modes.
 *
 * Implements sanguinehost.com-style multi-tiered glossary hover popovers and interlinear
 * reading modes for Chinese, Wuxia, and cultivation roleplay text.
 *
 * One structure (the K -> V table), one operation (`insert_with`), and `merge_b` for lookup.
 */

import { castTerms } from './cast-terms.js';
import {
    chat_metadata,
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandArgument } from '../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { t } from '../../i18n.js';
import {
    clearContextTerms,
    registerBatchContext,
    getGlossEntry,
    rebuildActiveTrie,
    registerContextTerm,
} from './lexicon.js';
import {
    glossElement,
    initGlossDom,
    READING_MODES,
} from './gloss.js';

export const MODULE_NAME = 'sanguine_gloss';

const defaultSettings = Object.freeze({
    enabled: true,
    mode: READING_MODES.HOVER,
    enable_wuxia: true,
    enable_common: true,
    custom_terms: {},
});

/**
 * Access live extension settings.
 * @returns {typeof defaultSettings}
 */
export function glossSettings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }
}

/**
 * Process all currently visible chat message bodies.
 */
export function processAllChatMessages() {
    const settings = glossSettings();
    if (!settings?.enabled) return;

    $('#chat .mes .mes_text').each(function () {
        glossElement(this, settings.mode);
    });
}

/**
 * Process a single message DOM node by message id.
 * @param {number} messageId
 */
function processMessage(messageId) {
    const settings = glossSettings();
    if (!settings?.enabled) return;

    const el = $(`#chat .mes[mesid="${messageId}"] .mes_text`)[0];
    if (el) {
        glossElement(el, settings.mode);
    }
}

async function renderSettingsUi() {
    const html = await renderExtensionTemplateAsync('sanguine-gloss', 'settings');
    const container = $('#sanguine_gloss_container');
    if (container.length) {
        container.append(html);
    } else {
        $('#sanguine_container, #sanguine_container').append(html);
    }

    const settings = glossSettings();

    $('#sanguine_gloss_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
        if (settings.enabled) {
            processAllChatMessages();
        }
    });

    $('#sanguine_gloss_mode').val(settings.mode).on('change', function () {
        settings.mode = String($(this).val());
        saveSettingsDebounced();
        // Clear existing gloss spans and re-render with new mode
        processAllChatMessages();
    });

    $('#sanguine_gloss_wuxia').prop('checked', settings.enable_wuxia).on('input', function () {
        settings.enable_wuxia = !!$(this).prop('checked');
        saveSettingsDebounced();
        rebuildActiveTrie({
            enableWuxia: settings.enable_wuxia,
            enableCommon: settings.enable_common,
            customTerms: settings.custom_terms,
        });
        processAllChatMessages();
    });

    $('#sanguine_gloss_common').prop('checked', settings.enable_common).on('input', function () {
        settings.enable_common = !!$(this).prop('checked');
        saveSettingsDebounced();
        rebuildActiveTrie({
            enableWuxia: settings.enable_wuxia,
            enableCommon: settings.enable_common,
            customTerms: settings.custom_terms,
        });
        processAllChatMessages();
    });

    $('#sanguine_gloss_add_term').on('click', function () {
        const term = String($('#sanguine_gloss_new_term').val() ?? '').trim();
        const say = String($('#sanguine_gloss_new_say').val() ?? '').trim();
        const mean = String($('#sanguine_gloss_new_mean').val() ?? '').trim();
        const more = String($('#sanguine_gloss_new_more').val() ?? '').trim();

        if (!term || !mean) {
            toastr.warning(t`Please provide both a Hanzi term and an English meaning.`);
            return;
        }

        const entry = { mean, ...(say && { say }), ...(more && { more }) };
        settings.custom_terms[term] = entry;
        registerContextTerm(term, entry);
        saveSettingsDebounced();

        $('#sanguine_gloss_new_term').val('');
        $('#sanguine_gloss_new_say').val('');
        $('#sanguine_gloss_new_mean').val('');
        $('#sanguine_gloss_new_more').val('');

        toastr.success(t`Added custom gloss term: ${term}`);
        processAllChatMessages();
    });

    $('#sanguine_gloss_reprocess').on('click', function () {
        processAllChatMessages();
        toastr.info(t`Re-scanned chat messages for glossary terms.`);
    });
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gloss',
        callback: (args, text) => {
            const query = String(text ?? '').trim();
            if (!query) {
                toastr.info(t`Usage: /gloss <Chinese term>`);
                return '';
            }
            const entry = getGlossEntry(query);
            if (entry) {
                const info = `${query} [${entry.say || ''}]: ${entry.mean}`;
                toastr.info(info);
                return info;
            }
            toastr.warning(t`No gloss entry found for: ${query}`);
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Chinese term to look up`,
                typeList: ['string'],
                isRequired: true,
            }),
        ],
        helpString: t`Look up a Chinese or Wuxia term in the active Sanguine Gloss lexicon.`,
    }));
}

/**
 * Feed the tracker's own names into the context tier.
 *
 * Read straight off `chat_metadata`, not through an import: sanguine and sanguine-gloss are
 * separate extensions and either may be absent. A missing tracker is the ordinary case for a
 * non-CJK story and leaves the gloss exactly as it was.
 *
 * Re-harvested on every chat change because the cast is per-chat, and `clearContextTerms` has just
 * emptied the tier — the pairing is cheap and always current.
 */
function harvestCastTerms() {
    try {
        const cast = chat_metadata?.sanguine?.state?.cast;
        if (!cast) return;
        const terms = castTerms(cast);
        const count = Object.keys(terms).length;
        if (!count) return;
        registerBatchContext(terms);
        console.debug(`[${MODULE_NAME}] ${count} names from the cast`);
    } catch (error) {
        // A gloss that throws would take the chat render with it; a gloss that skips a tier is a
        // gloss with fewer entries.
        console.debug(`[${MODULE_NAME}] cast harvest skipped:`, error?.message);
    }
}

/**
 * Extension entry point.
 */
export async function init() {
    loadSettings();
    initGlossDom();

    const settings = glossSettings();
    rebuildActiveTrie({
        enableWuxia: settings.enable_wuxia,
        enableCommon: settings.enable_common,
        customTerms: settings.custom_terms,
    });

    await renderSettingsUi();
    registerSlashCommands();

    // Hook message render events
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        processMessage(mesId);
    });

    eventSource.on(event_types.USER_MESSAGE_RENDERED, (mesId) => {
        processMessage(mesId);
    });

    eventSource.on(event_types.MESSAGE_UPDATED, (mesId) => {
        processMessage(mesId);
    });


    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearContextTerms();
        harvestCastTerms();
        setTimeout(() => processAllChatMessages(), 100);
    });

    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
        setTimeout(() => processAllChatMessages(), 100);
    });

    console.debug(`[${MODULE_NAME}] Sanguine Gloss ready`);
}
