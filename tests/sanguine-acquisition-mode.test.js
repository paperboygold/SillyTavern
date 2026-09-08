import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ACQUISITIONS,
    BOUGHT,
    MONEY,
    acquisitionOf,
    creditsWithoutDebit,
    itemKey,
    validateInventory,
} from '../public/scripts/extensions/sanguine/state-table.js';
import { OWED_TURNS, askableOwed } from '../public/scripts/extensions/sanguine/review-table.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGUINE = path.join(HERE, '../public/scripts/extensions/sanguine');

/**
 * `state.js` reaches into SillyTavern's browser globals, so it cannot be imported here, the schema
 * assertions below read it as source, which is the same thing `cap:stale-hidden`'s deletion test
 * does two files over. Reading the text is enough for what is being asserted: that the enum offers
 * no escape hatch and that the field is required.
 * @returns {string} `state.js` as written.
 */
const stateSource = () => fs.readFileSync(path.join(SANGUINE, 'state.js'), 'utf8');

/*
 * The "what did this cost?" question, and the campaign that proved it wrong.
 *
 * Ground truth throughout is the live Wuxia World RPG chat of 2026-08-20, durable ledger
 * `cac4153c-cb00-4658-8616-2e561a8168d9`, replayed pass-by-pass through `creditsWithoutDebit`
 * itself rather than read off the panel. 38 goods credited, 30 of them in a delta where no money
 * moved at all; at pass granularity the trigger fired 17 times and exactly ONE of those seventeen
 * is a purchase. The other sixteen are the fixtures below.
 *
 * Corpus-wide (2316 traced passes, nine campaigns) the rule fired on 286 passes and 531 items, and
 * the model was asked to price every one. Its answers settle it: of 369 `[paid?]` asks that reached
 * a prompt, 244 came back with no answer row at all, 102 answered "nothing was paid", and 19 named
 * an amount, six of which are double-bills this codebase already documents.
 *
 * So the trigger no longer guesses the acquisition mode. Every case here replays a real turn.
 */
