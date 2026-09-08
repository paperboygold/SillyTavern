/**
 * fold/extract-table.js: the pure half of the extraction window.
 *
 * Dependency-free and unit-testable, like every other `*-table` module here. `extract.js` owns the
 * request, the retry and the probes; this owns the one question that turned out to be worth its own
 * file: *which of these messages is the model allowed to bill?*
 *
 * The overlap was paying for the same beat three times.
 *
 * `buildWindow` took the trailing N messages every pass, and the pass runs every one to two turns
 * (`trigger-table.js` MIN_INTERVAL, `index.js` onAssistantMessage), so consecutive windows overlap
 * by four or five messages. Every event is attributed to the newest source in its window
 * (`chronicle.js:222-225`), so the same beat read three passes running produces three events with
 * three different anchors, and the exact dedup (same anchor, same content) and the semantic dedup
 * (`chronicle-table.js:285-292`, keyword-signature equality) both miss, because neither is looking
 * at the same key twice.
 *
 * Measured in the live Solo Leveling ledger: the phone-number exchange is recorded at mids 50, 52
 * and 54; the ahjumma's two candies at 54 and 58 (so the fold says four); the goblin knife at 22
 * and 38; the staff-and-shortsword purchase at 60, 66 and 68.
 *
 * The fix keeps the overlap and removes the billing. Messages up to a persisted high-water mark are
 * labelled as context the model may read and may not extract from; messages past it are the new
 * half, and only those are handed to the probes as sources. The model still sees the run-up, which
 * is why the window existed at all, since a beat's meaning is usually in the message before it,
 * but the anchor set no longer contains anything already looked at.
 *
 * Rejected alternative: shrink the window to exactly the new messages. That was the first shape and
 * it is worse in the way the overlap was introduced to fix, an event whose consequence lands in
 * the new half and whose setup is in the old one gets extracted with no idea what it was about, and
 * the summary comes back as "he agrees" with no referent.
 */

/**
 * Where the last pass stopped reading, resolved against the chat as it is NOW.
 *
 * A mid alone is not a safe mark, and swiping is why.
 *
 * A high-water mark stored as a message index says "everything up to here has been looked at". A
 * swipe rewrites the newest message in place: the index is unchanged and the content is not, so a
 * bare mid would file brand-new narration under "already recorded" and no pass would ever read it.
 * That is not a hypothetical, swiping the newest reply is the single most common thing a user does
 * to a chat, and this mechanism is the only one in fold that could be defeated by it.
 *
 * So the mark carries the content key of the message it was set on, the same `contentKey` hash the
 * chronicle already uses to decide which events are live on this branch (`chronicle.js:59-84`),
 * and is validated on every read:
 *
 *   · no mark, or a mark on a mid the chat no longer has (a deleted message, a shorter branch):
 *     the mark is meaningless, so return null and let the whole window be new. Re-reading is
 *     wasteful; skipping is wrong, and the two are not symmetric.
 *   · the key at that mid no longer matches: that message was swiped or edited, so it becomes new
 *     again: the mark retreats by one. Computed on read rather than persisted, so it stays
 *     retreated for as long as the content stays changed and heals itself on the next pass.
 *   · otherwise the mark stands.
 *
 * @param {Array<{mid: number, key: string}>} messages Candidate messages, oldest first.
 * @param {{mid: number, key: string}} mark The persisted mark.
 * @returns {number|null} The effective mark, or null when there is none to trust.
 */
export function resolveMark(messages, { mid = NaN, key = '' } = {}) {
    if (!Number.isFinite(mid)) {
        return null;
    }
    const at = (messages ?? []).find(message => message.mid === mid);
    if (!at) {
        return null;
    }
    // An empty stored key is a mark written before keys were stored. Trust it rather than discard
    // it: the alternative re-reads the whole window once per upgraded chat, for no benefit.
    return key && at.key !== key ? mid - 1 : mid;
}

/** No mark has ever been written: this chat has never been extracted from. */
export const FRONTIER_FRESH = 'fresh';

