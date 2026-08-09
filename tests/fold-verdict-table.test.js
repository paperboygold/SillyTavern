import { describe, expect, test } from '@jest/globals';

import {
    CLEAR,
    COST,
    FAILED,
    SETBACK,
    UNTRIED,
    WORKED,
    adjudicate,
    matchThread,
    precedentFor,
    standingRange,
} from '../public/scripts/extensions/fold/verdict-table.js';

/*
 * Phase E — the judge plays. Two bodies of work: a SETBACK no longer ticks a random clock (it ticks
 * the thread the attempt was actually about, or none), and the bands are deterministic arithmetic on
 * the standing the classifier returns — so the §6 fixtures can be asserted offline, without a model.
 */
describe('matchThread — a setback ticks the thread it was about', () => {
    // The `snapshot` shape: flat filled/size/kind plus name/about/detail.
    const dials = [
        { name: 'the residency window closes', about: 'twelve months pass with fewer than twenty raids logged', filled: 1, size: 8, kind: 'doom' },
        { name: 'Kang\'s standing offer', detail: 'they run D-rank raids almost daily', filled: 2, size: 6, kind: 'doom' },
        { name: 'the missing hunter in Busan', filled: 0, size: 6, kind: 'doom' },
    ];

    test('keywords pick the thread they describe', () => {
        const hit = matchThread(dials, { keywords: ['busan'], against: '' });
        expect(hit?.name).toBe('the missing hunter in Busan');
    });

    test('the against name outweighs an ordinary keyword', () => {
        // "Kang" appears only in Kang's own thread; the weight lifts it over the residency window
        // even though both share the "raids" keyword.
        const hit = matchThread(dials, { keywords: ['raids'], against: 'kang' });
        expect(hit?.name).toBe('Kang\'s standing offer');
    });

    test('no match returns null — a mis-aimed tick is worse than none', () => {
        expect(matchThread(dials, { keywords: ['cooking', 'noodles'], against: '' })).toBeNull();
    });

    test('a full dial is never the victim', () => {
        const full = [{ name: 'the doom done', filled: 6, size: 6, kind: 'doom' }, ...dials];
        const hit = matchThread(full, { keywords: ['busan'], against: '' });
        expect(hit?.name).toBe('the missing hunter in Busan');
        expect(hit?.name).not.toBe('the doom done');
    });

    test('empty inputs return null', () => {
        expect(matchThread([], { keywords: [], against: '' })).toBeNull();
        expect(matchThread(null, {})).toBeNull();
    });
});

describe('the bands on the fixtures §6 names', () => {
    test('the mid-35 leap — an E-rank with a wounded calf vaults a rank of goblins — is not CLEAR', () => {
        // Nothing on record makes vaulting a charging rank possible, the goblins resist, and the
        // leap ignores a wound the ledger carries: opposed-and-reckless, exactly the §6 example.
        const verdict = adjudicate(
            { supported: false, opposed: true, reckless: true, keywords: ['vault', 'goblins'] },
            { momentum: 0, hurt: 1, precedent: 'untried' },
        );
        expect(verdict.band).not.toBe(CLEAR);
        expect(verdict.band).toBe(SETBACK);
    });

    test('the crate-kill — supported by the crate, opposed by the goblin — is not CLEAR', () => {
        // The crate is on record (support), but the goblin resists: the interval straddles, so the
        // partial band is the third action — it works, and it costs something.
        const verdict = adjudicate(
            { supported: true, opposed: true, reckless: false, keywords: ['crush', 'crate'] },
            { momentum: 0, hurt: 0, precedent: 'untried' },
        );
        expect(verdict.band).not.toBe(CLEAR);
        expect(verdict.band).toBe(COST);
    });

    test('an unopposed, supported, uncomplicated action clears', () => {
        const verdict = adjudicate(
            { supported: true, opposed: false, reckless: false, keywords: ['pick up'] },
            { momentum: 0, hurt: 0, precedent: 'untried' },
        );
        expect(verdict.band).toBe(CLEAR);
    });

    test('precedent on record moves the interval — worked before lifts, failed before sinks', () => {
        const worked = standingRange(
            { supported: false, opposed: true, reckless: false },
            { momentum: 0, hurt: 0, precedent: 'worked' },
        );
        const failed = standingRange(
            { supported: false, opposed: true, reckless: false },
            { momentum: 0, hurt: 0, precedent: 'failed' },
        );
        expect(worked.lo).toBeGreaterThan(failed.lo);
    });

    test('precedentFor reads recorded outcomes, never the summary\'s English', () => {
        // The chronicle's summaries are model-written prose; a past attempt's result is decided in
        // code and recorded as `d.outcome` (chronicle.recordVerdictEvent). The old path regex-matched
        // "fail|refused|could not" against the summary — the same language-dependent guess the clock
        // used to make. Only the structured outcome counts now.
        const events = new Map([
            ['a', { kw: ['vault', 'goblins'], s: 'The hero vaulted the rank of goblins.', d: { outcome: 'worked' } }],
            ['b', { kw: ['vault', 'goblins'], s: 'Another goblin rank repulsed the attempt.', d: { outcome: 'failed' } }],
            // Overlapping keywords but no recorded outcome: no vote, whatever the summary says.
            ['c', { kw: ['vault', 'goblins'], s: 'The vault was refused outright and utterly lost.' }],
            ['d', { kw: ['vault', 'goblins'], s: 'The second rank threw them back.', d: { outcome: 'failed' } }],
        ]);
        expect(precedentFor(events, ['vault', 'goblins'])).toBe(FAILED);
        // A summary that LOOKS like a failure but was never adjudicated contributes nothing.
        expect(precedentFor(new Map([['c', events.get('c')]]), ['vault', 'goblins'])).toBe(UNTRIED);
        // One clean worked, nothing failed.
        expect(precedentFor(new Map([['a', events.get('a')]]), ['vault', 'goblins'])).toBe(WORKED);
        // No keyword overlap at all.
        expect(precedentFor(events, ['bargain', 'market'])).toBe(UNTRIED);
    });
});
