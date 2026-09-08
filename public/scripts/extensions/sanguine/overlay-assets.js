/**
 * sanguine/overlay-assets.js: the assets tab: the place tree, and the standing holdings.
 *
 * Two things under one heading, and they are not the same thing.
 *
 * The rail calls this tab "Standing holdings and the flows that feed or drain them", and there turn
 * out to be two kinds of standing thing in fold, kept apart because they answer different questions:
 *
 *   holdings  items keyed at `ASSETS` (`state-table.js:89`), a house, a mount, a shop. Property,
 *             with a quantity and a ledger trail, exempted from staleness because owning something
 *             is not a sighting. Every chat on disk can have these today, and the live one does.
 *   places    rows in `state.places` (`place-table.js`), somewhere the story established, carrying
 *             what is permanently true of it, what is true of it now, and what it is inside. NO chat
 *             on disk has one, because until Wave 1 there was no such record.
 *
 * A house can be both, and this tab does not pretend to join them: an asset row named "the farmhouse"
 * and a place record named "the farmhouse" are two statements about one building made in two
 * registers, and inventing an identity between them from a matching string is exactly the guess
 * `resolvePlace` refuses to make. What the tab does instead is show both and let containment do the
 * joining where it is actually recorded, an item whose free-text place RESOLVES to a record is
 * listed inside that record, and one whose place resolves to nothing is simply somewhere fold has no
 * record of, which is the state of every row in every chat that exists.
 *
 * Why the empty state is the important one.
 *
 * With no place records anywhere, a tree view is an empty box, and an empty box reads as a broken
 * feature. So when the table is empty this tab does not draw a tree at all: it says what a place
 * record is, what having one buys, and how one comes to exist, while the holdings pane beside it
 * fills with the property the chat really does have. The first thing the owner sees is a working
 * surface with an explanation, not a shell waiting for data.
 *
 * `places.js` was imported by nothing before this file. Importing it here is what registers its
 * over-budget pruner (`places.js:338`) for the first time, a side effect of this module existing at
 * all, not of anything it draws.
 *
 * The focus contract, and how this tab disambiguates.
 *
 * `overlay.js` says the assets namespace is "an item key in the assets place". This tab accepts a
 * PLACE key as well, so a later sidebar row for a place has somewhere to point. Both key spaces use
 * a NUL separator, so the rule is stated precisely and checked rather than guessed:
 *
 *   A focus key is a PLACE key when it splits into EXACTLY TWO NUL-separated segments, the first is
 *   `PLACE`, and the place table actually holds that key. Everything else is read as an item key.
 *
 * The membership test is what makes it safe. `itemKey('knife', 'assets', 'place')` is three segments
 * and never matches; a two-segment key whose owner half happens to be the word "place" matches only
 * if a place record of that exact name exists, and then the place reading is the better one anyway.
 * Neither key is parsed by hand beyond that split, `splitItemKey` owns the item side, and an item
 * key that names an ordinary place is resolved through `places.resolve` rather than pattern-matched.
 *
 * The tree is a treeitem tree, not a stack of buttons.
 *
 * The APG tree pattern puts `role="treeitem"` and the roving tabindex on the ROW and does not nest
 * interactive controls inside it, because a button inside a treeitem is a second tab stop the tree's
 * own keyboard model cannot see. So the rows are `<li role="treeitem">` carrying `aria-expanded`,
 * `aria-level` and `aria-selected`, and every other control on this tab, the holdings shelf, the
 * child links, the trail jumps, the edit actions, is a real `<button>`.
 */

import { t } from '../../i18n.js';
import { ASSETS, CARRIED, CATEGORIES, itemKey, splitItemKey } from './state-table.js';
import { BY_CLOCK, emptyIn, flowFace, netRate } from './flow-table.js';
import { PLACE, PLACE_RETIRED, ancestorsOf } from './place-table.js';
import { editRow } from './edit-form.js';
import { jumpToMessage } from './diagnostics-view.js';
import { registerTab } from './overlay.js';
import * as flows from './flows.js';
import * as places from './places.js';
import * as state from './state.js';

/** Id of the injected stylesheet, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-assets-css';

/**
 * Put `overlay-assets.css` in the document head, once.
 *
 * The same shape `overlay.js:185` uses and for the same reason: `addExtensionStyle` takes one
 * filename from the manifest and `style.css` already holds it, so a second sheet has to inject
 * itself. Derived from `import.meta.url` so it is found wherever the extension is mounted, and run
 * at import time rather than at first paint so the tab never renders unstyled for a frame.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-assets.css', import.meta.url).href;
    document.head.appendChild(link);
}

ensureStylesheet();

/**
 * The selection value standing for the assets place.
 *
 * Not the table key of anything, the assets place is a reserved place string, not a record, so it
 * needs a value that cannot collide with one. Every place key contains a NUL by construction
 * (`entityKey`); this contains none.
 */
const HOLDINGS = 'holdings';

/** The separator both key spaces use. Split on it, and never parse either key further by hand. */
const KEY_SEP = '\0';

/** What each trailed field was, in the words the record means it in. */
const TRAIL_LABELS = {
    facts: 'standing',
    detail: 'now',
    status: 'status',
    place: 'inside',
};

