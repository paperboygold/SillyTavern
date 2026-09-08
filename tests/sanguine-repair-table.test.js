import { describe, expect, test } from '@jest/globals';

/*
 * sanguine-repair-table: the line the whole redesign turns on.
 *
 * The measurement that produced it: `reconcile:asked: 80`, `reconcile:declined: 2`,
 * `reconcile:applied: 0`. One gate guarded the whole plan, so three obviously-good repairs were
 * hostage to two frightening ones and the batch was declined entire. `tierRepairs` is the repair for
 * that, and it is one line of judgement stated as data, which makes it exactly the kind of thing
 * that can be quietly wrong forever if nobody holds it.
 *
 * What each test here is actually protecting:
 *
 *   · A verdict silently moving lane. `amount` drifting into the auto lane would rewrite quantities
 *     with no announcement anywhere, the failure mode the tiering exists to prevent.
 *   · The undo taxonomy losing its honesty. `undoKindOf` is what lets a surface decline to offer a
 *     button that would do nothing, and an undo that quietly expires is the defect being repaired.
 *   · Clustering collapsing the singleton case, which is most of them.
 */

import {
    ASK, AUTO, MAX_LEDGER_PASSES, TIER_OF, askKey, clusterAsks, clusterKey, tierRepairs, undoKindOf,
} from '../public/scripts/extensions/sanguine/repair-table.js';
import {
    AMOUNT, GONE, MERGE, MOVE, RENAME, SPLIT, VERDICTS, KEEP,
} from '../public/scripts/extensions/sanguine/reconcile-table.js';

const repair = (op, kind, key, extra = {}) => ({ op, kind, key, name: key, evidence: 'the story shows it', ...extra });

describe('the tiering line is conservation of substance', () => {
    test('every repairable verdict has a lane, and `keep` is not a repair', () => {
        const repairable = VERDICTS.filter(verdict => verdict !== KEEP);
        expect(Object.keys(TIER_OF).sort()).toEqual([...repairable].sort());
        expect(TIER_OF[KEEP]).toBeUndefined();
    });

    test('the conserving half applies on sight', () => {
        // Afterwards the world contains exactly the same stuff: a different name, a different place,
        // a finer granularity. `splitDelta` credits every part and clamps the debit, so even the one
        // that destroys its source row conserves the quantity.
        expect(TIER_OF[RENAME]).toBe(AUTO);
        expect(TIER_OF[MOVE]).toBe(AUTO);
        expect(TIER_OF[SPLIT]).toBe(AUTO);
    });

    test('the non-conserving half asks, and `amount` is the reason the line is not invertibility', () => {
        // `amount` is trivially invertible, `setItemQty(key, from)`, and is still the most
        // dangerous verdict there is, because nothing on the panel announces that 2,944 gold became
        // 340. Risk is noticeability x recoverability, and a lane assigned by invertibility alone
        // would put the silent one on the auto side.
        expect(TIER_OF[AMOUNT]).toBe(ASK);
        expect(TIER_OF[GONE]).toBe(ASK);
        expect(TIER_OF[MERGE]).toBe(ASK);
    });

    test('a plan splits into two lanes, each in the order it was posed', () => {
        const plan = [
            repair(SPLIT, 'item', 'ammunition'),
            repair(GONE, 'cast', 'infected man'),
            repair(RENAME, 'item', 'sig p226'),
            repair(AMOUNT, 'item', 'gold'),
            repair(MOVE, 'cast', 'ada wong'),
            repair(MERGE, 'thread', 'residency'),
        ];
        const { auto, ask } = tierRepairs(plan);
        expect(auto.map(entry => entry.op)).toEqual([SPLIT, RENAME, MOVE]);
        expect(ask.map(entry => entry.op)).toEqual([GONE, AMOUNT, MERGE]);
    });

    test('a verdict this file has never heard of asks rather than lands', () => {
        // The safe direction for a vocabulary that grew without this file noticing. An unrecognised
        // repair landing unreviewed is the exact failure the redesign forbids; an unrecognised repair
        // becoming a card nobody answers costs nothing at all.
        const { auto, ask } = tierRepairs([repair('reticulate', 'item', 'splines')]);
        expect(auto).toEqual([]);
        expect(ask).toHaveLength(1);
    });

    test('a repair with no verdict is not a lane assignment problem, it is not a repair', () => {
        const { auto, ask } = tierRepairs([{ kind: 'item', key: 'x' }, null, undefined]);
        expect(auto).toEqual([]);
        expect(ask).toEqual([]);
    });

    test('nothing at all is two empty lanes rather than a throw', () => {
        expect(tierRepairs(undefined)).toEqual({ auto: [], ask: [] });
        expect(tierRepairs('not a plan')).toEqual({ auto: [], ask: [] });
    });
});

