/**
 * sanguine/repairs-view.js: what the Repairs tab SAYS, decided without a DOM.
 *
 * The tab itself is `overlay-repairs.js`. This file is the half of it that can be tested: the
 * coverage arithmetic, the verdict→colour map, the stamp and subject strings, the consequence
 * lines, the undo copy, and the key→action table. `tests/jest.config.json` runs under
 * `testEnvironment: node` and `tests/node_modules` carries no jsdom, so a module that touches
 * `document` at any point in its import graph cannot be tested at all, and the two things most
 * worth a regression gate here are a *sentence* ("expired, the record has moved on") and a *sum*
 * (`rows 1, 40 of 88`), neither of which needs an element to be checked.
 *
 * The split follows `diagnostics-view.js`, which was lifted out of `panel.js` for the neighbouring
 * reason: the row and its `help:` sentences outlived the surface they were first drawn on.
 *
 * What this file will not import.
 *
 * `../../i18n.js` reads `localStorage` and `navigator.language` at module scope (i18n.js:4-6), so
 * importing `t` here would put the whole file back out of reach of the tests. Copy is therefore
 * returned as plain English and wrapped by the caller where a caller can. That is a real cost,
 * these strings do not reach the locale files, and it is the same trade `reconcile-table.js`
 * already makes for `instruction()`.
 *
 * `./repairs.js` and `./repair-table.js` are the engine's, and are deliberately NOT imported: this
 * module takes plain objects in the frozen ask/pass shapes and answers with plain objects. The two
 * key helpers it does import (`splitItemKey`, `entityKey`) are pure table modules that node tests
 * already load directly.
 */

import { entityKey, PERSON } from './entity-table.js';
import { ASSETS, splitItemKey } from './state-table.js';

/**
 * The verdict→hue map, and the whole of it.
 *
 * `style.css` `:root` reserves the semantic axis for MEANING, so these three are spent on the three
 * questions the pass can ask and on nothing else:
 *
 *   gone    `--fold-crit`   crimson, a row leaves the record. Loss.
 *   amount  `--fold-warn`   ember, the economy verdict; a number nothing will announce is wrong.
 *   merge   `--fold-rel`    violet, a relation asserted between two rows.
 *
 * The conserving tier (`rename`, `move`, `split`) never appears as an ask, it has already landed
 * by the time this tab is opened, so on the ledger it takes the theme accent rather than a
 * semantic hue. An applied rename is not a warning about anything.
 *
 * Colour is never the only channel: every entry here is also a stamped word (`stampOf`) and a
 * `data-tone` attribute, so the card survives a greyscale render and a screen reader alike.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TONE_VAR = Object.freeze({
    gone: '--fold-crit',
    amount: '--fold-warn',
    merge: '--fold-rel',
    rename: '--fold-fresh',
    move: '--fold-fresh',
    split: '--fold-fresh',
});

/** @type {ReadonlyArray<string>} The three verdicts that ask. Anything else applied on sight. */
export const ASK_OPS = Object.freeze(['gone', 'amount', 'merge']);

/**
 * The tone token for a verdict, the suffix of the card's class and the value of `data-tone`.
 *
 * @param {string} op A verdict.
 * @returns {string} `gone` | `amount` | `merge` | `auto`.
 */
export function toneOf(op) {
    return ASK_OPS.includes(String(op)) ? String(op) : 'auto';
}

/**
 * The CSS variable a verdict paints with.
 *
 * Exported so `tests/sanguine-repairs-view.test.js` can hold this map against the sheet itself: a
 * rename here that is not made in `overlay-repairs.css` would silently drop a card back to the
 * default hue, which is exactly the class of bug colour-as-meaning exists to make impossible.
 *
 * @param {string} op A verdict.
 * @returns {string} The custom property name, `--fold-fresh` for anything not on the ask tier.
 */
export function toneVarOf(op) {
    return TONE_VAR[String(op)] ?? '--fold-fresh';
}

