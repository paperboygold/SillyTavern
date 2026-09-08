import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    actionForKey, appliedOf, applyLabelOf, cardModel, coverageCaption, KEYMAP,
    mechanismOf, recordTarget, revertOffer, stampOf, subjectOf, toneOf, toneVarOf, undoOffer,
} from '../public/scripts/extensions/sanguine/repairs-view.js';

/*
 * The Repairs tab, in the half that can be tested.
 *
 * `tests/jest.config.json` runs under `testEnvironment: node` and `tests/node_modules` carries no
 * jsdom, so nothing that touches `document` is reachable from here, which is every overlay tab in
 * the extension. `repairs-view.js` is the part of the Repairs tab that was lifted out for exactly
 * that reason, and the two things most worth a gate are a SENTENCE and a SUM:
 *
 *   · "rows 1, 40 of 88 checked this pass · next run continues at 41". The block poses at most
 *     `MAX_RECONCILE_LINES` (40) of the live rows (`reconcile-table.js`:177) and walks an offset,
 *     so on the measured Raccoon City record, 54 items + 3 marks + 16 cast + 15 threads = 88 live
 *     rows: one pass can never check more than 45% of it. Every empty state on this tab is scoped
 *     by that caption; get the arithmetic wrong and "nothing needs changing" becomes a claim about
 *     48 rows nobody looked at.
 *
 *   · "expired, the record has moved on." A pass snapshot is honest only until the next write.
 *     The design's own words: silent expiry is the defect, printed expiry is the feature. A control
 *     that quietly vanished when it expired would leave the player believing there had been an undo
 *     they missed.
 *
 * The colour test reaches into `overlay-repairs.css` on purpose. Verdict→hue is meaning, not
 * styling, and it is declared twice, once in the view model and once in the sheet. Two
 * declarations that can drift is one declaration nobody can trust.
 */

const SANGUINE = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');

/** The measured Raccoon City span: a 40-row block over an 88-row record. */
const RACCOON = { start: 1, end: 40, total: 88 };

/** Three cast rows that are dead where they fell, the cluster case, from the live record. */
const DEAD = [
    { op: 'gone', kind: 'cast', key: 'person\u0000infected man', name: 'infected man', evidence: 'dead on the storage room floor.' },
    { op: 'gone', kind: 'cast', key: 'person\u0000mechanic in the coveralls', name: 'mechanic in the coveralls', evidence: 'the hatchet is still in its skull.' },
    { op: 'gone', kind: 'cast', key: 'person\u0000two other figures', name: 'two other figures', evidence: 'neither has moved since.' },
];

/** The flagship `amount` ask: 9mm rounds, 60 in the ledger, 44 in the story. */
const NINE_MIL = {
    op: 'amount', kind: 'item', key: '\u0000carried\u00009mm rounds', name: '9mm rounds',
    from: 60, count: 44, evidence: 'Solomon counts what is left in the bag: forty-four rounds of 9mm.',
};

