import { describe, expect, test } from '@jest/globals';

import {
    checkpointValid,
    effectiveOps,
    replay,
    replayAt,
    restoreSeq,
} from '../public/scripts/extensions/fold/ledger-table.js';

/** An op envelope as the server writes one. */
let n = 0;
const op = (seq, body, fmid = seq) => ({ seq, v: 1, opId: `o${++n}`, chat: 'c', at: seq, fmid, ...body });
const ev = (seq, k, s, fmid) => op(seq, { op: 'ev', k, e: { s, kw: [], t: seq, mid: fmid ?? seq } }, fmid);
const summaries = (tables) => [...tables.events.values()].map(e => e.s);

describe('ledger-table — the effective sequence', () => {
    test('ops are ordered by seq, never by arrival', () => {
        // A retried append can land out of order; the timeline coordinate is the server's number.
        const { ops } = effectiveOps([ev(3, 'c', 'third'), ev(1, 'a', 'first'), ev(2, 'b', 'second')]);
        expect(ops.map(o => o.seq)).toEqual([1, 2, 3]);
    });

    test('a retried op is deduped on opId', () => {
        const once = ev(1, 'a', 'x');
        const { ops, duplicates } = effectiveOps([once, { ...once, seq: 2 }]);
        expect(ops).toHaveLength(1);
        expect(duplicates).toBe(1);
    });

    test('an unknown op is skipped, not rejected', () => {
        // Old builds must stay able to read new ledgers, or every new op is a breaking change.
        const { ops, skipped } = effectiveOps([ev(1, 'a', 'x'), op(2, { op: 'put', tbl: 'cast' })]);
        expect(ops).toHaveLength(1);
        expect(skipped).toBe(1);
    });

    test('a rewind truncates and does not enter the sequence itself', () => {
        const { ops, rewinds } = effectiveOps([
            ev(1, 'a', 'kept'), ev(2, 'b', 'kept'), ev(3, 'c', 'cut'),
            op(4, { op: 'rewind', to: 2 }),
        ]);
        expect(ops.map(o => o.k)).toEqual(['a', 'b']);
        expect(rewinds).toBe(1);
        expect(ops.some(o => o.op === 'rewind')).toBe(false);
    });

    test('ops appended after a rewind survive it', () => {
        const { ops } = effectiveOps([
            ev(1, 'a', 'x'), ev(2, 'b', 'cut'),
            op(3, { op: 'rewind', to: 1 }),
            ev(4, 'c', 'after'),
        ]);
        expect(ops.map(o => o.k)).toEqual(['a', 'c']);
    });

    test('rewinds nest and cross without special cases', () => {
        // Truncation needs no inverses, so each rewind simply re-filters whatever list it finds.
        const { ops } = effectiveOps([
            ev(1, 'a', 'x'), ev(2, 'b', 'x'), ev(3, 'c', 'x'),
            op(4, { op: 'rewind', to: 2 }),
            ev(5, 'd', 'x'),
            op(6, { op: 'rewind', to: 1 }),
            ev(7, 'e', 'x'),
        ]);
        expect(ops.map(o => o.k)).toEqual(['a', 'e']);
    });

    test('a repeated rewind is idempotent, which is what makes a retry safe', () => {
        const twice = op(4, { op: 'rewind', to: 1 });
        const { ops } = effectiveOps([ev(1, 'a', 'x'), ev(2, 'b', 'x'), twice, { ...twice, seq: 5 }]);
        expect(ops.map(o => o.k)).toEqual(['a']);
    });

    test('a rewind with no target is skipped rather than truncating everything', () => {
        const { ops, skipped } = effectiveOps([ev(1, 'a', 'x'), op(2, { op: 'rewind' })]);
        expect(ops).toHaveLength(1);
        expect(skipped).toBe(1);
    });

    test('a line with no seq cannot be placed on the timeline and is dropped', () => {
        const { ops } = effectiveOps([{ op: 'ev', k: 'a', e: {} }, ev(1, 'b', 'x')]);
        expect(ops.map(o => o.k)).toEqual(['b']);
    });
});

