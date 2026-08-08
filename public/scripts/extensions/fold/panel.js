/**
 * fold/panel.js — the tracker panel.
 *
 * The point of tracking state is seeing it while you play. Everything else in this extension is
 * plumbing for this surface: if the numbers only exist in a console dump, the feature does not
 * exist.
 *
 * ── The organising idea ──
 *
 * The first version printed fields. Label, value, next label — nine sections at one weight, so the
 * year 1998 was set exactly as loudly as a deadline twenty minutes out. Everything on it was true
 * and nothing on it was *related*, which is what made it read as a debug dump with a border.
 *
 * This version relates them. Time held against a stated deadline is a countdown. A condition held
 * against how long it lasts is a timer. An item held against where it is is a question of reach.
 * None of those are new facts — every one was already on screen, twice, unconnected.
 *
 * Two rules carry the layout:
 *
 *   · Derived numbers are set in the mono face; anything a narrator wrote is set as prose. If you
 *     can see the typeface, you know whether a model or a fold produced it.
 *   · Recency is a two-pixel rail, not a word. "What changed this turn" is answered peripherally,
 *     with no diff view and no extra text.
 *
 * Follows SillyTavern's own moving-panel convention (`#movingDivs`, `panelControlBar`,
 * `drag-grabber`, `dragElement`) so it drags, resizes and remembers its position exactly like the
 * Author's Note and World Info panels.
 */

import { eventSource, event_types } from '../../../script.js';
import { dragElement } from '../../RossAscends-mods.js';
import { loadMovingUIState } from '../../power-user.js';
import { t } from '../../i18n.js';
import * as state from './state.js';
import * as entities from './entities.js';
import * as clocks from './clocks.js';
import { LONG_STATEMENT, isNegation, splitClauses } from './block-parse.js';
import { DISPOSITIONS, LEAD_LABELS, PERSON_LABELS, dispositionRank } from './entity-table.js';
import {
    findDeadline,
    formatClock,
    formatDate,
    formatGap,
    parseClock,
    splitLocation,
    timeUntil,
} from './clock.js';
import { ABILITIES, ASSETS, CARRIED, CATEGORIES, MONEY } from './state-table.js';

const PANEL_ID = 'foldTracker';

/** Audit-trail rows shown before the rest collapse into a single "N earlier" line. */
const TRAIL_LIMIT = 6;

/**
 * Context labels the header owns. Everything else falls through to the generic section.
 *
 * `conditions` left this list in Phase D. It was rendered inside the header joined to the weather,
 * which is precisely how *"Bandaged calf"* came to read as a property of the Goblin Market
 * (`FOLD-REDESIGN.md` §0, §3). A body is not a place: the pov's afflictions are marks and render
 * under Condition, and everyone else's render on their own row.
 */
const SCENE_FIELDS = ['time', 'date', 'location', 'weather'];

/**
 * Context labels the header no longer draws and nothing else should draw either.
 *
 * A v1 chat that has not migrated yet still has `conditions` in its context, and a card may write a
 * `Health:` label at any time. Dropping them from SCENE_FIELDS without claiming them here would move
 * the body-state prose out of the header and into the generic aside section — the same string, one
 * heading lower, which is not what "the scene header loses body-state" means.
 */
const BODY_FIELDS = ['conditions', 'health'];

/** Context labels the entity view replaces once extraction has produced structure. */
const ENTITY_FIELDS = { people: PERSON_LABELS, leads: LEAD_LABELS };

let visible = false;
let onToggleOff = () => {};
let onToggleOpen = () => {};
/** Section headers the player collapsed this session, so a re-render keeps them collapsed. */
const collapsedSections = new Set();

/**
 * Build the panel markup, matching the structure SillyTavern's own floating panels use.
 * @returns {HTMLElement} The panel element.
 */
function buildPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.classList.add('drawer-content', 'flexGap5');

    // The RPG-companion collapse handle: a chevron tab straddling the panel's left edge. `>` while
    // expanded (push me back to the right), `<` while collapsed (pull me out). This is the strip's
    // whole history in one control — see the collapsed body below.
    const toggle = document.createElement('button');
    toggle.className = 'fold_toggle';
    toggle.type = 'button';
    toggle.appendChild(el('i', 'fa-solid fa-chevron-right'));
    panel.appendChild(toggle);

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

    // The collapsed altitude lives inside the panel now — the strip is the panel folded to the
    // right edge, not a separate top bar. Its segments render here and it is clickable to expand.
    const collapsedBody = document.createElement('div');
    collapsedBody.className = 'fold_collapsed_body';
    collapsedBody.title = t`Open fold tracker`;
    collapsedBody.addEventListener('click', () => {
        show();
        onToggleOpen();
    });
    panel.appendChild(collapsedBody);

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
 * Capitalise the first letter only.
 *
 * CSS `text-transform: capitalize` capitalises every word, which turns "cigarettes and papers"
 * into "Cigarettes And Papers". Item names are stored lowercased for key stability, so the
 * display casing has to be applied here instead.
 *
 * @param {string} text Input.
 * @returns {string} Sentence-cased text.
 */