describe('the coverage strip states the span and never more than the span', () => {
    test('the caption is the measured record, to the row', () => {
        const caption = coverageCaption(RACCOON);
        expect(caption.text).toBe('rows 1, 40 of 88 checked this pass');
        expect(caption.next).toBe('next run continues at 41');
    });

    test('the fill is inset, so a second pass does not claim the first pass’s rows', () => {
        const second = coverageCaption({ start: 41, end: 80, total: 88 });
        expect(second.text).toBe('rows 41, 80 of 88 checked this pass');
        // 40/88 of the bar, offset by the 40 rows this pass did not look at.
        expect(second.leftPct).toBeCloseTo((40 / 88) * 100, 6);
        expect(second.widthPct).toBeCloseTo((40 / 88) * 100, 6);
    });

    test('the last span says the walk wraps rather than inventing row 89', () => {
        expect(coverageCaption({ start: 81, end: 88, total: 88 }).next).toBe('next run starts over at row 1');
    });

    // `propose()` commits the offset only once a plan exists (`reconcile.js`:161), so a failed pass
    // is a no-op on the walk. The strip has to say that, or the next run's caption silently claims
    // coverage of forty rows that were posed and never judged.
    test('a failed pass shows the span as posed and unjudged', () => {
        const failed = coverageCaption(RACCOON, { covered: false });
        expect(failed.text).toBe('rows 1, 40 of 88 posed, none judged');
        expect(failed.next).toBe('the span is still unchecked, the next run poses the same rows');
    });

    test('an empty record says so instead of dividing by zero', () => {
        const none = coverageCaption({ start: 0, end: 0, total: 0 });
        expect(none.empty).toBe(true);
        expect(none.widthPct).toBe(0);
        expect(none.text).toBe('nothing tracked yet');
    });

    test('a span longer than the record is clamped, not printed', () => {
        const clamped = coverageCaption({ start: 1, end: 500, total: 88 });
        expect(clamped.text).toBe('rows 1, 88 of 88 checked this pass');
        expect(clamped.widthPct).toBe(100);
    });
});

describe('a verdict is a colour and a word, and the two agree with the sheet', () => {
    test.each([
        ['gone', '--fold-crit'],
        ['amount', '--fold-warn'],
        ['merge', '--fold-rel'],
    ])('%s paints with %s', (op, token) => {
        expect(toneVarOf(op)).toBe(token);
        expect(toneOf(op)).toBe(op);
    });

    // The conserving tier never asks, so it never takes a semantic hue, spending crit on an applied
    // rename is spending the urgency colour on chrome, which is how a tracker loses the ability to
    // say "urgent" at all.
    test.each(['rename', 'move', 'split'])('%s is not on the ask tier and takes the accent', (op) => {
        expect(toneOf(op)).toBe('auto');
        expect(toneVarOf(op)).toBe('--fold-fresh');
    });

    test('the sheet binds the same three hues to the same three cards', () => {
        const css = fs.readFileSync(path.join(SANGUINE, 'overlay-repairs.css'), 'utf8');
        for (const op of ['gone', 'amount', 'merge']) {
            const rule = new RegExp(`\\.sanguine_rep_ask_${op}\\s*\\{[^}]*--sanguine-rep-tone:\\s*var\\(${toneVarOf(op)}\\)`);
            expect(css).toMatch(rule);
        }
    });

    test('every verdict is also a stamped word, so colour is never the only channel', () => {
        expect(stampOf({ op: 'gone' })).toBe('Gone');
        expect(stampOf({ op: 'merge' })).toBe('Merge');
        // The number IS the verdict for an amount, a stamp reading only "AMOUNT" would send the
        // reader hunting the subject line for the one fact that decides the answer.
        expect(stampOf(NINE_MIL)).toBe('Set 44');
    });

    // `clusterAsks` groups by `(op, kind)`, so two `amount`/`item` asks DO cluster. The naive stamp
    // reads the cluster's own `count` and prints "Set 2" over two rows heading for 44 and 12, a
    // number in the loudest position on the card that is not a quantity of anything.
    test('a cluster of amounts stamps the verb, never the member count', () => {
        expect(stampOf({ op: 'amount', count: 2, members: [NINE_MIL, { ...NINE_MIL, count: 12 }] })).toBe('Amount');
        expect(applyLabelOf({ op: 'amount', members: [NINE_MIL, NINE_MIL] })).toBe('Apply, set 2');
    });
});

