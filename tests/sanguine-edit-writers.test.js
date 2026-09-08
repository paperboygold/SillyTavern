import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A hand edit that looks like it saved and did nothing.
 *
 * The panel's row editor is a SPEC: `edit-form.js` names the columns, `editRow` renders them, and
 * only the changed ones come back. Everything downstream of that is an allow-list. `clocks.set`
 * destructures the thread columns it is willing to write; `edits.editCast` names the cast columns
 * in a literal array. A field that exists in the form and is missing from the writer is accepted by
 * the dialog, returned by `editRow`, spread into the call, and then silently dropped on the floor.
 *
 * This has already happened twice and is recorded both times. `clocks.js` carries the note in its
 * own body, *"`open`, `source` and `where` are columns `foldThread` has always accepted and this
 * writer silently dropped, so a hand edit to any of them looked like it saved and did nothing"*,
 * and `per`, the calendar cadence, was the next one: the field that makes `tickCalendar` reachable
 * at all could not be set from anywhere, because the reader shipped and the writer never did.
 *
 * So this is the gate for the CLASS rather than for either instance. Adding a column to a form
 * without teaching its writer about it cannot pass review, which is the only enforcement that
 * survives the next person in a hurry.
 *
 * It reads source text on purpose: `edit-form.js` imports `popup.js` and cannot be loaded here, and
 * the writers are storage modules that import `script.js`. The rule is about the seam between them,
 * which is visible in the text and nowhere else.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLD = path.join(HERE, '..', 'public', 'scripts', 'extensions', 'sanguine');

const read = name => fs.readFileSync(path.join(FOLD, name), 'utf8');

/**
 * The `key:` values of a frozen field spec in `edit-form.js`.
 * @param {string} source The file text.
 * @param {string} name The exported constant.
 * @returns {string[]} Column keys, in spec order.
 */
function fieldKeys(source, name) {
    const at = source.indexOf(`export const ${name}`);
    const end = source.indexOf(']);', at);
    return [...source.slice(at, end).matchAll(/\{\s*key:\s*'([^']+)'/g)].map(hit => hit[1]);
}

/**
 * The parameter names a function destructures from its options object.
 * @param {string} source The file text.
 * @param {string} signature The text opening the function, up to the destructure.
 * @returns {string[]} Names, without defaults.
 */
function destructured(source, signature) {
    const at = source.indexOf(signature);
    const open = source.indexOf('{', at);
    const close = source.indexOf('}', open);
    return source.slice(open + 1, close)
        .split(',')
        .map(part => part.split('=')[0].trim())
        .filter(Boolean);
}

describe('every column a row editor offers has a writer that accepts it', () => {
    const form = read('edit-form.js');

    test('thread columns all reach `clocks.set`', () => {
        const offered = fieldKeys(form, 'THREAD_FIELDS');
        const accepted = destructured(read('clocks.js'), 'export function set(name, {');
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.filter(key => !accepted.includes(key))).toEqual([]);
    });

    test('cast columns all reach `edits.editCast`', () => {
        const offered = fieldKeys(form, 'CAST_FIELDS');
        const edits = read('edits.js');
        // `place` and `threat` are routed to their own setters above the prose columns, so the
        // accepted set is the literal column list plus those two.
        const at = edits.indexOf('const columns = [');
        const columns = [...edits.slice(at, edits.indexOf('];', at)).matchAll(/'([^']+)'/g)].map(hit => hit[1]);
        const accepted = [...columns, 'place', 'threat'];
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.filter(key => !accepted.includes(key))).toEqual([]);
    });

    test('item columns all reach `edits.editItem`', () => {
        // The inventory row editor. Its writer is unusual and the gate matters more here than
        // anywhere: an item has no record to assign to, so each column is a SEPARATE appended event
        // and two of them change the key the next one would be addressed with. `editItem` names the
        // four it applies, in the order that survives that; a fifth column added to the form and not
        // to the destructure would be accepted by the dialog and dropped on the floor.
        const offered = fieldKeys(form, 'ITEM_FIELDS');
        const accepted = destructured(read('edits.js'), 'export function editItem(key, {');
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.filter(key => !accepted.includes(key))).toEqual([]);
    });

    test('the grade is one of them, `rank` had a reader and no writer at all', () => {
        // `deriveState` has applied `{dq: 0, rank}` since ranks existed, and every writer of that
        // shape was the extraction model: the one per-item attribute fold tracks was readable on the
        // panel and unwritable from anywhere. Named directly, like `per`, because it is the same
        // class of defect, a field the engine waits on that nothing sets.
        expect(fieldKeys(form, 'ITEM_FIELDS')).toContain('rank');
        expect(read('edits.js')).toContain('export function setItemRank(');
    });

    test('ability columns all reach `edits.editAbility`', () => {
        // The same gate for the table that arrived when capabilities stopped being inventory. It is
        // the one spec where the columns that are ABSENT carry the design: no count and no place,
        // because a technique has neither.
        const offered = fieldKeys(form, 'ABILITY_FIELDS');
        const accepted = destructured(read('edits.js'), 'export function editAbility(key, {');
        expect(offered).toEqual(['name', 'rank']);
        expect(offered.filter(key => !accepted.includes(key))).toEqual([]);
        expect(offered).not.toContain('qty');
        expect(offered).not.toContain('place');
    });

    test('splitting a row reaches `edits.splitItem`', () => {
        // The operation the owner had to perform four dialogs at a time on the live Raccoon City
        // ledger, one `ammunition x28` row that was really three magazines, twenty-five buckshot
        // shells and a box of birdshot.
        expect(fieldKeys(form, 'SPLIT_FIELDS')).toEqual(['parts']);
        expect(read('edits.js')).toContain('export function splitItem(');
        expect(read('edit-table.js')).toContain('export function readParts(');
    });

    test('the cadence is one of them, `per` is what makes a front tick at all', () => {
        // Named directly as well as covered by the sweep above, because this is the field the whole
        // calendar engine waits on: `tickCalendar` reads `per` and can only ever reach its
        // `anchored` branch while nothing writes one.
        expect(fieldKeys(form, 'THREAD_FIELDS')).toContain('per');
        expect(destructured(read('clocks.js'), 'export function set(name, {')).toContain('per');
    });
});
