import { describe, expect, test } from '@jest/globals';

import {
    ABILITIES,
    CARRIED,
    MAX_REFUSED,
    MONEY,
    RECORDED_HORIZON,
    REFUSED_TURNS,
    itemKey,
    keepRefused,
    recentlyRecorded,
    refusedDebits,
    renderLedger,
    renderRefused,
    validateInventory,
} from '../public/scripts/extensions/sanguine/state-table.js';

/**
 * sanguine-counted-block: the two things the pinned block never told the model.
 *
 * The measurement this file exists to hold.
 *
 * Live chat `data/default-user/extensions/sanguine-traces/Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`,
 * 149 traced extraction passes over a 286-message campaign. Its counters at the end of play:
 *
 *   reject:already-recorded   22
 *   reject:remove-unknown     17
 *   reject:not-mentioned      13
 *
 * Replaying every `parsed.events[].delta.inv` in that trace through the real `validateInventory`:
 * state folded forward from the accepted deltas, `shown` from `renderLedger`, `visible` from the
 * mids each prompt's transcript actually contained, recovers 21 of the 22 and 13 of the 17 (the
 * remainder are `parts` entries, which take the same reason through a different validator). Every
 * fixture below is copied out of that replay; none of it is invented, and the whole point of the
 * numbers in the comments is that a later reader can go and check them.
 *
 * What the traces prove about `already-recorded`, which is not what was assumed.
 *
 * The premise `extract.js` states for the pinned ledger is that a model shown its own record has no
 * reason to re-report it. Measured: in 21 of 21 recoverable refusals the item WAS on the block, in
 * full, printed by `renderLedger`: `shown.has(key)` was true every single time. So the block was
 * never failing to show the item. What it never showed is WHICH MESSAGE PAID FOR IT, and that is
 * the fact the refusals turn on, because the gate itself refuses only when the beat that recorded
 * the row is still on screen (`validateInventory`, the `reTold` condition).
 *
 * Six of the refusals are the sharpest form of it, fold billed the INTENTION and refused the
 * completion:
 *
 *   turn 46, mids 83-88   mid 85 is the haggle ("I take out the three silver as if it were already
 *                         sorted"); fold records `spear +1` and `silver -3` there. Mids 86-88 are
 *                         the stall owner actually handing the spear over and taking the coins. The
 *                         model reports the sale it just watched happen. Both halves refuse.
 *   turn 91-93, mids 167-174   赵老爷 counts out forty taels at mid 170 and holds out his palm;
 *                         fold records `silver +40`. The exchange happens at 172. The model reports
 *                         it at 172, at 173 and again at 174, and each time the credit refuses
 *                         `already-recorded` while the matching `fragment -1` refuses
 *                         `remove-unknown`.
 *
 * `recentlyRecorded` + the `(counted)` marker is the answer to exactly that: fold's own arithmetic
 *, a contributor mid against the high-water mark, printed where the model reads it.
 *
 * And what they prove about `remove-unknown`, which is not the docblock's claim either.
 *
 * `validateInventory`'s own docblock says a double-bill drains a balance so the next debit presents
 * as `remove-unknown`, "a symptom of the corruption, not a separate defect". In THIS campaign that
 * causal link does not hold: not one of the thirteen is a debit against a row a double-bill emptied.
 * Checked against the pinned block each pass really carried, twelve of the thirteen would refuse in
 * production too, and they are:
 *
 *   `copper -500` x3 (turns 95, 96, 97)   one inn bill, re-told three passes running
 *   `copper -1`   x2 (turns 79, 146)      the ledger holds `silver` and has never held a copper row
 *   `coppers -500`   (turn 96)            counted in the three above
 *   `tael -15`       (turn 142)           the UNIT, against a ledger that holds `silver`
 *   `money -2`       (turn 48)            the generic word, same ledger
 *   `fragment -1` x3 (turns 91, 92, 93)   the sale had ALREADY been recorded; `artifact fragment`
 *                                         left the block between turn 90 and turn 91, and money went
 *                                         15 -> 55. Three re-tells of a completed transaction.
 *   `herb basket -1`, `vine herb -1` (turn 40)   the ledger holds `basket` and `dried herbs`
 *
 * Every one of the eight name mismatches sent `same_as: ""`. The channel exists, `deltaInstruction`
 * describes it, and it was simply not used, because nothing ever told the model the name it chose
 * had matched nothing. That is what `refusedDebits`/`renderRefused` close.
 *
 * What is NOT tested here, because it is not in these files.
 *
 * The turn-64 pass read TWENTY-FOUR messages instead of six: mid went backward (122 -> 120, a
 * swipe), `resolveMark` could not find the mark's content key, and `splitWindow` fell back to
 * `FIRST_WINDOW`. Seven of the 21 refusals come from that one pass, six of them beyond any honest
 * horizon. The tests below assert that the marker does NOT reach them, so the limit is recorded
 * rather than hoped away; the repair belongs to `extract-table.js`.
 */

