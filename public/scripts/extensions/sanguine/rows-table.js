/**
 * fold/rows-table.js. THE ROW TABLE: one table, stable opaque IDs, the fold is the only write.
 *
 * The Phase 1 replacement for the state tables, built from the census (`FOLD-CENSUS.md`).
 * Every tracked object (item, vital, mark, person, thread, clock, scene field) is a ROW with a
 * stable opaque ID. Rows are referenced by ID, never by name. State is a FOLD of ops over rows;
 * nothing is stored independently of the fold, so a re-fold is exact.
 *
 * WHY IDS (census row 1): the record failed because identity was guessed from free text: `knife`
 * ×10 against `ka-bar knife`, `key` ×6 against seven specific keys, `Sol`/`Solomon`/`Solomon
 * Winters` for one pov (`FOLD-CENSUS.md` §1). An opaque ID cannot be misspelled. The pinned ledger
 * prints IDs; the model references them; a held thing cannot grow a second row.
 *
 * WHY THE FOLD IS THE ONLY WRITE (census rows 3, 7): a `gain`/`spend` is `qty = qty + dq` with the
 * place ceiling, a commutative monoid, exact by construction. A `set` (the story stating a total)
 * records the conservation diff: `set` vs the accumulated `qty`. That diff is the surface the deep
 * audit (Phase 3) adjudicates; it is never silently adopted and never silently ignored.
 *
 * WHY `seen` (census row 4): temporality. Every op touches `seen = t`. The staleness detector reads
 * a carried/open row whose `seen` is old and ASKS, it never hides.
 *
 * THE OPS (the whole language):
 *   new      create a row (fold assigns the next ID)
 *   gain     +dq at the row's place, capped at the place ceiling
 *   spend    −dq, floored at 0
 *   set      the story stated an absolute total; records the conservation diff
 *   move     change place
 *   change   field edit on a survivor (rank/name/who)
 *   close    resolved, leaves the pinned ledger
 *   same_as  id is a spelling of target; target survives, id is merged away
 *   none     explicitly checked and kept
 *
 * PLACES: an item is carried or stored at a place. A person is located but never carried, so a
 * category token on a person means "no place known". Every other kind, a thread, a condition
 * (mark), a vital, a clock, a scene field, has NO place at all, an ongoing correspondence does
 * not sit in a pocket, and a row that prints `, carried` teaches the model to keep proposing such
 * things as carried items.
 */

/** The place ceilings, mirroring `state-table.js` `maxQty`. */
export const MAX_QTY = 9999;
export const MAX_MONEY = Number.MAX_SAFE_INTEGER;
export const maxQty = (place) => (place === 'money' ? MAX_MONEY : place === 'abilities' ? 1 : MAX_QTY);

/** Row kinds. */
export const KINDS = Object.freeze(['item', 'vital', 'mark', 'person', 'thread', 'clock', 'scene']);

/** Ops that carry a quantity. */
const QUANTITY_OPS = new Set(['gain', 'spend', 'set']);

/** Token containment either way, `nearIdentity`'s algebra, structure only, no morphology. */
function tokens(name) {
    return new Set(String(name).toLowerCase().trim().split(/[^0-9a-z\u00e0-\u00ff]+/i).filter(Boolean));
}
/** Strict token containment in either direction. Raises a question; never decides. */
export function nearIdentity(a, b) {
    const ta = tokens(a); const tb = tokens(b);
    if (!ta.size || !tb.size || ta.size === tb.size) return false;
    const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    for (const tok of small) if (!large.has(tok)) return false;
    return true;
}

/** @returns {object} An empty row table: `{rows: Map<id, Row>, nextId: number}`. */
export function makeTable() {
    return { rows: new Map(), nextId: 1 };
}

/** Serialise the table for the fold blob (a Map does not survive JSON). */
export function serialize(table) {
    return { nextId: table.nextId, rows: Array.from(table.rows.values()) };
}

/** Rebuild a table from serialised data. */
export function deserialize(data) {
    const table = makeTable();
    const nextId = Number(data?.nextId);
    if (Number.isFinite(nextId) && nextId > 0) table.nextId = nextId;
    for (const row of Array.isArray(data?.rows) ? data.rows : []) {
        if (row && row.id) table.rows.set(row.id, { ...row });
    }
    return table;
}

