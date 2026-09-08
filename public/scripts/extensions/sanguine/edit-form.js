/**
 * sanguine/edit-form.js: the whole row, in one dialog.
 *
 * Why this exists.
 *
 * The first cut wired a row's pencil to a single `window.prompt` for one field, so editing a person
 * offered "what does Chí Guāngdé want?" and nothing else, not their name, not their description,
 * not where they are. A cast row carries ten columns and the editor exposed one, which is a worse
 * affordance than no editor: it looks like the whole of what you can change.
 *
 * `edits.editCast` already accepted every column. Only the UI was narrow.
 *
 * A spec, not a form per table.
 *
 * Threads and cast rows are different tables with different columns, and writing a bespoke dialog
 * for each is how the second one ends up missing fields too. `editRow` takes a FIELD SPEC, label,
 * key, kind, and returns whatever the player changed. A new column becomes one line in the spec,
 * and nothing about the dialog has to know which table it came from.
 *
 * Only CHANGED fields come back, so an editor that touches one line does not restamp nine others.
 * That matters beyond tidiness: `merge_entity` is field-wise last-write versioned by turn, and
 * rewriting an untouched column would make a stale value look like the newest claim.
 */

import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';

/** Columns of a cast row worth putting in front of a person. */
export const CAST_FIELDS = Object.freeze([
    { key: 'name', label: 'Name' },
    { key: 'aka', label: 'Also called', hint: 'Comma-separated. Other names, titles, or the form in another script.' },
    // Appearance has its own columns now, so this one stopped claiming it.
    //
    // The hint used to read "appearance and standing truths that do not age", which was accurate
    // when `facts` was the only prose column and was the reason it answered for neither: a face and
    // a rank competed for the same 120 bytes, and one of them changed when the character put a coat
    // on. `look` and `wearing` took the physical half; `facts` keeps what is true regardless of how
    // anyone looks.
    { key: 'facts', label: 'Standing truths', kind: 'area', hint: 'Rank, role, allegiance, what is true of them regardless of appearance.' },
    { key: 'look', label: 'Appearance', kind: 'area', hint: 'Build, features, colouring, scars. Things that do not change when they change clothes.' },
    { key: 'wearing', label: 'Wearing', kind: 'area', hint: 'What they have on and how they look right now. Expected to change.' },
    { key: 'bearing', label: 'Manner', kind: 'area', hint: 'Voice, movement, temperament. Kept only for a person of interest.' },
    { key: 'history', label: 'Background', kind: 'area', hint: 'Where they came from. Kept only for a person of interest.' },
    { key: 'detail', label: 'Doing now', hint: 'What they are doing at this moment.' },
    { key: 'place', label: 'Where' },
    { key: 'wants', label: 'Wants', hint: 'What they are trying to bring about.' },
    { key: 'knows', label: 'Knows' },
    { key: 'reach', label: 'Reachable by', hint: 'How the point-of-view character can contact them at a distance.' },
]);

/**
 * Columns of an inventory row.
 *
 * Why an item gets a spec at all.
 *
 * Inventory is a fold over an append-only ledger: there is no row to assign to, so every one of
 * these four columns is a DIFFERENT event with different arithmetic, a move is a transfer between
 * two places, a rename is a transfer between two names, a count is the difference from what is held,
 * and a grade moves no quantity at all. The panel exposed the first two through `window.prompt`, one
 * question at a time, and the last two not at all. A player correcting "3 Sig P226 in the SUV" to
 * "1 SIG P226 (worn), carried" had to answer three prompts in the right order and could not touch
 * the grade from anywhere.
 *
 * The spec makes that one dialog. `edits.editItem` applies the four in the only order that survives
 * the key changing underneath them, see its docblock.
 *
 * `qty` is `kind: 'number'` because it is the one field here that is arithmetic rather than
 * language; everything else is the story's own words and stays text.
 */
export const ITEM_FIELDS = Object.freeze([
    { key: 'name', label: 'Name', hint: 'What the story calls it. Renaming carries the count across to the new name.' },
    { key: 'rank', label: 'Grade', hint: 'The grade the story gave it, "(E)", "+2", "masterwork". Free text; fold stores it and never compares two of them.' },
    { key: 'qty', label: 'How many', kind: 'number', hint: 'The count you have now. The difference from what is held is recorded as a gain or a loss.' },
    // `abilities` is deliberately no longer offered here. It was one of the four protocol tokens this
    // field accepted, and typing it filed a capability as luggage, the category error `foldAbility`
    // closes. Abilities have their own section and their own dialog; nothing needs to be moved into
    // one by naming a place.
    { key: 'place', label: 'Where', hint: 'carried, assets or money, or a place the story named ("the SUV", "the safe house").' },
]);

/**
 * Columns of a capability.
 *
 * Two fields, and the two that are missing are the point.
 *
 * An ability had four columns for as long as it was an inventory row, and two of them were a
 * category error made typeable: "how many" of a clearance level, and "where" a proficiency is kept.
 * `state-table.js` `foldAbility` retired both; this is the same retirement on the surface the player
 * actually touches. What is left is what a capability really has, what it is called, and what grade
 * the setting gives it, which is exactly the `standing` shape one level down.
 *
 * `rank` is unchanged and stays free text for its own stated reason: F/E/D/C/B/A/S, "Amateur",
 * "47/100", "Lv. 12" and "見習い" are all real gradings, fold stores the string and never compares
 * two, and an enum would fit one setting and mangle the rest.
 */