/**
 * Every `already-recorded` the replay recovered, with the two numbers the marker turns on.
 *
 * `mark` is the previous pass's anchor, the high-water mark `buildWindow` split that pass's window
 * on, and the value `state.extractMark().mid` returns when `ledgerBlock` runs. `trail` is the
 * contributor mids `deriveState` had on the row at that moment.
 */
const REFUSALS = [
    { turn: 36, mark: 65, item: 'small dull stone', at: CARRIED, dq: 1, trail: [65] },
    { turn: 44, mark: 82, item: 'silver', at: MONEY, dq: 20, trail: [80] },
    { turn: 44, mark: 82, item: 'wound medicine', at: CARRIED, dq: 1, trail: [80] },
    { turn: 46, mark: 85, item: 'silver', at: MONEY, dq: -3, trail: [80, 85] },
    { turn: 46, mark: 85, item: 'spear', at: CARRIED, dq: 1, trail: [85] },
    { turn: 50, mark: 93, item: 'bedroll and ground sheet', at: CARRIED, dq: 1, trail: [93] },
    { turn: 50, mark: 93, item: 'rope', at: CARRIED, dq: 1, trail: [93] },
    { turn: 50, mark: 93, item: 'fishing line', at: CARRIED, dq: 1, trail: [93] },
    { turn: 61, mark: 116, item: 'short blade', at: CARRIED, dq: 1, trail: [116] },
    // The swipe pass. Seven refusals, one window of twenty-four messages, one lost mark.
    { turn: 64, mark: 122, item: 'artifact fragment', at: CARRIED, dq: 1, trail: [112], swipe: true },
    { turn: 64, mark: 122, item: 'map of the northern woods', at: CARRIED, dq: 1, trail: [112], swipe: true },
    { turn: 64, mark: 122, item: 'letter', at: CARRIED, dq: 1, trail: [112], swipe: true },
    { turn: 64, mark: 122, item: 'short blade', at: CARRIED, dq: 1, trail: [116], swipe: true },
    { turn: 64, mark: 122, item: 'artifact fragment', at: CARRIED, dq: 1, trail: [112], swipe: true },
    { turn: 64, mark: 122, item: 'map of the northern woods', at: CARRIED, dq: 1, trail: [112], swipe: true },
    { turn: 64, mark: 122, item: 'letter', at: CARRIED, dq: 1, trail: [112], swipe: true },
    // The fragment sale, billed at the offer and re-reported at the handover, three passes running.
    { turn: 91, mark: 170, item: 'silver', at: MONEY, dq: 40, trail: [80, 85, 93, 170] },
    { turn: 92, mark: 172, item: 'silver', at: MONEY, dq: 40, trail: [80, 85, 93, 170] },
    { turn: 93, mark: 173, item: 'silver', at: MONEY, dq: 40, trail: [80, 85, 93, 170] },
    { turn: 116, mark: 217, item: 'spear', at: CARRIED, dq: 1, trail: [85, 217] },
    { turn: 147, mark: 279, item: 'silver', at: MONEY, dq: -15, trail: [80, 85, 93, 170, 273, 279, 279] },
];