/** The mark named a live message and stands (possibly retreated by one, for a swipe). */
export const FRONTIER_STOOD = 'stood';

/** The mark named a message this chat no longer has, and was recovered from the ones it does. */
export const FRONTIER_HEALED = 'healed';

/**
 * The read frontier: how far this chat has been extracted, and how sure we are of it.
 *
 * `resolveMark` returns null for two facts that are not the same fact, and it cost real money.
 *
 * `resolveMark` answers null both when the mark was NEVER SET and when the mark names a message the
 * chat no longer has. `splitWindow` read that single null as "nothing here has ever been read", took
 * the `FIRST_WINDOW` reach-back, and billed all 24 messages as sources. On a chat two hundred turns
 * deep that is not a first pass, it is a re-read of the last 24 messages with every one of them
 * licensed to anchor a new event.
 *
 * MEASURED, in the two live chats that carry `cap:opening-unread`:
 *
 *   Raccoon City (271 msgs, `cap:opening-unread: 145`)
 *     One pass at 21:13:37 on 08-18 wrote TEN events at once, all anchored at mid 168, the largest
 *     batch anywhere in the corpus, against a median of one or two. Six of them restate beats
 *     already in the ledger from four to eighteen messages earlier: "finds maps, flashlight, 9mm
 *     rounds" (already at mid 150), "reads the notebook" (150), "tapes up the bullet hole" (154),
 *     "reloads his handgun and organizes ammunition" (157), "finds binoculars" (160), "eats tuna …
 *     takes a nap" (160/164). `cap:duplicate-suppressed` for the whole chat is 4: the exact dedup
 *     could not see them, because each carries a different anchor (`chronicle.js:348-351`).
 *
 *   Wuxia World RPG (286 msgs, `cap:opening-unread: 97`)
 *     Same shape at 20:43:55 on 08-20: three events at mid 120 re-telling the grey-robed man's death
 *     already recorded at mids 110, 112 and 113.
 *
 * Both chats had been extracted from message 1 onward, 98 and 182 events sit below the mid the
 * counter claimed was unread, stamped within seconds of the messages they describe. So NEITHER
 * number ever meant "messages nothing will read". Each was one pass reporting `all.length - 24`
 * after its mark stopped resolving.
 *
 * What stopped it resolving is visible in the same files. Nine events in the Wuxia chat and five in
 * Raccoon City are anchored on a mid whose message was sent LATER than the event was written, mid
 * 166 in Raccoon City by 32,622 seconds, which is the session gap to the hour. Deleting a message
 * renumbers every mid above it, so a mark taken before the deletion points past the end of the
 * shortened chat. The chats with no such skew carry no `cap:opening-unread` either.
 *
 * So the third answer is recoverable and worth recovering. Deletion only ever REMOVES messages, so
 * every message still below the mark is a message the pass that set the mark had already read.
 *
 * The recovery lands one BELOW the newest survivor rather than on it, and that step is the file's own
 * asymmetry applied to the new case: re-reading is wasteful, skipping is wrong, and the two are not
 * symmetric. `state-table.js` `RECORDED_HORIZON` has the shape from the trace side, turn 64 of the
 * Wuxia campaign, where the mark went 122 → 120 and the newest message was a swipe. Landing ON the
 * survivor would file that brand-new narration under "already read" and no pass would ever look at
 * it; landing one below bills exactly one message, which the chronicle's exact dedup already covers
 * if it turns out to have been read.
 *
 * `heal` carries the corrected mark back so the stale mid is fixed rather than re-diagnosed every
 * pass: without it the mark stays past the end forever and every later pass repeats the re-read.
 *
 * @param {Array<{mid: number, key: string}>} messages Candidates, oldest first.
 * @param {{mid: number, key: string}} [mark] The persisted mark.
 * @returns {{at: number|null, state: string, heal: {mid: number, key: string}|null}} The frontier.
 */
