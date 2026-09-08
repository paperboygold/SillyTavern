/**
 * sanguine/overlay-chronicle.js, the chronicle tab: the record, and what recall does with it.
 *
 * What this replaces.
 *
 * `index.js:845` was the chronicle viewer: a `toastr.info` with two numbers in it and a
 * `console.log` of the whole ledger. That is the exact failure `panel.js`'s header names: *if the
 * numbers only exist in a console dump, the feature does not exist*. A campaign's memory was
 * technically inspectable and practically invisible.
 *
 * Two views, and why the second one is the point.
 *
 * **Events** is the history browser. `chronicle.snapshot()` has existed, complete, with zero
 * callers; this is its first reader. It pages, because with a hydrated ledger `MAX_EVENTS` bounds
 * what is HOT rather than what is STORED (`chronicle.js` `applyExtraction`) and a year-long campaign
 * is thousands of rows.
 *
 * **Recall** is what was actually asked for: *the events that would get pulled in via the RAG/fold*.
 * A history browser answers "what does fold remember"; only this answers "what did fold TELL the
 * model", which is the question that decides whether a scene went wrong because the extraction was
 * bad or because the retrieval was. It shows the injected block, the token spend against budget, the
 * three-source rank that produced each item, and, in the same list, everything that was retrieved
 * and then dropped, with the gate that dropped it. Retrieval that silently discards its best-ranked
 * tail is indistinguishable from retrieval that found nothing.
 *
 * The honest gap: there is no in-fiction time on an event.
 *
 * The time rail down the left is the time each event was RECORDED (`event.t`, `Date.now()` at
 * extraction), not the hour the story was standing in when it happened. The chronicle does not stamp
 * the narrative clock onto events, and it cannot start: `state.js` derives its state by folding over
 * these very events, so `chronicle.js` importing `state.js` to read the clock would close a cycle.
 * Stamping it would also only ever describe events recorded after the change. The rail is therefore
 * labelled for what it is, and the narrative clock is shown once, at the top, as the story's own
 * position. Inventing a per-event fiction time out of the wall clock would be a lie told in mono.
 */

import { t } from '../../i18n.js';
import * as chronicle from './chronicle.js';
import * as recall from './recall.js';
import { RRF_K } from './recall-table.js';
import { close, registerTab } from './overlay.js';
import { jumpToMessage } from './diagnostics-view.js';
import { formatClock, formatDate } from './clock.js';
import { loadClock } from './state.js';

/** Id of the injected stylesheet, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-chronicle-css';

/**
 * Put `overlay-chronicle.css` in the document head, once.
 *
 * The same pattern `overlay.js` uses for its own sheet, for the same two reasons: `manifest.json`
 * declares exactly one stylesheet and `style.css` already holds it, and a URL derived from
 * `import.meta.url` is found wherever the extension is installed from.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-chronicle.css', import.meta.url).href;
    document.head.appendChild(link);
}

// At import time rather than at first paint: a sheet that starts loading once the tab is on screen
// paints the rows unstyled for a frame.
ensureStylesheet();

/**
 * Rows drawn per page.
 *
 * The list is paged rather than virtualised because the rows are variable-height prose and a
 * windowing scheme over variable heights needs a measured-height cache that is wrong on every
 * resize. Sixty rows is more than one screen at any size, and the sentinel below loads the next
 * page before the reader reaches the bottom, so paging is invisible until the campaign is genuinely
 * enormous; at that point it is the thing keeping the tab openable at all.
 */
const PAGE = 60;

/**
 * Why a retrieved candidate did not make it into the prompt, in the order the gates are applied.
 *
 * Each is a sentence and not a word, because "duplicate: 3" is a number and "already represented by
 * something ranked above it" is an explanation. The reason strings themselves come from
 * `selectEvidence`, which is the only place these decisions are made.
 */
const DROP_REASONS = [
    ['budget', 'Ranked well enough to be worth injecting, but the token budget was already spent.'],
    ['covered', 'World Info is putting this in the prompt already; recall does not pay twice to say it.'],
    ['duplicate', 'Already represented by something ranked above it, or by the message it came from.'],
    ['missing', 'The candidate carried no text, so there was nothing to inject.'],
    ['capped', 'Past the twenty-item ceiling on one recall block.'],
];

