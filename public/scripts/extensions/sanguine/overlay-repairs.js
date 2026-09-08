/**
 * sanguine/overlay-repairs.js: the Repairs tab: the record's repair bay.
 *
 * Why the reconcile pass is a tab and not a modal.
 *
 * The measured history, from `observe`: `reconcile:asked: 80`, `reconcile:declined: 2`,
 * `reconcile:applied: 0`. Two runs ever, both declined, across 22 campaigns. The old surface
 * (`reconcile.js` `confirm()`) priced the transaction so that Cancel always won: applying cost up to
 * forty fiction-recall judgements made blind, over a modal that covered the only records that could
 * answer them, while cancelling cost one click and forfeited the whole plan.
 *
 * A tab fixes the half a prettier diff cannot. The questions are questions ABOUT the record, "is
 * the woman with the child the same person as the woman in the bloodied blouse?", and here the
 * record is one keystroke away in the same shell: `g` calls `open({ tab, focus })` and lands on that
 * cast row, dossier and trail and all. The modal's central defect inverts into this surface's
 * central strength.
 *
 * The other half is the engine's, not this file's: conserving repairs (`rename`, `move`, `split`)
 * have already landed by the time anything here is drawn, so closing this tab forfeits nothing and
 * Esc is safe. What is left to ask about is the three verdicts that change how much of the world
 * exists, and they are asked one card at a time.
 *
 * What this file owns.
 *
 * Rendering, and no data. Everything shown comes from `./repairs.js` (asks, ledger, coverage, and
 * the writers) and every judgement about WHAT to say comes from `./repairs-view.js`, which is
 * DOM-free so it can be tested under `testEnvironment: node`. This module is the DOM between them.
 *
 * Two kinds of key, and they are not interchangeable.
 *
 * `ask.key` is the RECORD's key, in the owning tab's namespace, that is what `g` hands to
 * `open({ tab, focus })`. `askKey(ask)` is the QUESTION's identity, and that is what `applyAsk` and
 * `dismissAsk` take. Conflating them would apply the wrong repair or none at all, so every ask
 * carried through this file keeps both.
 *
 * The focus namespace.
 *
 * Per `overlay.js`'s focus contract, this tab answers to:
 *
 *   ''             no particular record; the first pending question takes focus.
 *   `<askKey>`     one question, as `repair-table.js` `askKey()` returns it. Revealed and focused.
 *   `<recordKey>`  the record a question is about, for a caller that holds the row and not the ask.
 *   'ledger'       the applied ledger.
 *   `pass:<id>`    one pass in the ledger.
 *
 * An unknown key opens the tab anyway and says so, the shell cannot tell a stale key from a live
 * one, and that judgement belongs here (the same courtesy `overlay-diagnostics.js` extends).
 *
 * Two doctrines this file does not get to bend.
 *
 * Nothing is ever set as HTML. Evidence is raw model prose about the player's own campaign, and it
 * arrives here on the same path a prompt does; every value goes in as `textContent`.
 *
 * Mono against prose is meaning, not decoration. `60 → 44 (−16)`, keys, counts and the coverage
 * figures were computed and take `--fold-mono`; names and evidence were written and take the body
 * face. Evidence in particular sits at full `--o-now` opacity, opacity means TIME on this sheet,
 * and the model is speaking NOW; dimming it would misfile testimony as history.
 */

import { t, translate } from '../../i18n.js';
import { registerTab } from './overlay.js';
import * as audit from './audit.js';
import * as entities from './entities.js';
import { askKey, clusterAsks, undoKindOf } from './repair-table.js';
import * as repairs from './repairs.js';
import {
    actionForKey, appliedOf, applyLabelOf, cardModel, coverageCaption,
    revertOffer, undoOffer,
} from './repairs-view.js';

/** Id of the injected stylesheet link, so a second import cannot stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-repairs-css';

/**
 * The order verdicts are grouped in on the ledger.
 *
 * Conserving first, because that is what the tier is: `split`, `rename` and `move` are the repairs
 * that landed without being asked about, they are the bulk of any pass, and grouping them at the top
 * is what makes the ledger skimmable rather than a shuffled list. `amount`, `merge` and `gone` reach
 * the ledger only after the player has answered a card, so they sort last, where an answered
 * question belongs.
 */
const VERDICT_ORDER = Object.freeze(['split', 'rename', 'move', 'amount', 'merge', 'gone']);

/**
 * Which card to put focus back on after a re-render, or -1.
 *
 * Answering an ask re-runs the whole renderer from the engine's new state, one source of truth, no
 * local mutation of a list the store also owns. The cost is that focus would land back at the top of
 * the tab after every keystroke, which for the three-dead-cast-rows cluster means losing your place
 * on every answer. This carries it across the repaint.
 */