describe('the subject line keeps the two faces apart', () => {
    test('an amount carries its arithmetic in mono, with a real minus sign', () => {
        const parts = subjectOf(NINE_MIL);
        expect(parts[0]).toEqual({ text: '9mm rounds', mono: false });
        expect(parts[1]).toEqual({ text: '60 → 44', mono: true });
        expect(parts[2]).toEqual({ text: '(−16)', mono: true });
    });

    test('a gain is signed too, so the reader never has to work out the direction', () => {
        expect(subjectOf({ op: 'amount', from: 4, count: 9 })[2].text).toBe('(+5)');
    });

    test('a cluster counts rather than names, the names are one disclosure away', () => {
        const parts = subjectOf({ op: 'gone', kind: 'cast', members: DEAD });
        expect(parts).toHaveLength(1);
        expect(parts[0].text).toBe('3 cast rows the pass reads as gone from the story');
    });
});

describe('the consequence line names the keeper rules the pass does not control', () => {
    // `mergeEntities` keeps the LONGER name and accumulates aliases (`entity-table.js`:1859), so
    // "Ada Wong ⇄ the woman in red" keeps the description. A card that said "Merge" and nothing else
    // would be asking the player to authorise a rule they have no way to know.
    test('a cast merge prints the longer-name rule', () => {
        expect(mechanismOf({ op: 'merge', kind: 'cast' }))
            .toBe('entities.merge · keeper: longer name survives; aliases accumulate · no inverse operator exists');
    });

    // `mergeThreads` keeps whichever row bears the more advanced dial (`thread-table.js`:1459),
    // a name-length tie-break once wound the Karr clock backwards from 7/8 to 1/6.
    test('a thread merge prints the dial rule', () => {
        expect(mechanismOf({ op: 'merge', kind: 'thread' }))
            .toBe('clocks.merge · keeper: the more advanced dial · no inverse operator exists');
    });

    test('an amount prints the value its inverse was recorded at', () => {
        expect(mechanismOf(NINE_MIL)).toContain('inverse recorded: 60');
    });

    // A `gone` is never `forget` (`reconcile.js`:25): a pass may repair the record, only the player
    // may decide something was never true.
    test('a gone promises that the events which placed the row are kept', () => {
        expect(mechanismOf({ op: 'gone', kind: 'cast' })).toContain('the events that placed it are kept');
        expect(mechanismOf({ op: 'gone', kind: 'cast' })).toContain('snapshot-undo only');
    });
});

describe('undo is offered in exactly the terms it deserves', () => {
    test('a live snapshot says what it covers and that it is temporary', () => {
        const offer = revertOffer({ snapshotValid: true, applied: new Array(6).fill({ op: 'rename' }) });
        expect(offer.disabled).toBe(false);
        expect(offer.note).toBe('undoes all 6, until the record next changes');
    });

    // The control is NOT hidden when it expires. Silent expiry is the defect; printed expiry is the
    // feature, a control that vanishes takes its own explanation with it.
    test('an expired snapshot degrades to the disabled truth rather than disappearing', () => {
        const offer = revertOffer({ snapshotValid: false, applied: [{ op: 'rename' }] });
        expect(offer.disabled).toBe(true);
        expect(offer.note).toBe('expired, the record has moved on.');
        expect(offer.label).toContain('revert this pass');
    });

    test('an inverse edit is offered as one, and never expires', () => {
        const offer = undoOffer('inverse', false);
        expect(offer.disabled).toBe(false);
        expect(offer.title).toContain('never expires');
    });

    // `mergeEntities` has no inverse anywhere in the codebase (`reconcile-table.js`:107). The UI is
    // not allowed to imply otherwise, which is also why merge is an ask rather than an auto-apply.
    test('a merge never pretends an inverse exists', () => {
        expect(undoOffer('none', true).disabled).toBe(true);
        expect(undoOffer('none', true).title).toContain('no inverse operator exists for a merge');
    });

    test('a snapshot-only row says which control covers it, and stops saying so once it is spent', () => {
        expect(undoOffer('snapshot', true).title).toContain('revert this pass');
        expect(undoOffer('snapshot', false).title).toContain('expired');
    });
});

