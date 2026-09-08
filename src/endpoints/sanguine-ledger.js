/**
 * sanguine-ledger — the durable, append-only event ledger for the fold extension.
 *
 * ── Why this exists ──
 *
 * fold's state is a fold over its event stream. Until now that stream lived in
 * `chat_metadata.fold`, inside the chat's own JSONL header, under a hard 128 KiB ceiling
 * (`public/scripts/extensions/sanguine/store.js`). Measured over the live campaigns, that ceiling binds
 * at roughly 250–300 messages — about two weeks of daily play — and what happens at the wall is
 * worse than a refusal to write: events are evicted, and eviction USED to drop the state delta, so
 * a balance silently rewound to match a history that no longer existed.
 *
 * A year of daily play is ~3,650 messages ≈ 5,000–8,000 events ≈ 1.5–2.5 MB. That is nothing on
 * disk and impossible inside a metadata blob that is rewritten in full on every commit. So the
 * stream moves here: one file per campaign, append-only, with the delta kept forever.
 *
 * ── Append-only is the feature, not the implementation ──
 *
 * Three properties the owner asked for all fall out of "never mutate, only append":
 *
 *   · **Fidelity.** Every quantity traces to the op that caused it, at any age.
 *   · **Time travel.** State at any point is the fold of the prefix up to that point. This is
 *     `replay_append` in the sanguine corpus (`AIOperationSurface.lean:142`):
 *     `replayFold base (xs ++ ys) = replayFold (replayFold base xs) ys` — folding a prefix and then
 *     continuing is the same as folding the whole. A prefix read IS a restore.
 *   · **Forking.** A branch is a child campaign pinned at `(parent, forkSeq)`. Its state is the
 *     parent's prefix followed by its own ops. Nothing is copied, so forking is O(1) in bytes and
 *     arbitrarily deep.
 *
 * ── This file is deliberately op-agnostic ──
 *
 * It assigns sequence numbers, stores opaque JSON records and serves prefixes. It does not know
 * what an op MEANS — no schema, no validation of op kinds, no replay. That belongs to the client,
 * which already owns the fold (`state-table.js` `deriveState`). Keeping the transport ignorant is
 * what lets the op vocabulary change without a server migration, and it is why this endpoint can be
 * built before that vocabulary is finally settled.
 *
 * ── What it does NOT do ──
 *
 * No edit route and no delete route, for the same reason `sanguine-trace` has none: a ledger that can be
 * rewritten is not a ledger. Compaction, when it is needed, will be a new campaign seeded from a
 * checkpoint — an append, not a mutation.
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const router = express.Router();

/** One line per op; a campaign is a directory so its metadata can sit beside its ledger. */
const LEDGER_FILE = 'ledger.jsonl';
const META_FILE = 'campaign.json';

/**
 * Highest assigned `seq` per campaign, so an append does not have to read the file.
 *
 * Rebuilt by scanning when a campaign is first touched in this process, which is the only correct
 * source: a crash between the append and a sidecar write would leave any cached counter stale, and
 * the file itself cannot lie about what it contains. SillyTavern is a single server process, so one
 * scan per campaign per boot is the whole cost — and the scan is over a file measured at 1.5–2.5 MB
 * for a full year of play.
 *
 * Keyed by the resolved DIRECTORY, not the campaign id. The id alone is ambiguous: the same id under
 * two users resolves to two files, and a counter shared between them would hand out a `seq` that
 * already exists in one of the ledgers — silently, and at the one place the whole timeline is
 * indexed. Campaign ids are fold-minted UUIDs so a real collision is improbable, but "improbable"
 * is not a property to hang durability on when the correct key is right there.
 *
 * @type {Map<string, number>}
 */
const heads = new Map();

