/**
 * sanguine-backfill: reading a span the forward pass never reached, and not re-reading one it did.
 *
 * Where this suite came from.
 *
 * The brief was: "97 messages of a live campaign were never read, and nothing can ever read them."
 * The evidence offered was `cap:opening-unread: 97` in
 * `data/default-user/chats/Wuxia World RPG/Wuxia World RPG - 2026-08-20@19h08m26s160ms.jsonl`, and
 * the reading of `splitWindow` that only a FIRST pass can produce a non-zero there.
 *
 * Both live chats that carry the counter were read first, in their own metadata:
 *
 *   Wuxia World RPG      286 messages, 272 events, 98 of them anchored below mid 121, the mid the
 *                        counter claims nothing reached. The event for mid 1 is stamped 19:13 and
 *                        message 1 was sent at 19:13. Extraction ran from the first turn.
 *   Raccoon City         271 messages, 301 events, 182 of them below mid 170.
 *
 * So the counter was never a hole. What it was is visible in the same files: one pass in each chat
 * wrote an outsized batch of events, TEN at mid 168 in Raccoon City against a corpus median of one
 * or two, THREE at mid 120 in Wuxia, and six of Raccoon City's ten restate beats already in the
 * ledger from mids 150, 154, 157, 160 and 164. Those are the fingerprints of a window that reached
 * back `FIRST_WINDOW` messages and billed every one of them, in a chat two hundred turns deep.
 *
 * The cause is a mark that stopped resolving. Nine events in the Wuxia chat and five in Raccoon City
 * are anchored on a mid whose message was sent LATER than the event was written, mid 166 in Raccoon
 * City by 32,622 seconds, which is that session's gap to the hour, and messages only get renumbered
 * when messages are deleted. `resolveMark` returns null for a mark past the end, `splitWindow` read
 * that as "never extracted", and the reach-back followed.
 *
 * Hence two halves here. `readFrontier` stops a lost mark from being mistaken for a fresh chat, and
 * `planBackfill`/`backfillStamp`/`withoutDeltas` are what fills a hole that IS real, because the
 * brief's larger point stands even though its measurement does not: a chat switched on at message
 * 200 has 176 messages nothing can read, and until now nothing could go back for them.
 */

import { describe, expect, test } from '@jest/globals';

import {
    BACKFILL_CHUNK,
    BACKFILL_CONTEXT,
    BACKFILL_SPACING,
    CONTEXT_HEADER,
    FIRST_WINDOW,
    FRONTIER_FRESH,
    FRONTIER_HEALED,
    FRONTIER_STOOD,
    NEW_HEADER,
    backfillStamp,
    chunkRead,
    planBackfill,
    readFrontier,
    splitWindow,
    withoutDeltas,
} from '../public/scripts/extensions/sanguine/extract-table.js';

/** A message in the shape `readableMessages` hands over. */
const msg = (mid, text = `line ${mid}`, key = `k${mid}`) => ({ mid, key, name: 'Narrator', text });

/** A chat of `n` messages, mids 0..n-1. */
const chatOf = (n) => Array.from({ length: n }, (_, at) => msg(at));

