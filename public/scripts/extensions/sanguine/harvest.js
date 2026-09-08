/**
 * fold/harvest.js: consolidate the week's play into a resolver-ready corpus.
 *
 * Run from the SillyTavern repo root:
 *
 *     node public/scripts/extensions/sanguine/harvest.js [data-root] [out.jsonl]
 *
 * Three record kinds go into one JSONL at `data/<user>/fold-corpus.jsonl`:
 *
 *   { "kind": "trace",   "chat": "...", "turn": 3, "mid": 7, "ok": true,
 *     "prompt": "...", "schema": {...}, "raw": "...", "parsed": {...} }
 *   { "kind": "verdict", "chat": "...", "pair": "ab", "answer": "same", "at": 1786351019195 }
 *   { "kind": "pair",    "chat": "...", "a": "...", "b": "...", "of": "cast",
 *     "answer": "same", "source": "trace", "context": "...", "text": "..." }
 *
 * `trace` is the raw prompt->output evidence. `verdict` is a label with no context, the pair key
 * and the answer, all a chat played before the trace existed can offer. `pair` is the training
 * example: the same label with the text that decided it, which is the only kind `lib/ml/` can
 * learn the hard cases from.
 *
 * Why `pair` has to exist.
 *
 * A verdict's two names do not contain their own answer. Measured over the 35 verdicts fold had
 * persisted at the time this was written, two pairs of identical surface shape carry opposite
 * labels: `voss's network` / `voss's network on the river` is `same`, and `zareena's request` /
 * `zareena's request for a seat at the festival` is `different`. A featurizer reading only the two
 * strings must be wrong about one of them however much data it is given, and leave-one-out over
 * that corpus scored 81.3% against a 91.4% majority-class baseline: worse than answering "same"
 * every time. What separates the two pairs is in the ledger rows and the narrative, so that is
 * what a witness has to carry.
 *
 * Two context sources, and why the state is not one of them.
 *
 * - `source: 'trace'`: the prompt as it was SENT, sliced to the lines that name either side. This
 *   is what the live resolver would see at decide time, so it is the honest featurizer input.
 * - `source: 'chat'`: the narrative messages that name either side, for the verdicts recorded
 *   before the trace existed. Weaker (no ledger rows) but not fabricated.
 *
 * The persisted thread/cast table is deliberately NOT a context source, though it is the richest
 * text available. A `same` answer MERGES the two rows and a `different` answer leaves both
 * standing, so "do both keys still exist" reproduces the label almost perfectly, a leak that
 * would make any accuracy measured on it a fiction. Context is only ever read from text written
 * BEFORE the answer was known.
 *
 * On RULE 1.
 *
 * Matching a name against text here is `AGENTS.md` RULE 1's STRUCTURE clause: token algebra on
 * fold's OWN keys, case-folded, no English morphology and no word list. It also runs offline, out
 * of the live path, where there is no model to ask. Nothing in this file judges what prose means.
 */

import fs from 'node:fs';
import path from 'node:path';

import { readBlob } from './metadata-key.js';
import { nearIdentity } from './thread-table.js';

const dataRoot = path.resolve(process.argv[2] ?? 'data');
const outputPath = path.resolve(process.argv[3] ?? path.join(dataRoot, 'fold-corpus.jsonl'));

/** The pair-key separators `review-table.js` `pairKey`/`castKey` join on. */
const PAIR_SEP = String.fromCharCode(1);
const KIND_SEP = String.fromCharCode(0);

/** How much context one witness carries. Enough for the ledger rows and the lines that name the
 * pair; bounded so a long window cannot swamp a short one in the hashed-trigram counts. */
const CONTEXT_LIMIT = 2000;

/**
 * Every chat on disk, by the id the trace files are named with.
 * @param {string} chatsDir The `chats` directory.
 * @returns {Array<{chatId: string, file: string}>} One entry per chat JSONL.
 */
function findChatFiles(chatsDir) {
    const found = [];
    if (!fs.existsSync(chatsDir)) {
        return found;
    }
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const dir = path.join(chatsDir, entry.name);
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.jsonl')) {
                found.push({ chatId: path.basename(file, '.jsonl'), file: path.join(dir, file) });
            }
        }
    }
    return found;
}

/**
 * Read a chat JSONL once: the last `chat_metadata.fold` blob and every message body.
 * @param {string} chatFile The chat file.
 * @returns {{meta: object|null, messages: string[]}} The fold state and the narrative.
 */
