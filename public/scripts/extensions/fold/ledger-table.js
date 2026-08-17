/**
 * fold/ledger-table.js — replay semantics for the durable event ledger.
 *
 * Pure, like every `-table.js`: no storage, no app graph, no fetch. It turns a list of ops into
 * tables, and it answers "what did this look like at that point". The transport lives in
 * `src/endpoints/fold-ledger.js`; the persistence glue will live in `ledger.js`.
 *
 * ── Replay is two stages, and keeping them separate is the whole design ──
 *
 * 1. **Effective sequence** (`effectiveOps`). Walk the raw lines in `seq` order, dedupe on `opId`,
 *    and apply `rewind` as a truncation. What comes out is the list of ops that ACTUALLY happened
 *    on this timeline — history after the rewinds have had their say.
 * 2. **Fold** (`replay`). Left-fold that list into tables. Nothing here knows about rewinds.
 *
 * The split is what makes time travel cheap and total. State at any point is stage 2 over a bounded
 * prefix of stage 1's output, so `deriveAt` is not a special code path — it is the ordinary fold
 * with a smaller input. And because the fold is a left fold over a list,
 *
 *     replay(base, xs ++ ys) = replay(replay(base, xs), ys)
 *
 * holds with **no algebraic side condition at all** — it is `List.foldl_append`, proved in the
 * sanguine corpus as `replay_append`
 * (`../sanguine/proof/Closures/Applied/AIOperationSurface.lean:142-145`). A checkpoint is therefore
 * just a prefix fold, and hydrating from checkpoint + suffix is always equal to replaying from the
 * beginning. That is the property that lets a year-long campaign hydrate in milliseconds.
 *
 * ── Why the server assigns `seq` and the client may not ──
 *
 * `ev` and `amend` are last-write-wins (`merge_b`), and last-write **diverges without a clock** —
 * `merge_B_order_matters` (`../sanguine/proof/Closures/Applied/OntologyClosure.lean:136-140`).
 * The repair is a versioned last-write, which converges (`merge_max_converges`, `:152-156`). The
 * server-assigned `seq` is that version. `hit` is the counter face and commutes, so it is
 * order-insensitive and safe to reorder or shard (`build_gauge_invariance`,
 * `../sanguine/proof/Substrate/Algebra/Security/HashTrinityCore.lean:195`).
 *
 * ── Raw keys only, forever ──
 *
 * Identity resolution (the `same_as`/`[same?]` crosswalk) is applied at READ time over the settled
 * stream and is never baked into a stored op, a checkpoint or a compaction. The corpus proves both
 * halves: a resolver that reads the prefix it is resolving breaks checkpoint+suffix replay even at
 * a commutative monoid, and no versioning repairs it
 * (`incremental_resolution_breaks_the_split`,
 * `../sanguine/proof/Substrate/Algebra/Security/IncrementalResolution.lean:130-136`); a
 * prefix-blind pass IS `relabel` and inherits every soundness theorem (`relabelInc_const`,
 * `:99-105`). fold already knows this failure by name — `crosswalk.js` exists because a
 * carried-forward row "would fossilize under its old name". The rule generalizes: **fold under raw
 * keys; resolve at read.**
 *
 * ── Unknown ops are skipped, never rejected ──
 *
 * A reader that refuses a line it does not recognise makes every future op a breaking change. Old
 * builds must stay able to read new ledgers, so an unknown `op` is passed over and counted. This is
 * the one storage lesson worth keeping from Scribe, whose `#[serde(default)]`-everywhere tolerance
 * was the versioning strategy that actually held while its richer schemas were migrated away.
 */

import { insert_with, lookup, merge_b, merge_bu, table_entries } from './lib/hash.js';

/** The op kinds this build understands. Anything else is skipped by `effectiveOps`. */
export const OPS = Object.freeze(['ev', 'amend', 'forget', 'hit', 'rewind']);

/**
 * Reduce raw ledger lines to the ops that actually happened on this timeline.
 *
 * ── `rewind` is a truncation, not an inverse ──
 *
 * Undoing by appending compensating ops would need every op to have an inverse, which `forget` and
 * `amend` do not (you cannot un-forget without knowing what was forgotten). Truncation needs no
 * inverses: `rewind to=T` simply drops everything after T from the effective list. It is total
 * under nesting and crossing — two rewinds to different points, a rewind after a rewind, a rewind
 * that targets a point already cut — because each one re-filters whatever list it finds.
 *
 * The rewind op itself never enters the list: it is an operator on history, not a record in it.
 * That is also why it is safe for a rewind to be replayed twice (a retry) — truncating an already
 * truncated list is a no-op, which is idempotence for free rather than by bookkeeping.
 *
 * @param {Array<object>} raw Ledger lines, any order; sorted here by `seq`.
 * @returns {{ops: object[], skipped: number, rewinds: number, duplicates: number}} The effective
 *   sequence and what was discarded reaching it.
 */
export function effectiveOps(raw) {
    // Sorted by `seq` and never by arrival: a retried append can land out of order, and the
    // timeline coordinate is the server's number, not the order bytes reached us.
    const ordered = [...(raw ?? [])]
        .filter(op => op && Number.isFinite(op.seq))
        .sort((a, b) => a.seq - b.seq);

    const seen = new Set();
    let ops = [];
    let skipped = 0;
    let rewinds = 0;
    let duplicates = 0;

    for (const op of ordered) {
        // `opId` makes a retry idempotent. Absent (an older line, a hand-written one), the op is
        // taken at face value — `seq` is unique per campaign, so it cannot duplicate itself.
        if (op.opId) {
            if (seen.has(op.opId)) {
                duplicates++;
                continue;
            }
            seen.add(op.opId);
        }
        if (op.op === 'rewind') {
            const to = Number(op.to);
            if (!Number.isFinite(to)) {
                skipped++;
                continue;
            }
            ops = ops.filter(kept => kept.seq <= to);
            rewinds++;
            continue;
        }
        if (!OPS.includes(op.op)) {
            skipped++;
            continue;
        }
        ops.push(op);
    }
    return { ops, skipped, rewinds, duplicates };
}