describe('readFrontier, "never read" and "the mark named a message that is gone" are not one fact', () => {
    const CHAT = chatOf(6);

    test('no mark at all is a genuinely fresh chat', () => {
        expect(readFrontier(CHAT, {})).toEqual({ at: null, state: FRONTIER_FRESH, heal: null });
        expect(readFrontier(CHAT, { mid: NaN, key: 'k3' }).state).toBe(FRONTIER_FRESH);
    });

    test('a mark whose message still hashes the same stands', () => {
        expect(readFrontier(CHAT, { mid: 3, key: 'k3' })).toEqual({ at: 3, state: FRONTIER_STOOD, heal: null });
    });

    test('a swiped message still becomes new again, and that is not a loss', () => {
        // The retreat-by-one rule is unchanged: a swipe rewrites content in place, so the mark's own
        // message is new again. It resolved, so nothing is healed.
        expect(readFrontier(CHAT, { mid: 5, key: 'k5-old' })).toEqual({ at: 4, state: FRONTIER_STOOD, heal: null });
    });

    test('a mark past the end of the chat is recovered, not thrown away', () => {
        // The Raccoon City shape: the mark was taken at mid 200, messages were deleted, and the mid
        // now points past the end. Every message that survives below it was read by the pass that
        // set it, deletion only ever removes, so the recovery lands just below the newest one.
        expect(readFrontier(CHAT, { mid: 200, key: 'k200' })).toEqual({
            at: 4, state: FRONTIER_HEALED, heal: { mid: 4, key: 'k4' },
        });
    });

    test('the recovery stops one below the newest survivor, so a swipe is not skipped', () => {
        // `state-table.js` `RECORDED_HORIZON` records the trace side of this: turn 64 of the Wuxia
        // campaign, mark 122 → 120, and the newest message was a fresh swipe. Landing ON the
        // survivor would file brand-new narration under "already read" forever. One message is
        // re-offered instead, which the chronicle's exact dedup already covers.
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 200, key: 'k200' } });
        expect(window.sources.map(s => s.mid)).toEqual([5]);
    });

    test('a mark on a message that was hidden lands below the newest one under it', () => {
        // `readableMessages` filters `is_system` and empty messages, so a hidden message vanishes
        // from the list without shortening it. Same recovery.
        const gapped = [msg(0), msg(1), msg(3), msg(4)];
        expect(readFrontier(gapped, { mid: 2, key: 'k2' })).toEqual({
            at: 0, state: FRONTIER_HEALED, heal: { mid: 0, key: 'k0' },
        });
    });

    test('one survivor and nothing under it leaves no mark to write', () => {
        // The correct mark would be "before the first message", which the clock cannot say. The next
        // pass heals again; on a chat this short that costs nothing.
        expect(readFrontier([msg(0)], { mid: 9, key: 'k9' })).toEqual({
            at: null, state: FRONTIER_HEALED, heal: null,
        });
    });

    test('a mark below every message this chat has really is fresh', () => {
        // Nothing survives to recover from, so the reach-back and the honest `unread` are correct.
        const late = [msg(10), msg(11)];
        expect(readFrontier(late, { mid: 4, key: 'k4' }).state).toBe(FRONTIER_FRESH);
    });
});

describe('a lost mark must not be billed as a first pass', () => {
    /**
     * The measured shape, reconstructed.
     *
     * Raccoon City fired `cap:opening-unread: 145` on a chat with 169 readable messages, 169 - 24
     * is exactly 145, and the pass that fired it wrote ten events at mid 168, six of which restate
     * beats already recorded at mids 150 to 164. Every one of those 24 messages had already been
     * read; every one was licensed to anchor a new event.
     */
    const CHAT = chatOf(169);
    const LOST = { mid: 200, key: 'k200' };

    test('it no longer reaches back to FIRST_WINDOW', () => {
        const window = splitWindow(CHAT, { size: 6, mark: LOST });
        expect(window.seen).not.toHaveLength(FIRST_WINDOW);
        expect(window.seen).toHaveLength(6);
    });

    test('it bills one message instead of twenty-four', () => {
        // Raccoon City's pass billed 24 already-read messages and wrote ten events, six of them
        // restating beats from mids 150-164. One message is offered now, the newest, which may be
        // a swipe nothing has read, and the other 23 are recognised as read.
        const window = splitWindow(CHAT, { size: 6, mark: LOST });
        expect(window.sources.map(s => s.mid)).toEqual([168]);
        expect(window.context).toBe(5);
    });

    test('it reports no fictitious hole', () => {
        // 145 came from here. `unread` now means only what it always claimed to mean.
        expect(splitWindow(CHAT, { size: 6, mark: LOST }).unread).toBe(0);
        expect(splitWindow(chatOf(286), { size: 6, mark: { mid: 300, key: 'k300' } }).unread).toBe(0);
    });

    test('it hands back a corrected mark, so the recovery happens once', () => {
        // Without the write-back the stale mid stays past the end forever and every later pass
        // repeats the same recovery, cheap now, but it also means the diagnosis never settles.
        expect(splitWindow(CHAT, { size: 6, mark: LOST }).heal).toEqual({ mid: 167, key: 'k167' });
    });

    test('an ordinary pass heals nothing', () => {
        expect(splitWindow(CHAT, { size: 6, mark: { mid: 160, key: 'k160' } }).heal).toBe(null);
        expect(splitWindow(CHAT, { size: 6 }).heal).toBe(null);
    });

    test('a genuinely fresh chat still reaches the opening and still reports what it missed', () => {
        // The `FIRST_WINDOW` behaviour is untouched for the case it exists for. This is the
        // regression guard on the fix itself.
        const window = splitWindow(chatOf(300), {});
        expect(window.seen).toHaveLength(FIRST_WINDOW);
        expect(window.seen[0]).toBe(300 - FIRST_WINDOW);
        expect(window.unread).toBe(300 - FIRST_WINDOW);
        expect(window.sources).toHaveLength(FIRST_WINDOW);
    });
});