function readChat(chatFile) {
    let meta = null;
    const messages = [];
    const text = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8') : '';
    for (const line of text.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            // A malformed line is skipped, not fatal, the rest of the chat still counts.
            continue;
        }
        // Every key this project has persisted under, because a corpus harvester reads HISTORY:
        // the chats on disk carry both spellings, and one of them is a chat that stopped being
        // written to. `readBlob` owns that list so this file never spells a key again.
        const blob = readBlob(obj?.chat_metadata);
        if (blob) {
            meta = blob;
        }
        if (typeof obj?.mes === 'string' && obj.mes) {
            messages.push(`${obj?.name ?? ''}: ${obj.mes}`);
        }
    }
    return { meta, messages };
}

/**
 * The display form of one side of a pair key: the kind prefix stripped, case folded.
 * @param {string} key One side of a pair key.
 * @returns {string} The bare name.
 */
function bareName(key) {
    const parts = String(key ?? '').split(KIND_SEP);
    return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).toLowerCase();
}

/**
 * Does this line name either side of the pair? Case-folded containment on fold's own keys, no
 * tokenizer, so it reads Han, Hangul and Cyrillic exactly as it reads Latin.
 * @param {string} line The line.
 * @param {string[]} pairNames Both bare names.
 * @returns {boolean} True when the line names either.
 */
function lineNames(line, pairNames) {
    const folded = line.toLowerCase();
    return pairNames.some(name => name.length > 0 && folded.includes(name));
}

/**
 * The identity a pair is deduped under, so a verdict already harvested from a trace (with its
 * ledger context) is not harvested a second time from the chat text (without it). Case-folded and
 * sorted, because the two sources spell the pair differently: the trace carries display names, the
 * persisted key carries the normalised form.
 * @param {string} a One name.
 * @param {string} b The other.
 * @returns {string} The dedupe key.
 */
function dedupeKey(a, b) {
    return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join(PAIR_SEP);
}

/**
 * Slice a sent prompt to the lines that bear on one pair: the ledger and review rows that name
 * either side, plus the narrative paragraphs that do.
 *
 * The prompt is read as written by `extract.js`: a transcript excerpt between `---` fences, then
 * the pinned ledger, then the per-probe instructions. The instructions are the same on every pass
 * and carry no signal about this pair, so they are dropped: everything from the `Extract the
 * following:` line on.
 *
 * @param {string} prompt The exact prompt that was sent.
 * @param {string[]} pairNames Both bare names.
 * @returns {string} The context slice, bounded by `CONTEXT_LIMIT`.
 */
function sliceContext(prompt, pairNames) {
    const lines = String(prompt ?? '').split('\n');
    const kept = [];
    for (const line of lines) {
        // The probe instructions start here and are identical every pass, pure noise for a pair.
        if (line.startsWith('Extract the following:')) {
            break;
        }
        if (!line.trim()) {
            continue;
        }
        if (lineNames(line, pairNames)) {
            kept.push(line.trim());
        }
    }
    return kept.join('\n').slice(0, CONTEXT_LIMIT);
}

/**
 * The narrative context for a pair, for chats with no trace: the message paragraphs that name
 * either side, most recent last.
 * @param {string[]} messages The chat's messages.
 * @param {string[]} pairNames Both bare names.
 * @returns {string} The context slice, bounded by `CONTEXT_LIMIT`.
 */
function chatContext(messages, pairNames) {
    const kept = [];
    for (const message of messages) {
        for (const para of message.split('\n')) {
            if (para.trim() && lineNames(para, pairNames)) {
                kept.push(para.trim());
            }
        }
    }
    // The tail is the context closest to when the question was asked.
    return kept.join('\n').slice(-CONTEXT_LIMIT);
}

/**
 * The identity questions one prompt asked, paired with the answers that came back.
 *
 * The question line is fold's own protocol text (`review-table.js` `questionText`), so reading it
 * back is parsing fold's format, not the narrative.
 *
 * @param {object} record One trace record.
 * @returns {Array<{a: string, b: string, of: string, answer: string}>} Answered identity pairs.
 */
function identityAsks(record) {
    const asks = new Map();
    for (const line of String(record?.prompt ?? '').split('\n')) {
        // `  Q1 [same?] Are "X" and "Y" the same person? Answer "same" or "different".`
        const match = line.match(/^\s*([A-Z]\d+) \[same\?\] Are "(.+)" and "(.+)" the same (\S+)\?/);
        if (match) {
            asks.set(match[1], { a: match[2], b: match[3], of: match[4] === 'person' ? 'cast' : 'thread' });
        }
    }
    const out = [];
    for (const answer of Array.isArray(record?.parsed?.review?.answers) ? record.parsed.review.answers : []) {
        const ask = asks.get(String(answer?.id ?? ''));
        const value = String(answer?.answer ?? '');
        if (ask && value) {
            out.push({ ...ask, answer: value });
        }
    }
    return out;
}

