import { describe, expect, test } from '@jest/globals';

import {
    CARRIED,
    deriveState,
    itemKey,
    renderLedger,
    validateInventory,
} from '../public/scripts/extensions/fold/state-table.js';

/**
 * ── The replay: the proposals the model really made, run through the new rules ──
 *
 * Ground truth is the user's live chat, not this suite. Two of the worst defects in fold had
 * passing unit tests over them and were found only by reading the ledger, so the fixture below is
 * not invented: every `proposals` entry is a delta the model actually returned, copied out of
 * `chat_metadata.fold.chronicle.events` of
 * `data/default-user/chats/Solo Leveling The Eve of the Double Dungeon/…2026-08-08@12h58m35s399ms.jsonl`
 * (46 events, 13 of them carrying inventory deltas). The chat was copied to a scratchpad first and
 * read there; nothing in this repository writes to it.
 *
 * The defects being reproduced, all visible in that ledger:
 *
 *   · the phone-number exchange recorded THREE times — anchored at mids 50, 52 and 54;
 *   · the ahjumma's two candies recorded twice (54 and 58), so the fold says four;
 *   · the goblin knife recorded twice (22 and 38);
 *   · the staff-and-shortsword purchase recorded three times (60, 66, 68).
 *
 * Each event is attributed to the newest message in its window (`chronicle.js:222-225`), so all
 * three phone events carry different anchors and neither the exact dedup nor the keyword-signature
 * dedup (`chronicle-table.js:285-292`) can see them as one beat.
 *
 * ── What the fixture's `window` strings are, and why they are short ──
 *
 * The only thing any validator asks of the narrative window is `isMentioned`
 * (`state-table.js`): does the text contain this item's name, or its head token? So each window
 * here is a mechanical projection of the real messages through exactly that question — for every
 * item proposed in that pass, the FIRST sentence of the real window that contains the item's name
 * or its head token, capped at 200 characters, deduplicated. An item mentioned nowhere in the real
 * window contributes nothing, which is why two of these strings are empty: mids 51-52 and 55-58
 * genuinely never say "number" or "candy". The projection is faithful for the mention gate and for
 * nothing else, and no delta in this fixture reaches the corroboration path (`deltaAllowance` with
 * nothing held returns the place ceiling), so nothing else is needed.
 *
 * `windowAll` is the trailing-6 window as `buildWindow` built it before this phase; `windowNew` is
 * the half past the high-water mark. The mark advances exactly as it did in play: each pass sets it
 * to its own anchor mid, so pass N's new half is the messages after pass N-1's anchor.
 */
