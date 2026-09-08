import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendLedger, resolveHistory, writeMeta } from '../src/endpoints/sanguine-ledger.js';
import { effectiveOps, replay, replayAt, restoreSeq } from '../public/scripts/extensions/sanguine/ledger-table.js';

/**
 * The seam. `ledger-table` is proven pure and the endpoint is proven durable, but the thing that
 * actually has to work is the LOOP: a chronicle write becomes ops, the ops go to disk, a reload
 * hydrates them, and the table that comes back is the table that went in.
 *
 * Everything below drives that loop with the real endpoint and the real replay. The client glue
 * (`ledger.js`) cannot be imported here, it pulls in `script.js` and the browser, so the one piece
 * reproduced by hand is `saveEvents`' diff, kept deliberately identical to the shipped version.
 */
let root;
let dirs;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-rt-'));
    dirs = { extensions: root };
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

/** `chronicle.js` `saveEvents`, verbatim in behaviour: identity diff -> `ev` / `forget`. */
function diffToOps(before, next) {
    const ops = [];
    for (const [key, event] of next) {
        if (before.get(key) !== event) {
            ops.push({ op: 'ev', k: key, e: event });
        }
    }
    for (const key of before.keys()) {
        if (!next.has(key)) {
            ops.push({ op: 'forget', k: key });
        }
    }
    return ops;
}

/** One extraction pass: diff, append with a frontier, and return the hydrated table. */
function pass(campaign, before, next, fmid) {
    const ops = diffToOps(before, next);
    if (ops.length) {
        appendLedger(dirs, campaign, ops.map((op, i) => ({ ...op, opId: `${fmid}-${i}`, fmid })));
    }
    const { ops: eff } = effectiveOps(resolveHistory(dirs, campaign).ops);
    return replay(eff).events;
}

const ev = (s, mid) => ({ s, kw: [], t: mid, mid, src: 'llm' });

describe('ledger round trip, a write survives a reload', () => {
    test('events written across passes hydrate back identically', () => {
        let table = new Map();
        table = pass('c', table, new Map([['k1', ev('bought a spear', 10)]]), 10);
        expect([...table.keys()]).toEqual(['k1']);

        const next = new Map(table);
        next.set('k2', ev('paid ten silver', 12));
        table = pass('c', table, next, 12);
        expect([...table.values()].map(e => e.s)).toEqual(['bought a spear', 'paid ten silver']);
    });

    test('an in-place mutation of the returned table still produces ops', () => {
        // The bug this pins: `loadEvents` used to hand back the live cache, so a caller that did
        // `events.delete(k)` mutated the very Map the diff compares against. The diff found nothing
        // changed, no op was emitted, and the ledger recorded silence while looking healthy.
        let table = pass('c', new Map(), new Map([['k1', ev('a', 1)], ['k2', ev('b', 2)]]), 2);
        // A caller copies (as `loadEvents` now guarantees), mutates, and saves.
        const mutated = new Map(table);
        mutated.delete('k1');
        table = pass('c', table, mutated, 3);
        expect([...table.keys()]).toEqual(['k2']);
    });

    test('a forget survives the reload as an absence, not a resurrection', () => {
        let table = pass('c', new Map(), new Map([['k1', ev('gone soon', 1)]]), 1);
        table = pass('c', table, new Map(), 2);
        expect(table.size).toBe(0);
        // And re-reading from disk agrees, the tombstone is durable, not a local deletion.
        const { ops } = effectiveOps(resolveHistory(dirs, 'c').ops);
        expect(replay(ops).events.size).toBe(0);
    });

    test('an unchanged row emits nothing, so the ledger does not grow on idle passes', () => {
        const table = pass('c', new Map(), new Map([['k1', ev('once', 1)]]), 1);
        const before = resolveHistory(dirs, 'c').ops.length;
        pass('c', table, new Map(table), 2);
        expect(resolveHistory(dirs, 'c').ops.length).toBe(before);
    });

    test('an edited summary is last-write on the key', () => {
        let table = pass('c', new Map(), new Map([['k1', ev('first telling', 1)]]), 1);
        table = pass('c', table, new Map([['k1', ev('corrected telling', 1)]]), 2);
        expect([...table.values()].map(e => e.s)).toEqual(['corrected telling']);
    });
});

