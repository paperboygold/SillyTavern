import { describe, expect, test } from '@jest/globals';

import {
    ABILITIES,
    ASSETS,
    CARRIED,
    MAX_CHANGES_PER_TURN,
    MAX_CONDITION_TURNS,
    MAX_MONEY,
    MAX_QTY,
    MONEY,
    STALE_THRESHOLD,
    deltaAllowance,
    deriveState,
    isMentioned,
    itemKey,
    markKey,
    magnitudeCorroborated,
    normalizeItemName,
    normalizeKey,
    normalizePlace,
    renderLedger,
    renderState,
    setQty,
    splitItemKey,
    statusSubject,
    validateInventory,
    validateStatus,
    validateVitals,
    vitalLabel,
} from '../public/scripts/extensions/fold/state-table.js';

/**
 * Build an event carrying a delta.
 * @param {number} t Timestamp.
 * @param {object} d Delta.
 * @param {string} [s] Summary.
 * @returns {object} An event.
 */
const ev = (t, d, s = 'something happened') => ({ s, kw: [], t, src: 'llm', d });

describe('normalizeItemName', () => {
    test('lowercases and trims', () => {
        expect(normalizeItemName('  Healing Potion  ')).toEqual({ name: 'healing potion', qty: null });
    });

    test('strips the decoration models actually emit', () => {
        for (const raw of ['**Sword**', '- Sword', '1. Sword', '`Sword`', '"Sword"', '[Sword]', '* Sword']) {
            expect(normalizeItemName(raw)?.name).toBe('sword');
        }
    });

    test('pulls a leading quantity out of the name', () => {
        // Models write "3x potion" at least as often as they fill in a quantity field.
        expect(normalizeItemName('3x Healing Potion')).toEqual({ name: 'healing potion', qty: 3 });
        expect(normalizeItemName('2 gold coins')).toEqual({ name: 'gold coins', qty: 2 });
    });

    test('pulls a trailing quantity out of the name', () => {
        expect(normalizeItemName('Healing Potion x3')).toEqual({ name: 'healing potion', qty: 3 });
    });

    test('rejects structurally empty and dangerous names', () => {
        // 'None' is a name the model reported, so it is stored — the English sentinel is gone. Only
        // structurally empty strings and prototype-pollution keys are unusable.
        expect(normalizeItemName('')).toBeNull();
        expect(normalizeItemName('   ')).toBeNull();
        expect(normalizeItemName(null)).toBeNull();
        expect(normalizeItemName(undefined)).toBeNull();
        expect(normalizeItemName('__proto__')).toBeNull();
        expect(normalizeItemName('constructor')).toBeNull();
        expect(normalizeItemName('prototype')).toBeNull();
        expect(normalizeItemName('None')?.name).toBe('none');
    });

    test('caps absurd lengths', () => {
        expect(normalizeItemName('x'.repeat(500)).name.length).toBeLessThanOrEqual(64);
    });

    test('keeps a parenthesised qualifier intact', () => {
        // Stripping every trailing bracket turned "Thinkpad (closed)" into "thinkpad (closed",
        // which the user saw in the panel as a truncated name.
        expect(normalizeItemName('Thinkpad (closed)').name).toBe('thinkpad (closed)');
        expect(normalizeItemName('Beretta M92F (12 rounds, one spare)').name)
            .toBe('beretta m92f (12 rounds, one spare)');
    });

    test('still strips brackets that wrap the whole name', () => {
        expect(normalizeItemName('[Sword]').name).toBe('sword');
        expect(normalizeItemName('(Sword)').name).toBe('sword');
        expect(normalizeItemName('"Sword"').name).toBe('sword');
    });

    test('strips a stray closer that nothing opened', () => {
        expect(normalizeItemName('Sword)').name).toBe('sword');
    });
});

describe('item places', () => {
    test('an item key round-trips through its place', () => {
        expect(splitItemKey(itemKey('crowbar', 'car boot')))
            .toEqual({ place: 'car boot', name: 'crowbar' });
    });

    test('carried is the default; the protocol token collapses to it', () => {
        for (const place of [undefined, '', 'carried']) {
            expect(splitItemKey(itemKey('rope', place)).place).toBe(CARRIED);
        }
    });

    test('a key written before places existed reads as carried', () => {
        expect(splitItemKey('rope')).toEqual({ place: CARRIED, name: 'rope' });
    });

    test('the same item in two places stays two entries', () => {
        // "Everything you own is in your pockets" stops being true the moment there is a car.
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'crowbar', dq: 1 }] }),
            ev(2, { inv: [{ item: 'crowbar', dq: 1, at: 'car boot' }] }),
        ]);
        expect(inv.get(itemKey('crowbar'))).toEqual({ qty: 1 });
        expect(inv.get(itemKey('crowbar', 'car boot'))).toEqual({ qty: 1 });
    });

    test('moving an item is a loss in one place and a gain in the other', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'crowbar', dq: 1, at: 'apartment' }] }),
            ev(2, { inv: [{ item: 'crowbar', dq: -1, at: 'apartment' }, { item: 'crowbar', dq: 1 }] }),
        ]);
        expect(inv.has(itemKey('crowbar', 'apartment'))).toBe(false);
        expect(inv.get(itemKey('crowbar'))).toEqual({ qty: 1 });
    });

    test('renderState groups by place', () => {
        const inv = new Map([
            [itemKey('wallet'), { qty: 1 }],
            [itemKey('shotgun', 'apartment'), { qty: 1 }],
        ]);
        const block = renderState({ inv, vitals: new Map(), marks: new Map() });
        expect(block).toContain('Carrying: wallet');
        expect(block).toContain('Stored (apartment): shotgun');
    });

    test('a treasury is a literal place now — the model writes "money" for money', () => {
        // The English synonym list ("treasury"=money, "coffers"=money) is gone: fold does not guess
        // what an `at` label means. The schema instruction tells the model to write `at: "money"`
        // for a balance, and fold trusts the protocol token. "treasury" is a room, not a synonym.
        expect(normalizePlace('treasury')).toBe('treasury');
        expect(normalizePlace('money')).toBe(MONEY);
        expect(normalizePlace('assets')).toBe(ASSETS);
        expect(normalizePlace('abilities')).toBe(ABILITIES);
    });

    test('a stated balance establishes through set, not dq', () => {
        // The extraction schema exposes `set` so a first-stated treasury ("12,400 marks") lands as
        // an establishment. The model writes `at: "money"` per the instruction; fold keys it there.
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'marks', dq: 0, set: 12400, at: 'money' }] }),
        ]);
        expect(inv.get(itemKey('marks', MONEY))).toEqual({ qty: 12400 });
        // The single money row is keyed under the money place — there is no second row at a place
        // literally called "treasury".
        const entries = [...inv.entries()];
        expect(entries).toHaveLength(1);
        expect(splitItemKey(entries[0][0]).place).toBe(MONEY);
    });

    test('a model-authored set: 0 under strict mode is not a restatement', () => {
        // Strict structured output forces `set` into every row, so the write path must read a
        // 0/null `set` on an ordinary delta as "not a restatement" — otherwise every item the
        // model touches resets to zero. (The fold path still treats a stored `set: 0` as a
        // removal; that is the difference between a proposal and a record.)
        const result = validateInventory({
            inv: new Map(),
            windowText: 'she picked up a rope',
            deltas: [{ item: 'rope', dq: 1, set: 0 }],
        });
        expect(result.accepted).toEqual([{ item: 'rope', dq: 1 }]);
        expect(result.rejected).toEqual([]);
    });
});

describe('normalizeKey', () => {
    test('normalizes and rejects the same way', () => {
        expect(normalizeKey('  Health  ')).toBe('health');
        expect(normalizeKey('__proto__')).toBeNull();
        expect(normalizeKey('')).toBeNull();
    });
});