/** @param {number} value A number. @returns {string} Grouped digits, or '' for a non-number. */
function num(value) {
    return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '';
}

/**
 * The word for a kind, as a person would say it.
 *
 * `mark` is the one that must be translated rather than printed: the table calls it a mark, the
 * panel calls it a condition, and the player has only ever seen the second.
 *
 * @param {string} kind One of `item`, `mark`, `cast`, `thread`.
 * @param {number} [count] How many, for the plural.
 * @returns {string} The word.
 */
export function kindWord(kind, count = 1) {
    const one = { item: 'item', mark: 'condition', cast: 'cast row', thread: 'thread' }[String(kind)] ?? String(kind ?? 'row');
    if (count === 1) return one;
    return one === 'cast row' ? 'cast rows' : `${one}s`;
}

/**
 * The verdict stamp, the loudest thing on the card, and the reason it is a word and not a colour.
 *
 * `amount` carries its destination in the stamp (`Set 44`) because the number IS the verdict: an
 * `amount` card that stamped only "AMOUNT" would make the reader hunt the subject line for the one
 * fact that decides the answer. §5 of the spec puts this at `--s-title`/700/skewed; the casing is
 * done in CSS so this string stays readable when it is reused as the card's accessible name.
 *
 * @param {object} ask An ask, or a cluster head.
 * @returns {string} The stamp.
 */
export function stampOf(ask) {
    const op = String(ask?.op ?? '');
    // A cluster of amounts has as many destinations as it has members, so the stamp drops back to
    // the verb. `clusterAsks` groups by `(op, kind)`, and two `amount`/`item` asks do group, the
    // naive read would take the cluster's own `count` and stamp "Set 2" over two rows that are going
    // to 44 and 12.
    const clustered = Array.isArray(ask?.members) && ask.members.length > 1;
    if (op === 'amount') return clustered ? 'Amount' : `Set ${num(ask?.count)}`;
    if (op === 'merge') return 'Merge';
    if (op === 'gone') return 'Gone';
    return op ? op[0].toUpperCase() + op.slice(1) : '';
}

/**
 * The subject line, in segments.
 *
 * Segments rather than one string because the two faces are load-bearing: a name was written by a
 * narrator and is set in the body face, while `60 → 44 (−16)` was computed and is set in
 * `--fold-mono` with tabular figures. A single string would force the whole line into one face and
 * lose the only signal that says who produced which half of it.
 *
 * @param {object} entry An ask, or a cluster `{op, kind, count, members}`.
 * @returns {Array<{text: string, mono: boolean}>} The segments, in reading order.
 */
export function subjectOf(entry) {
    const op = String(entry?.op ?? '');
    const members = Array.isArray(entry?.members) ? entry.members : [];

    if (members.length > 1) {
        // A cluster's subject counts rather than names. The names are one disclosure away, in the
        // member list, where each carries its own evidence, §6: grouping is how bulk stays cheap
        // without becoming a blind "select all".
        const verb = op === 'gone'
            ? 'the pass reads as gone from the story'
            : op === 'merge' ? 'the pass reads as duplicates' : 'the pass would rewrite';
        return [{ text: `${members.length} ${kindWord(entry?.kind, members.length)} ${verb}`, mono: false }];
    }

    const ask = members.length === 1 ? members[0] : entry;
    const name = String(ask?.name ?? '');

    if (op === 'amount') {
        const from = Number(ask?.from ?? 0);
        const to = Number(ask?.count ?? 0);
        const delta = to - from;
        return [
            { text: name, mono: false },
            { text: `${num(from)} → ${num(to)}`, mono: true },
            // U+2212 MINUS SIGN, not a hyphen: this sits beside tabular figures and a hyphen is a
            // different width and a different height from the plus it pairs with.
            { text: `(${delta >= 0 ? '+' : '−'}${num(Math.abs(delta))})`, mono: true },
        ];
    }
    if (op === 'merge') {
        return [
            { text: name, mono: false },
            { text: '⇄', mono: true },
            { text: String(ask?.withName ?? ask?.to ?? ''), mono: false },
        ];
    }
    return [{ text: name, mono: false }];
}