/** The contributor trail as `deriveState` builds it: one entry per accepted delta, carrying its mid. */
const trailFor = row => new Map([[itemKey(row.item, row.at), row.trail.map((mid, at) => ({ at, dq: row.dq, summary: '', mid }))]]);

/** Whether the marker should reach a refusal, from the two numbers alone. */
const covered = row => row.mark - Math.max(...row.trail) <= RECORDED_HORIZON;

describe('the marker reaches the refusals the traces actually recorded', () => {
    test('every one of the 21 is a row the block had already printed', () => {
        // This is the finding, and it is what rules out "the model cannot see it" as the cause. The
        // replay recorded `shown.has(key)` at the moment of each refusal; it was true 21 times out
        // of 21. The fixture carries the outcome rather than the boolean, so the claim is that
        // every `item` below is a name the pinned block of that pass contained, which is checkable
        // against the `Already recorded` section of each prompt in the trace.
        expect(REFUSALS).toHaveLength(21);
        expect(REFUSALS.every(row => row.item && row.trail.length)).toBe(true);
    });

    test('fifteen of the twenty-one carry (counted), and the six misses are all one swiped pass', () => {
        const marked = REFUSALS.filter(row => recentlyRecorded(trailFor(row), row.mark).has(itemKey(row.item, row.at)));
        const missed = REFUSALS.filter(row => !recentlyRecorded(trailFor(row), row.mark).has(itemKey(row.item, row.at)));

        expect(marked).toHaveLength(15);
        expect(missed).toHaveLength(6);
        // Not "most of them are", all of them, and from the single pass whose window was four
        // times the size it should have been. A horizon wide enough to catch these would be lying
        // about the 143 passes that read six messages.
        expect(missed.every(row => row.swipe)).toBe(true);
        expect(new Set(missed.map(row => row.turn))).toEqual(new Set([64]));
    });

    test('the horizon is the window, so a beat one message past it is not claimed', () => {
        const trail = new Map([['carried spear', [{ dq: 1, mid: 100 }]]]);
        expect(recentlyRecorded(trail, 100 + RECORDED_HORIZON).has('carried spear')).toBe(true);
        expect(recentlyRecorded(trail, 100 + RECORDED_HORIZON + 1).has('carried spear')).toBe(false);
    });

    test('a row whose newest contributor is fresh is marked even when its trail is long', () => {
        // Turn 147's silver has seven contributors going back to mid 80. What decides is the newest.
        const row = REFUSALS.at(-1);
        expect(row.trail).toHaveLength(7);
        expect(covered(row)).toBe(true);
        expect(recentlyRecorded(trailFor(row), row.mark).has(itemKey('silver', MONEY))).toBe(true);
    });

    test('no mark and no trail mean no claim, rather than a claim about everything', () => {
        const trail = new Map([['carried spear', [{ dq: 1, mid: 100 }]]]);
        // Before the first successful pass `extractMark().mid` is NaN. A block that marked every row
        // then would be asserting a beat the model has never been shown.
        expect(recentlyRecorded(trail, Number.NaN).size).toBe(0);
        expect(recentlyRecorded(null, 100).size).toBe(0);
        // A row folded from an event with no mid, a hand edit, a migrated ledger, is never marked.
        expect(recentlyRecorded(new Map([['carried spear', [{ dq: 1, mid: null }]]]), 100).size).toBe(0);
    });
});

/**
 * The pinned block of turn 46 as the trace carries it, verbatim:
 *
 *   Abilities: nine realms heavenly ascension technique
 *   Money: 17 silver
 *   Carrying: scrap of blue cloth, note, knife, wolf hide x2, wolf meat, small dull stone,
 *             wound medicine, spear
 *
 * The spear and the silver are the two rows mid 85 wrote; everything else is older. That is the
 * whole point of marking per ROW, eight of the ten lines are not what the model is looking at.
 */
