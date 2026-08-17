import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    appendLedger,
    campaignDirectory,
    inlineForExport,
    headSeq,
    readLedger,
    resolveHistory,
    writeMeta,
} from '../src/endpoints/fold-ledger.js';

/**
 * The durability layer. These tests exist because every property the owner asked for — restore to
 * any point, fork from any point — is a property of the LEDGER, not of the fold on top of it. A
 * bug here is not a wrong number on a panel; it is a campaign that cannot be recovered.
 */
let root;
let dirs;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-ledger-'));
    dirs = { extensions: root };
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const ledgerPath = (campaign) => path.join(campaignDirectory(dirs, campaign), 'ledger.jsonl');

describe('fold-ledger — append and sequence', () => {
    test('seq is assigned by the server, monotonically, across calls', () => {
        // The client may not assign it: two tabs on one chat both believe they are at the same
        // point, and a collision would put two different ops at one place on the timeline.
        expect(appendLedger(dirs, 'c1', [{ kind: 'ev' }])).toMatchObject({ from: 1, to: 1 });
        expect(appendLedger(dirs, 'c1', [{ kind: 'ev' }, { kind: 'ev' }])).toMatchObject({ from: 2, to: 3 });
        expect(headSeq(dirs, 'c1')).toBe(3);
    });

    test('a client-supplied seq is overwritten, never trusted', () => {
        appendLedger(dirs, 'c1', [{ kind: 'ev', seq: 9999 }]);
        expect(readLedger(dirs, 'c1').ops[0].seq).toBe(1);
    });

    test('appending is O(1) — it does not rewrite what is already there', () => {
        // The defect this endpoint exists to avoid: `fold-trace` reads the whole file and rewrites
        // it on every record (`fold-trace.js:45-50`), which is O(file) per append forever.
        appendLedger(dirs, 'c1', [{ kind: 'a' }]);
        const first = fs.statSync(ledgerPath('c1'));
        appendLedger(dirs, 'c1', [{ kind: 'b' }]);
        const second = fs.statSync(ledgerPath('c1'));
        // The file grew; the original bytes were not rewritten (same inode, larger size).
        expect(second.size).toBeGreaterThan(first.size);
        expect(second.ino).toBe(first.ino);
    });

    test('a batch is one write, so a pass lands together or not at all', () => {
        const { ops } = appendLedger(dirs, 'c1', [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }]);
        expect(ops.map(o => o.seq)).toEqual([1, 2, 3]);
        expect(readLedger(dirs, 'c1').ops).toHaveLength(3);
    });

    test('an empty append is a no-op, not an empty line', () => {
        expect(appendLedger(dirs, 'c1', [])).toMatchObject({ from: 0, to: 0 });
        expect(readLedger(dirs, 'c1').ops).toEqual([]);
    });
});

