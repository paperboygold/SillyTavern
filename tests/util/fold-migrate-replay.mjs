#!/usr/bin/env node
/**
 * fold-migrate-replay — run the real migration against copies of the real chats.
 *
 * A migration runs once per chat, in a browser, with nobody watching. Unit tests over a
 * hand-written v1 blob prove the rules; they cannot prove the rules cover what four campaigns
 * actually put in their metadata — a lead whose name is a whole sentence, a clock the repair script
 * typed by hand, a card that never emitted a status block at all, an entity table with a NUL in
 * every key. This is the instrument for that, and it is the same shape as
 * `tests/util/fold-calibrate.mjs`: state the observed number, name what it does not cover.
 *
 * It asserts the invariants FOLD-REDESIGN.md §9 names, per chat:
 *
 *   1. cast row count preserved            (± confirmed merges, which at migration time is zero)
 *   2. thread count = leads + clocks       (plus whatever the block-shadow gate accepted, reported
 *                                           separately so the equality stays checkable)
 *   3. derived money unchanged
 *   4. derived item multiset unchanged apart from the `contacts` rows, each of which is now a
 *      `reach` on the cast row it names
 *   5. every lock intact
 *   6. the chronicle byte-identical — state is a fold, and an event is the record of what happened
 *
 * Phase D adds three, over the staged remainder of §9 (`migrate.js` `migrateBody`, `migrateFacts`):
 *
 *   7. no `health` key survives in v2 context, and no `conditions` key the SCENE PROBE wrote
 *   8. no block-sourced standing truth (`rank`, `mana`, and whatever else a card invented) survives
 *      in v2 context, whenever there is a pov row to move it onto
 *   9. every clause that left a routed field landed somewhere — as a mark, as a fact, or kept
 *      verbatim as a refusal. Nothing is destroyed by a rule that produced nothing.
 *
 * Usage:
 *   node tests/util/fold-migrate-replay.mjs <chat.jsonl> [<chat.jsonl> …]
 *   node tests/util/fold-migrate-replay.mjs --json <chat.jsonl>
 *
 * Reads only. Never writes to a chat file, and never touches a running SillyTavern.
 *
 * ⚠ Point it at COPIES. The user plays on these files and SillyTavern rewrites the whole metadata
 * blob on save; this script refuses any path under `data/` for that reason alone.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { migrate, BODY_LABEL, CLAIMED } from '../../public/scripts/extensions/fold/migrate.js';
import { splitEntityKey } from '../../public/scripts/extensions/fold/entity-table.js';
import { splitConditions } from '../../public/scripts/extensions/fold/block-parse.js';
import {
    BLOCK,
    CONTACTS,
    CONTACT_PLACE,
    HEALTH_LABELS,
    MONEY,
    NARRATIVE,
    deriveState,
    itemKey,
    normalizePlace,
    splitItemKey,
} from '../../public/scripts/extensions/fold/state-table.js';
import { threads } from '../../public/scripts/extensions/fold/thread-table.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const paths = args.filter(arg => !arg.startsWith('--'));

if (!paths.length) {
    console.error('usage: node tests/util/fold-migrate-replay.mjs [--json] <chat.jsonl> [...]');
    process.exit(2);
}

/**
 * Read a chat file's header and its fold blob.
 * @param {string} file A chat JSONL path.
 * @returns {object} The header.
 */
function header(file) {
    if (/(^|\/)data\//.test(path.resolve(file))) {
        throw new Error(`refusing to read a live chat in place: ${file} — copy it first`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0]);
}

/**
 * The derived inventory as a multiset of `name@place` → quantity.
 * @param {object[]} events Chronicle events.
 * @returns {{items: Map<string, number>, money: number, contacts: string[]}} What the fold derives.
 */
function derived(events) {
    const { inv } = deriveState(events);
    const items = new Map();
    let money = 0;
    for (const [key, held] of inv) {
        items.set(key, held?.qty ?? 0);
        if (normalizePlace(splitItemKey(key).place) === MONEY) {
            money += held?.qty ?? 0;
        }
    }
    // ── Read off the LEDGER, not off the derived inventory, since Phase C ──
    //
    // `deriveState` now skips the `contacts` place on read, which is what drove this replay's
    // printed residual to zero (FOLD-REDESIGN.md §10, Phase B LANDED deviation 7). Taking the list
    // from the derived table would therefore make it empty for both `before` and `after`, and the
    // "every contacts row landed as reach" invariant would pass vacuously — a check that cannot
    // fail is worse than no check. The events still carry the rows, so they are the honest source.
    const contacts = [...new Set((events ?? [])
        .flatMap(event => event?.d?.inv ?? [])
        .filter(change => CONTACT_PLACE.test(normalizePlace(change?.at)))
        .map(change => itemKey(String(change.item ?? ''), CONTACTS)))];
    return { items, money, contacts };
}

/**
 * Compare two multisets, ignoring a set of keys.
 * @param {Map<string, number>} before One.
 * @param {Map<string, number>} after Another.
 * @param {Set<string>} ignore Keys to skip.
 * @returns {string[]} Differences, empty when equal.
 */