const TURN46 = {
    inv: new Map([
        [itemKey('silver', MONEY), { qty: 17 }],
        [itemKey('scrap of blue cloth', CARRIED), { qty: 1 }],
        [itemKey('note', CARRIED), { qty: 1 }],
        [itemKey('knife', CARRIED), { qty: 1 }],
        [itemKey('wolf hide', CARRIED), { qty: 2 }],
        [itemKey('wolf meat', CARRIED), { qty: 1 }],
        [itemKey('small dull stone', CARRIED), { qty: 1 }],
        [itemKey('wound medicine', CARRIED), { qty: 1 }],
        [itemKey('spear', CARRIED), { qty: 1 }],
    ]),
    abilities: new Map([[itemKey('nine realms heavenly ascension technique', ABILITIES), { qty: 1, name: 'nine realms heavenly ascension technique' }]]),
    contributors: new Map([
        [itemKey('silver', MONEY), [{ at: 1, dq: 20, mid: 80 }, { at: 2, dq: -3, mid: 85 }]],
        [itemKey('spear', CARRIED), [{ at: 3, dq: 1, mid: 85 }]],
        [itemKey('wound medicine', CARRIED), [{ at: 4, dq: 1, mid: 80 }]],
        [itemKey('small dull stone', CARRIED), [{ at: 5, dq: 1, mid: 65 }]],
    ]),
    mark: 85,
    seen: new Set([83, 84, 85, 86, 87, 88]),
};

describe('what the block says, and what it still refuses', () => {
    const render = counted => renderLedger({
        inv: TURN46.inv,
        vitals: new Map(),
        marks: new Map(),
        abilities: TURN46.abilities,
        counted,
    });

    test('the two rows mid 85 wrote are marked and the other seven are not', () => {
        const counted = recentlyRecorded(TURN46.contributors, TURN46.mark);
        const { lines, counted: marked } = render(counted);
        const carrying = lines.find(line => line.startsWith('Carrying: '));

        expect(lines.find(line => line.startsWith('Money: '))).toBe('Money: 17 silver (counted)');
        expect(carrying).toContain('spear (counted)');
        // Wound medicine was recorded at mid 80, five back of the mark, so it is inside the window
        // and marked too, which is correct and is exactly the turn-44 refusal one pass earlier.
        expect(carrying).toContain('wound medicine (counted)');
        // The stone came from mid 65, twenty messages back. Nothing about it is on screen.
        expect(carrying).toContain('small dull stone,');
        expect(carrying).not.toContain('small dull stone (counted)');
        expect(carrying).not.toContain('knife (counted)');
        expect(marked).toBe(3);
    });

    test('the legend rides only when something wears the marker', () => {
        const { lines } = render(recentlyRecorded(TURN46.contributors, TURN46.mark));
        expect(lines.at(-1)).toContain('A line marked (counted)');
        expect(lines.at(-1)).toContain('Never report it as gained or lost again');

        // A pass whose ledger has nothing fresh in it pays nothing for a notation it does not use.
        const quiet = render(recentlyRecorded(TURN46.contributors, 200));
        expect(quiet.counted).toBe(0);
        expect(quiet.lines.some(line => line.includes('(counted)'))).toBe(false);
    });

    test('a null counted renders the block exactly as it rendered before', () => {
        // The judge's block passes null (`ledgerBlock({ask: false})`), and every existing caller and
        // test reads this shape. Byte-identical, not merely equivalent.
        const before = render(null);
        expect(before.lines).toEqual([
            'Abilities: nine realms heavenly ascension technique',
            'Money: 17 silver',
            'Carrying: scrap of blue cloth, note, knife, wolf hide x2, wolf meat, small dull stone, wound medicine, spear',
        ]);
        expect(before.counted).toBe(0);
        expect(before.shown.has(itemKey('spear', CARRIED))).toBe(true);
        expect(before.shown.has(itemKey('nine realms heavenly ascension technique', ABILITIES))).toBe(true);
    });

    test('a capability takes the marker too, because a re-granted technique is the same shape', () => {
        const counted = new Set([itemKey('nine realms heavenly ascension technique', ABILITIES)]);
        const { lines } = render(counted);
        expect(lines[0]).toBe('Abilities: nine realms heavenly ascension technique (counted)');
    });

    test('the gate is untouched: turn 46 still refuses both halves of the re-told purchase', () => {
        // The marker is a rendering change. If it were doing the refusing, this would go green for
        // the wrong reason, so the two proposals the trace really carried are run through the real
        // validator with the real window, and must still be refused for the reason they were.
        const outcome = validateInventory({
            inv: TURN46.inv,
            deltas: [
                { item: 'silver', at: 'money', dq: -3, set: 0, same_as: '' },
                { item: 'spear', at: 'carried', dq: 1, set: 0, same_as: '' },
            ],
            windowText: 'He lifts the spear off the rack and hands it to you, hilt-first. As you pass him the silver, he leans in slightly.',
            shown: renderLedger({ inv: TURN46.inv, vitals: new Map(), marks: new Map(), abilities: TURN46.abilities, counted: recentlyRecorded(TURN46.contributors, TURN46.mark) }).shown,
            mentioned: new Set(['spear', 'silver']),
            contributors: TURN46.contributors,
            visible: TURN46.seen,
        });
        expect(outcome.accepted).toEqual([]);
        expect(outcome.rejected.map(row => row.reason)).toEqual(['already-recorded', 'already-recorded']);
    });
});