/**
 * @param {string} tag Element name.
 * @param {string} [cls] Class list.
 * @param {string} [text] Text content. Always text, never HTML, all of this is model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, cls = '', text = '') {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
}

/**
 * @param {string} cls Class list.
 * @param {string} text Label.
 * @param {string} title Tooltip.
 * @param {() => void} run What it does.
 * @returns {HTMLButtonElement} A real button, because everything that acts on this tab is one.
 */
function button(cls, text, title, run) {
    const node = /** @type {HTMLButtonElement} */ (el('button', cls, text));
    node.type = 'button';
    if (title) node.title = title;
    node.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
    });
    return node;
}

/** @param {string} text Input. @returns {string} First letter capitalised, the rest untouched. */
function sentenceCase(text) {
    const said = String(text ?? '');
    return said ? said[0].toUpperCase() + said.slice(1) : said;
}

/** @param {string} key An opaque key. @returns {string} It, with its NULs made visible. */
function showKey(key) {
    return String(key ?? '').replace(/\0/g, '␀');
}

/** @param {object} row A place record. @returns {boolean} Whether the story is finished with it. */
function isRetired(row) {
    return PLACE_RETIRED.has(String(row?.status ?? '').toLowerCase());
}

/**
 * Which record a focus key names, if any.
 *
 * The disambiguation rule from the header, and the only place either key space is inspected.
 *
 * Whether the key names anything is deliberately NOT decided here. A place key is answerable from
 * the place table alone, but an item key is only answerable once the pane it lands in has been
 * built: an `assets`-place key for an item the ledger does not hold names a real pane and no row in
 * it, and calling that "found" because the place half parsed is how a dead key comes to look live.
 * So this reports where to go, and the landing reports whether the row was there.
 *
 * @param {string} focus The key the shell handed through, untouched.
 * @param {Map<string, object>} index Place key -> place, from the snapshot.
 * @returns {{selected: string, item: string}} What to stand on, and which item row to reveal there.
 */
function locate(focus, index) {
    const key = String(focus ?? '');
    if (!key) {
        return { selected: HOLDINGS, item: '' };
    }

    const parts = key.split(KEY_SEP);
    if (parts.length === 2 && parts[0] === PLACE && index.has(key)) {
        return { selected: key, item: '' };
    }

    // Everything else is an item key. `splitItemKey` owns that shape; nothing here re-derives it.
    const { place } = splitItemKey(key);
    if (place === ASSETS) {
        return { selected: HOLDINGS, item: key };
    }
    const record = places.resolve(place);
    if (record && index.has(record.key)) {
        return { selected: record.key, item: key };
    }
    // A place key with no record behind it lands here too, and correctly: there is nowhere to stand,
    // so it stands on the holdings and is reported as a key that named nothing.
    return { selected: HOLDINGS, item: key };
}

/**
 * One holding, with whatever rate is moving it.
 *
 * Shared by the holdings pane and by a place's contained items, because they are the same row asked
 * about from two directions, what you own, and what is in the cellar. The quantity, the grade and
 * the rate are derived values and take the instrument face; the item's name is the story's own
 * casing where the ledger caught it, so it is set as prose.
 *
 * @param {object} item An `inventory` row from `state.snapshot()`.
 * @param {Map<string, object[]>} running Item key -> the flows aimed at it.
 * @param {Map<string, object>} table The flow table, for the net rate.
 * @returns {HTMLElement} The row.
 */
function holdingRow(item, running, table) {
    const row = el('li', 'sanguine_assets_item');

    const head = el('div', 'sanguine_assets_item_head');
    head.appendChild(el('span', 'sanguine_assets_iname', item.display || sentenceCase(item.name)));
    if (item.rank) {
        head.appendChild(el('span', 'sanguine_assets_irank', item.rank));
    }
    // A count of one is the count a possession almost always has, and printing "×1" against every
    // house is noise standing where a signal should be.
    if (Number(item.qty) !== 1) {
        head.appendChild(el('span', 'sanguine_assets_iqty', `×${Number(item.qty) || 0}`));
    }
    if (!item.mine && item.who) {
        head.appendChild(el('span', 'sanguine_assets_iowner', sentenceCase(item.who)));
    }
    row.appendChild(head);

    const rates = running.get(item.key) ?? [];
    if (!rates.length) {
        return row;
    }

    const foot = el('div', 'sanguine_assets_item_foot');
    for (const flow of rates) {
        const face = el('span',
            `sanguine_assets_rate ${flow.dq < 0 ? 'sanguine_assets_rate_down' : 'sanguine_assets_rate_up'}`,
            `${flow.dq < 0 ? '▼' : '▲'} ${flowFace(flow)}`);
        face.title = flow.on ? String(flow.label) : t`${flow.label}, paused. It keeps what it has earned.`;
        if (!flow.on) {
            face.classList.add('sanguine_assets_paused');
        }
        foot.appendChild(face);
    }
    // Periods of the CURRENT net rate, not of one row: a shop paying its own rent is not running
    // out, and the sidebar's `Running` section already sorts on exactly this number.
    const net = netRate(table, item.key);
    const first = rates[0];
    const per = first.coord === BY_CLOCK ? net.perMinute * first.size : net.perTurn * first.size;
    const empties = emptyIn(Number(item.qty), per);
    if (Number.isFinite(empties)) {
        foot.appendChild(el('span',
            `sanguine_assets_empties${empties <= 1 ? ' sanguine_assets_urgent' : ''}`,
            t`empty in ${Math.max(1, Math.round(empties))}`));
    }
    row.appendChild(foot);
    return row;
}