describe('asks cluster by (op, kind), and singletons stay singletons', () => {
    test('the three dead where they fell become one card', () => {
        // Real, from the live Raccoon City record: `infected man` ("dead on the floor"), `mechanic in
        // the coveralls` ("dead, hatchet in skull"), `two other figures` ("dead, killed by Solomon").
        // One judgement, is the pass reading death correctly, currently wearing three cards.
        const cards = clusterAsks([
            repair(GONE, 'cast', 'infected man'),
            repair(GONE, 'cast', 'mechanic in the coveralls'),
            repair(GONE, 'cast', 'two other figures'),
        ]);
        expect(cards).toHaveLength(1);
        expect(cards[0].count).toBe(3);
        expect(cards[0].op).toBe(GONE);
        expect(cards[0].kind).toBe('cast');
        expect(cards[0].members.map(member => member.key)).toEqual(
            ['infected man', 'mechanic in the coveralls', 'two other figures']);
        expect(cards[0].key).toBe(clusterKey(GONE, 'cast'));
    });

    test('a lone ask is still a card, so the caller has one shape to render', () => {
        const cards = clusterAsks([repair(AMOUNT, 'item', 'gold')]);
        expect(cards).toHaveLength(1);
        expect(cards[0].count).toBe(1);
        expect(cards[0].members).toHaveLength(1);
    });

    test('the same verdict on a different kind is a different card', () => {
        // A dead person and a spent round are not one judgement. Each kind's `gone` reaches a
        // different writer, so grouping across them would put two decisions behind one click.
        const cards = clusterAsks([
            repair(GONE, 'cast', 'infected man'),
            repair(GONE, 'item', '9mm rounds'),
            repair(GONE, 'cast', 'two other figures'),
        ]);
        expect(cards.map(card => [card.kind, card.count])).toEqual([['cast', 2], ['item', 1]]);
    });

    test('cards come back in the order the block posed them', () => {
        // The asks arrive in block order and a player reads them top to bottom. Re-sorting by size
        // or by verdict would move a card under somebody mid-decision.
        const cards = clusterAsks([
            repair(AMOUNT, 'item', 'gold'),
            repair(GONE, 'cast', 'infected man'),
            repair(GONE, 'cast', 'two other figures'),
            repair(MERGE, 'thread', 'residency'),
        ]);
        expect(cards.map(card => card.op)).toEqual([AMOUNT, GONE, MERGE]);
    });

    test('an empty queue is an empty list', () => {
        expect(clusterAsks([])).toEqual([]);
        expect(clusterAsks(null)).toEqual([]);
    });
});

describe('identity, which supersession and undo both address rows by', () => {
    test('kind and key, because keys are only unique within their table', () => {
        // A thread and a mark can legitimately carry the same string. Keyed on the string alone, one
        // pass's question about a stake would supersede another's about a wound.
        expect(askKey({ kind: 'thread', key: 'blood loss' }))
            .not.toBe(askKey({ kind: 'mark', key: 'blood loss' }));
    });

    test('the separator is the one byte a name cannot contain', () => {
        // NUL, matching `entity-table.js`:139 and `state-table.js`:137. A visible separator could
        // appear inside a place or a phrase and make two different rows share a key.
        expect(askKey({ kind: 'item', key: 'carried\u0000scrap' })).toBe('item\u0000carried\u0000scrap');
        expect(clusterKey(GONE, 'cast')).toBe('gone\u0000cast');
    });

    test('a missing field is empty rather than "undefined"', () => {
        expect(askKey({})).toBe('\u0000');
        expect(askKey(null)).toBe('\u0000');
    });

    test('a ledger row and the ask it came from address the same identity', () => {
        // The surface computes a row key from a ledger row and hands it back to `undoRow`. That only
        // works while both shapes are addressed the same way.
        const ask = repair(AMOUNT, 'item', 'carried\u0000gold', { from: 2944, count: 340 });
        const row = { op: ask.op, kind: ask.kind, key: ask.key, name: ask.name, from: 2944 };
        expect(askKey(row)).toBe(askKey(ask));
    });
});

describe('the undo taxonomy, which is the tiering line seen from the other side', () => {
    test('the field edits invert, and never expire, because they are just edits', () => {
        expect(undoKindOf(RENAME)).toBe('inverse');
        expect(undoKindOf(MOVE)).toBe('inverse');
        expect(undoKindOf(AMOUNT)).toBe('inverse');
    });

    test('split and gone have only the snapshot', () => {
        // Nothing reassembles a split row, and the inverse of a recorded "it left the story" event is
        // not an un-event. Both are honest only while the snapshot is, which is why the window is
        // printed rather than assumed.
        expect(undoKindOf(SPLIT)).toBe('snapshot');
        expect(undoKindOf(GONE)).toBe('snapshot');
    });

    test('merge has nothing, and that is why merge is an ask', () => {
        // `mergeEntities` accumulates aliases and has no inverse anywhere in this codebase
        // (`reconcile-table.js`:107); `mergeThreads` keeps the more advanced dial and discards the
        // other row; the item merge sums two piles with nothing recording how they divided.
        expect(undoKindOf(MERGE)).toBe('none');
    });

    test('every auto-lane verdict has SOME undo, which is what earns it the lane', () => {
        for (const verdict of Object.keys(TIER_OF).filter(op => TIER_OF[op] === AUTO)) {
            expect(undoKindOf(verdict)).not.toBe('none');
        }
        // And the one verdict with no undo at all is on the other side of the line.
        expect(TIER_OF[MERGE]).toBe(ASK);
    });

    test('an unknown verdict claims no undo it cannot deliver', () => {
        expect(undoKindOf('reticulate')).toBe('none');
        expect(undoKindOf(undefined)).toBe('none');
    });
});

describe('the ledger bound is a budget decision, not a taste one', () => {
    test('three passes', () => {
        // `MAX_FOLD_BYTES` is 128 KiB and three live chats are already over 90% of it, the largest at
        // 96%. A ledger row per repair per pass is real bytes in a blob that rides inside the chat
        // file, and an undo affordance from six passes ago is history rather than an affordance.
        expect(MAX_LEDGER_PASSES).toBe(3);
    });
});