/**
 * The consequence line: what the write will actually do, in the machine's own voice.
 *
 * §5's fourth rank, and the one piece of copy the redesign argues hardest for, the player is told
 * what they are authorising rather than asked to trust a verb. That includes the rules the pass
 * does NOT control, because those are precisely the ones a reasonable person would guess wrong:
 *
 *   · `entities.merge` keeps the LONGER name and accumulates aliases (`entity-table.js`:1859), so
 *     "Ada Wong ⇄ the woman in red" keeps the description, not the name.
 *   · `clocks.merge` keeps whichever row holds the MORE ADVANCED dial (`thread-table.js`:1459),
 *     a name-length tie-break once wound the Karr clock backwards from 7/8 to 1/6, which is why
 *     that rule exists and why the card must not promise a direction it cannot deliver.
 *   · A `merge` on an item is a transfer, not a deletion: `reconcile.js`:348 routes it through
 *     `edits.renameItem`, which debits the whole quantity and credits it under the survivor.
 *   · A `gone` is never `forget` (`reconcile.js`:25), the events that placed the row are kept.
 *
 * @param {object} entry An ask or a cluster head.
 * @returns {string} One line, mono, `--s-meta`.
 */
export function mechanismOf(entry) {
    const op = String(entry?.op ?? '');
    const kind = String(entry?.kind ?? '');
    const ask = Array.isArray(entry?.members) && entry.members.length === 1 ? entry.members[0] : entry;

    if (op === 'gone') {
        const write = {
            item: 'edits.removeItem · the row leaves the panel',
            mark: 'edits.clearMark · the condition comes off',
            thread: 'edits.closeThread · the thread closes and its dial stops',
            cast: 'edits.editCast status:gone · the row leaves the cast',
        }[kind] ?? 'the row leaves the record';
        return `${write} · the events that placed it are kept · snapshot-undo only`;
    }
    if (op === 'amount') {
        const clustered = Array.isArray(entry?.members) && entry.members.length > 1;
        return clustered
            ? 'edits.setItemQty · the story\'s count replaces the ledger\'s · each row\'s own inverse is recorded'
            : `edits.setItemQty · the story's count replaces the ledger's · inverse recorded: ${num(ask?.from)}`;
    }
    if (op === 'merge') {
        if (kind === 'cast') return 'entities.merge · keeper: longer name survives; aliases accumulate · no inverse operator exists';
        if (kind === 'thread') return 'clocks.merge · keeper: the more advanced dial · no inverse operator exists';
        if (kind === 'item') return 'edits.renameItem · the whole quantity transfers onto the survivor · no inverse operator exists';
        return 'edits.clearMark · the duplicate condition comes off · no inverse operator exists';
    }
    return '';
}

/**
 * The label on a card's apply button.
 *
 * It names the outcome, not the verb. "Apply" alone is the modal's copy and it is what made the
 * measured trade (80 asked, 0 applied) a blind one, a button that says `Apply, set to 44` can be
 * pressed without re-reading the card that explains it.
 *
 * @param {object} entry An ask or a cluster head.
 * @param {number} [selected] For a cluster, how many members are ticked.
 * @returns {string} The label.
 */
export function applyLabelOf(entry, selected = 0) {
    const op = String(entry?.op ?? '');
    const members = Array.isArray(entry?.members) ? entry.members : [];
    if (members.length > 1) {
        const n = selected || members.length;
        if (op === 'gone') return `Apply, remove ${n}`;
        if (op === 'merge') return `Apply, collapse ${n}`;
        if (op === 'amount') return `Apply, set ${n}`;
        return `Apply, ${n}`;
    }
    const ask = members.length === 1 ? members[0] : entry;
    if (op === 'amount') return `Apply, set to ${num(ask?.count)}`;
    if (op === 'merge') return ask?.kind === 'thread' ? 'Apply, one thread' : 'Apply, one row';
    return 'Apply, remove it';
}