/**
 * A place's change trail: what was revised about somewhere, and the message that revised it.
 *
 * `PLACE_TRAILED` is `facts`/`detail`/`status`/`place` (`place-table.js:136`), which is the whole of
 * what can be said differently about a place a second time. An entry with a `mid` gets the
 * cause-link: the same click the inventory trail and the diagnostics log already offer.
 *
 * @param {object[]} trail The record's trail, oldest first.
 * @returns {HTMLElement|null} The block, or null when nothing has been revised.
 */
function trailBlock(trail) {
    const entries = Array.isArray(trail) ? trail : [];
    if (!entries.length) {
        return null;
    }
    const block = el('section', 'sanguine_assets_block');
    block.appendChild(el('h4', 'sanguine_assets_head', t`Changed`));

    const list = el('ol', 'sanguine_assets_trail');
    // Newest first: what the place most recently became is the thing being looked for.
    for (const entry of [...entries].reverse()) {
        const row = el('li', 'sanguine_assets_trail_row');
        row.appendChild(el('span', 'sanguine_assets_trail_field',
            TRAIL_LABELS[entry?.field] ?? String(entry?.field ?? '')));

        const said = el('div', 'sanguine_assets_trail_said');
        if (entry?.from) {
            said.appendChild(el('span', 'sanguine_assets_trail_from', String(entry.from)));
            said.appendChild(el('span', 'sanguine_assets_trail_arrow', '→'));
        }
        said.appendChild(el('span', 'sanguine_assets_trail_to', String(entry?.to ?? '')));
        row.appendChild(said);

        const meta = el('div', 'sanguine_assets_trail_meta');
        meta.appendChild(el('span', 'sanguine_assets_trail_turn', `t${Number(entry?.turn) || 0}`));
        // `-1` is `foldPlace`'s own value for "this write had no anchor", a hand edit, or a
        // migration. There is no message to jump to, and drawing no button says so better than a
        // button that does nothing.
        if (Number.isFinite(entry?.mid) && entry.mid >= 0) {
            meta.appendChild(button('sanguine_assets_jump', t`jump`,
                t`Jump to the message that changed this`, () => jumpToMessage(entry.mid)));
        }
        row.appendChild(meta);
        list.appendChild(row);
    }

    block.appendChild(list);
    return block;
}

/**
 * The field spec a place is edited through.
 *
 * `edit-form.js` takes a spec rather than a bespoke dialog per table, so a column added to
 * `foldPlace` becomes one line here. `name` is deliberately absent: the table key is built from the
 * name the record was created with, so renaming through `patch` would leave a record whose display
 * name and key disagree. `aka` is the supported way to give somewhere another name, and it is what
 * `resolvePlace` follows.
 */
const PLACE_FIELDS = Object.freeze([
    { key: 'aka', label: 'Also called', hint: 'Comma-separated. The other names this place answers to, "home", "the old house".' },
    { key: 'facts', label: 'Standing', kind: 'area', hint: 'What is permanently true of it. Two storeys, north-facing, always cold.' },
    { key: 'detail', label: 'Now', kind: 'area', hint: 'What is true of it at the moment. The east wing is rubble.' },
    { key: 'place', label: 'Inside', hint: 'The place this one is in, by name. A room is a place whose parent is the house. Empty to take it out of anything.' },
    { key: 'status', label: 'Status', hint: 'Empty while it stands. "destroyed" or "ruined" retires it without deleting it, rows still point at it.' },
    { key: 'source', label: 'Came from' },
]);

/** The same spec for a record that does not exist yet, where the name is the one thing needed. */
const NEW_PLACE_FIELDS = Object.freeze([
    { key: 'name', label: 'Name', hint: 'What the story calls it.' },
    ...PLACE_FIELDS.filter(field => field.key !== 'source'),
]);

/**
 * Edit a record through the shared form.
 *
 * `place` is routed through `setParent` rather than `patch`, because `patch` refuses it on purpose:
 * an empty string is silence to the merge, so releasing a room from its house has to be a
 * whole-record write, and the cycle check is owed on the way in (`places.js:143-155`).
 *
 * @param {object} place The record.
 * @param {() => void} onWrite Redraw.
 */
async function editPlace(place, onWrite) {
    const changed = await editRow(`Place, ${place.name || place.key}`, PLACE_FIELDS, place);
    if (!changed) {
        return;
    }
    const { place: parent, ...columns } = changed;
    let wrote = false;
    if (Object.keys(columns).length) {
        wrote = places.patch(place.key, columns) || wrote;
    }
    if (parent !== undefined) {
        wrote = places.setParent(place.key, parent) || wrote;
    }
    if (wrote) {
        onWrite();
    }
}

/**
 * Write a new record by hand.
 *
 * Through `upsert`, which is `foldPlace` plus a commit: field-wise, so an empty column is silence
 * rather than an erasure, and cycle-checked, so a parent that would close a loop is dropped while
 * everything else the form said is still written.
 *
 * @param {(key: string) => void} onWrite Called with the new key, to redraw standing on it.
 */
async function createPlace(onWrite) {
    const changed = await editRow('New place', NEW_PLACE_FIELDS, {});
    if (!changed?.name) {
        return;
    }
    const outcome = places.upsert(changed);
    if (outcome.key) {
        onWrite(outcome.key);
    }
}

/**
 * @param {HTMLElement} row A treeitem.
 * @param {boolean} open Whether it should be open.
 */