function diff(before, after, ignore) {
    const out = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
        if (ignore.has(key)) continue;
        const [a, b] = [before.get(key) ?? 0, after.get(key) ?? 0];
        if (a !== b) out.push(`${key}: ${a} → ${b}`);
    }
    return out;
}

/**
 * Replay one chat.
 * @param {string} file A chat JSONL path.
 * @returns {object} The report row.
 */
function replay(file) {
    const head = header(file);
    const fold = head?.chat_metadata?.fold;
    if (!fold) {
        return { file, skipped: 'no fold state' };
    }

    const events = Object.values(fold?.chronicle?.events ?? {});
    const beforeEntities = Object.entries(fold?.state?.entities ?? {});
    // What the context held before, and which of those keys Phase D's rules claim. Captured here
    // because migration deletes them in place and there is no other record of what was there.
    const contextBefore = Object.entries(fold?.state?.context ?? {})
        .map(([label, field]) => ({ label, src: field?.src ?? '', value: String(field?.v ?? '') }));
    const routable = contextBefore.filter(field => HEALTH_LABELS.has(field.label.toLowerCase())
        || (field.label.toLowerCase() === BODY_LABEL && field.src === NARRATIVE));
    const factable = contextBefore.filter(field => field.src === BLOCK && !CLAIMED.has(field.label.toLowerCase()));

    const before = {
        v: fold.v ?? 1,
        people: beforeEntities.filter(([key]) => splitEntityKey(key).kind === 'person').length,
        leads: beforeEntities.filter(([key]) => splitEntityKey(key).kind === 'lead').length,
        clocks: Object.keys(fold?.state?.clocks ?? {}).length,
        locks: JSON.stringify(fold?.state?.locks ?? null),
        chronicle: JSON.stringify(fold?.chronicle ?? null),
        ...derived(events),
    };

    const report = migrate(fold);

    const afterEvents = Object.values(fold?.chronicle?.events ?? {});
    const after = {
        v: fold.v,
        cast: Object.keys(fold?.state?.cast ?? {}).length,
        threads: Object.keys(fold?.state?.threads ?? {}).length,
        locks: JSON.stringify(fold?.state?.locks ?? null),
        chronicle: JSON.stringify(fold?.chronicle ?? null),
        ...derived(afterEvents),
    };

    const contextAfter = Object.keys(fold?.state?.context ?? {});
    const povRow = Object.values(fold?.state?.cast ?? {})
        .find(row => String(row?.name ?? '').toLowerCase()
            === String(fold?.state?.context?.pov?.v ?? '\u0000none').toLowerCase().replace(/^(?:the|a|an)\s+/, ''));
    const marks = [...(povRow?.marks ?? []), ...(fold?.state?.migrated?.marks ?? [])];
    const facts = String(povRow?.facts ?? '');

    // Which cast rows now carry a way of reaching someone, and which contact rows named them.
    const reaches = Object.entries(fold?.state?.cast ?? {})
        .filter(([, row]) => row?.reach)
        .map(([key, row]) => `${key.replace(/\0/g, '/')} → ${row.reach}`);

    const failures = [];
    const check = (ok, label) => { if (!ok) failures.push(label); };

    check(after.v === 2, `version stamped 2 (got ${after.v})`);
    check(after.cast === before.people,
        `cast row count preserved (${before.people} people → ${after.cast} cast)`);
    check(after.threads === before.leads + before.clocks + report.counts.threadsFromContext,
        `threads = leads + clocks + routed block clauses (${before.leads} + ${before.clocks} + ${report.counts.threadsFromContext} → ${after.threads})`);
    check(after.money === before.money, `derived money unchanged (${before.money} → ${after.money})`);
    // No exemption set any more: the `contacts` rows do not derive on either side of the migration,
    // so the multiset has to match exactly.
    const drift = diff(before.items, after.items, new Set());
    check(!drift.length, `derived item multiset unchanged: ${drift.join(', ')}`);
    check(!after.contacts.length || after.contacts.every(key => !after.items.has(key)),
        `no contacts row derives into inventory (${after.contacts.length} in the ledger, 0 expected in state)`);
    check(before.contacts.every(key => reaches.some(line => line.includes(splitItemKey(key).name.replace(/^.*?['’]s\s+/, '')))),
        `every contacts row landed as reach (${before.contacts.length} rows, ${reaches.length} reaches)`);
    check(after.locks === before.locks, `locks intact (${before.locks} → ${after.locks})`);
    check(after.chronicle === before.chronicle, 'chronicle untouched');

    // ── Phase D: the staged remainder of §9 ──
    check(!contextAfter.some(label => HEALTH_LABELS.has(label.toLowerCase())),
        `no health key survives in v2 context (${contextAfter.join(', ')})`);
    check(!routable.some(field => contextAfter.includes(field.label)),
        `every body-state field left context (${routable.map(f => f.label).join(', ') || 'none'})`);
    // Only where there was somebody to own them. A chat with no pov row keeps its standing truths in
    // context, visibly, rather than having them parked in a bucket nothing reads (`migrateFacts`).
    check(!povRow || !factable.some(field => contextAfter.includes(field.label)),
        `every block-only standing truth left context (${factable.map(f => f.label).join(', ') || 'none'})`);
    // Nothing destroyed by a rule that produced nothing: every clause of every routed field is
    // either a mark, or inside the facts string, or was refused by `isNegation` — and a refusal is
    // recorded here rather than being invisible.
    const routedClauses = routable.flatMap(field => splitConditions(field.value));
    const landed = routedClauses.filter(clause => marks.some(mark => mark.phrase === clause));
    check(landed.length === routedClauses.length,
        `every routed body clause landed as a mark (${landed.length}/${routedClauses.length})`);
    const factsLanded = povRow ? factable.filter(field => facts.includes(field.value)) : factable;
    check(factsLanded.length === factable.length,
        `every rescued standing truth is on the row (${factsLanded.length}/${factable.length})`);

    // Idempotence and the retirement stage, replayed on the same blob the app would reload.
    const reloaded = JSON.parse(JSON.stringify(fold));
    const second = migrate(reloaded);
    check(second.counts.cast === 0 && second.counts.threadsFromLeads === 0, 're-running the migration is a no-op');
    check(!reloaded.state.entities && !reloaded.state.clocks, 'old keys retired once v2 came back off disk');
    check(Object.keys(reloaded.state.cast ?? {}).length === after.cast, 'retirement preserves the cast');
    check(Object.keys(reloaded.state.threads ?? {}).length === after.threads, 'retirement preserves the threads');

    return {
        file: path.basename(file),
        before: { people: before.people, leads: before.leads, clocks: before.clocks, items: before.items.size, money: before.money, contacts: before.contacts.length },
        after: { cast: after.cast, threads: after.threads, items: after.items.size, money: after.money, reaches: reaches.length },
        counts: report.counts,
        identity: report.flags.identity,
        polarity: report.flags.polarity.length,
        dropped: (fold.state.migrated?.dropped ?? []).length,
        contextBefore: contextBefore.map(field => `${field.label}${field.src ? `(${field.src})` : ''}`),
        contextAfter,
        marks: marks.map(mark => `${mark.who || '(pov)'}: ${mark.phrase} [${mark.severity}]`),
        facts,
        keptBody: routable.filter(field => contextAfter.includes(field.label)).map(field => field.label),
        // Rows the ledger still carries that the DERIVED inventory still shows. Phase B's
        // printed residual; zero is the Phase C read rule holding.
        residualContacts: after.contacts.filter(key => after.items.has(key)).length,
        failures,
    };
}

const rows = paths.map(replay);

if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
} else {
    for (const row of rows) {
        if (row.skipped) {
            console.log(`\n${row.file}\n  skipped — ${row.skipped}`);
            continue;
        }
        console.log(`\n${row.file}`);
        console.log(`  before   people ${row.before.people} · leads ${row.before.leads} · clocks ${row.before.clocks} · items ${row.before.items} · money ${row.before.money} · contacts rows ${row.before.contacts}`);
        console.log(`  after    cast ${row.after.cast} · threads ${row.after.threads} · items ${row.after.items} · money ${row.after.money} · reaches ${row.after.reaches}`);
        console.log(`  routed   from leads ${row.counts.threadsFromLeads} · from clocks ${row.counts.threadsFromClocks} · from block prose ${row.counts.threadsFromContext} · refused ${row.counts.blockShadow} (kept verbatim: ${row.dropped})`);
        console.log(`  context  before: ${row.contextBefore.join(', ') || '(none)'}`);
        console.log(`           after:  ${row.contextAfter.join(', ') || '(none)'}`);
        console.log(`  marks    ${row.marks.length ? row.marks.join(' · ') : '(none)'}`);
        console.log(`  facts    ${row.facts || '(none)'}`);
        console.log(`  asked    identity ${row.identity.length} · polarity ${row.polarity} · unowned contact rows ${row.counts.unowned}`);
        for (const question of row.identity) {
            console.log(`           ${question.kind}: ${question.a.replace(/\0/g, '/')}  ↔  ${question.b.replace(/\0/g, '/')}   (${question.why})`);
        }
        if (row.before.contacts) {
            // Phase B printed a RESIDUAL here — the contacts rows still derived, because migration
            // moved them onto the cast rows without touching the ledger and state is a fold. Phase C
            // added the read rule in `deriveState`; the residual is a count of rows that are in the
            // ledger and no longer in the derived state, which is what "driven to zero" means.
            console.log(`  contacts ${row.before.contacts} row(s) in the ledger · ${row.residualContacts} still deriving (0 = the read rule holds)`);
        }
        console.log(row.failures.length
            ? `  FAIL     ${row.failures.join('\n           ')}`
            : '  ok       every §9 invariant holds');
    }
}

const failed = rows.filter(row => row.failures?.length).length;
if (failed) {
    console.error(`\n${failed} chat(s) failed a §9 invariant`);
    process.exit(1);
}
