/**
 * sanguine/overlay-diagnostics.js: the Diagnostics tab.
 *
 * Why this is a tab and not a panel section.
 *
 * The rejection log used to render at the bottom of the 288px sidebar: thirty rows, each carrying
 * the model's raw token, a rustc-style caret underlining it, the window it was read from and a
 * `help:` line naming the fix. It is the most detailed thing this extension draws, and it was on the
 * glance surface, below the fiction, in a column too narrow to show a prompt at all, so the
 * extraction trace collapsed to a single icon whose click printed to the console, because there was
 * nowhere to put a prompt that a person could read.
 *
 * Here there is: ~760px by 640px. Everything in this tab is a question you ask ON PURPOSE, "why did
 * it refuse that", "what did the model actually see", "is this record still true", "does that limit
 * ever bind", and the answers are long. The panel keeps the counts; the counts open this.
 *
 * The four questions, in the order they get asked.
 *
 *   rejects   What did fold refuse, and what should the model have done instead?
 *   trace     What did the model actually see, and what did it actually say?
 *   health    Is what the panel shows still true, and how would I know?
 *   counters  Does that bound ever bind, and is anything binding that nobody declared?
 *
 * The focus keys this tab answers to.
 *
 * `overlay.js`'s focus contract gives every tab its own namespace; this one's is SECTION NAMES,
 * plus one addressable record inside the first section:
 *
 *   'rejects'          The rejections section. The sidebar footer's "N rejected" count opens this.
 *   'trace'            The extraction trace.
 *   'health'           Record health, sync, extraction failures, the status-block gap.
 *   'counters'         Caps and counters, and the rules that have never fired.
 *   'reject:<reason>'  One rejection group, expanded and revealed. `<reason>` is the machine token
 *                      (`not-mentioned`, `invariant:overdraw`), the same string `state.log` and
 *                      `observe.js` count under, so a caller holding a reason holds the key.
 *
 * An unknown key opens the tab on the rejections section and says so, rather than showing nothing
 * (the shell cannot tell a stale key from a live one; that judgement belongs here).
 *
 * Two doctrines this file does not get to bend.
 *
 * Nothing is ever set as HTML. This surface renders raw model output, the highest-risk content in
 * the app, and a prompt is not a string this code is allowed to trust, only one it is allowed to
 * display. Every node is built and every value goes in as `textContent`.
 *
 * Mono against prose is load-bearing and is the whole reason the surface is readable: raw tokens,
 * prompts, counts, turn numbers and rule names are machine-produced and take `--fold-mono`; the
 * `help:` sentences are written for a human and take the body face. The typeface says who produced
 * the value, so the eye can skip a whole class of thing without reading it.
 */

import { t, translate } from '../../i18n.js';
import { eventSource } from '../../../script.js';
import { GUARD, LEDGER, WASTE, classifyRejects, rejectHelp, renderExtractRow, renderRejectRow, jumpToMessage } from './diagnostics-view.js';
import { ackSpans, countsOf, newRejects, perTurn } from './reject-table.js';
import * as entities from './entities.js';
import * as observe from './observe.js';
import { close, registerTab } from './overlay.js';
import * as state from './state.js';
import * as trace from './trace.js';

/** Id of the injected stylesheet link, so a second import cannot stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-diagnostics-css';

/**
 * How much of a `pre` block is rendered before it has to be asked for.
 *
 * A prompt is routinely tens of kilobytes, the narrative window plus the pinned ledger plus every
 * probe's instructions. That is not a rendering problem in itself (one text node, one scroll box),
 * but 40KB of wrapped text is a layout pass nobody asked for on a panel whose other three sections
 * are the point. Clamped for display only: copy and the console print always take the whole thing,
 * and the button says exactly how much is being held back.
 */
const CLAMP = 8000;

/** How long a button holds its "copied" state before returning to its label. */
const FLASH_MS = 1400;

/** A `syncing` record older than this was never going to finish (`panel.js` renderSyncChip). */
const STALL_MS = 150_000;

/** Unique ids for `aria-controls`, which needs one and cannot have a reason token in it. */
let uid = 0;

/**
 * Put `overlay-diagnostics.css` in the document head, once.
 *
 * The same shape as `overlay.js`'s own injection and for the same two reasons: `addExtensionStyle`
 * takes exactly one filename from the manifest and `style.css` already holds it, and a sheet that
 * starts loading when the tab is already on screen paints it unstyled for a frame.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-diagnostics.css', import.meta.url).href;
    document.head.appendChild(link);
}

// At import time, not at first render.
ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. Always text, never HTML.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * A real button, every time. Nothing in this tab is a div with a click handler.
 * @param {string} className Class list.
 * @param {string} label Visible text.
 * @param {() => void} onClick The action.
 * @returns {HTMLButtonElement} The button.
 */
function button(className, label, onClick) {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, label));
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

/** @param {number} value A count. @returns {string} Grouped digits. */
function num(value) {
    return Number(value ?? 0).toLocaleString();
}

/**
 * How long ago, in the coarsest unit that is still true.
 * @param {number} ms Epoch milliseconds.
 * @returns {string} A relative phrase, or '' when there is no timestamp.
 */