function sentenceCase(text) {
    const value = String(text ?? '');
    return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * A section heading, optionally with a count on the right.
 * @param {string} label The heading.
 * @param {number|string} [count] A count or annotation.
 * @returns {HTMLElement} The heading row.
 */
function section(label, count) {
    const head = el('div', 'fold_sec');
    head.appendChild(el('span', null, label));
    if (count !== undefined && count !== '') {
        head.appendChild(el('span', 'fold_sec_n', String(count)));
    }
    return head;
}

/**
 * Split a field value into short chips and long remainder.
 *
 * "cool, overcast, light drizzle; apartment secured and quiet" is three atmospheric facts and one
 * clause. The first three are chips because they are labels; the fourth is a sentence and set as
 * one, because a four-word chip is a chip and a nine-word chip is a paragraph in a costume.
 *
 * @param {string} value A field value.
 * @returns {{chips: string[], rest: string[]}} The split.
 */
function chipsAndRest(value) {
    const parts = String(value ?? '')
        .split(/[;,]/)
        .map(part => part.trim())
        .filter(Boolean);

    const chips = [];
    const rest = [];
    for (const part of parts) {
        (part.split(/\s+/).length <= 4 ? chips : rest).push(part);
    }
    return { chips, rest };
}

/**
 * Render a field value as bullets when it is a list, or a paragraph when it is a sentence.
 *
 * The fallback path, used for context fields fold has no structure for. Cards invent their own
 * labels and it is better to show one verbatim than to drop it for not fitting a schema.
 *
 * @param {string} value Field value.
 * @param {object} [options] Options.
 * @param {boolean} [options.dropNegations] Whether to hide clauses that assert nothing is wrong.
 * @returns {HTMLElement} A list or a paragraph.
 */
function bulletsOrProse(value, { dropNegations = false } = {}) {
    const text = String(value ?? '').trim();
    let parts = text.split(/[;]|,(?=\s)|\bbut\b|\botherwise\b/).map(part => part.trim()).filter(Boolean);

    if (dropNegations) {
        const afflictions = parts.filter(part => !isNegation(part));
        if (!afflictions.length) {
            return el('div', 'fold_prose', sentenceCase(text));
        }
        parts = afflictions;
    }

    const listy = parts.length > 1 && parts.every(part => part.split(/\s+/).length <= 6);
    if (!listy) {
        return el('div', 'fold_prose', sentenceCase(parts.join(', ')));
    }
    const list = el('ul', 'fold_bullets');
    for (const part of parts) {
        list.appendChild(el('li', null, sentenceCase(part)));
    }
    return list;
}


/**
 * A card-authored field rendered as separate statements rather than one run of prose.
 *
 * Used for leads, contacts, objectives — anything the extraction probe has not yet turned into
 * entities. Long statements clamp to two lines and open on click, so six leads stay scannable
 * without hiding any of them.
 *
 * @param {string} value The field value.
 * @returns {HTMLElement} A list.
 */
function statementList(value) {
    const list = el('ul', 'fold_list');
    for (const statement of splitClauses(value)) {
        const row = el('li', 'fold_row fold_stmt');
        row.appendChild(rail(1));

        const textEl = el('span', 'fold_stmt_text', sentenceCase(statement));
        row.appendChild(textEl);

        if (statement.length > LONG_STATEMENT) {
            row.classList.add('fold_clamped');
            const caret = el('span', 'fold_caret', '›');
            row.appendChild(caret);
            textEl.setAttribute('role', 'button');
            textEl.setAttribute('tabindex', '0');
            textEl.setAttribute('aria-expanded', 'false');

            const toggle = () => {
                const open = row.classList.toggle('fold_open_clamp');
                textEl.setAttribute('aria-expanded', String(open));
            };
            textEl.addEventListener('click', toggle);
            textEl.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                }
            });
        }
        list.appendChild(row);
    }
    return list;
}

/**
 * The scene header: when, where, and what the weather is doing.
 *
 * Two rows became one line and gained emphasis doing it. You glance at a clock; you do not read it,
 * and a five-line address is not a glance.
 *
 * @param {Map<string, string>} scene Scene fields by label.
 * @returns {HTMLElement|null} The header, or null when there is no scene yet.
 */
function sceneHeader(scene, clock) {
    const contests = clock?.contests ?? [];
    const time = scene.get('time');
    const date = scene.get('date');
    const location = scene.get('location');
    const pov = scene.get('pov');
    // Weather alone. What used to be `[conditions, weather].join('; ')` is the measured defect
    // §0 opens with — see SCENE_FIELDS.
    const conditions = scene.get('weather') ?? '';

    if (!time && !date && !location && !conditions && !pov) {
        return null;
    }

    const head = el('div', 'fold_head');

    // Whose story this is. It sits above the clock because it is the one fact on the panel that
    // does not change between turns, and because a tracker that never names the protagonist reads
    // as a tracker for somebody else — which is exactly how it looked when the point-of-view
    // character was filed under People alongside the people he was fighting.
    if (pov) {
        const row = el('div', 'fold_pov');
        lockable(row, 'pov', clock?.locks, contests);
        row.appendChild(el('span', 'fold_pov_name', pov));
        head.appendChild(row);
    }

    if (time || date) {
        const row = el('div', 'fold_clock');
        const minutes = parseClock(time);
        // A time fold cannot parse is still the narrator's time, and is shown as written rather
        // than dropped for failing to be a clock.
        row.appendChild(el('span', 'fold_hh', minutes === null ? (time ?? '') : formatClock(minutes)));
        if (date) {
            row.appendChild(el('span', 'fold_dd', formatDate(date)));
        }
        // A clock nothing has confirmed for several exchanges is shown as stopped, not as the time.
        // Seeing "13:03 · 6 turns" is the difference between knowing the clock has stuck and
        // believing an afternoon never happened.
        if (clock?.stale) {
            row.classList.add('fold_clock_stale');
            row.appendChild(el('span', 'fold_dd fold_clock_age', `· ${clock.age} ${t`turns`}`));
        }
        head.appendChild(row);
    }

    if (location) {
        const { place, qualifier } = splitLocation(location);
        const row = el('div', 'fold_loc');
        lockable(row, 'location', clock?.locks, contests);
        row.appendChild(el('span', 'fold_loc_place', place));
        if (qualifier) {
            row.appendChild(el('span', 'fold_loc_q', ` — ${qualifier}`));
        }
        lockable(row, 'time', clock?.locks, contests);
        head.appendChild(row);
    }

    if (conditions) {
        const { chips, rest } = chipsAndRest(conditions);
        if (chips.length) {
            const strip = el('div', 'fold_chips');
            for (const chip of chips) {
                strip.appendChild(el('span', 'fold_chip', sentenceCase(chip)));
            }
            head.appendChild(strip);
        }
        for (const line of rest) {
            head.appendChild(el('div', 'fold_prose fold_cond_rest', sentenceCase(line)));
        }
    }

    return head;
}

/**
 * Make a scene row lockable: click to pin the field so the narrator cannot overwrite it.
 *
 * The cheap version of Marinara's 1036-line lock system, and it is cheap because fold's scene
 * header is five flat labels rather than cells inside arrays that renumber under edits. Clicking
 * the row is the whole affordance — there is no lock column, because a column of padlocks on a
 * 288px panel costs more than it explains.
 *
 * @param {HTMLElement} row The row.
 * @param {string} label The field it shows.
 * @param {string[]} [locks] Currently locked labels.
 */
function lockable(row, label, locks, contests) {
    row.classList.add('fold_lockable');
    if ((locks ?? []).includes(label)) {
        row.classList.add('fold_locked');
    }
    // ── A lock that has fallen out with the story says so ──
    //
    // The lock did its job seven times on the live Solo Leveling chat and the panel showed an empty
    // room in a scene containing the player: every disagreeing write was discarded and nothing on
    // screen distinguished a pinned value the story agrees with from one it has left behind
    // (FOLD-REDESIGN.md §0.1-2, §5). This is the smallest honest signal — the existing lock rail in
    // the warning hue rather than the fresh one, and the narrative's own value in the tooltip.
    // Clicking still toggles the lock, which is what accepting the narrative amounts to: unlock it
    // and the next restatement lands. The full accept/keep affordance is Phase F's.
    const contest = (contests ?? []).find(entry => entry.field === label);
    if (contest) {
        row.classList.add('fold_contested');
        row.title = t`The story says` + ` "${contest.narrativeValue}" (${contest.count}×). ` + t`Click to unpin and accept it`;
    } else {
        row.title = t`Click to pin this field so the narrator cannot change it`;
    }
    row.addEventListener('click', () => {
        const now = state.setLock(label);
        row.classList.toggle('fold_locked', now);
        render();
    });
}

