import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAX_ITEM_LINES,
    MAX_MARK_LINES,
    MAX_QUESTIONS,
    SHEET_KINDS,
    SHEET_TEMPO,
    STILL,
    STILL_A_THING,
    describePlan,
    isTouched,
    outstanding,
    pairKey,
    planReview,
    reviewBlock,
    reviewSchema,
    resolveCurrencyKey,
    reviewableWindow,
    suspectedPairs,
} from '../public/scripts/extensions/fold/review-table.js';
import {
    CLOSED,
    DOOM,
    MOOT,
    PROGRESS,
    THREAD_STALE,
    foldThread,
    mergeThreads,
    overlayClosures,
    threads,
    threadsByKind,
} from '../public/scripts/extensions/fold/thread-table.js';
import {
    PERSON,
    entityKey,
    foldEntity,
    mergeEntities,
} from '../public/scripts/extensions/fold/entity-table.js';
import {
    CONTEST_AT,
    MONEY,
    contestsOf,
    creditsWithoutDebit,
    deriveState,
    markKey,
    foldContest,
    itemKey,
    validateInventory,
} from '../public/scripts/extensions/fold/state-table.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FOLD = path.join(HERE, '../public/scripts/extensions/fold');

/*
 * Phase C — everything can close.
 *
 * The centre of the redesign: extraction becomes review. Every fixture below is built from the real
 * Solo Leveling chat, either from the ledger copy or from the pre-repair2 header the second hand
 * repair overwrote, because the standing rule is that ground truth is the log and not this file —
 * two defects in this codebase had passing tests over them.
 *
 * Every LLM-dependent step is driven by a CANNED answer at the pure layer. That is the honest shape
 * for a mechanism whose other half is a language model: the code decides what to ask and what an
 * answer means, and the fixture supplies what the model would have said.
 */

/**
 * The four thread rows the pre-repair2 header actually held, verbatim from `solo-leveling.backup2`.
 *
 * Written through `foldThread` rather than `foldThreads`, deliberately: these are STORED rows being
 * restored, not fresh proposals, and `foldThreads` applies the exposition gate. Two of the four
 * would fail it — the weapon thread's "Nothing bought yet; Jin-Woo is doing the talking" and the
 * residency's "1 of 20 logged. Nineteen to go" both name something genuinely unresolved without
 * using any of the ignorance/incompletion/interrogation words `UNSETTLED` tests for. That is a real
 * limit of the gate and it is not this fixture's business to hide it: the rows exist in the live
 * chat, so the review has to be able to close them.
 */
function preRepair2Threads() {
    const table = new Map();
    for (const row of [
        {
            name: 'Next raid with Kang\'s squad',
            detail: 'Jin-Woo will text Solomon when it posts',
            open: 'When and where the raid will be',
            source: 'Jin-Woo, after the double dungeon',
        },
        {
            name: 'next raid with Kang\'s team',
            detail: 'Kang Min-seo will text when a D-rank slot opens',
            open: 'waiting for Kang\'s call',
            source: 'Kang\'s text',
        },
        {
            name: 'A weapon that is not a goblin’s knife',
            detail: 'Solomon is looking for a bo-staff or spear plus something shorter, on his share of the raid pay.',
            open: 'Nothing bought yet; Jin-Woo is doing the talking so the brokers do not read Solomon as rich.',
            source: 'Goblin Market, Jongno 3-ga',
        },
        {
            name: 'Hunter residency: twenty D-rank raids',
            detail: 'A D-10 visa needs twenty active D-rank-or-higher raids inside twelve months.',
            open: '1 of 20 logged. Nineteen to go, and the clock started at Awakening.',
            source: 'foreign-national addendum, Association pamphlet',
        },
    ]) {
        foldThread(table, { ...row, turn: 14 });
    }
    return table;
}

/** The two cast rows the pre-repair2 header actually held. */
function preRepair2Cast() {
    const table = new Map();
    foldEntity(table, {
        kind: PERSON, name: 'the scarred broker', detail: 'showing weapons and gear from behind the counter',
        place: 'Goblin Market, basement of old shopping centre, Jongno 3-ga', feels: 'wary',
        wants: 'sell surplus gear to the two E-ranks', status: 'present', turn: 10,
    });
    foldEntity(table, {
        kind: PERSON, name: 'broker', detail: 'wrapping up after the sale', place: 'Goblin Market shop',
        feels: 'friendly', wants: 'to sell gear and maintain client relationships', status: 'remote', turn: 12,
    });
    return table;
}

