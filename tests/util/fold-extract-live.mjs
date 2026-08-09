#!/usr/bin/env node
/**
 * fold-extract-live — call the REAL DeepSeek API with the extraction request fold sends.
 *
 * This is the diagnostic that has been missing: every `extract:empty` and every hang was inferred,
 * never observed. This script builds the extraction request the way fold builds it (window split,
 * "report only changes" ledger header, instructions, the JSON schema appended as a user message —
 * DeepSeek's `json_object` hack from `src/endpoints/backends/chat-completions.js`), sends it to the
 * real API with the real key, and prints exactly what comes back.
 *
 * Usage:
 *   node tests/util/fold-extract-live.mjs <chat.jsonl> [--key <sk-...>]
 *
 * Reads only. Never writes to the chat.
 */

import fs from 'node:fs';
import process from 'node:process';
import { splitWindow } from '../../public/scripts/extensions/fold/extract-table.js';

const path = process.argv[2];
if (!path) {
    console.error('usage: node tests/util/fold-extract-live.mjs <chat.jsonl> [--key sk-...]');
    process.exit(2);
}

// ── the key: --key flag, or the seeded secret store ──
function readKey() {
    const flag = process.argv.indexOf('--key');
    if (flag !== -1 && process.argv[flag + 1]) {
        return process.argv[flag + 1];
    }
    for (const file of ['data/default-user/secrets.json', 'data/default-user/secrets.json'.replace('default-user', '.st-data/default-user')]) {
        try {
            const secrets = JSON.parse(fs.readFileSync(file, 'utf8'));
            const entry = Array.isArray(secrets.api_key_deepseek)
                ? secrets.api_key_deepseek.find(e => e?.value)
                : secrets.api_key_deepseek;
            const value = typeof entry === 'string' ? entry : entry?.value;
            if (value) return value;
        } catch { /* keep looking */ }
    }
    console.error('No DeepSeek key found. Pass --key sk-... or seed tests/util/seed-secrets.mjs.');
    process.exit(2);
}
const API_KEY = readKey();

// ── the chat: header + messages, exactly as fold's buildWindow sees them ──
const lines = fs.readFileSync(path, 'utf8').split('\n').filter(l => l.trim());
const header = JSON.parse(lines[0]);
const messages = lines.slice(1).map((l, mid) => ({ mid, raw: JSON.parse(l) }));
const chat = messages.map(({ mid, raw }) => ({ mid, message: raw }));
const window = splitWindow(chat.map(({ mid, message }) => ({
    mid,
    key: `test:${mid}`,
    name: message.name ?? 'Unknown',
    text: message.mes ?? '',
})), { size: 6, mark: { mid: -1 } });

// ── the schema: faithfully mirrors `buildSchema()` (events + delta, the core probe) ──
const schema = {
    type: 'object',
    $schema: 'http://json-schema.org/draft-04/schema#',
    properties: {
        events: {
            type: 'array',
            description: 'Significant narrative events worth remembering. Empty if nothing of consequence happened.',
            items: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'One sentence, past tense, naming who did what. No commentary.' },
                    keywords: { type: 'array', items: { type: 'string' }, description: '2-6 lowercase search keywords: names, places, objects, actions.' },
                    delta: {
                        type: 'object',
                        description: 'What this event changed. Omit anything it did not change.',
                        properties: {
                            inv: {
                                type: 'array',
                                description: 'Things gained or lost: objects, property owned, capabilities gained.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        item: { type: 'string', description: 'Item name, singular, lowercase.' },
                                        dq: { type: 'integer', description: 'Change in quantity: positive gained, negative lost.' },
                                        at: { type: 'string', description: 'Where it is: "carried", a place, "assets", "abilities", or "money".' },
                                    },
                                    required: ['item', 'dq', 'at'],
                                    additionalProperties: false,
                                },
                            },
                            vit: {
                                type: 'array',
                                description: 'Changes to health, stamina or similar tracked levels.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string', description: 'Vital name, lowercase: "hp", "mana".' },
                                        dcur: { type: 'number', description: 'Change from the current value this turn, never the new total.' },
                                        max: { type: 'number', description: 'Ceiling; send only when newly established.' },
                                    },
                                    required: ['name', 'dcur', 'max'],
                                    additionalProperties: false,
                                },
                            },
                            st: {
                                type: 'array',
                                description: 'Injuries and conditions that started or ended, and WHO they happened to.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        who: { type: 'string', description: 'Whose condition — name from the people list; empty only for the point-of-view character.' },
                                        flag: { type: 'string', description: 'The affliction as a short lowercase phrase: "bruised left arm".' },
                                        on: { type: 'boolean', description: 'True if it started, false if it healed.' },
                                        severity: { type: 'string', enum: ['minor', 'moderate', 'severe'] },
                                        turns: { type: 'integer', description: 'How many exchanges it lasts on its own; 0 for a wound.' },
                                    },
                                    required: ['who', 'flag', 'on', 'severity', 'turns'],
                                    additionalProperties: false,
                                },
                            },
                        },
                        required: ['inv', 'vit', 'st'],
                        additionalProperties: false,
                    },
                },
                required: ['summary', 'keywords', 'delta'],
                additionalProperties: false,
            },
        },
    },
    required: ['events'],
    additionalProperties: false,
};

