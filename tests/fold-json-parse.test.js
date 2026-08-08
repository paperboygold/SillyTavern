import { describe, expect, test } from '@jest/globals';

import {
    analyzeExtraction,
    analyzeJson,
    balancedRegions,
    closeUnbalanced,
    coerceExtraction,
    looksTruncated,
    parseLooseJson,
    pickObject,
} from '../public/scripts/extensions/fold/json-parse.js';

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

    test('analyzeJson now RECOVERS a truncated reply, and still reports it as truncated', () => {
        // Was: value null, cycle abandoned, one extra LLM call to ask again. The reply already
        // contained everything the model managed to say; only the closing brackets were missing.
        const analysis = analyzeJson('{"events":[{"summary":"cut off here');
        expect(analysis.value).toEqual({ events: [{ summary: 'cut off here' }] });
        // Still flagged, so the counter keeps recording that the budget is running short.
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

/*
 * The failure that cost one chat every single extraction. `deepseek-v4-pro` with reasoning_effort
 * on an 800-token budget spends the whole allowance thinking and returns nothing — a complete,
 * well-formed, empty reply. That has no unterminated structure, so `looksTruncated` says false, the
 * cycle is filed as garbage, and the retry that would have fixed it never runs.
 */
describe('empty is a budget failure, not a garbage one', () => {
    test('an empty reply is flagged empty rather than truncated', () => {
        for (const reply of ['', '   ', '\n\n']) {
            const analysis = analyzeJson(reply);
            expect(analysis.empty).toBe(true);
            expect(analysis.truncated).toBe(false);
            expect(analysis.value).toBeNull();
        }
    });

    test('looksTruncated genuinely cannot see it — which is why the flag exists', () => {
        expect(looksTruncated('')).toBe(false);
    });

    test('prose is neither empty nor truncated — retrying it just burns tokens', () => {
        const analysis = analyzeJson('I cannot help with that request.');
        expect(analysis.empty).toBe(false);
        expect(analysis.truncated).toBe(false);
    });

    test('a cut-off object is still truncated, not empty', () => {
        const analysis = analyzeJson('{"events": [{"s": "she opened the');
        expect(analysis.truncated).toBe(true);
        expect(analysis.empty).toBe(false);
    });

    test('success reports neither flag', () => {
        const analysis = analyzeJson('{"a": 1}');
        expect(analysis.value).toEqual({ a: 1 });
        expect(analysis.empty).toBe(false);
        expect(analysis.truncated).toBe(false);
    });

    test('coercion carries the flag through both request paths', () => {
        // generateRaw hands back a string; a connection profile hands back parsed content. A null
        // or undefined is neither, and is the same budget failure an empty string is.
        expect(analyzeExtraction('').empty).toBe(true);
        expect(analyzeExtraction(null).empty).toBe(true);
        expect(analyzeExtraction(undefined).empty).toBe(true);
        expect(analyzeExtraction({ events: [] }).empty).toBe(false);
    });
});

/*
 * Recovery. Measured on a real chat: extract:retry-truncated fired twice in thirteen attempts, each
 * costing a second LLM call for a reply that already contained everything the model managed to say.
 */
describe('pickObject — later beats richer', () => {
    test('a correction supersedes the draft it corrects', () => {
        // The old rule took the object with the most keys, which can return the draft the model
        // itself rejected — and a draft parses exactly as well as an answer.
        const draft = { events: ['a'], entities: {}, scene: {} };
        const final = { events: ['b'] };
        expect(pickObject([draft, final])).toBe(final);
    });

    test('an empty envelope never wins', () => {
        const real = { events: ['a'] };
        expect(pickObject([real, {}])).toBe(real);
    });

    test('all-empty falls back to the last rather than throwing', () => {
        expect(pickObject([{}, {}])).toEqual({});
    });

    test('disjoint fragments are one answer split in two', () => {
        expect(pickObject([{ events: [1] }, { entities: [2] }]))
            .toEqual({ events: [1], entities: [2] });
    });

    test('overlapping fragments are a draft and a correction, and are NOT merged', () => {
        expect(pickObject([{ events: [1], scene: 'x' }, { events: [2] }])).toEqual({ events: [2] });
    });
});

describe('closeUnbalanced — recover a cut-off reply without a second call', () => {
    test('closes nested structures innermost first', () => {
        const parsed = JSON.parse(closeUnbalanced('{"events": [{"s": "she opened the door"'));
        expect(parsed.events[0].s).toBe('she opened the door');
    });

    test('terminates a string cut mid-word, keeping the partial value', () => {
        const parsed = JSON.parse(closeUnbalanced('{"events": [{"s": "she opened the doo'));
        expect(parsed.events[0].s).toBe('she opened the doo');
    });

    test('drops the incomplete member after the last comma', () => {
        const parsed = JSON.parse(closeUnbalanced('{"a": 1, "b": 2, "c"'));
        expect(parsed).toEqual({ a: 1, b: 2 });
    });

    test('a brace inside a string does not open a structure', () => {
        const parsed = JSON.parse(closeUnbalanced('{"s": "a {curly} aside", "t": [1'));
        expect(parsed.s).toBe('a {curly} aside');
        expect(parsed.t).toEqual([1]);
    });

    test('analyzeJson recovers truncation end to end, and still reports it', () => {
        const analysis = analyzeJson('{"events": [{"s": "the door gave way"');
        expect(analysis.value.events[0].s).toBe('the door gave way');
        // Still flagged, so the counter records that the model is running out of budget.
        expect(analysis.truncated).toBe(true);
    });

    test('prose is not rescued into a fake object', () => {
        expect(analyzeJson('I cannot help with that request.').value).toBeNull();
    });
});