/**
 * The soonest deadline the fiction has stated, if it has stated one.
 *
 * This is the panel's whole thesis in one function. The tracker already knew it was 07:38 and
 * already knew RPD systems went offline at 08:00; twenty-two minutes is not new information, it is
 * the only interesting reading of two facts that were on screen and unconnected.
 *
 * @param {Map<string, string>} scene Scene fields.
 * @param {object[]} leads Dial-less threads.
 * @returns {{label: string, detail: string, gap: object}|null} The nearest deadline, or null.
 */
function nearestDeadline(scene, leads) {
    const now = parseClock(scene.get('time'));
    if (now === null) {
        return null;
    }

    const candidates = [];
    for (const lead of leads) {
        const at = findDeadline(`${lead.name} ${lead.detail}`);
        if (at !== null) {
            candidates.push({ label: lead.name, detail: lead.detail, at, key: lead.key });
        }
    }
    // The card's own leads field, for chats where extraction has not run yet. Split into clauses
    // first: the field is a comma-joined run of several leads, and taking the first eighty
    // characters of the whole thing puts an unrelated sentence next to the countdown.
    for (const label of ENTITY_FIELDS.leads) {
        const raw = scene.get(label);
        if (!raw) continue;
        for (const clause of String(raw).split(/[;,](?=\s)|(?<=\.)\s+/)) {
            const at = findDeadline(clause);
            if (at !== null) {
                candidates.push({ label: clause.trim(), detail: '', at });
            }
        }
    }

    const timed = candidates
        .map(candidate => ({ ...candidate, gap: timeUntil(now, candidate.at) }))
        .filter(candidate => candidate.gap)
        .sort((a, b) => (a.gap.passed === b.gap.passed ? a.gap.minutes - b.gap.minutes : a.gap.passed ? 1 : -1));

    return timed[0] ?? null;
}

/**
 * Jump the chat to the message that caused a value change.
 *
 * The cause-link (FOLD-REDESIGN.md §8, altitude 3): "click a contributor → the chat scrolls to the
 * causing message". SillyTavern renders every chat line with `mesid`, so the jump is a selector and
 * a scroll — no stored position, no state to keep in sync.
 *
 * @param {number} mid The message id a contributor is anchored to.
 */
function jumpToMessage(mid) {
    const node = document.querySelector(`.mes[mesid="${Number(mid)}"]`);
    if (!node) {
        return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('fold_jump_target');
    setTimeout(() => node.classList.remove('fold_jump_target'), 2000);
}

/**
 * Make a node editable in place, committing on blur or Enter.
 *
 * §8's edit-in-place, in its simplest honest form: display-form/edit-form swap on focus,
 * commit-on-blur/Enter, placeholder-on-empty. Every commit goes through the caller's `onCommit`,
 * which is a ledger user event (`state.adjustItem` / `setContext`) — hand edits stay auditable and
 * swipe-safe, the §0 repair script becomes clicking.
 *
 * @param {HTMLElement} node The display node to make editable.
 * @param {object} [opts] Options.
 * @param {(value: string) => void} [opts.onCommit] Called with the raw text on commit.
 */
function makeEditable(node, { onCommit = () => {} } = {}) {
    node.classList.add('fold_editable');
    node.addEventListener('click', (event) => {
        // The count sits inside the item head, whose own click toggles the cause-link trail.
        // Entering edit mode must not also flip the disclosure — one click, one job.
        event.stopPropagation();
        node.contentEditable = 'plaintext-only';
        node.focus();
        document.getSelection()?.selectAllChildren(node);
    });
    const commit = () => {
        if (node.contentEditable !== 'plaintext-only') {
            return;
        }
        node.contentEditable = 'inherit';
        const value = node.textContent.trim();
        node.classList.toggle('fold_empty', !value);
        onCommit(value);
    };
    node.addEventListener('blur', commit);
    node.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            node.blur();
        }
    });
}

/**
 * One inventory row, with its audit trail behind a disclosure.
 *
 * The trail used to be a `title` attribute — a newline-joined dump the browser renders as an
 * unstyled tooltip, in the OS font, after a delay, positioned wherever it likes, and dismissed by
 * moving the mouse. It read as a debug artefact because that is exactly what it was. A click-to-
 * expand list is the same information given a shape: aligned deltas, running total, real type.
 *
 * @param {object} item An entry from `state.snapshot().inventory`.
 * @returns {HTMLElement} The `li`.
 */
function itemRow(item) {
    const row = el('li', 'fold_row fold_item');
    row.appendChild(rail(item.since));

    const head = el('div', 'fold_item_head');
    head.appendChild(el('span', 'fold_item_name', sentenceCase(item.name)));
    if (item.place === MONEY) {
        // An amount, not a multiplier. "Won ×9999" reads as nine thousand separate wons, and was
        // also a lie — the count was clamped to an item ceiling that has no business bounding money.
        // Editable in place; the delta is committed with `at: 'money'` so it lands on the balance,
        // not in a pocket (the mid-46 clamp lesson, FOLD-REDESIGN.md §8).
        const money = el('span', 'fold_meta fold_money fold_editable', item.qty.toLocaleString());
        makeEditable(money, {
            onCommit: (value) => {
                const next = Math.trunc(Number(String(value).replace(/[^\d-]/g, '')) || 0);
                const delta = next - item.qty;
                if (delta !== 0 && state.adjustItem(item.name, delta, 'money')) {
                    render();
                }
            },
        });
        head.appendChild(money);
    } else if (item.qty > 1) {
        const count = el('span', 'fold_meta fold_editable', `×${item.qty}`);
        makeEditable(count, {
            onCommit: (value) => {
                const next = Math.trunc(Number(String(value).replace(/[^\d-]/g, '')) || 0);
                const delta = next - item.qty;
                if (delta !== 0 && state.adjustItem(item.name, delta)) {
                    render();
                }
            },
        });
        head.appendChild(count);
    }
    row.appendChild(head);

    if (!item.from?.length) {
        return row;
    }

    row.classList.add('fold_has_trail');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(el('span', 'fold_caret', '›'));

    const trail = el('div', 'fold_trail');
    // Only the tail. A long-held item accumulates a contributor per turn that touches it, and a
    // disclosure that opens into forty rows is a log file, not an explanation. The running total
    // still starts from the true beginning, so the arithmetic on screen stays correct.
    const shown = item.from.slice(-TRAIL_LIMIT);
    const hidden = item.from.length - shown.length;
    let running = item.from.slice(0, hidden).reduce((sum, entry) => sum + entry.dq, 0);

    if (hidden > 0) {
        const earlier = el('div', 'fold_trail_row');
        earlier.appendChild(el('span', 'fold_trail_dq', '⋯'));
        earlier.appendChild(el('span', 'fold_trail_sum', `${hidden} ${t`earlier`}`));
        earlier.appendChild(el('span', 'fold_trail_run', String(running)));
        trail.appendChild(earlier);
    }

    for (const entry of shown) {
        running += entry.dq;
        const line = el('div', 'fold_trail_row');
        line.appendChild(el('span', `fold_trail_dq ${entry.dq > 0 ? 'gain' : 'loss'}`,
            `${entry.dq > 0 ? '+' : ''}${entry.dq}`));
        line.appendChild(el('span', 'fold_trail_sum', entry.summary || t`Recorded`));
        line.appendChild(el('span', 'fold_trail_run', String(running)));
        // Cause-link: a contributor with an anchor jumps the chat to the message that caused the
        // change (§8, altitude 3). A contributor without one (legacy, no mid recorded) stays inert.
        if (Number.isFinite(entry.mid)) {
            line.classList.add('fold_trail_jump');
            line.title = t`Jump to the message that caused this`;
            line.addEventListener('click', () => jumpToMessage(entry.mid));
        }
        trail.appendChild(line);
    }
    row.appendChild(trail);

    const toggle = () => {
        const open = row.classList.toggle('fold_open_trail');
        head.setAttribute('aria-expanded', String(open));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });

    return row;
}

