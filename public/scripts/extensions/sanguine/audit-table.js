/**
 * fold/audit-table.js: the deep-audit detectors, as data (pure half).
 *
 * The app half is `audit.js`. Nothing here touches storage, the chronicle or the DOM.
 *
 * What these are, and are not.
 *
 * The detectors are EXACT. They compute a violation by arithmetic, staleness from the `seen`
 * clock, capacity from a count, identity from `nearIdentity` token containment, a conservation
 * diff from a stated `set` against the fold, a duplicate from a refused `new`. None of them asks a
 * model "is anything wrong?", that measured 0.14% closure (`reconcile-table.js:13`). They produce
 * a SHORTLIST of real anomalies, each with the chronicle evidence attached, and ONE bounded
 * adjudication call resolves it.
 *
 * The ask, never the hide.
 *
 * The one detector with a body count in its past is staleness: `cap:stale-hidden` fired 540 times
 * hiding items that were in the character's pockets (`reconcile-table.js:46`). The sin was HIDING.
 * Here a stale carried row is a QUESTION, "still carrying it?", answered keep/gone/moved. The
 * player's silence keeps it.
 *
 * The question block.
 *
 * Numbered lines with ids, the measured-working mechanism (`reconcile-table.js:21-24`: 3,319
 * answers against numbered lines vs 0 for the open invitation). Every suspect gets an id; the
 * model answers by id; the router applies through the same fold the per-turn ops use.
 */

/** A carried row not touched in this many turns is a staleness question. */
export const STALE_AFTER = 12;

/**
 * How many carried distinct things before the capacity warning fires.
 *
 * One warning, not per-row questions: a survivor's loadout legitimately carries dozens of things,
 * and "is THIS one you're not carrying?" asked thirty times reads as noise, not a tool. The
 * warning is the flag that the carried list has grown past a person's practical load; the
 * staleness questions (over time) are what trim it.
 */
export const CARRIED_LIMIT = 50;

/** The question ids this pass poses. Prefixes name the detector. */
export const PREFIX = Object.freeze({ stale: 'S', capacity: 'C', identity: 'I', conservation: 'V', duplicate: 'D' });

/** The ops an answer may carry. `rename` and `split` fix a polluted row NAME, the audit's reason
 * for existing is rows like "tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo" where
 * the legacy extractor folded several things into one name. */
export const VERDICTS = Object.freeze(['keep', 'gone', 'move', 'same', 'different', 'set', 'rename', 'split']);

/**
 * Staleness: a carried (or open) row whose `seen` is older than the threshold. The "dumped at the
 * house five turns ago" detector, it asks, it never hides.
 *
 * @param {Map<string, object>} rows The rows table.
 * @param {number} now The current turn/mid.
 * @param {number} [threshold] Turns of silence before a carried row is questioned.
 * @returns {Array<object>} Suspects `{kind, id, name, place, seen, ago}`.
 */
export function stalenessSuspects(rows, now, threshold = STALE_AFTER) {
    const out = [];
    for (const row of rows.values()) {
        if (row.status === 'closed') continue;
        // Carried items and open threads/marks/people go stale; a money balance does not, a
        // balance is a persistent total, not a thing that can be silently dumped.
        const carried = row.place === 'carried';
        const openThread = row.status === 'open' && (row.kind === 'thread' || row.kind === 'mark' || row.kind === 'person');
        if (!carried && !openThread) continue;
        const ago = Math.max(0, now - row.seen);
        if (ago >= threshold) {
            out.push({ kind: 'stale', resolver: 'model', id: row.id, name: row.name, place: row.place, seen: row.seen, ago });
        }
    }
    return out.sort((a, b) => b.ago - a.ago);
}

/**
 * Capacity: more carried distinct things than a person can hold. The anti-1000kg, a carried
 * inventory that never shrinks is the measured "carrying 1000kg worth of shit" failure.
 *
 * ONE warning, never per-row questions: asking the player "is this one you're not carrying?" for
 * every row past the bound is the same 34-card noise the review's blind-judgement modal was. The
 * warning names the count and the bound; the staleness questions are what actually trim the list.
 *
 * @param {Map<string, object>} rows The rows table.
 * @param {number} [limit] The carried distinct-item bound.
 * @returns {Array<object>} At most one warning `{kind, resolver, count, limit}`: empty when under.
 */
export function capacitySuspects(rows, limit = CARRIED_LIMIT) {
    const carried = [...rows.values()]
        .filter(r => r.status !== 'closed' && r.place === 'carried' && r.qty > 0);
    if (carried.length <= limit) return [];
    return [{
        kind: 'capacity', resolver: 'player', count: carried.length, limit,
    }];
}

