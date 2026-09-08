/**
 * sanguine/overlay-cast.js: the cast tab: an index of everyone the story has named, and the full
 * record of whichever one you are standing on.
 *
 * What this is for.
 *
 * The panel's cast row is 288px of summary: a name, five pips, a predicate, and, if the row is
 * lucky: one line of what they want. That is the correct thing to show at a glance and it drops
 * nine columns to do it. `overlay.js`'s opening docblock states the bargain: a summary is honest
 * only because the full record is one click away. This file is the full record.
 *
 * Three things it surfaces that were STORED and never drawn anywhere:
 *
 *   · `trail`: every change to `feels`/`wants`/`knows` this row has survived, capped at twelve by
 *     `MAX_TRAIL`, each entry stamped with the anchor mid of the pass that saw it. `MAX_TRAIL`'s own
 *     docblock says what it was built for: "§8's Relationships tab can render *friendly, doubled
 *     your cut from her own share* with a click through to the message that caused it". It has been
 *     accumulating in the metadata blob of every live chat since, read by nothing.
 *   · `aka`: the names somebody answers to. Accumulated by `merge_entity` as the one Set-face
 *     field on the record, and the reason a second sighting of "Kang" lands on Kang Min-seo's row
 *     rather than opening a duplicate. Invisible, so the player could not tell a merged record from
 *     a lucky one.
 *   · `drive`/`driveSize`: a standing agenda's POSITION, which the world-turn advances between
 *     scenes. A number that moves while the camera is elsewhere is exactly the number a player
 *     wants to be able to look at.
 *
 * Person of interest.
 *
 * The toggle in the header band writes `state.setPoi`, and what the flag BUYS is mostly elsewhere:
 * the extractor is told to describe a flagged character in full (`entities.context`), the fold lets
 * their row hold the long form (`entity-table.js` `MAX_DOSSIER`), and `renderEntities` carries it
 * into the prompt while they are in the scene. The flag is therefore a claim about what the narrator
 * should be told, made on the surface where you have just finished reading why.
 *
 * What that means for THIS tab is that a flagged record is visibly richer than an unflagged one, and
 * it has to be legible that the difference was bought rather than lucky. `manner` and `background`
 * are marked as the flag's purchase; `appearance` and `wearing` are not, because every record has
 * them.
 *
 * What it does not do.
 *
 * No editing. `panel.js` already owns the edit and delete affordances for a cast row (`edits.js`,
 * `edit-form.js`), and a second set of writers over the same table on a second surface is two
 * places to fix the next bug in. The one write this tab owns is the trail's per-line undo, which
 * is not an edit, it is reverting a change that already landed, and it belongs beside the change
 * that produced it.
 */

import { t } from '../../i18n.js';
import { registerTab } from './overlay.js';
import * as edits from './edits.js';
import * as entities from './entities.js';
import * as state from './state.js';
import {
    DISPOSITIONS,
    ELSEWHERE,
    FACTION,
    GONE,
    HERE,
    dispositionRank,
    presenceOf,
    splitEntityKey,
} from './entity-table.js';
import { jumpToMessage } from './diagnostics-view.js';
import * as lore from './lore.js';

/** Id of the injected stylesheet link, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-cast-css';

/**
 * How many change-history entries are open before the disclosure.
 *
 * The trail holds at most twelve (`MAX_TRAIL`), and the newest few are the ones that explain the
 * state the header band is showing. The rest are the beginning of a story whose ending you are
 * already reading, so they are one keystroke away rather than in the way.
 */
const HISTORY_OPEN = 4;

/**
 * Put `overlay-cast.css` in the document head, once.
 *
 * Same pattern and same reasoning as `overlay.js` `ensureStylesheet`: `addExtensionStyle`
 * (extensions.js:781) reads one filename from the manifest and `style.css` already holds it, so
 * every sheet after the first is injected from the module that owns it. The URL comes from
 * `import.meta.url` so it resolves wherever the extension is installed.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-cast.css', import.meta.url).href;
    document.head.appendChild(link);
}

// At import time, not at first render: a sheet that starts loading when the tab is already on
// screen paints the dossier unstyled for a frame or two.
ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [cls] Class list.
 * @param {string} [text] Text content. Always set as text, every prose field on a cast row was
 *   written by a model, and `innerHTML` on model output is how a tracker becomes an injection.
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
 * A labelled block of prose, or nothing when there is no prose.
 *
 * The label is a micro-scale uppercase tracked heading, the ONLY thing `--s-micro` is for, and
 * the value is body-face prose at `--s-sub`, because a model wrote it. That contrast is the panel's
 * central doctrine carried onto the reading surface: you can tell at a glance who produced a value.
 *
 * @param {string} label The heading.
 * @param {string} value The prose.
 * @param {string} [cls] An extra class for the value.
 * @returns {HTMLElement|null} The block, or null when `value` is empty.
 */
function prose(label, value, cls = '') {
    const said = String(value ?? '').trim();
    if (!said) {
        return null;
    }
    const wrap = el('div', 'sanguine_cast_field');
    wrap.appendChild(el('h4', 'sanguine_cast_label', label));
    wrap.appendChild(el('p', `sanguine_cast_prose ${cls}`.trim(), said));
    return wrap;
}