/**
 * The recency rail: two pixels of accent whose intensity is how recently this changed.
 *
 * Answers "what happened this turn" without a diff view, a timestamp column, or a word. Anything
 * older than the staleness threshold is already hidden, so the scale only ever spans what is shown.
 *
 * @param {number} since Events since this last changed.
 * @returns {HTMLElement} The rail.
 */
function rail(since) {
    const age = Number.isFinite(since) ? since : 99;
    return el('i', `fold_rail ${age <= 0 ? 'fresh' : age <= 3 ? 'warm' : ''}`.trim());
}

/**
 * One dial: a name, a meter, and what happens when it fills.
 *
 * ── Two shapes, because polarity is not decoration ──
 *
 * A doom draws as the Blades clock face — discrete segments, filling toward something you do not
 * want, urgent past three quarters. A progress track draws as a bar, and deliberately does NOT
 * take the urgency colour, because a track filling is the good news on the panel. Drawing them the
 * same was how "Solomon completes 20 D-rank raids and gains residency" came to sit under
 * `Pressure:` looking exactly like a countdown to disaster (FOLD-REDESIGN.md §0.1-3).
 *
 * Disco Elysium's rule is kept in both: a thread is a line of prose with a meter attached, never a
 * meter with a label.
 *
 * @param {object} thread A thread record carrying a dial.
 * @returns {HTMLElement} The row.
 */
function dialRow(thread) {
    const progress = thread.dial?.kind === clocks.PROGRESS;
    const row = el('li', `fold_row fold_clock_row${progress ? ' fold_progress_row' : ''}`);
    row.appendChild(rail(thread.stale));
    row.appendChild(el('span', 'fold_entity_name', sentenceCase(thread.name)));

    const hidden = thread.seen === 'hidden';
    const size = thread.dial?.size || 6;
    if (progress) {
        const track = el('span', 'fold_track');
        track.title = hidden ? t`Underway — your character cannot tell how far` : `${thread.filled}/${size}`;
        const fill = el('i');
        fill.style.width = `${hidden ? 0 : Math.max(0, Math.min(1, thread.pressure)) * 100}%`;
        track.appendChild(fill);
        // The bar and its fraction are one right-hand cell on the NAME line; the about
        // ("visa granted") drops to its own row below. Split as separate grid items, the
        // fraction and the about shared a cell and ran together (the live panel defect).
        const tail = el('span', 'fold_progress_tail');
        tail.appendChild(track);
        if (!hidden) {
            tail.appendChild(el('span', 'fold_meta', `${thread.filled}/${size}`));
        }
        row.appendChild(tail);
        if (thread.about) {
            row.appendChild(el('span', 'fold_sub', thread.about));
        }
        return row;
    }

    const dial = el('span', `fold_dial${hidden ? ' hidden' : ''}${thread.pressure >= 0.75 ? ' urgent' : ''}`);
    if (hidden) {
        // Named but not quantified. Knowing something is closing in without knowing how close is
        // its own kind of pressure, and it is the honest thing to show for a threat the character
        // cannot perceive.
        dial.title = t`Closing in — your character cannot tell how near`;
        dial.appendChild(el('i', 'fold_seg unknown'));
    } else {
        dial.title = `${thread.filled}/${size}`;
        for (let seg = 0; seg < size; seg++) {
            dial.appendChild(el('i', `fold_seg${seg < thread.filled ? ' on' : ''}`));
        }
    }
    row.appendChild(dial);

    if (thread.about) {
        row.appendChild(el('span', 'fold_sub', thread.about));
    }
    return row;
}

/**
 * One person or lead.
 * @param {object} entity An entity record.
 * @param {string} kind 'person' or 'lead'.
 * @returns {HTMLElement} The row.
 */