/**
 * Normalise a place string for keying and ceilings.
 * @param {string} raw A place as the model wrote it.
 * @returns {string} The normalised place.
 */
export function normalizePlace(raw) {
    return String(raw ?? '').trim().toLowerCase() || 'carried';
}

/** The reserved category places, fold's own protocol tokens, never a location. */
const CATEGORY_PLACES = new Set(['carried', 'money', 'assets', 'abilities']);

/**
 * Where a row of `kind` may actually be.
 *
 * An item is carried or stored at a place. A person is located but never carried, so a category
 * token on a person means "no place known" and a literal place is kept. Every other kind, a
 * thread, a condition (mark), a vital, a clock, a scene field, has no place at all: an ongoing
 * correspondence or an access that is still open does not sit in a pocket, and a row that shows
 * `, carried` teaches the model to keep proposing such things as carried items.
 *
 * @param {string} kind The row kind.
 * @param {string} at The place the model wrote, possibly empty.
 * @returns {string} The row's place, '' when the kind does not take one.
 */
function placeFor(kind, at) {
    const place = normalizePlace(at);
    if (kind === 'item') return place;
    if (kind === 'person') return CATEGORY_PLACES.has(place) ? '' : place;
    return '';
}

/**
 * Apply one op to the table. Mutates `table.rows`; returns `{diff}` or `{error}`.
 *
 * @param {object} table The row table.
 * @param {object} op The operation.
 * @param {number} [t] The current turn/mid, the staleness clock.
 * @returns {{diff: object|null, row?: object, error?: string}} Result.
 */
