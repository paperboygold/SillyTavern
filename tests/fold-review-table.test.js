import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    MAX_MARK_LINES,
    MAX_QUESTIONS,
    STILL,
    describePlan,
    isTouched,
    outstanding,
    pairKey,
    planReview,
    reviewBlock,
    reviewSchema,
    reviewableWindow,
} from '../public/scripts/extensions/fold/review-table.js';
import {
    CLOSED,
    DOOM,
    MOOT,
    PROGRESS,
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
    parseAmount,
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
        expect(reviewSchema().properties.lines.items.properties.still.enum).toEqual(STILL);
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'same', note: 'one man, one counter' }] }, index);
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'same', note: 'one raid, two wordings' }] }, index);

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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'different', note: 'a family, not a person' }] }, index);

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
            answers: [],
        }, index);

        expect(plan.closures).toEqual([{ key: 'a weapon that is not a goblin’s knife', status: CLOSED, note: 'staff and shortsword bought' }]);
        expect(plan.kept).toBe(1);
        // And the summary that becomes the audit event names what changed, in words a reader
        // scrolling the chronicle can use.
        const names = new Map([...table].map(([key, row]) => [key, row.name]));
        expect(describePlan(plan, names)).toContain('A weapon that is not a goblin’s knife is settled');
    });

    test('and the closure removes it from the ledger the NEXT pass pins', () => {
        const plan = planReview({ lines: [{ id: weaponId, still: 'settled', note: '' }], answers: [] }, index);
        const view = overlayClosures(table, plan.closures);
        const next = reviewBlock({ threads: threadsByKind(view, 14).open });
        expect(next.text).not.toContain('A weapon that is not a goblin’s knife');
    });

    test('`moot` is a closure too, and it is not failure', () => {
        const plan = planReview({ lines: [{ id: weaponId, still: 'moot', note: 'no longer matters' }], answers: [] }, index);
        expect(plan.closures[0].status).toBe(MOOT);
    });

    test('`advanced` is counted and deliberately does not write a tick', () => {
        // The dial probe rides the same call and is the thing that reports how far something moved,
        // with MAX_TICK bounding it. Synthesising a tick from a word would be a second, unbounded
        // writer on one field. What `advanced` buys is the §12 rubber-stamp measurement.
        const plan = planReview({ lines: [{ id: weaponId, still: 'advanced', note: 'set aside for purchase' }], answers: [] }, index);
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

    test('the question carries the balance on record', () => {
        const { text } = reviewBlock({ owed: { items: ['darkwood staff', 'shortsword'], balance: 330000, currency: 'won' } });
        expect(text).toContain('recorded as gained with nothing paid: darkwood staff, shortsword');
        expect(text).toContain('Balance on record: 330000 won');
    });

    test('a canned "₩120,000" lands the debit, and the balance moves', () => {
        const { index } = reviewBlock({ owed: { items: ['darkwood staff', 'shortsword'], balance: 330000, currency: 'won' } });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [], answers: [{ id, answer: '₩120,000', note: 'handed over the 120k' }] }, index);
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'nothing — the ahjumma gave them to him', note: '' }] }, index);
        expect(plan.money).toEqual(expect.objectContaining({ amount: 0 }));
    });

    test('an unreadable amount is refused rather than guessed at', () => {
        const { index } = reviewBlock({ owed: { items: ['staff'], balance: 1, currency: 'won' } });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [], answers: [{ id, answer: 'quite a lot, honestly', note: '' }] }, index);
        expect(plan.money).toBeNull();
        expect(plan.rejected[0].reason).toBe('review-unreadable-amount');
    });

    test('amounts are read with their scale words, not their currency symbols', () => {
        expect(parseAmount('₩120,000')).toBe(120000);
        expect(parseAmount('120k won')).toBe(120000);
        expect(parseAmount('eighty-five thousand')).toBeNull();
        expect(parseAmount('85 thousand')).toBe(85000);
        expect(parseAmount('nothing at all')).toBeNull();
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'the Nowon gate site', note: 'news crawl says sealed' }] }, index);
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'the Nowon gate site', note: 'dispersed after the raid' }] }, index);
        expect(plan.places).toEqual([{ key: entityKey(PERSON, 'kim'), name: 'Kim', place: 'the Nowon gate site', note: 'dispersed after the raid' }]);
    });

    test('"unknown" is a real answer and never becomes a place name', () => {
        // A cast row with `place: "unknown"` would put the presence predicate to work comparing
        // rooms to the word "unknown", which is worse than the UNPLACED it replaced.
        const { index } = reviewBlock({ unplaced: [{ key: entityKey(PERSON, 'kim'), name: 'Kim' }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [], answers: [{ id, answer: 'unknown', note: '' }] }, index);
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
        const plan = planReview({ lines: [], answers: [{ id, answer: 'progress', note: 'he wins residency' }] }, index);
        expect(plan.polarity).toEqual([{ key: 'residency in korea', kind: PROGRESS, note: 'he wins residency' }]);
    });

    test('"good" and "bad" are accepted as the words a reader would use', () => {
        const { index } = reviewBlock({ polarity: [{ thread: 'x', name: 'X', about: '' }] });
        const id = [...index.keys()][0];
        expect(planReview({ lines: [], answers: [{ id, answer: 'bad', note: '' }] }, index).polarity[0].kind).toBe(DOOM);
    });
});

describe('an answer fold cannot place is refused, never repaired by guessing', () => {
    test('an id that was never asked about', () => {
        const plan = planReview({ lines: [{ id: 'T99', still: 'settled', note: '' }], answers: [] }, new Map());
        expect(plan.closures).toEqual([]);
        expect(plan.rejected).toEqual([{ item: 'T99', reason: 'review-unknown-id' }]);
    });

    test('a disposition filed against a question', () => {
        const { index } = reviewBlock({ unplaced: [{ key: 'k', name: 'Kim' }] });
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, still: 'settled', note: '' }], answers: [] }, index);
        expect(plan.rejected).toEqual([{ item: id, reason: 'review-wrong-shape' }]);
    });

    test('an empty fragment changes nothing', () => {
        const plan = planReview(null, new Map());
        expect(plan.closures).toEqual([]);
        expect(plan.merges).toEqual([]);
        expect(plan.rejected).toEqual([]);
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