function entityRow(entity, kind, { showStatus = true, turn = 0, hedged = false, marks = [] } = {}) {
    const row = el('li', `fold_row fold_entity${hedged ? ' fold_unplaced' : ''}`);
    row.appendChild(rail(entity.stale));
    row.appendChild(el('span', 'fold_entity_name', entity.name));
    // ── Shown in the room, marked as not known to be in the room ──
    //
    // These are people fold has not retracted and cannot place. The panel used to assert them into
    // the scene without saying so, which is how HERE read as five people on a turn when the
    // narration had named none of them (FOLD-REDESIGN.md §0.1-1). Dimmed and suffixed, they stay
    // one glance away without claiming anything.
    if (hedged) {
        row.appendChild(el('span', 'fold_meta fold_hedge', t`· whereabouts unstated`));
    }

    // ── The eye goes to what changed ──
    //
    // `BayesFilter.zero_residual_is_fixed`: a measurement equal to the prediction carries no
    // information. Most of this panel is restatement, so the part that is NOT restatement has to be
    // the part that reads loudest. A resolved item keeps its place one more turn, struck through,
    // so the completion is witnessed rather than silently vanishing.
    const badge = entity.presence === 'gone' ? 'resolved'
        : entity.first === turn && turn > 0 ? 'new'
            : entity.stale === 0 && turn > 0 ? 'updated'
                : '';
    if (badge) {
        row.classList.add(`fold_is_${badge}`);
    }
    // ── The right-hand chips: lifecycle badge, presence status, disposition ──
    //
    // Grouped into ONE grid cell so they sit side by side on the name line instead of
    // auto-placing down the auto column — where each chip took its own row and the status
    // stacked onto the description row below (the live "NEW forces open onto a newline" defect).
    const tail = el('span', 'fold_row_tail');
    if (badge) {
        // `t` is a template tag; calling it with a bare string passes the string as its `strings`
        // array and crashes (`strings.reduce`). The badge is fold's own protocol vocabulary, which
        // this codebase is free to leave in English — the docblock at `entity-table.js` governs.
        tail.appendChild(el('span', `fold_badge fold_badge_${badge}`, badge));
    }
    if (entity.status && showStatus) {
        tail.appendChild(el('span', `fold_meta fold_status_${entity.status}`, entity.status));
    }
    // ── Disposition as a scale you read at a glance ──
    //
    // Five pips, filled to rank. Citizen Sleeper's condition pips are the reference: a shape carries
    // an ordinal faster than a word does, and the word stays in the title for anyone who needs it
    // or cannot see the difference.
    if (kind === 'person' && entity.feels) {
        const rank = dispositionRank(entity.feels);
        const meter = el('span', `fold_feels fold_feels_${entity.feels}`);
        meter.title = `${sentenceCase(entity.feels)} toward you`;
        for (let pip = 0; pip < DISPOSITIONS.length; pip++) {
            meter.appendChild(el('i', `fold_pip${pip <= rank ? ' on' : ''}`));
        }
        tail.appendChild(meter);
    }
    row.appendChild(tail);

    // Place and activity, paired but distinct — "in the stableyard · sparring with Marote" rather
    // than one prose field doing both jobs badly. `reach` joins them rather than hiding inside
    // `detail`: how you contact someone is the thing you look for when they are NOT in the room,
    // and it used to be filed as an item in a pocket (`state-table.js:104-110`).
    const said = kind === 'person'
        ? [entity.place, entity.detail, entity.reach && `${t`reach`}: ${entity.reach}`].filter(Boolean).join(' · ')
        : entity.detail;
    if (said) {
        // The predicate, in the mono face and the relation colour — this is the pairing the flat
        // block destroyed, and setting it as a sibling bullet is exactly the bug being fixed.
        row.appendChild(el('span', kind === 'person' ? 'fold_pred' : 'fold_sub',
            kind === 'person' ? `↳ ${said}` : said));
    }
    // What acting would settle, set apart from the description of what the lead is. Reading these
    // as one string is how a thread became indistinguishable from a fact.
    if (entity.open) {
        row.appendChild(el('span', 'fold_open', entity.open));
    }
    // What they are after, and what they have on you. Set as prose rather than as fields, because
    // "wants supplies for the northern march" reads as a motive and `wants: "supplies"` reads as a
    // database column.
    if (entity.wants) {
        row.appendChild(el('span', 'fold_wants', `wants ${entity.wants}`));
    }
    if (entity.knows) {
        row.appendChild(el('span', 'fold_knows', `knows ${entity.knows}`));
    }
    // ── What is wrong with them, on their row ──
    //
    // The whole of Phase D in one strip of chips. Before `who`, Lee's ribs and Park's thigh were
    // rendered under the PLAYER's Condition heading, because the flag table had no subject
    // (`FOLD-RPG-GAP.md` §3). A mark now renders exactly once, beside the person carrying it.
    if (marks.length) {
        const strip = el('div', 'fold_marks');
        for (const mark of marks) {
            const chip = el('span', `fold_mark fold_mark_${mark.severity || 'moderate'}`, sentenceCase(mark.phrase));
            chip.title = `${sentenceCase(mark.phrase)} — ${mark.severity || 'moderate'}`;
            strip.appendChild(chip);
        }
        row.appendChild(strip);
    }
    // One small integer, and only while they are actually dangerous. A dead hobgoblin's row carries
    // nothing (`entity-table.js` MAX_THREAT).
    if (entity.threat > 0) {
        const meter = el('span', 'fold_threat', `${t`threat`} ${entity.threat}`);
        meter.title = t`Actively dangerous. The review clears this when the fight ends.`;
        row.appendChild(meter);
    }
    // Standing truths that do not age. `rank: "E-Rank Hunter"` spent thirty-three turns in scene
    // context being dropped from the prompt for staleness (`FOLD-REDESIGN.md` §0).
    if (entity.facts) {
        row.appendChild(el('span', 'fold_facts', entity.facts));
    }
    // Provenance, in the mono face, because it is a citation rather than prose. A third of play is
    // querying records; a lead should say which record.
    if (entity.source) {
        row.appendChild(el('span', 'fold_src', entity.source));
    }
    return row;
}

/**
 * Redraw from derived state. Cheap enough to run on every message: the fold is over at most a few
 * hundred events, and the alternative is a cache that can disagree with the ledger.
 */