let restoreCard = -1;

/**
 * The question the player left through `g`, so coming back lands on it.
 *
 * Module state rather than render scope, because the render that set it is gone by the time the
 * player returns, that is the whole point of the jump. Cleared on use: it is a one-way ticket back,
 * not a permanent selection.
 */
let returnTo = '';

/** Put `overlay-repairs.css` in the document head, once. Same shape as `overlay.js`'s injection. */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-repairs.css', import.meta.url).href;
    document.head.appendChild(link);
}

// At import time, not at first render: a sheet that starts loading when the tab is already on screen
// paints it unstyled for a frame or two.
ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. Always text, never HTML, this renders model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * A real button, every time. Nothing on this tab is a div with a click handler, Space and Enter,
 * the focus ring and the "button" announcement all come from the element.
 *
 * @param {string} className Class list.
 * @param {string} label Visible text.
 * @param {(event: MouseEvent) => void} onClick The action.
 * @returns {HTMLButtonElement} The button.
 */
function button(className, label, onClick) {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, label));
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

/**
 * A line of parts, each set in the face that says who produced it.
 *
 * @param {string} className The line's class.
 * @param {Array<{text: string, mono: boolean}>} parts From `repairs-view.js`.
 * @returns {HTMLElement} The line.
 */
function line(className, parts) {
    const node = el('span', className);
    for (const part of parts) {
        if (!part.text) continue;
        node.appendChild(el('span', part.mono ? 'sanguine_rep_val' : 'sanguine_rep_word', part.text));
    }
    return node;
}

/**
 * A quoted block of the model's own words.
 *
 * Body face, `--s-sub`, full opacity, a 2px rule in the card's tone, and NEVER italic. A forty-row
 * wall of italics was the old design's texture, and italics at this size cost legibility exactly
 * where the judgement is being made. The quote marks are drawn in CSS so they are not part of the
 * string a screen reader has to spell out.
 *
 * @param {string} text The evidence.
 * @param {string} [className] Extra classes.
 * @returns {HTMLElement} The block.
 */
function evidenceBlock(text, className = '') {
    return el('blockquote', `sanguine_rep_ev${className ? ` ${className}` : ''}`, text);
}

/**
 * Announce something to the live region.
 *
 * `aria-live="polite"` rather than a toast: an apply, a dismiss and an undo are confirmations of
 * something the player just did on a surface they are already looking at, so the sighted feedback is
 * the card leaving and the ledger growing. This is the channel for everybody else.
 *
 * @param {object} scope The render scope.
 * @param {string} message What happened.
 */
function say(scope, message) {
    if (scope.live?.isConnected) scope.live.textContent = message;
}

/* The coverage strip.
 *
 * §7, and the reason the empty state is honest. The block poses at most `MAX_RECONCILE_LINES` (40)
 * of the live rows (`reconcile-table.js`:177), offset-walked, so on the measured Raccoon City record
 *, 54 items + 3 marks + 16 cast + 15 threads = 88 live rows, one pass can never check more than
 * 45% of it. "Nothing needs changing" is a claim about the SPAN, and this strip is what keeps it one.
 *
 * `Run again` sits INSIDE the strip rather than in a toolbar: the affordance belongs where the gap
 * is shown, so "there is more" and "here is how to reach it" are one gesture apart.
 */

/**
 * @param {object} scope The render scope.
 * @param {object} span `coverage()`'s answer.
 * @param {boolean} covered False when the last pass failed and the offset was not advanced.
 * @returns {HTMLElement} The strip.
 */
function coverageStrip(scope, span, covered) {
    const caption = coverageCaption(span, { covered });
    const strip = el('div', 'sanguine_rep_cover');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', t`Coverage`);

    strip.appendChild(el('span', 'sanguine_rep_covtext sanguine_rep_covspan', caption.text));

    // The bar draws a number that is already written out beside it, so it is hidden from the
    // accessibility tree rather than given a meter role nobody asked for. The fill is INSET, not
    // left-anchored: the second pass covers rows 41, 80, and a bar filling from zero would draw a
    // claim about rows 1, 40 that this pass never made.
    const bar = el('div', 'sanguine_rep_bar');
    bar.setAttribute('aria-hidden', 'true');
    const fill = el('div', `sanguine_rep_fill${covered ? '' : ' sanguine_rep_fill_void'}`);
    fill.style.left = `${caption.leftPct}%`;
    fill.style.width = `${caption.widthPct}%`;
    bar.appendChild(fill);
    strip.appendChild(bar);

    strip.appendChild(el('span', 'sanguine_rep_covtext', caption.next));

    const label = t`run again`;
    const run = button('sanguine_rep_run', label, async () => {
        if (run.disabled) return;
        run.disabled = true;
        run.textContent = t`running…`;
        say(scope, t`Reconcile is running, the same deep audit the agent runs on its own.`);
        try {
            // The one reconcile: the deep audit. Its questions land in the Audit tab, so the player
            // is taken there rather than left on a history surface the run no longer feeds.
            await audit.run({ now: entities.turn() });
            scope.ctx.open({ tab: 'audit' });
        } catch (error) {
            console.error('[sanguine] repairs: the pass failed', error);
            if (!run.isConnected) return;
            run.disabled = false;
            run.textContent = label;
            say(scope, t`The pass failed. Nothing was changed.`);
        }
    });
    run.title = t`Check the record against the story, the same pass the background agent runs. One model call.`;
    strip.appendChild(run);

    return strip;
}