/**
 * Where a record lives, so `g` can jump to it.
 *
 * This is the argument §3 makes for a tab over a modal, reduced to a function: the ask is a
 * question ABOUT a record, and the record is one keystroke away in the same shell. Each answer is a
 * key in the target tab's own namespace, per `overlay.js`'s focus contract:
 *
 *   item    the item key itself, split to decide inventory from assets (`state-table.js`:163)
 *   cast    the entity key, which is what `asks()` carries
 *   thread  the thread key from `clocks.view()`
 *   mark    a condition has no tab of its own; it is a fact about a PERSON, so the jump lands on
 *           the person carrying it, rebuilt with `entityKey` from the owner segment of the mark
 *           key (`state-table.js`:774, `markKey(who, subject)`). A mark with no owner has nowhere
 *           to go and says so by answering null rather than opening a tab on nothing.
 *
 * @param {object} ask One ask (never a cluster, the jump is per record).
 * @returns {{tab: string, focus: string, label: string}|null} Where to go, or null.
 */
export function recordTarget(ask) {
    const kind = String(ask?.kind ?? '');
    const key = String(ask?.key ?? '');
    if (!key) return null;

    if (kind === 'item') {
        const inAssets = splitItemKey(key).place === ASSETS;
        return inAssets
            ? { tab: 'assets', focus: key, label: 'view in Assets' }
            : { tab: 'inventory', focus: key, label: 'view in Inventory' };
    }
    if (kind === 'cast') {
        return { tab: 'cast', focus: key, label: 'view in Entities' };
    }
    if (kind === 'thread') {
        return { tab: 'threads', focus: key, label: 'view in Threads' };
    }
    if (kind === 'mark') {
        const who = String(ask?.who ?? '').trim() || splitItemKey(key).who;
        return who ? { tab: 'cast', focus: entityKey(PERSON, who), label: 'view in Entities' } : null;
    }
    return null;
}

/**
 * The coverage strip's arithmetic and its caption.
 *
 * §7: the block poses at most `MAX_RECONCILE_LINES` (40) of the live rows
 * (`reconcile-table.js`:177), offset-walked, so a record of 88 live rows, the measured Raccoon
 * City figure: 54 items + 3 marks + 16 cast + 15 threads, is never fully checked by one pass. The
 * strip is what stops "nothing needs changing" from claiming more than "nothing IN THE CHECKED SPAN
 * needs changing".
 *
 * The fill is INSET, not left-anchored: on the second pass the covered span is rows 41, 80, and a bar
 * that filled from zero would draw a claim about rows 1, 40 that the pass never made.
 *
 * @param {object} span The span. `{start, end, total}`, 1-based and inclusive.
 * @param {object} [options] Options.
 * @param {boolean} [options.covered] False when the pass failed, the offset was not advanced
 *   (`reconcile.js`:161 commits only once a plan exists), so the span is still unchecked.
 * @returns {{text: string, next: string, leftPct: number, widthPct: number, empty: boolean}} The strip.
 */
export function coverageCaption({ start = 0, end = 0, total = 0 } = {}, { covered = true } = {}) {
    const size = Math.max(0, Number(total) || 0);
    if (!size) {
        return { text: 'nothing tracked yet', next: 'the record is empty, there is nothing to check', leftPct: 0, widthPct: 0, empty: true };
    }

    const first = Math.min(Math.max(1, Number(start) || 0), size);
    const last = Math.min(Math.max(first, Number(end) || 0), size);
    const rows = last - first + 1;
    const leftPct = ((first - 1) / size) * 100;
    const widthPct = (rows / size) * 100;

    if (!covered) {
        return {
            text: `rows ${first}, ${last} of ${size} posed, none judged`,
            next: 'the span is still unchecked, the next run poses the same rows',
            leftPct, widthPct, empty: false,
        };
    }
    return {
        text: `rows ${first}, ${last} of ${size} checked this pass`,
        next: last >= size ? 'next run starts over at row 1' : `next run continues at ${last + 1}`,
        leftPct, widthPct, empty: false,
    };
}

