/**
 * fold/clocks.js — threads, persisted and folded.
 *
 * The pure logic is in thread-table.js; this file is the half that touches storage and the
 * extraction pass. It keeps the name `clocks.js` because four modules import it by that name and a
 * rename is churn a phase should not spend its risk budget on; what it stores is the whole thread
 * table — leads, clocks and progress tracks — since Phase B.
 *
 * ── Why threads ride the existing extraction call ──
 *
 * A separate adjudicator pass would be the obvious design and the wrong one: the model is already
 * reading the narrative window to produce events and people, and asking it a second time costs
 * another round trip for the same paragraph. Ticks and thread proposals are answered alongside
 * everything else, and the whole feature adds no LLM calls at all.
 *
 * ── Why leads moved here from the entity probe ──
 *
 * Because the split was costing the campaign its spine. The Solo Leveling chat held the residency
 * obligation as a lead ("1 of 20 logged. Nineteen to go") AND as a clock ("The residency window
 * closes", 1/8): two tables, two lifecycles, two renderings of one stake, and the thing the
 * fiction actually stated — twenty raids in twelve months — expressible in neither, so the count
 * lived as prose (FOLD-REDESIGN.md §4). One probe fragment, one table, one answer.
 */

import {
    CLOCK_SIZES,
    CLOSED,
    DIAL_KINDS,
    DOOM,
    HIDDEN,
    MAX_TICK,
    MAX_TRACK_SIZE,
    OPEN,
    PROGRESS,
    THREAD_STATUSES,
    foldThread,
    foldThreads,
    foldTicks,
    identityPairs,
    isFull,
    mergeThreads,
    reviewable as reviewableThreads,
    normalizeThreadName,
    overlayClosures,
    renderThreads,
    tickCalendar as runCalendarTicks,
    threads,
    threadsByKind,
} from './thread-table.js';
import { lookup } from './lib/hash.js';
import * as chronicle from './chronicle.js';
import * as cold from './cold-store.js';
import * as observe from './observe.js';
import { commit, loadTable } from './store.js';

/**
 * Where threads live under v2.
 *
 * The v1 key `state.clocks` survives beside this one until the v2 blob has come back off disk
 * (`migrate.js`), so a rollback finds its clocks exactly as it left them.
 */
const THREADS_PATH = 'state.threads';

/** @returns {Map<string, object>} The thread table, exactly as stored. */
export function load() {
    return loadTable(THREADS_PATH);
}

/**
 * The thread table as the world currently is: stored rows, with this branch's closures over them.
 *
 * ── Read paths use this; write paths use `load()`, and mixing them would bake the overlay in ──
 *
 * A closure is a ledger event, not a field (`thread-table.js` `overlayClosures` carries the full
 * argument and the swipe scenario). So every consumer that asks "what is open?" composes the stored
 * table with the live closures, and every consumer that writes takes the stored table alone — commit
 * an overlaid table and a swipe could no longer undo anything, because the closure would have become
 * a stored status indistinguishable from one extraction wrote.
 *
 * That is the same discipline `deriveState` keeps by never persisting what it folds, and it is why
 * `set()` and `merge()` below call `load()` rather than this.
 *
 * @returns {Map<string, object>} The overlaid table.
 */
export function view() {
    return overlayClosures(load(), chronicle.threadClosures());
}

/**
 * The schema fragment for the thread probe.
 * @returns {object} A JSON Schema fragment.
 */