/**
 * Identity: nearIdentity pairs among open rows of the same kind. The "key"/"bronze key",
 * "knife"/"ka-bar knife" class, fold raises the question, never decides.
 *
 * A row whose NAME is three or more comma-joined things is excluded from identity pairing: it is
 * content pollution ("tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo"), and asking
 * whether one of its contents is "the same as" the whole is nonsense. The split detector handles
 * that row.
 *
 * @param {Map<string, object>} rows The rows table.
 * @param {Function} [near] The containment test (injected for testing).
 * @returns {Array<object>} Suspects `{kind, id, name, other, otherName}`.
 */
export function identitySuspects(rows, near) {
    const open = [...rows.values()].filter(r => r.status !== 'closed' && !isPollutedName(r.name));
    const out = [];
    for (let i = 0; i < open.length; i++) {
        for (let j = i + 1; j < open.length; j++) {
            const a = open[i]; const b = open[j];
            if (a.kind !== b.kind) continue;
            if (a.place !== b.place) continue;
            if (near(a.name, b.name)) {
                out.push({ kind: 'identity', resolver: 'model', id: a.id, name: a.name, other: b.id, otherName: b.name });
            }
        }
    }
    return out;
}

/** A name with three or more comma-separated segments is content pollution, not a compound. */
export function isPollutedName(name) {
    return String(name ?? '').split(/[,，;；]+/).map(s => s.trim()).filter(Boolean).length >= 3;
}

/**
 * Content pollution: a row whose NAME is several things comma-joined, the legacy extractor's
 * category error ("tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo"). One name
 * holding several things is a split question, answered by the model from the history.
 *
 * @param {Map<string, object>} rows The rows table.
 * @returns {Array<object>} Suspects `{kind, resolver, id, name, segments}`.
 */
export function namePollutionSuspects(rows) {
    const out = [];
    for (const row of rows.values()) {
        if (row.status === 'closed') continue;
        if (isPollutedName(row.name)) {
            out.push({ kind: 'split', resolver: 'model', id: row.id, name: row.name });
        }
    }
    return out;
}

/**
 * Conservation: the pending `set` diffs a pass produced (Phase 2 handoff). A stated total that
 * disagrees with the fold is a question the deep audit adjudicates.
 *
 * @param {Array<object>} diffs The `{id, name, qty, set, diff}` records from the fold.
 * @returns {Array<object>} Suspects `{kind, id, name, qty, set, diff}`.
 */
export function conservationSuspects(diffs) {
    return (Array.isArray(diffs) ? diffs : []).map(d => ({
        kind: 'conservation', resolver: 'model', id: d.id, name: d.name, qty: d.qty, set: d.set, diff: d.diff,
    }));
}

/**
 * Duplicates: the refused `new-matches-held` ops, collected across passes. Each is the model trying
 * to create a row the fold already holds under a near name, the census's knife/ka-bar class.
 *
 * @param {Array<object>} errors The `{error, op}` records from the fold.
 * @returns {Array<object>} Suspects `{kind, id, name, held, heldName}`.
 */
export function duplicateSuspects(errors, rows) {
    const out = [];
    for (const e of Array.isArray(errors) ? errors : []) {
        if (e.error !== 'new-matches-held' || !e.op) continue;
        const held = e.held || e.op.held;
        const heldRow = rows.get(held);
        out.push({
            kind: 'duplicate', resolver: 'model', id: e.op.id || '', name: String(e.op.name ?? '').trim(),
            held, heldName: heldRow?.name ?? held,
        });
    }
    return out;
}

/**
 * The pending findings a run should retain after posing a truncated shortlist.
 *
 * The question cap means a run poses at most `MAX_AUDIT_QUESTIONS` of the detected suspects. The
 * conservation diffs and duplicate refusals whose rows were NOT posed must survive for the next run
 *, staleness re-derives from the `seen` clock, but a `set` diff exists only in the pending store.
 *
 * @param {{diffs?: Array<object>, errors?: Array<object>}} pending The stored findings.
 * @param {Iterable<string>} posedIds The row ids this run actually posed.
 * @returns {{diffs: Array<object>, errors: Array<object>}} What to retain.
 */
export function unposedFindings(pending, posedIds) {
    const posed = new Set(posedIds);
    const keep = (list) => (Array.isArray(list) ? list : []).filter(item => !posed.has(item?.id));
    return { diffs: keep(pending?.diffs), errors: keep(pending?.errors) };
}

/** The id of one suspect, prefixed by its detector. */
function suspectId(suspect, at) {
    return `${PREFIX[suspect.kind]}${at}`;
}