/* Ask cards. */

/**
 * A section heading with its count and an aside.
 *
 * @param {string} title The heading.
 * @param {number|string} count What is under it.
 * @param {string} [aside] One line, right-aligned, in the mono face.
 * @returns {HTMLElement} The heading.
 */
function sectionHead(title, count, aside = '') {
    const head = el('h3', 'sanguine_rep_sect');
    head.appendChild(el('span', '', title));
    head.appendChild(el('span', 'sanguine_rep_sect_n', String(count)));
    if (aside) head.appendChild(el('span', 'sanguine_rep_sect_aside', aside));
    return head;
}

/**
 * Toggle every disclosure inside one card.
 *
 * A cluster's members are always listed, you must see what you are authorising, but their evidence
 * is one interaction away, per §6: the wall of italics is dissolved by disclosing evidence the tier
 * has already judged safe, while a singleton ask's evidence stays fully visible because it is the
 * thing being judged.
 *
 * @param {HTMLElement} card The card.
 * @param {boolean} [want] Force a state, or omit to flip.
 */
function discloseCard(card, want) {
    const regions = [...card.querySelectorAll('[data-disclose]')];
    if (!regions.length) return;
    const open = want ?? regions.some(region => region.hidden);
    for (const region of regions) {
        region.hidden = !open;
        card.querySelector(`[aria-controls="${region.id}"]`)?.setAttribute('aria-expanded', String(open));
    }
}

/**
 * One question, or one cluster of questions that share a shape.
 *
 * Why a cluster is one card and not a bulk button.
 *
 * The Raccoon City record carries three cast rows that are dead where they fell ("dead on the
 * floor", "hatchet in skull", "killed by Solomon"). Three separate cards is three judgements about
 * one fact; a global apply-all is the old gate in a new shirt. One card per `(op, kind)` group, with
 * per-member evidence and per-member opt-out, is the only shape that makes bulk cheap without making
 * it blind. The maximum blast radius of one interaction stays at one card.
 *
 * Why `role="group"` and not a listbox.
 *
 * §9 asks for "listbox-like" movement, and it gets the movement: roving tabindex, arrows and `j`/`k`.
 * It does not get the ROLE, because a listbox option may not contain interactive children and every
 * card holds two buttons, a jump link and, on a cluster, a checkbox per member. Claiming a role
 * whose contents are illegal buys an announcement and loses the controls underneath it.
 *
 * @param {object} scope The render scope.
 * @param {object} entry A cluster from `clusterAsks`, or a bare ask.
 * @param {number} index Its position, for the roving tabindex and for element ids.
 * @returns {HTMLElement} The card.
 */
