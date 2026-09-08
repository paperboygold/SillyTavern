import { describe, expect, test } from '@jest/globals';

import {
    makeTable, applyOps, applyOp,
} from '../public/scripts/extensions/sanguine/rows-table.js';
import {
    stalenessSuspects, capacitySuspects, identitySuspects,
    conservationSuspects, duplicateSuspects, auditBlock, planAudit,
    questionKey, opForVerdict, unposedFindings,
    namePollutionSuspects, isPollutedName,
    CARRIED_LIMIT,
} from '../public/scripts/extensions/sanguine/audit-table.js';

const near = (a, b) => {
    const toks = s => new Set(String(s).toLowerCase().split(/[^0-9a-z]+/).filter(Boolean));
    const [x, y] = [toks(a), toks(b)];
    if (!x.size || !y.size || x.size === y.size) return false;
    const [small, large] = x.size <= y.size ? [x, y] : [y, x];
    return [...small].every(t => large.has(t));
};

describe('audit-table: the exact detectors', () => {
    test('staleness: a carried row silent past the threshold is a question, never a hide', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'wolf pelt', place: 'carried', qty: 10 },
            { op: 'new', kind: 'item', name: 'dumped bag', place: 'house', qty: 1 },
        ], 1);
        // Touch only the knife at turn 20; the pelts were last seen at turn 1.
        applyOps(t, [{ op: 'gain', id: 'R1', dq: 1 }], 20);
        const suspects = stalenessSuspects(t.rows, 21);
        expect(suspects.map(s => s.id)).toEqual(['R2']); // pelts, silent 20 turns
        expect(suspects[0]).toMatchObject({ kind: 'stale', name: 'wolf pelt', place: 'carried', ago: 20 });
        // The dumped bag is at the house, not a carried-staleness question.
        expect(suspects.some(s => s.id === 'R3')).toBe(false);
        // The knife was touched at 20, not silent.
        expect(suspects.some(s => s.id === 'R1')).toBe(false);
    });

    test('staleness: closed rows are never questioned', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'arrow', place: 'carried', qty: 1 },
            { op: 'close', id: 'R1' },
        ], 1);
        expect(stalenessSuspects(t.rows, 100)).toEqual([]);
    });

    test('capacity: over the bound is ONE warning, never per-row noise', () => {
        const t = makeTable();
        for (let i = 1; i <= CARRIED_LIMIT + 2; i++) {
            applyOps(t, [{ op: 'new', kind: 'item', name: `thing${i}`, place: 'carried', qty: 1 }], i);
        }
        const suspects = capacitySuspects(t.rows);
        // One warning card, not two per-row questions.
        expect(suspects).toHaveLength(1);
        expect(suspects[0]).toMatchObject({ kind: 'capacity', count: CARRIED_LIMIT + 2, limit: CARRIED_LIMIT });
        // Under the bound there is no warning.
        const t2 = makeTable();
        applyOps(t2, [{ op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 }], 1);
        expect(capacitySuspects(t2.rows)).toEqual([]);
    });

    test('identity: nearIdentity same-kind same-place pairs are questions', () => {
        const t = makeTable();
        // The `new-matches-held` guard refuses a near name at the same place, so the pair must
        // co-locate by a move, exactly the case the guard cannot see.
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'bronze key', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'key', place: 'house', qty: 1 },
            { op: 'new', kind: 'item', name: 'wolf pelt', place: 'carried', qty: 10 },
            { op: 'move', id: 'R2', at: 'carried' },
        ], 1);
        const suspects = identitySuspects(t.rows, near);
        expect(suspects).toHaveLength(1);
        expect(suspects[0]).toMatchObject({ kind: 'identity', name: 'bronze key', otherName: 'key' });
    });

    test('conservation and duplicates carry through from the fold', () => {
        const cons = conservationSuspects([{ id: 'R1', name: 'won', qty: 9999, set: 10200, diff: -201 }]);
        expect(cons[0]).toMatchObject({ kind: 'conservation', diff: -201 });

        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 }], 1);
        const refused = applyOp(t, { op: 'new', kind: 'item', name: 'knife', place: 'carried', qty: 1 }, 2);
        const dups = duplicateSuspects([{ error: refused.error, held: refused.held, op: { name: 'knife' } }], t.rows);
        expect(dups[0]).toMatchObject({ kind: 'duplicate', name: 'knife', heldName: 'ka-bar knife' });
    });

    test('auditBlock + planAudit: the numbered block routes answers back to fold ops', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'wolf pelt', place: 'carried', qty: 10 },
            { op: 'new', kind: 'item', name: 'bronze key', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'key', place: 'house', qty: 1 },
            { op: 'move', id: 'R3', at: 'carried' },
        ], 1);
        const suspects = [
            ...stalenessSuspects(t.rows, 30),
            ...identitySuspects(t.rows, near),
        ];
        const { text, index } = auditBlock(suspects);
        expect(text).toContain('S1');
        expect(text).toContain('[stale]');
        expect(text).toContain('I1');
        expect(text).toContain('[identity]');

        const { ops, rejected } = planAudit({
            answers: [
                { id: 'S1', verdict: 'gone', at: '', target: '', evidence: 'the pelts were sold at the trader.' },
                { id: 'I1', verdict: 'same', at: '', target: 'R3', evidence: 'the key and the bronze key are the same.' },
            ],
        }, index);
        expect(rejected).toEqual([]);
        expect(ops).toHaveLength(2);
        expect(ops[0]).toMatchObject({ op: 'close', id: 'R1' });
        expect(ops[1]).toMatchObject({ op: 'same_as', id: 'R2', target: 'R3' });

        // A keep answers nothing and needs no evidence.
        const { ops: kept } = planAudit({ answers: [{ id: 'S1', verdict: 'keep', at: '', target: '', evidence: '' }] }, index);
        expect(kept).toEqual([{ op: 'none', id: 'R1' }]);
    });

    test('conservation: the full path, stated set diffs, posed, resolved by force, no loop', () => {
        const t = makeTable();
        applyOps(t, [{ op: 'new', kind: 'item', name: 'won', place: 'money', qty: 9999 }], 1);
        // The model states a total that disagrees → one diff, the fold keeps its value.
        const { diffs } = applyOps(t, [{ op: 'set', id: 'R1', set: 10200 }], 2);
        expect(diffs).toHaveLength(1);
        expect(t.rows.get('R1').qty).toBe(9999);

        // The audit poses the diff as a conservation question.
        const suspects = conservationSuspects(diffs);
        const { text, index } = auditBlock(suspects);
        expect(text).toContain('V1');
        expect(text).toContain('the story says 10200, the record says 9999');

        // The model answers "set", the story's number is the truth. Forced, so no re-diff.
        const { ops } = planAudit({ answers: [{ id: 'V1', verdict: 'set', at: '', target: '', evidence: 'the treasurer read out the balance' }] }, index);
        expect(ops).toEqual([{ op: 'set', id: 'R1', set: 10200, force: true, evidence: expect.any(String) }]);
        const after = applyOps(t, ops, 3);
        expect(after.diffs).toEqual([]);
        expect(t.rows.get('R1').qty).toBe(10200);

        // And a "keep" verdict leaves the fold's value standing, the story was misread.
        applyOps(t, [{ op: 'set', id: 'R1', set: 9000 }], 4);
        const keep = planAudit({ answers: [{ id: 'V1', verdict: 'keep', at: '', target: '', evidence: '' }] }, auditBlock(conservationSuspects([{ id: 'R1', name: 'won', qty: 10200, set: 9000, diff: 1200 }])).index);
        expect(keep.ops).toEqual([{ op: 'none', id: 'R1' }]);
        expect(t.rows.get('R1').qty).toBe(10200);
    });

    test('the player-click path and the model-call path share one write (opForVerdict)', () => {
        const stale = { kind: 'stale', id: 'R2', name: 'wolf pelt', place: 'carried', ago: 40 };
        const key = questionKey(stale);
        expect(key).toBe('stale:R2:');

        // A click and a call produce the same op for the same verdict.
        expect(opForVerdict(stale, 'gone', { evidence: 'clicked' }))
            .toEqual({ op: { op: 'close', id: 'R2', evidence: 'clicked' } });
        expect(opForVerdict(stale, 'move', { at: 'house', evidence: 'clicked' }))
            .toEqual({ op: { op: 'move', id: 'R2', at: 'house', evidence: 'clicked' } });
        // keep needs no evidence; gone does.
        expect(opForVerdict(stale, 'keep')).toEqual({ op: { op: 'none', id: 'R2' } });
        expect(opForVerdict(stale, 'gone', {})).toEqual({ error: 'no-evidence' });

        const idPair = { kind: 'identity', id: 'R4', name: 'bronze key', other: 'R5', otherName: 'key' };
        expect(questionKey(idPair)).toBe('identity:R4:R5');
        expect(opForVerdict(idPair, 'same', { evidence: 'clicked' }))
            .toEqual({ op: { op: 'same_as', id: 'R4', target: 'R5', evidence: 'clicked' } });

        const cons = { kind: 'conservation', id: 'R1', name: 'won', qty: 9999, set: 10200, diff: -201 };
        expect(opForVerdict(cons, 'set', { evidence: 'clicked' }))
            .toEqual({ op: { op: 'set', id: 'R1', set: 10200, force: true, evidence: 'clicked' } });
    });

    test('unposed findings survive a truncated run, a set diff past the cap is not lost', () => {
        const pending = {
            diffs: [
                { id: 'R1', name: 'won', qty: 9999, set: 10200, diff: -201 },
                { id: 'R2', name: 'hp', qty: 38, set: 30, diff: 8 },
            ],
            errors: [{ error: 'new-matches-held', op: { id: 'R3', name: 'knife' } }],
        };
        // The run posed only R1; R2's diff and the R3 refusal wait for the next run.
        const kept = unposedFindings(pending, ['R1']);
        expect(kept.diffs).toEqual([pending.diffs[1]]);
        expect(kept.errors).toEqual(pending.errors);
        // Posed findings are consumed.
        expect(unposedFindings(pending, ['R1', 'R2', 'R3']).diffs).toEqual([]);
    });

    test('the block carries chronicle evidence so the model answers from history', () => {
        const suspects = [
            { kind: 'stale', resolver: 'model', id: 'R2', name: 'ka-bar knife', place: 'carried', seen: 1, ago: 40 },
            { kind: 'identity', resolver: 'model', id: 'R7', name: 'sig p226', other: 'R53', otherName: 'sig p226 (15/15 loaded, 2 spare mags)' },
        ];
        const evidence = new Map([
            ['S1', ['Solomon exits the SUV, taking the knife, and approaches the store.']],
            ['I1', ['Solomon drew his Sig, flipped the safety off.']],
        ]);
        const { text } = auditBlock(suspects, evidence);
        expect(text).toContain('S1');
        expect(text).toContain('· Solomon exits the SUV, taking the knife');
        expect(text).toContain('I1');
        expect(text).toContain('· Solomon drew his Sig');
        // Without evidence the question still poses, silence is not evidence, the instruction says.
        expect(auditBlock(suspects).text).not.toContain('·');
    });

    test('name pollution: a row whose name is several things comma-joined is a split question', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'Nine-Tails Inn, common room', place: 'carried', qty: 1 },
        ], 1);
        const suspects = namePollutionSuspects(t.rows);
        // The 3+ comma-segment name is caught; the two-part compound and the clean name are not.
        expect(suspects).toHaveLength(1);
        expect(suspects[0]).toMatchObject({ kind: 'split', resolver: 'model', id: 'R1' });
        expect(isPollutedName('tactical bag thinkpad, audit usbs, maps')).toBe(true);
        expect(isPollutedName('Nine-Tails Inn, common room')).toBe(false);
        expect(isPollutedName('break room')).toBe(false);
    });

    test('identity excludes polluted rows, no nonsense "keycard vs the bag" questions', () => {
        const t = makeTable();
        applyOps(t, [
            { op: 'new', kind: 'item', name: 'keycard', place: 'carried', qty: 1 },
            { op: 'new', kind: 'item', name: 'tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo', place: 'carried', qty: 1 },
        ], 1);
        // "keycard" is a token-subset of the polluted name, but the pair must NOT be posed,
        // the keycard is inside the bag, not the same as it.
        const suspects = identitySuspects(t.rows, (a, b) => a.includes(b) || b.includes(a));
        expect(suspects).toEqual([]);
    });

    test('split verdict routes to the fold\'s split op with its parts', () => {
        const polluted = { kind: 'split', resolver: 'model', id: 'R1', name: 'tactical bag thinkpad, audit usbs, maps' };
        expect(opForVerdict(polluted, 'split', { parts: [{ name: 'tactical bag' }, { name: 'thinkpad' }, { name: 'audit usbs' }, { name: 'maps' }], evidence: 'the bag holds them' }))
            .toEqual({ op: { op: 'split', id: 'R1', parts: [{ name: 'tactical bag' }, { name: 'thinkpad' }, { name: 'audit usbs' }, { name: 'maps' }], evidence: 'the bag holds them' } });
        expect(opForVerdict(polluted, 'rename', { at: 'tactical bag', evidence: 'x' }))
            .toEqual({ op: { op: 'change', id: 'R1', name: 'tactical bag', evidence: 'x' } });
    });
});