describe('how a thing arrived, read rather than inferred', () => {
    /*
     * The sixteen wrong firings, in the words the ledger stored, with the mode a reader of that
     * sentence gives. None of them is a purchase and none of them may raise the money question.
     */
    const CAMPAIGN = [
        { mid: 6, item: 'nine realms heavenly ascension technique', at: 'abilities', how: 'given', why: 'Ling Xiang taught Chí Guāngdé the first layer' },
        { mid: 64, item: 'basket', at: 'carried', how: 'found', why: 'finds the herbalist boy\'s basket' },
        { mid: 64, item: 'scrap of blue cloth', at: 'carried', how: 'found', why: 'a scrap of blue cloth, and a note' },
        { mid: 65, item: 'wolf hide', at: 'carried', how: 'made', why: 'butchered the two wolves, obtaining hides' },
        { mid: 65, item: 'wolf meat', at: 'carried', how: 'made', why: 'obtaining hides, meat, and a small dull stone' },
        { mid: 68, item: 'beast core', at: 'carried', how: 'made', why: 'butchered the wolves, extracting a low-grade beast core' },
        { mid: 72, item: 'vine rope', at: 'carried', how: 'found', why: 'tied the wounded boy to himself with a vine rope' },
        { mid: 112, item: 'artifact fragment', at: 'carried', how: 'taken', why: 'searches the dead man and retrieves' },
        { mid: 112, item: 'map of the northern woods', at: 'carried', how: 'taken', why: 'searches the dead man and retrieves' },
        { mid: 116, item: 'short blade', at: 'carried', how: 'taken', why: 'takes the short blade from the dead man' },
        { mid: 130, item: 'coin pouch', at: 'carried', how: 'given', why: '王大夫 gives him a pouch of coins to pay Liú Sān' },
        { mid: 134, item: 'pouch', at: 'carried', how: 'given', why: '刘三 accepts the pouch' },
        { mid: 141, item: 'token', at: 'carried', how: 'found', why: 'opens the pouch, revealing silver and a token' },
        { mid: 208, item: 'wooden token', at: 'carried', how: 'given', why: 'registered for the trial, giving his name' },
        { mid: 217, item: 'spear', at: 'carried', how: 'taken', why: 'selects a spear from the weapon rack for the arena' },
        { mid: 239, item: 'iron sword', at: 'carried', how: 'taken', why: 'sheathed his spear and DREW his iron sword' },
    ];

    test('every one of the sixteen wrong firings goes quiet', () => {
        for (const row of CAMPAIGN) {
            const accepted = [{ item: row.item, dq: 1, at: row.at, how: row.how }];
            expect({ mid: row.mid, item: row.item, owed: creditsWithoutDebit({ accepted }) })
                .toEqual({ mid: row.mid, item: row.item, owed: [] });
        }
        expect(CAMPAIGN).toHaveLength(16);
    });

    test('and the word is the WHOLE of the difference, swap it and every one fires again', () => {
        // These rows are otherwise the trigger's textbook shape: a positive dq, an ordinary place,
        // no money anywhere. Under the old rule that was the entire test, which is why all sixteen
        // fired. Re-labelled `bought` they fire again, unchanged in every other respect, so this
        // is the campaign proving that the acquisition mode, and nothing else, is what was missing.
        // The taught technique is the one exception, and for a reason that predates this field: a
        // capability is filed at `abilities`, which was never buyable and is excluded regardless.
        const carried = CAMPAIGN.filter(row => row.at === 'carried');
        for (const row of carried) {
            expect(creditsWithoutDebit({ accepted: [{ item: row.item, dq: 1, at: row.at, how: BOUGHT }] }))
                .toEqual([row.item]);
        }
        expect(carried).toHaveLength(15);
    });

    test('the one genuine purchase in seventeen passes still asks, mid 96', () => {
        // "Chí Guāngdé buys a bedroll, ground sheet, rope, and fishing line from the market vendor."
        // The money row for it landed three passes earlier at mid 93, so this pass moves no money
        // and the question is exactly right to fire.
        expect(creditsWithoutDebit({
            accepted: [
                { item: 'bedroll and ground sheet', dq: 1, how: BOUGHT },
                { item: 'rope', dq: 1, how: BOUGHT },
                { item: 'fishing line', dq: 1, how: BOUGHT },
            ],
        })).toEqual(['bedroll and ground sheet', 'rope', 'fishing line']);
    });

    test('a purchase that DID record its payment asks nothing, mid 85', () => {
        // "bought a spear for three taels": the money row is present, so there is nothing to ask
        // even though the model called it a purchase. The debit test still comes first.
        expect(creditsWithoutDebit({
            accepted: [{ item: 'spear', dq: 1, how: BOUGHT }, { item: 'silver', dq: -3, at: MONEY }],
        })).toEqual([]);
    });
});

/*
 * The two traps this project has already walked into.
 *
 * `moves: []` came back 107/107 and `drive_size: 0` came back 288/288, both because an empty answer
 * was legal and cost nothing. And a default that is wrong in the majority case is worse than no
 * default: `bought` as the fallback would take a rule that was wrong 95% of the time and make it
 * wrong every time.
 */