describe('ledger-table — the fold', () => {
    test('later seq wins on the same key', () => {
        const { ops } = effectiveOps([ev(1, 'a', 'old'), ev(2, 'a', 'new')]);
        expect(summaries(replay(ops))).toEqual(['new']);
    });

    test('amend rewrites a summary in place', () => {
        const { ops } = effectiveOps([ev(1, 'a', 'before'), op(2, { op: 'amend', k: 'a', s: 'after' })]);
        expect(summaries(replay(ops))).toEqual(['after']);
    });

    test('amending a forgotten row does NOT resurrect it', () => {
        // Otherwise `forget` would be conditional on what happened after it.
        const { ops } = effectiveOps([
            ev(1, 'a', 'x'),
            op(2, { op: 'forget', k: 'a' }),
            op(3, { op: 'amend', k: 'a', s: 'back?' }),
        ]);
        expect(replay(ops).events.size).toBe(0);
    });

    test('hits accumulate and commute', () => {
        const forward = effectiveOps([op(1, { op: 'hit', keys: ['a', 'b'] }), op(2, { op: 'hit', keys: ['a'] })]);
        const tables = replay(forward.ops);
        expect(tables.hits.get('a')).toBe(2);
        expect(tables.hits.get('b')).toBe(1);
    });

    test('a checkpoint plus its suffix equals a full replay', () => {
        // `replay_append` / List.foldl_append — no algebraic side condition. This is the property
        // that lets a year-long campaign hydrate without folding every op.
        const all = [ev(1, 'a', 'x'), ev(2, 'b', 'y'), ev(3, 'a', 'z'), op(4, { op: 'hit', keys: ['b'] })];
        const { ops } = effectiveOps(all);
        const full = replay(ops);
        const base = replay(ops.slice(0, 2));
        const resumed = replay(ops.slice(2), base);
        expect([...resumed.events.entries()]).toEqual([...full.events.entries()]);
        expect([...resumed.hits.entries()]).toEqual([...full.hits.entries()]);
        expect(resumed.at).toBe(full.at);
    });
});

describe('ledger-table — time travel', () => {
    const story = [
        ev(1, 'a', 'bought a spear', 10),
        ev(2, 'b', 'paid ten silver', 10),
        ev(3, 'c', 'rode north', 20),
        ev(4, 'd', 'ambushed', 30),
    ];

    test('replayAt is the present when unbounded', () => {
        expect(summaries(replayAt(story))).toHaveLength(4);
    });

    test('replayAt bounds the fold to a prefix', () => {
        expect(summaries(replayAt(story, 2))).toEqual(['bought a spear', 'paid ten silver']);
        expect(summaries(replayAt(story, 0))).toEqual([]);
    });

    test('restoreSeq maps a MESSAGE index to a timeline point', () => {
        // The player asks in messages; the ledger is indexed in seq. `fmid` is the only join.
        expect(restoreSeq(story, 10)).toBe(2);
        expect(restoreSeq(story, 20)).toBe(3);
        expect(restoreSeq(story, 30)).toBe(4);
    });

    test('several ops at one frontier all restore, largest seq winning', () => {
        // Restoring to M includes everything that happened while the conversation stood at M.
        expect(summaries(replayAt(story, restoreSeq(story, 10)))).toEqual(['bought a spear', 'paid ten silver']);
    });

    test('a message before anything happened restores to nothing', () => {
        expect(restoreSeq(story, 0)).toBe(0);
        expect(summaries(replayAt(story, restoreSeq(story, 0)))).toEqual([]);
    });

    test('a frontier with no ops falls back to the last one that had them', () => {
        // A pass that produced nothing changed nothing, so the state at 25 is the state at 20.
        expect(restoreSeq(story, 25)).toBe(3);
    });

    test('restoreSeq reads the EFFECTIVE sequence, so a rewound frontier resolves to the live one', () => {
        // The conversation stood at message 10 twice: once before the rewind, once after. The
        // player is looking at the second one.
        const withRewind = [
            ev(1, 'a', 'first try', 10),
            ev(2, 'b', 'wrong turn', 20),
            op(3, { op: 'rewind', to: 1 }, 10),
            ev(4, 'c', 'second try', 20),
        ];
        expect(restoreSeq(withRewind, 20)).toBe(4);
        expect(summaries(replayAt(withRewind, restoreSeq(withRewind, 20)))).toEqual(['first try', 'second try']);
    });

    test('an op with no fmid cannot answer a message query and is ignored by restoreSeq', () => {
        const noFrontier = [ev(1, 'a', 'x', 5), { ...op(2, { op: 'ev', k: 'b', e: { s: 'y' } }), fmid: undefined }];
        expect(restoreSeq(noFrontier, 99)).toBe(1);
    });
});

describe('ledger-table — checkpoint validity under rewind', () => {
    test('a checkpoint survives a rewind that lands above it', () => {
        const raw = [ev(1, 'a', 'x'), ev(2, 'b', 'x'), ev(3, 'c', 'x'), op(4, { op: 'rewind', to: 2 })];
        expect(checkpointValid(raw, 2)).toBe(true);
    });

    test('a checkpoint is VOID when a later rewind cuts below it', () => {
        // The prefix it summarises is no longer the effective prefix.
        const raw = [ev(1, 'a', 'x'), ev(2, 'b', 'x'), ev(3, 'c', 'x'), op(4, { op: 'rewind', to: 1 })];
        expect(checkpointValid(raw, 3)).toBe(false);
    });

    test('a rewind BEFORE the checkpoint does not void it', () => {
        // It was already accounted for when the checkpoint was folded.
        const raw = [ev(1, 'a', 'x'), op(2, { op: 'rewind', to: 1 }), ev(3, 'b', 'x')];
        expect(checkpointValid(raw, 3)).toBe(true);
    });

    test('no checkpoint is not a valid checkpoint', () => {
        expect(checkpointValid([], 0)).toBe(false);
        expect(checkpointValid([], NaN)).toBe(false);
    });
});