export function render() {
    // The strip is the collapsed altitude, so every render pass refreshes it too — even when the
    // panel itself is hidden, the glance line stays current (§8: "the collapsed form of the panel,
    // not a separate feature").
    renderStrip();
    const target = body();
    if (!target || !visible) {
        return;
    }

    const snapshot = state.snapshot();
    const scene = new Map(snapshot.context.map(field => [field.label, field.value]));
    const cast = entities.snapshot({
        at: scene.get('location') ?? '',
        pov: scene.get('pov') ?? '',
    });
    const stakes = clocks.sections(cast.turn, scene.get('location') ?? '');
    // Marks, grouped by the cast row they belong to. `owner` is a table key resolved through the
    // alias set in `state.snapshot()`, so the panel never has to know that a name and a title can be
    // the same person.
    const marksBy = new Map();
    for (const mark of snapshot.marks ?? []) {
        if (mark.mine || !mark.owner) continue;
        marksBy.set(mark.owner, [...(marksBy.get(mark.owner) ?? []), mark]);
    }
    const marksFor = person => marksBy.get(person.key) ?? [];
    target.replaceChildren();

    const health = scene.get('health');

    // Context labels the entity view has taken over. Kept in `scene` for the deadline scan and for
    // the fallback below, but never rendered twice.
    const claimed = new Set([...SCENE_FIELDS, ...BODY_FIELDS, 'pov']);

    // The point-of-view character is not a member of the cast he is observing — `entities.snapshot`
    // has already resolved him through the alias set and removed him from both lists. The panel
    // used to do this itself with a whole-string comparison, which is why "Hero" and "Solomon"
    // both appeared: two names for one man, and neither equal to the other.
    if (cast.people.length || cast.unplaced.length) ENTITY_FIELDS.people.forEach(label => claimed.add(label));
    if (stakes.open.length || stakes.pressure.length) ENTITY_FIELDS.leads.forEach(label => claimed.add(label));

    const head = sceneHeader(scene, { ...snapshot.clock, locks: snapshot.locks, contests: snapshot.contests });
    if (head) {
        target.appendChild(head);
    }

    const deadline = nearestDeadline(scene, stakes.open);

    // ── You: the protagonist, their body and their money ──
    //
    // §8 restructures the glance to lead with the person at the centre — identity, vitals, marks,
    // money — before pressure or company. "How am I doing" is answered in one glance, and money
    // stops being a thing in a pocket under Stuff: it is a balance, not an inventory row.
    const moneyItems = snapshot.inventory.filter(item => item.place === MONEY);
    const you = section(t`You`);
    if (scene.get('pov')) {
        you.appendChild(el('span', 'fold_meta', sentenceCase(scene.get('pov'))));
    }
    target.appendChild(you);

    for (const vital of snapshot.vitals) {
        const row = el('div', 'fold_vital');
        const vhead = el('div', 'fold_vital_head');
        vhead.appendChild(el('span', 'fold_vital_name', sentenceCase(vital.name)));
        vhead.appendChild(el('span', 'fold_meta', `${Math.round(vital.cur)}/${Math.round(vital.max)}`));
        row.appendChild(vhead);

        const bar = el('div', 'fold_bar');
        const fill = el('span');
        const ratio = vital.max > 0 ? Math.max(0, Math.min(1, vital.cur / vital.max)) : 0;
        fill.style.width = `${ratio * 100}%`;
        fill.classList.add(ratio <= 0.25 ? 'critical' : ratio <= 0.5 ? 'low' : 'ok');
        bar.appendChild(fill);
        row.appendChild(bar);
        target.appendChild(row);
    }

    // Tracked conditions first, because those are the ones that tick. The narrator's own prose is
    // a FALLBACK, not a companion: showing both gives "Mild hangover" from the fold and "Mild
    // hangover, otherwise uninjured" from the block, which is the same fact twice and was exactly
    // the stacked-health-lines complaint.
    if (snapshot.status.length || health) {
        target.appendChild(section(t`Condition`));
        const list = el('ul', 'fold_list');
        for (const flag of snapshot.status) {
            const row = el('li', `fold_row fold_cond fold_mark_${flag.severity || 'moderate'}`);
            row.appendChild(rail(0));
            row.appendChild(el('span', null, sentenceCase(flag.phrase)));
            // The severity word, printed for anything above the mildest rank. `minor` is left
            // unstated for the same reason `renderLedger` leaves it out: labelling every scratch
            // "minor" spends the line saying "nothing much".
            if (flag.severity && flag.severity !== 'minor') {
                row.appendChild(el('span', 'fold_meta fold_sev', flag.severity));
            }
            if (flag.turns > 0) {
                // Fading, not counting down in words: the exact number of turns left is a
                // precision the extraction never had.
                row.appendChild(el('span', 'fold_meta', flag.fade > 0.5 ? t`persists` : t`fading`));
                const dur = el('div', 'fold_dur');
                const fill = el('i');
                fill.style.width = `${Math.max(0, Math.min(1, flag.fade)) * 100}%`;
                dur.appendChild(fill);
                row.appendChild(dur);
            }
            list.appendChild(row);
        }
        if (list.childElementCount) {
            target.appendChild(list);
        }
        // Only when the fold has nothing of its own to say. Reassurances are dropped either way —
        // "otherwise uninjured" is the absence of a condition, not one.
        if (health && !snapshot.status.length) {
            target.appendChild(bulletsOrProse(health, { dropNegations: true }));
        }
    }

    // Money, under You — a balance with its cause-link trail, not a row in Stuff.
    if (moneyItems.length) {
        const list = el('ul', 'fold_list');
        for (const money of moneyItems) {
            list.appendChild(itemRow(money));
        }
        target.appendChild(list);
    }

    // The soonest stated deadline, loud, before the pressure it belongs to.
    if (deadline) {
        const alert = el('div', `fold_alert ${deadline.gap.passed ? 'passed' : ''}`.trim());
        const text = el('div', 'fold_alert_text');
        text.appendChild(el('div', 'fold_alert_name', sentenceCase(deadline.label)));
        if (deadline.detail) {
            text.appendChild(el('div', 'fold_sub', sentenceCase(deadline.detail)));
        }
        alert.appendChild(text);
        alert.appendChild(el('span', 'fold_alert_gap',
            deadline.gap.passed ? t`passed` : formatGap(deadline.gap.minutes)));
        target.appendChild(alert);
    }

    // ── Stuff: what you carry and where you left things, deferred to after Elsewhere ──
    //
    // §8's glance order is You → Pressure → Progress → Here → Elsewhere → Stuff → Threads: the
    // nouns of what you own come after the people and the world, because "what threatens me" and
    // "who is here" answer the glance before "what is in my pockets". Money no longer ranks first
    // here — it lives under You.
    const stuff = document.createDocumentFragment();
    const places = new Map();
    let hidden = 0;
    for (const item of snapshot.inventory) {
        if (!item.fresh) {
            hidden++;
            continue;
        }
        if (item.place === MONEY) {
            continue;
        }
        const list = places.get(item.place) ?? [];
        list.push(item);
        places.set(item.place, list);
    }

    // Carried first, then the places you left things, then the two categories last — property and
    // capability are the least volatile things on the panel and the least often consulted mid-scene.
    const rank = place => (place === CARRIED ? 1 : CATEGORIES.has(place) ? 3 : 2);
    const ordered = [...places.keys()].sort((a, b) =>
        rank(a) - rank(b) || a.localeCompare(b));

    const HEADINGS = { [CARRIED]: t`Carrying`, [ASSETS]: t`Property`, [ABILITIES]: t`Abilities` };

    for (const place of ordered) {
        const items = places.get(place);
        stuff.appendChild(section(HEADINGS[place] ?? sentenceCase(place), items.length));
        const list = el('ul', 'fold_list');
        for (const item of items) {
            list.appendChild(itemRow(item));
        }
        stuff.appendChild(list);
    }

    // Named, not dropped. These are still held and still in the ledger; they have simply stopped
    // being mentioned, and a panel that silently omits them reads as a panel that lost them.
    if (hidden) {
        const note = el('div', 'fold_prose fold_hidden_note',
            `${hidden} ${t`not mentioned lately — still held, not sent to the model`}`);
        stuff.appendChild(note);
    }

    // ── Pressure, above the cast ──
    //
    // The one section that says what is ABOUT to happen rather than what is already true, so it
    // sits where the eye lands first. A hidden dial is named but not quantified: the panel never
    // tells you what your character does not know, and never pretends nothing is happening either.
    if (stakes.pressure.length) {
        target.appendChild(section(t`Pressure`, stakes.pressure.length));
        const list = el('ul', 'fold_list');
        for (const thread of stakes.pressure) {
            list.appendChild(dialRow(thread));
        }
        target.appendChild(list);
    }

    // ── Progress, its own section and never inside Pressure ──
    //
    // A dial that fills on success is not pressure, and for as long as they shared a table the
    // panel and the injection both said it was. Separate heading, bar rather than clock face.
    if (stakes.progress.length) {
        target.appendChild(section(t`Progress`, stakes.progress.length));
        const list = el('ul', 'fold_list');
        for (const thread of stakes.progress) {
            list.appendChild(dialRow(thread));
        }
        target.appendChild(list);
    }

    if (cast.people.length || cast.unplaced.length) {
        target.appendChild(section(t`Here`, cast.people.length + cast.unplaced.length));
        const list = el('ul', 'fold_list');
        // A column with one value in it is not a column. Everyone in the room being "present" is
        // the normal case, and stamping it four times says nothing while costing a chip's width;
        // the moment one person is remote or gone, the distinction is worth drawing and returns.
        const mixed = new Set(cast.people.map(person => person.status)).size > 1;
        for (const person of cast.people) {
            list.appendChild(entityRow(person, 'person', { showStatus: mixed, turn: cast.turn, marks: marksFor(person) }));
        }
        // After the people the scene actually contains, and visibly hedged. Sorting them last is
        // part of the honesty: the reader meets what is known before what is merely not retracted.
        for (const person of cast.unplaced) {
            list.appendChild(entityRow(person, 'person', { showStatus: false, turn: cast.turn, hedged: true, marks: marksFor(person) }));
        }
        target.appendChild(list);
    }

    // ── Demoted, not deleted ──
    //
    // People the story has left behind keep their last known place and stay one glance away. This is
    // ScenePulse's Character Wiki and Marinara's absence block — whose own wording is the point:
    // "this list does not mean everyone is present now". Dropping them entirely would lose exactly
    // the thing that makes a returning character feel remembered rather than reintroduced.
    const away = cast.elsewhere;
    if (away.length) {
        const head = section(t`Elsewhere`, away.length);
        head.classList.add('fold_head_quiet');
        target.appendChild(head);
        const list = el('ul', 'fold_list fold_list_quiet');
        for (const person of away) {
            list.appendChild(entityRow(person, 'person', { showStatus: false, turn: cast.turn, marks: marksFor(person) }));
        }
        target.appendChild(list);
    }

    // ── Stuff, after the world ──
    //
    // §8's order: You → Pressure → Progress → Here → Elsewhere → Stuff → Threads. What you own is
    // the least urgent thing on the panel — the nouns come after the people and the pressure.
    target.appendChild(stuff);

    // The thread the countdown came from is already at the top of the panel, in a louder form.
    const remaining = stakes.open.filter(thread => thread.key !== deadline?.key);
    if (remaining.length) {
        target.appendChild(section(t`Threads`, remaining.length));
        const list = el('ul', 'fold_list');
        for (const thread of remaining) {
            list.appendChild(entityRow(thread, 'lead', { turn: cast.turn }));
        }
        target.appendChild(list);
    }

    // ── Struck through, for one turn ──
    //
    // A thread that closed or became moot holds its place once so the completion is witnessed.
    // ScenePulse does the same for quests; a change nobody saw reads as a tracker that lost
    // something. `moot` is drawn differently from `closed` on purpose — the campaign archive's
    // whole value is the difference between "we did it" and "it stopped mattering".
    if (stakes.done.length) {
        const head = section(t`Settled`, stakes.done.length);
        head.classList.add('fold_head_quiet');
        target.appendChild(head);
        const list = el('ul', 'fold_list fold_list_quiet');
        for (const thread of stakes.done) {
            const row = entityRow(thread, 'lead', { turn: cast.turn, showStatus: false });
            row.classList.add(thread.status === 'moot' ? 'fold_is_moot' : 'fold_is_resolved');
            list.appendChild(row);
        }
        target.appendChild(list);
    }

    // Whatever else the card chose to report, shown as given rather than dropped for not fitting a
    // schema — including contacts and leads when extraction has not yet produced structure.
    const aside = snapshot.context.filter(field => !claimed.has(field.label));
    for (const field of aside) {
        const statements = splitClauses(field.value);
        target.appendChild(section(sentenceCase(field.label), statements.length > 1 ? statements.length : ''));
        target.appendChild(statements.length > 1
            ? statementList(field.value)
            : bulletsOrProse(field.value));
    }

    // ── What the block-shadow routing could not parse, shown as the card wrote it ──
    //
    // `absorb.js` now routes `leads`, `pressure` and `health` fields into the thread and status
    // pipelines instead of parking them in context, so those labels no longer appear above. What a
    // pipeline refuses is kept verbatim rather than destroyed (`state.js` `noteShadow`, and Phase
    // B's precedent for the migration's own refusals) — and a refusal nobody can see is a refusal
    // nobody can correct, which is the whole argument for the rejects tally beside it.
    const shadow = snapshot.shadow ?? [];
    if (shadow.length) {
        const head = section(t`Not parsed`, shadow.length);
        head.classList.add('fold_head_quiet');
        target.appendChild(head);
        const list = el('ul', 'fold_list fold_list_quiet');
        for (const entry of shadow) {
            const row = el('li', 'fold_row');
            row.appendChild(el('span', 'fold_prose', sentenceCase(entry.text)));
            row.title = `${entry.label}: ${entry.reason}`;
            list.appendChild(row);
        }
        target.appendChild(list);
    }

    const empty = !head && !deadline && !snapshot.vitals.length && !snapshot.status.length
        && !places.size && !moneyItems.length && !aside.length && !shadow.length
        && !cast.people.length && !cast.unplaced.length
        && !stakes.open.length && !stakes.pressure.length && !stakes.progress.length && !health;
    if (empty) {
        target.appendChild(el('div', 'fold_empty',
            t`Nothing tracked yet. It fills in as the story establishes where you are and what you have.`));
    } else {
        const foot = el('div', 'fold_foot');
        const events = snapshot.inventory.reduce((sum, item) => sum + (item.from?.length ?? 0), 0);
        // "0 changes" is a count of a ledger this chat has never written to. Most cards have no
        // stat block at all, and reporting zero there reads as a failure rather than as a feature
        // going unused — the footer should describe what happened, not what didn't.
        if (events) {
            foot.appendChild(el('span', null, `${events} ${t`changes`}`));
        }
        // A narrator that stops restating its block is normal — measured, they arrive in bursts —
        // but a gap nobody can see is indistinguishable from a tracker that has died. Null means no
        // block has EVER arrived, which is not a gap and must not be counted as one.
        if (snapshot.sinceBlock !== null && snapshot.sinceBlock >= 2) {
            foot.appendChild(el('span', 'fold_foot_gap', `${snapshot.sinceBlock} ${t`turns unreported`}`));
        }
        const rejects = snapshot.rejects.reduce((sum, entry) => sum + entry.count, 0);
        if (rejects) {
            // The rejection tally, visible. A validation layer nobody can see is one nobody trusts,
            // and one that gets ripped out the first time the state looks wrong.
            foot.title = snapshot.rejects.map(entry => `${entry.count}× ${entry.reason}`).join('\n');
            foot.appendChild(el('span', null, `${rejects} ${t`rejected`}`));
        }
        // Every line in it is now conditional, so the bar itself has to be. An empty rule under the
        // panel is a footer that says nothing while looking like it meant to.
        if (foot.childElementCount) {
            target.appendChild(foot);
        }
    }

    // ── Collapsible sections ──
    //
    // A click on any section header hides the list that follows, so a crowded panel can be
    // thinned without configuration (§8's "progressive disclosure must be structural"). The
    // choice is remembered for the session across re-renders, because every render rebuilds the
    // DOM and a collapse that forgets itself on the next message is a feature nobody will use.
    for (const sec of target.querySelectorAll('.fold_sec')) {
        const label = sec.textContent.trim();
        sec.setAttribute('role', 'button');
        sec.setAttribute('tabindex', '0');
        if (collapsedSections.has(label)) {
            sec.classList.add('fold_collapsed');
        }
        const toggle = () => {
            const on = sec.classList.toggle('fold_collapsed');
            if (on) {
                collapsedSections.add(label);
            } else {
                collapsedSections.delete(label);
            }
        };
        sec.addEventListener('click', toggle);
        sec.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    }
}