/**
 * A stable key for one suspect, so a persisted question survives re-renders and re-detects.
 * The row ids are the stable part; the detector names the question kind.
 * @param {object} s A suspect.
 * @returns {string} The key.
 */
export function questionKey(s) {
    return `${String(s?.kind ?? '')}:${String(s?.id ?? '')}:${String(s?.other ?? '')}`;
}

/**
 * The fold op one verdict resolves to. Shared by the model-call router (`planAudit`) and the
 * player-click surface (`audit.resolveQuestion`), so a click and a call are the same write.
 *
 * @param {object} suspect The suspect being answered.
 * @param {string} verdict One of `VERDICTS`.
 * @param {{at?: string, target?: string, evidence?: string}} [fields] The answer's fields.
 * @returns {{op?: object, error?: string}} The op, or a refusal reason.
 */
export function opForVerdict(suspect, verdict, fields = {}) {
    const rowId = suspect?.id;
    const evidence = String(fields?.evidence ?? '').trim();
    if (verdict === 'keep' || verdict === 'different') {
        return { op: { op: 'none', id: rowId } };
    }
    if (!evidence) return { error: 'no-evidence' };
    if (verdict === 'gone') return { op: { op: 'close', id: rowId, evidence } };
    if (verdict === 'move') {
        const at = String(fields?.at ?? '').trim();
        if (!at) return { error: 'no-place' };
        return { op: { op: 'move', id: rowId, at, evidence } };
    }
    if (verdict === 'same') {
        const other = suspect?.other;
        if (!other || other === rowId) return { error: 'no-change' };
        return { op: { op: 'same_as', id: rowId, target: other, evidence } };
    }
    if (verdict === 'set') {
        return { op: { op: 'set', id: rowId, set: Number(suspect?.set), force: true, evidence } };
    }
    if (verdict === 'rename') {
        const to = String(fields?.at ?? '').trim();
        if (!to) return { error: 'no-name' };
        return { op: { op: 'change', id: rowId, name: to, evidence } };
    }
    if (verdict === 'split') {
        const parts = Array.isArray(fields?.parts) ? fields.parts
            : String(fields?.at ?? '').split(/[,，;；]+/).map(p => ({ name: String(p).trim() })).filter(p => p.name);
        if (!parts.length) return { error: 'split-empty' };
        return { op: { op: 'split', id: rowId, parts, evidence } };
    }
    return { error: 'unknown-verdict' };
}

/**
 * Build the numbered question block from a shortlist.
 *
 * @param {Array<object>} suspects The detector output, concatenated in detector order.
 * @returns {{text: string, index: Map<string, object>}} The block and the id index.
 */
/**
 * Build the numbered question block from a shortlist.
 *
 * `evidence` is a Map<qid, string[]> of chronicle-event lines retrieved for each suspect, so the
 * model answers from the actual history rather than from the bare question. A question without
 * evidence still asks, the instruction tells the model what a silence means.
 *
 * @param {Array<object>} suspects The detector output, concatenated in detector order.
 * @param {Map<string, string[]>} [evidence] qid -> evidence lines.
 * @returns {{text: string, index: Map<string, object>}} The block and the id index.
 */
export function auditBlock(suspects, evidence = null) {
    const index = new Map();
    const counters = {};
    const lines = [];
    for (const s of Array.isArray(suspects) ? suspects : []) {
        counters[s.kind] = (counters[s.kind] ?? 0) + 1;
        // The suspect's `id` IS the row id; the question id is separate (`qid`), so routing an
        // answer never has to guess whether S1 means a question or a row.
        const qid = suspectId(s, counters[s.kind]);
        index.set(qid, { ...s, qid });
        lines.push(`  ${qid} ${face(s)}`);
        const ev = evidence?.get(qid) ?? [];
        for (const e of ev.slice(0, 4)) {
            lines.push(`     · ${e}`);
        }
    }
    return { text: `AUDIT?\n${lines.join('\n')}`, index };
}

/** One suspect as it reads on its line. */
function face(s) {
    if (s.kind === 'stale') return `[stale] ${s.name} (${s.place}), last touched ${s.ago} turns ago. Still there?`;
    if (s.kind === 'capacity') return `[capacity] the record says you are carrying ${s.count} distinct things; a person carries ~${s.limit}. That is over the practical load, check the carried list.`;
    if (s.kind === 'identity') return `[identity] ${s.id} "${s.name}" and ${s.other} "${s.otherName}", the same thing?`;
    if (s.kind === 'conservation') return `[conservation] ${s.name}: the story says ${s.set}, the record says ${s.qty}. Which is right?`;
    if (s.kind === 'duplicate') return `[duplicate] "${s.name}" looks like the row you already hold as ${s.held} "${s.heldName}". Same thing?`;
    if (s.kind === 'split') return `[split] "${s.name}" looks like several separate things in one name. Split them?`;
    return JSON.stringify(s);
}

