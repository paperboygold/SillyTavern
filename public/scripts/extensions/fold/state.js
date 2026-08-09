/**
 * fold/state.js — inventory, vitals and status, derived from the chronicle.
 *
 * There is no state table. A chronicle event may carry a `d` (delta) describing what it did to the
 * world, and the current state is a fold over the events that are live on this branch. See
 * state-table.js for why, and for the three merges that do the folding.
 *
 * The only thing persisted here is the rejection tally, which is not derivable from the ledger —
 * a rejected delta is by definition one that never became an event.
 */

import { insert_with, lookup, merge_b, merge_bu, table_entries } from './lib/hash.js';
import { advanceClock, clockAge, clockScalar, isClockStale, parseElapsed, parseSceneElapsed, skipClock } from './clock.js';
import { MIN_INTERVAL } from './trigger-table.js';
import * as chronicle from './chronicle.js';
import * as entities from './entities.js';
import * as clocks from './clocks.js';
import * as observe from './observe.js';
import { ENTITY_STALE, LEAD_LABELS, PERSON, PERSON_LABELS, resolveEntity } from './entity-table.js';
import {
    BLOCK,
    CONTEXT_OVERRIDE_AFTER,
    NARRATIVE,
    contestsOf,
    contextBand,
    creditsWithoutDebit,
    deriveState,
    foldContest,
    isMentioned,
    ownerKey,
    povMarks,
    splitMarkKey,
    SEVERITIES,
    merge_context,
    MAX_CHANGES_PER_TURN,
    CARRIED,
    MONEY,
    normalizeItemName,
    normalizePlace,
    renderLedger,
    renderState,
    splitItemKey,
    STALE_THRESHOLD,
    validateInventory,
    validateStatus,
    validateVitals,
} from './state-table.js';
import { reviewBlock } from './review-table.js';
import * as review from './review.js';
import { commit, loadTable } from './store.js';
import * as log from './log.js';
import { renderWorldEvents, revealContract } from './world-table.js';

const REJECTS_PATH = 'state.rejects';
const CONTEXT_PATH = 'state.context';
const CLOCK_PATH = 'state.clock';
const LOCKS_PATH = 'state.locks';
const CONTESTS_PATH = 'state.contests';
const SYNC_PATH = 'state.sync';

/**
 * The extraction lifecycle, as the player should see it.
 *
 * FOLD-SLA.md §2: freshness and failure must be VISIBLE. This is the record the strip and the
 * panel render, so a stale panel is never presented as current and a failed pass is never silent.
 *
 *   up-to-date    the ledger reflects the newest processed message. Green.
 *   acknowledged  a message just rendered; extraction is pending. Amber — your input is seen.
 *   syncing       an extraction pass is in flight. Blue pulse.
 *   behind        extraction succeeded but a newer message arrived before it finished; the next
 *                 pass covers the gap. Amber.
 *   failed        the pass returned empty/truncated/unparseable; red, with the reason and fix,
 *                 until the next success clears it.
 *
 * @param {'up-to-date'|'acknowledged'|'syncing'|'behind'|'failed'} state The state.
 * @param {object} [opts] Extra record.
 * @param {number} [opts.mid] The newest message the ledger reflects.
 * @param {string} [opts.reason] For `failed`: the pass reason.
 * @param {string} [opts.detail] For `failed`: the fix hint.
 */
export function setSync(state, { mid = null, reason = '', detail = '' } = {}) {
    const table = loadTable(SYNC_PATH);
    insert_with(table, merge_b, 'sync', {
        state: String(state ?? ''),
        mid: Number.isFinite(mid) ? mid : null,
        reason: String(reason ?? '').slice(0, 80),
        detail: String(detail ?? '').slice(0, 200),
        since: Date.now(),
    });
    commit(SYNC_PATH, table);
}

/** @returns {{state: string, mid: number|null, reason: string, detail: string, since: number}} The sync record, defaulting to up-to-date. */
export function getSync() {
    const row = lookup(loadTable(SYNC_PATH), 'sync', null);
    return {
        state: row?.state ?? 'up-to-date',
        mid: Number.isFinite(row?.mid) ? row.mid : null,
        reason: row?.reason ?? '',
        detail: row?.detail ?? '',
        since: row?.since ?? 0,
    };
}

/**
 * Scene context lifted from a card's own state block — time, location, leads and whatever else it
 * chose to report. Stored rather than derived because it is the narrator's assertion about the
 * present, not something a fold over past events can reconstruct: nothing in the ledger says what
 * time it is now.
 * @returns {Map<string, string>} label -> value.
 */
export function loadContext() {
    const stored = loadTable(CONTEXT_PATH);
    const out = new Map();
    for (const [label, value] of table_entries(stored)) {
        // Chats written before fields carried a turn hold a bare string; they read as turn 0.
        out.set(label, (value && typeof value === 'object' && 'v' in value)
            ? { v: String(value.v ?? ''), t: Number(value.t ?? 0), src: String(value.src ?? BLOCK) }
            : { v: String(value ?? ''), t: 0, src: BLOCK });
    }
    return out;
}

// The trust order and its merge live in state-table.js, with the rest of the pure layer.
export { BLOCK, CONTEXT_OVERRIDE_AFTER, NARRATIVE, merge_context };

/**
 * Replace scene context, keeping fields the new block did not mention.
 *
 * A narrator that omits Location this turn has not moved the character to nowhere — same asymmetry
 * as inventory: a block is evidence of what it states, not of what it leaves out.
 *
 * @param {Map<string, string>} context Fields from the latest block.
 */
/**
 * Record that an assistant turn happened, block or no block.
 *
 * Called on every reply. Separating this from `setContext` is the whole fix: a narrator that stops
 * restating its status block does not stop time, and fold must not report a frozen clock as a
 * current one just because nothing arrived to contradict it.
 */
export function noteTurn() {
    const clock = loadClock();
    saveClock({ ...clock, seen: (clock.seen ?? 0) + 1 });
}

/**
 * Advance the clock by however much time the player's own message says has passed.
 *
 * The player is the authority on their own elision. "I continue working for the next several hours"
 * is a statement of fact about the fiction, and until now nothing in fold acted on it — the clock
 * sat where the last status block left it while the narrative moved through an afternoon.
 *
 * @param {string} text The player's message.
 * @returns {{skipped: boolean, minutes?: number}} What happened.
 */
export function noteElapsed(text) {
    const minutes = parseElapsed(text);
    if (minutes === null) {
        return { skipped: false };
    }
    return advanceClockBy(minutes, 'player');
}

/**
 * Advance the clock on the scene probe's report of elapsed time.
 *
 * The scene probe reads the narrative with comprehension and reports `elapsed` as the phrase the
 * story used — "a week", "overnight", "come morning". Unlike the player's own message (which has
 * to pass the assertion gate in `parseElapsed` to prove it is not a memory), the model has already
 * asserted that time moved: it is answering the question "how much time passed?". So the phrase is
 * read as a bare duration and, when it is a scene-transition marker rather than a unit ("overnight",
 * "come morning", "first light"), as the day its marker implies — `parseSceneElapsed` handles both,
 * without the player's assertion gate, because the model is the authority here, in any language.
 *
 * @param {string} text The scene probe's `elapsed` answer.
 * @returns {{skipped: boolean, minutes?: number}} Whether the clock moved.
 */
export function noteSceneElapsed(text) {
    const minutes = parseSceneElapsed(text);
    if (minutes === null) {
        return { skipped: false };
    }
    return advanceClockBy(minutes, 'scene');
}

/**
 * Advance the persisted clock by a number of minutes and keep its consumers in step.
 *
 * The shared half of `noteElapsed` and `noteSceneElapsed`: skip the clock, persist it, tick any
 * calendar fronts that the elapse runs past, and push the new time into the scene's display field.
 * @param {number} minutes Minutes to advance.
 * @param {'player'|'scene'} source Who asserted the passage, for the audit trail.
 * @returns {{skipped: boolean, minutes: number}} The outcome.
 */