export function readFrontier(messages, mark = {}) {
    const all = messages ?? [];
    if (!Number.isFinite(mark?.mid)) {
        return { at: null, state: FRONTIER_FRESH, heal: null };
    }
    const at = resolveMark(all, mark);
    if (at !== null) {
        return { at, state: FRONTIER_STOOD, heal: null };
    }
    // Everything at or below the mark. Not `mark.mid - 1`: after a deletion the mid the mark names
    // may be tens of messages past the end, and the recovery has to land on a message that exists.
    const below = all.filter(message => Number.isFinite(message?.mid) && message.mid <= mark.mid);
    if (!below.length) {
        // The mark is below every message this chat has. Nothing to recover from, so this really is
        // a window nothing has read, the fresh path, with its reach-back and its honest `unread`.
        return { at: null, state: FRONTIER_FRESH, heal: null };
    }
    // One below the newest survivor, so the newest survivor is read again. See above for why.
    const previous = below[below.length - 2] ?? null;
    return {
        at: previous ? previous.mid : null,
        state: FRONTIER_HEALED,
        // Nothing to write when only one message survives at or below the mark: the correct mark
        // would be "before the first message", which the clock has no way to say. The next pass
        // heals again, which on a chat that short costs nothing.
        heal: previous ? { mid: previous.mid, key: previous.key } : null,
    };
}

/** The header over messages the model may read but may not extract from. */
export const CONTEXT_HEADER = 'Earlier, for context only (already recorded, extract nothing from this):';

/**
 * How far back the FIRST pass may reach.
 *
 * The opening is the one message nobody else reads.
 *
 * Cards put the premise, the character sheet and the starting equipment in the greeting. Fold had
 * two ways to read it and used neither: `absorb` needs `findStateBlock` to recognise the card's
 * delimiters, and the extraction window is the trailing `size`, so by the time the first pass fires
 *, `MIN_INTERVAL` is 2, the greeting has already slid out of it.
 *
 * The live Wuxia World RPG is the case. Its message 0 says, in plain unwrapped lines,
 * `STORAGE RING: 1x Medicinal Pill … - 1x Basic Iron Sword`, and neither item ever reached the
 * ledger: the card wraps nothing so absorb never ran, and the first pass anchored at mid 8 and read
 * mids 3-8. When the player later picked up a sword it was the only sword fold had ever seen, and
 * the narrator started treating him as a thief.
 *
 * So a pass with no mark reads from the start instead of from the tail. Bounded, because "the
 * start" is not always small: measured across the corpus, a fresh chat's first pass wants at most
 * ten messages (My Hero Academia), but one live Wuxia chat had fold enabled at message 266 of 277,
 * and reading from the start there would put 266 messages into one prompt. Twenty-four is 4x the
 * default window and 2.4x the worst fresh chat.
 *
 * What it cannot reach is REPORTED (`unread`) rather than dropped in silence, which is the lesson of
 * the defect it fixes: absorb failed open for three campaigns and never said so.
 *
 * Why this stays at 24 rather than growing.
 *
 * The case for raising it rested on `cap:opening-unread`, 145 in Raccoon City, 97 in Wuxia World,
 * read as "a hundred and forty-five messages nothing will ever read". `readFrontier` above has the
 * measurement that neither number was ever that: both chats were extracted from message 1, and both
 * counts are one pass reporting `all.length - 24` after a deletion left its mark past the end of the
 * chat. Across 21 live chats and 24 ledgers there is not one genuine unread opening.
 *
 * So the corpus offers no evidence at all that 24 is too small for the case it exists for, and
 * raising it is paid for by the FIRST PASS OF EVERY CHAT, the pass most likely to be a fresh chat
 * with nine messages in it, which is 21 of the 21. The one measured 24-message billed window
 * (Raccoon City's re-read) also shows what a big first window costs in fidelity: at the same 800
 * token budget it returned 10 events for 24 messages, each spanning several beats ("eats tuna,
 * drinks water, and observes the RPD for two hours, then takes a nap"), where the forward passes
 * over the same stretch had returned 11 finer ones. A bigger first window buys reach and pays in
 * granularity, and the granularity is what makes an event retrievable.
 *
 * And the argument that the bound is the LAST chance is no longer true: `planBackfill` below reads
 * any span the first pass could not reach, on demand and on the owner's say-so. A bounded first
 * window that reports what it missed, plus a way to go back for it, beats an unbounded guess.
 */