/** The instruction that answers the block. */
export function auditInstruction() {
    return [
        'The "History fold recorded" block is the story\'s recorded events, oldest first. The "Recent conversation (raw)" block is the actual narrative, the placements, drops and hand-offs live there. Read BOTH. The "AUDIT?" block lists things the record is unsure about. Answer every id once, from your reading of that history.',
        '"keep" when the record is right. "gone" when the history shows the thing ended, spent, dropped, traded, healed, resolved, killed, departed. "move" when it is somewhere else, give the place in "at". If the raw conversation shows the character setting something down, leaving it in a vehicle, stowing it, or handing it over, that is the thing no longer being carried, answer "move" or "gone".',
        'For "identity"/"duplicate", answer "same" when the history shows the two names are one thing (fold merges them), "different" when they are two things. Match by meaning, not spelling, "the knife" and "the ka-bar knife" can be one thing; two names that mean the same are not two rows.',
        'For "rename", give the row the name the story actually uses, in "at". For "split", when one name is really several things comma-joined ("tactical bag thinkpad, audit usbs, maps, lockbox keycard, ammo"), list the separate things in "parts".',
        'For "capacity", you are not asked, that is a warning card for the player.',
        'For "conservation", "keep" means the record is right; "set" the stated total if the story\'s number is the truth.',
        'Silence about a thing is not evidence it is gone. If the history shows it was last seen carried and nothing since ended it, "keep".',
        'Every answer except "keep"/"different" needs "evidence": which recorded event shows it.',
    ].join(' ');
}

/** The schema for the answers. */
export function schema() {
    return {
        type: 'object',
        properties: {
            answers: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The id exactly as listed, e.g. "S1", "C1", "I1", "V1", "D1".' },
                        verdict: { type: 'string', enum: [...VERDICTS], description: '"keep"/"different" when right; "gone" when it ended; "move" when elsewhere; "same" when two rows are one thing; "set" when the stated total is the truth; "rename" when the row\'s NAME is wrong (put the right name in "at"); "split" when one row is really several things comma-joined into one name (list them in "parts").' },
                        at: { type: 'string', description: 'For "move", the place it is actually in. For "rename", the correct name. Empty otherwise.' },
                        target: { type: 'string', description: 'For "same", the OTHER row\'s id. Empty otherwise.' },
                        parts: { type: 'array', description: 'For "split", the separate things one name is actually holding, comma-separated, "tactical bag, thinkpad, audit usbs". Empty otherwise.', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name', 'qty'], additionalProperties: false } },
                        evidence: { type: 'string', description: 'Required for everything except "keep"/"different": what in the text shows it.' },
                    },
                    required: ['id', 'verdict', 'at', 'target', 'parts', 'evidence'],
                    additionalProperties: false,
                },
            },
        },
        required: ['answers'],
        additionalProperties: false,
    };
}

/**
 * Route the answers back through the index into fold ops. The verdicts map onto the rows ops so
 * the resolutions are the same writes the per-turn fold makes.
 *
 * @param {object} fragment The model's answer.
 * @param {Map<string, object>} index The index `auditBlock` returned.
 * @returns {{ops: Array<object>, rejected: Array<object>}} Fold ops and refusals.
 */
export function planAudit(fragment, index) {
    const ops = [];
    const rejected = [];
    const answered = new Set();
    const refuse = (suspect, reason, raw) => {
        rejected.push({ item: String(suspect?.name ?? suspect?.id ?? ''), reason, raw });
    };
    for (const raw of Array.isArray(fragment?.answers) ? fragment.answers : []) {
        const id = String(raw?.id ?? '').trim().toUpperCase();
        const suspect = index.get(id);
        if (!suspect) { refuse({ id }, 'unknown-id', raw); continue; }
        if (answered.has(id)) { refuse(suspect, 'duplicate-id', raw); continue; }
        answered.add(id);
        const verdict = String(raw?.verdict ?? '').trim().toLowerCase();
        const r = opForVerdict(suspect, verdict, {
            at: raw?.at, target: raw?.target, parts: raw?.parts, evidence: raw?.evidence,
        });
        if (r.error) { refuse(suspect, r.error, raw); continue; }
        ops.push(r.op);
    }
    return { ops, rejected };
}