function setExpanded(row, open) {
    if (!row.hasAttribute('aria-expanded')) {
        return;
    }
    row.setAttribute('aria-expanded', String(open));
    const group = row.querySelector(':scope > .sanguine_assets_group');
    if (group instanceof HTMLElement) {
        group.hidden = !open;
    }
    const twisty = row.querySelector(':scope > .sanguine_assets_node_line > .sanguine_assets_twisty');
    if (twisty) {
        twisty.textContent = open ? '▾' : '▸';
    }
}

/**
 * Every row the eye can currently see, in the order it sees them.
 *
 * Derived by walking rather than by querying layout, because a collapsed subtree has to be skipped
 * and a tab that is not the visible one has no layout to ask about.
 *
 * @param {HTMLElement} tree The tree.
 * @returns {HTMLElement[]} The visible treeitems, top to bottom.
 */
function visibleRows(tree) {
    const out = [];
    /** @param {Element} parent A tree or a group. */
    const walk = (parent) => {
        for (const row of parent.querySelectorAll(':scope > [role="treeitem"]')) {
            out.push(/** @type {HTMLElement} */ (row));
            const group = row.querySelector(':scope > .sanguine_assets_group');
            if (group instanceof HTMLElement && !group.hidden) {
                walk(group);
            }
        }
    };
    walk(tree);
    return out;
}

/**
 * Arrow-key movement through the tree.
 *
 * The APG model: up and down walk what is visible, right opens a closed row or steps into an open
 * one, left closes an open row or steps out to its parent, Home and End go to the ends, Enter and
 * Space select. Selection does NOT follow focus here, unlike the overlay's own rail, where every
 * tab is cheap to redraw, arrowing through a tree would rebuild the detail pane on every keystroke.
 *
 * @param {KeyboardEvent} event The keydown.
 * @param {HTMLElement} tree The tree.
 * @param {(key: string) => void} onPick Selection callback.
 */
function onTreeKey(event, tree, onPick) {
    const row = /** @type {HTMLElement} */ (event.target)?.closest?.('[role="treeitem"]');
    if (!(row instanceof HTMLElement) || !tree.contains(row)) {
        return;
    }
    const rows = visibleRows(tree);
    const at = rows.indexOf(row);
    const open = row.getAttribute('aria-expanded');

    /** @param {HTMLElement} [next] Where to go. */
    const go = (next) => {
        if (!next) return;
        for (const other of rows) {
            other.tabIndex = -1;
        }
        next.tabIndex = 0;
        next.focus();
    };

    switch (event.key) {
        case 'ArrowDown':
            go(rows[at + 1]);
            break;
        case 'ArrowUp':
            go(rows[at - 1]);
            break;
        case 'ArrowRight':
            if (open === 'false') {
                setExpanded(row, true);
            } else if (open === 'true') {
                go(visibleRows(tree)[at + 1]);
            }
            break;
        case 'ArrowLeft':
            if (open === 'true') {
                setExpanded(row, false);
            } else {
                go(/** @type {HTMLElement} */ (row.parentElement?.closest('[role="treeitem"]')));
            }
            break;
        case 'Home':
            go(rows[0]);
            break;
        case 'End':
            go(rows[rows.length - 1]);
            break;
        case 'Enter':
        case ' ':
            onPick(String(row.dataset.key ?? ''));
            break;
        default:
            return;
    }
    event.preventDefault();
}

/**
 * The place tree.
 *
 * `rootsOf` and `childrenOf` already did the hierarchy, `places.snapshot()` carries both, so this
 * only walks it. Nesting is `<ul role="group">` inside the parent's `<li>`, the APG structure, which
 * is also what draws the guide rule: one border per tier, from the markup rather than from a depth
 * arithmetic that would have to be kept in step with it.
 *
 * A record whose parent chain loops is unreachable from any root. `wouldCycle` refuses to create
 * one, but a hand edit or data written before that check could, so anything the walk never reached
 * is appended at the end with the reason said out loud rather than silently vanishing.
 *
 * @param {object} snapshot `places.snapshot()`.
 * @param {Map<string, object>} index Key -> place.
 * @param {Map<string, HTMLElement>} nodes Filled with key -> row.
 * @param {(key: string) => void} onPick Called with the key of a row the player chose.
 * @returns {HTMLElement} The tree.
 */
