import { beforeEach, describe, expect, jest, test } from '@jest/globals';

/*
 * sanguine-repairs: the durable half of the redesigned reconcile pass.
 *
 * Why this drives the REAL store.
 *
 * Three of the properties under test are properties OF `store.js`, not of `repairs.js`:
 *
 *   · the write counter (`writeMark`) that makes "is this snapshot still honest" answerable;
 *   · the budget loop, which runs pruners cheapest-first and stops the moment the blob fits;
 *   · `replaceFold`, which is what a revert actually performs.
 *
 * A hand-written store double would let all three drift while this file went on passing, it would
 * be testing the double. So `chat_metadata` is a plain object behind a mocked `script.js` and
 * everything from `store.js` down is real, including `observe.js` and `log.js`. What IS mocked is the
 * write layer under `repairs.js` (`edits`, `entities`, `clocks`), because those reach the chronicle,
 * the flow table and the place table, and because a fake record that actually holds quantities proves
 * more than a spy: a wrong inverse shows up as a wrong record rather than as a wrong call.
 *
 * Nothing here calls `propose()` or `run()`. Those spend a model call.
 */

const SEP = '\u0000';
const askKeyOf = (kind, key) => `${kind}${SEP}${key}`;

/** The fake record the `edits` mock writes to. */
const inv = new Map();
const cast = new Map();
const threads = new Map();
const calls = [];

/** The chat's metadata, which the real `store.js` reads and writes through. */
const metadata = {};

jest.unstable_mockModule('../public/script.js', () => ({
    chat_metadata: metadata,
    saveMetadata: async () => {},
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    saveMetadataDebounced: () => {},
}));
jest.unstable_mockModule('../public/scripts/extensions/sanguine/migrate.js', () => ({
    migrate: () => ({ from: 2, to: 2, changed: false, counts: {} }),
}));

const itemKey = (name, place = 'carried') => `${place}${SEP}${name}`;

jest.unstable_mockModule('../public/scripts/extensions/sanguine/edits.js', () => ({
    removeItem: (key) => {
        calls.push(`removeItem ${key}`);
        return inv.delete(key);
    },
    setItemQty: (key, qty) => {
        calls.push(`setItemQty ${key} ${qty}`);
        if (!inv.has(key)) return false;
        inv.set(key, qty);
        return true;
    },
    renameItem: (key, to) => {
        calls.push(`renameItem ${key} -> ${to}`);
        if (!inv.has(key) || !to) return false;
        const held = inv.get(key);
        const place = key.split(SEP)[0];
        inv.delete(key);
        const landed = itemKey(String(to).toLowerCase(), place);
        inv.set(landed, (inv.get(landed) ?? 0) + held);
        return true;
    },
    moveItemTo: (key, place) => {
        calls.push(`moveItemTo ${key} -> ${place}`);
        if (!inv.has(key) || !place) return false;
        const held = inv.get(key);
        inv.delete(key);
        // `normalizePlace` strips a leading article before it keys, so "the van" and "van" are one
        // place. Mirrored here rather than glossed over: `applyRepair` computes the landed key with
        // the real `normalizePlace`, and a mock that keyed differently would make the undo test pass
        // against a record the real writers never produce.
        inv.set(itemKey(key.split(SEP).pop(), String(place).toLowerCase().replace(/^(?:the|my|in|at|on)\s+/, '')), held);
        return true;
    },
    splitItem: (key, parts) => {
        calls.push(`splitItem ${key}`);
        if (!inv.has(key)) return [];
        inv.delete(key);
        for (const part of parts) inv.set(itemKey(part.name), part.qty);
        return parts.map(part => itemKey(part.name));
    },
    clearMark: (key) => {
        calls.push(`clearMark ${key}`);
        return true;
    },
    closeThread: (name) => {
        calls.push(`closeThread ${name}`);
        return true;
    },
    editCast: (key, fields) => {
        calls.push(`editCast ${key} ${JSON.stringify(fields)}`);
        if (!cast.has(key)) return false;
        cast.set(key, { ...cast.get(key), ...fields });
        return true;
    },
}));