/** The `remove-unknown` refusals as `validateInventory` produced them, straight from the replay. */
const COPPER = turn => ({ item: 'copper', reason: 'remove-unknown', raw: { item: 'copper', at: 'money', dq: -500, set: 0, same_as: '' }, turn });
const FRAGMENT = { item: 'fragment', reason: 'remove-unknown', raw: { item: 'fragment', at: 'carried', dq: -1, set: 0, same_as: '' } };
const HERB_BASKET = { item: 'herb basket', reason: 'remove-unknown', raw: { item: 'herb basket', at: 'carried', dq: -1, set: 0, same_as: '' } };
const TAEL = { item: 'tael', reason: 'remove-unknown', raw: { item: 'tael', at: 'money', dq: -15, set: 0, same_as: '' } };

describe('the refusal the model was never told about', () => {
    test('only a debit qualifies, and a component refusal is not one', () => {
        const rows = refusedDebits([
            FRAGMENT,
            // `validateDelta`'s component loop takes the same reason with the component's NAME as
            // `raw`. No `dq`, so it is filtered by the shape rather than by a special case.
            { item: 'longsword', reason: 'remove-unknown', raw: 'flame rune' },
            // A credit is never this refusal, and a rejection for any other reason is not ours.
            { item: 'spear', reason: 'already-recorded', raw: { item: 'spear', dq: 1 } },
            { item: 'copper', reason: 'no-change', raw: { item: 'copper', at: 'money', dq: 0 } },
        ], 91);
        expect(rows).toEqual([{ key: itemKey('fragment', CARRIED), name: 'fragment', at: CARRIED, turn: 91 }]);
    });

    test('one inn bill refused three passes running is one line, stamped with the newest turn', () => {
        // Turns 95, 96 and 97 of the live chat: `copper -500`, `coppers -500`, `copper -500`. The
        // second wording opens its own row on purpose, it is a different name and fold does not
        // decide that two names are one, but the repeat of the same name does not.
        let kept = keepRefused(new Map(), refusedDebits([COPPER(95)], 95));
        kept = keepRefused(kept, refusedDebits([COPPER(96)], 96));
        kept = keepRefused(kept, refusedDebits([COPPER(97)], 97));
        expect(kept.size).toBe(1);
        expect([...kept.values()][0]).toEqual({ key: itemKey('copper', MONEY), name: 'copper', at: MONEY, turn: 97 });
    });

    test('the cap keeps the newest, because an old refusal has already had its pass', () => {
        const rows = Array.from({ length: MAX_REFUSED + 3 }, (_, at) => ({
            item: `thing ${at}`, reason: 'remove-unknown', raw: { item: `thing ${at}`, at: 'carried', dq: -1 },
        }));
        const kept = rows.reduce((table, row, at) => keepRefused(table, refusedDebits([row], at)), new Map());
        expect(kept.size).toBe(MAX_REFUSED);
        expect([...kept.values()].map(row => row.turn)).toEqual([6, 5, 4, 3]);
    });

    test('the note names the wording and the place, and never guesses which row was meant', () => {
        const kept = keepRefused(new Map(), refusedDebits([FRAGMENT, TAEL, HERB_BASKET], 91));
        const note = renderRefused(kept, 91);

        expect(note).toContain('"fragment" (carried)');
        expect(note).toContain('"tael" (money)');
        expect(note).toContain('"herb basket" (carried)');
        expect(note).toContain('same_as');
        // Fold holds `silver` and `artifact fragment` and `basket`. Naming one of them here would be
        // fold doing the record linkage it refuses to do anywhere else, and `tael`/`silver` is a
        // merge while `copper`/`silver` is not, on identical evidence.
        expect(note).not.toContain('artifact fragment');
        expect(note).not.toContain('silver');
        // And never the amount: a model handed "your 15 was refused" re-sends 15 at whatever row it
        // settles on. The ask is about the NAME.
        expect(note).not.toContain('15');
        expect(note).not.toContain('-1');
    });

    test('it clears itself after a pass, without a renderer that deletes what it prints', () => {
        const kept = keepRefused(new Map(), refusedDebits([FRAGMENT], 91));
        expect(renderRefused(kept, 91)).toContain('"fragment"');
        expect(renderRefused(kept, 91 + REFUSED_TURNS - 1)).toContain('"fragment"');
        expect(renderRefused(kept, 91 + REFUSED_TURNS)).toBe('');
        // `ledgerBlock` has two callers and the judge's is `ask: false`. A destructive read would
        // mean whichever ran first ate the note.
        expect(renderRefused(kept, 91)).toBe(renderRefused(kept, 91));
        expect(renderRefused(new Map(), 91)).toBe('');
    });
});