/**
 * The disposition meter, enlarged, with the word beside it.
 *
 * The panel draws five pips and hides the word in a `title`, because at 288px the shape is all
 * there is room for. Here there is room for both, and both are wanted: the shape carries the
 * ordinal faster than the word does, and the word is the only part that survives for a reader who
 * cannot distinguish the fill. Colour is the semantic axis (`--fold-crit` through `--fold-fresh`,
 * bound in `style.css` `.sanguine_feels_*`), so it means state and not decoration.
 *
 * @param {string} feels A `DISPOSITIONS` member.
 * @returns {HTMLElement} The meter.
 */
function dispositionMeter(feels) {
    const rank = dispositionRank(feels);
    const wrap = el('div', 'sanguine_cast_disposition');
    const meter = el('span', `sanguine_feels sanguine_cast_pips sanguine_feels_${feels}`);
    // The pips are decorative here in the strict sense: the word right beside them says the same
    // thing, and announcing five list items to a screen reader would be five pieces of noise.
    meter.setAttribute('aria-hidden', 'true');
    for (let pip = 0; pip < DISPOSITIONS.length; pip++) {
        meter.appendChild(el('i', `sanguine_pip${pip <= rank ? ' on' : ''}`));
    }
    wrap.appendChild(meter);
    wrap.appendChild(el('span', 'sanguine_cast_disposition_word', sentenceCase(feels)));
    wrap.appendChild(el('span', 'sanguine_cast_disposition_of', t`toward you`));
    return wrap;
}

/**
 * Where this person stands relative to the scene, as a chip.
 *
 * ELSEWHERE names the place, because "elsewhere" alone is the answer that made the panel useless
 * for anyone trying to find somebody. UNPLACED says the hedge in words, `presenceOf` returns a
 * third value precisely so nobody has to guess, and a chip that rendered it as "away" would spend
 * the honesty one function later (see `castAt`).
 *
 * @param {object} person A cast row with `presence`.
 * @returns {HTMLElement} The chip.
 */
function presenceChip(person) {
    const place = String(person.place ?? '').trim();
    switch (person.presence) {
        case HERE:
            return el('span', 'sanguine_cast_chip sanguine_cast_here',
                place ? `${t`here`} · ${place}` : t`here`);
        case ELSEWHERE:
            return el('span', 'sanguine_cast_chip sanguine_cast_away',
                place ? `${t`elsewhere`} · ${place}` : t`elsewhere`);
        case GONE:
            return el('span', 'sanguine_cast_chip sanguine_cast_gone',
                person.status ? `${t`gone`} · ${person.status}` : t`gone`);
        default:
            return el('span', 'sanguine_cast_chip sanguine_cast_hedge', t`whereabouts unstated`);
    }
}

/**
 * The standing agenda, as a track with its position.
 *
 * Drawn as a progress track and NOT as a clock face, for `panel.js` `dialRow`'s reason: polarity is
 * not decoration, and a filling track is not a countdown. An agenda advancing is simply what the
 * faction is doing while you are not watching.
 *
 * @param {object} person A cast row.
 * @returns {HTMLElement|null} The block, or null when there is no agenda.
 */
function driveBlock(person) {
    const size = Number(person.driveSize) || 0;
    if (size <= 0) {
        return null;
    }
    const filled = Math.max(0, Math.min(size, Number(person.drive) || 0));
    const wrap = el('div', 'sanguine_cast_field');
    wrap.appendChild(el('h4', 'sanguine_cast_label', t`agenda`));
    const row = el('div', 'sanguine_cast_drive');
    const track = el('span', 'sanguine_cast_drive_track');
    track.setAttribute('role', 'img');
    track.setAttribute('aria-label', `${filled} of ${size}`);
    for (let seg = 0; seg < size; seg++) {
        track.appendChild(el('i', `sanguine_cast_drive_seg${seg < filled ? ' on' : ''}`));
    }
    row.appendChild(track);
    row.appendChild(el('span', 'sanguine_cast_num', `${filled}/${size}`));
    wrap.appendChild(row);
    return wrap;
}

/**
 * A strip of chips, marks or belongings.
 *
 * @param {string} label The heading.
 * @param {Array<HTMLElement>} chips The chips.
 * @returns {HTMLElement|null} The block, or null when there are none.
 */
function strip(label, chips) {
    if (!chips.length) {
        return null;
    }
    const wrap = el('div', 'sanguine_cast_field');
    wrap.appendChild(el('h4', 'sanguine_cast_label', label));
    const row = el('div', 'sanguine_cast_strip');
    for (const chip of chips) {
        row.appendChild(chip);
    }
    wrap.appendChild(row);
    return wrap;
}

/**
 * One change out of the trail.
 *
 * Why the row is a button.
 *
 * `mid` is the anchor of the extraction pass that saw the change, and `jumpToMessage` turns it into
 * a scroll, the same cause-link the diagnostics log and the inventory trail already use. The whole
 * row is the target rather than a small arrow beside it, because the row IS the claim and a
 * click-target the size of a footnote is a click-target nobody hits. A trail entry written by a hand
 * edit or a migration carries `mid: -1` (see `changesBetween`) and has nothing to jump to, so it
 * renders as a plain row rather than as a button that does nothing.
 *
 * @param {object} change A `trail[]` entry.
 * @returns {HTMLElement} The list item.
 */
