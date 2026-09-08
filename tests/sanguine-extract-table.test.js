import { describe, expect, test } from '@jest/globals';

import {
    CONTEXT_HEADER,
    FIRST_WINDOW,
    NEW_HEADER,
    extractionSettled,
    missingProbes,
    resolveMark,
    splitWindow,
} from '../public/scripts/extensions/sanguine/extract-table.js';

/** A message in the shape `buildWindow` hands over. */
const msg = (mid, text, key = `k${mid}`) => ({ mid, key, name: 'Narrator', text });

const CHAT = [msg(0, 'zero'), msg(1, 'one'), msg(2, 'two'), msg(3, 'three'), msg(4, 'four'), msg(5, 'five')];

describe('resolveMark, a message index is only as good as the message under it', () => {
    test('no mark at all means the whole window is new', () => {
        expect(resolveMark(CHAT, {})).toBe(null);
        expect(resolveMark(CHAT, { mid: NaN, key: 'k3' })).toBe(null);
    });

    test('a mark whose message still hashes the same stands', () => {
        expect(resolveMark(CHAT, { mid: 3, key: 'k3' })).toBe(3);
    });

    test('a swiped message becomes new again', () => {
        // The single most common thing a user does to a chat. A bare mid would file the new
        // narration under "already recorded" and no pass would ever read it.
        expect(resolveMark(CHAT, { mid: 5, key: 'k5-old' })).toBe(4);
    });

    test('a mark on a message the branch no longer has is discarded, not guessed at', () => {
        // Re-reading is wasteful; skipping is wrong. The two are not symmetric, so the ambiguous
        // case resolves to re-reading.
        expect(resolveMark(CHAT, { mid: 99, key: 'k99' })).toBe(null);
    });

    test('a mark stored before keys were kept is trusted rather than thrown away', () => {
        expect(resolveMark(CHAT, { mid: 3, key: '' })).toBe(3);
    });
});

describe('splitWindow, the model may read the run-up and may not bill it', () => {
    test('with no mark, everything is new, and the window reaches the opening', () => {
        // WAS: `size: 4` gave sources [2, 3, 4, 5]. A pass with no mark now reaches back to the
        // start instead of taking the tail, because the greeting is the one message no later pass
        // will ever see (`FIRST_WINDOW`). `size` still governs every pass after the first.
        const window = splitWindow(CHAT, { size: 4 });
        expect(window.sources.map(s => s.mid)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(window.context).toBe(0);
        expect(window.text).not.toContain(CONTEXT_HEADER);
        expect(window.text).toContain(NEW_HEADER);
    });

    test('the overlap is kept as context and excluded from the sources', () => {
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 3, key: 'k3' } });
        expect(window.sources.map(s => s.mid)).toEqual([4, 5]);
        expect(window.context).toBe(4);
        // Both halves reach the prompt, a beat whose setup is in the old half is unreadable
        // without it, which is why the window overlapped in the first place.
        expect(window.text).toContain('zero');
        expect(window.text).toContain('five');
        expect(window.text.indexOf(CONTEXT_HEADER)).toBeLessThan(window.text.indexOf(NEW_HEADER));
    });

    test('the mention gate reads the new half only', () => {
        // The gate and the billing rule have to agree: if a beat narrated only in the context half
        // may not be recorded, the excerpt that licenses a change is the same half that anchors it.
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 3, key: 'k3' } });
        expect(window.newText).toBe('Narrator: four\n\nNarrator: five');
        expect(window.newText).not.toContain('three');
    });

    test('nothing new leaves no sources at all, rather than an old anchor', () => {
        // `chronicle.applyExtraction` attributes every event to the last source, so handing back a
        // stale one would anchor new claims on a message already read. The caller declines instead.
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 5, key: 'k5' } });
        expect(window.sources).toEqual([]);
        expect(window.context).toBe(6);
    });

    test('the trailing size still bounds the whole window, mark or no mark', () => {
        const window = splitWindow(CHAT, { size: 2, mark: { mid: 0, key: 'k0' } });
        expect(window.sources.map(s => s.mid)).toEqual([4, 5]);
        // mid 0 is outside the trailing two, so there is no context half to show.
        expect(window.context).toBe(0);
    });

    test('`seen` reports every mid the model was shown, both halves', () => {
        // `sources` is the new half, what may anchor an event. `seen` is the whole window, what
        // the model could be RE-telling, which is a different question and the one the
        // already-recorded gate needs answered (`state-table.js` `validateInventory`).
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 3, key: 'k3' } });
        expect(window.seen).toEqual([0, 1, 2, 3, 4, 5]);
        expect(window.sources.map(s => s.mid)).toEqual([4, 5]);
    });

    test('`seen` is bounded by the trailing size, like the rest of the window', () => {
        const window = splitWindow(CHAT, { size: 2, mark: { mid: 0, key: 'k0' } });
        expect(window.seen).toEqual([4, 5]);
    });

    test('a window with nothing new still reports what it showed', () => {
        // The pass declines, but if a later one runs on the same tail the mids it displayed are
        // still the mids that could be re-told.
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 5, key: 'k5' } });
        expect(window.sources).toEqual([]);
        expect(window.seen).toEqual([0, 1, 2, 3, 4, 5]);
    });
});

