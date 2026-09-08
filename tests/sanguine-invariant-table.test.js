import { describe, expect, test } from '@jest/globals';

import {
    freshFindings,
    checkInvariants,
    negativeQuantities,
    partitionContradictions,
    splitCurrency,
    splitNames,
    unbackedDebits,
} from '../public/scripts/extensions/sanguine/invariant-table.js';
import { CARRIED, deriveState, itemKey, MONEY } from '../public/scripts/extensions/sanguine/state-table.js';

const PAIR_SEP = String.fromCharCode(1);

/**
 * invariant-table.js is what the ledger can prove wrong about ITSELF, no labels, no model call,
 * no human. The cases below are the live ones, taken off the chats rather than invented.
 */
describe('invariant-table, contradictions provable without ground truth', () => {
    test('a negative quantity of a physical thing is impossible', () => {
        // A CONSTRUCTED table, and the distinction matters: `deriveState` deletes any row that
        // reaches zero, so no derived inventory can hold a negative and this check cannot fire on
        // live state. The comment here used to cite "Time Stop's real state ... -11", a number that
        // came from a scratch fold omitting that rule. See `negativeQuantities` and
        // `tests/fold-crosswalk.test.js`. The function is still correct for the pre-derive tables
        // migration and replay build, which is what this pins.
        const inv = new Map([
            [itemKey('silver', MONEY), { qty: -11 }],
            [itemKey('rope'), { qty: 1 }],
        ]);
        const found = negativeQuantities(inv);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: 'negative-quantity', name: 'silver', qty: -11 });
    });

    test('one currency in two rows is a keying fault, and it is flagged across places', () => {
        // Wuxia's real state.
        const inv = new Map([
            [itemKey('silver wen'), { qty: 21 }],
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const found = splitCurrency(inv);
        expect(found).toHaveLength(1);
        expect(found[0].token).toBe('silver');
        expect(found[0].rows.map(r => r.name).sort()).toEqual(['silver', 'silver wen']);
    });

    test('two carried objects sharing a word are two objects, not a split balance', () => {
        // The discrimination that keeps this from firing on everything: no money row, no flag.
        // Time Stop really does hold both of these.
        const inv = new Map([
            [itemKey('silver ring'), { qty: 1 }],
            [itemKey('silver moon locket'), { qty: 1 }],
        ]);
        expect(splitCurrency(inv)).toEqual([]);
    });

    test('a `different` inside a merged component is a contradiction', () => {
        // a=b and b=c, so a and c are one thing; calling them different cannot be meant.
        const answers = new Map([
            [`a${PAIR_SEP}b`, { answer: 'same' }],
            [`b${PAIR_SEP}c`, { answer: 'same' }],
            [`a${PAIR_SEP}c`, { answer: 'different' }],
        ]);
        const found = partitionContradictions(answers);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: 'partition-contradiction' });
    });

    test('the live corpus shape is consistent, which is what makes the closure free', () => {
        // Measured over PERSISTED answers, nine campaigns, 69 verdicts: zero contradictions, which
        // is the condition under which transitivity may be taken as fact rather than hypothesis.
        // The licence stops there: the HARVESTED corpus carries 13 contradictions at 174 pairs, and
        // the persisted table looks clean only because `remember` keeps one answer per pair key.
        const answers = new Map([
            [`temple discovery${PAIR_SEP}temple mystery`, { answer: 'same' }],
            [`temple mystery${PAIR_SEP}temple secrets`, { answer: 'same' }],
            [`garrison integration${PAIR_SEP}garrison loyalty`, { answer: 'different' }],
        ]);
        expect(partitionContradictions(answers)).toEqual([]);
    });

    test('a split raises a QUESTION and never a merge, and that question is a free witness', () => {
        // The point of the second return value. `lib/ml/` has been starved of witnesses because
        // every one cost an LLM question slot; this one is produced by conservation, during play,
        // at no marginal cost. It is still only a question: fold does not merge on a token overlap.
        const inv = new Map([
            [itemKey('silver wen'), { qty: 21 }],
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const { violations, suspected, witnesses } = checkInvariants({ inv });
        // A split is SUSPECTED, never proven: fold cannot tell `silver wen` from `silver moon
        // locket` structurally, so it raises the question and reports no defect.
        expect(violations).toEqual([]);
        expect(suspected.some(v => v.kind === 'split-currency')).toBe(true);
        expect(witnesses).toHaveLength(1);
        expect(witnesses[0]).toMatchObject({ of: 'item', why: 'split-currency' });
        // The witness names the two KEYS, so a resolver answer can be applied to the right rows.
        expect([witnesses[0].a, witnesses[0].b].every(k => typeof k === 'string' && k.length)).toBe(true);
    });

    test('the token test is script-dependent, and this pins which scripts it fails', () => {
        // The claim "language-neutral" was made and was wrong. Splitting on non-alphanumerics needs
        // whitespace between words; Han, Hangul and Kana do not use it, and inflecting languages
        // change the stem. Pinned so the limitation cannot be forgotten again.
        const split = (a, b) => splitCurrency(new Map([
            [itemKey(a), { qty: 21 }],
            [itemKey(b, MONEY), { qty: 76 }],
        ])).length > 0;
        expect(split('silver wen', 'silver')).toBe(true);
        expect(split('二十银两', '银两')).toBe(false);
        expect(split('銀貨二十枚', '銀貨')).toBe(false);
        expect(split('은화스무닢', '은화')).toBe(false);
        expect(split('серебряных монет', 'серебро')).toBe(false);
    });

    test('an unbacked debit finds the split with NO text at all', () => {
        // The language-invariant half: money was spent from a row holding less than the debit, so
        // the credit is under another key. Pure arithmetic on fold's own numbers, this works in
        // every script, including the four the token test above misses.
        //
        // Driven by an INCIDENT rather than a negative row, and that is the correction: this test
        // used to build `{qty: -11}` and assert the scan found it. `deriveState` deletes a row the
        // moment it goes non-positive, so that table is one no fold can produce, and the function
        // returned `[]` on all nine live campaigns while real overdraws sat in the event streams.
        const inv = new Map([
            [itemKey('二十银两', MONEY), { qty: 40 }],
            [itemKey('金', MONEY), { qty: 3 }],
        ]);
        const overdrawn = [{ key: itemKey('银两', MONEY), had: 9, dq: -20, short: 11, mid: 42 }];
        const found = unbackedDebits(inv, overdrawn);
        expect(found).toHaveLength(1);
        expect(found[0].name).toBe('银两');
        expect(found[0].qty).toBe(-11);
        // Every funded row is a candidate; fold picks none of them.
        expect(found[0].candidates.map(c => c.name).sort()).toEqual(['二十银两', '金']);
    });

    test('no incidents means no report, and that is not a clean bill of health', () => {
        // The failure mode this replaces was silent: a detector that cannot fire looks exactly like
        // a ledger with nothing wrong. An empty result means "nothing was recorded" and the caller
        // has to pass what the fold recorded for it to mean anything more.
        const inv = new Map([[itemKey('silver', MONEY), { qty: 40 }]]);
        expect(unbackedDebits(inv)).toEqual([]);
        expect(unbackedDebits(inv, [])).toEqual([]);
    });

    test('spending your last coin is not an overdraw', () => {
        // A drop to exactly zero is ordinary. Only a debit LARGER than the balance is evidence.
        const events = [
            { t: 1, mid: 1, d: { inv: [{ item: 'silver', at: MONEY, dq: 5 }] } },
            { t: 2, mid: 2, d: { inv: [{ item: 'silver', at: MONEY, dq: -5 }] } },
        ];
        expect(deriveState(events).overdrawn).toEqual([]);
    });

    test('deriveState records the overdraw it is about to destroy the evidence of', () => {
        // Isekai's real incident: money/copper held 12 and was debited 14 at mid 54.
        const events = [
            { t: 1, mid: 3, d: { inv: [{ item: 'copper', at: MONEY, dq: 12 }] } },
            { t: 2, mid: 54, d: { inv: [{ item: 'copper', at: MONEY, dq: -14 }] } },
        ];
        const state = deriveState(events);
        expect(state.inv.has(itemKey('copper', MONEY))).toBe(false);
        expect(state.overdrawn).toHaveLength(1);
        expect(state.overdrawn[0]).toMatchObject({ had: 12, dq: -14, short: 2, mid: 54 });
    });

    test('an unbacked debit offers only MONEY rows as candidates, and that is deliberate', () => {
        // Wuxia's real split is cross-place: `carried silver wen` holds the credit for a debit at
        // `money silver`. With no text there is nothing to narrow carried rows by, so offering all
        // of them would pair a shortfall against the dagger, the bow, the map and the rest, a flood
        // of obviously-different questions spending the review's eight slots on noise.
        //
        // So the text-free detector stays precise and money-only, and the cross-place case is the
        // token supplement's job wherever the script separates words. Where it does not (Han,
        // Hangul, Kana, inflected Slavic), a cross-place split is caught only once it OVERDRAWS,
        // late, but caught, which is the half that was missing while this function was dead.
        const inv = new Map([
            [itemKey('dagger'), { qty: 1 }],
            [itemKey('bow'), { qty: 1 }],
        ]);
        const overdrawn = [{ key: itemKey('silver', MONEY), had: 1, dq: -12, short: 11, mid: 79 }];
        const found = unbackedDebits(inv, overdrawn);
        expect(found).toHaveLength(1);
        expect(found[0].candidates).toEqual([]);
    });

    test('an overdraw on a carried item is not a currency question', () => {
        // Solo Leveling really did debit two painkillers from a row holding one. It is a defect and
        // it is logged, but it is not evidence of a SPLIT CURRENCY, so it raises no pair.
        const overdrawn = [{ key: itemKey('painkillers'), had: 1, dq: -2, short: 1, mid: 191 }];
        expect(unbackedDebits(new Map(), overdrawn)).toEqual([]);
    });

    test('the two detectors cover different halves, and both become witnesses', () => {
        const inv = new Map([
            [itemKey('二十银两', MONEY), { qty: 40 }],    // the funded row the credit is likely in
            [itemKey('silver wen'), { qty: 21 }],        // overlap: found by the token supplement
            [itemKey('silver', MONEY), { qty: 76 }],
        ]);
        const overdrawn = [{ key: itemKey('银两', MONEY), had: 9, dq: -20, short: 11, mid: 42 }];
        const { suspected, witnesses } = checkInvariants({ inv, overdrawn });
        expect(suspected.some(v => v.kind === 'unbacked-debit')).toBe(true);
        expect(suspected.some(v => v.kind === 'split-currency')).toBe(true);
        expect(witnesses.some(w => w.why === 'unbacked-debit')).toBe(true);
        expect(witnesses.some(w => w.why === 'split-currency')).toBe(true);
    });

    test('a clean ledger reports nothing', () => {
        const inv = new Map([
            [itemKey('rope'), { qty: 1 }],
            [itemKey('silver', MONEY), { qty: 30 }],
        ]);
        expect(checkInvariants({ inv, answers: [] })).toEqual({ violations: [], suspected: [], witnesses: [] });
    });
});