describe('isMentioned — the block-path fallback, exact-name only', () => {
    test('matches the full name when it appears verbatim', () => {
        // This is the fallback that runs only when no model report exists. The primary gate is the
        // model's `mentions` report, which names items exactly. The old head-noun truncation
        // (`itemHead` splitting "healing potion" on English prepositions) is gone; the name is
        // matched as the model wrote it.
        expect(isMentioned('healing potion', 'she drank the healing potion')).toBe(true);
        expect(isMentioned('iron sword', 'he drew his iron sword')).toBe(true);
    });

    test('a parenthetical is part of the name, not stripped by fold', () => {
        expect(isMentioned('potion (minor)', 'she drank the potion (minor)')).toBe(true);
        expect(isMentioned('potion (minor)', 'she drank the potion')).toBe(false);
    });

    test('rejects what the narrative never mentions', () => {
        expect(isMentioned('dragon egg', 'she walked to the river')).toBe(false);
    });

    test('a modifier alone does not smuggle an item past the gate', () => {
        // Any-token matching let "dragon egg" through a scene that only mentioned a Dragon Keep,
        // which is precisely how a model invents an item while looking like it is grounded.
        expect(isMentioned('dragon egg', 'they travelled to the Dragon Keep')).toBe(false);
        expect(isMentioned('silver crown', 'she counted the silver coins')).toBe(false);
    });

    test('matches the full phrase when it appears verbatim', () => {
        expect(isMentioned('dragon egg', 'a dragon egg lay in the nest')).toBe(true);
    });

    test('matches a plural in the narrative', () => {
        expect(isMentioned('silver coin', 'he handed over three silver coins')).toBe(true);
    });

    test('is total over empty input', () => {
        expect(isMentioned('sword', '')).toBe(false);
        expect(isMentioned('', 'anything')).toBe(false);
    });
});

describe('validateInventory — the model proposes, the merge disposes', () => {
    const base = { inv: new Map(), windowText: 'she picked up a rope and two coins' };

    test('accepts a mentioned, plausible gain', () => {
        const result = validateInventory({ ...base, deltas: [{ item: 'rope', dq: 1 }] });
        expect(result.accepted).toEqual([{ item: 'rope', dq: 1 }]);
        expect(result.rejected).toEqual([]);
    });

    test('rejects a change to something the narrative never mentions', () => {
        // The strongest rule: a model cannot invent state changes for things nobody talked about.
        const result = validateInventory({ ...base, deltas: [{ item: 'dragon egg', dq: 1 }] });
        expect(result.accepted).toEqual([]);
        expect(result.rejected[0].reason).toBe('not-mentioned');
    });

    test('a reported item is accepted even when the window test would fail (coverage wins)', () => {
        // The model's report is authoritative: a paraphrased item it declares is admitted even if
        // the window cannot token-match it — the whole point of coverage over substring.
        const result = validateInventory({
            ...base,
            windowText: 'she stowed her things by the door',
            mentioned: new Set(['the traveller\'s pack']),
            deltas: [{ item: 'the traveller\'s pack', dq: 1 }],
        });
        expect(result.accepted).toEqual([{ item: 'the traveller\'s pack', dq: 1 }]);
        expect(result.rejected).toEqual([]);
    });

    test('a window-mentioned item is accepted even when the model under-reported its mentions', () => {
        // Measured in the Wuxia RP: the model's coverage report omitted items the prose visibly
        // named, and the old gate rejected every one as `not-mentioned`. The window test rescues a
        // name the report forgot — while still refusing something neither report nor window has.
        const result = validateInventory({
            ...base,
            windowText: 'she picked up a rope and two coins, then sheathed the iron dagger',
            mentioned: new Set(['rope', 'coins']), // dagger omitted from the report
            deltas: [{ item: 'dagger', dq: 1 }],
        });
        expect(result.accepted).toEqual([{ item: 'dagger', dq: 1 }]);
        expect(result.rejected).toEqual([]);
    });

    test('an item neither reported nor in the window is still refused', () => {
        // The OR must not admit everything: a fabricated item survives only if neither the report
        // nor the window carries it.
        const result = validateInventory({
            ...base,
            windowText: 'she picked up a rope and two coins',
            mentioned: new Set(['rope', 'coins']),
            deltas: [{ item: 'a dragon egg', dq: 1 }],
        });
        expect(result.accepted).toEqual([]);
        expect(result.rejected[0].reason).toBe('not-mentioned');
    });

    test('rejects an implausible magnitude', () => {
        // The premise moved with the rule: a FIRST sighting of any size is allowed (no prior to
        // bound against), so an implausible magnitude is now one that outgrows what is held.
        const result = validateInventory({
            inv: new Map([[itemKey('rope'), { qty: 1 }]]),
            windowText: 'she picked up a rope and two coins',
            deltas: [{ item: 'rope', dq: 4000 }],
        });
        expect(result.rejected[0].reason).toBe('implausible-delta');
    });

    test('an untagged delta joins an existing money row (precedent, not a name guess)', () => {
        // The mid-46 event of the live Solo Leveling chat — `{"item":"won","dq":360000}` with no
        // `at` — keyed as carried and clamped to 9,999 while the real balance went unrecorded.
        // §11 forbids guessing "won is currency" from the name; the §11-compliant default reads
        // fold's OWN state — once a `money␀won` row exists, an untagged "won" delta joins it.
        const inv = new Map([[itemKey('won', 'money'), { qty: 210000 }]]);
        const result = validateInventory({
            inv,
            windowText: 'Kang sends a message that 680,000 won was deposited',
            deltas: [{ item: 'won', dq: 680000 }],
        });
        expect(result.accepted).toEqual([{ item: 'won', dq: 680000, at: 'money' }]);
    });

    test('an untagged delta with no prior money row still defaults to carried', () => {
        // The first payout is the one lapse the precedent rule cannot heal — nothing is yet on
        // record as money, so a name is not read to invent it. That case is the directed-money
        // question's job (§5); this rule stops every recurrence after the first.
        const result = validateInventory({
            inv: new Map(),
            windowText: 'Solomon receives 360,000 won as his share',
            deltas: [{ item: 'won', dq: 360000 }],
        });
        // Accepted (civilisation-scale corroborated deltas stay allowed); the clamp at MAX_QTY is
        // the separate, documented serialization guard, not this rule's concern.
        expect(result.accepted[0]).toEqual({ item: 'won', dq: 360000 });
        expect(result.rejected).toEqual([]);
    });

    test('rejects removing something never held', () => {
        const result = validateInventory({ ...base, deltas: [{ item: 'rope', dq: -1 }] });
        expect(result.rejected[0].reason).toBe('remove-unknown');
    });

    test('clamps underflow rather than rejecting it', () => {
        // Our count may simply be behind; the narrative is the better authority on what happened.
        const inv = new Map([[itemKey('rope'), { qty: 1 }]]);
        const result = validateInventory({ ...base, inv, deltas: [{ item: 'rope', dq: -5 }] });
        expect(result.accepted).toEqual([{ item: 'rope', dq: -5 }]);
        expect(result.rejected[0].reason).toBe('clamped-underflow');
    });

    test('uses a quantity baked into the name when no delta was given', () => {
        const result = validateInventory({ ...base, deltas: [{ item: '2 coins', dq: 0 }] });
        expect(result.accepted).toEqual([{ item: 'coins', dq: 2 }]);
    });

    test('rate-limits a flood of changes', () => {
        // Asserted against the constant, not a copy of it. A test that restates the number cannot
        // tell a retune from a regression — it just fails, which is what happened when calibration
        // moved this from 8 to 12.
        const deltas = Array.from({ length: MAX_CHANGES_PER_TURN * 3 }, () => ({ item: 'rope', dq: 1 }));
        const result = validateInventory({ ...base, deltas });
        expect(result.accepted.length).toBeLessThanOrEqual(MAX_CHANGES_PER_TURN);
        expect(result.rejected.some(r => r.reason === 'rate-limited')).toBe(true);
    });

    test('is total over junk', () => {
        expect(validateInventory({ ...base, deltas: null }).accepted).toEqual([]);
        expect(validateInventory({ ...base, deltas: [null, {}] }).accepted).toEqual([]);
    });
});

describe('validateVitals', () => {
    test('accepts a mentioned change', () => {
        const result = validateVitals({
            vitals: new Map(), deltas: [{ name: 'health', dcur: -10, max: 50 }],
            windowText: 'the blow cost her health',
        });
        expect(result.accepted[0]).toMatchObject({ name: 'health', dcur: -10, max: 50 });
    });

    test('rejects a max that moves more than half in one turn', () => {
        const vitals = new Map([['health', { cur: 40, max: 50 }]]);
        const result = validateVitals({
            vitals, deltas: [{ name: 'health', dcur: 0, max: 500 }],
            windowText: 'her health held steady',
        });
        expect(result.rejected[0].reason).toBe('implausible-max');
    });
});