export const FIRST_WINDOW = 24;

/** The header over messages this pass is actually about. */
export const NEW_HEADER = 'New since the last look:';

/**
 * Split a window of messages at the high-water mark.
 *
 * @param {Array<{mid: number, key: string, name?: string, text: string}>} messages Candidates,
 *   oldest first, already filtered to the ones worth reading.
 * @param {object} [options] Options.
 * @param {number} [options.size] How many trailing messages to include in total.
 * @param {{mid: number, key: string}} [options.mark] The persisted high-water mark.
 *
 * `sources` and `seen` answer different questions.
 *
 * `sources` is the new half: what may ANCHOR an event and carry a delta. `seen` is the whole
 * window: what the model could be RE-telling. The already-recorded gate needs the second one,
 * a refusal that rests on a beat outside this window is refusing something the model cannot see
 * (`state-table.js` `validateInventory`, and the measurement in its docblock).
 *
 * A pass that has never run reaches back to the opening.
 *
 * No mark means nothing here has ever been read, and the greeting is where a card states the
 * premise and the starting kit. See `FIRST_WINDOW` for the measurement and for why it is bounded.
 *
 * @returns {{text: string, newText: string, sources: Array<{key: string, mid: number}>,
 *   seen: number[], unread: number, context: number, mark: number|null}} The window: `text` for the
 *   prompt, `newText` for the mention gate, `sources` for anchoring, new half only, `seen` for
 *   every mid displayed, `unread` for what it could not reach, and `context` for background count.
 */
export function splitWindow(messages, { size = 6, mark = {} } = {}) {
    const all = messages ?? [];
    // Resolved against the FULL list, not the slice: a mark that still stands means this is not the
    // first pass, however short the chat is, and the reach-back is only for the pass that has none.
    // `readFrontier` rather than `resolveMark` because the two nulls it collapses are different
    // facts, see its docblock, and the ten duplicate events one of them wrote in Raccoon City.
    const frontier = readFrontier(all, mark);
    const started = frontier.state !== FRONTIER_FRESH;
    const window = all.slice(-Math.max(1, started ? size : FIRST_WINDOW));
    // The frontier resolves against the whole chat; the split is about this window. A mark that sits
    // below the trailing window leaves nothing to label as context, exactly as before.
    const at = window.some(message => message.mid === frontier.at) ? frontier.at : null;

    const older = at === null ? [] : window.filter(message => message.mid <= at);
    const fresh = at === null ? window : window.filter(message => message.mid > at);
    const line = (message) => `${message.name ?? 'Unknown'}: ${message.text}`;

    const newText = fresh.map(line).join('\n\n');
    const text = [
        older.length ? `${CONTEXT_HEADER}\n${older.map(line).join('\n\n')}` : '',
        `${NEW_HEADER}\n${newText}`,
    ].filter(Boolean).join('\n\n');

    return {
        text,
        newText,
        // Only the new half may anchor an event or carry a delta. `chronicle.applyExtraction`
        // attributes everything to the last of these, so an empty new half must never be papered
        // over with an old source, the caller declines the pass instead.
        sources: fresh.map(message => ({ key: message.key, mid: message.mid })),
        // Both halves. Reported even when `sources` is empty: a pass that declines still displayed
        // these mids, and the question `seen` answers is about display, not about anchoring.
        seen: window.map(message => message.mid).filter(Number.isFinite),
        // Messages the first pass could not reach. Only a pass with NO MARK AT ALL can leave any:
        // once a mark has been written, everything below it was read by the pass that wrote it, and
        // a mark that has merely stopped resolving is healed above rather than mistaken for a chat
        // nobody has looked at. That mistake is what put 145 and 97 into this counter in two chats
        // that had been read from message 1, see `readFrontier`.
        //
        // Non-zero now means what it always claimed to mean: fold was switched on partway through a
        // chat, and these messages are below the reach-back. `runBackfill` is what fills them.
        unread: started ? 0 : Math.max(0, all.length - window.length),
        context: older.length,
        mark: at,
        // A corrected mark to write back, when the stored one named a message this chat no longer
        // has. Null on every ordinary pass. Returned rather than applied because this file is pure
        // and the clock is the caller's.
        heal: frontier.heal,
    };
}