jest.unstable_mockModule('../public/scripts/extensions/sanguine/entities.js', () => ({
    load: () => cast,
    turn: () => 7,
    merge: (a, b) => {
        calls.push(`entities.merge ${a} -> ${b}`);
        if (!cast.has(a) || !cast.has(b)) return null;
        cast.delete(a);
        return { key: b, dropped: a };
    },
}));

jest.unstable_mockModule('../public/scripts/extensions/sanguine/clocks.js', () => ({
    load: () => threads,
    merge: (a, b) => {
        calls.push(`clocks.merge ${a} -> ${b}`);
        threads.delete(a);
        return { key: b };
    },
}));

const repairs = await import('../public/scripts/extensions/sanguine/repairs.js');
const observe = await import('../public/scripts/extensions/sanguine/observe.js');
const store = await import('../public/scripts/extensions/sanguine/store.js');
const { askKey, MAX_LEDGER_PASSES } = await import('../public/scripts/extensions/sanguine/repair-table.js');
const { AMOUNT, GONE, MERGE, MOVE, RENAME, SPLIT } = await import('../public/scripts/extensions/sanguine/reconcile-table.js');

const SANGUINE = 'sanguine';

/** One repair, in the shape `planReconcile` produces. */
const repair = (op, kind, key, extra = {}) => ({
    op, kind, key, name: key.split(SEP).pop(), evidence: 'the story shows it', ...extra,
});

const span = { start: 1, end: 40, total: 88 };

beforeEach(() => {
    for (const key of Object.keys(metadata)) delete metadata[key];
    calls.length = 0;
    inv.clear();
    inv.set(itemKey('ammunition'), 29);
    inv.set(itemKey('gold'), 2944);
    inv.set(itemKey('scrap'), 4);
    cast.clear();
    cast.set('person ada wong', { name: 'Ada Wong', place: 'the sewers' });
    cast.set('person infected man', { name: 'infected man', place: 'the lobby' });
    threads.clear();
    threads.set('residency at rpd', { name: 'Residency at RPD' });
    repairs.clear();
});

/** Apply an auto-lane repair the way `reconcile.apply` does, and return its ledger row. */
function land(entry) {
    const done = repairs.applyRepair(entry);
    return done.changed ? repairs.ledgerRow(entry, done) : null;
}

describe('a pass is recorded, and the ask lane is durable state rather than a popup', () => {
    test('the asks persist under the sanguine blob, keyed by kind and key', () => {
        repairs.record({
            applied: [],
            asked: [repair(GONE, 'cast', 'person infected man'), repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944 })],
            covered: span,
        });
        // The path the design names, so the surface and the pruner address the same thing.
        expect(Object.keys(metadata[SANGUINE].state['repair-asks']).sort())
            .toEqual([askKeyOf('cast', 'person infected man'), askKeyOf('item', itemKey('gold'))].sort());
        expect(repairs.asks()).toHaveLength(2);
    });

    test('an ask carries the merge TARGET KEY, not only the name the card reads', () => {
        // `withName` is display. `entities.merge` and `clocks.merge` take keys, an ask stored
        // without `with` is a question that can only ever be dismissed.
        repairs.record({
            applied: [],
            asked: [repair(MERGE, 'cast', 'person ada wong', { with: 'person infected man', withName: 'infected man' })],
            covered: span,
        });
        expect(repairs.asks()[0].with).toBe('person infected man');
        expect(repairs.asks()[0].withName).toBe('infected man');
    });

    test('asks come back newest pass first, and carry the turn they were raised on', () => {
        repairs.record({ applied: [], asked: [repair(GONE, 'cast', 'person infected man')], covered: span });
        repairs.record({ applied: [], asked: [repair(GONE, 'item', itemKey('scrap'))], covered: span });
        expect(repairs.asks().map(ask => ask.kind)).toEqual(['item', 'cast']);
        expect(repairs.asks()[0].pass).toBe(2);
        expect(repairs.asks()[0].turn).toBe(7);
    });

    test('a newer pass proposing the same row supersedes the older ask rather than doubling it', () => {
        const key = askKeyOf('item', itemKey('gold'));
        repairs.record({ applied: [], asked: [repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944, evidence: 'first reading' })], covered: span });
        repairs.record({ applied: [], asked: [repair(AMOUNT, 'item', itemKey('gold'), { count: 512, from: 2944, evidence: 'a better reading' })], covered: span });
        const pending = repairs.asks();
        expect(pending).toHaveLength(1);
        expect(pending[0].count).toBe(512);
        expect(pending[0].evidence).toBe('a better reading');
        expect(askKey(pending[0])).toBe(key);
    });

    test('a row re-posed and NOT re-proposed has its standing ask withdrawn', () => {
        // The model looked at the row again and said keep. Leaving the question standing would make
        // the queue a place where refuted asks accumulate.
        repairs.record({ applied: [], asked: [repair(GONE, 'cast', 'person infected man')], covered: span });
        repairs.record({
            applied: [],
            asked: [],
            posed: new Set([askKeyOf('cast', 'person infected man')]),
            covered: span,
        });
        expect(repairs.asks()).toEqual([]);
    });

    test('and a row this pass never posed keeps its ask, because the walk did not reach it', () => {
        // `reconcileBlock` poses 40 of 88 rows and offset-walks the rest, so "not re-proposed" says
        // nothing at all about a row that was never looked at.
        repairs.record({ applied: [], asked: [repair(GONE, 'cast', 'person infected man')], covered: span });
        repairs.record({ applied: [], asked: [], posed: new Set([askKeyOf('item', itemKey('scrap'))]), covered: span });
        expect(repairs.asks()).toHaveLength(1);
    });
});

