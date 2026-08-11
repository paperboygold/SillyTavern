import { describe, expect, test } from '@jest/globals';

import {
    DUPLICATE_WINDOW,
    MAX_KEYWORDS,
    MAX_SUMMARY_CHARS,
    applyEvents,
    buildKeywordIndex,
    eventSignature,
    normalizeEvent,
    pruneEvents,
    rankEvents,
    renderEvents,
    selectEvictions,
    tokenize,
} from '../public/scripts/extensions/fold/chronicle-table.js';

/**
 * Build an event table from [key, summary, keywords] triples.
 * @param {Array<[string, string, string[]]>} rows Rows.
 * @param {number} [startTime] Base timestamp; each row is one ms later.
 * @returns {Map<string, object>} The ledger.
 */
function ledger(rows, startTime = 1000) {
    return new Map(rows.map(([key, s, kw], i) => [key, { s, kw, t: startTime + i, src: 'llm' }]));
}

describe('normalizeEvent', () => {
    test('accepts both the wire shape and the stored shape', () => {
        expect(normalizeEvent({ summary: 'A thing happened', keywords: ['Thing'] }, { now: 5 }))
            // `dropped` is transient — the caller counts it and strips it before storage, so it
            // never reaches the ledger. It exists so a genuine clip can be told apart from a model
            // that returned exactly the cap because the prompt asked for exactly the cap.
            .toEqual({ s: 'A thing happened', kw: ['thing'], t: 5, src: 'llm', dropped: 0 });
        expect(normalizeEvent({ s: 'A thing happened', kw: ['thing'] }, { now: 5 }).s)
            .toBe('A thing happened');
    });

    test('rejects anything without a usable summary', () => {
        for (const bad of [null, undefined, {}, { summary: '   ' }, { summary: 42 }, { summary: {} }]) {
            expect(normalizeEvent(bad)).toBeNull();
        }
    });

    test('rejects an event that no query could ever retrieve', () => {
        // No usable keywords and a summary with no salient tokens: it would sit in the ledger
        // consuming budget and surfacing to nobody.
        expect(normalizeEvent({ summary: '!!! ...', keywords: [] })).toBeNull();
    });

    test('bounds summary length and keyword count', () => {
        const event = normalizeEvent({
            summary: 'x'.repeat(500),
            keywords: Array.from({ length: 20 }, (_, i) => `kw${i}`),
        });
        expect(event.s).toHaveLength(MAX_SUMMARY_CHARS);
        expect(event.kw).toHaveLength(MAX_KEYWORDS);
    });

    test('lowercases and dedups keywords', () => {
        expect(normalizeEvent({ summary: 'x', keywords: ['Dragon', 'dragon', 'DRAGON', 'sword'] }).kw)
            .toEqual(['dragon', 'sword']);
    });

    test('falls back to summary tokens when the model returns no keywords', () => {
        // An event with no keywords would be unreachable by retrieval — dead weight in the ledger.
        // The fallback tokenizes the summary structurally (length filter only; no English stoplist).
        const event = normalizeEvent({ summary: 'The party defeated the ancient dragon', keywords: [] });
        expect(event.kw.length).toBeGreaterThan(0);
        expect(event.kw).toContain('dragon');
        expect(event.kw).toContain('the');
    });

    test('records mid only when it is an integer', () => {
        expect(normalizeEvent({ summary: 'x', keywords: ['k'] }, { mid: 3 }).mid).toBe(3);
        expect(normalizeEvent({ summary: 'x', keywords: ['k'] }, { mid: undefined })).not.toHaveProperty('mid');
    });
});

describe('tokenize', () => {
    test('keeps content words and drops short noise — no English stoplist', () => {
        // The old 90-word English stoplist is gone: the events carry model-chosen keywords, so a
        // function word in the query ("the", "went") never matches an event keyword anyway. Only
        // the structural length filter survives — it means the same in every language.
        expect(tokenize('The party went to the Dragon Keep'))
            .toEqual(['the', 'party', 'went', 'the', 'dragon', 'keep']);
    });

    test('is total over junk input', () => {
        expect(tokenize(null)).toEqual([]);
        expect(tokenize('!!! ... ???')).toEqual([]);
        expect(tokenize('a an to')).toEqual([]);
    });
});