/**
 * The collapsed sidebar — altitude 1 (FOLD-REDESIGN.md §8).
 *
 * The strip used to be a separate bar pinned to the top of the page, where it sat on SillyTavern's
 * own top bar and painted itself in the theme's *foreground* colour (--SmartThemeBodyColor is the
 * text colour; 92% of it is white). Both were the same mistake twice over. The strip is the panel
 * folded to the right edge now, and its surface is the same --SmartThemeBlurTintColor the panel
 * already uses:
 *
 *   14:07 / the broker's shop / ₩330,000 / ◔ 1/20   (stacked, spine-wise, in the collapsed rail)
 *
 * Time, place, money, the most urgent doom dial, and a transient band-coloured flash when a verdict
 * fires. Nothing on it is configurable — it renders whatever exists and collapses the segments that
 * don't. Clicking anywhere on it expands the panel, so a glance becomes altitude 2 without the
 * strip costing anything to maintain.
 */

let stripTimer = null;

/** The collapsed-body container inside the panel, or null before initPanel. */
function collapsedBody() {
    return document.querySelector(`#${PANEL_ID} .fold_collapsed_body`);
}

/**
 * Whether the sidebar is currently mounted (the collapsed form, or the expanded panel on top of it).
 * @returns {boolean} True when the panel exists and is mounted.
 */