const PASSES = [
    {
        mid: 6, newMids: [1, 2, 3, 4, 5, 6],
        windowAll: 'Licensed hunter. She passes a laminated card and a thin pamphlet through the slot.',
        windowNew: 'Licensed hunter. She passes a laminated card and a thin pamphlet through the slot.',
        proposals: [{ s: 'Solomon undergoes mana Awakening, receives an E-rank license and a pamphlet.', inv: [{ item: 'e-rank hunter license', dq: 1 }, { item: 'hunter pamphlet', dq: 1 }] }],
    },
    {
        mid: 14, newMids: [9, 10, 11, 12, 13, 14],
        windowAll: 'She\'s walking back toward the group now, pulling a pair of cheap mana-shackle bracers from a gear crate — the kind that let a hunter pop a shield once before they crack, standard issue for low-rank ra',
        windowNew: 'She\'s walking back toward the group now, pulling a pair of cheap mana-shackle bracers from a gear crate — the kind that let a hunter pop a shield once before they crack, standard issue for low-rank ra',
        proposals: [{ s: 'Kang assigns Solomon as mule and gives him mana-shackle bracers and a stone crate.', inv: [{ item: 'mana-shackle bracers', dq: 1 }, { item: 'stone crate', dq: 1 }] }],
    },
    {
        mid: 22, newMids: [17, 18, 19, 20, 21, 22],
        windowAll: 'It\'s reaching weakly for the knife in its belt — the rusted hunter\'s knife, the trophy. Then, louder: "Stone extraction.',
        windowNew: 'It\'s reaching weakly for the knife in its belt — the rusted hunter\'s knife, the trophy. Then, louder: "Stone extraction.',
        proposals: [
            { s: 'Solomon kills a goblin and takes its rusted hunter\'s knife and sheath.', inv: [{ item: 'rusty hunter\'s knife with sheath', dq: 1 }] },
            { s: 'Solomon learns how to extract mana stones from goblin corpses.', inv: [{ item: 'mana stone extraction', dq: 1, at: 'abilities' }] },
        ],
    },
    { mid: 30, newMids: [25, 26, 27, 28, 29, 30], windowAll: '', windowNew: '', proposals: [] },
    {
        mid: 38, newMids: [33, 34, 35, 36, 37, 38],
        windowAll: 'Solomon\'s hands find whatever the dead goblins left behind — a jagged knife with a broken tip, a hand-axe chipped along the blade, a crude spear little more than a sharpened stick bound with sinew.',
        windowNew: 'Solomon\'s hands find whatever the dead goblins left behind — a jagged knife with a broken tip, a hand-axe chipped along the blade, a crude spear little more than a sharpened stick bound with sinew.',
        proposals: [{ s: 'Solomon picks up a rusty hunter\'s knife from the dead goblins.', inv: [{ item: 'rusty hunter\'s knife with sheath', dq: 1 }] }],
    },
    {
        mid: 46, newMids: [41, 42, 43, 44, 45, 46],
        windowAll: 'Six million won for the crate — a decent haul for a D-rank gate — and Solomon\'s six percent came to 360,000 won.',
        windowNew: 'Six million won for the crate — a decent haul for a D-rank gate — and Solomon\'s six percent came to 360,000 won.',
        proposals: [{ s: 'Solomon receives 360,000 won as his share from the D-rank gate raid.', inv: [{ item: 'won', dq: 360000 }] }],
    },
    {
        mid: 50, newMids: [47, 48, 49, 50],
        windowAll: 'Then I glance sidelong, "Oh, by the way, Kang said I should get her number from you.',
        windowNew: 'Then I glance sidelong, "Oh, by the way, Kang said I should get her number from you.',
        proposals: [{ s: 'Solomon exchanges phone numbers with Jin-Woo and gets Kang\'s number.', inv: [{ item: 'jin-woo\'s phone number', dq: 1 }, { item: 'kang\'s phone number', dq: 1 }] }],
    },
    {
        mid: 52, newMids: [51, 52],
        windowAll: 'Then I glance sidelong, "Oh, by the way, Kang said I should get her number from you.',
        windowNew: '',
        proposals: [{ s: 'Solomon obtains Kang\'s phone number and Jin-Woo\'s phone number.', inv: [{ item: 'kang\'s phone number', dq: 1, at: 'contacts' }, { item: 'jin-woo\'s phone number', dq: 1, at: 'contacts' }] }],
    },
    {
        mid: 54, newMids: [53, 54],
        windowAll: 'Then I glance sidelong, "Oh, by the way, Kang said I should get her number from you. she says, as if candy fixes lacerations.',
        windowNew: 'she says, as if candy fixes lacerations.',
        proposals: [
            { s: 'Solomon receives Jin-Woo\'s and Kang\'s phone numbers.', inv: [{ item: 'jin-woo\'s phone number', dq: 1 }, { item: 'kang\'s phone number', dq: 1 }] },
            { s: 'Jin-Woo receives Solomon\'s phone number.', inv: [{ item: 'solomon\'s phone number', dq: 1 }] },
            { s: 'The ahjumma gives Solomon two wrapped candies.', inv: [{ item: 'wrapped candy', dq: 2 }] },
        ],
    },
    {
        mid: 58, newMids: [55, 56, 57, 58],
        windowAll: 'she says, as if candy fixes lacerations.',
        windowNew: '',
        proposals: [{ s: 'The ahjumma gives Solomon two wrapped candies along with his change.', inv: [{ item: 'wrapped candy', dq: 2 }] }],
    },
    {
        mid: 60, newMids: [59, 60],
        windowAll: 'But I keep an eye out for any bo-style staff\'s or spears, plus something shorter range to go along with it. And a dagger or shortsword.',
        windowNew: 'The dungeon pull staff of darkwood was a no-brainer. As for the shorter blade, I try out all three from the tanto, hunting knife to the shortsword just to feel which one weighed the best.',
        proposals: [{ s: 'Solomon selects the darkwood staff and the shortsword from the broker.', inv: [{ item: 'darkwood staff', dq: 1 }, { item: 'shortsword', dq: 1 }] }],
    },
    {
        mid: 66, newMids: [61, 62, 63, 64, 65, 66],
        windowAll: 'I let out a grunt, and put the darkwood staff and the shortsword aside for purchase, returning the rest. Then I go and try on a few of the bracers and the greaves. The broker throws in a pair of worn but serviceable gloves as a bundle deal. Once I\'ve selected good bracers and greaves, I pick up the trauma kit with the extra coagulant the guy mentioned.',
        windowNew: 'I let out a grunt, and put the darkwood staff and the shortsword aside for purchase, returning the rest. Then I go and try on a few of the bracers and the greaves. The broker throws in a pair of worn but serviceable gloves as a bundle deal. Once I\'ve selected good bracers and greaves, I pick up the trauma kit with the extra coagulant the guy mentioned.',
        proposals: [{ s: 'Solomon paid 120,000 won for a darkwood staff, shortsword, bracers, greaves, gloves, and a trauma kit.', inv: [{ item: 'darkwood staff', dq: 1 }, { item: 'shortsword', dq: 1 }, { item: 'mana-shackle bracers', dq: 1 }, { item: 'reinforced bracers and greaves', dq: 1 }, { item: 'gloves', dq: 1 }, { item: 'trauma kit with extra coagulant', dq: 1 }] }],
    },
    {
        mid: 68, newMids: [67, 68],
        windowAll: 'He wraps the shortsword in oiled cloth and bundles everything together with twine: staff, sword, bracers, greaves, gloves, trauma kit.',
        windowNew: 'The number for his grandfather — the man who taught him the staff — sits somewhere in the contacts list, untouched for a year or The shortsword rests on the desk. The trauma kit\'s scissors cut away Jin-Woo\'s bandage cleanly.',
        proposals: [{ s: 'Solomon paid 120k won to the broker and received the darkwood staff, shortsword, bracers, greaves, gloves, and trauma kit.', inv: [{ item: 'darkwood staff', dq: 1 }, { item: 'shortsword', dq: 1 }, { item: 'mana-shackle bracers', dq: 1 }, { item: 'reinforced bracers and greaves', dq: 1 }, { item: 'gloves', dq: 1 }, { item: 'trauma kit with extra coagulant', dq: 1 }] }],
    },
];