/**
 * How each retrieval source is introduced. Fold fuses three RANKINGS, and a reader who does not
 * know what the third one is will read "recency 2" as a score.
 */
const SOURCE_BLURBS = {
    chronicle: 'BM25 over the event keywords, restricted to this branch.',
    vectors: 'Similarity over past chat messages, from the vectors extension.',
    recency: 'Newest first. A ranking, not a decay curve: it breaks ties and lifts the recent past.',
};

/**
 * The tab's own view state.
 *
 * Module-scoped and deliberately not persisted, exactly like `overlay.js`'s `lastTab`: which pane
 * and which filter a reader left the tab on is a convenience for the next click in this session, and
 * a filter restored a week later reads as a bug ("where are my events?").
 */
const view = {
    /** @type {'events'|'recall'} */
    pane: 'events',
    /** Free-text filter over summaries and keywords. */
    q: '',
    /** @type {'all'|'live'|'dead'} */
    live: 'all',
    /** @type {'all'|'delta'} */
    delta: 'all',
    /** A day bucket key from the rail, or '' for the whole campaign. */
    bucket: '',
    /** How many rows of the filtered list are drawn. */
    shown: PAGE,
};

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. Always text, never HTML; most of this is model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * A real button, because Space, Enter, the focus ring and the announcement all come free with one.
 * @param {string} className Class list.
 * @param {string} text Label.
 * @param {() => void} onClick Handler.
 * @param {string} [title] Tooltip and accessible name when the label is a bare number.
 * @returns {HTMLButtonElement} The button.
 */
function button(className, text, onClick, title = '') {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, text));
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    node.addEventListener('click', onClick);
    return node;
}

/**
 * A segmented control: one choice out of a few, as buttons rather than a `<select>`.
 * @param {string} label What the group is choosing.
 * @param {Array<[string, string]>} options `[value, label]` pairs.
 * @param {string} current The selected value.
 * @param {(value: string) => void} onPick Called with the new value.
 * @returns {HTMLElement} The group.
 */
function segmented(label, options, current, onPick) {
    const group = el('div', 'sanguine_chron_seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    for (const [value, text] of options) {
        const node = button('sanguine_chron_segbtn', text, () => onPick(value));
        node.setAttribute('aria-pressed', String(value === current));
        if (value === current) node.classList.add('sanguine_chron_segbtn_on');
        group.appendChild(node);
    }
    return group;
}