/**
 * Whether an extraction reply ends the retry loop.
 *
 * A repaired reply is not a whole reply.
 *
 * `json-parse.js` Tier 3 closes the unbalanced brackets of a cut-off reply and hands back
 * `{value: repaired, truncated: true}`. That is right for the parser, everything the model managed
 * to say is in there, and it is cheaper than a retry when the tail was empty anyway. It was wrong
 * for the loop, which tested `analysis.value || (!analysis.empty && !analysis.truncated)` and so
 * broke on the truthy repaired value, spending none of the tripled budget `RETRY_GROWTH` exists to
 * spend on exactly this shape.
 *
 * What that cost is not random. The model emits properties in schema order and the probes assemble
 * in registration order, so a cut-off reply always loses the TAIL, and a probe whose key never
 * arrived reads `undefined` at the apply loop and no-ops in silence, indistinguishable from a probe
 * that had nothing to say. The repaired value is still kept as the last-attempt fallback by the
 * caller; it is simply no longer allowed to end the loop on the first try.
 *
 * `unparseable` still settles immediately, and that is unchanged: a reply the parser cannot read at
 * all is structural, schema, prompt or model, and asking again returns the same garbage.
 *
 * @param {{value: any, truncated: boolean, empty: boolean}|null} analysis From `analyzeExtraction`.
 * @returns {boolean} True when there is nothing to gain from another attempt.
 */
export function extractionSettled(analysis) {
    if (!analysis) {
        return false;
    }
    if (analysis.truncated) {
        return false;
    }
    return !!analysis.value || !analysis.empty;
}

/**
 * Which probes the reply never answered.
 *
 * Only an ABSENT key counts. `{}`, `[]` and `null` are what a probe with nothing to report
 * legitimately sends, and conflating those with a truncation would report a failure on every quiet
 * pass: the same conflation `zero is silence` refuses everywhere else in this codebase.
 *
 * @param {object|null} parsed The parsed reply.
 * @param {string[]} keys Schema keys of the probes that rode this pass.
 * @returns {string[]} The keys that never arrived, in the order they were asked for.
 */
export function missingProbes(parsed, keys) {
    return (keys ?? []).filter(key => parsed?.[key] === undefined);
}

/**
 * ══ Backfill: reading a span the forward pass never reached ══
 *
 * `splitWindow` only ever looks at the tail. That is right for a pass that runs every turn and wrong
 * for the one case it cannot serve: a chat switched on at message 200, whose first 176 messages are
 * below `FIRST_WINDOW` and which nothing will ever read. `unread` reports that honestly and could do
 * nothing about it, and reporting a hole is not the same as being able to fill it.
 *
 * The machinery below is the same window in a different direction. A span is cut into bounded
 * chunks, each chunk is a window with a run-up of context and a billable half, and the caller runs
 * them through the same probes, the same schema and the same retry loop the live pass uses.
 *
 * Three rules make that safe, and each is a function here rather than a hope:
 *
 *   `planBackfill`     what will be read, in what order, and how many model calls it is. Forward,
 *                      oldest first, see its docblock for why not backward.
 *   `backfillStamp`    where a recovered event lands in a ledger that is ordered by wall clock.
 *   `withoutDeltas`    what a recovered event is NOT allowed to do to the arithmetic.
 */