export function schema() {
    return {
        type: 'object',
        description: 'What is at stake: dangers and deadlines that advance, long efforts that make progress, and open threads nobody has settled.',
        properties: {
            ticks: {
                type: 'array',
                description: 'Dials that advanced or retreated in this excerpt, and new ones it establishes.',
                items: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'The outcome being worked toward, as a short phrase: "the Blight reaches Briarwood", "twenty D-rank raids logged".',
                        },
                        tick: {
                            type: 'integer',
                            description: `How much it advanced: 1 for a step, 2 for a serious one, at most ${MAX_TICK}. Negative if pushed back. Never zero.`,
                        },
                        kind: {
                            type: 'string',
                            enum: DIAL_KINDS,
                            description: `${DOOM} if filling it is BAD for the characters (a danger closing in, a deadline running out). ${PROGRESS} if filling it is GOOD (a long effort completing). Only when newly established.`,
                        },
                        size: {
                            type: 'integer',
                            description: `Total steps, only when newly established. ${DOOM}: 4 imminent, 6 ordinary, 8 slow catastrophe. ${PROGRESS}: the number the story states, up to ${MAX_TRACK_SIZE} — "twenty raids" is 20.`,
                        },
                        about: {
                            type: 'string',
                            description: 'What happens when it completes: "the village is abandoned". Empty if the excerpt does not say.',
                        },
                        where: {
                            type: 'string',
                            description: 'The place this applies, as a bare place name, when tied to one. Empty for something that follows the characters anywhere.',
                        },
                        seen: {
                            type: 'string',
                            enum: [OPEN, HIDDEN],
                            description: `${OPEN} if the point-of-view character could plausibly perceive this, ${HIDDEN} if beyond their knowledge.`,
                        },
                    },
                    required: ['name', 'tick', 'kind', 'size', 'about', 'where', 'seen'],
                    additionalProperties: false,
                },
            },
            leads: {
                type: 'array',
                description: 'Unresolved threads with no measurable position — something a character could act on and has not yet. Not lore, abilities, or plain facts. If nothing about it is still open, it is not a thread.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'A short title, five words at most.' },
                        detail: {
                            type: 'string',
                            description: 'The specifics: who, where, when. One short phrase.',
                        },
                        open: {
                            type: 'string',
                            description: 'What is still unknown or undone — the gap, not the goal, phrased explicitly: "the final command is unknown", "six wolves still to be killed". A flat objective ("kill six wolves") will be discarded; empty if nothing is unresolved.',
                        },
                        status: {
                            type: 'string',
                            enum: THREAD_STATUSES,
                            description: 'open if still unsettled, closed if the excerpt settled it, moot if it stopped being about anything.',
                        },
                        source: {
                            type: 'string',
                            description: 'Where this was learned: "RPD dispatch, 11:18 AM", "overheard at the ramen shop". Empty if the excerpt does not say.',
                        },
                    },
                    required: ['name', 'detail', 'open', 'status', 'source'],
                    additionalProperties: false,
                },
            },
        },
        required: ['ticks', 'leads'],
        additionalProperties: false,
    };
}

/** @returns {string} Prompt guidance for the probe. */
export function instruction() {
    return [
        'What is at stake, as dials that move and threads that do not.',
        'A dial is a named outcome with steps. Report one only when the excerpt actually moved it — a danger merely mentioned has not advanced. Never re-report an already-recorded dial just to confirm it still exists; "still open" is the review section\'s question, and a re-report with no movement is rejected. A tick measures pressure, not bodies: downing a pack in one scene is still a tick of at most 3, never one per kill.',
        'Name the outcome, not the activity: "the Blight reaches Briarwood", never "dealing with the Blight".',
        `Say whether filling the dial is bad ("${DOOM}") or good ("${PROGRESS}"). Set "kind" and "size" once, when the dial is first established; afterwards send only the tick.`,
        'A thread with no dial is a title plus specifics: "missing-persons cluster" with detail "Arklay County, 15-18 September".',
        'A thread already listed in the review section is RECORDED — never propose it again as new. The "T6" on a review line is a label, not part of the name; reporting "T6 Geldfurt funding" opens a duplicate of an existing thread.',
        'A thread must have something unresolved, and "open" must say it — the gap, not the goal: "the final command is unknown", "six wolves still to be killed". A flat objective ("kill six wolves") is discarded.',
        'Exposition is not a thread: what a power does, what an object is for, what someone was told to do and then did — background, however new.',
        'Say where each thread came from in "source". Use empty arrays when nothing advanced and nothing new opened.',
    ].join(' ');
}