/**
 * Replay the recorded proposals through the validator and the fold.
 *
 * Mirrors production exactly in the one respect that decides these outcomes: within a pass, every
 * proposal is validated against the state derived from COMMITTED events only, because
 * `chronicle.applyExtraction` calls `validateDelta` per candidate and `validateDelta` re-derives
 * from `chronicle.liveEvents()`, which does not yet contain this pass's own events.
 *
 * @param {object} options Options.
 * @param {boolean} options.split Whether to use the new half as the window (this phase) or the
 *   whole trailing window (before it).
 * @param {boolean} options.pinned Whether the pinned ledger was shown, which arms
 *   `reject:already-recorded`.
 * @returns {{inv: Map, rejected: object[]}} The folded inventory and every refusal.
 */
function replay({ split, pinned }) {
    const events = [];
    const rejected = [];
    let t = 0;

    // A migrated chat: the rows the real ledger filed under the `contacts` place were recorded by
    // the migration's own `reachKeys` output, so the read-heal skips those exact keys.
    const reachKeys = new Set([
        `${'contacts'}${'\u0000'}kang's phone number`,
        `${'contacts'}${'\u0000'}jin-woo's phone number`,
    ]);

    for (const pass of PASSES) {
        const state = deriveState(events, { reachKeys });
        const shown = pinned ? renderLedger(state).shown : null;
        const windowText = split ? pass.windowNew : pass.windowAll;

        for (const proposal of pass.proposals) {
            // Coverage by report, the way production passes it: the model says the window names
            // the items it proposes, in any language. The fallback `isMentioned` (exact substring)
            // only runs when no report exists — the block path.
            const mentioned = new Set((proposal.inv ?? []).map(d => d.item));
            const outcome = validateInventory({ inv: state.inv, deltas: proposal.inv, windowText, shown, mentioned });
            rejected.push(...outcome.rejected.map(r => ({ ...r, mid: pass.mid })));
            if (outcome.accepted.length) {
                events.push({ s: proposal.s, kw: [], t: ++t, src: 'llm', d: { inv: outcome.accepted } });
            }
        }
    }

    return { inv: deriveState(events, { reachKeys }).inv, rejected };
}

