/**
 * sanguine/overlay-inventory.js: the inventory tab.
 *
 * Why a list and not a grid.
 *
 * Every inventory screen worth copying, Diablo, Resident Evil, Escape from Tarkov, is a grid, and
 * every one of them earns the grid the same way: item ART, so a shape and a colour identify a thing
 * faster than a word can, and SPATIAL PACKING, so arranging the bag is itself a puzzle. Neither is
 * available here. There is no art to ship for `SIG P226` or for `Quarterstaff proficiency (E)`,
 * which means a grid degrades to a field of identical bordered squares each holding a truncated
 * name: strictly worse than a line of text at reading them. And packing-as-puzzle is bookkeeping,
 * which is the one thing this project has said out loud it does not want.
 *
 * So: a list, and the effort goes where a list can actually beat a grid, finding the row you want
 * among sixty, and explaining WHY it says what it says.
 *
 * Inventory is not a table.
 *
 * There is no item record anywhere in this extension. `state.snapshot().inventory` is a fold over an
 * append-only event ledger, and every row on this screen is a running total with its own audit
 * trail. That is the fact the whole tab is shaped around:
 *
 *   · The row's disclosure opens onto the trail, every event that moved the count, with a running
 *     total beside it and a jump to the message that caused it. The panel shows the last six of
 *     these in 288px; this is a reading surface, so it shows all of them.
 *   · Every action is an APPEND, never a mutation. `−` records that the thing left the story and
 *     stays in the trail; `×` erases the events that ever claimed it, which is destructive and
 *     confirmed.
 *
 * Categories are discovered, never enumerated.
 *
 * `normalizePlace` (`state-table.js`) recognises exactly three protocol tokens, carried, assets,
 * money: and passes ANY other string through as a literal place the model named: "the SUV",
 * "赤焰居", "rocky ridge overhang". A fixed chip list would therefore be wrong on its first campaign.
 * The chips are built from the places actually present in the fold, sorted by kind, and the labels
 * are looked up rather than switched on.
 *
 * …and Abilities is not one of them.
 *
 * It used to be the fourth token, which made a technique a thing with a count in a location:
 * `tier 3 access ×1`, filed under "where". `state-table.js` `foldAbility` moved capabilities into
 * their own table for the whole argument; here the consequence is that the Abilities group is not
 * a place chip that happens to be reserved but a different KIND of row, drawn without a count and
 * without a "where", edited through `ABILITY_FIELDS` rather than `ITEM_FIELDS`, and written by
 * `edits.addAbility` / `removeAbility` / `editAbility`.
 *
 * They share this list anyway, and that is deliberate: a player asking "what have I got" means both,
 * and the group headings already say which is which. What they do not share is any control that
 * assumes an arithmetic quantity.
 */

import { t, translate } from '../../i18n.js';
import { eventSource } from '../../../script.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { registerTab } from './overlay.js';
import * as state from './state.js';
import * as edits from './edits.js';
// The two tiers this tab gained in §7.2, 7.3. Importing `parts.js` here is what registers its
// over-budget pruner, the same side effect `overlay-assets.js` records for `places.js`.
import * as components from './parts.js';
import * as placeRecords from './places.js';
import { COMPONENT_FIELDS, ABILITY_FIELDS, ITEM_FIELDS, SPLIT_FIELDS, editRow } from './edit-form.js';
import { readParts } from './edit-table.js';
import { jumpToMessage } from './diagnostics-view.js';
import { ABILITIES, ASSETS, CARRIED, CATEGORIES, MONEY, itemKey, normalizeItemName, splitItemKey } from './state-table.js';

/** Id of the injected stylesheet, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-inventory-css';

/**
 * Put `overlay-inventory.css` in the document head, once.
 *
 * Same shape and same reason as `overlay.js` `ensureStylesheet`: the manifest declares exactly one
 * sheet and `style.css` already holds it, so a second surface injects its own. Derived from
 * `import.meta.url` so it is found from a third-party path too, and done at import time rather than
 * at first render, a sheet that starts loading once the tab is on screen paints it unstyled.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-inventory.css', import.meta.url).href;
    document.head.appendChild(link);
}

ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. ALWAYS as text, every name and summary here is model
 *   output, and `innerHTML` on model output is the one mistake this file cannot make.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * @param {string} className Class list.
 * @param {string} [text] Label text.
 * @returns {HTMLButtonElement} A real button, with `type` set so it can never submit anything.
 */
function button(className, text = '') {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, text));
    node.type = 'button';
    return node;
}

/**
 * Capitalise the first letter only, for a place the story named, which arrives lowercased by
 * `normalizePlace`. Item names are NOT put through this: `display` already carries the story's own
 * casing, and sentence-casing `SIG P226` produced `Sig p226`, which is the defect `display` exists
 * to close.
 *
 * @param {string} text Input.
 * @returns {string} Sentence-cased text.
 */
function sentenceCase(text) {
    const value = String(text ?? '');
    return value ? value[0].toUpperCase() + value.slice(1) : value;
}

/**
 * What a place is called on screen.
 *
 * The four protocol tokens get the words the panel already uses for them, so the sidebar and the
 * overlay name the same section the same way. Everything else is a place the model wrote, and is
 * shown as it wrote it.
 *
 * @param {string} place A normalized place.
 * @returns {string} Its label.
 */