export const ABILITY_FIELDS = Object.freeze([
    { key: 'name', label: 'Name', hint: 'What the story calls it, "Nine Realms Heavenly Ascension", "tier 3 access", "quarterstaff proficiency". Leave the grade out of the name.' },
    { key: 'rank', label: 'Grade', hint: 'The grade the story gives it, copied as written, "E", "Amateur", "47/100", "Lv. 12". Empty when the story grades it with nothing.' },
]);

/**
 * The one field a split needs.
 *
 * One part per line, because the number of parts is not known until it is typed, see
 * `edit-table.js` `readParts` for why that beats a repeating name/count pair, and `splitDelta` for
 * the live case that asked for the operation at all.
 */
export const SPLIT_FIELDS = Object.freeze([
    {
        key: 'parts',
        label: 'What it actually is',
        kind: 'area',
        hint: 'One per line, with a count: "9mm magazines x3". The counts are taken out of this row; anything left over keeps the old name.',
    },
]);

/**
 * The two fields a component has.
 *
 * Two, and neither of them is a number.
 *
 * A component is `{name, value}` and the value is OPAQUE (`part-table.js`): fold stores what the
 * story said and never compares two readings. That is the `standing` shape and the `rank` discipline
 * one tier down, and it is what lets one field carry an enchantment, a calibre, a cultivation grade
 * and a serial number without fold learning any of their names.
 *
 * There is deliberately no count and no "where". A sword's enchantment is not somewhere you stand
 * and there is no ×2 of it, the same two absences `ABILITY_FIELDS` records, and for the same reason.
 */
export const COMPONENT_FIELDS = Object.freeze([
    { key: 'name', label: 'Part', hint: 'What it is, "flame rune", "calibre", "serial", "curse".' },
    { key: 'value', label: 'Reads', hint: 'What it says now, in the story\'s own words. Replaces whatever was there before.' },
]);

/** Columns of a thread. */
export const THREAD_FIELDS = Object.freeze([
    { key: 'about', label: 'Stake' },
    { key: 'open', label: 'Still open because', kind: 'area', hint: 'What acting on it would settle.' },
    { key: 'where', label: 'Where' },
    // The cadence. `tickCalendar` has always been able to read this and nothing has ever written
    // one, so every front in every chat has waited for the story to mention it. A span here is the
    // difference between a clock that counts and a clock that is only ever wound by hand.
    { key: 'per', label: 'Advances every', hint: 'A span, "6 hours", "1 week", "1 month". The front then advances on the calendar as time passes, even when the story never mentions it. Leave empty and it only moves when something says so.' },
    { key: 'source', label: 'Came from' },
]);

/**
 * Show a row's fields and return what changed.
 *
 * @param {string} title Dialog heading.
 * @param {ReadonlyArray<{key: string, label: string, kind?: string, hint?: string}>} fields The spec.
 * @param {object} row The row as it stands.
 * @returns {Promise<Record<string, string>|null>} Changed fields only, or null if cancelled.
 */
export async function editRow(title, fields, row) {
    const form = document.createElement('div');
    form.className = 'sanguine_editform';

    const heading = document.createElement('h3');
    heading.textContent = title;
    form.appendChild(heading);

    /** @type {Map<string, HTMLInputElement|HTMLTextAreaElement>} */
    const inputs = new Map();

    for (const field of fields) {
        const wrap = document.createElement('label');
        wrap.className = 'sanguine_editfield';

        const label = document.createElement('span');
        label.className = 'sanguine_editlabel';
        label.textContent = field.label;
        wrap.appendChild(label);

        const input = field.kind === 'area'
            ? document.createElement('textarea')
            : document.createElement('input');
        if (input instanceof HTMLTextAreaElement) {
            input.rows = 3;
        } else if (field.kind === 'number') {
            // A count is arithmetic, so it gets the control that says so: spinners on a desktop and
            // the numeric keypad on a phone. The comparison below still reads `.value` as a string,
            // which is what makes an untouched number field indistinguishable from an untouched
            // text one, no special case downstream.
            input.type = 'number';
            input.inputMode = 'numeric';
            input.step = '1';
        } else {
            input.type = 'text';
        }
        input.className = 'text_pole';
        input.value = String(row?.[field.key] ?? '');
        if (field.hint) input.title = field.hint;
        wrap.appendChild(input);

        if (field.hint) {
            const hint = document.createElement('small');
            hint.className = 'sanguine_edithint';
            hint.textContent = field.hint;
            wrap.appendChild(hint);
        }

        inputs.set(field.key, input);
        form.appendChild(wrap);
    }

    const result = await callGenericPopup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }

    // Only what moved. An untouched column must not be rewritten, the cast merge is versioned
    // last-write, so restamping a stale value would make it the newest claim about that field.
    const changed = {};
    for (const [key, input] of inputs) {
        const value = String(input.value ?? '').trim();
        if (value !== String(row?.[key] ?? '').trim()) {
            changed[key] = value;
        }
    }
    return changed;
}