describe('the keyboard model is one table, not a switch nobody can read', () => {
    test.each([
        ['ArrowDown', 'next'], ['j', 'next'],
        ['ArrowUp', 'prev'], ['k', 'prev'],
        ['Enter', 'apply'], ['y', 'apply'],
        ['n', 'dismiss'], ['Delete', 'dismiss'],
        ['e', 'disclose'], ['g', 'goto'], ['u', 'undo'],
    ])('%s is %s', (key, action) => {
        expect(actionForKey(key)).toBe(action);
    });

    // Space scrolls the panel. A scroll key that also applied a repair would be the worst possible
    // collision on a surface whose entire job is making an irreversible change deliberate.
    test.each([' ', 'Escape', 'Tab', 'a', 'Backspace'])('%s is left alone', (key) => {
        expect(actionForKey(key)).toBe('');
    });

    test('every action the tab implements has at least one binding', () => {
        expect(new Set(Object.values(KEYMAP))).toEqual(new Set(['next', 'prev', 'apply', 'dismiss', 'disclose', 'goto', 'undo']));
    });
});

describe('a cluster becomes one card without losing a member', () => {
    const cluster = { op: 'gone', kind: 'cast', key: 'gone\u0000cast', count: 3, members: DEAD };

    test('three questions become one card that still carries three answers', () => {
        const model = cardModel(cluster);
        expect(model.clustered).toBe(true);
        expect(model.count).toBe(3);
        expect(model.members).toHaveLength(3);
        expect(model.members.map(member => member.name)).toEqual(DEAD.map(ask => ask.name));
        // The cluster key is what `applyCluster` takes, and it must survive the trip through the
        // view model unchanged.
        expect(model.key).toBe('gone\u0000cast');
    });

    test('every member keeps its own evidence, because each is a separate judgement', () => {
        const model = cardModel(cluster);
        expect(model.members.map(member => member.evidence)).toEqual(DEAD.map(ask => ask.evidence));
        // The card itself carries none: a cluster's evidence lives on its members, disclosed.
        expect(model.evidence).toBe('');
    });

    // The record key and the ask key are different strings and are not interchangeable: one
    // addresses a row through `open({ tab, focus })`, the other addresses a question through
    // `applyAsk`. Conflating them applies the wrong repair or none at all.
    test('both keys are carried, and the ask key comes from the caller', () => {
        const model = cardModel(cluster, { identify: ask => `ask:${ask.key}` });
        expect(model.members[0].key).toBe('person\u0000infected man');
        expect(model.members[0].askKey).toBe('ask:person\u0000infected man');
    });

    test('the apply button names the outcome and follows the opt-out count', () => {
        const model = cardModel(cluster);
        expect(model.applyLabel).toBe('Apply, remove 3');
        expect(applyLabelOf(model, 2)).toBe('Apply, remove 2');
    });

    test('a singleton renders as itself, not as a cluster of one', () => {
        const model = cardModel({ op: 'amount', kind: 'item', key: 'RI7', count: 1, members: [NINE_MIL] });
        expect(model.clustered).toBe(false);
        expect(model.evidence).toBe(NINE_MIL.evidence);
        expect(model.applyLabel).toBe('Apply, set to 44');
        expect(model.ariaLabel).toBe('Set 44: 9mm rounds 60 → 44 (−16)');
    });

    test('the accessible name is the stamp and the subject, per the a11y contract', () => {
        expect(cardModel(cluster).ariaLabel).toBe('Gone: 3 cast rows the pass reads as gone from the story');
    });
});