function placeLabel(place) {
    const known = {
        [CARRIED]: t`Carrying`,
        [ASSETS]: t`Property`,
        [ABILITIES]: t`Abilities`,
        [MONEY]: t`Money`,
    };
    return known[place] ?? sentenceCase(place);
}

/**
 * Which band a place sorts into. Carried first, it is the only one that changes scene to scene.
 * Then the places you left things, alphabetically. Then the three standing categories, which are
 * the least volatile and the least often consulted mid-scene.
 *
 * @param {string} place A normalized place.
 * @returns {number} Sort band.
 */
function placeRank(place) {
    if (place === CARRIED) return 0;
    return CATEGORIES.has(place) ? 2 : 1;
}

/** How the list can be ordered. `since` counts events since a row last moved, so ascending is freshest first. */
const SORTS = Object.freeze([
    { id: 'recency', label: 'Recent first', compare: (a, b) => (a.since ?? 0) - (b.since ?? 0) },
    { id: 'name', label: 'Name', compare: (a, b) => face(a).localeCompare(face(b)) },
    { id: 'qty', label: 'Most held', compare: (a, b) => (b.qty ?? 0) - (a.qty ?? 0) },
]);

/** @param {object} item An inventory row. @returns {string} The name to show and to sort by. */
function face(item) {
    return String(item?.display || item?.name || '');
}

/**
 * The capability rows, in the shape the list already draws.
 *
 * Read from `derive()` rather than from `snapshot()`.
 *
 * `state.snapshot().inventory` is built from `derive().inv`, and `foldAbility` took capabilities out
 * of it, deliberately, because they were never inventory. Until `snapshot` grows a section of its
 * own (it is not this file's to change), the tab reads the fold directly. That is the same table
 * `snapshot` reads and the same keys, so nothing here can disagree with the panel about what is
 * held; it only differs in what it is allowed to say about it.
 *
 * They carry `place: ABILITIES` so the existing grouping, chips, search and sort do the work
 * unchanged, and `kind: 'ability'` so the renderer knows to omit the two things an ability does not
 * have: a count, and anywhere to be.
 *
 * @returns {object[]} Rows.
 */
function abilityRows() {
    const { abilities, faces, since, contributors } = state.derive();
    const rows = [];
    for (const [key, row] of abilities ?? new Map()) {
        const parts = splitItemKey(key);
        rows.push({
            kind: 'ability',
            key,
            who: row?.who ?? parts.who,
            place: ABILITIES,
            name: row?.name ?? parts.name,
            display: faces?.get(key) || row?.name || parts.name,
            rank: row?.rank ?? '',
            since: since?.get(key) ?? 0,
            // Unowned is the point-of-view character's, the same reading every other table gives it.
            mine: !(row?.who ?? parts.who),
            owner: '',
            from: (contributors?.get(key) ?? []).map(c => ({ dq: c.dq, summary: c.summary, mid: c.mid ?? null })),
        });
    }
    return rows;
}

/**
 * Does a row answer the search?
 *
 * Name and grade, and deliberately not the trail: a search that matched summary prose would return
 * every row the story has ever mentioned in a sentence containing the word, which is a different
 * question ("what happened") and the Chronicle tab's. Substring rather than tokens, because item
 * names are not always space-delimited, a language without spaces has to be searchable too.
 *
 * @param {object} item An inventory row.
 * @param {string} needle A lowercased query.
 * @returns {boolean} Whether it matches.
 */
function matches(item, needle) {
    return face(item).toLowerCase().includes(needle)
        || String(item?.name ?? '').toLowerCase().includes(needle)
        || String(item?.rank ?? '').toLowerCase().includes(needle);
}

/**
 * How a count reads.
 *
 * Money is an amount and everything else is a multiplicity. `Won ×9999` was on the live panel and
 * was wrong twice, it reads as nine thousand separate wons, and the number itself had been clamped
 * to an item ceiling that has no business bounding a balance.
 *
 * @param {object} item An inventory row.
 * @returns {string} The count, as shown.
 */
function countFace(item) {
    const qty = Number(item?.qty ?? 0);
    return item?.place === MONEY ? qty.toLocaleString() : `×${qty}`;
}

/**
 * The view, kept outside the renderer on purpose.
 *
 * `context.refresh()` re-runs the renderer against an emptied body, and so does every tab switch. A
 * filter that lived in the closure would therefore reset itself every time an edit landed, the
 * player types three letters, corrects a count, and the list they were reading is gone. This is
 * session state, not a setting: it is not persisted, so it does not follow anyone into tomorrow.
 */
const VIEW = { query: '', category: '', sort: SORTS[0].id };

/** Keys whose trail is open, by item key. Survives a redraw for the same reason `VIEW` does. */
const OPEN = new Set();

/** Ids for the disclosure targets. NEVER derived from an item key, those contain NUL. */
let detailSeq = 0;

/**
 * Tell the sidebar the ledger moved.
 *
 * The panel derives from the same events and redraws on `sanguine_chronicle_updated` (panel.js), so
 * an edit made here has to say so or the two surfaces disagree until the next message. Fire and
 * forget: nothing in this tab waits on the panel.
 */
function announce() {
    Promise.resolve(eventSource.emit('sanguine_chronicle_updated', { src: 'inventory' }))
        .catch(error => console.error('[sanguine] inventory: redraw notice failed', error));
}