describe('the ledger is bounded, because the blob is nearly full', () => {
    test('only the newest three passes are kept', () => {
        for (let at = 0; at < 6; at++) {
            repairs.record({ applied: [{ op: RENAME, kind: 'item', key: `k${at}`, name: `n${at}`, to: 'x', from: 'y', count: 0, evidence: 'e', undo: 'inverse' }], covered: span });
        }
        const kept = repairs.ledger();
        expect(kept).toHaveLength(MAX_LEDGER_PASSES);
        expect(kept.map(pass => pass.pass)).toEqual([6, 5, 4]);
    });

    test('the pending queue is bounded too, oldest pass first', () => {
        for (let pass = 0; pass < 4; pass++) {
            const asked = Array.from({ length: 25 }, (_, at) => repair(GONE, 'item', itemKey(`row ${pass}-${at}`)));
            repairs.record({ applied: [], asked, covered: span });
        }
        const pending = repairs.asks();
        expect(pending.length).toBeLessThanOrEqual(60);
        // An ask walked past for several runs is one the player has answered by not answering.
        expect(pending.every(ask => ask.pass >= 2)).toBe(true);
    });
});

describe('coverage, which is what stops an all-clear overclaiming', () => {
    test('with no pass on record, nothing is claimed as checked', () => {
        expect(repairs.coverage()).toEqual({ start: 0, end: 0, total: 0 });
    });

    test('the newest pass\'s span, and a live total when the caller has one', () => {
        repairs.record({ applied: [], covered: { start: 41, end: 80, total: 88 } });
        expect(repairs.coverage()).toEqual({ start: 41, end: 80, total: 88 });
        expect(repairs.coverage(91).total).toBe(91);
    });
});

