import { describe, expect, test } from '@jest/globals';

import {
    itemKey,
    validateInventory,
} from '../public/scripts/extensions/fold/state-table.js';
import { foldEntities } from '../public/scripts/extensions/fold/entity-table.js';
import { PERSON } from '../public/scripts/extensions/fold/entity-table.js';
import { foldTicks } from '../public/scripts/extensions/fold/thread-table.js';
import { planReview, reviewBlock } from '../public/scripts/extensions/fold/review-table.js';

/*
 * ── The replay: the proposals the model REALLY made in the Time Stop RPG chat ──
 *
 * Ground truth is the user's live chat, not this suite. Every rejected fragment below is copied
 * verbatim from the panel's diagnostics of
 * `data/default-user/chats/Time Stop RPG Fantasy/Time Stop RPG Fantasy - 2026-08-09@13h39m24s664ms.jsonl`
 * (the rejection log `state.log`, read from a scratch copy). The chat is not written to.
 *
 * Three structural defects produced the 28 rejections this reproduces:
 *
 *   · `review-wrong-shape` (19, all P1-P10): the review block rendered dispositions and questions
 *     as one flat list, so the model filed `[where now?]` place answers into `lines`. Now the block
 *     renders them as two sections, and a correctly-filed answer is applied, not refused.
 *   · negative deltas double-billed (the spear at mids 36/38, the room at 73/74, the locket at
 *     66/67): one thing billed twice drained the balance and the THIRD bill read `remove-unknown`.
 *     Now the contributor-trail exact-dq guard covers losses.
 *   · the alias gap (the widow): the window said "the woman" while the stored name was "widow", and
 *     the mention gate checked only the primary name. Now it checks the aliases the observation
 *     declares, and the probe is told to record every name the excerpt actually uses.
 */
describe('Time Stop RPG replay — the rejected fragments, through the fixed gates', () => {
    test('a place question answered in "answers" is placed, not refused (the P-reject)', () => {
        const { text, index } = reviewBlock({
            unplaced: [{ key: 'person\u0000widow', name: 'the widow', place: 'garden gate' }],
        });
        expect(text).toContain('[where now?] the widow');
        const id = [...index.keys()][0];
        const plan = planReview({ lines: [{ id, place: 'the inn', note: 'went to buy a room' }] }, index);
        expect(plan.rejected).toEqual([]);
        expect(plan.places).toEqual([{ key: 'person\u0000widow', name: 'the widow', place: 'the inn', note: 'went to buy a room' }]);
    });

    test('the second spear bill is a re-tell, not a fresh spend', () => {
        // Event at mid 38: "Sol purchased a spear from the smith for ten silver" — the same spear
        // already billed at mid 36. The window names the purchase; the trail has the exact -10.
        const inv = new Map([[itemKey('silver', 'money'), { qty: 10 }]]);
        const contributors = new Map([[itemKey('silver', 'money'), [{ dq: -10, summary: 'buys an ash spear', mid: 36 }]]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'silver', dq: -10, at: 'money' }],
            windowText: 'Sol purchased a spear from the smith for ten silver.',
            contributors,
            // The window this pass displayed: trailing six ending at its anchor. Mid 36 is in it,
            // so the earlier bill is something the model can still read — which is the only
            // evidence a re-tell refusal is allowed to rest on.
            visible: new Set([33, 34, 35, 36, 37, 38]),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'silver', reason: 'already-recorded' })]);
    });

    test('the second room rental is a re-tell, not a fresh payment', () => {
        // Mids 73 and 74 both bill "pays two silver for a room at The Spear & Thistle".
        const inv = new Map([[itemKey('silver', 'money'), { qty: 2 }]]);
        const contributors = new Map([[itemKey('silver', 'money'), [{ dq: -2, summary: 'rented a room', mid: 73 }]]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'silver', dq: -2, at: 'money' }],
            windowText: 'Sol pays two silver for a room at The Spear & Thistle and gets a meal.',
            contributors,
            visible: new Set([69, 70, 71, 72, 73, 74]),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'silver', reason: 'already-recorded' })]);
    });

    test('the second locket give-back is a re-tell, not a fresh removal', () => {
        // Mids 66 and 67 both bill "silver moon locket -1". The second is the same give-back.
        const key = itemKey('silver moon locket');
        const inv = new Map([[key, { qty: 0 }]]);
        const contributors = new Map([[key, [{ dq: -1, summary: 'gave the locket back', mid: 66 }]]]);
        const { rejected } = validateInventory({
            inv,
            deltas: [{ item: 'silver moon locket', dq: -1 }],
            windowText: 'Sol returns his silver moon locket to the widow.',
            contributors,
        });
        // Held at 0, the magnitude 1 is NOT <= held 0, so the trail gate does not claim a re-tell —
        // this is a removal of nothing, which the underflow clamp flags. The point is that with the
        // FIRST duplicate refused (the test above), the balance never drains to 0 in the first place.
        expect(rejected).toEqual([expect.objectContaining({ reason: 'clamped-underflow' })]);
    });

    test('the locket lands on "silver moon locket" when the model names it with same_as', () => {
        // The remove-unknown on "locket" happened because the ledger holds "silver moon locket" and
        // the old head-merge joined them by English morphology. Identity is the model's answer now:
        // when the model means the held item under a different spelling, it sets "same_as" to the
        // exact held name, and fold merges on that word — never on its own guess.
        const inv = new Map([[itemKey('silver moon locket'), { qty: 1 }]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'locket', same_as: 'silver moon locket', dq: -1 }],
            windowText: 'The widow\'s hands freeze mid-reach as you place the locket in her palm.',
            mentioned: new Set(['locket']),
        });
        expect(accepted).toEqual([{ item: 'silver moon locket', dq: -1 }]);
    });

    test('a "locket" with no same_as is a separate row until the model says otherwise', () => {
        // Without the model's word, fold keys under exactly what it reported — a visible, correctable
        // new row, resolved by a `[same?]` review question rather than by a spelling guess.
        const inv = new Map([[itemKey('silver moon locket'), { qty: 1 }]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'locket', dq: 1 }],
            windowText: 'The widow\'s hands freeze mid-reach as you place the locket in her palm.',
            mentioned: new Set(['locket']),
        });
        expect(accepted).toEqual([{ item: 'locket', dq: 1 }]);
    });

    test('the widow is mentioned through an alias the observation declares', () => {
        const table = new Map();
        const { accepted, rejected } = foldEntities(table, [{
            kind: PERSON, name: 'widow', aka: 'Elin\'s mother', place: 'garden gate', status: 'present',
        }], { windowText: 'The widow\'s hands freeze mid-reach as you place the locket in her palm.', turn: 1 });
        expect(accepted).toBe(1);
        expect(rejected).toEqual([]);
    });

    test('an invented silver spend is still refused — the mention gate keeps its teeth', () => {
        // The coin-purse / silver proposals at t27 were the model inferring a cost the window never
        // stated ("purchase a room" — no silver, no amount). That is exactly what the gate exists to
        // refuse, and the section fix must not have loosened it.
        const { accepted, rejected } = validateInventory({
            inv: new Map([[itemKey('silver', 'money'), { qty: 20 }]]),
            deltas: [{ item: 'silver', dq: -2, at: 'money' }],
            windowText: 'Sol: I nod to the woman once, and then turn off to head on down to the inn and purchase a room for the night.',
            // The window names no coin and no amount, and the model's own report says so: it named
            // nothing. That empty attestation is what refuses the inferred cost now — not a token
            // test over the word "silver".
            mentioned: new Set(),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'not-mentioned' })]);
    });
});