/**
 * What the revert-pass control says, and whether it may be pressed.
 *
 * §4's first undo mechanism, printed rather than implied. The snapshot is honest only while nothing
 * else has written, so it invalidates on the next sanguine write that is not part of the pass, and
 * when it does, the control does NOT vanish. A control that disappears takes its own explanation
 * with it and leaves the player believing an undo existed that they missed; the disabled truth
 * leaves the mechanism on screen and says why it is spent. Silent expiry is the defect; printed
 * expiry is the feature.
 *
 * @param {object} pass One ledger pass.
 * @returns {{label: string, note: string, disabled: boolean}} The control.
 */
export function revertOffer(pass) {
    const applied = Array.isArray(pass?.applied) ? pass.applied.length : 0;
    if (!pass?.snapshotValid) {
        return { label: '↶ revert this pass', note: 'expired, the record has moved on.', disabled: true };
    }
    return {
        label: '↶ revert this pass',
        note: `undoes all ${applied}, until the record next changes`,
        disabled: false,
    };
}

/**
 * What a single applied row's undo affordance says.
 *
 * Three mechanisms, three sentences, and the UI never pretends there is a fourth. `merge` has no
 * inverse operator anywhere in the codebase (`reconcile-table.js`:107), and neither does a spent
 * `split` or `gone` once the snapshot has expired, so those buttons are present, disabled, and
 * carry the reason in their tooltip rather than being quietly dropped from the row.
 *
 * @param {string} undoKind `inverse` | `snapshot` | `none`, from `undoKindOf(op)`.
 * @param {boolean} snapshotValid Whether this pass's snapshot is still honest.
 * @returns {{label: string, title: string, disabled: boolean}} The affordance.
 */
export function undoOffer(undoKind, snapshotValid) {
    if (undoKind === 'inverse') {
        return { label: 'undo', title: 'writes the inverse edit, an ordinary edit, so it never expires', disabled: false };
    }
    if (undoKind === 'snapshot') {
        return snapshotValid
            ? { label: 'undo', title: 'no inverse edit exists, use “revert this pass” while the snapshot lives', disabled: true }
            : { label: 'undo', title: 'no inverse edit exists, and the pass snapshot has expired', disabled: true };
    }
    return { label: 'undo', title: 'no inverse operator exists for a merge, the rows are one row now', disabled: true };
}

/**
 * One applied row, as segments.
 *
 * The ledger is the quiet tier (`--o-context`): it was already judged safe by the conservation
 * line, so it is reference rather than testimony. Same two-face rule as `subjectOf`: names in
 * prose, values in mono.
 *
 * @param {object} row One entry from `pass.applied`.
 * @returns {Array<{text: string, mono: boolean}>} The segments.
 */
export function appliedOf(row) {
    const op = String(row?.op ?? '');
    const name = String(row?.name ?? '');
    const to = String(row?.to ?? '');

    if (op === 'rename') return [{ text: name, mono: false }, { text: '→', mono: true }, { text: to, mono: false }];
    if (op === 'move') return [{ text: name, mono: false }, { text: '→', mono: true }, { text: to, mono: false }];
    if (op === 'amount') {
        return [
            { text: name, mono: false },
            { text: num(row?.from), mono: true },
            { text: '→', mono: true },
            { text: num(row?.count), mono: true },
        ];
    }
    if (op === 'split') {
        const parts = Array.isArray(row?.parts) ? row.parts : [];
        const into = parts.map(part => `${part?.name ?? ''}${Number(part?.count) > 1 ? ` ×${num(part.count)}` : ''}`).join(' · ');
        return [
            { text: Number(row?.from) > 1 ? `${name} ×${num(row.from)}` : name, mono: false },
            { text: '→', mono: true },
            { text: into, mono: false },
        ];
    }
    if (op === 'merge') {
        return [{ text: name, mono: false }, { text: '⇄', mono: true }, { text: String(row?.withName ?? to), mono: false }];
    }
    if (op === 'gone') return [{ text: name, mono: false }, { text: '→', mono: true }, { text: 'removed', mono: false }];
    return [{ text: name, mono: false }];
}