describe('validateStatus', () => {
    test('accepts a mentioned flag and rejects an invented one', () => {
        const result = validateStatus({
            status: new Map(),
            deltas: [{ flag: 'poisoned', on: true }, { flag: 'cursed', on: true }],
            windowText: 'the venom left her poisoned',
        });
        expect(result.accepted).toEqual([{ who: '', flag: 'poisoned', on: true, severity: 'moderate', turns: 0 }]);
        expect(result.rejected[0].reason).toBe('not-mentioned');
    });
});

describe('deriveState — state is a fold over the ledger', () => {
    test('quantities accumulate across events', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }),
            ev(2, { inv: [{ item: 'coin', dq: 2 }] }),
        ]);
        expect(inv.get(itemKey('coin'))).toEqual({ qty: 5 });
    });

    test('an item spent down to zero leaves the inventory', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }),
            ev(2, { inv: [{ item: 'coin', dq: -3 }] }),
        ]);
        expect(inv.has(itemKey('coin'))).toBe(false);
    });

    test('events fold in chronological order regardless of array order', () => {
        const out = deriveState([
            ev(2, { inv: [{ item: 'coin', dq: -1 }] }),
            ev(1, { inv: [{ item: 'coin', dq: 5 }] }),
        ]);
        expect(out.inv.get(itemKey('coin'))).toEqual({ qty: 4 });
    });

    test('dropping an event un-does its effect — branch-awareness for free', () => {
        // This is the payoff of deriving rather than storing: pass only the events live on this
        // swipe and the inventory is automatically the inventory of this branch.
        const all = [
            ev(1, { inv: [{ item: 'rope', dq: 1 }] }),
            ev(2, { inv: [{ item: 'sword', dq: 1 }] }),
        ];
        expect(deriveState(all).inv.has(itemKey('sword'))).toBe(true);
        expect(deriveState(all.slice(0, 1)).inv.has(itemKey('sword'))).toBe(false);
    });

    test('vitals clamp to their maximum and floor at zero', () => {
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'health', dcur: 0, max: 50 }] }),
            ev(2, { vit: [{ name: 'health', dcur: -80 }] }),
        ]);
        expect(vitals.get('health')).toEqual({ cur: 0, max: 50 });

        const healed = deriveState([
            ev(1, { vit: [{ name: 'health', dcur: 0, max: 50 }] }),
            ev(2, { vit: [{ name: 'health', dcur: -20 }] }),
            ev(3, { vit: [{ name: 'health', dcur: 999 }] }),
        ]);
        expect(healed.vitals.get('health')).toEqual({ cur: 50, max: 50 });
    });

    test('a first vital report that carries damage folds to cur, not a raw delta', () => {
        // Regression: the model's first and only HP report was `{name:"hp", dcur:-26, max:70}` —
        // damage and max in one event. `insert_with` stores the incoming value verbatim when the
        // key is absent, so before the seeding fix the stored row was the raw `{dcur:-26, max:70}`
        // with no `cur` — the panel showed "Hp 0/70" (the `?? 0` fallback) and the injection
        // "hp NaN/70" (`Math.round(undefined)`).
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'hp', dcur: -26, max: 70 }] }),
        ]);
        expect(vitals.get('hp')).toEqual({ max: 70, cur: 44 });

        // A later delta accumulates from the folded base, not from a re-anchor at max.
        const later = deriveState([
            ev(1, { vit: [{ name: 'hp', dcur: -26, max: 70 }] }),
            ev(2, { vit: [{ name: 'hp', dcur: 10 }] }),
        ]);
        expect(later.vitals.get('hp')).toEqual({ max: 70, cur: 54 });

        // The stored shape is always {max, cur}, so a reader never sees NaN.
        const { cur, max } = later.vitals.get('hp');
        expect(Number.isFinite(cur)).toBe(true);
        expect(Number.isFinite(max)).toBe(true);
    });

    test('vitalLabel uppercases initialisms and sentence-cases the rest', () => {
        expect(vitalLabel('hp')).toBe('HP');
        expect(vitalLabel('mp')).toBe('MP');
        expect(vitalLabel('stamina')).toBe('Stamina');
        expect(vitalLabel('health')).toBe('Health');
        expect(vitalLabel('')).toBe('');
    });

    test('status flags clear, because status is the Map face and not the Set face', () => {
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'poisoned', on: true }] }),
            ev(2, { st: [{ flag: 'poisoned', on: false }] }),
        ]);
        expect(status.get(markKey('', 'poisoned')).on).toBe(false);
    });

    test('records the audit trail for every quantity, with its anchor mid for the cause-link', () => {
        const { contributors } = deriveState([
            ev(1, { inv: [{ item: 'coin', dq: 3 }] }, 'Found three coins'),
            ev(2, { inv: [{ item: 'coin', dq: -1 }] }, 'Paid the toll'),
        ]);
        // `ev` sets no mid, so the anchor is null — a legacy event is still a contributor, just
        // not a jumpable one (§8 cause-link: the jump needs a mesid).
        expect(contributors.get(itemKey('coin'))).toEqual([
            { at: 1, dq: 3, summary: 'Found three coins', mid: null },
            { at: 2, dq: -1, summary: 'Paid the toll', mid: null },
        ]);
    });

    test('a contributor with a mid keeps it, so the panel can jump to its message', () => {
        const { contributors } = deriveState([
            { s: 'Found three coins', kw: [], t: 1, mid: 46, src: 'llm', d: { inv: [{ item: 'coin', dq: 3 }] } },
        ]);
        expect(contributors.get(itemKey('coin'))).toEqual([
            { at: 1, dq: 3, summary: 'Found three coins', mid: 46 },
        ]);
    });

    test('staleness is derived from position in the ledger, not stored', () => {
        const events = [
            ev(1, { inv: [{ item: 'rope', dq: 1 }] }),
            ev(2, { inv: [{ item: 'coin', dq: 1 }] }),
            ev(3, {}),
            ev(4, {}),
        ];
        const { since } = deriveState(events);
        expect(since.get(itemKey('rope'))).toBe(3);
        expect(since.get(itemKey('coin'))).toBe(2);
    });

    test('ignores events with no delta, and is total over junk', () => {
        expect(deriveState([]).inv.size).toBe(0);
        expect(deriveState(null).inv.size).toBe(0);
        expect(deriveState([{ s: 'no delta', t: 1 }]).inv.size).toBe(0);
    });
});

describe('renderState — and the staleness that no longer hides anything', () => {
    test('an item nobody has mentioned for ages is still in the prompt', () => {
        // The `isFresh` test that stood here asserted the opposite, and the assertion was the bug:
        // `cap:stale-hidden` read 198 in the live Solo Leveling chat and 540 in Raccoon City, and
        // what it was hiding was the character's own pockets — the goblin knife, the E-rank licence
        // and the hunter pamphlet, all held and all invisible to the narrator (FOLD-RPG-GAP.md §4).
        // Silence is a zero residual and a zero residual moves nothing (BayesFilter.lean:80-81).
        const inv = new Map([[itemKey('lantern'), { qty: 1 }]]);
        const stale = new Map([[itemKey('lantern'), STALE_THRESHOLD * 100]]);
        expect(renderState({ inv, vitals: new Map(), marks: new Map(), since: stale }))
            .toContain('Carrying: lantern');
    });

    test('renders a compact block', () => {
        const block = renderState({
            inv: new Map([['rope', { qty: 1 }], ['coin', { qty: 42 }]]),
            vitals: new Map([['health', { cur: 34, max: 50 }]]),
            marks: new Map([[markKey('', 'poisoned'), { on: true }], [markKey('', 'blessed'), { on: false }]]),
        });
        expect(block).toContain('Vitals: Health 34/50');
        expect(block).toContain('Status: poisoned');
        expect(block).not.toContain('blessed');
        expect(block).toContain('Carrying: rope, coin x42');
    });

    test('renders nothing at all when there is nothing to say', () => {
        expect(renderState({ inv: new Map(), vitals: new Map(), marks: new Map() })).toBe('');
    });
});

// ── Regressions from live play on the Raccoon City card ───────────────────────────────────────
// Each of these was visible in the panel before it was a test. They are grouped because they share
// a cause: a value that should have replaced an earlier one was instead stored beside it.