function changeRow(change, key, onRefresh) {
    const item = el('li', 'sanguine_cast_change');
    const anchored = Number.isFinite(change?.mid) && change.mid >= 0;
    const inner = el(anchored ? 'button' : 'div', 'sanguine_cast_change_body');
    if (anchored) {
        /** @type {HTMLButtonElement} */ (inner).type = 'button';
        inner.title = t`Jump to the message that caused this`;
        inner.addEventListener('click', () => jumpToMessage(change.mid));
    }

    inner.appendChild(el('span', 'sanguine_cast_change_field', String(change?.field ?? '')));
    // The new value as prose, because a model wrote it; the superseded one beneath it, dimmed to
    // `--o-dormant`: the stop that means "over, moot, or left behind", which is exactly what a
    // replaced value is.
    inner.appendChild(el('span', 'sanguine_cast_change_to', String(change?.to ?? '')));
    const from = String(change?.from ?? '').trim();
    inner.appendChild(el('span', 'sanguine_cast_change_from',
        from ? `${t`was`} ${from}` : t`nothing recorded before`));
    // The turn is derived, so it is mono and tabular, the one thing on this row fold produced.
    inner.appendChild(el('span', 'sanguine_cast_num', `t${Number(change?.turn) || 0}`));

    item.appendChild(inner);

    // The per-line undo: write the superseded value back. A deliberate reversal, so it sits on the
    // change it reverses rather than in the edit menu, and it is recorded in the trail like any
    // other hand write, so undoing the undo is one more click.
    const undo = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_cast_change_undo', t`Undo`));
    undo.type = 'button';
    undo.title = t`Revert this change`;
    undo.addEventListener('click', (event) => {
        event.stopPropagation();
        if (edits.undoCastChange(key, change)) {
            onRefresh?.();
        }
    });
    item.appendChild(undo);
    return item;
}

/**
 * The change history, newest first, with the older half behind a disclosure.
 *
 * Newest first is not a preference. The header band above is showing the CURRENT disposition and
 * agenda; the entry that explains it is the last one written, and a list that opens on the oldest
 * entry asks the reader to scroll to find out why they are reading it.
 *
 * @param {Array<object>} trail The row's trail, oldest first as stored.
 * @returns {HTMLElement} The section.
 */
function historySection(trail, key, onRefresh) {
    const wrap = el('section', 'sanguine_cast_field sanguine_cast_history');
    wrap.appendChild(el('h4', 'sanguine_cast_label', t`history`));

    const changes = [...trail].reverse();
    if (!changes.length) {
        // Said out loud rather than omitted: an empty history and an unbuilt history look the same,
        // and one of them is a bug. Nothing has changed since this row opened is a real answer.
        wrap.appendChild(el('p', 'sanguine_cast_empty', t`Nothing has changed since this record opened.`));
        return wrap;
    }

    const list = el('ul', 'sanguine_cast_changes');
    for (const change of changes.slice(0, HISTORY_OPEN)) {
        list.appendChild(changeRow(change, key, onRefresh));
    }
    wrap.appendChild(list);

    const rest = changes.slice(HISTORY_OPEN);
    if (!rest.length) {
        return wrap;
    }

    // A real <button> with `aria-expanded`, not a div that toggles a class: Space and Enter, the
    // focus ring and the "collapsed/expanded" announcement all come from the element.
    const more = el('ul', 'sanguine_cast_changes');
    more.hidden = true;
    for (const change of rest) {
        more.appendChild(changeRow(change, key, onRefresh));
    }
    const toggle = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_cast_more'));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = `${rest.length} ${rest.length === 1 ? t`earlier change` : t`earlier changes`}`;
    toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!open));
        more.hidden = open;
    });
    wrap.appendChild(toggle);
    wrap.appendChild(more);
    return wrap;
}

/**
 * The person-of-interest toggle.
 *
 * `aria-pressed` rather than a checkbox: this is a button whose effect is immediate and whose state
 * is a property of the thing it names, which is what the pressed state is for. The label says what
 * the flag BUYS, a fuller line in the prompt, because "person of interest" on its own reads as a
 * bookmark, and this is not a bookmark.
 *
 * @param {string} key The entity key.
 * @param {() => void} onChange Called after the write, so the index can restripe.
 * @returns {HTMLElement} The button.
 */
function poiToggle(key, onChange) {
    const on = state.isPoi(key);
    const button = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_cast_poi'));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(on));
    const star = el('i', 'fa-solid fa-star sanguine_cast_poi_icon');
    star.setAttribute('aria-hidden', 'true');
    button.appendChild(star);
    button.appendChild(el('span', '', t`Person of interest`));
    button.title = t`Tell the narrator more about this person. Extraction is asked to describe them in full, the record keeps the long form, and their line in the prompt carries it while they are in the scene.`;
    button.addEventListener('click', () => {
        const next = state.setPoi(key);
        button.setAttribute('aria-pressed', String(next));
        onChange();
    });
    return button;
}

/**
 * A button, with a label and no ceremony.
 * @param {string} cls Class list.
 * @param {string} label Visible text.
 * @param {() => void} onClick Handler.
 * @returns {HTMLButtonElement} The button.
 */
function action(cls, label, onClick) {
    const button = /** @type {HTMLButtonElement} */ (el('button', cls, label));
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
}

