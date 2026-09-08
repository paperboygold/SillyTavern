/**
 * fold/overlay-audit.js, the Audit tab: the deep audit's pending questions, clickable.
 *
 * The judgement half is `audit-table.js` (the exact detectors + `opForVerdict`); this is the DOM.
 * It renders `audit.questions()` (staleness, capacity, identity, conservation and duplicate
 * findings the model call did not resolve) as cards with real buttons, and each click resolves
 * through the SAME fold write the model call makes (`audit.resolveQuestion`).
 *
 * Never in fiction.
 *
 * The audit's questions are machinery, not narrative. Nothing here generates prose; the answers
 * land in the row table and the projection, and the fiction stays clean.
 */

import * as audit from './audit.js';
import * as entities from './entities.js';
import { registerTab } from './overlay.js';
import { t } from '../../i18n.js';

const STYLE_ID = 'sanguine-overlay-audit-css';

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** @param {string} className @param {string} label @param {(e: MouseEvent) => void} onClick */
function button(className, label, onClick) {
    const node = el('button', className, label);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) return;
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-repairs.css', import.meta.url).href;
    document.head.appendChild(link);
}
ensureStylesheet();

/** One pending question as a card. A capacity overload is a WARNING: it has no per-row verdict;
 * the staleness questions (over time) are what trim the list, so the card carries no buttons. */
function questionCard(suspect, refresh) {
    const card = el('div', 'sanguine_rep_card');
    const head = el('div', 'sanguine_rep_card_head', suspectLine(suspect));
    card.appendChild(head);
    if (suspect.kind === 'capacity') {
        card.appendChild(el('div', 'sanguine_rep_empty', t`This is a warning, not a question: the carried list is over a person's practical load. As turns pass, fold will ask about the items it stops seeing, and answering "gone" there trims the list.`));
        return card;
    }
    const actions = el('div', 'sanguine_rep_actions');
    const now = entities.turn();
    const resolve = (verdict, fields = {}) => {
        if (audit.resolveQuestion(questionKey(suspect), verdict, { now, ...fields })) refresh();
    };
    actions.appendChild(button('sanguine_rep_btn', t`Keep`, () => resolve('keep')));
    actions.appendChild(button('sanguine_rep_btn sanguine_rep_btn_warn', t`Gone`, () => resolve('gone', { evidence: 'answered in the audit tab' })));
    if (suspect.kind === 'identity' || suspect.kind === 'duplicate') {
        actions.appendChild(button('sanguine_rep_btn', t`Same`, () => resolve('same', { evidence: 'answered in the audit tab' })));
        actions.appendChild(button('sanguine_rep_btn', t`Different`, () => resolve('different')));
    }
    if (suspect.kind === 'conservation') {
        actions.appendChild(button('sanguine_rep_btn', t`Use story's number`, () => resolve('set', { evidence: 'answered in the audit tab' })));
    }
    actions.appendChild(button('sanguine_rep_btn', t`Rename…`, () => {
        const to = window.prompt(t`What is it actually called?`);
        if (to) resolve('rename', { at: to, evidence: 'answered in the audit tab' });
    }));
    actions.appendChild(button('sanguine_rep_btn', t`Split…`, () => {
        const raw = window.prompt(t`This name is several things. List them comma-separated, e.g. "tactical bag, thinkpad, audit usbs, maps, lockbox keycard, ammo"`);
        if (raw) resolve('split', { at: raw, evidence: 'answered in the audit tab' });
    }));
    actions.appendChild(button('sanguine_rep_btn', t`Move…`, () => {
        const at = window.prompt(t`Where is it now?`);
        if (at) resolve('move', { at, evidence: 'answered in the audit tab' });
    }));
    card.appendChild(actions);
    return card;
}

/** One question as it reads on its line, mirroring `audit-table.js` `face`. */
function suspectLine(s) {
    if (s.kind === 'stale') return t`${s.name} (${s.place}), last touched ${s.ago} turns ago. Still there?`;
    if (s.kind === 'capacity') return t`The record says you are carrying ${s.count} distinct things; a person carries ~${s.limit}. That is over the practical load.`;
    if (s.kind === 'identity') return t`${s.name} and ${s.otherName}: the same thing?`;
    if (s.kind === 'conservation') return t`${s.name}: the story says ${s.set}, the record says ${s.qty}. Which is right?`;
    if (s.kind === 'duplicate') return t`"${s.name}" looks like the row you already hold as "${s.heldName}". Same thing?`;
    return JSON.stringify(s);
}

function questionKey(s) {
    return `${s?.kind}:${s?.id}:${s?.other ?? ''}`;
}

/** The Audit tab renderer. */
function render(body, context) {
    body.innerHTML = '';
    const header = el('div', 'sanguine_rep_toolbar');
    header.appendChild(button('sanguine_rep_btn', t`Run the deep audit`, async () => {
        await audit.run({ now: entities.turn() });
        context.refresh();
    }));
    body.appendChild(header);

    const list = audit.questions();
    if (!list.length) {
        const none = el('div', 'sanguine_rep_empty', t`No pending audit questions. The exact detectors found nothing to ask, or the last run answered everything.`);
        body.appendChild(none);
        return;
    }
    for (const suspect of list) {
        body.appendChild(questionCard(suspect, context.refresh));
    }
}

registerTab('audit', render);
