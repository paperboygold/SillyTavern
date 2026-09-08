/**
 * sanguine/diagnostics-view.js: the rejection log, rendered.
 *
 * Lifted out of `panel.js` when the log left the sidebar for the overlay's Diagnostics tab. It was
 * always the most detailed thing this extension draws, thirty rows, each with the model's raw
 * token, a rustc-style caret underlining it, the window it was read from, and a `help:` line naming
 * the fix, and it was rendering at the bottom of a 288px column below the fiction.
 *
 * It lives here rather than in the tab module so that `panel.js` and the tab can both reach it
 * without importing each other: the panel used to own this, the tab renders it now, and a cycle
 * between the two would be the price of leaving it where it was.
 *
 * What survived the move is the ROW, one refused change, or one failed pass, with its evidence.
 * What did not is the flat thirty-row list `renderDiagnostics` built to sit under the fiction: the
 * Diagnostics tab groups by reason, states the lifetime-tally-versus-specific-log split once at the
 * top instead of once per row, and has the width to let a `pre` block be read. Two renderers
 * disagreeing about what a rejection looks like is how the two surfaces drift apart.
 *
 * `rejectHelp` in particular is the reason this is a module and not a rewrite. Every entry in it is
 * a sentence telling the player what the extraction model did wrong and what to do instead, written
 * against a specific validation gate in `state-table.js`. A NEW GATE WITH NO ENTRY HERE renders as
 * the generic fallback, which is how a precise refusal becomes an unhelpful one.
 */

import { t } from '../../i18n.js';
import { showMoreMessages } from '../../../script.js';
// `rejectHelp` and the refusal classes moved to a leaf, and are re-exported from here.
//
// This module imports `script.js`, which makes it and everything in it unreachable from the node
// test environment, so a lookup table nothing can test would drift, and the classification added
// beside it needs a build gate (`tests/sanguine-reject-class.test.js`). `reject-table.js` imports
// nothing, for the reason `metadata-key.js` imports nothing.
//
// Re-exported rather than repointed at every call site: `rejectHelp` is the sentence a player reads
// when a gate refuses their narrator, and the modules that render it should not have to care which
// half of this pair it lives in.
export { CAP, GUARD, LEDGER, WASTE, classifiedReasons, classifyRejects, rejectClass, rejectHelp } from './reject-table.js';
import { rejectHelp } from './reject-table.js';

/** How many times to ask core for older messages before giving up on a cause-link. */
const MAX_LOAD_ATTEMPTS = 4;

/** Never ask for fewer than this, a handful at a time would take four rounds to reach anything. */
const MIN_LOAD_BATCH = 100;

/** Asked for over the exact gap, so the target lands inside the window rather than on its edge. */
const LOAD_MARGIN = 20;

/**
 * @param {string} tag Element name.
 * @param {string} [cls] Class list.
 * @param {string} [text] Text content. Always text, never HTML, this renders model output.
 * @returns {HTMLElement} The element.
 */
const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
};

/**
 * Jump the chat to the message that caused a value change.
 *
 * The cause-link (FOLD-REDESIGN.md §8, altitude 3): "click a contributor → the chat scrolls to the
 * causing message". SillyTavern renders every chat line with `mesid`, so the jump is a selector and
 * a scroll, no stored position, no state to keep in sync.
 *
 * `behavior: 'auto'`, because 'smooth' did not scroll at all.
 *
 * Measured, not assumed: `'smooth'` moved `#chat` by exactly 0 pixels over two seconds, and the
 * identical call with `'auto'` landed at 23561. Smooth scrolling is driven by the animation clock,
 * which does not advance while the page is not the foreground tab, and the whole point of this
 * control is that you click it from a panel and then look at the chat. The overlay shell hit the
 * same wall on its own `reveal()` and made the same choice for the same reason.
 *
 * So the animation was never a nicety that degraded; it was the difference between the cause-link
 * working and silently doing nothing, which is the worst way for a link to fail, the highlight
 * still lands, so it looks like the message simply was not found.
 *
 * The message usually is not rendered yet, and that is not a missing message.
 *
 * SillyTavern renders a window of recent messages and keeps the rest in `chat` until you scroll or
 * press "show more". So on a 271-message campaign a trail anchored at message 20 found no
 * `.mes[mesid="20"]`, returned, and did nothing at all, the single most common case for the oldest
 * and most interesting cause-links, failing silently. Reported independently by two callers before
 * anyone thought to check the DOM.
 *
 * `showMoreMessages(n)` is core's own loader and prepends older messages before the currently
 * first-rendered one, so the fix is to ask for enough of them and look again. Bounded, and it stops
 * early when the first rendered id is already at or below the target, at that point the message is
 * genuinely absent (a deleted message, or an anchor from a branch this chat no longer has) and
 * loading more would spin.
 *
 * @param {number} mid The message id a contributor is anchored to.
 * @returns {Promise<boolean>} Whether the message was found and jumped to. Callers may ignore it;
 *   a caller that wants to say "that message is gone" now can.
 */
export async function jumpToMessage(mid) {
    const id = Number(mid);
    let node = document.querySelector(`.mes[mesid="${id}"]`);

    for (let attempt = 0; !node && attempt < MAX_LOAD_ATTEMPTS; attempt++) {
        const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
        // Not a lazy-render problem: the window already reaches past the target and it still is not
        // there. Asking for more would page through the whole chat to find nothing.
        if (!Number.isFinite(first) || first <= id) {
            break;
        }
        // A margin over the exact gap, so one round normally suffices and the loop is a safety net
        // rather than the mechanism.
        await showMoreMessages(Math.max(MIN_LOAD_BATCH, (first - id) + LOAD_MARGIN));
        node = document.querySelector(`.mes[mesid="${id}"]`);
    }

    if (!node) {
        return false;
    }
    node.scrollIntoView({ behavior: 'auto', block: 'center' });
    node.classList.add('sanguine_jump_target');
    setTimeout(() => node.classList.remove('sanguine_jump_target'), 2000);
    return true;
}