const instructions = [
    '- events: Record only events with lasting consequence: decisions, revelations, changes in relationship or location, promises, injuries, acquisitions. Ignore small talk and scenery. Return an empty array if nothing of consequence happened.',
    'For each event, record what it CHANGED — changes, not totals. Record only what the excerpt NAMES and actually changes. Contact details are NOT items. Set "at": "carried" when on the character, otherwise the place. Money is "at": "money" — name the currency, amount in dq. Every condition belongs to somebody: "who" is the person\'s name; empty only for the point-of-view character. Record the affliction, never the reassurance.',
    'Respond with JSON only.',
].join('\n');

const prompt = [
    'Transcript excerpt:',
    '---',
    window.text,
    '---',
    '',
    'Extract the following:',
    instructions,
    '',
    'Respond with JSON only.',
].join('\n');

// ── the request, exactly as `sendDeepSeekRequest` shapes it ──
const messagesForApi = [
    { role: 'system', content: 'You are a narrative archivist. You read a transcript excerpt and return structured JSON. You never write prose and never invent facts that are not in the excerpt.' },
    { role: 'user', content: prompt },
    { role: 'user', content: `JSON schema for the response:\n${JSON.stringify(schema, null, 4)}` },
];

const body = {
    model: process.env.FOLD_TEST_MODEL || 'deepseek-chat',
    messages: messagesForApi,
    temperature: 0.7,
    max_tokens: Number(process.env.FOLD_TEST_MAX_TOKENS) || 8192,
    stream: false,
    response_format: { type: 'json_object' },
    stop: [],
    ...(process.env.FOLD_TEST_REASONING ? { reasoning_effort: process.env.FOLD_TEST_REASONING } : {}),
    ...(process.env.FOLD_TEST_THINKING ? { thinking: { type: process.env.FOLD_TEST_THINKING } } : {}),
};

console.log(`=== calling DeepSeek (api.deepseek.com/chat/completions) ===`);
console.log(`model: deepseek-chat · max_tokens: 8192 · prompt chars: ${prompt.length} · schema chars: ${JSON.stringify(schema).length}`);
console.log(`window: ${window.sources.length} fresh message(s), ${window.context} context\n`);

const started = Date.now();
try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify(body),
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`HTTP ${res.status} after ${elapsed}s`);
    const text = await res.text();
    if (!res.ok) {
        console.log(`ERROR BODY:\n${text.slice(0, 2000)}`);
        process.exit(1);
    }
    const data = JSON.parse(text);
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
    const usage = data.usage ?? {};
    console.log(`finish_reason: ${choice?.finish_reason}`);
    console.log(`usage: ${JSON.stringify(usage)}`);
    console.log(`reasoning_content: ${reasoning ? reasoning.length + ' chars' : '(none)'}`);
    console.log(`content: ${content === undefined ? '(MISSING)' : content.length + ' chars'}`);
    console.log('\n=== RAW CONTENT ===');
    console.log(content === undefined ? '(no content field)' : content.slice(0, 3000));
    if (content) {
        try {
            const parsed = JSON.parse(content);
            console.log('\n=== PARSES OK ===', JSON.stringify(parsed).length, 'bytes, events:', parsed.events?.length);
        } catch (e) {
            console.log('\n=== CONTENT IS NOT VALID JSON ===', e.message);
        }
    }
} catch (error) {
    console.log(`\nREQUEST FAILED/TIMED OUT after ${((Date.now() - started) / 1000).toFixed(1)}s:`);
    console.log(error.message);
    process.exit(1);
}