/**
 * The lorebook link, and the authored text it makes readable.
 *
 * Why this is the first thing in the record.
 *
 * Authored beats extracted. If the player wrote "Almond-brown eyes, straight brows, sharp
 * cheekbones, pale-gold skin" into a World Info entry, that is the true description of this
 * character and the four extracted fields under it are sanguine's best effort at re-deriving it. A
 * record that shows the derivation above the source is a record that reads as though the source were
 * a footnote.
 *
 * Read-only is stated, not implied.
 *
 * An entry sanguine authored can be rewritten from the record. An entry the player wrote never can,
 * and the reason the label says so is that the alternative is a player discovering the rule by
 * losing a card to it.
 *
 * The pane fills asynchronously and the tab does not wait for it.
 *
 * `lore.dossier` reads a world file. The record paints immediately with a one-line placeholder and
 * the pane replaces itself when the read lands, checked against the abort signal, a click that
 * arrives after the player has navigated on must not write into a dead panel.
 *
 * @param {object} person The cast row.
 * @param {object} options Options.
 * @param {AbortSignal} options.signal The tab's abort signal.
 * @param {() => void} options.onChange Called after any write, so the index restripes.
 * @returns {HTMLElement} The pane, already filling.
 */
function lorePane(person, { signal, onChange }) {
    const pane = el('section', 'sanguine_cast_lore');
    pane.appendChild(el('p', 'sanguine_cast_empty', t`Checking the lorebook…`));

    /** Repaint from storage. */
    const paint = async () => {
        let info;
        try {
            info = await lore.dossier(person.key);
        } catch {
            // `lore.dossier` does not throw; this is the belt for the braces. A pane that cannot
            // answer says nothing rather than blanking the record around it.
            info = null;
        }
        if (signal?.aborted) {
            return;
        }
        pane.replaceChildren();
        if (!info || info.state === 'none') {
            unlinkedView();
            return;
        }
        if (info.state === 'stale') {
            staleView(info);
            return;
        }
        linkedView(info);
    };

    /**
     * A row of controls under the pane.
     * @param {HTMLElement[]} buttons The controls.
     * @returns {HTMLElement} The row.
     */
    const controls = (buttons) => {
        const row = el('div', 'sanguine_cast_lore_controls');
        buttons.forEach(button => row.appendChild(button));
        return row;
    };

    /** Nobody has linked this person. */
    const unlinkedView = () => {
        const head = el('h3', 'sanguine_cast_lore_head');
        head.appendChild(el('span', '', t`Lorebook`));
        pane.appendChild(head);
        pane.appendChild(el('p', 'sanguine_cast_empty', t`Not linked. Link an entry to use its text as this person's canon.`));
        pane.appendChild(controls([
            action('sanguine_cast_lore_btn', t`Link an entry`, () => void pickerView()),
            action('sanguine_cast_lore_btn', t`Write a new entry`, () => void write()),
        ]));
    };

    /** The link points at a book or an entry that is gone. */
    const staleView = (info) => {
        const head = el('h3', 'sanguine_cast_lore_head');
        head.appendChild(el('span', '', t`Lorebook`));
        head.appendChild(el('span', 'sanguine_cast_lore_src sanguine_cast_lore_stale', t`stale`));
        pane.appendChild(head);
        pane.appendChild(el('p', 'sanguine_cast_note', info.book
            ? t`The linked entry is gone from "${info.book}". Nothing is injected and nothing is lost.`
            : t`The linked entry is gone. Nothing is injected and nothing is lost.`));
        pane.appendChild(controls([
            action('sanguine_cast_lore_btn', t`Link an entry`, () => void pickerView()),
            action('sanguine_cast_lore_btn', t`Unlink`, () => { lore.unlink(person.key); onChange(); void paint(); }),
        ]));
    };

    /** A live link, with the authored text. */
    const linkedView = (info) => {
        const head = el('h3', 'sanguine_cast_lore_head');
        head.appendChild(el('span', '', t`Canon`));
        const source = el('span', 'sanguine_cast_lore_src', info.comment
            ? `${info.book} · ${info.comment}`
            : info.book);
        source.title = t`Lorebook entry ${String(info.uid)} in ${info.book}.`;
        head.appendChild(source);
        head.appendChild(el('span', `sanguine_cast_lore_own${info.writable ? '' : ' sanguine_cast_lore_theirs'}`,
            info.writable ? t`written by sanguine` : t`yours, read-only`));
        pane.appendChild(head);

        // `textContent`, never `innerHTML`: this is user-authored prose out of a file, and the one
        // rule the overlay has no exceptions to.
        const text = el('div', 'sanguine_cast_lore_text');
        text.textContent = info.content || t`This entry is empty.`;
        pane.appendChild(text);

        const carry = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_cast_lore_btn sanguine_cast_lore_carry'));
        carry.type = 'button';
        carry.textContent = t`Carry while present`;
        carry.setAttribute('aria-pressed', String(info.present));
        carry.title = t`Send this text to the narrator whenever this person is in the scene, even if no keyword fires. Skipped when World Info already sent it.`;
        carry.addEventListener('click', () => {
            const next = lore.setPresent(person.key, undefined);
            carry.setAttribute('aria-pressed', String(next));
        });

        const buttons = [carry];
        if (info.writable) {
            buttons.push(action('sanguine_cast_lore_btn', t`Update from record`, () => void write()));
        }
        buttons.push(action('sanguine_cast_lore_btn', t`Unlink`, () => {
            lore.unlink(person.key);
            onChange();
            void paint();
        }));
        pane.appendChild(controls(buttons));
    };

    /** Choose an entry from the books this chat can see. */
    const pickerView = async () => {
        pane.replaceChildren();
        pane.appendChild(el('p', 'sanguine_cast_empty', t`Reading the lorebooks…`));
        let entries = [];
        try {
            entries = await lore.entryIndex();
        } catch {
            entries = [];
        }
        if (signal?.aborted) {
            return;
        }
        pane.replaceChildren();
        const head = el('h3', 'sanguine_cast_lore_head');
        head.appendChild(el('span', '', t`Link an entry`));
        pane.appendChild(head);
        if (!entries.length) {
            pane.appendChild(el('p', 'sanguine_cast_empty', t`No lorebook is attached to this chat.`));
            pane.appendChild(controls([
                action('sanguine_cast_lore_btn', t`Write a new entry`, () => void write()),
                action('sanguine_cast_lore_btn', t`Cancel`, () => void paint()),
            ]));
            return;
        }

        const select = /** @type {HTMLSelectElement} */ (el('select', 'sanguine_cast_lore_pick'));
        select.setAttribute('aria-label', t`Lorebook entry`);
        let book = '';
        let group = null;
        entries.forEach((entry, index) => {
            if (entry.book !== book) {
                book = entry.book;
                group = document.createElement('optgroup');
                group.label = book;
                select.appendChild(group);
            }
            const option = document.createElement('option');
            option.value = String(index);
            // The label is the entry's own comment; the suffix says who wrote it, because that is
            // the one fact that decides whether linking it makes it writable.
            option.textContent = entry.mine ? `${entry.label} (${t`sanguine`})` : entry.label;
            (group ?? select).appendChild(option);
        });
        // Pre-select the entry whose keys already name this person, the common case is that the
        // player wrote a card for exactly this character and is now pairing the two.
        const named = String(person.name ?? '').toLowerCase();
        const guess = entries.findIndex(entry => entry.keys.some(key => String(key).toLowerCase() === named)
            || entry.label.toLowerCase() === named);
        if (guess >= 0) {
            select.value = String(guess);
        }
        pane.appendChild(select);
        pane.appendChild(controls([
            action('sanguine_cast_lore_btn', t`Link`, () => {
                const chosen = entries[Number(select.value)];
                if (!chosen) {
                    return;
                }
                void lore.linkExisting(person.key, chosen.book, chosen.uid).then(() => {
                    onChange();
                    return paint();
                });
            }),
            action('sanguine_cast_lore_btn', t`Cancel`, () => void paint()),
        ]));
    };

    /** Write the record out to an entry, creating one, or updating sanguine's own. */
    const write = async () => {
        try {
            const done = await lore.writeOut(person.key, person);
            if (!done.ok && done.reason === 'read-only') {
                toastr.info(t`That entry is yours. Sanguine reads it and never overwrites it.`);
            } else if (!done.ok) {
                toastr.error(t`Could not write a lorebook entry.`);
            }
        } catch (error) {
            console.error('[sanguine] lorebook write failed', error);
            toastr.error(t`Could not write a lorebook entry.`);
        }
        if (!signal?.aborted) {
            onChange();
            await paint();
        }
    };

    void paint();
    return pane;
}