describe('planBackfill, what will be read, in what order, and what it costs', () => {
    // The brief's span, as it would be if it were real: fold switched on at message 121 of a chat
    // that is now 286 long, leaving mids 0-120 below the reach-back.
    const CHAT = chatOf(286);

    test('it refuses to run without a ceiling, rather than guessing one', () => {
        // A guessed ceiling that is too high re-reads messages the ledger already has, which is
        // money spent to write duplicates with fresh anchors that neither dedup can see, exactly
        // the damage the lost mark did by accident.
        const plan = planBackfill(CHAT, {});
        expect(plan.reason).toBe('no-ceiling');
        expect(plan.calls).toBe(0);
        expect(plan.chunks).toEqual([]);
    });

    test('it refuses when the span is already covered', () => {
        expect(planBackfill(CHAT, { to: 121, done: 120 }).reason).toBe('nothing-to-backfill');
        expect(planBackfill(CHAT, { to: 0 }).reason).toBe('nothing-to-backfill');
    });

    test('it refuses on an empty chat', () => {
        expect(planBackfill([], { to: 121 }).reason).toBe('empty-chat');
    });

    test('the 97-message hole is nine calls at the default chunk', () => {
        // The number the owner is asked to authorise. 121 messages below the ceiling would be 11;
        // the brief's hole is the 97 below mid 97, which is what `unread` measured.
        const plan = planBackfill(CHAT, { to: 97 });
        expect(plan.messages).toBe(97);
        expect(plan.calls).toBe(Math.ceil(97 / BACKFILL_CHUNK));
        expect(plan.calls).toBe(9);
        expect(plan.from).toBe(0);
        expect(plan.to).toBe(97);
    });

    test('it walks forward, so the opening is read first', () => {
        // The whole reason the hole is worth filling is at message 0: cards put the premise, the
        // sheet and the starting kit in the greeting. A backward walk reaches it last, so a run the
        // owner stops early recovers everything except the reason he ran it.
        const plan = planBackfill(CHAT, { to: 97 });
        expect(plan.chunks[0].sources[0].mid).toBe(0);
        expect(plan.chunks[0].sources.at(-1).mid).toBe(BACKFILL_CHUNK - 1);
        expect(plan.chunks.at(-1).sources.at(-1).mid).toBe(96);
    });

    test('every chunk bills its own messages and nothing else', () => {
        const plan = planBackfill(CHAT, { to: 97, chunk: 10 });
        const billed = plan.chunks.flatMap(chunk => chunk.sources.map(source => source.mid));
        expect(billed).toEqual(Array.from({ length: 97 }, (_, at) => at));
        expect(new Set(billed).size).toBe(97);
    });

    test('each chunk after the first carries the previous one as unbillable run-up', () => {
        // `splitWindow`'s overlap argument applied to the chunk boundary: an event whose setup is in
        // the last message of the previous chunk is unreadable without it. Shown, never billed.
        const plan = planBackfill(CHAT, { to: 97 });
        const second = plan.chunks[1];
        expect(second.context).toBe(BACKFILL_CONTEXT);
        expect(second.seen.slice(0, BACKFILL_CONTEXT)).toEqual([BACKFILL_CHUNK - 2, BACKFILL_CHUNK - 1]);
        expect(second.sources.map(s => s.mid)).not.toContain(BACKFILL_CHUNK - 1);
        expect(second.text).toContain(CONTEXT_HEADER);
        expect(second.text).toContain(NEW_HEADER);
    });

    test('the first chunk has no run-up to show and says so', () => {
        const first = planBackfill(CHAT, { to: 97 }).chunks[0];
        expect(first.context).toBe(0);
        expect(first.text).not.toContain(CONTEXT_HEADER);
    });

    test('`newText` is the billable half only, which is what the mention gate reads', () => {
        const second = planBackfill(CHAT, { to: 97, chunk: 4 }).chunks[1];
        expect(second.newText).toContain('line 4');
        expect(second.newText).not.toContain('line 3');
        expect(second.text).toContain('line 3');
    });

    test('a chunk never claims to be a first pass', () => {
        // `unread` on a backfill chunk would report a hole below the hole being filled.
        for (const chunk of planBackfill(CHAT, { to: 97 }).chunks) {
            expect(chunk.unread).toBe(0);
            expect(chunk.heal).toBe(null);
        }
    });
});

