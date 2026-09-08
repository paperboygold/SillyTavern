/**
 * sanguine/overlay-threads.js: the Threads tab.
 *
 * What the sidebar could not say.
 *
 * `panel.js` `dialRow` renders four of the twenty fields a thread record carries: the name, the
 * dial, `about`, and a recency rail. Everything that says what the stake actually IS was on the
 * record and off the screen, `open` (what acting on it would settle), `detail` (who, where, when),
 * `where` (where it applies at all), `per` (its cadence), `deadline` (the hour it is racing),
 * `source` (which message raised it), `first`/`turn`/`ticked` (its history), `aka`, `status`,
 * `seen`, `restored`. A 288px column has no room for that, which is the whole reason the overlay
 * exists: the row is allowed to be a summary because the record is one click away.
 *
 * So this tab is the record. Every field a row actually carries, grouped as a reader meets them,
 * the stake, what settles it, where it applies, its cadence, its provenance, its dial and that
 * dial's history. The one column deliberately left unrendered is `steps`, which no row in the
 * corpus has and nothing writes; the argument is beside the field helpers below.
 *
 * The other absence: a dial could not be touched.
 *
 * A dial-less thread row in the sidebar offers ✓ / ✎ / ×. A dial row offered nothing at all, so the
 * one kind of thread whose position is a NUMBER, the kind most likely to be wrong, and the kind
 * whose wrongness is most visible, was the kind you could not correct. Every row here carries the
 * same three, through the same writers (`edits.js`), plus the pin.
 *
 * The active thread: two claims that must not look alike.
 *
 * "What is the story currently about" already had an answer nobody was showing: `state.coverage`
 * (`coverage.js`) is the model's own report of which threads the last extraction window mentioned,
 * persisted every pass, free to read. That is the DEFAULT, and it is the model's claim about the
 * prose.
 *
 * `state.activeThread()` is the player's claim about their intent, and it exists for the case where
 * the two disagree, pushing on a thread the narration has not reached yet is exactly when you most
 * want it pinned. It is an override, not a replacement, so the two render differently and say so in
 * words: the pin wears the interface accent (a selection state, like the overlay rail's own), and
 * coverage wears no colour at all, only a dotted outline. Spending a semantic hue on either would
 * claim severity where there is none.
 *
 * The split is computed by `thread-table.js` `currentThreads`, which is pure and tested, so the
 * sidebar's eventual active-thread card can ask the same question and get the same answer rather
 * than reimplementing the precedence.
 */

import { t } from '../../i18n.js';
import { registerTab } from './overlay.js';
import * as clocks from './clocks.js';
import * as edits from './edits.js';
import * as entities from './entities.js';
import * as state from './state.js';
import { THREAD_FIELDS, editRow } from './edit-form.js';
import { coveredThreads } from './coverage.js';
import { formatClock, formatGap, timeUntil } from './clock.js';
import {
    CLOSED,
    DOOM,
    HIDDEN,
    MOOT,
    OPEN_STATUS,
    PROGRESS,
    THREAD_STALE,
    currentThreads,
    isFull,
    isTouchedThread,
    perMinutes,
    threads as readThreads,
} from './thread-table.js';

/** Id of the injected stylesheet, so a re-import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-threads-css';

/**
 * Put `overlay-threads.css` in the document head, once.
 *
 * Same reasoning and same shape as `overlay.js` `ensureStylesheet`: the manifest declares exactly
 * one sheet and `style.css` already holds it, so a tab that needs its own brings it itself. The URL
 * comes off `import.meta.url` so it resolves wherever the extension is installed, and it runs at
 * import time rather than at first render, a sheet that starts loading while the tab is on screen
 * paints it unstyled for a frame.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-threads.css', import.meta.url).href;
    document.head.appendChild(link);
}

ensureStylesheet();

/**
 * Minutes in a day.
 *
 * `clock.js` holds the same number and does not export it. Restated rather than exported-for-one-
 * caller because it is a property of a day rather than of that module, and it is read here for one
 * job: `ticked` is a clock SCALAR (`clockScalar` = day × DAY + minutes), so showing it as a time
 * needs the divisor back.
 */
const DAY = 1440;

/** Ids for the disclosure regions. A thread key can hold anything, so it can never be one. */
let sequence = 0;

