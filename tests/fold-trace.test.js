import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendTrace, readTrace } from '../src/endpoints/fold-trace.js';

/**
 * The fold-trace endpoint is the durable sink for fold's prompt->output pairs: one JSONL line
 * per extraction pass, appended per chat, off the 128KB `chat_metadata` budget. These tests pin
 * the append/read contract — the two pure helpers the router wraps.
 */
describe('fold-trace endpoint — append/read', () => {
    /** @type {string} */
    let dir;
    /** @type {{extensions: string}} */
    let userDirectories;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-trace-'));
        userDirectories = { extensions: path.join(dir, 'extensions') };
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('an unknown chat reads as an empty list', () => {
        expect(readTrace(userDirectories, 'no-such-chat')).toEqual([]);
    });

    test('append writes one JSONL line; read returns it, oldest first', () => {
        appendTrace(userDirectories, 'chatA', { t: 1, turn: 1, mid: 1, prompt: 'p1', raw: 'r1', parsed: null, ok: true, reason: '' });
        appendTrace(userDirectories, 'chatA', { t: 2, turn: 2, mid: 2, prompt: 'p2', raw: 'r2', parsed: null, ok: true, reason: '' });

        const records = readTrace(userDirectories, 'chatA');
        expect(records.length).toBe(2);
        expect(records[0].t).toBe(1);
        expect(records[1].t).toBe(2);
        // each record is one line on disk — the JSONL invariant a file-based trace needs
        const lines = fs.readFileSync(path.join(dir, 'extensions', 'fold-traces', 'chatA.jsonl'), 'utf8')
            .trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).prompt).toBe('p1');
    });

    test('chats are isolated — appending to one does not leak into another', () => {
        appendTrace(userDirectories, 'chatB', { t: 9, prompt: 'other', raw: 'x', ok: true, reason: '' });
        const a = readTrace(userDirectories, 'chatA');
        const b = readTrace(userDirectories, 'chatB');
        expect(a).toHaveLength(2);
        expect(b).toHaveLength(1);
        expect(b[0].prompt).toBe('other');
    });

    test('a failure record is kept verbatim, reason and all', () => {
        appendTrace(userDirectories, 'chatC', {
            t: 5, turn: 3, mid: 7, prompt: 'full prompt text', raw: 'garbage reply', parsed: null, ok: false, reason: 'unparseable',
        });
        const records = readTrace(userDirectories, 'chatC');
        expect(records).toHaveLength(1);
        expect(records[0].ok).toBe(false);
        expect(records[0].reason).toBe('unparseable');
        expect(records[0].raw).toBe('garbage reply');
    });
});

/*
 * The client half (`public/scripts/extensions/fold/trace.js`) imports `script.js` and cannot be
 * unit-tested directly — the same instrument the panel uses. These tests read the source to pin
 * the record contract: every extraction pass (success AND failure) must send the full prompt, the
 * raw reply and the parsed fragment, so the trace really is the input->output pair the resolver
 * needs, not a tally.
 */
describe('fold trace.js — the client record contract', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'fold');
    const extract = fs.readFileSync(path.join(FOLD, 'extract.js'), 'utf8');
    const trace = fs.readFileSync(path.join(FOLD, 'trace.js'), 'utf8');

    test('every pass records prompt, schema, raw and parsed', () => {
        // The four fields that make the trace a full input->output pair. Without `raw` the
        // unparseable passes are lost; without `prompt` nothing can be re-derived. The fields
        // appear as keys in the JSON.stringify body.
        for (const field of ['prompt:', 'schema:', 'raw:', 'parsed:']) {
            expect(trace).toContain(field);
        }
    });

    test('the success path records the pair (extract.js after the pass succeeds)', () => {
        // The success record sits right before `return { ok: true, results }`.
        const successBlock = extract.slice(extract.indexOf('return { ok: true, results }') - 700, extract.indexOf('return { ok: true, results }'));
        expect(successBlock).toContain('trace.record({');
        expect(successBlock).toContain('prompt,');
        expect(successBlock).toContain('raw: String(rawReply');
        expect(successBlock).toContain('parsed,');
        expect(successBlock).toContain('ok: true,');
    });

    test('the failure path records the pair too (unparseable replies are evidence)', () => {
        // The failure record is anchored by the diagnostics-log write it follows.
        const failAnchor = extract.indexOf('log.note({');
        const failureBlock = extract.slice(failAnchor, failAnchor + 800);
        expect(failureBlock).toContain('trace.record({');
        expect(failureBlock).toContain('ok: false');
        expect(failureBlock).toContain('reason,');
    });

    test('a failed trace write never fails the pass it records', () => {
        // The record call is fire-and-forget; a network error must not propagate to `runExtraction`.
        expect(trace).toContain('// The trace is evidence, not a gate: a network hiccup must not fail the pass it records.');
        expect(trace).toMatch(/catch\s*\{/);
    });
});