function advanceClockBy(minutes, source) {
    const clock = skipClock(loadClock(), minutes);
    if (!clock.accepted) {
        return { skipped: false };
    }
    saveClock(clock);

    // A declared elapse is the one high-precision signal a `per`-front can tick against. The
    // residency window's "twelve months pass" is a pure calendar condition; before Phase W it could
    // not fire, because ticks arrived only from on-screen extraction (FOLD-REDESIGN.md §7.1, §7.4).
    // This is arithmetic fold can do, traded for no hallucination surface and no model call. The
    // pure function is idempotent by construction, so fire-and-forget on the player's say-so is safe.
    try {
        clocks.tickCalendar({ now: clockScalar(clock.day, clock.minutes), turn: entities.turn() });
    } catch (error) {
        console.error('[fold] failed to tick calendar fronts', error);
    }

    // The scene's own time field is the display surface, so it has to follow or the panel keeps
    // showing the old hour with a fresh clock behind it.
    const context = loadContext();
    if (context.has('time')) {
        insert_with(context, merge_b, 'time', { v: clock.raw, t: clock.seen ?? 0 });
        commit(CONTEXT_PATH, context);
    }
    if (source === 'scene') {
        observe.note('clock:scene-elapsed');
    }
    return { skipped: true, minutes };
}

/**
 * How many turns since a state block was last absorbed.
 *
 * Null when no block has ever been absorbed, which is a different fact from a long gap and has to
 * read as one. A card with no stat block never writes a block at all, so `block` stays at its
 * initial value and the subtraction reports the whole chat length as a gap — an alarm about a
 * feature the chat does not use. `NaN` from the store is the honest initial value; 0 was a lie
 * that happened to be a number.
 *
 * @returns {number|null} The gap, or null if no block has ever arrived.
 */
export function turnsSinceBlock() {
    const clock = loadClock();
    // Zero counts as never, not as turn zero. Chats that ran before `block` defaulted to NaN have
    // a literal 0 persisted, and `seen - 0` reports the whole chat as a gap — which is how a chat
    // whose card has no status block came to say "38 turns unreported". A block absorbed on the
    // first turn writes `seen`, which `noteTurn` has already advanced to 1, so a genuine 0 is not
    // reachable and nothing true is lost by reading it as absence.
    if (!Number.isFinite(clock.block) || clock.block <= 0) {
        return null;
    }
    return Math.max(0, (clock.seen ?? 0) - clock.block);
}

/**
 * How many assistant turns since extraction last ran.
 *
 * ── Why this is derived and not a counter ──
 *
 * It was `let sinceExtract = 0` in index.js, incremented per reply and reset to zero on
 * CHAT_CHANGED. Two failure modes fall out of that, and both are silent. A reload puts it back to
 * zero, so the first four replies after every refresh are dead. Worse, CHAT_CHANGED fires whenever
 * you so much as glance at another chat — so a session spent switching between two chats can reset
 * the counter forever and extraction never fires once, which is exactly what a chat showing seven
 * advanced turns and not one extraction attempt looks like.
 *
 * The turn counter is already persisted per chat and already survives both. Subtracting is free.
 *
 * @returns {number} Turns since the last extraction; the whole chat length if it has never run.
 */
export function turnsSinceExtract() {
    const clock = loadClock();
    const seen = clock.seen ?? 0;
    return Number.isFinite(clock.extract) ? Math.max(0, seen - clock.extract) : seen;
}

/**
 * The adaptive extraction interval, in assistant turns.
 *
 * Stored per chat, because cadence is a property of how fast this story is moving and not of the
 * installation. Defaults to the floor so a fresh chat looks often while it is establishing itself.
 *
 * @returns {number} Turns to wait before looking again.
 */
export function extractInterval() {
    const stored = loadClock().every;
    return Number.isFinite(stored) && stored > 0 ? stored : MIN_INTERVAL;
}

/**
 * Set the adaptive extraction interval.
 * @param {number} turns The new interval.
 */
export function setExtractInterval(turns) {
    const clock = loadClock();
    saveClock({ ...clock, every: Math.max(1, Math.round(Number(turns) || MIN_INTERVAL)) });
}

/** Record that extraction ran on this turn. */
export function noteExtracted() {
    const clock = loadClock();
    saveClock({ ...clock, extract: clock.seen ?? 0 });
}

/**
 * The high-water mark: the last message a successful extraction pass actually read.
 *
 * Separate from `extract` above, and the separation is the point. `extract` is a TURN counter and
 * it is deliberately stamped *before* the call (`index.js` onAssistantMessage, "Stamped before the
 * call, not after") so that replies landing while the pass is in flight do not all pile up against
 * the `busy` guard. The mark is a claim about what has been read, so stamping it before the read
 * would be a lie the next pass acts on — it advances only when a pass has succeeded.
 *
 * @returns {{mid: number, key: string}} The mark; `mid` is NaN when no pass has ever succeeded.
 */
export function extractMark() {
    const clock = loadClock();
    return { mid: clock.extractMid, key: clock.extractKey };
}

/**
 * Advance the high-water mark to the newest message this pass read.
 *
 * The content key rides along so a swipe can be detected; `resolveMark` (`extract-table.js`) owns
 * what to do about it.
 *
 * @param {object} mark The mark.
 * @param {number} mark.mid Message index.
 * @param {string} mark.key Content key of that message.
 */
export function noteExtractedWindow({ mid, key }) {
    if (!Number.isFinite(mid)) {
        return;
    }
    saveClock({ ...loadClock(), extractMid: mid, extractKey: String(key ?? '') });
}

export function setContext(context, { source = BLOCK } = {}) {
    if (!context?.size) {
        return;
    }

    // The clock is folded separately, under `max` rather than last-write. See `advanceClock`.
    // `seen` is already current — `noteTurn` ran for this turn before the block was parsed — so
    // advanceClock must not count it again.
    const before = loadClock();
    const clock = { ...advanceClock({ ...before, seen: before.seen - 1 }, {
        time: context.get('time'),
        date: context.get('date'),
    }), block: source === BLOCK ? before.seen : before.block };
    saveClock(clock);
    if (clock.reason === 'reversed') {
        noteRejections([{ item: String(context.get('time') ?? ''), reason: 'clock-reversed' }]);
    }

    const locks = loadLocks();
    const merged = loadContext();
    const contests = loadContests();
    let contestsMoved = false;
    for (const [label, value] of context) {
        // A refused time must not reach the display or the prompt: re-asserting an earlier time is
        // how the model gets anchored on a clock the story has already passed.
        if (label === 'time' && !clock.accepted) {
            continue;
        }
        // A locked field is one you corrected by hand. Nothing the narrator says overwrites it —
        // that is the entire point, and it is the one thing fold had no answer for.
        if (lookup(locks, label, false)) {
            observe.noteCap('field-locked');
            // ── …but it can no longer lie silently ──
            //
            // The lock did its job seven times on the live chat and the result was a panel showing
            // an empty room in a scene containing the player (`FOLD-REDESIGN.md` §0.1-2). Every
            // blocked write was discarded with nothing left behind but a tally, so nobody could see
            // that the lock and the story had fallen out — and an expiry would be decay, which §11
            // forbids. The record below is the honest alternative: keep the value, keep the
            // argument, and surface it once the disagreement is consistent. `foldContest` owns the
            // consecutive rule and CONTEST_AT.
            const held = lookup(merged, label, null);
            const outcome = foldContest(lookup(contests, label, null), {
                locked: held?.v ?? '', value, turn: clock.seen,
            });
            if (outcome.record) {
                insert_with(contests, merge_b, label, outcome.record);
            } else {
                contests.delete(label);
            }
            contestsMoved = true;
            if (outcome.raised) {
                // Not a `cap:` — nothing was dropped that a bound could have kept. This is the
                // disagreement itself, which is a fact about the world rather than about a bound,
                // so it gets its own namespace beside `cap:field-locked`.
                observe.note('lock:contested');
                console.debug(`[fold] "${label}" is contested: locked to "${held?.v ?? ''}", narration says "${value}"`);
            }
            continue;
        }
        // A write that lands clears any contest the field was carrying: an unlocked field cannot be
        // in an argument with the narrator, because the narrator just won it.
        if (contests.has(label)) {
            contests.delete(label);
            contestsMoved = true;
        }
        // Stamped with the turn it was asserted on. Without this the injected [Scene] composes a
        // moment that never happened — location from one turn, contacts from another, time from a
        // third, each field last-written independently. `{field}_as_of`, in the smallest form that
        // pays for itself.
        insert_with(merged, merge_context, label, { v: value, t: clock.seen, src: source });
    }
    commit(CONTEXT_PATH, merged);
    if (contestsMoved) {
        commit(CONTESTS_PATH, contests);
    }
}