/** @param {number} at Epoch ms. @returns {string} A local day key, or '' when unstamped. */
function dayKey(at) {
    if (!at) {
        return '';
    }
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** @param {number} at Epoch ms. @returns {string} "14:32", or '--:--' when unstamped. */
function hourOf(at) {
    if (!at) {
        return '--:--';
    }
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** @param {number} at Epoch ms. @returns {string} How long ago, coarsely. */
function ago(at) {
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return t`${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t`${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t`${hours}h ago`;
    return t`${Math.round(hours / 24)}d ago`;
}

/**
 * Leave the overlay and land the chat on a message.
 *
 * Two things have to happen that the shared `jumpToMessage` cannot do from inside a modal:
 *
 *   1. **Close first, and wait for the dialog to actually go.** The overlay is a `<dialog>` opened
 *      with `showModal()`, so the chat behind it is inert; a scroll nobody can see is not a jump.
 *      `close()` resolves before the teardown, which the popup layer runs inside `runAfterAnimation`
 *      (utils.js:2223) once the 150ms exit animation ends, so the dialog outlives the promise.
 *
 *   2. **Land the scroll.** `jumpToMessage` (diagnostics-view.js:48) scrolls with
 *      `behavior: 'smooth'`, and measured in this app that call moves `#chat` by exactly zero:
 *      `scrollTop` stayed 0 across two seconds, where the same call with `'auto'` landed at 23561.
 *      It is the same failure `overlay.js` documents on `reveal` and fixed there by dropping smooth.
 *      `diagnostics-view.js` is owned elsewhere, so this repeats the scroll rather than editing it:
 *      `jumpToMessage` still runs, because the highlight and the cause-link belong to it and every
 *      other caller shares them. DELETE THE SECOND SCROLL once that file drops `'smooth'` too.
 *
 * @param {number} mid The message id to land on.
 */
async function jumpTo(mid) {
    await close();
    for (let i = 0; i < 20 && document.querySelector('dialog.sanguine_overlay_popup'); i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    jumpToMessage(mid);
    document.querySelector(`.mes[mesid="${Number(mid)}"]`)?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

/**
 * A short uppercase badge. `--s-micro` is the floor and it is for exactly this, never for prose.
 * @param {string} text The label.
 * @param {string} [tone] A modifier class suffix.
 * @returns {HTMLElement} The badge.
 */
function badge(text, tone = '') {
    return el('span', `sanguine_chron_badge${tone ? ` sanguine_chron_badge_${tone}` : ''}`, text);
}

/* The events browser. */

/**
 * Which of a snapshot's rows survive the current filters.
 *
 * The text match is a lowercase substring over the summary and the model's own keywords. That is
 * shape, not language: it makes no judgement about what the words MEAN, which is the line
 * `trigger-table.js` draws and `sanguine-no-prose-regex.test.js` enforces.
 *
 * @param {Array<object>} rows Snapshot rows.
 * @returns {Array<object>} The visible ones, newest first.
 */
function filtered(rows) {
    const needle = view.q.trim().toLowerCase();
    return rows.filter((row) => {
        if (view.live === 'live' && !row.live) return false;
        if (view.live === 'dead' && row.live) return false;
        if (view.delta === 'delta' && !row.delta) return false;
        if (view.bucket && dayKey(row.at) !== view.bucket) return false;
        if (!needle) return true;
        if (String(row.summary).toLowerCase().includes(needle)) return true;
        return (row.keywords ?? []).some(word => String(word).toLowerCase().includes(needle));
    });
}

/**
 * The time rail: one entry per day the record was written on.
 *
 * It is a filter and an index at once. On a long campaign it is also the only affordance that gets
 * a reader to March without scrolling through February, which is what a rail is for.
 *
 * @param {Array<object>} rows All snapshot rows.
 * @param {() => void} repaint Redraw the browser.
 * @returns {HTMLElement} The rail.
 */
function buildRail(rows, repaint) {
    const rail = el('div', 'sanguine_chron_rail');

    const clock = loadClock();
    const heading = el('div', 'sanguine_chron_railhead');
    heading.appendChild(el('div', 'sanguine_chron_label', t`Story clock`));
    const now = el('div', 'sanguine_chron_storyclock');
    const reading = Number.isFinite(clock.minutes) ? formatClock(clock.minutes) : '--:--';
    now.appendChild(el('span', 'sanguine_chron_num', reading));
    if (clock.day) {
        now.appendChild(el('span', 'sanguine_chron_num sanguine_chron_dim', t`day ${clock.day}`));
    }
    heading.appendChild(now);
    const written = formatDate(clock.date);
    if (written) {
        heading.appendChild(el('div', 'sanguine_chron_storydate', written));
    }
    heading.appendChild(el('div', 'sanguine_chron_railnote',
        t`Events below are filed by the time they were recorded. The chronicle does not stamp the story clock onto them.`));
    rail.appendChild(heading);

    /** @type {Map<string, {count: number, live: number, delta: number, at: number}>} */
    const buckets = new Map();
    for (const row of rows) {
        const key = dayKey(row.at);
        const bucket = buckets.get(key) ?? { count: 0, live: 0, delta: 0, at: row.at };
        bucket.count++;
        if (row.live) bucket.live++;
        if (row.delta) bucket.delta++;
        bucket.at = Math.max(bucket.at, row.at);
        buckets.set(key, bucket);
    }

    const list = el('div', 'sanguine_chron_buckets');
    list.appendChild(bucketButton('', t`All`, { count: rows.length, live: rows.filter(r => r.live).length }, repaint));
    for (const [key, bucket] of [...buckets.entries()].sort((a, b) => b[1].at - a[1].at)) {
        const label = key
            ? new Date(bucket.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
            : t`undated`;
        list.appendChild(bucketButton(key, label, bucket, repaint));
    }
    rail.appendChild(list);
    return rail;
}

/**
 * One day on the rail.
 * @param {string} key The bucket key, '' for all.
 * @param {string} label What it reads.
 * @param {{count: number, live: number}} bucket Its tallies.
 * @param {() => void} repaint Redraw.
 * @returns {HTMLButtonElement} The button.
 */
function bucketButton(key, label, bucket, repaint) {
    const node = button('sanguine_chron_bucket', '', () => {
        view.bucket = view.bucket === key ? '' : key;
        view.shown = PAGE;
        repaint();
    });
    node.setAttribute('aria-pressed', String(view.bucket === key));
    if (view.bucket === key) node.classList.add('sanguine_chron_bucket_on');
    node.appendChild(el('span', 'sanguine_chron_bucketday', label));
    const tally = el('span', 'sanguine_chron_buckettally');
    tally.appendChild(el('span', 'sanguine_chron_num', String(bucket.count)));
    const dead = bucket.count - bucket.live;
    if (dead > 0) {
        // The exception, not the norm, so the rail states the OFF-BRANCH count rather than the live
        // one. Two bare numbers side by side would need a legend; one number and a minus does not.
        const off = el('span', 'sanguine_chron_num sanguine_chron_bucketoff', `−${dead}`);
        off.title = t`${dead} off this branch`;
        tally.appendChild(off);
    }
    node.appendChild(tally);
    return node;
}

/**
 * One event.
 *
 * The typeface does the work here. The time and the hit count are DERIVED: mono, tabular. The
 * summary is what the extraction model wrote about the fiction: body face, prose. A reader can tell
 * a measurement from a sentence without reading either.
 *
 * @param {object} row A snapshot row.
 * @param {(keyword: string) => void} onKeyword Filter by a keyword.
 * @returns {HTMLElement} The row.
 */
function eventRow(row, onKeyword) {
    const node = el('li', 'sanguine_chron_row');
    node.dataset.key = row.key;
    if (!row.live) node.classList.add('sanguine_chron_row_dead');

    node.appendChild(el('span', 'sanguine_chron_when', hourOf(row.at)));

    const bodyCol = el('div', 'sanguine_chron_rowbody');
    bodyCol.appendChild(el('p', 'sanguine_chron_summary', row.summary));

    const tags = el('div', 'sanguine_chron_tags');
    for (const keyword of row.keywords ?? []) {
        tags.appendChild(button('sanguine_chron_chip', keyword,
            () => onKeyword(keyword), t`Filter by ${keyword}`));
    }
    if (row.delta) {
        // A delta is what makes an event load-bearing rather than decorative: state is a fold over
        // these, so this row is the reason something is in the inventory.
        tags.appendChild(badge(t`state`, 'delta'));
    }
    if (!row.live) {
        // Retained, not deleted. A swipe replaced the message this was read from, so it is off the
        // branch; navigate back and it returns. Hiding it would make the record look shorter than
        // it is; deleting it would make swiping destructive.
        tags.appendChild(badge(t`off-branch`, 'dead'));
    }
    if (row.src === 'user') {
        tags.appendChild(badge(t`by hand`, 'user'));
    }
    if (row.hits) {
        tags.appendChild(el('span', 'sanguine_chron_num sanguine_chron_hits', `×${row.hits}`));
    }
    bodyCol.appendChild(tags);
    node.appendChild(bodyCol);

    if (Number.isInteger(row.mid)) {
        node.appendChild(button('sanguine_chron_jump', `#${row.mid}`,
            () => void jumpTo(row.mid), t`Jump to message ${row.mid}`));
    } else {
        node.appendChild(el('span', 'sanguine_chron_jump sanguine_chron_jump_none', '-'));
    }

    return node;
}

/**
 * The events browser.
 * @param {HTMLElement} stage Where to draw.
 * @param {import('./overlay.js').TabContext} ctx The tab context.
 * @param {number} [attempt] Which empty-record retry this is. See below.
 */
function paintEvents(stage, ctx, attempt = 0) {
    const snap = chronicle.snapshot();
    const repaint = () => paintEvents(stage, ctx);

    stage.replaceChildren();

    if (!snap.total) {
        stage.appendChild(el('p', 'sanguine_chron_empty',
            t`Nothing recorded yet. The chronicle fills in as extraction runs over the story.`));

        // An empty record and an unfinished hydrate look identical from here.
        //
        // `ledger.hydrate()` is a fetch kicked off on CHAT_CHANGED, and for the second or two it is
        // in flight `loadEvents` answers from an empty table. Measured on the live app: opening this
        // tab straight after switching to a 302-event campaign showed "Nothing recorded yet." The
        // tab cannot see the fetch (`ledger.isHydrated()` is already true while it lands), so it
        // simply looks again, a bounded number of times, and stops. A wrong answer that corrects
        // itself in a second beats a spinner that has to be told when to stop.
        if (attempt < 3) {
            const timer = setTimeout(() => {
                if (!ctx.signal.aborted) paintEvents(stage, ctx, attempt + 1);
            }, 700);
            ctx.signal.addEventListener('abort', () => clearTimeout(timer));
        }
        return;
    }

    // A focus key is a navigation TO one record. Arriving to find it filtered out of view would be
    // the shell keeping its promise and the tab breaking it, so the filters step aside.
    const wanted = String(ctx.focus ?? '');
    let missing = false;
    if (wanted) {
        const hit = snap.events.find(row => row.key === wanted || row.anchor === wanted);
        if (hit) {
            view.q = '';
            view.live = 'all';
            view.delta = 'all';
            view.bucket = '';
            view.shown = Math.max(PAGE, snap.events.indexOf(hit) + 1);
        } else {
            missing = true;
        }
    }

    const head = el('div', 'sanguine_chron_head');
    const counts = el('div', 'sanguine_chron_counts');
    counts.appendChild(el('span', 'sanguine_chron_num sanguine_chron_big', String(snap.total)));
    counts.appendChild(el('span', 'sanguine_chron_headlabel', t`events recorded`));
    counts.appendChild(el('span', 'sanguine_chron_num sanguine_chron_big', String(snap.live)));
    counts.appendChild(el('span', 'sanguine_chron_headlabel', t`live on this branch`));
    head.appendChild(counts);
    if (snap.bounded) {
        // Only worth saying when it is true: against a hydrated ledger the cap is a view bound and
        // nothing has been lost, so claiming a limit there would be a false alarm.
        head.appendChild(el('p', 'sanguine_chron_bound',
            t`This chat stores its record in chat metadata, so it keeps only the newest ${snap.max} events. Older ones are archived.`));
    }
    stage.appendChild(head);

    if (missing) {
        const note = el('p', 'sanguine_chron_notfound');
        note.appendChild(el('span', '', t`No event with that key is in this chat's record; it may have been forgotten, amended, or belong to another chat.`));
        note.appendChild(el('code', 'sanguine_chron_key', wanted));
        stage.appendChild(note);
    }

    const filters = el('div', 'sanguine_chron_filters');
    const search = /** @type {HTMLInputElement} */ (el('input', 'sanguine_chron_search'));
    search.type = 'search';
    search.value = view.q;
    search.placeholder = t`Filter by keyword or summary`;
    search.setAttribute('aria-label', t`Filter events`);
    search.addEventListener('input', () => {
        view.q = search.value;
        view.shown = PAGE;
        // Redraw only the list: rebuilding the whole browser would take the focus out of the box
        // between keystrokes.
        drawList();
    });
    filters.appendChild(search);
    filters.appendChild(segmented(t`Branch`, [
        ['all', t`All`], ['live', t`Live`], ['dead', t`Off-branch`],
    ], view.live, (value) => {
        view.live = /** @type {'all'|'live'|'dead'} */ (value);
        view.shown = PAGE;
        repaint();
    }));
    filters.appendChild(segmented(t`State`, [
        ['all', t`Any`], ['delta', t`Changed state`],
    ], view.delta, (value) => {
        view.delta = /** @type {'all'|'delta'} */ (value);
        view.shown = PAGE;
        repaint();
    }));
    stage.appendChild(filters);

    const panes = el('div', 'sanguine_chron_panes');
    panes.appendChild(buildRail(snap.events, repaint));

    const listWrap = el('div', 'sanguine_chron_listwrap');
    panes.appendChild(listWrap);
    stage.appendChild(panes);

    /** @type {IntersectionObserver|null} */
    let watcher = null;
    ctx.signal.addEventListener('abort', () => watcher?.disconnect());

    /** Draw (or redraw) the filtered, paged list. */
    function drawList() {
        watcher?.disconnect();
        listWrap.replaceChildren();

        const rows = filtered(snap.events);
        if (!rows.length) {
            listWrap.appendChild(el('p', 'sanguine_chron_empty', t`No event matches these filters.`));
            return;
        }

        const shown = Math.min(view.shown, rows.length);
        const list = el('ul', 'sanguine_chron_list');
        const onKeyword = (keyword) => {
            view.q = keyword;
            view.shown = PAGE;
            repaint();
        };
        for (const row of rows.slice(0, shown)) {
            list.appendChild(eventRow(row, onKeyword));
        }
        listWrap.appendChild(list);

        if (shown < rows.length) {
            const remaining = rows.length - shown;
            const more = button('sanguine_chron_more',
                t`Show ${Math.min(PAGE, remaining)} more, ${remaining} left`, () => {
                    view.shown += PAGE;
                    drawList();
                });
            listWrap.appendChild(more);

            // Auto-page as the button comes into view, so the reader scrolls rather than clicks.
            // The button stays a real button: it is what a keyboard and a screen reader use, and
            // what happens when the observer is unavailable.
            if (typeof IntersectionObserver === 'function') {
                watcher = new IntersectionObserver((entries) => {
                    if (entries.some(entry => entry.isIntersecting) && !ctx.signal.aborted) {
                        view.shown += PAGE;
                        drawList();
                    }
                }, { root: listWrap.closest('.sanguine_overlay_panel'), rootMargin: '200px' });
                watcher.observe(more);
            }
        }

        if (wanted && !missing) {
            // The key may address the event's own table key or the content key its whole extraction
            // batch is anchored on, so the row is found by the same two-way match the lookup above
            // used; and then addressed by its table key, which is what `data-key` holds.
            const hit = snap.events.find(row => row.key === wanted || row.anchor === wanted);
            const target = hit ? list.querySelector(`[data-key="${CSS.escape(hit.key)}"]`) : null;
            if (target instanceof HTMLElement) {
                ctx.reveal(target);
            }
        }
    }

    drawList();
}

/* The recall view. */

/**
 * The per-source ranks that produced one fused item, as chips.
 *
 * This is the whole reason `fuse` carries `by` now. A fused score of 0.0312 is not an explanation of
 * anything; "the chronicle ranked it 1st and recency ranked it 3rd" is, and it is also how a reader
 * catches a retrieval that is running on recency alone because the vector store is switched off.
 *
 * @param {Record<string, number>} by Source label -> zero-based rank.
 * @returns {HTMLElement} The chip row.
 */
function provenanceChips(by) {
    const wrap = el('span', 'sanguine_chron_prov');
    const labels = Object.keys(by ?? {});
    if (!labels.length) {
        return wrap;
    }
    // Sorted by how well each source rated it, so the source most responsible reads first.
    for (const label of labels.sort((a, b) => by[a] - by[b])) {
        const chip = el('span', `sanguine_chron_prov_chip sanguine_chron_prov_${label}`);
        chip.appendChild(el('span', 'sanguine_chron_provname', label));
        // Ranks are zero-based inside the fusion and one-based on screen; nobody reads "ranked 0th".
        chip.appendChild(el('span', 'sanguine_chron_num', `#${by[label] + 1}`));
        chip.title = SOURCE_BLURBS[label] ?? '';
        wrap.appendChild(chip);
    }
    return wrap;
}

/**
 * One retrieved candidate, injected or dropped.
 * @param {object} item The item, carrying its provenance.
 * @param {string} [reason] The gate that dropped it, if it was dropped.
 * @returns {HTMLElement} The row.
 */
function evidenceRow(item, reason = '') {
    const node = el('li', `sanguine_chron_ev${reason ? ' sanguine_chron_ev_out' : ''}`);

    const rank = el('div', 'sanguine_chron_evrank');
    rank.appendChild(el('span', 'sanguine_chron_num', `#${(item.rank ?? 0) + 1}`));
    rank.appendChild(el('span', 'sanguine_chron_num sanguine_chron_dim', Number(item.score ?? 0).toFixed(4)));
    node.appendChild(rank);

    const bodyCol = el('div', 'sanguine_chron_evbody');
    bodyCol.appendChild(el('p', 'sanguine_chron_summary', item.text || t`(no text)`));
    const meta = el('div', 'sanguine_chron_evmeta');
    if (item.source) {
        meta.appendChild(badge(item.source, item.source === 'chronicle' ? 'delta' : 'user'));
    }
    meta.appendChild(provenanceChips(item.by));
    if (Number(item.agree ?? 0) > 1) {
        // Multi-source agreement is the signal fusion exists to produce, and it is the tiebreak in
        // `rankFused`. Worth naming rather than leaving the reader to infer it from the chips.
        meta.appendChild(badge(t`${item.agree} sources agree`, 'agree'));
    }
    if (Number.isFinite(item.cost)) {
        meta.appendChild(el('span', 'sanguine_chron_num sanguine_chron_dim', t`${item.cost} tok`));
    }
    bodyCol.appendChild(meta);
    node.appendChild(bodyCol);

    return node;
}

/**
 * The token spend, as a bar and as numbers.
 * @param {number} tokens Spent.
 * @param {number} budget Allowed.
 * @returns {HTMLElement} The meter.
 */
function budgetMeter(tokens, budget) {
    const wrap = el('div', 'sanguine_chron_budget');
    const share = budget > 0 ? Math.min(1, tokens / budget) : 0;

    const bar = el('div', 'sanguine_chron_bar');
    bar.setAttribute('role', 'meter');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(budget));
    bar.setAttribute('aria-valuenow', String(tokens));
    bar.setAttribute('aria-label', t`Recall token budget`);
    const fill = el('div', 'sanguine_chron_barfill');
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    // The semantic axis, spent on meaning: a block at its ceiling is dropping evidence it ranked
    // highly, which is the thing this view exists to make visible.
    if (share >= 1) fill.classList.add('sanguine_chron_barfill_full');
    else if (share >= 0.85) fill.classList.add('sanguine_chron_barfill_near');
    bar.appendChild(fill);
    wrap.appendChild(bar);

    const read = el('div', 'sanguine_chron_budgetread');
    read.appendChild(el('span', 'sanguine_chron_num sanguine_chron_big', String(tokens)));
    read.appendChild(el('span', 'sanguine_chron_headlabel', t`of ${budget} tokens`));
    wrap.appendChild(read);
    return wrap;
}

/**
 * The recall view.
 * @param {HTMLElement} stage Where to draw.
 */
function paintRecall(stage) {
    stage.replaceChildren();
    const last = recall.lastSelection();

    if (!last) {
        const empty = el('div', 'sanguine_chron_empty');
        empty.appendChild(el('p', '', t`Nothing retrieved yet in this chat.`));
        empty.appendChild(el('p', '', t`Recall runs once per generation: it queries the chronicle, the vector store and the recent past, fuses the three rankings, and injects what fits the budget. Send a message and this fills in.`));
        stage.appendChild(empty);
        return;
    }

    const head = el('div', 'sanguine_chron_head');
    const when = el('div', 'sanguine_chron_counts');
    when.appendChild(el('span', 'sanguine_chron_headlabel', t`last generation`));
    when.appendChild(el('span', 'sanguine_chron_num', ago(last.at)));
    when.appendChild(el('span', 'sanguine_chron_headlabel', t`candidates`));
    when.appendChild(el('span', 'sanguine_chron_num', String(last.candidates)));
    when.appendChild(el('span', 'sanguine_chron_headlabel', t`injected`));
    when.appendChild(el('span', 'sanguine_chron_num', String(last.items.length)));
    head.appendChild(when);
    head.appendChild(budgetMeter(last.tokens, last.budget));
    stage.appendChild(head);

    // What was asked. Model-facing prose, so it is prose here, and collapsed because it is the
    // last few turns of the chat and would otherwise be the whole view.
    const asked = el('details', 'sanguine_chron_query');
    asked.appendChild(el('summary', 'sanguine_chron_label', t`The query it retrieved against`));
    asked.appendChild(el('p', 'sanguine_chron_querytext', last.query || t`(empty)`));
    stage.appendChild(asked);

    const sources = el('div', 'sanguine_chron_sources');
    sources.appendChild(el('div', 'sanguine_chron_label', t`Sources fused, reciprocal rank, k=${RRF_K}`));
    const legend = el('ul', 'sanguine_chron_sourcelist');
    for (const source of last.sources ?? []) {
        const row = el('li', 'sanguine_chron_source');
        row.appendChild(el('span', `sanguine_chron_prov_chip sanguine_chron_prov_${source.label}`, source.label));
        row.appendChild(el('span', 'sanguine_chron_num', t`${source.count} found`));
        row.appendChild(el('span', 'sanguine_chron_num sanguine_chron_dim', t`weight ${source.weight}`));
        row.appendChild(el('span', 'sanguine_chron_sourceblurb', SOURCE_BLURBS[source.label] ?? ''));
        legend.appendChild(row);
    }
    sources.appendChild(legend);
    if (last.covered) {
        sources.appendChild(el('p', 'sanguine_chron_sourcenote',
            t`${last.covered} World Info entries were activated for this turn; anything they already say was suppressed below.`));
    }
    stage.appendChild(sources);

    const injected = el('section', 'sanguine_chron_section');
    injected.appendChild(el('h4', 'sanguine_chron_label', t`Injected into the prompt`));
    if (last.items.length) {
        const list = el('ul', 'sanguine_chron_evlist');
        for (const item of last.items) {
            list.appendChild(evidenceRow(item));
        }
        injected.appendChild(list);
    } else {
        injected.appendChild(el('p', 'sanguine_chron_empty', t`Nothing was injected; every candidate was dropped, or nothing was retrieved.`));
    }
    stage.appendChild(injected);

    const dropped = last.dropped ?? [];
    for (const [reason, blurb] of DROP_REASONS) {
        const group = dropped.filter(item => item.reason === reason);
        if (!group.length) {
            continue;
        }
        const section = el('section', 'sanguine_chron_section sanguine_chron_section_out');
        const title = el('h4', 'sanguine_chron_label');
        title.appendChild(el('span', '', t`Skipped, ${reason}`));
        title.appendChild(el('span', 'sanguine_chron_num', String(group.length)));
        section.appendChild(title);
        section.appendChild(el('p', 'sanguine_chron_why', blurb));
        const list = el('ul', 'sanguine_chron_evlist');
        for (const item of group) {
            list.appendChild(evidenceRow(item, reason));
        }
        section.appendChild(list);
        stage.appendChild(section);
    }

    if (!dropped.length && last.items.length) {
        stage.appendChild(el('p', 'sanguine_chron_why', t`Nothing was dropped: everything retrieved fitted the budget and said something new.`));
    }
}

/* The tab. */

registerTab('chronicle', (body, ctx) => {
    // A focus key addresses one event, and events live in the browser. Arriving on Recall with a key
    // in hand would answer a question nobody asked.
    if (ctx.focus) {
        view.pane = 'events';
    }

    const root = el('div', 'sanguine_chron');
    const stage = el('div', 'sanguine_chron_stage');

    /** Draw whichever pane is selected. */
    const draw = () => {
        if (ctx.signal.aborted) return;
        if (view.pane === 'recall') {
            paintRecall(stage);
        } else {
            paintEvents(stage, ctx);
        }
    };

    const switcher = el('div', 'sanguine_chron_switch');
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', t`Chronicle views`);
    for (const [pane, label, hint] of [
        ['events', t`Events`, t`Everything the record holds.`],
        ['recall', t`Recall`, t`What the last generation actually retrieved and injected.`],
    ]) {
        const node = button('sanguine_chron_switchbtn', label, () => {
            view.pane = /** @type {'events'|'recall'} */ (pane);
            for (const other of switcher.children) {
                const on = other === node;
                other.classList.toggle('sanguine_chron_switchbtn_on', on);
                other.setAttribute('aria-pressed', String(on));
            }
            draw();
        });
        node.title = hint;
        node.setAttribute('aria-pressed', String(view.pane === pane));
        if (view.pane === pane) node.classList.add('sanguine_chron_switchbtn_on');
        switcher.appendChild(node);
    }

    root.appendChild(switcher);
    root.appendChild(stage);
    body.appendChild(root);

    draw();
});