/**
 * The audit trail, opened out.
 *
 * Why the running total is the point.
 *
 * A row says `×3`. The trail says the story gave you two, then one more, then took none away, and
 * the third column carries the arithmetic so the claim is checkable at a glance rather than by
 * adding six numbers in your head. When fold is WRONG, this is the surface that shows where: the
 * gain nobody narrated, the loss recorded twice.
 *
 * The panel truncates this to the last six because it is 288px wide and a disclosure that opens into
 * forty rows is a log file. Here it is complete: a reading surface that hides two thirds of the
 * evidence is not a reading surface.
 *
 * @param {object} item An inventory row.
 * @returns {HTMLElement} The trail.
 */
function trail(item) {
    const box = el('div', 'sanguine_inv_trail');
    box.appendChild(el('div', 'sanguine_inv_label', t`Audit trail`));

    if (!item.from?.length) {
        // Carried forward past the ledger's horizon, or seeded from a baseline. The count is real
        // and its causes have been shed; saying so beats an empty box that reads as a bug.
        box.appendChild(el('p', 'sanguine_inv_empty', t`No events left for this, the count was carried forward.`));
        return box;
    }

    const list = el('ul', 'sanguine_inv_trail_list');
    let running = 0;
    for (const entry of item.from) {
        running += Number(entry.dq ?? 0);
        const gain = Number(entry.dq ?? 0) >= 0;
        const jumpable = Number.isFinite(entry.mid);

        const line = el('li', 'sanguine_inv_trail_row');
        // A line with an anchor is a real control, it moves the chat. One without is text, and
        // dressing it as a button would promise a jump that never happens.
        const inner = jumpable
            ? button('sanguine_inv_trail_line sanguine_inv_trail_jump')
            : el('div', 'sanguine_inv_trail_line');

        // Derived: mono, tabular, and coloured on the semantic axis, a gain is fresh, a loss warns.
        inner.appendChild(el('span', `sanguine_inv_dq ${gain ? 'sanguine_inv_gain' : 'sanguine_inv_loss'}`,
            `${gain ? '+' : ''}${Number(entry.dq ?? 0)}`));
        // The model's own sentence about what happened: prose face, full size.
        inner.appendChild(el('span', 'sanguine_inv_sum', entry.summary || t`Recorded`));
        inner.appendChild(el('span', 'sanguine_inv_run', String(running)));

        if (jumpable) {
            inner.title = t`Jump to the message that caused this`;
            inner.addEventListener('click', () => jumpToMessage(entry.mid));
        }
        line.appendChild(inner);
        list.appendChild(line);
    }
    box.appendChild(list);
    return box;
}

/**
 * What a row is made of, with each component's own rail and its own cause-link.
 *
 * One tier down, and it gets a tier's worth of surface.
 *
 * A component is not an item: it has no count, nowhere to be, and no audit trail of its own, because
 * it is a last-write claim rather than a fold over events (`part-table.js`). What it does have is
 * its own `turn` and its own `mid`, so adding an enchantment lights THAT line and jumps to the
 * message that added it, which is the whole reason components are a side table rather than words
 * inside the item's name.
 *
 * Drawn only when there is something to draw. An empty "Parts" heading on every one of sixty rows
 * would be a feature advertising itself at the cost of the list being readable.
 *
 * @param {object} item An inventory row.
 * @param {object} handlers What the row can do.
 * @returns {HTMLElement|null} The block, or null when the row has no components.
 */
function partsBlock(item, handlers) {
    const rows = item.parts ?? [];
    const box = el('div', 'sanguine_inv_parts');
    box.appendChild(el('div', 'sanguine_inv_label', t`Parts`));

    if (rows.length) {
        const list = el('ul', 'sanguine_inv_parts_list');
        for (const part of rows) {
            const line = el('li', 'sanguine_inv_part');
            const open = button('sanguine_inv_part_head');
            open.title = t`Edit this part`;
            open.addEventListener('click', () => handlers.part(item, part));
            open.appendChild(el('span', 'sanguine_inv_part_name', part.name));
            // Prose, in the body face: this is the story's own words and fold never reads it.
            open.appendChild(el('span', 'sanguine_inv_part_value', part.value));
            line.appendChild(open);

            const meta = el('div', 'sanguine_inv_part_meta');
            meta.appendChild(el('span', 'sanguine_inv_part_since',
                part.since <= 0 ? t`this turn` : t`${part.since} turns ago`));
            // `-1` is the record's own word for a write with no anchor, a hand edit. Drawing no
            // button says so better than a button that goes nowhere.
            if (part.mid >= 0) {
                const jump = button('sanguine_inv_part_jump', t`jump`);
                jump.title = t`Jump to the message that changed this part`;
                jump.addEventListener('click', () => jumpToMessage(part.mid));
                meta.appendChild(jump);
            }
            const drop = button('sanguine_inv_part_drop', '×');
            drop.title = t`Forget this part`;
            drop.addEventListener('click', () => handlers.dropPart(item, part));
            meta.appendChild(drop);
            line.appendChild(meta);
            list.appendChild(line);
        }
        box.appendChild(list);
    }

    const add = button('sanguine_inv_act', t`Add a part`);
    add.title = t`An enchantment, a calibre, a serial, anything the story says this thing has`;
    add.addEventListener('click', () => handlers.part(item, null));
    box.appendChild(add);
    return box;
}

