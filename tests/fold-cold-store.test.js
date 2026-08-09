import { describe, expect, test } from '@jest/globals';

import { MAX_THREADS, foldThreads } from '../public/scripts/extensions/fold/thread-table.js';
import { isMentioned } from '../public/scripts/extensions/fold/state-table.js';

// The cold store's browser half (cold-store.js) cannot be imported by jest — it pulls in store.js,
// which touches chat_metadata. But its two load-bearing ideas are pure and are exercised here:
//
//  1. EVICTION RETURNS THE ROW (foldThreads) — the cap never destroys, it hands the row up so the
//     storage layer can demote it.
//  2. RECALL IS BY COVERAGE (isMentioned, which cold-store.covered calls) — the window mentioning
//     the subject admits it; a resemblance without a mention does not ([ROUTER]).
//
// The loop under test is exactly what cold-store.demote -> covered -> promote performs, inlined.

describe('cold store contract — eviction returns, recall is by coverage', () => {
    test('a full table returns the evicted row whole instead of destroying it', () => {
        const table = new Map();
        for (let i = 0; i < MAX_THREADS; i++) {
            foldThreads(table, [{ name: `thread ${i}`, open: 'unresolved' }], { turn: 1 });
        }
        const { accepted, evicted } = foldThreads(
            table,
            [{ name: 'the courier killer', open: 'who and why' }],
            { turn: 34 },
        );
        expect(accepted).toBe(1);
        expect(evicted).toHaveLength(1);
        // The evicted row is whole — a thread is still a thread — so a later recall can restore it.
        expect(evicted[0].row.name).toBe('thread 0');
        expect(evicted[0].row.open).toBe('unresolved');
        expect(table.has('thread 0')).toBe(false);
        expect(table.has('the courier killer')).toBe(true);
    });

    test('a cold row is recalled when the window mentions its subject', () => {
        // The shape cold.demote stores: the thread's name and keywords survive the demotion.
        const coldRow = {
            key: 'investigate the courier\'s death',
            row: {
                name: 'investigate the courier\'s death',
                kw: ['courier', 'death', 'mill dock'],
                open: 'who and why',
            },
        };
        const windowText = 'The courier was pulled from the river at the old mill dock.';
        const subjects = [coldRow.row.name, coldRow.row.aka, coldRow.row.about, ...(coldRow.row.kw || [])]
            .filter(Boolean);
        // covered() admits when any subject is mentioned — the keyword "courier" is in the window.
        expect(subjects.some(subject => isMentioned(subject, windowText))).toBe(true);
    });

    test('a cold row is NOT recalled by a window that merely resembles it', () => {
        const coldRow = {
            key: 'investigate the courier\'s death',
            row: { name: 'investigate the courier\'s death', kw: ['courier', 'death', 'mill dock'] },
        };
        const unrelated = 'The week settles into a rhythm of early mornings and quiet evenings.';
        const subjects = [coldRow.row.name, coldRow.row.aka, coldRow.row.about, ...(coldRow.row.kw || [])]
            .filter(Boolean);
        expect(subjects.some(subject => isMentioned(subject, unrelated))).toBe(false);
    });

    test('a possessive subject is recalled by the plain mention the window uses', () => {
        // "investigate the courier's death" stores keywords that include "courier"; a window that
        // says "the courier" (no apostrophe) must still admit it.
        const kw = ['courier', 'death', 'mill dock'];
        expect(isMentioned('courier', 'the courier is gone')).toBe(true);
        expect(kw.some(k => isMentioned(k, 'the courier is gone'))).toBe(true);
    });
});
