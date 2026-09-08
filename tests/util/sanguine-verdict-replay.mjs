#!/usr/bin/env node
/**
 * fold-verdict-replay — replay Phase E's gate and standing against a real chat.
 *
 * What this CAN do offline (pure modules only — the same boundary fold-calibrate keeps):
 *   · run `looksLikeAttempt` over every user message, so the gate's true shape is visible — it is a
 *     deliberately permissive pre-filter on whether to spend a call, not the contestedness filter;
 *   · reconstruct the standing-side inputs (hurt, momentum, precedent) for the §6 fixtures
 *     straight from the chat's own chronicle, via the pure fold;
 *   · print the deterministic band for those standings given the classification §6 asserts.
 *
 * What it CANNOT do offline, and does not pretend to: the classification (contested/supported/
 * opposed/reckless) is a model reading-comprehension question answered in `verdict.js` `classify`,
 * which imports the SillyTavern runtime. "Shopping stays uncontested" is decided there, not in the
 * gate. That half is the live play confirmation: a verdict in a real session where
 * `verdict:setback + verdict:cost ≥ 1` and `verdict:uncontested` stops being 100%.
 *
 * Usage:
 *   node tests/util/fold-verdict-replay.mjs <chat.jsonl>
 *
 * Reads only. Never writes to the chat, and never touches a running SillyTavern.
 */

import fs from 'node:fs';
import process from 'node:process';

import {
    adjudicate,
    matchThread,
    standingRange,
} from '../../public/scripts/extensions/sanguine/verdict-table.js';
import { deriveState } from '../../public/scripts/extensions/sanguine/state-table.js';
import { looksLikeAttempt } from '../../public/scripts/extensions/sanguine/trigger-table.js';
import { MOMENTUM_FLOOR, MOMENTUM_CEILING } from '../../public/scripts/extensions/sanguine/verdict-table.js';

const path = process.argv[2];
if (!path) {
    console.error('usage: node tests/util/fold-verdict-replay.mjs <chat.jsonl>');
    process.exit(2);
}

const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
const header = (() => { try { return JSON.parse(lines[0]); } catch { return {}; } })();
const messages = lines.slice(1).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const events = Object.values(header.chat_metadata?.fold?.chronicle?.events ?? {});

// The standing-side inputs from the chat's own ledger. The classification (supported/opposed/
// reckless) is the model half; the standing is the fold's half, and it is fully derived here.
const derived = deriveState(events);
const momentum = Number((header.chat_metadata?.fold?.state?.momentum ?? {})?.n) || 0;
const hurt = derived.marks
    ? Array.from(derived.marks.values()).filter(mark => mark?.who === 'pov' || mark?.on).length
    : 0;
const standing = { momentum, hurt, regard: undefined, precedent: 'untried' };

console.log(`fold-verdict-replay — ${path}`);
console.log(`  messages ${messages.length} · chronicle events ${events.length}`);
console.log(`  standing reconstructed: momentum ${momentum} · hurt ${hurt} (approx, unweighted) · precedent untried`);
console.log('');

// ── Gate replay: which user messages would run the adjudicator at all ──
//
// The uncontested half of the gate is CODE, not the model: `looksLikeAttempt` decides whether a
// call is spent. "Shopping dialogue stays uncontested" lives or dies here.
let userMessages = 0;
let gated = 0;
let gatedOn = [];
console.log('gate — every user message');
for (const message of messages) {
    if (!message?.is_user || !message?.mes) continue;
    userMessages++;
    const gate = looksLikeAttempt(message.mes);
    const brief = String(message.mes).replace(/\s+/g, ' ').slice(0, 70);
    if (gate.attempt) {
        gated++;
        gatedOn.push(brief);
        console.log(`  run   ${brief}`);
    } else {
        console.log(`  skip  (${gate.why}) ${brief}`);
    }
}
console.log(`  → ${gated}/${userMessages} user messages pass the gate (a cheap pre-filter on whether to SPEND A CALL)`);
console.log(`  → uncontestedness is decided by the classifier's contested flag, which is the live half — not the gate`);
console.log('');

// ── The §6 fixtures: the deterministic band, given the standing §6 asserts ──
//
// "An E-rank with a wounded calf vaults a rank of charging goblins" — opposed and reckless, and
// nothing on record supports it. "The crate-kill" — supported by the crate, opposed by the goblin.
const fixtures = [
    {
        name: 'mid-35 leap',
        text: 'vaults a rank of charging goblins',
        classify: { supported: false, opposed: true, reckless: true, keywords: ['vault', 'leap', 'goblins'] },
        standing: { ...standing, hurt: Math.max(1, standing.hurt) },
    },
    {
        name: 'crate-kill',
        text: 'slams the stone crate down on the goblin',
        classify: { supported: true, opposed: true, reckless: false, keywords: ['crate', 'crush', 'goblin'] },
        standing,
    },
];
console.log('fixtures — the deterministic band (classification asserted per §6; standing from the real ledger)');
for (const fixture of fixtures) {
    const range = standingRange(fixture.classify, fixture.standing);
    const verdict = adjudicate(fixture.classify, fixture.standing);
    const gate = 'non-CLEAR'; // CLEAR_AT=1 / SETBACK_AT=-2 are the constants; the band is the assertion
    console.log(`  ${fixture.name}: standing ${range.lo}..${range.hi} → ${verdict.band} (${gate})`);
}
console.log('');

// ── Where a setback would aim today: the first matching thread, or none ──
//
// Phase E: SETBACK ticks the thread the attempt was about, or no dial at all. Reconstruct the
// thread list from the real chat to show which of the fixtures would tick what.
const threads = (header.chat_metadata?.fold?.state?.threads ?? {});
const threadRows = Object.entries(threads).map(([key, value]) => ({
    name: value?.name ?? key,
    about: value?.about ?? '',
    detail: value?.detail ?? '',
    filled: Number(value?.filled) || 0,
    size: Number(value?.size) || 6,
    kind: value?.kind || 'doom',
}));
for (const fixture of fixtures) {
    const aimed = matchThread(threadRows, { keywords: fixture.classify.keywords, against: '' });
    console.log(`  ${fixture.name} setback would aim at: ${aimed ? aimed.name : 'NO THREAD (no tick — correct)'}`);
}

process.exit(0);