describe('per-row inverse undo, which never expires because it is just an edit', () => {
    test('a rename is undone at the key the row LANDED under, not the one it left', () => {
        // An item key is `place\0name`, so a rename re-keys the row. An inverse addressed at the old
        // key would find nothing and report success, an undo button that changes nothing.
        const row = land(repair(RENAME, 'item', itemKey('ammunition'), { to: 'buckshot shells' }));
        expect(row.key).toBe(itemKey('buckshot shells'));
        expect(row.from).toBe('ammunition');
        expect(row.undo).toBe('inverse');
        repairs.record({ applied: [row], covered: span });

        expect(repairs.undoRow(1, askKey(row))).toBe(true);
        expect(inv.get(itemKey('ammunition'))).toBe(29);
        expect(inv.has(itemKey('buckshot shells'))).toBe(false);
    });

    test('a move is undone back to the place the row was actually in', () => {
        const row = land(repair(MOVE, 'item', itemKey('scrap'), { to: 'the van' }));
        expect(row.key).toBe(itemKey('scrap', 'van'));
        expect(row.from).toBe('carried');
        repairs.record({ applied: [row], covered: span });

        expect(repairs.undoRow(1, askKey(row))).toBe(true);
        expect(inv.get(itemKey('scrap'))).toBe(4);
    });

    test('a cast move records where the row actually was, read at apply time', () => {
        // Not the place the BLOCK posed: an ask can be answered many turns after it was raised, and
        // an inverse has to restore what was there rather than what the pass was told was there.
        cast.set('person ada wong', { name: 'Ada Wong', place: 'the lab' });
        const row = land(repair(MOVE, 'cast', 'person ada wong', { to: 'the sewers' }));
        expect(row.from).toBe('the lab');
        repairs.record({ applied: [row], covered: span });

        expect(repairs.undoRow(1, askKey(row))).toBe(true);
        expect(cast.get('person ada wong').place).toBe('the lab');
    });

    test('an amount is undone to the count the block posed', () => {
        const entry = repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944 });
        const row = land(entry);
        expect(inv.get(itemKey('gold'))).toBe(340);
        repairs.record({ applied: [row], covered: span });

        expect(repairs.undoRow(1, askKey(row))).toBe(true);
        expect(inv.get(itemKey('gold'))).toBe(2944);
    });

    test('the row leaves the ledger once undone, so the ledger keeps meaning "what stands"', () => {
        const row = land(repair(RENAME, 'item', itemKey('scrap'), { to: 'wire' }));
        repairs.record({ applied: [row], covered: span });
        repairs.undoRow(1, askKey(row));
        expect(repairs.ledger()[0].applied).toEqual([]);
        expect(observe.load().get('reconcile:undone')).toBe(1);
    });

    test('split, gone and merge are refused rather than pretended at', () => {
        const rows = [
            land(repair(SPLIT, 'item', itemKey('ammunition'), { parts: [{ name: 'shells', count: 25 }], from: 29 })),
            land(repair(GONE, 'item', itemKey('scrap'))),
        ];
        repairs.record({ applied: rows, covered: span });
        for (const row of rows) {
            expect(['snapshot', 'none']).toContain(row.undo);
            expect(repairs.undoRow(1, askKey(row))).toBe(false);
        }
        // And the ledger still holds them, because they DID happen, refusing the undo is not
        // refusing the record.
        expect(repairs.ledger()[0].applied).toHaveLength(2);
    });

    test('an undo aimed at a pass or a row that is not there answers false', () => {
        repairs.record({ applied: [], covered: span });
        expect(repairs.undoRow(99, askKeyOf('item', 'x'))).toBe(false);
        expect(repairs.undoRow(1, askKeyOf('item', 'x'))).toBe(false);
    });
});