describe('names are the model\'s report — the schema instruction is the contract', () => {
    test('a placeholder name the model reported is stored, not refused by an English list', () => {
        // The old `EMPTY_NAME` sentinel was an English word list ("none", "nothing", "nil", "empty",
        // "n/a", "unknown", ...) that could only work in one language. The delta instruction says
        // "Use empty arrays when an event changes nothing" and "Record only what the excerpt NAMES"
        // — so a name meaning "nothing" is the model's error, visible and correctable, never a
        // refusal fold makes with words. Only a structurally empty name is unusable.
        for (const raw of ['none carried', 'None carried', 'nothing of note',
            'no items at present', 'none currently', 'nil']) {
            expect(normalizeItemName(raw)?.name).toBe(raw.toLowerCase());
        }
    });

    test('a real name that merely starts with those letters survives', () => {
        expect(normalizeItemName('north gate key')?.name).toBe('north gate key');
        expect(normalizeItemName('notebook')?.name).toBe('notebook');
        expect(normalizeItemName('nail file')?.name).toBe('nail file');
    });

    test('only structurally empty names are unusable', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'none carried', dq: 1 }, { item: 'none carried', dq: 1 }],
            windowText: 'the block said none carried',
            mentioned: new Set(['none carried']),
        });
        expect(accepted).toHaveLength(2);
        expect(rejected).toHaveLength(0);
    });
});

describe('statusSubject — the subject comes from the schema, not an English modifier list', () => {
    test('finds the leading content token when the phrase leads with it', () => {
        // The old `STATUS_MODIFIERS` stoplist that stripped "mild"/"severe" is gone. The subject is
        // the model's structured `subject` answer; `statusSubject` is only the legacy fallback and
        // takes the first content token.
        expect(statusSubject('hangover mostly eased')).toBe('hangover');
    });

    test('a phrase of no content has no subject', () => {
        expect(statusSubject('')).toBeNull();
    });

    test('a restatement REPLACES rather than joining — the whole point', () => {
        // The model reports `subject: "hangover"` for both descriptions, so they fold to one mark.
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'mild hangover', subject: 'hangover', on: true }] }),
            ev(2, { st: [{ flag: 'hangover mostly eased', subject: 'hangover', on: true }] }),
        ]);
        expect(status.size).toBe(1);
        expect(status.get(markKey('', 'hangover'))).toMatchObject({ on: true, phrase: 'hangover mostly eased' });
    });

    test('unrelated conditions still coexist', () => {
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'mild hangover', on: true }] }),
            ev(2, { st: [{ flag: 'sprained ankle', on: true }] }),
        ]);
        expect(status.size).toBe(2);
    });

    test('renderState reports the phrase, not the key', () => {
        const { marks: status } = deriveState([ev(1, { st: [{ flag: 'hangover mostly eased', on: true }] })]);
        expect(renderState({ inv: new Map(), vitals: new Map(), marks: status })).toContain('hangover mostly eased');
    });
});

describe('healing is the model\'s report, not an English word list', () => {
    test('a flag the model marks on:false turns a tracked condition off', () => {
        // The schema tells the model to set `on: false` when something heals or is treated away.
        // That IS the transition; no `isNegation` word list guesses it from prose.
        const { accepted } = validateStatus({
            status: new Map([[markKey('', 'hangover'), { on: true, phrase: 'mild hangover' }]]),
            deltas: [{ flag: 'hangover', on: false }],
            windowText: 'the hangover was gone by noon',
        });
        expect(accepted).toEqual([expect.objectContaining({ who: '', flag: 'hangover', on: false })]);
    });

    test('an affliction and its later healing leave the healed line', () => {
        // The model reports the affliction, then a second event reports on:false for the same
        // subject. The fold shows the healed state, not a reassurance invented by a word list.
        const window = 'mild hangover';
        const first = validateStatus({
            status: new Map(),
            deltas: [{ flag: 'mild hangover', subject: 'hangover', on: true }],
            windowText: window,
        });
        const state = deriveState([ev(1, { st: first.accepted })]);
        const second = validateStatus({
            status: state.marks,
            deltas: [{ flag: 'hangover', subject: 'hangover', on: false }],
            windowText: 'hangover mostly eased',
        });
        const final = deriveState([ev(1, { st: first.accepted }), ev(2, { st: second.accepted })]);

        const shown = [...final.marks.values()].filter(v => v.on).map(v => v.phrase);
        expect(shown).toEqual([]);
    });
});

describe('read-time normalization heals a ledger written under an older normalizer', () => {
    test('an orphaned opening bracket loses the bracket, not the word', () => {
        // "thinkpad (closed" was recorded before trimWrapping existed. State is a fold, so it
        // folded forward under the truncated name on every single redraw.
        expect(normalizeItemName('thinkpad (closed')?.name).toBe('thinkpad closed');
    });

    test('a properly closed qualifier is left completely alone', () => {
        expect(normalizeItemName('Thinkpad (closed)')?.name).toBe('thinkpad (closed)');
        expect(normalizeItemName('Beretta M92F (12 rounds)')?.name).toBe('beretta m92f (12 rounds)');
    });

    test('deriveState re-normalizes, so the old and new spellings converge on one row', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'thinkpad (closed', dq: 1 }] }),
            ev(2, { inv: [{ item: 'thinkpad closed', dq: 1 }] }),
        ]);
        expect(inv.size).toBe(1);
        expect(inv.get(itemKey('thinkpad closed', CARRIED))).toEqual({ qty: 2 });
    });
});

describe('conditions that tick — consequence without dice', () => {
    test('a condition with no stated duration is permanent', () => {
        // A missing limb does not grow back because twelve turns went by.
        const events = [ev(1, { st: [{ flag: 'broken arm', on: true, turns: 0 }] })];
        for (let i = 2; i < 30; i++) {
            events.push(ev(i, { st: [] }));
        }
        const { marks: status } = deriveState(events);
        expect([...status.values()]).toEqual([expect.objectContaining({ on: true, fade: 1 })]);
    });

    test('a condition with a duration wears off on its own', () => {
        const events = [ev(1, { st: [{ flag: 'mild hangover', on: true, turns: 3 }] })];
        for (let i = 2; i <= 6; i++) {
            events.push(ev(i, { inv: [] }));
        }
        const { marks: status } = deriveState(events);
        expect([...status.values()][0].on).toBe(false);
    });

    test('it fades rather than snapping, so the panel can draw it', () => {
        const events = [
            ev(1, { st: [{ flag: 'mild hangover', on: true, turns: 4 }] }),
            ev(2, { inv: [] }),
            ev(3, { inv: [] }),
        ];
        const { marks: status } = deriveState(events);
        const hangover = [...status.values()][0];
        expect(hangover.on).toBe(true);
        expect(hangover.fade).toBeCloseTo(0.5, 5);
    });

    test('restating it resets the clock — the narrator is the authority on now', () => {
        const events = [
            ev(1, { st: [{ flag: 'mild hangover', on: true, turns: 2 }] }),
            ev(2, { inv: [] }),
            ev(3, { st: [{ flag: 'hangover still going', on: true, turns: 2 }] }),
        ];
        const { marks: status } = deriveState(events);
        expect(status.size).toBe(1);
        expect([...status.values()][0].on).toBe(true);
    });

    test('an expired condition stops being sent to the model', () => {
        const events = [ev(1, { st: [{ flag: 'tipsy', on: true, turns: 1 }] }), ev(2, { inv: [] }), ev(3, { inv: [] })];
        const { marks: status } = deriveState(events);
        expect(renderState({ inv: new Map(), vitals: new Map(), marks: status })).toBe('');
    });

    test('a duration is bounded like any other model claim', () => {
        const { accepted } = validateStatus({
            status: new Map(),
            deltas: [{ flag: 'cursed', on: true, turns: 99999 }],
            windowText: 'she was cursed',
        });
        expect(accepted[0].turns).toBe(MAX_CONDITION_TURNS);
    });

    test('a nonsensical duration degrades to permanent, the safe failure', () => {
        const { accepted } = validateStatus({
            status: new Map(),
            deltas: [{ flag: 'cursed', on: true, turns: -4 }],
            windowText: 'she was cursed',
        });
        expect(accepted[0].turns).toBe(0);
    });

    test('expiry is a READ of the ledger, so swiping the cause away undoes the effect', () => {
        // The whole reason ticking lives in deriveState rather than in a scheduler: drop the event
        // that caused the hangover and there is no hangover to have been fading.
        const cause = ev(1, { st: [{ flag: 'mild hangover', on: true, turns: 3 }] });
        const later = [ev(2, { inv: [] }), ev(3, { inv: [] })];
        expect(deriveState([cause, ...later]).marks.size).toBe(1);
        expect(deriveState(later).marks.size).toBe(0);
    });
});