/**
 * @param {string} tag Element name.
 * @param {string} [cls] Class list.
 * @param {string} [text] Text content. Always text, every string here is model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
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
 * A short uppercase label.
 *
 * `--s-micro` is the floor of the type scale and is licensed for exactly this: tracked capitals,
 * whose word shapes survive 9.3px where lowercase prose would not.
 *
 * @param {string} cls Extra classes.
 * @param {string} text The label.
 * @param {string} [title] Tooltip.
 * @returns {HTMLElement} The chip.
 */
function chip(cls, text, title = '') {
    const node = el('span', `sanguine_thr_chip ${cls}`.trim(), text);
    if (title) node.title = title;
    return node;
}

/**
 * The dial, drawn so polarity is unmistakable.
 *
 * A doom is a Blades clock face, discrete segments in the warning hue, going critical past three
 * quarters. A progress track is a continuous bar in the fresh hue with no urgency state at all,
 * because a track filling is the good news. The two were drawn identically once and the residency
 * obligation, the player's own achievement, read as a countdown to disaster
 * (`FOLD-REDESIGN.md` §0.1-3). The classes are this sheet's own rather than the panel's: same
 * vocabulary deliberately, separate ownership.
 *
 * @param {object} thread A thread carrying a dial.
 * @returns {HTMLElement} The meter.
 */
function dialNode(thread) {
    const { filled, size, kind } = thread.dial;
    // A dial that has fired is no longer a secret.
    //
    // `seen: hidden` means the character cannot tell HOW FAR ALONG a dial is, and the honest render
    // is one hatched mark and no fraction. It does not mean the outcome stays hidden once it lands:
    // when the clock completes, the thing happens, on screen, to them. Drawn without this the row
    // contradicted itself in the live chat, a "?" beside a chip reading COMPLETE, which is the
    // fraction being withheld from a reader who has already been told the answer.
    const hidden = thread.seen === HIDDEN && filled < size;
    const wrap = el('span', 'sanguine_thr_meter');

    if (kind === PROGRESS) {
        const track = el('span', 'sanguine_thr_track');
        track.title = hidden ? t`Underway, your character cannot tell how far` : `${filled}/${size}`;
        const fill = el('i');
        fill.style.width = `${hidden ? 0 : Math.max(0, Math.min(1, filled / size)) * 100}%`;
        track.appendChild(fill);
        wrap.appendChild(track);
        wrap.appendChild(el('span', 'sanguine_thr_num', hidden ? '?' : `${filled}/${size}`));
        return wrap;
    }

    const pressure = filled / size;
    const dial = el('span', `sanguine_thr_dial${hidden ? ' is_hidden' : ''}${pressure >= 0.75 ? ' is_urgent' : ''}`);
    if (hidden) {
        // Named but never quantified. Knowing something is closing in without knowing how close is
        // its own kind of pressure, and it is the honest thing to show for a threat the character
        // cannot perceive.
        dial.title = t`Closing in, your character cannot tell how near`;
        dial.appendChild(el('i', 'sanguine_thr_seg is_unknown'));
    } else {
        dial.title = `${filled}/${size}`;
        for (let seg = 0; seg < size; seg++) {
            dial.appendChild(el('i', `sanguine_thr_seg${seg < filled ? ' on' : ''}`));
        }
    }
    wrap.appendChild(dial);
    wrap.appendChild(el('span', 'sanguine_thr_num', hidden ? '?' : `${filled}/${size}`));
    return wrap;
}

/**
 * One field of the record: a tracked label and its value.
 *
 * `mono` is not decoration, it is the rule the panel established and this overlay inherits: a value
 * fold DERIVED (a position, a count, a turn number, a clock reading) is set in the instrument face,
 * and anything a narrator or the model wrote is set as prose. The typeface says who produced it.
 *
 * @param {HTMLElement} into The definition list.
 * @param {string} label The label.
 * @param {string} value The value. Empty values are skipped, an empty row is noise.
 * @param {object} [options] Options.
 * @param {boolean} [options.mono] Whether the value is derived.
 * @param {string} [options.hint] Tooltip on the label.
 */
function field(into, label, value, { mono = false, hint = '' } = {}) {
    const text = String(value ?? '').trim();
    if (!text) {
        return;
    }
    const term = el('dt', 'sanguine_thr_label', label);
    if (hint) term.title = hint;
    into.appendChild(term);
    into.appendChild(el('dd', `sanguine_thr_value${mono ? ' is_derived' : ''}`, text));
}