/**
 * Messages billed per backfill chunk.
 *
 * Bounded by what a billed window of 24 measurably did to the story.
 *
 * A backfill chunk is shaped like a FIRST pass, not like a steady-state one: every message in it is
 * new, so every one may anchor an event, and they all have to fit in one reply's budget. The corpus
 * contains exactly one billed window that big, Raccoon City's accidental 24-message re-read
 * (`readFrontier`), and it is the measurement. At the same 800-token budget it returned 10 events
 * for 24 messages, each one spanning several beats ("Solomon eats tuna, drinks water, and observes
 * the RPD for two hours, then takes a nap"), where the forward passes over that same stretch had
 * returned 11 finer-grained ones. Nothing was dropped; the granularity was.
 *
 * Twelve is half of that, so a chunk's output has roughly the room a live pass's does, at the price
 * of one extra call per 24 messages. The 97-message span in the brief is 9 calls at 12 and 5 at 24,
 * a difference of four calls against a measured loss of resolution in the record being rebuilt. That
 * trade is a judgement, not a measurement, which is why `chunk=` overrides it.
 */
export const BACKFILL_CHUNK = 12;

/**
 * Messages of run-up shown before each chunk and NOT billed.
 *
 * The same argument `splitWindow`'s overlap rests on: an event whose setup is in the previous
 * message and whose consequence is in this one gets extracted with no idea what it was about. Two is
 * what the live window carries in practice (size 6, ~4-5 of overlap consumed by the mark), applied
 * here to the chunk boundary instead of the turn boundary.
 */
export const BACKFILL_CONTEXT = 2;

/**
 * Plan a backfill over the messages below `to`.
 *
 * Forward through the hole, not backward from its edge.
 *
 * The obvious shape is to walk back from the read frontier in chunks, so a run stopped halfway
 * leaves a covered span adjoining the history that is already read. Two things argue against it and
 * both are decisive:
 *
 *   · A chunk's meaning is in what came BEFORE it. Walking forward, the previous chunk is the
 *     run-up (`BACKFILL_CONTEXT`) and it is free, because it has just been read. Walking backward
 *     the context available is what comes AFTER, which explains nothing about setup.
 *   · The prize is at message 0. The whole argument for `FIRST_WINDOW` is that cards put the
 *     premise, the sheet and the starting kit in the greeting, the live Wuxia card's storage ring
 *     with its medicinal pill and its basic iron sword. A backward walk reaches that last, so a run
 *     the owner stops early recovers everything except the reason he ran it.
 *
 * Forward also makes resumption one number, the highest mid covered, which is the same shape as
 * the read mark and cannot express a gap it would then have to remember.
 *
 * @param {Array<{mid: number, key: string, name?: string, text: string}>} messages Candidates,
 *   oldest first, already filtered the way `buildWindow` filters them.
 * @param {object} [options] Options.
 * @param {number} [options.to] Exclusive ceiling: the oldest mid the forward pass has read.
 * @param {number} [options.done] Highest mid already backfilled; -1 when none.
 * @param {number} [options.chunk] Messages billed per call.
 * @returns {{chunks: Array<object>, calls: number, messages: number, from: number, to: number,
 *   reason: string}} The plan. `reason` is non-empty exactly when there is nothing to do.
 */
export function planBackfill(messages, { to = NaN, done = -1, chunk = BACKFILL_CHUNK } = {}) {
    const all = messages ?? [];
    const ceiling = Number(to);
    const size = Math.max(1, Math.trunc(Number(chunk) || BACKFILL_CHUNK));
    const empty = (reason) => ({ chunks: [], calls: 0, messages: 0, from: NaN, to: ceiling, reason });

    if (!all.length) {
        return empty('empty-chat');
    }
    if (!Number.isFinite(ceiling)) {
        // Refusing rather than guessing a ceiling. A backfill that runs over messages the forward
        // pass already read is money spent to write duplicates, the exact damage the mark-loss bug
        // did by accident, and it must not be reintroduced as a feature.
        return empty('no-ceiling');
    }
    const below = Number.isFinite(done) ? Number(done) : -1;
    const span = all.filter(message => message.mid < ceiling && message.mid > below);
    if (!span.length) {
        return empty('nothing-to-backfill');
    }

    const chunks = [];
    for (let at = 0; at < span.length; at += size) {
        const fresh = span.slice(at, at + size);
        const first = fresh[0].mid;
        // The run-up comes from the FULL list, so the first chunk after a resume is preceded by the
        // tail of what the previous run already read rather than by nothing.
        const older = all.filter(message => message.mid < first).slice(-BACKFILL_CONTEXT);
        chunks.push(backfillWindow(older, fresh));
    }

    return {
        chunks,
        calls: chunks.length,
        messages: span.length,
        from: span[0].mid,
        to: ceiling,
        reason: '',
    };
}