/**
 * The key→action table for the tab.
 *
 * A table rather than a switch so the binding can be asserted directly. Two letters per action,
 * the arrow/vi pair for movement, `y`/`n` for the answer, because this tab's whole thesis is that
 * an answer should cost one keystroke, and a player who has to reach for the mouse to dismiss three
 * cast rows is back inside the cost structure §1 measured.
 *
 * `Enter` is here and `Space` is not: Space scrolls the panel, and a scroll key that silently
 * applied a repair would be the worst possible collision on this surface.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const KEYMAP = Object.freeze({
    ArrowDown: 'next',
    j: 'next',
    ArrowUp: 'prev',
    k: 'prev',
    Enter: 'apply',
    y: 'apply',
    n: 'dismiss',
    Delete: 'dismiss',
    e: 'disclose',
    g: 'goto',
    u: 'undo',
});

/**
 * @param {string} key A `KeyboardEvent.key`.
 * @returns {string} The action, or '' when the tab does not claim that key.
 */
export function actionForKey(key) {
    return KEYMAP[String(key)] ?? '';
}

/**
 * The whole card, decided.
 *
 * One function so the DOM builder in `overlay-repairs.js` has no judgement left in it, and so the
 * test can assert the shape a cluster takes without a document: `clusterAsks` hands over
 * `{op, kind, members, key, count}` and this turns it into everything the card renders.
 *
 * Two keys per member, and why `identify` is a parameter.
 *
 * `ask.key` names the RECORD, in the owning tab's namespace, it is what `g` hands to
 * `open({ tab, focus })`. `askKey(ask)` names the QUESTION, and it is what `applyAsk` and
 * `dismissAsk` take. Applying one where the other belongs would answer the wrong question or none
 * at all, so both are carried. `askKey` itself lives in `repair-table.js`, which this module will
 * not import, it is the engine's, and importing it would put this file back out of reach of the
 * node tests, so it arrives as a function instead.
 *
 * @param {object} entry A cluster from `clusterAsks`, or a bare ask.
 * @param {object} [options] Options.
 * @param {(ask: object) => string} [options.identify] `askKey`, or the record key as a stand-in.
 * @returns {object} The view model.
 */
export function cardModel(entry, { identify = ask => String(ask?.key ?? '') } = {}) {
    const members = Array.isArray(entry?.members) && entry.members.length ? entry.members : [entry];
    const head = { ...members[0], ...entry, members };
    const op = String(head.op ?? '');
    const clustered = members.length > 1;
    const stamp = stampOf(clustered ? head : members[0]);
    const subject = subjectOf(head);

    return {
        key: String(entry?.key ?? entry?.kind ?? '') || op,
        op,
        kind: String(head.kind ?? ''),
        tone: toneOf(op),
        toneVar: toneVarOf(op),
        stamp,
        subject,
        clustered,
        count: members.length,
        // A cluster's evidence belongs to its members, one line each; a singleton's is the card's
        // own and is shown, never disclosed. §5: evidence is testimony, at full `--o-now`.
        evidence: clustered ? '' : String(members[0]?.evidence ?? ''),
        members: members.map(member => ({
            ask: member,
            key: String(member?.key ?? ''),
            askKey: identify(member),
            name: String(member?.name ?? ''),
            evidence: String(member?.evidence ?? ''),
            target: recordTarget(member),
        })),
        mechanism: mechanismOf(head),
        applyLabel: applyLabelOf(head),
        // A cluster jumps to its first member. There is no single record a group of three cast rows
        // is "about", and the first one is the one whose evidence the reader has already met.
        target: recordTarget(members[0]),
        // The accessible name, per §9: the stamp and the subject, so the verdict is announced as a
        // word before the record it is about.
        ariaLabel: `${stamp}: ${subject.map(part => part.text).join(' ')}`,
    };
}