describe('cap:stale-hidden is retired by construction, not by configuration', () => {
    /*
     * FOLD-REDESIGN.md §5: "The counter is retired to zero *by construction*, which is the cleanest
     * success criterion in this document." A test that merely observes a zero would pass on a chat
     * where nothing had gone stale yet, so this reads the source: nothing may INCREMENT the rule.
     */
    const sources = fs.readdirSync(FOLD)
        .filter(name => name.endsWith('.js'))
        .map(name => ({ name, text: fs.readFileSync(path.join(FOLD, name), 'utf8') }));

    test('no code path increments it', () => {
        // The two ways to raise it: `noteCap('stale-hidden')` or a raw `note('cap:stale-hidden')`.
        const raisers = sources.filter(file =>
            /noteCap\(\s*['"]stale-hidden/.test(file.text) || /note\(\s*['"]cap:stale-hidden/.test(file.text));
        expect(raisers.map(file => file.name)).toEqual([]);
    });

    test('and `isFresh`, the rule that decided it, is gone from the codebase', () => {
        // Named as a deletion rather than merely absent: the docblock that replaced it keeps the
        // argument and the three measurements that killed it (198 and 540 live hidings, the
        // knife/licence/pamphlet class, BayesFilter.lean:80-81).
        const callers = sources.filter(file => /\bisFresh\s*\(/.test(file.text));
        expect(callers.map(file => file.name)).toEqual([]);
    });

    test('but the rule stays registered, so the zero is visible', () => {
        // A bound that quietly leaves the list proves nothing. `observe.neverFired()` naming it is
        // the success criterion; a missing entry would just be a shorter list.
        const observe = sources.find(file => file.name === 'observe.js').text;
        expect(observe).toContain('\'cap:stale-hidden\'');
    });
});

describe('the review block: stable ids on every open line', () => {
    const table = preRepair2Threads();
    const open = threadsByKind(table, 14).open;

    test('every open thread gets an id, and the same ledger gives the same ids', () => {
        const first = reviewBlock({ threads: open });
        const second = reviewBlock({ threads: [...open].reverse() });
        expect([...first.index.keys()]).toEqual([...second.index.keys()]);
        expect([...first.index.values()].map(q => q.key))
            .toEqual([...second.index.values()].map(q => q.key));
        expect(first.text).toBe(second.text);
    });

    test('a dial prints its position and a dial-less thread prints what is unresolved', () => {
        const dialled = new Map();
        foldThread(dialled, { name: 'twenty D-rank raids logged', tick: 1, size: 20, kind: PROGRESS, turn: 1 });
        const { text } = reviewBlock({ threads: threads(dialled, 1) });
        expect(text).toContain('[1/20] twenty D-rank raids logged');

        const { text: plain } = reviewBlock({ threads: open });
        expect(plain).toContain('[open] A weapon that is not a goblin’s knife');
        expect(plain).toContain('Nothing bought yet');
    });

    test('an empty ledger asks nothing at all', () => {
        expect(reviewBlock({}).text).toBe('');
        expect(reviewBlock({}).index.size).toBe(0);
    });

    test('the directed questions are budgeted, most consequential first', () => {
        const built = reviewBlock({
            contests: [{ field: 'location', locked: 'the chamber', value: 'the Nowon gate site', count: 3 }],
            identity: Array.from({ length: 9 }, (_, n) => ({ a: `a${n}`, b: `b${n}`, of: 'cast', names: [`a${n}`, `b${n}`] })),
            owed: { items: ['darkwood staff'], balance: 330000, currency: 'won' },
        });
        // Locks first: a lock contest is the panel actively showing something the story contradicts.
        expect(built.text).toContain('L1');
        const asked = [...built.index.values()].filter(q => q.kind !== 'thread' && q.kind !== 'place');
        expect(asked).toHaveLength(MAX_QUESTIONS);
    });

    test('a misplaced person (a place that is not here) is asked where they are now, with their last place', () => {
        // The presence fix (FOLD-REDESIGN.md §10 Phase F diagnosis): the cast freezes because the
        // review only questioned UNPLACED people, so anyone with a stale-but-non-empty place was
        // never refreshed. A person whose stored place is elsewhere but who is mentioned in the
        // window now joins the `[where now?]` list — and the line shows their last place so the
        // model can correct it ("Jin-Woo — last placed: his home in Dongdaemun").
        const { text, index } = reviewBlock({
            unplaced: [{ key: 'person\u0000jin-woo', name: 'Jin-Woo', place: 'his home in Dongdaemun' }],
        });
        expect(text).toContain('[where now?] Jin-Woo — last placed: his home in Dongdaemun');
        const q = [...index.values()].find(entry => entry.kind === 'place');
        expect(q).toMatchObject({ key: 'person\u0000jin-woo', name: 'Jin-Woo' });
    });

    test('the schema offers exactly the four dispositions the design names', () => {
        // Plus '' — one list means a P, L or Q entry has a `still` field it does not use, and
        // strict mode requires every property in `required`, so the empty string has to be legal.
        expect(reviewSchema().properties.lines.items.properties.still.enum).toEqual(['', ...STILL]);
        expect(STILL).toEqual(['open', 'advanced', 'settled', 'moot']);
    });
});

describe('the identity questions the pre-repair2 header actually raised', () => {
    /*
     * FOLD-REDESIGN.md §10, Phase C gate: "the broker pair AND the `Kang's squad`/`Kang's team`
     * thread pair each merge on the first review pass over a fixture reconstructing the pre-repair2
     * header". Both rows in each pair are copied verbatim from `solo-leveling.backup2.jsonl`.
     */
    test('the broker pair merges on the first pass, and the fuller name survives', () => {
        const cast = preRepair2Cast();
        expect(cast.size).toBe(2);

        const pair = { a: entityKey(PERSON, 'scarred broker'), b: entityKey(PERSON, 'broker'), of: 'cast', names: ['the scarred broker', 'broker'] };
        const { index } = reviewBlock({ identity: [pair] });
        const id = [...index.keys()].find(key => index.get(key).kind === 'identity');

        // The canned answer: what the model says when it reads a scene with one man behind one
        // counter. "One name containing another is not identity" (FOLD-RPG-GAP.md §4) is exactly
        // why it is asked rather than assumed — the merge is the ANSWER, never the detection.
        const plan = planReview({ lines: [{ id, answer: 'same', note: 'one man, one counter' }] }, index);
        expect(plan.merges).toHaveLength(1);

        const done = mergeEntities(cast, plan.merges[0].a, plan.merges[0].b);
        expect(cast.size).toBe(1);
        expect(done.key).toBe(entityKey(PERSON, 'scarred broker'));
        const row = cast.get(done.key);
        expect(row.name).toBe('the scarred broker');
        // The demoted name joins the alias set, which is what stops the next mention of "broker"
        // opening a third row — the defect that reopened within 48 hours of the hand repair.
        expect(row.aka.toLowerCase()).toContain('broker');
        // The fresher sighting's fields win, exactly as a re-report would.
        expect(row.detail).toBe('wrapping up after the sale');
    });

    test('the Kang\'s squad / Kang\'s team thread pair merges, and the dial does not double', () => {
        const table = preRepair2Threads();
        const pair = {
            a: 'next raid with kang\'s squad', b: 'next raid with kang\'s team', of: 'thread',
            names: ['Next raid with Kang\'s squad', 'next raid with Kang\'s team'],
        };
        const { index } = reviewBlock({ identity: [pair] });
        const id = [...index.keys()].find(key => index.get(key).kind === 'identity');
        const plan = planReview({ lines: [{ id, answer: 'same', note: 'one raid, two wordings' }] }, index);

        const before = table.size;
        const done = mergeThreads(table, plan.merges[0].a, plan.merges[0].b);
        expect(table.size).toBe(before - 1);
        const row = table.get(done.key);
        expect(row.aka.toLowerCase()).toContain('kang\'s');
        // A substitution pair, which a subset test provably cannot catch — neither token set
        // contains the other (thread-table.js nearIdentity, and FOLD-REDESIGN.md §0.1-6).
        expect(pair.a).not.toBe(pair.b);
    });

    test('a merge of a dialled and a dial-less thread keeps ONE position, never the sum', () => {
        // The residency pair: a lead reading "1 of 20 logged" and a clock at 1/8. Adding them
        // produces a meaningless 2 and averaging invents a number nobody wrote.
        const table = new Map();
        foldThread(table, { name: 'Hunter residency: twenty D-rank raids', open: '1 of 20 logged', turn: 9 });
        foldThread(table, { name: 'The residency window closes', tick: 1, size: 8, kind: DOOM, about: 'the sponsorship lapses', turn: 9 });

        const done = mergeThreads(table, 'hunter residency: twenty d-rank raids', 'the residency window closes');
        const row = table.get(done.key);
        // The dial-bearing row is the keeper: a measurable position is strictly more than none.
        expect(done.key).toBe('the residency window closes');
        expect(row.filled).toBe(1);
        expect(row.size).toBe(8);
        expect(row.aka).toContain('Hunter residency');
    });

    test('a canned "different" is remembered and never asked again', () => {
        // The detector is loose by design, so false pairs are expected — `Lord Everard` /
        // `Lillian Everard` is the measured one. A `different` that is forgotten is a question that
        // returns on every pass forever and trains the reader to ignore the mechanism.
        const pair = { a: entityKey(PERSON, 'lord everard'), b: entityKey(PERSON, 'lillian everard'), of: 'cast', names: ['Lord Everard', 'Lillian Everard'] };
        const { index } = reviewBlock({ identity: [pair] });
        const id = [...index.keys()].find(key => index.get(key).kind === 'identity');
        const plan = planReview({ lines: [{ id, answer: 'different', note: 'a family, not a person' }] }, index);

        expect(plan.merges).toEqual([]);
        expect(plan.different).toHaveLength(1);

        const answers = new Map([[pairKey(pair.a, pair.b), { answer: 'different' }]]);
        expect(outstanding([pair], { answers })).toEqual([]);
        // And order-independently: the detector walks a Map, whose order changes when a row is
        // written, so the same pair can be presented either way round on different passes.
        expect(outstanding([{ ...pair, a: pair.b, b: pair.a }], { answers })).toEqual([]);
    });

    test('a pair whose rows no longer exist is not asked about', () => {
        const pair = { a: 'gone', b: 'also gone', of: 'thread' };
        expect(outstanding([pair], { exists: () => false })).toEqual([]);
    });
});

describe('closure survives a swipe — the shape decision, measured', () => {
    /*
     * §2 promises three things at once: closures land as ledger events, nothing is deleted in place,
     * and swiping away the closing turn un-closes the thread. Threads are a STORED table, so the
     * reconciliation is a read-time overlay: stored status, overridden by live closure events.
     */
    const stored = preRepair2Threads();
    const weapon = 'a weapon that is not a goblin’s knife';

    test('a live closure closes the thread', () => {
        const view = overlayClosures(stored, [{ key: weapon, status: CLOSED }]);
        expect(view.get(weapon).status).toBe(CLOSED);
        expect(threadsByKind(view, 14).open.map(row => row.key)).not.toContain(weapon);
    });

    test('the stored row is never edited, so the closure can be taken back', () => {
        overlayClosures(stored, [{ key: weapon, status: CLOSED }]);
        expect(stored.get(weapon).status).toBe('open');
    });

    test('swiping away the closing turn re-opens it — no repair, no third state', () => {
        // The swipe changes the message's text, so its content key changes, so `liveHashes()` no
        // longer contains it, so `liveEvents()` drops the closure, so this function receives an
        // empty list. Modelled exactly: the closure list is what liveness produced.
        const closed = overlayClosures(stored, [{ key: weapon, status: CLOSED }]);
        const swiped = overlayClosures(stored, []);
        expect(closed.get(weapon).status).toBe(CLOSED);
        expect(swiped.get(weapon).status).toBe('open');
        expect(threadsByKind(swiped, 14).open.map(row => row.key)).toContain(weapon);
    });

    test('closures apply in order, so a later review can re-open what an earlier one closed', () => {
        const view = overlayClosures(stored, [
            { key: weapon, status: CLOSED },
            { key: weapon, status: 'open' },
        ]);
        expect(view.get(weapon).status).toBe('open');
    });

    test('a closure follows aliases, so a confirmed merge does not orphan it', () => {
        const table = preRepair2Threads();
        mergeThreads(table, 'next raid with kang\'s squad', 'next raid with kang\'s team');
        const view = overlayClosures(table, [{ key: 'next raid with kang\'s team', status: MOOT }]);
        expect([...view.values()].some(row => row.status === MOOT)).toBe(true);
    });
});

describe('the mids 59–72 replay: the weapon thread settles in one pass', () => {
    /*
     * The real window. At mid 61 Solomon "put the darkwood staff and the shortsword aside for
     * purchase"; at 62 the broker says "Eighty-five thousand for the pair"; at 63 the player writes
     * "I hand over the 120k"; at 64 "The broker takes the cash". The thread that could not close for
     * eight turns has its answer sitting in the same window (FOLD-REDESIGN.md §2).
     */
    const table = preRepair2Threads();
    const open = threadsByKind(table, 14).open;
    const { text, index } = reviewBlock({ threads: open });
    const weaponId = [...index.entries()].find(([, q]) => q.key === 'a weapon that is not a goblin’s knife')[0];

    test('the weapon thread is on the block with an id', () => {
        expect(text).toContain(`${weaponId} [open] A weapon that is not a goblin’s knife`);
    });

    test('one canned pass settles it', () => {
        const plan = planReview({
            lines: [
                { id: weaponId, still: 'settled', note: 'staff and shortsword bought' },
                { id: [...index.keys()].find(key => key !== weaponId), still: 'open', note: '' },
            ],
        }, index);

        expect(plan.closures).toEqual([{ key: 'a weapon that is not a goblin’s knife', status: CLOSED, note: 'staff and shortsword bought' }]);
        expect(plan.kept).toBe(1);
        // And the summary that becomes the audit event names what changed, in words a reader
        // scrolling the chronicle can use.
        const names = new Map([...table].map(([key, row]) => [key, row.name]));
        expect(describePlan(plan, names)).toContain('A weapon that is not a goblin’s knife is settled');
    });

    test('and the closure removes it from the ledger the NEXT pass pins', () => {
        const plan = planReview({ lines: [{ id: weaponId, still: 'settled', note: '' }] }, index);
        const view = overlayClosures(table, plan.closures);
        const next = reviewBlock({ threads: threadsByKind(view, 14).open });
        expect(next.text).not.toContain('A weapon that is not a goblin’s knife');
    });

    test('`moot` is a closure too, and it is not failure', () => {
        const plan = planReview({ lines: [{ id: weaponId, still: 'moot', note: 'no longer matters' }] }, index);
        expect(plan.closures[0].status).toBe(MOOT);
    });

    test('`advanced` is counted and deliberately does not write a tick', () => {
        // The dial probe rides the same call and is the thing that reports how far something moved,
        // with MAX_TICK bounding it. Synthesising a tick from a word would be a second, unbounded
        // writer on one field. What `advanced` buys is the §12 rubber-stamp measurement.
        const plan = planReview({ lines: [{ id: weaponId, still: 'advanced', note: 'set aside for purchase' }] }, index);
        expect(plan.closures).toEqual([]);
        expect(plan.advanced).toHaveLength(1);
    });
});

describe('the directed money question — §5 fix 1', () => {
    /*
     * The recorded events at mids 60 and 62 credit the darkwood staff and the shortsword with no
     * money delta anywhere in the pass. Across 40 turns of this chat money moved up and never down,
     * while the one purchase was priced five separate times in plain text.
     */
    const mid60 = { inv: [{ item: 'darkwood staff', dq: 1 }, { item: 'shortsword', dq: 1 }] };

    test('the trigger fires on the recorded mid-60/62 events', () => {
        expect(creditsWithoutDebit({ accepted: mid60.inv })).toEqual(['darkwood staff', 'shortsword']);
    });

    test('and does not fire when the pass paid for them', () => {
        expect(creditsWithoutDebit({
            accepted: [...mid60.inv, { item: 'won', dq: -120000, at: MONEY }],
        })).toEqual([]);
    });

    test('a refused credit counts too — Phase A\'s known cost is this question\'s trigger shape', () => {
        // `reject:already-recorded` refuses a genuine same-name re-buy: the bracers destroyed at
        // mid 38 and re-bought at 66 stay at ledger 1. Nothing in `{item, dq, at}` distinguishes a
        // re-buy from a re-report, so the refusal is right at write time — and the refusal PLUS a
        // payment in the window is exactly what this question surfaces.
        expect(creditsWithoutDebit({
            accepted: [],
            refused: [{ item: 'mana-shackle bracers', reason: 'already-recorded' }],
        })).toEqual(['mana-shackle bracers']);
    });

    test('a restatement is not an acquisition, and a category is not a purchase', () => {
        expect(creditsWithoutDebit({ accepted: [{ item: 'goblin knife', set: 1 }] })).toEqual([]);
        expect(creditsWithoutDebit({ accepted: [{ item: 'haidong gumdo', dq: 1, at: 'abilities' }] })).toEqual([]);
    });

    /*
     * ── A restated balance is an answer, and the question was asked over the top of it ──
     *
     * Ground truth is the live Wuxia ledger replayed through `replay` (campaign e8416d96), not the
     * panel. The narrative pass reports an ABSOLUTE money total after a purchase; this question then
     * fired anyway, and the only thing the model could do with "you gained these and paid nothing"
     * was name the price a second time:
     *
     *   mid 251 `set: 63`   (563 − 500)   then mid 253 review `dq: -500`
     *   mid 258 `set: 23`   ( 63 −  40)   then mid 260 review `dq:  -40`
     *   mid 266 `set: 173`                then mid 267 review `dq:  -80`
     *   mid 286 `set: 373`  (1273 − 900)  then mid 287 review `dq: -900`
     *
     * The last one is why this is not merely an accuracy bug: 373 − 900 is negative, `merge_qty`
     * floors at zero and `deriveState` deletes an emptied row, so the campaign's entire fortune
     * stopped existing. The player's report was "the fuckin Spirit Stones disappear".
     */
    test('a restated money total is the debit side — the Wuxia double-bill', () => {
        // Verbatim shape of mid 286: things gained, and the balance restated to what remains.
        expect(creditsWithoutDebit({
            accepted: [
                { item: '四阶地火龙髓', dq: 1 },
                { item: '九转淬金丹', dq: 1 },
                { item: 'low-grade spirit stones', set: 373, at: MONEY },
            ],
        })).toEqual([]);
    });

    test('a restated total counts however the balance moved', () => {
        // `set` carries no sign and that is the whole point: it is the model's last word on the
        // purse either way, so there is nothing left to ask. A rise is a sale, not an unpaid credit.
        expect(creditsWithoutDebit({
            accepted: [{ item: 'plaque', dq: 1 }, { item: 'spirit stones', set: 1273, at: MONEY }],
        })).toEqual([]);
    });

    test('a turn that moved no money at all still asks — the case this was built for', () => {
        // The Solo Leveling shape is untouched: six items credited and the purse never mentioned.
        expect(creditsWithoutDebit({ accepted: mid60.inv })).toEqual(['darkwood staff', 'shortsword']);
    });

    test('the question carries the balance on record', () => {
        const { text } = reviewBlock({ owed: { items: ['darkwood staff', 'shortsword'], balance: 330000, currency: 'won' } });
        expect(text).toContain('recorded as gained with nothing paid: darkwood staff, shortsword');
        expect(text).toContain('Balance on record: 330000 won');
    });

    test('a canned "₩120,000" lands the debit, and the balance moves', () => {
        const { index } = reviewBlock({ owed: { items: ['darkwood staff', 'shortsword'], balance: 330000, currency: 'won' } });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, amount: 120000, note: 'handed over the 120k' }] }, index);
        expect(plan.money).toEqual(expect.objectContaining({ amount: 120000, currency: 'won', at: MONEY }));

        // The answer becomes an ORDINARY validated delta — no special path into state. The window
        // for the mention gate is the excerpt plus the answer, the same widening `absorb.js` makes
        // for a status block.
        const before = deriveState([{ t: 1, d: { inv: [{ item: 'won', set: 330000, at: MONEY }] } }]);
        const { accepted, rejected } = validateInventory({
            inv: before.inv,
            deltas: [{ item: plan.money.currency, dq: -plan.money.amount, at: MONEY }],
            windowText: 'I hand over the 120k. won 120000',
        });
        expect(rejected).toEqual([]);
        const after = deriveState([
            { t: 1, d: { inv: [{ item: 'won', set: 330000, at: MONEY }] } },
            { t: 2, d: { inv: accepted } },
        ]);
        expect(after.inv.get(itemKey('won', MONEY)).qty).toBe(210000);
    });

    test('"nothing" is a real answer and clears the question rather than leaving it to repeat', () => {
        const { index } = reviewBlock({ owed: { items: ['wrapped candy'], balance: 330000, currency: 'won' } });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, nothing: true, note: 'the ahjumma gave them to him' }] }, index);
        expect(plan.money).toEqual(expect.objectContaining({ amount: 0 }));
    });

    test('an unreadable amount is refused rather than guessed at', () => {
        const { index } = reviewBlock({ owed: { items: ['staff'], balance: 1, currency: 'won' } });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, amount: 0, note: '' }] }, index);
        expect(plan.money).toBeNull();
        expect(plan.rejected[0].reason).toBe('review-unreadable-amount');
    });
});