function buildTree(snapshot, index, nodes, onPick) {
    const tree = el('ul', 'sanguine_assets_tree');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', t`Places`);

    const seen = new Set();

    /**
     * @param {object} place A place.
     * @param {number} level ARIA level, 1-based.
     * @returns {HTMLElement} The row and its subtree.
     */
    function branch(place, level) {
        seen.add(place.key);
        const kids = (place.children ?? [])
            .map(key => index.get(key))
            .filter(child => child && !seen.has(child.key));

        const row = el('li', `sanguine_assets_node${isRetired(place) ? ' sanguine_assets_dormant' : ''}`);
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(level));
        row.setAttribute('aria-selected', 'false');
        row.tabIndex = -1;
        row.dataset.key = place.key;

        const line = el('div', 'sanguine_assets_node_line');
        const twisty = el('span', 'sanguine_assets_twisty', kids.length ? '▾' : '');
        twisty.setAttribute('aria-hidden', 'true');
        line.appendChild(twisty);
        line.appendChild(el('span', 'sanguine_assets_node_name', place.name || place.key));
        if (kids.length) {
            line.appendChild(el('span', 'sanguine_assets_count', String(kids.length)));
        }
        if (isRetired(place)) {
            line.appendChild(el('span', 'sanguine_assets_chip', String(place.status)));
        }
        row.appendChild(line);

        if (kids.length) {
            row.setAttribute('aria-expanded', 'true');
            const group = el('ul', 'sanguine_assets_group');
            group.setAttribute('role', 'group');
            for (const child of kids) {
                group.appendChild(branch(child, level + 1));
            }
            row.appendChild(group);
        }

        // The twisty is the only click on a row that does not select. A disclosure and a selection
        // are different intents, and a row that did both at once would make one of them
        // inexpressible.
        line.addEventListener('click', (event) => {
            if (event.target === twisty && kids.length) {
                setExpanded(row, row.getAttribute('aria-expanded') !== 'true');
                return;
            }
            onPick(place.key);
            row.focus();
        });

        nodes.set(place.key, row);
        return row;
    }

    for (const root of snapshot.roots) {
        tree.appendChild(branch(root, 1));
    }

    const stranded = snapshot.places.filter(place => !seen.has(place.key));
    if (stranded.length) {
        const note = el('li', 'sanguine_assets_stranded');
        note.setAttribute('role', 'none');
        note.appendChild(el('span', 'sanguine_assets_stranded_flag',
            t`Inside each other, nothing contains these:`));
        tree.appendChild(note);
        // Re-checked inside the loop, not filtered once: the first row of a loop draws the rest of
        // it as its children, so the second entry in this list is usually already on screen. Drawing
        // it again would put one record in the tree twice, and the second copy would be the one
        // `nodes` remembers.
        for (const place of stranded) {
            if (!seen.has(place.key)) {
                tree.appendChild(branch(place, 1));
            }
        }
    }

    tree.addEventListener('keydown', event => onTreeKey(event, tree, onPick));
    return tree;
}

/**
 * What a place record is, for the chat that has none, which today is every chat.
 *
 * Two sentences. The first draft was four paragraphs explaining the record's whole data model to
 * somebody who had opened a tab, a lecture where a label was wanted. An empty state says what is
 * here and what to press; if the concept needs teaching, it needs teaching somewhere the reader
 * chose to be taught.
 *
 * @returns {HTMLElement} The explanation.
 */
function intro() {
    const box = el('div', 'sanguine_assets_intro');
    box.appendChild(el('p', 'sanguine_assets_intro_flag', t`No places recorded yet.`));
    box.appendChild(el('p', 'sanguine_assets_intro_body',
        t`Record a house, a ship, a district, then its rooms inside it. Extraction adds them as the story establishes them.`));
    return box;
}

/**
 * The banner for a key nothing answers to.
 *
 * The shell cannot tell a stale key from a live one and says so (`overlay.js:126`), so the tab has
 * to: show the tab, say the record is not here, and print the key it was handed. A tab that rendered
 * nothing would look broken rather than empty.
 *
 * @param {string} key The key as handed over.
 * @returns {HTMLElement} The banner.
 */
function missing(key) {
    const box = el('div', 'sanguine_assets_missing');
    box.appendChild(el('p', 'sanguine_assets_missing_flag', t`That record is not in this chat.`));
    box.appendChild(el('p', 'sanguine_assets_missing_how',
        t`It may have been archived, corrected away, or written by a different chat. What is below is current.`));
    box.appendChild(el('pre', 'sanguine_assets_key', showKey(key)));
    return box;
}

/**
 * The holdings pane: standing property with no place of its own.
 *
 * This is what the tab shows on every chat that has not established a place, which is every chat,
 * so it is written to stand alone rather than as the fallback half of a two-pane view.
 *
 * @param {HTMLElement} into The detail pane.
 * @param {object[]} holdings Inventory rows at `ASSETS`.
 * @param {Map<string, object[]>} running Item key -> flows.
 * @param {Map<string, object>} table The flow table.
 * @returns {Map<string, HTMLElement>} Item key -> its row, so a focus key can be revealed.
 */
function holdingsPane(into, holdings, running, table) {
    const found = new Map();

    into.appendChild(el('h2', 'sanguine_assets_title', t`Holdings`));
    into.appendChild(el('p', 'sanguine_assets_lede',
        t`Property the ledger holds with no place of its own, a house, a mount, a shop. Exempt from staleness, because owning something is not a sighting.`));

    const block = el('section', 'sanguine_assets_block');
    const head = el('div', 'sanguine_assets_block_head');
    head.appendChild(el('h4', 'sanguine_assets_head', t`Owned`));
    head.appendChild(el('span', 'sanguine_assets_count', String(holdings.length)));
    block.appendChild(head);

    if (!holdings.length) {
        block.appendChild(el('p', 'sanguine_assets_none',
            t`Nothing is recorded as standing property. Extraction files an item here when the story says it is owned rather than carried.`));
    } else {
        const list = el('ul', 'sanguine_assets_list');
        // Freshest first: `since` counts events since a row was last touched, the same ordering the
        // sidebar's own sections use.
        for (const item of [...holdings].sort((a, b) => (a.since ?? 0) - (b.since ?? 0))) {
            const row = holdingRow(item, running, table);
            found.set(item.key, row);
            list.appendChild(row);
        }
        block.appendChild(list);
    }
    into.appendChild(block);
    return found;
}