/**
 * A row action.
 *
 * A real `<button>`, always: these run destructive writes, and a `<div>` with a click handler is
 * unreachable by keyboard and unannounced by a screen reader.
 *
 * @param {string} label What it reads.
 * @param {string} title What it does, in full.
 * @param {() => any} run The action.
 * @param {object} [options] Options.
 * @param {boolean} [options.danger] Whether it destroys something.
 * @returns {HTMLButtonElement} The button.
 */
function action(label, title, run, { danger = false } = {}) {
    const button = el('button', `sanguine_thr_act${danger ? ' is_danger' : ''}`, label);
    button.type = 'button';
    button.title = title;
    // The glyph is the label and a glyph is not a name, the accessible name has to be the sentence.
    button.setAttribute('aria-label', title);
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
    });
    return button;
}

/**
 * The deadline line: the hour the fiction stated, and how far off it is.
 *
 * `deadline` is minutes since midnight, reported as a number by the model, fold never reads a
 * scheduling time out of prose. The countdown needs the narrative clock, and `timeUntil` refuses a
 * gap more than half a day out or more than three hours past, so a stale deadline shows its hour
 * without pretending to be a countdown.
 *
 * One field row, and nothing structural.
 *
 * MEASURED, corpus-wide: `deadline` is set on exactly ONE thread row across 21 live chats. So it is
 * rendered plainly, in field-row order, when it happens to be there, no banner, no section, no
 * sort key, nothing about this tab's shape depends on it. A layout organised around a field that
 * one row in the corpus carries is a layout that is empty for everybody. (The sidebar's
 * `nearestDeadline` is built on the same field and is `panel.js`'s to reconsider, not this tab's.)
 *
 * @param {object} thread The thread.
 * @param {number} now Minutes since midnight, now, or NaN.
 * @returns {string} The line, or ''.
 */
function deadlineText(thread, now) {
    const at = Number(thread?.deadline);
    if (!Number.isInteger(at) || at < 0) {
        return '';
    }
    const gap = timeUntil(now, at);
    if (!gap) {
        return formatClock(at);
    }
    return `${formatClock(at)} · ${gap.passed ? `${formatGap(gap.minutes)} ${t`ago`}` : `${t`in`} ${formatGap(gap.minutes)}`}`;
}

/**
 * The cadence line: how often this front advances on its own, and when it next will.
 *
 * `per` is a span the player (or the world probe) set; `ticked` is where the narrative clock stood
 * when the calendar last moved it, a POSITION, not an accumulator, which is what makes the tick
 * idempotent (`thread-table.js` `tickCalendar`). Rendering the two together turns a cadence nobody
 * could verify into an arithmetic anyone can check against the clock on the panel.
 *
 * The projection appears only once `ticked` exists, that is, once the calendar has actually
 * anchored this front. Without it the line is the span alone, which is the honest reading: a cadence
 * that has never fired cannot be shown a next time it will fire. This is deliberately NOT the world
 * turn: `world.js`'s off-screen advancement is inert corpus-wide (one event, ever, and `driveSize`
 * on none of 179 cast rows), so nothing here reads drive or predicts an off-screen move. `per` is
 * hand-set through the edit dialog, and that is the only path this line depends on.
 *
 * @param {object} thread The thread.
 * @returns {string} The line, or ''.
 */
function cadenceText(thread) {
    const per = String(thread?.per ?? '').trim();
    if (!per) {
        return '';
    }
    const span = perMinutes(thread);
    const at = Number(thread?.ticked);
    if (!span || !Number.isFinite(at)) {
        return per;
    }
    const next = at + span;
    return `${per} · ${t`next`} ${t`day`} ${Math.floor(next / DAY)} ${formatClock(next % DAY)}`;
}

/*
 * `steps` is NOT rendered, and this is the decision, so nobody re-litigates it.
 *
 * A thread record can carry `steps`: named dial segments, the Dungeon World front shape, *the
 * scouts return*, *the palisade burns*, *the gate falls*. `thread-table.js` accepts the column and
 * says of it, accurately, that it "remains genuinely unread". Building a reader for it here was the
 * obvious move and it was the wrong one.
 *
 * MEASURED, corpus-wide: ZERO thread rows across 21 live chats carry a `steps` array. Nothing
 * writes one, not the probe schema, not `clocks.set`, not a slash command, not the block path,
 * and until this file tried, nothing read one. A renderer for a field with no rows is UI that can
 * never appear, and it costs the same review attention as UI that does. Worse, drawing it would
 * imply the pipeline produces segment names, which would be the tab asserting a capability the
 * extension does not have.
 *
 * So: not rendered, and not removed either. Deleting the column is a separate wave's call, it is
 * carried so that a front which somehow arrives with segments does not silently lose them, and the
 * cost of carrying an unread string array is nothing. If a writer for it ever ships, this comment
 * is the place to start.
 */