describe('statusKeyFor — overlap, because word position cannot decide this', () => {
    test('a modifier-led phrase and a subject-led restatement are one condition', () => {
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'mild hangover', on: true }] }),
            ev(2, { st: [{ flag: 'hangover mostly eased', on: true }] }),
        ]);
        expect(status.size).toBe(1);
    });

    test('and so are the inverse pair, which any Nth-word rule gets backwards', () => {
        // "broken arm" then "arm healing": first-word keying gives broken/arm, last-word keying
        // gives arm/healing. Both duplicate. Shared content words do not.
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'broken arm', on: true }] }),
            ev(2, { st: [{ flag: 'arm healing', on: true }] }),
        ]);
        expect(status.size).toBe(1);
        expect([...status.values()][0].phrase).toBe('arm healing');
    });

    test('conditions that share nothing stay separate', () => {
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'broken arm', on: true }] }),
            ev(2, { st: [{ flag: 'mild hangover', on: true }] }),
            ev(3, { st: [{ flag: 'concussion', on: true }] }),
        ]);
        expect(status.size).toBe(3);
    });

    test('identity is fixed by the first description, not the latest', () => {
        // Otherwise the key drifts with every restatement and a third phrase can fail to match.
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'broken arm', on: true }] }),
            ev(2, { st: [{ flag: 'arm healing', on: true }] }),
            ev(3, { st: [{ flag: 'broken arm splinted', on: true }] }),
        ]);
        expect(status.size).toBe(1);
    });
});

describe('restated totals — the fold path that heals a runaway count', () => {
    test('a total overwrites rather than accumulating', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'grey flat cap', set: 1 }] }),
            ev(2, { inv: [{ item: 'grey flat cap', set: 1 }] }),
            ev(3, { inv: [{ item: 'grey flat cap', set: 1 }] }),
        ]);
        expect(inv.get(itemKey('grey flat cap'))).toEqual({ qty: 1 });
    });

    test('a total lands on top of the deltas that corrupted the count', () => {
        // Exactly the shape of the broken chat: seven recorded +1s, then one honest restatement.
        const events = [];
        for (let i = 1; i <= 7; i++) {
            events.push(ev(i, { inv: [{ item: 'grey flat cap', dq: 1 }] }));
        }
        expect(deriveState(events).inv.get(itemKey('grey flat cap'))).toEqual({ qty: 7 });

        events.push(ev(8, { inv: [{ item: 'grey flat cap', set: 1 }] }));
        expect(deriveState(events).inv.get(itemKey('grey flat cap'))).toEqual({ qty: 1 });
    });

    test('a total of zero removes the item', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'rope', dq: 1 }] }),
            ev(2, { inv: [{ item: 'rope', set: 0 }] }),
        ]);
        expect(inv.has(itemKey('rope'))).toBe(false);
    });

    test('a restatement that changes nothing adds no audit row', () => {
        // Otherwise the trail fills with "still have it" once per turn and stops being readable.
        const { contributors } = deriveState([
            ev(1, { inv: [{ item: 'rope', set: 1 }] }),
            ev(2, { inv: [{ item: 'rope', set: 1 }] }),
            ev(3, { inv: [{ item: 'rope', set: 1 }] }),
        ]);
        expect(contributors.get(itemKey('rope'))).toHaveLength(1);
    });

    test('a correction DOES leave an audit row, showing the correction', () => {
        const { contributors } = deriveState([
            ev(1, { inv: [{ item: 'rope', dq: 4 }] }),
            ev(2, { inv: [{ item: 'rope', set: 1 }] }, 'the block restated the list'),
        ]);
        expect(contributors.get(itemKey('rope')).map(c => c.dq)).toEqual([4, -3]);
    });

    test('a total is bounded like any other model claim', () => {
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'rope', set: 99999999 }],
            windowText: 'a coil of rope',
        });
        expect(accepted[0].set).toBeLessThanOrEqual(9999);
    });

    test('a total still has to pass the mention gate', () => {
        const { accepted, rejected } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'dragon egg', set: 1 }],
            windowText: 'she walked to the river',
        });
        expect(accepted).toEqual([]);
        expect(rejected[0].reason).toBe('not-mentioned');
    });
});

describe('canonicalItemName — exact-key identity', () => {
    test('a rewording is a NEW row — the model reports names, fold does not merge by morphology', () => {
        // The old head-token rule folded "m-65 military jacket" onto "m-65 jacket". Whether two
        // spellings name one thing is the model's reading: it reuses the exact State-block name
        // when restating, and the review probe answers `[same?]` for a pair fold cannot resolve.
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'm-65 jacket', dq: 1 }] }),
            ev(2, { inv: [{ item: 'm-65 military jacket', set: 1 }] }),
        ]);
        expect([...inv.keys()].sort()).toEqual([itemKey('m-65 jacket'), itemKey('m-65 military jacket')].sort());
    });

    test('the same name in a different place is still a different item', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'crowbar', dq: 1 }] }),
            ev(2, { inv: [{ item: 'crowbar', dq: 1, at: 'car boot' }] }),
        ]);
        expect(inv.size).toBe(2);
    });
});

describe('the magnitude bound is a RATIO, because an absolute one encodes a genre', () => {
    test('a first sighting is not bounded — there is no prior to bound against', () => {
        // "Absence is not a retraction", applied to magnitude: no evidence, no verdict.
        expect(deltaAllowance(0)).toBe(9999);
    });

    test('growth is bounded against what is held', () => {
        expect(deltaAllowance(1)).toBe(8);
        expect(deltaAllowance(1000)).toBe(4000);
    });

    test('ordinary domestic play never trips it', () => {
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'rope', dq: 1 }],
            windowText: 'she coiled the rope',
        });
        expect(accepted).toHaveLength(1);
    });

    test('civilisation scale passes when the narrative says the number', () => {
        // The case the absolute cap of 6 destroyed.
        const inv = new Map([[itemKey('troops'), { qty: 2000 }]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'troops', dq: 10000 }],
            windowText: 'Ten thousand troops — 10,000 of them — swore to the new banner.',
        });
        expect(accepted).toEqual([{ item: 'troops', dq: 10000 }]);
    });

    test('and is refused when the narrative says no such number', () => {
        const inv = new Map([[itemKey('crowbar'), { qty: 1 }]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'crowbar', dq: 500 }],
            windowText: 'he picked up the crowbar and weighed it in his hand',
        });
        expect(accepted).toEqual([]);
        expect(rejected[0].reason).toBe('implausible-delta');
    });

    test('magnitudeCorroborated reads digits, and leaves spelled-out numbers to the model\'s magnitude field', () => {
        expect(magnitudeCorroborated(10000, 'a levy of 10,000')).toBe(true);
        // "thousands" is a spelled-out scale word — the model reports magnitude:10000 now; fold
        // does not guess the order from English.
        expect(magnitudeCorroborated(10000, 'thousands answered the call')).toBe(false);
        expect(magnitudeCorroborated(10000, 'he found a coin')).toBe(false);
        // Small changes never need corroborating.
        expect(magnitudeCorroborated(3, 'nothing numeric here')).toBe(true);
    });
});

describe('staleness hides nothing at all — cap:stale-hidden retired by construction', () => {
    test('a carried item nobody has mentioned is still carried', () => {
        const inv = new Map([[itemKey('rope'), { qty: 1 }]]);
        const since = new Map([[itemKey('rope'), STALE_THRESHOLD * 50]]);
        expect(renderState({ inv, vitals: new Map(), marks: new Map(), since }))
            .toContain('Carrying: rope');
    });

    test('the three items the live chat hid are all in the ledger block', () => {
        // The exact class FOLD-RPG-GAP.md §4 names: "carried | knife, licence, pamphlet all
        // silently hidden". Every one is past the old threshold and every one renders.
        const inv = new Map([
            [itemKey('goblin knife'), { qty: 1 }],
            [itemKey('e-rank hunter licence'), { qty: 1 }],
            [itemKey('hunter pamphlet'), { qty: 1 }],
        ]);
        const since = new Map([...inv.keys()].map(key => [key, STALE_THRESHOLD * 3]));
        const { lines, shown } = renderLedger({ inv, vitals: new Map(), marks: new Map(), since });
        const text = lines.join('\n');
        expect(text).toContain('goblin knife');
        expect(text).toContain('e-rank hunter licence');
        expect(text).toContain('hunter pamphlet');
        // And `shown` now equals what is held, which is what closes the last hole in the
        // already-recorded gate: a stale item could previously be re-billed because the ledger
        // never showed it.
        expect(shown.size).toBe(inv.size);
    });

    test('renderState keeps stored items in the prompt indefinitely', () => {
        const inv = new Map([
            [itemKey('wallet'), { qty: 1 }],
            [itemKey('shotgun', 'apartment'), { qty: 1 }],
        ]);
        const since = new Map([
            [itemKey('wallet'), STALE_THRESHOLD],
            [itemKey('shotgun', 'apartment'), STALE_THRESHOLD * 9],
        ]);
        const block = renderState({ inv, vitals: new Map(), marks: new Map(), since });
        expect(block).toContain('Stored (apartment): shotgun');
        // The wallet used to be asserted ABSENT here, on the strength of one carried-item
        // measurement (mention gaps top out at 8 turns, n=25) applied to a question about belief.
        // It is in the prompt now, and the case that settles it is a knife in a pocket during a
        // conversation about noodles.
        expect(block).toContain('wallet');
    });
});