function ago(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return '';
    }
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 45) return t`just now`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return t`${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return t`${hours} h ago`;
    const days = Math.round(hours / 24);
    return t`${days} d ago`;
}

/**
 * A section shell: heading, one line saying what it is for, and a slot.
 * @param {string} id The focus key this section answers to.
 * @param {string} title The heading.
 * @param {string} blurb One line of prose.
 * @returns {HTMLElement} The section.
 */
function section(id, title, blurb) {
    const node = el('section', 'sanguine_diag_section');
    node.dataset.section = id;
    node.setAttribute('aria-labelledby', `sanguine_diag_h_${id}`);
    const heading = el('h3', 'sanguine_diag_head', title);
    heading.id = `sanguine_diag_h_${id}`;
    node.appendChild(heading);
    if (blurb) node.appendChild(el('p', 'sanguine_diag_blurb', blurb));
    return node;
}

/**
 * The counted facts of a section, as figures with labels under them.
 * @param {Array<{value: string, label: string, tone?: string}>} items The figures.
 * @returns {HTMLElement} The row.
 */
function stats(items) {
    const row = el('dl', 'sanguine_diag_stats');
    for (const item of items) {
        const cell = el('div', 'sanguine_diag_stat');
        // Value first in the source and in the reading order; the label is the caption under it.
        const value = el('dd', `sanguine_diag_stat_value${item.tone ? ` sanguine_diag_${item.tone}` : ''}`, item.value);
        const label = el('dt', 'sanguine_diag_stat_label', item.label);
        cell.appendChild(label);
        cell.appendChild(value);
        row.appendChild(cell);
    }
    return row;
}

/**
 * The `help:` line: a mono tag against a prose sentence.
 *
 * The contrast is the point. `help:` is fold speaking as a compiler does; the sentence after it is
 * the one thing on this surface written for a person, and setting it in the mono face, which is
 * what the panel did, filed it with the machine output the reader has learned to skim past.
 *
 * @param {string} sentence The advice.
 * @returns {HTMLElement} The line.
 */
function help(sentence) {
    const line = el('p', 'sanguine_diag_help');
    line.appendChild(el('span', 'sanguine_diag_help_tag', 'help:'));
    line.appendChild(el('span', 'sanguine_diag_help_text', sentence));
    return line;
}

/**
 * Copy text to the clipboard, and say so on the button that asked.
 * @param {HTMLButtonElement} node The button.
 * @param {string} label Its resting label.
 * @param {string} text What to copy.
 */
async function copy(node, label, text) {
    try {
        await navigator.clipboard.writeText(text);
        node.textContent = t`copied`;
        node.classList.add('sanguine_diag_copied');
    } catch (error) {
        // A clipboard write can be refused by permissions or by an insecure origin, and a button
        // that silently does nothing is worse than one that admits it: the text is still in the
        // console print, which is one click away.
        console.error('[sanguine] diagnostics: clipboard write refused', error);
        node.textContent = t`copy failed`;
        node.classList.add('sanguine_diag_failed');
    }
    setTimeout(() => {
        if (!node.isConnected) return;
        node.textContent = label;
        node.classList.remove('sanguine_diag_copied', 'sanguine_diag_failed');
    }, FLASH_MS);
}

/**
 * One labelled block of machine text, a prompt, a raw reply, a parsed fragment.
 *
 * Scrollable rather than clipped, copyable rather than selectable-if-you-are-careful, and clamped
 * rather than truncated: the count in the header is of the WHOLE text, and the button that lifts the
 * clamp says how much is left. A block that quietly showed the first 8000 characters would be a
 * diagnostic surface lying about the evidence.
 *
 * @param {string} label The block's name. Uppercase, mono, micro, a machine label.
 * @param {string} text The content. Empty is a fact, not a gap.
 * @param {string} [empty] What to say when the text is empty.
 * @returns {HTMLElement} The block.
 */
function textBlock(label, text, empty = t`(empty)`) {
    const body = String(text ?? '');
    const block = el('div', 'sanguine_diag_block');

    const head = el('div', 'sanguine_diag_block_head');
    head.appendChild(el('span', 'sanguine_diag_block_label', label));
    head.appendChild(el('span', 'sanguine_diag_block_size', t`${num(body.length)} chars`));
    const controls = el('div', 'sanguine_diag_block_controls');
    const copyLabel = t`copy`;
    const copyButton = button('sanguine_diag_btn', copyLabel, () => copy(copyButton, copyLabel, body));
    copyButton.disabled = !body;
    copyButton.setAttribute('aria-label', t`Copy ${label} to the clipboard`);
    controls.appendChild(copyButton);
    head.appendChild(controls);
    block.appendChild(head);

    const pre = el('pre', 'sanguine_diag_pre');
    // Focusable so the scroll box answers to the keyboard, and labelled so a screen reader landing
    // on it knows which of the three blocks it is standing in.
    pre.tabIndex = 0;
    pre.setAttribute('role', 'group');
    pre.setAttribute('aria-label', label);
    if (!body) {
        pre.classList.add('sanguine_diag_pre_empty');
        pre.textContent = empty;
        block.appendChild(pre);
        return block;
    }

    if (body.length > CLAMP) {
        pre.textContent = body.slice(0, CLAMP);
        block.appendChild(pre);
        const rest = body.length - CLAMP;
        const more = button('sanguine_diag_btn sanguine_diag_more', t`show all, ${num(rest)} more chars`, () => {
            pre.textContent = body;
            more.remove();
        });
        block.appendChild(more);
        return block;
    }

    pre.textContent = body;
    block.appendChild(pre);
    return block;
}

/**
 * The cause-link's action, from inside a modal dialog.
 *
 * `jumpToMessage` scrolls the chat and flashes the message. The overlay is a `<dialog>` opened with
 * `showModal()`, so the chat is inert and behind it, scrolling it while the dialog is up is a
 * navigation the player cannot see, and the flash is over before they close. Close first, jump
 * after, in that order.
 *
 * @param {number} mid The message index.
 */
async function jumpAndClose(mid) {
    await close();
    jumpToMessage(mid);
}

/* 1. Rejections. */

/**
 * A rate, to two places, or a dash when the span cannot carry one.
 * @param {number|null} value Events per turn from `perTurn`.
 * @returns {string} The figure.
 */
function rate(value) {
    return value === null
        ? ', '
        : Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * How a span reads in its first column.
 * @param {{from: object, to: object, open: boolean}} span A span from `ackSpans`.
 * @returns {string} The label.
 */
function spanLabel(span) {
    const from = Number(span.from?.at) || 0;
    const start = from ? t`turn ${num(from)}` : t`the start`;
    return span.open ? t`${start} → now` : t`${start} → turn ${num(Number(span.to?.at) || 0)}`;
}

/**
 * Acknowledgement: the watermark, what it did, and whether things are getting better.
 *
 * Why the control is HERE and not on the panel chip.
 *
 * The chip is a count you click to go and look. Putting the clear action on it would let a number be
 * dismissed from the one surface that does not show what is being dismissed, which is the shape
 * that trains a reader to clear without reading, and the counters would then be measuring a habit
 * instead of the extraction. The button sits under the four figures it is about, next to the reasons
 * that make them up, and the sentence beside it says exactly what does and does not happen.
 *
 * Why a rate and not a "since you looked" number alone.
 *
 * A watermark answers "what is new". It cannot answer "did my change help", because the answer to
 * that is a comparison and a single number is not one. So every acknowledgement leaves a mark, the
 * marks cut the chat into spans, and each span reports refusals PER TURN, the only form in which a
 * 60-turn span and a 12-turn one can be read against each other. `reject-table.js` `ackSpans` does
 * the arithmetic; `MAX_ACK_MARKS` argues the bound in bytes measured off the live corpus.
 *
 * Waste and guard get their own columns because they move for different reasons, `reject-table.js`
 * says it at length, and a combined rate can hold a waste regression flat under a guard
 * improvement and show nothing at all.
 *
 * @param {object} snapshot `state.snapshot()`.
 * @param {Array<{reason: string, count: number}>} tally The lifetime rejects tally.
 * @param {number} capped Lifetime cap firings, from `observe.capTotal()`.
 * @param {object} ctx The tab context, for the redraw after a click.
 * @returns {HTMLElement} The block.
 */
function ackBlock(snapshot, tally, capped, ctx) {
    const node = el('div', 'sanguine_diag_ack');
    const marks = Array.isArray(snapshot.acks) ? snapshot.acks : [];
    const acked = marks.length ? marks[marks.length - 1] : null;

    // Nothing refused and nothing marked: there is no watermark to explain and no chip to clear, so
    // a control offering to acknowledge nothing is a control that teaches the reader to click past
    // this block. It reappears the moment either becomes true.
    if (!tally.length && !capped && !marks.length) {
        return node;
    }

    node.appendChild(el('h4', 'sanguine_diag_sub', t`Since you last looked`));

    const fresh = newRejects(tally, acked?.r);
    const split = classifyRejects(fresh);
    const dropped = Math.max(0, capped - (Number(acked?.c) || 0));
    node.appendChild(stats([
        { value: num(split[WASTE]), label: t`wasted`, tone: split[WASTE] ? 'warn' : '' },
        { value: num(split[GUARD]), label: t`refused` },
        { value: num(dropped), label: t`dropped by a cap`, tone: dropped ? 'warn' : '' },
        { value: num(split[LEDGER]), label: t`ledger`, tone: split[LEDGER] ? 'crit' : '' },
    ]));

    node.appendChild(el('p', 'sanguine_diag_prose', acked
        ? t`The same four buckets as above, counted from the mark you set at turn ${num(Number(acked.at) || 0)}, ${ago(Number(acked.ts) || 0)}. Per reason and never below zero: a reason that did not exist when you marked counts in full, and a count that has gone down, a pruned chat, a restored blob, subtracts from nothing.`
        : t`Nothing has been marked as seen in this chat, so these are the lifetime figures above, repeated. Mark them and this becomes what has happened since.`));

    // The control.
    const actions = el('div', 'sanguine_diag_ack_actions');
    const mark = button('sanguine_diag_btn sanguine_diag_ack_btn', t`Mark these as seen`, () => {
        state.acknowledge();
        // The panel derives its footer chip from the same watermark and redraws on this event
        // (`panel.js`), so an acknowledgement made here has to say so or the chip keeps its old
        // number until the next message, which reads exactly like a button that did nothing.
        Promise.resolve(eventSource.emit('sanguine_chronicle_updated', { src: 'diagnostics' }))
            .catch(error => console.error('[sanguine] diagnostics: redraw notice failed', error));
        ctx?.refresh?.();
    });
    mark.setAttribute('aria-describedby', 'sanguine_diag_ack_caveat');
    actions.appendChild(mark);
    node.appendChild(actions);

    const caveat = el('p', 'sanguine_diag_note',
        t`Nothing is deleted. Every count on this tab stays exactly as it is, this only writes down where you had got to, so the panel's "N rejected" chip can show what arrives after it and disappear when there is nothing new. Refusals from the next pass on start the count again.`);
    caveat.id = 'sanguine_diag_ack_caveat';
    node.appendChild(caveat);

    // Is it getting better?
    if (!marks.length) {
        // One span is not a comparison, and drawing a one-row table implies it is.
        return node;
    }
    const live = { ts: Date.now(), at: entities.turn(), r: countsOf(tally), c: capped };
    const spans = ackSpans(marks, live);

    node.appendChild(el('h4', 'sanguine_diag_sub', t`Refusals per turn, between marks`));
    node.appendChild(el('p', 'sanguine_diag_prose',
        t`A delta is not comparable across spans of different lengths; a rate is. This is the surface that answers whether a change helped, watch the wasted column on its own, because that is the only one with a fix on this side of the wire, and a guard improvement can hide a waste regression in the combined figure.`));

    const table = el('table', 'sanguine_diag_table sanguine_diag_rates');
    const head = el('thead');
    const headRow = el('tr');
    for (const label of [t`span`, t`turns`, t`refusals`, t`per turn`, t`wasted/turn`, t`guarded/turn`]) {
        const cell = el('th', '', label);
        cell.scope = 'col';
        headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const tbody = el('tbody');
    for (const span of spans) {
        const row = el('tr', span.open ? 'sanguine_diag_rate_open' : '');
        row.appendChild(el('td', 'sanguine_diag_rule', spanLabel(span)));
        row.appendChild(el('td', 'sanguine_diag_num', num(span.turns)));
        row.appendChild(el('td', 'sanguine_diag_num', num(span.split.total)));
        row.appendChild(el('td', 'sanguine_diag_num', rate(perTurn(span.split.total, span.turns))));
        row.appendChild(el('td', 'sanguine_diag_num', rate(perTurn(span.split[WASTE], span.turns))));
        row.appendChild(el('td', 'sanguine_diag_num', rate(perTurn(span.split[GUARD], span.turns))));
        tbody.appendChild(row);
    }
    table.appendChild(tbody);
    node.appendChild(table);

    if (spans.some(span => span.turns === 0)) {
        node.appendChild(el('p', 'sanguine_diag_thin',
            t`A dash is a span of no turns, marked twice without playing between. Nothing happened in it, so there is no rate to report; saying zero would be a measurement, and there isn't one.`));
    }
    return node;
}