describe('no free skip, and no wrong default', () => {
    test('the enum offers no empty and no "other", every member names a real arrival', () => {
        expect(ACQUISITIONS).toEqual([BOUGHT, 'given', 'found', 'taken', 'made', 'lost']);
        expect(ACQUISITIONS).not.toContain('');
        expect(ACQUISITIONS).not.toContain('other');
        expect(ACQUISITIONS).not.toContain('unknown');
        // And the schema offers exactly that list, rather than a hand-written copy that can drift.
        expect(stateSource()).toContain('enum: ACQUISITIONS');
    });

    test('the field is required, so strict mode cannot let it be omitted', () => {
        // Strict structured output demands every property in `required`; a field the model may skip
        // is the shape `moves: []` had.
        expect(stateSource()).toContain('\'magnitude\', \'at\', \'how\', \'rank\', \'who\'');
    });

    test('an entry fold was never told about is NOT a purchase', () => {
        // The status-block path, a hand-authored delta, and every ledger written before the field
        // existed all arrive with no `how` at all. Each of them must go quiet, not become a bill.
        expect(creditsWithoutDebit({ accepted: [{ item: 'brass key', dq: 1 }] })).toEqual([]);
        expect(creditsWithoutDebit({ accepted: [{ item: 'brass key', dq: 1, how: '' }] })).toEqual([]);
        expect(creditsWithoutDebit({ accepted: [{ item: 'brass key', dq: 1, how: 'purchased' }] })).toEqual([]);
    });

    test('"lost" on a gain is a contradiction, not an answer, and is discarded either way', () => {
        // The shape a free-skip answer would take: the model filling the field with the member that
        // describes no arrival while `dq` says something arrived. Believing it would be harmless
        // here and dangerous in the ledger, so `acquisitionOf` refuses to record it.
        expect(acquisitionOf({ how: 'lost' }, 1)).toBe('');
        expect(acquisitionOf({ how: BOUGHT }, 1)).toBe(BOUGHT);
        expect(acquisitionOf({ how: BOUGHT }, -1)).toBe('');
        expect(acquisitionOf({ how: 'FOUND' }, 2)).toBe('found');
    });

    test('the instruction names the common answers so that none of them is the hard choice', () => {
        // The measured failure of `moves` was that the safe answer was also the empty one. Here the
        // three commonest real modes are spelled out in the prose block as well as the schema, and
        // the narrow member is the one carrying the warning.
        const said = stateSource();
        for (const word of ['found', 'taken', 'given', 'made', 'lost']) {
            expect(said).toContain(`"${word}"`);
        }
        expect(said).toContain('only when the excerpt shows it being paid for');
    });
});

/*
 * The refusal branch, which had no gates at all.
 *
 * `already-recorded` pushed any refused item name into the question without the place exclusion or
 * the sign test the accepted branch has applied since it was written. Two of the corpus's
 * longest-lived questions are that hole.
 */
describe('a refused credit faces the same gates as an accepted one', () => {
    test('the currency itself can no longer be offered back as an unpaid acquisition', () => {
        // Solo Leveling asked "won, darkwood staff, shortsword, bracers, greaves, gloves, trauma
        // kit, coagulant" for ten passes running. `won` is the money row, excluded four lines above
        // in the accepted branch and readmitted here.
        expect(creditsWithoutDebit({
            accepted: [],
            refused: [{ item: 'won', reason: 'already-recorded', raw: { item: 'won', dq: 680000, at: MONEY, how: BOUGHT } }],
        })).toEqual([]);
    });

    test('a taught technique can no longer be offered back either', () => {
        // Wuxia asked "nine realms heavenly ascension technique, silver wen" for seven passes.
        expect(creditsWithoutDebit({
            accepted: [],
            refused: [{ item: 'nine realms heavenly ascension technique', reason: 'already-recorded', raw: { dq: 1, at: 'abilities', how: BOUGHT } }],
        })).toEqual([]);
    });

    test('a refused DEBIT is not an unpaid purchase', () => {
        // The Time Stop double-bills refuse `silver -10` as `already-recorded`. A refused loss is
        // the gate working, and reading it as an acquisition inverts its meaning.
        expect(creditsWithoutDebit({
            accepted: [],
            refused: [{ item: 'silver', reason: 'already-recorded', raw: { dq: -10, at: MONEY } }],
        })).toEqual([]);
    });

    test('but the re-bought bracers still come through', () => {
        expect(creditsWithoutDebit({
            accepted: [],
            refused: [{ item: 'mana-shackle bracers', reason: 'already-recorded', raw: { dq: 1, how: BOUGHT } }],
        })).toEqual(['mana-shackle bracers']);
    });
});

/*
 * The mode has to survive the write, or the trigger reads nothing.
 */