function askCard(scope, entry, index) {
    const model = cardModel(entry, { identify: askKey });
    const card = el('section', `sanguine_rep_ask sanguine_rep_ask_${model.tone}`);
    card.dataset.tone = model.tone;
    card.dataset.op = model.op;
    card.tabIndex = index === 0 ? 0 : -1;
    card.setAttribute('role', 'group');

    const top = el('div', 'sanguine_rep_top');
    const stamp = el('span', 'sanguine_rep_stamp', model.stamp);
    stamp.id = `sanguine_rep_stamp_${index}`;
    const subject = line('sanguine_rep_subject', model.subject);
    subject.id = `sanguine_rep_subj_${index}`;
    // The verdict is announced as a WORD before the record it is about, colour is never the only
    // channel, and the stamp is the channel that survives greyscale, a screen reader and a
    // colour-blind reader alike.
    card.setAttribute('aria-labelledby', `${stamp.id} ${subject.id}`);
    top.appendChild(stamp);
    top.appendChild(subject);
    top.appendChild(el('span', 'sanguine_rep_chip',
        model.clustered ? `${model.kind} ×${model.count}` : model.kind));
    card.appendChild(top);

    if (model.evidence) {
        const quote = evidenceBlock(model.evidence);
        quote.id = `sanguine_rep_ev_${index}`;
        quote.dataset.disclose = 'evidence';
        card.appendChild(quote);
    }

    // The consequence line: what the write will DO, including the keeper rules the pass does not
    // control. The player is told what they are authorising, not asked to trust a verb.
    if (model.mechanism) card.appendChild(el('div', 'sanguine_rep_mech', model.mechanism));

    /** @type {Array<HTMLInputElement>} Per-member opt-in boxes, parallel to `model.members`. */
    const boxes = [];
    if (model.clustered) {
        const list = el('ul', 'sanguine_rep_members');
        model.members.forEach((member, at) => {
            const row = el('li', 'sanguine_rep_member');
            const label = el('label', 'sanguine_rep_member_label');
            const box = /** @type {HTMLInputElement} */ (document.createElement('input'));
            box.type = 'checkbox';
            box.checked = true;
            box.className = 'sanguine_rep_member_box';
            label.appendChild(box);
            label.appendChild(el('span', 'sanguine_rep_member_name', member.name));
            row.appendChild(label);
            boxes[at] = box;

            if (member.evidence) {
                const quote = evidenceBlock(member.evidence, 'sanguine_rep_ev_member');
                quote.id = `sanguine_rep_ev_${index}_${at}`;
                quote.dataset.disclose = 'evidence';
                quote.hidden = true;
                const why = button('sanguine_rep_why', t`why`, () => {
                    quote.hidden = !quote.hidden;
                    why.setAttribute('aria-expanded', String(!quote.hidden));
                });
                why.setAttribute('aria-expanded', 'false');
                why.setAttribute('aria-controls', quote.id);
                row.appendChild(why);
                row.appendChild(quote);
            }
            list.appendChild(row);
        });
        card.appendChild(list);
    }

    const actions = el('div', 'sanguine_rep_acts');
    const apply = button('sanguine_rep_btn sanguine_rep_apply', model.applyLabel,
        () => answer(scope, card, model, boxes, true));
    actions.appendChild(apply);
    actions.appendChild(button('sanguine_rep_btn sanguine_rep_dismiss', t`Dismiss`,
        () => answer(scope, card, model, boxes, false)));

    // Per-member opt-out changes what the apply button promises, immediately. A button still reading
    // "remove 3" with one box unticked would be lying about the blast radius.
    for (const box of boxes) {
        box.addEventListener('change', () => {
            const picked = boxes.filter(one => one.checked).length;
            apply.textContent = applyLabelOf(model, picked);
            apply.disabled = picked === 0;
        });
    }

    if (model.target) {
        const view = button('sanguine_rep_view', `${translate(model.target.label)} ▸`,
            () => goTo(scope, model));
        view.title = t`Open the record this question is about.`;
        actions.appendChild(view);
    }
    actions.appendChild(el('span', 'sanguine_rep_hint', 'y / n'));
    card.appendChild(actions);

    // Kept side by side rather than hung on the element: a focus key has to be matched against the
    // model, and an expando on a DOM node is state the next reader has no way to find.
    scope.cards.push(card);
    scope.models.push(model);
    return card;
}

/**
 * Apply or dismiss one card.
 *
 * Why an opt-out leaves the rest pending rather than dismissing them.
 *
 * `applyCluster(key)` is the whole-cluster path and is taken when every box is ticked. Unticking a
 * member means "not this one, not now", so the ticked ones go through `applyAsk` individually and
 * the unticked ones are left PENDING. Dismissing them would silently answer a question the player
 * deliberately declined to answer, which is the exact move this redesign exists to stop.
 *
 * @param {object} scope The render scope.
 * @param {HTMLElement} card The card.
 * @param {object} model Its view model.
 * @param {Array<HTMLInputElement>} boxes Member opt-in boxes; empty for a singleton.
 * @param {boolean} applied True to apply, false to dismiss.
 */
function answer(scope, card, model, boxes, applied) {
    // Land on the card that takes this one's place. Clamped one short of the end because this card
    // is about to leave the list.
    restoreCard = Math.max(0, Math.min(scope.cards.indexOf(card), scope.cards.length - 2));

    const picked = model.members.filter((member, at) => boxes[at]?.checked ?? true);

    try {
        if (applied) {
            if (!picked.length) {
                say(scope, t`Nothing is ticked, this card would change nothing.`);
                return;
            }
            let done = 0;
            if (model.clustered && picked.length === model.members.length) {
                done = Number(repairs.applyCluster(model.key)) || 0;
            } else {
                for (const member of picked) {
                    if (repairs.applyAsk(member.askKey)) done++;
                }
            }
            const held = model.members.length - picked.length;
            say(scope, held
                ? t`Applied ${done}. ${held} left pending, unticked is not dismissed.`
                : t`Applied: ${model.ariaLabel}`);
        } else {
            let done = 0;
            for (const member of model.members) {
                if (repairs.dismissAsk(member.askKey)) done++;
            }
            say(scope, t`Dismissed ${done}, the record stands. The next pass re-poses anything still contradicted.`);
        }
    } catch (error) {
        console.error('[sanguine] repairs: the write failed', error);
        say(scope, t`That could not be written, see the console.`);
    }
    scope.ctx.refresh();
}