describe('resumability, a run stopped anywhere picks up where it stopped', () => {
    const CHAT = chatOf(286);

    test('a frontier mid-span plans only what is left', () => {
        // `done` is persisted after EVERY chunk (`extract.js` `runBackfill`), so a closed tab, a
        // `limit`, or a stop costs at most the chunk in flight.
        const plan = planBackfill(CHAT, { to: 97, done: 47 });
        expect(plan.from).toBe(48);
        expect(plan.messages).toBe(49);
        expect(plan.calls).toBe(Math.ceil(49 / BACKFILL_CHUNK));
    });

    test('resuming twice reads every message exactly once', () => {
        // The property that makes interruption safe: two runs split by a stop cover the same set as
        // one uninterrupted run, with no message read twice and none skipped.
        const first = planBackfill(CHAT, { to: 97 });
        const stoppedAfter = 3;
        const covered = first.chunks.slice(0, stoppedAfter).flatMap(c => c.sources.map(s => s.mid));
        const resumed = planBackfill(CHAT, { to: 97, done: covered.at(-1) });
        const all = [...covered, ...resumed.chunks.flatMap(c => c.sources.map(s => s.mid))];
        expect(all).toEqual(Array.from({ length: 97 }, (_, at) => at));
    });

    test('a resumed chunk still gets its run-up, from messages already read', () => {
        // The context comes from the FULL list rather than the remaining span, so the first chunk
        // after a resume is not left explaining itself from nothing.
        const resumed = planBackfill(CHAT, { to: 97, done: 47 });
        expect(resumed.chunks[0].context).toBe(BACKFILL_CONTEXT);
        expect(resumed.chunks[0].seen[0]).toBe(46);
        expect(resumed.chunks[0].sources[0].mid).toBe(48);
    });

    test('a frontier at the ceiling is a refusal, not an empty run', () => {
        expect(planBackfill(CHAT, { to: 97, done: 96 }).reason).toBe('nothing-to-backfill');
    });
});

describe('chunkRead, the one way a backfill could silently skip what it exists to recover', () => {
    test('a chunk the model answered is read', () => {
        expect(chunkRead({ ok: true, results: {} })).toBe(true);
    });

    test('a chunk the model read and could not answer for is still read', () => {
        // A call was spent and the stretch is established as unreadable by this model. Paying again
        // changes nothing, so the frontier moves and `backfill:failed` records the hole.
        for (const reason of ['empty', 'truncated', 'unparseable', 'error']) {
            expect(chunkRead({ ok: false, reason })).toBe(true);
        }
    });

    test('a chunk that never reached the model is NOT read', () => {
        // Every one of these is `runExtraction` refusing before the request. Advancing past them
        // would mark messages as recovered that nothing has looked at, while reporting a completed
        // run, which is the exact shape of failure this whole session is about.
        for (const reason of ['busy', 'chat-changed', 'no-probes', 'empty-window', 'nothing-new', 'sources-not-live']) {
            expect(chunkRead({ ok: false, reason })).toBe(false);
        }
    });

    test('a result that is nothing at all stops the run', () => {
        // The two mistakes are not symmetric: stopping costs a re-invocation, advancing past an
        // unread chunk costs the messages.
        expect(chunkRead(null)).toBe(false);
        expect(chunkRead(undefined)).toBe(false);
    });
});