export function applyOp(table, op, t = 0) {
    const { rows } = table;
    const id = String(op?.id ?? '').trim();
    const row = id ? rows.get(id) : undefined;

    if (op.op === 'new') {
        const kind = KINDS.includes(op.kind) ? op.kind : 'item';
        const name = String(op.name ?? '').trim();
        if (!name) return { error: 'new-without-name' };
        // The duplicate-row close (census row 1): a `new` whose name matches a held row of the
        // same kind is a second spelling, not a new thing. Refused, the model must `same_as` it
        // instead, so a held item cannot grow a second row.
        // `op.at ?? op.place`: the probe sends `at`; a caller may send `place`.
        const place = placeFor(kind, op.at ?? op.place);
        const who = String(op.who ?? '').trim();
        for (const held of rows.values()) {
            if (held.status === 'closed') continue;
            if (held.kind !== kind || held.place !== place || held.who !== who) continue;
            if (held.name.toLowerCase() === name.toLowerCase() || nearIdentity(held.name, name)) {
                return { error: 'new-matches-held', held: held.id };
            }
        }
        const rid = `R${table.nextId++}`;
        // Items, clocks and vitals carry a quantity (default 1); marks, people, threads and scene
        // rows are presence only.
        const countCarried = kind === 'item' || kind === 'clock' || kind === 'vital';
        const qty = countCarried ? Math.max(0, Math.trunc(Number(op.qty) || 1)) : 0;
        const rowObj = {
            id: rid, kind, name,
            place, who: String(op.who ?? '').trim(),
            qty: Math.min(qty, maxQty(place)),
            rank: String(op.rank ?? '').trim(),
            status: 'open',
            born: t, seen: t,
            dqSinceSet: 0, stated: null,
        };
        rows.set(rid, rowObj);
        return { row: rowObj, diff: null };
    }

    if (!row) return { error: 'unknown-id' };

    row.seen = t;

    if (op.op === 'gain') {
        const dq = Math.trunc(Number(op.dq) || 0);
        if (dq <= 0) return { error: 'gain-nonpositive' };
        row.qty = Math.min(maxQty(row.place), row.qty + dq);
        row.dqSinceSet += dq;
        return { row, diff: null };
    }
    if (op.op === 'spend') {
        const dq = Math.trunc(Number(op.dq) || 0);
        if (dq <= 0) return { error: 'spend-nonpositive' };
        row.qty = Math.max(0, row.qty - dq);
        row.dqSinceSet -= dq;
        return { row, diff: null };
    }
    if (op.op === 'set') {
        const set = Math.trunc(Number(op.set) || 0);
        if (set < 0) return { error: 'set-negative' };
        // The conservation diff: the accumulated fold vs the stated truth. A mismatch is surfaced,
        // never adopted silently and never ignored, the deep audit resolves it. So on a mismatch
        // the fold KEEPS its value and records the diff as the pending question. Only a matching
        // total (diff 0) or a forced resolution (the audit's `set` verdict, `force: true`) applies.
        const diff = row.qty - set;
        row.stated = { set, t, diff };
        if (op.force || diff === 0) {
            row.qty = Math.min(maxQty(row.place), set);
            row.dqSinceSet = 0;
            return { row, diff: null };
        }
        return { row, diff: { id: row.id, name: row.name, qty: row.qty, set, diff, t } };
    }
    if (op.op === 'move') {
        const place = placeFor(row.kind, op.at ?? op.place);
        const cap = maxQty(place);
        if (row.qty > cap) row.qty = cap;
        row.place = place;
        return { row, diff: null };
    }
    if (op.op === 'change') {
        if (op.name !== undefined) {
            const n = String(op.name ?? '').trim();
            if (!n) return { error: 'change-empty-name' };
            row.name = n;
        }
        if (op.rank !== undefined) row.rank = String(op.rank ?? '').trim();
        if (op.who !== undefined) row.who = String(op.who ?? '').trim();
        return { row, diff: null };
    }
    if (op.op === 'close') {
        row.status = 'closed';
        return { row, diff: null };
    }
    if (op.op === 'same_as') {
        const targetId = String(op.target ?? '').trim();
        const target = rows.get(targetId);
        if (!target || targetId === id) return { error: 'same_as-bad-target' };
        if (target.kind !== row.kind) return { error: 'same_as-kind-mismatch' };
        // Target survives; the merged row is folded in. Quantity sums (items/vitals); the deeper
        // keeper rules (people: longer name; threads: the more advanced dial) are the audit's.
        if (QUANTITY_OPS.has(target.kind) || target.kind === 'item' || target.kind === 'vital') {
            target.qty = Math.min(maxQty(target.place), target.qty + row.qty);
        }
        if (row.place === target.place && target.kind === 'item') {
            // same place + same owner: the honest merge. Different places are two things, not one.
        }
        if (String(row.name).length > String(target.name).length) {
            target.name = row.name;
        }
        rows.delete(id);
        return { row: target, diff: null };
    }
    if (op.op === 'split') {
        // A row whose NAME is several things comma-joined ("tactical bag thinkpad, audit usbs,
        // maps, lockbox keycard, ammo") is a category error the legacy extractor made: the name
        // absorbed its contents. Split distributes the source's quantity across the parts, each
        // part a new row; the source becomes an empty shell and closes.
        const parts = Array.isArray(op.parts) ? op.parts : [];
        if (!parts.length) return { error: 'split-empty' };
        const made = [];
        for (const part of parts) {
            const name = String(part?.name ?? '').trim();
            const qty = Math.max(1, Math.trunc(Number(part?.qty) || 1));
            if (!name) return { error: 'split-bad-part' };
            const rid = `R${table.nextId++}`;
            const partRow = {
                id: rid, kind: row.kind, name, place: row.place, who: row.who, rank: row.rank,
                qty: Math.min(qty, maxQty(row.place)),
                status: 'open', born: t, seen: t, dqSinceSet: 0, stated: null,
            };
            rows.set(rid, partRow);
            made.push(partRow);
        }
        row.qty = 0;
        row.status = 'closed';
        return { row, diff: null, made };
    }
    if (op.op === 'none') {
        return { row, diff: null };
    }
    return { error: 'unknown-op' };
}

/**
 * Fold a list of ops over the table. The only way rows change.
 * @param {object} table The row table.
 * @param {Array<object>} ops The ops, in model order.
 * @param {number} [t] The current turn/mid.
 * @returns {{diffs: Array<object>, errors: Array<object>}} The conservation diffs and any refusals.
 */
export function applyOps(table, ops, t = 0) {
    const diffs = [];
    const errors = [];
    for (const op of Array.isArray(ops) ? ops : []) {
        const r = applyOp(table, op, t);
        if (r.error) {
            errors.push({ op, error: r.error });
        } else if (r.diff) {
            diffs.push(r.diff);
        }
    }
    return { diffs, errors };
}