/** The directory holding every campaign. */
export function ledgerDirectory(userDirectories) {
    const dir = path.join(userDirectories.extensions, 'sanguine-ledger');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * The directory for one campaign.
 *
 * `sanitize` is the same guard `sanguine-trace` uses on its chat id. Campaign ids are fold-minted
 * UUIDs rather than user-typed names, so this is defence in depth rather than the primary control —
 * but the primary control is on the client, and a path traversal here would be a file write outside
 * the data directory, so it is checked where it is enforced.
 */
export function campaignDirectory(userDirectories, campaignId) {
    const safe = sanitize(String(campaignId));
    if (!safe) {
        return '';
    }
    const dir = path.join(ledgerDirectory(userDirectories), safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Read a campaign's metadata: its parent link, if it is a fork, and when it was created. */
export function readMeta(userDirectories, campaignId) {
    const dir = campaignDirectory(userDirectories, campaignId);
    if (!dir) {
        return null;
    }
    const file = path.join(dir, META_FILE);
    if (!fs.existsSync(file)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Write a campaign's metadata. Atomic, because a torn metadata file orphans an entire campaign —
 * the ledger would survive with nothing able to say what it forked from.
 */
export function writeMeta(userDirectories, campaignId, meta) {
    const dir = campaignDirectory(userDirectories, campaignId);
    if (!dir) {
        return false;
    }
    writeFileAtomicSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
    return true;
}

/**
 * Read a campaign's ops, optionally only those up to and including `upto`.
 *
 * ── The torn tail is dropped; a torn middle is surfaced ──
 *
 * An append that was interrupted by a crash or a full disk can leave a partial final line. That op
 * was never acknowledged to the client, so nothing downstream believes it happened, and dropping it
 * returns the ledger to its last consistent state — which is exactly what append-only buys.
 *
 * An unparseable line in the MIDDLE is a different animal: the ops after it were acknowledged, so
 * silently skipping it would produce a fold that is quietly missing an event. It is returned as an
 * explicit `{ unparseable }` marker so the client can refuse to derive rather than derive something
 * wrong. Never silently repaired.
 *
 * @param {object} userDirectories The user's directories.
 * @param {string} campaignId The campaign.
 * @param {number} [upto] Highest `seq` to include; omit for everything.
 * @returns {{ops: object[], torn: boolean, damaged: number}} Ops in seq order, and what was wrong.
 */
export function readLedger(userDirectories, campaignId, upto = Infinity) {
    const dir = campaignDirectory(userDirectories, campaignId);
    const file = dir && path.join(dir, LEDGER_FILE);
    if (!file || !fs.existsSync(file)) {
        return { ops: [], torn: false, damaged: 0 };
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    // A trailing newline makes the last element empty; that is a CLEAN end, not a torn one.
    const trailingBlank = lines.length && lines[lines.length - 1] === '';
    if (trailingBlank) {
        lines.pop();
    }

    const ops = [];
    let torn = false;
    let damaged = 0;
    lines.forEach((line, index) => {
        if (!line.trim()) {
            return;
        }
        const isLast = index === lines.length - 1;
        try {
            const op = JSON.parse(line);
            if (Number.isFinite(op?.seq) && op.seq <= upto) {
                ops.push(op);
            }
        } catch {
            // Unparseable and last, with no trailing newline: the write was cut off mid-flight.
            if (isLast && !trailingBlank) {
                torn = true;
                return;
            }
            damaged++;
            ops.push({ unparseable: line });
        }
    });
    return { ops, torn, damaged };
}

/**
 * The highest `seq` this campaign has assigned, scanning once per process.
 *
 * Reads the file rather than trusting a sidecar, because the file is the only thing that cannot be
 * out of date with itself. A torn tail does not count: that op was never acknowledged, so the next
 * append reuses its number and overwrites nothing (the torn text stays as a dead line the reader
 * already drops).
 */
export function headSeq(userDirectories, campaignId) {
    const dir = campaignDirectory(userDirectories, campaignId);
    if (!dir) {
        return 0;
    }
    if (heads.has(dir)) {
        return heads.get(dir);
    }
    const { ops } = readLedger(userDirectories, campaignId);
    const seq = ops.reduce((max, op) => (Number.isFinite(op?.seq) && op.seq > max ? op.seq : max), 0);
    heads.set(dir, seq);
    return seq;
}

/**
 * Append ops to a campaign, assigning each a monotonic `seq`.
 *
 * ── Why the server assigns the sequence and the client may not ──
 *
 * `seq` is the timeline coordinate: it is what a prefix read cuts on and what a fork pins to. Two
 * tabs open on one chat both believe they are at the same point, so a client-assigned number would
 * collide and two different ops would claim one position on the timeline. The corpus is blunt about
 * the consequence for the merges that are not commutative — `merge_B_order_matters`
 * (`OntologyClosure.lean:136`) — and `merge_max_converges` (`:152`) is the repair: a versioned
 * last-write converges, an unversioned one does not. The server clock is that version.
 *
 * One `appendFileSync` per batch, not per op, and never the read-whole-file-and-rewrite that
 * `sanguine-trace` does (`sanguine-trace.js:45-50`) — that is O(file) per record and is precisely the cost
 * this endpoint exists to remove.
 *
 * @param {object} userDirectories The user's directories.
 * @param {string} campaignId The campaign.
 * @param {object[]} records Ops to append; `seq` and `at` are assigned here and overwrite any sent.
 * @returns {{from: number, to: number, ops: object[]}} The seq range assigned.
 */
export function appendLedger(userDirectories, campaignId, records) {
    const dir = campaignDirectory(userDirectories, campaignId);
    if (!dir || !Array.isArray(records) || !records.length) {
        return { from: 0, to: 0, ops: [] };
    }
    const start = headSeq(userDirectories, campaignId);
    const at = Date.now();
    const ops = records.map((record, index) => ({
        ...record,
        seq: start + index + 1,
        at,
    }));
    fs.appendFileSync(
        path.join(dir, LEDGER_FILE),
        ops.map(op => JSON.stringify(op)).join('\n') + '\n',
        'utf8',
    );
    const to = start + ops.length;
    heads.set(dir, to);
    return { from: start + 1, to, ops };
}

/**
 * The full op history for a campaign, walking its fork chain to the root.
 *
 * A fork stores nothing but a parent link and the seq it split at, so reading it means folding the
 * parent's prefix and then its own ops — recursively, to whatever depth the chain runs. This is the
 * read side of "fork from any point arbitrarily": the cost of a fork is one line of metadata, and
 * the cost of reading one is a walk up a chain whose length is the number of times the player has
 * branched, not the length of the story.
 *
 * Cycles are impossible by construction (a parent always predates its child) but are guarded anyway,
 * because a hand-edited or half-restored `campaign.json` would otherwise hang the server.
 *
 * @returns {{ops: object[], chain: string[], torn: boolean, damaged: number}} The resolved history.
 */
export function resolveHistory(userDirectories, campaignId, upto = Infinity) {
    const chain = [];
    const seen = new Set();
    let current = String(campaignId);
    let cut = upto;

    // Walk up to the root first, recording where each child was cut from its parent.
    const steps = [];
    while (current && !seen.has(current)) {
        seen.add(current);
        chain.unshift(current);
        const meta = readMeta(userDirectories, current);
        steps.unshift({ campaign: current, upto: cut });
        if (!meta?.parent) {
            break;
        }
        cut = Number.isFinite(meta.forkSeq) ? meta.forkSeq : Infinity;
        current = String(meta.parent);
    }

    const ops = [];
    let torn = false;
    let damaged = 0;
    for (const step of steps) {
        const read = readLedger(userDirectories, step.campaign, step.upto);
        ops.push(...read.ops);
        torn = torn || read.torn;
        damaged += read.damaged;
    }
    return { ops, chain, torn, damaged };
}

/**
 * Re-inline a chat's ledger into its own metadata, for export.
 *
 * ── Why export needs this at all ──
 *
 * The chronicle lives on disk and `chat_metadata.fold.chronicle.events` is a cache the budget
 * pruner is free to shed (`chronicle.js`, the PRUNE_MEMORY pruner). That is right for a running
 * chat and wrong for an exported one: `/api/chats/export` ships the chat file verbatim, so a long
 * campaign would export its transcript plus whatever slice of memory happened to survive pruning —
 * silently, and looking complete.
 *
 * Inlining makes the exported file self-contained and needs no new format: the receiving side sees
 * an ordinary chat whose metadata holds every event, and `chronicle.seedLedger()` turns that back
 * into a ledger on first hydrate. The mirror IS the interchange format, in both directions.
 *
 * Uses the shipped replay rather than a server-side reimplementation — the same rule that made
 * `observedKeys` call `normalizeItemName` instead of guessing at it. `ledger-table.js` imports only
 * `lib/hash.js`, so it loads in plain Node.
 *
 * @param {object} userDirectories The user's directories.
 * @param {string} raw The chat file, verbatim.
 * @returns {Promise<string>} The chat file with its ledger inlined, or `raw` unchanged.
 */
export async function inlineForExport(userDirectories, raw) {
    const lines = String(raw ?? '').split('\n');
    if (!lines.length || !lines[0].trim()) {
        return raw;
    }
    let header;
    try {
        header = JSON.parse(lines[0]);
    } catch {
        return raw;
    }
    const campaign = header?.chat_metadata?.fold?.campaign;
    if (!campaign) {
        return raw;
    }
    try {
        const { ops, damaged } = resolveHistory(userDirectories, campaign);
        if (!ops.length || damaged) {
            // A damaged ledger must not silently overwrite the mirror with a partial history —
            // the cache may well be the more complete of the two.
            return raw;
        }
        const { effectiveOps, replay } = await import('../../public/scripts/extensions/sanguine/ledger-table.js');
        const { events } = replay(effectiveOps(ops).ops);
        if (!events.size) {
            return raw;
        }
        header.chat_metadata.fold.chronicle = {
            ...(header.chat_metadata.fold.chronicle ?? {}),
            events: Object.fromEntries(events),
        };
        lines[0] = JSON.stringify(header);
        return lines.join('\n');
    } catch (error) {
        // An export that fails to enrich is still a valid export; one that throws is not.
        console.error('[sanguine] could not inline ledger for export', error);
        return raw;
    }
}

router.post('/:campaignId', (request, response) => {
    const { campaignId } = request.params;
    if (!campaignId || !request.body) {
        return response.sendStatus(400);
    }
    // One op or a batch; a batch is one file write and one seq range, which is what makes an
    // extraction pass's several ops land together or not at all.
    const records = Array.isArray(request.body) ? request.body : [request.body];
    if (!records.length || records.some(record => !record || typeof record !== 'object')) {
        return response.sendStatus(400);
    }
    const result = appendLedger(request.user.directories, campaignId, records);
    response.setHeader('Content-Type', 'application/json');
    return response.send(JSON.stringify({ from: result.from, to: result.to }));
});

router.get('/:campaignId', (request, response) => {
    const { campaignId } = request.params;
    if (!campaignId) {
        return response.sendStatus(400);
    }
    // `upto` is the time machine: everything at or before this seq, and nothing after.
    const raw = Number(request.query.upto);
    const upto = Number.isFinite(raw) ? raw : Infinity;
    // `flat=1` reads this campaign's own ops only, without walking its parents — for tooling that
    // wants to see what a fork itself contributed.
    const read = request.query.flat
        ? { ...readLedger(request.user.directories, campaignId, upto), chain: [String(campaignId)] }
        : resolveHistory(request.user.directories, campaignId, upto);
    response.setHeader('Content-Type', 'application/json');
    return response.send(JSON.stringify({
        campaign: campaignId,
        chain: read.chain,
        head: headSeq(request.user.directories, campaignId),
        torn: read.torn,
        damaged: read.damaged,
        ops: read.ops,
    }));
});

router.get('/:campaignId/meta', (request, response) => {
    const { campaignId } = request.params;
    if (!campaignId) {
        return response.sendStatus(400);
    }
    response.setHeader('Content-Type', 'application/json');
    return response.send(JSON.stringify({
        campaign: campaignId,
        head: headSeq(request.user.directories, campaignId),
        ...(readMeta(request.user.directories, campaignId) ?? {}),
    }));
});

router.post('/:campaignId/fork', (request, response) => {
    const { campaignId } = request.params;
    const child = String(request.body?.child ?? '');
    if (!campaignId || !child) {
        return response.sendStatus(400);
    }
    // Fork at HEAD unless a point on the timeline was named. Clamped to the parent's head, because
    // a fork pinned past the end would silently start including ops the parent had not written yet.
    const head = headSeq(request.user.directories, campaignId);
    const asked = Number(request.body?.forkSeq);
    const forkSeq = Number.isFinite(asked) ? Math.max(0, Math.min(asked, head)) : head;

    if (readMeta(request.user.directories, child)) {
        // Forking onto an existing campaign would rewrite its ancestry, which is the one edit an
        // append-only store must refuse.
        return response.sendStatus(409);
    }
    const ok = writeMeta(request.user.directories, child, {
        campaign: child,
        parent: String(campaignId),
        forkSeq,
        createdAt: Date.now(),
    });
    if (!ok) {
        return response.sendStatus(400);
    }
    response.setHeader('Content-Type', 'application/json');
    return response.send(JSON.stringify({ campaign: child, parent: campaignId, forkSeq }));
});