describe('contested locks — the turn-10 lock and its seven blocked writes', () => {
    /*
     * FOLD-REDESIGN.md §0.1-2: the lock mechanism did its job seven times and the result was a panel
     * showing an empty room in a scene containing the player. Expiry would be decay, which §11
     * forbids; the honest mechanism is to surface the disagreement and ask.
     */
    const LOCKED = 'the chamber';
    const SAID = 'the Nowon gate site';

    /** Replay a sequence of blocked writes through the fold, returning the stored record. */
    function replay(values) {
        let held = null;
        const raises = [];
        values.forEach((value, at) => {
            const outcome = foldContest(held, { locked: LOCKED, value, turn: at });
            held = outcome.record;
            if (outcome.raised) raises.push(at);
        });
        return { held, raises };
    }

    test('the contest is raised on the third consecutive disagreement, and once', () => {
        const { held, raises } = replay(Array.from({ length: 7 }, () => SAID));
        expect(raises).toEqual([2]);
        expect(held.count).toBe(7);
        // One alert about one argument, not seven. Counting every subsequent disagreement would
        // make `lock:contested` a measure of how long the user took to answer.
        expect(raises).toHaveLength(1);
    });

    test('a wandering narrator never raises one', () => {
        // One disagreement is the narrator wandering and two is a coincidence; three consecutive
        // reads that all say the same OTHER thing is the story having moved.
        const { raises } = replay([SAID, 'the alley', SAID, 'the ramen shop', SAID]);
        expect(raises).toEqual([]);
    });

    test('a write that agrees with the lock ends the argument', () => {
        const { held } = replay([SAID, SAID, LOCKED]);
        expect(held).toBeNull();
    });

    test('agreement is case-insensitive, because a capital is not a contest', () => {
        expect(foldContest(null, { locked: 'The Chamber', value: 'the chamber' }).record).toBeNull();
    });

    test('the snapshot carries the locked value AND the narrative value', () => {
        const { held } = replay(Array.from({ length: 3 }, () => SAID));
        const rows = contestsOf(new Map([['location', held]]));
        expect(rows).toEqual([{ field: 'location', lockedValue: LOCKED, narrativeValue: SAID, count: 3 }]);
    });

    test('nothing surfaces before the threshold, so an ordinary lock costs the panel nothing', () => {
        const { held } = replay([SAID, SAID]);
        expect(held.count).toBe(CONTEST_AT - 1);
        expect(contestsOf(new Map([['location', held]]))).toEqual([]);
    });

    test('the contest reaches the review as a question, and the lock still wins', () => {
        const { index, text } = reviewBlock({
            contests: [{ field: 'location', locked: LOCKED, value: SAID, count: 3 }],
        });
        expect(text).toContain(`"location" is pinned to "${LOCKED}"`);
        expect(text).toContain(SAID);
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, place: 'the Nowon gate site', note: 'news crawl says sealed' }] }, index);
        // The answer refreshes what the narrative is said to claim. It does NOT change the field:
        // "The lock still wins until the user acts" (§5).
        expect(plan.locks).toEqual([{ field: 'location', value: 'the Nowon gate site', note: 'news crawl says sealed' }]);
        expect(plan.closures).toEqual([]);
    });
});

describe('unplaced people — the question that replaces the guess', () => {
    test('an unplaced person is asked about by name, not asserted into the room', () => {
        const { text, index } = reviewBlock({
            unplaced: [{ key: entityKey(PERSON, 'kim'), name: 'Kim', place: 'the chamber' }],
        });
        expect(text).toContain('[where now?] Kim');
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, place: 'the Nowon gate site', note: 'dispersed after the raid' }] }, index);
        expect(plan.places).toEqual([{ key: entityKey(PERSON, 'kim'), name: 'Kim', place: 'the Nowon gate site', note: 'dispersed after the raid' }]);
    });

    test('an empty place means the excerpt did not say, and never becomes a place name', () => {
        // A cast row with `place: "unknown"` would put the presence predicate to work comparing
        // rooms to the word "unknown", which is worse than the UNPLACED it replaced. The model
        // leaves the field empty rather than writing a refusal word; the question is asked again.
        const { index } = reviewBlock({ unplaced: [{ key: entityKey(PERSON, 'kim'), name: 'Kim' }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, place: '', note: '' }] }, index);
        expect(plan.places).toEqual([]);
        expect(plan.kept).toBe(1);
    });
});

describe('polarity questions, carried out of the migration', () => {
    test('a migrated dial is asked which way it fills, and an answer sets it', () => {
        // Phase B flags EVERY migrated dial rather than guessing from an enumerated word list (§11).
        // The measured population is one clock across four campaigns — the residency clock, whose
        // `about` reads "Solomon completes 20 D-rank raids and gains residency": a progress track
        // that was injected under `Pressure:` for the life of the chat.
        const { text, index } = reviewBlock({
            polarity: [{ thread: 'residency in korea', name: 'Residency in Korea', about: 'Solomon completes 20 D-rank raids and gains residency' }],
        });
        expect(text).toContain('is filling this bad for the characters');
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, answer: PROGRESS, note: 'he wins residency' }] }, index);
        expect(plan.polarity).toEqual([{ key: 'residency in korea', kind: PROGRESS, note: 'he wins residency' }]);
    });

    test('the answer is the closed vocabulary, not a synonym', () => {
        const { index } = reviewBlock({ polarity: [{ thread: 'x', name: 'X', about: '' }] });
        const id = [...index.keys()][0];
        // The schema's enum is DOOM — the model answers the protocol word, and fold does not
        // recognise "bad" or "good" as if they were it.
        expect(planReview({ lines: [{ id, answer: DOOM, note: '' }] }, index).polarity[0].kind).toBe(DOOM);
        expect(planReview({ lines: [{ id, answer: 'bad', note: '' }] }, index).polarity).toEqual([]);
    });
});

