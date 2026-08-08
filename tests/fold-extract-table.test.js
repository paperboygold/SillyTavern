import { describe, expect, test } from '@jest/globals';

import {
    CONTEXT_HEADER,
    NEW_HEADER,
    resolveMark,
    splitWindow,
} from '../public/scripts/extensions/fold/extract-table.js';

/** A message in the shape `buildWindow` hands over. */
const msg = (mid, text, key = `k${mid}`) => ({ mid, key, name: 'Narrator', text });

const CHAT = [msg(0, 'zero'), msg(1, 'one'), msg(2, 'two'), msg(3, 'three'), msg(4, 'four'), msg(5, 'five')];

describe('resolveMark — a message index is only as good as the message under it', () => {
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

describe('splitWindow — the model may read the run-up and may not bill it', () => {
    test('with no mark, everything in the window is new', () => {
        const window = splitWindow(CHAT, { size: 4 });
        expect(window.sources.map(s => s.mid)).toEqual([2, 3, 4, 5]);
        expect(window.context).toBe(0);
        expect(window.text).not.toContain(CONTEXT_HEADER);
        expect(window.text).toContain(NEW_HEADER);
    });

    test('the overlap is kept as context and excluded from the sources', () => {
        const window = splitWindow(CHAT, { size: 6, mark: { mid: 3, key: 'k3' } });
        expect(window.sources.map(s => s.mid)).toEqual([4, 5]);
        expect(window.context).toBe(4);
        // Both halves reach the prompt — a beat whose setup is in the old half is unreadable
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
});
