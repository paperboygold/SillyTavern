#!/usr/bin/env node
/**
 * fold-calibrate — measure fold's constants against a real chat.
 *
 * fold carries twenty-two numeric limits and every one of them was chosen rather than measured.
 * This is the instrument that fixes that: it replays a SillyTavern chat file through fold's own
 * pure modules and reports, for each constant, the distribution it was supposed to bound.
 *
 * The method is `whispering-tides/src/globe.slang`'s: state the observed number next to the
 * configured one, and name what the data cannot answer rather than papering over it. A constant
 * that the data never approaches is decoration; one the data routinely exceeds is set wrong.
 *
 * Usage:
 *   node tests/util/fold-calibrate.mjs "data/default-user/chats/<char>/<chat>.jsonl"
 *   node tests/util/fold-calibrate.mjs --json <chat.jsonl>     # machine-readable
 *
 * Reads only. Never writes to the chat, and never touches a running SillyTavern.
 */

import fs from 'node:fs';
import process from 'node:process';

import {
    LONG_STATEMENT,
    classifyBlock,
    findStateBlock,
    parseStateBlock,
    restateInventory,
    splitClauses,
} from '../../public/scripts/extensions/sanguine/block-parse.js';
import {
    MAX_EVENTS,
    MAX_KEYWORDS,
    MAX_KEYWORD_CHARS,
    MAX_SUMMARY_CHARS,
} from '../../public/scripts/extensions/sanguine/chronicle-table.js';
import { CLOCK_STALE_AFTER, parseClock } from '../../public/scripts/extensions/sanguine/clock.js';
import {
    MAX_CHANGES_PER_TURN,
    MAX_ITEMS,
    MAX_ITEM_NAME,
    STALE_THRESHOLD,
    canonicalItemName,
    deriveState,
    itemKey,
    normalizeItemName,
    normalizePlace,
    renderLedger,
    splitItemKey,
    validateInventory,
} from '../../public/scripts/extensions/sanguine/state-table.js';
import { splitWindow } from '../../public/scripts/extensions/sanguine/extract-table.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const path = args.find(a => !a.startsWith('--'));

if (!path) {
    console.error('usage: node tests/util/fold-calibrate.mjs [--json] <chat.jsonl>');
    process.exit(2);
}

const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
const messages = lines.slice(1).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const header = (() => { try { return JSON.parse(lines[0]); } catch { return {}; } })();

/**
 * Summarise a sample.
 * @param {number[]} values Observations.
 * @returns {object} n, max, p50, p95, mean.
 */