/**
 * The by-id coverage gate (census R7). An op that touches a held row passes only when the model's
 * own `mentions` report names that row, the model cannot change a row its report says the window
 * did not touch. A `new` is its own mention (the story named the thing). Exact set membership on
 * fold's own ids: no language, no fuzzy match, any script.
 *
 * @param {Array<object>} ops The ops as the model sent them.
 * @param {Iterable<string>} mentions The rows the model reported the window touched.
 * @returns {Array<object>} The ops that pass the gate.
 */
export function withCoverage(ops, mentions) {
    const said = new Set(mentions);
    const out = [];
    for (const op of Array.isArray(ops) ? ops : []) {
        const o = op?.op;
        if (o === 'new') { out.push(op); continue; }
        if (said.has(op?.id)) out.push(op);
    }
    return out;
}

/**
 * Render the pinned ledger, the rows the model sees every pass, with IDs.
 * Closed rows and empty shells are excluded.
 *
 * Bounded (census finding, live gate): an unbounded ledger exceeds what the model can see, so it
 * stops referencing IDs and starts re-creating rows, 162 rows of sounds and doors in the live
 * Raccoon City replay, 86 refused duplicate attempts. `limit` keeps the carried/money/vital/open
 * rows visible and drops the tail with a line saying how many were not shown. What is NOT shown
 * is still tracked; it is simply not in the model's face.
 *
 * @param {object} table The row table.
 * @param {number} [limit] How many rows to show. 0 or missing = unbounded.
 * @returns {string} The ledger block, one row per line.
 */
export function renderLedger(table, limit = 0) {
    const rows = [...table.rows.values()].filter(row => row.status !== 'closed');
    // Live first: carried items, money, vitals, open threads/marks/people, then the rest.
    rows.sort((a, b) => liveRank(a) - liveRank(b) || String(a.id).localeCompare(String(b.id)));
    const shown = limit > 0 ? rows.slice(0, limit) : rows;
    const lines = shown.map(row => `  ${row.id} [${row.kind}] ${face(row)}`);
    if (rows.length > shown.length) {
        lines.push(`  (${rows.length - shown.length} more rows not shown, refer to them only if the story names them)`);
    }
    return lines.join('\n');
}

/** Live first: carried / money / vitals / open rows rank before the rest. */
function liveRank(row) {
    if (row.kind === 'vital') return 0;
    if (row.place === 'carried' || row.place === 'money') return 1;
    if (row.status === 'open' && (row.kind === 'thread' || row.kind === 'mark' || row.kind === 'person')) return 2;
    return 3;
}

/** One row as it reads on its line. Fold's own fields, never prose fold must understand. */
function face(row) {
    const qty = row.qty > 0 ? (row.kind === 'vital' ? `${row.qty}${row.stated?.set ? `/${row.stated.set}` : ''}` : `x${row.qty}`) : '';
    const place = row.place ? `, ${row.place}` : '';
    const who = row.who ? ` (${row.who})` : '';
    const rank = row.rank ? ` [${row.rank}]` : '';
    const name = qty ? `${row.name} ${qty}` : `${row.name}${row.kind === 'mark' || row.kind === 'thread' || row.kind === 'person' || row.kind === 'scene' ? '' : ''}`;
    return `${name}${rank}${who}${place}`;
}

/**
 * The instruction that tells the model how to use the pinned ledger.
 * @returns {string} The instruction block.
 */