/**
 * Capitalise the first letter only.
 * @param {string} text Input.
 * @returns {string} Sentence-cased text.
 */
function sentenceCase(text) {
    const value = String(text ?? '');
    return value ? value[0].toUpperCase() + value.slice(1) : value;
}


/**
 * The cause-link: a real button that jumps the chat to the message a diagnostic was anchored on.
 *
 * It was the whole ROW's click handler while this rendered in the 288px panel, which is a click
 * target a pointer can find and a keyboard cannot: no role, no tab stop, no announcement. Nothing
 * else consumes these rows any more (the log left the panel for the Diagnostics tab), so the
 * accessible shape is simply the shape now.
 *
 * @param {number} mid The message index.
 * @param {(mid: number) => void} onJump What the click does. The overlay passes a handler that
 *   closes itself first, a scroll behind a modal dialog is a scroll nobody sees.
 * @returns {HTMLElement} The button.
 */
function causeLink(mid, onJump) {
    const button = el('button', 'sanguine_log_jump_btn', `#${mid}`);
    /** @type {HTMLButtonElement} */ (button).type = 'button';
    button.title = t`Jump to the message that prompted this`;
    button.setAttribute('aria-label', t`Jump to message ${mid}`);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onJump(mid);
    });
    return button;
}

/**
 * One rejection, rendered the way song renders a compile error: the reason, the raw value the model
 * proposed with a caret run underlining it, the window it was read from, and a `help:` naming the
 * fix. This is the surface that turns "6 rejected" into "the AI proposed this, here, because of
 * this, and here is the fix".
 *
 * @param {object} entry A `state.log` reject entry.
 * @param {object} [options] Options.
 * @param {boolean} [options.help] Whether to render the `help:` line. False when the caller has
 *   already said it once, grouped by reason, thirty rows repeat one sentence thirty times.
 * @param {(mid: number) => void} [options.onJump] What the cause-link does.
 * @returns {HTMLElement} The row.
 */
export function renderRejectRow(entry, { help = true, onJump = jumpToMessage } = {}) {
    const row = el('li', 'sanguine_log_row sanguine_log_reject');
    row.appendChild(el('span', 'sanguine_log_tag', t`rejected`));
    const report = el('div', 'sanguine_log_report');
    const line = el('div', 'sanguine_log_line');
    if (entry.item) {
        line.appendChild(el('span', 'sanguine_log_item', sentenceCase(entry.item)));
        line.appendChild(el('span', 'sanguine_log_sep', '·'));
    }
    if (entry.reason) {
        line.appendChild(el('span', 'sanguine_log_reason', entry.reason));
    }
    if (entry.turn != null) {
        line.appendChild(el('span', 'sanguine_log_turn', `t${entry.turn}`));
    }
    report.appendChild(line);
    if (entry.raw) {
        // The offending token, and the caret underlining it, rustc-style.
        const pre = el('pre', 'sanguine_log_raw');
        pre.textContent = entry.raw;
        report.appendChild(pre);
        const caret = el('pre', 'sanguine_log_caret');
        caret.textContent = '^'.repeat(Math.max(1, entry.raw.length));
        report.appendChild(caret);
    }
    if (entry.snippet) {
        report.appendChild(el('div', 'sanguine_log_snippet', `"${entry.snippet}…"`));
    }
    if (help && entry.reason) {
        report.appendChild(el('div', 'sanguine_log_help', `help: ${rejectHelp(entry.reason)}`));
    }
    row.appendChild(report);
    if (Number.isFinite(entry.mid)) {
        row.appendChild(causeLink(entry.mid, onJump));
    }
    return row;
}

/**
 * One extraction pass that produced nothing usable.
 *
 * A sibling of the rejection row and deliberately not the same thing: a rejection is fold refusing
 * the model, this is the model returning something fold could not read. The `detail` carries the
 * distinction that matters, `empty`/`truncated` is a budget failure and raising the allowance is
 * the fix, `unparseable` is prompt, schema or model and no budget fixes it (`log.js`).
 *
 * @param {object} entry A `state.log` extract entry.
 * @param {object} [options] Options.
 * @param {(mid: number) => void} [options.onJump] What the cause-link does.
 * @returns {HTMLElement} The row.
 */
export function renderExtractRow(entry, { onJump = jumpToMessage } = {}) {
    const row = el('li', 'sanguine_log_row sanguine_log_extract');
    row.appendChild(el('span', 'sanguine_log_tag', t`extract`));
    const report = el('div', 'sanguine_log_report');
    const line = el('div', 'sanguine_log_line');
    line.appendChild(el('span', 'sanguine_log_reason', entry.reason));
    if (entry.turn != null) {
        line.appendChild(el('span', 'sanguine_log_turn', `t${entry.turn}`));
    }
    report.appendChild(line);
    if (entry.detail) {
        report.appendChild(el('div', 'sanguine_log_help', `help: ${entry.detail}`));
    }
    row.appendChild(report);
    if (Number.isFinite(entry.mid)) {
        row.appendChild(causeLink(entry.mid, onJump));
    }
    return row;
}