/**
 * One thread, whole.
 *
 * @param {object} thread A thread from `threads()`.
 * @param {object} context Rendering context.
 * @param {object} context.ctx The tab context.
 * @param {string} context.pinned The pinned key.
 * @param {Set<string>} context.covered The model's coverage report.
 * @param {number} context.now Minutes since midnight, now.
 * @returns {HTMLElement} The row.
 */
function threadRow(thread, { ctx, pinned, covered, now }) {
    const isPinned = Boolean(pinned) && thread.key === pinned;
    const isTouched = isTouchedThread(thread, covered);
    const settled = thread.status !== OPEN_STATUS || isFull(thread);

    // Opacity is HOW CURRENT, and nothing else.
    //
    // Four stops, in the order a reader should meet them: what the story is touching now, what is
    // open, what nobody has named in twenty turns, and what is over. Emphasis and severity are not
    // on this axis, that is the hue's job, and an axis with two meanings has none.
    const currency = settled ? 'is_over'
        : (isPinned || isTouched) ? 'is_now'
            : thread.stale >= THREAD_STALE ? 'is_standing' : 'is_context';

    const row = el('li', `sanguine_thr_row ${currency}${isPinned ? ' is_pinned' : ''}`);

    const head = el('div', 'sanguine_thr_head');

    // The disclosure.
    const detailId = `sanguine_thr_d${++sequence}`;
    const disclose = el('button', 'sanguine_thr_disc');
    disclose.type = 'button';
    disclose.setAttribute('aria-expanded', 'false');
    disclose.setAttribute('aria-controls', detailId);
    disclose.appendChild(el('span', 'sanguine_thr_caret', '›'));
    disclose.appendChild(el('span', 'sanguine_thr_name', sentenceCase(thread.name)));
    head.appendChild(disclose);

    const marks = el('span', 'sanguine_thr_marks');
    // The two claims, drawn apart.
    //
    // PINNED is the player's own selection, so it wears the interface accent the way the overlay's
    // selected tab does, chrome, not meaning. IN PLAY is the model's report, and it wears no hue at
    // all: a dotted outline and nothing else. Neither is severity, and neither may borrow the
    // severity colours to say so.
    if (isPinned) {
        marks.appendChild(chip('is_pin', t`pinned`, t`You pinned this as the thread you are pushing on`));
    }
    if (isTouched) {
        marks.appendChild(chip('is_play', t`in play`, t`The last extraction window mentioned this, the model's reading, not yours`));
    }
    // Veiled is about the POSITION, so it stops applying the moment the dial reaches the end, see
    // `dialNode`. A row cannot say "you cannot tell how far along" and "it completed" at once.
    if (thread.seen === HIDDEN && !isFull(thread)) {
        marks.appendChild(chip('is_veiled', t`veiled`, t`Your character cannot perceive how far along this is`));
    }
    // Why a thread you can see here is missing from the sidebar.
    //
    // A thread bound to a place applies only there: a goblin nest counterattacks in the dungeon it
    // lives in and does not follow you to a noodle shop, so `threadsByKind` drops it from the panel
    // the moment you leave. That is right for a 288px glance and it looks like a disappearance. The
    // record still holds it, this tab still lists it, and the chip says which of the two you are
    // reading. No hue: "somewhere else" is a fact about geography, not a severity.
    if (!thread.local) {
        marks.appendChild(chip('is_away', t`elsewhere`, t`Bound to a place you are not, which is why the panel does not show it`));
    }
    if (thread.status === CLOSED) {
        marks.appendChild(chip('is_shut', t`settled`, t`Resolved, the stake was acted on`));
    }
    if (thread.status === MOOT) {
        marks.appendChild(chip('is_moot', t`moot`, t`No longer about anything, not resolved, stopped applying`));
    }
    if (thread.status === OPEN_STATUS && isFull(thread)) {
        marks.appendChild(chip(thread.dial?.kind === PROGRESS ? 'is_done' : 'is_fired',
            thread.dial?.kind === PROGRESS ? t`complete` : t`fired`,
            thread.dial?.kind === PROGRESS ? t`The track filled, this was achieved` : t`The clock filled, this happened`));
    }
    if (thread.restored) {
        marks.appendChild(chip('is_back', t`recalled`, t`Brought back out of the cold store when the story returned to it`));
    }
    if (marks.childElementCount) {
        head.appendChild(marks);
    }

    if (thread.dial) {
        head.appendChild(dialNode(thread));
    }

    // Make Active.
    //
    // On the head rather than inside the disclosure, because it is the one control the tab exists
    // for and a control you must expand a record to reach is a control nobody finds. `aria-pressed`
    // rather than a label swap alone: it is a toggle, and re-pinning the pinned thread clears it, so
    // the button is genuinely its own off-switch (`state.setActiveThread`).
    const pin = el('button', `sanguine_thr_pin${isPinned ? ' is_on' : ''}`);
    pin.type = 'button';
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.title = isPinned ? t`Unpin, go back to what the story is touching` : t`Make active, the thread you are pushing on`;
    pin.setAttribute('aria-label', pin.title);
    pin.appendChild(el('i', 'fa-solid fa-thumbtack'));
    pin.addEventListener('click', (event) => {
        event.stopPropagation();
        state.setActiveThread(thread.key);
        ctx.refresh();
    });
    head.appendChild(pin);

    row.appendChild(head);

    // The consequence, always visible: a thread is a line of prose with a meter attached, never a
    // meter with a label. `about` is what happens when the dial completes; `open` is what acting
    // would settle. A dial-less thread has only the second, so whichever exists leads.
    const lead = thread.dial ? (thread.about || thread.open) : (thread.open || thread.about);
    if (lead) {
        row.appendChild(el('p', 'sanguine_thr_lead', sentenceCase(lead)));
    }

    // The record.
    const detail = el('div', 'sanguine_thr_detail');
    detail.id = detailId;
    detail.hidden = true;

    const list = el('dl', 'sanguine_thr_fields');
    // The stake and its settlement, in that order, reading them as one string is how a thread
    // became indistinguishable from a fact (`panel.js`).
    if (thread.dial && thread.about && thread.open) {
        field(list, t`Still open because`, sentenceCase(thread.open),
            { hint: t`What acting on it would settle.` });
    }
    if (!thread.dial && thread.about && thread.open) {
        field(list, t`If it completes`, sentenceCase(thread.about));
    }
    field(list, t`The specifics`, sentenceCase(thread.detail), { hint: t`Who, where, when.` });
    field(list, t`Where it applies`, sentenceCase(thread.where),
        { hint: t`A thread bound to a place applies only there. One with no place applies everywhere.` });
    field(list, t`Deadline`, deadlineText(thread, now), { mono: true, hint: t`The hour the excerpt scheduled this by.` });
    field(list, t`Advances every`, cadenceText(thread),
        { mono: true, hint: t`The calendar cadence, this front moves as time passes, with no model call.` });
    field(list, t`Also called`, thread.aka);
    field(list, t`Came from`, sentenceCase(thread.source), { hint: t`What raised it.` });
    // The dial's history.
    //
    // Derived every one of them, so mono and tabular: when it was first seen, when it last moved,
    // and where it stands. `stale` is the distance between the last two and the thing the sidebar's
    // recency rail was drawing without ever naming.
    field(list, t`Dial`, thread.dial
        ? `${thread.dial.filled}/${thread.dial.size} · ${thread.dial.kind === PROGRESS ? t`progress track` : t`doom clock`}`
        : '', { mono: true });
    field(list, t`First seen`, Number.isFinite(thread.first) ? `t${thread.first}` : '', { mono: true });
    field(list, t`Last changed`, `t${thread.turn ?? 0}${thread.stale ? ` · ${thread.stale} ${t`turns ago`}` : ` · ${t`this turn`}`}`,
        { mono: true });
    field(list, t`Status`, thread.status, { mono: true });
    if (list.childElementCount) {
        detail.appendChild(list);
    }

    // `steps` deliberately does not appear here, see the note above `threadRow`'s helpers.

    // The affordances a dial never had.
    //
    // The same three the sidebar's dial-less rows offer, through the same writers. A thread is a
    // STORED row rather than a derived one, so these are table writes and not events, there is no
    // fold to re-derive them from, which is also why a delete is one delete and not two.
    const acts = el('div', 'sanguine_thr_acts');
    acts.appendChild(action('✓', t`Settled, close this stake the way the review would`, () => {
        if (edits.closeThread(thread.name)) ctx.refresh();
    }));
    acts.appendChild(action('✎', t`Edit this stake`, async () => {
        const changed = await editRow(`${t`Edit`} ${thread.name}`, THREAD_FIELDS, thread);
        // The overlay may have been closed, or navigated away, while the dialog was up, this render
        // no longer owns the body it would be refreshing.
        if (ctx.signal.aborted) return;
        if (changed && Object.keys(changed).length && edits.editThread(thread.name, changed)) ctx.refresh();
    }));
    acts.appendChild(action('×', t`Never was a stake, drop it entirely`, () => {
        if (!edits.deleteThread(thread.key)) return;
        // A pin pointing at a row that no longer exists is a dangling override, and re-pinning the
        // pinned key is how `setActiveThread` clears itself.
        if (state.activeThread() === thread.key) state.setActiveThread(thread.key);
        ctx.refresh();
    }, { danger: true }));
    detail.appendChild(acts);

    // The key, last and quiet. It is what `open({ tab, focus })` navigates by, so it is the one
    // thing worth having in front of you when something did not land where it should have.
    detail.appendChild(el('p', 'sanguine_thr_key', thread.key));

    row.appendChild(detail);

    disclose.addEventListener('click', () => {
        const open = detail.hidden;
        detail.hidden = !open;
        disclose.setAttribute('aria-expanded', String(open));
        row.classList.toggle('is_open', open);
    });

    return row;
}