/**
 * One place record, whole.
 *
 * @param {HTMLElement} into The detail pane.
 * @param {object} place The record, from `places.snapshot()`.
 * @param {Map<string, object>} index Key -> place.
 * @param {object[]} items Inventory rows whose place resolves here.
 * @param {Map<string, object[]>} running Item key -> flows.
 * @param {Map<string, object>} table The flow table.
 * @param {(key: string) => void} onPick Select another record.
 * @param {() => void} onWrite Called after a hand edit, to redraw.
 * @returns {Map<string, HTMLElement>} Item key -> its row.
 */
function placePane(into, place, index, items, running, table, onPick, onWrite) {
    const found = new Map();
    if (!place) {
        return found;
    }

    into.appendChild(el('h2', `sanguine_assets_title${isRetired(place) ? ' sanguine_assets_dormant' : ''}`,
        place.name || place.key));

    // The chain up, innermost first, from the same walk `snapshot()` counts depth with. Resolved
    // against the live table rather than re-derived from the child lists, so one definition of "what
    // is this inside" serves the tree, the depth and this line.
    const chain = ancestorsOf(places.load(), place.key);
    if (chain.length) {
        const crumb = el('div', 'sanguine_assets_crumb');
        crumb.appendChild(el('span', 'sanguine_assets_crumb_in', t`in`));
        for (const step of chain) {
            crumb.appendChild(button('sanguine_assets_crumb_step', step.row?.name || step.key,
                t`Open this place`, () => onPick(step.key)));
        }
        into.appendChild(crumb);
    } else if (place.place) {
        // A parent named but not recorded. Fail-open: the string is the string it was written as,
        // and saying so is the whole compatibility story rather than an error.
        into.appendChild(el('div', 'sanguine_assets_crumb_plain', t`in ${place.place}, no record`));
    }

    // `renderPlace`'s own line: what it permanently is, what it currently is, and what is in it. The
    // same string a later injection would hand the narrator, so what the player reads and what the
    // model would be told never drift into two descriptions.
    if (place.line) {
        into.appendChild(el('p', 'sanguine_assets_lede', place.line));
    }

    const facts = el('dl', 'sanguine_assets_facts');
    /**
     * @param {string} label The row's label.
     * @param {string} value Its value.
     * @param {string} [cls] Extra classes for the value.
     */
    const fact = (label, value, cls = '') => {
        if (!value) return;
        facts.appendChild(el('dt', 'sanguine_assets_flabel', label));
        facts.appendChild(el('dd', `sanguine_assets_fvalue ${cls}`.trim(), value));
    };
    // Standing truths never age, so they sit at the standing stop; what is true NOW is a claim about
    // this scene and sits a stop brighter.
    fact(t`standing`, place.facts, 'sanguine_assets_standing');
    fact(t`now`, place.detail, 'sanguine_assets_current');
    fact(t`also called`, place.aka, 'sanguine_assets_standing');
    fact(t`status`, place.status, 'sanguine_assets_standing');
    fact(t`came from`, place.source, 'sanguine_assets_standing');
    if (Number(place.driveSize) > 0) {
        facts.appendChild(el('dt', 'sanguine_assets_flabel', t`changing`));
        const dd = el('dd', 'sanguine_assets_fvalue');
        dd.appendChild(el('span', 'sanguine_assets_drive',
            `${Number(place.drive) || 0}/${Number(place.driveSize)}`));
        dd.appendChild(el('span', 'sanguine_assets_drive_note',
            t`a standing change that advances while the camera is away`));
        facts.appendChild(dd);
    }
    facts.appendChild(el('dt', 'sanguine_assets_flabel', t`last touched`));
    facts.appendChild(el('dd', 'sanguine_assets_fvalue sanguine_assets_meta',
        place.stale ? t`${place.stale} turns ago` : t`this turn`));
    into.appendChild(facts);

    const actions = el('div', 'sanguine_assets_actions');
    actions.appendChild(button('sanguine_assets_action', t`edit`, t`Correct this record by hand`,
        () => editPlace(place, onWrite)));

    // Destroy, which is a status and never a delete.
    //
    // The rooms go with it, the records all stay, and everything stored inside becomes unreachable
    // rather than vanishing. Rebuilding is the same button the other way round and does NOT cascade:
    // putting the shell back says nothing about the cellar under it (`cascadeRetirement`).
    if (isRetired(place)) {
        actions.appendChild(button('sanguine_assets_action', t`rebuild`,
            t`Clear the status. The rooms inside stay as they are, rebuild each one that came back.`,
            () => {
                if (places.patch(place.key, { status: '' })) {
                    onWrite();
                }
            }));
    } else {
        actions.appendChild(button('sanguine_assets_action', t`destroy`,
            t`Record that this no longer stands. Everything inside it goes with it; nothing is deleted.`,
            () => {
                const kids = (place.children ?? []).length;
                const asked = kids
                    ? `Record "${place.name}" as destroyed? The ${kids} place(s) inside it go with it. Nothing is deleted.`
                    : `Record "${place.name}" as destroyed? Nothing is deleted.`;
                if (window.confirm(asked) && places.destroy(place.key).length) {
                    onWrite();
                }
            }));
    }

    actions.appendChild(button('sanguine_assets_action sanguine_assets_danger', t`forget`,
        t`Delete this record. Whatever is inside it goes back to being a plain name.`,
        () => {
            if (window.confirm(`Forget the record for "${place.name}"? Whatever is inside it becomes a plain name again.`)) {
                places.remove(place.key);
                onWrite();
            }
        }));
    into.appendChild(actions);

    // Inside: the live children, then whatever is stored there.
    //
    // Retired children are left out, exactly as `renderPlace` leaves them out: a burned barn is not
    // something the farmhouse contains. The tree still shows them, because the record still exists.
    const inhabited = (place.children ?? []).map(key => index.get(key)).filter(Boolean);
    const kids = inhabited.filter(child => !isRetired(child));
    const ruined = inhabited.filter(child => isRetired(child));
    const inside = el('section', 'sanguine_assets_block');
    const insideHead = el('div', 'sanguine_assets_block_head');
    insideHead.appendChild(el('h4', 'sanguine_assets_head', t`Contains`));
    insideHead.appendChild(el('span', 'sanguine_assets_count', String(kids.length)));
    inside.appendChild(insideHead);
    if (kids.length) {
        const list = el('ul', 'sanguine_assets_kids');
        for (const child of kids) {
            const row = el('li');
            row.appendChild(button('sanguine_assets_child', child.name || child.key,
                t`Open this place`, () => onPick(child.key)));
            if (child.detail) {
                row.appendChild(el('span', 'sanguine_assets_child_note', child.detail));
            }
            list.appendChild(row);
        }
        inside.appendChild(list);
    } else if (!ruined.length) {
        inside.appendChild(el('p', 'sanguine_assets_none',
            t`Nothing is recorded inside this. A place goes inside another by naming it as its parent.`));
    }
    // Rooms the story is finished with. Kept out of `renderPlace`'s "contains", a burned barn is
    // not something the farmhouse contains, and shown here anyway, because the record still exists
    // and "nothing inside" would be a lie about a house that had four rooms this morning.
    if (ruined.length) {
        const gone = el('ul', 'sanguine_assets_kids sanguine_assets_dormant');
        for (const child of ruined) {
            const row = el('li');
            row.appendChild(button('sanguine_assets_child', child.name || child.key,
                t`Open this place`, () => onPick(child.key)));
            row.appendChild(el('span', 'sanguine_assets_chip', String(child.status)));
            gone.appendChild(row);
        }
        inside.appendChild(gone);
    }
    into.appendChild(inside);

    const stored = el('section', 'sanguine_assets_block');
    const storedHead = el('div', 'sanguine_assets_block_head');
    storedHead.appendChild(el('h4', 'sanguine_assets_head', t`Here`));
    storedHead.appendChild(el('span', 'sanguine_assets_count', String(items.length)));
    // Unreachable, not gone. The rows below still hold what they hold; what changed is that nobody
    // can get at them. Said once, at the heading, rather than on every row.
    const shut = isRetired(place) ? String(place.status) : place.sealed ? t`inside ${place.sealed}` : '';
    if (shut && items.length) {
        storedHead.appendChild(el('span', 'sanguine_assets_shut', t`unreachable, ${shut}`));
    }
    stored.appendChild(storedHead);
    if (items.length) {
        const list = el('ul', 'sanguine_assets_list');
        for (const item of [...items].sort((a, b) => (a.since ?? 0) - (b.since ?? 0))) {
            const row = holdingRow(item, running, table);
            found.set(item.key, row);
            list.appendChild(row);
        }
        stored.appendChild(list);
    } else {
        stored.appendChild(el('p', 'sanguine_assets_none',
            t`No item's place resolves to this record. An item is left somewhere by name, and that name has to reach this record, as it is written, or through one of the record's other names, before it is listed here.`));
    }
    into.appendChild(stored);

    const trail = trailBlock(place.trail);
    if (trail) {
        into.appendChild(trail);
    }

    return found;
}

