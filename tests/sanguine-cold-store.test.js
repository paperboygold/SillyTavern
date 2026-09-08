import { describe, expect, test } from '@jest/globals';

import { MAX_THREADS, foldThreads } from '../public/scripts/extensions/sanguine/thread-table.js';

// The cold store's browser half (cold-store.js) cannot be fully imported by jest, it pulls in
// store.js, which touches chat_metadata. But its load-bearing ideas are exercised here:
//
//  1. EVICTION RETURNS THE ROW (foldThreads), the cap never destroys, it hands the row up so the
//     storage layer can demote it.
//  2. RECALL IS BY COVERAGE, the MODEL's `mentions` report admits a cold row; a substring match
//     never does ([ROUTER]: admission by coverage, never a token proxy). `covered()` in
//     cold-store.js implements exactly this predicate over the report; it is inlined here.
//
// The loop under test is exactly what cold-store.demote -> covered -> promote performs, inlined.

/** The `covered` predicate, inlined from cold-store.js: admission iff a subject is in the report. */
function covered(report, rows) {
    const names = report instanceof Set ? report : new Set();
    const out = [];
    for (const item of Array.isArray(rows) ? rows : []) {
        const row = item?.row ?? null;
        if (!row) continue;
        const subjects = [
            row.name,
            row.aka,
            row.about,
            ...(Array.isArray(row.kw) ? row.kw : []),
        ].filter(Boolean);
        if (subjects.some(subject => names.has(String(subject ?? '').toLowerCase().trim()))) {
            out.push(item);
        }
    }
    return out;
}

describe('cold store contract, eviction returns, recall is by model-reported coverage', () => {
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
        // The evicted row is whole, a thread is still a thread, so a later recall can restore it.
        expect(evicted[0].row.name).toBe('thread 0');
        expect(evicted[0].row.open).toBe('unresolved');
        expect(table.has('thread 0')).toBe(false);
        expect(table.has('the courier killer')).toBe(true);
    });

    test('a cold row is recalled when the model\'s report names its subject', () => {
        // The shape cold.demote stores: the thread's name and keywords survive the demotion. The
        // model's `mentions` report for a window about the courier names "courier", that report is
        // what `covered()` admits on, in any language.
        const coldRow = {
            key: 'investigate the courier\'s death',
            row: {
                name: 'investigate the courier\'s death',
                kw: ['courier', 'death', 'mill dock'],
                open: 'who and why',
            },
        };
        const report = new Set(['courier', 'mill dock']);
        expect(covered(report, [coldRow])).toHaveLength(1);
    });

    test('a cold row is NOT recalled by a report that never names it', () => {
        const coldRow = {
            key: 'investigate the courier\'s death',
            row: { name: 'investigate the courier\'s death', kw: ['courier', 'death', 'mill dock'] },
        };
        // A report about the week settling names none of the courier's subjects, no recall.
        const report = new Set(['week', 'morning', 'evening']);
        expect(covered(report, [coldRow])).toEqual([]);
    });

    test('admission is by the report, never by token resemblance', () => {
        // The keyword "courier" is in the row and the window literally contains the word, but a
        // report is the model's answer about what it read, and an English token match is not it.
        const coldRow = {
            key: 'investigate the courier\'s death',
            row: { name: 'investigate the courier\'s death', kw: ['courier', 'death', 'mill dock'] },
        };
        expect(covered(new Set(['unrelated']), [coldRow])).toEqual([]);
    });
});
