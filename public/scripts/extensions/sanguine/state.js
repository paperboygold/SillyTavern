/**
 * fold/state.js: inventory, vitals and status, derived from the chronicle.
 *
 * There is no state table. A chronicle event may carry a `d` (delta) describing what it did to the
 * world, and the current state is a fold over the events that are live on this branch. See
 * state-table.js for why, and for the three merges that do the folding.
 *
 * The only thing persisted here is the rejection tally, which is not derivable from the ledger,
 * a rejected delta is by definition one that never became an event.
 */

import { insert_with, lookup, merge_b, merge_bu, table_entries } from './lib/hash.js';
import { advanceClock, advanceSceneClock, blockReport, clockAge, clockScalar, formatClock, isClockStale, parseClock } from './clock.js';
import { MIN_INTERVAL } from './trigger-table.js';
import { assembleStateBlock } from './prompt-fragments.js';
import * as chronicle from './chronicle.js';
import * as entities from './entities.js';
import * as places from './places.js';
import * as parts from './parts.js';
import * as flows from './flows.js';
import { renderFlows } from './flow-table.js';
import * as clocks from './clocks.js';
import * as observe from './observe.js';
import { ENTITY_STALE, LEAD_LABELS, PERSON, PERSON_LABELS, absentKeys, resolveEntity } from './entity-table.js';
import { SHADOW } from './absorb-table.js';
import {
    itemKey,
    ACQUISITIONS,
    BLOCK,
    BOUGHT,
    CATEGORIES,
    CONTEXT_OVERRIDE_AFTER,
    NARRATIVE,
    carriedBaseline,
    contextBand,
    creditsWithoutDebit,
    deriveState,
    isDisposable,
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
    recentlyRecorded,
    refusedDebits,
    keepRefused,
    renderRefused,
    renderLedger,
    renderState,
    splitItemKey,
    STALE_THRESHOLD,
    validateInventory,
    validateStatus,
    validateVitals,
} from './state-table.js';
import { reviewBlock, reviewableWindow } from './review-table.js';
import { excessMarkKeys, shedMarkKeys, sortAckKeys } from './reject-table.js';
import * as review from './review.js';
import { coveredCast, coveredThreads } from './coverage.js';
import { PRUNE_ARCHIVE, commit, commitValue, loadTable, loadValue, registerPruner } from './store.js';
import * as log from './log.js';
import { renderWorldEvents, revealContract } from './world-table.js';
import { checkInvariants, freshFindings } from './invariant-table.js';
import { buildCrosswalk } from './crosswalk.js';

const REJECTS_PATH = 'state.rejects';

/**
 * The debits fold refused because it holds no such row, kept until the model has been told.
 * A refusal the model cannot see is a refusal it will make again.
 *
 * `reject:remove-unknown` is correct: folding a debit against an unheld row would open it at a
 * negative quantity and stop the arithmetic being a sum. The failure was never saying so, so the
 * counter ticked and the model re-proposed the same debit every pass.
 *
 * Measured on the live Wuxia campaign (149 traced passes, 17 `reject:remove-unknown`; the replay
 * recovers 13 of them from the inventory validator). Eight of the thirteen were a row fold holds
 * under another name (`fragment`/`artifact fragment`, `herb basket`/`basket`, `vine herb`/`dried
 * herbs`, `wooden token`/`token`, `tael`/`silver`) and every one sent `same_as: ""`, the identity
 * channel existed and was simply unused. The other five were a currency the ledger never opened,
 * correctly and permanently refused. Three of the thirteen were one beat (the fragment sale)
 * re-told across passes, three more one inn bill re-told, the same re-tell mechanism as
 * `(counted)`. So `remove-unknown` here is item identity plus invisible re-tell, not a drained
 * balance.
 *
 * The fix is to report the refusal where the model will read it, in fold's own words, naming only
 * what fold can prove, the name it was sent and the place it was sent for. Fold never guesses which
 * held row was meant; `renderRefused` asks, and `same_as` is the answer ([ROUTER]: identity is the
 * model's, never fold's).
 *
 * Only storage lives here. What qualifies (`refusedDebits`), the bounds (`MAX_REFUSED`,
 * `REFUSED_TURNS`) and the wording (`renderRefused`) are in `state-table.js`, so a test can make
 * the decision without a browser.
 */
const REFUSED_PATH = 'state.refused';

// `review.js` owns this table; read here for the partition-consistency check only, never written.
const REVIEW_ANSWERS_PATH = 'state.answers';
const CONTEXT_PATH = 'state.context';
const CLOCK_PATH = 'state.clock';

/** People worth high-resolution detail. Same shape and same reasoning as `state.locks`. */
const POI_PATH = 'state.poi';

/** The one thread the player has pinned, overriding what coverage says is current. */
const ACTIVE_THREAD_PATH = 'state.activeThread';
const SYNC_PATH = 'state.sync';

/**
 * Whether the model reported narrative time moving on the last pass, waiting to arm the next one.
 * A single boolean rather than a table: it holds one fact and is read-and-cleared. See `applyClock`.
 */
const SKIPPED_PATH = 'state.skipped';

/**
 * Invariant findings already reported, so a standing defect is counted once rather than per pass.
 *
 * See `freshFindings` (`invariant-table.js`) for the measurement that made this necessary. Bounded
 * by the number of REAL defects a chat has, which is one in 143 messages of the live Wuxia RP, the
 * flood it replaces was 94 copies of that one.
 */
const AUDITED_PATH = 'state.audited';

/**
 * What the ledger held before the events it no longer keeps. Bounded by the number of distinct
 * items a campaign ever touches, not by its length, which is why it can outlive the event cap.
 */
const BASELINE_PATH = 'state.baseline';

/** What each card-invented status field IS, as the review model classified it. label -> {kind, tempo, same_as}. */
const SHEET_PATH = 'state.sheet';

/**
 * Context labels fold routes itself, and therefore never asks the model to classify.
 *
 * These are fold's OWN protocol, the scene probe writes `location`, `pov`, `time`, `date` and
 * `weather` under exactly these names, and `block-parse.js` routes `health`/`conditions` into the
 * status pipeline before context is ever written. RULE 1 permits block-field labels explicitly as
 * PROTOCOL; what it bans is a list of English words used to guess what a CARD meant, which is the
 * job `SHEET_KINDS` hands to the model instead.
 *
 * `PERSON_LABELS` and `LEAD_LABELS` belong here for the same reason and were missing. They name the
 * cast and thread tables, which fold routes itself, but because they were not listed, the review
 * WAS asked to classify them, answered with a perfectly reasonable non-stat kind, and that kind is
 * what guaranteed `immediate contacts` landed in the panel's Sheet section instead of anywhere
 * sensible. A field fold owns must never be posed to the model, or the model's honest answer becomes
 * the bug.
 */
export const MODELLED_FIELDS = new Set([
    'time', 'date', 'location', 'weather', 'pov', 'conditions', 'health',
    ...PERSON_LABELS, ...LEAD_LABELS,
]);

/** @returns {Map<string, {kind: string, tempo: string, same_as: string}>} The stored classifications. */
export function sheet() {
    return loadTable(SHEET_PATH);
}

/**
 * Record what the review model said each card field is.
 * @param {Array<{label: string, kind: string, tempo: string, same_as: string}>} rows Classifications.
 * @returns {number} How many were stored.
 */
export function classifySheet(rows) {
    const list = Array.isArray(rows) ? rows.filter(row => row?.label) : [];
    if (!list.length) {
        return 0;
    }
    const table = sheet();
    for (const row of list) {
        insert_with(table, merge_b, row.label, { kind: row.kind, tempo: row.tempo, same_as: row.same_as ?? '' });
    }
    commit(SHEET_PATH, table);
    return list.length;
}

/**
 * The card fields nothing has classified yet, for the review block to pose.
 *
 * Only the unanswered ones, so a sorted sheet costs nothing: the list empties, the section stops
 * rendering and the schema array comes back empty forever after.
 *
 * @returns {Array<{label: string, value: string}>} Unsorted fields.
 */
export function unsortedSheet() {
    const known = sheet();
    const out = [];
    for (const [label, field] of table_entries(loadContext())) {
        if (MODELLED_FIELDS.has(label) || known.has(label)) {
            continue;
        }
        out.push({ label, value: String(field?.v ?? '') });
    }
    return out;
}

/**
 * The extraction lifecycle, as the player should see it.
 *
 * FOLD-SLA.md §2: freshness and failure must be VISIBLE. This is the record the strip and the
 * panel render, so a stale panel is never presented as current and a failed pass is never silent.
 *
 *   up-to-date    the ledger reflects the newest processed message. Green.
 *   acknowledged  a message just rendered; extraction is pending. Amber, your input is seen.
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
 * Scene context lifted from a card's own state block, time, location, leads and whatever else it
 * chose to report. Stored rather than derived because it is the narrator's assertion about the
 * present, not something a fold over past events can reconstruct: nothing in the ledger says what
 * time it is now.
 * @returns {Map<string, string>} label -> value.
 */
/**
 * The scene's current location, as the scene probe last worded it.
 *
 * Exposed so the entities probe can be told which string the scene already chose. `samePlace` is
 * exact by design, so two probes answering "where is this" independently in the same pass is a
 * coin-flip on whether anybody is ever in the room, measured on Raccoon City, the scene said
 * `RPD break room`, the cast said `break room`, and `here` was empty for nine people standing in it.
 *
 * @returns {string} The location, or ''.
 */
