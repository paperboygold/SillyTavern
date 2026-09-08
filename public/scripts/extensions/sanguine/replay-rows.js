#!/usr/bin/env node
/* eslint-env node */
/**
 * fold/replay-rows.js: the Phase 1 gate instrument.
 *
 * Replays a real chat through the NEW contract: pinned ledger with stable IDs → model ops → the
 * fold. Measures the gate: `% of ops carrying a valid id`, `duplicate rows created`, `new rows
 * for things the story introduced`.
 *
 * The model call is a seam. `--answers <file>` folds a recorded response (a JSON file with
 * `{rows, mentions}`), the shape a live run would produce. Without it, the harness builds and
 * prints the prompt so a live run can be wired against your connection profile, or recorded and
 * replayed.
 *
 *     node public/scripts/extensions/sanguine/replay-rows.js \
 *         "data/default-user/chats/Raccoon City/<chat>.jsonl" \
 *         --seed <state.json> --answers <resp.json> --window 12
 *
 * `--seed` seeds the rows table from a serialised rows table (`state.rows` shape). Without it the
 * table starts empty and the first pass establishes it.
 *
 * `--live` calls the chat's own configured model (the DeepSeek profile in this tree's settings,
 * read from `data/default-user/secrets.json` and `settings.json`) for each window and folds the
 * real response, the honest gate measurement.
 */

import fs from 'node:fs';
import path from 'node:path';
import { makeTable, deserialize, applyOps, renderLedger, ledgerInstruction, withCoverage, nearIdentity } from './rows-table.js';
import { analyzeExtraction } from './json-parse.js';
import { stalenessSuspects, capacitySuspects, identitySuspects, auditBlock } from './audit-table.js';

const CHAT = process.argv[2];
if (!CHAT) {
    console.error('usage: node replay-rows.js <chat.jsonl> [--seed file] [--answers file] [--window n] [--print] [--live]');
    process.exit(1);
}

const arg = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
const has = (flag) => process.argv.includes(flag);
const windowSize = Math.max(1, Number(arg('--window') || 12));
const seedFile = arg('--seed');
const answersFile = arg('--answers');
const printPrompt = has('--print');
const live = has('--live');
const runAudit = has('--audit');
/** Same bound the probe uses, so the measurement reflects the real contract. */
const LEDGER_LIMIT = 60;