describe('invariant-table, one pair raises one question', () => {
    test('a key that overdraws repeatedly does not re-ask the same pair', () => {
        // Time Stop's `money silver` overdrew three times; each incident offers the same funded
        // rows, so the naive loop spent a review slot per repeat.
        const inv = new Map([
            [itemKey('gold', MONEY), { qty: 8 }],
            [itemKey('copper', MONEY), { qty: 15 }],
        ]);
        const overdrawn = [
            { key: itemKey('silver', MONEY), had: 0, dq: -9, short: 9, mid: 38 },
            { key: itemKey('silver', MONEY), had: 10, dq: -12, short: 2, mid: 79 },
        ];
        const { witnesses } = checkInvariants({ inv, overdrawn });
        expect(witnesses).toHaveLength(2);
        expect(witnesses.map(w => w.b).sort()).toEqual([itemKey('copper', MONEY), itemKey('gold', MONEY)].sort());
    });

    test('the dedup is order-independent', () => {
        // The same pair reached from either side is one question.
        const inv = new Map([[itemKey('silver wen'), { qty: 21 }], [itemKey('silver', MONEY), { qty: 76 }]]);
        const overdrawn = [{ key: itemKey('silver', MONEY), had: 1, dq: -3, short: 2, mid: 9 }];
        const { witnesses } = checkInvariants({ inv, overdrawn });
        const ids = witnesses.map(w => [w.a, w.b].sort().join('|'));
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the invariants stop at the owner\'s edge', () => {
    test('two people carrying swords is not one row that split', () => {
        // `splitNames` is a token-containment test over one person's belongings. Across owners the
        // relation is meaningless, {sword} ⊂ {shortsword… } would raise Kaelira against Solomon on
        // the strength of them both being armed, and spend a review question on it.
        const inv = new Map([
            [itemKey('sword'), { qty: 1 }],
            [itemKey('bronze sword', CARRIED, 'Kaelira'), { qty: 1 }],
        ]);
        expect(splitNames(inv)).toEqual([]);
        // Same two names on ONE person is still the split it always was.
        const one = new Map([
            [itemKey('sword', CARRIED, 'Kaelira'), { qty: 1 }],
            [itemKey('bronze sword', CARRIED, 'Kaelira'), { qty: 1 }],
        ]);
        expect(splitNames(one)).toHaveLength(1);
    });

    test('a companion holding silver is not evidence the player\'s silver is split', () => {
        // "One currency in two rows" is a question about one purse. New Eldoria hands Vexia half of
        // a 33-gold payout; her gold and Solomon's gold are two people paid, not one balance torn.
        const inv = new Map([
            [itemKey('gold', MONEY), { qty: 17 }],
            [itemKey('gold', MONEY, 'Vexia'), { qty: 16 }],
        ]);
        expect(splitCurrency(inv)).toEqual([]);
    });
});

describe('splitNames, the non-money half that had no detector at all', () => {
    test('the live Isekai duplicate: one skill recorded twice', () => {
        // Granted at mid 4 with its rank, re-reported at mid 46 without it. Nothing in this file
        // could see it: splitCurrency needs a money row, unbackedDebits needs an overdraw, and
        // `same_currency` reads the Money block. So it sat on the panel as two abilities.
        const inv = new Map([
            [itemKey('quarterstaff proficiency (e)', 'abilities'), { qty: 1 }],
            [itemKey('quarterstaff proficiency', 'abilities'), { qty: 1 }],
        ]);
        const found = splitNames(inv);
        expect(found).toHaveLength(1);
        expect(found[0].rows.map(r => r.name).sort()).toEqual(['quarterstaff proficiency', 'quarterstaff proficiency (e)']);
    });

    test('it raises a QUESTION and never merges, the two genuine refusals stay separate rows', () => {
        // Royal Succession really holds two ledgers; Star Wars really holds a plain dataspike and an
        // FS-4. Both are asked, neither is decided here.
        const inv = new Map([
            [itemKey('second ledger'), { qty: 1 }],
            [itemKey('ledger'), { qty: 1 }],
        ]);
        const { violations, suspected } = checkInvariants({ inv });
        expect(violations).toEqual([]);
        expect(suspected.some(s => s.kind === 'split-name')).toBe(true);
    });

    test('sharing a token is not containment, which is what keeps it off everything', () => {
        // The looser shared-token rule `splitCurrency` uses is right for currency names and far too
        // loose here: it would pair every carried item sharing any word.
        const inv = new Map([
            [itemKey('silver ring'), { qty: 1 }],
            [itemKey('silver moon locket'), { qty: 1 }],
            [itemKey('iron shortsword'), { qty: 1 }],
            [itemKey('worn iron shortsword'), { qty: 1 }],
        ]);
        const found = splitNames(inv);
        // ring/locket share "silver" but neither contains the other; the shortswords do.
        expect(found).toHaveLength(1);
        expect(found[0].rows.map(r => r.name).sort()).toEqual(['iron shortsword', 'worn iron shortsword']);
    });

    test('the same name in two PLACES is two things, and place is part of identity by design', () => {
        // The ledger's own rule: a crowbar in the boot and a crowbar in your hand are two entries,
        // and moving one must not silently merge them. Cross-place is money's case alone.
        const inv = new Map([
            [itemKey('crowbar', 'boot'), { qty: 1 }],
            [itemKey('crowbar'), { qty: 1 }],
        ]);
        expect(splitNames(inv)).toEqual([]);
    });

    test('identical names cannot be a pair, because they are one key', () => {
        expect(splitNames(new Map([[itemKey('rope'), { qty: 2 }]]))).toEqual([]);
    });

    test('the pair becomes a witness with both real ledger keys', () => {
        const inv = new Map([
            [itemKey('quarterstaff proficiency (e)', 'abilities'), { qty: 1 }],
            [itemKey('quarterstaff proficiency', 'abilities'), { qty: 1 }],
        ]);
        const { witnesses } = checkInvariants({ inv });
        const w = witnesses.find(x => x.why === 'split-name');
        expect(w).toBeTruthy();
        expect(w.of).toBe('item');
        expect([w.a, w.b].every(k => k.includes('abilities'))).toBe(true);
    });
});

describe('freshFindings, a standing condition is not an event', () => {
    // The live Wuxia World RPG, measured.
    //
    // 118 rejections recorded, of which NINETY-FOUR were `invariant:overdraw` with a single distinct
    // payload: `copper, held 1, debited 2` at mid 50, one real incident. `auditLedger` runs on
    // every pass and re-reads `state.overdrawn`, which `deriveState` recomputes from the whole event
    // history each time, so a condition that happened once got pushed through `noteRejections` on
    // every pass thereafter.
    //
    // Two costs, and the second is worse than the miscount. `observe.note` is the Count face, so the
    // tally read 94 defects where there was one. And `log.js` caps at LOG_LIMIT = 120, so the flood
    // occupied 94 of 120 diagnostic slots, leaving 26 for every real rejection in the chat, each
    // duplicate carrying an empty `raw`, an empty `snippet` and a null `mid`.
    //
    // A rejection is an EVENT: the model proposed, fold refused. An invariant finding is a STATE:
    // it is true of the ledger until the ledger changes. Reporting the second through the channel
    // built for the first is the category error, and this is the filter that separates them.

    test('the same finding reported twice is reported once', () => {
        const found = [{ kind: 'overdraw', key: 'money\u0000copper', had: 1, dq: -2, short: 1, mid: 50 }];
        const first = freshFindings(found, new Set());
        expect(first.fresh).toHaveLength(1);
        expect(freshFindings(found, first.seen).fresh).toEqual([]);
        expect(freshFindings(found, first.seen).fresh).toEqual([]);
    });

    test('a genuinely second incident on the same row is still reported', () => {
        // Identity is the incident, not the row: overdrawing copper twice is two defects, and a
        // filter that collapsed them would hide the second one forever.
        const one = { kind: 'overdraw', key: 'money\u0000copper', had: 1, dq: -2, short: 1, mid: 50 };
        const two = { kind: 'overdraw', key: 'money\u0000copper', had: 3, dq: -4, short: 1, mid: 88 };
        const { seen } = freshFindings([one], new Set());
        expect(freshFindings([one, two], seen).fresh).toEqual([two]);
    });

    test('violations without a mid are keyed on what makes them distinct', () => {
        // A split name or a contradicted partition is standing rather than anchored, it has no
        // mid, so its identity is the pair it is about. Re-derived every pass, reported once.
        const v = { kind: 'partition-contradiction', a: 'money\u0000silver', b: 'carried\u0000silver wen' };
        const { fresh, seen } = freshFindings([v], new Set());
        expect(fresh).toHaveLength(1);
        expect(freshFindings([v], seen).fresh).toEqual([]);
        // A different pair is a different finding.
        expect(freshFindings([{ ...v, b: 'carried\u0000silver ring' }], seen).fresh).toHaveLength(1);
    });

    test('the seen set carries forward rather than being replaced', () => {
        const a = { kind: 'overdraw', key: 'k', had: 1, dq: -2, short: 1, mid: 10 };
        const b = { kind: 'overdraw', key: 'k', had: 1, dq: -2, short: 1, mid: 20 };
        const first = freshFindings([a], new Set());
        const second = freshFindings([b], first.seen);
        expect(second.seen.size).toBe(2);
        expect(freshFindings([a, b], second.seen).fresh).toEqual([]);
    });
});