/** @returns {Map<string, object>} label -> `{value, locked, count, turn}`. */
export function loadContests() {
    return loadTable(CONTESTS_PATH);
}

/**
 * The locked fields the narrative keeps disagreeing with.
 *
 * Only the ones that have crossed CONTEST_AT reach a consumer: a single blocked write is the
 * narrator wandering and surfacing it would make the panel noisier than the problem. The record is
 * kept from the first disagreement because that is what makes the third countable.
 *
 * @returns {Array<{field: string, lockedValue: string, narrativeValue: string, count: number}>}
 *   Contested fields, most argued-over first.
 */
export function contests() {
    return contestsOf(loadContests());
}

/**
 * Record what the review says the narrative claims a contested field is.
 *
 * The lock still wins — that is what a lock is, and `FOLD-REDESIGN.md` §5 is explicit that it wins
 * "until the user says otherwise". All this does is replace the last blocked write with the model's
 * reading of the scene, so the one-click accept the panel offers is offering something a reader
 * recognises rather than whichever restatement happened to arrive last.
 *
 * @param {string} field The field label.
 * @param {string} value What the narrative says it is.
 * @returns {boolean} True if a contest was updated.
 */
export function noteContestAnswer(field, value) {
    const label = String(field ?? '').trim().toLowerCase();
    const said = String(value ?? '').trim();
    const table = loadContests();
    const held = lookup(table, label, null);
    if (!held || !said) {
        return false;
    }
    insert_with(table, merge_b, label, { ...held, value: said });
    commit(CONTESTS_PATH, table);
    return true;
}

/**
 * Accept the narrative's value for a contested field, releasing the lock.
 *
 * The user action §5 promises. Recorded as an ordinary context write with the lock cleared first,
 * so the value arrives through the same merge everything else does.
 *
 * @param {string} field The field label.
 * @returns {boolean} True if anything changed.
 */
export function acceptContest(field) {
    const label = String(field ?? '').trim().toLowerCase();
    const held = lookup(loadContests(), label, null);
    if (!held?.value) {
        return false;
    }
    setLock(label, false);
    setContext(new Map([[label, String(held.value)]]), { source: NARRATIVE });
    return true;
}

/** @returns {object} The stored narrative clock. */
export function loadClock() {
    const table = loadTable(CLOCK_PATH);
    return {
        day: Number(lookup(table, 'day', 0)),
        minutes: Number(lookup(table, 'minutes', NaN)),
        raw: String(lookup(table, 'raw', '')),
        date: String(lookup(table, 'date', '')),
        seen: Number(lookup(table, 'seen', 0)),
        moved: Number(lookup(table, 'moved', 0)),
        // The turn a state block was last absorbed, so the gap since is readable. Absent until one
        // actually arrives — `saveClock` drops NaN, so "never" survives the round trip as "never".
        block: Number(lookup(table, 'block', NaN)),
        // The turn extraction last ran. Stored for the same reason `seen` is: a counter held in a
        // module variable is reset by every chat switch and cannot survive a reload.
        extract: Number(lookup(table, 'extract', NaN)),
        // The newest MESSAGE a successful pass read, and that message's content key. A turn counter
        // cannot answer "which messages have been looked at" — turns and message indices drift apart
        // the moment a swipe or an edit happens — and that question is what the window split needs.
        extractMid: Number(lookup(table, 'extractMid', NaN)),
        extractKey: String(lookup(table, 'extractKey', '')),
        every: Number(lookup(table, 'every', NaN)),
    };
}

/**
 * Persist the clock.
 * @param {object} clock The clock to store.
 */
function saveClock(clock) {
    const table = new Map();
    for (const field of ['day', 'minutes', 'raw', 'date', 'seen', 'moved', 'block', 'extract', 'extractMid', 'extractKey', 'every']) {
        if (clock[field] !== undefined && !Number.isNaN(clock[field])) {
            table.set(field, clock[field]);
        }
    }
    commit(CLOCK_PATH, table);
}

/**
 * Scene fields the narrator may not overwrite.
 *
 * ── The Map face, not the Set face ──
 *
 * `merge_nb` is `nu || old` — once locked, always locked — so a Set here would be a lock you could
 * never release. Locks clear, therefore last-write, therefore `merge_b`. Same reasoning as status
 * flags in state-table.js, and the same trap: calling it a Set because it looks like a set of
 * labels would be exactly the decorative labelling this basis exists to avoid.
 *
 * Marinara spends 1036 lines on this because its locks address cells inside arrays that renumber
 * under edits. fold's scene header is five flat labels — time, date, location, conditions, weather —
 * so the whole mechanism is one table and one skip in `setContext`.
 *
 * @returns {Map<string, boolean>} label -> locked.
 */
export function loadLocks() {
    return loadTable(LOCKS_PATH);
}

/**
 * Lock or unlock a scene field.
 * @param {string} label Field label.
 * @param {boolean} [locked] Desired state; omitted toggles.
 * @returns {boolean} The new state.
 */
export function setLock(label, locked) {
    const key = String(label ?? '').trim().toLowerCase();
    if (!key) {
        return false;
    }
    const locks = loadLocks();
    const next = locked === undefined ? !lookup(locks, key, false) : !!locked;
    insert_with(locks, merge_b, key, next);
    commit(LOCKS_PATH, locks);
    return next;
}

/** @returns {string[]} Locked field labels. */
export function lockedFields() {
    return table_entries(loadLocks()).filter(([, on]) => on).map(([label]) => label);
}

/** @returns {Map<string, number>} Rejection reason counts. */
export function loadRejects() {
    return loadTable(REJECTS_PATH);
}

/**
 * What the block-shadow routing could not parse, kept exactly as the card wrote it.
 *
 * ── A refusal that destroys the evidence is not a refusal, it is a loss ──
 *
 * Phase B established the precedent under `state.migrated.dropped`: on Raccoon City extraction never
 * ran, so the `leads` context field was not a duplicate of a structured row — it was the ONLY row,
 * and §9's "never carried into v2 context" must not mean "destroyed" (`migrate.js`, LANDED deviation
 * 5). The live routing in `absorb.js` faces the same case every turn, and answers it the same way:
 * everything the pipelines refuse is preserved verbatim here and surfaced in `snapshot()`, which is
 * what lets `routeBlockFields` delete the context key unconditionally.
 *
 * Bounded, because it is prose in a metadata blob that is rewritten on every save. Newest kept.
 */
const SHADOW_PATH = 'state.shadow';

/** How many refused clauses to keep. Enough for several turns of one card's block, no more. */
export const MAX_SHADOW = 12;

