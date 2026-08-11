/**
 * fold-trace — the prompt->output trace for the fold extension.
 *
 * fold (`public/scripts/extensions/fold/`) runs one shared LLM call per extraction cycle: it
 * builds a prompt (the narrative window + the pinned ledger + the probe instructions), sends it,
 * and parses the model's reply into per-probe fragments. Everything but the parsed fragments is
 * discarded on success — the exact prompt string and the raw model reply are gone, so nothing can
 * later answer "what input produced this output?" or re-derive the pair a resolver should learn
 * from. This endpoint is the durable sink for that pair: one JSONL line per pass, appended to a
 * per-chat file, so a week of roleplay survives reloads without riding the 128KB `chat_metadata`
 * budget that fold's own state enforces.
 *
 * The trace is append-only by design. Reads stream the file back; there is no edit and no delete
 * route — a record of what the model was actually shown and actually returned is evidence, and
 * evidence that can be edited stops being evidence.
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const router = express.Router();

/** The per-user directory that holds every chat's trace file. */
export function traceDirectory(userDirectories) {
    const dir = path.join(userDirectories.extensions, 'fold-traces');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** The trace file for one chat. The chat id is already a filename-safe value from the client. */
export function traceFile(userDirectories, chatId) {
    return path.join(traceDirectory(userDirectories), sanitize(`${chatId}.jsonl`));
}

/**
 * Append one trace record for a chat.
 * @param {string} chatId The chat id (already URL-safe from the client).
 * @param {object} record The record: `{t, turn, mid, why, profileId, responseLength, prompt,
 *   schema, raw, parsed, ok, reason}`.
 */
export function appendTrace(userDirectories, chatId, record) {
    const file = traceFile(userDirectories, chatId);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\n$/, '') : '';
    const separator = existing.length ? '\n' : '';
    writeFileAtomicSync(file, `${existing}${separator}${JSON.stringify(record)}\n`, 'utf8');
}

/** Every stored record for a chat, one object per line. */
export function readTrace(userDirectories, chatId) {
    const file = traceFile(userDirectories, chatId);
    if (!fs.existsSync(file)) {
        return [];
    }
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return { unparseable: line };
            }
        });
}

router.post('/:chatId', (request, response) => {
    if (!request.body || typeof request.body !== 'object') {
        return response.sendStatus(400);
    }
    const { chatId } = request.params;
    if (!chatId) {
        return response.sendStatus(400);
    }
    appendTrace(request.user.directories, chatId, request.body);
    return response.sendStatus(200);
});

router.get('/:chatId', (request, response) => {
    const { chatId } = request.params;
    if (!chatId) {
        return response.sendStatus(400);
    }
    response.setHeader('Content-Type', 'application/json');
    response.send(JSON.stringify(readTrace(request.user.directories, chatId)));
});
