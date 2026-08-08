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
 * @returns {{text: string, newText: string, sources: Array<{key: string, mid: number}>,
 *   context: number, mark: number|null}} The window: `text` for the prompt, `newText` for the
 *   mention gate, `sources` for anchoring — new half only — and `context` for how many messages
 *   were shown as background.
 */
export function splitWindow(messages, { size = 6, mark = {} } = {}) {
    const window = (messages ?? []).slice(-Math.max(1, size));
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
        context: older.length,
        mark: at,
    };
}