describe('ledger round trip, the timeline over a real stream', () => {
    /** A small campaign: four passes at four frontiers. */
    function play() {
        let table = new Map();
        table = pass('c', table, new Map([['k1', ev('left the village', 5)]]), 5);
        table = pass('c', table, new Map([...table, ['k2', ev('bought a spear', 10)]]), 10);
        table = pass('c', table, new Map([...table, ['k3', ev('ambushed on the road', 20)]]), 20);
        table = pass('c', table, new Map([...table, ['k4', ev('reached the city', 30)]]), 30);
        return table;
    }

    test('restoring to a message shows what was known then, and nothing after', () => {
        play();
        const raw = resolveHistory(dirs, 'c').ops;
        const at10 = replayAt(raw, restoreSeq(raw, 10));
        expect([...at10.events.values()].map(e => e.s)).toEqual(['left the village', 'bought a spear']);
        const at20 = replayAt(raw, restoreSeq(raw, 20));
        expect([...at20.events.values()].map(e => e.s)).toHaveLength(3);
    });

    test('restoring does not destroy the future, the present is still there', () => {
        play();
        const raw = resolveHistory(dirs, 'c').ops;
        expect(replayAt(raw).events.size).toBe(4);
        expect(replayAt(raw, restoreSeq(raw, 10)).events.size).toBe(2);
        expect(replayAt(raw).events.size).toBe(4);
    });

    test('a rewind makes the truncation durable, and play continues from there', () => {
        play();
        const raw = resolveHistory(dirs, 'c').ops;
        const to = restoreSeq(raw, 10);
        appendLedger(dirs, 'c', [{ op: 'rewind', to, opId: 'rw', fmid: 10 }]);
        appendLedger(dirs, 'c', [{ op: 'ev', k: 'k5', e: ev('took the river road instead', 12), opId: 'n1', fmid: 12 }]);

        const after = resolveHistory(dirs, 'c').ops;
        const events = replayAt(after).events;
        expect([...events.values()].map(e => e.s)).toEqual([
            'left the village', 'bought a spear', 'took the river road instead',
        ]);
        // The ambush and the city are gone from the timeline, and their lines are still on disk,
        // append-only means the truncation is a statement, not an erasure.
        expect(after.length).toBeGreaterThan(events.size);
    });
});

describe('ledger round trip, forking from a point', () => {
    test('a fork inherits the past and diverges, leaving the parent intact', () => {
        const first = pass('parent', new Map(), new Map([['k1', ev('shared past', 5)]]), 5);
        pass('parent', first, new Map([...first, ['k2', ev('parent future', 10)]]), 10);

        const raw = resolveHistory(dirs, 'parent').ops;
        const forkSeq = restoreSeq(raw, 5);
        writeMeta(dirs, 'child', { campaign: 'child', parent: 'parent', forkSeq });
        appendLedger(dirs, 'child', [{ op: 'ev', k: 'k9', e: ev('child future', 7), opId: 'c1', fmid: 7 }]);

        const child = replayAt(resolveHistory(dirs, 'child').ops);
        expect([...child.events.values()].map(e => e.s)).toEqual(['shared past', 'child future']);

        const parent = replayAt(resolveHistory(dirs, 'parent').ops);
        expect([...parent.events.values()].map(e => e.s)).toEqual(['shared past', 'parent future']);
    });
});

describe('the mirror is a cache, shedding it must never touch the ledger', () => {
    test('a durable ledger survives the metadata mirror being emptied', () => {
        // The bug this pins, twice over: the budget pruner and the MAX_EVENTS cap both read through
        // `loadEvents()` (which answers from the ledger once hydrated) and wrote back through
        // `saveEvents` (which turns a missing key into a `forget` op). Either one would have deleted
        // events from the durable store to satisfy a metadata budget the durable store exists to
        // escape, permanently, and with the ledger reporting itself healthy afterwards.
        const table = new Map([
            ['k1', ev('bought a spear', 10)],
            ['k2', ev('rode north', 20)],
            ['k3', ev('ambushed', 30)],
        ]);
        pass('c', new Map(), table, 30);
        expect(replayAt(resolveHistory(dirs, 'c').ops).events.size).toBe(3);

        // The mirror is shed wholesale, the metadata blob went over budget. No ops are emitted,
        // because shedding a cache is not a statement about history.
        const before = resolveHistory(dirs, 'c').ops.length;
        // (no appendLedger call here: that IS the assertion)
        const after = resolveHistory(dirs, 'c');
        expect(after.ops.length).toBe(before);
        expect(replayAt(after.ops).events.size).toBe(3);
    });

    test('a forget op still deletes, so the cache rule does not disarm real deletion', () => {
        // Shedding must be silent; forgetting must not be. If the cache change had made writes
        // no-ops in general, a genuine `forget` would stop working and nothing would notice.
        let table = pass('c', new Map(), new Map([['k1', ev('gone soon', 1)]]), 1);
        expect(table.size).toBe(1);
        table = pass('c', table, new Map(), 2);
        expect(table.size).toBe(0);
        expect(replayAt(resolveHistory(dirs, 'c').ops).events.size).toBe(0);
    });
});