/**
 * One row, head and detail.
 *
 * @param {object} item An inventory row from `state.snapshot().inventory`.
 * @param {object} handlers What the row can do.
 * @param {(item: object) => void} handlers.edit Open the field-spec dialog.
 * @param {(item: object) => void} handlers.drop Record that it left the story.
 * @param {(item: object) => void} handlers.forget Erase the events that claimed it.
 * @param {(item: object) => void} handlers.owner Open the cast tab on its owner.
 * @param {(item: object) => void} handlers.split Break a row into the things it actually was.
 * @returns {HTMLElement} The `li`.
 */
function itemRow(item, handlers) {
    const ability = item.kind === 'ability';
    const row = el('li', `sanguine_inv_row${ability ? ' sanguine_inv_row_ability' : ''}`
        + (item.shut ? ' sanguine_inv_shut' : ''));

    const detailId = `sanguine_inv_detail_${++detailSeq}`;
    const open = OPEN.has(item.key);

    // The whole head is the disclosure. A real button: Enter, Space, the focus ring and the "button"
    // announcement all arrive with the element, and every one would be reimplemented worse on a div.
    const head = button('sanguine_inv_head');
    head.setAttribute('aria-expanded', String(open));
    head.setAttribute('aria-controls', detailId);

    const caret = el('i', 'sanguine_inv_caret', '›');
    caret.setAttribute('aria-hidden', 'true');
    head.appendChild(caret);
    head.appendChild(el('span', 'sanguine_inv_name', face(item)));

    // The grade the story gave it. Derived and never compared, so it takes the instrument face and
    // sits beside the name rather than inside it, which is what makes `Quarterstaff proficiency
    // (E)` and `Quarterstaff proficiency` one row whose grade changed instead of two abilities.
    if (item.rank) {
        head.appendChild(el('span', 'sanguine_inv_rank', item.rank));
    }
    // Somebody else's. A chip that can navigate only when there is somewhere to navigate TO:
    // `owner` is the cast key `snapshot` resolved through the alias set, and it is '' when the story
    // has named a holder fold has no cast row for. Rendering an inert button then would promise a
    // person page that does not exist.
    if (!item.mine && item.who) {
        const label = sentenceCase(item.who);
        if (item.owner) {
            const owner = button('sanguine_inv_owner', label);
            owner.title = t`Open this person`;
            owner.addEventListener('click', event => {
                event.stopPropagation();
                handlers.owner(item);
            });
            head.appendChild(owner);
        } else {
            head.appendChild(el('span', 'sanguine_inv_owner sanguine_inv_owner_flat', label));
        }
    }
    // No count on a capability. `tier 3 access ×1` was the category error made visible: there is no
    // ×2 of a clearance level, and the number was only ever there because the fold was a sum.
    if (!ability) {
        head.appendChild(el('span', 'sanguine_inv_qty', countFace(item)));
    }
    // Unreachable, and still here.
    //
    // The place it is in was destroyed. The row is NOT hidden and its count is untouched: it renders
    // dimmed, with the reason on the chip. `cap:stale-hidden` counted 540 silent hidings in Raccoon
    // City alone and every one of them was a real thing in a real pocket, fold may say why
    // something cannot be got at; it may never quietly stop saying the thing exists.
    if (item.shut) {
        const chip = el('span', 'sanguine_inv_shut_chip', t`unreachable`);
        chip.title = t`${item.shut.name} is ${item.shut.status}, this is still yours, and cannot be got at.`;
        head.appendChild(chip);
    }
    row.appendChild(head);

    const detail = el('div', 'sanguine_inv_detail');
    detail.id = detailId;
    detail.hidden = !open;

    // Where and when, in the instrument face, both are fold's own bookkeeping rather than anything
    // a narrator wrote. `since` counts events, not minutes, which is the only clock the ledger has.
    const meta = el('div', 'sanguine_inv_meta');
    // "Where is your quarterstaff proficiency" has no answer, so it is not asked. `since` still is:
    // how long ago the story last said anything about it is a real question about a capability.
    if (!ability) {
        meta.appendChild(el('span', 'sanguine_inv_where', placeLabel(item.place)));
    }
    meta.appendChild(el('span', 'sanguine_inv_since',
        Number(item.since ?? 0) <= 0 ? t`changed this turn` : t`${Number(item.since)} events ago`));
    detail.appendChild(meta);

    // The reason, in the disclosure as well as on the chip: a tooltip is not a place to keep the one
    // sentence that explains why a row you own is greyed out.
    if (item.shut) {
        const why = el('p', 'sanguine_inv_shut_why');
        why.appendChild(document.createTextNode(translate('Unreachable, ')));
        why.appendChild(el('strong', '', item.shut.name));
        why.appendChild(document.createTextNode(` ${translate('is')} ${item.shut.status}.`));
        detail.appendChild(why);
    }

    // What it is made of, before what happened to it: a component is a property of the thing and the
    // trail is a history of the count, and the property is what a reader came to check.
    if (!ability) {
        detail.appendChild(partsBlock(item, handlers));
    }

    detail.appendChild(trail(item));

    const actions = el('div', 'sanguine_inv_actions');
    const edit = button('sanguine_inv_act', t`Edit`);
    edit.title = ability ? t`Name and grade` : t`Name, grade, count and where it is`;
    edit.addEventListener('click', () => handlers.edit(item));
    actions.appendChild(edit);

    // Split, for the row that turned out to be several things.
    //
    // The live case: the Raccoon City ledger recorded one `ammunition x28` for a purchase the
    // narration described as three magazines, twenty-five buckshot shells and a box of birdshot, and
    // repairing it took a delete and three separate Add dialogs. One row cannot be split into one, so
    // the control appears only where there is something to divide.
    if (!ability && Number(item.qty ?? 0) > 1) {
        const split = button('sanguine_inv_act', t`Split`);
        split.title = t`Record what this row actually is, the counts come out of it`;
        split.addEventListener('click', () => handlers.split(item));
        actions.appendChild(split);
    }

    // The two deletes, and they are not the same button. `−` records that the thing LEFT: an
    // appended event, kept in the trail, undone by a swipe like any other. `×` says it was NEVER
    // TRUE and erases the events that asserted it, because writing "lost 1 phantom sword" to cancel
    // a row the model invented would put fiction in the audit trail to correct fiction on screen.
    const drop = button('sanguine_inv_act', t`No longer has it`);
    drop.title = t`Records that it left the story, stays in the trail`;
    drop.addEventListener('click', () => handlers.drop(item));
    actions.appendChild(drop);

    const forget = button('sanguine_inv_act sanguine_inv_danger', t`Never had it`);
    forget.title = t`Erases the events that claimed it. This cannot be undone by a swipe.`;
    forget.addEventListener('click', () => handlers.forget(item));
    actions.appendChild(forget);

    detail.appendChild(actions);
    row.appendChild(detail);

    head.addEventListener('click', () => {
        const now = !OPEN.has(item.key);
        if (now) {
            OPEN.add(item.key);
        } else {
            OPEN.delete(item.key);
        }
        head.setAttribute('aria-expanded', String(now));
        detail.hidden = !now;
        row.classList.toggle('sanguine_inv_open', now);
    });
    row.classList.toggle('sanguine_inv_open', open);

    return row;
}