/**
 * The rejections section: what the extraction model proposed and fold refused.
 *
 * Two different things, and the difference is the honesty of this surface.
 *
 * `state.snapshot().rejects` is the LIFETIME tally: `{reason, count}`, counted from the first turn
 * of the chat. `state.log` holds SPECIFIC refusals, the raw proposal, the window it was read from,
 * the message it was anchored on, and only from the build that introduced the log onward. So a chat
 * can honestly show "97 rejected" over eleven reasons with nothing specific behind any of them, and
 * the live Raccoon City campaign does exactly that. Rendering the tally as though the specifics were
 * merely collapsed would be a lie told by a diagnostics panel, which is the worst place to tell one.
 *
 * So: group by reason, count from the tally, and let a group say plainly whether it has evidence.
 *
 * @param {object} snapshot `state.snapshot()`.
 * @param {Array<object>} entries The `reject` entries of `state.log`, newest first.
 * @returns {{node: HTMLElement, groups: Map<string, {node: HTMLElement, expand: () => void}>}} The
 *   section, and its groups by reason so a `reject:<reason>` focus can open one.
 */
function rejectsSection(snapshot, entries, ctx) {
    const node = section('rejects', t`Rejections`,
        t`Changes fold refused, and what refusing each one meant. Most are gates holding against a bad proposal and want nothing from you. The ones marked wasted are different: those are answers lost to how fold asked, and they are the only kind anyone can fix from here.`);

    const tally = Array.isArray(snapshot.rejects) ? snapshot.rejects : [];
    const total = tally.reduce((sum, row) => sum + (Number(row.count) || 0), 0);

    /** @type {Map<string, {reason: string, count: number, entries: Array<object>}>} */
    const grouped = new Map();
    for (const row of tally) {
        const reason = String(row.reason ?? '');
        if (reason) grouped.set(reason, { reason, count: Number(row.count) || 0, entries: [] });
    }
    for (const entry of entries) {
        const reason = String(entry.reason ?? '');
        if (!reason) continue;
        // A reason recorded specifically but absent from the tally is possible, the tally is a
        // different table with a different write path, and dropping it would hide the one kind of
        // rejection that has evidence.
        const group = grouped.get(reason) ?? { reason, count: 0, entries: [] };
        group.entries.push(entry);
        grouped.set(reason, group);
    }
    const groups = [...grouped.values()]
        .map(group => ({ ...group, count: Math.max(group.count, group.entries.length) }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

    // Four numbers, because "51 refusals" in one alarming colour was pointing at the wrong half.
    //
    // Measured on the live Wuxia chat at turn 76: of fifty-one refusals, twenty-two were guards
    // catching bad proposals, `already-recorded` alone was fifteen, and its own docblock cites the
    // spear billed twice, the room rental twice and the locket twice. Sixteen were one confusing
    // block throwing answers away. Rendering those as one `crit` total under a caption reading
    // "every one is a validation gate doing its job" managed to be alarming AND wrong, and it sent
    // the reader to fix the part that was protecting them.
    //
    // Only WASTE takes a tone. A guard firing is the system working, and a number that turns red
    // when the system works teaches the reader to ignore the colour.
    const split = classifyRejects(groups);
    // The cap total comes from the COUNTERS, because it can never come from this table.
    //
    // The first cut read all four numbers off `snapshot.rejects` and rendered "at a cap: 0" on a
    // chat with 202 cap firings. A cap is not a rejection and never enters that table: `observe.js`
    // says so in its own opening, "a rejection is at least visible in the rejects tally, whereas a
    // cap that truncates a summary or evicts an event leaves no trace at all. Counting them is the
    // whole point of the split." A bucket wired to a source that structurally cannot fill it reads
    // zero forever, and reads as reassurance.
    //
    // Measured on the live Wuxia chat at turn 149: 99 rejections against 202 caps, so the number
    // the reader most needs was both the larger one and the one being reported as nothing.
    const capped = observe.capTotal();
    node.appendChild(stats([
        { value: num(split[WASTE]), label: t`wasted, fold asked badly`, tone: split[WASTE] ? 'warn' : '' },
        { value: num(split[GUARD]), label: t`refused, the proposal was wrong` },
        { value: num(capped), label: t`dropped by a cap, unasked`, tone: capped ? 'warn' : '' },
        { value: num(split[LEDGER]), label: t`ledger disagrees with itself`, tone: split[LEDGER] ? 'crit' : '' },
    ]));
    node.appendChild(el('p', 'sanguine_diag_note',
        t`${num(split.total)} refusals over ${num(groups.length)} reasons, ${num(entries.length)} recorded in detail. A refusal means a proposal was turned away and the record is intact; a cap means something was dropped or hidden that nobody proposed and nothing else records. Neither number should be read as a healthy baseline, a gate catching a bad proposal is still a bad proposal that was made.`));

    node.appendChild(ackBlock(snapshot, tally, capped, ctx));

    if (!groups.length) {
        node.appendChild(el('p', 'sanguine_diag_note',
            t`Nothing has been refused in this chat. Either the extraction model is proposing only what the record can take, or extraction has not run, the counters below say which.`));
        return { node, groups: new Map() };
    }

    if (total && !entries.length) {
        // The awkward case, stated once at the top rather than repeated under every group.
        node.appendChild(el('p', 'sanguine_diag_note',
            t`These were counted, not recorded. The detailed log, the raw proposal, the window it was read from, the message it was anchored on, only captures refusals from the build that introduced it onward, so an older chat carries a tally with nothing behind it. Refusals from the next extraction on will appear here in full.`));
    }

    /** @type {Map<string, {node: HTMLElement, expand: () => void}>} */
    const handles = new Map();
    const list = el('div', 'sanguine_diag_groups');
    for (const group of groups) {
        const built = rejectGroup(group);
        handles.set(group.reason, built);
        list.appendChild(built.node);
    }
    node.appendChild(list);
    return { node, groups: handles };
}

/**
 * One reason, with its count and, when there is one, its evidence.
 *
 * A disclosure, because thirty groups' worth of raw tokens and carets open at once is the 288px
 * panel's problem transplanted into a wider box. Closed it is one line: what was refused and how
 * often. Open it is the compiler error.
 *
 * @param {{reason: string, count: number, entries: Array<object>}} group The group.
 * @returns {{node: HTMLElement, expand: () => void}} The group and a way to open it.
 */
function rejectGroup(group) {
    const node = el('div', 'sanguine_diag_group');
    const bodyId = `sanguine_diag_group_${++uid}`;

    const toggle = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_diag_disclosure'));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', bodyId);

    const caret = el('i', 'fa-solid fa-chevron-right sanguine_diag_caret');
    caret.setAttribute('aria-hidden', 'true');
    toggle.appendChild(caret);
    toggle.appendChild(el('span', 'sanguine_diag_reason', group.reason));
    toggle.appendChild(el('span', 'sanguine_diag_count', `${num(group.count)}×`));
    toggle.appendChild(el('span', 'sanguine_diag_evidence',
        group.entries.length ? t`${num(group.entries.length)} recorded` : t`counted only`));

    const body = el('div', 'sanguine_diag_group_body');
    body.id = bodyId;
    body.hidden = true;
    body.appendChild(help(rejectHelp(group.reason)));

    if (group.entries.length) {
        const rows = el('ul', 'sanguine_diag_rows');
        for (const entry of group.entries) {
            // `help: false`: the sentence is stated once above, and thirty copies of it is the
            // reason the old flat log read as noise.
            rows.appendChild(renderRejectRow(entry, { help: false, onJump: jumpAndClose }));
        }
        body.appendChild(rows);
    }
    // No "no specifics were recorded" line here. The group's own header already says `counted only`,
    // and on any chat that predates the detailed log EVERY group is counted only, so this printed
    // the same apology eleven times down the tab and buried the one line that helps, which is the
    // `help:` sentence above. Said once, in the section summary, or not at all.

    const expand = () => {
        body.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        node.classList.add('sanguine_diag_open');
    };
    toggle.addEventListener('click', () => {
        if (body.hidden) {
            expand();
            return;
        }
        body.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        node.classList.remove('sanguine_diag_open');
    });

    node.appendChild(toggle);
    node.appendChild(body);
    return { node, expand };
}

/* 2. Extraction trace. */

/**
 * The extraction trace: the exact prompt, the raw reply, and what was parsed out of it.
 *
 * This is the "what did the model actually see and say" answer, and until now it has had no readable
 * surface anywhere. In the sidebar it was one 22px icon: the metadata lived in its tooltip and the
 * prompt lived in the console, because a 288px column cannot show forty kilobytes of text. The
 * console print is kept, it is muscle memory, and a devtools console can be searched, but the
 * blocks below are the answer.
 *
 * Why there is a button, and why it is not automatic.
 *
 * `trace.last()` is the latest pass IN MEMORY, set by `record()` and restored once by `hydrate()` at
 * init. `hydrate()` runs before a chat is necessarily open, so on the live Raccoon City chat, which
 * has a 7.8MB trace file on disk, `last()` is null until a pass runs in the session. An empty
 * section standing next to a full trace file is a surface that lies by omission.
 *
 * So the section offers to fetch it, and does not do it unasked: the trace is append-only and
 * full-fidelity, the file for a long campaign is megabytes, and `load()` pulls and parses all of it
 * to reach the last line. That is a fine price for an answer somebody wanted and an absurd one for
 * merely opening a tab.
 *
 * @param {object} ctx The tab context, for `signal`, because this is the one thing here that waits.
 * @returns {HTMLElement} The section.
 */
function traceSection(ctx) {
    const node = section('trace', t`Extraction trace`,
        t`The last extraction pass, whole: the prompt fold built, the reply the model sent back, and the fragment that survived parsing.`);

    const slot = el('div', 'sanguine_diag_trace');
    node.appendChild(slot);

    const rec = trace.last();
    if (rec) {
        fillTrace(slot, rec);
        return node;
    }

    slot.appendChild(el('p', 'sanguine_diag_note',
        t`No pass has been traced in this session. Every pass is also written to a per-chat trace file on the server, which is where the answer is if extraction has ever run for this chat, it is not read on open because a long campaign's trace is megabytes and this is a tab you might merely be passing through.`));

    const label = t`load the last recorded pass`;
    const load = button('sanguine_diag_btn sanguine_diag_console', label, async () => {
        load.disabled = true;
        load.textContent = t`loading…`;
        const records = await trace.load();
        // The render this button belongs to may have been superseded while the fetch was in flight,
        // the player switched tabs, navigated again, or closed the overlay. `signal` says so; the
        // connectivity check covers the case where this node was replaced by a refresh.
        if (ctx.signal.aborted || !slot.isConnected) {
            return;
        }
        const last = records[records.length - 1];
        if (!last) {
            load.textContent = t`no passes on file for this chat`;
            return;
        }
        slot.replaceChildren();
        fillTrace(slot, last);
        slot.appendChild(el('p', 'sanguine_diag_thin',
            t`Read from the trace file, the last of ${num(records.length)} recorded passes.`));
    });
    slot.appendChild(load);
    return node;
}

/**
 * Fill a slot with one traced pass: what it was, then what it saw, said and yielded.
 * @param {HTMLElement} slot Where to put it.
 * @param {object} rec A trace record.
 */
function fillTrace(slot, rec) {
    const ok = !!rec.ok;
    slot.appendChild(stats([
        { value: ok ? t`ok` : t`failed`, label: t`outcome`, tone: ok ? 'fresh' : 'crit' },
        { value: rec.turn != null ? `t${rec.turn}` : ', ', label: t`turn` },
        { value: rec.mid != null ? `#${rec.mid}` : ', ', label: t`message` },
        { value: rec.t ? new Date(rec.t).toLocaleTimeString() : ', ', label: ago(rec.t) || t`when` },
    ]));

    // The pass's plumbing, in a definition list rather than a sentence: every value here is a
    // machine key, and the mono column makes them scannable in a way prose never would.
    const facts = el('dl', 'sanguine_diag_facts');
    /** @param {string} label The key. @param {string} value The value. */
    const fact = (label, value) => {
        if (!value) return;
        facts.appendChild(el('dt', 'sanguine_diag_fact_label', label));
        facts.appendChild(el('dd', 'sanguine_diag_fact_value', value));
    };
    fact(t`why it ran`, String(rec.why ?? ''));
    fact(t`profile`, String(rec.profileId ?? ''));
    fact(t`token budget`, Number.isFinite(rec.responseLength) ? num(rec.responseLength) : '');
    fact(t`recorded`, rec.t ? new Date(rec.t).toLocaleString() : '');
    if (facts.childElementCount) slot.appendChild(facts);

    if (!ok && rec.reason) {
        // A failed pass is the one thing on this surface that earns the critical colour.
        const failed = el('p', 'sanguine_diag_verdict');
        failed.appendChild(el('span', 'sanguine_diag_reason', String(rec.reason)));
        failed.appendChild(el('span', 'sanguine_diag_help_text', t`, the raw reply below is exactly what fold could not use.`));
        slot.appendChild(failed);
    }

    slot.appendChild(textBlock(t`prompt`, rec.prompt, t`(no prompt was recorded for this pass)`));
    if (rec.schema) {
        slot.appendChild(textBlock(t`schema`, JSON.stringify(rec.schema, null, 2)));
    }
    slot.appendChild(textBlock(t`raw reply`, rec.raw, t`(the model returned nothing, this is what an under-budgeted pass looks like)`));
    slot.appendChild(textBlock(t`parsed`, rec.parsed ? JSON.stringify(rec.parsed, null, 2) : '',
        t`(nothing was parsed out of the reply)`));

    // Kept because it is muscle memory, and because a console line can be searched, expanded and
    // kept across a reload in ways a scroll box cannot.
    slot.appendChild(button('sanguine_diag_btn sanguine_diag_console', t`print this pass to the console`, () => {
        console.log(`[sanguine] trace, pass @ ${new Date(rec.t ?? Date.now()).toISOString()}`);
        console.log(`[sanguine] PROMPT\n${rec.prompt ?? ''}`);
        console.log(`[sanguine] RAW REPLY\n${rec.raw ?? ''}`);
        console.log(`[sanguine] PARSED\n${JSON.stringify(rec.parsed ?? null, null, 2)}`);
    }));
}

/* 3. Record health. */

/** What each sync state means, said plainly rather than as a status word. @type {Record<string, {label: string, tone: string, prose: string}>} */
const SYNC_MEANING = {
    'up-to-date': {
        label: 'synced', tone: 'fresh',
        prose: 'The record reflects the newest message that has been read. Nothing is pending.',
    },
    acknowledged: {
        label: 'pending', tone: 'warn',
        prose: 'A message arrived and extraction has not run on it yet. This is a resting state, not a fault, it waits for the cadence or the next trigger, and can sit here for as long as the interval says.',
    },
    syncing: {
        label: 'syncing', tone: 'rel',
        prose: 'A pass is in flight right now. What you see is the record as of before it.',
    },
    behind: {
        label: 'behind', tone: 'warn',
        prose: 'A pass finished, but newer messages arrived while it was running. The next pass covers the gap; this corrects itself.',
    },
    failed: {
        label: 'failed', tone: 'crit',
        prose: 'The last pass produced nothing usable. The record is not wrong, it is old, it retries on the next message.',
    },
    stalled: {
        label: 'stalled', tone: 'crit',
        prose: 'A pass was left in flight and never finished, a hang, or a session that ended mid-pass. A healthy pass is bounded by the extraction timeout, so this one was never going to land. It retries on the next message.',
    },
};

/** What the status-block gap means. @type {Record<string, string>} */
const BLOCK_MEANING = {
    never: 'This card has never written a status block, which is the common case and costs nothing: fold reads the prose. Nothing is missing.',
    current: 'The narrator is still writing status blocks and the last one is current.',
    gap: 'The narrator has not restated its status block for a few turns. Blocks arrive in bursts, so a short gap is normal, nothing is lost, because everything on the panel is read from the prose either way.',
    stopped: 'The narrator wrote status blocks early in this chat and then stopped. That is a change of behaviour rather than a pause, and it is worth knowing about, but nothing is missing, because fold reads the prose.',
};

/**
 * Record health: is what the panel shows still true, and how would you know?
 *
 * Three instruments that answer one question, which is why they are one section: where extraction
 * stands, which passes came back with nothing usable, and whether the narrator is still restating
 * its own status block. Each says plainly what it means, a status word nobody can expand is a
 * status word nobody trusts.
 *
 * @param {object} snapshot `state.snapshot()`.
 * @param {Array<object>} extracts The `extract` entries of `state.log`, newest first.
 * @returns {HTMLElement} The section.
 */
function healthSection(snapshot, extracts) {
    const node = section('health', t`Record health`,
        t`Whether what the panel shows is current, what has failed lately, and whether the narrator is still writing status blocks.`);

    const sync = snapshot.sync ?? { state: 'up-to-date' };
    const stalled = sync.state === 'syncing' && Number.isFinite(sync.since) && (Date.now() - sync.since) > STALL_MS;
    const key = stalled ? 'stalled' : String(sync.state ?? 'up-to-date');
    const meaning = SYNC_MEANING[key] ?? { label: key, tone: '', prose: '' };
    const block = snapshot.blockState ?? { state: 'never', gap: 0 };

    node.appendChild(stats([
        { value: translate(meaning.label), label: t`extraction`, tone: meaning.tone },
        { value: num(extracts.length), label: t`failed passes logged`, tone: extracts.length ? 'warn' : '' },
        {
            value: block.state === 'never' ? t`none` : `${num(block.gap)}`,
            label: block.state === 'never' ? t`status blocks` : t`turns since a status block`,
            tone: block.state === 'stopped' ? 'warn' : '',
        },
    ]));

    // Sync.
    const syncBlock = el('div', 'sanguine_diag_reading');
    syncBlock.appendChild(el('h4', 'sanguine_diag_sub', t`Extraction lifecycle`));
    if (meaning.prose) syncBlock.appendChild(el('p', 'sanguine_diag_prose', translate(meaning.prose)));
    const since = ago(sync.since);
    if (since) syncBlock.appendChild(el('p', 'sanguine_diag_thin', t`In this state ${since}.`));
    if (sync.reason || sync.detail) {
        const line = el('p', 'sanguine_diag_verdict');
        if (sync.reason) line.appendChild(el('span', 'sanguine_diag_reason', String(sync.reason)));
        if (sync.detail) line.appendChild(el('span', 'sanguine_diag_help_text', String(sync.detail)));
        syncBlock.appendChild(line);
    }
    node.appendChild(syncBlock);

    // Failed passes.
    const passBlock = el('div', 'sanguine_diag_reading');
    passBlock.appendChild(el('h4', 'sanguine_diag_sub', t`Passes that produced nothing usable`));
    passBlock.appendChild(el('p', 'sanguine_diag_prose',
        t`A pass that came back empty or truncated ran out of its token allowance, raising the budget is the fix. A pass that came back unparseable produced JSON the parser could not read, and no budget fixes that: it is the prompt, the schema, or the model.`));
    if (extracts.length) {
        const rows = el('ul', 'sanguine_diag_rows');
        for (const entry of extracts) {
            rows.appendChild(renderExtractRow(entry, { onJump: jumpAndClose }));
        }
        passBlock.appendChild(rows);
    } else {
        passBlock.appendChild(el('p', 'sanguine_diag_thin',
            t`No failed pass has been recorded for this chat.`));
    }
    node.appendChild(passBlock);

    // The status-block gap.
    const blockBlock = el('div', 'sanguine_diag_reading');
    blockBlock.appendChild(el('h4', 'sanguine_diag_sub', t`Status blocks`));
    blockBlock.appendChild(el('p', 'sanguine_diag_prose',
        translate(BLOCK_MEANING[block.state] ?? BLOCK_MEANING.never)));
    if (block.state !== 'never' && Number.isFinite(block.gap)) {
        blockBlock.appendChild(el('p', 'sanguine_diag_thin', t`Last block was ${num(block.gap)} turns ago.`));
    }
    node.appendChild(blockBlock);

    return node;
}

/* 4. Caps and counters. */

/** What each observation namespace is. @type {Record<string, string>} */
const KIND_MEANING = {
    reject: 'a validator refused a proposed change, the model asked and fold said no',
    cap: 'a bound silently dropped or hid something nobody proposed',
    pass: 'the extraction pass itself: why it ran, and how it ended',
    verdict: 'the adjudicator placing an action in a band',
    review: 'the review pass settling, keeping or merging an open line',
    pressure: 'the pressure probe, and the threads it did or did not tick',
    world: 'the off-screen world turn',
};

/**
 * Caps and counters: does that bound ever bind?
 *
 * `observe.js` exists because fold carries a great many numeric constants and not one of them was
 * measured. The finding this section renders is the SILENCE, a gate that has never fired across
 * nine campaigns is either dead code or a gate that works, and the difference is worth being able to
 * see. `undeclared()` is the same argument from the other side: four of the place table's own rules
 * were firing in live chats while `KNOWN_RULES` had never heard of them, so they appeared in no
 * report and in no silence. They are declared now, and the list that found them stays.
 *
 * @returns {HTMLElement} The section.
 */
function countersSection() {
    const node = section('counters', t`Caps and counters`,
        t`Every bound that changed an outcome in this chat, and every one that never has. A limit that has never bound is a number nobody needed; a limit that binds constantly is set wrong.`);

    const fired = observe.report();
    const silent = observe.silentRules();
    const undeclared = observe.undeclared();

    node.appendChild(stats([
        { value: num(fired.length), label: t`rules that fired` },
        { value: num(silent.length), label: t`never fired` },
        { value: num(undeclared.length), label: t`fired but undeclared`, tone: undeclared.length ? 'warn' : '' },
    ]));

    // What bound.
    if (fired.length) {
        const table = el('table', 'sanguine_diag_table');
        const head = el('thead');
        const headRow = el('tr');
        for (const label of [t`rule`, t`kind`, t`count`]) {
            const cell = el('th', '', label);
            cell.scope = 'col';
            headRow.appendChild(cell);
        }
        head.appendChild(headRow);
        table.appendChild(head);
        const tbody = el('tbody');
        for (const row of fired) {
            const tr = el('tr');
            tr.appendChild(el('td', 'sanguine_diag_rule', row.key ?? row.rule));
            tr.appendChild(el('td', 'sanguine_diag_kind', row.kind));
            tr.appendChild(el('td', 'sanguine_diag_num', num(row.count)));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        node.appendChild(table);

        // The namespaces, named once, so `cap` versus `reject` is legible without reading observe.js.
        const kinds = new Set(fired.map(row => row.kind));
        const legend = el('dl', 'sanguine_diag_facts');
        for (const kind of kinds) {
            if (!KIND_MEANING[kind]) continue;
            legend.appendChild(el('dt', 'sanguine_diag_fact_label', kind));
            legend.appendChild(el('dd', 'sanguine_diag_prose', translate(KIND_MEANING[kind])));
        }
        if (legend.childElementCount) node.appendChild(legend);
    } else {
        node.appendChild(el('p', 'sanguine_diag_note',
            t`No bound has changed an outcome in this chat yet. In a chat of any length that is itself a finding: either extraction has never run, or nothing has come near a limit.`));
    }

    // What fired without being declared.
    if (undeclared.length) {
        const undeclaredBlock = el('div', 'sanguine_diag_reading');
        undeclaredBlock.appendChild(el('h4', 'sanguine_diag_sub', t`Fired, but not declared`));
        undeclaredBlock.appendChild(el('p', 'sanguine_diag_prose',
            t`These bound something in this chat and are not in the known-rules list, so they can appear neither in the report above as a named rule nor in the never-fired list below. An undeclared rule is invisible in both directions, add it to KNOWN_RULES in observe.js.`));
        const chips = el('ul', 'sanguine_diag_chips');
        for (const row of undeclared) {
            chips.appendChild(el('li', 'sanguine_diag_chip sanguine_diag_chip_warn', `${row.rule} · ${num(row.count)}`));
        }
        undeclaredBlock.appendChild(chips);
        node.appendChild(undeclaredBlock);
    }

    // What never fired.
    const silentBlock = el('div', 'sanguine_diag_reading');
    silentBlock.appendChild(el('h4', 'sanguine_diag_sub', t`Never fired in this chat`));
    silentBlock.appendChild(el('p', 'sanguine_diag_prose',
        t`A silent zero is the finding, not the absence of one. In a short chat this list means very little; in a long one, a rule here is either dead code or a gate that is working, and telling those two apart is what the list is for.`));
    if (silent.length) {
        const chips = el('ul', 'sanguine_diag_chips');
        for (const rule of silent) {
            chips.appendChild(el('li', 'sanguine_diag_chip', rule));
        }
        silentBlock.appendChild(chips);
    } else {
        silentBlock.appendChild(el('p', 'sanguine_diag_thin', t`Every known rule has fired at least once.`));
    }
    node.appendChild(silentBlock);

    return node;
}

/* The tab. */

/**
 * The section index: four buttons that move down the tab.
 *
 * Not a second tab rail, the overlay has one of those and it is vertical on the left. This is a
 * jump list for a page that is four screens long, and it uses `reveal` so that arriving by click
 * lands exactly the way arriving by `open({ tab, focus })` does.
 *
 * @param {Map<string, {node: HTMLElement, label: string}>} sections The sections, in order.
 * @param {object} ctx The tab context.
 * @returns {HTMLElement} The index.
 */
function index(sections, ctx) {
    const nav = el('nav', 'sanguine_diag_index');
    nav.setAttribute('aria-label', t`Diagnostics sections`);
    for (const entry of sections.values()) {
        nav.appendChild(button('sanguine_diag_jump', entry.label, () => ctx.reveal(entry.node)));
    }
    return nav;
}

registerTab('diagnostics', (body, ctx) => {
    ensureStylesheet();

    // The render itself is synchronous, and deliberately: every source is already in memory,
    // `state.snapshot()` is the same fold the panel renders from, `trace.last()` is the in-memory
    // record `hydrate()` restored at startup, and `observe` reads a table out of chat metadata. So
    // there is no window between building `body` and filling it. The one thing on this tab that
    // waits is the trace file, which is fetched on a click and checks `ctx.signal` before it writes.
    let snapshot;
    try {
        snapshot = state.snapshot();
    } catch (error) {
        console.error('[sanguine] diagnostics: the snapshot could not be read', error);
        body.appendChild(el('p', 'sanguine_diag_note',
            t`The record could not be read, there may be no chat open. Open a chat and reopen this tab.`));
        return;
    }

    const entries = Array.isArray(snapshot.log) ? snapshot.log : [];
    const rejects = entries.filter(entry => entry.kind !== 'extract');
    const extracts = entries.filter(entry => entry.kind === 'extract');

    const built = rejectsSection(snapshot, rejects, ctx);
    /** @type {Map<string, {node: HTMLElement, label: string}>} */
    const sections = new Map([
        ['rejects', { node: built.node, label: t`Rejections` }],
        ['trace', { node: traceSection(ctx), label: t`Trace` }],
        ['health', { node: healthSection(snapshot, extracts), label: t`Health` }],
        ['counters', { node: countersSection(), label: t`Counters` }],
    ]);

    const wrap = el('div', 'sanguine_diag');
    wrap.appendChild(index(sections, ctx));

    const wanted = String(ctx.focus ?? '');
    const reason = wanted.startsWith('reject:') ? wanted.slice('reject:'.length) : '';
    const known = !wanted || sections.has(wanted) || (reason && built.groups.has(reason));
    if (!known) {
        // The shell cannot tell a stale key from a live one, so it opens the tab regardless and this
        // is where the judgement lives: say what was asked for and show the tab anyway.
        const miss = el('p', 'sanguine_diag_note', t`Nothing in Diagnostics is called `);
        // NUL separators are real in some focus namespaces and invisible on screen; shown as ␀ so a
        // key that arrived intact does not look truncated (the same courtesy `overlay.js` extends).
        miss.appendChild(el('span', 'sanguine_diag_rule', wanted.replace(/\0/g, '␀')));
        miss.appendChild(document.createTextNode(t`, showing the whole tab.`));
        wrap.appendChild(miss);
    }

    for (const entry of sections.values()) {
        wrap.appendChild(entry.node);
    }
    body.appendChild(wrap);

    if (reason && built.groups.has(reason)) {
        const group = built.groups.get(reason);
        group.expand();
        ctx.reveal(group.node);
        return;
    }
    if (sections.has(wanted)) {
        ctx.reveal(sections.get(wanted).node);
    }
});