/**
 * Fold an effective sequence into the chronicle tables.
 *
 * Deliberately knows nothing about rewinds — those are resolved by `effectiveOps` before anything
 * gets here. A fold that also had to reason about truncation would be a fold that cannot be
 * checkpointed, because a checkpoint of it would not be a prefix of anything.
 *
 * @param {Array<object>} ops An effective sequence, in `seq` order.
 * @param {object} [base] A checkpoint to continue from: `{events, hits}`. Not mutated.
 * @returns {{events: Map<string, object>, hits: Map<string, number>, at: number}} The tables, and
 *   the highest `seq` folded.
 */
export function replay(ops, base = null) {
    const events = new Map(base?.events ? table_entries(base.events) : []);
    const hits = new Map(base?.hits ? table_entries(base.hits) : []);
    let at = Number.isFinite(base?.at) ? base.at : 0;

    for (const op of ops ?? []) {
        at = Math.max(at, Number(op.seq) || 0);
        switch (op.op) {
            case 'ev':
                // Last-write on the key, and the list is in `seq` order, so this IS the versioned
                // last-write `merge_max_converges` prescribes rather than arrival-order chance.
                if (op.k && op.e) {
                    insert_with(events, merge_b, op.k, op.e);
                }
                break;
            case 'amend': {
                // A summary rewrite that names no live row is dropped rather than resurrecting one:
                // amending a forgotten event would make `forget` conditional on what came after it.
                const row = lookup(events, op.k, null);
                if (row) {
                    insert_with(events, merge_b, op.k, { ...row, s: String(op.s ?? '') });
                }
                break;
            }
            case 'forget':
                events.delete(op.k);
                break;
            case 'hit':
                // The counter face: commutes, so retrieval credits need no clock and can be
                // reordered or sharded without changing the result.
                for (const key of op.keys ?? []) {
                    insert_with(hits, merge_bu, key, 1);
                }
                break;
            default:
                break;
        }
    }
    return { events, hits, at };
}

/**
 * The state of the ledger as of a point on the timeline.
 *
 * Not a special path: the effective sequence bounded by `seq`, then the ordinary fold. Time travel
 * costs exactly one filter more than reading the present.
 *
 * @param {Array<object>} raw Ledger lines.
 * @param {number} [seq] Highest `seq` to include; omit for the present.
 * @returns {{events: Map, hits: Map, at: number}} The tables at that point.
 */
export function replayAt(raw, seq = Infinity) {
    const { ops } = effectiveOps(raw);
    return replay(ops.filter(op => op.seq <= seq));
}

/**
 * Where on the timeline the conversation stood at message index `M`.
 *
 * ── The join between two coordinate systems ──
 *
 * The player asks in MESSAGES ("take me back to before the ambush"); the ledger is indexed in
 * `seq`. `fmid` — the frontier message index when an op was appended — is the only field that
 * spans both, which is why it rides the envelope unconditionally rather than being derived from an
 * event's `mid`. An event's `mid` is its ANCHOR and can point at an older message (a review closure
 * settles a thread opened fifty turns ago) or be absent entirely (a world move), so anchors cannot
 * order a timeline.
 *
 * `max{seq : fmid ≤ M}` is total. Several ops sharing a frontier all qualify and the largest wins,
 * so restoring to M includes everything that happened while the conversation stood at M. A pass
 * that produced no ops leaves no seq at that frontier, and the answer falls back to the last
 * frontier that did — which is correct: nothing happened, so nothing changed.
 *
 * After a rewind, `fmid` values can repeat — the conversation stood at M twice. Computing over the
 * EFFECTIVE sequence resolves it to the most recent time the timeline stood at M, which is the one
 * the player is looking at.
 *
 * @param {Array<object>} raw Ledger lines.
 * @param {number} mid The message index to restore to.
 * @returns {number} The `seq` to restore to; 0 when nothing had happened yet.
 */
export function restoreSeq(raw, mid) {
    if (!Number.isFinite(mid)) {
        return 0;
    }
    const { ops } = effectiveOps(raw);
    let best = 0;
    for (const op of ops) {
        const frontier = Number(op.fmid);
        if (Number.isFinite(frontier) && frontier <= mid && op.seq > best) {
            best = op.seq;
        }
    }
    return best;
}

/**
 * Is a checkpoint still usable against this ledger?
 *
 * ── The one caveat `rewind` introduces ──
 *
 * `replay_append` makes checkpoint + suffix unconditionally equal to a full replay — but that is a
 * statement about a fixed list, and a rewind CHANGES the list. A checkpoint covering `seq ≤ c` is
 * void if any line after it rewinds to below `c`, because the prefix it summarises is no longer the
 * effective prefix. One comparison per rewind line; on a hit, discard and fold from scratch, which
 * is always available.
 *
 * @param {Array<object>} raw Ledger lines.
 * @param {number} covered The highest `seq` the checkpoint folded.
 * @returns {boolean} True when the checkpoint may be used as a base.
 */
export function checkpointValid(raw, covered) {
    if (!Number.isFinite(covered) || covered <= 0) {
        return false;
    }
    return !(raw ?? []).some(op => op?.op === 'rewind'
        && Number.isFinite(op.seq)
        && op.seq > covered
        && Number(op.to) < covered);
}