/**
 * Ask before erasing.
 *
 * `forgetItem` deletes events out of the ledger. Nothing else in this tab is irreversible, a
 * recorded loss can be swiped away like any other event, so this is the one place a confirmation
 * earns its interruption rather than training the player to dismiss dialogs.
 *
 * @param {object} item The row.
 * @returns {Promise<boolean>} Whether to go ahead.
 */
async function confirmForget(item) {
    const wrap = el('div', 'sanguine_inv_confirm');
    wrap.appendChild(el('p', '', t`Erase every event that claimed ${face(item)}?`));
    wrap.appendChild(el('p', 'sanguine_inv_confirm_note',
        t`This says it was never true and removes it from the record. Use "No longer has it" instead if the story took it away.`));
    const answer = await callGenericPopup(wrap, POPUP_TYPE.CONFIRM, '', {
        okButton: t`Erase`,
        cancelButton: t`Cancel`,
    });
    return answer === POPUP_RESULT.AFFIRMATIVE;
}

registerTab('inventory', (body, ctx) => {
    // A navigation is a promise to land on the record. If it arrived while a filter was standing
    // that hides the row, the filter loses, the alternative is an overlay that opens on an empty
    // list and says nothing about why.
    if (ctx.focus) {
        VIEW.query = '';
        VIEW.category = '';
    }

    const root = el('div', 'sanguine_inv');

    // Controls.
    //
    // Sticky, because a filter you have to scroll back up to reach is a filter that gets used once.
    const controls = el('div', 'sanguine_inv_controls');

    const search = el('label', 'sanguine_inv_search');
    // A real label, not a placeholder. A placeholder is not an accessible name, and it disappears at
    // exactly the moment the field has content and the reader most needs to know what they typed
    // into. It is uppercase and letter-spaced, which is the only thing `--s-micro` is for.
    search.appendChild(el('span', 'sanguine_inv_label', t`Search`));
    const input = /** @type {HTMLInputElement} */ (el('input', 'text_pole sanguine_inv_input'));
    input.type = 'search';
    input.autocomplete = 'off';
    input.value = VIEW.query;
    input.placeholder = translate('name or grade');
    search.appendChild(input);
    controls.appendChild(search);

    const sortWrap = el('label', 'sanguine_inv_sortwrap');
    sortWrap.appendChild(el('span', 'sanguine_inv_label', t`Sort`));
    const sort = /** @type {HTMLSelectElement} */ (el('select', 'text_pole sanguine_inv_sort'));
    for (const option of SORTS) {
        const node = /** @type {HTMLOptionElement} */ (el('option', '', translate(option.label)));
        node.value = option.id;
        node.selected = option.id === VIEW.sort;
        sort.appendChild(node);
    }
    sortWrap.appendChild(sort);
    controls.appendChild(sortWrap);

    const chips = el('div', 'sanguine_inv_chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', t`Filter by category`);
    controls.appendChild(chips);

    const add = button('sanguine_inv_add', t`Add`);
    add.title = t`Record something the story gave you and fold missed`;
    controls.appendChild(add);

    // What just happened, for a reader who cannot see the list reshuffle. A removal takes the row,
    // and the button that was pressed, out of the document, so without this the only feedback is
    // silence followed by a focus ring somewhere else.
    const status = el('p', 'sanguine_inv_status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    controls.appendChild(status);

    /**
     * Say what an edit did, and put the keyboard somewhere that still exists.
     *
     * @param {string} text The announcement.
     */
    function report(text) {
        status.textContent = text;
        // The pressed button lived inside the row that is now gone, so focus would fall to the
        // dialog and the player would have to Tab back in from the top. The search field is the one
        // control on this tab that is never removed, and it is where the next thing you do begins.
        input.focus();
    }

    root.appendChild(controls);

    const listBox = el('div', 'sanguine_inv_body');
    root.appendChild(listBox);
    body.appendChild(root);

    /**
     * Tell the group headings how far down to stick.
     *
     * They stick UNDER the controls, and the controls are one line on a wide dialog and three when
     * the chips wrap on a phone, measured on this very chat, 105px against a 56px guess. A
     * hardcoded offset is a heading that hides behind the search box at one width and floats in
     * space at another, so the number comes from the box itself.
     *
     * Written from the paint AND from a `ResizeObserver`, because neither alone is enough. The
     * observer misses the first value: the dialog animates in, and on a cold open the callback has
     * been measured firing against a box that is not laid out yet, or not firing before the render
     * is superseded, which disconnects it. The paint misses every LATER value: a chip appearing
     * after an edit rewraps the bar and nothing about that is a repaint of the controls.
     */
    const measure = () => root.style.setProperty('--inv-controls-h', `${controls.offsetHeight}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    ctx.signal.addEventListener('abort', () => observer.disconnect());

    /** The key to scroll to and highlight on the next paint, then cleared, it is a landing, not a selection. */
    let landing = String(ctx.focus ?? '');

    /**
     * Repaint the chips and the list from the ledger as it stands now.
     *
     * The controls themselves are built once and never rebuilt: the search input holds focus and a
     * caret position, and replacing it on every keystroke would take both.
     */
    function draw() {
        if (ctx.signal.aborted) return;

        // Cleared here and written by `report` afterwards, so an announcement lasts exactly as long
        // as the state it describes: typing a search or picking a chip is moving on, and a live
        // region still reading "recorded as no longer held" three interactions later is noise.
        status.textContent = '';

        // Two folds, one list. `snapshot().inventory` is the item table; `abilityRows` is the
        // capability table, which is a different class and not a different screen, a player asking
        // "what have I got" means both, and the grouping already separates them by heading.
        const items = [...(state.snapshot().inventory ?? []), ...abilityRows()];

        // The two tiers, resolved once per draw.
        //
        // Unreachability is a property of the PLACE, so it is answered once per distinct place
        // string rather than once per row, the same shape `overlay-assets.js` uses for containment.
        // `null` is the answer for a place with no record, which is every place in every chat that
        // has not built one, and it means the row behaves exactly as it does today.
        const shut = new Map();
        for (const item of items) {
            if (item.kind !== 'ability' && !shut.has(item.place)) {
                const gone = CATEGORIES.has(item.place) || item.place === CARRIED
                    ? null
                    : placeRecords.unreachable(item.place);
                shut.set(item.place, gone ? { name: gone.row?.name ?? '', status: gone.row?.status ?? '' } : null);
            }
            item.shut = shut.get(item.place) ?? null;
            item.parts = item.kind === 'ability' ? [] : components.list(item.key);
        }

        const needle = VIEW.query.trim().toLowerCase();
        const hits = needle ? items.filter(item => matches(item, needle)) : items;

        // The category set, derived.
        //
        // Every place present in the fold, whether or not the search left anything in it, a chip
        // list that reshuffles as you type is unusable. The COUNTS are of the search hits, which is
        // the standard faceted read: "if I clicked this, here is what I would get".
        const counts = new Map();
        for (const item of items) {
            counts.set(item.place, 0);
        }
        for (const item of hits) {
            counts.set(item.place, (counts.get(item.place) ?? 0) + 1);
        }
        const places = [...counts.keys()].sort((a, b) => placeRank(a) - placeRank(b) || a.localeCompare(b));

        // A category that no longer exists, the chat changed underneath us, is not a filter, it is
        // a way to show an empty list forever.
        if (VIEW.category && !counts.has(VIEW.category)) {
            VIEW.category = '';
        }

        const chipFor = (id, label, count) => {
            const node = button(`sanguine_inv_chip${VIEW.category === id ? ' sanguine_inv_chip_on' : ''}`);
            node.setAttribute('aria-pressed', String(VIEW.category === id));
            node.appendChild(el('span', 'sanguine_inv_chip_label', label));
            node.appendChild(el('span', 'sanguine_inv_chip_count', String(count)));
            if (!count) node.classList.add('sanguine_inv_chip_empty');
            node.addEventListener('click', () => {
                VIEW.category = VIEW.category === id ? '' : id;
                draw();
            });
            return node;
        };
        // Rebuilt wholesale, so the keyboard has to be put back: pressing a chip destroys the chip
        // that was pressed, and focus would fall to the dialog. By POSITION rather than by id, the
        // set is stable within a chat, and the position is what the hand and the eye were on.
        const at = [...chips.children].indexOf(document.activeElement);
        chips.replaceChildren(
            chipFor('', t`All`, hits.length),
            ...places.map(place => chipFor(place, placeLabel(place), counts.get(place) ?? 0)),
        );
        if (at >= 0) {
            /** @type {HTMLElement} */ (chips.children[Math.min(at, chips.children.length - 1)])?.focus();
        }

        // The list.
        const compare = (SORTS.find(option => option.id === VIEW.sort) ?? SORTS[0]).compare;
        const shown = VIEW.category ? places.filter(place => place === VIEW.category) : places;
        const frame = document.createDocumentFragment();
        /** @type {HTMLElement|null} */
        let landed = null;

        const handlers = {
            owner: item => ctx.open({ tab: 'cast', focus: item.owner }),
            /**
             * Add or revise one component.
             * @param {object} item The row it is about.
             * @param {object|null} part The component being edited, or null to add one.
             */
            part: async (item, part) => {
                const seed = { name: part?.name ?? '', value: part?.value ?? '' };
                const changed = await editRow(part ? t`Edit part` : t`Add a part`, COMPONENT_FIELDS, seed);
                if (!changed || ctx.signal.aborted) return;
                const wanted = { ...seed, ...changed };
                if (!String(wanted.name).trim() || !String(wanted.value).trim()) return;
                // A rename is a different key, so the old row is dropped rather than left behind as
                // a second component saying the same thing under the previous name.
                if (part && wanted.name !== part.name) components.remove(part.key);
                const written = components.set(item.key, wanted.name, wanted.value);
                if (!written.key) {
                    report(written.reason === 'place-destroyed'
                        ? t`${face(item)}, that place no longer stands.`
                        : t`${face(item)}, no room for another part.`);
                    return;
                }
                announce();
                draw();
            },
            /**
             * Forget one component.
             * @param {object} item The row it is about.
             * @param {object} part The component.
             */
            dropPart: (item, part) => {
                if (!components.remove(part.key)) return;
                announce();
                draw();
                report(t`${part.name}, no longer recorded.`);
            },
            split: async item => {
                const changed = await editRow(t`Split ${face(item)}`, SPLIT_FIELDS, { parts: '' });
                if (!changed || ctx.signal.aborted) return;
                const parts = readParts(changed.parts ?? '');
                if (!parts.length) return;
                const landed = edits.splitItem(item.key, parts);
                if (!landed.length) return;
                OPEN.delete(item.key);
                for (const key of landed) OPEN.add(key);
                landing = landed[0];
                announce();
                draw();
                report(t`${face(item)}, split into ${landed.length} rows.`);
            },
            edit: async item => {
                if (item.kind === 'ability') {
                    const want = await editRow(t`Edit ability`, ABILITY_FIELDS, { name: face(item), rank: item.rank ?? '' });
                    if (!want || !Object.keys(want).length || ctx.signal.aborted) return;
                    const moved = edits.editAbility(item.key, want);
                    if (!moved) return;
                    if (OPEN.delete(item.key)) OPEN.add(moved);
                    landing = moved;
                    announce();
                    draw();
                    return;
                }
                const seed = { name: face(item), rank: item.rank ?? '', qty: item.qty ?? 0, place: item.place };
                const changed = await editRow(t`Edit item`, ITEM_FIELDS, seed);
                if (!changed || !Object.keys(changed).length || ctx.signal.aborted) return;
                const now = edits.editItem(item.key, changed);
                if (!now) return;
                // The key is a product of the name and the place, so an edit to either MOVES it.
                // Carrying the disclosure and the landing across is what keeps the row you were
                // reading the row you are still reading.
                if (OPEN.delete(item.key)) OPEN.add(now);
                landing = now;
                announce();
                draw();
            },
            drop: item => {
                const gone = item.kind === 'ability' ? edits.removeAbility(item.key) : edits.removeItem(item.key);
                if (!gone) return;
                OPEN.delete(item.key);
                announce();
                draw();
                report(t`${face(item)}, recorded as no longer held.`);
            },
            forget: async item => {
                if (!await confirmForget(item) || ctx.signal.aborted) return;
                const erased = item.kind === 'ability' ? edits.forgetAbility(item.key) : edits.forgetItem(item.key);
                if (!erased) return;
                OPEN.delete(item.key);
                announce();
                draw();
                report(t`${face(item)}, ${erased} events erased.`);
            },
        };

        for (const place of shown) {
            const rows = hits.filter(item => item.place === place).sort((a, b) => compare(a, b) || face(a).localeCompare(face(b)));
            // A group the search emptied is not drawn at all, unless it is the one being filtered
            // to, where an absent header would read as a broken chip.
            if (!rows.length && place !== VIEW.category) continue;

            const gone = shut.get(place) ?? null;
            const heading = el('h3', `sanguine_inv_group${gone ? ' sanguine_inv_group_shut' : ''}`);
            heading.appendChild(el('span', 'sanguine_inv_group_name', placeLabel(place)));
            heading.appendChild(el('span', 'sanguine_inv_group_count', String(rows.length)));
            // Said once at the heading as well as once per row: the place is what is destroyed, and
            // a reader scanning the list should not have to infer it from six identical chips.
            if (gone) {
                heading.appendChild(el('span', 'sanguine_inv_group_shut_note', translate(gone.status)));
            }
            frame.appendChild(heading);

            const list = el('ul', 'sanguine_inv_list');
            for (const item of rows) {
                const node = itemRow(item, handlers);
                if (landing && item.key === landing) {
                    // Opened as well as revealed: the click that sent us here was on a name, and the
                    // answer to "what about this one" is the trail, not the row restated.
                    OPEN.add(item.key);
                    node.classList.add('sanguine_inv_open');
                    node.querySelector('.sanguine_inv_head')?.setAttribute('aria-expanded', 'true');
                    const detail = node.querySelector('.sanguine_inv_detail');
                    if (detail instanceof HTMLElement) detail.hidden = false;
                    landed = /** @type {HTMLElement} */ (node.querySelector('.sanguine_inv_head'));
                }
                list.appendChild(node);
            }
            frame.appendChild(list);
        }

        // Parts whose row is gone, shown rather than swept.
        //
        // A split turns one row into several and nothing can say which part inherits an enchantment,
        // so the components stay addressed to a row that stopped existing (`orphanParts`). Silently
        // deleting them would be the `cap:stale-hidden` mistake in miniature; listing them lets the
        // player put them back or let them go.
        const loose = components.orphans(new Set(items.map(item => item.key)));
        if (loose.length) {
            const heading = el('h3', 'sanguine_inv_group');
            heading.appendChild(el('span', 'sanguine_inv_group_name', t`Parts with no row`));
            heading.appendChild(el('span', 'sanguine_inv_group_count', String(loose.length)));
            frame.appendChild(heading);
            const list = el('ul', 'sanguine_inv_parts_list sanguine_inv_loose');
            for (const part of loose) {
                const line = el('li', 'sanguine_inv_part');
                const said = el('div', 'sanguine_inv_part_head');
                said.appendChild(el('span', 'sanguine_inv_part_name', part.name));
                said.appendChild(el('span', 'sanguine_inv_part_value', part.value));
                said.appendChild(el('span', 'sanguine_inv_part_orphan', splitItemKey(part.on).name));
                line.appendChild(said);
                const drop = button('sanguine_inv_part_drop', '×');
                drop.title = t`Forget this part`;
                drop.addEventListener('click', () => {
                    if (!components.remove(part.key)) return;
                    announce();
                    draw();
                    report(t`${part.name}, no longer recorded.`);
                });
                line.appendChild(drop);
                list.appendChild(line);
            }
            frame.appendChild(list);
        }

        if (!items.length) {
            frame.appendChild(el('p', 'sanguine_inv_empty', t`Nothing recorded yet. What the story gives you lands here.`));
        } else if (!hits.length) {
            const none = el('p', 'sanguine_inv_empty');
            none.appendChild(document.createTextNode(translate('Nothing matches ')));
            none.appendChild(el('strong', '', VIEW.query.trim()));
            frame.appendChild(none);
        }

        // An unknown key opens the tab and SAYS SO. The shell cannot tell a stale key from a live
        // one and opens the tab regardless, so a renderer that quietly showed the whole list would
        // leave the player hunting for a row that was forgotten three turns ago.
        if (landing && !landed) {
            const missing = el('p', 'sanguine_inv_missing', t`That item is no longer on the record, it was removed, renamed, or forgotten.`);
            frame.insertBefore(missing, frame.firstChild);
        }

        listBox.replaceChildren(frame);
        measure();

        if (landed) {
            ctx.reveal(landed);
        }
        landing = '';
    }

    input.addEventListener('input', () => {
        VIEW.query = input.value;
        draw();
    });
    // A search field's own clear affordance fires `search`, not `input`, in some engines.
    input.addEventListener('search', () => {
        VIEW.query = input.value;
        draw();
    });
    sort.addEventListener('change', () => {
        VIEW.sort = sort.value;
        draw();
    });
    add.addEventListener('click', async () => {
        // A capability is a different class, so "add" inside the Abilities chip is a different
        // dialog, two fields instead of four, and neither of the two that do not apply.
        if (VIEW.category === ABILITIES) {
            const want = await editRow(t`Add an ability`, ABILITY_FIELDS, { name: '', rank: '' });
            if (!want || ctx.signal.aborted || !String(want.name ?? '').trim()) return;
            if (!edits.addAbility(want.name, want.rank ?? '')) return;
            const key = itemKey(normalizeItemName(want.name)?.name ?? '', ABILITIES);
            OPEN.add(key);
            landing = key;
            announce();
            draw();
            return;
        }
        // Seeded with the category being looked at, because "add to THIS" is the only sensible
        // reading of a plus sign standing inside a filtered list, and it saves asking where after.
        const seed = { name: '', rank: '', qty: 1, place: VIEW.category || CARRIED };
        const changed = await editRow(t`Add an item`, ITEM_FIELDS, seed);
        if (!changed || ctx.signal.aborted) return;
        const wanted = { ...seed, ...changed };
        if (!String(wanted.name).trim()) return;
        if (!edits.addItem(wanted.name, Number(wanted.qty) || 1, wanted.place)) return;
        // A grade cannot ride along on the acquisition, `deriveState` applies a rank only to a row
        // that ALREADY EXISTS, and this one did not until the line above. Stated as its own event,
        // which is also how the extraction path reports a grade.
        //
        // The key is recomputed rather than searched for: `addItem` normalises the name (pulling out
        // any count the player baked into it, "3x rations") and the place, and `itemKey` is the same
        // function the fold used to store it, so this is arithmetic and not a guess.
        const key = itemKey(normalizeItemName(wanted.name)?.name ?? '', wanted.place);
        if (String(wanted.rank ?? '').trim()) {
            edits.setItemRank(key, wanted.rank);
        }
        OPEN.add(key);
        landing = key;
        announce();
        draw();
    });

    draw();
});