/**
 * The witness text a resolver featurizes: the two names, then the context that decided them.
 *
 * The names are sorted for the same reason `pairKey` sorts, the detector may present the pair in
 * either order on different passes, and one ordering must not become a second, unrelated witness.
 *
 * @param {string} a One name.
 * @param {string} b The other.
 * @param {string} context The context slice.
 * @returns {string} The witness text.
 */
function witnessText(a, b, context) {
    const [left, right] = [String(a), String(b)].sort();
    return `${left} | ${right}\n${context}`;
}

function main() {
    const chatsDir = path.join(dataRoot, 'default-user', 'chats');
    const tracesDir = path.join(dataRoot, 'default-user', 'extensions', 'sanguine-traces');
    const chats = findChatFiles(chatsDir);
    if (!chats.length) {
        console.error(`No chats at ${chatsDir}, nothing to harvest.`);
        process.exit(1);
    }

    const lines = [];
    const summary = [];

    for (const { chatId, file } of chats) {
        const { meta, messages } = readChat(file);

        // traces, and the contextual pairs only a trace can supply.
        let traceCount = 0;
        let tracePairs = 0;
        // Pairs a trace already covered, so the same verdict is not emitted twice, once with the
        // ledger context and once with only the narrative.
        const covered = new Set();
        const tracePath = path.join(tracesDir, `${chatId}.jsonl`);
        if (fs.existsSync(tracePath)) {
            for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
                if (!line.trim()) {
                    continue;
                }
                let record;
                try {
                    record = JSON.parse(line);
                } catch {
                    // A corrupt trace line is skipped; the rest of the pass log still counts.
                    continue;
                }
                lines.push(JSON.stringify({ kind: 'trace', chat: chatId, ...record }));
                traceCount += 1;
                for (const ask of identityAsks(record)) {
                    const context = sliceContext(record.prompt, [ask.a.toLowerCase(), ask.b.toLowerCase()]);
                    covered.add(dedupeKey(ask.a, ask.b));
                    lines.push(JSON.stringify({
                        kind: 'pair',
                        chat: chatId,
                        a: ask.a,
                        b: ask.b,
                        of: ask.of,
                        why: nearIdentity(ask.a, ask.b),
                        answer: ask.answer,
                        source: 'trace',
                        turn: Number.isFinite(record?.turn) ? record.turn : null,
                        context,
                        text: witnessText(ask.a, ask.b, context),
                    }));
                    tracePairs += 1;
                }
            }
        }

        // the persisted verdicts: every chat's, trace or no trace.
        let verdictCount = 0;
        let chatPairs = 0;
        const answers = meta?.state?.answers;
        if (answers && typeof answers === 'object') {
            for (const [pair, value] of Object.entries(answers)) {
                const answer = value?.answer ?? null;
                lines.push(JSON.stringify({
                    kind: 'verdict',
                    chat: chatId,
                    pair,
                    answer,
                    at: value?.at ?? null,
                }));
                verdictCount += 1;

                const [a, b] = pair.split(PAIR_SEP);
                if (!answer || !a || !b) {
                    continue;
                }
                const bare = [bareName(a), bareName(b)];
                // A trace already produced this pair with the stronger context; don't double it.
                if (covered.has(dedupeKey(bare[0], bare[1]))) {
                    continue;
                }
                const context = chatContext(messages, bare);
                lines.push(JSON.stringify({
                    kind: 'pair',
                    chat: chatId,
                    a: bare[0],
                    b: bare[1],
                    of: String(a).includes(KIND_SEP) ? 'cast' : 'thread',
                    why: nearIdentity(bare[0], bare[1]),
                    answer,
                    source: 'chat',
                    turn: null,
                    context,
                    text: witnessText(bare[0], bare[1], context),
                }));
                chatPairs += 1;
            }
        }

        if (traceCount || verdictCount) {
            summary.push({ chat: chatId, traces: traceCount, verdicts: verdictCount, pairs: tracePairs + chatPairs });
        }
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

    const totals = summary.reduce((t, r) => ({
        traces: t.traces + r.traces,
        verdicts: t.verdicts + r.verdicts,
        pairs: t.pairs + r.pairs,
    }), { traces: 0, verdicts: 0, pairs: 0 });

    console.log(`Wrote ${lines.length} lines to ${outputPath}`);
    for (const row of summary) {
        console.log(`  ${row.chat}: ${row.traces} traces, ${row.verdicts} verdicts, ${row.pairs} contextual pairs`);
    }
    console.log(`  TOTAL: ${totals.traces} traces, ${totals.verdicts} verdicts, ${totals.pairs} contextual pairs`);
}

main();