/**
 * The four description fields, in reading order, and which of them the flag pays for.
 *
 * `look` and `wearing` are on every record. `bearing` and `history` are stored only for a person of
 * interest (`entity-table.js` `MAX_DOSSIER`), so they are marked as the flag's purchase rather than
 * silently present, a reader who cannot tell which fields the flag bought cannot tell what the
 * toggle does.
 */
const DOSSIER_FIELDS = [
    { field: 'look', label: () => t`appearance`, poi: false },
    { field: 'wearing', label: () => t`wearing`, poi: false },
    { field: 'bearing', label: () => t`manner`, poi: true },
    // Labelled `background`, not `history`: the section at the foot of this card is already called
    // history and means the change trail. One word for two things on one screen is a word that
    // means neither.
    { field: 'history', label: () => t`background`, poi: true },
];

/**
 * The dossier: one person, everything on the record.
 *
 * Two columns, and which side a field lands on.
 *
 * Left is what is TRUE of them, the facts that do not tick, what is wrong with them, what they are
 * carrying, where the agenda stands. Right is what they are DOING and what has moved: wants, knows,
 * and the history of both. The split is the same one `hasEdge` makes when it decides whether a row
 * is a person or a description: a record with only a left column is scenery.
 *
 * The four description fields lead the left column, ahead of `facts`, because they are what the
 * player opened the record to read. That is also the order the panel could never offer: at 288px a
 * cast row shows a name and a predicate, and "almond-brown eyes, straight brows, sharp cheekbones"
 * is the sentence the summary had to drop.
 *
 * @param {object} person A cast row.
 * @param {object} extra Marks and belongings already grouped by key.
 * @param {Array<object>} extra.marks The marks on this person.
 * @param {Array<object>} extra.holds What they are carrying.
 * @param {number} extra.turn The current turn.
 * @param {() => void} extra.onFlag Called when the flag changes.
 * @param {AbortSignal} [extra.signal] The tab's abort signal, for the lorebook read.
 * @returns {HTMLElement} The dossier.
 */