/** The model call, wired to this tree's DeepSeek profile. Reads the key from disk, never prints it. */
async function callModel(prompt, schema) {
    const secrets = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/default-user/secrets.json'), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/default-user/settings.json'), 'utf8'));
    const oai = settings.oai_settings || {};
    // The key is the new multi-key shape: an array of {value, active}. Take the active one.
    const rawKey = secrets.api_key_deepseek;
    const key = Array.isArray(rawKey)
        ? (rawKey.find(k => k?.active) || rawKey[0])?.value
        : rawKey;
    const model = oai.deepseek_model || 'deepseek-v4-flash';
    const body = {
        model,
        messages: [
            { role: 'system', content: 'You are a narrative archivist. Read the transcript and return ONLY the requested JSON. Never write prose.' },
            { role: 'user', content: prompt },
        ],
        max_tokens: 8000,
        temperature: 0.2,
        // deepseek-v4-flash spends a small budget entirely on reasoning and returns empty content;
        // disabling thinking is the measured fix (`extract.js`).
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
    };
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`model ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    // The fold's own tolerant parser: fenced blocks, preambles, unbalanced braces, unescaped
    // quotes in evidence text, strict JSON.parse is not enough for real model output.
    const parsed = analyzeExtraction(content);
    if (parsed?.value) return parsed.value;
    throw new Error(`model JSON parse failed (${content.length} chars): ${content.slice(0, 300)}`);
}

/** The JSON shape the model must answer with, inlined into the prompt. */
function shape() {
    return {
        rows: [{
            op: 'new|gain|spend|set|move|change|close|same_as|none',
            id: 'the row id, e.g. "R2" (empty for new)',
            target: 'for same_as, the held row id (empty otherwise)',
            kind: 'item|vital|mark|person|thread|clock|scene (for new)',
            name: 'for new / change, the name the story uses (never a category)',
            dq: 0, set: 0, at: 'carried|money|assets|abilities|place (for new/move)', who: '', rank: '', qty: 0,
            evidence: 'what in the text shows it (required except for none)',
        }],
        mentions: ['row ids the excerpt named'],
    };
}

function readable(chat) {
    return chat
        .map((m, mid) => ({ mid, message: m }))
        .filter(({ message }) => message?.mes && !message.is_system)
        .map(({ message, mid }) => ({ mid, name: message.name ?? 'Unknown', text: message.mes }));
}

function main() {
    const lines = fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const messages = readable(lines);
    const table = seedFile ? deserialize(JSON.parse(fs.readFileSync(seedFile, 'utf8'))) : makeTable();

    const report = { passes: 0, ops: 0, validIdOps: 0, heldOps: 0, refusals: [], diffs: [], duplicateAttempts: 0, newRows: 0, parseFailures: 0 };
    const run = async () => {
        for (let start = 0; start < messages.length; start += windowSize) {
            const window = messages.slice(start, start + windowSize);
            const transcript = window.map(m => `${m.name}: ${m.text}`).join('\n\n');
            const ledger = renderLedger(table, LEDGER_LIMIT);
            const prompt = [
                'You are a narrative archivist. Read the transcript and return the state changes as rows-ops.',
                '',
                'Transcript excerpt:',
                '---', transcript, '---',
                ledger ? ['', ledgerInstruction(), '', `State:\n${ledger}`] : [ledgerInstruction()],
                '',
                `Answer with JSON matching exactly this shape: ${JSON.stringify(shape())}`,
            ].flat().join('\n');

            report.passes++;
            if (printPrompt) {
                console.log(`\n===== PASS ${report.passes} (mids ${window[0].mid}..${window[window.length - 1].mid}) =====\n${prompt}\n`);
            }

            let response;
            if (live) {
                try {
                    response = await callModel(prompt, shape());
                } catch (err) {
                    report.parseFailures++;
                    console.error(`  pass ${report.passes}: model call failed (${err.message.slice(0, 120)})`);
                    continue;
                }
            } else if (answersFile) {
                response = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
            } else {
                continue;
            }

            const covered = withCoverage(Array.isArray(response.rows) ? response.rows : [], response.mentions ?? []);
            for (const op of covered) {
                report.ops++;
                if (op.op === 'new') { report.newRows++; continue; }
                report.heldOps++;
                if (op.id && table.rows.has(op.id)) report.validIdOps++;
            }
            const { diffs, errors } = applyOps(table, covered, window[window.length - 1].mid);
            report.diffs.push(...diffs);
            for (const err of errors) {
                report.refusals.push(err);
                if (err.error === 'new-matches-held') report.duplicateAttempts++;
            }
            if (live) console.log(`  pass ${report.passes}: ${covered.length} covered ops, ${diffs.length} diffs, ${errors.length} refused`);
        }
    };

    run().then(() => {
        const valid = report.ops ? Math.round((report.validIdOps / report.ops) * 100) : 100;
        const heldValid = report.heldOps ? Math.round((report.validIdOps / report.heldOps) * 100) : 100;
        console.log('\n===== GATE REPORT =====');
        console.log(`passes: ${report.passes} (${report.parseFailures} model call failures)`);
        console.log(`ops folded: ${report.ops} total (${report.newRows} new, ${report.heldOps} on held rows)`);
        console.log(`held-row ops referencing a valid id: ${report.validIdOps}/${report.heldOps} (${heldValid}%)  [all-ops: ${valid}%]`);
        console.log(`duplicate-row attempts refused: ${report.duplicateAttempts}`);
        console.log(`conservation diffs: ${report.diffs.length}`);
        console.log('refusals:');
        for (const r of report.refusals.slice(0, 20)) console.log(`  ${r.error} ${JSON.stringify(r.op?.name ?? r.op?.id ?? r.op)}`);
        if (report.diffs.length) {
            console.log('diffs:');
            for (const d of report.diffs.slice(0, 10)) console.log(`  ${d.id} ${d.name}: fold ${d.qty} vs stated ${d.set} (${d.diff})`);
        }
        console.log('\nfinal ledger:');
        console.log(renderLedger(table));
        if (runAudit) {
            const now = messages.length ? messages[messages.length - 1].mid : 0;
            const suspects = [
                ...stalenessSuspects(table.rows, now),
                ...capacitySuspects(table.rows),
                ...identitySuspects(table.rows, nearIdentity),
            ];
            if (suspects.length) {
                const { text } = auditBlock(suspects);
                console.log('\n===== AUDIT (exact detectors over the replay\'s final table) =====');
                console.log(text);
                console.log('(answers route keep/gone/move/same through the fold, one call, never in fiction)');
            } else {
                console.log('\naudit: nothing to question, the final table is quiet');
            }
        }
        if (!answersFile && !live) {
            console.log('\n(no --answers/--live: prompts built, nothing folded.)');
        }
    }).catch(err => {
        console.error('\nreplay failed:', err.message);
        process.exit(1);
    });
}

main();