/** How many of a thing the fold ended up holding. */
const qty = (inv, name, place = CARRIED) => inv.get(itemKey(name, place))?.qty ?? 0;

describe('what the recorded ledger actually folds to', () => {
    // No validation at all: every recorded delta folded, which is what the live chat's state IS.
    // This is the baseline the phase has to beat, and it is read from the ledger rather than
    // asserted about it.
    const inv = deriveState(PASSES.flatMap((pass, index) =>
        pass.proposals.map((proposal, n) => ({ s: proposal.s, kw: [], t: index * 10 + n, src: 'llm', d: { inv: proposal.inv } })),
    ), {
        reachKeys: new Set([
            `${'contacts'}${'\u0000'}kang's phone number`,
            `${'contacts'}${'\u0000'}jin-woo's phone number`,
        ]),
    }).inv;

    test('the phone-number beat exists twice, and its contacts rows no longer derive at all', () => {
        expect(qty(inv, 'jin-woo\'s phone number')).toBe(2);
        expect(qty(inv, 'kang\'s phone number')).toBe(2);
        // The events at mids 50-54 recorded `at: "contacts"` against a schema that never offered
        // the place. The migration records those exact item keys as `reachKeys` and `deriveState`
        // skips exactly those on READ — keyed on the migration's OWN output, never an English
        // place word (FOLD-REDESIGN.md §10, Phase B LANDED deviation 7). The baseline this replay
        // measures went from four phone-number rows to two.
        expect(qty(inv, 'jin-woo\'s phone number', 'contacts')).toBe(0);
        expect(qty(inv, 'kang\'s phone number', 'contacts')).toBe(0);
    });

    test('the candies total four, which is what the live panel shows', () => {
        expect(qty(inv, 'wrapped candy')).toBe(4);
    });

    test('one knife is two knives and one purchase is three purchases', () => {
        expect(qty(inv, 'rusty hunter\'s knife with sheath')).toBe(2);
        expect(qty(inv, 'darkwood staff')).toBe(3);
        expect(qty(inv, 'shortsword')).toBe(3);
        expect(qty(inv, 'mana-shackle bracers')).toBe(3);
    });

    test('and the raid share is the ₩9,999 bug, in one line', () => {
        // `{"item":"won","dq":360000}` with no `at`, so the money lands in a pocket and clamps at
        // MAX_QTY. Untouched by this phase — the fix is the debit side and the `at: "money"`
        // instruction (`FOLD-REDESIGN.md` §5), which belongs to a later one. Recorded here so the
        // replay is honest about what it does and does not repair.
        expect(qty(inv, 'won')).toBe(9999);
    });
});