describe('an answer fold cannot place is refused, never repaired by guessing', () => {
    test('an id that was never asked about', () => {
        const plan = planReview({ lines: [{ id: 'T99', still: 'settled', note: '' }] }, new Map());
        // Carries what was sent, which is the whole reason a refusal is worth recording.
        expect(plan.rejected[0].raw).toEqual({ id: 'T99', still: 'settled', note: '' });
        expect(plan.closures).toEqual([]);
        expect(plan.rejected).toEqual([
            expect.objectContaining({ item: 'T99', reason: 'review-unknown-id' }),
        ]);
    });

    test('a disposition word against a question is ignored, and the question stays open', () => {
        // WAS: `review-wrong-shape`, when `lines` and `answers` were two arrays and a P id in the
        // first one was a category error. There is one array now, so the id routes to the place
        // handler — which finds no `place` and leaves the question outstanding. That is the same
        // outcome the handler has always given an empty answer: asked again next pass, never turned
        // into a location named after a disposition word.
        const { index } = reviewBlock({ unplaced: [{ key: 'k', name: 'Kim' }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, still: 'settled', note: '' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.places).toEqual([]);
        expect(plan.kept).toBe(1);
    });

    test('an empty fragment changes nothing', () => {
        const plan = planReview(null, new Map());
        expect(plan.closures).toEqual([]);
        expect(plan.merges).toEqual([]);
        expect(plan.rejected).toEqual([]);
    });
});

describe('the review block renders dispositions and questions apart, so a place answer is filed correctly', () => {
    test('T/M/A lines and P/L/Q questions live under different headers', () => {
        const { text, index } = reviewBlock({
            threads: [{ key: 't', name: 'the menace from the mountains' }],
            unplaced: [{ key: 'person\u0000widow', name: 'the widow', place: 'garden gate' }],
            marks: [{ key: 'k', name: 'Sol', phrase: 'bruised arm' }],
        });
        // The section headers name the fragment array each list feeds.
        expect(text).toContain('Say which of these are settled — put your reading in the "lines" answers:');
        expect(text).toContain('Answer these — put your reading in the "answers" list:');
        // Dispositions are T/M; the place question is under the questions header.
        expect(text.indexOf('[open] the menace from the mountains')).toBeLessThan(text.indexOf('[where now?] the widow'));
        expect(index.get([...index.keys()].find(k => index.get(k).kind === 'place')).id).toMatch(/^P\d+$/);
    });

    test('a place answer places the person (the Time Stop RPG P-reject case)', () => {
        // Measured: 19 rejects in Time Stop and 7 more in New Eldoria, all P ids, because the model
        // filed `[where now?]` answers in `lines` while the schema wanted them in `answers`. There
        // is one list now and the id routes, so this is applied wherever it arrives.
        const { text, index } = reviewBlock({
            unplaced: [{ key: 'person\u0000widow', name: 'the widow', place: 'garden gate' }],
        });
        expect(text).toContain('[where now?] the widow');
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, place: 'the inn', note: 'went to buy a room' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.places).toEqual([{ key: 'person\u0000widow', name: 'the widow', place: 'the inn', note: 'went to buy a room' }]);
    });

    test('the same answer is applied whichever way the model shapes the entry', () => {
        // The class the twenty-six refusals belonged to, closed by construction. The model can copy
        // the id and fill `place`, or fill `place` alongside a stray `still` it did not need to
        // give; both land the placement, because the id — not the array, and not the field set —
        // is what says which handler this is for.
        const { index } = reviewBlock({ unplaced: [{ key: 'k', name: 'Kim' }] });
        const id = [...index.keys()][0];
        const clean = planReview({ lines: [{ id, place: 'the stable yard', note: '' }] }, index);
        const noisy = planReview({ lines: [{ id, still: 'open', answer: '', place: 'the stable yard', amount: 0, nothing: false, note: '' }] }, index);
        expect(clean.places).toEqual(noisy.places);
        expect(clean.places).toEqual([{ key: 'k', name: 'Kim', place: 'the stable yard', note: '' }]);
        expect(noisy.rejected).toEqual([]);
    });
});

describe('the §12 fallback, armed', () => {
    test('isTouched finds a thread the new window is actually about', () => {
        expect(isTouched({ name: 'A weapon that is not a goblin’s knife' }, 'he set the shortsword aside; the weapon question is settled')).toBe(true);
        expect(isTouched({ name: 'Hunter residency: twenty D-rank raids' }, 'the residency window is what worries him')).toBe(true);
        expect(isTouched({ name: 'Teaching Jin-Woo IT' }, 'the ahjumma hands over two wrapped candies')).toBe(false);
        expect(isTouched({ name: 'anything' }, '')).toBe(false);
    });

    test('reviewableWindow poses only touched threads within the valve window ([TLB])', () => {
        const threads = [
            { key: 'a', name: 'the courier killer', turn: 3 },
            { key: 'b', name: 'Karr of the Red Hand', turn: 40 },
            { key: 'c', name: 'the tolls petition', turn: 5 },
        ];
        // The window mentions the courier; at turn 41, the two threads last updated before the
        // valve window (turn 41 - REVIEW_EVERY = 33) are also posed. Karr was updated at 40, so it
        // is neither touched nor stale — it waits for a pass that mentions it.
        const posed = reviewableWindow(threads, 'The courier was pulled from the river.', 41);
        const names = posed.map(t => t.name);
        expect(names).toContain('the courier killer');
        expect(names).toContain('the tolls petition');
        expect(names).not.toContain('Karr of the Red Hand');
    });

    test('reviewableWindow poses touched threads even when recently updated', () => {
        const threads = [
            { key: 'a', name: 'the courier killer', turn: 41 },
        ];
        const posed = reviewableWindow(threads, 'The courier was pulled from the river.', 41);
        expect(posed.map(t => t.name)).toEqual(['the courier killer']);
    });

    test('reviewableWindow with no window poses only the stale safety valve', () => {
        const threads = [
            { key: 'a', name: 'the courier killer', turn: 3 },
            { key: 'b', name: 'Karr of the Red Hand', turn: 40 },
        ];
        // No window means nothing is touched; only the thread that has gone unlooked-at longest
        // (turn 3, well past REVIEW_EVERY before turn 41) gets its regular look.
        const posed = reviewableWindow(threads, '', 41);
        expect(posed.map(t => t.name)).toEqual(['the courier killer']);
    });

    test('a thread updated within the valve window and untouched is not posed', () => {
        const threads = [{ key: 'b', name: 'Karr of the Red Hand', turn: 40 }];
        const posed = reviewableWindow(threads, 'The week settles into a rhythm.', 41);
        expect(posed).toHaveLength(0);
    });
});

describe('the worst observed first pass, and what the budget guarantees about it', () => {
    /*
     * Counted against the pre-repair2 Solo Leveling header: six identity pairs (the broker pair, the
     * squad/team pair, and four cross-table residency pairs the migration's looser trigger raises),
     * two polarity flags, one lock contest, one money question — ten. The ceiling is eight, and the
     * gate's claim is not "everything is asked at once" but "these two are asked FIRST".
     */
    const identity = [
        { a: entityKey(PERSON, 'scarred broker'), b: entityKey(PERSON, 'broker'), of: 'cast', why: 'subset', names: ['the scarred broker', 'broker'] },
        { a: 'next raid with kang\'s squad', b: 'next raid with kang\'s team', of: 'thread', why: 'substitution', names: ['Next raid with Kang\'s squad', 'next raid with Kang\'s team'] },
        ...Array.from({ length: 4 }, (_, n) => ({ a: `residency lead ${n}`, b: `residency clock ${n}`, of: 'thread', why: 'shared-subject:residency', names: [`lead ${n}`, `clock ${n}`] })),
    ];
    const polarity = [
        { thread: 'the residency window closes', name: 'The residency window closes', about: 'the sponsorship lapses' },
        { thread: 'residency in korea', name: 'Residency in Korea', about: 'Solomon completes 20 D-rank raids and gains residency' },
    ];
    const contests = [{ field: 'location', locked: 'the chamber', value: 'the Nowon gate site', count: 7 }];
    const owed = { items: ['darkwood staff'], balance: 330000, currency: 'won' };

    test('ten questions are outstanding and eight are asked', () => {
        expect(identity.length + polarity.length + contests.length + 1).toBe(10);
        const { index } = reviewBlock({ identity, polarity, contests, owed });
        const asked = [...index.values()].filter(q => q.kind !== 'thread' && q.kind !== 'place');
        expect(asked).toHaveLength(MAX_QUESTIONS);
    });

    test('and BOTH pairs the gate names are on the first pass', () => {
        const { index } = reviewBlock({ identity, polarity, contests, owed });
        const pairs = [...index.values()].filter(q => q.kind === 'identity').map(q => pairKey(q.a, q.b));
        expect(pairs).toContain(pairKey(entityKey(PERSON, 'scarred broker'), entityKey(PERSON, 'broker')));
        expect(pairs).toContain(pairKey('next raid with kang\'s squad', 'next raid with kang\'s team'));
    });

    test('what does not fit is not lost — it is outstanding again next pass', () => {
        // The one property that lets the ceiling sit inside the observed range at all: nothing is
        // destroyed by not fitting. The sources still hold every unanswered question.
        const { index } = reviewBlock({ identity, polarity, contests, owed });
        const asked = new Set([...index.values()].filter(q => q.kind === 'identity').map(q => pairKey(q.a, q.b)));
        const missed = identity.filter(pair => !asked.has(pairKey(pair.a, pair.b)));
        expect(outstanding(identity, { answers: new Map() })).toHaveLength(identity.length);
        expect(missed.length + asked.size).toBe(identity.length);
    });
});

describe('two defects the printed block caught that no test had', () => {
    test('a migration pair\'s own `kind` does not overwrite the question kind', () => {
        // `migrate.js` tags its pairs `kind: 'thread'` / `'cast'` to say which table they came from.
        // `reviewBlock` spread the pair over `{ kind: 'identity' }` and the table name won, so
        // `questionText` fell through its switch and four of the ten questions on the worst observed
        // first pass rendered as blank lines with live ids behind them.
        const { text, index } = reviewBlock({
            identity: [{ a: 'hunter residency', b: 'the residency window closes', why: 'shared-subject:residency', kind: 'thread', of: 'thread', names: ['Hunter residency', 'The residency window closes'] }],
        });
        expect(text).toContain('[same?] Are "Hunter residency" and "The residency window closes" the same thing?');
        expect([...index.values()][0].kind).toBe('identity');
    });

    test('a hidden dial is named on the review block but never quantified', () => {
        // The same rule `renderPressure` keeps: the narrator knows something is closing in, and how
        // near it is stays theirs to decide. The review can still be told it is moot, which is the
        // exit a hidden threat most needs since nobody is watching it fill.
        const table = new Map();
        foldThread(table, { name: 'the cult completes the rite', tick: 3, size: 6, kind: DOOM, seen: 'hidden', turn: 1 });
        const { text } = reviewBlock({ threads: threads(table, 1) });
        expect(text).toContain('[closing in] the cult completes the rite');
        expect(text).not.toContain('3/6');
    });
});

/*
 * ── Marks and adversaries close the way threads close (Phase D) ──
 *
 * `FOLD-REDESIGN.md` §2's table lists marks in its second row and names what closed them before
 * this: "`turns` guess at write time only". `cap:condition-expired` has never fired in any of the
 * three chats, so in practice a wound never healed — the panel simply kept it forever.
 */
describe('the review can settle a mark', () => {
    const marks = [
        { key: markKey('', 'calf'), who: '', name: 'Solomon Winters', phrase: 'bandaged left calf', severity: 'moderate', mine: true },
        { key: markKey('lee', 'bleeding'), who: 'lee', name: 'Lee', phrase: 'bleeding', severity: 'severe', mine: false },
    ];

    test('every live mark gets an id, and the line names whose it is', () => {
        const { text, index } = reviewBlock({ marks });
        expect(text).toContain('M1 [mark: Solomon Winters] bandaged left calf (moderate)');
        // Without the owner the block is the subjectless flag table with extra steps.
        expect(text).toContain('M2 [mark: Lee] bleeding (severe)');
        expect(index.get('M2')).toMatchObject({ kind: 'mark', key: markKey('lee', 'bleeding') });
    });

    test('settled and moot both clear it — a body has no "it stopped mattering"', () => {
        const { index } = reviewBlock({ marks });
        for (const still of ['settled', 'moot']) {
            const plan = planReview({ lines: [{ id: 'M2', still, note: 'field-dressed' }] }, index);
            expect(plan.cleared).toEqual([expect.objectContaining({ key: markKey('lee', 'bleeding'), phrase: 'bleeding' })]);
        }
    });

    test('`advanced` on a mark is counted and NOT acted on', () => {
        // Exactly what `turns` was invented to guess at. Counted so §12's rubber-stamp measurement
        // sees it; not turned into a write, because "mending" is not a state fold models.
        const { index } = reviewBlock({ marks });
        const plan = planReview({ lines: [{ id: 'M1', still: 'advanced', note: 'scabbing over' }] }, index);
        expect(plan.cleared).toEqual([]);
        expect(plan.advanced).toHaveLength(1);
    });

    test('and a mark left open is kept, like any other line', () => {
        const { index } = reviewBlock({ marks });
        expect(planReview({ lines: [{ id: 'M1', still: 'open', note: '' }] }, index).kept).toBe(1);
    });

    test('the block bounds its mark lines, because MAX_FLAGS would allow thirty-two bodies', () => {
        // §12.2's size discipline, enforced by the renderer rather than promised by the schema.
        // Nothing is lost: this caps a queue, and an unasked mark is asked next pass.
        const many = Array.from({ length: MAX_MARK_LINES + 5 }, (unused, at) => ({
            key: markKey(`p${at}`, 'bleeding'), who: `p${at}`, name: `Person ${at}`, phrase: 'bleeding', severity: 'minor',
        }));
        const { index } = reviewBlock({ marks: many });
        expect([...index.keys()].filter(id => id.startsWith('M'))).toHaveLength(MAX_MARK_LINES);
    });
});

describe('the review closes a fight', () => {
    const threats = [{ key: entityKey(PERSON, 'hobgoblin'), name: 'the hobgoblin', threat: 4 }];

    test('an active adversary is one line and one small integer', () => {
        const { text, index } = reviewBlock({ threats });
        expect(text).toContain('A1 [threat 4] the hobgoblin — still fighting?');
        expect(index.get('A1')).toMatchObject({ kind: 'adversary', key: entityKey(PERSON, 'hobgoblin') });
    });

    test('settled or moot disarms the row; the row itself survives', () => {
        const { index } = reviewBlock({ threats });
        const plan = planReview({ lines: [{ id: 'A1', still: 'settled', note: 'crate to the skull' }] }, index);
        expect(plan.disarmed).toEqual([expect.objectContaining({ key: entityKey(PERSON, 'hobgoblin') })]);
        // A beaten adversary is still a person — possibly a corpse the scene has to deal with — so
        // nothing here retires the cast row. Presence stays the presence predicate's question.
        expect(plan.closures).toEqual([]);
        expect(describePlan(plan)).toContain('the hobgoblin is no longer a threat');
    });
});

describe('resolveCurrencyKey — a volunteered name matched to the row it names', () => {
    const CARRIED_WEN = itemKey('silver wen');
    const MONEY_SILVER = itemKey('silver', MONEY);

    test('the live cross-place case the old code silently dropped', () => {
        // Wuxia. The model volunteered {"a":"silver wen","b":"silver"}; the ledger holds `silver wen`
        // at CARRIED and `silver` at MONEY. Keying both at `money` built `money␀silver wen`, a key
        // the ledger never held, so the crosswalk discarded a correct answer without a trace.
        const keys = new Set([CARRIED_WEN, MONEY_SILVER, itemKey('dagger')]);
        expect(resolveCurrencyKey('silver wen', keys)).toBe(CARRIED_WEN);
        expect(resolveCurrencyKey('silver', keys)).toBe(MONEY_SILVER);
    });

    test('a leading amount is stripped, because the block renders one', () => {
        const keys = new Set([MONEY_SILVER]);
        expect(resolveCurrencyKey('20 silver', keys)).toBe(MONEY_SILVER);
        expect(resolveCurrencyKey('1,500 silver', keys)).toBe(MONEY_SILVER);
    });

    test('money wins a tie, because that is where a currency belongs', () => {
        const keys = new Set([itemKey('silver'), MONEY_SILVER]);
        expect(resolveCurrencyKey('silver', keys)).toBe(MONEY_SILVER);
    });

    test('a name held at two non-money places is ambiguous and refused', () => {
        // Refusing is the point: an unresolvable answer must not become a confident merge.
        const keys = new Set([itemKey('silver', 'chest'), itemKey('silver', 'satchel')]);
        expect(resolveCurrencyKey('silver', keys)).toBe('');
    });

    test('a name the ledger does not hold resolves to nothing', () => {
        expect(resolveCurrencyKey('groats', new Set([MONEY_SILVER]))).toBe('');
        expect(resolveCurrencyKey('', new Set([MONEY_SILVER]))).toBe('');
        expect(resolveCurrencyKey('silver', new Set())).toBe('');
    });

    test('it is exact equality, not a substring — in any script', () => {
        // `silver` must not match `silver moon locket`, and the same rule has to hold where no
        // whitespace separates words. Exact equality is the only test that means one thing in both.
        const keys = new Set([itemKey('silver moon locket'), itemKey('銀貨二十枚', MONEY)]);
        expect(resolveCurrencyKey('silver', keys)).toBe('');
        expect(resolveCurrencyKey('銀貨', keys)).toBe('');
        expect(resolveCurrencyKey('銀貨二十枚', keys)).toBe(itemKey('銀貨二十枚', MONEY));
    });
});

describe('the pair the model volunteers — identity fold cannot detect', () => {
    // `nearIdentity` is a token-subset trigger over NAMES, so it can only ever raise a restatement.
    // Measured on the live New Eldoria cast at turn 90: 22 threads, 231 possible pairs, **0 raised**
    // — including "Musical language of the symbols" and "Musical language hypothesis", opened one
    // turn apart, sharing two tokens of three. Five threads now cover one stone sphere.
    //
    // `same_currency` already solved this shape for money: the model reads the pinned block and
    // names two lines as one thing, unprompted, on the pass that was going to run anyway. The same
    // field over the thread list and the cast list is the whole of this change.

    test('the schema offers both lists', () => {
        const schema = reviewSchema();
        expect(schema.properties.same_thread).toBeDefined();
        expect(schema.properties.same_person).toBeDefined();
        expect(schema.required).toEqual(expect.arrayContaining(['same_thread', 'same_person']));
    });

    test('a volunteered thread pair becomes a SUSPICION, never a merge', () => {
        // The asymmetry is deliberate and the corpus states it: `same_currency` writes a witness
        // into `state.answers`, which the crosswalk relabels on and which nothing destroys. A
        // thread merge REWRITES a stored table, and "a wrong merge cannot be undone by silence"
        // (`entities.js`). So a volunteered pair is a candidate: it is asked once, with an id, and
        // the existing confirmed-merge path does the write. Two readings before a destructive one,
        // at no extra request.
        const { index } = reviewBlock({});
        const plan = planReview({
            lines: [],
            same_thread: [{ a: 'Musical language of the symbols', b: 'Musical language hypothesis' }],
        }, index);
        expect(plan.merges).toEqual([]);
        expect(plan.suspected).toEqual([
            { of: 'thread', a: 'Musical language of the symbols', b: 'Musical language hypothesis' },
        ]);
    });

    test('a volunteered cast pair is carried the same way', () => {
        const { index } = reviewBlock({});
        const plan = planReview({
            lines: [],
            same_person: [{ a: 'Grimble', b: 'Armorer' }],
        }, index);
        expect(plan.suspected).toEqual([{ of: 'cast', a: 'Grimble', b: 'Armorer' }]);
    });

    test('a self-pair says nothing and is dropped, not refused', () => {
        // Same rule `same_currency` keeps: a model naming one line twice has volunteered nothing.
        const { index } = reviewBlock({});
        const plan = planReview({
            lines: [],
            same_thread: [{ a: 'The ruins', b: 'the ruins' }, { a: '', b: 'Sphere study' }],
        }, index);
        expect(plan.suspected).toEqual([]);
        expect(plan.rejected).toEqual([
            expect.objectContaining({ item: 'Sphere study', reason: 'review-wrong-shape' }),
        ]);
        expect(plan.rejected[0].raw).toEqual({ a: '', b: 'Sphere study' });
    });
});

describe('suspectedPairs — a volunteered pair becomes an ordinary question', () => {
    // The stored table holds what the model NAMED, the way the block printed it. Turning that into
    // a question means resolving each side to a row, through the same one-hop alias resolution
    // every other consumer uses — and refusing to ask when it cannot.
    const stored = pairs => new Map(pairs.map((pair, at) => [String(at), pair]));

    test('both sides resolve, and the pair joins the identity queue', () => {
        const rows = new Map([
            ['musical language of the symbols', 'thread\u0000musical language of the symbols'],
            ['musical language hypothesis', 'thread\u0000musical language hypothesis'],
        ]);
        const out = suspectedPairs(
            stored([{ of: 'thread', a: 'Musical language of the symbols', b: 'Musical language hypothesis' }]),
            { resolve: (of, name) => rows.get(String(name).toLowerCase()) ?? null },
        );
        expect(out).toEqual([{
            of: 'thread',
            a: 'thread\u0000musical language of the symbols',
            b: 'thread\u0000musical language hypothesis',
            why: 'the model reports these are one',
        }]);
    });

    test('a side that resolves to nothing is dropped, not asked', () => {
        // `resolveCurrencyKey`'s rule: an unresolvable answer must not become a confident question.
        // A thread closed, renamed or pruned between the pass that named it and the pass that reads
        // it back is exactly this case, and asking about a row that no longer exists spends a slot
        // on a question nobody can answer.
        const out = suspectedPairs(
            stored([{ of: 'thread', a: 'Sphere study', b: 'a thread that was pruned' }]),
            { resolve: (of, name) => (name === 'Sphere study' ? 'thread\u0000sphere study' : null) },
        );
        expect(out).toEqual([]);
    });

    test('two names that resolve to ONE row are already merged, and say nothing', () => {
        const out = suspectedPairs(
            stored([{ of: 'cast', a: 'the tiefling', b: 'Kaelira' }]),
            { resolve: () => 'person\u0000kaelira' },
        );
        expect(out).toEqual([]);
    });

    test('the kind rides along, so the merge lands in the right table', () => {
        const out = suspectedPairs(
            stored([
                { of: 'cast', a: 'Grimble', b: 'Armorer' },
                { of: 'thread', a: 'The ruins', b: 'Sphere study' },
            ]),
            { resolve: (of, name) => `${of}:${String(name).toLowerCase()}` },
        );
        expect(out.map(pair => pair.of)).toEqual(['cast', 'thread']);
    });

    test('an answered pair never comes back, because `outstanding` already drops it', () => {
        // No cleanup path is needed and none is written: the verdict lives in `state.answers`, and
        // `outstanding` filters on it for every source at once.
        const raised = suspectedPairs(
            stored([{ of: 'thread', a: 'A', b: 'B' }]),
            { resolve: (of, name) => `thread\u0000${name.toLowerCase()}` },
        );
        const settled = new Map([[pairKey('thread\u0000a', 'thread\u0000b'), { answer: 'different' }]]);
        expect(outstanding(raised, { answers: settled })).toEqual([]);
        expect(outstanding(raised, { answers: new Map() })).toHaveLength(1);
    });
});

describe('one list, because the routing decision was the defect', () => {
    // ── The 26 misfilings ──
    //
    // `review-wrong-shape` fired 19 times in the Time Stop chat (all P1-P10) and 7 more in New
    // Eldoria (P1, P1, P2, P1, P2, P3, P4). Every one is a `[where now?]` answer the model filed as
    // a disposition. The repair tried first was in the BLOCK — two rendered sections instead of one
    // flat list — and it did not close the gap, because the schema still asked the model to choose
    // between two arrays after it had already copied an id that says which kind of answer is wanted.
    //
    // The id is a protocol token fold minted and handed out; `index` maps it to its kind, and
    // `planReview` has always dispatched on that kind. The second routing decision was redundant
    // and it was the one being got wrong. It is gone: one list, one entry per id, fold routes.
    //
    // Worth stating why "accept it from either array" was not the fix. The old `lines` item was
    // `{id, still, note}` under `additionalProperties: false`, so a misfiled place answer had
    // NOWHERE to put the place name — reading it from the other array would have recovered a
    // disposition word and no location. Only removing the choice recovers the answer.

    test('the schema asks for one list, not two', () => {
        const schema = reviewSchema();
        expect(schema.properties.lines).toBeDefined();
        expect(schema.properties.answers).toBeUndefined();
        expect(schema.required).not.toContain('answers');
    });

    test('a place answer filed as a line is APPLIED, which is the whole of the 26', () => {
        const { index } = reviewBlock({ unplaced: [{ key: 'person\u0000lira', name: 'Lira', place: 'Nine-Tails Inn' }] });
        const plan = planReview({
            lines: [{ id: 'P1', place: 'the stable yard', still: '', answer: '', amount: 0, nothing: false, note: '' }],
        }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.places).toEqual([{ key: 'person\u0000lira', name: 'Lira', place: 'the stable yard', note: '' }]);
    });

    test('a thread disposition in the same list still closes the thread', () => {
        const { index } = reviewBlock({ threads: [{ key: 'the ruins', name: 'The ruins', open: 'unexplored' }] });
        const plan = planReview({ lines: [{ id: 'T1', still: 'settled', note: 'explored it' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.closures).toEqual([{ key: 'the ruins', status: CLOSED, note: 'explored it' }]);
    });

    test('a paid answer in the same list still lands the debit', () => {
        const { index } = reviewBlock({ owed: { items: ['moonpetals'], balance: 0, currency: 'gold' } });
        const plan = planReview({ lines: [{ id: 'Q1', amount: 18, nothing: false, note: 'Grimble paid' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.money).toEqual(expect.objectContaining({ amount: 18, currency: 'gold' }));
    });

    test('an identity answer in the same list still merges', () => {
        const { index } = reviewBlock({ identity: [{ a: 'a', b: 'b', of: 'thread', why: 'x', names: ['A', 'B'] }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, answer: 'same', note: '' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.merges).toEqual([{ of: 'thread', a: 'a', b: 'b', note: '' }]);
    });

    test('an unknown id is still refused, and now says what it sent', () => {
        // The one refusal that survives, because an id fold never minted cannot be routed. It
        // carries the fragment, so the next person reads the ledger instead of reasoning about it.
        const { index } = reviewBlock({});
        const sent = { id: 'T9', still: 'settled', note: 'invented' };
        const plan = planReview({ lines: [sent] }, index);
        expect(plan.rejected).toEqual([
            expect.objectContaining({ item: 'T9', reason: 'review-unknown-id', raw: sent }),
        ]);
    });

    test('every refusal planReview can make carries its raw', () => {
        const { index } = reviewBlock({ owed: { items: ['x'], balance: 0, currency: 'gold' } });
        const plan = planReview({
            lines: [
                { id: 'ZZ1', still: 'settled' },
                { id: 'Q1', amount: -3, nothing: false },
            ],
            same_currency: [{ a: '', b: 'silver' }],
            same_thread: [{ a: 'A', b: '' }],
        }, index);
        expect(plan.rejected.length).toBeGreaterThanOrEqual(4);
        for (const rejection of plan.rejected) {
            expect(rejection.raw).toBeDefined();
            expect(rejection.item).toBeDefined();
        }
    });

    test('the window snippet rides along when the caller has one', () => {
        const { index } = reviewBlock({});
        const plan = planReview({ lines: [{ id: 'T9', still: 'settled' }] }, index, {
            windowText: 'Vexia raises her tankard in a mock toast to intelligent jellyfish.',
        });
        expect(plan.rejected[0].snippet).toContain('Vexia raises her tankard');
    });
});

describe('review-wrong-shape is unreachable for an id fold minted', () => {
    // The class, closed by construction rather than patched. `reviewBlock` mints six prefixes and
    // `planReview` now has a handler for every kind behind them, so the only refusal left in the
    // list loop is an id fold never issued. This enumerates all six rather than asserting it.
    const EVERY_KIND = {
        threads: [{ key: 'the ruins', name: 'The ruins', open: 'unexplored' }],
        unplaced: [{ key: 'person\u0000lira', name: 'Lira', place: 'the inn' }],
        marks: [{ key: 'person\u0000sol\u0000calf', name: 'Sol', phrase: 'gashed calf', severity: 'moderate', mine: true }],
        threats: [{ key: 'person\u0000hob', name: 'Hobgoblin', threat: 4 }],
        contests: [{ field: 'location', locked: 'the inn', value: 'the yard', count: 3 }],
        identity: [{ a: 'a', b: 'b', of: 'thread', why: 'x', names: ['A', 'B'] }],
        owed: { items: ['moonpetals'], balance: 0, currency: 'gold' },
    };

    test('every id the block mints is routed, none refused', () => {
        const { index } = reviewBlock(EVERY_KIND);
        expect(index.size).toBeGreaterThanOrEqual(6);
        // One entry per id, every field present and empty except the one its kind reads — which is
        // what strict mode makes the model send anyway.
        const lines = [...index.keys()].map(id => ({
            id, still: 'open', answer: 'same', place: 'the yard', amount: 7, nothing: false, note: '',
        }));
        const plan = planReview({ lines }, index);
        expect(plan.rejected).toEqual([]);
    });

    test('and the prefixes are the six the block documents', () => {
        const { index } = reviewBlock(EVERY_KIND);
        const prefixes = new Set([...index.keys()].map(id => id.replace(/[0-9]+$/, '')));
        expect([...prefixes].sort()).toEqual(['A', 'L', 'M', 'P', 'Q', 'T']);
    });
});

describe('a stake the story walked away from is asked once, then retired', () => {
    // ── The loop, traced on the live My Hero Academia RP ──
    //
    // `threadsByKind` hides a dial-less thread at THREAD_STALE = 20, so it leaves the NARRATOR's
    // prompt. The story therefore never touches it; it is never in the model's coverage report;
    // `reviewableWindow` poses it only on the REVIEW_EVERY safety valve; and the review instruction
    // correctly says "a thread the excerpt does not touch is still open". So the answer is `kept`,
    // forever. The counters say it plainly: review:kept 53 against review:settled 1, with all three
    // of the chat's threads stale at 26, 31 and 35 turns and NONE of them rendered anywhere.
    //
    // One of them read "hero costume pickup — costume not yet picked up" while the inventory two
    // lines above it held the costume, collected at mid 38.
    //
    // The repair is a different QUESTION, not a different filter. A stale line cannot be judged
    // from an excerpt that does not mention it, but it can be judged from the record — the same
    // thing `same_currency` is answered from. So it is posed as one.

    test('a fresh thread still asks whether the excerpt settled it', () => {
        const { text } = reviewBlock({ threads: [{ key: 'k', name: 'The ruins', open: 'unexplored', stale: 0 }] });
        expect(text).toContain('[open] The ruins');
    });

    test('a stale thread asks whether it is still a stake at all', () => {
        const { text } = reviewBlock({ threads: [{ key: 'k', name: 'hero costume pickup', open: 'costume not yet picked up', stale: 35 }] });
        expect(text).toContain('[still a thing?] hero costume pickup');
        expect(text).not.toContain('[open] hero costume pickup');
    });

    test('the edge is THREAD_STALE itself, not some second number', () => {
        const at = n => reviewBlock({ threads: [{ key: 'k', name: 'T', open: 'o', stale: n }] }).text;
        expect(at(THREAD_STALE - 1)).toContain('[open]');
        expect(at(THREAD_STALE)).toContain('[still a thing?]');
    });

    test('a dial keeps its position — a number answers both questions at once', () => {
        // The docblock's rule for dialled threads is untouched: "is this still open" and "how far
        // has it got" are the same question when there is a number, and a dial is never hidden by
        // staleness in the first place (`threadsByKind`), so it cannot reach this state.
        const { text } = reviewBlock({ threads: [{ key: 'k', name: 'T', open: 'o', stale: 99, dial: { filled: 2, size: 4 }, seen: 'open' }] });
        expect(text).toContain('[2/4] T');
    });

    test('and `moot` retires it through the path that already exists', () => {
        const { index } = reviewBlock({ threads: [{ key: 'hero costume pickup', name: 'hero costume pickup', open: 'not yet picked up', stale: 35 }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, still: 'moot', note: 'he has been wearing it' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.closures).toEqual([{ key: 'hero costume pickup', status: MOOT, note: 'he has been wearing it' }]);
    });
});

describe('an item can leave the ledger, which it could not before', () => {
    // ── The Azure Dragon sword ──
    //
    // Taken off a dead disciple at mid 88 of the live Wuxia World RPG, then laid down with him at
    // mid 92 — "arranging his hands around the sword hilt", with the village head gesturing at "the
    // blade on the ground". fold never recorded it leaving, so the pinned block told the narrator
    // the player was carrying it every turn afterwards, and at mid 92 the village head said "That's
    // the sword you took off him, boy?" — fold's own stale record, read back as an accusation.
    //
    // It could not have gone any other way. The review had a question kind for every table EXCEPT
    // the one that holds objects: T, M, A, P, L, Q and nothing for inventory. An item entered when
    // the model volunteered a positive delta and left only if it volunteered a negative one, and
    // across 143 messages there were three negative carried deltas, all from one selling scene.
    // Gains are salient to a narrator; putting something down is not.
    //
    // Same list, same disposition vocabulary, one more kind.

    test('carried items are posed, with their own prefix', () => {
        const { text, index } = reviewBlock({ carried: [
            { key: 'carried\u0000azure dragon sword', name: 'azure dragon sword', qty: 1 },
        ] });
        expect(text).toContain('[still carrying?] azure dragon sword');
        expect([...index.keys()]).toContain('I1');
        expect(index.get('I1')).toEqual(expect.objectContaining({ kind: 'item', key: 'carried\u0000azure dragon sword' }));
    });

    test('a count rides along, because "still carrying" and "how many" are one question', () => {
        const { text } = reviewBlock({ carried: [{ key: 'k', name: 'spirit stones', qty: 8 }] });
        expect(text).toContain('[still carrying?] spirit stones x8');
    });

    test('`settled` removes it, as the disposal the story already showed', () => {
        const { index } = reviewBlock({ carried: [
            { key: 'carried\u0000azure dragon sword', name: 'azure dragon sword', qty: 1 },
        ] });
        const plan = planReview({ lines: [{ id: 'I1', still: 'settled', note: 'left with the body' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.dropped).toEqual([
            { key: 'carried\u0000azure dragon sword', name: 'azure dragon sword', qty: 1, note: 'left with the body' },
        ]);
    });

    test('`moot` drops it too — given away and lost are the same fact about a pack', () => {
        const { index } = reviewBlock({ carried: [{ key: 'k', name: 'letter', qty: 1 }] });
        expect(planReview({ lines: [{ id: 'I1', still: 'moot', note: 'handed it over' }] }, index).dropped)
            .toHaveLength(1);
    });

    test('`open` keeps it, and costs nothing', () => {
        const { index } = reviewBlock({ carried: [{ key: 'k', name: 'letter', qty: 1 }] });
        const plan = planReview({ lines: [{ id: 'I1', still: 'open', note: '' }] }, index);
        expect(plan.dropped).toEqual([]);
        expect(plan.kept).toBe(1);
    });

    test('the budget is bounded, like every other list here', () => {
        const many = Array.from({ length: 40 }, (_, n) => ({ key: `k${n}`, name: `thing ${n}`, qty: 1 }));
        const { index } = reviewBlock({ carried: many });
        expect([...index.keys()].filter(id => id.startsWith('I')).length).toBeLessThanOrEqual(MAX_ITEM_LINES);
    });
});

describe('a volunteered pair named by fold\'s own line label resolves to the line', () => {
    // ── The model answers with the label fold printed ──
    //
    // Review lines render as `T3 [open] Reach the capital city`, so a volunteered pair comes back
    // worded that way. `suspectedPairs` resolved the whole string as a thread NAME, matched nothing
    // and dropped it silently.
    //
    // MEASURED in the live Isekai RPG chat, against the shipped resolver:
    //   DROPPED  "T3 [open] Reach the capital city" -> null  |  "travel to capital" -> ok
    //   DROPPED  "M3" -> null                                |  "M4" -> null
    // Three pairs volunteered, zero thread merges — and the panel still carried
    // `travel to capital` beside `Reach the capital city`.

    const person = name => `person${String.fromCharCode(0)}${name}`;
    const index = new Map([
        ['T3', { id: 'T3', kind: 'thread', key: 'reach the capital city' }],
        ['T5', { id: 'T5', kind: 'thread', key: 'travel to capital' }],
        ['M3', { id: 'M3', kind: 'mark', key: 'ike traumatized' }],
        ['M4', { id: 'M4', kind: 'mark', key: 'traumatized' }],
        ['A1', { id: 'A1', kind: 'adversary', key: person('goblin') }],
        ['P1', { id: 'P1', kind: 'place', key: person('goblin leader') }],
    ]);

    test('an id-prefixed side becomes the key that id stands for', () => {
        const plan = planReview({
            same_thread: [{ a: 'T3 [open] Reach the capital city', b: 'travel to capital' }],
        }, index);
        expect(plan.suspected).toEqual([
            { of: 'thread', a: 'reach the capital city', b: 'travel to capital' },
        ]);
    });

    test('two bare ids resolve to both keys', () => {
        const plan = planReview({ same_person: [{ a: 'A1', b: 'P1' }] }, index);
        expect(plan.suspected).toEqual([
            { of: 'cast', a: person('goblin'), b: person('goblin leader') },
        ]);
    });

    test('the LINES decide which table it is about, not the field it arrived in', () => {
        // The model filed a pair of MARKS under `same_thread`. Stored as a thread pair it would be
        // hunted for among threads on every pass forever; marks have no merge path, so it is
        // refused where somebody can see it.
        const plan = planReview({ same_thread: [{ a: 'M3', b: 'M4' }] }, index);
        expect(plan.suspected).toEqual([]);
        expect(plan.rejected).toEqual([
            expect.objectContaining({ reason: 'review-unmergeable' }),
        ]);
    });

    test('two labels for one line volunteer nothing', () => {
        // `T3` and its own printed name are the same row; only the ids differ in wording.
        const plan = planReview({
            same_thread: [{ a: 'T3', b: 'T3 [open] Reach the capital city' }],
        }, index);
        expect(plan.suspected).toEqual([]);
    });

    test('a pair named in plain words still works, unchanged', () => {
        // The path that always worked. Names the index cannot resolve pass through to the caller's
        // own name resolver, which is what `suspectedPairs` expects.
        const plan = planReview({
            same_thread: [{ a: 'Reach the capital city', b: 'travel to capital' }],
        }, index);
        expect(plan.suspected).toEqual([
            { of: 'thread', a: 'Reach the capital city', b: 'travel to capital' },
        ]);
    });
});

describe('the card\'s own stat line is classified by the model, never by a word list', () => {
    // ── Why this exists ──
    //
    // A card invents its own status block. The live Isekai card writes HP, MP, Level, BP, Gold,
    // Reputation, Class, Skills, Abilities, Bonds and Quests; another writes SAN, AC, Corruption,
    // Heat, Battle Power. fold has no idea what any of them mean, and the one thing RULE 1 forbids
    // is a lookup table saying which English words are vitals — it is wrong for the next card, in
    // the next genre, in the next language.
    //
    // So the review model is asked, on the pass that already runs, and answers through the schema.
    // Same licence as `same_currency` and `same_thread`.

    test('a classified field carries a kind and a tempo', () => {
        const plan = planReview({
            sheet: [
                { label: 'HP', kind: 'gauge', tempo: 'scene', same_as: '' },
                { label: 'Level', kind: 'rating', tempo: 'arc', same_as: '' },
                { label: 'Class', kind: 'identity', tempo: 'arc', same_as: '' },
            ],
        }, new Map([['T1', { id: 'T1', kind: 'thread', key: 'x' }]]));
        expect(plan.sheet).toEqual([
            { label: 'hp', kind: 'gauge', tempo: 'scene', same_as: '' },
            { label: 'level', kind: 'rating', tempo: 'arc', same_as: '' },
            { label: 'class', kind: 'identity', tempo: 'arc', same_as: '' },
        ]);
    });

    test('a gauge that names a fold row it duplicates says so', () => {
        // The MP defect: the card reports `MP: 30/50` and the ledger derives an `mp` vital from
        // events. One fact, two witnesses, and the panel drew both — in two different treatments,
        // in two different places.
        const plan = planReview({
            sheet: [{ label: 'MP', kind: 'gauge', tempo: 'scene', same_as: 'mp' }],
        }, new Map([['T1', { id: 'T1', kind: 'thread', key: 'x' }]]));
        expect(plan.sheet[0].same_as).toBe('mp');
    });

    test('a category the model invented is refused with the word it invented', () => {
        // The enum is the contract. A model answering "stat" or "misc" has not classified anything,
        // and storing it would put a field in a zone no renderer knows about.
        const plan = planReview({
            sheet: [
                { label: 'Heat', kind: 'vibe', tempo: 'scene', same_as: '' },
                { label: 'Doom', kind: 'gauge', tempo: 'eventually', same_as: '' },
            ],
        }, new Map([['T1', { id: 'T1', kind: 'thread', key: 'x' }]]));
        expect(plan.sheet).toEqual([]);
        expect(plan.rejected.map(r => r.reason)).toEqual(['sheet-unknown-kind', 'sheet-unknown-kind']);
        // The reason names WHICH, so the report says what the model tried to invent.
        expect(plan.rejected[0].item).toContain('vibe');
        expect(plan.rejected[1].item).toContain('eventually');
    });

    test('an unnamed field is refused rather than stored under an empty key', () => {
        const plan = planReview({
            sheet: [{ label: '  ', kind: 'gauge', tempo: 'scene', same_as: '' }],
        }, new Map([['T1', { id: 'T1', kind: 'thread', key: 'x' }]]));
        expect(plan.sheet).toEqual([]);
        expect(plan.rejected).toEqual([expect.objectContaining({ reason: 'sheet-unnamed' })]);
    });

    test('the block poses only what is unsorted, so a sorted sheet costs nothing', () => {
        const { text } = reviewBlock({
            sheet: [{ label: 'hp', value: '100/100' }, { label: 'class', value: 'Spellbrawler' }],
        });
        expect(text).toContain('Unsorted');
        expect(text).toContain('hp: 100/100');
        expect(text).toContain('class: Spellbrawler');
        // Nothing left to ask: no section, and therefore no tokens.
        expect(reviewBlock({ sheet: [] }).text).toBe('');
    });

    test('every kind and tempo the schema offers is a real answer', () => {
        // A schema enum the parser would refuse is a trap: the model obeys the schema and fold
        // rejects the result. They are the same list or they are a bug.
        const index = new Map([['T1', { id: 'T1', kind: 'thread', key: 'x' }]]);
        for (const kind of SHEET_KINDS) {
            for (const tempo of SHEET_TEMPO) {
                const plan = planReview({ sheet: [{ label: 'x', kind, tempo, same_as: '' }] }, index);
                expect(plan.sheet).toEqual([{ label: 'x', kind, tempo, same_as: '' }]);
            }
        }
    });
});

describe('a `same_as` naming a row the ledger does not hold does nothing', () => {
    // ── Deferring to a row that does not exist deletes the fact ──
    //
    // `same_as` means "this card field is the fact your ledger already tracks", and the panel drops
    // the card's copy so the fact renders exactly once. That is only safe when the named row
    // EXISTS. `aliasMap` has always applied this filter — "the `known` filter is what keeps a
    // verdict naming a key the ledger does not hold from doing anything, silently and safely".
    //
    // MEASURED the moment the first real classification landed in the live Isekai chat: the review
    // answered `{label: 'hp', kind: 'gauge', same_as: 'hp'}`, which is right about HP being a
    // gauge — but that chat's ledger has no `hp` vital, only `mp`. Unfiltered, the card's copy was
    // dropped in deference to nothing and HP disappeared from the panel altogether.
    //
    // This pins the predicate the panel routes on.

    const held = vitals => new Set(vitals);
    const shadowsHeld = (field, rows) => Boolean(field.same_as) && held(rows).has(field.same_as);

    test('a gauge naming a vital that exists is deduplicated', () => {
        expect(shadowsHeld({ label: 'mp', same_as: 'mp' }, ['mp'])).toBe(true);
    });

    test('a gauge naming a vital that does not exist is kept', () => {
        // The measured case. Nothing else renders HP, so dropping it loses the number outright.
        expect(shadowsHeld({ label: 'hp', same_as: 'hp' }, ['mp'])).toBe(false);
    });

    test('a money row counts as held, so a card balance can defer to the ledger', () => {
        expect(shadowsHeld({ label: 'gold', same_as: 'gold' }, ['mp', 'gold'])).toBe(true);
    });

    test('an empty answer never deduplicates anything', () => {
        expect(shadowsHeld({ label: 'gold', same_as: '' }, ['gold'])).toBe(false);
    });
});

describe('a line asked of the RECORD gets its own heading', () => {
    // ── One list, two contradictory instructions ──
    //
    // Stale lines used to render among the ordinary ones, so the instruction had to say both
    // "a thread the excerpt does not touch is still open — say nothing about it" and, one line
    // later, "a line marked [still a thing?] is the exception… this is one you should answer".
    // The conservative rule wins that argument, because it is stated first and covers every line
    // on screen.
    //
    // MEASURED, live Wuxia World RPG at 133 messages: 14 lines posed per pass, 7 wearing the stale
    // face, 24 closures against 956 asks — 2.5%. `find a blacksmith shop` sat open beside
    // `collect forged spear` (the blacksmith is found; he is forging it), and two duplicate
    // spear-collection threads were both 26+ turns cold.

    const fresh = { key: 'a', name: 'gather crystal', open: 'not yet taken', stale: 0 };
    const cold = { key: 'b', name: 'find a blacksmith', open: 'not yet located', stale: THREAD_STALE + 5 };

    test('stale lines render under their own heading, apart from the excerpt list', () => {
        const { text } = reviewBlock({ threads: [fresh, cold] });
        const settledAt = text.indexOf('Say which of these are settled');
        const forgottenAt = text.indexOf('Nothing has touched these in a long time');
        expect(settledAt).toBeGreaterThan(-1);
        expect(forgottenAt).toBeGreaterThan(settledAt);
        // The fresh one is above the second heading; the cold one below it.
        expect(text.indexOf('gather crystal')).toBeLessThan(forgottenAt);
        expect(text.indexOf('find a blacksmith')).toBeGreaterThan(forgottenAt);
    });

    test('the heading only appears when something is actually cold', () => {
        expect(reviewBlock({ threads: [fresh] }).text).not.toContain('Nothing has touched these');
        expect(reviewBlock({ threads: [cold] }).text).toContain('Nothing has touched these');
    });

    test('both kinds still answer through the same list, and the ids still route', () => {
        // The section is a heading, not a second destination — the 19 misfilings that came from
        // two arrays are not being reintroduced.
        const { text, index } = reviewBlock({ threads: [fresh, cold] });
        expect(text).toContain('"lines" answers');
        const ids = [...index.keys()];
        expect(ids).toHaveLength(2);
        const plan = planReview({ lines: ids.map(id => ({ id, still: MOOT })) }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.closures ?? plan.settled ?? []).toHaveLength(2);
    });

    test('a dialled thread is never called forgotten, however long it sits', () => {
        // `threadsByKind` filters only dial-less threads by staleness: a countdown is not stale for
        // going unmentioned, and asking "still a thing?" about a 1/3 clock invites a wrong moot.
        const dialled = { key: 'c', name: 'reach town', dial: { filled: 1, size: 3 }, stale: 99 };
        const { text } = reviewBlock({ threads: [dialled] });
        expect(text).toContain('[1/3]');
        expect(text).not.toContain('Nothing has touched these');
    });
});

describe('the dead zone: posed by one threshold, silenced by another', () => {
    // ── Two numbers decided one question ──
    //
    // `reviewableWindow` poses an untouched thread at REVIEW_EVERY (8). The block decided to ask it
    // of the RECORD at THREAD_STALE (20). Everything between the two was posed under the rule that
    // says "a thread the excerpt does not touch is still open — say nothing about it": on screen
    // every pass, answerable by nothing, closed by nothing.
    //
    // MEASURED twice in the live Wuxia chat. First: seven finished stakes at ages 4-12 — crystal
    // taken, cave found, bear killed and butchered, cores refined, level fifty reached. Closed by
    // hand; play continued; the band refilled with four more — Earth-Spiritual Liquid drunk at
    // mid 205 and still open at stale 12, Blazing Sun City reached at mid 216 and still open at
    // stale 8, the mission taken at 220, the Lava Scorpion slain at 226.

    // `turn` is what reviewableWindow measures age from; `stale` is what reviewBlock reads.
    const cold = stale => ({ key: `k${stale}`, name: `thing ${stale}`, open: 'not yet done', stale, turn: 100 - stale });

    test('a thread posed because the excerpt does not touch it is asked of the record', () => {
        // Age 9: past REVIEW_EVERY, nowhere near THREAD_STALE. The old rule posed it as [open].
        const posed = reviewableWindow([cold(9)], new Set(), 100);
        expect(posed[0].askedOfRecord).toBe(true);
        const { text } = reviewBlock({ threads: posed });
        expect(text).toContain('Nothing has touched these in a long time');
        expect(text).toContain(`[${STILL_A_THING}] thing 9`);
    });

    test('a thread the excerpt DID touch keeps the ordinary face', () => {
        // Touched lines are the ones the window can actually settle; they must stay in the list
        // that is judged from the excerpt.
        const posed = reviewableWindow([cold(9)], new Set(['thing 9']), 100);
        expect(posed[0].askedOfRecord).toBeUndefined();
        const { text } = reviewBlock({ threads: posed });
        expect(text).toContain('[open] thing 9');
        expect(text).not.toContain('Nothing has touched these');
    });

    test('the whole dead band is covered, not just its far end', () => {
        const posed = reviewableWindow([cold(8), cold(12), cold(19), cold(25)], new Set(), 100);
        expect(posed.every(t => t.askedOfRecord)).toBe(true);
        const { text } = reviewBlock({ threads: posed });
        for (const age of [8, 12, 19, 25]) {
            expect(text).toContain(`[${STILL_A_THING}] thing ${age}`);
        }
    });

    test('a thread younger than the valve is not posed at all', () => {
        // The valve's own bound is unchanged: a thread nobody has named for two turns is not
        // forgotten, it is simply not this pass's business.
        expect(reviewableWindow([cold(2)], new Set(), 100)).toEqual([]);
    });

    test('a dialled thread still prints its number, however cold', () => {
        // A countdown is not stale for going unmentioned, and "still a thing?" on a live clock
        // invites a wrong moot.
        const dialled = { key: 'd', name: 'the siege', dial: { filled: 2, size: 6 }, stale: 40 };
        const posed = reviewableWindow([dialled], new Set(), 100);
        const { text } = reviewBlock({ threads: posed });
        expect(text).toContain('[2/6]');
        expect(text).not.toContain('Nothing has touched these');
    });
});