function stats(values) {
    if (!values.length) {
        return { n: 0, max: null, p50: null, p95: null, mean: null };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
        n: sorted.length,
        max: sorted[sorted.length - 1],
        p50: at(0.5),
        p95: at(0.95),
        mean: Number((sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(2)),
    };
}

// ── replay ────────────────────────────────────────────────────────────────────
// The block a card emitted is on `extra.fold_block` once fold has absorbed it, and inline in `mes`
// before that. Both are read, so a chat calibrates whether or not absorption was on.

const blocks = [];
for (const message of messages) {
    if (message.is_user || message.is_system) continue;
    const raw = message.extra?.fold_block ?? (findStateBlock(message.mes ?? '') ? message.mes : null);
    if (!raw) continue;
    const fields = parseStateBlock(raw);
    if (fields) blocks.push(fields);
}

const events = Object.values(header.chat_metadata?.fold?.chronicle?.events ?? {});

// Item names, per-turn listed counts, and the gap between mentions of the same item.
const itemNameLengths = [];
const listedPerTurn = [];
const lastSeen = new Map();
const mentionGaps = [];
const distinctItems = new Set();

// Clock: how many consecutive blocks state a time that has not advanced.
const clockRuns = [];
let clockRun = 0;
let lastMinutes = null;

// Fields a card invents, and how long a single lead statement runs.
const fieldLabels = new Map();
const statementLengths = [];

blocks.forEach((fields, turn) => {
    const { items, context } = classifyBlock(fields);

    const named = items.map(raw => normalizeItemName(raw)?.name).filter(Boolean);
    listedPerTurn.push(named.length);
    for (const name of named) {
        itemNameLengths.push(name.length);
        distinctItems.add(name);
        if (lastSeen.has(name)) mentionGaps.push(turn - lastSeen.get(name));
        lastSeen.set(name, turn);
    }

    const minutes = parseClock(fields.get('time'));
    if (minutes !== null) {
        if (lastMinutes !== null && minutes === lastMinutes) {
            clockRun++;
        } else {
            if (clockRun > 0) clockRuns.push(clockRun);
            clockRun = 0;
        }
        lastMinutes = minutes;
    }

    for (const [label, value] of context) {
        fieldLabels.set(label, (fieldLabels.get(label) ?? 0) + 1);
        for (const statement of splitClauses(value)) statementLengths.push(statement.length);
    }
});
if (clockRun > 0) clockRuns.push(clockRun);

// The restatement leak, measured: how many totals a block proposes that differ from what is held.
const held = new Map();
let restatementsThatChanged = 0;
let restatementsTotal = 0;
for (const fields of blocks) {
    const { items } = classifyBlock(fields);
    const named = items.map(raw => normalizeItemName(raw)?.name).filter(Boolean);
    for (const { item, set } of restateInventory({ held, listed: named })) {
        restatementsTotal++;
        if ((held.get(item)?.qty ?? 0) !== set) restatementsThatChanged++;
        held.set(item, { qty: set });
    }
}

const summaryLengths = events.map(e => String(e?.s ?? '').length);
const keywordCounts = events.map(e => (e?.kw ?? []).length);
const keywordLengths = events.flatMap(e => (e?.kw ?? []).map(k => String(k).length));
const deltaMagnitudes = events.flatMap(e => (e?.d?.inv ?? []).map(c => Math.abs(Number(c?.dq ?? 0))).filter(Boolean));

const assistantTurns = messages.filter(m => !m.is_user && !m.is_system).length;

// ── the ledger ────────────────────────────────────────────────────────────────
// `bound` is the honest verdict: did this number ever change an outcome in this chat?

const CONSTANTS = [
    ['MAX_ITEM_NAME', MAX_ITEM_NAME, stats(itemNameLengths), 'characters in an item name'],
    ['MAX_ITEMS', MAX_ITEMS, { n: 1, max: distinctItems.size, p50: distinctItems.size, p95: distinctItems.size, mean: distinctItems.size }, 'distinct items ever held'],
    ['MAX_CHANGES_PER_TURN', MAX_CHANGES_PER_TURN, stats(listedPerTurn), 'items a block lists in one turn'],
    // MAX_DELTA is gone: the bound is now a ratio against what is held, so there is no single
    // number to report. The distribution is still worth showing — it is what proved an absolute
    // cap was encoding a genre.
    ['(delta magnitude)', null, stats(deltaMagnitudes), 'magnitude of a single quantity change'],
    ['STALE_THRESHOLD', STALE_THRESHOLD, stats(mentionGaps), 'turns between mentions of the same item'],
    ['CLOCK_STALE_AFTER', CLOCK_STALE_AFTER, stats(clockRuns), 'consecutive blocks restating an unchanged time'],
    ['MAX_SUMMARY_CHARS', MAX_SUMMARY_CHARS, stats(summaryLengths), 'characters in an event summary'],
    ['MAX_KEYWORDS', MAX_KEYWORDS, stats(keywordCounts), 'keywords per event'],
    ['MAX_KEYWORD_CHARS', MAX_KEYWORD_CHARS, stats(keywordLengths), 'characters in a keyword'],
    ['MAX_EVENTS', MAX_EVENTS, { n: 1, max: events.length, p50: events.length, p95: events.length, mean: events.length }, 'events in the ledger'],
    ['LONG_STATEMENT', LONG_STATEMENT, stats(statementLengths), 'characters in one lead statement'],
];

const rows = CONSTANTS.filter(([, configured]) => configured !== null).map(([name, configured, observed, what]) => ({
    name,
    configured,
    ...observed,
    what,
    bound: observed.max !== null && observed.max >= configured,
    headroom: observed.max === null ? null : Number((configured / Math.max(1, observed.max)).toFixed(1)),
}));

// ── the duplicate-beat detector ───────────────────────────────────────────────
//
// The instrument for "nothing is billed twice". A beat is duplicated when one item is GAINED by two
// separate events whose anchor messages are close enough together that the same narration was in
// both windows — which is the only way the two dedups can both miss, since each event carries a
// different anchor key (`chronicle.js:222-225`, `chronicle-table.js:285-292`).
//
// The span is the extraction window, because that is exactly the reach of the overlap: with a
// window of N and a pass every one or two turns, a message is re-read for about N mids. Losses are
// ignored — nobody re-narrates dropping something — and restated totals are ignored because the Map
// face makes them idempotent. Names are compared through `canonicalItemName`, so a rewording counts
// as the same beat rather than escaping the detector by being spelled differently.

/** The extraction window in messages. Matches `settings.chronicle.window` (`index.js:111`). */
const WINDOW = 6;

/**
 * Find items gained more than once inside one overlap span.
 * @param {Array<{mid: number, d: object}>} events Ledger events.
 * @param {number} [span] Mids within which two gains are the same beat re-read.
 * @returns {Array<{item: string, place: string, mids: number[], qty: number}>} Duplicated beats.
 */
function duplicateBeats(events, span = WINDOW) {
    const gains = new Map();
    const canon = new Map();

    for (const event of [...events].filter(e => Number.isFinite(e?.mid)).sort((a, b) => a.mid - b.mid)) {
        for (const change of event?.d?.inv ?? []) {
            const dq = Number(change?.dq ?? 0);
            const parsed = normalizeItemName(change?.item)?.name;
            if (!parsed || dq <= 0) continue;
            const place = normalizePlace(change?.at);
            const key = itemKey(canonicalItemName(canon, parsed, place), place);
            canon.set(key, { qty: 1 });
            if (!gains.has(key)) gains.set(key, []);
            gains.get(key).push({ mid: event.mid, dq });
        }
    }

    const found = [];
    for (const [key, occurrences] of gains) {
        const close = occurrences.some((o, i) => i > 0 && o.mid - occurrences[i - 1].mid <= span);
        if (close) {
            found.push({ ...splitItemKey(key), mids: occurrences.map(o => o.mid), qty: occurrences.reduce((s, o) => s + o.dq, 0) });
        }
    }
    return found;
}

/**
 * Re-validate this chat's own recorded proposals under the current rules.
 *
 * Not a simulation of the model — the model's answers are already in the ledger, verbatim. What is
 * replayed is everything downstream of them: the window split at a high-water mark that advances
 * exactly as it did in play (each pass marks its own anchor), the pinned ledger derived from what
 * has been accepted so far, and every validator gate. So the "after" number is measured on the real
 * campaign rather than on a fixture built to pass.
 *
 * @param {object[]} chatMessages The chat's messages, in order.
 * @param {object[]} ledger The recorded events.
 * @returns {{events: object[], rejected: object[]}} The ledger this chat would have grown.
 */
function replayLedger(chatMessages, ledger) {
    const readable = chatMessages
        .map((message, mid) => ({ message, mid }))
        .filter(({ message }) => message?.mes && !message.is_system)
        .map(({ message, mid }) => ({ mid, key: `m${mid}`, name: message.name ?? 'Unknown', text: message.mes }));

    const byMid = new Map();
    for (const event of ledger.filter(e => Number.isFinite(e?.mid) && e?.src === 'llm')) {
        if (!byMid.has(event.mid)) byMid.set(event.mid, []);
        byMid.get(event.mid).push(event);
    }

    const events = [];
    const rejected = [];
    let mark = {};
    let t = 0;

    for (const mid of [...byMid.keys()].sort((a, b) => a - b)) {
        const upTo = readable.filter(m => m.mid <= mid);
        const window = splitWindow(upTo, { size: WINDOW, mark });
        // A pass with nothing new declines outright; its proposals never reach a validator.
        if (window.sources.length) {
            const state = deriveState(events);
            const { shown } = renderLedger(state);
            for (const event of byMid.get(mid)) {
                if (!event?.d?.inv?.length) continue;
                const outcome = validateInventory({ inv: state.inv, deltas: event.d.inv, windowText: window.newText, shown });
                rejected.push(...outcome.rejected.map(r => ({ ...r, mid })));
                if (outcome.accepted.length) {
                    events.push({ s: event.s ?? '', kw: [], t: ++t, mid, src: 'llm', d: { inv: outcome.accepted } });
                }
            }
            mark = { mid: window.sources[window.sources.length - 1].mid, key: window.sources[window.sources.length - 1].key };
        }
    }

    return { events, rejected };
}

const beatsBefore = duplicateBeats(events);
const replayed = replayLedger(messages, events);
const beatsAfter = duplicateBeats(replayed.events);
const refusals = replayed.rejected.reduce((acc, r) => acc.set(r.reason, (acc.get(r.reason) ?? 0) + 1), new Map());

const summary = {
    chat: path,
    duplicateBeats: {
        before: beatsBefore.length,
        after: beatsAfter.length,
        span: WINDOW,
        items: beatsBefore.map(b => `${b.name}@${b.place} x${b.qty} (mids ${b.mids.join(',')})`),
        refusals: [...refusals.entries()].sort((a, b) => b[1] - a[1]),
    },
    assistantTurns,
    blocks: blocks.length,
    events: events.length,
    distinctItems: distinctItems.size,
    restatements: { total: restatementsTotal, changed: restatementsThatChanged },
    cardFields: [...fieldLabels.entries()].sort((a, b) => b[1] - a[1]),
    constants: rows,
};

if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
}