export function stripVisible() {
    return !!document.getElementById(PANEL_ID)?.classList.contains('fold_mounted');
}

/**
 * Mount or unmount the sidebar outright (fold disabled, for example).
 *
 * Mounting is `next || visible`: an expanded panel stays on screen even when the state track is
 * off — the collapsed rail is what follows the state switch, the panel itself is the player's own
 * choice. Unmounting requires both to be off.
 * @param {boolean} next Whether the collapsed rail should be mounted.
 */
export function setStripVisible(next) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }
    panel.classList.toggle('fold_mounted', !!(next || visible));
    if (next || visible) {
        renderStrip();
    }
}

/**
 * Render the collapsed rail: whatever segments exist, in the §8 order, empty ones dropped.
 *
 * The rail and the panel are the same data — `state.snapshot()` — at different altitudes. This is
 * `ledgerBlock()` with affordances, the same relationship §8 asserts of the glance panel.
 */
export function renderStrip() {
    const rail = collapsedBody();
    if (!rail || !stripVisible()) {
        return;
    }

    const snapshot = state.snapshot();
    const scene = new Map(snapshot.context.map(field => [field.label, field.value]));
    const at = scene.get('location') ?? '';
    const segments = [];

    if (snapshot.clock?.raw) {
        segments.push(el('span', 'fold_strip_seg fold_strip_time', snapshot.clock.raw));
    }
    if (at) {
        segments.push(el('span', 'fold_strip_seg fold_strip_place', sentenceCase(at)));
    }
    const balance = state.balance();
    if (balance.amount > 0) {
        segments.push(el('span', 'fold_strip_seg fold_strip_money',
            `${balance.amount.toLocaleString()} ${balance.currency}`));
    }
    const urgent = clocks.snapshot(entities.turn(), at).find(dial => dial.kind === 'doom' && !clocks.isFull(dial));
    if (urgent) {
        segments.push(el('span', 'fold_strip_seg fold_strip_dial',
            `${urgent.filled}/${urgent.size}`));
    }

    rail.replaceChildren(...segments);
    rail.classList.toggle('fold_collapsed_empty', !segments.length);
}

/**
 * Flash the rail in the verdict's band colour — a transient cue, never a persistent state.
 * @param {string} band CLEAR, COST or SETBACK.
 */
export function flashVerdict(band) {
    const rail = collapsedBody();
    if (!rail) {
        return;
    }
    rail.classList.remove('fold_flash_clear', 'fold_flash_cost', 'fold_flash_setback');
    rail.classList.add(`fold_flash_${band}`);
    if (stripTimer) {
        clearTimeout(stripTimer);
    }
    stripTimer = setTimeout(() => {
        rail.classList.remove('fold_flash_clear', 'fold_flash_cost', 'fold_flash_setback');
    }, 4000);
}

/** Point the collapse chevron the way the panel can move: `>` to push it right, `<` to pull it out. */
function updateToggleIcon() {
    const panel = document.getElementById(PANEL_ID);
    const toggle = panel?.querySelector('.fold_toggle');
    const icon = toggle?.querySelector('i');
    if (!panel || !toggle || !icon) {
        return;
    }
    const collapsed = !panel.classList.contains('fold_open');
    icon.classList.remove('fa-chevron-left', 'fa-chevron-right');
    icon.classList.add(collapsed ? 'fa-chevron-left' : 'fa-chevron-right');
    toggle.title = collapsed ? t`Open fold tracker` : t`Collapse fold tracker`;
}

/**
 * Show the panel (expand).
 *
 * Uses a class rather than jQuery's show(), which writes an inline `display: block` that beats the
 * stylesheet's `display: flex` and collapses the layout into stacked blocks.
 */
export function show() {
    visible = true;
    const panel = document.getElementById(PANEL_ID);
    // Showing mounts the sidebar as well as expanding it: an explicit open is its own reason to be
    // on screen, independent of the state track (which only ever earns the collapsed rail).
    panel?.classList.add('fold_mounted', 'fold_open');
    updateToggleIcon();
    render();
}

/** Hide the panel (fold it back to the collapsed rail). */
export function hide() {
    visible = false;
    document.getElementById(PANEL_ID)?.classList.remove('fold_open');
    updateToggleIcon();
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
 * @param {() => void} [options.onClose] Called when the user collapses the panel, so the setting can follow.
 * @param {() => void} [options.onOpen] Called when the user expands the panel, so the setting can follow.
 */
export function initPanel({ onClose = () => {}, onOpen = () => {} } = {}) {
    if (document.getElementById(PANEL_ID)) {
        return;
    }
    onToggleOff = onClose;
    onToggleOpen = onOpen;

    const host = document.getElementById('movingDivs') ?? document.body;
    host.appendChild(buildPanel());

    const panel = document.getElementById(PANEL_ID);
    panel.querySelector('.fold_toggle').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (visible) {
            hide();
            onToggleOff();
        } else {
            show();
            onToggleOpen();
        }
    });
    updateToggleIcon();

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