describe('the gate the note asks the model to answer is not weakened by asking', () => {
    // Turn 40's ledger, from the prompt: `Carrying: basket, dried herbs, scrap of blue cloth, …`.
    const inv = new Map([
        [itemKey('basket', CARRIED), { qty: 1 }],
        [itemKey('dried herbs', CARRIED), { qty: 1 }],
    ]);
    const windowText = 'Chí Guāngdé handed over the herb basket and the vine herb to Dr. Wáng.';
    const mentioned = new Set(['herb basket', 'vine herb']);

    test('the unmatched name is refused exactly as it was', () => {
        const outcome = validateInventory({
            inv, deltas: [{ item: 'herb basket', at: 'carried', dq: -1, set: 0, same_as: '' }],
            windowText, mentioned,
        });
        expect(outcome.accepted).toEqual([]);
        expect(outcome.rejected.map(row => row.reason)).toEqual(['remove-unknown']);
    });

    test('and the same debit lands once the model answers with the block\'s own wording', () => {
        // This is what the note is for. `same_as` is the model's identity claim and `canonicalItemName`
        // resolves it against a held key, fold merged on the model's word, never on the spelling.
        const outcome = validateInventory({
            inv, deltas: [{ item: 'herb basket', at: 'carried', dq: -1, set: 0, same_as: 'basket' }],
            windowText, mentioned,
        });
        expect(outcome.rejected).toEqual([]);
        expect(outcome.accepted).toEqual([{ item: 'basket', dq: -1 }]);
    });

    test('a same_as that still matches nothing is still refused, which is the last clause of the note', () => {
        const outcome = validateInventory({
            inv, deltas: [{ item: 'copper', at: 'money', dq: -500, set: 0, same_as: 'coppers' }],
            windowText: 'He paid 500 copper for the room.', mentioned: new Set(['copper']),
        });
        expect(outcome.accepted).toEqual([]);
        expect(outcome.rejected.map(row => row.reason)).toEqual(['remove-unknown']);
    });
});