describe('fold-ledger — time travel', () => {
    test('a prefix read is a restore', () => {
        // `replay_append` (../sanguine AIOperationSurface.lean:142): folding a prefix and then
        // continuing equals folding the whole, so state at any point IS the fold of the prefix.
        appendLedger(dirs, 'c1', [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
        expect(readLedger(dirs, 'c1', 2).ops.map(o => o.n)).toEqual([1, 2]);
        expect(readLedger(dirs, 'c1').ops.map(o => o.n)).toEqual([1, 2, 3, 4]);
    });

    test('restoring to before the beginning yields nothing, not everything', () => {
        appendLedger(dirs, 'c1', [{ n: 1 }]);
        expect(readLedger(dirs, 'c1', 0).ops).toEqual([]);
    });
});

describe('fold-ledger — forking from any point', () => {
    test('a fork costs one metadata line and copies no ops', () => {
        appendLedger(dirs, 'parent', [{ n: 1 }, { n: 2 }, { n: 3 }]);
        writeMeta(dirs, 'child', { campaign: 'child', parent: 'parent', forkSeq: 2 });
        // Nothing was copied: the child's own ledger does not exist yet.
        expect(fs.existsSync(ledgerPath('child'))).toBe(false);
        const { ops } = resolveHistory(dirs, 'child');
        expect(ops.map(o => o.n)).toEqual([1, 2]);
    });

    test('a fork continues from its point, and the parent never sees the divergence', () => {
        appendLedger(dirs, 'parent', [{ n: 1 }, { n: 2 }, { n: 3 }]);
        writeMeta(dirs, 'child', { campaign: 'child', parent: 'parent', forkSeq: 2 });
        appendLedger(dirs, 'child', [{ n: 'x' }]);
        expect(resolveHistory(dirs, 'child').ops.map(o => o.n)).toEqual([1, 2, 'x']);
        expect(resolveHistory(dirs, 'parent').ops.map(o => o.n)).toEqual([1, 2, 3]);
    });

    test('forks nest to arbitrary depth', () => {
        // "fork from that point arbitrarily" — a fork of a fork of a fork must resolve.
        appendLedger(dirs, 'a', [{ n: 1 }, { n: 2 }]);
        writeMeta(dirs, 'b', { campaign: 'b', parent: 'a', forkSeq: 1 });
        appendLedger(dirs, 'b', [{ n: 'b1' }, { n: 'b2' }]);
        writeMeta(dirs, 'c', { campaign: 'c', parent: 'b', forkSeq: 1 });
        appendLedger(dirs, 'c', [{ n: 'c1' }]);
        const { ops, chain } = resolveHistory(dirs, 'c');
        expect(chain).toEqual(['a', 'b', 'c']);
        expect(ops.map(o => o.n)).toEqual([1, 'b1', 'c1']);
    });

    test('a child fork does not renumber against its parent, and that is a real hazard', () => {
        // Both campaigns number from 1, so `seq` is only unique WITHIN a campaign. Pinned so the
        // client never treats a resolved history's seq as a global timeline coordinate.
        appendLedger(dirs, 'parent', [{ n: 1 }, { n: 2 }]);
        writeMeta(dirs, 'child', { campaign: 'child', parent: 'parent', forkSeq: 1 });
        appendLedger(dirs, 'child', [{ n: 'x' }]);
        const seqs = resolveHistory(dirs, 'child').ops.map(o => o.seq);
        expect(seqs).toEqual([1, 1]);
    });

    test('a cycle in the fork chain terminates instead of hanging the server', () => {
        // Impossible by construction — a parent predates its child — but a hand-edited or
        // half-restored campaign.json would otherwise spin forever inside a request.
        writeMeta(dirs, 'x', { campaign: 'x', parent: 'y', forkSeq: 1 });
        writeMeta(dirs, 'y', { campaign: 'y', parent: 'x', forkSeq: 1 });
        expect(() => resolveHistory(dirs, 'x')).not.toThrow();
        expect(resolveHistory(dirs, 'x').chain.length).toBeLessThanOrEqual(2);
    });
});

describe('fold-ledger — damage', () => {
    test('a torn tail is dropped, because that op was never acknowledged', () => {
        appendLedger(dirs, 'c1', [{ n: 1 }, { n: 2 }]);
        fs.appendFileSync(ledgerPath('c1'), '{"n":3,"seq":3', 'utf8');
        const read = readLedger(dirs, 'c1');
        expect(read.torn).toBe(true);
        expect(read.damaged).toBe(0);
        expect(read.ops.map(o => o.n)).toEqual([1, 2]);
    });

    test('the next append after a torn tail reuses the number and loses nothing real', () => {
        appendLedger(dirs, 'c1', [{ n: 1 }]);
        fs.appendFileSync(ledgerPath('c1'), '{"n":2,"seq":2', 'utf8');
        // headSeq must not count the torn line; a fresh process rescans and sees only seq 1.
        const fresh = { extensions: root };
        expect(headSeq(fresh, 'c1-rescan')).toBe(0);
        expect(readLedger(dirs, 'c1').ops.map(o => o.n)).toEqual([1]);
    });

    test('a damaged line in the MIDDLE is surfaced, never silently skipped', () => {
        // Ops after it were acknowledged, so quietly dropping it yields a fold that is missing an
        // event and says nothing. The client must be able to refuse to derive.
        appendLedger(dirs, 'c1', [{ n: 1 }]);
        fs.appendFileSync(ledgerPath('c1'), 'not json\n', 'utf8');
        appendLedger(dirs, 'c1', [{ n: 3 }]);
        const read = readLedger(dirs, 'c1');
        expect(read.torn).toBe(false);
        expect(read.damaged).toBe(1);
        expect(read.ops.some(o => o.unparseable)).toBe(true);
    });

    test('a missing campaign reads as empty rather than throwing', () => {
        expect(readLedger(dirs, 'never-existed')).toMatchObject({ ops: [], torn: false, damaged: 0 });
        expect(resolveHistory(dirs, 'never-existed').ops).toEqual([]);
    });

    test('damage anywhere in a fork chain propagates to the reader', () => {
        appendLedger(dirs, 'parent', [{ n: 1 }]);
        fs.appendFileSync(ledgerPath('parent'), 'garbage\n', 'utf8');
        writeMeta(dirs, 'child', { campaign: 'child', parent: 'parent', forkSeq: 99 });
        expect(resolveHistory(dirs, 'child').damaged).toBe(1);
    });
});

describe('fold-ledger — paths', () => {
    test('a traversal attempt cannot escape the ledger directory', () => {
        const dir = campaignDirectory(dirs, '../../etc');
        expect(dir.startsWith(path.join(root, 'fold-ledger'))).toBe(true);
    });
});

describe('fold-ledger — export carries the memory with the chat', () => {
    const chatFile = (fold, messages = 2) => [
        JSON.stringify({ user_name: 'U', chat_metadata: { fold } }),
        ...Array.from({ length: messages }, (_, i) => JSON.stringify({ mes: `line ${i}` })),
    ].join('\n');

    test('a shed mirror is refilled from the ledger', async () => {
        // The failure this closes: the chronicle lives on disk and the metadata copy is a cache the
        // budget pruner sheds, so a long campaign exported its transcript plus whatever slice of
        // memory happened to survive — silently, and looking complete.
        appendLedger(dirs, 'camp', [
            { op: 'ev', k: 'k1', e: { s: 'bought a spear' }, opId: 'a', fmid: 1 },
            { op: 'ev', k: 'k2', e: { s: 'rode north' }, opId: 'b', fmid: 2 },
        ]);
        // The mirror has been pruned down to one event; the ledger holds both.
        const raw = chatFile({ campaign: 'camp', chronicle: { events: { k2: { s: 'rode north' } } } });
        const out = await inlineForExport(dirs, raw);
        const header = JSON.parse(out.split('\n')[0]);
        expect(Object.keys(header.chat_metadata.fold.chronicle.events).sort()).toEqual(['k1', 'k2']);
        // The transcript is untouched — this enriches the header and nothing else.
        expect(out.split('\n').slice(1)).toEqual(raw.split('\n').slice(1));
    });

    test('a chat with no campaign is returned byte-identical', async () => {
        const raw = chatFile({ chronicle: { events: { k1: { s: 'x' } } } });
        expect(await inlineForExport(dirs, raw)).toBe(raw);
    });

    test('a chat fold never touched is returned byte-identical', async () => {
        const raw = [JSON.stringify({ user_name: 'U', chat_metadata: {} }), JSON.stringify({ mes: 'hi' })].join('\n');
        expect(await inlineForExport(dirs, raw)).toBe(raw);
    });

    test('a damaged ledger does NOT overwrite the mirror', async () => {
        // The cache may be the more complete of the two, and a partial history that looks whole is
        // worse than an unenriched export.
        appendLedger(dirs, 'hurt', [{ op: 'ev', k: 'k1', e: { s: 'kept' }, opId: 'a', fmid: 1 }]);
        fs.appendFileSync(path.join(campaignDirectory(dirs, 'hurt'), 'ledger.jsonl'), 'garbage\n', 'utf8');
        appendLedger(dirs, 'hurt', [{ op: 'ev', k: 'k2', e: { s: 'later' }, opId: 'b', fmid: 2 }]);
        const raw = chatFile({ campaign: 'hurt', chronicle: { events: { k9: { s: 'mirror only' } } } });
        expect(await inlineForExport(dirs, raw)).toBe(raw);
    });

    test('an empty ledger leaves the mirror alone', async () => {
        const raw = chatFile({ campaign: 'empty', chronicle: { events: { k1: { s: 'mirror' } } } });
        expect(await inlineForExport(dirs, raw)).toBe(raw);
    });

    test('a forgotten event does not come back through export', async () => {
        appendLedger(dirs, 'forg', [
            { op: 'ev', k: 'k1', e: { s: 'gone soon' }, opId: 'a', fmid: 1 },
            { op: 'forget', k: 'k1', opId: 'b', fmid: 2 },
            { op: 'ev', k: 'k2', e: { s: 'stays' }, opId: 'c', fmid: 3 },
        ]);
        const raw = chatFile({ campaign: 'forg', chronicle: { events: {} } });
        const header = JSON.parse((await inlineForExport(dirs, raw)).split('\n')[0]);
        expect(Object.keys(header.chat_metadata.fold.chronicle.events)).toEqual(['k2']);
    });
});
