/**
 * fold/panel.js — the tracker panel.
 *
 * The point of tracking state is seeing it while you play. Everything else in this extension is
 * plumbing for this surface: if the numbers only exist in a console dump, the feature does not
 * exist.
 *
 * Follows SillyTavern's own moving-panel convention (`#movingDivs`, `panelControlBar`,
 * `drag-grabber`, `dragElement`) so it drags, resizes and remembers its position exactly like the
 * Author's Note and World Info panels, rather than being a bolted-on div with its own rules.
 */

import { eventSource, event_types } from '../../../script.js';
import { dragElement } from '../../RossAscends-mods.js';
import { loadMovingUIState } from '../../power-user.js';
import { t } from '../../i18n.js';
import * as state from './state.js';

const PANEL_ID = 'sanguineTracker';

let visible = false;
let onToggleOff = () => {};

/**
 * Build the panel markup, matching the structure SillyTavern's own floating panels use.
 * @returns {HTMLElement} The panel element.
 */
function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('drawer-content', 'flexGap5');

    const bar = document.createElement('div');
    bar.classList.add('panelControlBar', 'flex-container', 'alignItemsBaseline');

    const grabber = document.createElement('div');
    grabber.id = `${PANEL_ID}header`;
    grabber.classList.add('fa-fw', 'fa-solid', 'fa-grip', 'drag-grabber');
    bar.appendChild(grabber);

    const close = document.createElement('div');
    close.id = `${PANEL_ID}Close`;
    close.classList.add('fa-fw', 'fa-solid', 'fa-circle-xmark', 'floating_panel_close');
    close.title = t`Close`;
    close.addEventListener('click', () => {
        hide();
        onToggleOff();
    });
    bar.appendChild(close);

    panel.appendChild(bar);

    const body = document.createElement('div');
    body.classList.add('fold_tracker_body', 'scrollY');
    panel.appendChild(body);

    return panel;
}

/**
 * @returns {HTMLElement|null} The panel body, if the panel exists.
 */
function body() {
    return document.querySelector(`#${PANEL_ID} .fold_tracker_body`);
}

const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
};

/**
 * Redraw from derived state. Cheap enough to run on every message: the fold is over at most a few
 * hundred events, and the alternative is a cache that can disagree with the ledger.
 */
export function render() {
    const target = body();
    if (!target || !visible) {
        return;
    }

    const snapshot = state.snapshot();
    target.replaceChildren();

    // Left-aligned so it clears the control bar, which SillyTavern positions absolutely over the
    // panel's top-right corner.
    target.appendChild(el('div', 'fold_tracker_title', t`Tracker`));

    for (const vital of snapshot.vitals) {
        const row = el('div', 'fold_vital');
        const head = el('div', 'fold_vital_head');
        head.appendChild(el('span', 'fold_vital_name', vital.name));
        head.appendChild(el('span', 'fold_vital_num', `${Math.round(vital.cur)}/${Math.round(vital.max)}`));
        row.appendChild(head);

        const bar = el('div', 'fold_bar');
        const fill = el('span');
        const ratio = vital.max > 0 ? Math.max(0, Math.min(1, vital.cur / vital.max)) : 0;
        fill.style.width = `${ratio * 100}%`;
        // Colour carries the same information as the number, so a glance is enough.
        fill.classList.add(ratio <= 0.25 ? 'critical' : ratio <= 0.5 ? 'low' : 'ok');
        bar.appendChild(fill);
        row.appendChild(bar);
        target.appendChild(row);
    }

    if (snapshot.status.length) {
        const flags = el('div', 'fold_flags');
        for (const flag of snapshot.status) {
            flags.appendChild(el('span', 'fold_flag', flag));
        }
        target.appendChild(flags);
    }

    const carried = snapshot.inventory.filter(item => item.fresh);
    if (carried.length) {
        target.appendChild(el('div', 'fold_section', t`Carrying`));
        const list = el('div', 'fold_items');
        for (const item of carried) {
            const row = el('div', 'fold_item');
            row.appendChild(el('span', 'fold_item_name', item.name));
            if (item.qty > 1) {
                row.appendChild(el('span', 'fold_item_qty', `×${item.qty}`));
            }
            // Why you have it — the audit trail the fold gives for free.
            if (item.from?.length) {
                row.title = item.from.map(f => `${f.dq > 0 ? '+' : ''}${f.dq}  ${f.summary}`).join('\n');
            }
            list.appendChild(row);
        }
        target.appendChild(list);
    }

    if (!snapshot.vitals.length && !snapshot.status.length && !carried.length) {
        target.appendChild(el('div', 'fold_empty',
            t`Nothing tracked yet. It fills in as the story establishes what you have and how you are.`));
    }
}

/**
 * Show the panel.
 *
 * Uses a class rather than jQuery's show(), which writes an inline `display: block` that beats the
 * stylesheet's `display: flex` and collapses the layout into stacked blocks.
 */
export function show() {
    visible = true;
    document.getElementById(PANEL_ID)?.classList.add('fold_open');
    render();
}

/** Hide the panel. */
export function hide() {
    visible = false;
    document.getElementById(PANEL_ID)?.classList.remove('fold_open');
}

/**
 * Show or hide.
 * @param {boolean} next Whether it should be visible.
 */
export function setVisible(next) {
    if (next) {
        show();
    } else {
        hide();
    }
}

/** @returns {boolean} Whether the panel is currently shown. */
export function isVisible() {
    return visible;
}

/**
 * Create the panel and wire it to the events that change state.
 * @param {object} options Options.
 * @param {() => void} [options.onClose] Called when the user closes the panel, so the setting can follow.
 */
export function initPanel({ onClose = () => {} } = {}) {
    if (document.getElementById(PANEL_ID)) {
        return;
    }
    onToggleOff = onClose;

    const host = document.getElementById('movingDivs') ?? document.body;
    host.appendChild(buildPanel());

    // Same treatment SillyTavern gives its own panels, so Moving UI position persists.
    dragElement($(`#${PANEL_ID}`));
    loadMovingUIState();

    // State is derived, so anything that changes which events are live changes what is shown —
    // including swipes, which is the whole point of deriving rather than storing.
    const redraw = () => render();
    for (const type of [
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.MESSAGE_SWIPE_DELETED,
        event_types.MESSAGE_EDITED,
        event_types.CHAT_CHANGED,
        event_types.MORE_MESSAGES_LOADED,
    ]) {
        if (type) {
            eventSource.on(type, redraw);
        }
    }
    // Emitted after an extraction lands, which is when new deltas appear.
    eventSource.on('fold_chronicle_updated', redraw);
}
