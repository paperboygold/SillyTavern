/**
 * fold/steer.js — the single entry point for every steering surface.
 *
 * Every route into steering (the wand button, /steer, /swipe <instruction>) funnels through
 * requestSteer(), so the guards, the template rendering and the persistence shape are defined
 * exactly once.
 */

import { chat, isMessageSwipeable, isSwipingAllowed, saveSettingsDebounced, swipe } from '../../../script.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../constants.js';
import { t } from '../../i18n.js';
import { foldSettings, isSteerEnabled, MODULE_NAME } from './index.js';
import { FOLD_STEER_DIRECTION, renderSteerTemplate } from './steer-table.js';

/**
 * Generate a new swipe under an explicit instruction, preserving every existing swipe.
 *
 * @param {number} mesId The message to steer.
 * @param {string} instruction The user's raw instruction.
 * @param {object} [options] Options.
 * @param {string} [options.source] Which surface issued this: 'ui' | 'slash' | 'swipe_cmd'.
 * @returns {Promise<boolean>} True if a generation was started.
 */
export async function requestSteer(mesId, instruction, { source = 'ui' } = {}) {
    const text = String(instruction ?? '').trim();

    if (!text) {
        toastr.info(t`Type an instruction to steer the reply.`);
        return false;
    }

    if (!isSteerEnabled()) {
        toastr.warning(t`Swipe steering is disabled in the Fold settings.`);
        return false;
    }

    const message = chat[mesId];

    if (!message) {
        console.warn(`[${MODULE_NAME}] steer requested for a message that does not exist:`, mesId);
        return false;
    }

    // Steering deliberately obeys the same guards as a manual swipe: last message only, and
    // never while a generation is in flight. SWIPE_SOURCE.STEER is not in swipe()'s bypass list.
    if (!isSwipingAllowed() || !isMessageSwipeable(mesId, message)) {
        toastr.warning(t`Only the last reply can be steered, and not while generating.`);
        return false;
    }

    const settings = foldSettings();
    const rendered = renderSteerTemplate(settings.steer.template, text);

    if (settings.steer.remember_last) {
        settings.steer.last_instruction = text;
        saveSettingsDebounced();
    }

    if (!Array.isArray(message.swipes)) {
        // ensureSwipes() runs inside swipe() itself; this is only so forceSwipeId below is sane
        // for a message that has never been swiped.
        message.swipes = [message.mes];
        message.swipe_id = 0;
    }

    const steerRecord = {
        text,
        direction: FOLD_STEER_DIRECTION.STEER,
        at: Date.now(),
        template: settings.steer.template,
        source,
    };

    await swipe(null, SWIPE_DIRECTION.RIGHT, {
        source: SWIPE_SOURCE.STEER,
        forceMesId: mesId,
        // Forcing the id to one-past-the-end lands us in the overswipe branch regardless of
        // which swipe is currently displayed, so steering always APPENDS and never overwrites.
        forceSwipeId: message.swipes.length,
        generateOptions: { quiet_prompt: rendered, quietToLoud: true },
        newSwipeExtra: {
            sanguine_steer: steerRecord,
            fold_steer: steerRecord,
        },
    });

    return true;
}