function dossier(person, { marks, holds, turn, onFlag, signal = null, onRefresh = null }) {
    const card = el('section', 'sanguine_cast_dossier');
    card.setAttribute('aria-labelledby', 'sanguine_cast_name');

    const band = el('header', 'sanguine_cast_band');
    const heading = el('h2', 'sanguine_cast_name', person.name || t`unnamed`);
    heading.id = 'sanguine_cast_name';
    band.appendChild(heading);

    // Every other name this record answers to. Prose, because they are names a story wrote, and the
    // proof that a merge happened, "Kang Min-seo (also known as Kang)" is the row that stopped
    // being two rows (`mergeEntities`).
    if (String(person.aka ?? '').trim()) {
        band.appendChild(el('p', 'sanguine_cast_aka', `${t`also known as`} ${person.aka}`));
    }

    const chips = el('div', 'sanguine_cast_chips');
    if (splitEntityKey(person.key).kind === FACTION) {
        chips.appendChild(el('span', 'sanguine_cast_chip sanguine_cast_kind', t`faction`));
    }
    chips.appendChild(presenceChip(person));
    if ((Number(person.threat) || 0) > 0) {
        const threat = el('span', 'sanguine_cast_chip sanguine_cast_threat', `${t`threat`} ${person.threat}`);
        threat.title = t`Actively dangerous. The review clears this when the fight ends.`;
        chips.appendChild(threat);
    }
    band.appendChild(chips);

    if (person.feels) {
        band.appendChild(dispositionMeter(person.feels));
    }

    // One line under the description, restated when the flag changes. Not four paragraphs about
    // budgets: the player needs to know what the toggle buys and nothing else.
    const hint = el('p', 'sanguine_cast_empty');
    const restate = () => {
        const on = state.isPoi(person.key);
        hint.textContent = on
            ? (person.bearing || person.history
                ? ''
                : t`Flagged. Manner and background fill in the next time the story shows them.`)
            : t`Flag them to record manner and background, and to carry it all into the narrator's prompt.`;
        hint.hidden = !hint.textContent;
    };
    band.appendChild(poiToggle(person.key, () => {
        onFlag();
        restate();
    }));
    card.appendChild(band);

    // Full width, under the band and above the columns. Not inside the left column, although that is
    // where the description it supersedes lives: the record pane is ~380px and its left column ~215px
    // of that, which turns a paragraph of authored prose into a ribbon two words wide. The widest
    // thing on the tab gets the width, the same call `historySection` documents at the foot of the
    // card, and this block is longer than a trail entry.
    card.appendChild(lorePane(person, { signal, onChange: onFlag }));

    const body = el('div', 'sanguine_cast_columns');

    // Left: what is true of them.
    const left = el('div', 'sanguine_cast_col');
    const described = el('div', 'sanguine_cast_described');
    for (const { field, label, poi } of DOSSIER_FIELDS) {
        const block = prose(label(), person[field]);
        if (!block) {
            continue;
        }
        if (poi) {
            // The flag's purchase, said in the markup rather than only in a tooltip. `--fold-rel`
            // rather than the theme accent, because this is a fact about a relationship the player
            // declared, the same semantic axis the trail's field labels already use.
            block.classList.add('sanguine_cast_field_poi');
        }
        described.appendChild(block);
    }
    described.appendChild(hint);
    restate();
    left.appendChild(described);

    const standing = [
        prose(t`facts`, person.facts),
        prose(t`doing`, person.detail),
        prose(t`reach`, person.reach),
        // What they know that the PC does not. Blurred until revealed: the player owns the record
        // but the fiction says the character does not know it, and a record that reads the secret
        // at a glance is a record that spoils itself. The blur is purely this surface, the model
        // still reads the secret plainly in the injected block.
        prose(t`secret`, person.secret, 'sanguine_cast_secret'),
        strip(t`condition`, marks.map(mark => {
            const chip = el('span', `sanguine_mark sanguine_mark_${mark.severity || 'moderate'}`,
                sentenceCase(mark.phrase));
            chip.title = `${sentenceCase(mark.phrase)}, ${mark.severity || 'moderate'}`;
            return chip;
        })),
        strip(t`carrying`, holds.map(item => {
            const label = item.qty > 1 ? `${item.display ?? item.name} ×${item.qty}` : (item.display ?? item.name);
            const chip = el('span', 'sanguine_holds_item', label);
            chip.title = item.place ? `${label}, ${item.place}` : label;
            return chip;
        })),
        driveBlock(person),
    ].filter(Boolean);
    for (const block of standing) {
        left.appendChild(block);
    }

    // The record's own provenance, in the mono face because every value in it is one fold computed
    // or stored rather than one a narrator wrote. `first` and `turn` are the two ends of how long
    // the story has been coming back to this person, the arithmetic `hasEdge` uses to decide the
    // row is not furniture.
    const meta = el('dl', 'sanguine_cast_meta');
    const fact = (label, value) => {
        if (!value && value !== 0) return;
        meta.appendChild(el('dt', '', label));
        meta.appendChild(el('dd', 'sanguine_cast_num', String(value)));
    };
    fact(t`first seen`, `t${Number(person.first) || 0}`);
    fact(t`last seen`, person.stale === 0 ? `t${turn} (${t`this turn`})` : `t${Number(person.turn) || 0}`);
    if (person.status) {
        meta.appendChild(el('dt', '', t`status`));
        meta.appendChild(el('dd', 'sanguine_cast_prose', person.status));
    }
    if (person.source) {
        meta.appendChild(el('dt', '', t`heard from`));
        meta.appendChild(el('dd', 'sanguine_cast_prose', person.source));
    }
    left.appendChild(meta);
    body.appendChild(left);

    // Right: what they are doing, and what has moved.
    const right = el('div', 'sanguine_cast_col');
    const wants = prose(t`wants`, person.wants, 'sanguine_cast_motive');
    const knows = prose(t`knows`, person.knows, 'sanguine_cast_motive');
    if (wants) right.appendChild(wants);
    if (knows) right.appendChild(knows);
    if (!wants && !knows) {
        // The gap is the point. A row with no `wants` and no `knows` is one the extraction has never
        // characterised, and `hasEdge` gives exactly that row the short window before it ages out.
        right.appendChild(el('p', 'sanguine_cast_empty',
            t`Nothing recorded about what they want or what they know.`));
    }
    body.appendChild(right);
    card.appendChild(body);

    // Under both columns rather than inside one, and measured rather than assumed: the record pane
    // is ~380px wide at the dialog's `min(760px, 94vw)`, so a column of it is ~215px, and a trail
    // entry is two lines of prose plus what it replaced. The widest thing on the tab gets the width.
    card.appendChild(historySection(Array.isArray(person.trail) ? person.trail : [], person.key, onRefresh));
    return card;
}