describe('g jumps to the record the question is about', () => {
    test('a carried item goes to Inventory, keyed by the item key itself', () => {
        expect(recordTarget(NINE_MIL)).toEqual({ tab: 'inventory', focus: NINE_MIL.key, label: 'view in Inventory' });
    });

    test('an item in the assets place goes to Assets', () => {
        const deed = { kind: 'item', key: '\u0000assets\u0000the safehouse' };
        expect(recordTarget(deed).tab).toBe('assets');
    });

    test.each([
        ['cast', 'cast'],
        ['thread', 'threads'],
    ])('a %s row goes to the %s tab with its own key', (kind, tab) => {
        expect(recordTarget({ kind, key: 'k' })).toEqual({ tab, focus: 'k', label: expect.any(String) });
    });

    // A condition has no tab of its own, it is a fact ABOUT a person, so the jump lands on the
    // person, rebuilt from the owner segment of the mark key (`state-table.js`:774).
    test('a condition jumps to the person carrying it', () => {
        const mark = { kind: 'mark', key: 'Martinez\u0000bloody arm', who: 'Martinez' };
        expect(recordTarget(mark)).toEqual({ tab: 'cast', focus: 'person\u0000Martinez', label: 'view in Entities' });
    });

    test('a condition with no owner has nowhere to go, and says so', () => {
        expect(recordTarget({ kind: 'mark', key: 'orphan', who: '' })).toBeNull();
        expect(recordTarget({ kind: 'item', key: '' })).toBeNull();
    });
});

describe('the ledger prints what changed in the face that produced it', () => {
    test('a rename is two names and an arrow', () => {
        expect(appliedOf({ op: 'rename', name: 'key', to: 'records room key' }))
            .toEqual([{ text: 'key', mono: false }, { text: '→', mono: true }, { text: 'records room key', mono: false }]);
    });

    test('an amount records both ends, in mono', () => {
        const parts = appliedOf({ op: 'amount', name: '9mm rounds', from: 60, count: 44 });
        expect(parts.filter(part => part.mono).map(part => part.text)).toEqual(['60', '→', '44']);
    });

    // The split's flagship case: ammunition ×29 becomes three magazines, twenty-five buckshot shells
    // and a box of birdshot. Quantity is conserved by construction (`edit-table.js splitDelta`), and
    // the ledger line is what makes the loudest edit in the pass legible after the fact.
    test('a split names every part it created', () => {
        const parts = appliedOf({
            op: 'split', name: 'ammunition', from: 29,
            parts: [{ name: '9mm magazines', count: 3 }, { name: 'buckshot shells', count: 25 }, { name: 'box of birdshot', count: 1 }],
        });
        expect(parts[0].text).toBe('ammunition ×29');
        expect(parts[2].text).toBe('9mm magazines ×3 · buckshot shells ×25 · box of birdshot');
    });
});

describe('the tab is registered where the rail doctrine puts it', () => {
    const overlay = fs.readFileSync(path.join(SANGUINE, 'overlay.js'), 'utf8');

    test('Repairs sits between Assets and Diagnostics, machinery after story', () => {
        const ids = [...overlay.matchAll(/Object\.freeze\(\{ id: '([a-z]+)'/g)].map(hit => hit[1]);
        expect(ids).toEqual(['cast', 'threads', 'chronicle', 'inventory', 'assets', 'repairs', 'audit', 'prompts', 'diagnostics']);
    });

    test('the tab carries the icon and blurb the design specified', () => {
        expect(overlay).toContain('id: \'repairs\', label: \'Repairs\', icon: \'fa-screwdriver-wrench\'');
    });
});

describe('the tab renders model output and never trusts it', () => {
    const tab = fs.readFileSync(path.join(SANGUINE, 'overlay-repairs.js'), 'utf8');

    // Evidence is raw model prose about the player's own campaign, arriving on the same path a
    // prompt does. Every value goes in as `textContent`; one `innerHTML` on this surface is one
    // script tag away from the story writing to the DOM.
    test('nothing on the Repairs tab is ever set as HTML', () => {
        expect(tab).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    });

    // §6: the maximum blast radius of one interaction is one card. A global apply-all is the old
    // gate wearing a new shirt, it re-couples the frightening decision to the easy ones, which is
    // the coupling that produced 80 asked / 0 applied.
    test('there is no global apply-all across questions', () => {
        expect(tab).not.toMatch(/applyAll|applyEvery|applyAsks\(/);
    });
});
