/**
 * fold/panel.js: the tracker panel.
 *
 * The point of tracking state is seeing it while you play. Everything else in this extension is
 * plumbing for this surface: if the numbers only exist in a console dump, the feature does not
 * exist.
 *
 * The organising idea.
 *
 * The first version printed fields. Label, value, next label, nine sections at one weight, so the
 * year 1998 was set exactly as loudly as a deadline twenty minutes out. Everything on it was true
 * and nothing on it was *related*, which is what made it read as a debug dump with a border.
 *
 * This version relates them. Time held against a stated deadline is a countdown. A condition held
 * against how long it lasts is a timer. An item held against where it is is a question of reach.
 * None of those are new facts, every one was already on screen, twice, unconnected.
 *
 * Two rules carry the layout:
 *
 *   · Derived numbers are set in the mono face; anything a narrator wrote is set as prose. If you
 *     can see the typeface, you know whether a model or a fold produced it.
 *   · Recency is a two-pixel rail, not a word. "What changed this turn" is answered peripherally,
 *     with no diff view and no extra text.
 *
 * Follows SillyTavern's own moving-panel convention (`#movingDivs`, `panelControlBar`,
 * `drag-grabber`) so it sits where the Author's Note and World Info panels sit. It moves itself
 * rather than through `dragElement`: see `wireDrag`.
 */

import { default_user_avatar, eventSource, event_types } from '../../../script.js';
import { getUserAvatar, user_avatar } from '../../personas.js';
import { t } from '../../i18n.js';
import * as state from './state.js';
import * as edits from './edits.js';
import { CAST_FIELDS, THREAD_FIELDS, editRow } from './edit-form.js';
import * as entities from './entities.js';
import * as clocks from './clocks.js';
import * as flows from './flows.js';
import { BY_CLOCK, emptyIn, flowFace, netRate } from './flow-table.js';
import { LONG_STATEMENT, unwrapList } from './block-parse.js';
import { SHEET_STATS } from './review-table.js';
import { DISPOSITIONS, LEAD_LABELS, PERSON_LABELS, dispositionRank } from './entity-table.js';
import { currentThreads } from './thread-table.js';
// Aliased: `panel.js` already has a local `places` Map that groups ITEMS by their place string
// (`renderStuff`), and two different things called `places` in one file is how the wrong one gets
// read. `placeRecords` is the record; `places` is a grouping. Same alias `overlay-inventory.js`
// uses, for the same reason.
import * as placeRecords from './places.js';
import { ancestorsOf, childrenOf } from './place-table.js';
import {
    formatClock,
    formatDate,
    formatGap,
    parseClock,
    splitLocation,
    timeUntil,
} from './clock.js';
import { ASSETS, CARRIED, CATEGORIES, HEALTH_LABELS, MONEY, contextBand, itemKey, vitalLabel } from './state-table.js';
import * as audit from './audit.js';
import * as trace from './trace.js';
import * as overlay from './overlay.js';
import { coveredThreads } from './coverage.js';
import { jumpToMessage } from './diagnostics-view.js';
import { newRejects, newerThan } from './reject-table.js';
// Imported for their side effect: each registers its renderer with the overlay. Without these the
// seven tabs open on their placeholders.
import './overlay-cast.js';
import './overlay-threads.js';
import './overlay-chronicle.js';
import './overlay-inventory.js';
import './overlay-assets.js';
import './overlay-diagnostics.js';
import './overlay-repairs.js';
import './overlay-audit.js';
import './overlay-prompts.js';
// The audit tab registers its renderer above; the reconcile button also reads its pending-question
// count back through `audit.questions()`.

const PANEL_ID = 'sanguineTracker';

/** Audit-trail rows shown before the rest collapse into a single "N earlier" line. */
const TRAIL_LIMIT = 6;

/**
 * How many rows of one place the sidebar shows before deferring to the Inventory tab.
 *
 * Five, because the sort is by recency and a scene rarely touches more than a handful of things,
 * so five covers "what has moved" while a sixth would already be answering a question nobody asked
 * at a glance. UNMEASURED against play; it is a starting number, and the "N more" control below
 * makes being wrong about it cheap rather than lossy.
 */
const GLANCE_ITEMS = 5;

/**
 * How many open threads the sidebar shows before deferring to the Threads tab.
 *
 * Four rather than the pack's five: a thread row carries an open question that runs to two lines,
 * so four of them cost about what five item rows do. UNMEASURED against play. Both numbers exist to
 * keep the panel inside one screen, and the "N more" control is what makes them cheap to be wrong
 * about: nothing is hidden, only deferred.
 */
const GLANCE_THREADS = 4;

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
 * the body-state prose out of the header and into the generic aside section, the same string, one
 * heading lower, which is not what "the scene header loses body-state" means.
 *
 * `HEALTH_LABELS` is the block's whole health family, so a `Status:` line kept verbatim in context
 * is claimed rather than rendered in the aside as though it were a tracked fact.
 */
const BODY_FIELDS = ['conditions', ...HEALTH_LABELS];

/** Context labels the entity view replaces once extraction has produced structure. */
const ENTITY_FIELDS = { people: PERSON_LABELS, leads: LEAD_LABELS };

let visible = false;
let onToggleOff = () => {};
let onToggleOpen = () => {};
/** Section headers the player collapsed this session, so a re-render keeps them collapsed. */
const collapsedSections = new Set();
/** Section headers whose default has already been applied once. See the `quiet` branch in `render`. */
const decidedSections = new Set();
/**
 * Sections the player has expanded past their glance slice, so a re-render keeps them expanded.
 *
 * Separate from `collapsedSections` because these are different questions. Collapse asks "do I want
 * this section at all"; expansion asks "I want this section, and all of it", a section can be
 * expanded and then collapsed, and re-opening it should give back the expansion rather than
 * silently re-truncating to five.
 */
const expandedSections = new Set();

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
    // whole history in one control, see the collapsed body below.
    const toggle = document.createElement('button');
    toggle.className = 'sanguine_toggle';
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
    body.classList.add('sanguine_tracker_body', 'scrollY');
    panel.appendChild(body);

    // The collapsed altitude lives inside the panel now, the strip is the panel folded to the
    // right edge, not a separate top bar. Its segments render here and it is clickable to expand.
    const collapsedBody = document.createElement('div');
    collapsedBody.className = 'sanguine_collapsed_body';
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
    return document.querySelector(`#${PANEL_ID} .sanguine_tracker_body`);
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
 * How a card's own field label is set.
 *
 * `sentenceCase` gave `Hp`, `Mp` and `Bp`, which is not what any card wrote and not how anyone
 * reads them. The block parser lowercases labels so they key reliably, so the original casing is
 * gone by the time it gets here and has to be chosen rather than recovered.
 *
 * The rule is length, not vocabulary: a label of three characters or fewer is an initialism and is
 * set in capitals; anything longer is a word and is sentence-cased. No list of known stat names,
 * which is the enumerated judgement RULE 1 bans and which would be missing `SAN`, `AC` or `PP` the
 * moment somebody loads a different card.
 *
 * @param {string} label A lowercased block-field label.
 * @returns {string} The label as it should be displayed.
 */
function statLabel(label) {
    const text = String(label ?? '');
    return text.length <= 3 ? text.toUpperCase() : sentenceCase(text);
}

/**
 * The card's own stat line, as a compact label/value grid.
 *
 * Eleven fields do not need eleven section headers.
 *
 * These used to render at the BOTTOM of the panel, below Threads, one full `sanguine_sec` heading and
 * one value block per field. For a card with a real character sheet, the live Isekai RPG reports
 * HP, MP, Level, BP, Gold, Reputation, Class, Skills, Abilities, Bonds and Quests, that is
 * twenty-two elements and most of a screen of scrolling, to show what is in total about eleven
 * short numbers. A heading is for a section you might collapse; a stat is a label and a value.
 *
 * So they are a two-column grid directly under the scene header, which is also where they belong by
 * meaning: the header says who and when and where, and this says what shape they are in.
 *
 * Multi-value fields are separated with a middot rather than left as the card's commas, because the
 * comma is what made `[Journey to the Capital, The Sage's Mandate]` read as two broken fragments
 * once the wrapper was stripped off only one end.
 *
 * @param {Array<{label: string, value: string}>} fields Unclaimed context fields.
 * @returns {HTMLElement} The grid.
 */
function statGrid(fields) {
    const grid = el('div', 'sanguine_stats');
    for (const field of fields) {
        // Unwrapped here as well as at absorb, so a chat whose block was read before that landed
        // heals on the next render instead of needing its stored context rewritten.
        const value = unwrapList(field.value);
        const parts = String(value ?? '').split(/\s*[;,，、；]\s*/).map(part => part.trim()).filter(Boolean);
        grid.appendChild(el('span', 'sanguine_stat_k', statLabel(field.label)));
        grid.appendChild(el('span', 'sanguine_stat_v', parts.length > 1 ? parts.join(' · ') : String(value ?? '')));
    }
    return grid;
}

/**
 * A section heading, optionally with a count on the right.
 *
 * The label is the identity, and it is not the rendered text.
 *
 * The collapse memory used to key on `sec.textContent.trim()`, which concatenates the heading and
 * its count into `Carrying28`. So collapsing a section bound the choice to the size it happened to
 * be, and the next item to arrive made it `Carrying29`: a key nobody had collapsed, so the section
 * sprang open again. The one section guaranteed to change size is the one worth collapsing, which
 * is why the feature read as not working.
 *
 * `dataset.label` carries the stable name, so identity survives a count and the count still renders.
 *
 * @param {string} label The heading.
 * @param {number|string} [count] A count or annotation.
 * @param {boolean} [quiet] Start collapsed the first time it is seen. For the sections §8 already
 *   ranks last, property, capability, things left in another place, which are consulted between
 *   scenes rather than during one.
 * @returns {HTMLElement} The heading row.
 */