/**
 * One backfill chunk, in the shape `splitWindow` returns so the caller cannot tell them apart.
 *
 * @param {Array<object>} older Run-up, shown and not billable.
 * @param {Array<object>} fresh The chunk, billable.
 * @returns {object} The window.
 */
function backfillWindow(older, fresh) {
    const line = (message) => `${message.name ?? 'Unknown'}: ${message.text}`;
    const newText = fresh.map(line).join('\n\n');
    return {
        text: [
            older.length ? `${CONTEXT_HEADER}\n${older.map(line).join('\n\n')}` : '',
            `${NEW_HEADER}\n${newText}`,
        ].filter(Boolean).join('\n\n'),
        newText,
        sources: fresh.map(message => ({ key: message.key, mid: message.mid })),
        seen: [...older, ...fresh].map(message => message.mid).filter(Number.isFinite),
        unread: 0,
        context: older.length,
        mark: older.length ? older[older.length - 1].mid : null,
        heal: null,
    };
}

/**
 * Median seconds between two consecutive messages, in milliseconds.
 *
 * Measured over the corpus: 3,168 consecutive message pairs under an hour apart across 21 live
 * chats, median 34.7s (mean 91.1s, skewed by the pauses). Used only to space recovered events that
 * have no later event to interpolate against, so only the ORDER it produces matters, but a number
 * taken from the chats beats a round one invented here.
 */
export const BACKFILL_SPACING = 35_000;

/**
 * Where a recovered event belongs in a ledger ordered by wall clock.
 *
 * The ordering hazard, and the half of it that this solves.
 *
 * `deriveState` folds the chronicle in `t` order (`state-table.js:2373`, `sort((a, b) => a.t - b.t)`)
 * and `t` is `Date.now()` at the moment the pass ran (`chronicle-table.js:154`). A backfilled event
 * stamped now would therefore sort AFTER everything, and an event recovered from message 3 would be
 * the newest thing the ledger knows, newest in the chronicle view, newest for recall's recency, and
 * last to be evicted when the budget bites.
 *
 * So the stamp is derived from the ledger's own mid→t anchors instead. Between two events the
 * recovered one is interpolated by mid; below all of them it is spaced backward by the corpus median
 * gap. Both are monotone in mid, which is the only property that matters: a recovered event reads as
 * old news everywhere `t` is read, and two recovered events from the same span stay in story order.
 *
 * This does NOT make it safe to fold a recovered DELTA, see `withoutDeltas`, which is the other
 * half and the load-bearing one.
 *
 * @param {Array<{mid: number, t: number}>} anchors Live events that carry both a mid and a stamp.
 * @param {number} mid The message the recovered event is anchored on.
 * @param {number} [now] Fallback when the ledger has no anchors at all.
 * @returns {number} The stamp.
 */
export function backfillStamp(anchors, mid, now = Date.now()) {
    const sorted = (anchors ?? [])
        .filter(anchor => Number.isFinite(anchor?.mid) && Number.isFinite(anchor?.t))
        .sort((a, b) => a.mid - b.mid || a.t - b.t);
    let before = null;
    let after = null;
    for (const anchor of sorted) {
        if (anchor.mid <= mid) {
            before = anchor;
        } else {
            after = anchor;
            break;
        }
    }
    if (!after && !before) {
        return now;
    }
    if (!after) {
        // Nothing later on record. Cannot happen for a hole below the read frontier; kept total
        // because a pure function that throws on an empty ledger is a pure function nobody can test.
        return before.t;
    }
    if (!before) {
        return after.t - BACKFILL_SPACING * Math.max(1, after.mid - mid);
    }
    const span = after.mid - before.mid;
    const slid = span > 0
        ? before.t + Math.round((after.t - before.t) * (mid - before.mid) / span)
        : before.t;
    // Clamped into the bracket. A ledger whose stamps do not ascend with its mids (a swipe re-anchor,
    // an imported chat) must not push a recovered event outside the pair that brackets it.
    return Math.min(Math.max(slid, before.t), after.t);
}