/**
 * How many turns an entity may sit recorded ELSEWHERE before the review asks where it actually is.
 *
 * The cast-starvation fix asked `[where now?]` of people with no place and of people recorded
 * elsewhere whose NAME re-appeared in the window — but a person who left the scene and is never
 * named again sat frozen in their last room, `present`, for up to ENTITY_STALE turns. The court
 * dispersed at message 32 of the Royal Succession chat and Ulrich, Gerhard and Rathold stayed in
 * "the throne room" for the rest of it. This is the dispatch law applied to staleness: a place
 * that has contradicted the scene for this long is evidence the code cannot decide about, so it is
 * asked rather than asserted. A fraction of ENTITY_STALE, so the question fires long before the
 * prune would silently forget the person.
 */
export const PLACE_STALE_AFTER = Math.max(1, Math.floor(ENTITY_STALE / 4));

/** @returns {object[]} Refused block clauses, newest first. */
export function shadow() {
    const stored = loadTable(SHADOW_PATH);
    return table_entries(stored).map(([, entry]) => entry).filter(Boolean);
}

/**
 * Keep refused block clauses verbatim.
 * @param {object[]} entries `{label, reason, text}` records.
 */
export function noteShadow(entries) {
    const list = (Array.isArray(entries) ? entries : []).filter(entry => entry?.text);
    if (!list.length) {
        return;
    }
    const seen = new Map();
    // Keyed by label and text, so a card restating the same unparseable line every turn occupies one
    // slot rather than flushing the table. The turn is refreshed; the text is the identity.
    for (const entry of [...shadow(), ...list]) {
        seen.set(`${entry.label}|${entry.text}`, { ...entry, t: loadClock().seen ?? 0 });
    }
    const kept = [...seen.values()].slice(-MAX_SHADOW);
    commit(SHADOW_PATH, new Map(kept.map((entry, at) => [String(at), entry])));
}

/**
 * Current state, folded from the live events of this branch.
 *
 * The seeds are the marks a v1 → v2 migration parked on cast rows because they predate the ledger
 * (`state-table.js` `seedMarks`, `migrate.js`); everything else comes from events, which is what
 * makes state branch-aware for free.
 *
 * @returns {{inv: Map, vitals: Map, marks: Map, since: Map, contributors: Map}} Derived state.
 */
export function derive() {
    return deriveState(chronicle.liveEvents(), { seeds: entities.markSeeds() });
}

/** @returns {string} The point-of-view character's name, or ''. */
export function pov() {
    return lookup(loadContext(), 'pov', { v: '' }).v;
}

/**
 * The schema fragment describing what a delta may say.
 *
 * Every object carries `additionalProperties: false` and lists every property in `required`,
 * because OpenAI's strict structured output demands it on EVERY object in the schema — a fragment
 * that omits it fails the whole shared call for every probe.
 *
 * @returns {object} A JSON Schema fragment.
 */