describe('snapshot honesty, an undo that silently expires is a lie', () => {
    test('valid immediately after the pass that took it', () => {
        const row = land(repair(RENAME, 'item', itemKey('scrap'), { to: 'wire' }));
        repairs.record({ applied: [row], covered: span, snapshot: store.snapshotFold() });
        expect(repairs.snapshotValid(1)).toBe(true);
        expect(repairs.ledger()[0].snapshotValid).toBe(true);
    });

    test('and INVALID the moment anything else writes', () => {
        // The whole property. A restore discards everything the blob learned after the copy was
        // taken, so a snapshot offered after an extraction fold, a hand edit or an accepted ask would
        // destroy a turn of play. `store.writeMark` counts every write; nothing else could see this.
        repairs.record({ applied: [], covered: span, snapshot: store.snapshotFold() });
        expect(repairs.snapshotValid(1)).toBe(true);

        observe.note('extract:ok');
        expect(repairs.snapshotValid(1)).toBe(false);
        expect(repairs.ledger()[0].snapshotValid).toBe(false);
        expect(repairs.revertPass(1)).toBe(false);
    });

    test('only the pass that owns it, and never an older one', () => {
        repairs.record({ applied: [], covered: span, snapshot: store.snapshotFold() });
        repairs.record({ applied: [], covered: span, snapshot: store.snapshotFold() });
        expect(repairs.snapshotValid(1)).toBe(false);
        expect(repairs.snapshotValid(2)).toBe(true);
    });

    test('a pass that applied nothing holds no snapshot to offer', () => {
        repairs.record({ applied: [], covered: span, snapshot: null });
        expect(repairs.snapshotValid(1)).toBe(false);
    });

    test('and a later pass that changed nothing does not take the earlier revert away', () => {
        // A run that finds nothing to fix wrote nothing to the record, so it has not made the earlier
        // pass's snapshot dishonest. Clearing it anyway would mean "press Reconcile twice and lose
        // the undo for the first one", the silent expiry, arriving by a different door.
        repairs.record({ applied: [], covered: span, snapshot: store.snapshotFold() });
        repairs.record({ applied: [], covered: span, snapshot: null });
        expect(repairs.snapshotValid(1)).toBe(true);
        expect(repairs.revertPass(1)).toBe(true);
    });

    test('recording the pass does not invalidate the snapshot it is recording', () => {
        // The ledger write and the ask write both bump the counter. Without absorbing them into the
        // held mark, "Revert this pass" would be dead on arrival every single time.
        repairs.record({
            applied: [],
            asked: [repair(GONE, 'cast', 'person infected man')],
            covered: span,
            snapshot: store.snapshotFold(),
        });
        expect(repairs.snapshotValid(1)).toBe(true);
    });

    test('dismissing an ask expires the snapshot, which is the conservative direction', () => {
        repairs.record({
            applied: [],
            asked: [repair(GONE, 'cast', 'person infected man')],
            covered: span,
            snapshot: store.snapshotFold(),
        });
        expect(repairs.dismissAsk(askKeyOf('cast', 'person infected man'))).toBe(true);
        // `dismissAsk` also notes a counter, which IS a write, so the honest answer here is
        // "expired". Conservative in the safe direction: over-reporting costs an undo the player
        // could have had, under-reporting costs them a turn they cannot get back.
        expect(repairs.snapshotValid(1)).toBe(false);
    });
});

describe('reverting a pass restores the record and nothing else', () => {
    test('the record comes back, and the counters and the queue do not', () => {
        repairs.record({
            applied: [],
            asked: [repair(GONE, 'cast', 'person infected man')],
            covered: span,
            snapshot: store.snapshotFold(),
        });
        // Something in the pre-pass blob, so a restore is observable.
        const before = JSON.stringify(metadata[SANGUINE].state.observed ?? {});

        expect(repairs.revertPass(1)).toBe(true);
        expect(JSON.stringify(metadata[SANGUINE].state.observed ?? {})).not.toBe(before);
        // The instrument survived the undo it was measuring: both facts are counted.
        expect(observe.load().get('reconcile:reverted')).toBe(1);
        // The questions are not writes to the record, so reverting the writes says nothing about them.
        expect(repairs.asks()).toHaveLength(1);
        // The pass itself is gone from the ledger, it no longer describes anything that stands.
        expect(repairs.ledger().map(pass => pass.pass)).not.toContain(1);
    });

    test('a second revert of the same pass answers false rather than restoring twice', () => {
        repairs.record({ applied: [], covered: span, snapshot: store.snapshotFold() });
        expect(repairs.revertPass(1)).toBe(true);
        expect(repairs.revertPass(1)).toBe(false);
    });
});