/**
 * The tab.
 *
 * Synchronous throughout: every table it reads is chat metadata already in memory, so there is no
 * await for `ctx.signal` to guard. It is checked at the top of each draw anyway, because the hand
 * edits reach here through a promise and a redraw can therefore arrive after the player has moved
 * on.
 *
 * @param {HTMLElement} body The tab panel, emptied.
 * @param {object} ctx The tab context.
 */
function render(body, ctx) {
    /**
     * Draw everything.
     *
     * A full redraw rather than `ctx.refresh()` after a write, and the difference matters: `refresh`
     * re-runs with the ORIGINAL focus key, so editing a record you navigated to by hand would throw
     * the selection back to wherever the overlay was opened on. This keeps the selection the player
     * actually has.
     *
     * @param {string} want Which record to stand on.
     * @param {string} item An item key to reveal once there, or ''.
     * @param {boolean} announce Whether to `reveal` the landing, true only for the navigation that
     *   brought the player here, never for a redraw they caused themselves.
     */
    function draw(want, item, announce) {
        if (ctx.signal?.aborted) {
            return;
        }
        body.replaceChildren();

        const tree = places.snapshot();
        const index = new Map(tree.places.map(place => [place.key, place]));
        const inventory = state.snapshot().inventory;

        // The flows, indexed by what they are aimed at. `flows.list` carries each row's ruler and
        // period, which is what `emptyIn` needs and what the bare table does not have. The target is
        // rebuilt with `itemKey` from the row's own three columns, the same call `accrue` and
        // `netRate` make (`flow-table.js:246, 416`), because a second way of spelling that key is a
        // second chance to disagree about it.
        const table = flows.load();
        const running = new Map();
        for (const flow of flows.list(state.loadClock())) {
            const target = itemKey(flow.item, flow.at, flow.who);
            running.set(target, [...(running.get(target) ?? []), flow]);
        }

        // Where each item actually is, resolved once per distinct place string. A row that resolves
        // to nothing is not an error and not "nowhere": it is somewhere fold has no record of, which
        // is the state of every row in every existing chat.
        const resolved = new Map();
        const contained = new Map();
        const holdings = [];
        for (const row of inventory) {
            if (row.place === ASSETS) {
                holdings.push(row);
                continue;
            }
            if (row.place === CARRIED || CATEGORIES.has(row.place)) {
                continue;
            }
            if (!resolved.has(row.place)) {
                resolved.set(row.place, places.resolve(row.place)?.key ?? '');
            }
            const at = resolved.get(row.place);
            if (at) {
                contained.set(at, [...(contained.get(at) ?? []), row]);
            }
        }

        const wrap = el('div', 'sanguine_assets');
        const detail = el('div', 'sanguine_assets_detail');

        // Selection: what was asked for if it still exists, the holdings otherwise. The holdings
        // pane is the honest default, it is the only one of the two that any chat has data for.
        let selected = want === HOLDINGS || index.has(want) ? want : HOLDINGS;

        /** @type {Map<string, HTMLElement>} Selection value -> its tree row, for aria and reveal. */
        const nodes = new Map();
        /** @type {HTMLElement|null} The holdings row, which is a button and keeps its own tab stop. */
        let shelfRow = null;
        /** @type {HTMLElement|null} The tree, when there is one. */
        let treeEl = null;

        /**
         * Show one record in the right-hand pane.
         * @param {string} key The selection value.
         * @param {string} focusItem An item key to reveal inside it, or ''.
         * @param {boolean} shout Whether to reveal the landing rather than only draw it.
         */
        function show(key, focusItem, shout) {
            selected = key;
            for (const [id, node] of nodes) {
                const on = id === key;
                node.setAttribute('aria-selected', String(on));
                node.classList.toggle('sanguine_assets_on', on);
                // Roving tabindex across the TREE only. The holdings row is a button and must keep
                // its own tab stop, or the pane every chat actually has data for becomes reachable
                // by pointer alone.
                node.tabIndex = on ? 0 : -1;
            }
            if (shelfRow) {
                const on = key === HOLDINGS;
                shelfRow.setAttribute('aria-pressed', String(on));
                shelfRow.classList.toggle('sanguine_assets_on', on);
            }
            // With nothing in the tree selected, the tree still needs exactly one row in the tab
            // order or it cannot be entered from the keyboard at all, and it has to be the FIRST
            // ROW ON SCREEN. `nodes` is filled depth-first as each branch returns, so its first
            // entry is the deepest leaf of the first root, and entering a tree at a grandchild is
            // the kind of thing only the person who wrote the loop would expect.
            if (!nodes.has(key)) {
                const first = treeEl?.querySelector('[role="treeitem"]');
                if (first instanceof HTMLElement) first.tabIndex = 0;
            }

            detail.replaceChildren();
            const landed = key === HOLDINGS
                ? holdingsPane(detail, holdings, running, table)
                : placePane(detail, index.get(key), index, contained.get(key) ?? [], running, table,
                    next => show(next, '', false), () => draw(key, '', false));

            // The landing is what knows whether the key named a row. Only a NAVIGATION carries one,
            // every selection the player makes afterwards passes '', so the banner belongs to the
            // key they did not type and disappears the moment they go anywhere themselves.
            if (focusItem && !landed.has(focusItem)) {
                detail.prepend(missing(focusItem));
            }

            if (!shout) {
                return;
            }
            const target = (focusItem && landed.get(focusItem)) || nodes.get(key) || shelfRow;
            if (target) {
                ctx.reveal(target);
            }
        }

        // Left: the tree, or the explanation of what a tree here would be.
        const side = el('div', 'sanguine_assets_side');

        const sideHead = el('div', 'sanguine_assets_side_head');
        sideHead.appendChild(el('h3', 'sanguine_assets_head', t`Places`));
        sideHead.appendChild(el('span', 'sanguine_assets_count', String(tree.places.length)));
        sideHead.appendChild(button('sanguine_assets_action', t`record one`,
            t`Write a place record by hand`, () => createPlace(key => draw(key, '', false))));
        side.appendChild(sideHead);

        if (tree.places.length) {
            treeEl = buildTree(tree, index, nodes, key => show(key, '', false));
            side.appendChild(treeEl);
        } else {
            side.appendChild(intro());
        }

        // The holdings are reachable tree or no tree, so they are a row of their own beneath it
        // rather than a pane you can only arrive at by accident.
        shelfRow = button('sanguine_assets_shelf', '', t`Standing property with no place record`,
            () => show(HOLDINGS, '', false));
        shelfRow.setAttribute('aria-pressed', 'false');
        shelfRow.appendChild(el('span', 'sanguine_assets_shelf_name', t`Holdings`));
        shelfRow.appendChild(el('span', 'sanguine_assets_count', String(holdings.length)));
        side.appendChild(shelfRow);

        wrap.appendChild(side);
        wrap.appendChild(detail);
        body.appendChild(wrap);

        show(selected, item, announce);
    }

    const first = locate(ctx.focus, new Map(places.snapshot().places.map(place => [place.key, place])));
    draw(first.selected, first.item, !!ctx.focus);
}

registerTab('assets', render);