/**
 * Jump to the record a question is about.
 *
 * §3's argument made operational. There is no back STACK in the shell and there should not be one,
 * the rail is the way back and it is one click from anywhere. What this does instead is remember
 * which question was being read, so returning to Repairs lands on that card rather than at the top
 * of the list. The asks are store state, so the question itself survives the trip by construction.
 *
 * @param {object} scope The render scope.
 * @param {object} model The card's view model.
 */
function goTo(scope, model) {
    if (!model.target) {
        say(scope, t`This question has no record to open.`);
        return;
    }
    returnTo = model.members[0]?.askKey ?? '';
    say(scope, t`Opening the record, the Repairs tab keeps this question.`);
    scope.ctx.open({ tab: model.target.tab, focus: model.target.focus });
}

/* The ledger. */

/**
 * One applied row: what changed, its evidence disclosed, and its undo stated honestly.
 *
 * @param {object} scope The render scope.
 * @param {object} pass The pass it belongs to.
 * @param {object} row One entry from `pass.applied`.
 * @param {number} at Its position, for element ids.
 * @returns {HTMLElement} The row.
 */
function ledgerRow(scope, pass, row, at) {
    const op = String(row?.op ?? '');
    const item = el('li', `sanguine_rep_led sanguine_rep_led_${op}`);
    item.dataset.op = op;

    item.appendChild(el('span', 'sanguine_rep_vchip', op));
    item.appendChild(line('sanguine_rep_what', appliedOf(row)));
    // `--fold-fresh` is spent here and nowhere else on this tab: the accent marks the one thing that
    // is genuinely new, and the word "applied" carries the same fact without colour.
    item.appendChild(el('span', 'sanguine_rep_tick', t`✓ applied`));

    if (row?.evidence) {
        const quote = evidenceBlock(row.evidence, 'sanguine_rep_ev_led');
        quote.id = `sanguine_rep_led_ev_${pass?.pass ?? 0}_${at}`;
        quote.hidden = true;
        const why = button('sanguine_rep_why', t`why`, () => {
            quote.hidden = !quote.hidden;
            why.setAttribute('aria-expanded', String(!quote.hidden));
        });
        why.setAttribute('aria-expanded', 'false');
        why.setAttribute('aria-controls', quote.id);
        item.appendChild(why);
        item.appendChild(quote);
    }

    const offer = undoOffer(undoKindOf(op), Boolean(pass?.snapshotValid));
    const undo = button('sanguine_rep_undo', offer.label, () => {
        if (repairs.undoRow(pass.pass, row.key)) {
            say(scope, t`Undone, the inverse edit was written.`);
        } else {
            say(scope, t`That could not be undone.`);
        }
        scope.ctx.refresh();
    });
    undo.disabled = offer.disabled;
    undo.title = offer.title;
    // The handle `u` reaches for. Only a row with a real inverse carries it, so the binding can never
    // press a disabled control and call it an undo.
    if (!offer.disabled) item.dataset.undoable = 'yes';
    item.appendChild(undo);

    return item;
}

/**
 * One pass's applied rows, grouped by verdict under micro-label headers.
 *
 * @param {object} scope The render scope.
 * @param {object} pass The pass.
 * @returns {HTMLElement} The list.
 */
function ledgerList(scope, pass) {
    const rows = Array.isArray(pass?.applied) ? pass.applied : [];
    const list = el('ul', 'sanguine_rep_ledger');

    /** @type {Map<string, Array<object>>} */
    const byOp = new Map();
    for (const row of rows) {
        const op = String(row?.op ?? '');
        if (!byOp.has(op)) byOp.set(op, []);
        byOp.get(op).push(row);
    }
    const rank = op => (VERDICT_ORDER.indexOf(op) === -1 ? VERDICT_ORDER.length : VERDICT_ORDER.indexOf(op));
    const ordered = [...byOp.keys()].sort((a, b) => rank(a) - rank(b));

    let at = 0;
    for (const op of ordered) {
        const group = byOp.get(op);
        const head = el('li', 'sanguine_rep_ledgroup');
        head.appendChild(el('span', '', op));
        head.appendChild(el('span', 'sanguine_rep_sect_n', String(group.length)));
        list.appendChild(head);
        for (const row of group) {
            list.appendChild(ledgerRow(scope, pass, row, at++));
        }
    }
    return list;
}