describe('backfillStamp, a recovered event is old news everywhere `t` is read', () => {
    /**
     * `deriveState` folds the chronicle in `t` order (`state-table.js:2373`) and `t` is `Date.now()`
     * at the moment the pass ran (`chronicle-table.js:154`). A recovered event stamped now would be
     * the newest thing the ledger knows about a message from an hour before any of it, newest in
     * the chronicle view, newest for recall's recency, and last to be evicted.
     */
    const ANCHORS = [
        { mid: 100, t: 1_000_000 },
        { mid: 120, t: 1_200_000 },
        { mid: 160, t: 1_600_000 },
    ];

    test('below every anchor it is spaced backwards by the corpus median gap', () => {
        // 3,168 consecutive message pairs across 21 live chats, median 34.7s.
        expect(backfillStamp(ANCHORS, 99)).toBe(1_000_000 - BACKFILL_SPACING);
        expect(backfillStamp(ANCHORS, 0)).toBe(1_000_000 - BACKFILL_SPACING * 100);
    });

    test('between two anchors it is interpolated by mid', () => {
        expect(backfillStamp(ANCHORS, 110)).toBe(1_100_000);
        expect(backfillStamp(ANCHORS, 140)).toBe(1_400_000);
    });

    test('it is monotone in mid, which is the only property the fold needs', () => {
        const stamps = Array.from({ length: 160 }, (_, mid) => backfillStamp(ANCHORS, mid));
        for (let at = 1; at < stamps.length; at++) {
            expect(stamps[at]).toBeGreaterThanOrEqual(stamps[at - 1]);
        }
    });

    test('a recovered event always sorts before everything that followed it', () => {
        // The fact the chronicle view and recall's recency depend on.
        expect(backfillStamp(ANCHORS, 50)).toBeLessThan(1_000_000);
        expect(backfillStamp(ANCHORS, 130)).toBeLessThan(1_600_000);
        expect(backfillStamp(ANCHORS, 130)).toBeGreaterThan(1_200_000);
    });

    test('a ledger whose stamps do not ascend with its mids cannot push one outside its bracket', () => {
        // A swipe re-anchor or an imported chat can leave `t` and `mid` disagreeing. Clamped rather
        // than trusted: the recovered event stays between the pair that brackets it.
        const crooked = [{ mid: 100, t: 5_000_000 }, { mid: 120, t: 1_000_000 }];
        const stamp = backfillStamp(crooked, 110);
        expect(stamp).toBeGreaterThanOrEqual(1_000_000);
        expect(stamp).toBeLessThanOrEqual(5_000_000);
    });

    test('an empty ledger falls back to now rather than throwing', () => {
        expect(backfillStamp([], 5, 42)).toBe(42);
        expect(backfillStamp(null, 5, 42)).toBe(42);
    });

    test('anchors with no mid or no stamp are ignored, not counted as zero', () => {
        const noisy = [{ mid: undefined, t: 5 }, { mid: 3 }, ...ANCHORS];
        expect(backfillStamp(noisy, 110)).toBe(1_100_000);
    });
});

describe('withoutDeltas, backfill is additive to the record and never to the arithmetic', () => {
    /**
     * Why the stamp is not enough, and this is the load-bearing rule.
     *
     * The case is the one `FIRST_WINDOW` is written about. The Wuxia card's greeting lists
     * `1x Basic Iron Sword` in the storage ring, the opening was never read, and the player's later
     * mention of a sword is the only sword the ledger ever saw, so it was credited then.
     * Recovering the greeting now adds a second one, and fold order cannot help: a sum does not care
     * what order it is taken in, so the pair is two swords either way. The only fix is to not sum.
     */
    test('a recovered event keeps its summary and loses its delta', () => {
        const fragment = [{
            summary: 'The pendant spirit names the Nine Realms Heavenly Art.',
            keywords: ['pendant', 'nine realms'],
            delta: { inv: [{ item: 'basic iron sword', dq: 1 }] },
        }];
        const [recovered] = withoutDeltas(fragment);
        expect(recovered.summary).toBe('The pendant spirit names the Nine Realms Heavenly Art.');
        expect(recovered.keywords).toEqual(['pendant', 'nine realms']);
        expect(recovered).not.toHaveProperty('delta');
    });

    test('it does not mutate what it was given', () => {
        const fragment = [{ summary: 'x', delta: { inv: [] } }];
        withoutDeltas(fragment);
        expect(fragment[0].delta).toEqual({ inv: [] });
    });

    test('an event with no delta is passed through untouched', () => {
        const fragment = [{ summary: 'x', keywords: ['x'] }];
        expect(withoutDeltas(fragment)).toEqual(fragment);
    });

    test('a fragment that is not a list is returned as it came', () => {
        // The model can answer null or an object; a strip that assumed an array would turn a
        // recoverable reply into a crash inside the apply loop.
        expect(withoutDeltas(null)).toBe(null);
        expect(withoutDeltas(undefined)).toBe(undefined);
        expect(withoutDeltas({ events: [] })).toEqual({ events: [] });
    });

    test('every event in a batch is stripped, not just the first', () => {
        const fragment = [
            { summary: 'a', delta: { inv: [{ item: 'pill', dq: 1 }] } },
            { summary: 'b' },
            { summary: 'c', delta: { vitals: [{ name: 'health', value: 50 }] } },
        ];
        expect(withoutDeltas(fragment).some(event => 'delta' in event)).toBe(false);
    });
});