describe('buildKeywordIndex — the Graph face', () => {
    test('maps each keyword to every event carrying it, in insertion order', () => {
        const events = ledger([
            ['a', 'Dragon slain', ['dragon', 'battle']],
            ['b', 'Dragon egg found', ['dragon', 'egg']],
        ]);
        const index = buildKeywordIndex(events);
        expect(index.get('dragon')).toEqual(['a', 'b']);
        expect(index.get('egg')).toEqual(['b']);
        expect(index.get('absent')).toBeUndefined();
    });

    test('is empty for an empty ledger', () => {
        expect(buildKeywordIndex(new Map()).size).toBe(0);
    });

    test('multi-word keywords are indexed by their tokens', () => {
        // Real models return keywords like "silver coins". Queries are tokenized into single
        // words, so a verbatim index would leave those permanently unreachable.
        const events = ledger([['a', 'Paid the ferryman', ['silver coins', 'ferryman']]]);
        const index = buildKeywordIndex(events);
        expect(index.get('silver')).toEqual(['a']);
        expect(index.get('coins')).toEqual(['a']);
        expect(index.get('ferryman')).toEqual(['a']);
    });

    test('a repeated token does not list the same event twice', () => {
        // Double-listing would silently double that event's overlap score.
        const events = ledger([['a', 'x', ['dragon', 'dragon hoard']]]);
        expect(buildKeywordIndex(events).get('dragon')).toEqual(['a']);
    });

    test('short keywords that tokenize away are still indexed verbatim', () => {
        const events = ledger([['a', 'x', ['axe']]]);
        expect(buildKeywordIndex(events).get('axe')).toEqual(['a']);
    });
});

describe('multi-word keyword retrieval', () => {
    test('an event is retrievable by any word of a multi-word keyword', () => {
        const events = ledger([['a', 'Paid the ferryman in silver', ['silver coins']]]);
        const kwIndex = buildKeywordIndex(events);
        expect(rankEvents({ events, kwIndex, queryText: 'where did the silver go?' }))
            .toHaveLength(1);
        expect(rankEvents({ events, kwIndex, queryText: 'how many coins?' }))
            .toHaveLength(1);
    });
});

describe('eventSignature', () => {
    test('is order-independent, so restating an event matches it', () => {
        expect(eventSignature({ kw: ['b', 'a'] })).toBe(eventSignature({ kw: ['a', 'b'] }));
    });

    test('is total over malformed events', () => {
        expect(eventSignature({})).toBe('');
        expect(eventSignature(null)).toBe('');
    });
});