function section(label, count, quiet = false) {
    const head = el('div', 'sanguine_sec');
    head.dataset.label = label;
    if (quiet) {
        head.dataset.quiet = '1';
    }
    head.appendChild(el('span', null, label));
    if (count !== undefined && count !== '') {
        head.appendChild(el('span', 'sanguine_sec_n', String(count)));
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
        .split(/[;,，、；]/)
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
function bulletsOrProse(value) {
    const text = String(value ?? '').trim();
    // Punctuation split only, a clause boundary means the same in every language. The old
    // `\bbut\b|\botherwise\b` split and the `isNegation` word-list (which judged whether a clause
    // was a reassurance) are gone: whether "otherwise unhurt" is a condition is a reading the model
    // answers with `on: false`/`subject`, never an English list.
    const parts = text.split(/[;]|,(?=\s)/).map(part => part.trim()).filter(Boolean);

    const listy = parts.length > 1 && parts.every(part => part.split(/\s+/).length <= 6);
    if (!listy) {
        return el('div', 'sanguine_prose', sentenceCase(parts.join(', ')));
    }
    const list = el('ul', 'sanguine_bullets');
    for (const part of parts) {
        list.appendChild(el('li', null, sentenceCase(part)));
    }
    return list;
}


/**
 * A card-authored field rendered as separate statements rather than one run of prose.
 *
 * Used for leads, contacts, objectives, anything the extraction probe has not yet turned into
 * entities. Long statements clamp to two lines and open on click, so six leads stay scannable
 * without hiding any of them.
 *
 * @param {string} value The field value.
 * @returns {HTMLElement} A list.
 */
function statementList(value) {
    const list = el('ul', 'sanguine_list');
    // Punctuation split only, same discipline as `bulletsOrProse`: whether a fragment is a
    // separate statement is a reading the model answers (the threads probe reports leads
    // structurally), never the old `FINITE_VERB` English verb list.
    const statements = String(value ?? '').split(/\s*[;,，、；]\s*/).map(part => part.trim()).filter(Boolean);
    for (const statement of statements) {
        const row = el('li', 'sanguine_row sanguine_stmt');
        row.appendChild(rail(1));

        const textEl = el('span', 'sanguine_stmt_text', sentenceCase(statement));
        row.appendChild(textEl);

        if (statement.length > LONG_STATEMENT) {
            row.classList.add('sanguine_clamped');
            const caret = el('span', 'sanguine_caret', '›');
            row.appendChild(caret);
            textEl.setAttribute('role', 'button');
            textEl.setAttribute('tabindex', '0');
            textEl.setAttribute('aria-expanded', 'false');

            const toggle = () => {
                const open = row.classList.toggle('sanguine_open_clamp');
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
 * A summary label that opens the overlay on the record it names.
 *
 * The contract that makes summarising safe.
 *
 * Everything this panel stopped printing, a person's wants and knowledge, an item's audit trail, a
 * thread's open question and provenance, was removed on the promise that it is one click away, not
 * gone. This is that click. A sidebar row is an INDEX ENTRY into the overlay, which is what
 * distinguishes demotion from deletion, and demotion-not-deletion is the rule this codebase already
 * lives by everywhere else.
 *
 * A real `<button>` rather than a click handler on a span: it has to be reachable by keyboard and
 * announce itself as something that does anything. Styled back down to look like the text it
 * replaces: the affordance is the hover state and the cursor, not a button chrome on every row of
 * a 288px panel.
 *
 * `focus` keys are opaque and belong to whichever module owns that tab (`overlay.js` documents the
 * namespaces). Nothing here parses them; they are handed back exactly as `snapshot()` reported them.
 *
 * @param {string} text The label.
 * @param {string} tab An overlay tab id.
 * @param {string} key The record's key within that tab, or '' for none in particular.
 * @param {string} title Tooltip.
 * @returns {HTMLElement} The control.
 */
function openLink(text, tab, key, title) {
    const button = el('button', 'sanguine_entity_name sanguine_open_link', text);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', (event) => {
        // Cast and item rows are themselves disclosure toggles in places; opening the overlay must
        // not also flip the row open behind it.
        event.stopPropagation();
        overlay.open({ tab, focus: key ?? '' });
    });
    return button;
}

/**
 * The player's persona portrait, if they have set one.
 *
 * `user_avatar` is the filename SillyTavern's persona system keeps (`scripts/personas.js`), and
 * `getUserAvatar` turns it into the served path. Both are read live rather than cached: the player
 * can switch persona mid-chat, and `PERSONA_CHANGED` re-renders the panel.
 *
 * `default_user_avatar` is the generic silhouette core ships for a player who never chose one.
 * Drawing it here would be the placeholder this deliberately does not have, a frame around
 * nobody: so it is treated as "no portrait" rather than as an image.
 *
 * @returns {HTMLElement|null} The portrait, or null when there is nothing worth framing.
 */
function personaPortrait() {
    const file = user_avatar;
    if (!file || file === default_user_avatar) {
        return null;
    }
    const img = el('img', 'sanguine_portrait');
    img.src = getUserAvatar(file);
    img.alt = '';
    // Decorative: the name is right beside it and says the same thing. Announcing the filename to a
    // screen reader would be noise, and announcing the name twice is worse.
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    return img;
}

/**
 * The "N more" control under a truncated section.
 *
 * It expands where you are; it does not take you somewhere.
 *
 * This used to open the overlay, which conflated two different intentions. "Show me the rest of my
 * pack" is a glance that got one row too long, the answer is four more rows, in place, without
 * losing the panel you were reading. "Open the inventory" is a decision to go and work on something,
 * and that gets its own control on the section heading.
 *
 * A disclosure that navigates is the same mistake as a link that looks like a button: the affordance
 * has to predict what happens, and an arrow pointing down should not open a window.
 *
 * @param {string} key The section's identity, stable across renders.
 * @param {number} hidden How many rows are not being shown.
 * @param {() => void} redraw What to call once the flag flips.
 * @returns {HTMLElement} The control.
 */
function moreToggle(key, hidden, redraw) {
    const open = expandedSections.has(key);
    const button = el('button', 'sanguine_more');
    button.type = 'button';
    button.textContent = open ? `${t`show fewer`} ↑` : `${hidden} ${t`more`} ↓`;
    button.title = open ? t`Show only what changed recently` : t`Show the rest here`;
    button.setAttribute('aria-expanded', String(open));
    button.addEventListener('click', () => {
        if (expandedSections.has(key)) {
            expandedSections.delete(key);
        } else {
            expandedSections.add(key);
        }
        redraw();
    });
    return button;
}

/**
 * The control that leaves the panel for the overlay, on a section heading.
 *
 * Deliberately distinct from `moreToggle` in both glyph and position: this one goes on the heading
 * beside the count, where a section-level action belongs, and it points OUT rather than down.
 *
 * @param {string} tab An overlay tab id.
 * @param {string} title Tooltip, say what opens, not "open".
 * @returns {object} A `rowActions` descriptor.
 */
function openAction(tab, title) {
    // `sanguine_open_win` opts this one OUT of the hover gate the other row actions live behind.
    // That gate exists so the panel reads as a panel and only becomes a console when reached for,
    // which is right for edit and erase, destructive things you go looking for. It is wrong for
    // navigation: a way out of the panel that only appears once you are already hovering the exact
    // heading it lives on is a way out nobody finds.
    return { label: '⤢', title, cls: 'sanguine_open_win', run: () => overlay.open({ tab, focus: '' }) };
}

/**
 * The clock face: the in-fiction time as a form, beside the same time as a number.
 *
 * Why a dial and not just the digits.
 *
 * The panel's own rule is pips and rails first, with the number beside them, a form is read
 * pre-attentively and a number has to be parsed. `09:11` tells you the time; a hand near the top of
 * a lit face tells you it is morning before you have read anything, which is the actual question a
 * player asks of a clock mid-scene.
 *
 * And it says something the digits cannot. A 24-hour reading is unambiguous but flat; the face is
 * TINTED for day or night, so "is it dark out", a question with real consequences in most of these
 * campaigns: is answered by the widget's own colour rather than by arithmetic on `09:11`. That is
 * the one thing this adds as information rather than as decoration, which is the whole test for
 * whether it belongs.
 *
 * Drawn as inline SVG rather than CSS rotations: two hands at arbitrary angles inside a 22px circle
 * is exactly what vector primitives are for, and the alternative is four nested divs with
 * transform-origin arithmetic that breaks the moment the size changes.
 *
 * @param {number|null} minutes Minutes since midnight, or null when the time did not parse.
 * @returns {SVGElement|null} The face, or null when there is no time to draw.
 */
function clockFace(minutes) {
    if (minutes === null || !Number.isFinite(minutes)) {
        return null;
    }
    const NS = 'http://www.w3.org/2000/svg';
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    // Local noon-ish to dusk reads as day. Deliberately crude: the fiction rarely states a latitude,
    // and a tracker that claimed to know civil twilight would be inventing precision.
    const day = wrapped >= 6 * 60 && wrapped < 18 * 60;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `sanguine_face ${day ? 'sanguine_face_day' : 'sanguine_face_night'}`);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const dial = document.createElementNS(NS, 'circle');
    dial.setAttribute('cx', '12');
    dial.setAttribute('cy', '12');
    dial.setAttribute('r', '10.25');
    dial.setAttribute('class', 'sanguine_face_ring');
    svg.appendChild(dial);

    // Hands. The minute hand sweeps the hour; the hour hand sweeps twelve, so it carries the
    // fraction of the hour too, a stopped-looking hour hand on a moving minute hand is the tell
    // that a clock is drawn wrong.
    const hand = (angle, length, cls) => {
        const line = document.createElementNS(NS, 'line');
        const rad = ((angle - 90) * Math.PI) / 180;
        line.setAttribute('x1', '12');
        line.setAttribute('y1', '12');
        line.setAttribute('x2', String(12 + Math.cos(rad) * length));
        line.setAttribute('y2', String(12 + Math.sin(rad) * length));
        line.setAttribute('class', cls);
        return line;
    };
    svg.appendChild(hand(((wrapped % 720) / 720) * 360, 4.6, 'sanguine_face_hour'));
    svg.appendChild(hand((wrapped % 60) * 6, 7, 'sanguine_face_minute'));
    return svg;
}

/**
 * Where you are, at whatever depth the record can support.
 *
 * One line was all there was to draw.
 *
 * This used to be `splitLocation()` into a place and a qualifier, and that was not a design
 * decision: it was the whole of the available data. The scene probe answers `location` as one
 * free string and nothing else about the world's geography was ever stored, so "RPD break room"
 * plus the weather chips under it was the complete picture.
 *
 * Meanwhile `place-table.js` and `places.js` implement containment, per-place standing facts,
 * per-place current state, a destruction cascade and a trail, and held ZERO rows in all 22 live
 * chats, because the only thing that ever wrote a place row was hand entry in the Assets tab. A
 * record with no producer renders as a record with nothing in it.
 *
 * Fail open, and that is the load-bearing part.
 *
 * Every existing chat has no place rows, and chats written from here on will acquire them one scene
 * at a time. So the record is treated as ENRICHMENT over the scene string, never as a
 * precondition: with no row this renders exactly the line it always rendered, and each field that
 * does exist adds one line. There is no state in which having less recorded shows less than before.
 *
 * The four registers are kept apart because they age differently, which is the same division
 * `entity-table.js` draws between `facts` and the dossier fields for people:
 *
 *   ancestry: where this sits in the world. Changes when you walk somewhere else.
 *   facts: true of the room in every scene. A stairwell has no windows on the day it burns.
 *   detail: true of it right now. The barricade goes up and comes down.
 *   children: what is inside it, which is the "guest room, kitchen" the owner asked for and the
 *               only one of the four that reads as a place you could go next.
 *
 * @param {string} location The scene's location string.
 * @returns {HTMLElement} The block.
 */
function locationBlock(location) {
    const block = el('div', 'sanguine_place');

    const { place, qualifier } = splitLocation(location);
    // Resolved through the record so an alias lands on the row it belongs to, but the DISPLAY name
    // stays the string the scene wrote. The record is the index; the narration is the wording.
    //
    // `here()` first, and the two string lookups only as fallbacks, because parsing the scene
    // string is exactly what this record exists to stop anyone doing. The scene probe now names the
    // place structurally and `setHere` stores the resolved key, so `here()` is an exact answer where
    // both fallbacks are guesses, and both guesses are wrong in a measured way:
    //
    //   · `splitLocation` splits on the FIRST comma and calls the left half the place. For
    //     "Nine-Tails Inn, common room", 9 occurrences in New Eldoria, that is the CONTAINER, so
    //     the panel would render the inn and caption the room you are standing in.
    //   · "RPD break room" has no comma at all, so the whole string is tried, and it resolves to
    //     nothing even when `break room` has a row of its own.
    //
    // The fallbacks stay because they are what every chat written before the producer has, and a
    // wrong-but-close breadcrumb still beats none. `resolvePlace` answers `{key, row}` or null.
    const found = placeRecords.here() ?? placeRecords.resolve(location) ?? placeRecords.resolve(place);
    const table = placeRecords.load();
    const key = found?.key ?? '';
    const row = found?.row ?? null;

    // The trail of containers, outermost first: `RPD ▸ break room`. Capped at two, a breadcrumb is
    // orientation, not a path, and `Verdant Moon Forest ▸ Rocky Ridge ▸ overhang ▸ …` spends a 288px
    // line on the part you already know.
    //
    // `ancestorsOf` walks NEAREST first, so the two worth showing are the two at the FRONT, and they
    // are then reversed to read outside-in the way an address does.
    const chain = row ? ancestorsOf(table, key).slice(0, 2).reverse() : [];
    const line = el('div', 'sanguine_loc');
    for (const ancestor of chain) {
        line.appendChild(el('span', 'sanguine_loc_up', ancestor.row?.name ?? ''));
        line.appendChild(el('span', 'sanguine_loc_sep', '▸'));
    }
    line.appendChild(el('span', 'sanguine_loc_place', place));
    if (qualifier) {
        line.appendChild(el('span', 'sanguine_loc_q', `, ${qualifier}`));
    }
    block.appendChild(line);

    if (!row) {
        // No record yet, which is every chat before the scene probe started answering. The line
        // above is exactly what this function has always drawn.
        return block;
    }

    // Destroyed, or sealed inside something destroyed. Loudest thing here because it changes what
    // the other three lines MEAN, facts about a room that no longer stands are history.
    const sealed = placeRecords.sealed(key);
    const gone = String(row.status ?? '').trim();
    if (gone || sealed) {
        block.appendChild(el('div', 'sanguine_place_gone',
            sealed ? `${gone || t`sealed`}, ${t`inside`} ${sealed.row.name}` : gone));
    }

    // Standing truths, then what is true now. `detail` is the brighter of the two because it is the
    // half that changed; `facts` are the half that will read the same next scene.
    if (String(row.facts ?? '').trim()) {
        block.appendChild(el('div', 'sanguine_place_facts', row.facts));
    }
    if (String(row.detail ?? '').trim()) {
        block.appendChild(el('div', 'sanguine_place_detail', row.detail));
    }

    // What is inside here. Named rather than counted, "3 rooms" tells you there is somewhere to go
    // and not where, and the names are short enough that the count was never the cheaper thing to
    // print. Live children only: a destroyed wing is not somewhere you can walk.
    // `childrenOf` answers `{key, row}` wrappers, not rows, the name and the status both live one
    // level down.
    const inside = childrenOf(table, key).filter(child => !String(child.row?.status ?? '').trim());
    if (inside.length) {
        const row2 = el('div', 'sanguine_place_in');
        row2.appendChild(el('span', 'sanguine_place_in_label', t`inside`));
        row2.appendChild(el('span', 'sanguine_place_in_names',
            inside.slice(0, 6).map(child => child.row?.name ?? '').filter(Boolean).join(' · ')));
        if (inside.length > 6) {
            row2.appendChild(el('span', 'sanguine_place_in_more', ` +${inside.length - 6}`));
        }
        block.appendChild(row2);
    }

    return block;
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
    const time = scene.get('time');
    const date = scene.get('date');
    const location = scene.get('location');
    const pov = scene.get('pov');
    // Weather alone. What used to be `[conditions, weather].join('; ')` is the measured defect
    // §0 opens with, see SCENE_FIELDS.
    const conditions = scene.get('weather') ?? '';

    if (!time && !date && !location && !conditions && !pov) {
        return null;
    }

    const head = el('div', 'sanguine_head');

    // The clock is built before the identity row, because it sits INSIDE it.
    //
    // It used to render as its own full-width line under the name: `09:11  FRIDAY, SEPTEMBER 26,
    // 1998` spanning the panel, with the location on the line below. That is a lot of width for the
    // one value on the panel that is glanced at rather than read, and it put the two loudest things
    // on the surface, the portrait and the 23px hour, on separate rows competing for the top.
    //
    // Seated opposite the name they read as one masthead: who, and when. The date follows the time
    // rather than sharing its line, which also stops a long calendar ("Friday, September 26, 1998")
    // from setting the width of the whole header.
    let clockBlock = null;
    if (time || date) {
        clockBlock = el('div', 'sanguine_clock');
        const minutes = parseClock(time);
        const face = clockFace(minutes);
        if (face) {
            clockBlock.appendChild(face);
        }
        const readout = el('div', 'sanguine_clock_read');
        // The DATE does not ride in the masthead. Measured: `FRIDAY, SEPTEMBER 26, 1998` is 176px
        // of a 260px column, which left four pixels for the protagonist's name and wrapped
        // "Solomon" one letter per line. It is also a different tempo, the hour moves every scene,
        // the date every in-fiction day, so pairing them cost the panel its name column to say two
        // things that do not change together.
        // A time fold cannot parse is still the narrator's time, and is shown as written rather
        // than dropped for failing to be a clock.
        // Both editable. The clock drifts, the live Raccoon City campaign ran eight days ahead of
        // its own fiction, and until now the only cure was a script. `setClockByHand` writes the
        // clock and the scene context together, so the header and the injected block cannot
        // disagree the way they did there.
        const hh = el('span', 'sanguine_hh', minutes === null ? (time ?? '') : formatClock(minutes));
        makeEditable(hh, {
            onCommit: (value) => {
                state.setClockByHand({ time: value });
                render();
            },
        });
        hh.title = t`Click to set the time`;
        readout.appendChild(hh);
        // A clock nothing has confirmed for several exchanges is shown as stopped, not as the time.
        // Seeing "13:03 · 6 turns" is the difference between knowing the clock has stuck and
        // believing an afternoon never happened.
        if (clock?.stale) {
            clockBlock.classList.add('sanguine_clock_stale');
            readout.appendChild(el('span', 'sanguine_dd sanguine_clock_age', `${clock.age} ${t`turns`}`));
        }
        clockBlock.appendChild(readout);
    }

    // Its own line, right-aligned under the clock it belongs to, the alignment is what keeps them
    // one fact in two tempos rather than two unrelated rows.
    let dateLine = null;
    if (date) {
        dateLine = el('div', 'sanguine_dateline');
        const dd = el('span', 'sanguine_dd', formatDate(date));
        makeEditable(dd, {
            // Stored verbatim: fold never parses a date, so any calendar the story uses works.
            onCommit: (value) => {
                state.setClockByHand({ date: value });
                render();
            },
        });
        dd.title = t`Click to set the date`;
        dateLine.appendChild(dd);
    }

    // Whose story this is. It sits above the clock because it is the one fact on the panel that
    // does not change between turns, and because a tracker that never names the protagonist reads
    // as a tracker for somebody else, which is exactly how it looked when the point-of-view
    // character was filed under People alongside the people he was fighting.
    if (pov) {
        // The portrait is the panel's only image, and its identity anchor.
        //
        // SillyTavern already has one: the persona avatar the player chose, which every message
        // they send is stamped with. Borrowing it costs nothing and answers "whose panel is this"
        // before a word is read.
        //
        // A RECTANGLE at 5:6, not a circle. A circular avatar is the chat-app convention and reads
        // as "the account you are logged in as"; a portrait frame is the CRPG convention, Baldur's
        // Gate, Planescape, Dragon Age all frame a party member this way, and reads as "the
        // character this is about", which is what the panel is for.
        //
        // No placeholder when there is no persona image. An empty frame is a slot advertising that
        // something is missing; the name block simply starts at the left edge instead.
        const identityRow = el('div', 'sanguine_ident');
        const portrait = personaPortrait();
        if (portrait) {
            identityRow.appendChild(portrait);
        }

        const row = el('div', 'sanguine_pov');
        row.appendChild(el('span', 'sanguine_pov_name', pov));
        // What the card says they ARE, class, title, ancestry, set quietly beside the name rather
        // than as its own labelled row further down. `Ike Kōtoku · Spellbrawler` is one fact about
        // one person; two rows made it look like two.
        if (clock?.subtitle) {
            row.appendChild(el('span', 'sanguine_pov_is', clock.subtitle));
        }
        identityRow.appendChild(row);
        if (clockBlock) {
            identityRow.appendChild(clockBlock);
            clockBlock = null;
        }
        head.appendChild(identityRow);
    }

    // No point-of-view character yet, so there is no masthead to sit opposite, the clock keeps its
    // own line rather than floating alone against the right edge of nothing.
    if (clockBlock) {
        head.appendChild(clockBlock);
    }
    if (dateLine) {
        head.appendChild(dateLine);
    }

    if (location) {
        head.appendChild(locationBlock(location));
    }

    if (conditions) {
        const { chips, rest } = chipsAndRest(conditions);
        if (chips.length) {
            const strip = el('div', 'sanguine_chips');
            for (const chip of chips) {
                strip.appendChild(el('span', 'sanguine_chip', sentenceCase(chip)));
            }
            head.appendChild(strip);
        }
        for (const line of rest) {
            head.appendChild(el('div', 'sanguine_prose sanguine_cond_rest', sentenceCase(line)));
        }
    }

    return head;
}

/*
 * `lockable` is gone, and so is the idea it implemented.
 *
 * It made the scene header's pov / location / time rows click-to-pin, where PIN meant "the narrator
 * can no longer change this": `setContext` discarded any incoming write for a locked label. The
 * source said so outright, "Nothing the narrator says overwrites it, that is the entire point."
 *
 * That is the opposite of what pinning is supposed to mean here. Pinning something is meant to
 * PROMOTE it, a larger token allocation, more fields kept, protection from being aged out of the
 * story. It was never meant to stop the model editing anything. The concept the word belongs to
 * already exists as the person-of-interest flag (`state.poi`), which does exactly that.
 *
 * It also did real harm while it existed. The whole row was a click target with no label, the only
 * feedback was a hairline rail that was amber-on-amber until the panel stopped inheriting the accent
 * as its body colour, and a locked field then refused the narrator SILENTLY. Measured on the live
 * Raccoon City chat: `location` and `time` were pinned, almost certainly by a stray click, and
 * writing "the parking garage" from the narrative source left the location at "RPD break room" with
 * nothing reported to anyone. A control that quietly discards incoming truth is worse than no
 * control.
 */

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

    // The deadline is the model's STRUCTURED answer, the lead schema's `deadline` field (minutes
    // since midnight the excerpt scheduled it by), reported in any language. fold never reads a
    // scheduling time out of prose with an English preposition list; it renders the number the
    // model reported. The card's own leads field is included only for chats where extraction has
    // not run yet, those carry no structured deadline, so they contribute nothing to the count.
    const candidates = [];
    for (const lead of leads) {
        const at = Number(lead?.deadline);
        if (Number.isInteger(at) && at >= 0) {
            candidates.push({ label: lead.name, detail: lead.detail, at, key: lead.key });
        }
    }

    const timed = candidates
        .map(candidate => ({ ...candidate, gap: timeUntil(now, candidate.at) }))
        .filter(candidate => candidate.gap)
        .sort((a, b) => (a.gap.passed === b.gap.passed ? a.gap.minutes - b.gap.minutes : a.gap.passed ? 1 : -1));

    return timed[0] ?? null;
}


/**
 * The `help:` line a rejection row shows, the song-compiler habit of naming the fix, not just the
 * fault. This is a display table over fold's OWN reason tokens (never over narrative text), so it
 * is the §11-sanctioned formatting kind, and unknown reasons fall back to a generic line.
 * @param {string} reason The rejection reason.
 * @returns {string} The fix to suggest.
 */
/** The label, class and tooltip for each extraction lifecycle state (FOLD-SLA.md §2). */
function syncMeta(state) {
    return ({
        'up-to-date': { label: t`synced`, cls: 'up_to_date', title: t`State is current` },
        acknowledged: { label: t`pending`, cls: 'acknowledged', title: t`Message received, extraction pending` },
        syncing: { label: t`syncing`, cls: 'syncing', title: t`Updating state…` },
        behind: { label: t`behind`, cls: 'behind', title: t`A newer message arrived during extraction, the next pass covers it` },
        failed: { label: t`extraction failed`, cls: 'failed', title: t`Extraction failed` },
    })[state] ?? { label: state, cls: 'unknown', title: state };
}

/**
 * The extraction lifecycle chip: a dot (compact, for the strip) or a dot + label (for the panel),
 * coloured by state. The failed state is red and its tooltip carries the reason and the fix, so a
 * failed pass is never silent (FOLD-SLA.md §2.3).
 *
 * A non-terminal state that is far older than the extraction window is a lie, a hang or an
 * interrupted session left `syncing` persisted in the chat metadata. A healthy pass is bounded by
 * `EXTRACT_TIMEOUT_MS`, so anything that old was never going to finish; it renders as failed
 * ("stalled") rather than pulsing forever.
 *
 * `acknowledged` is deliberately NOT stale-flagged.
 *
 * `acknowledged` is a RESTING state, a message rendered and extraction is pending, waiting for
 * the interval gate or the next trigger (`index.js` onAssistantMessage, `extract:waiting`). It is
 * meant to persist for however long the cadence says, and an idle `acknowledged` is not a hang.
 * Measured in the Royal Succession chat: a chat sat `acknowledged` for hours under its interval,
 * and both the watchdog and this renderer marked it "stalled", a false alarm on a healthy wait.
 * Only `syncing` (a pass genuinely in flight) can hang.
 *
 * @param {object} sync The `state.sync` record.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.compact] Dot only, for the collapsed rail.
 * @returns {HTMLElement} The chip.
 */
function renderSyncChip(sync, { compact = false } = {}) {
    let state = sync?.state ?? 'up-to-date';
    const stale = state === 'syncing' && Number.isFinite(sync?.since) && (Date.now() - sync.since) > 150_000;
    if (stale) {
        state = 'failed';
    }
    const meta = syncMeta(state);
    const chip = el('span', `sanguine_sync sanguine_sync_${meta.cls}${compact ? ' sanguine_sync_compact' : ''}`);
    chip.title = state === 'failed'
        ? stale
            ? 'Extraction stalled, the last pass never finished (hung or interrupted). It retries on the next message.'
            : `Extraction failed: ${sync.reason}, ${sync.detail}`
        : meta.title;
    chip.appendChild(el('i', 'sanguine_sync_dot'));
    // The word only when the word is needed.
    //
    // `compact` used to mean "the collapsed rail"; it now also means the record-health strip, where
    // a permanent `SYNCED` label is a line of text asserting that nothing is wrong. The dot carries
    // the state, the tooltip spells it out, and the label comes back for `failed`/`stalled`: the
    // one state that needs a decision from the player rather than patience. `behind` stays a dot on
    // purpose: it is self-correcting by construction, and a warning that clears itself is noise.
    if (!compact || state === 'failed') {
        chip.appendChild(el('span', 'sanguine_sync_label', stale ? t`stalled` : meta.label));
    }
    return chip;
}

/**
 * The trace section: the latest extraction pass, if any, shown as the full input->output pair
 * under a quiet heading. A click prints it verbatim to the console, the same "a question you
 * ask on purpose" discipline as the calibration report, because the full prompt is long and the
 * panel exists to be glanced at, not read. `state.log` keeps the last N failures for the footer;
 * this is the SUCCESSES, which nothing else on the panel shows.
 * @param {object|null} rec The latest traced pass (from `trace.last()`), or null.
 * @returns {HTMLElement|null} The section, or null when nothing is traced yet.
 */
function traceButton(rec) {
    if (!rec) {
        return null;
    }
    // Everything the six spans used to spell out, in the tooltip. The line read
    // `ok · t5 · #0 · interval · 23:49:49 · click to print prompt → output to the console`, which is
    // six facts about the extractor's plumbing set at the same weight as what the story is doing.
    const when = rec.t ? new Date(rec.t).toLocaleTimeString() : '?';
    const facts = [
        rec.ok ? t`ok` : `${t`failed`}: ${rec.reason ?? ''}`,
        rec.turn != null ? `${t`turn`} ${rec.turn}` : '',
        rec.mid != null ? `${t`message`} #${rec.mid}` : '',
        rec.why,
        when,
    ].filter(Boolean).join(' · ');

    const button = el('button', `sanguine_health_btn sanguine_trace_btn${rec.ok ? '' : ' sanguine_trace_failed'}`);
    button.type = 'button';
    button.appendChild(el('i', 'fa-solid fa-receipt'));
    button.title = `${t`Last extraction pass`}, ${facts}\n${t`Click to print the prompt and the reply to the console.`}`;
    button.setAttribute('aria-label', t`Print the last extraction pass to the console`);
    button.addEventListener('click', () => {
        console.log(`[sanguine] trace, pass @ ${new Date(rec.t ?? Date.now()).toISOString()}`);
        console.log(`[sanguine] PROMPT\n${rec.prompt ?? ''}`);
        console.log(`[sanguine] RAW REPLY\n${rec.raw ?? ''}`);
        console.log(`[sanguine] PARSED\n${JSON.stringify(rec.parsed ?? null, null, 2)}`);
    });
    return button;
}

/**
 * The record-health strip: is what you are looking at current, and can you check?
 *
 * Three controls that were never three things.
 *
 * The sync chip, the reconcile button and the trace line used to render as three consecutive
 * siblings in the CONTENT column, between the scene header and the protagonist's vitals. Read down
 * the panel and you passed `● behind`, a bare circular arrow, and a row of extractor telemetry
 * before reaching a single fact about the story.
 *
 * None of them are about the fiction. All three answer the same question, *is this record still
 * true, and what happened last time it was checked*, which makes them one control group, and a
 * control group belongs in a strip with its own treatment rather than interleaved with prose. The
 * reconcile button in particular was reported as hard to find, and it was: an unlabelled 22px icon
 * with nothing around it to say it was a control reads as a bullet point.
 *
 * Top-left, and why that is not a promotion.
 *
 * It was docked right, below the header and the stat grid, on the reasoning that nothing here is
 * read at a glance so it belongs at the panel's lowest rank. The rank is right and the POSITION was
 * wrong, because rank on this panel is carried by treatment, size, weight, opacity, not by depth.
 * The strip answers "is what I am about to read current", and burying the answer under the first
 * two blocks of content means it is read after the thing it qualifies.
 *
 * So it moves to the corner and keeps every bit of its quietness: 22px outlines at `--o-context`,
 * no labels, the state word only for a state that needs a decision. It is findable without being
 * loud, which is what "looked for, not glanced at" actually asks for.
 *
 * The corner was not free real estate, either, it was rendering a stray `? ` from a class
 * collision, so the panel's top-left was already spent, on nothing.
 *
 * @param {object} sync The `state.sync` record.
 * @param {object|null} rec The latest traced pass (from `trace.last()`), or null.
 * @returns {HTMLElement} The strip.
 */
function recordStrip(sync, rec) {
    const strip = el('div', 'sanguine_health');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', t`Record`);
    // Compact: the dot alone. The state word is in the tooltip and returns as a visible label only
    // when the state is one you need to act on, see `renderSyncChip`.
    strip.appendChild(renderSyncChip(sync, { compact: true }));
    const traced = traceButton(rec);
    if (traced) {
        strip.appendChild(traced);
    }
    strip.appendChild(popoutButton());
    strip.appendChild(reconcileButton());
    return strip;
}

/**
 * The one control that opens the full record, the pop-out.
 *
 * Everything else on this strip answers "is what I am looking at current". This one answers "show
 * me everything": every summary row on the panel is a summary because the full record is one click
 * away, and this is the click that does not need a row to start from. Opens the overlay to the tab
 * it was last on. `o` does the same when the panel is open and focus is not in a text field.
 *
 * @returns {HTMLElement} The control.
 */
function popoutButton() {
    const button = el('button', 'sanguine_health_btn');
    button.type = 'button';
    const icon = el('i', 'fa-solid fa-up-right-from-square');
    button.appendChild(icon);
    button.title = t`Open the full record, entities, threads, chronicle, inventory, assets, repairs, audit, diagnostics. (o while the panel is open)`;
    button.setAttribute('aria-label', t`Open the full record`);
    button.addEventListener('click', () => overlay.open({}));
    return button;
}

/**
 * The reconcile control, and the badge that invites you to read what it found.
 *
 * Disabled while it runs, because the pass is a model call and a double-click would spend two and
 * pose the same rows twice.
 *
 * The button and the background agent are the same pass.
 *
 * The agent reconciles on the extraction cadence (`index.js` `AUDIT_EVERY`); this button is the
 * on-demand arm of the same pass. Both call `audit.run()`: the exact detectors (staleness,
 * capacity, identity, conservation, duplicates, pollution) shortlisted and resolved in one model
 * call against the full history, conserving writes applied on sight, the rest kept as durable
 * questions. There is one reconcile, and pressing the button does exactly what the agent does when
 * it decides it is time.
 *
 * Why the count is a badge and not a popup.
 *
 * Measured, across 22 campaigns: `reconcile:asked: 80`, `reconcile:declined: 2`,
 * `reconcile:applied: 0`. Every one of those asks arrived inside a modal that had to be dispatched
 * before play could continue, and the cheap answer to a forced question is always Cancel. The pass
 * now applies its conserving repairs on sight and leaves its questions as durable state, so this
 * badge is an INVITATION and nothing is forced open behind it, the overlay is not opened after a
 * run, and the questions keep until they are answered or superseded.
 *
 * Why the badge is its own button.
 *
 * A `<button>` cannot contain a `<button>`, and this count has to be clickable: its whole job is to
 * open the Audit tab. So it is a sibling positioned over the icon's corner rather than a span
 * inside it, which also means it lands in the tab order on its own, with its own accessible name,
 * instead of being a decoration that only a mouse can reach.
 *
 * @returns {HTMLElement} The control group: the pass button, and the badge when anything is waiting.
 */
function reconcileButton() {
    const wrap = el('span', 'sanguine_reconcile_wrap');
    const button = el('button', 'sanguine_health_btn sanguine_reconcile_btn');
    button.type = 'button';
    // Circular arrows, and they spin while the pass runs, the wait is a model call, so a control
    // that looks identical before and during would read as one that did nothing.
    const icon = el('i', 'fa-solid fa-arrows-rotate');
    button.appendChild(icon);
    // The whole label lives in the tooltip now, so it has to carry what the icon no longer says:
    // that this is the same pass the agent runs on its own, and that only a row that needs the
    // player's call waits, never the fiction.
    button.title = t`Reconcile, the same pass the background agent runs on its own. Exact detectors shortlist the record; identity and conservation resolve in one model call, staleness and capacity are held for you to answer in the Audit tab. Conserving fixes apply on sight; nothing is ever forced on the fiction.`;
    button.setAttribute('aria-label', t`Reconcile the tracked record against the story`);
    button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        icon.classList.add('fa-spin');
        try {
            await audit.run({ now: entities.turn() });
        } catch (error) {
            console.error('[sanguine] reconcile failed', error);
            toastr.error(t`Reconcile failed, see the console.`);
        } finally {
            button.disabled = false;
            // `render()` below may replace this button wholesale; the handle is only used before
            // that, so a stale one cannot throw and swallow the error path.
            icon.classList.remove('fa-spin');
            // Unconditionally: a pass can apply fixes and leave questions while answering 0, and
            // either changes the badge. Gating the repaint on the return value is how the
            // invitation would fail to appear.
            render();
        }
    });
    wrap.appendChild(button);

    const waiting = audit.questions().length;
    if (waiting > 0) {
        const badge = el('button', 'sanguine_reconcile_badge', String(waiting));
        badge.type = 'button';
        badge.title = t`${waiting} audit questions are waiting. Only the ones that need your call, staleness and capacity, and nothing is applied until you answer. Leaving them costs nothing.`;
        badge.setAttribute('aria-label', t`Open the Audit tab, ${waiting} questions waiting`);
        badge.addEventListener('click', () => overlay.open({ tab: 'audit' }));
        wrap.appendChild(badge);
    }

    return wrap;
}