describe('a healed condition is recorded as on:false, not guessed from prose', () => {
    test('an on:false flag is what stops a condition rendering', () => {
        // Healing is the model's own report (`on: false`), never an English word list reading the
        // phrase. "Otherwise uninjured" was never a condition a model should have stored as on:true;
        // the schema forbids recording a reassurance, and a heal arrives as on:false.
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'mild arm fatigue', on: true }] }),
            ev(2, { st: [{ flag: 'mild arm fatigue', on: false }] }),
        ]);
        expect([...status.values()].filter(v => v.on).map(v => v.phrase)).toEqual([]);
    });

    test('a real affliction is untouched', () => {
        const { marks: status } = deriveState([ev(1, { st: [{ flag: 'sprained ankle', on: true }] })]);
        expect(status.size).toBe(1);
    });

    test('turning something OFF with a negation phrase still works', () => {
        // The read-time filter only drops negations asserted as true; it must not block a clear.
        const { marks: status } = deriveState([
            ev(1, { st: [{ flag: 'mild hangover', on: true }] }),
            ev(2, { st: [{ flag: 'hangover gone', on: false }] }),
        ]);
        expect([...status.values()].every(v => !v.on)).toBe(true);
    });
});

/*
 * Categories. The whole inventory/assets/abilities divide, with no new table: `itemKey(name, place)`
 * was already a product type and every stage of the pipeline already dispatched on the place half.
 */
describe('categories are places, and cost nothing', () => {
    test('a category is a reserved place, keyed like any other', () => {
        expect(splitItemKey(itemKey('farmstead', 'assets'))).toEqual({ place: ASSETS, name: 'farmstead' });
        expect(splitItemKey(itemKey('second sight', 'abilities'))).toEqual({ place: ABILITIES, name: 'second sight' });
    });

    test('the protocol tokens reach the category; other words are literal places', () => {
        for (const said of ['assets', 'Assets', 'the assets']) {
            expect(normalizePlace(said)).toBe(ASSETS);
        }
        for (const said of ['abilities', 'Abilities', 'the abilities']) {
            expect(normalizePlace(said)).toBe(ABILITIES);
        }
        // No English synonym guessing: a singular "ability" is a phrase, not the protocol token.
        expect(normalizePlace('ability')).toBe('ability');
        expect(normalizePlace('assets and property')).toBe('assets and property');
    });

    test('the protocol carried token stays CARRIED — no second equipment list', () => {
        // Foundry dnd5e keeps ONE inventory with `equipped` as a flag, after a decade of iteration,
        // specifically to kill the desync that two parallel lists guarantee. "worn"/"held" are
        // English synonyms fold no longer guesses — the model writes "carried" per the schema.
        expect(normalizePlace('carried')).toBe(CARRIED);
        expect(normalizePlace('worn')).toBe('worn');
    });

    test('a leading article does not fork a place', () => {
        expect(normalizePlace('the apartment')).toBe(normalizePlace('apartment'));
        expect(normalizePlace('my locker')).toBe(normalizePlace('locker'));
    });

    test('the carried token survives the article strip', () => {
        expect(normalizePlace('the carried')).toBe(CARRIED);
    });

    test('a category never collapses into carried, however phrased', () => {
        expect(normalizePlace('assets')).not.toBe(CARRIED);
        expect(normalizePlace('abilities')).not.toBe(CARRIED);
    });

    test('property, capability and pockets alike survive any amount of silence', () => {
        const inv = new Map([
            [itemKey('farmstead', ASSETS), { qty: 1 }],
            [itemKey('second sight', ABILITIES), { qty: 1 }],
            [itemKey('rope', CARRIED), { qty: 1 }],
        ]);
        const since = new Map([...inv.keys()].map(key => [key, 999]));
        const block = renderState({ inv, vitals: new Map(), marks: new Map(), since });
        expect(block).toContain('farmstead');
        expect(block).toContain('second sight');
        expect(block).toContain('rope');
    });
});

/*
 * Money has no play limit. The first version capped it at 1e12 — a number chosen for feeling roomy,
 * which is exactly how a ceiling becomes a bug in somebody's campaign. A trillionaire is a
 * legitimate character and a national treasury is a legitimate quantity.
 */
describe('money is bounded by arithmetic, not by taste', () => {
    test('a trillion is unremarkable', () => {
        const table = new Map();
        setQty(table, itemKey('won', MONEY), 4.2e12);
        expect(table.get(itemKey('won', MONEY)).qty).toBe(4.2e12);
    });

    test('the only ceiling is where addition stops being exact', () => {
        // Not a judgement about wealth: past MAX_SAFE_INTEGER, a + b silently returns the wrong
        // total, and a wrong total is worse than a refused one.
        expect(MAX_MONEY).toBe(Number.MAX_SAFE_INTEGER);
        const table = new Map();
        setQty(table, itemKey('credits', MONEY), Number.MAX_SAFE_INTEGER * 4);
        expect(table.get(itemKey('credits', MONEY)).qty).toBe(MAX_MONEY);
    });

    test('items keep their own ceiling, which is a plausibility bound', () => {
        // Four thousand crowbars IS a hallucination; four trillion won is a Tuesday.
        const table = new Map();
        setQty(table, itemKey('crowbar', CARRIED), 999999);
        expect(table.get(itemKey('crowbar', CARRIED)).qty).toBe(MAX_QTY);
    });

    test('the delta allowance scales with the holding rather than capping it', () => {
        // A ratio still catches a thousandfold jump at any scale; a fixed floor would have made
        // every large transaction implausible.
        expect(deltaAllowance(4.2e12, MONEY)).toBeGreaterThan(4.2e12);
        expect(deltaAllowance(0, MONEY)).toBe(MAX_MONEY);
    });
});