export function deltaSchema() {
    return {
        type: 'object',
        description: 'What this event changed. Omit anything it did not change.',
        properties: {
            inv: {
                type: 'array',
                description: 'Things gained or lost: money and objects, plus property owned (a house, a ship, a mount) and capabilities gained (a spell, a skill, a granted power). A capability gained is quantity +1.',
                items: {
                    type: 'object',
                    properties: {
                        item: { type: 'string', description: 'Item name, singular, lowercase.' },
                        dq: { type: 'integer', description: 'Change in quantity: positive gained, negative lost.' },
                        set: {
                            type: 'integer',
                            description: 'The absolute total now held, instead of a change — "the treasury holds 12,400 marks" is set 12400, never dq. Use set only when the story states a current balance or count outright.',
                        },
                        at: {
                            type: 'string',
                            description: 'Where it is: "carried" (on the character, incl. worn or drawn), a place name ("apartment", "car boot"), "assets" (owned property not carried), "abilities" (a capability), or "money" (the currency name, set or dq = amount). Contact details — a phone number, address, email — are never items.',
                        },
                    },
                    required: ['item', 'dq', 'set', 'at'],
                    additionalProperties: false,
                },
            },
            vit: {
                type: 'array',
                description: 'Changes to health, stamina or similar tracked levels.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Vital name, lowercase: "hp", "mana", "stamina".' },
                        dcur: { type: 'number', description: 'Change from the current value this turn, never the new total: "HP 62 to 44" is dcur -18.' },
                        max: { type: 'number', description: 'Ceiling; send only when newly established, then omit afterwards.' },
                    },
                    required: ['name', 'dcur', 'max'],
                    additionalProperties: false,
                },
            },
            st: {
                type: 'array',
                description: 'Injuries and conditions that started or ended, and WHO they happened to.',
                items: {
                    type: 'object',
                    properties: {
                        who: {
                            type: 'string',
                            description: 'Whose condition — the person\'s name, exactly as in the people list. Empty only for the point-of-view character.',
                        },
                        flag: {
                            type: 'string',
                            description: 'The affliction as a short lowercase phrase: "bruised left arm". Record the affliction, never the reassurance — "otherwise unhurt" is not a condition.',
                        },
                        on: { type: 'boolean', description: 'True if it started, false if it healed or was treated away.' },
                        severity: {
                            type: 'string',
                            enum: SEVERITIES,
                            description: 'How bad: minor (stings), moderate (hinders), severe (could end the scene or the character).',
                        },
                        turns: {
                            type: 'integer',
                            description: 'How many exchanges it lasts on its own; 0 for a wound or anything that needs treatment or time.',
                        },
                    },
                    required: ['who', 'flag', 'on', 'severity', 'turns'],
                    additionalProperties: false,
                },
            },
        },
        required: ['inv', 'vit', 'st'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the delta field.
 * @returns {string} Instruction text.
 */
export function deltaInstruction() {
    return [
        'For each event, record what it CHANGED — changes, not totals. dq is how many were gained or lost, not held afterwards.',
        'Record only what the excerpt NAMES and actually changes; nothing merely mentioned, held over, or unchanged.',
        'Record only what changed in the NEW part of the excerpt — anything shown as already recorded has been counted; do not gain it again.',
        // ── Money first, because it is the state that pays for everything else ──
        //
        // The old list mentioned money in the middle of "things gained or lost" and in the whole of
        // a financial-intrigue chat it produced ZERO money deltas across 46 events — a treasury, a
        // discretionary fund "off the books", tolls cut, a twelve-barge purchase, all recorded as
        // narrative and none as state. The model read "gold" and heard "inventory item", which it
        // reported and fold silently ignored (a money line with no delta is not even a rejection).
        // So money leads the list, and the treasury cases that are NOT a pocketed balance are named
        // outright: a fund granted, a debt incurred, a revenue change — those are money moving too.
        'Money is "at": "money" — name the currency (won, credits, gold, silver), amount in dq, exact as the story says. Grants, purchases, taxes, tolls, debts and funds are money changing hands: a discretionary fund granted is a money gain for the recipient and a loss for the giver, not an inventory item.',
        'A balance the story states outright — "the treasury holds 12,400 marks" — is "set" to that total, never a dq change. Use set only for a stated current balance; use dq for movement.',
        'dcur is the change from the current value, never the new total; max only when newly established.',
        'Contact details (phone number, address, email) are NOT items — never record them as gained.',
        'Set "at": "carried" when on the character, otherwise the place; moving between places is a loss in one and a gain in the other.',
        '"at": "assets" for owned property (house, ship, mount); "at": "abilities" for a capability gained or lost (spell, skill, power). These are the most commonly missed.',
        'Every condition belongs to somebody: "who" is the person\'s name, exactly as in the people list; empty only for the point-of-view character.',
        'Record the affliction, never the reassurance — "otherwise unhurt" is not a condition.',
        'Use empty arrays when an event changed nothing.',
    ].join(' ');
}

/**
 * Validate a proposed delta against the narrative and the state as currently derived.
 *
 * Called when an event is being recorded. Anything that survives is stored on the event and will
 * be folded from then on; anything rejected never enters the ledger, which is what keeps the fold
 * a pure sum.
 *
 * @param {any} raw The delta the model proposed for one event.
 * @param {object} context Context.
 * @param {string} [context.windowText] Narrative window, for the mention gate.
 * @param {object} [context.state] Pre-derived state, to avoid re-folding per event.
 * @param {Set<string>|null} [context.shown] Inventory keys the pinned ledger showed the model this
 *   pass. Threaded from `extract.js` through `chronicle.applyExtraction` rather than re-derived
 *   here, because the question the gate asks is "what was this model told", and only the caller
 *   that built the prompt knows the answer.
 * @returns {{delta: object|null, rejected: object[]}} The accepted delta, or null if empty.
 */
export function validateDelta(raw, { windowText = '', state = null, shown = null } = {}) {
    const current = state ?? derive();

    const inventory = validateInventory({
        inv: current.inv,
        deltas: raw?.inv,
        windowText,
        budget: MAX_CHANGES_PER_TURN,
        shown,
        // The contributor trail, so the already-recorded gate can refuse a cross-window re-record
        // (the doubled ₩680,000 payout, the knife and phone numbers) — see the gate's docblock.
        contributors: current.contributors,
    });
    const vitals = validateVitals({ vitals: current.vitals, deltas: raw?.vit, windowText });
    // ── The cast table is the only thing that can say whether an owner exists ──
    //
    // Threaded in rather than looked up inside `state-table.js`, for that file's standing reason: it
    // is pure, and a validator that reaches into storage cannot be replayed. `entities.load()` is a
    // read of the same table the probe writes, so a person established earlier in THIS pass is
    // already in it by the time a delta names them.
    const status = validateStatus({
        status: current.marks,
        deltas: raw?.st,
        windowText,
        cast: entities.load(),
        pov: pov(),
    });

    if (status.capped) {
        // Three consequence slots per person, and this is the count of the fourth wounds that had to
        // displace or escalate one (`state-table.js` `placeMark`). Never a rejection: the narrative
        // did not propose a wound, it inflicted one.
        observe.noteCap('marks-full', status.capped);
    }

    const rejected = [...inventory.rejected, ...vitals.rejected, ...status.rejected];
    const delta = {};
    if (inventory.accepted.length) delta.inv = inventory.accepted;
    if (vitals.accepted.length) delta.vit = vitals.accepted;
    if (status.accepted.length) delta.st = status.accepted;

    return { delta: Object.keys(delta).length ? delta : null, rejected };
}

/**
 * Record rejections so the UI can show them. A rejection layer nobody can see is one nobody
 * trusts, and one that gets ripped out the first time the state looks wrong.
 * @param {object[]} rejections Rejections from validateDelta.
 */
export function noteRejections(rejections) {
    if (!rejections?.length) {
        return;
    }
    const rejects = loadRejects();
    for (const rejection of rejections) {
        insert_with(rejects, merge_bu, rejection.reason, 1);
    }
    commit(REJECTS_PATH, rejects);
    // Also into the one table that answers "did this bound ever bind" for every constant, not just
    // the ones that reject. See observe.js. The diagnostics log gets the same refusals with the
    // turn they happened on; `mid` was attached by `chronicle.applyExtraction` for the cause-jump,
    // and the state probe's own `recordMarks` refusals carry neither.
    observe.noteRejections(rejections.map(rejection => ({ ...rejection, turn: entities.turn() })));
}

/**
 * The pinned ledger: everything fold currently believes, in one screenful.
 *
 * ── One rendering of the world, and why it starts with one consumer ──
 *
 * The design's centre is that the panel, the narrator, the extractor and the judge all read the
 * same block, so they can never disagree about what fold believes (`FOLD-REDESIGN.md` §5). This is
 * that renderer. In this phase it has exactly one consumer — the extraction prompt — and the
 * narrator keeps `render()` below untouched, deliberately: rewiring the narrator's injection
 * changes how every live chat gets written, and it should land with the phases that also change
 * what there is to render (threads, marks, closures). Shipping the renderer now and the rewiring
 * later is the order that keeps each change measurable on its own.
 *
 * What it contains is the design's budget list and nothing else: money, what is carried and where,
 * vitals, conditions, the people actually here with what they want and know, open leads, live
 * pressure. Everything excluded is excluded for a reason the schema already had — people who are
 * Elsewhere are dropped by `renderEntities`, hidden clocks are named without their numbers by
 * `renderPressure`. Stale carried items used to be excluded too; Phase C deleted that hiding
 * (`state-table.js`, the `isFresh` retirement note), which is why a knife the conversation moved on
 * from is in this block again.
 *
 * ── And it is now a QUESTION, which is the whole of Phase C ──
 *
 * The block ends with the review section: every open line carries a stable id, and the review probe
 * answers per id whether it is still open (`review-table.js` `reviewBlock`). That turns the pinned
 * ledger from something the model reads into something it is accountable to — the retraction
 * mechanism `FOLD-REDESIGN.md` §2 is entirely about. The returned `review` index is how the probe's
 * answers get back to the rows they are about; `extract.js` threads it into the probe context beside
 * `shown`, for the same reason `shown` is threaded: the question "what was this model told" has one
 * honest answer and only the caller that built the prompt knows it.
 *
 * The returned `shown` set is not decoration: `reject:already-recorded` may only refuse a
 * re-report of something the model was actually shown, and this is the only place that knows what
 * that was.
 *
 * @param {object} [params] Options.
 * @param {string} [params.windowText] The recent narrative window, for presence questions.
 * @returns {{text: string, shown: Set<string>, review: Map<string, object>}} The block (or '' when
 *   there is nothing to say), the inventory keys it contained, and the review id index.
 */
export function ledgerBlock({ windowText = '' } = {}) {
    const { inv, vitals, marks } = derive();
    const who = pov();
    const { lines, shown } = renderLedger({ inv, vitals, marks, pov: who });

    const fields = loadContext();
    const at = lookup(fields, 'location', { v: '' }).v;
    // Same exclusion as the narrator's block: the protagonist is not a member of the cast he is the
    // centre of, and listing him invites the model to write him as someone in the room. His marks
    // are on the `Condition:` line above; everyone else's ride beside their own name, which is the
    // whole of Phase D as the model sees it.
    const cast = entities.render({ exclude: who, at, marks });
    const turn = entities.turn();

    // ── The review section REPLACES the thread lines; it does not sit under them ──
    //
    // `render()` below still injects `Pressure:`/`Progress:`/`Threads:` for the narrator, because
    // that is the shape the fiction has been written against. The extraction prompt must not have
    // both: every open thread would appear twice, once as prose and once with an id, and the model
    // would be looking at the same stake in two representations — which is the defect §5 spends its
    // longest paragraph on. Measured on the pre-repair2 Solo Leveling header before this line
    // changed: 30 lines and 6,173 characters, of which the whole `Threads:` line was a restatement
    // of T1–T15 below it. §12's second open question is exactly this block's size discipline.
    const questions = review.pending();
    // ── Presence, the cast-starvation fix ──
    //
    // The cast freezes because the pinned header says "report only CHANGES" while the entities
    // probe says "Re-report anything still true" — a model obeys the header, so a tracked
    // person's `place` stops updating the moment the story moves them. The review's `[where
    // now?]` was only ever asked of UNPLACED people; everyone with a stale-but-non-empty place
    // was never questioned, which is exactly the live-chat failure this reconciles
    // (FOLD-REDESIGN.md §0.1-1). A person whose stored place is ELSEWHERE but whose name appears
    // in the recent window may have moved HERE — that is the model's reading-comprehension
    // question, so it is asked, the same way the unplaced are. It stays a code gate: no window
    // means no misplaced questions (the narrator's own block never sees them).
    const castRows = entities.snapshot({ at, pov });
    // ── The doubt signal is "recorded elsewhere", not "named in the window" ──
    //
    // A person whose stored place contradicts the current scene and who has not been re-reported
    // recently may have moved — the court disperses, a guest retires, a rider leaves. The review's
    // `[where now?]` is the "ask rather than guess" half of the dispatch law
    // (`SelectionDispatch.lean:223`), and before this it was asked only of people with no place at
    // all, plus people recorded elsewhere whose NAME re-appeared in the window. Everyone else sat
    // frozen in the panel: Ulrich, Gerhard and Rathold stayed `present` in "the throne room" for
    // the whole of the Royal Succession chat after the court dismissed at message 32, because the
    // scene moved and nobody ever asked where they went. A stale record is exactly the "evidence
    // cannot decide" case the law names — ask, rather than let the panel assert a room they left.
    // Only mentioned-elsewhere and stale-elsewhere; a person freshly placed needs no question.
    const misplaced = windowText
        ? castRows.elsewhere.filter(person => isMentioned(person.name, windowText))
        : [];
    const staleElsewhere = castRows.elsewhere
        .filter(person => !isMentioned(person.name, windowText) && (person.stale ?? 0) >= PLACE_STALE_AFTER);
    const unplaced = [...castRows.unplaced, ...misplaced, ...staleElsewhere];
    const { text: asked, index } = reviewBlock({
        // Every open thread, dialled or not, LOCAL OR NOT, stale or not — `clocks.reviewable`
        // rather than `clocks.sections`, and its docblock has the hand-check that forced the
        // distinction. A dial can become moot as easily as a lead can be settled, and `tick === 0`
        // being refused as `no-change` (`thread-table.js` foldTicks) is exactly why a dial that
        // stopped mattering had no exit before this.
        threads: clocks.reviewable(turn),
        unplaced,
        contests: contests().map(contest => ({
            field: contest.field, locked: contest.lockedValue, value: contest.narrativeValue, count: contest.count,
        })),
        identity: questions.identity,
        polarity: questions.polarity,
        owed: questions.owed,
        // Marks close the way threads close: the review reads them back and says which are still
        // afflicting anybody (`FOLD-REDESIGN.md` §2's table names marks in the second row, and their
        // only exit before this was the `turns` guess made at write time). Names come from the cast
        // table so the block says "Lee" rather than a normalised key.
        marks: markLines(marks, who),
        threats: entities.threats(),
    });

    // ── The world moves while you are not looking (FOLD-REDESIGN.md §7.5) ──
    //
    // Recent off-screen events ride the pinned block under an explicit reveal contract: the NARRATOR
    // gets the full hidden state (that is what makes the world's off-screen motion something it can
    // hint at and later confirm), while `renderWorldEvents` withholds the content of anything the
    // character could not know until locality makes it assertable. The player's panel stays the more
    // conservative surface; the model is told the constraint instead of being left to infer it.
    const worldLine = renderWorldEvents(chronicle.liveEvents(), at);
    const contract = worldLine ? revealContract() : '';

    return { text: [...lines, cast, worldLine, contract, asked].filter(Boolean).join('\n'), shown, review: index };
}

/**
 * Render current state for the prompt.
 * @returns {string} The block, or '' when there is nothing to say.
 */
export function render() {
    const { inv, vitals, marks } = derive();
    const body = renderState({ inv, vitals, marks, pov: pov() });

    // ── `cap:stale-hidden` was counted here, and nothing increments it any more ──
    //
    // The count that stood here read 198 in the live Solo Leveling chat and 540 in Raccoon City, and
    // it was measuring fold hiding a character's own pockets from the narrator. `isFresh` is gone
    // (`state-table.js` carries its retirement note and the three measurements that killed it), so
    // the counter is retired to zero by construction — which `FOLD-REDESIGN.md` §5 calls the
    // cleanest success criterion in the document. It stays in `observe.js` KNOWN_RULES so the zero
    // is visible rather than merely absent.
    const expired = table_entries(marks).filter(([, v]) => v?.turns > 0 && !v.on).length;
    if (expired) {
        observe.noteCap('condition-expired', expired);
    }

    // People and leads as objects. The card's block already carries them as prose, so this is a
    // replacement rather than an addition: `Maria (reachable by email)` is the pairing the flat
    // block destroyed, and sending both shapes would spend tokens contradicting ourselves.
    // The protagonist is excluded from the cast list he is at the centre of, for the same reason
    // the panel excludes him: telling the model "People: Solomon" when Solomon is the point of view
    // invites it to write him as someone in the room rather than as the one looking at it.
    const fields = loadContext();
    const cast = entities.render({
        exclude: lookup(fields, 'pov', { v: '' }).v,
        // The scene's own location decides who is in it. Both halves of the comparison finally live
        // in the same call.
        at: lookup(fields, 'location', { v: '' }).v,
        marks,
    });
    // Pressure last in the block and first in importance — it is the only part that says what is
    // about to happen rather than what is already true. Rendered here rather than below because
    // the block's own `leads` field is superseded by the `Threads:` line, not by the cast line:
    // leads became threads in Phase B and the label they shadow moved with them.
    const stakes = clocks.render(entities.turn(), lookup(fields, 'location', { v: '' }).v);
    const superseded = new Set([
        ...(cast.includes('People:') ? PERSON_LABELS : []),
        ...(stakes.includes('Threads:') || stakes.includes('Pressure:') ? LEAD_LABELS : []),
    ]);

    // Scene context first: it is what the card's own block led with, and it is the part the
    // narrator most needs handed back to it, since it is the only part fold cannot re-derive.
    // ── Why the clock is annotated rather than simply stated ──
    //
    // Injecting "Time: 1:03 PM" every turn is an assertion, and the model reads it as one. When the
    // narrative has moved through an afternoon and the block never restated the time, fold was
    // handing back a clock the story had outrun — and the model, asked what time it was, dutifully
    // repeated it. The panel was not failing to track time; fold was actively holding it still.
    //
    // So a clock nothing has confirmed for a few exchanges is labelled as such. That converts a
    // silent falsehood into a request the narrator can act on.
    const clock = loadClock();
    const stale = isClockStale(clock);
    const now = clock.seen ?? 0;

    let dropped = 0;
    // Locked scene fields render as `(fixed)` so the narrator is TOLD the value is pinned rather
    // than silently overridden and left to fight it (§8: lock-serialization, Marinara's design
    // adopted because "the narrator is *told* the field is pinned instead of silently overridden").
    const locked = new Set(lockedFields());
    const context = table_entries(fields)
        .filter(([label]) => !superseded.has(label))
        .map(([label, field]) => {
            // "Pov: Solomon" is a field name leaking into the prompt. The model is being told who
            // the story follows, so it should read as that sentence. Never aged out — who the story
            // follows is not a fact about the present scene.
            if (label === 'pov') {
                return `Point of view: ${field.v}`;
            }
            const head = `${label[0].toUpperCase()}${label.slice(1)}`;
            const fix = locked.has(label) ? ' (fixed)' : '';
            const age = Math.max(0, now - (field.t ?? 0));
            if (label === 'time' && stale) {
                return `${head}: ${field.v} (last confirmed ${clockAge(clock)} exchanges ago — state the current time if it has moved on)`;
            }
            switch (contextBand(age)) {
                case 'assert':
                    return `${head}: ${field.v}${fix}`;
                // A field nobody has restated in a while is not part of the present scene. Saying so
                // is the difference between context and a claim: without it the block asserted an
                // apartment, a grocery cashier and a lunchtime clock as one moment, none of which
                // were true together.
                case 'annotate':
                    return `${head}: ${field.v}${fix} (as of ${age} exchanges ago)`;
                // Past the horizon an annotation is no longer enough. The panel still shows it with
                // its age; the prompt stops asserting a scene the story has left.
                default:
                    dropped++;
                    return '';
            }
        })
        .filter(Boolean);
    if (dropped) {
        observe.noteCap('context-stale', dropped);
    }

    const scene = [...context, cast, stakes].filter(Boolean).join('\n');
    if (!scene) {
        return body;
    }
    return [`[Scene]\n${scene}`, body].filter(Boolean).join('\n');
}

/**
 * Everything the UI panel needs, including the audit trail.
 * @returns {object} A snapshot.
 */
export function snapshot() {
    const { inv, vitals, marks, since, contributors } = derive();
    const who = pov();
    const cast = entities.load();

    return {
        // Everything the card itself reported — time, location, conditions, leads. Fold cannot
        // model most of it and does not need to; the panel's job is to show what was said.
        context: table_entries(loadContext())
            .map(([label, field]) => ({ label, value: field.v, age: Math.max(0, (loadClock().seen ?? 0) - (field.t ?? 0)) })),
        // How long since the narrator last restated its status block. Measured on a real chat,
        // blocks arrive in bursts, so a gap is normal — but a gap nobody can see looks like a
        // tracker that has stopped working.
        sinceBlock: turnsSinceBlock(),
        // Everything held, full stop. The panel used to receive a `fresh` flag and draw the rest as
        // a count, because `isFresh` hid stale carried items from the prompt and a panel that hid
        // them too would have been lying twice. Phase C deleted the hiding, so `fresh` is `true` for
        // every row by construction — kept on the shape rather than removed, because the panel and
        // the calibration instrument both read it and a silently vanishing field is the kind of
        // change that produces a blank section nobody notices.
        inventory: table_entries(inv).map(([key, item]) => ({
            ...splitItemKey(key),
            key,
            qty: item?.qty ?? 0,
            since: since.get(key) ?? 0,
            fresh: true,
            // Why you have this: the events that produced the quantity, each with its anchor so the
            // panel can jump a contributor to the message that caused it (§8 cause-link).
            from: (contributors.get(key) ?? []).map(c => ({ dq: c.dq, summary: c.summary, mid: c.mid ?? null })),
        })),
        vitals: table_entries(vitals).map(([name, v]) => ({ name, cur: v?.cur ?? 0, max: v?.max ?? 0 })),
        // ── The pov's marks only, which is what the Condition section always claimed to be ──
        //
        // Objects, not strings: a condition that ticks has a remaining fraction, and the panel
        // draws it. `fade` is 1 for anything with no stated duration, so those render no timer.
        // Everyone else's marks come through `marks` below and render on their own row, so the
        // section that says "Condition" under the player's name stops carrying other people's
        // wounds (`FOLD-RPG-GAP.md` §3).
        status: povMarks(marks, who).map(([key, v]) => ({
            subject: splitMarkKey(key).subject,
            phrase: v.phrase ?? splitMarkKey(key).subject,
            severity: v.severity ?? '',
            turns: v.turns ?? 0,
            fade: Number.isFinite(v.fade) ? v.fade : 1,
        })),
        // Every live mark with the cast row it belongs to, so the panel can draw a wound beside the
        // person carrying it. `owner` is a TABLE KEY, resolved here through the alias set rather
        // than in the panel, for `snapshot`'s standing reason: the panel must never have to know
        // that a name and a title can be the same person.
        marks: table_entries(marks)
            .filter(([, mark]) => mark?.on)
            .map(([key, mark]) => {
                const { who: name, subject } = splitMarkKey(key);
                return {
                    key,
                    subject,
                    who: mark.who ?? name,
                    owner: name ? (resolveEntity(cast, PERSON, name)?.key ?? '') : '',
                    mine: !name || ownerKey(name) === ownerKey(who),
                    phrase: mark.phrase ?? subject,
                    severity: mark.severity ?? '',
                    turns: mark.turns ?? 0,
                    fade: Number.isFinite(mark.fade) ? mark.fade : 1,
                };
            }),
        rejects: table_entries(loadRejects()).map(([reason, count]) => ({ reason, count })),
        // The diagnostics log: what was rejected and which extraction passes failed, newest first.
        // The panel's "N rejected" footer opens it, so a tally is one click from its causes.
        log: log.load(),
        // The extraction lifecycle, so the panel can show acknowledged/syncing/failed instead of a
        // stale value presented as current (FOLD-SLA.md §2).
        sync: getSync(),
        locks: lockedFields(),
        // ── The lock's argument with the narrator, made visible ──
        //
        // `{field, lockedValue, narrativeValue, count}`, and every field of it is load-bearing for
        // the panel's one-click accept: the value that stands, the value the story keeps asserting,
        // and how consistently. Empty until a field crosses CONTEST_AT, so an ordinary lock costs
        // the panel nothing. `FOLD-REDESIGN.md` §5.
        contests: contests(),
        // Block prose the structured pipelines refused, kept exactly as the card wrote it. See
        // `noteShadow`: a refusal that destroys the evidence is a loss, not a refusal.
        shadow: shadow(),
        // So the panel can show a stopped clock as stopped rather than as the time.
        clock: { ...loadClock(), age: clockAge(loadClock()), stale: isClockStale(loadClock()) },
        staleThreshold: STALE_THRESHOLD,
    };
}

/**
 * Live marks as review lines: `{key, who, name, phrase, severity}`, pov first.
 *
 * Names are resolved back through the cast table so the block asks about "Lee" rather than about a
 * normalised key, and so a mark whose owner has since been merged away still names somebody.
 *
 * @param {Map<string, object>} marks The marks table.
 * @param {string} who The pov's name.
 * @returns {object[]} Mark lines for `reviewBlock`.
 */
function markLines(marks, who) {
    const cast = entities.load();
    return table_entries(marks)
        .filter(([, mark]) => mark?.on)
        .map(([key, mark]) => {
            const owner = splitMarkKey(key).who;
            const named = owner ? resolveEntity(cast, PERSON, owner)?.entity?.name : '';
            return {
                key,
                // The DISPLAY name, or '' for the pov — this is what a closure event will carry as
                // its `who`, and `ownerKey` normalises it back to the same bucket the mark is in.
                // The prose `name` below must never be used for that: its pov fallback is a
                // sentence, and a sentence would key as a person nobody has met.
                who: owner ? (named || mark.who || owner) : '',
                name: named || (owner ? mark.who ?? owner : who || 'the point-of-view character'),
                mine: !owner || ownerKey(owner) === ownerKey(who),
                phrase: mark.phrase ?? splitMarkKey(key).subject,
                severity: mark.severity ?? '',
            };
        })
        .sort((a, b) => Number(b.mine) - Number(a.mine) || a.key.localeCompare(b.key));
}

/**
 * Record marks somebody is carrying, as one event.
 *
 * ── The mention gate is widened here, for `review.js`'s reason ──
 *
 * `isMentioned` exists to stop a model inventing an ITEM the excerpt never named, and it works
 * because an item has a name the prose uses. An affliction does not: the scene probe is asked *how
 * is this character doing* and answers in its own words — "calf scabbed and rebandaged" against a
 * paragraph that said "he re-wraps the bandage". Checked against the window alone the gate would
 * refuse nearly every honest answer, so the phrase itself joins the haystack, exactly as
 * `absorb.js` widens the gate with the block text (the block is the narrator restating its own turn)
 * and as `review.js` widens it with a quoted price. What survives is the rest of validation: the
 * negation rule, the owner rule, the per-owner slot rule.
 *
 * @param {Array<{phrase: string, severity?: string, who?: string}>} marks Proposed marks.
 * @param {object} [context] Context.
 * @param {string} [context.windowText] The narrative window.
 * @param {Array<{key: string, mid: number}>} [context.sources] Window sources, newest last.
 * @param {string} [context.summary] Leading words for the event summary.
 * @returns {number} How many marks were recorded.
 */
export function recordMarks(marks, { windowText = '', sources = [], summary = 'Condition' } = {}) {
    const proposed = (Array.isArray(marks) ? marks : [])
        .map(mark => ({ who: mark?.who ?? '', flag: mark?.phrase, on: true, severity: mark?.severity, turns: 0 }))
        .filter(mark => String(mark.flag ?? '').trim());
    if (!proposed.length) {
        return 0;
    }
    const said = proposed.map(mark => mark.flag).join('; ');
    const outcome = validateDelta({ st: proposed }, { windowText: `${windowText}\n${said}` });
    noteRejections(outcome.rejected);
    if (!outcome.delta) {
        return 0;
    }
    const anchor = sources[sources.length - 1];
    const recorded = chronicle.recordReviewEvent({
        summary: `${summary}: ${said}`.slice(0, 200),
        keywords: proposed.map(mark => String(mark.flag)).slice(0, 4),
        delta: outcome.delta,
        srcKey: anchor?.key,
        mid: anchor?.mid,
    });
    return recorded ? outcome.delta.st?.length ?? 0 : 0;
}

/**
 * Clear a mark, as an event.
 *
 * ── Why this is an append and not a delete ──
 *
 * Marks derive from the ledger, so "healed" is a thing that HAPPENED and gets recorded like
 * everything else: an `st` delta with `on: false`, anchored on the message the review was reading.
 * Swipe that message away and the healing un-happens along with the turn that described it, exactly
 * as `overlayClosures` promises for threads (`thread-table.js`) — with no overlay needed, because
 * marks were never stored in the first place.
 *
 * @param {object} params Parameters.
 * @param {string} params.key The mark key (`markKey`).
 * @param {string} params.phrase The phrase, for the summary and for the delta's own flag.
 * @param {string} [params.who] The owner's name, as stored on the mark.
 * @param {string} [params.note] The review's five-word note.
 * @param {string} [params.srcKey] Content key of the anchor message.
 * @param {number} [params.mid] Anchor message index.
 * @returns {boolean} True if an event was recorded.
 */
export function clearMark({ key, phrase, who = '', note = '', srcKey = '', mid } = {}) {
    const said = String(phrase ?? splitMarkKey(key).subject ?? '').trim();
    if (!said) {
        return false;
    }
    const owner = String(who ?? '').trim();
    return chronicle.recordReviewEvent({
        summary: `${owner || 'The point-of-view character'} is over: ${said}${note ? ` (${note})` : ''}`.slice(0, 200),
        keywords: [said, owner].filter(Boolean),
        delta: { st: [{ who: owner, flag: said, on: false, turns: 0 }] },
        srcKey,
        mid,
    });
}

/**
 * The balance on record, and what it is denominated in.
 *
 * Read off the ledger rather than named by a setting, because the currency is whatever the fiction
 * calls it — won, credits, crowns — and a currency list is the enumerated-vocabulary shape §11 rules
 * out. When several currencies are held the largest holding is the one quoted, on the grounds that a
 * question about what a purchase cost is about the money the character actually spends.
 *
 * @returns {{amount: number, currency: string}} The balance.
 */
export function balance() {
    const { inv } = derive();
    let best = { amount: 0, currency: '' };
    for (const [key, item] of table_entries(inv)) {
        const parts = splitItemKey(key);
        if (normalizePlace(parts.place) !== MONEY) continue;
        if ((item?.qty ?? 0) >= best.amount) {
            best = { amount: item?.qty ?? 0, currency: parts.name };
        }
    }
    return best;
}

/**
 * Watch a pass's deltas for acquisitions nobody paid for.
 *
 * The trigger half of `FOLD-REDESIGN.md` §5 fix 1: **code decides when to ask**. The detection rule
 * and its full argument are `creditsWithoutDebit` (`state-table.js`); this is the wiring that gives
 * it the balance and hands the question to `review.js` to be asked on the NEXT pass — next, because
 * the pass that noticed has already sent its prompt, and inventing a second call to ask sooner is
 * the thing §11 forbids outright.
 *
 * @param {object} params Parameters.
 * @param {object[]} params.accepted Accepted inventory deltas from this pass, flattened.
 * @param {object[]} [params.refused] Rejections from this pass.
 * @returns {string[]} The items the next review will ask about.
 */
export function noteCredits({ accepted = [], refused = [] } = {}) {
    const items = creditsWithoutDebit({ accepted, refused });
    if (!items.length) {
        return [];
    }
    const held = balance();
    review.noteCredits({ items, balance: held.amount, currency: held.currency || 'money' });
    observe.note('review:owed', items.length);
    return items;
}

/**
 * Manually adjust an item by recording a user-authored event.
 *
 * State is a fold over the ledger, so the only honest way to change it is to add to the ledger.
 * That keeps the audit trail complete: a hand-edited quantity is visibly a hand edit.
 *
 * @param {string} rawName Item name.
 * @param {number} dq Quantity change.
 * @returns {boolean} True if an event was recorded.
 */
/**
 * Move an item to a place, by hand.
 *
 * ── Why this has to exist ──
 *
 * Measured on a real chat: all 38 inventory deltas in the ledger carry no place at all, and every
 * one came from block absorption. The extraction probe has never proposed one. So the place
 * mechanism was complete, tested, rendered — and nothing had ever used it, which is why a shelf of
 * groceries kept reading as luggage.
 *
 * A card's block cannot fix this. Its inventory field means "what you have", and the narrator is
 * not tracking whether you set the bags down. You are. So this is a user event, and
 * `restateInventory` now carries a known place forward, which is what makes the correction stick
 * instead of being undone by the next block.
 *
 * @param {string} rawName Item name.
 * @param {string} place Destination place, or 'carried'.
 * @returns {{moved: boolean, from?: string, to?: string, reason?: string}} What happened.
 */
export function moveItem(rawName, place) {
    const parsed = normalizeItemName(rawName);
    if (!parsed) {
        return { moved: false, reason: 'unusable-name' };
    }
    const to = normalizePlace(place);

    const { inv } = derive();
    let from = null;
    let qty = 0;
    for (const [key, item] of table_entries(inv)) {
        const split = splitItemKey(key);
        if (split.name === parsed.name) {
            from = split.place;
            qty = item?.qty ?? 0;
            break;
        }
    }

    if (from === null) {
        return { moved: false, reason: 'not-held' };
    }
    if (from === to) {
        return { moved: false, reason: 'already-there', from, to };
    }

    // Out of one place and into the other, as one event — the same shape the extraction schema
    // describes for a move, so a hand correction and a narrated one fold identically.
    const recorded = chronicle.recordUserEvent({
        summary: `Moved ${parsed.name} to ${to === CARRIED ? 'carried' : to}`,
        keywords: [parsed.name, to],
        delta: {
            inv: [
                { item: parsed.name, dq: -qty, at: from },
                { item: parsed.name, dq: qty, at: to },
            ],
        },
    });
    return recorded ? { moved: true, from, to } : { moved: false, reason: 'not-recorded' };
}

export function adjustItem(rawName, dq, at = '') {
    const parsed = normalizeItemName(rawName);
    if (!parsed || !Number.isFinite(dq) || !dq) {
        return false;
    }
    const delta = Math.trunc(dq);
    return chronicle.recordUserEvent({
        summary: `${delta > 0 ? 'Gained' : 'Lost'} ${Math.abs(delta)} ${parsed.name}`,
        keywords: [parsed.name],
        // `at` matters for money: an untagged "won" delta keys as carried and clamps at MAX_QTY
        // (the mid-46 live-chat bug). An edit to a money row must tag its delta so the fold lands
        // it on the balance, not in a pocket (FOLD-REDESIGN.md §8 edit-in-place).
        delta: { inv: [{ item: parsed.name, dq: delta, ...(at ? { at } : {}) }] },
    });
}
