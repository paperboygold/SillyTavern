import { describe, expect, test } from './test-harness.js';

import {
    analyzeJson,
    balancedRegions,
    coerceExtraction,
    looksTruncated,
    parseLooseJson,
} from '../public/scripts/extensions/sanguine/json-parse.js';

describe('parseLooseJson', () => {
    test('tier 1: plain JSON', () => {
        expect(parseLooseJson('{"events":[{"summary":"x"}]}'))
            .toEqual({ events: [{ summary: 'x' }] });
    });

    test('tier 1: tolerates surrounding whitespace', () => {
        expect(parseLooseJson('\n  {"a":1}  \n')).toEqual({ a: 1 });
    });

    test('tier 2: JSON inside a fenced block', () => {
        expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(parseLooseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    });

    test('tier 2: fenced block with a preamble', () => {
        expect(parseLooseJson('Certainly! Here you go:\n```json\n{"a":1}\n```\nHope that helps.'))
            .toEqual({ a: 1 });
    });

    test('tier 3: a bare object embedded in prose', () => {
        expect(parseLooseJson('Sure thing: {"a":1} — let me know if you need more.'))
            .toEqual({ a: 1 });
    });

    test('nested objects survive', () => {
        expect(parseLooseJson('text {"a":{"b":2},"c":3} more'))
            .toEqual({ a: { b: 2 }, c: 3 });
    });

    test('recovers an object followed by prose containing a stray brace', () => {
        // A greedy /\{[\s\S]*\}/ spans to the LAST brace anywhere in the reply, so an emoticon
        // after the object was enough to produce invalid JSON and abandon the whole cycle.
        expect(parseLooseJson('Here you go: {"events":[]} — hope that helps :} cheers'))
            .toEqual({ events: [] });
    });

    test('handles two objects in one reply, preferring the richer one', () => {
        // Models that restate often emit an empty envelope alongside the real one.
        expect(parseLooseJson('{"events":[]}\n{"events":[{"summary":"a"}],"state":{}}'))
            .toEqual({ events: [{ summary: 'a' }], state: {} });
    });

    test('a brace inside a string value does not end the region', () => {
        expect(parseLooseJson('{"events":[{"summary":"he said }: hi"}]}'))
            .toEqual({ events: [{ summary: 'he said }: hi' }] });
    });

    test('an escaped quote does not end the string', () => {
        expect(parseLooseJson('{"summary":"she said \\"stop\\" }"}'))
            .toEqual({ summary: 'she said "stop" }' });
    });

    test('returns null when there is nothing usable', () => {
        for (const junk of ['', '   ', null, undefined, 'I cannot comply with that request.']) {
            expect(parseLooseJson(junk)).toBeNull();
        }
    });

    test('rejects valid JSON that is not an object', () => {
        // A bare scalar or array is not a probe envelope; treating it as one would mean
        // dispatching undefined fragments to every probe.
        for (const scalar of ['42', '"a string"', 'null', 'true']) {
            expect(parseLooseJson(scalar)).toBeNull();
        }
    });

    test('accepts the empty object SillyTavern substitutes for unusable output', () => {
        // generateRaw with returnInvalid:false hands back "{}" rather than the raw prose, so this
        // is the common shape of "the model said nothing useful" on chat-completion backends.
        expect(parseLooseJson('{}')).toEqual({});
    });

    test('malformed JSON inside a fence falls through rather than throwing', () => {
        expect(parseLooseJson('```json\n{not valid}\n```')).toBeNull();
    });
});

describe('balancedRegions', () => {
    test('finds each outermost region separately', () => {
        expect(balancedRegions('a {"x":1} b {"y":2} c')).toEqual(['{"x":1}', '{"y":2}']);
    });

    test('does not open or close a region on a brace inside a string', () => {
        expect(balancedRegions('{"s":"{ not a region }"}')).toEqual(['{"s":"{ not a region }"}']);
    });

    test('ignores an unterminated region', () => {
        expect(balancedRegions('{"a":1')).toEqual([]);
    });

    test('is total over junk', () => {
        expect(balancedRegions('')).toEqual([]);
        expect(balancedRegions('no braces here')).toEqual([]);
    });
});

describe('looksTruncated — retryable, as distinct from garbage', () => {
    test('detects a reply cut off mid-object', () => {
        expect(looksTruncated('{"events":[{"summary":"The party reached the')).toBe(true);
    });

    test('detects a reply cut off inside a string', () => {
        expect(looksTruncated('{"summary":"half a sen')).toBe(true);
    });

    test('a complete object is not truncated', () => {
        expect(looksTruncated('{"events":[]}')).toBe(false);
    });

    test('prose with no structure at all is not truncated, it is garbage', () => {
        // The distinction that matters: retry the first, give up on the second.
        expect(looksTruncated('I am sorry, I cannot comply with that request.')).toBe(false);
    });

    test('analyzeJson reports truncation alongside a null value', () => {
        const analysis = analyzeJson('{"events":[{"summary":"cut off here');
        expect(analysis.value).toBeNull();
        expect(analysis.truncated).toBe(true);
    });

    test('analyzeJson does not claim truncation when it recovered a value', () => {
        const analysis = analyzeJson('sure: {"events":[]} and then some rambling {');
        expect(analysis.value).toEqual({ events: [] });
        expect(analysis.truncated).toBe(false);
    });
});

describe('coerceExtraction', () => {
    // The two request paths return different shapes: generateRaw hands back a string, while a
    // connection-profile request with json_schema hands back already-parsed content.
    test('passes an already-parsed object straight through', () => {
        const parsed = { events: [{ summary: 'x' }] };
        expect(coerceExtraction(parsed)).toBe(parsed);
    });

    test('parses a string through the loose parser', () => {
        expect(coerceExtraction('```json\n{"events":[]}\n```')).toEqual({ events: [] });
    });

    test('rejects arrays, which are never a valid probe envelope', () => {
        expect(coerceExtraction([{ summary: 'x' }])).toBeNull();
    });

    test('rejects nothing-shaped values', () => {
        for (const junk of [null, undefined, 42, true, 'not json at all']) {
            expect(coerceExtraction(junk)).toBeNull();
        }
    });
});