/**
 * A section of the list.
 *
 * @param {string} label The heading.
 * @param {string} note One line saying what belongs here.
 * @param {object[]} rows The threads.
 * @param {object} context Rendering context, as `threadRow` takes it.
 * @param {Map<string, HTMLElement>} index Key -> row node, filled as rows are built.
 * @returns {HTMLElement|null} The section, or null when it is empty.
 */
function section(label, note, rows, context, index) {
    if (!rows.length) {
        return null;
    }
    const box = el('section', 'sanguine_thr_section');
    const heading = el('h3', 'sanguine_thr_heading');
    heading.appendChild(el('span', 'sanguine_thr_heading_label', label));
    heading.appendChild(el('span', 'sanguine_thr_count', String(rows.length)));
    box.appendChild(heading);
    box.appendChild(el('p', 'sanguine_thr_note', note));

    const list = el('ul', 'sanguine_thr_list');
    for (const thread of rows) {
        const node = threadRow(thread, context);
        index.set(thread.key, node);
        list.appendChild(node);
    }
    box.appendChild(list);
    return box;
}

/**
 * The strip at the top: what is current, and who says so.
 *
 * Names rather than a second copy of the rows, a key that appears twice in one tab has two nodes
 * to reveal and the shell can only highlight one. Each name is a button that scrolls its real row
 * into view, which is `reveal` doing exactly what it does for a navigation from the sidebar.
 *
 * @param {object} current The `currentThreads` split.
 * @param {Map<string, HTMLElement>} index Key -> row node.
 * @param {object} ctx The tab context.
 * @returns {HTMLElement} The strip.
 */