export function sceneLocation() {
    return String(lookup(loadContext(), 'location', { v: '' }).v ?? '').trim();
}

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
 * A narrator that omits Location this turn has not moved the character to nowhere, same asymmetry
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
 * Advance the clock on the scene probe's report of elapsed time and current time.
 *
 * The scene probe reads the narrative with comprehension and reports STRUCTURED values, `days`
 * (whole days passed), `minutes` (sub-day minutes), `phase` (the part of a day a transition marker
 * landed on), and `clockHour`/`clockMinute` (the clock as it now reads). These are one update, not
 * two: `advanceSceneClock` moves the DAY by the elapsed and sets the FACE from the clock (or the
 * marker's implied phase). Before this, `time` was folded in absolutely by `setContext` and
 * `elapsed` was added on top by a minute count, a pass reporting "come morning" and "19:45" set
 * the clock to 19:45 and then added a day to it, leaving the face frozen at 19:45 while the day
 * rolled (the Royal Succession court that assembled "at first light" and read 19:45).
 *
 * The model is the authority here, in any language: it read the prose and answered with numbers,
 * so no English gate is applied to any of it.
 *
 * @param {object} [stated] The scene probe's answers.
 * @param {number} [stated.days] Whole days passed.
 * @param {number} [stated.minutes] Sub-day minutes passed.
 * @param {string} [stated.phase] The part of a day a marker landed on: '' or a day part.
 * @param {number} [stated.clockHour] The hour the clock reads now, or NaN.
 * @param {number} [stated.clockMinute] The minute, or NaN.
 * @param {boolean} [stated.dateChanged] Whether a new day was named.
 * @returns {{skipped: boolean, minutes?: number}} Whether the clock moved.
 */
export function noteSceneElapsed({ days = 0, minutes = 0, phase = '', clockHour = NaN, clockMinute = NaN, dateChanged = false, date = '' } = {}) {
    // `date` rides so the roll can tell a NEW day from the same day read twice, see
    // `advanceSceneClock`. Without it a bare `date_changed` rolls on every pass whose window still
    // contains the sentence that named the day.
    const clock = advanceSceneClock(loadClock(), { days, minutes, phase, clockHour, clockMinute, dateChanged, date });
    // A span too large to believe is clamped rather than refused, the story still moves, by as much
    // as fold is willing to accept at once. Counted here so a model that has lost its place shows up
    // as a number instead of as a clock nobody can explain.
    if (clock.clamped) {
        observe.noteCap('span-clamped');
    }
    if (!clock.accepted) {
        return { skipped: false };
    }
    return applyClock(clock, 'scene');
}

/**
 * Advance the persisted clock and keep its consumers in step.
 *
 * The shared tail of every clock writer: persist it, tick any calendar fronts that the elapse runs
 * past, and push the new time into the scene's display field.
 * @param {object} clock The new clock from a pure `advanceClock`/`advanceSceneClock`/`skipClock`.
 * @param {'player'|'scene'} source Who asserted the passage, for the audit trail.
 * @returns {{skipped: boolean, minutes?: number}} The outcome.
 */
function applyClock(clock, source) {
    saveClock(clock);

    // A declared elapse is the one high-precision signal a `per`-front can tick against. The
    // residency window's "twelve months pass" is a pure calendar condition; before Phase W it could
    // not fire, because ticks arrived only from on-screen extraction (FOLD-REDESIGN.md §7.1, §7.4).
    // This is arithmetic fold can do, traded for no hallucination surface and no model call. The
    // pure function is idempotent by construction, so fire-and-forget on the player's say-so is safe.
    try {
        clocks.tickCalendar({ now: clockScalar(clock.day, clock.minutes), turn: entities.turn() });
    } catch (error) {
        console.error('[sanguine] failed to tick calendar fronts', error);
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
    // The reconnected wire: an accepted elapse arms the NEXT pass.
    //
    // `trigger-table.js` says the world's triggers are "the model's own report, not a regex", and
    // that was true of the deletion and false of the wiring. When the English time-phrase word lists
    // came out, `TIME_SKIPPED` lost its only producer and nothing replaced it, so `world.js` armed
    // on a reason no code path could emit, and the off-screen world never wrote a single event.
    // Measured before this line existed: `0` events with `src: 'world'`, across every campaign.
    //
    // The model already answers the question, structurally, in the schema it fills every pass
    // (`elapsed_days`, `elapsed_minutes`, `date_changed`). This flag is that answer, kept for one
    // pass. One pass behind is not a compromise here: the pass that READ the skip has already built
    // and sent its prompt, so arming it retroactively is impossible, and inventing a second request
    // to ask sooner is the thing RULE 1 forbids outright.
    commitValue(SKIPPED_PATH, true);
    return { skipped: true, minutes: clock.minutes };
}

/**
 * Has the model reported narrative time moving since the last pass looked?
 *
 * Read-and-clear: the flag arms exactly one pass. Leaving it set would arm every subsequent pass
 * until the next skip, which would make the world fragment permanent rather than occasional and
 * quietly triple the schema on conversational turns.
 *
 * @returns {boolean} True when the previous pass reported an elapse, clearing it.
 */
export function takeTimeSkip() {
    if (!loadValue(SKIPPED_PATH, false)) {
        return false;
    }
    commitValue(SKIPPED_PATH, false);
    return true;
}

/**
 * How many turns since a state block was last absorbed.
 *
 * Null when no block has ever been absorbed, which is a different fact from a long gap and has to
 * read as one. A card with no stat block never writes a block at all, so `block` stays at its
 * initial value and the subtraction reports the whole chat length as a gap, an alarm about a
 * feature the chat does not use. `NaN` from the store is the honest initial value; 0 was a lie
 * that happened to be a number.
 *
 * @returns {number|null} The gap, or null if no block has ever arrived.
 */
export function turnsSinceBlock() {
    const clock = loadClock();
    // Zero counts as never, not as turn zero. Chats that ran before `block` defaulted to NaN have
    // a literal 0 persisted, and `seen - 0` reports the whole chat as a gap, which is how a chat
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
 * Why this is derived and not a counter.
 *
 * It was `let sinceExtract = 0` in index.js, incremented per reply and reset to zero on
 * CHAT_CHANGED. Two failure modes fall out of that, and both are silent. A reload puts it back to
 * zero, so the first four replies after every refresh are dead. Worse, CHAT_CHANGED fires whenever
 * you so much as glance at another chat, so a session spent switching between two chats can reset
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
 * would be a lie the next pass acts on, it advances only when a pass has succeeded.
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

/**
 * Store scene/block context fields, folding the clock when the source asserts one.
 *
 * Why `skipClock` exists.
 *
 * A card's status block is the narrator asserting the time in its own words, so `setContext` folds
 * `time`/`date` into the clock through `advanceClock`: the block is the clock's writer. The scene
 * probe reports BOTH `time` and `elapsed`, and those are ONE update (`advanceSceneClock`, via
 * `noteSceneElapsed`); letting `setContext` fold `time` in separately would write the same pass
 * twice. So the scene path stores its fields here with `skipClock: true` and advances the clock in
 * `noteSceneElapsed` instead. The display field still needs the face, which `applyClock` pushes.
 *
 * @param {Map<string, string>} context Fields to store.
 * @param {object} [opts] Options.
 * @param {'block'|'narrative'} [opts.source] Who asserted the fields.
 * @param {boolean} [opts.skipClock] Do not fold `time`/`date` into the clock; the caller does.
 */
export function setContext(context, { source = BLOCK, skipClock = false } = {}) {
    if (!context?.size) {
        return;
    }

    // The clock is folded separately, under `max` rather than last-write. See `advanceClock`.
    // `seen` is already current, `noteTurn` ran for this turn before the block was parsed, so
    // advanceClock must not count it again.
    const before = loadClock();
    const clock = skipClock
        ? { ...before, seen: before.seen - 1, accepted: true }
        : { ...advanceClock({ ...before, seen: before.seen - 1 }, {
            time: context.get('time'),
            date: context.get('date'),
        }), block: source === BLOCK ? before.seen : before.block };
    saveClock(clock);
    if (clock.reason === 'reversed') {
        // The raw is what the clock was told and what it held: a refusal nobody can read back is a
        // tally, not a diagnostic (`tests/fold-no-raw-reject.test.js`).
        noteRejections([{
            item: String(context.get('time') ?? ''),
            reason: 'clock-reversed',
            detail: `held day ${before.day} ${before.raw ?? ''}`,
            raw: { time: context.get('time') ?? '', date: context.get('date') ?? '', source },
        }]);
    }

    // No lock check here any more.
    //
    // This block used to read `state.locks` and DISCARD any incoming write for a locked label,
    // "Nothing the narrator says overwrites it, that is the entire point", plus a contest record
    // for when the narration kept disagreeing. The mechanism worked; the concept was wrong. Pinning
    // is meant to PROMOTE a thing (more tokens, more fields kept, protection from being aged out),
    // never to stop the model editing it. That concept lives in `state.poi`.
    //
    // It was also silently destructive: measured on the live Raccoon City chat, `location` and
    // `time` were pinned by a stray click on an unlabelled row, and every scene write the narrator
    // made was dropped without a word to anyone.
    const merged = loadContext();
    for (const [label, value] of context) {
        // A refused time must not reach the display or the prompt: re-asserting an earlier time is
        // how the model gets anchored on a clock the story has already passed.
        if (label === 'time' && !clock.accepted) {
            continue;
        }
        // Stamped with the turn it was asserted on. Without this the injected [Scene] composes a
        // moment that never happened, location from one turn, contacts from another, time from a
        // third, each field last-written independently. `{field}_as_of`, in the smallest form that
        // pays for itself.
        insert_with(merged, merge_context, label, { v: value, t: clock.seen, src: source });
    }
    commit(CONTEXT_PATH, merged);
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
        // actually arrives, `saveClock` drops NaN, so "never" survives the round trip as "never".
        block: Number(lookup(table, 'block', NaN)),
        // The turn extraction last ran. Stored for the same reason `seen` is: a counter held in a
        // module variable is reset by every chat switch and cannot survive a reload.
        extract: Number(lookup(table, 'extract', NaN)),
        // The newest MESSAGE a successful pass read, and that message's content key. A turn counter
        // cannot answer "which messages have been looked at", turns and message indices drift apart
        // the moment a swipe or an edit happens, and that question is what the window split needs.
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
 * Set the clock by hand.
 *
 * Why this bypasses the advance guards.
 *
 * Every other clock writer goes through `advanceClock`/`advanceSceneClock`, which refuse a reading
 * that moves backwards (`reason: 'reversed'`) because a narrator contradicting itself is the common
 * case and a stuck clock that says so is the safe failure. A PLAYER correcting the clock is the
 * opposite situation: they are the authority, they are usually fixing a drift the guards let
 * through, and the correction is very often backwards, the live Raccoon City clock had run eight
 * days ahead of its own fiction and only a backwards write could fix it.
 *
 * Writes the CONTEXT fields as well as the clock, deliberately. The panel and the injected block
 * read the scene context, `advanceClock` writes the clock, and the two drifting apart is a defect
 * this codebase has already been bitten by, that campaign showed `Friday, September 26` in the
 * header while the clock held `Wednesday, September 23`. One hand edit, both stores.
 *
 * @param {object} params What to set.
 * @param {string} [params.time] A clock face as written ("13:04", "1:04 PM").
 * @param {string} [params.date] A date as written; stored verbatim, never parsed.
 * @returns {boolean} Whether anything changed.
 */
export function setClockByHand({ time, date } = {}) {
    const clock = loadClock();
    const next = { ...clock };
    const context = new Map();
    let changed = false;

    const said = String(time ?? '').trim();
    if (said) {
        const minutes = parseClock(said);
        if (minutes === null) {
            return false;
        }
        next.minutes = minutes;
        next.raw = formatClock(minutes);
        // The clock is current as of now, so staleness restarts: the player has just confirmed it.
        next.moved = clock.seen ?? 0;
        context.set('time', next.raw);
        changed = true;
    }

    const day = String(date ?? '').trim();
    if (day) {
        next.date = day;
        context.set('date', day);
        changed = true;
    }

    if (!changed) {
        return false;
    }
    saveClock(next);
    // `skipClock` because the clock is already written above; letting `setContext` fold it again
    // would run the same reading through `advanceClock` and could refuse the correction.
    setContext(context, { source: NARRATIVE, skipClock: true });
    observe.note('edit:clock-set');
    return true;
}

/**
 * People the player, or the extractor, has said are worth knowing properly.
 *
 * Why a side table and not a field on the cast row.
 *
 * `merge_entity` treats `''`, `null` and `undefined` as SILENCE, the property that lets a quiet
 * sighting leave everything it did not mention alone. `false` is not in that set, but `false` is
 * also exactly what un-flagging someone has to write, and `entities.patch` copies only string
 * fields. So a boolean on the row would need either a whole-record writer (`entities.setThreat`'s
 * shape) or a new exception in the merge, and both put a UI concern inside the fold.
 *
 * `state.locks` already solved this exact problem for scene fields, down to the reasoning: a Set
 * would be a flag you could never clear, so it is last-write via `merge_b`. This is the same table
 * with a different key space, which is why it is 20 lines rather than a design.
 *
 * What the flag BUYS, which is the part that matters.
 *
 * Not decoration. A flagged person renders a fuller line in `renderEntities` when they are present,
 * so the model is told more about the people the story keeps returning to and no more than before
 * about the rest. The budget stays bounded because the set is small by construction and because
 * `elsewhere` still never reaches the prompt at all.
 *
 * @returns {Map<string, boolean>} entity key -> of interest.
 */
export function loadPoi() {
    // Filtered on the way out, so rows written before `setPoi` learned to delete rather than store
    // `false` heal themselves: every writer commits what this returns, so the first toggle after the
    // upgrade purges them. Same discipline as `shadow()` above, and for the same reason, a
    // migration step to delete two inert booleans is more moving parts than the defect.
    const stored = loadTable(POI_PATH);
    for (const [key, on] of table_entries(stored)) {
        if (!on) {
            stored.delete(key);
        }
    }
    return stored;
}

/**
 * Flag or unflag a person of interest.
 *
 * Un-flagging DELETES the row; it does not store `false`.
 *
 * `state.locks`, which this table is otherwise copied from, writes `false` and keeps the key. That
 * is right there and wrong here, and the difference is the key space: locks are five fixed scene
 * labels, so a cleared lock is one of five rows that were always going to exist. POI keys are
 * ENTITY keys, unbounded, one per person the story has ever named, so storing the off state means
 * a campaign that flags and unflags forty people carries forty rows saying "not this one", forever,
 * in a 128 KB blob.
 *
 * Measured, on this repository, an hour after the table was added: two chats already carried a
 * `false` row apiece from nothing more than a toggle being tested. `poiKeys()` filters on truthiness
 * so it reported an empty set, and the rows were invisible to every reader while still occupying
 * the blob, which is exactly the shape of leak that is never noticed until the budget pruner starts
 * shedding chronicle events to make room for it.
 *
 * The pruner added alongside this table would eventually collect them, but a pruner is for pressure
 * that is unavoidable. This one is avoidable: absence already means "not of interest", so the off
 * state needs no storage at all.
 *
 * @param {string} key An entity key, as `entities.snapshot()` reports it.
 * @param {boolean} [want] Desired state; omitted toggles.
 * @returns {boolean} The new state.
 */
export function setPoi(key, want) {
    const id = String(key ?? '').trim();
    if (!id) {
        return false;
    }
    const table = loadPoi();
    const next = want === undefined ? !lookup(table, id, false) : !!want;
    if (next) {
        insert_with(table, merge_b, id, true);
    } else {
        table.delete(id);
    }
    commit(POI_PATH, table);
    return next;
}

/** @param {string} key An entity key. @returns {boolean} Whether it is flagged. */
export function isPoi(key) {
    return Boolean(lookup(loadPoi(), String(key ?? '').trim(), false));
}

/** @returns {string[]} Flagged entity keys. */
export function poiKeys() {
    return table_entries(loadPoi()).filter(([, on]) => on).map(([key]) => key);
}

/**
 * The thread the player is currently pushing on.
 *
 * One key, not a table.
 *
 * "Active" is singular by definition, Dragon Age's *Make Active* marks one quest, and a second
 * active thread is just a list again. So this is a single value rather than a flag per row, which
 * also means un-setting it is writing `''` and there is no stale-flag class of bug to have.
 *
 * It is an OVERRIDE, not the only signal.
 *
 * `state.coverage.threads` (`coverage.js`) is already a persisted, model-derived record of which
 * threads the last extraction window actually touched, "what the story is currently about",
 * answered by the model rather than guessed by the code. That is the default, and it costs nothing
 * because it is already being written. This key exists so the player can disagree with it, which is
 * the case that matters: pushing on a thread the narration has not reached yet is exactly when you
 * most want it pinned to the top.
 *
 * Empty means "no override" and defers to coverage. It is never written speculatively.
 *
 * @returns {string} The pinned thread key, or '' when the player has not pinned one.
 */
export function activeThread() {
    return String(loadValue(ACTIVE_THREAD_PATH, '') ?? '');
}

/**
 * Pin, or unpin, the active thread.
 * @param {string} key A thread key, or '' to clear the override.
 * @returns {string} The key now pinned, or ''.
 */
export function setActiveThread(key) {
    const id = String(key ?? '').trim();
    // Re-pinning the pinned thread clears it, so the control is its own off-switch and a player
    // never has to hunt for "unpin".
    const next = id && id === activeThread() ? '' : id;
    commitValue(ACTIVE_THREAD_PATH, next);
    return next;
}

/** @returns {Map<string, number>} Rejection reason counts. */
export function loadRejects() {
    return loadTable(REJECTS_PATH);
}

/* Acknowledgement. */

/**
 * Where the reader had got to, recorded as a WATERMARK and never as a reset.
 *
 * The counters are the measurement; nothing here is allowed to touch them.
 *
 * The panel footer shows "97 rejected" on the live Raccoon City chat and "94 rejected" on Wuxia, and
 * it shows it forever, because `state.rejects` is cumulative from the chat's first turn. That is the
 * correct shape for the tally, every deletion argument in `observe.js` rests on lifetime figures,
 * and several docblocks in this extension cite them by name, and it is the wrong shape for a chip
 * whose whole job is to say "something happened that you have not looked at".
 *
 * The obvious fix is to zero the counters on acknowledgement, and it is the one thing that must not
 * happen: it would trade a measurement the project runs on for a UI convenience, and it would do it
 * irreversibly. So acknowledgement writes a COPY of the counts as they stood, and everything
 * downstream subtracts. Nothing is deleted, the Diagnostics tab still shows the lifetime totals, and
 * a mark can be discarded by a pruner without costing anything but a comparison.
 *
 * One list, not a watermark plus a history.
 *
 * The current watermark is simply the newest mark. Storing it a second time under its own key would
 * duplicate ~280 bytes on a chat with 3.3 KB of headroom (`reject-table.js` MAX_ACK_MARKS measures
 * both numbers) and would invent a state that has no meaning: a `state.acked` disagreeing with the
 * last entry of `state.ackMarks` is unreachable by construction here and would be a bug nobody could
 * diagnose if some future write made it reachable. One list also makes the pruner's contract fall
 * out for free, shed from the front, and the watermark survives by being the thing at the back.
 */
const ACKS_PATH = 'state.acks';

/**
 * What losing the acknowledgement history costs, on `store.js`'s cheapest-first scale.
 *
 * Between the diagnostics log (10) and repair state (20), and the placement is the argument.
 *
 * `PRUNE_DIAGNOSTICS` goes first because the log is a debug surface and, measured, the largest one
 * there is: 35 KiB of Wuxia's 117 KiB blob, 29 KiB of Time Stop's 73 KiB. It is also REGENERATING,
 * `LOG_LIMIT` is 120 and the next extraction pass refills it, so shedding sixty entries costs sixty
 * details that the chat is about to produce again.
 *
 * A mark does not regenerate. The counters are cumulative, so there is no way to reconstruct "the
 * tally stood at 94 when I last looked" after the fact from anything on disk, the information
 * exists only because somebody wrote it down at that moment. That is why the marks go AFTER the log
 * despite being a hundredth of its size, and why the newest one is never shed at all: losing the
 * history costs a comparison, losing the watermark costs him seeing 93 again, which is the thing he
 * asked for.
 *
 * Before `PRUNE_REPAIRS` (20) for that band's own reason, read the other way: repair state is a
 * queue of questions and a receipt for edits already made, and the pass that produced it is
 * explicitly re-runnable. Both of those are machinery. Neither is campaign memory, which is why both
 * sit above `PRUNE_ARCHIVE`.
 */
export const PRUNE_ACK_MARKS = 15;

/** Key uniqueness within one millisecond, for a caller that acknowledges twice in a tick. */
let ackSeq = 0;

/**
 * Every acknowledgement mark, oldest first.
 *
 * Ordering is `reject-table.js` `sortAckKeys` rather than a comparator here, for this file's
 * standing reason (see `keepRefusedDebits`): the decision must be testable without a browser, and
 * `<ms>:<seq>` keys do not sort as strings once `seq` reaches ten.
 *
 * @returns {Array<{ts: number, at: number, r: Record<string, number>, c: number}>} The marks.
 */
export function loadAckMarks() {
    const table = loadTable(ACKS_PATH);
    return sortAckKeys([...table.keys()])
        .map(key => table.get(key))
        .filter(mark => mark && typeof mark === 'object');
}

/**
 * The current watermark, the newest mark, or `null` when nothing has been acknowledged.
 * @returns {{ts: number, at: number, r: Record<string, number>, c: number}|null} The mark.
 */
export function ackedMark() {
    const marks = loadAckMarks();
    return marks.length ? marks[marks.length - 1] : null;
}

/**
 * Record that the reader has seen the refusals as they currently stand.
 *
 * The log watermark is the CLICK, not the newest entry.
 *
 * `reject-table.js` `newerThan` explains why extraction failures are counted against a timestamp
 * rather than a stored count: `state.log` rotates, so a count decays. What that timestamp should BE
 * is a second decision. The newest entry's own `t` is the tempting answer and is subtly wrong: on a
 * chat where the log is empty, Raccoon City carries 97 refusals and a log of zero, because the
 * detailed log postdates the chat, there is no newest entry, and any fallback other than "now"
 * either counts every future entry as already seen or none of them.
 *
 * "Now" is right in both cases and needs no fallback, so the mark's own `ts` IS the log watermark
 * and there is no second field. The one thing it cannot see is an entry written in the same
 * millisecond as the click, which is one refusal, once, and is the direction that under-reports
 * rather than the direction that hides something.
 *
 * @returns {{ts: number, at: number, r: Record<string, number>, c: number}} The mark that was written.
 */
export function acknowledge() {
    const table = loadTable(ACKS_PATH);
    const mark = {
        ts: Date.now(),
        at: entities.turn(),
        r: Object.fromEntries(table_entries(loadRejects()).map(([reason, count]) => [reason, Number(count) || 0])),
        c: observe.capTotal(),
    };
    table.set(`${mark.ts}:${ackSeq++}`, mark);
    for (const key of excessMarkKeys([...table.keys()])) {
        table.delete(key);
    }
    commit(ACKS_PATH, table);
    // Counted, so the marks on screen can be read against how many times the reader actually looked.
    // See `observe.js` KNOWN_RULES: a history shorter than this number is a pruned history.
    observe.note('ack:marked');
    return mark;
}

// The history yields; the watermark does not.
//
// What to shed is `reject-table.js` `shedMarkKeys`, oldest half, never the newest, so the decision
// is under test without a browser. This half is the storage: a commit that frees nothing must not
// happen at all, because `commit` re-enters `enforceBudget` and a no-op write inside the budget loop
// is a wasted pass out of the four it is allowed.
registerPruner((overBy) => {
    const table = loadTable(ACKS_PATH);
    const shed = shedMarkKeys([...table.keys()]);
    if (!shed.length) return;
    for (const key of shed) {
        table.delete(key);
    }
    commit(ACKS_PATH, table);
    console.debug(`[sanguine] dropped ${shed.length} acknowledgement mark(s) to fit the metadata budget (over by ${overBy}); the watermark is kept`);
}, PRUNE_ACK_MARKS);

/**
 * What the block-shadow routing could not parse, kept exactly as the card wrote it.
 *
 * A refusal that destroys the evidence is not a refusal, it is a loss.
 *
 * Phase B established the precedent under `state.migrated.dropped`: on Raccoon City extraction never
 * ran, so the `leads` context field was not a duplicate of a structured row, it was the ONLY row,
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
 * elsewhere whose NAME re-appeared in the window, but a person who left the scene and is never
 * named again sat frozen in their last room, `present`, for up to ENTITY_STALE turns. The court
 * dispersed at message 32 of the Royal Succession chat and Ulrich, Gerhard and Rathold stayed in
 * "the throne room" for the rest of it. This is the dispatch law applied to staleness: a place
 * that has contradicted the scene for this long is evidence the code cannot decide about, so it is
 * asked rather than asserted. A fraction of ENTITY_STALE, so the question fires long before the
 * prune would silently forget the person.
 */
export const PLACE_STALE_AFTER = Math.max(1, Math.floor(ENTITY_STALE / 4));

/**
 * Refused block clauses, newest first.
 *
 * Filtered on the way out, so an old reason cannot outlive the code that wrote it.
 *
 * `routeBlockFields` once filed a second reason here, `health-prose`, for a field that routed
 * cleanly but had a residual worth keeping. It no longer does (`absorb-table.js`), but chats
 * carrying entries written by the old code still have them in metadata, and the panel renders every
 * entry under a heading that says "Not parsed". A chat whose card only ever said `Health: Uninjured`
 * therefore reported a parse failure forever.
 *
 * Filtering at the READER rather than in a migration step is what makes this self-healing: the next
 * `noteShadow` rebuilds the table from this function, so the stale rows drop out of storage on the
 * first write after the upgrade, with no migration to run and nothing to get wrong on a v2 blob.
 *
 * @returns {object[]} Refused block clauses, newest first.
 */
export function shadow() {
    const stored = loadTable(SHADOW_PATH);
    return table_entries(stored)
        .map(([, entry]) => entry)
        .filter(entry => entry && entry.reason === SHADOW);
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
 * Where the identity verdicts finally land.
 *
 * `state.answers` has always collected `same`/`different` for items, and until the crosswalk existed
 * an item verdict was recorded and never applied (`review.js`, the `review:item-same-deferred`
 * branch). Built here rather than inside `deriveState` because the crosswalk needs `itemKey` and
 * `MONEY` from `state-table.js`, so importing it there would close a cycle; passing it in matches
 * how `seeds` and `reachKeys` already arrive.
 *
 * Rebuilt on every derive, deliberately. It is a pure function of the answers and the events, so
 * caching it would only create a second thing that can be stale, and a verdict that landed this turn
 * takes effect on the next render rather than the next reload.
 *
 * @returns {{inv: Map, vitals: Map, marks: Map, since: Map, contributors: Map, suppressed: number}} Derived state.
 */
export function derive() {
    // `reachKeys` is the migration's OWN record of the legacy contact rows it moved, exact item
    // keys, never an English place word. `loadValue` returns undefined when no migration has run.
    const reachKeys = loadValue('state.migrated.reachKeys');
    const events = chronicle.liveEvents();
    const held = baseline();
    const state = deriveState(events, {
        seeds: entities.markSeeds(),
        reachKeys: Array.isArray(reachKeys) ? new Set(reachKeys) : null,
        // The baseline's keys ride in as observed: their events are gone, so without this a verdict
        // about a carried-forward row would be dropped and the row would fossilize under its old name.
        crosswalk: buildCrosswalk(events, loadTable(REVIEW_ANSWERS_PATH), held.keys()),
        // What the events that have already been shed contributed. Without this the ledger rewinds
        // as the chat grows, which is the failure that binds a year-long campaign long before any
        // accuracy question does.
        baseline: held,
        // So an `st` delta that named nobody folds onto the same key as one that named the player.
        // See the `who` resolution in `deriveState`'s status fold for the measurement.
        pov: pov(),
    });

    // What time did to it, on top of what was narrated.
    //
    // The ledger records what somebody said happened. Flows are what happens anyway: rent falling
    // due, stores being eaten through, a shop taking money while the scene is somewhere else. It is
    // applied here rather than inside `deriveState` for two reasons, and the second is the real one:
    // `flow-table.js` imports `state-table.js` for the key algebra, so folding the other way would
    // be a cycle, and the seam is honest, because these are different kinds of claim.
    //
    // A READ, never a write. Nothing is appended, so this cannot double-count, cannot survive the
    // flow being deleted, and cannot pin a receipt above the story in the eviction ranking. The
    // house rule it follows is `tickConditions`': "expiry is a READ of the ledger, not a write to
    // it, which is what keeps it correct under swiping".
    const moved = flows.contribute(state.inv, loadClock());
    return { ...state, ...moved };
}

/**
 * What the ledger held before the events it no longer keeps.
 *
 * @returns {Map<string, {qty: number}>} Inventory key -> carried-forward quantity.
 */
export function baseline() {
    return loadTable(BASELINE_PATH);
}

/**
 * Carry the contribution of events about to be evicted into the baseline.
 *
 * Called BEFORE the eviction, because afterwards the deltas are gone.
 *
 * `demoteEvents` archives a summary, keywords and a timestamp; it drops `d`. So the moment an event
 * leaves the hot ledger its delta is unrecoverable, and since state is a fold over live events, the
 * balance it contributed silently unwinds. Nothing counted this, and the failure looks exactly like
 * the model having been wrong about a purchase months ago.
 *
 * The measurement is a difference of two folds of the SHIPPED `deriveState`: what the ledger holds
 * now, against what it would hold with these events gone, so the carried amount is by construction
 * whatever eviction was about to destroy, including any interaction with the zero-floor. Two folds
 * of a few hundred events is cheap and this runs only when the blob is over budget.
 *
 * Marks and vitals are NOT carried. Marks already have a seed path (`seedMarks`, written by
 * migration) and vitals are a clamped last-write whose baseline shape is a different argument; both
 * are real gaps and neither is inventory, which is where the measured damage is. Stated rather than
 * silently skipped.
 *
 * @param {string[]} evictedKeys Event keys about to leave the hot ledger.
 * @param {Map<string, object>} before The ledger as it stands, to read the rows from.
 */
export function carryForward(evictedKeys, before) {
    const doomed = new Set(evictedKeys ?? []);
    if (!doomed.size || !before?.size) {
        return;
    }
    const keep = [];
    const all = [];
    for (const [key, event] of table_entries(before)) {
        all.push(event);
        if (!doomed.has(key)) {
            keep.push(event);
        }
    }
    const held = baseline();
    // The same options on both folds, or the difference measures the options rather than the loss.
    const options = { seeds: entities.markSeeds(), baseline: held };
    // The union of both tables, because capabilities left `inv`.
    //
    // `deriveState(...).inv` no longer contains a capability, so folding only `inv` here would let
    // an evicted grant fall out of the baseline entirely, the events that proved it are gone and
    // nothing carries it forward, so the character silently forgets a skill. Remote (eviction only
    // fires at `MAX_FOLD_BYTES`, and delta-bearing events are shed last) and cheap to close.
    const foldBoth = (events) => {
        const out = deriveState(events, options);
        const merged = new Map(out.inv);
        for (const [key, row] of table_entries(out.abilities ?? new Map())) {
            // Presence, expressed as the count the baseline arithmetic understands. A capability is
            // held or it is not; it never carries a quantity of its own.
            merged.set(key, { qty: 1, ...(row?.rank ? { rank: row.rank } : {}) });
        }
        return merged;
    };
    const now = foldBoth(all);
    const after = foldBoth(keep);

    // The arithmetic on top of the two folds lives in `state-table.js` so it can be gated: it used
    // to skip a negative difference and to iterate `now` alone, and both of those drop DEBITS,
    // a class that was rare while every stream mixed credits and debits, and becomes the normal
    // case the moment a recurring cost exists. A row that existed only in the evicted events, and a
    // row the zero-floor deleted, are both reached now because the keys are the union of the folds.
    const { next, carried } = carriedBaseline(now, after, held);
    if (carried) {
        commit(BASELINE_PATH, next);
        observe.noteCap('baseline-carried', carried);
    }
}

/**
 * The inventory keys the ledger currently holds.
 *
 * Injected into `review.applyExtraction` so a currency name the model volunteered can be resolved to
 * the row it names. The model reports a NAME ("silver wen"); the ledger is keyed by place and name,
 * and which place is not something the model was asked or should be assumed to know, it answered
 * `silver wen`/`silver` on a pass whose prompt carried no Money line at all.
 *
 * @returns {Set<string>} Inventory keys.
 */
export function ledgerKeys() {
    return new Set(derive().inv.keys());
}

/**
 * Run the self-consistency checks over the derived ledger, log what they prove, and hand back the
 * questions they raise.
 *
 * Logged, never surfaced. A negative balance is fold's defect, not something the player did, and a
 * panel warning about it would be an apology interrupting a story, the diagnostics log is where a
 * defect belongs and `/fold-calibrate` is where somebody goes looking.
 *
 * Suspected splits are NOT logged as rejections, because they are not defects: three of the five
 * raised on the live chats are a silver ring and a silver moon locket sharing a token with the
 * balance. They leave as witnesses instead.
 *
 * The overdraw incidents have to ride in from the SAME derivation.
 *
 * `overdrawn` is produced by the fold as it deletes a row, so it exists only on the result object
 * that produced it. Deriving twice, once for `inv`, once for the incidents, would be two folds and
 * an invitation for them to disagree; one `derive()` and both fields off it is the only shape that
 * cannot drift. This is also why `negativeQuantities` stays in the violation list despite being
 * unable to fire here: it is still correct for a pre-derive table, and removing it would hide that
 * the check exists at all.
 *
 * @returns {Array<{a: string, b: string, of: string, why: string}>} Identity questions raised.
 */
export function auditLedger() {
    const state = derive();
    const { violations, witnesses } = checkInvariants({
        inv: state.inv,
        answers: loadTable(REVIEW_ANSWERS_PATH),
        overdrawn: state.overdrawn,
    });
    // Reported ONCE, because a finding is a state and this channel counts events.
    //
    // This function runs on every pass and `state.overdrawn` is re-derived from the whole event
    // history each time, so every finding used to be re-noted forever. Measured on the live Wuxia
    // World RPG: 94 of 118 recorded rejections were one overdraw incident, and they filled 94 of
    // `log.js`'s 120 diagnostic slots. `freshFindings` carries the identities already reported.
    const { fresh, seen } = freshFindings(
        [
            ...violations,
            // An overdraw is a proven defect even though the row it happened to is gone, so it is
            // logged where a defect belongs rather than left to the witness path alone.
            ...(state.overdrawn ?? []),
            // Drift rides the same channel, for the same reason.
            //
            // A stated total that disagrees with the computed one is evidence a transaction went
            // unrecorded, and it was completely invisible: a completed campaign agreed with its own
            // narrator on 21 of 63 stated balances and nothing in the product said so. Same
            // `freshFindings` dedupe as the overdraws, or a re-derive would re-report every drift in
            // the history on every pass, the failure `AUDITED_PATH` was added to stop.
            ...(state.drifted ?? []).map(d => ({ ...d, kind: 'drift' })),
        ],
        loadValue(AUDITED_PATH, []),
    );
    if (fresh.length) {
        // The worst gap on record, so a glance at the counters says whether drift is a rounding
        // matter or a fortune. `note` is a running total; this is a high-water mark, so it is
        // written rather than incremented.
        const worst = (state.drifted ?? []).reduce((most, d) => Math.max(most, Math.abs(d.gap)), 0);
        if (worst) {
            observe.noteMax('money:drift-worst', worst);
        }
        // Routed by kind rather than by a three-deep ternary: each finding shape names its own
        // row, and a new kind is a new entry rather than another nested branch.
        const asRejection = {
            drift: v => ({
                item: splitItemKey(v.key).name,
                reason: 'money:drift',
                detail: `fold held ${v.held}, the story said ${v.said} (gap ${v.gap > 0 ? '+' : ''}${v.gap})`,
                raw: v,
                mid: Number.isFinite(v.mid) ? v.mid : undefined,
            }),
            overdraw: v => ({
                item: splitItemKey(v.key).name,
                reason: 'invariant:overdraw',
                detail: `held ${v.had}, debited ${v.dq}, short ${v.short}`,
                // The incident IS the evidence, there is no model proposal behind a state check,
                // so the raw is what the fold recorded rather than what anyone sent.
                raw: v,
                mid: Number.isFinite(v.mid) ? v.mid : undefined,
            }),
        };
        noteRejections(fresh.map(v => (asRejection[v.kind] ?? (row => ({
            item: row.kind === 'partition-contradiction' ? `${row.a} ~ ${row.b}` : row.name,
            reason: `invariant:${row.kind}`,
            detail: row.kind === 'negative-quantity' ? `${row.place} holds ${row.qty}` : '',
            raw: row,
        })))(v)));
        commitValue(AUDITED_PATH, [...seen]);
    }
    return witnesses;
}

/** @returns {string} The point-of-view character's name, or ''. */
export function pov() {
    return lookup(loadContext(), 'pov', { v: '' }).v;
}

/**
 * The schema fragment describing what a delta may say.
 *
 * Every object carries `additionalProperties: false` and lists every property in `required`,
 * because OpenAI's strict structured output demands it on EVERY object in the schema, a fragment
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
                // "Only entries that move something", and the count that made it worth saying.
                //
                // MEASURED over 2256 traced passes: 102 of 1607 proposed inventory rows (6.3%) said
                // nothing at all, no `dq`, no `set`, no `rank`, and `validateInventory` refused
                // every one as `no-change`. They split three ways: 69 bare mentions of a held thing
                // ("coins, at money, dq 0", 24 of them at `money`), 24 that set `same_as` to the
                // entry's OWN name, and 9 that asserted a rename with no quantity.
                //
                // The gate is right and stays; a no-op that landed would be worse than one refused.
                // What was missing is that nothing in the schema ever said an entry needs a reason
                // to exist. `dq` read "positive gained, negative lost" and never said what 0 meant,
                // and strict mode requires the field, so 0 was the free way to fill it. The three
                // legal reasons are named here and again on `dq`, because "may I send this row?" is
                // read off the array and off the field, not out of the prose block.
                description: 'Things gained or lost: money and objects, plus property owned (a house, a ship, a mount) and capabilities gained (a spell, a skill, a granted power). A capability gained is quantity +1. Every entry must MOVE something: a non-zero "dq", or a "set" total the story stated outright, or a new "rank". An entry that changes none of those says nothing, naming a thing the record already holds is not a change, so leave it out entirely rather than sending it with dq 0.',
                items: {
                    type: 'object',
                    properties: {
                        // "singular" is where `ammunition` came from.
                        //
                        // This was the only identity field in the schema with no "as the story wrote
                        // it" clause, and it asked for the opposite. `standing.name` says "exactly as
                        // the story names it… never translate it"; `rank` says "copied exactly as
                        // written"; this said `singular`. Given "three magazines, twenty-five rounds
                        // of buckshot plus a box of birdshot", singular has exactly one answer, and
                        // the trace file shows the model giving it: `{"item":"ammunition","dq":28}`
                        // at turn 23, 3 + 25, three non-interchangeable things summed into a mass
                        // noun, which is precisely what the player later had to unpick by hand.
                        item: {
                            type: 'string',
                            description: 'Item name, lowercase, in the story\'s own words, the specific thing the excerpt named, never a category you summarised several things into. "9mm magazines", "buckshot shells" and "9mm rounds" are three items, not one "ammunition": write one entry per distinct thing named. When you mean an item the State block already lists, use its EXACT name from the State block.',
                        },
                        same_as: {
                            type: 'string',
                            // 24 of the 102 no-op rows set this to the entry's own "item" string,
                            // "the spear is the same as the spear", which is the sentence below
                            // being read as a request to confirm identity rather than to correct a
                            // spelling. Said in the negative as well, because the positive form was
                            // already there and was not enough.
                            description: 'The exact name of an item the State block already lists, when THIS entry is a different spelling of that same thing. Empty when this is a new item or already uses the exact name, never repeat the "item" name here. Never guess a name fold holds under a different spelling without saying so here. This field only re-labels a change; it is not a change by itself, so an entry carrying nothing but a same_as should not be sent.',
                        },
                        dq: { type: 'integer', description: 'Change in quantity: positive gained, negative lost. 0 means nothing moved, an entry with dq 0 belongs in this list only when it carries a stated "set" total or a new "rank", and otherwise must be left out.' },
                        set: {
                            type: 'integer',
                            description: 'The absolute total now held, instead of a change, "the treasury holds 12,400 marks" is set 12400, never dq. Use set only when the story states a current balance or count outright.',
                        },
                        magnitude: {
                            type: 'integer',
                            description: 'The quantity the narrative actually states, when it states one, "a hundred silver" is 100, "forty wolves" is 40. 0 when no explicit count is given. This is what corroborates a large change; fold never guesses a magnitude from prose.',
                        },
                        at: {
                            type: 'string',
                            description: 'Where it is: "carried" (on the character, incl. worn or drawn), a place name ("apartment", "car boot"), "assets" (owned property not carried), "abilities" (a capability), or "money" (the currency name, set or dq = amount). Contact details, a phone number, address, email, are never items.',
                        },
                        how: {
                            type: 'string',
                            enum: ACQUISITIONS,
                            // The field that replaced a guess, and the third time this has worked.
                            //
                            // `moves: []` became a numbered form and `drive_size` became a judged
                            // nomination for the same reason this exists: fold was inferring
                            // something only a reading of the scene can settle. Here the inference
                            // was "an item arrived with no money beside it, so it is an unpaid
                            // purchase", and across 2316 traced passes it fired on 531 items and was
                            // right about roughly one in twenty. The full measurement, including the
                            // model's own 102 "nothing was paid" answers, is on `state-table.js`
                            // `BOUGHT`.
                            //
                            // The enum carries no '' and no `other`, which is the anti-free-skip
                            // rule this project learned twice. `st.severity` is the proof it holds:
                            // required, three members, no empty, 305/305 answered and distributed.
                            // `entities.feels` carries '' and came back empty 562 times in 3150.
                            //
                            // `lost` is not a hatch, 449 of 1638 traced rows lose something and 116
                            // move nothing, so nearly half of all rows genuinely gain nothing and
                            // need a true answer rather than a blank. `acquisitionOf` refuses to
                            // believe `lost` on a positive `dq` anyway.
                            description: 'How this entry moved. "bought" ONLY when it was paid for, a purchase, a commission, a bribe. "given" when someone handed it over: a gift, a reward, wages, a token issued at a desk, a technique taught. "found" when it was picked up unowned or discovered. "taken" when it came off a body, a rack, or an owner: looted, stolen, seized, drawn. "made" when it came out of work: crafted, harvested, butchered, cooked, trained up. "lost" for any entry that does NOT gain, spent, used up, dropped, destroyed, handed away, or a stated total. Most gains in play are found, taken or given; never guess "bought".',
                        },
                        who: {
                            type: 'string',
                            // Whose, which `at` was being made to carry and cannot.
                            //
                            // The model already tried: `{"item":"pale stone sphere","dq":-1,
                            // "at":"Sylanna's satchel"}`, refused as `remove-unknown` because a
                            // satchel is not a place fold holds anything at. A companion's gear had
                            // no channel at all, so New Eldoria's ironwood branch was chronicled and
                            // never recorded, and 17 gold handed to Vexia was credited to the
                            // player. One field, answered in whatever language the excerpt uses.
                            description: 'Whose it is, when it is NOT the point-of-view character\'s, the person\'s name exactly as the record or the excerpt gives it. Empty for the point-of-view character, which is the normal case. Use this when a companion picks something up, is given something, or is handed money: what someone else now holds is theirs, not the viewpoint character\'s.',
                        },
                        rank: {
                            type: 'string',
                            // The grade, in the story's own system, which fold never interprets.
                            //
                            // Deliberately one free-text field and not an enum, a number, or a
                            // ladder. Settings grade things however they like: F/E/D/C/B/A/S,
                            // "Unskilled/Amateur/Proficient", 1, 10, 0, 100000, "Novice (3/5)", or not
                            // at all. An enum would fit exactly one of those and silently mangle the
                            // rest, and any ordering fold imposed would be fold deciding that D beats
                            // E or that Proficient beats Amateur, language understanding, which is
                            // the model's job and not fold's.
                            //
                            // fold stores this string, shows it, and replaces it when a new one
                            // arrives. It never compares two ranks, so it never needs the order.
                            //
                            // Splitting the grade out of the NAME is the point: a skill that goes
                            // F→E→D is one row whose rank changes, not three rows. That is exactly
                            // the defect this closes, a live campaign showed "Quarterstaff
                            // proficiency (e)" and "Quarterstaff proficiency" as two abilities.
                            description: 'The rank, grade or level the story gives this, copied exactly as written, "E", "D", "Amateur", "47/100", "Novice (3/5)", "Lv. 12". Leave empty when the story grades it with nothing. The "item" name must NOT contain the rank: a skill written "Quarterstaff Proficiency (E)" is item "quarterstaff proficiency" with rank "E", so that the same skill at a new grade stays one entry instead of becoming a second one.',
                        },
                    },
                    required: ['item', 'same_as', 'dq', 'set', 'magnitude', 'at', 'how', 'rank', 'who'],
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
                        // The mirror of `dq`'s clause. This half is not a measured problem, across
                        // 2256 traced passes, 70 vital rows, exactly 0 carried neither a dcur nor a
                        // max, so `validateVitals`' `no-change` has never fired, but the two
                        // arrays are read side by side and a rule stated on one and not the other
                        // is exactly how `advances`/`nominations` drifted apart in `world-table.js`.
                        dcur: { type: 'number', description: 'Change from the current value this turn, never the new total: "HP 62 to 44" is dcur -18. 0 means the level did not move, send a row with dcur 0 only when it establishes a new "max", never to restate a gauge that is unchanged.' },
                        max: { type: 'number', description: 'Ceiling, when the story states one. 0 when it does not, this field is required, so 0 is how you say nothing was stated, and fold keeps whatever ceiling it already had. Send a real number only when the story newly establishes or changes it.' },
                    },
                    required: ['name', 'dcur', 'max'],
                    additionalProperties: false,
                },
            },
            standing: {
                type: 'array',
                // Every named track a setting keeps, without fold knowing any of their names.
                //
                // fold used to classify a status block by matching its LABELS against English word
                // lists (`INVENTORY_LABELS`, `HEALTH_LABELS`, `LEAD_LABELS`, `PRESSURE_LABELS`), and
                // `domainOf` returned '' for anything absent from all of them. So a live card
                // emitting `Level: 1 (0/100 EXP)`, `BP: 10`, `Reputation: 0 "Nobody"`,
                // `Class: NULL SAGE`, `Threat: Low` and `Bonds: Yamada:5 (trusting)` had every one
                // of those fields silently discarded, and no list could ever have caught them,
                // because the next card names them differently and the one after that names them in
                // another language.
                //
                // This is the repair, and it is the `rank` trick one level up: the MODEL says what
                // is being tracked and what it currently reads, and fold stores an opaque pair. No
                // ordering, no units, no vocabulary. A setting can grade reputation as a number, a
                // word, a colour or a rune and fold carries it identically.
                //
                // `who` is what makes relationships fall out for free rather than needing their own
                // structure: a bond is simply a standing whose subject is someone else.
                description: 'Named tracks the story keeps score with, and their current reading, the things a status line lists that are neither items nor injuries. Level, experience, class, rank, reputation, standing, threat level, alignment, favour, notoriety, a relationship score with a named person. Report one entry whenever the story states or changes such a track. Do not report inventory, money or injuries here; they have their own fields.',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'What is tracked, lowercase, exactly as the story names it: "level", "reputation", "class", "threat", "bp", "notoriety", "standing with the guild". Use the story\'s own word, in the story\'s own language; never translate it.',
                        },
                        value: {
                            type: 'string',
                            description: 'What it reads NOW, copied exactly as written and complete: "1 (0/100 EXP)", "NULL SAGE", "Low", "0 \\"Nobody\\"", "5 (trusting)", "Exalted". Always the current full reading, never a change or a difference, this replaces whatever was recorded before.',
                        },
                        who: {
                            type: 'string',
                            description: 'Whose track it is, the person\'s name exactly as in the people list. Empty for the point-of-view character. A relationship score the story keeps about another person is that person\'s standing: "Yamada: 5 (trusting)" is name "bond", value "5 (trusting)", who "Yamada".',
                        },
                    },
                    required: ['name', 'value', 'who'],
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
                            description: 'Whose condition, the person\'s name, exactly as in the people list. Empty only for the point-of-view character.',
                        },
                        flag: {
                            type: 'string',
                            description: 'The affliction as a short lowercase phrase: "bruised left arm". Record the affliction, never the reassurance, "otherwise unhurt" is not a condition.',
                        },
                        subject: {
                            type: 'string',
                            description: 'What the condition is ABOUT, as a short lowercase phrase: "hangover", "left arm", "ribs". This is what groups "mild hangover" and "hangover mostly eased" as one condition. Empty only when the phrase has no content word.',
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
                    required: ['who', 'flag', 'subject', 'on', 'severity', 'turns'],
                    additionalProperties: false,
                },
            },
            // What a thing is MADE OF, which had nowhere to go.
            //
            // A calibre, an enchantment, a serial number, a refinement grade. None of these is a new
            // item and none is a place, and until now the only field that could hold one was `rank`
            //, a single string per row, replaced wholesale. That is why `9mm rounds` and
            // `.45 rounds` could not both be "ammunition with a calibre": the calibre had to become
            // the name or be lost.
            //
            // Deliberately addressed by `item`+`at`+`who` rather than by a key: the model has never
            // been shown a key and should not be asked to build one. `state-table.js itemKey` turns
            // the three back into the row, which is the same trip every other delta makes.
            parts: {
                type: 'array',
                description: 'What a thing the record already lists is MADE OF, an enchantment, a calibre, a serial number, a refinement grade, a curse, a mounted scope. Not a new item and not a place: report one entry each time the story states or changes such a property of something already held.',
                items: {
                    type: 'object',
                    properties: {
                        item: { type: 'string', description: 'The item this is about, EXACTLY as the State block names it.' },
                        at: { type: 'string', description: 'Where that item is, exactly as the State block groups it: "carried", "assets", "money", or the place name.' },
                        who: { type: 'string', description: 'Whose it is; empty for the point-of-view character.' },
                        name: { type: 'string', description: 'What the property is, lowercase, in the story\'s own words: "flame rune", "calibre", "serial", "refinement".' },
                        value: { type: 'string', description: 'What it reads NOW, copied exactly as written. This replaces whatever was recorded before.' },
                    },
                    required: ['item', 'at', 'who', 'name', 'value'],
                    additionalProperties: false,
                },
            },
        },
        required: ['inv', 'vit', 'st', 'parts'],
        additionalProperties: false,
    };
}

/**
 * Prompt guidance for the delta field.
 * @returns {string} Instruction text.
 */
export function deltaInstruction() {
    return [
        'For each event, record what it CHANGED, changes, not totals. dq is how many were gained or lost, not held afterwards.',
        'Record only what the excerpt NAMES and actually changes; nothing merely mentioned, held over, or unchanged.',
        // The placement clause: putting something down IS a change.
        //
        // The story rarely announces "I am no longer carrying X". It SHOWS the placement, "leave
        // the food in the back seat", "set the bag on the floor", "tuck the rifle into the trunk",
        // and that showing is the retraction. The measured failure is real: a campaign left "canned
        // goods", "bottled water", "trail mix" and ten more as carried while the transcript said at
        // mid 228-229 "leave most of the food and other supplies in the car". No event ever
        // recorded it, so the record kept a man carrying a carload. A placement, a drop, a hand-off
        // or a stow is a move: a loss at "carried" and a gain at the place it went. Report it.
        'Putting something down IS a change. When the story shows the character setting something aside, leaving it in a vehicle or at a place, stowing it, or handing it to someone, record the move, a loss at "carried" and a gain at the place it went. A placement is how a retraction is said; record it like any other change.',
        'Record only what changed in the NEW part of the excerpt, anything shown as already recorded has been counted; do not gain it again.',
        // The clause the 102 refused no-ops needed, in the prose block as well as the schema.
        //
        // "nothing merely mentioned, held over, or unchanged" above is the same rule and it was not
        // enough on its own: 6.3% of traced inventory rows still arrived carrying no dq, no set and
        // no rank. What that clause does not say is what to DO with the required fields when the
        // answer is "nothing", and the answer is not "send zeros", it is "send no row". Stated as
        // an action, next to the shapes that were actually sent.
        'An entry with dq 0, no stated total and no new rank changes nothing, and an entry whose only content is "same_as" changes nothing either: omit both. Do not list a currency or an item to say it is still held, and never set "same_as" to the entry\'s own name. An empty list is the right answer when nothing moved.',
        // Money first, because it is the state that pays for everything else.
        //
        // The old list mentioned money in the middle of "things gained or lost" and in the whole of
        // a financial-intrigue chat it produced ZERO money deltas across 46 events, a treasury, a
        // discretionary fund "off the books", tolls cut, a twelve-barge purchase, all recorded as
        // narrative and none as state. The model read "gold" and heard "inventory item", which it
        // reported and fold silently ignored (a money line with no delta is not even a rejection).
        // So money leads the list, and the treasury cases that are NOT a pocketed balance are named
        // outright: a fund granted, a debt incurred, a revenue change, those are money moving too.
        'Money is "at": "money", name the currency (won, credits, gold, silver), amount in dq, exact as the story says. Grants, purchases, taxes, tolls, debts and funds are money changing hands: a discretionary fund granted is a money gain for the recipient and a loss for the giver, not an inventory item.',
        'A balance the story states outright, "the treasury holds 12,400 marks", is "set" to that total, never a dq change. Use set only for a stated current balance; use dq for movement.',
        'dcur is the change from the current value, never the new total; max only when newly established.',
        'Contact details (phone number, address, email) are NOT items, never record them as gained.',
        'Set "at": "carried" when on the character, otherwise the place; moving between places is a loss in one and a gain in the other.',
        // Said here as well as in the schema, because the 102 no-ops proved once is not enough.
        //
        // The `dq 0` rule was in the schema and 6.3% of rows still ignored it until it was also
        // stated as an action in this block. This field carries more risk than that one did: a
        // wrong `bought` is what billed twenty taels for a gift and nine hundred spirit stones for a
        // balance the model had just restated, deleting the campaign's whole purse
        // (`state-table.js` `creditsWithoutDebit`). So the narrow member is the one this line spends
        // its tokens on, and the common answers are named so that none of them is the hard choice.
        '"how" says where each entry came from, "found", "taken", "given" and "made" cover almost everything that arrives, and "lost" is the answer for anything the entry does not gain. Say "bought" only when the excerpt shows it being paid for, and record the payment as a money entry in the same event.',
        'Identity is yours, not fold\'s: when you mean an item the State block already lists, reuse its EXACT name from the State block. If you write a different spelling of a held item, set "same_as" to the exact held name. fold merges only on your word; it never guesses from spelling.',
        // The other half of killing `ammunition`. Naming things specifically going forward does not
        // repair the generic row already on the record, and the model cannot fix it silently,
        // because the arithmetic has to stay a sum. Said as a transfer, a split is two halves of one
        // event, so a swipe takes the whole correction or none of it.
        'A property OF something you already hold is "parts", never a new item: an enchantment, a calibre, a serial number, a grade of refinement. "the sword now burns" is {"item":"longsword","name":"flame rune","value":"sets a struck target alight"}, not a gained item.',
        'When a row you already hold turns out to be several things, say so as a transfer: one entry losing the general name and one entry per specific thing. "the ammunition is three magazines and twenty-five buckshot shells" is {"item":"ammunition","dq":-28}, {"item":"9mm magazines","dq":3}, {"item":"buckshot shells","dq":25}.',
        '"at": "assets" for owned property (house, ship, mount); "at": "abilities" for a capability gained or lost (spell, skill, power). These are the most commonly missed.',
        'Every condition belongs to somebody: "who" is the person\'s name, exactly as in the people list; empty only for the point-of-view character.',
        'Record the affliction, never the reassurance, "otherwise unhurt" is not a condition.',
        '"subject" is what the condition is ABOUT, not its severity or its wording: "mild hangover" and "hangover mostly eased" are both subject "hangover", "bruised left arm" is subject "left arm". This is what groups two phrasings of one condition into one.',
        'Use empty arrays when an event changed nothing.',
        // The coverage proof: tried, measured, and NOT added.
        //
        // `mentions` gates every delta this event proposes (`chronicle.js applyExtraction` folds the
        // batch's `mentions` into the set `validateDelta` admits by), and this probe alone had the
        // field in its SCHEMA with no word about it in its instruction, unlike threads and
        // entities, which both say "this is the coverage proof" and both report well. The obvious
        // fix was to add the same clause here, so that `isMentioned`: a substring test on the
        // narrative, which RULE 1 forbids and names by that function's own name, could be deleted.
        //
        // It does not work. Replayed over Wuxia, 277 messages, ~136 passes per arm:
        //
        //   no instruction              report admits 93.4%   2.5 mention phrases per event
        //   "exactly as written"                      89.5%   3.3
        //   "both names when they differ"             87.0%   3.2
        //
        // n≈60 per arm, so the differences are noise, but the direction is wrong and the mechanism
        // is visible: asking for more phrases got more phrases and NOT better coverage, because the
        // extra ones are excerpt-wording ("the key", "the jade", "thirty silver") while the gate
        // needs the delta's key ("bronze key", "jade trinket", "silver wen").
        //
        // The residual is not a coverage-reporting problem at all. Nearly every remaining miss is
        // ONE thing: the currency. "silver wen" against "thirty silver", "a full silver piece",
        // "forty silver". That is item identity, the same split that makes `remove-unknown` eat
        // spends, the Wuxia ledger holds `money silver` and `carried silver wen` as two rows of
        // one currency. Fix identity and this closes; add prompt tokens and it does not.
        //
        // Recorded here rather than left as a silent absence, so the next reader does not re-run it.
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
 * @param {Set<string>|null} [context.mentioned] Names the model reports the excerpt uses,
 *   coverage by report, not a substring proxy ([ROUTER]).
 * @param {Set<number>|null} [context.visible] The mids this pass displayed (`splitWindow`'s
 *   `seen`). Threaded for `shown`'s exact reason: only the caller that built the prompt knows what
 *   the model was shown, and the already-recorded gate may not refuse on anything else.
 * @returns {{delta: object|null, rejected: object[]}} The accepted delta, or null if empty.
 */
export function validateDelta(raw, { windowText = '', state = null, shown = null, mentioned = null, visible = null } = {}) {
    const current = state ?? derive();
    // The cast table is the only thing that can say whether an owner exists.
    //
    // Threaded in rather than looked up inside `state-table.js`, for that file's standing reason: it
    // is pure, and a validator that reaches into storage cannot be replayed. `entities.load()` is a
    // read of the same table the probe writes, so a person established earlier in THIS pass is
    // already in it by the time a delta names them. Read once and shared by the two validators that
    // resolve an owner, marks have always needed it, items need it now that they carry `who`.
    const cast = entities.load();
    const viewpoint = pov();

    const inventory = validateInventory({
        inv: current.inv,
        deltas: raw?.inv,
        windowText,
        budget: MAX_CHANGES_PER_TURN,
        shown,
        mentioned,
        // The contributor trail, so the already-recorded gate can refuse a re-record the pinned
        // ledger did not carry (the knife, the phone numbers), see the gate's docblock.
        contributors: current.contributors,
        // …and the window that bounds it. Without this the trail is unbounded history and refuses
        // every repeat purchase forever; the docblock carries the corpus measurement.
        visible,
        cast,
        pov: viewpoint,
        // Capabilities left the item table and became their own fold, so the gates have to be shown
        // both or they judge a capability against a pack that no longer contains it: revoking one
        // would refuse as `remove-unknown` and re-grading one as `no-change`.
        abilities: current.abilities,
        // The story's own casing, so `same_as: "Ka-Bar"` can be matched against what the pinned
        // block actually PRINTED rather than only against the lowercased key. Measured across every
        // trace on disk: 25 of 215 `same_as` claims were unmatchable purely because the model was
        // quoting the rendered line back.
        faces: current.faces,
    });
    const vitals = validateVitals({ vitals: current.vitals, deltas: raw?.vit, windowText, mentioned });
    const status = validateStatus({
        status: current.marks,
        deltas: raw?.st,
        windowText,
        cast,
        pov: viewpoint,
        mentioned,
    });

    if (status.capped) {
        // Three consequence slots per person, and this is the count of the fourth wounds that had to
        // displace or escalate one (`state-table.js` `placeMark`). Never a rejection: the narrative
        // did not propose a wound, it inflicted one.
        observe.noteCap('marks-full', status.capped);
    }

    // Components are validated here and applied outside the fold.
    //
    // `state.parts` is a side table, not part of `deriveState`'s arithmetic, so a component carries
    // no quantity and cannot be folded. What it still needs from this function is the same identity
    // discipline every other delta gets: the row must EXIST before something can be a property of
    // it, and the place it names must still stand.
    const componentRows = [];
    const componentRejects = [];
    for (const entry of Array.isArray(raw?.parts) ? raw.parts : []) {
        const name = String(entry?.name ?? '').trim();
        const value = String(entry?.value ?? '').trim();
        if (!name || !value) {
            componentRejects.push({ reason: 'unusable-name', item: name || String(entry?.item ?? ''), raw: name });
            continue;
        }
        const key = itemKey(String(entry?.item ?? ''), String(entry?.at ?? ''), String(entry?.who ?? ''));
        if (!current.inv.has(key)) {
            // The same rule as `remove-unknown`: you cannot describe a property of something the
            // ledger does not hold. Reported rather than silently dropped, so a model naming a row
            // that is spelled differently finds out.
            componentRejects.push({ reason: 'remove-unknown', item: String(entry?.item ?? ''), raw: name });
            continue;
        }
        componentRows.push({ key, name, value });
    }

    const rejected = [...inventory.rejected, ...vitals.rejected, ...status.rejected, ...componentRejects];
    const delta = {};
    if (inventory.accepted.length) delta.inv = inventory.accepted;
    if (vitals.accepted.length) delta.vit = vitals.accepted;
    if (status.accepted.length) delta.st = status.accepted;
    if (componentRows.length) delta.parts = componentRows;

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
    // The one refusal class the model can act on, routed back to it. See REFUSED_PATH.
    keepRefusedDebits(rejections);
    // Also into the one table that answers "did this bound ever bind" for every constant, not just
    // the ones that reject. See observe.js. The diagnostics log gets the same refusals with the
    // turn they happened on; `mid` was attached by `chronicle.applyExtraction` for the cause-jump,
    // and the state probe's own `recordMarks` refusals carry neither.
    observe.noteRejections(rejections.map(rejection => ({ ...rejection, turn: entities.turn() })));
}

/**
 * Remember the debits refused for naming a row fold does not hold, so the block can report them.
 *
 * The storage half only. What qualifies (`refusedDebits`), what survives the cap (`keepRefused`) and
 * the wording of the note (`renderRefused`) are all in `state-table.js`, for that file's standing
 * reason: they are decisions a test must be able to make without a browser.
 *
 * @param {object[]} rejections Rejections as the validators produced them.
 */
function keepRefusedDebits(rejections) {
    const rows = refusedDebits(rejections, entities.turn());
    if (!rows.length) {
        return;
    }
    commit(REFUSED_PATH, keepRefused(loadTable(REFUSED_PATH), rows));
}

/**
 * The pinned ledger: everything fold currently believes, in one screenful.
 *
 * One rendering of the world, and why it starts with one consumer.
 *
 * The design's centre is that the panel, the narrator, the extractor and the judge all read the
 * same block, so they can never disagree about what fold believes (`FOLD-REDESIGN.md` §5). This is
 * that renderer. In this phase it has exactly one consumer, the extraction prompt, and the
 * narrator keeps `render()` below untouched, deliberately: rewiring the narrator's injection
 * changes how every live chat gets written, and it should land with the phases that also change
 * what there is to render (threads, marks, closures). Shipping the renderer now and the rewiring
 * later is the order that keeps each change measurable on its own.
 *
 * What it contains is the design's budget list and nothing else: money, what is carried and where,
 * vitals, conditions, the people actually here with what they want and know, open leads, live
 * pressure. Everything excluded is excluded for a reason the schema already had, people who are
 * Elsewhere are dropped by `renderEntities`, hidden clocks are named without their numbers by
 * `renderPressure`. Stale carried items used to be excluded too; Phase C deleted that hiding
 * (`state-table.js`, the `isFresh` retirement note), which is why a knife the conversation moved on
 * from is in this block again.
 *
 * And it is now a QUESTION, which is the whole of Phase C.
 *
 * The block ends with the review section: every open line carries a stable id, and the review probe
 * answers per id whether it is still open (`review-table.js` `reviewBlock`). That turns the pinned
 * ledger from something the model reads into something it is accountable to, the retraction
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
export function ledgerBlock({ windowText = '', ask = true } = {}) {
    // Capabilities and the story's own casing, for the same reason `render` needs them: the pinned
    // block is what `reject:already-recorded` is judged against, so anything it fails to print is
    // something the model can be refused for re-reporting.
    const { inv, vitals, marks, standings, abilities, faces, contributors } = derive();
    const who = pov();
    // What the gate knows and the block never said.
    //
    // `reject:already-recorded` refuses a proposal against a row the model was shown WHOSE BEAT IS
    // STILL ON SCREEN (`state-table.js validateInventory`, the `reTold` condition). Replaying the
    // live Wuxia campaign's 149 traced passes, all 21 recoverable refusals were against a row the
    // block had printed in full, so the block was never failing to show the ITEM. It was failing to
    // show that the item's acquisition is the beat the model is currently reading, which is the one
    // fact that makes "report only CHANGES to this" answerable rather than a coin toss against the
    // transcript. `recentlyRecorded` computes it from fold's own arithmetic; see there for the
    // measurement and for the two shapes it covers (a re-tell, and a purchase billed at the offer
    // and re-proposed at the handover).
    //
    // `extractMark()` is read rather than passed because `extract.js` calls this with `windowText`
    // and nothing else, and the mark is the same value `buildWindow` split this pass's window on,
    // `noteExtractedWindow` does not advance it until the pass succeeds, which is after this runs.
    //
    // `ask` gates it for `ask: false`'s stated reason: the adjudicator is being asked whether one
    // attempt succeeds, and "fold already billed this" is not a fact about that question.
    const counted = ask ? recentlyRecorded(contributors, extractMark().mid) : null;
    const { lines, shown, counted: marked } = renderLedger({ inv, vitals, marks, standings, abilities, faces, pov: who, counted });
    if (marked) {
        // How much of the block is carrying the marker. A count that runs at the width of the whole
        // Carrying line means the horizon is too wide to mean anything; a persistent zero on a chat
        // that is still recording means the mark or the trail is not reaching here.
        observe.note('block:counted', marked);
    }

    const fields = loadContext();
    const at = lookup(fields, 'location', { v: '' }).v;
    // Same exclusion as the narrator's block: the protagonist is not a member of the cast he is the
    // centre of, and listing him invites the model to write him as someone in the room. His marks
    // are on the `Condition:` line above; everyone else's ride beside their own name, which is the
    // whole of Phase D as the model sees it.
    // `inv` as well as `marks`: an item can belong to somebody now, and what a companion is
    // carrying belongs on their line rather than nowhere. `renderLedger` above has already left
    // those rows out of the player's, so nothing is said twice.
    // `poi` raises the resolution of the people the story keeps returning to, and only for those
    // present, `elsewhere` still never reaches the prompt at all. Threaded the same way `marks`
    // and `inv` already are, so `entity-table.js` never has to reach back into this module.
    const cast = entities.render({ exclude: who, at, marks, inv, poi: new Set(poiKeys()) });
    const turn = entities.turn();

    // The review section REPLACES the thread lines; it does not sit under them.
    //
    // `render()` below still injects `Pressure:`/`Progress:`/`Threads:` for the narrator, because
    // that is the shape the fiction has been written against. The extraction prompt must not have
    // both: every open thread would appear twice, once as prose and once with an id, and the model
    // would be looking at the same stake in two representations, which is the defect §5 spends its
    // longest paragraph on. Measured on the pre-repair2 Solo Leveling header before this line
    // changed: 30 lines and 6,173 characters, of which the whole `Threads:` line was a restatement
    // of T1, T15 below it. §12's second open question is exactly this block's size discipline.
    // Item identity questions come from the conservation audit rather than a detector, because
    // inventory has no table for a detector to walk. `auditLedger` also logs what it can prove.
    // `ask: false` is for a reader that is never going to answer.
    //
    // Two callers build this block. The extraction pass answers the numbered lines; the ADJUDICATOR
    // (`verdict.js`) does not, it is asked whether one attempt succeeds, and was nonetheless
    // shipped the whole `T3 [3/6] …` form, on the one call the player is blocked on. `auditLedger()`
    // is worse than wasted there: it WRITES, pushing findings into a 120-slot diagnostics log to
    // build questions nobody will be posed.
    //
    // Everything else in the block, the ledger lines, the cast, the world line, `shown`, is
    // byte-identical either way, which is what makes this a subtraction rather than a second block.
    const questions = ask ? review.pending({ itemQuestions: auditLedger() }) : { identity: [], polarity: [], owed: [] };
    // Presence, the cast-starvation fix.
    //
    // The cast freezes because the pinned header says "report only CHANGES" while the entities
    // probe says "Re-report anything still true", a model obeys the header, so a tracked
    // person's `place` stops updating the moment the story moves them. The review's `[where
    // now?]` was only ever asked of UNPLACED people; everyone with a stale-but-non-empty place
    // was never questioned, which is exactly the live-chat failure this reconciles
    // (FOLD-REDESIGN.md §0.1-1). A person whose stored place is ELSEWHERE but whose name appears
    // in the recent window may have moved HERE, that is the model's reading-comprehension
    // question, so it is asked, the same way the unplaced are. It stays a code gate: no window
    // means no misplaced questions (the narrator's own block never sees them).
    // `pov: who`, not `pov`. The shorthand `{ at, pov }` passed the IMPORTED FUNCTION rather than
    // the name it returns, `who` is `pov()`, computed at the top of this function, so
    // `entities.snapshot` compared every cast key against a function object, matched nobody, and
    // returned the protagonist as a member of the cast he is observing. The review was then asked
    // where Solomon was, in a list of people standing near Solomon. `panel.js` passes it correctly,
    // which is why this never showed on screen and only ever cost prompt lines.
    const castRows = ask ? entities.snapshot({ at, pov: who }) : { people: [], unplaced: [], elsewhere: [] };
    // The doubt signal is "recorded elsewhere", not "named in the window".
    //
    // A person whose stored place contradicts the current scene and who has not been re-reported
    // recently may have moved, the court disperses, a guest retires, a rider leaves. The review's
    // `[where now?]` is the "ask rather than guess" half of the dispatch law
    // (`SelectionDispatch.lean:223`), and before this it was asked only of people with no place at
    // all, plus people recorded elsewhere whose NAME re-appeared in the window. Everyone else sat
    // frozen in the panel: Ulrich, Gerhard and Rathold stayed `present` in "the throne room" for
    // the whole of the Royal Succession chat after the court dismissed at message 32, because the
    // scene moved and nobody ever asked where they went. A stale record is exactly the "evidence
    // cannot decide" case the law names, ask, rather than let the panel assert a room they left.
    // Only mentioned-elsewhere and stale-elsewhere; a person freshly placed needs no question.
    //
    // The "mentioned" signal is the model's OWN coverage report from the previous pass
    // (`coveredCast()`), not a substring test of the window: whether the excerpt actually used the
    // person's name is a reading-comprehension question the probe already answered, in any
    // language. [ROUTER]: admission by coverage, never a token match.
    const castCovered = coveredCast();
    const castMentioned = person => castCovered.has(String(person.name ?? '').toLowerCase().trim())
        || castCovered.has(String(person.key ?? '').toLowerCase().trim());
    const misplaced = windowText
        ? castRows.elsewhere.filter(person => castMentioned(person))
        : [];
    const staleElsewhere = castRows.elsewhere
        .filter(person => !castMentioned(person) && (person.stale ?? 0) >= PLACE_STALE_AFTER);
    const unplaced = [...castRows.unplaced, ...misplaced, ...staleElsewhere];
    // [TLB]: the review's hot set scales with the window.
    //
    // Every open thread used to be posed every pass, measured at ~24 lines/pass, 1473 lines over
    // the Royal Succession chat, 78% answered "still open" or not at all. The window can only settle
    // threads it touches, so `reviewableWindow` poses the touched ones (they might change) and the
    // untouched ones only on the REVIEW_EVERY safety valve ([TLB]: a fixed hot set doesn't scale;
    // STATE-ARCHIVE.md measured misses growing ~3x per context doubling at constant slots). "Touched"
    // is the model's previous-pass coverage report (`coveredThreads()`), not a substring test.
    const { text: asked, index } = !ask ? { text: '', index: new Map() } : reviewBlock({
        threads: reviewableWindow(clocks.reviewable(turn), coveredThreads(), turn),
        unplaced,
        identity: questions.identity,
        polarity: questions.polarity,
        owed: questions.owed,
        // Marks close the way threads close: the review reads them back and says which are still
        // afflicting anybody (`FOLD-REDESIGN.md` §2's table names marks in the second row, and their
        // only exit before this was the `turns` guess made at write time). Names come from the cast
        // table so the block says "Lee" rather than a normalised key.
        marks: markLines(marks, who, at),
        threats: entities.threats(),
        // The only way anything leaves the ledger.
        //
        // What is on the player's person, so the review can ask whether each is still there.
        // Somebody else's belongings are theirs to lose, not the player's; money is asked about by
        // the `paid?` question instead, a balance going down being a payment rather than a disposal;
        // and a row already recorded off the pack is not asked at all, because its key is the answer.
        carried: carriedLines(inv, who),
        // The card's own stat fields that nothing has classified yet. Empty once the sheet is
        // sorted, which is what makes this cost decay to nothing rather than ride every pass.
        sheet: unsortedSheet(),
    });

    // The world moves while you are not looking (FOLD-REDESIGN.md §7.5).
    //
    // Recent off-screen events ride the pinned block under an explicit reveal contract: the NARRATOR
    // gets the full hidden state (that is what makes the world's off-screen motion something it can
    // hint at and later confirm), while `renderWorldEvents` withholds the content of anything the
    // character could not know until locality makes it assertable. The player's panel stays the more
    // conservative surface; the model is told the constraint instead of being left to infer it.
    const worldLine = renderWorldEvents(chronicle.liveEvents(), at);
    const contract = worldLine ? revealContract() : '';

    // What is moving on its own, so the extractor does not read a falling stock as a contradiction
    // of the ledger it was just handed. Empty by construction in a chat with no rates, which is
    // every chat until somebody sets one.
    //
    // The narrator's block (`render`) deliberately does NOT get this line yet: `renderState`'s own
    // docblock is explicit that its shape is what every live chat has been written against, and
    // that a change to it should land with its own measurement rather than ride along with this.
    const running = renderFlows(flows.load());

    // What fold did with the last answer, said out loud.
    //
    // Directly under the ledger lines, because it is about them: every line in it is a name that
    // matched nothing above. `ask` gates it with the review for the same reason `counted` is gated,
    // the adjudicator is ruling on an attempt, not correcting a record. See `renderRefused`.
    const refused = ask ? renderRefused(loadTable(REFUSED_PATH), entities.turn()) : '';
    if (refused) {
        observe.note('block:refused');
    }

    return { text: [...lines, refused, cast, running, worldLine, contract, asked].filter(Boolean).join('\n'), shown, review: index };
}

/**
 * Render current state for the prompt.
 *
 * The `player` line states who the player character is, in the persona's own words. Fold had no
 * notion of whose story this is beyond the `pov` field the scene probe infers from prose, and
 * that field can be empty (before the first extraction) or wrong (a scene the narration reads
 * from another character's shoulder for a stretch). Neither case should leave the narrator free
 * to decide who the reader is: at initialization and mid-game the model sometimes picked a cast
 * member as the player character. The persona is the ground truth for that, so it is stated
 * outright, at the top of the block, close to generation where it cannot decay.
 *
 * @param {object} [options] Options.
 * @param {string} [options.player] The player's identity: "Sol, a young man standing 184cm…".
 * @returns {string} The block, or '' when there is nothing to say.
 */
export function render({ player = '', overrides = {} } = {}) {
    // `abilities` and `faces` are not optional garnish here. Without the first the narrator simply
    // stops being told the character has Tier 3 access, the capability is still tracked and no
    // longer mentioned, which is the worst of both. Without the second every proper noun the story
    // wrote reaches the model lowercased.
    const { inv, vitals, marks, standings, abilities, faces } = derive();
    // The place tier and the component faces.
    //
    // `renderState` takes the tables and renders the tiers itself, there is deliberately no second
    // `places.render()` call, because two renderers disagreeing about what a place looks like is how
    // the same fact ends up in the block twice.
    //
    // `here` is what makes the tiering possible: the place the scene is in renders in full, and
    // everywhere else is a name and a line. Both fail open, with no place record on either side the
    // plain strings decide, which is every chat on disk today.
    const body = renderState({
        inv, vitals, marks, standings, abilities, faces, pov: pov(),
        parts: parts.faces(),
        places: places.load(),
        // The resolved place, not the scene STRING.
        //
        // `sceneLocation()` is what the narration wrote, and `renderPlaces` matches it against the
        // record by name. That match misses on exactly the compound strings this record was built
        // for: measured across 2064 located passes in the trace corpus, 26, 35% carry a container,
        // and every one of them fails, "RPD break room" does not equal the row `break room`, and
        // "Nine-Tails Inn, common room" matches neither half.
        //
        // So the near tier, the place the scene is in, rendered in full, would have stayed empty
        // on a quarter to a third of passes, and the narrator would keep being told nothing about
        // where the story is standing. `here()` is the key the scene probe already resolved, and it
        // falls back to the string for every chat written before the probe carried `place_name`.
        here: places.here()?.row?.name ?? sceneLocation(),
        // The far tier has no producer yet: nothing assembles the places merely MENTIONED this
        // scene. The natural source is the distinct `place` on live cast rows plus `where` on open
        // threads; until that exists the near tier carries the whole feature and this stays empty
        // rather than guessing.
        mentioned: [],
    });

    // `cap:stale-hidden` was counted here, and nothing increments it any more.
    //
    // The count that stood here read 198 in the live Solo Leveling chat and 540 in Raccoon City, and
    // it was measuring fold hiding a character's own pockets from the narrator. `isFresh` is gone
    // (`state-table.js` carries its retirement note and the three measurements that killed it), so
    // the counter is retired to zero by construction, which `FOLD-REDESIGN.md` §5 calls the
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
        inv,
        // Same set as the narrator block. The extractor is told more about a flagged person for the
        // same reason the narrator is: it is being asked to keep that person's record straight.
        poi: new Set(poiKeys()),
    });
    // Pressure last in the block and first in importance, it is the only part that says what is
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
    // Why the clock is annotated rather than simply stated.
    //
    // Injecting "Time: 1:03 PM" every turn is an assertion, and the model reads it as one. When the
    // narrative has moved through an afternoon and the block never restated the time, fold was
    // handing back a clock the story had outrun, and the model, asked what time it was, dutifully
    // repeated it. The panel was not failing to track time; fold was actively holding it still.
    //
    // So a clock nothing has confirmed for a few exchanges is labelled as such. That converts a
    // silent falsehood into a request the narrator can act on.
    const clock = loadClock();
    const stale = isClockStale(clock);
    const now = clock.seen ?? 0;

    let dropped = 0;
    // No `(fixed)` annotation any more: nothing pins a scene field, so nothing has to be declared
    // immovable to the narrator.
    const context = table_entries(fields)
        .filter(([label]) => !superseded.has(label))
        .map(([label, field]) => {
            // "Pov: Solomon" is a field name leaking into the prompt. The model is being told who
            // the story follows, so it should read as that sentence. Never aged out, who the story
            // follows is not a fact about the present scene.
            if (label === 'pov') {
                return `Point of view: ${field.v}`;
            }
            const head = `${label[0].toUpperCase()}${label.slice(1)}`;
            const fix = '';
            const age = Math.max(0, now - (field.t ?? 0));
            if (label === 'time' && stale) {
                return `${head}: ${field.v} (last confirmed ${clockAge(clock)} exchanges ago, state the current time if it has moved on)`;
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

    // The player, first and always.
    //
    // Identity is the one thing the ledger should assert even when the scene probe has not run yet:
    // at initialization the block used to say nothing about who the reader is, and the model picked
    // from the cast. The persona is authoritative for that, so it leads the block. `pov` stays as a
    // separate fact, who the prose currently follows can differ from who the player is, but the
    // player is never left to be guessed.
    //
    // The block is assembled from named fragments (`prompt-fragments.js`) so any part can be
    // overridden or suppressed per the player's `promptOverrides`. With none set, the assembly is
    // byte-identical to the inline builder it replaced.
    const playerLine = player ? `Player: ${player}` : '';
    const fragments = {
        'scene.header': '[Scene]',
        'scene.player': playerLine,
        'scene.context': context.join('\n'),
        'scene.cast': cast,
        'scene.stakes': stakes,
        'state.body': body,
    };
    return assembleStateBlock(fragments, overrides);
}

/**
 * Everything the UI panel needs, including the audit trail.
 * @returns {object} A snapshot.
 */
export function snapshot() {
    const { inv, vitals, marks, since, contributors, faces, abilities } = derive();
    const who = pov();
    const cast = entities.load();

    return {
        // Everything the card itself reported, time, location, conditions, leads. Fold cannot
        // model most of it and does not need to; the panel's job is to show what was said.
        context: table_entries(loadContext())
            .map(([label, field]) => ({
                label,
                value: field.v,
                age: Math.max(0, (loadClock().seen ?? 0) - (field.t ?? 0)),
                // What this field IS, as the review model classified it, the panel routes on this
                // rather than on the label, so a card can call its health anything. Null until the
                // review has seen it, which the panel renders as "unsorted" rather than guessing.
                ...(lookup(sheet(), label, null) ?? {}),
            })),
        // How long since the narrator last restated its status block. Measured on a real chat,
        // blocks arrive in bursts, so a gap is normal, but a gap nobody can see looks like a
        // tracker that has stopped working.
        sinceBlock: turnsSinceBlock(),
        // The same silence, classified: a narrator that stopped emitting blocks is not a gap, and
        // the footer printed both the same way. See `clock.js` `blockReport`.
        blockState: blockReport(loadClock()),
        // Everything held, full stop. The panel used to receive a `fresh` flag and draw the rest as
        // a count, because `isFresh` hid stale carried items from the prompt and a panel that hid
        // them too would have been lying twice. Phase C deleted the hiding, so `fresh` is `true` for
        // every row by construction, kept on the shape rather than removed, because the panel and
        // the calibration instrument both read it and a silently vanishing field is the kind of
        // change that produces a blank section nobody notices.
        inventory: table_entries(inv).map(([key, item]) => {
            const parts = splitItemKey(key);
            return {
                ...parts,
                key,
                // The story's own casing where the ledger caught it, so `SIG P226` does not reach
                // the panel as `Sig p226`. Falls back to the key, which is what always happened.
                display: faces.get(key) || parts.name,
                qty: item?.qty ?? 0,
                since: since.get(key) ?? 0,
                fresh: true,
                // The grade the story gave it, `Quarterstaff proficiency (E)`, `Sword +2`. Folded
                // since it was introduced and rendered into the narrator's block as part of the
                // label (`renderState`), but never forwarded here, so the one per-item attribute
                // fold already tracks was invisible on the only surface a player looks at. Free text
                // and never compared, exactly as `deltaSchema` describes it.
                rank: item?.rank ?? '',
                // `owner`/`mine` exactly as the marks below carry them, and for the same reason: an
                // item can belong to a companion now, so the panel needs to draw it beside them
                // rather than in the player's pockets, and it must never have to know that a name
                // and a title can be the same person. Resolved here, through the alias set.
                owner: parts.who ? (resolveEntity(cast, PERSON, parts.who)?.key ?? '') : '',
                mine: !parts.who || parts.who === ownerKey(who),
                // Why you have this: the events that produced the quantity, each with its anchor so
                // the panel can jump a contributor to the message that caused it (§8 cause-link).
                from: (contributors.get(key) ?? []).map(c => ({ dq: c.dq, summary: c.summary, mid: c.mid ?? null })),
            };
        }),
        vitals: table_entries(vitals).map(([name, v]) => ({ name, cur: v?.cur ?? 0, max: v?.max ?? 0 })),
        // Capabilities, which are no longer things in a place.
        //
        // `tier 3 access ×1` was a category error: a capability has no count, no location and cannot
        // be dropped, and filing it in the item table gave it all three plus a share of the 64-row
        // pack ceiling. It folds separately now and it is reported separately here.
        //
        // Keyed the same way, deliberately, `contributors`, `since` and `faces` all address rows by
        // `itemKey`, so the audit trail and the story's own casing survive the move without a single
        // key being rewritten.
        abilities: table_entries(abilities).map(([key, row]) => {
            const parts = splitItemKey(key);
            return {
                key,
                who: row?.who ?? parts.who ?? '',
                name: row?.name ?? parts.name,
                display: faces.get(key) || row?.name || parts.name,
                rank: row?.rank ?? '',
                since: since.get(key) ?? 0,
                mine: !parts.who || parts.who === ownerKey(who),
                from: (contributors.get(key) ?? []).map(c => ({ dq: c.dq, summary: c.summary, mid: c.mid ?? null })),
            };
        }),
        // The pov's marks only, which is what the Condition section always claimed to be.
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
        // Where the reader had got to, oldest first. The tally above stays LIFETIME, every
        // deletion argument in `observe.js` rests on those figures, and the panel subtracts the
        // newest mark from it to decide whether the footer chip has anything to say. See
        // `acknowledge` for why this is a watermark and never a reset.
        acks: loadAckMarks(),
        // The diagnostics log: what was rejected and which extraction passes failed, newest first.
        // The panel's "N rejected" footer opens it, so a tally is one click from its causes.
        log: log.load(),
        // The extraction lifecycle, so the panel can show acknowledged/syncing/failed instead of a
        // stale value presented as current (FOLD-SLA.md §2).
        sync: getSync(),
        // The lock's argument with the narrator, made visible.
        //
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
 * @param {string} [at] The scene location, for the presence predicate.
 * @returns {object[]} Mark lines for `reviewBlock`.
 */
function markLines(marks, who, at = '') {
    const cast = entities.load();
    // Only about people who could be in the room.
    //
    // The review settles what the excerpt touches, so a mark on somebody the record places two
    // scenes away is a question with one possible answer, re-posed every pass out of a budget the
    // present cast needs (`MAX_MARK_LINES`). Midoriya carried `stunned` from mid 69 of the live My
    // Hero Academia RP through two in-story days that never mentioned him again.
    //
    // `absentKeys` is deliberately positive evidence only, somebody merely UNPLACED is still asked
    // about, because not knowing where they are is not knowing they are gone. The mark itself is
    // untouched either way: a wound does not heal because the story looked elsewhere, and this
    // bounds the question, not the condition.
    const absent = absentKeys(cast, entities.turn(), at);
    return table_entries(marks)
        .filter(([, mark]) => mark?.on)
        .filter(([key]) => {
            const owner = splitMarkKey(key).who;
            return !owner || !absent.has(ownerKey(owner));
        })
        .map(([key, mark]) => {
            const owner = splitMarkKey(key).who;
            const named = owner ? resolveEntity(cast, PERSON, owner)?.entity?.name : '';
            return {
                key,
                // The DISPLAY name, or '' for the pov, this is what a closure event will carry as
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
 * The player's carried rows, for the review's `still carrying?` questions.
 *
 * Freshest first, `since` counts events since a row was last touched, so the things the story has
 * been handling lately are the things it is most likely to have just put down, and the ones this
 * pass can actually answer about. `MAX_ITEM_LINES` caps the queue; what does not fit is posed on a
 * later pass, exactly as the mark lines work.
 *
 * @param {Map<string, {qty: number}>} inv Derived inventory.
 * @param {string} who The pov's name.
 * @returns {Array<{key: string, name: string, qty: number}>} Item lines for `reviewBlock`.
 */
function carriedLines(inv, who) {
    const { since } = derive();
    return table_entries(inv)
        // The pack, and the pack only. What that excludes and why is `isDisposable`'s docblock,
        // the short version is that "still carrying?" asked about an ability, a house or a thing
        // already recorded elsewhere has one honest answer, and that answer used to delete the row.
        .filter(([key]) => isDisposable(key, who))
        .map(([key, item]) => ({ key, name: splitItemKey(key).name, qty: item?.qty ?? 1, age: since.get(key) ?? 0 }))
        .sort((a, b) => a.age - b.age)
        .map(({ key, name, qty }) => ({ key, name, qty }));
}

/**
 * Record marks somebody is carrying, as one event.
 *
 * The mention gate is widened here, for `review.js`'s reason.
 *
 * `isMentioned` exists to stop a model inventing an ITEM the excerpt never named, and it works
 * because an item has a name the prose uses. An affliction does not: the scene probe is asked *how
 * is this character doing* and answers in its own words, "calf scabbed and rebandaged" against a
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
        .map(mark => ({ who: mark?.who ?? '', flag: mark?.phrase, on: true, severity: mark?.severity, turns: Number(mark?.turns) }))
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
 * Why this is an append and not a delete.
 *
 * Marks derive from the ledger, so "healed" is a thing that HAPPENED and gets recorded like
 * everything else: an `st` delta with `on: false`, anchored on the message the review was reading.
 * Swipe that message away and the healing un-happens along with the turn that described it, exactly
 * as `overlayClosures` promises for threads (`thread-table.js`), with no overlay needed, because
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
 * calls it, won, credits, crowns, and a currency list is the enumerated-vocabulary shape §11 rules
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
 * Count how the pass said its gains arrived, the instrument that decides whether `how` works.
 *
 * This exists because the last two fields of its kind failed silently.
 *
 * `moves: []` came back empty 107 times out of 107 and `drive_size: 0` 288 out of 288, and both
 * were only found by someone going and looking. A field whose skip is invisible is a field nobody
 * audits, so `how` reports its own distribution from the day it ships:
 *
 *   `money:acquired`   a gain the model placed, found, taken, given or made
 *   `money:bought`     a gain it called a purchase, which is the only value that asks a question
 *   `money:how-unsaid` a gain that carried no usable word
 *
 * The three settle every question worth asking about the field. `how-unsaid` climbing is the free
 * skip, and it is expected to be non-zero and small for a legitimate reason, the status-block path
 * (`absorb.js`) and hand-authored deltas never carry a `how` at all, and nothing about them should.
 * `bought` approaching `acquired` is the opposite failure, the model calling everything a purchase.
 * The corpus predicts roughly one `bought` for every twenty `acquired`; a ratio far off that in
 * either direction means the description is wrong and this comment is the record of what to expect.
 *
 * Counted here rather than in `validateInventory` because `state-table.js` imports only pure
 * siblings and `observe` is not one, the same split `noteRejections` already lives on.
 *
 * @param {object[]} accepted Accepted inventory deltas from this pass, flattened.
 */
function tallyAcquisitions(accepted) {
    for (const change of accepted) {
        // Exactly the rows `creditsWithoutDebit` governs: a gain, at a place that can be bought.
        // Counting losses and abilities would bury the signal under rows the field never speaks for.
        if (!(Number(change?.dq ?? 0) > 0) || CATEGORIES.has(normalizePlace(change?.at))) {
            continue;
        }
        const how = String(change?.how ?? '');
        if (how === BOUGHT) {
            observe.note('money:bought');
        } else if (how) {
            observe.note('money:acquired');
        } else {
            observe.note('money:how-unsaid');
        }
    }
}

/**
 * Watch a pass's deltas for purchases nobody paid for.
 *
 * The trigger half of `FOLD-REDESIGN.md` §5 fix 1: **code decides when to ask**. The detection rule
 * and its full argument are `creditsWithoutDebit` (`state-table.js`); this is the wiring that gives
 * it the balance and hands the question to `review.js` to be asked on the NEXT pass, next, because
 * the pass that noticed has already sent its prompt, and inventing a second call to ask sooner is
 * the thing §11 forbids outright.
 *
 * The turn rides along so the question can expire. Measured over the 271 distinct `[paid?]`
 * questions in the traced corpus, 94.1% are gone within one turn of being raised and 97.0% within
 * two; the six that outlive that are the ones nobody ever answered, including a single `torch`
 * re-asked for eleven passes over ten turns. See `review.noteCredits`.
 *
 * @param {object} params Parameters.
 * @param {object[]} params.accepted Accepted inventory deltas from this pass, flattened.
 * @param {object[]} [params.refused] Rejections from this pass.
 * @returns {string[]} The items the next review will ask about.
 */
export function noteCredits({ accepted = [], refused = [] } = {}) {
    tallyAcquisitions(accepted);
    const items = creditsWithoutDebit({ accepted, refused });
    if (!items.length) {
        return [];
    }
    const held = balance();
    review.noteCredits({ items, balance: held.amount, currency: held.currency || 'money', turn: entities.turn() });
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
 * Why this has to exist.
 *
 * Measured on a real chat: all 38 inventory deltas in the ledger carry no place at all, and every
 * one came from block absorption. The extraction probe has never proposed one. So the place
 * mechanism was complete, tested, rendered, and nothing had ever used it, which is why a shelf of
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

    // Out of one place and into the other, as one event, the same shape the extraction schema
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

// Person-of-interest keys outlive the people they name.
//
// `setPoi` writes by entity key, and entity rows are pruned: `entities.prune` deletes past
// `ENTITY_STALE * 2` and demotes to the cold store. Nothing was clearing the flag, so a campaign
// that meets and forgets forty people accumulates forty dead keys, small individually, unbounded
// over a long chat, and pure waste in a 128 KB blob.
//
// Two stages, cheapest first. Orphans are free to lose, because the row they pointed at is gone and
// the flag can never affect anything again; only if that is not enough does it shed live flags,
// oldest-key-first for want of a better order. `PRUNE_ARCHIVE` rather than `PRUNE_DIAGNOSTICS`: a
// flag the player set by hand is worth more than a log line and less than the record itself.
registerPruner((overBy) => {
    const table = loadPoi();
    if (!table.size) return;
    const live = new Set(table_entries(entities.load()).map(([key]) => key));
    let dropped = 0;
    for (const [key, on] of table_entries(table)) {
        if (!on || !live.has(key)) {
            table.delete(key);
            dropped++;
        }
    }
    if (!dropped && table.size) {
        // Still over after losing the orphans: shed half the remainder rather than all of it, so a
        // second pass converges instead of emptying a table the player filled deliberately.
        for (const [key] of table_entries(table).slice(0, Math.ceil(table.size / 2))) {
            table.delete(key);
            dropped++;
        }
    }
    commit(POI_PATH, table);
    console.debug(`[sanguine] dropped ${dropped} person-of-interest flag(s) to fit the metadata budget (over by ${overBy})`);
}, PRUNE_ARCHIVE);