export function ledgerInstruction() {
    return [
        'The "State:" block lists every row fold currently holds, each with an id like R1 or R7.',
        'A row is a thing the player can carry, own, hold, or that is at stake: an item, money, a vital, a person, an open thread, a clock, a condition. A sound, a door, a crowd, a smell, an ambient detail, or a building is NOT a row, describe it in the narrative, not the state.',
        'Kinds: an "item" is only something you can physically hold or stow, a flash drive, a jacket, 20 rounds. A "thread" is an ongoing exchange or a standing situation, a correspondence, a negotiation, a chase, an open access or account, and it has no place and no count. A "person" is a living someone, located but never carried. A "mark" is a condition with no place, a "clock" a dial. An access right, a relationship, a rumour, or knowledge is a thread or a condition, never an item, and nothing that is not an item is ever "carried".',
        'Refer to a row you mean by its EXACT id. Never restate a held row\'s name, if you mean R2, write R2. If the story names something already in the block under a different name, use "same_as" with the held row\'s id, never a new row.',
        'Use these ops: "new" for a thing the story introduced that is NOT in the block (give it a name and kind; a place only for an item). "gain"/"spend" for a change in quantity (dq). "set" when the story STATES A CURRENT TOTAL outright, "the treasury holds 12,400 marks", "your HP is 38", "there are 40 rounds left", send the exact stated number. A stated total is the one thing that catches a missed event, so report it every time the story names one; when the number disagrees with the record, that is a question to resolve, not a silent edit. "move" for a change of place. "close" for a thread or condition that resolved. "change" for a new rank or name on an existing row. "none" for a row you checked and kept.',
        'Never merge several distinct things into one name: "9mm magazines", "buckshot shells" and "birdshot" are three rows, not one "ammunition".',
        'Every op except "none" needs "evidence": what in the text shows it. If you cannot say what shows it, the op is "none".',
        'An entry that changes nothing says nothing, omit it. Naming a row the record already holds is not a change.',
        'Rows not shown in the block exist but were not listed. Create a row for them ONLY if the story names them and they are things a player could hold or things at stake.',
    ].join(' ');
}

/**
 * Project applied ops into the old-shape delta (`{inv, vit, st}`) so the legacy readers, the
 * panel, the reconcile pass, `entities.render`: keep folding the same truth off `deriveState`
 * while the rows table is the authoritative fold. The projection is the same arithmetic in the old
 * shape.
 *
 * Only an ITEM projects into `inv`. A vital is `vit`, a mark is `st`, and a thread, person, scene
 * or clock projects nowhere, they have their own surfaces (the threads and cast tables), and a
 * projection into the inventory is how "A.W.'s email correspondence" and "server access" were
 * filed under Carrying.
 *
 * `before` is a snapshot of the affected rows (`{kind, name, place, qty, who, rank}`) keyed by id,
 * taken BEFORE the fold, a `move` needs the old place.
 *
 * @param {Map<string, object>} before id -> row snapshot.
 * @param {Array<object>} ops The covered, cleaned ops that were applied.
 * @returns {{inv: Array<object>, vit: Array<object>, st: Array<object>}} The old-shape delta.
 */
export function projectDelta(before, ops) {
    const inv = [];
    const vit = [];
    const st = [];
    for (const op of ops) {
        const b = before.get(op.id);
        const base = { item: op.name || b?.name || '', who: op.who ?? b?.who ?? '', rank: op.rank ?? b?.rank ?? '' };
        if (op.op === 'new') {
            if (op.kind === 'vital') vit.push({ name: op.name, dcur: op.qty || 0 });
            else if (op.kind === 'mark') st.push({ flag: op.name, on: true, who: op.who ?? '' });
            // Only an item is inventory. A thread, a person, a scene or a clock has its own
            // surface, the threads and cast tables, and projecting it into the legacy inventory is
            // how "A.W.'s email correspondence" and "server access" appeared under Carrying.
            else if (op.kind === 'item') inv.push({ ...base, dq: op.qty || 1, at: op.at || 'carried' });
            continue;
        }
        if (!b) continue;
        if (b.kind === 'vital') {
            if (op.op === 'gain') vit.push({ name: b.name, dcur: op.dq });
            if (op.op === 'spend') vit.push({ name: b.name, dcur: -op.dq });
            if (op.op === 'set') vit.push({ name: b.name, dcur: op.set });
            continue;
        }
        if (b.kind === 'mark') {
            if (op.op === 'close') st.push({ flag: b.name, on: false, who: b.who });
            continue;
        }
        if (b.kind !== 'item') {
            // Threads, people, clocks and scene fields have no quantity and no legacy inventory
            // face; a gain or move on one must not print an item row.
            continue;
        }
        if (op.op === 'gain') inv.push({ ...base, dq: op.dq, at: b.place });
        if (op.op === 'spend') inv.push({ ...base, dq: -op.dq, at: b.place });
        if (op.op === 'set') inv.push({ ...base, set: op.set, at: b.place });
        if (op.op === 'move') {
            inv.push({ ...base, dq: -b.qty, at: b.place });
            inv.push({ ...base, dq: b.qty, at: op.at });
        }
        if (op.op === 'change') {
            const entry = { ...base, dq: 0, at: b.place };
            if (op.rank !== undefined && op.rank !== b.rank) entry.rank = op.rank;
            if (op.name && op.name !== b.name) entry.item = op.name;
            inv.push(entry);
        }
        if (op.op === 'split') {
            // Debit the source's whole quantity; credit each part. The old fold's own split rule
            // (`edit-table.js` `splitDelta`): every part is credited in full, the debit clamped to
            // what the row can pay.
            inv.push({ ...base, dq: -b.qty, at: b.place });
            for (const part of Array.isArray(op.parts) ? op.parts : []) {
                if (!String(part?.name ?? '').trim()) continue;
                inv.push({
                    item: String(part.name).trim(),
                    who: b.who ?? '', rank: b.rank ?? '',
                    dq: Math.max(1, Math.trunc(Number(part.qty) || 1)),
                    at: b.place,
                });
            }
        }
    }
    return { inv, vit, st };
}