/**
 * Make a node editable in place, committing on blur or Enter.
 *
 * §8's edit-in-place, in its simplest honest form: display-form/edit-form swap on focus,
 * commit-on-blur/Enter, placeholder-on-empty. Every commit goes through the caller's `onCommit`,
 * which is a ledger user event (`state.adjustItem` / `setContext`), hand edits stay auditable and
 * swipe-safe, the §0 repair script becomes clicking.
 *
 * @param {HTMLElement} node The display node to make editable.
 * @param {object} [opts] Options.
 * @param {(value: string) => void} [opts.onCommit] Called with the raw text on commit.
 */
function makeEditable(node, { onCommit = () => {} } = {}) {
    node.classList.add('sanguine_editable');
    node.addEventListener('click', (event) => {
        // The count sits inside the item head, whose own click toggles the cause-link trail.
        // Entering edit mode must not also flip the disclosure, one click, one job.
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
        node.classList.toggle('sanguine_empty', !value);
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
 * The trail used to be a `title` attribute, a newline-joined dump the browser renders as an
 * unstyled tooltip, in the OS font, after a delay, positioned wherever it likes, and dismissed by
 * moving the mouse. It read as a debug artefact because that is exactly what it was. A click-to-
 * expand list is the same information given a shape: aligned deltas, running total, real type.
 *
 * @param {object} item An entry from `state.snapshot().inventory`.
 * @returns {HTMLElement} The `li`.
 */
/**
 * The row's own controls, revealed on hover.
 *
 * Why two deletes, and why they are not the same button.
 *
 * A tracker you cannot correct is one you stop trusting the first time it is wrong, and the two
 * ways a row can be wrong need different repairs. `−` records that the thing LEFT the story: an
 * appended event, kept in the trail, undone by a swipe like any other. `×` says it was NEVER TRUE
 * and erases the events that asserted it, because writing "lost 1 phantom sword" to cancel a row
 * the model invented would put fiction in the audit trail in order to correct fiction on the panel.
 *
 * Hidden until the row is hovered (`sanguine_actions`), so a panel read at a glance stays a panel
 * and only becomes a console when reached for.
 *
 * @param {Array<{label: string, title: string, run: () => void, danger?: boolean}>} actions
 * @returns {HTMLElement} The control cluster.
 */
function rowActions(actions) {
    const box = el('span', 'sanguine_actions');
    for (const action of actions) {
        const button = el('button',
            `sanguine_act${action.danger ? ' sanguine_act_danger' : ''}${action.cls ? ` ${action.cls}` : ''}`,
            action.label);
        button.type = 'button';
        button.title = action.title;
        button.addEventListener('click', (event) => {
            // The row head is itself a disclosure toggle; an action must not also open the trail.
            event.stopPropagation();
            event.preventDefault();
            action.run();
        });
        box.appendChild(button);
    }
    return box;
}

/**
 * Ask for a value, seeded with the current one.
 *
 * `prompt` rather than an inline form: SillyTavern already owns the modal layer, and a second one
 * inside a floating panel that can be dragged off-screen is a worse place to type. Returns null on
 * cancel, which every caller treats as "changed nothing".
 *
 * @param {string} question What to ask.
 * @param {string} current The value now.
 * @returns {string|null} The answer, trimmed, or null.
 */
function ask(question, current = '') {
    // eslint-disable-next-line no-alert
    const answer = window.prompt(question, current);
    if (answer === null) return null;
    const trimmed = String(answer).trim();
    return trimmed || null;
}

/**
 * One line of the `Running` section.
 *
 * Why this section exists at all.
 *
 * The panel's inventory is a list of LEVELS, and a list of levels has nothing to watch. What makes a
 * simulation worth looking at is its derivatives: not "97 rounds" but "97, down six a day, empty in
 * sixteen". This is the only place on the panel that shows a rate, and it is sorted by urgency
 * rather than by name, the thing about to run out floats, which is the whole difference between an
 * inventory and a feed.
 *
 * @param {object} flow A row from `flows.list`.
 * @param {number} held What the ledger currently holds of its target.
 * @param {number|null} empties Periods until the target runs out, or null.
 * @returns {HTMLElement} The row.
 */
function flowRow(flow, held, empties) {
    const row = el('li', `sanguine_row sanguine_flow${flow.on ? '' : ' sanguine_is_resolved'}`);

    const head = el('div', 'sanguine_item_head');
    head.appendChild(el('span', 'sanguine_item_name', flow.display || sentenceCase(flow.item)));
    head.appendChild(el('span', 'sanguine_item_qty', Number.isFinite(held) ? String(held) : ', '));

    // The face is editable in place, the same interaction as the clock and the vitals. `parseFlow`
    // reads back exactly what `flowFace` printed, which is fold parsing its own protocol rather
    // than reading narrative, the licence `parseClock` already takes on the clock field.
    const face = el('span', `sanguine_meta sanguine_rate${flow.dq < 0 ? ' sanguine_rate_down' : ' sanguine_rate_up'}`,
        `${flow.dq < 0 ? '▼' : '▲'} ${flowFace(flow)}`);
    face.title = flow.on
        ? t`${flow.label}, click to change the rate, or empty it to stop.`
        : t`${flow.label}, paused. It keeps what it has earned.`;
    head.appendChild(face);
    row.appendChild(head);

    const foot = el('div', 'sanguine_item_foot');
    if (Number.isFinite(empties) && empties !== null) {
        // Under one period left is the urgent case, the same shape as a dial past three quarters.
        const urgent = empties <= 1;
        foot.appendChild(el('span', `sanguine_meta${urgent ? ' sanguine_urgent' : ''}`,
            t`empty in ${Math.max(1, Math.round(empties))}`));
    }
    if (flow.on && Number.isFinite(flow.nextIn)) {
        foot.appendChild(el('span', 'sanguine_meta',
            flow.coord === BY_CLOCK
                ? t`next in ${formatGap(flow.nextIn)}`
                : t`next in ${Math.max(0, Math.round(flow.nextIn))} exchanges`));
    }
    if (!flow.on) {
        foot.appendChild(el('span', 'sanguine_meta', t`paused`));
    }
    if (foot.childNodes.length) {
        row.appendChild(foot);
    }
    return row;
}

/**
 * One capability: a name, its grade, and how it was got.
 *
 * Deliberately NOT `itemRow` with the quantity hidden. A capability shares the audit trail and the
 * cause-link with an item and shares nothing else, no count to edit, no place to move it to, and
 * no "move somewhere else" action, because there is nowhere for a skill to go. Reusing the item row
 * and suppressing three of its affordances is how `abilities` became a place in the first place.
 *
 * @param {object} row A `snapshot().abilities` row.
 * @returns {HTMLElement} The row.
 */
function abilityRow(row) {
    const node = el('li', 'sanguine_row sanguine_item');
    node.appendChild(rail(row.since));

    const head = el('div', 'sanguine_item_head');
    head.appendChild(openLink(row.display || sentenceCase(row.name), 'inventory', row.key,
        t`Open this capability`));
    // The grade rides beside the name in the instrument face, exactly as it does on an item,
    // `Quarterstaff proficiency D` is one row whose grade changed, never two capabilities.
    if (row.rank) {
        head.appendChild(el('span', 'sanguine_meta sanguine_rank', row.rank));
    }
    head.appendChild(rowActions([
        {
            label: '✎', title: t`Rename this, or set its grade`,
            run: () => {
                const to = ask(t`Rename to:`, row.name);
                if (to && to !== row.name && edits.renameAbility(row.key, to)) render();
            },
        },
        {
            label: '−', title: t`No longer has it, records that it was lost`,
            run: () => {
                if (edits.removeAbility(row.key)) render();
            },
        },
        {
            label: '×', danger: true, title: t`Never had it, erases the events that granted it`,
            run: () => {
                if (edits.forgetAbility(row.key)) render();
            },
        },
    ]));
    node.appendChild(head);

    if (!row.from?.length) {
        return node;
    }
    // The trail is the one thing a capability shares wholly with an item: how you came to have it,
    // with a click through to the message that granted it.
    node.classList.add('sanguine_has_trail');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(el('span', 'sanguine_caret', '›'));
    const trail = el('div', 'sanguine_trail');
    for (const entry of row.from.slice(-TRAIL_LIMIT)) {
        const line = el('div', 'sanguine_trail_row sanguine_trail_jump');
        line.title = t`Jump to the message that caused this`;
        line.appendChild(el('span', `sanguine_trail_dq ${entry.dq >= 0 ? 'gain' : 'loss'}`,
            entry.dq >= 0 ? `+${entry.dq}` : String(entry.dq)));
        line.appendChild(el('span', 'sanguine_trail_sum', entry.summary ?? ''));
        if (Number.isFinite(entry.mid)) {
            line.addEventListener('click', (event) => {
                event.stopPropagation();
                jumpToMessage(entry.mid);
            });
        }
        trail.appendChild(line);
    }
    node.appendChild(trail);

    const toggle = () => {
        const open = node.classList.toggle('sanguine_open_trail');
        head.setAttribute('aria-expanded', String(open));
    };
    head.addEventListener('click', (event) => {
        if (event.target.closest('.sanguine_actions')) return;
        toggle();
    });
    head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    return node;
}

function itemRow(item) {
    const row = el('li', 'sanguine_row sanguine_item');
    row.appendChild(rail(item.since));

    const head = el('div', 'sanguine_item_head');
    // Opens the inventory tab on this row. The audit trail is still expandable in place below,
    // because a cause-link is the one piece of item detail that answers a question you have
    // WHILE reading the sidebar rather than one you went looking for.
    head.appendChild(openLink(item.display || sentenceCase(item.name), 'inventory', item.key, t`Open this item`));
    // The grade, beside the name rather than folded into it. `rank` is why `Quarterstaff
    // proficiency (E)` and `Quarterstaff proficiency` are one row whose grade changed instead of two
    // abilities, it has been in the ledger and in the narrator's block all along, and this is the
    // first time the panel says it. Derived, so it is set in the instrument face.
    if (item.rank) {
        head.appendChild(el('span', 'sanguine_meta sanguine_rank', item.rank));
    }
    if (item.place === MONEY) {
        // An amount, not a multiplier. "Won ×9999" reads as nine thousand separate wons, and was
        // also a lie, the count was clamped to an item ceiling that has no business bounding money.
        // Editable in place; the delta is committed with `at: 'money'` so it lands on the balance,
        // not in a pocket (the mid-46 clamp lesson, FOLD-REDESIGN.md §8).
        const money = el('span', 'sanguine_meta sanguine_money sanguine_editable', item.qty.toLocaleString());
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
        const count = el('span', 'sanguine_meta sanguine_editable', `×${item.qty}`);
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
    // Every row is correctable, including a lone one, the count only rendered when it was above
    // one, so a single wrong item could be deleted but never counted up.
    if (item.place !== MONEY && item.qty <= 1) {
        const count = el('span', 'sanguine_meta sanguine_editable sanguine_qty_one', `×${item.qty}`);
        makeEditable(count, {
            onCommit: (value) => {
                const next = Math.trunc(Number(String(value).replace(/[^\d-]/g, '')) || 0);
                if (edits.setItemQty(item.key, next)) render();
            },
        });
        head.appendChild(count);
    }

    head.appendChild(rowActions([
        {
            label: '✎', title: 'Rename this',
            run: () => {
                const to = ask('Rename to:', item.name);
                if (to && edits.renameItem(item.key, to)) render();
            },
        },
        {
            label: '→', title: 'Move somewhere else',
            run: () => {
                const to = ask('Move to (carried, assets, or a place):', item.place);
                if (to && edits.moveItemTo(item.key, to)) render();
            },
        },
        {
            label: '−', title: 'No longer has it, records that it left the story',
            run: () => {
                if (edits.removeItem(item.key)) render();
            },
        },
        {
            label: '×', danger: true,
            title: 'Never had it, erases the events that claimed it',
            run: () => {
                if (edits.forgetItem(item.key)) render();
            },
        },
    ]));

    row.appendChild(head);

    if (!item.from?.length) {
        return row;
    }

    row.classList.add('sanguine_has_trail');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('aria-expanded', 'false');
    head.appendChild(el('span', 'sanguine_caret', '›'));

    const trail = el('div', 'sanguine_trail');
    // Only the tail. A long-held item accumulates a contributor per turn that touches it, and a
    // disclosure that opens into forty rows is a log file, not an explanation. The running total
    // still starts from the true beginning, so the arithmetic on screen stays correct.
    const shown = item.from.slice(-TRAIL_LIMIT);
    const hidden = item.from.length - shown.length;
    let running = item.from.slice(0, hidden).reduce((sum, entry) => sum + entry.dq, 0);

    if (hidden > 0) {
        const earlier = el('div', 'sanguine_trail_row');
        earlier.appendChild(el('span', 'sanguine_trail_dq', '⋯'));
        earlier.appendChild(el('span', 'sanguine_trail_sum', `${hidden} ${t`earlier`}`));
        earlier.appendChild(el('span', 'sanguine_trail_run', String(running)));
        trail.appendChild(earlier);
    }

    for (const entry of shown) {
        running += entry.dq;
        const line = el('div', 'sanguine_trail_row');
        line.appendChild(el('span', `sanguine_trail_dq ${entry.dq > 0 ? 'gain' : 'loss'}`,
            `${entry.dq > 0 ? '+' : ''}${entry.dq}`));
        line.appendChild(el('span', 'sanguine_trail_sum', entry.summary || t`Recorded`));
        line.appendChild(el('span', 'sanguine_trail_run', String(running)));
        // Cause-link: a contributor with an anchor jumps the chat to the message that caused the
        // change (§8, altitude 3). A contributor without one (legacy, no mid recorded) stays inert.
        if (Number.isFinite(entry.mid)) {
            line.classList.add('sanguine_trail_jump');
            line.title = t`Jump to the message that caused this`;
            line.addEventListener('click', () => jumpToMessage(entry.mid));
        }
        trail.appendChild(line);
    }
    row.appendChild(trail);

    const toggle = () => {
        const open = row.classList.toggle('sanguine_open_trail');
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
    return el('i', `sanguine_rail ${age <= 0 ? 'fresh' : age <= 3 ? 'warm' : ''}`.trim());
}

/**
 * One dial: a name, a meter, and what happens when it fills.
 *
 * Two shapes, because polarity is not decoration.
 *
 * A doom draws as the Blades clock face, discrete segments, filling toward something you do not
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
    const row = el('li', `sanguine_row sanguine_clock_row${progress ? ' sanguine_progress_row' : ''}`);
    row.appendChild(rail(thread.stale));
    row.appendChild(openLink(sentenceCase(thread.name), 'threads', thread.key, t`Open this thread`));

    const hidden = thread.seen === 'hidden';
    const size = thread.dial?.size || 6;
    if (progress) {
        const track = el('span', 'sanguine_track');
        track.title = hidden ? t`Underway, your character cannot tell how far` : `${thread.filled}/${size}`;
        const fill = el('i');
        fill.style.width = `${hidden ? 0 : Math.max(0, Math.min(1, thread.pressure)) * 100}%`;
        track.appendChild(fill);
        // The bar and its fraction are one right-hand cell on the NAME line; the about
        // ("visa granted") drops to its own row below. Split as separate grid items, the
        // fraction and the about shared a cell and ran together (the live panel defect).
        const tail = el('span', 'sanguine_progress_tail');
        tail.appendChild(track);
        if (!hidden) {
            tail.appendChild(el('span', 'sanguine_meta', `${thread.filled}/${size}`));
        }
        row.appendChild(tail);
        if (thread.about) {
            row.appendChild(el('span', 'sanguine_sub', thread.about));
        }
        return row;
    }

    const dial = el('span', `sanguine_dial${hidden ? ' hidden' : ''}${thread.pressure >= 0.75 ? ' urgent' : ''}`);
    if (hidden) {
        // Named but not quantified. Knowing something is closing in without knowing how close is
        // its own kind of pressure, and it is the honest thing to show for a threat the character
        // cannot perceive.
        dial.title = t`Closing in, your character cannot tell how near`;
        dial.appendChild(el('i', 'sanguine_seg unknown'));
    } else {
        dial.title = `${thread.filled}/${size}`;
        for (let seg = 0; seg < size; seg++) {
            dial.appendChild(el('i', `sanguine_seg${seg < thread.filled ? ' on' : ''}`));
        }
    }
    row.appendChild(dial);

    if (thread.about) {
        row.appendChild(el('span', 'sanguine_sub', thread.about));
    }
    return row;
}

/**
 * One person or lead.
 * @param {object} entity An entity record.
 * @param {string} kind 'person' or 'lead'.
 * @returns {HTMLElement} The row.
 */
function entityRow(entity, kind, { showStatus = true, turn = 0, hedged = false, marks = [], holds = [] } = {}) {
    const row = el('li', `sanguine_row sanguine_entity${hedged ? ' sanguine_unplaced' : ''}`);
    row.appendChild(rail(entity.stale));
    // The name is the way in. A summary row is only allowed to be a summary because the full record
    // is one click away, that is the whole contract that lets this panel stop printing four
    // sublines per person.
    row.appendChild(openLink(entity.name, kind === 'lead' ? 'threads' : 'cast', entity.key,
        kind === 'lead' ? t`Open this thread` : t`Open this character`));
    // Shown in the room, marked as not known to be in the room.
    //
    // These are people fold has not retracted and cannot place. The panel used to assert them into
    // the scene without saying so, which is how HERE read as five people on a turn when the
    // narration had named none of them (FOLD-REDESIGN.md §0.1-1). Dimmed and suffixed, they stay
    // one glance away without claiming anything.
    if (hedged) {
        row.appendChild(el('span', 'sanguine_meta sanguine_hedge', t`· whereabouts unstated`));
    }

    // The eye goes to what changed.
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
        row.classList.add(`sanguine_is_${badge}`);
    }
    // The right-hand chips: lifecycle badge, presence status, disposition.
    //
    // Grouped into ONE grid cell so they sit side by side on the name line instead of
    // auto-placing down the auto column, where each chip took its own row and the status
    // stacked onto the description row below (the live "NEW forces open onto a newline" defect).
    const tail = el('span', 'sanguine_row_tail');
    if (badge) {
        // `t` is a template tag; calling it with a bare string passes the string as its `strings`
        // array and crashes (`strings.reduce`). The badge is fold's own protocol vocabulary, which
        // this codebase is free to leave in English, the docblock at `entity-table.js` governs.
        tail.appendChild(el('span', `sanguine_badge sanguine_badge_${badge}`, badge));
    }
    if (entity.status && showStatus) {
        tail.appendChild(el('span', `sanguine_meta sanguine_status_${entity.status}`, entity.status));
    }
    // Correcting a stake or a person.
    //
    // Both tables are STORED rather than derived, so these are table writes and not events: there
    // is no fold to re-derive them from, and `clocks.set` / `entities.patch` are the same writers
    // the extraction pass uses. That also means there is nothing to `forget` here, a stored row
    // has no originating event, so a stake or a person gets one delete, not two.
    tail.appendChild(rowActions(kind === 'lead'
        ? [
            {
                label: '✓', title: 'Settled, close this stake the way the review would',
                run: () => {
                    if (edits.closeThread(entity.name)) render();
                },
            },
            {
                label: '✎', title: 'Edit this stake',
                run: async () => {
                    const changed = await editRow(`Edit ${entity.name}`, THREAD_FIELDS, entity);
                    if (changed && Object.keys(changed).length && edits.editThread(entity.name, changed)) render();
                },
            },
            {
                label: '×', danger: true, title: 'Never was a stake, drop it entirely',
                run: () => {
                    if (edits.deleteThread(entity.key)) render();
                },
            },
        ]
        : [
            {
                label: '✎', title: 'Edit this person',
                run: async () => {
                    // The whole row. The first cut asked for `wants` alone through a prompt, which
                    // presented one of ten columns as though it were all of them.
                    const changed = await editRow(`Edit ${entity.name}`, CAST_FIELDS, entities.load().get(entity.key) ?? entity);
                    if (changed && Object.keys(changed).length && edits.editCast(entity.key, changed)) render();
                },
            },
            {
                label: '×', danger: true, title: 'Not a real person, drop this row',
                run: () => {
                    if (edits.deleteCast(entity.key)) render();
                },
            },
        ]));
    // Disposition as a scale you read at a glance.
    //
    // Five pips, filled to rank. Citizen Sleeper's condition pips are the reference: a shape carries
    // an ordinal faster than a word does, and the word stays in the title for anyone who needs it
    // or cannot see the difference.
    if (kind === 'person' && entity.feels) {
        const rank = dispositionRank(entity.feels);
        const meter = el('span', `sanguine_feels sanguine_feels_${entity.feels}`);
        meter.title = `${sentenceCase(entity.feels)} toward you`;
        for (let pip = 0; pip < DISPOSITIONS.length; pip++) {
            meter.appendChild(el('i', `sanguine_pip${pip <= rank ? ' on' : ''}`));
        }
        tail.appendChild(meter);
    }
    row.appendChild(tail);

    // Place and activity, paired but distinct, "in the stableyard · sparring with Marote" rather
    // than one prose field doing both jobs badly. `reach` joins them rather than hiding inside
    // `detail`: how you contact someone is the thing you look for when they are NOT in the room,
    // and it used to be filed as an item in a pocket (`state-table.js:104-110`).
    // For a thread, `open` below IS the row, "what is still unresolved" is the whole reason a
    // stake is on the panel, so `detail` renders only when there is no open question to show. Two
    // prose lines per thread was 805px across ten rows, and the second line was describing a stake
    // the first line had already named.
    const said = kind === 'person'
        ? [entity.place, entity.detail, entity.reach && `${t`reach`}: ${entity.reach}`].filter(Boolean).join(' · ')
        : (entity.open ? '' : entity.detail);
    if (said) {
        // The predicate, in the mono face and the relation colour, this is the pairing the flat
        // block destroyed, and setting it as a sibling bullet is exactly the bug being fixed.
        row.appendChild(el('span', kind === 'person' ? 'sanguine_pred' : 'sanguine_sub',
            kind === 'person' ? `↳ ${said}` : said));
    }
    // What acting would settle, set apart from the description of what the lead is. Reading these
    // as one string is how a thread became indistinguishable from a fact.
    if (entity.open) {
        // `sanguine_unresolved`, not `sanguine_open`: the panel root wears `sanguine_open` as its
        // expanded-state class, so the two collided and this rule styled the whole panel. See the
        // rule's own comment in `style.css` for what leaked through and what it cost.
        row.appendChild(el('span', 'sanguine_unresolved', entity.open));
    }
    // One line, because four was the panel's single biggest spreadsheet-maker.
    //
    // `wants`, `knows` and `facts` each used to render as their own stacked subline. Nine people in
    // Elsewhere is thirty-six lines of small grey prose at one weight, which is the excel-spreadsheet
    // complaint in its purest form, every one of them true, none of them ranked, and no answer at
    // all to "which of these do I read".
    //
    // They are interleaved into one clamped line here and rendered in full in the Cast dossier,
    // which the row's own name now opens. That is what makes this DEMOTION rather than deletion, and
    // the reason the click-through had to exist before this line could be written.
    //
    // The order is deliberate: motive, then leverage, then standing description. What someone wants
    // is the thing that changes what they do next; what they look like is the thing you can re-read
    // any time.
    const glance = [
        entity.wants && `${t`wants`} ${entity.wants}`,
        entity.knows && `${t`knows`} ${entity.knows}`,
        entity.facts,
    ].filter(Boolean).join(' · ');
    if (glance) {
        const line = el('span', 'sanguine_glance', glance);
        // The full text stays reachable without opening anything, for the case where the clamp cut
        // one word off the end and the dossier would be a heavy answer to a light question.
        line.title = glance;
        row.appendChild(line);
    }
    // What is wrong with them, on their row.
    //
    // The whole of Phase D in one strip of chips. Before `who`, Lee's ribs and Park's thigh were
    // rendered under the PLAYER's Condition heading, because the flag table had no subject
    // (`FOLD-RPG-GAP.md` §3). A mark now renders exactly once, beside the person carrying it.
    if (marks.length) {
        const strip = el('div', 'sanguine_marks');
        for (const mark of marks) {
            const chip = el('span', `sanguine_mark sanguine_mark_${mark.severity || 'moderate'}`, sentenceCase(mark.phrase));
            chip.title = `${sentenceCase(mark.phrase)}, ${mark.severity || 'moderate'}`;
            strip.appendChild(chip);
        }
        row.appendChild(strip);
    }
    // What they are carrying, on their row, for the marks argument exactly.
    //
    // Before items had an owner, a companion's gear had two fates and both were wrong: dropped
    // (New Eldoria's ironwood branch, chronicled at mid 82 and never recorded) or filed in the
    // player's pockets (Vexia's stone sphere at mid 84, her cloth scrap at mid 90, and the 17 gold
    // she was handed at mid 108). It renders exactly once now, beside whoever holds it.
    if (holds.length) {
        const strip = el('div', 'sanguine_holds');
        for (const item of holds) {
            const label = item.qty > 1 ? `${item.name} ×${item.qty}` : item.name;
            const chip = el('span', 'sanguine_holds_item', label);
            chip.title = item.place === CARRIED ? label : `${label}, ${item.place}`;
            strip.appendChild(chip);
        }
        row.appendChild(strip);
    }
    // One small integer, and only while they are actually dangerous. A dead hobgoblin's row carries
    // nothing (`entity-table.js` MAX_THREAT).
    if (entity.threat > 0) {
        const meter = el('span', 'sanguine_threat', `${t`threat`} ${entity.threat}`);
        meter.title = t`Actively dangerous. The review clears this when the fight ends.`;
        row.appendChild(meter);
    }
    // `facts` joined the glance line above rather than keeping a row of its own.
    //
    // `source` is gone from the glance entirely. It is a citation, "Martinez's report", "heard from
    // generator room", and a citation answers a question you ask ON PURPOSE, after you have decided
    // to doubt something. It is in the Threads and Cast tabs, one click from the row it belongs to,
    // which is where a question you ask on purpose belongs.
    return row;
}

/**
 * Redraw from derived state. Cheap enough to run on every message: the fold is over at most a few
 * hundred events, and the alternative is a cache that can disagree with the ledger.
 */
export function render() {
    // The strip is the collapsed altitude, so every render pass refreshes it too, even when the
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
    // Belongings, grouped the same way and for the same reason. `owner` is a table key resolved in
    // `state.snapshot()`, so the panel never has to know that a name and a title are one person.
    const heldBy = new Map();
    for (const item of snapshot.inventory ?? []) {
        if (item.mine || !item.owner) continue;
        heldBy.set(item.owner, [...(heldBy.get(item.owner) ?? []), item]);
    }
    const holdsFor = person => heldBy.get(person.key) ?? [];
    target.replaceChildren();

    // The card's own health wording, all of it, joined: a card writing `Health: Uninjured` and
    // `Status: Rested` keeps both. Shown as prose only when the fold has no marks of its own, and
    // `HEALTH_LABELS` not `BODY_FIELDS`, because `conditions` in context is the legacy ambient.
    const health = [...HEALTH_LABELS].map(label => scene.get(label)).filter(Boolean).join('; ');

    // Context labels the entity view has taken over. Kept in `scene` for the deadline scan and for
    // the fallback below, but never rendered twice.
    const claimed = new Set([...SCENE_FIELDS, ...BODY_FIELDS, 'pov']);

    // The point-of-view character is not a member of the cast he is observing, `entities.snapshot`
    // has already resolved him through the alias set and removed him from both lists. The panel
    // used to do this itself with a whole-string comparison, which is why "Hero" and "Solomon"
    // both appeared: two names for one man, and neither equal to the other.
    //
    // Claimed unconditionally, because the conditional version failed exactly where it mattered.
    //
    // These two claims used to be gated on the structured tables being non-empty, `if
    // (cast.people.length || cast.unplaced.length)`, on the reasoning that a card's flat prose is
    // better than nothing when extraction has produced nothing. It reads well and it is backwards.
    // Raccoon City has an empty entity table (`migrate.js` says so about this very chat), so
    // `immediate contacts` was never claimed, fell through to `aside`, and rendered at the bottom of
    // the panel as `Sheet → Immediate contacts: bus driver and passengers`: a raw status-block
    // string presented as though it were a tracked fact, on the one chat where the fallback was
    // supposed to help.
    //
    // A label the structured view owns is owned whether or not the view currently has rows in it.
    // An empty cast is a cast with nobody in it, which is a true and useful thing to render; it is
    // not licence to print the card's prose under a heading that implies fold extracted it.
    ENTITY_FIELDS.people.forEach(label => claimed.add(label));
    ENTITY_FIELDS.leads.forEach(label => claimed.add(label));

    // The card's own stat line, routed by what the model says each field IS.
    //
    // See `review-table.js` `SHEET_KINDS`. Every field carries a `kind` and a `tempo` the review
    // answered; fold never reads the label to decide where a field goes, because the label is the
    // card author's English and the next card's will be different.
    //
    // `identity` rides in the header, `gauge`+`scene` joins the vitals, and everything else waits
    // below the fold. A field the review has not reached yet has no `kind` at all and lands in the
    // sheet, visible, never guessed at, and reclassified on the next pass.
    // The panel agrees with the prompt about what has gone stale.
    //
    // `contextBand` is how the injected block decides whether a context field still has warrant:
    // assert it, annotate it with its age, or drop it entirely (`state-table.js`, applied in
    // `state.render`). Nothing ever deletes a context key at runtime, `setContext` merges, so a
    // label the card wrote once survives every later block that does not mention it.
    //
    // The panel computed `age` on every field and then never read it. So a field the prompt had
    // stopped asserting turns ago, because the scene has moved on and nothing has restated it,
    // went on rendering here indefinitely, which is how a stale card fragment earns a heading on a
    // surface that is supposed to describe the present. One filter, and the two surfaces stop
    // disagreeing about what is still true.
    const aside = snapshot.context
        .filter(field => !claimed.has(field.label))
        .filter(field => contextBand(field.age) !== 'drop');
    const partsOf = value => String(unwrapList(value) ?? '').split(/\s*[;,，、；]\s*/).map(part => part.trim()).filter(Boolean);

    // A card gauge the review says names a fold vital IS that vital. It renders once, as the bar
    // the ledger computed, and the card's copy is dropped here rather than shown beside it. That
    // duplication is the defect this whole routing exists to kill: `MP 30/50` appeared twice, in
    // two different treatments, in two different places, and a glance surface that argues with
    // itself has to be read instead of glanced at.
    // What the character IS rides in the header, beside their name.
    const identity = aside.filter(field => field.kind === 'identity');
    const conditions = aside.filter(field => field.kind === 'condition');
    // The stat line, at the top, whatever its tempo.
    //
    // `SHEET_STATS` is the scalar half of the enum. An unclassified field falls back to the SHAPE
    // it has, one short part is a stat, several parts or a long one is a list, because until the
    // review has answered, the panel still has to put it somewhere, and "somewhere" must not be the
    // bottom: everything is unclassified on the first render of every chat, and demoting the lot
    // reproduces exactly the complaint this routing exists to fix.
    const scalar = field => partsOf(field.value).length <= 1
        && partsOf(field.value).every(part => part.length <= LONG_STATEMENT);
    const isStat = field => (field.kind ? SHEET_STATS.includes(field.kind) : scalar(field));

    // A `same_as` naming a row fold does not hold must do NOTHING.
    //
    // `same_as` says "this card field is the fact your ledger already tracks", and the panel drops
    // the card's copy so the fact renders once. That is only safe when the named row EXISTS, and
    // `aliasMap` has always said so: "the `known` filter is what keeps a verdict naming a key the
    // ledger does not hold from doing anything, silently and safely" (`crosswalk.js`).
    //
    // MEASURED here the moment the first real classification landed: the review answered
    // `{label: 'hp', kind: 'gauge', same_as: 'hp'}`: correct in spirit, since HP is plainly a
    // gauge, but this chat's ledger has no `hp` vital at all, only `mp`. Unfiltered, the card's
    // copy was dropped in deference to a row that does not exist and HP vanished from the panel
    // entirely. Deferring to nothing is worse than showing the card's own number.
    const held = new Set([
        ...snapshot.vitals.map(vital => vital.name),
        ...snapshot.inventory.map(item => item.name),
    ]);
    const shadowsHeld = field => Boolean(field.same_as) && held.has(field.same_as);
    // Ordered by tempo: what can move this scene reads first. This is all `tempo` decides, it
    // never demotes a stat off the top, which was the mistake this replaces.
    const stats = aside
        .filter(field => isStat(field) && field.kind !== 'identity' && !shadowsHeld(field))
        .sort((a, b) => Number(b.tempo === 'scene') - Number(a.tempo === 'scene'));
    // Lists and prose wait below: capabilities, goals, bonds, and anything the review called `other`.
    const routed = new Set([...identity, ...stats, ...conditions]);
    const notes = aside.filter(field => !routed.has(field) && !shadowsHeld(field));

    // The record controls sit at the panel's top-left corner, opposite the clock.
    //
    // They used to render below the header and the stat grid, docked right. Two things were wrong
    // with that. The first is ordering: the strip is the answer to "is what I am about to read
    // current", which is a question you ask BEFORE reading, and it was placed after the first two
    // blocks of content. The second is that the corner it now occupies was not empty, it held a
    // stray `? ` from a CSS class collision, so the panel's most prominent corner was spent on a
    // glyph that meant nothing (see `style.css` `.sanguine_unresolved`).
    //
    // Built here rather than inside `sceneHeader` because that function returns null before the
    // first scene lands, and "no scene yet" is exactly when a player most wants to see whether
    // extraction is running.
    target.appendChild(recordStrip(snapshot.sync, trace.last()));

    // The header carries `identity` as a subtitle, so it is built after the routing rather than
    // before it, who you are belongs beside your name, not in a list below the fold.
    const head = sceneHeader(scene, {
        ...snapshot.clock, locks: snapshot.locks, contests: snapshot.contests,
        subtitle: identity.map(field => unwrapList(field.value)).filter(Boolean).join(' · '),
    });
    if (head) {
        target.appendChild(head);
    }

    // The card's stat line, immediately under the header. This is the "up the top next to name,
    // time" the owner asked for, and the reason it is here rather than below Threads.
    if (stats.length) {
        target.appendChild(statGrid(stats));
    }

    const deadline = nearestDeadline(scene, stakes.open);

    // You: the protagonist, their body and their money.
    //
    // §8 restructures the glance to lead with the person at the centre, identity, vitals, marks,
    // money, before pressure or company. "How am I doing" is answered in one glance, and money
    // stops being a thing in a pocket under Stuff: it is a balance, not an inventory row.
    // `mine` only. An item can belong to a companion now (`state-table.js` `itemKey`), and this
    // section is headed with the protagonist's name, putting Vexia's purse under it is the
    // misattribution the owner was added to stop. Theirs render on their cast row below.
    const moneyItems = snapshot.inventory.filter(item => item.mine && item.place === MONEY);
    // A heading with nothing under it is not a section.
    //
    // `You` used to render unconditionally, and to repeat the protagonist's name as its annotation.
    // On a chat whose ledger holds no vitals and no money, Raccoon City, where everything about
    // Solomon's body is a mark rather than a gauge, that produced `YOU        SOLOMON` sitting
    // alone between the header and Condition: an empty section whose only content was a name the
    // header states in 17px directly above it. Two claims at once that the panel had nothing to
    // say and that it was worth a heading to say so.
    //
    // The name is gone because the header owns it, and the heading appears only when something is
    // beneath it. Condition renders under its own heading either way, so nothing is orphaned.
    if (snapshot.vitals.length || moneyItems.length) {
        target.appendChild(section(t`You`));
    }

    for (const vital of snapshot.vitals) {
        const row = el('div', 'sanguine_vital');
        const vhead = el('div', 'sanguine_vital_head');
        vhead.appendChild(el('span', 'sanguine_vital_name', vitalLabel(vital.name)));
        // The reading is the value, so it is the thing to click. "80/100" round-trips as typed:
        // `setVital` sends the DIFFERENCE, because `dcur` is a change and an absolute would be
        // read as a change of that size.
        // `max: 0` is "no ceiling stated" (`state-table.js` `merge_vital`), and a count renders as a
        // count. Typing "40/60" into it still establishes a ceiling, the editor splits on the
        // slash, so the reading a player can write is richer than the one fold prints.
        const reading = el('span', 'sanguine_meta sanguine_editable',
            vital.max > 0 ? `${Math.round(vital.cur)}/${Math.round(vital.max)}` : `${Math.round(vital.cur)}`);
        makeEditable(reading, {
            onCommit: (value) => {
                const [rawCur, rawMax] = String(value).split('/');
                const want = {
                    cur: Number(String(rawCur ?? '').replace(/[^\d-]/g, '')),
                    ...(rawMax === undefined ? {} : { max: Number(String(rawMax).replace(/[^\d-]/g, '')) }),
                };
                if (edits.setVital(vital.name, want)) render();
            },
        });
        vhead.appendChild(reading);
        vhead.appendChild(rowActions([
            {
                label: '×', danger: true,
                title: 'Never had this gauge, erases the events that claimed it',
                run: () => {
                    if (edits.forgetVital(vital.name)) render();
                },
            },
        ]));
        row.appendChild(vhead);

        // A bar is a fraction of a ceiling, so a row with no ceiling gets no bar. Drawing one at 0%
        // says "empty" about a count that is merely unbounded, which is the same invented geometry
        // `merge_vital` stopped fabricating, arriving through the renderer instead.
        if (vital.max > 0) {
            const bar = el('div', 'sanguine_bar');
            const fill = el('span');
            const ratio = Math.max(0, Math.min(1, vital.cur / vital.max));
            fill.style.width = `${ratio * 100}%`;
            fill.classList.add(ratio <= 0.25 ? 'critical' : ratio <= 0.5 ? 'low' : 'ok');
            bar.appendChild(fill);
            row.appendChild(bar);
        }
        target.appendChild(row);
    }

    // Tracked conditions first, because those are the ones that tick. The narrator's own prose is
    // a FALLBACK, not a companion: showing both gives "Mild hangover" from the fold and "Mild
    // hangover, otherwise uninjured" from the block, which is the same fact twice and was exactly
    // the stacked-health-lines complaint.
    if (snapshot.status.length || health) {
        target.appendChild(section(t`Condition`));
        const list = el('ul', 'sanguine_list');
        for (const flag of snapshot.status) {
            const row = el('li', `sanguine_row sanguine_cond sanguine_mark_${flag.severity || 'moderate'}`);
            row.appendChild(rail(0));
            row.appendChild(el('span', null, sentenceCase(flag.phrase)));
            // The severity word, printed for anything above the mildest rank. `minor` is left
            // unstated for the same reason `renderLedger` leaves it out: labelling every scratch
            // "minor" spends the line saying "nothing much".
            if (flag.severity && flag.severity !== 'minor') {
                row.appendChild(el('span', 'sanguine_meta sanguine_sev', flag.severity));
            }
            if (flag.turns > 0) {
                // Fading, not counting down in words: the exact number of turns left is a
                // precision the extraction never had.
                row.appendChild(el('span', 'sanguine_meta', flag.fade > 0.5 ? t`persists` : t`fading`));
                const dur = el('div', 'sanguine_dur');
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
        // Only when the fold has nothing of its own to say. The card's Health field is shown as-is.
        if (health && !snapshot.status.length) {
            target.appendChild(bulletsOrProse(health));
        }
    }

    // Money, under You, a balance with its cause-link trail, not a row in Stuff.
    if (moneyItems.length) {
        const list = el('ul', 'sanguine_list');
        for (const money of moneyItems) {
            list.appendChild(itemRow(money));
        }
        target.appendChild(list);
    }

    // The two enclosures, and why the second one changed hands.
    //
    // A border-and-background is the loudest device this panel has and the scarcest: at most two are
    // visible at rest, because three boxes shouting at once is a page with nothing emphasised. The
    // deadline alert held one of them on the strength of `nearestDeadline`.
    //
    // Then the corpus was counted: `deadline` is present on ONE thread row across 21 live chats. A
    // treatment reserved for the two most urgent things on screen was being held open for a field
    // that has fired once, ever, while the thread the player is actually pushing on had no treatment
    // at all. So the alert keeps its box only when it has something to say, which is nearly never,
    // and correctly so, and the active thread takes the standing second enclosure.
    if (deadline) {
        const alert = el('div', `sanguine_alert ${deadline.gap.passed ? 'passed' : ''}`.trim());
        const text = el('div', 'sanguine_alert_text');
        text.appendChild(el('div', 'sanguine_alert_name', sentenceCase(deadline.label)));
        if (deadline.detail) {
            text.appendChild(el('div', 'sanguine_sub', sentenceCase(deadline.detail)));
        }
        alert.appendChild(text);
        alert.appendChild(el('span', 'sanguine_alert_gap',
            deadline.gap.passed ? t`passed` : formatGap(deadline.gap.minutes)));
        target.appendChild(alert);
    }

    // The active thread.
    //
    // Two different claims, drawn differently on purpose. `pinned` is the player saying "this is what
    // I am doing", an override, and the only thing on the panel the player asserts rather than the
    // story. `touched` is `state.coverage.threads`, the model's own report of which threads the last
    // extraction window actually handled. Conflating them would be the panel telling you your own
    // intention was inferred, which is exactly the kind of quiet lie the lock/contest surface got
    // wrong elsewhere.
    //
    // Only the pinned one is enclosed. Coverage is real information and it is not a decision, so it
    // rides on the thread rows themselves rather than taking the panel's scarcest treatment.
    const current = currentThreads([...stakes.open, ...stakes.pressure, ...stakes.progress], {
        pinned: state.activeThread(),
        covered: coveredThreads(),
    });
    if (current.pinned) {
        const card = el('div', 'sanguine_active');
        const head = el('div', 'sanguine_active_head');
        head.appendChild(el('span', 'sanguine_active_tag', t`on this`));
        const unpin = el('button', 'sanguine_act', '×');
        unpin.type = 'button';
        unpin.title = t`Stop pushing on this thread`;
        unpin.addEventListener('click', () => {
            state.setActiveThread(current.pinnedKey);
            render();
        });
        head.appendChild(unpin);
        card.appendChild(head);
        card.appendChild(openLink(sentenceCase(current.pinned.name), 'threads', current.pinned.key,
            t`Open this thread`));
        // Unclamped, unlike every other thread line on the panel. This is the one stake the player
        // said they are working on, so the question it turns on is worth its full height.
        if (current.pinned.open) {
            card.appendChild(el('div', 'sanguine_active_open', sentenceCase(current.pinned.open)));
        }
        target.appendChild(card);
    } else if (current.pinnedKey) {
        // Pinned, and the thread is gone, closed, pruned, or on a branch this swipe left behind.
        // `pinnedKey` exists precisely so this is distinguishable from "nothing pinned", and saying
        // so beats a card that silently stops appearing.
        const note = el('div', 'sanguine_prose sanguine_active_lost', t`The thread you were on is no longer tracked.`);
        target.appendChild(note);
    }

    // Stuff: what you carry and where you left things, deferred to after Elsewhere.
    //
    // §8's glance order is You → Pressure → Progress → Here → Elsewhere → Stuff → Threads: the
    // nouns of what you own come after the people and the world, because "what threatens me" and
    // "who is here" answer the glance before "what is in my pockets". Money no longer ranks first
    // here, it lives under You.
    // `item.fresh` is not read here any more. `isFresh` was retired in `state-table.js` after it
    // hid 540 real rows on this very chat, a knife, a licence and a pamphlet sitting in the
    // character's pockets and absent from the prompt, and `snapshot()` now reports `fresh: true`
    // unconditionally, kept on the shape only so nothing reading it breaks. Branching on a constant
    // meant this loop's `hidden` counter could never increment and the "N not mentioned lately" note
    // below could never render, so both are gone rather than left as a feature that looks live.
    const stuff = document.createDocumentFragment();
    const places = new Map();
    for (const item of snapshot.inventory) {
        if (item.place === MONEY || !item.mine) {
            continue;
        }
        const list = places.get(item.place) ?? [];
        list.push(item);
        places.set(item.place, list);
    }

    // Carried first, then the places you left things, then the two categories last, property and
    // capability are the least volatile things on the panel and the least often consulted mid-scene.
    const rank = place => (place === CARRIED ? 1 : CATEGORIES.has(place) ? 3 : 2);
    const ordered = [...places.keys()].sort((a, b) =>
        rank(a) - rank(b) || a.localeCompare(b));

    // `ABILITIES` is deliberately absent. A capability is not a thing in a place any more, it folds
    // into its own table, so a heading here would group an empty set forever while the real rows
    // rendered nowhere. They get their own section below, with no count and no "where".
    const HEADINGS = { [CARRIED]: t`Carrying`, [ASSETS]: t`Property` };

    // Everything but the pack starts folded away.
    //
    // The split into pack / elsewhere / property / capability was already here and is the same axis
    // RPG Companion gives four tabs (`src/systems/rendering/inventory.js` `renderInventorySubTabs`:
    // On Person, Clothing, Stored, Assets). What fold lacked was not the axis but the FOLD, all of
    // it rendered open at once, so a Wuxia pack of 28 things and a house and six techniques arrived
    // as one undifferentiated column. Collapsing by default costs nothing new: the headers have been
    // click-to-collapse all along, and `rank` already says which are the between-scene sections.
    for (const place of ordered) {
        const items = places.get(place);
        // Freshest first, the order `carriedLines` already uses to decide what the review can
        // answer about: `since` counts events since a row was last touched, so what the story is
        // actually handling rises to the top and the pendant from turn two sinks. The pack is a
        // list you scan, not a list you read.
        const rows = [...items].sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
        const heading = section(HEADINGS[place] ?? sentenceCase(place), rows.length, rank(place) > 1);
        // The add control lives on the heading, because "add to THIS place" is the only sensible
        // reading of a plus sign inside a section, and it saves asking where afterwards.
        heading.appendChild(rowActions([
            openAction('inventory', t`Open the full inventory, with search and categories`),
            {
                label: '+', title: `Add something to ${HEADINGS[place] ?? place}`,
                run: () => {
                    const name = ask(`Add to ${HEADINGS[place] ?? place}:`);
                    if (name && edits.addItem(name, 1, place)) render();
                },
            },
        ]));
        stuff.appendChild(heading);
        const list = el('ul', 'sanguine_list');
        // The pack is an index now, not the pack.
        //
        // 51 rows in a 288px column, each with an expandable audit trail, is most of a screen of
        // scrolling to answer "what am I carrying", and it is the reason the sidebar could not fit
        // 70vh at rest, which is the test that says whether anything on it has earned its altitude.
        //
        // `since` counts events since a row was last touched, so the sort already puts what the
        // story is actually handling at the top and sinks the pendant from turn two. Taking the head
        // of that list is therefore not a truncation by convenience: it is the rows the story has
        // touched most recently, which is the only slice a glance surface can honestly claim to be
        // showing. Everything else is one click away in the Inventory tab, with search, categories
        // and filtering, which is why this is safe to do NOW and was not before.
        const shown = expandedSections.has(place) ? rows : rows.slice(0, GLANCE_ITEMS);
        for (const item of shown) {
            list.appendChild(itemRow(item));
        }
        stuff.appendChild(list);
        // Named and counted, never silently cut. A list that quietly stops reads as a tracker that
        // lost something, the same argument that retired `isFresh` after it hid 540 rows.
        if (rows.length > GLANCE_ITEMS) {
            stuff.appendChild(moreToggle(place, rows.length - GLANCE_ITEMS, render));
        }
    }

    // Capabilities, which are not things in a place.
    //
    // `tier 3 access ×1`, filed under `Stored (abilities)` beside `Stored (the SUV)`, was the panel
    // repeating a category error the ledger has now stopped making. A capability has no count, no
    // location and cannot be dropped, so this section shows a name and a grade and nothing else,
    // no `×1`, no place, and no "move somewhere else".
    const capabilities = (snapshot.abilities ?? []).filter(row => row.mine);
    if (capabilities.length) {
        const head = section(t`Abilities`, capabilities.length, true);
        head.appendChild(rowActions([
            openAction('inventory', t`Open the full inventory, with search and categories`),
            {
                label: '+', title: t`Add a capability`,
                run: () => {
                    const name = ask(t`Add a capability:`);
                    if (name && edits.addAbility(name)) render();
                },
            },
        ]));
        stuff.appendChild(head);
        const list = el('ul', 'sanguine_list');
        for (const row of [...capabilities].sort((a, b) => (a.since ?? 0) - (b.since ?? 0))) {
            list.appendChild(abilityRow(row));
        }
        stuff.appendChild(list);
    }

    // Pressure, above the cast.
    //
    // The one section that says what is ABOUT to happen rather than what is already true, so it
    // sits where the eye lands first. A hidden dial is named but not quantified: the panel never
    // tells you what your character does not know, and never pretends nothing is happening either.
    // Running: the only part of the panel that shows a derivative.
    //
    // Placed above Pressure because a stock about to hit zero is more urgent than a dial at 3/8, and
    // because this is the answer to "there is nothing happening unless I explicitly query for it".
    // Empty by construction until somebody sets a rate, so it costs nothing until it earns its place.
    const running = flows.list(state.loadClock())
        .map(flow => {
            const key = itemKey(flow.item, flow.at, flow.who);
            const held = snapshot.inventory.find(item => item.key === key);
            const qty = Number(held?.qty);
            const net = netRate(flows.load(), key);
            // Periods of the CURRENT net drain, not of this row alone: a shop paying for its own
            // rent is not running out, and sorting it as though it were would put the calmest row
            // at the top of a list whose whole purpose is urgency.
            const rate = flow.coord === BY_CLOCK ? net.perMinute * flow.size : net.perTurn * flow.size;
            return { flow, qty, empties: flow.on ? emptyIn(qty, rate) : null };
        })
        .sort((a, b) => {
            const left = a.empties ?? Infinity;
            const right = b.empties ?? Infinity;
            return left - right || String(a.flow.label).localeCompare(String(b.flow.label));
        });
    if (running.length) {
        target.appendChild(section(t`Running`, running.length));
        const list = el('ul', 'sanguine_list');
        for (const entry of running) {
            list.appendChild(flowRow(entry.flow, entry.qty, entry.empties));
        }
        target.appendChild(list);
    }

    if (stakes.pressure.length) {
        target.appendChild(section(t`Pressure`, stakes.pressure.length));
        const list = el('ul', 'sanguine_list');
        for (const thread of stakes.pressure) {
            list.appendChild(dialRow(thread));
        }
        target.appendChild(list);
    }

    // Progress, its own section and never inside Pressure.
    //
    // A dial that fills on success is not pressure, and for as long as they shared a table the
    // panel and the injection both said it was. Separate heading, bar rather than clock face.
    if (stakes.progress.length) {
        target.appendChild(section(t`Progress`, stakes.progress.length));
        const list = el('ul', 'sanguine_list');
        for (const thread of stakes.progress) {
            list.appendChild(dialRow(thread));
        }
        target.appendChild(list);
    }

    if (cast.people.length || cast.unplaced.length) {
        const hereHead = section(t`Here`, cast.people.length + cast.unplaced.length);
        hereHead.appendChild(rowActions([
            openAction('cast', t`Open everyone the story has named, with dossiers and history`),
        ]));
        target.appendChild(hereHead);
        const list = el('ul', 'sanguine_list');
        // A column with one value in it is not a column. Everyone in the room being "present" is
        // the normal case, and stamping it four times says nothing while costing a chip's width;
        // the moment one person is remote or gone, the distinction is worth drawing and returns.
        const mixed = new Set(cast.people.map(person => person.status)).size > 1;
        for (const person of cast.people) {
            list.appendChild(entityRow(person, 'person', { showStatus: mixed, turn: cast.turn, marks: marksFor(person), holds: holdsFor(person) }));
        }
        // After the people the scene actually contains, and visibly hedged. Sorting them last is
        // part of the honesty: the reader meets what is known before what is merely not retracted.
        for (const person of cast.unplaced) {
            list.appendChild(entityRow(person, 'person', { showStatus: false, turn: cast.turn, hedged: true, marks: marksFor(person), holds: holdsFor(person) }));
        }
        target.appendChild(list);
    }

    // Demoted, not deleted.
    //
    // People the story has left behind keep their last known place and stay one glance away. This is
    // ScenePulse's Character Wiki and Marinara's absence block, whose own wording is the point:
    // "this list does not mean everyone is present now". Dropping them entirely would lose exactly
    // the thing that makes a returning character feel remembered rather than reintroduced.
    const away = cast.elsewhere;
    if (away.length) {
        // `quiet: true`, not just the quiet CLASS. These are people the story has left behind, the
        // lowest rank the panel renders, and nine of them expanded was 631px of a 660px column,
        // more than the entire rest of the panel put together. The header still carries the count,
        // so "who is out there" is answered without any of them costing a line, and one click opens
        // them. The class only dimmed them; this is what actually folds them away.
        const head = section(t`Elsewhere`, away.length, true);
        head.classList.add('sanguine_head_quiet');
        head.appendChild(rowActions([
            openAction('cast', t`Open everyone the story has named, with dossiers and history`),
        ]));
        target.appendChild(head);
        const list = el('ul', 'sanguine_list sanguine_list_quiet');
        for (const person of away) {
            list.appendChild(entityRow(person, 'person', { showStatus: false, turn: cast.turn, marks: marksFor(person), holds: holdsFor(person) }));
        }
        target.appendChild(list);
    }

    // Stuff, after the world.
    //
    // §8's order: You → Pressure → Progress → Here → Elsewhere → Stuff → Threads. What you own is
    // the least urgent thing on the panel, the nouns come after the people and the pressure.
    target.appendChild(stuff);

    // The thread the countdown came from is already at the top of the panel, in a louder form.
    const remaining = stakes.open
        .filter(thread => thread.key !== deadline?.key)
        // The pinned thread has its own enclosure above; a second copy of it here would be the same
        // stake in two representations, which is the defect the whole record-once discipline exists
        // to stop.
        .filter(thread => thread.key !== current.pinnedKey);
    if (remaining.length) {
        const threadHead = section(t`Threads`, remaining.length);
        threadHead.appendChild(rowActions([
            openAction('threads', t`Open every thread, with its stake and provenance`),
        ]));
        target.appendChild(threadHead);
        const list = el('ul', 'sanguine_list');
        // Same argument as the pack, and the same slice. `threads()` sorts by pressure and then by
        // staleness, so the head of this list is what the story is closest to touching; ten open
        // stakes at rest was 537px of a 660px column and the tail of it was the fronts nothing has
        // moved in twenty turns. The Threads tab holds all of them, sectioned by kind, with the
        // pinned and in-play ones marked.
        const shownThreads = expandedSections.has('threads') ? remaining : remaining.slice(0, GLANCE_THREADS);
        for (const thread of shownThreads) {
            list.appendChild(entityRow(thread, 'lead', { turn: cast.turn }));
        }
        target.appendChild(list);
        if (remaining.length > GLANCE_THREADS) {
            target.appendChild(moreToggle('threads', remaining.length - GLANCE_THREADS, render));
        }
    }

    // Struck through, for one turn.
    //
    // A thread that closed or became moot holds its place once so the completion is witnessed.
    // ScenePulse does the same for quests; a change nobody saw reads as a tracker that lost
    // something. `moot` is drawn differently from `closed` on purpose, the campaign archive's
    // whole value is the difference between "we did it" and "it stopped mattering".
    if (stakes.done.length) {
        const head = section(t`Settled`, stakes.done.length);
        head.classList.add('sanguine_head_quiet');
        target.appendChild(head);
        const list = el('ul', 'sanguine_list sanguine_list_quiet');
        for (const thread of stakes.done) {
            const row = entityRow(thread, 'lead', { turn: cast.turn, showStatus: false });
            row.classList.add(thread.status === 'moot' ? 'sanguine_is_moot' : 'sanguine_is_resolved');
            list.appendChild(row);
        }
        target.appendChild(list);
    }


    // The sheet: everything that cannot change what you type this turn.
    //
    // The LIST half of the card's sheet: capabilities, goals, bonds, and anything the review called
    // `other`. These are the four the owner named as not belonging up top, `Abilities`, `Bonds`,
    // `Skills`, `Quests`: and what they share is that each one is a set of things, not a number.
    // The stat line is not here; it is under the header where it was asked for.
    //
    // A field the card wrote as PROSE, a lead, an objective in a sentence, keeps the statement
    // treatment, because a paragraph crushed into a grid row is unreadable. The test is the length
    // of the longest part against `LONG_STATEMENT`, the same threshold the statement list already
    // uses for clamping. Structure, not a list of known stat names.
    if (notes.length) {
        const brief = notes.filter(field => partsOf(field.value).every(part => part.length <= LONG_STATEMENT));
        const prose = notes.filter(field => !brief.includes(field));
        const sheetHead = section(t`Sheet`, notes.length);
        sheetHead.classList.add('sanguine_head_quiet');
        target.appendChild(sheetHead);
        if (brief.length) {
            target.appendChild(statGrid(brief));
        }
        for (const field of prose) {
            const statements = partsOf(field.value);
            target.appendChild(section(statLabel(field.label), statements.length > 1 ? statements.length : ''));
            target.appendChild(statements.length > 1
                ? statementList(unwrapList(field.value))
                : bulletsOrProse(unwrapList(field.value)));
        }
    }

    // What the block-shadow routing could not parse, shown as the card wrote it.
    //
    // `absorb.js` now routes `leads`, `pressure` and `health` fields into the thread and status
    // pipelines instead of parking them in context, so those labels no longer appear above. What a
    // pipeline refuses is kept verbatim rather than destroyed (`state.js` `noteShadow`, and Phase
    // B's precedent for the migration's own refusals), and a refusal nobody can see is a refusal
    // nobody can correct, which is the whole argument for the rejects tally beside it.
    const shadow = snapshot.shadow ?? [];
    if (shadow.length) {
        const head = section(t`Not parsed`, shadow.length);
        head.classList.add('sanguine_head_quiet');
        target.appendChild(head);
        const list = el('ul', 'sanguine_list sanguine_list_quiet');
        for (const entry of shadow) {
            const row = el('li', 'sanguine_row');
            row.appendChild(el('span', 'sanguine_prose', sentenceCase(entry.text)));
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
        target.appendChild(el('div', 'sanguine_empty',
            t`Nothing tracked yet. It fills in as the story establishes where you are and what you have.`));
    } else {
        const foot = el('div', 'sanguine_foot');
        const events = snapshot.inventory.reduce((sum, item) => sum + (item.from?.length ?? 0), 0);
        // "0 changes" is a count of a ledger this chat has never written to. Most cards have no
        // stat block at all, and reporting zero there reads as a failure rather than as a feature
        // going unused, the footer should describe what happened, not what didn't.
        if (events) {
            foot.appendChild(el('span', null, `${events} ${t`changes`}`));
        }
        // A narrator that stops restating its block is normal, measured, they arrive in bursts,
        // but a gap nobody can see is indistinguishable from a tracker that has died. Null means no
        // block has EVER arrived, which is not a gap and must not be counted as one.
        // A narrator that stopped is not a gap.
        //
        // This printed "N turns unreported" for any silence, which on the live Raccoon City campaign
        // meant an 84-turn alarm about a card whose narrator emitted blocks through turn 12 and then
        // stopped. True, and in the same visual register as a fault, about a feature nothing needs:
        // sanguine reads prose. `blockReport` separates a pause from a change of behaviour, and only
        // the pause is worth a warning.
        const block = snapshot.blockState ?? { state: 'never', gap: 0 };
        if (block.state === 'gap') {
            foot.appendChild(el('span', 'sanguine_foot_gap', `${block.gap} ${t`turns unreported`}`));
        } else if (block.state === 'stopped') {
            const stopped = el('span', 'sanguine_foot_quiet', t`no status block`);
            stopped.title = t`The narrator stopped writing status blocks ${block.gap} turns ago. Nothing is missing, everything on this panel is read from the prose.`;
            foot.appendChild(stopped);
        }
        // The chip counts what is NEW; the tally underneath it never moves.
        //
        // "97 rejected" on Raccoon City and "94 rejected" on Wuxia are lifetime figures, correct and
        // permanent, and a permanent red number is a number the eye stops reading, which costs the
        // one thing the chip exists for, saying that something happened. So the chip renders the
        // count since the reader last acknowledged (`state.js` acknowledge), floored per reason, and
        // when there is nothing new it is not drawn at all. Nothing is deleted to achieve that: the
        // lifetime total is one hover away in the title, and the Diagnostics tab still opens on all
        // of it.
        const acked = (snapshot.acks ?? []).length ? snapshot.acks[snapshot.acks.length - 1] : null;
        const lifetime = snapshot.rejects.reduce((sum, entry) => sum + entry.count, 0);
        const fresh = newRejects(snapshot.rejects, acked?.r);
        const rejects = fresh.reduce((sum, entry) => sum + entry.count, 0);
        const entries = snapshot.log ?? [];
        // Timestamp rather than a stored count, because `state.log` rotates, `reject-table.js`
        // `newerThan` argues it, and the mark's own `ts` is the watermark.
        const extractEntries = entries.filter(entry => entry.kind === 'extract');
        const extractFails = acked ? newerThan(extractEntries, acked.ts).length : extractEntries.length;
        // The diagnostics log: what was rejected and which passes failed, one click from the tally.
        // Built before the footer so the counts can toggle it DIRECTLY (class on/off, no re-render)
        //, a re-render inside a click handler is the kind of thing that silently does nothing if
        // anything else on the panel throws. Appended whenever a count is clickable, even when the
        // log is empty, because an empty log is exactly what the user needs told (specifics only
        // record from the next extraction on).
        // The log left the panel.
        //
        // `renderDiagnostics` used to build a thirty-row block of rejections, each with its raw
        // token, a caret underline and a `help:` line, and park it at the bottom of a 288px column.
        // It is the single most detailed thing the extension renders and it was on the glance
        // surface, below the fiction, in a panel whose whole problem was that everything looked
        // equally important. It is now the Diagnostics tab, where a `pre` block has room to be read.
        //
        // The counts stay exactly where they were: a validation layer nobody can see is one nobody
        // trusts, and one that gets ripped out the first time the state looks wrong.
        const openLog = () => overlay.open({ tab: 'diagnostics', focus: 'rejects' });
        if (rejects) {
            // The rejection tally, visible. A validation layer nobody can see is one nobody trusts,
            // and one that gets ripped out the first time the state looks wrong. Clicking it opens
            // the log and shows WHAT was refused, not just that something was.
            const count = el('span', 'sanguine_foot_count sanguine_foot_rejects', `${rejects} ${t`rejected`}`);
            // The breakdown is of the NEW refusals, because that is the number on the chip. The
            // lifetime total follows it rather than replacing it: a chip that showed 12 while the
            // record held 94 and said so nowhere would be a counter surface hiding a counter.
            count.title = [
                ...fresh.map(entry => `${entry.count}× ${entry.reason}`),
                acked
                    ? t`, ${lifetime} refused in total since the chat began; ${lifetime - rejects} marked as seen at turn ${acked.at}.`
                    : t`, ${lifetime} refused in total since the chat began, none of it marked as seen yet.`,
            ].join('\n');
            count.setAttribute('role', 'button');
            count.setAttribute('tabindex', '0');
            count.addEventListener('click', openLog);
            count.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLog(); }
            });
            foot.appendChild(count);
        }
        if (extractFails) {
            // Extraction passes that returned no usable JSON. The log entry for each says whether it
            // was a budget failure (empty/truncated) or a structural one (unparseable), the answer
            // to "is raising the token budget enough?"
            const count = el('span', 'sanguine_foot_count sanguine_foot_extract', `${extractFails} ${t`extract fails`}`);
            count.title = acked
                ? t`Extraction passes that produced no usable JSON since you last marked these as seen, ${extractEntries.length} are still in the log. Click to see whether it is the token budget or something structural.`
                : t`Extraction passes that produced no usable JSON, click to see whether it is the token budget or something structural.`;
            count.setAttribute('role', 'button');
            count.setAttribute('tabindex', '0');
            count.addEventListener('click', openLog);
            count.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLog(); }
            });
            foot.appendChild(count);
        }
        // Every line in it is now conditional, so the bar itself has to be. An empty rule under the
        // panel is a footer that says nothing while looking like it meant to.
        if (foot.childElementCount) {
            target.appendChild(foot);
        }
    }

    // Collapsible sections.
    //
    // A click on any section header hides the list that follows, so a crowded panel can be
    // thinned without configuration (§8's "progressive disclosure must be structural"). The
    // choice is remembered for the session across re-renders, because every render rebuilds the
    // DOM and a collapse that forgets itself on the next message is a feature nobody will use.
    //
    // A `quiet` section starts collapsed the FIRST time it is seen and is the player's thereafter.
    // `decided` is what makes that one-shot rather than sticky: without it, opening a quiet section
    // would last exactly until the next render, which is the same broken feature by another route.
    for (const sec of target.querySelectorAll('.sanguine_sec')) {
        const label = sec.dataset.label ?? sec.textContent.trim();
        if (sec.dataset.quiet && !decidedSections.has(label)) {
            decidedSections.add(label);
            collapsedSections.add(label);
        }
        sec.setAttribute('role', 'button');
        sec.setAttribute('tabindex', '0');
        if (collapsedSections.has(label)) {
            sec.classList.add('sanguine_collapsed');
        }
        const toggle = () => {
            const on = sec.classList.toggle('sanguine_collapsed');
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

    // A render changes the panel's HEIGHT, a chat with a cast and an inventory is several times
    // the height of an empty one, and a taller panel at the same offset reaches further down the
    // screen. Measured while testing this: an open panel sitting at 588px was 153px tall on the
    // welcome screen and 709px tall once a chat loaded, so its bottom 284px, footer counters and
    // all, was off the viewport with nothing having moved. Re-clamps the display only; the stored
    // offset is untouched, so it returns to where it was put when the panel shrinks again.
    applyTop();
}

/**
 * The collapsed sidebar, altitude 1 (FOLD-REDESIGN.md §8).
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
 * fires. Nothing on it is configurable, it renders whatever exists and collapses the segments that
 * don't. Clicking anywhere on it expands the panel, so a glance becomes altitude 2 without the
 * strip costing anything to maintain.
 */

let stripTimer = null;

/** The collapsed-body container inside the panel, or null before initPanel. */
function collapsedBody() {
    return document.querySelector(`#${PANEL_ID} .sanguine_collapsed_body`);
}

/**
 * Whether the sidebar is currently mounted (the collapsed form, or the expanded panel on top of it).
 * @returns {boolean} True when the panel exists and is mounted.
 */
export function stripVisible() {
    return !!document.getElementById(PANEL_ID)?.classList.contains('sanguine_mounted');
}

/**
 * Mount or unmount the sidebar outright (fold disabled, for example).
 *
 * Mounting is `next || visible`: an expanded panel stays on screen even when the state track is
 * off: the collapsed rail is what follows the state switch, the panel itself is the player's own
 * choice. Unmounting requires both to be off.
 * @param {boolean} next Whether the collapsed rail should be mounted.
 */
export function setStripVisible(next) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }
    panel.classList.toggle('sanguine_mounted', !!(next || visible));
    if (next || visible) {
        renderStrip();
    }
}

/**
 * Render the collapsed rail: whatever segments exist, in the §8 order, empty ones dropped.
 *
 * The rail and the panel are the same data, `state.snapshot()`, at different altitudes. This is
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
        segments.push(el('span', 'sanguine_strip_seg sanguine_strip_time', snapshot.clock.raw));
    }
    if (at) {
        segments.push(el('span', 'sanguine_strip_seg sanguine_strip_place', sentenceCase(at)));
    }
    const balance = state.balance();
    if (balance.amount > 0) {
        segments.push(el('span', 'sanguine_strip_seg sanguine_strip_money',
            `${balance.amount.toLocaleString()} ${balance.currency}`));
    }
    const urgent = clocks.snapshot(entities.turn(), at).find(dial => dial.kind === 'doom' && !clocks.isFull(dial));
    if (urgent) {
        segments.push(el('span', 'sanguine_strip_seg sanguine_strip_dial',
            `${urgent.filled}/${urgent.size}`));
    }

    // The lifecycle chip is the one segment that is ALWAYS there, the collapsed rail is where the
    // player glances while the panel is closed, so it is exactly where "is my state current?" has
    // to be answerable (FOLD-SLA.md §2.1).
    segments.unshift(renderSyncChip(snapshot.sync, { compact: true }));

    rail.replaceChildren(...segments);
    rail.classList.toggle('sanguine_collapsed_empty', !segments.length);
}

/**
 * Flash the rail in the verdict's band colour, a transient cue, never a persistent state.
 * @param {string} band CLEAR, COST or SETBACK.
 */
export function flashVerdict(band) {
    const rail = collapsedBody();
    if (!rail) {
        return;
    }
    rail.classList.remove('sanguine_flash_clear', 'sanguine_flash_cost', 'sanguine_flash_setback');
    rail.classList.add(`sanguine_flash_${band}`);
    if (stripTimer) {
        clearTimeout(stripTimer);
    }
    stripTimer = setTimeout(() => {
        rail.classList.remove('sanguine_flash_clear', 'sanguine_flash_cost', 'sanguine_flash_setback');
    }, 4000);
}

/* moving the panel.
 *
 * Why fold moves itself instead of calling `dragElement`.
 *
 * The panel used to be handed to SillyTavern's Moving UI (`dragElement` + `loadMovingUIState`),
 * which is the right convention and did not work here, for three reasons that compound:
 *
 *   · The stylesheet pins the panel with `left: auto !important` so it hugs the right edge and the
 *     collapse tab has somewhere to be. `dragElement` moves an element by writing an INLINE
 *     `left`, and an inline declaration loses to `!important`. Horizontal drag was a no-op, and a
 *     drag that only half-answers reads as a drag that is broken.
 *   · Its only handle is `.drag-grabber` inside `.panelControlBar`, and the control bar is
 *     `display: none` while collapsed. So the rail, the altitude the panel spends most of its
 *     life at, had no handle at all.
 *   · It is bound to `mousedown`/`mousemove`, gated on `power_user.movingUI`, and returns early on
 *     `isMobile()`. A touchscreen could never move it, whatever the setting said.
 *
 * So this owns the one axis the layout actually leaves free. What is given up with it: the
 * bottom-right resize corner, which could only ever have changed the HEIGHT, `width` is
 * `!important` at both altitudes, so resize was half-blocked by the same rule as drag.
 *
 * The position is stored in fold's own settings rather than `power_user.movingUIState`, so it
 * persists whether or not Moving UI is switched on.
 */

/** Pixels of travel before a press counts as a drag and stops counting as a click. */
const DRAG_SLOP = 4;

/** Pixels kept between the panel and the top or bottom of the viewport. */
const EDGE_GAP = 4;

/** Surfaces that begin a drag. One at each altitude: the tab and grip expanded, the rail collapsed. */
const DRAG_HANDLES = '.sanguine_toggle, .drag-grabber, .sanguine_collapsed_body';

/** Where the player put it, in px from the top of the viewport; null means the stylesheet's default. */
let panelTop = null;

/** Called with the new offset once a drag settles, so the setting can follow. */
let onMoved = () => {};

/**
 * Hold an offset inside the viewport.
 *
 * The stored value is normalised once, when the drag settles, the player just put it there, so
 * that is a position they can see. It is never rewritten by anything else, which matters because
 * the two altitudes are different heights: the rail is 120px and the open panel is up to 70vh, so
 * an offset that is legal collapsed can be illegal expanded. Clamping on every apply would let
 * expanding the panel once permanently drag the rail back up the screen.
 *
 * @param {number} top The desired offset.
 * @returns {number} An offset that keeps the panel on screen.
 */
function clampTop(top) {
    const height = document.getElementById(PANEL_ID)?.getBoundingClientRect().height ?? 0;
    const floor = Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP);
    return Math.min(Math.max(top, EDGE_GAP), floor);
}