/**
 * A cast row as it appears in the index.
 *
 * @param {object} person The row.
 * @param {(person: object) => void} onPick Called with the row when it is chosen.
 * @returns {HTMLButtonElement} The entry.
 */
function indexEntry(person, onPick) {
    const button = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_cast_entry'));
    button.type = 'button';
    button.setAttribute('aria-controls', 'sanguine_cast_record');
    button.appendChild(el('span', 'sanguine_cast_entry_name', person.name || t`unnamed`));

    const tail = el('span', 'sanguine_cast_entry_tail');
    // A linked row is marked in the index, because "which of these has authored canon" is a question
    // about the whole cast and answering it one record at a time is not answering it.
    if (lore.linkOf(person.key)) {
        const book = el('i', 'fa-solid fa-book sanguine_cast_entry_book');
        book.setAttribute('aria-hidden', 'true');
        tail.appendChild(book);
        tail.appendChild(el('span', 'sanguine_cast_sr', t`linked to a lorebook entry`));
    }
    if (state.isPoi(person.key)) {
        const star = el('i', 'fa-solid fa-star sanguine_cast_entry_star');
        star.setAttribute('aria-hidden', 'true');
        // The icon carries no text, so the state has to reach a screen reader some other way.
        tail.appendChild(star);
        tail.appendChild(el('span', 'sanguine_cast_sr', t`person of interest`));
    }
    if ((Number(person.threat) || 0) > 0) {
        tail.appendChild(el('span', 'sanguine_cast_entry_threat', `${t`threat`} ${person.threat}`));
    }
    if (person.feels) {
        const meter = el('span', `sanguine_feels sanguine_feels_${person.feels}`);
        meter.setAttribute('aria-hidden', 'true');
        const rank = dispositionRank(person.feels);
        for (let pip = 0; pip < DISPOSITIONS.length; pip++) {
            meter.appendChild(el('i', `sanguine_pip${pip <= rank ? ' on' : ''}`));
        }
        tail.appendChild(meter);
        tail.appendChild(el('span', 'sanguine_cast_sr', sentenceCase(person.feels)));
    }
    button.appendChild(tail);

    button.addEventListener('click', () => onPick(person));
    return button;
}

/**
 * The cast tab.
 *
 * @param {HTMLElement} body The tab panel, emptied.
 * @param {object} context The render context, see `overlay.js`.
 */