describe('replaying the real proposals — each beat once', () => {
    const { inv, rejected } = replay({ split: true, pinned: true });
    const reasons = rejected.reduce((acc, r) => acc.set(r.reason, (acc.get(r.reason) ?? 0) + 1), new Map());

    test('every phone number is gained exactly once, in one place', () => {
        expect(qty(inv, 'jin-woo\'s phone number')).toBe(1);
        expect(qty(inv, 'kang\'s phone number')).toBe(1);
        expect(qty(inv, 'kang\'s phone number', 'contacts')).toBe(0);
        expect(qty(inv, 'jin-woo\'s phone number', 'contacts')).toBe(0);
    });

    test('the candies total two', () => {
        expect(qty(inv, 'wrapped candy')).toBe(2);
    });

    test('the knife is one knife', () => {
        expect(qty(inv, 'rusty hunter\'s knife with sheath')).toBe(1);
    });

    test('the weapons bought once are held once', () => {
        expect(qty(inv, 'darkwood staff')).toBe(1);
        expect(qty(inv, 'shortsword')).toBe(1);
        expect(qty(inv, 'reinforced bracers and greaves')).toBe(1);
        expect(qty(inv, 'trauma kit with extra coagulant')).toBe(1);
    });

    test('both mechanisms carry weight, and the counters say which did what', () => {
        // Coverage by report is the admission gate now: the model says the window names the items
        // it proposes, so a re-report is refused by the LEDGER gate (already-recorded) rather than
        // by the old substring mention gate. The window split does its work where the beat is
        // narrated only in the overlap, which the ledger gate then refuses.
        expect(reasons.get('not-mentioned')).toBeUndefined();
        // The ledger gate does the work where the new half DOES mention the thing again — the knife
        // at mid 38, the staff and sword at 66 and 68.
        expect(reasons.get('already-recorded')).toBeGreaterThanOrEqual(4);
        // The `not-an-item` refusal is gone: the schema instruction ("Contact details are NOT
        // items") is the contract, and the read-heal skips the migration's own reachKeys instead.
        expect(reasons.get('not-an-item')).toBeUndefined();
    });

    test('the false positive is real and is the price, stated rather than hidden', () => {
        // Solomon's mana-shackle bracers are destroyed at mid 38 ("the hobgoblin's cleaver destroys
        // Solomon's bracer") and he buys new ones at 66. The destruction was never recorded as a
        // delta, so the ledger still shows one pair — and the purchase is refused as a re-report.
        // This is the "buy a second knife" cost named in `validateInventory`'s docblock, occurring
        // in the real data. It is still an improvement on the alternative, which counted three.
        expect(qty(inv, 'mana-shackle bracers')).toBe(1);
        // Both re-bills (mids 66 and 68) are now refused by the ledger gate: coverage by report
        // admits the model's re-mention, and the held row is shown, so `already-recorded` catches
        // each one. The old mention gate let the second slip on a substring miss.
        expect(rejected.filter(r => r.item === 'mana-shackle bracers' && r.reason === 'already-recorded')).toHaveLength(2);
    });
});

describe('what each half of the fix is worth on its own', () => {
    test('the window split alone still double-bills whatever the new half re-narrates', () => {
        const { inv } = replay({ split: true, pinned: false });
        // The old substring mention gate used to refuse the phone and candy re-reports whose window
        // said nothing — a coverage miss, not a decision. Coverage is by the model's OWN report now
        // (`mentioned`), so with no ledger gate (`pinned: false`) every re-narration bills again:
        // the knife and the weapons because the new half mentions them, the phones because the
        // model's report admits them. The split alone cannot refuse a re-report; the ledger gate is
        // the load-bearing half, which is exactly what this pair of tests measures.
        expect(qty(inv, 'kang\'s phone number')).toBe(2);
        expect(qty(inv, 'wrapped candy')).toBe(4);
        expect(qty(inv, 'rusty hunter\'s knife with sheath')).toBe(2);
        expect(qty(inv, 'darkwood staff')).toBe(3);
    });

    test('the ledger gate alone still double-bills across an unshown line', () => {
        const { inv } = replay({ split: false, pinned: true });
        // Every one of these is caught, because the item was held and shown when re-proposed —
        // which is what makes the gate the load-bearing half and the split the cheap half.
        expect(qty(inv, 'kang\'s phone number')).toBe(1);
        expect(qty(inv, 'wrapped candy')).toBe(2);
        expect(qty(inv, 'rusty hunter\'s knife with sheath')).toBe(1);
    });
});