describe('coverage by the model\'s report ([ROUTER]) — the Star Wars Vesk/Gorak/Weequay window', () => {
    // The Star Wars chat rejected Vesk, Gorak and Weequay as `not-mentioned` because the gate
    // token-matched the window. The model's `mentions` report is the authority now: a person is
    // admitted when the model says the excerpt names them, whatever the prose's wording.
    const WINDOW = 'You push yourself upright as the pain in your ribs makes itself known. '
        + 'The Weequay watches you pass, his prod idle. Gorak\'s heard the name you\'re making.';

    test('a person in the model\'s mentions is admitted, however the prose words it', () => {
        const table = new Map();
        const mentioned = new Set(['weequay', 'gorak', 'vesk']);
        const { accepted, rejected } = foldEntities(table, [
            { kind: PERSON, name: 'Weequay', place: 'the gate', status: 'present' },
            { kind: PERSON, name: 'Gorak', status: 'remote' },
            { kind: PERSON, name: 'Vesk', place: 'arena floor', status: 'remote' },
        ], { windowText: WINDOW, turn: 1, mentioned });
        expect(accepted).toBe(3);
        expect(rejected).toEqual([]);
    });

    test('a person in neither the mentions nor the window is refused, even if a token matches', () => {
        // The report is the floor, not the whole answer: a name the model actually read is admitted
        // even when the report omitted it (measured in the Wuxia RP — the POV character and fight
        // actors were dropped from `mentions` and wrongly rejected while the snippet named them).
        // What the OR must still refuse is a name in NEITHER the report NOR the window — a
        // fabrication that merely shares a content token with the prose, like a person whose name
        // happens to share "ribs" with a line about ribs. That is the over-admission the report
        // gate exists to stop.
        const table = new Map();
        const mentioned = new Set(['the weequay']);
        const { accepted, rejected } = foldEntities(table, [
            { kind: PERSON, name: 'Ribson', status: 'remote' },
        ], { windowText: WINDOW, turn: 1, mentioned });
        expect(accepted).toBe(0);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'not-mentioned' })]);
    });

    test('a dial in the mentions is admitted to advance', () => {
        const table = new Map();
        const mentioned = new Set(['the blight reaches briarwood']);
        const { accepted, rejected } = foldTicks(table, [
            { name: 'The Blight reaches Briarwood', tick: 1 },
        ], { turn: 1, windowText: 'the blight creeps closer each night', mentioned });
        expect(accepted).toBe(1);
        expect(rejected).toEqual([]);
    });

    test('a dial NOT in the mentions is refused even when a token matches', () => {
        const table = new Map();
        const mentioned = new Set(['the residency window']);
        const { accepted, rejected } = foldTicks(table, [
            { name: 'The Blight reaches Briarwood', tick: 1 },
        ], { turn: 1, windowText: 'the blight creeps closer each night', mentioned });
        expect(accepted).toBe(0);
        expect(rejected).toEqual([expect.objectContaining({ reason: 'not-mentioned' })]);
    });
});
