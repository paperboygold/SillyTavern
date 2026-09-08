/**
 * fold/ui.js: the wand button, the inline steer bar, and the badge.
 *
 * Visibility of the controls is handled entirely in style.css (gated on `.last_mes` and
 * `body.fold-steer-enabled`), so there is no per-message show/hide bookkeeping here. All
 * bindings are delegated on `.last_mes`, mirroring how core binds `.swipe_right`.
 */

import { chat, eventSource, event_types } from '../../../script.js';
import { t } from '../../i18n.js';
// Read from the settings bag directly, NOT imported from index.js.
//
// index.js imports this module to mount the steering UI, so importing back from it closes a cycle.
// It happens to work, ES modules hoist function declarations, but it works by accident, and the
// same pattern already had to be removed from slash-commands.js once. The settings key is the
// stable thing here; `foldSettings()` is just a lookup on it.
import { extension_settings } from '../../extensions.js';

const MODULE_NAME = 'sanguine';

/** @returns {object} This extension's settings bag. */
const foldSettings = () => extension_settings[MODULE_NAME] ?? {};

/** @returns {boolean} True when both the extension and steering are on. */
const isSteerEnabled = () => {
    const settings = foldSettings();
    return !!settings?.enabled && !!settings?.steer?.enabled;
};
import { isSteered, steerForMessage } from './steer-table.js';
import { requestSteer } from './steer.js';

/**
 * Resolve the message id that owns a DOM node inside a `.mes` block.
 * @param {HTMLElement} element Any element inside a message.
 * @returns {number} The message id, or NaN.
 */
function mesIdOf(element) {
    return Number($(element).closest('.mes').attr('mesid'));
}

function barFor(mesId) {
    return $(`#chat .mes[mesid="${mesId}"] .sanguine_steer_bar`);
}

function openSteerBar(mesId) {
    const settings = foldSettings();
    const bar = barFor(mesId);
    const input = bar.find('.sanguine_steer_input');

    if (settings.steer.remember_last && settings.steer.last_instruction && !String(input.val())) {
        input.val(settings.steer.last_instruction);
    }

    bar.removeClass('sanguine_hidden');
    input.trigger('focus').trigger('select');
}

function closeSteerBar(mesId) {
    barFor(mesId).addClass('sanguine_hidden');
}

async function submitSteer(mesId) {
    const bar = barFor(mesId);
    const input = bar.find('.sanguine_steer_input');
    const text = String(input.val() ?? '').trim();

    if (!text) {
        toastr.info(t`Type an instruction to steer the reply.`);
        return;
    }

    closeSteerBar(mesId);
    input.val('');

    await requestSteer(mesId, text, { source: 'ui' });
}

/**
 * Show a badge on messages whose currently displayed swipe was steered, so the provenance
 * is visible without opening the swipe picker.
 */
function refreshBadges() {
    const settings = foldSettings();

    $('#chat .mes').each(function () {
        const element = $(this);
        element.find('.sanguine_steer_badge').remove();

        if (!settings?.steer?.show_badge || !isSteerEnabled()) {
            return;
        }

        const mesId = Number(element.attr('mesid'));
        const message = chat[mesId];

        if (!message) {
            return;
        }

        const steer = steerForMessage(message, message.swipe_id ?? 0);

        if (!isSteered(steer)) {
            return;
        }

        const badge = document.createElement('i');
        badge.classList.add('sanguine_steer_badge', 'fa-solid', 'fa-wand-magic-sparkles');
        // Never innerHTML: the instruction is user input.
        badge.title = t`Steered:` + ' ' + steer.text;
        element.find('.ch_name .flex-container.alignItemsBaseline').first().append(badge);
    });
}

/**
 * Wire up the steering UI. Called once from init().
 */
export function initSteerUi() {
    $(document).on('click', '.last_mes .mes_steer', function () {
        const mesId = mesIdOf(this);
        const bar = barFor(mesId);
        bar.hasClass('sanguine_hidden') ? openSteerBar(mesId) : closeSteerBar(mesId);
    });

    $(document).on('click', '.last_mes .sanguine_steer_send', async function () {
        await submitSteer(mesIdOf(this));
    });

    $(document).on('click', '.last_mes .sanguine_steer_cancel', function () {
        closeSteerBar(mesIdOf(this));
    });

    $(document).on('keydown', '.last_mes .sanguine_steer_input', async function (event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            await submitSteer(mesIdOf(this));
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            closeSteerBar(mesIdOf(this));
        }
    });

    const refresh = () => refreshBadges();

    // MESSAGE_SWIPED is the right hook HERE (a badge tracks whichever swipe is displayed), but
    // note it fires during navigation, BEFORE generation, it is not a commit hook, and must not
    // be used to write steering data. Persistence rides saveReply's structuredClone instead.
    for (const type of [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPE_DELETED,
        event_types.CHAT_CHANGED,
        event_types.MORE_MESSAGES_LOADED,
    ]) {
        if (type) {
            eventSource.on(type, refresh);
        }
    }

    console.debug(`[${MODULE_NAME}] steering UI ready`);
}
