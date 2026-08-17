/**
 * fold/extract-table.js — the pure half of the extraction window.
 *
 * Dependency-free and unit-testable, like every other `*-table` module here. `extract.js` owns the
 * request, the retry and the probes; this owns the one question that turned out to be worth its own
 * file: *which of these messages is the model allowed to bill?*
 *
 * ── The overlap was paying for the same beat three times ──
 *
 * `buildWindow` took the trailing N messages every pass, and the pass runs every one to two turns
 * (`trigger-table.js` MIN_INTERVAL, `index.js` onAssistantMessage), so consecutive windows overlap
 * by four or five messages. Every event is attributed to the newest source in its window
 * (`chronicle.js:222-225`), so the same beat read three passes running produces three events with
 * three different anchors — and the exact dedup (same anchor, same content) and the semantic dedup
 * (`chronicle-table.js:285-292`, keyword-signature equality) both miss, because neither is looking
 * at the same key twice.
 *
 * Measured in the live Solo Leveling ledger: the phone-number exchange is recorded at mids 50, 52
 * and 54; the ahjumma's two candies at 54 and 58 (so the fold says four); the goblin knife at 22
 * and 38; the staff-and-shortsword purchase at 60, 66 and 68.
 *
 * The fix keeps the overlap and removes the billing. Messages up to a persisted high-water mark are
 * labelled as context the model may read and may not extract from; messages past it are the new
 * half, and only those are handed to the probes as sources. The model still sees the run-up — which
 * is why the window existed at all, since a beat's meaning is usually in the message before it —
 * but the anchor set no longer contains anything already looked at.
 *
 * Rejected alternative: shrink the window to exactly the new messages. That was the first shape and
 * it is worse in the way the overlap was introduced to fix — an event whose consequence lands in
 * the new half and whose setup is in the old one gets extracted with no idea what it was about, and
 * the summary comes back as "he agrees" with no referent.
 */

/**
 * Where the last pass stopped reading, resolved against the chat as it is NOW.
 *
 * ── A mid alone is not a safe mark, and swiping is why ──
 *
 * A high-water mark stored as a message index says "everything up to here has been looked at". A
 * swipe rewrites the newest message in place: the index is unchanged and the content is not, so a
 * bare mid would file brand-new narration under "already recorded" and no pass would ever read it.
 * That is not a hypothetical — swiping the newest reply is the single most common thing a user does
 * to a chat, and this mechanism is the only one in fold that could be defeated by it.
 *
 * So the mark carries the content key of the message it was set on — the same `contentKey` hash the
 * chronicle already uses to decide which events are live on this branch (`chronicle.js:59-84`) —
 * and is validated on every read:
 *
 *   · no mark, or a mark on a mid the chat no longer has (a deleted message, a shorter branch):
 *     the mark is meaningless, so return null and let the whole window be new. Re-reading is
 *     wasteful; skipping is wrong, and the two are not symmetric.
 *   · the key at that mid no longer matches: that message was swiped or edited, so it becomes new
 *     again — the mark retreats by one. Computed on read rather than persisted, so it stays
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

/** The header over messages the model may read but may not extract from. */
export const CONTEXT_HEADER = 'Earlier, for context only (already recorded — extract nothing from this):';

/**
 * How far back the FIRST pass may reach.
 *
 * ── The opening is the one message nobody else reads ──
 *
 * Cards put the premise, the character sheet and the starting equipment in the greeting. Fold had
 * two ways to read it and used neither: `absorb` needs `findStateBlock` to recognise the card's
 * delimiters, and the extraction window is the trailing `size`, so by the time the first pass fires
 * — `MIN_INTERVAL` is 2 — the greeting has already slid out of it.
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
 * ── `sources` and `seen` answer different questions ──
 *
 * `sources` is the new half: what may ANCHOR an event and carry a delta. `seen` is the whole
 * window: what the model could be RE-telling. The already-recorded gate needs the second one —
 * a refusal that rests on a beat outside this window is refusing something the model cannot see
 * (`state-table.js` `validateInventory`, and the measurement in its docblock).
 *
 * ── A pass that has never run reaches back to the opening ──
 *
 * No mark means nothing here has ever been read, and the greeting is where a card states the
 * premise and the starting kit. See `FIRST_WINDOW` for the measurement and for why it is bounded.
 *
 * @returns {{text: string, newText: string, sources: Array<{key: string, mid: number}>,
 *   seen: number[], unread: number, context: number, mark: number|null}} The window: `text` for the
 *   prompt, `newText` for the mention gate, `sources` for anchoring — new half only — `seen` for
 *   every mid displayed, `unread` for what it could not reach, and `context` for background count.
 */
export function splitWindow(messages, { size = 6, mark = {} } = {}) {
    const all = messages ?? [];
    // Resolved against the FULL list, not the slice: a mark that still stands means this is not the
    // first pass, however short the chat is, and the reach-back is only for the pass that has none.
    const started = resolveMark(all, mark) !== null;
    const window = all.slice(-Math.max(1, started ? size : FIRST_WINDOW));
    const at = resolveMark(window, mark);

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
        // over with an old source — the caller declines the pass instead.
        sources: fresh.map(message => ({ key: message.key, mid: message.mid })),
        // Both halves. Reported even when `sources` is empty: a pass that declines still displayed
        // these mids, and the question `seen` answers is about display, not about anchoring.
        seen: window.map(message => message.mid).filter(Number.isFinite),
        // Messages nothing will EVER read. Only the first pass can leave any: once a mark exists,
        // everything below it was read by the pass that set it. Non-zero means fold was enabled on
        // a chat already in progress, and it is worth saying out loud rather than discovering later
        // that the ledger began life not knowing what was in the first two hundred messages.
        unread: started ? 0 : Math.max(0, all.length - window.length),
        context: older.length,
        mark: at,
    };
}