describe('reject:already-recorded — the model was shown the line and billed it anyway', () => {
    const held = new Map([[itemKey('wrapped candy'), { qty: 2 }]]);
    const shown = new Set([itemKey('wrapped candy')]);
    const windowText = 'she presses two wrapped candies into his palm, as if candy fixes lacerations';
    // Coverage by report, the way production passes it: the model says the window names the item.
    const mentioned = new Set(['wrapped candy']);

    test('a re-report of a line already on the ledger is refused', () => {
        const { accepted, rejected } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: 2 }], windowText, shown, mentioned });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'wrapped candy', reason: 'already-recorded' })]);
    });

    test('nothing is refused when no ledger was pinned', () => {
        // Block absorption never pins one, and a model that was told nothing cannot be blamed for
        // not knowing. `shown` absent means the gate is off, not empty.
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: 2 }], windowText, mentioned });
        expect(accepted).toEqual([{ item: 'wrapped candy', dq: 2 }]);
    });

    test('nothing is refused for a line the ledger held but did not show', () => {
        // Refusing against a line the model never saw would punish it for our own omission.
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: 2 }], windowText, shown: new Set(), mentioned });
        expect(accepted).toEqual([{ item: 'wrapped candy', dq: 2 }]);
    });

    test('a proposal bigger than the ledger covers is not a re-report', () => {
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: 5 }], windowText, shown, mentioned });
        expect(accepted).toEqual([{ item: 'wrapped candy', dq: 5 }]);
    });

    test('a loss with no trail is not a restatement', () => {
        // No contributor trail means no recorded beat to be re-told, so a debit is a fresh change
        // and is accepted. The old blanket claim — "nobody re-narrates dropping something" — was
        // falsified by the Time Stop RPG ledger (one spear billed twice, one room rented twice),
        // which is why the trail now decides the question instead of the sign of `dq`.
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: -1 }], windowText, shown, mentioned });
        expect(accepted).toEqual([{ item: 'wrapped candy', dq: -1 }]);
    });

    test('a loss whose exact magnitude was already recorded is a re-tell, not a fresh debit', () => {
        // The spear purchase billed at mids 36 AND 38 as `silver -10`: the second bill is the same
        // event, and refusing it is what keeps the balance from draining to zero and the THIRD bill
        // from reading as `remove-unknown`. An exact `dq` on the trail, with the magnitude fully
        // covered by the held quantity, is arithmetic on fold's own numbers.
        const inv = new Map([[itemKey('silver', 'money'), { qty: 10 }]]);
        const contributors = new Map([[itemKey('silver', 'money'), [{ dq: -10, summary: 'buys an ash spear', mid: 36 }]]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'silver', dq: -10, at: 'money' }],
            windowText: 'Sol purchased a spear from the smith for ten silver',
            contributors,
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'silver', reason: 'already-recorded' })]);
    });

    test('a loss of a different magnitude than anything recorded is accepted', () => {
        // Same item, same trail, different amount — a real second transaction, not a re-tell.
        const inv = new Map([[itemKey('silver', 'money'), { qty: 10 }]]);
        const contributors = new Map([[itemKey('silver', 'money'), [{ dq: -10, summary: 'buys an ash spear', mid: 36 }]]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'silver', dq: -2, at: 'money' }],
            windowText: 'Sol pays two silver for a room at the inn',
            contributors,
        });
        expect(accepted).toEqual([{ item: 'silver', dq: -2, at: 'money' }]);
    });

    test('the contributor trail refuses a cross-window money re-record', () => {
        // The Eunpyeong ₩680,000 payout credited twice (mids 128 and 142) falsified the "never a
        // duplicated credit" exemption money had. The trail check refuses the re-record even with
        // no `shown` set — a balance was shown, but the exact magnitude already on record is the
        // same event re-told.
        const inv = new Map([[itemKey('won', 'money'), { qty: 2078000 }]]);
        const contributors = new Map([[itemKey('won', 'money'), [{ dq: 680000, summary: 'Kang sends the raid payout', mid: 128 }]]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'won', dq: 680000, at: 'money' }],
            windowText: 'Kang deposits the 680,000 won raid payout',
            contributors,
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'won', reason: 'already-recorded' })]);
    });

    test('a different amount on money is not a re-record', () => {
        const inv = new Map([[itemKey('won', 'money'), { qty: 2078000 }]]);
        const contributors = new Map([[itemKey('won', 'money'), [{ dq: 680000, summary: 'raid payout', mid: 128 }]]]);
        const { accepted } = validateInventory({
            inv,
            deltas: [{ item: 'won', dq: 85000, at: 'money' }],
            windowText: 'a sale nets 85,000 won',
            contributors,
        });
        expect(accepted).toEqual([{ item: 'won', dq: 85000, at: 'money' }]);
    });

    test('the trail catches an item re-record the shown gate missed', () => {
        // The goblin knife recorded at mids 22 and 38: the second window's ledger may not have
        // shown it, but the trail has the +1, so the re-record is refused without needing `shown`.
        const key = itemKey('rusty hunter\'s knife with sheath');
        const inv = new Map([[key, { qty: 1 }]]);
        const contributors = new Map([[key, [{ dq: 1, summary: 'takes its rusted knife', mid: 22 }]]]);
        const { accepted, rejected } = validateInventory({
            inv,
            deltas: [{ item: 'rusty hunter\'s knife with sheath', dq: 1 }],
            windowText: 'he picks up the rusty knife from the dead goblins',
            contributors,
            mentioned: new Set(['rusty hunter\'s knife with sheath']),
        });
        expect(accepted).toEqual([]);
        expect(rejected).toEqual([expect.objectContaining({ item: 'rusty hunter\'s knife with sheath', reason: 'already-recorded' })]);
    });

    test('a restated total is exempt, because it is idempotent by construction', () => {
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', set: 2 }], windowText, shown, mentioned: new Set(['wrapped candy']) });
        expect(accepted).toEqual([{ item: 'wrapped candy', set: 2 }]);
    });

    test('money is exempt — a balance is not evidence about a payment', () => {
        // ₩360,000 after a raid and ₩85,000 from a sale are two payments, not one told twice. The
        // measured money defects were the quantity-cap artefact and the missing debit side, never
        // a duplicated credit.
        const purse = new Map([[itemKey('won', MONEY), { qty: 330000 }]]);
        const { accepted } = validateInventory({
            inv: purse,
            deltas: [{ item: 'won', dq: 85000, at: 'money' }],
            windowText: 'eighty-five thousand won changes hands',
            shown: new Set([itemKey('won', MONEY)]),
            mentioned: new Set(['won']),
        });
        expect(accepted).toEqual([{ item: 'won', dq: 85000, at: MONEY }]);
    });

    test('the same name in another place is another thing', () => {
        const { accepted } = validateInventory({ inv: held, deltas: [{ item: 'wrapped candy', dq: 2, at: 'desk drawer' }], windowText, shown, mentioned: new Set(['wrapped candy']) });
        expect(accepted).toEqual([{ item: 'wrapped candy', dq: 2, at: 'desk drawer' }]);
    });
});

describe('contact details are never items — the schema instruction is the contract', () => {
    test('a contact row the model reports is stored, not refused by an English place list', () => {
        // The delta instruction says "Contact details are NOT items — never record them as gained"
        // and the entity probe reports `reach` structurally. The old `CONTACT_PLACE` regex was an
        // English word list ("contacts", "phone book", "address book") that could only work in one
        // language. fold stores what the model reports; a wrong row is the model's error, visible
        // and correctable, and the review probe re-reads the ledger.
        for (const at of ['contacts', 'contact', 'phone book', 'address book']) {
            const { accepted, rejected } = validateInventory({
                inv: new Map(),
                deltas: [{ item: 'kang\'s phone number', dq: 1, at }],
                windowText: 'he reads out Kang\'s number while Solomon types',
                mentioned: new Set(['kang\'s phone number']),
            });
            expect(rejected).toEqual([]);
            expect(accepted).toEqual([expect.objectContaining({ item: 'kang\'s phone number', dq: 1 })]);
        }
    });
});

describe('canonicalItemName — one name containing another is still two rows', () => {
    test('a phone and a phone number stay two rows', () => {
        // Measured: a block listing `phone` was absorbed into `solomon's phone number`.
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'solomon\'s phone number', dq: 1 }] }),
            ev(2, { inv: [{ item: 'phone', dq: 1 }] }),
        ]);
        expect([...inv.keys()].sort()).toEqual([itemKey('phone'), itemKey('solomon\'s phone number')].sort());
    });

    test('one coat described twice is TWO rows until the model says same', () => {
        // The old head-token rule merged these. Identity is exact now: whether "m-65 military
        // jacket" is the same coat as "m-65 jacket" is the review probe's `[same?]` question, not a
        // fold judgement made from English prepositions.
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'm-65 jacket', dq: 1 }] }),
            ev(2, { inv: [{ item: 'm-65 military jacket', dq: 1 }] }),
        ]);
        expect([...inv.keys()].sort()).toEqual([itemKey('m-65 jacket'), itemKey('m-65 military jacket')].sort());
        expect(inv.get(itemKey('m-65 jacket'))).toEqual({ qty: 1 });
    });

    test('two people\'s numbers do not collapse into one', () => {
        const { inv } = deriveState([
            ev(1, { inv: [{ item: 'kang\'s phone number', dq: 1 }] }),
            ev(2, { inv: [{ item: 'jin-woo\'s phone number', dq: 1 }] }),
        ]);
        expect(inv.size).toBe(2);
    });
});