console.log(`fold-calibrate — ${path}`);
console.log(`  ${assistantTurns} assistant turns · ${blocks.length} state blocks · ${events.length} events · ${distinctItems.size} distinct items\n`);

const w = Math.max(...rows.map(r => r.name.length));
console.log(`  ${'constant'.padEnd(w)}  set     n   max   p50   p95   headroom  verdict`);
for (const r of rows) {
    const pad = (v) => String(v ?? '-').padStart(5);
    const verdict = r.n === 0 ? 'no data'
        : r.bound ? 'BINDS'
            : r.headroom >= 4 ? 'never close'
                : 'holds';
    console.log(`  ${r.name.padEnd(w)}  ${String(r.configured).padStart(4)}  ${pad(r.n)} ${pad(r.max)} ${pad(r.p50)} ${pad(r.p95)}  ${String(r.headroom ?? '-').padStart(7)}x  ${verdict}`);
}

console.log(`\n  duplicate beats (same item gained twice within ${WINDOW} mids): ${beatsBefore.length} recorded → ${beatsAfter.length} under the current rules`);
for (const beat of beatsBefore) {
    console.log(`    ${beat.name} @ ${beat.place} — x${beat.qty} across mids ${beat.mids.join(', ')}`);
}
if (refusals.size) {
    console.log(`  replay refusals: ${[...refusals.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ${n}`).join(' · ')}`);
}

const magnitudes = stats(deltaMagnitudes);
console.log(`\n  delta magnitudes (no absolute cap; bounded by ratio): n=${magnitudes.n} max=${magnitudes.max} p95=${magnitudes.p95}`);
console.log(`  restated totals: ${restatementsTotal}, of which ${restatementsThatChanged} changed a quantity`);
console.log(`  card fields: ${summary.cardFields.map(([k, n]) => `${k}(${n})`).join(' ')}`);
