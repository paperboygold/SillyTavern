import { describe, expect, test } from '@jest/globals';

import {
    deriveState,
    merge_vital,
    renderState,
} from '../public/scripts/extensions/sanguine/state-table.js';

const ev = (t, d) => ({ s: 'something happened', kw: [], t, src: 'llm', d });

/*
 * A gauge nobody bounded is not a gauge.
 *
 * MEASURED, live Raccoon City campaign. The whole campaign contains exactly ONE vital event:
 *
 *     mid 138  {"name": "ammunition", "dcur": -1}
 *              "Solomon fired at the operative from the SUV, then drove off."
 *
 * The panel showed `Ammunition 99/100`. Both numbers were invented by the merge: `max` fell back to
 * a literal 100, and the accumulation base fell back to `max`, so a gauge nobody had ever described
 * was assumed to exist, to hold a hundred, and to be full. One shot fired, and the fold built a
 * hundred-round magazine to fire it out of.
 *
 * The corpus is exact about why that is the wrong algebra. `reconcile_ok`
 * (`sanguine/proof/Closures/Applied/DerivedState.lean:105`) is a theorem about clamping to a REAL
 * ceiling; `trust_can_break` (`:115`) is the branch that does not. A DEFAULTED ceiling makes the
 * clamp a fabrication engine rather than a bound. An unbounded quantity, the corpus's counter,
 * `balance l = foldKey id l` (`:59`), with exact removal (`refund_is_exact`, `:77`), is a different
 * shape, and this codebase already has it as `merge_qty` over the inventory key space. sanguine's
 * own taxonomy names the split (`review-table.js`: "gauge" for a pool with a current and a maximum,
 * "counter" for an unbounded quantity, coin, ammo, charges).
 *
 * So: an attested ceiling still behaves exactly as it did, including the "arrives full, then takes
 * damage" case the merge was written for. An unattested one invents nothing.
 */
describe('a vital invents neither its ceiling nor its starting value', () => {
    test('the live ammunition event no longer folds to 99/100', () => {
        const { vitals } = deriveState([ev(1, { vit: [{ name: 'ammunition', dcur: -1 }] })]);
        const ammo = vitals.get('ammunition');
        expect(ammo.max).toBe(0);
        expect(ammo.cur).not.toBe(99);
    });

    test('an attested ceiling still arrives full and then takes the damage', () => {
        // The case `merge_vital` was written for and which must not regress: a first HP report that
        // carries its own damage. `{dcur:-26, max:70}` folds to 44, not to a row with no `cur`.
        const { vitals } = deriveState([ev(1, { vit: [{ name: 'hp', dcur: -26, max: 70 }] })]);
        expect(vitals.get('hp')).toMatchObject({ cur: 44, max: 70 });
    });

    test('a ceiling stated later bounds what was counted before it', () => {
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'focus', dcur: 3 }] }),
            ev(2, { vit: [{ name: 'focus', dcur: 1, max: 5 }] }),
        ]);
        expect(vitals.get('focus')).toMatchObject({ cur: 4, max: 5 });
    });

    test('an unbounded count accumulates and floors at zero, never at an invented ceiling', () => {
        const { vitals } = deriveState([
            ev(1, { vit: [{ name: 'charges', dcur: 6 }] }),
            ev(2, { vit: [{ name: 'charges', dcur: 500 }] }),
        ]);
        // 506 would be impossible under a fabricated ceiling of 100.
        expect(vitals.get('charges')).toMatchObject({ cur: 506, max: 0 });
        const { vitals: floored } = deriveState([ev(1, { vit: [{ name: 'charges', dcur: -4 }] })]);
        expect(floored.get('charges').cur).toBe(0);
    });

    test('the merge is honest on its own, with no fold around it', () => {
        expect(merge_vital({ dcur: -1 }, undefined)).toEqual({ max: 0, cur: 0 });
        expect(merge_vital({ dcur: -26, max: 70 }, undefined)).toEqual({ max: 70, cur: 44 });
    });

    test('an unbounded count renders as a count, not as "0/0"', () => {
        const { inv, vitals, marks } = deriveState([ev(1, { vit: [{ name: 'charges', dcur: 6 }] })]);
        const block = renderState({ inv, vitals, marks });
        expect(block).toContain('Charges 6');
        expect(block).not.toContain('/0');
    });
});