/**
 * Write the stored offset to the panel, or clear it and let the stylesheet's `top` stand.
 *
 * Called after every altitude change and on resize, because both change what "on screen" means.
 */
function applyTop() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
        return;
    }
    panel.style.top = panelTop === null ? '' : `${clampTop(panelTop)}px`;
}

/**
 * Set the panel's vertical offset from outside, the persisted value, at startup.
 * @param {number|null} top Offset in px, or null for the default.
 */
export function setPanelTop(top) {
    panelTop = Number.isFinite(top) ? Number(top) : null;
    applyTop();
}

/**
 * Make the panel draggable up and down from any of its handles.
 *
 * Pointer events rather than mouse events, so the same code path serves a mouse, a trackpad and a
 * touchscreen. Every handle is also a button, the tab collapses, the rail expands, so a press
 * only becomes a drag after `DRAG_SLOP` of travel, and a press that became a drag swallows the
 * click it would otherwise have fired.
 *
 * @param {HTMLElement} panel The panel element.
 */
function wireDrag(panel) {
    let from = 0;
    let base = 0;
    let handle = null;
    let pointer = -1;
    let moved = false;
    let swallow = false;

    const finish = () => {
        if (!handle) {
            return;
        }
        if (handle.hasPointerCapture?.(pointer)) {
            handle.releasePointerCapture(pointer);
        }
        handle = null;
        panel.classList.remove('sanguine_dragging');
        if (moved) {
            swallow = true;
            panelTop = Math.round(clampTop(panelTop));
            applyTop();
            onMoved(panelTop);
        }
    };

    panel.addEventListener('pointerdown', (e) => {
        // Cleared here rather than by the click it suppresses, because that click is not guaranteed
        // to arrive: let go of a drag with the cursor off the panel and no click is dispatched to it
        // at all, and a flag waiting to be consumed would then swallow the next real press instead.
        // Scoping it to the press that set it makes that impossible rather than unlikely.
        swallow = false;
        if (e.button > 0) {
            return;
        }
        const target = e.target instanceof Element ? e.target.closest(DRAG_HANDLES) : null;
        if (!target) {
            return;
        }
        handle = target;
        pointer = e.pointerId;
        moved = false;
        from = e.clientY;
        // Measured, not remembered. The stored offset is the player's intent and the panel may be
        // displaying a clamped version of it, grabbing an expanded panel that was pushed up to fit
        // would otherwise snap it back down to the rail's offset on the first pixel of travel.
        base = panel.getBoundingClientRect().top;
        // Captured on the HANDLE, not the panel: capture retargets the pointer stream, and holding
        // it on the panel would move the click off the button the player actually pressed.
        handle.setPointerCapture?.(pointer);
    });

    panel.addEventListener('pointermove', (e) => {
        if (!handle) {
            return;
        }
        const travel = e.clientY - from;
        if (!moved && Math.abs(travel) < DRAG_SLOP) {
            return;
        }
        moved = true;
        panel.classList.add('sanguine_dragging');
        panelTop = base + travel;
        applyTop();
        // Only once it IS a drag: before that the press still belongs to the button underneath.
        e.preventDefault();
    });

    panel.addEventListener('pointerup', finish);
    panel.addEventListener('pointercancel', finish);

    // Capture phase, so it runs before the tab's and the rail's own click handlers and can stop the
    // drag from also collapsing or expanding the panel it just moved.
    panel.addEventListener('click', (e) => {
        if (!swallow) {
            return;
        }
        swallow = false;
        e.stopPropagation();
        e.preventDefault();
    }, true);

    // A panel parked against the old bottom edge is off screen after the window shrinks, and the
    // stored intent is still the right thing to re-clamp from.
    window.addEventListener('resize', applyTop);
}