describe('rankEvents', () => {
    const events = ledger([
        ['a', 'The party defeated the dragon', ['dragon', 'battle', 'victory']],
        ['b', 'They bought rope in town', ['rope', 'town']],
        ['c', 'A dragon egg was discovered', ['dragon', 'egg']],
    ]);
    const kwIndex = buildKeywordIndex(events);

    test('ranks by keyword overlap', () => {
        const ranked = rankEvents({ events, kwIndex, queryText: 'what happened with the dragon battle?' });
        expect(ranked[0].key).toBe('a');
        expect(ranked[0].overlap).toBe(2);
        expect(ranked.map(r => r.key)).toContain('c');
        expect(ranked.map(r => r.key)).not.toContain('b');
    });

    test('returns nothing when no keyword matches', () => {
        expect(rankEvents({ events, kwIndex, queryText: 'unrelated musings' })).toEqual([]);
    });

    test('respects topK', () => {
        expect(rankEvents({ events, kwIndex, queryText: 'dragon', topK: 1 })).toHaveLength(1);
    });

    test('liveHashes filters out events from abandoned branches', () => {
        // The whole branch-awareness mechanism is this one lookup: an event whose source content
        // is no longer in the chat is invisible, without being destroyed.
        const live = new Map([['c', true]]);
        const ranked = rankEvents({ events, kwIndex, queryText: 'dragon', liveHashes: live });
        expect(ranked.map(r => r.key)).toEqual(['c']);
    });

    test('an absent liveHashes means no filtering', () => {
        expect(rankEvents({ events, kwIndex, queryText: 'dragon', liveHashes: null }).length).toBe(2);
    });

    test('liveness follows the source key, not the table key', () => {
        // A batch of several events extracted from one message gets distinct table keys but shares
        // one source. Judging liveness by the table key made every multi-event batch invisible the
        // moment it was written.
        const batch = new Map([
            ['SRC:0', { s: 'First finding', kw: ['dragon'], t: 1, src: 'llm', k: 'SRC' }],
            ['SRC:1', { s: 'Second finding', kw: ['dragon'], t: 2, src: 'llm', k: 'SRC' }],
        ]);
        const index = buildKeywordIndex(batch);
        const live = new Map([['SRC', true]]);

        const ranked = rankEvents({ events: batch, kwIndex: index, queryText: 'dragon', liveHashes: live });
        expect(ranked.map(r => r.key).sort()).toEqual(['SRC:0', 'SRC:1']);

        // And when the source leaves the branch, the whole batch goes with it.
        expect(rankEvents({ events: batch, kwIndex: index, queryText: 'dragon', liveHashes: new Map() }))
            .toEqual([]);
    });
});

describe('applyEvents — two dedup layers', () => {
    test('a repeat of the same key overwrites rather than duplicating', () => {
        const events = ledger([['a', 'First version', ['x']]]);
        const result = applyEvents({
            events,
            incoming: [{ key: 'a', event: { s: 'Second version', kw: ['x'], t: 2, src: 'llm' } }],
        });
        expect(result.events.size).toBe(1);
        expect(result.events.get('a').s).toBe('Second version');
        expect(result.replaced).toEqual(['a']);
        expect(result.added).toEqual([]);
    });

    test('a new key with an already-seen keyword signature is dropped as a duplicate', () => {
        const events = ledger([['a', 'Dragon slain', ['battle', 'dragon']]]);
        const result = applyEvents({
            events,
            incoming: [{ key: 'b', event: { s: 'The dragon was slain', kw: ['dragon', 'battle'], t: 2, src: 'llm' } }],
        });
        expect(result.events.size).toBe(1);
        expect(result.duplicates).toEqual(['b']);
    });

    test('a recurrence outside the recency window is kept', () => {
        // The same keywords appearing much later is usually a genuine recurrence, not a
        // duplicate extraction.
        const filler = Array.from({ length: DUPLICATE_WINDOW + 2 }, (_, i) =>
            [`f${i}`, `Filler ${i}`, [`k${i}`]]);
        const events = ledger([['a', 'Dragon slain', ['battle', 'dragon']], ...filler]);
        const result = applyEvents({
            events,
            incoming: [{ key: 'z', event: { s: 'Another dragon battle', kw: ['dragon', 'battle'], t: 99, src: 'llm' } }],
        });
        expect(result.added).toEqual(['z']);
    });

    test('does not mutate the ledger it was given', () => {
        const events = ledger([['a', 'One', ['x']]]);
        applyEvents({ events, incoming: [{ key: 'b', event: { s: 'Two', kw: ['y'], t: 2, src: 'llm' } }] });
        expect(events.size).toBe(1);
    });

    test('skips malformed entries without throwing', () => {
        const result = applyEvents({
            events: new Map(),
            incoming: [{ key: '', event: null }, { key: 'ok', event: { s: 'Fine', kw: ['k'], t: 1, src: 'llm' } }],
        });
        expect(result.added).toEqual(['ok']);
    });
});