describe('answering an ask is the same write the auto lane would have made', () => {
    test('applying routes through the ordinary writer and lands on the ledger', () => {
        repairs.record({
            applied: [],
            asked: [repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944 })],
            covered: span,
        });
        expect(repairs.applyAsk(askKeyOf('item', itemKey('gold')))).toBe(true);
        expect(calls).toContain(`setItemQty ${itemKey('gold')} 340`);
        expect(inv.get(itemKey('gold'))).toBe(340);
        expect(repairs.asks()).toEqual([]);
        // Appended to the pass it belongs to rather than evicting two real passes for a receipt.
        expect(repairs.ledger()[0].applied.map(row => row.op)).toEqual([AMOUNT]);
        expect(observe.load().get('reconcile:ask-applied')).toBe(1);
        expect(observe.load().get('reconcile:applied')).toBe(1);
    });

    test('a merge reaches the table that owns the keeper rule, using the stored target key', () => {
        repairs.record({
            applied: [],
            asked: [repair(MERGE, 'cast', 'person infected man', { with: 'person ada wong', withName: 'Ada Wong' })],
            covered: span,
        });
        expect(repairs.applyAsk(askKeyOf('cast', 'person infected man'))).toBe(true);
        expect(calls).toContain('entities.merge person infected man -> person ada wong');
        expect(repairs.ledger()[0].applied[0].to).toBe('Ada Wong');
        expect(repairs.ledger()[0].applied[0].undo).toBe('none');
    });

    test('dismissing writes nothing to the record at all', () => {
        repairs.record({ applied: [], asked: [repair(GONE, 'item', itemKey('scrap'))], covered: span });
        expect(repairs.dismissAsk(askKeyOf('item', itemKey('scrap')))).toBe(true);
        expect(calls).toEqual([]);
        expect(inv.get(itemKey('scrap'))).toBe(4);
        expect(repairs.asks()).toEqual([]);
        expect(observe.load().get('reconcile:ask-dismissed')).toBe(1);
    });

    test('an ask whose row has moved on is dropped rather than re-posed forever', () => {
        repairs.record({ applied: [], asked: [repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944 })], covered: span });
        inv.delete(itemKey('gold'));
        expect(repairs.applyAsk(askKeyOf('item', itemKey('gold')))).toBe(false);
        expect(repairs.asks()).toEqual([]);
    });

    test('a cluster is one decision, and its members share (op, kind) so ordering cannot bite', () => {
        cast.set('person mechanic', { name: 'mechanic in the coveralls' });
        cast.set('person two figures', { name: 'two other figures' });
        repairs.record({
            applied: [],
            asked: [
                repair(GONE, 'cast', 'person infected man'),
                repair(GONE, 'cast', 'person mechanic'),
                repair(GONE, 'cast', 'person two figures'),
                repair(AMOUNT, 'item', itemKey('gold'), { count: 340, from: 2944 }),
            ],
            covered: span,
        });
        expect(repairs.applyCluster(`${GONE}${SEP}cast`)).toBe(3);
        // The amount is a different card and is untouched, the maximum blast radius of one
        // interaction is one card, which is the whole reason there is no global apply-all.
        expect(repairs.asks().map(ask => ask.op)).toEqual([AMOUNT]);
        expect(inv.get(itemKey('gold'))).toBe(2944);
    });

    test('answering something that is not there answers false and writes nothing', () => {
        expect(repairs.applyAsk(askKeyOf('item', 'nothing'))).toBe(false);
        expect(repairs.dismissAsk(askKeyOf('item', 'nothing'))).toBe(false);
        expect(repairs.applyCluster(`${GONE}${SEP}cast`)).toBe(0);
        expect(calls).toEqual([]);
    });
});