function currentStrip(current, index, ctx) {
    const box = el('div', 'sanguine_thr_current');

    const jump = (thread, cls, text) => {
        const button = el('button', `sanguine_thr_jump ${cls}`.trim(), text);
        button.type = 'button';
        button.title = t`Go to this thread`;
        button.addEventListener('click', () => {
            const node = index.get(thread.key);
            if (node) ctx.reveal(node);
        });
        return button;
    };

    const line = el('div', 'sanguine_thr_current_line');
    line.appendChild(el('span', 'sanguine_thr_label', t`Pinned`));
    if (current.pinned) {
        line.appendChild(jump(current.pinned, 'is_pin', sentenceCase(current.pinned.name)));
    } else if (current.pinnedKey) {
        // A pin outliving its row is worth saying out loud, it is why nothing looks pinned.
        line.appendChild(el('span', 'sanguine_thr_none', t`the pinned thread is no longer in the table`));
    } else {
        line.appendChild(el('span', 'sanguine_thr_none', t`nothing, the story's own reading stands`));
    }
    box.appendChild(line);

    const play = el('div', 'sanguine_thr_current_line');
    play.appendChild(el('span', 'sanguine_thr_label', t`In play`));
    if (current.touched.length) {
        for (const thread of current.touched) {
            play.appendChild(jump(thread, 'is_play', sentenceCase(thread.name)));
        }
    } else {
        play.appendChild(el('span', 'sanguine_thr_none', t`the last window named none of these`));
    }
    box.appendChild(play);

    box.appendChild(el('p', 'sanguine_thr_note',
        t`In play is the model's report of what the last extraction window actually mentioned. Pinning is yours, and it overrides nothing about the record, it says which of these you are pushing on.`));
    return box;
}