/**
 * Declines that happen BEFORE the request goes out.
 *
 * Every one of these is `runExtraction` refusing to start: a live pass already holds `busy`, the
 * user changed chat, the window has no billable half, the messages are no longer on this branch. No
 * model saw the chunk.
 */
export const UNSENT = new Set(['busy', 'chat-changed', 'no-probes', 'empty-window', 'nothing-new', 'sources-not-live']);

/**
 * Did this chunk get read, for the purpose of advancing the backfill frontier?
 *
 * The one way this mechanism could silently skip what it exists to recover.
 *
 * A chunk the model READ and could not answer for is done: the stretch is established as unreadable
 * by the current model and paying for it again changes nothing, so the frontier moves past it and a
 * counter records the hole. The same rule applied to a chunk that was never SENT would mark
 * messages as recovered that nothing has looked at, and it would look like a completed run, which
 * is the failure mode this whole session is about. So the two are distinguished here rather than in
 * the driver, where they cannot be tested.
 *
 * @param {{ok: boolean, reason?: string}|null} result What `runExtraction` returned.
 * @returns {boolean} True when a call was spent and the frontier may advance.
 */
export function chunkRead(result) {
    if (!result) {
        // An outcome nobody produced says nothing about whether a call was spent, and the two
        // mistakes are not symmetric: stopping the run costs a re-invocation, advancing past an
        // unread chunk costs the messages themselves. Stop.
        return false;
    }
    return !!result.ok || !UNSENT.has(String(result.reason ?? ''));
}

/**
 * Strip the state deltas from a recovered extraction fragment.
 *
 * This is the ordering hazard's real answer: backfill is additive to the RECORD, never to the
 * ARITHMETIC.
 *
 * Inventory is a fold over deltas, so re-reading an old message and crediting what it established
 * double-counts whatever the forward pass has ALREADY absorbed by other means. The case is the one
 * `FIRST_WINDOW` is written about: the Wuxia card's greeting lists `1x Basic Iron Sword` in the
 * storage ring, the opening was never read, and the player's later mention of a sword is the only
 * sword the ledger ever saw, so it was credited then. Recovering the greeting now adds a second
 * one. Nothing in the record can tell the two apart, because the evidence that they are one sword is
 * in the messages that were never read.
 *
 * Which is not a bug in the stamp and cannot be fixed by placing the event earlier: fold order is
 * irrelevant to a sum, and the pair sums to two swords in either order. It is only fixable by
 * refusing to sum. So a recovered event carries its summary, its keywords and its anchor, the
 * things that make it retrievable, which is what backfill is FOR, and carries no `delta`.
 *
 * The versioned tables (`merge_entity` and friends, last-write by `turn`) are refused a different
 * way, by the caller: a recovered pass runs only the probes whose output is a record of the past.
 * `merge_entity` ties precedence and freshness to one field (`entity-table.js:930`, and `prune` sheds
 * anything more than `ENTITY_STALE * 2` = 40 turns old at `entities.js:586`), so there is no turn
 * stamp for a recovered sighting that is both too old to overwrite the present and fresh enough to
 * survive the next pass. That is a real limitation and it is stated here rather than papered over.
 *
 * @param {any} fragment The `events` fragment from the reply.
 * @returns {any} The same fragment with every `delta` removed.
 */
export function withoutDeltas(fragment) {
    if (!Array.isArray(fragment)) {
        return fragment;
    }
    return fragment.map((candidate) => {
        if (!candidate || typeof candidate !== 'object' || candidate.delta === undefined) {
            return candidate;
        }
        const rest = { ...candidate };
        delete rest.delta;
        return rest;
    });
}