describe('renderLedger — the pinned block, and what it says it showed', () => {
    const state = deriveState([
        ev(1, { inv: [{ item: 'won', set: 330000, at: 'money' }] }),
        ev(2, { inv: [{ item: 'goblin knife', dq: 1 }, { item: 'laptop', dq: 1, at: 'goshiwon room' }] }),
        ev(3, { st: [{ flag: 'bandaged left calf', on: true, turns: 0 }] }),
    ]);

    test('money reads as a balance, not as luggage', () => {
        // `renderState` prints it as `Stored (money): won x330000` — a balance dressed as a thing
        // in a bag, in the one prompt that is asking the model to record purchases.
        const { lines } = renderLedger(state);
        expect(lines[0]).toBe('Money: 330000 won');
        expect(lines).toContain('Carrying: goblin knife');
        expect(lines).toContain('Stored (goshiwon room): laptop');
        expect(lines).toContain('Condition: bandaged left calf');
    });

    test('the shown set is exactly the inventory keys that reached the prompt', () => {
        const { shown } = renderLedger(state);
        expect([...shown].sort()).toEqual([
            itemKey('goblin knife'),
            itemKey('laptop', 'goshiwon room'),
            itemKey('won', MONEY),
        ].sort());
    });

    test('a carried item nothing has mentioned is both shown and claimed', () => {
        // The inverse of the assertion that stood here. `shown` is what makes
        // `reject:already-recorded` honest, and while `isFresh` hid stale rows the gate had a hole
        // exactly the size of the hiding: an item too stale to be shown could be re-billed. Both
        // ends closed at once.
        const stale = { ...state, since: new Map([[itemKey('goblin knife'), STALE_THRESHOLD * 20]]) };
        const { lines, shown } = renderLedger(stale);
        expect(lines.join('\n')).toContain('goblin knife');
        expect(shown.has(itemKey('goblin knife'))).toBe(true);
    });

    test('an empty state renders nothing at all', () => {
        const { lines, shown } = renderLedger(deriveState([]));
        expect(lines).toEqual([]);
        expect(shown.size).toBe(0);
    });
});

/*
 * ── The ₩9,999 root, and it was deeper than the missing `at` ──
 *
 * Phase A's window replay found it while measuring something else: `merge_qty` picks its ceiling
 * with `maxQty(nu?.at ?? old?.at)`, and `bumpQty` handed it a bare `{dq}` — no `at` on the incoming
 * value, and none on the stored one either, because the stored shape is `{qty}`. So EVERY dq-sourced
 * change clamped at MAX_QTY, money included, and only `setQty` (the restated-total path) ever read
 * the place off the key. The pinned `Money:` line then lied about the balance for the rest of the
 * chat (FOLD-RPG-GAP.md §0: "money | won ×9,999 | ₩330,000").
 */
describe('a money delta is bounded by arithmetic, not by the pocket cap', () => {
    test('a tagged money delta folds to its full amount', () => {
        const inv = deriveState([ev(1, { inv: [{ item: 'won', dq: 360000, at: 'money' }] })]).inv;
        expect(inv.get(itemKey('won', MONEY)).qty).toBe(360000);
        expect(inv.get(itemKey('won', MONEY)).qty).not.toBe(MAX_QTY);
    });

    test('the raid payout at mid 46 is the case, and its recorded shape is the other half of it', () => {
        // The event as it actually sits in the live ledger: `{"item":"won","dq":360000}`, with no
        // `at` at all. It keys as a CARRIED "won" and is still capped — correctly, since a carried
        // object is not a balance. Getting that delta into the money place is the delta
        // instruction's job and the directed money question's, not a currency word list here
        // (FOLD-REDESIGN.md §11 rules those out with a standing measurement). Asserted rather than
        // hidden, so the remaining half of the defect is visible in the suite.
        const asRecorded = deriveState([ev(1, { inv: [{ item: 'won', dq: 360000 }] })]).inv;
        expect(asRecorded.get(itemKey('won', CARRIED)).qty).toBe(MAX_QTY);

        const asTagged = deriveState([ev(1, { inv: [{ item: 'won', dq: 360000, at: 'money' }] })]).inv;
        expect(asTagged.get(itemKey('won', MONEY)).qty).toBe(360000);
    });

    test('a validated money delta survives the whole pipeline at full size', () => {
        const { accepted } = validateInventory({
            inv: new Map(),
            deltas: [{ item: 'won', dq: 360000, at: 'money' }],
            windowText: 'his share came to 360,000 won',
        });
        expect(deriveState([ev(1, { inv: accepted })]).inv.get(itemKey('won', MONEY)).qty).toBe(360000);
    });

    test('and an ordinary item is still capped, because that guard was never the bug', () => {
        const inv = deriveState([ev(1, { inv: [{ item: 'crowbar', dq: 999999 }] })]).inv;
        expect(inv.get(itemKey('crowbar')).qty).toBe(MAX_QTY);
    });
});

/*
 * MAX_CHANGES_PER_TURN counted restatements against a budget named for changes. The measured shape:
 * the message-72 reconciliation in Solo Leveling is one validateInventory call carrying 30 inventory
 * lines, all restatements, and any genuine gain queued behind the twelfth would have been dropped.
 */
describe('the change budget counts changes', () => {
    test('a restated total never consumes a change slot', () => {
        const deltas = [
            ...Array.from({ length: MAX_CHANGES_PER_TURN + 4 }, (_, n) => ({ item: `thing ${n}`, set: 1 })),
            { item: 'goblin knife', dq: 1 },
        ];
        const windowText = `${deltas.map(d => d.item).join(' ')} goblin knife`;
        const { accepted, rejected } = validateInventory({ inv: new Map(), deltas, windowText });
        expect(rejected.filter(r => r.reason === 'rate-limited')).toEqual([]);
        expect(accepted.some(entry => entry.item === 'goblin knife' && entry.dq === 1)).toBe(true);
    });

    test('and a genuine flood is still bounded', () => {
        const deltas = Array.from({ length: MAX_CHANGES_PER_TURN + 3 }, (_, n) => ({ item: `thing ${n}`, dq: 1 }));
        const { accepted, rejected } = validateInventory({
            inv: new Map(), deltas, windowText: deltas.map(d => d.item).join(' '),
        });
        expect(accepted).toHaveLength(MAX_CHANGES_PER_TURN);
        expect(rejected.filter(r => r.reason === 'rate-limited')).toHaveLength(3);
    });

    test('the bound clears the live observation by more than a factor of two', () => {
        // Phase A measured it BINDING at 13 in one turn of the live chat; re-measured over all four
        // ledger copies the largest per-turn total of non-restated changes is 11, and the largest in
        // any single delta is 6. A cap's own victims are the rows missing from the file you measure
        // it against, so the live count is the tighter observation.
        expect(MAX_CHANGES_PER_TURN).toBeGreaterThanOrEqual(2 * 13);
    });
});

/*
 * Contact details are `reach` on a person, not a thing in a pocket. The read-heal is keyed on the
 * migration's OWN record — the exact item keys it moved (`reachKeys`) — never on an English place
 * word. FOLD-REDESIGN.md §10, Phase B LANDED deviation 7.
 */
describe('the contact read-heal is keyed on the migration\'s own record', () => {
    test('an exact key the migration recorded contributes no inventory row', () => {
        const inv = deriveState([ev(1, {
            inv: [
                { item: 'kang\'s phone number', dq: 1, at: 'contacts' },
                { item: 'jin-woo\'s phone number', dq: 1, at: 'contacts' },
            ],
        })], {
            reachKeys: new Set([`contacts${'\u0000'}kang's phone number`, `contacts${'\u0000'}jin-woo's phone number`]),
        }).inv;
        expect(inv.size).toBe(0);
    });

    test('a spelling the migration did not record folds as the model reported it', () => {
        // The old rule refused every spelling of the place ("contact list", "phonebook", "phone
        // book", "address book") with an English word list. fold no longer reads place words to
        // decide what is a contact; a row not in the migration's own reachKeys record folds.
        for (const place of ['contact list', 'phonebook', 'phone book', 'address book']) {
            const inv = deriveState([ev(1, { inv: [{ item: 'kang\'s number', dq: 1, at: place }] })]).inv;
            expect(inv.size).toBe(1);
        }
    });

    test('read-time, so nobody\'s ledger is rewritten and a rollback loses nothing', () => {
        // The event is untouched — only the fold ignores it. Rewriting the ledger would destroy the
        // evidence that the numbers were ever exchanged.
        const events = [ev(1, { inv: [{ item: 'kang\'s phone number', dq: 1, at: 'contacts' }] })];
        deriveState(events, { reachKeys: new Set(['kang\'s phone number']) });
        expect(events[0].d.inv[0]).toEqual({ item: 'kang\'s phone number', dq: 1, at: 'contacts' });
    });

    test('an ordinary place is unaffected', () => {
        const inv = deriveState([ev(1, { inv: [{ item: 'laptop', dq: 1, at: 'goshiwon room' }] })]).inv;
        expect(inv.get(itemKey('laptop', 'goshiwon room')).qty).toBe(1);
    });
});