/** Run the self-test. */
export function selfTest() {
    const eq = (a, b, name) => {
        const sa = JSON.stringify(a); const sb = JSON.stringify(b);
        if (sa !== sb) throw new Error(`rows-table.js: ${name}: ${sa} != ${sb}`);
    };

    // new + gain: 200 + 10000 = 10200 at the money ceiling
    let t = makeTable();
    let { diffs, errors } = applyOps(t, [
        { op: 'new', kind: 'item', name: 'won', place: 'money', qty: 200 },
        { op: 'gain', id: 'R1', dq: 10000 },
    ], 1);
    eq(errors.length, 0, 'no errors');
    eq(t.rows.get('R1').qty, 10200, '200+10000=10200');
    eq(diffs.length, 0, 'no diff on gain');

    // identity: same_as merges a second spelling into the held row
    applyOps(t, [
        { op: 'new', kind: 'item', name: 'knife', place: 'carried', qty: 1 },
        { op: 'same_as', id: 'R2', target: 'R1' },
    ], 2);
    eq(t.rows.has('R1'), true, 'target survives');
    eq(t.rows.has('R2'), false, 'spelling merged away');

    // the duplicate-row close: a `new` matching a held row is refused (census row 1)
    t = makeTable();
    applyOps(t, [{ op: 'new', kind: 'item', name: 'ka-bar knife', place: 'carried', qty: 1 }], 1);
    const dup = applyOp(t, { op: 'new', kind: 'item', name: 'knife', place: 'carried', qty: 1 }, 2);
    eq(dup.error, 'new-matches-held', 'bare knife refused against held ka-bar knife');
    eq(dup.held, 'R1', 'refusal names the held row');
    eq(t.rows.size, 1, 'no second row created');

    // conservation: a stated set that disagrees produces a diff
    t = makeTable();
    applyOps(t, [{ op: 'new', kind: 'item', name: 'won', place: 'money', qty: 9999 }], 1);
    const { diffs: d2 } = applyOps(t, [{ op: 'set', id: 'R1', set: 10200 }], 2);
    eq(d2.length, 1, 'set mismatch yields one diff');
    eq(d2[0].diff, -201, 'diff is fold minus stated');

    // spend floors at 0, move caps at the new place ceiling, close leaves the ledger
    t = makeTable();
    applyOps(t, [
        { op: 'new', kind: 'item', name: 'arrow', place: 'carried', qty: 1 },
        { op: 'spend', id: 'R1', dq: 5 },
        { op: 'new', kind: 'thread', name: 'the missing shipment' },
        { op: 'close', id: 'R2' },
    ], 1);
    eq(t.rows.get('R1').qty, 0, 'spend floors at 0');
    eq(t.rows.get('R2').status, 'closed', 'close works');
    const ledger = renderLedger(t);
    eq(ledger.includes('R1'), true, 'open row shown');
    eq(ledger.includes('R2'), false, 'closed row hidden');

    return 'rows-table.js: all checks hold';
}