describe('validateInventory carries the mode onto the accepted row', () => {
    const base = {
        inv: new Map(),
        windowText: 'he butchered the two wolves, obtaining hides, meat, and a small dull stone',
        mentioned: null,
    };

    test('a gain keeps the word the model gave it', () => {
        const { accepted } = validateInventory({ ...base, deltas: [{ item: 'wolf hide', dq: 2, how: 'made' }] });
        expect(accepted).toEqual([{ item: 'wolf hide', dq: 2, how: 'made' }]);
    });

    test('a loss carries no mode, because there is no arrival to describe', () => {
        const { accepted } = validateInventory({
            inv: new Map([[itemKey('wolf hide', 'carried', ''), { qty: 2 }]]),
            windowText: 'he traded away both wolf hides',
            deltas: [{ item: 'wolf hide', dq: -2, how: 'lost' }],
        });
        expect(accepted).toEqual([{ item: 'wolf hide', dq: -2 }]);
    });

    test('a restated total carries no mode either', () => {
        const { accepted } = validateInventory({
            ...base,
            windowText: 'he counts eleven arrows',
            deltas: [{ item: 'arrows', dq: 0, set: 11, how: BOUGHT }],
        });
        expect(accepted).toEqual([{ item: 'arrows', set: 11 }]);
    });

    test('the write and the trigger agree end to end, the one purchase, then the sixteen finds', () => {
        // The whole path in one: proposals in, accepted rows out, question raised off those rows.
        const bought = validateInventory({
            ...base,
            windowText: 'he buys a bedroll, ground sheet, rope, and fishing line from the market vendor',
            deltas: [{ item: 'bedroll', dq: 1, how: BOUGHT }, { item: 'fishing line', dq: 1, how: BOUGHT }],
        });
        expect(creditsWithoutDebit({ accepted: bought.accepted })).toEqual(['bedroll', 'fishing line']);

        const looted = validateInventory({
            ...base,
            windowText: 'he searches the dead man and retrieves an artifact fragment and a letter',
            deltas: [{ item: 'artifact fragment', dq: 1, how: 'taken' }, { item: 'letter', dq: 1, how: 'taken' }],
        });
        expect(looted.accepted).toHaveLength(2);
        expect(creditsWithoutDebit({ accepted: looted.accepted })).toEqual([]);
    });
});

/*
 * A question nobody can answer must stop being asked.
 *
 * 244 of the 369 asks in the corpus came back with no answer row at all: the model was being asked
 * to price items whose excerpt had scrolled out of the window. An unanswered question is never
 * cleared, `applyMoney` returns before `clearOwed` when no answer arrives, so it sat in the block
 * and was re-posed, accreting new items up to the cap of eight.
 */
describe('the money question expires, because the evidence does', () => {
    const raised = { items: ['bedroll', 'rope'], balance: 12, currency: 'silver', turn: 40 };

    test('asked on the pass right after it is raised, which is 94% of the answered ones', () => {
        expect(askableOwed(raised, 40)).toBe(raised);
        expect(askableOwed(raised, 41)).toBe(raised);
    });

    test('and at the far edge of the measured distribution, which covers 97%', () => {
        expect(askableOwed(raised, 42)).toBe(raised);
    });

    test('but the `torch` case, eleven passes over ten turns, is over', () => {
        expect(askableOwed(raised, 43)).toBeNull();
        expect(askableOwed(raised, 50)).toBeNull();
    });

    test('a record written before the stamp existed is fresh, not destroyed', () => {
        // The fail-open every horizon in this codebase takes: a bound that erases data on a missing
        // field is a bound that erases data during an upgrade.
        const old = { items: ['bedroll'], balance: 12, currency: 'silver' };
        expect(askableOwed(old, 900)).toBe(old);
    });

    test('nothing owed is nothing to ask, at any age', () => {
        expect(askableOwed(null, 3)).toBeNull();
        expect(askableOwed({ items: [], turn: 3 }, 3)).toBeNull();
    });

    test('two turns, and the number comes from the distribution rather than from taste', () => {
        expect(OWED_TURNS).toBe(2);
    });
});