/**
 * The revert-pass control, and the sentence that makes it honest.
 *
 * The control is never hidden. When the snapshot has expired it degrades to the disabled truth,
 * "expired, the record has moved on.", because a control that disappears takes its own explanation
 * with it and leaves the player believing there was an undo they missed. Silent expiry is the
 * defect; printed expiry is the feature.
 *
 * @param {object} scope The render scope.
 * @param {object} pass The pass.
 * @returns {HTMLElement} The line.
 */
function revertLine(scope, pass) {
    const offer = revertOffer(pass);
    const row = el('div', 'sanguine_rep_revert');
    const control = button('sanguine_rep_revertbtn', offer.label, () => {
        say(scope, repairs.revertPass(pass.pass)
            ? t`Reverted, the record is back to where the pass found it.`
            : t`The snapshot has expired, the record has moved on.`);
        scope.ctx.refresh();
    });
    control.disabled = offer.disabled;
    row.appendChild(control);
    row.appendChild(el('span', 'sanguine_rep_revertnote', offer.note));
    return row;
}

/**
 * A prior pass, collapsed to one line that opens.
 *
 * §6: newest pass first, prior passes collapse. Their rows stay reachable, a ledger that forgets
 * last week's renames is a ledger you cannot audit, but they do not compete with the pass that just
 * ran.
 *
 * @param {object} scope The render scope.
 * @param {object} pass The pass.
 * @returns {HTMLElement} The disclosure.
 */
function priorPass(scope, pass) {
    const box = el('details', 'sanguine_rep_prior');
    const applied = Array.isArray(pass?.applied) ? pass.applied.length : 0;
    const when = Number(pass?.at) > 0 ? new Date(pass.at).toLocaleDateString() : '';
    const summary = el('summary', 'sanguine_rep_prior_head');
    summary.appendChild(el('span', 'sanguine_rep_vchip', `pass ${pass?.pass ?? '?'}`));
    summary.appendChild(el('span', 'sanguine_rep_what', when
        ? t`${applied} repairs applied · ${when}`
        : t`${applied} repairs applied`));
    box.appendChild(summary);
    box.appendChild(ledgerList(scope, pass));
    box.appendChild(revertLine(scope, pass));
    return box;
}

/* Refusals. */

/**
 * What the pass refused, and why, behind a disclosure at `--o-dormant`.
 *
 * They exist for trust, the pass shows its rejects, and not for action: there is nothing to do
 * about `unknown-id` except know that the pass threw the line away rather than guessing at it. The
 * reasons are the `REJECTIONS` tokens (`reconcile-table.js`:132-141), so a count here and a
 * `reconcile:<reason>` counter in Diagnostics are the same number.
 *
 * @param {Array<object>} rejected The refusals, `{item, reason}`.
 * @returns {HTMLElement|null} The disclosure, or null when there were none.
 */
function refusalsBlock(rejected) {
    if (!rejected.length) return null;
    const box = el('details', 'sanguine_rep_refused');
    /** @type {Map<string, Array<string>>} reason -> the rows it was raised about. */
    const byReason = new Map();
    for (const one of rejected) {
        const reason = String(one?.reason ?? 'unknown');
        if (!byReason.has(reason)) byReason.set(reason, []);
        const named = String(one?.item ?? '').trim();
        if (named) byReason.get(reason).push(named);
    }
    box.appendChild(el('summary', 'sanguine_rep_refused_head', t`${rejected.length} answers refused`));
    const counts = [...byReason.entries()].map(([reason, named]) => ({
        reason,
        named,
        count: rejected.filter(one => String(one?.reason ?? 'unknown') === reason).length,
    }));
    for (const entry of counts.sort((a, b) => b.count - a.count)) {
        const row = el('div', 'sanguine_rep_refrow');
        row.appendChild(el('span', 'sanguine_rep_reason',
            entry.count > 1 ? `${entry.reason} ×${entry.count}` : entry.reason));
        if (entry.named.length) row.appendChild(el('span', 'sanguine_rep_word', entry.named.join(', ')));
        box.appendChild(row);
    }
    return box;
}

/* The keyboard. */

/**
 * Move card focus, with a roving tabindex.
 *
 * Exactly one card in the tab order at a time, arrows and `j`/`k` for the rest, the same model the
 * overlay's own rail uses, so the two do not disagree about what Tab means inside this dialog.
 *
 * @param {object} scope The render scope.
 * @param {number} to The index to land on.
 */
function focusCard(scope, to) {
    const cards = scope.cards;
    if (!cards.length) return;
    const at = Math.min(Math.max(0, to), cards.length - 1);
    for (const [index, card] of cards.entries()) {
        card.tabIndex = index === at ? 0 : -1;
    }
    cards[at].focus();
}