describe('the first pass reads the opening, because nothing else ever will', () => {
    // What message 0 costs when nobody reads it.
    //
    // Cards put the premise, the character sheet and the starting equipment in the greeting. The
    // live Wuxia World RPG opens with, in plain lines:
    //
    //     Chí Guāngdé's LEVEL: 5 (Qi Gathering Stage)
    //     STORAGE RING: 1x Medicinal Pill (Heals 50 Health instantly.) - 1x Basic Iron Sword
    //
    // Neither ever reached the ledger. `absorb` could not read it, `findStateBlock` matches three
    // wrappers and this card uses none, and the extraction model never got the chance, because
    // `MIN_INTERVAL` is 2 and the window is the trailing 6, so the first pass anchored at mid 8 and
    // read mids 3-8. Message 0 fell out before anything looked at it. Measured across the corpus:
    // My Hero Academia lost 5 messages that way, this Wuxia run 3, Royal Succession 2.
    //
    // The opening also has to land in the NEW half. `CONTEXT_HEADER` says "extract nothing from
    // this", so a greeting shown as background is a greeting still nobody reads.

    const long = n => Array.from({ length: n }, (_, at) => msg(at, `line ${at}`));

    test('with no mark, a fresh chat is read from the start', () => {
        const window = splitWindow(long(9), {});
        expect(window.seen[0]).toBe(0);
        expect(window.seen).toHaveLength(9);
    });

    test('and every message it reads may anchor an event', () => {
        // In `sources`, not the context half, otherwise the instruction forbids extracting from it.
        const window = splitWindow(long(9), {});
        expect(window.sources.map(s => s.mid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        expect(window.context).toBe(0);
        expect(window.text).not.toContain(CONTEXT_HEADER);
    });

    test('once there is a mark it is the trailing window again, unchanged', () => {
        // The reach-back is for the pass that has never run. Every pass after it works as before,
        // or the prompt would grow without bound.
        const window = splitWindow(long(20), { mark: { mid: 14, key: 'k14' } });
        expect(window.seen).toEqual([14, 15, 16, 17, 18, 19]);
        expect(window.sources.map(s => s.mid)).toEqual([15, 16, 17, 18, 19]);
    });

    test('a chat fold was enabled on late is bounded, not sent whole', () => {
        // The case the corpus supplies: one live Wuxia chat has 277 messages and a first anchor of
        // 266, so reading "from the start" unbounded would have put 266 messages in one prompt.
        const window = splitWindow(long(300), {});
        expect(window.seen).toHaveLength(FIRST_WINDOW);
        expect(window.seen[0]).toBe(300 - FIRST_WINDOW);
    });

    test('FIRST_WINDOW clears every fresh chat in the corpus with room to spare', () => {
        // Worst fresh-chat first anchor measured: 10 (My Hero Academia).
        expect(FIRST_WINDOW).toBeGreaterThanOrEqual(20);
    });

    test('what it could not reach is reported, not silently dropped', () => {
        // The lesson of this whole class: `absorb` failing open said nothing for three campaigns.
        expect(splitWindow(long(300), {}).unread).toBe(300 - FIRST_WINDOW);
        expect(splitWindow(long(9), {}).unread).toBe(0);
        // Only the FIRST pass can leave anything unread. Once a mark exists everything below it was
        // read by the pass that set it, however far outside this window it now sits.
        expect(splitWindow(long(20), { mark: { mid: 14, key: 'k14' } }).unread).toBe(0);
    });
});

/**
 * A repaired reply is not a whole reply, and the difference is always the same probes.
 *
 * `json-parse.js` Tier 3 closes the unbalanced brackets of a cut-off reply and returns
 * `{value: repaired, truncated: true}`. That is the right thing for the parser to do, everything
 * the model managed to say is in there. It is the wrong thing for the RETRY LOOP to treat as
 * success, and it did: the loop's condition was
 *
 *     if (analysis.value || (!analysis.empty && !analysis.truncated)) break;
 *
 * so a repaired-truncated reply had a truthy `value`, broke the loop, and was used, never earning
 * the tripled budget that `RETRY_GROWTH` exists to spend on exactly this failure.
 *
 * The casualties are not random. The model emits properties in schema order and the probes are
 * assembled in registration order (`events`, `scene`, `threads`, `review`, `entities`, `world`), so
 * a cut-off reply always loses the TAIL. A probe whose key never arrived reads `undefined` at the
 * apply loop and no-ops in silence, which is indistinguishable from "the model had nothing to say".
 *
 * Two decisions, moved here out of the app layer so they can be gated at all: whether the loop is
 * finished, and which probes went missing when it is.
 */
describe('extractionSettled', () => {
    test('a whole reply is settled and must not be retried', () => {
        expect(extractionSettled({ value: { a: 1 }, truncated: false, empty: false })).toBe(true);
    });

    test('a REPAIRED-truncated reply is not settled, this is the bug', () => {
        // The exact shape `json-parse.js` Tier 3 returns. It has a value AND it was cut off.
        expect(extractionSettled({ value: { events: {} }, truncated: true, empty: false })).toBe(false);
    });

    test('an unrepairable truncated reply is not settled', () => {
        expect(extractionSettled({ value: null, truncated: true, empty: false })).toBe(false);
    });

    test('an empty reply is not settled, transient, worth another ask', () => {
        expect(extractionSettled({ value: null, truncated: false, empty: true })).toBe(false);
    });

    test('unparseable IS settled, a retry returns the same garbage', () => {
        // Structural: schema, prompt or model. The loop's own docblock argues this and it stays.
        expect(extractionSettled({ value: null, truncated: false, empty: false })).toBe(true);
    });

    test('nothing at all is not settled', () => {
        expect(extractionSettled(null)).toBe(false);
        expect(extractionSettled(undefined)).toBe(false);
    });
});

describe('missingProbes', () => {
    const KEYS = ['events', 'scene', 'threads', 'review', 'entities', 'world'];

    test('names the tail a truncated reply dropped', () => {
        const parsed = { events: {}, scene: {}, threads: {} };
        expect(missingProbes(parsed, KEYS)).toEqual(['review', 'entities', 'world']);
    });

    test('a whole reply is missing nothing', () => {
        const parsed = Object.fromEntries(KEYS.map(key => [key, {}]));
        expect(missingProbes(parsed, KEYS)).toEqual([]);
    });

    test('a key present but empty is NOT missing, silence is an answer', () => {
        // `{}` and `[]` are what a probe with nothing to report legitimately sends. Only `undefined`
        // means the key never arrived, and conflating the two would turn every quiet pass into a
        // reported failure.
        expect(missingProbes({ events: {}, scene: [], threads: null }, ['events', 'scene', 'threads'])).toEqual([]);
    });

    test('no reply at all is every probe missing', () => {
        expect(missingProbes(null, KEYS)).toEqual(KEYS);
    });
});