describe('eviction', () => {
    test('keeps events that keep proving useful', () => {
        const events = ledger([
            ['old_useful', 'Referenced often', ['a']],
            ['old_ignored', 'Never referenced', ['b']],
            ['new_ignored', 'Recent but unused', ['c']],
        ]);
        const hits = new Map([['old_useful', 5]]);
        // Everything live, so retrieval history is what decides.
        const live = new Map([['old_useful', true], ['old_ignored', true], ['new_ignored', true]]);
        const victims = selectEvictions({ events, hits, liveHashes: live, count: 1 });
        expect(victims).toEqual(['old_ignored']);
    });

    test('events off the live branch are evicted first', () => {
        const events = ledger([['dead', 'From an abandoned swipe', ['a']], ['live', 'Current', ['b']]]);
        const live = new Map([['live', true]]);
        expect(selectEvictions({ events, hits: new Map(), liveHashes: live, count: 1 })).toEqual(['dead']);
    });

    test('pruneEvents is a no-op below the cap', () => {
        const events = ledger([['a', 'One', ['x']]]);
        const result = pruneEvents({ events, hits: new Map(), max: 10 });
        expect(result.evicted).toEqual([]);
        expect(result.events).toBe(events);
    });

    test('pruneEvents trims down to the cap', () => {
        const events = ledger(Array.from({ length: 10 }, (_, i) => [`k${i}`, `E${i}`, [`w${i}`]]));
        const result = pruneEvents({ events, hits: new Map(), max: 4 });
        expect(result.events.size).toBe(4);
        expect(result.evicted).toHaveLength(6);
    });
});

describe('renderEvents', () => {
    test('renders a bulleted block through the template', () => {
        const ranked = [{ event: { s: 'The dragon fell' } }, { event: { s: 'Rope was bought' } }];
        expect(renderEvents(ranked, 'Past:\n{{text}}'))
            .toBe('Past:\n- The dragon fell\n- Rope was bought');
    });

    test('renders nothing at all when there are no events', () => {
        // An empty header spends tokens telling the model nothing.
        expect(renderEvents([], 'Past:\n{{text}}')).toBe('');
    });
});

/*
 * Silent losses. Extraction runs on overlapping windows, so the same message is often read twice —
 * and the second reading may summarise an event without re-proposing the state change the first one
 * caught. Under plain last-write that quietly un-does the change, leaving the state fold disagreeing
 * with the story that produced it, with nothing anywhere recording that it happened.
 */
describe('replacing an event does not retract its delta', () => {
    const withDelta = {
        s: 'Solomon pockets the signet ring', kw: ['signet', 'ring', 'pocket'],
        d: { inv: [{ item: 'signet ring', dq: 1, at: 'carried' }] },
    };

    test('a re-read that mentions no delta keeps the one already recorded', () => {
        const first = applyEvents({ events: new Map(), incoming: [{ key: 'k', event: withDelta }] });
        const again = applyEvents({
            events: first.events,
            incoming: [{ key: 'k', event: { s: 'Solomon pockets the ring', kw: ['signet', 'ring'] } }],
        });

        expect(again.replaced).toEqual(['k']);
        expect(again.events.get('k').d).toEqual(withDelta.d);
        // The summary itself is still superseded — only the omission is refused.
        expect(again.events.get('k').s).toBe('Solomon pockets the ring');
    });

    test('a replacement that DOES carry a delta supersedes the old one', () => {
        const first = applyEvents({ events: new Map(), incoming: [{ key: 'k', event: withDelta }] });
        const corrected = { s: 'Solomon leaves the ring', kw: ['signet', 'ring'], d: { inv: [] } };
        const again = applyEvents({ events: first.events, incoming: [{ key: 'k', event: corrected }] });

        expect(again.events.get('k').d).toEqual({ inv: [] });
    });

    test('an event that never had a delta does not acquire one', () => {
        const bare = { s: 'they talk', kw: ['talk', 'hall'] };
        const first = applyEvents({ events: new Map(), incoming: [{ key: 'k', event: bare }] });
        const again = applyEvents({ events: first.events, incoming: [{ key: 'k', event: bare }] });
        expect(again.events.get('k').d).toBeUndefined();
    });
});