/**
 * The tab's key handler.
 *
 * @param {object} scope The render scope.
 * @param {KeyboardEvent} event The keydown.
 */
function onKey(scope, event) {
    const target = /** @type {HTMLElement} */ (event.target);
    // Text entry always wins. A checkbox is not text entry, `j`/`k` must still move while the player
    // is halfway through unticking a cluster.
    if (target?.matches?.('input:not([type="checkbox"]), textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) {
        return;
    }
    // A modified key belongs to the browser or to SillyTavern, never to a single-letter binding.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const action = actionForKey(event.key);
    if (!action) return;

    // Enter on a control is that control's business. Every other binding is a bare letter, which no
    // button claims, so this is the only collision the tab has to yield.
    if (event.key === 'Enter' && target?.matches?.('button, summary, a, [role="button"]')) return;

    const card = /** @type {HTMLElement|null} */ (target?.closest?.('.sanguine_rep_ask') ?? null);
    const at = card ? scope.cards.indexOf(card) : -1;

    switch (action) {
        case 'next':
        case 'prev':
            // With nothing to move between, the arrows belong to the scrollbar. Claiming them on an
            // empty tab would take scrolling away and give nothing back.
            if (!scope.cards.length) return;
            focusCard(scope, at === -1 ? 0 : at + (action === 'next' ? 1 : -1));
            break;
        case 'apply':
        case 'dismiss': {
            if (!card) return;
            const control = card.querySelector(action === 'apply' ? '.sanguine_rep_apply' : '.sanguine_rep_dismiss');
            if (!(control instanceof HTMLButtonElement) || control.disabled) return;
            control.click();
            break;
        }
        case 'disclose':
            if (!card) return;
            discloseCard(card);
            break;
        case 'goto': {
            if (!card) return;
            const view = card.querySelector('.sanguine_rep_view');
            if (!(view instanceof HTMLButtonElement)) return;
            view.click();
            break;
        }
        case 'undo': {
            // The most recent undoable row: the ledger is newest-pass-first and its groups are
            // ordered, so the first row in document order that carries an inverse is the newest one
            // that has one.
            const undo = scope.wrap.querySelector('.sanguine_rep_led[data-undoable] .sanguine_rep_undo');
            if (undo instanceof HTMLButtonElement && !undo.disabled) {
                undo.click();
            } else {
                say(scope, t`Nothing on the ledger has an inverse, revert the pass while its snapshot lives.`);
            }
            break;
        }
        default:
            return;
    }
    event.preventDefault();
}

/* The tab. */

registerTab('repairs', (body, ctx) => {
    ensureStylesheet();

    const wrap = el('div', 'sanguine_rep');
    const scope = { wrap, ctx, cards: [], models: [], live: null };

    // The live region goes in empty and goes in FIRST: a region that already holds text when it is
    // inserted announces nothing, so it has to exist before anything writes to it.
    const live = el('div', 'sanguine_rep_live');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    scope.live = live;
    wrap.appendChild(live);

    let asks = [];
    let passes = [];
    let span = { start: 0, end: 0, total: 0 };
    try {
        asks = repairs.asks() ?? [];
        passes = repairs.ledger() ?? [];
        span = repairs.coverage() ?? span;
    } catch (error) {
        // The same failure `overlay-diagnostics.js` guards against: no chat open, or a blob that
        // could not be read. A tab that renders nothing is indistinguishable from a tab with nothing
        // in it, and one of those is a bug.
        console.error('[sanguine] repairs: the record could not be read', error);
        wrap.appendChild(el('p', 'sanguine_rep_note',
            t`The record could not be read, there may be no chat open. Open a chat and reopen this tab.`));
        body.appendChild(wrap);
        return;
    }

    const newest = passes[0] ?? null;
    // Neither field is in the frozen pass contract; both are read defensively so that an engine that
    // reports a failed pass or its refusals gets them rendered, and one that does not simply renders
    // the populated state. Absence is not treated as success.
    const failed = Boolean(newest?.failed);
    const rejected = Array.isArray(newest?.rejected) ? newest.rejected : [];

    wrap.appendChild(coverageStrip(scope, span, !failed));

    // Failure first, and in the crit colour.
    //
    // §8: nothing was written, so say exactly that before anything else. The strip above already
    // shows the span as unjudged, because `propose()` commits the offset only once a plan exists
    // (`reconcile.js`:161), a failed pass is a no-op on the walk, and the strip makes that visible
    // rather than merely true.
    if (failed) {
        const box = el('div', 'sanguine_rep_failed');
        box.appendChild(el('p', 'sanguine_rep_failed_head', t`The pass failed. Nothing was changed.`));
        box.appendChild(el('p', 'sanguine_rep_failed_note',
            t`The model's answer could not be read back. The record is exactly as it was, and this span still counts as unchecked, the next run poses the same rows again.`));
        wrap.appendChild(box);
    }

    // Questions, loud.
    const clusters = asks.length ? (clusterAsks(asks) ?? []) : [];
    if (clusters.length) {
        wrap.appendChild(sectionHead(t`Questions`, asks.length, t`one keypress each · closing loses nothing`));
        const group = el('div', 'sanguine_rep_cards');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', t`Pending questions`);
        clusters.forEach((cluster, index) => group.appendChild(askCard(scope, cluster, index)));
        wrap.appendChild(group);
    } else if (!failed) {
        // Empty, and scoped to the span.
        //
        // Never "nothing needs changing" on its own: that is a claim about the whole record, and the
        // pass looked at at most 40 rows of it. The strip states the span, this states the finding
        // inside it, and the ledger below keeps the tab a place rather than a dead end.
        const clear = el('div', 'sanguine_rep_clear');
        clear.appendChild(el('p', 'sanguine_rep_clear_head', t`Nothing in the checked span needs changing.`));
        const caption = coverageCaption(span, { covered: true });
        clear.appendChild(el('p', 'sanguine_rep_clear_scope', `${caption.text} · ${caption.next}`));
        wrap.appendChild(clear);
    }

    // The ledger, quiet.
    if (newest && Array.isArray(newest.applied) && newest.applied.length) {
        wrap.appendChild(sectionHead(t`Applied this pass`, newest.applied.length,
            t`label and place repairs apply on sight, nothing was added or lost`));
        wrap.appendChild(ledgerList(scope, newest));
        wrap.appendChild(revertLine(scope, newest));
    }

    const prior = passes.slice(1);
    if (prior.length) {
        wrap.appendChild(sectionHead(t`Earlier passes`, prior.length));
        for (const pass of prior) {
            wrap.appendChild(priorPass(scope, pass));
        }
    }

    // Refusals, dormant.
    const refusals = refusalsBlock(rejected);
    if (refusals) {
        // On a failed pass the refusals ARE the explanation, so they open with the tab. Otherwise
        // they stay shut: they exist for trust, not for action.
        refusals.open = failed;
        wrap.appendChild(refusals);
    }

    wrap.appendChild(el('p', 'sanguine_rep_keys',
        t`↑↓ move · y apply · n dismiss · e evidence · g go to record · u undo last · esc close (questions keep)`));

    // On the PANEL, not on the wrapper, so `j`/`k` answer while focus is still on the scroll region
    // the shell hands you when you Tab off the rail, a keyboard model that only works once you have
    // already clicked a card is a keyboard model for people who used a mouse first.
    //
    // The panel outlives this render (the shell empties it rather than replacing it), so the
    // listener would stack one copy per repaint. `ctx.signal` is aborted the moment this render is
    // superseded (`overlay.js` `paint`), which is exactly the lifetime this handler should have.
    body.addEventListener('keydown', event => onKey(scope, event), { signal: ctx.signal });
    body.appendChild(wrap);

    // Landing.
    //
    // Four ways in, in priority order: a focus key handed over by `open({ tab, focus })`, the card
    // the player left through `g` and has come back to, the card they were standing on before an
    // answer repainted the tab, and otherwise nothing, the panel keeps focus and the rail's
    // autofocus decides.
    const wanted = String(ctx.focus ?? '');
    const find = (key) => {
        if (!key) return null;
        // Either key answers: the question's own identity, or the record it is about. A caller
        // holding a cast row should not have to know how an ask is keyed to link to its question.
        const at = scope.models.findIndex(model =>
            model.key === key || model.members.some(member => member.askKey === key || member.key === key));
        return at === -1 ? null : scope.cards[at];
    };

    const landed = find(wanted) ?? find(returnTo);
    returnTo = '';

    if (wanted && !landed && wanted !== 'ledger' && !wanted.startsWith('pass:')) {
        const miss = el('p', 'sanguine_rep_note', t`No pending question is called `);
        // NUL separators are real in item and mark keys and invisible on screen; shown as ␀ so a key
        // that arrived intact does not look truncated.
        miss.appendChild(el('span', 'sanguine_rep_val', wanted.replace(/\0/g, '␀')));
        miss.appendChild(document.createTextNode(t`, showing the whole tab. It may already have been answered.`));
        wrap.insertBefore(miss, live.nextSibling);
    }

    if (landed) {
        ctx.reveal(landed);
    } else if (restoreCard >= 0 && scope.cards.length) {
        focusCard(scope, restoreCard);
    }
    restoreCard = -1;
});
