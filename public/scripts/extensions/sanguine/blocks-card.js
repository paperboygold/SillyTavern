/**
 * fold/blocks-card.js: the state card under the latest reply, wired.
 *
 * Adopted from Megumin's block card: the derived state rendered in-context, under the reply that
 * produced it, instead of only in the sidebar panel. What it draws is exactly what the panel
 * draws, `state.snapshot()` and `clocks.sections()`, so the two surfaces cannot disagree; the one
 * thing the panel does not have is the scene probe's `choices`, rendered as buttons that fill the
 * send box. Two rules, both borrowed: never rewrite `mes` (the card is DOM-only, so swipes, edits
 * and the extractor keep seeing the model's own words) and fail silent (an empty view renders no
 * card at all). The renderer is pure (`card-html.js`) and unit-tested in node; this wiring is thin.
 *
 * @cite ../Megumin-Suite/src/blocks/render.js the block card
 * @cite ../Megumin-Suite/src/features/blocks/chat.js re-sweeping the card over message-churn events
 */

import { eventSource, event_types } from '../../../script.js';
import { extension_settings } from '../../extensions.js';
import * as clocks from './clocks.js';
import * as entities from './entities.js';
import { lastChoices } from './choices.js';
import * as state from './state.js';
import { buildCardHtml } from './card-html.js';

export { buildCardHtml };

/** The card's element id, so a re-render replaces rather than stacks. */
const CARD_ID = 'sanguine_state_card';

/** Scene context labels the card shows as chips. */
const SCENE_LABELS = ['time', 'date', 'location', 'weather', 'pov'];

/**
 * The current data the card draws, the same sources the panel uses.
 * @returns {object} A card view.
 */
export function cardView() {
    const snapshot = state.snapshot();
    const scene = {};
    for (const field of snapshot.context ?? []) {
        if (SCENE_LABELS.includes(field.label)) {
            scene[field.label] = field.value;
        }
    }
    const sections = clocks.sections(entities.turn(), scene.location ?? '');
    return {
        scene,
        vitals: snapshot.vitals,
        conditions: snapshot.status,
        inventory: snapshot.inventory,
        threads: { pressure: sections.pressure, progress: sections.progress, open: sections.open },
        choices: lastChoices(),
    };
}

/** The latest AI message element, the only place the card belongs. @returns {HTMLElement|null} */
function latestAiMes() {
    const nodes = document.querySelectorAll('#chat .mes');
    for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node.getAttribute('is_user') !== 'true' && node.getAttribute('is_system') !== 'true') {
            return node;
        }
    }
    return null;
}

/**
 * A choice button's action: fill the send box, and send directly on shift-click.
 * @param {Event} event The click.
 */
function onChoiceClick(event) {
    const button = event.target.closest('[data-sanguine-choice]');
    if (!button) return;
    event.preventDefault();
    const text = button.getAttribute('data-sanguine-choice') ?? '';
    const textarea = document.querySelector('#send_textarea');
    if (!textarea) return;
    textarea.value = text;
    if (event.shiftKey) {
        document.querySelector('#send_but')?.click();
    } else {
        textarea.focus();
    }
}

/**
 * Draw the card under the latest AI reply, replacing any previous one.
 * A no-op when the card is disabled or the view has nothing to say; the reply's stored text is
 * never touched. The card is a TOP-LEVEL child of `#chat`, a sibling just after the message,
 * never inside `.mes`, which is a flex row (avatar + content) and would squash the card against
 * the message text. A swipe or edit that rebuilds the chat drops it and the next refresh redraws.
 */
export function renderStateCard() {
    document.getElementById(CARD_ID)?.remove();
    if (extension_settings?.sanguine?.card?.enabled === false) {
        return;
    }
    const target = latestAiMes();
    if (!target) return;
    const html = buildCardHtml(cardView());
    if (!html) return;
    const node = document.createElement('div');
    node.id = CARD_ID;
    node.innerHTML = html;
    node.addEventListener('click', onChoiceClick);
    // `after`, not `appendChild`: the card must sit beside the message in the chat column, not
    // inside its flex row.
    target.after(node);
}

/** Re-draw on a short delay, so SillyTavern's own re-render of the message lands first. */
let cardTimer = 0;
function scheduleCard() {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(() => renderStateCard(), 80);
}

/**
 * Wire the card to the same events that refresh the panel, plus the message-churn events that
 * rebuild the DOM and would drop a previously appended card.
 */
export function registerStateCard() {
    const refresh = () => scheduleCard();
    for (const name of ['CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MORE_MESSAGES_LOADED', 'GENERATION_ENDED']) {
        const type = event_types[name];
        if (type) eventSource.on(type, refresh);
    }
    eventSource.on('sanguine_chronicle_updated', refresh);
    eventSource.on(event_types.CHAT_CHANGED, refresh);
}