describe('the budget pruner sheds machinery before it sheds memory', () => {
    test('the ledger goes first, then the asks, one shed per pass', () => {
        repairs.record({
            applied: [{ op: RENAME, kind: 'item', key: 'k', name: 'n', to: 'x', from: 'y', count: 0, evidence: 'e', undo: 'inverse' }],
            asked: [repair(GONE, 'cast', 'person infected man')],
            covered: span,
        });
        expect(repairs.ledger()).toHaveLength(1);
        expect(repairs.asks()).toHaveLength(1);

        // Push the blob past `MAX_FOLD_BYTES` so the real budget loop runs the real pruners.
        const fold = store.getFold();
        fold.ballast = 'x'.repeat(store.MAX_FOLD_BYTES);
        store.enforceBudget();

        // The receipt for edits already in the chronicle's trail goes first: losing it costs an undo
        // affordance. The questions cost a re-run of a pass that is explicitly re-runnable.
        expect(repairs.ledger()).toEqual([]);
        expect(repairs.asks()).toEqual([]);
        expect(repairs.snapshotValid(1)).toBe(false);
    });

    test('and it sheds before the archive and the chronicle do', () => {
        // `PRUNE_DIAGNOSTICS=10 < PRUNE_REPAIRS=20 < PRUNE_ARCHIVE=50 < PRUNE_MEMORY=100`. Repair
        // state is machinery, a queue of questions and a receipt, where the archive below it is the
        // campaign's own displaced memory. Losing a pending question costs a re-run; losing an
        // archived person costs the person.
        expect(store.PRUNE_REPAIRS).toBeGreaterThan(store.PRUNE_DIAGNOSTICS);
        expect(store.PRUNE_REPAIRS).toBeLessThan(store.PRUNE_ARCHIVE);
        expect(store.PRUNE_REPAIRS).toBeLessThan(store.PRUNE_MEMORY);
    });

    test('a pruner call with nothing left to shed does not spin', () => {
        repairs.clear();
        const fold = store.getFold();
        fold.ballast = 'x'.repeat(store.MAX_FOLD_BYTES);
        expect(() => store.enforceBudget()).not.toThrow();
    });
});

/*
 * The two states the surface renders but the pass had no source for.
 *
 * The Repairs tab renders a failure state ("The pass failed. Nothing was changed.") and a refusals
 * disclosure. Neither had anywhere to read from: `record` stored `covered` and `applied` only, so
 * both branches were unreachable and a pass that wrote nothing would have rendered as the ordinary
 * populated state, the previous pass's successes showing as the most recent thing that happened,
 * which reads as "the run went fine".
 *
 * That is the same defect the coverage strip exists to prevent, one level up: a surface implying it
 * checked more than it did.
 */
describe('a pass records what it refused and whether it failed', () => {
    test('refusals are stored as reason codes, for a per-reason count', () => {
        repairs.record({
            applied: [],
            asked: [],
            covered: span,
            rejected: [
                { item: 'RI3', reason: 'no-evidence' },
                { item: 'gold', reason: 'unusable-amount' },
                { item: 'RC1', reason: 'no-evidence' },
            ],
        });
        const pass = repairs.ledger()[0];
        expect(pass.rejected).toHaveLength(3);
        expect(pass.rejected.map(entry => entry.reason))
            .toEqual(['no-evidence', 'unusable-amount', 'no-evidence']);
    });

    test('the model’s refused ANSWER is never stored, only which row and why', () => {
        // The refused answer is not evidence of anything, and the blob is at 96% of its cap on three
        // live chats. Storing raw model output here would be unbounded growth for no reader.
        repairs.record({
            applied: [],
            asked: [],
            covered: span,
            rejected: [{ item: 'gold', reason: 'unusable-amount', raw: { verdict: 'amount', count: -12 } }],
        });
        expect(repairs.ledger()[0].rejected[0].raw).toBeUndefined();
        expect(Object.keys(repairs.ledger()[0].rejected[0]).sort()).toEqual(['item', 'reason']);
    });

    test('an ordinary pass is not marked failed, and carries an empty refusal list', () => {
        repairs.record({ applied: [], asked: [], covered: span });
        expect(repairs.ledger()[0].failed).toBe(false);
        expect(repairs.ledger()[0].rejected).toEqual([]);
    });

    test('a failed pass is recorded as a pass, so the surface can say nothing was changed', () => {
        repairs.record({ applied: [], asked: [], covered: span });
        repairs.record({ applied: [], asked: [], covered: span, failed: true });
        const pass = repairs.ledger()[0];
        expect(pass.failed).toBe(true);
        expect(pass.applied).toEqual([]);
        // A failure that left no trace would let the previous pass's successes stand as the newest
        // entry, which is the reading the toast cannot correct once it has faded.
        expect(repairs.ledger()[1].failed).toBe(false);
    });
});
