import { describe, expect, test } from '@jest/globals';

import {
    applyOp, applyOps, makeTable, renderLedger, withCoverage,
    serialize, deserialize, selfTest, projectDelta,
} from '../public/scripts/extensions/sanguine/rows-table.js';
import { deriveState, itemKey } from '../public/scripts/extensions/sanguine/state-table.js';

describe('rows-table: the Phase 1 fold closes the census failure classes', () => {
    test('the self-test holds', () => {
        expect(() => selfTest()).not.toThrow();
    });

    test('conservation: 200 + 10000 = 10200 at the money ceiling', () => {
        const t = makeTable();
        const { diffs, errors } = applyOps(t, [
            { op: 'new', kind: 'item', name: 'won', place: 'money', qty: 200 },
            { op: 'gain', id: 'R1', dq: 10000 },
        ], 1);
        expect(errors).toEqual([]);
        expect(diffs).toEqual([]);
        expect(t.rows.get('R1').qty).toBe(10200);
    });

    test('census row 1: a bare "knife" cannot grow a second row against a held "ka-bar knife"', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 }], 1);
        // The census measured `{"item":"knife","dq":1}` sent 10 times against the held ka-bar knife.
        const dup = applyOp(t, { op: 'new', kind: 'item', name: 'knife', place: 'carried', qty: 1 }, 2);
        expect(dup.error).toBe('new-matches-held');
        expect(dup.held).toBe('R1');
        expect(t.rows.size).toBe(1);
    });

    test('census row 1: same_as merges two spellings into the held row', () => {
        const t = makeTable();
        applyOps(t, [
            // No shared tokens, so both rows are created; the merge then folds one into the other.
            { op: 'new', kind: 'person', name: 'Ada Wong', place: 'elsewhere' },
            { op: 'new', kind: 'person', name: 'the woman in red', place: 'elsewhere' },
            { op: 'same_as', id: 'R2', target: 'R1' },
        ], 1);
        expect(t.rows.has('R1')).toBe(true);
        expect(t.rows.has('R2')).toBe(false);
        expect(t.rows.get('R1').name).toBe('the woman in red');
    });

    test('census row 2: two distinct things stay two rows, no single row can be summed into', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: '9mm magazines', place: 'carried', qty: 3 },
            { op: 'new', kind: 'item', name: 'buckshot shells', place: 'carried', qty: 25 },
            { op: 'new', kind: 'item', name: 'box of birdshot', place: 'carried', qty: 1 },
        ], 1);
        applyOps(t, [{ op: 'spend', id: 'R2', dq: 5 }], 2);
        expect(t.rows.get('R1').qty).toBe(3);
        expect(t.rows.get('R2').qty).toBe(20);
        expect(t.rows.get('R3').qty).toBe(1);
    });

    test('census row 3 + 7: a stated set that disagrees with the fold is a diff, never silently adopted', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'won', place: 'money', qty: 9999 }], 1);
        const { diffs } = applyOps(t, [{ op: 'set', id: 'R1', set: 10200 }], 2);
        expect(diffs).toHaveLength(1);
        expect(diffs[0]).toMatchObject({ id: 'R1', set: 10200, diff: -201 });
        // The mismatch is surfaced, NOT applied: the fold keeps its own value so a "keep" verdict
        // can restore it. Only the audit's forced resolution applies the story's number.
        expect(t.rows.get('R1').qty).toBe(9999);
        expect(t.rows.get('R1').stated).toMatchObject({ set: 10200, diff: -201 });
    });

    test('a matching set applies (no diff), and a forced set is the audit resolution', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'won', place: 'money', qty: 10200 }], 1);
        const { diffs } = applyOps(t, [{ op: 'set', id: 'R1', set: 10200 }], 2);
        expect(diffs).toEqual([]);
        expect(t.rows.get('R1').qty).toBe(10200);

        // The audit resolves a mismatch: force applies the stated total, no re-diff.
        applyOps(t, [{ op: 'set', id: 'R1', set: 200, force: true }], 3);
        expect(t.rows.get('R1').qty).toBe(200);
    });

    test('census row 4: ops touch the staleness clock; close leaves the ledger', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'thread', name: 'the missing shipment' },
            { op: 'new', kind: 'item', name: 'arrow', place: 'carried', qty: 1 },
        ], 10);
        expect(t.rows.get('R1').seen).toBe(10);
        applyOps(t, [{ op: 'gain', id: 'R2', dq: 3 }], 11);
        expect(t.rows.get('R2').seen).toBe(11);
        applyOps(t, [{ op: 'close', id: 'R1' }], 12);
        const ledger = renderLedger(t);
        expect(ledger).toContain('R2');
        expect(ledger).not.toContain('R1');
    });

    test('census row 5: who flows through new and change', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'ironwood branch', place: 'carried', who: 'Sylanna\'s satchel' }], 1);
        expect(t.rows.get('R1').who).toBe('Sylanna\'s satchel');
    });

    test('census R7: the by-id coverage gate refuses an op on a row the report did not mention', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'won', place: 'money', qty: 200 }], 1);
        const ops = [{ op: 'gain', id: 'R1', dq: 10000 }];
        // The model's own mentions report only R2, R1 was not in the window it read.
        const covered = withCoverage(ops, ['R2']);
        expect(covered).toEqual([]);
        expect(withCoverage([{ op: 'new', kind: 'item', name: 'birdshot' }], [])).toHaveLength(1);
        expect(withCoverage(ops, ['R1', 'R2'])).toHaveLength(1);
    });

    test('serialize/deserialize round-trips the table', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'won', place: 'money', qty: 10200 },
            { op: 'new', kind: 'thread', name: 'the missing shipment' },
        ], 1);
        const t2 = deserialize(serialize(t));
        expect(t2.nextId).toBe(t.nextId);
        expect(t2.rows.get('R1').qty).toBe(10200);
        expect(t2.rows.get('R2').name).toBe('the missing shipment');
    });

    test('spend floors at zero, a spent thing is the residue, not a negative balance', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'arrow', place: 'carried', qty: 1 }], 1);
        applyOps(t, [{ op: 'spend', id: 'R1', dq: 5 }], 2);
        expect(t.rows.get('R1').qty).toBe(0);
    });

    test('projectDelta: the bridge keeps the old-shape delta faithful', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'won', place: 'money', qty: 200 },
            { op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 },
            { op: 'new', kind: 'vital', name: 'hp', place: '', qty: 38 },
        ], 1);
        const ops = [
            { op: 'gain', id: 'R1', dq: 10000 },
            { op: 'move', id: 'R2', at: 'house' },
            { op: 'set', id: 'R3', set: 70 },
        ];
        const before = new Map();
        for (const op of ops) {
            const row = t.rows.get(op.id);
            before.set(op.id, { kind: row.kind, name: row.name, place: row.place, qty: row.qty, who: row.who, rank: row.rank });
        }
        const delta = projectDelta(before, ops);
        // gain → dq at the row's place
        expect(delta.inv).toContainEqual(expect.objectContaining({ item: 'won', dq: 10000, at: 'money' }));
        // move → a debit at the old place and a credit at the new
        expect(delta.inv).toContainEqual(expect.objectContaining({ item: 'ka-bar knife', dq: -1, at: 'carried' }));
        expect(delta.inv).toContainEqual(expect.objectContaining({ item: 'ka-bar knife', dq: 1, at: 'house' }));
        // set on a vital → dcur
        expect(delta.vit).toContainEqual(expect.objectContaining({ name: 'hp', dcur: 70 }));
    });

    test('the pinned ledger is bounded, live rows first, the tail counted not hidden', () => {
        const t = makeTable();
        // A vital, a carried item, and a far-row that would fall off a small limit.
        applyOps(t, [
            { op: 'new', kind: 'vital', name: 'hp', qty: 38 },
            { op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'old newspaper', place: 'gutter', qty: 1 },
            { op: 'new', kind: 'item', name: 'curtains', place: 'apartment', qty: 1 },
        ], 1);
        const ledger = renderLedger(t, 2);
        const lines = ledger.split('\n');
        expect(lines[0]).toContain('R1'); // vitals first
        expect(lines[1]).toContain('R2'); // carried next
        expect(ledger).toContain('2 more rows not shown');
    });

    test('new lands at its `at`, not the carried default', () => {
        const t = makeTable();
        const { errors } = applyOps(t, [{ op: 'new', kind: 'item', name: 'food', at: 'car', qty: 5 }], 1);
        expect(errors).toEqual([]);
        expect(t.rows.get('R1').place).toBe('car');
        expect(t.rows.get('R1').qty).toBe(5);
    });

    test('split: a name that is several things comma-joined becomes separate rows', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'tactical bag thinkpad, audit usbs, maps', place: 'carried', qty: 1 }], 1);
        const { errors } = applyOps(t, [{
            op: 'split', id: 'R1',
            parts: [{ name: 'tactical bag' }, { name: 'thinkpad' }, { name: 'audit usbs' }, { name: 'maps' }],
        }], 2);
        expect(errors).toEqual([]);
        // The source is an empty shell, closed off the ledger.
        expect(t.rows.get('R1')).toMatchObject({ qty: 0, status: 'closed' });
        // The parts are their own rows, carried.
        for (const name of ['tactical bag', 'thinkpad', 'audit usbs', 'maps']) {
            const part = [...t.rows.values()].find(r => r.name === name);
            expect(part).toMatchObject({ kind: 'item', place: 'carried', qty: 1 });
        }
        const ledger = renderLedger(t);
        expect(ledger).toContain('tactical bag');
        expect(ledger).not.toContain('tactical bag thinkpad');
    });

    test('a thread is never carried: new with no place lands ""', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'thread', name: 'correspondence with A.W.' }], 1);
        expect(t.rows.get('R1')).toMatchObject({ kind: 'thread', place: '' });
        expect(renderLedger(t)).not.toContain('carried');
    });

    test('a thread\'s carried is stripped, an explicit place does not make it an item', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'thread', name: 'Umbrella file server access', at: 'carried' }], 1);
        applyOps(t, [{ op: 'move', id: 'R1', at: 'carried' }], 2);
        expect(t.rows.get('R1')).toMatchObject({ kind: 'thread', place: '' });
    });

    test('a person is located but never carried', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'person', name: 'A.W.', at: 'carried' },
            { op: 'new', kind: 'person', name: 'Kang Min-seo', at: 'Nowon gate' },
        ], 1);
        expect(t.rows.get('R1')).toMatchObject({ kind: 'person', place: '' });
        expect(t.rows.get('R2')).toMatchObject({ kind: 'person', place: 'nowon gate' });
    });

    test('projectDelta projects only items into the legacy inventory', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'flash drive', place: 'carried', qty: 1 },
            { op: 'new', kind: 'thread', name: 'correspondence with A.W.' },
            { op: 'new', kind: 'person', name: 'A.W.' },
        ], 1);
        const ops = [
            { op: 'gain', id: 'R1', dq: 1 },
            { op: 'move', id: 'R2', at: 'apartment' },
            { op: 'change', id: 'R3', name: 'A.W.' },
        ];
        const before = new Map();
        for (const op of ops) {
            const row = t.rows.get(op.id);
            before.set(op.id, { kind: row.kind, name: row.name, place: row.place, qty: row.qty, who: row.who, rank: row.rank });
        }
        const delta = projectDelta(before, ops);
        // The item still projects; the thread and the person do not.
        expect(delta.inv).toHaveLength(1);
        expect(delta.inv[0]).toMatchObject({ item: 'flash drive', dq: 1, at: 'carried' });
        expect(delta.inv.some(e => e.item.includes('correspondence'))).toBe(false);
        expect(delta.inv.some(e => e.item === 'A.W.')).toBe(false);
    });

    test('projectDelta: a thread new produces no inventory delta at all', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'thread', name: 'the missing shipment', at: 'carried' }], 1);
        const before = new Map();
        const delta = projectDelta(before, [{ op: 'new', kind: 'thread', name: 'the missing shipment', at: 'carried' }]);
        expect(delta.inv).toEqual([]);
        expect(delta.vit).toEqual([]);
        expect(delta.st).toEqual([]);
    });

    test('Phase 4 reactivity: the projected delta folds back to the exact rows truth', () => {
        // The block the GM sees is `deriveState` over the chronicle, fed by the rows probe's
        // projected deltas. The contract: what the block shows equals what the fold holds.
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'won', place: 'money', qty: 200 },
            { op: 'gain', id: 'R1', dq: 10000 },
            { op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 },
        ], 1);
        const ops = [
            { op: 'gain', id: 'R1', dq: 10000 },
            { op: 'spend', id: 'R2', dq: 1 },
        ];
        const before = new Map();
        for (const op of ops) {
            const row = t.rows.get(op.id);
            before.set(op.id, { kind: row.kind, name: row.name, place: row.place, qty: row.qty, who: row.who, rank: row.rank });
        }
        const delta = projectDelta(before, ops);
        // Feed the projection back as chronicle events the way `recordRowsEvent` does.
        const events = [
            { s: 'seed', kw: [], t: 1, src: 'rows', k: 'seed', d: { inv: [{ item: 'won', dq: 200, at: 'money' }], vit: [], st: [] } },
            { s: 'seed', kw: [], t: 2, src: 'rows', k: 'seed2', d: { inv: [{ item: 'ka-bar knife', dq: 1, at: 'carried' }], vit: [], st: [] } },
            { s: 'projected', kw: [], t: 3, src: 'rows', k: 'proj', d: delta },
        ];
        const { inv } = deriveState(events);
        // The fold held 10200 won; the derived state must read exactly that.
        expect(inv.get(itemKey('won', 'money')).qty).toBe(10200);
        // A thing spent to zero leaves the derived panel, the row the fold keeps is the audit's
        // to question, not the block's to show.
        expect(inv.has(itemKey('ka-bar knife', 'carried'))).toBe(false);
    });
});