function renderCast(body, context) {
    // One `state.snapshot()` for the marks and the belongings, one `entities.snapshot()` for the
    // cast itself. Both are what the panel already runs on every message, so neither is a new cost.
    const snapshot = state.snapshot();
    const scene = new Map((snapshot.context ?? []).map(field => [field.label, field.value]));
    const at = scene.get('location') ?? '';
    const cast = entities.snapshot({ at, pov: scene.get('pov') ?? '' });

    // `owner` is a table key the state snapshot already resolved through the alias set, so this tab
    // never has to know that a name and a title can be the same person.
    const marksBy = new Map();
    for (const mark of snapshot.marks ?? []) {
        if (mark.mine || !mark.owner) continue;
        marksBy.set(mark.owner, [...(marksBy.get(mark.owner) ?? []), mark]);
    }
    const heldBy = new Map();
    for (const item of snapshot.inventory ?? []) {
        if (item.mine || !item.owner) continue;
        heldBy.set(item.owner, [...(heldBy.get(item.owner) ?? []), item]);
    }

    const groups = [
        { label: t`Here`, people: cast.people },
        { label: t`Whereabouts unstated`, people: cast.unplaced },
        { label: t`Elsewhere`, people: cast.elsewhere },
    ].filter(group => group.people.length);
    const everyone = groups.flatMap(group => group.people);

    // Resolving the focus key.
    //
    // Three outcomes, and they are three different things to render. A key in the visible cast is a
    // selection. A key the TABLE still holds but the cast lists do not, the point-of-view character
    // (`snapshot` removes him), or a row that has gone stale since the panel drew the link, is
    // still a record worth showing, so it is shown with a note rather than denied. Only a key
    // nothing holds is "not found", which the shell's focus contract requires be said out loud:
    // "the renderer should show the tab and say the record was not found, rather than showing
    // nothing."
    const wanted = String(context.focus ?? '');
    let selected = everyone.find(person => person.key === wanted) ?? null;
    let aside = false;
    if (wanted && !selected) {
        const row = entities.load().get(wanted);
        if (row) {
            selected = { ...row, key: wanted, stale: Math.max(0, cast.turn - (row.turn ?? 0)), presence: presenceOf(row, at) };
            aside = true;
        }
    }
    const missing = Boolean(wanted) && !selected;
    if (!selected && everyone.length) {
        selected = everyone[0];
    }

    const wrap = el('div', 'sanguine_cast');

    // The index.
    const nav = el('nav', 'sanguine_cast_index');
    nav.setAttribute('aria-label', t`Cast`);
    /** @type {Map<string, HTMLButtonElement>} */
    const entries = new Map();

    const record = el('div', 'sanguine_cast_record');
    record.id = 'sanguine_cast_record';

    /**
     * Show one person, and mark them current in the index.
     * @param {object} person The row.
     * @param {boolean} [reveal] Whether to move keyboard focus onto the record.
     */
    const show = (person, reveal = true) => {
        // `signal` is checked on every path that writes into `body`, because a click that lands
        // after the player has already navigated on would be writing into a dead panel.
        if (context.signal.aborted) {
            return;
        }
        for (const [key, button] of entries) {
            const on = key === person?.key;
            button.classList.toggle('sanguine_cast_entry_on', on);
            // `aria-current` rather than `aria-selected`: this is a list of links to records, not a
            // tablist, and `aria-selected` outside a composite widget announces nothing useful.
            if (on) {
                button.setAttribute('aria-current', 'true');
            } else {
                button.removeAttribute('aria-current');
            }
        }
        record.replaceChildren();
        if (!person) {
            record.appendChild(el('p', 'sanguine_cast_empty',
                t`Nobody to show. The cast fills itself as the story names people.`));
            return;
        }
        if (aside && person.key === selected?.key) {
            record.appendChild(el('p', 'sanguine_cast_note',
                t`This record is not in the current cast list, they are the point of view, or the story has not come back to them lately.`));
        }
        const card = dossier(person, {
            marks: marksBy.get(person.key) ?? [],
            holds: heldBy.get(person.key) ?? [],
            turn: cast.turn,
            signal: context.signal,
            // An undo rewrites the row, so the whole dossier redraws, and the index beside it is
            // untouched, nothing about it changes when a relationship field reverts.
            onRefresh: () => context.refresh(),
            // Restripes the index without rebuilding it: the flag shows there as a star, and a star
            // that only updates on the next open is a control that looks broken.
            onFlag: () => {
                const entry = entries.get(person.key);
                if (entry) {
                    entry.replaceWith(restripe(person));
                }
            },
        });
        record.appendChild(card);
        if (reveal) {
            context.reveal(card);
        }
    };

    /**
     * Rebuild one index entry in place, so a flag change shows immediately.
     * @param {object} person The row.
     * @returns {HTMLButtonElement} The replacement, already registered.
     */
    const restripe = (person) => {
        const button = indexEntry(person, picked => show(picked));
        const on = entries.get(person.key)?.classList.contains('sanguine_cast_entry_on');
        if (on) {
            button.classList.add('sanguine_cast_entry_on');
            button.setAttribute('aria-current', 'true');
        }
        entries.set(person.key, button);
        return button;
    };

    for (const group of groups) {
        const section = el('div', 'sanguine_cast_group');
        const head = el('h3', 'sanguine_cast_group_head');
        head.appendChild(el('span', '', group.label));
        head.appendChild(el('span', 'sanguine_cast_num', String(group.people.length)));
        section.appendChild(head);
        const list = el('ul', 'sanguine_cast_list');
        for (const person of group.people) {
            const item = el('li');
            const button = indexEntry(person, picked => show(picked));
            entries.set(person.key, button);
            item.appendChild(button);
            list.appendChild(item);
        }
        section.appendChild(list);
        nav.appendChild(section);
    }
    if (!everyone.length) {
        nav.appendChild(el('p', 'sanguine_cast_empty',
            t`Nobody on the cast yet. Extraction writes a row the first time the story names someone.`));
    }

    wrap.appendChild(nav);
    wrap.appendChild(record);
    body.appendChild(wrap);

    if (missing) {
        const note = el('div', 'sanguine_cast_missing');
        note.appendChild(el('p', 'sanguine_cast_note', t`That record is no longer on the cast.`));
        note.appendChild(el('p', 'sanguine_cast_empty',
            t`Rows age out and are demoted to the cold store; a name that returns comes back with its record.`));
        // The key itself, shown with its separator made visible, the same treatment the shell's
        // placeholder gives a focus key, so an intact key never reads as a truncated one.
        note.appendChild(el('p', 'sanguine_cast_num', wanted.replace(/\0/g, '␀')));
        record.appendChild(note);
        context.reveal(note);
        return;
    }

    // The first paint moves focus onto the record only when the player asked for a specific one.
    // Opening the tab cold and having focus yanked out of the rail would be the overlay stealing a
    // keystroke nobody spent.
    show(selected, Boolean(wanted));
}

registerTab('cast', renderCast);