/** Point the collapse chevron the way the panel can move: `>` to push it right, `<` to pull it out. */
function updateToggleIcon() {
    const panel = document.getElementById(PANEL_ID);
    const toggle = panel?.querySelector('.sanguine_toggle');
    const icon = toggle?.querySelector('i');
    if (!panel || !toggle || !icon) {
        return;
    }
    const collapsed = !panel.classList.contains('sanguine_open');
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
    panel?.classList.add('sanguine_mounted', 'sanguine_open');
    updateToggleIcon();
    render();
    // The open panel is many times the rail's height, so an offset that was on screen collapsed can
    // hang off the bottom expanded. Re-clamped from the stored intent, never overwriting it.
    applyTop();
}

/** Hide the panel (fold it back to the collapsed rail). */
export function hide() {
    visible = false;
    document.getElementById(PANEL_ID)?.classList.remove('sanguine_open');
    updateToggleIcon();
    applyTop();
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
 * @param {(top: number) => void} [options.onMove] Called when the panel is dragged, so the position persists.
 * @param {number|null} [options.top] The persisted vertical offset, in px from the top of the viewport.
 */
export function initPanel({ onClose = () => {}, onOpen = () => {}, onMove = () => {}, top = null } = {}) {
    if (document.getElementById(PANEL_ID)) {
        return;
    }
    onToggleOff = onClose;
    onToggleOpen = onOpen;
    onMoved = onMove;

    const host = document.getElementById('movingDivs') ?? document.body;
    host.appendChild(buildPanel());

    const panel = document.getElementById(PANEL_ID);
    panel.querySelector('.sanguine_toggle').addEventListener('click', (e) => {
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

    wireDrag(panel);
    setPanelTop(top);

    // State is derived, so anything that changes which events are live changes what is shown,
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
        // The header carries the persona portrait, and a player can swap persona mid-chat without
        // touching a message. Without this the frame keeps the previous player's face.
        event_types.PERSONA_CHANGED,
    ]) {
        if (type) {
            eventSource.on(type, redraw);
        }
    }
    // Emitted after an extraction lands, which is when new deltas appear.
    eventSource.on('sanguine_chronicle_updated', redraw);

    // `o` opens the pop-out. A bare key, so it is guarded twice: the panel has to be open, and the
    // player cannot be typing anywhere, otherwise every message that happens to contain an `o`
    // would open the overlay. `overlay.open` is idempotent (it selects the current tab), so a
    // double-fire is harmless.
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'o' || event.metaKey || event.ctrlKey || event.altKey) return;
        if (!visible) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement &&
            (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
            return;
        }
        overlay.open({});
    });
}
