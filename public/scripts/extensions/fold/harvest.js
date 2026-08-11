/**
 * fold/harvest.js — consolidate the week's traces into a resolver-ready corpus.
 *
 * Run from the SillyTavern repo root:
 *
 *     node public/scripts/extensions/fold/harvest.js [data-root]
 *
 * Reads every chat's `fold-traces/<chat>.jsonl` (the prompt->output pairs recorded since the
 * trace was added) and, for chats that have it, the persisted `state.answers` identity-pair
 * verdicts from their `chat_metadata.fold.state`. Writes one JSONL corpus to
 * `data/<user>/fold-corpus.jsonl`:
 *
 *   { "chat": "Time Stop RPG Fantasy - ...", "kind": "trace",  "turn": 3, "mid": 7,
 *     "ok": true, "prompt": "...", "schema": {...}, "raw": "...", "parsed": {...} }
 *   { "chat": "...", "kind": "verdict", "pair": "a\u0001b", "answer": "same", "at": 1786351019195 }
 *
 * The trace lines are the full input->output evidence the resolver (`lib/ml/`) trains on; the
 * verdict lines are the identity-pair labels `state.answers` already persisted. Both feed the
 * same corpus — the trace explains the output, the verdicts are the labels.
 *
 * Output path can be overridden with the second argument. Prints a per-chat and total summary.
 */

import fs from 'node:fs';
import path from 'node:path';

const dataRoot = path.resolve(process.argv[2] ?? 'data');
const outputPath = path.resolve(process.argv[3] ?? path.join(dataRoot, 'fold-corpus.jsonl'));

/** Find a chat JSONL by its id, searching the per-character subdirectories. */
function findChatFile(chatsDir, chatId) {
    if (!fs.existsSync(chatsDir)) {
        return null;
    }
    // The chat id is the filename without `.jsonl` (SillyTavern's `getCurrentChatId()` returns
    // `characters[x].chat`); the file on disk is `<id>.jsonl` under the character's folder.
    const chatName = chatId.endsWith('.jsonl') ? chatId : `${chatId}.jsonl`;
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = path.join(chatsDir, entry.name, chatName);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

/** Read the chat_metadata.fold blob out of a chat JSONL (the last object that carries one). */
function readFoldMeta(chatFile) {
    let meta = null;
    const text = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, 'utf8') : '';
    for (const line of text.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const obj = JSON.parse(line);
            const fold = obj?.chat_metadata?.fold;
            if (fold && typeof fold === 'object') {
                meta = fold;
            }
        } catch {
            // A malformed line ends the chat's metadata scan; keep whatever we had.
        }
    }
    return meta;
}

function main() {
    const chatsDir = path.join(dataRoot, 'default-user', 'chats');
    const tracesDir = path.join(dataRoot, 'default-user', 'extensions', 'fold-traces');
    if (!fs.existsSync(tracesDir)) {
        console.error(`No fold-traces directory at ${tracesDir} — has the trace been recording passes yet?`);
        process.exit(1);
    }

    const lines = [];
    const summary = [];

    for (const traceFile of fs.readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))) {
        const chatId = path.basename(traceFile, '.jsonl');
        const chatFile = findChatFile(chatsDir, chatId);
        const meta = chatFile ? readFoldMeta(chatFile) : null;

        let traceCount = 0;
        const tracePath = path.join(tracesDir, traceFile);
        for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
            if (!line.trim()) {
                continue;
            }
            try {
                const record = JSON.parse(line);
                lines.push(JSON.stringify({ chat: chatId, kind: 'trace', ...record }));
                traceCount += 1;
            } catch {
                // skip a corrupt trace line; the rest still count
            }
        }

        let verdictCount = 0;
        const answers = meta?.state?.answers;
        if (answers && typeof answers === 'object') {
            for (const [pair, value] of Object.entries(answers)) {
                lines.push(JSON.stringify({
                    chat: chatId,
                    kind: 'verdict',
                    pair,
                    answer: value?.answer ?? null,
                    at: value?.at ?? null,
                }));
                verdictCount += 1;
            }
        }

        summary.push({ chat: chatId, traces: traceCount, verdicts: verdictCount });
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');

    console.log(`Wrote ${lines.length} lines to ${outputPath}`);
    for (const row of summary) {
        console.log(`  ${row.chat}: ${row.traces} traces, ${row.verdicts} identity verdicts`);
    }
}

main();