/**
 * Apply a probe fragment.
 * @param {any} fragment The probe's slice of the extraction.
 * @param {object} context Context from the extraction pass.
 * @param {number} [context.turn] Turn counter.
 * @returns {{accepted: number, fired: object[], rejected: object[]}} What was applied.
 */
export function applyExtraction(fragment, { turn = 0, windowText = '', sources = [] } = {}) {
    const table = load();
    const proposed = fragment?.ticks;
    // ── "Proposed nothing" is not "was never asked" ──
    //
    // The same gap that made the delta pipeline unfalsifiable, left in a brand-new subsystem by not
    // applying the lesson. Measured on a live chat: nine turns of a dungeon raid produced zero
    // clocks and zero counters, so there was no way to tell whether the probe had reached the model
    // at all. It had; the model simply proposed nothing.
    if (!Array.isArray(proposed)) {
        observe.note('pressure:absent');
    } else if (!proposed.length) {
        observe.note('pressure:empty');
    }

    const ticks = foldTicks(table, proposed ?? [], { turn, windowText });
    const opened = foldThreads(table, fragment?.leads ?? [], { turn, windowText });
    commit(THREADS_PATH, table);

    // ── A full table sheds to the cold store, not to oblivion ──
    //
    // `foldThreads` RETURNS the rows that gave up their slots instead of deleting them. Demoting
    // them here keeps the hot table bounded while preserving the thread whole — a courier's death
    // that lost its slot at turn 34 is still recallable the moment the story returns to it
    // (cold-store.js, [EVICT]). The `threads-full` rejection now only means "the table was full and
    // even the stalest expendable row was dial-bearing", which is the one case that still refuses.
    for (const evicted of opened.evicted) {
        cold.demote({ kind: 'thread', key: evicted.key, row: evicted.row, at: turn });
        observe.noteCap('threads-archived');
    }

    const rejected = [...ticks.rejected, ...opened.rejected];
    // Anchor refusals to the newest message the pass read, for the log's cause-link.
    observe.noteRejections(rejected.map(rejection => ({ ...rejection, mid: sources[sources.length - 1]?.mid, turn })));
    for (const thread of ticks.fired) {
        // A dial filling is the single most consequential thing this subsystem produces, and it
        // happens once. Counted so it can never fill unnoticed.
        observe.noteCap('clock-fired');
        console.debug(`[fold] a dial filled: ${thread.name}${thread.about ? ` — ${thread.about}` : ''}`);
        // ── Firing CLOSES the dial, the same way a review closure does ──
        //
        // A filled dial was deliberately excluded from the review's open lines ("already fired is
        // not an open line", `thread-table.js` reviewable) — and nothing else ever wrote its exit,
        // so it sat `open` in storage forever: one turn of `done`, then invisible, then a
        // duplicate re-report could even tick it again. The consequence of a filled dial is
        // already on the record (`about` — "the east falls to raiders" IS what completing the dial
        // means), so closing it is arithmetic, not a model guess. Written through the chronicle so
        // it carries the same anchor and liveness a review closure does: a swipe that removes the
        // completing message retracts the fire with it.
        chronicle.recordReviewEvent({
            summary: `${thread.name} completes: ${thread.about || 'the dial filled'}`,
            keywords: [thread.name, ...(thread.about ? thread.about.split(/[^a-z0-9']+/i).filter(w => w.length > 3) : [])],
            delta: { threads: [{ key: thread.key, status: CLOSED }] },
            srcKey: (sources ?? [])[sources.length - 1]?.key ?? '',
            mid: (sources ?? [])[sources.length - 1]?.mid,
        });
    }
    if (ticks.accepted) {
        observe.note('pressure:ok');
    }
    if (opened.accepted) {
        observe.note('threads:ok');
    }
    return { accepted: ticks.accepted + opened.accepted, fired: ticks.fired, rejected };
}

/**
 * Advance every calendar front the narrative clock has run past — in code, no model involved.
 *
 * The pure logic is `thread-table.js` `tickCalendar`; this half owns storage and observation. It is
 * called the instant a declared elapse moves the clock (`state.js` `noteElapsed`), so a front whose
 * firing condition is "twelve months pass with fewer than twenty raids logged" ticks on the month
 * boundary rather than waiting for a narrator who never says so (FOLD-REDESIGN.md §7.1: "a pure
 * calendar condition that nothing in fold can tick"; §7.3, Gate 2).
 *
 * ── Why `load()` and not `view()` ──
 *
 * The same discipline every write path in this file keeps: `view()` overlays this branch's closures,
 * and committing an overlaid table would bake a closure into storage where a swipe could no longer
 * undo it. The closures are ledger events; the calendar tick is arithmetic on the stored row. Read
 * paths compose the two; write paths never mix them.
 *
 * @param {object} params Parameters.
 * @param {number} params.now The narrative clock as a scalar (`clock.js` `clockScalar`).
 * @param {number} [params.turn] Turn counter.
 * @returns {{ticked: object[], anchored: string[], fired: object[]}} What advanced, what was met
 *   for the first time, and what filled.
 */
export function tickCalendar({ now, turn = 0 } = {}) {
    const table = load();
    const result = runCalendarTicks(table, { now, turn });
    commit(THREADS_PATH, table);
    if (result.ticked.length) {
        observe.noteCap('calendar-ticked', result.ticked.length);
    }
    if (result.anchored.length) {
        observe.noteCap('calendar-anchored', result.anchored.length);
    }
    for (const thread of result.fired) {
        // Reuses the dial-filled counter the extraction pass already beats: a fill is a fill, and
        // whether a model or the calendar caused it is recorded in the audit trail, not the histogram.
        observe.noteCap('clock-fired');
        console.debug(`[fold] a calendar front filled: ${thread.name}${thread.about ? ` — ${thread.about}` : ''}`);
        // Same arithmetic close as extraction: the calendar fills the dial, so the calendar closes
        // it. Anchored to the user message that declared the elapse (no extraction source exists
        // here), which is what `recordReviewEvent` uses when srcKey is empty anyway.
        chronicle.recordReviewEvent({
            summary: `${thread.name} completes: ${thread.about || 'the dial filled'}`,
            keywords: [thread.name, ...(thread.about ? thread.about.split(/[^a-z0-9']+/i).filter(w => w.length > 3) : [])],
            delta: { threads: [{ key: thread.key, status: CLOSED }] },
            mid: undefined,
        });
    }
    return result;
}

/**
 * Render threads into the injected block.
 *
 * Three lines rather than one, and the split is the point: `Pressure:` for doom dials, `Progress:`
 * for the ones that fill toward something the characters want, `Threads:` for the ones with no
 * measurable position. A progress dial has never once belonged under `Pressure:` and was printed
 * there for as long as the two tables existed.
 *
 * @param {number} turn Current turn.
 * @param {string} [at] Scene location.
 * @returns {string} Lines, or ''.
 */
export function render(turn, at = '') {
    return renderThreads(view(), turn, { at });
}

/**
 * Everything the panel and the adjudicator need about DIALS.
 *
 * Dial-bearing threads only, with the dial's fields flat on the record — which is what
 * `verdict.js` and the slash commands were written against, and what `thread-table.js` stores
 * anyway (see its header on why the dial is flat in storage and an object on read).
 *
 * @param {number} turn Current turn.
 * @param {string} [at] Scene location.
 * @returns {object[]} Dials, most urgent first.
 */
export function snapshot(turn, at = '') {
    return threads(view(), turn, { at }).filter(thread => thread.dial);
}

/**
 * Everything the panel needs about threads, split by how it should draw them.
 * @param {number} turn Current turn.
 * @param {string} [at] Scene location.
 * @returns {{pressure: object[], progress: object[], open: object[], done: object[]}} The split.
 */
export function sections(turn, at = '') {
    return threadsByKind(view(), turn, { at });
}

/**
 * Every thread the review pass must be able to close.
 *
 * Read through `view()` like every other read path, so a thread this branch has already closed does
 * not come back as a question. The selection rule and the hand-check that produced it are
 * `thread-table.js` `reviewable`.
 *
 * @param {number} turn Current turn.
 * @returns {object[]} Threads for the review block.
 */
export function reviewable(turn) {
    return reviewableThreads(view(), turn);
}

/**
 * Threads whose names raise the identity question.
 *
 * `next raid with Kang's squad` and `next raid with Kang's team` opened as two threads in the live
 * chat, because leads had no `aka` and nothing ever compared two thread names
 * (FOLD-REDESIGN.md §0.1-6). Data only in this phase: the pairs are computed, never merged.
 *
 * @returns {Array<{a: string, b: string, why: string}>} Pairs, by table key.
 */
export function questions() {
    return identityPairs(threads(view(), 0));
}

/**
 * Set a thread by hand.
 *
 * The GM's override. Every value fold derives should be correctable in place — a tracker you cannot
 * correct is one you stop trusting the first time it is wrong, which is the defect that sank the
 * reference implementation.
 *
 * @param {string} name Thread name.
 * @param {object} changes Fields to set.
 * @returns {boolean} True if it was written.
 */
export function set(name, { filled, size, kind, about, seen, status, turn = 0 } = {}) {
    const table = load();
    const parsed = normalizeThreadName(name);
    if (!parsed) {
        return false;
    }

    // Deliberately NOT routed through `foldTicks`. That path validates a proposed tick — it
    // refuses zero as "no change" and anything over MAX_TICK as implausible — and both refusals are
    // about a MODEL guessing. A person setting a dial by hand is the authority the validators
    // exist to protect, so this sets the fill absolutely and skips them.
    const current = lookup(table, parsed.key, null);
    const target = Number.isFinite(filled) ? filled : (current?.filled ?? 0);
    const written = foldThread(table, {
        name,
        // foldThread accumulates, so the tick is the difference from where it stands.
        tick: target - (current?.filled ?? 0),
        size: size ?? current?.size,
        kind: kind ?? current?.kind,
        about: about ?? current?.about ?? '',
        seen: seen ?? current?.seen,
        status: status ?? current?.status,
        turn,
    });
    if (!written) {
        return false;
    }
    // A hand-set dial can evict the stalest expendable thread the same way an extraction pass can;
    // the returned row is demoted to the cold store rather than lost (cold-store.js, [EVICT]).
    if (written.evicted) {
        cold.demote({ kind: 'thread', key: written.evicted.key, row: written.evicted.row, at: turn });
        observe.noteCap('threads-archived');
    }
    commit(THREADS_PATH, table);
    return true;
}

/**
 * Merge two threads the review confirmed are one stake.
 *
 * The rule and its argument live in `thread-table.js` `mergeThreads`; this is the storage half.
 * `load()` rather than `view()`, deliberately — see `view()`'s docblock: a merge is a write, and
 * writing an overlaid table would make this branch's closures permanent.
 *
 * @param {string} a One table key.
 * @param {string} b Another.
 * @returns {{key: string, dropped: string}|null} What survived, or null if nothing merged.
 */
export function merge(a, b) {
    const table = load();
    const done = mergeThreads(table, a, b);
    if (done) {
        commit(THREADS_PATH, table);
    }
    return done;
}

/**
 * Persist a thread table a pure routine has just written to.
 *
 * The one write path that does not go through this module's own folds, and it exists because
 * `absorb-table.js` owns the block-routing rule and has to stay pure to be testable. It takes a
 * table that came out of `load()`, never `view()` — see `view()`'s docblock for why mixing them
 * would make this branch's closures permanent.
 *
 * @param {Map<string, object>} table The table to store.
 */
export function commitTable(table) {
    commit(THREADS_PATH, table);
}

/** Forget every thread. */
export function clear() {
    commit(THREADS_PATH, new Map());
}

// Re-exported so the panel can ask "has this already happened?" without reaching past this
// module into the pure layer.
export { isFull, CLOCK_SIZES, DOOM, PROGRESS };