/**
 * Draw the tab.
 *
 * Synchronous throughout: every read is a metadata read that has already happened, so there is no
 * await between reading the table and appending the rows, and no window in which `ctx.signal` could
 * fire mid-render. The two async paths are both inside row actions, and both check it.
 *
 * @param {HTMLElement} body The panel, emptied.
 * @param {object} ctx The tab context.
 */
function renderThreadsTab(body, ctx) {
    const turn = entities.turn();
    const at = String(state.loadContext().get('location')?.v ?? '');
    const now = Number(state.loadClock().minutes);
    const covered = coveredThreads();
    const pinned = state.activeThread();

    // `view()`, so this branch's closures count, a thread the review settled on this swipe reads
    // settled here. Unfiltered, deliberately: `sections()` hides what is elsewhere, stale or done,
    // which is right for a 288px glance and wrong for the record. This tab is the record.
    const all = readThreads(clocks.view(), turn, { at });
    const current = currentThreads(all, { pinned, covered });

    const wrap = el('div', 'sanguine_thr');

    // An unknown key is the tab's problem, not the shell's: say the record was not found rather than
    // showing a list that silently is not standing on anything.
    if (ctx.focus && !all.some(thread => thread.key === ctx.focus)) {
        const lost = el('p', 'sanguine_thr_lost');
        lost.appendChild(el('span', '', t`That thread is not in the table, it may have been settled, merged or dropped.`));
        lost.appendChild(el('span', 'sanguine_thr_key', ctx.focus));
        wrap.appendChild(lost);
    }

    if (!all.length) {
        wrap.appendChild(el('p', 'sanguine_thr_empty',
            t`Nothing is at stake yet. Threads arrive as the story raises them, a danger with a clock, an effort with a track, or a question nobody has settled.`));
        body.appendChild(wrap);
        return;
    }

    /** @type {Map<string, HTMLElement>} */
    const index = new Map();

    const context = { ctx, pinned, covered, now };
    const live = all.filter(thread => thread.status === OPEN_STATUS && !isFull(thread));
    const sections = [
        section(t`Pressure`, t`Dangers and deadlines. The dial fills toward something nobody wants.`,
            live.filter(thread => thread.dial?.kind === DOOM), context, index),
        section(t`Progress`, t`Long efforts. The track fills toward something the characters want.`,
            live.filter(thread => thread.dial?.kind === PROGRESS), context, index),
        section(t`Open`, t`Stakes with no dial, unresolved, and not yet measured by anything.`,
            live.filter(thread => !thread.dial), context, index),
        section(t`Settled`, t`Closed, moot, or filled. Kept because a campaign archive exists to preserve the difference.`,
            all.filter(thread => thread.status !== OPEN_STATUS || isFull(thread)), context, index),
    ].filter(Boolean);

    // Built before the strip is appended, because the strip's jump buttons need the row nodes; the
    // strip is inserted first so it reads first.
    wrap.appendChild(currentStrip(current, index, ctx));
    for (const box of sections) {
        wrap.appendChild(box);
    }

    body.appendChild(wrap);

    const target = ctx.focus ? index.get(ctx.focus) : null;
    if (target) {
        // Expand what the player navigated to. Arriving on a collapsed summary of the record you
        // clicked through to read is the trip not finishing.
        const disclose = target.querySelector('.sanguine_thr_disc');
        if (disclose && disclose.getAttribute('aria-expanded') === 'false') disclose.click();
        ctx.reveal(target);
    }
}

registerTab('threads', renderThreadsTab);
