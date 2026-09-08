/**
 * sanguine/reject-table.js: what fold refused, and what refusing it MEANT.
 *
 * A leaf. No imports, deliberately, the same reason `metadata-key.js` is one: `diagnostics-view.js`
 * imports `script.js` (for `showMoreMessages`), so anything living beside it is unreachable from the
 * node test environment, and a classification nothing can test is a classification that drifts.
 * Everything here is a pure lookup over a reason string.
 */

/**
 * What a refusal MEANS, which is not the same question as what it was.
 *
 * One number for four different things.
 *
 * The rejections section counted every refusal into one total, painted it `crit`, and captioned it
 * "Every one is a validation gate doing its job". Both halves cannot be true, and neither was.
 * Measured on the live Wuxia chat of 2026-08-20 at turn 76, fifty-one refusals:
 *
 *     already-recorded   15    the double-bill guard. Its own docblock cites the spear billed
 *                              twice, the room rental twice, the locket twice. Refusing SAVED the
 *                              record; there is nothing here to fix.
 *     unknown-id         16    the world block's two sections being cross-filed. Nobody's record
 *                              was protected, sixteen answers were paid for and thrown away.
 *     no-change          12    the model naming a row and asserting nothing about it.
 *     remove-unknown      4    guard.
 *     not-mentioned       3    the coverage gate. Guard.
 *     invariant:…         1    no model proposed anything at all.
 *
 * Twenty-two of those fifty-one are the system working. Presenting them beside sixteen wasted
 * answers, at one weight and in one alarming colour, tells the reader to go and fix the parts that
 * are protecting them, and buries the one population that is actually costing them something.
 *
 * So each reason declares which of four things a refusal of that kind IS:
 *
 *   GUARD   the proposal was wrong and refusing it protected the record. Nothing to fix. A rising
 *           count here is the model getting sloppier, not fold getting worse.
 *   WASTE   the answer was lost to HOW FOLD ASKED, a confusing block, a schema that invited a
 *           no-op. This is the only class where the fix is on this side of the wire.
 *   CAP     a bound was reached. The proposal may have been perfect. Read it as a budget signal.
 *   LEDGER  no model was involved (`invariant:*`). The record disagrees with itself, and the cause
 *           is an earlier event that was never recorded, the fix is never "prompt better", as the
 *           invariant help lines below already say.
 *
 * @param {string} reason A rejection reason.
 * @returns {string} One of `GUARD`, `WASTE`, `CAP`, `LEDGER`.
 */
export const GUARD = 'guard';
export const WASTE = 'waste';
export const CAP = 'cap';
export const LEDGER = 'ledger';

/** Every reason fold files, and what refusing it means. `sanguine-reject-class.test.js` pins coverage. */
const REJECT_CLASS = Object.freeze({
    // Guards: the proposal contradicted the record, and refusing it is the end state.
    'not-mentioned': GUARD,
    'already-recorded': GUARD,
    'remove-unknown': GUARD,
    'already-held': GUARD,
    'implausible-delta': GUARD,
    'implausible-max': GUARD,
    'implausible-tick': GUARD,
    'clamped-underflow': GUARD,
    'unknown-owner': GUARD,
    'exposition': GUARD,
    // Retired producer, live data.
    //
    // `unusable-steps` was raised when a drive nomination answered "it completes" with fewer than
    // two steps. That gate is gone, the floor is clamped now, the same way the ceiling always was
    //, but the counter is CUMULATIVE and the live Wuxia blob still carries 7 of them. A reason
    // whose producer has been deleted still has to explain itself for as long as a reader can see
    // it, or the tally shows a number with the generic fallback sentence under it.
    'unusable-steps': GUARD,
    'clock-reversed': GUARD,
    'place-cycle': GUARD,
    'place-destroyed': GUARD,
    'money:drift': GUARD,
    'review-unmergeable': GUARD,
    'merge-conflict': GUARD,
    'unknown-target': GUARD,
    'wrong-op': GUARD,
    'no-evidence': GUARD,

    // Waste: fold asked badly, and the answer died on the way back.
    'unknown-id': WASTE,
    'duplicate-id': WASTE,
    'no-change': WASTE,
    'unusable-name': WASTE,
    'unusable-amount': WASTE,
    'block-shadow': WASTE,
    'flow-unusable': WASTE,
    'review-unknown-id': WASTE,
    'review-wrong-shape': WASTE,
    'review-unreadable-amount': WASTE,
    'sheet-unnamed': WASTE,
    'sheet-unknown-kind': WASTE,

    // Caps: nothing was wrong with the answer; the table was full.
    'rate-limited': CAP,
    'abilities-full': CAP,
    'inventory-full': CAP,
    'vitals-full': CAP,
    'flags-full': CAP,
    'threads-full': CAP,
    'entities-full': CAP,
    'parts-full': CAP,
    'places-full': CAP,
    'flows-full': CAP,

    // Ledger: no model spoke. The record contradicts itself.
    'invariant:overdraw': LEDGER,
    'invariant:negative-quantity': LEDGER,
    'invariant:unbacked-debit': LEDGER,
    'invariant:split-name': LEDGER,
    'invariant:split-currency': LEDGER,
    'invariant:partition-contradiction': LEDGER,
});

/**
 * Which of the four a reason is.
 *
 * Unknown reasons answer `GUARD`, deliberately: an unclassified refusal is most likely a gate
 * somebody added without coming back here, and the conservative reading is "the record was
 * protected" rather than "go and fix something". The build gate is what stops that default from
 * quietly swallowing a new reason, `tests/sanguine-reject-class.test.js` fails when a reason
 * `rejectHelp` explains has no class declared here.
 *
 * @param {string} reason A rejection reason.
 * @returns {string} `GUARD`, `WASTE`, `CAP` or `LEDGER`.
 */
export function rejectClass(reason) {
    // `invariant:` is a namespace, not a fixed list, a new witness kind added to `invariant-table`
    // is still a ledger contradiction whatever it is called.
    if (String(reason ?? '').startsWith('invariant:')) {
        return LEDGER;
    }
    return REJECT_CLASS[String(reason ?? '')] ?? GUARD;
}

/** Every reason with a declared class, for the build gate. @returns {string[]} Reasons. */
export function classifiedReasons() {
    return Object.keys(REJECT_CLASS);
}

/**
 * Tally refusals by what they mean.
 *
 * @param {Array<{reason: string, count: number}>} groups Reason groups.
 * @returns {{guard: number, waste: number, cap: number, ledger: number, total: number}} The split.
 */
export function classifyRejects(groups) {
    const out = { [GUARD]: 0, [WASTE]: 0, [CAP]: 0, [LEDGER]: 0, total: 0 };
    for (const group of Array.isArray(groups) ? groups : []) {
        const count = Number(group?.count) || 0;
        out[rejectClass(group?.reason)] += count;
        out.total += count;
    }
    return out;
}

/* Acknowledgement: what is NEW, without destroying what came before. */

/**
 * How many acknowledgement marks a chat keeps, newest included.
 *
 * Five, and the binding constraint is bytes rather than taste.
 *
 * A mark is `{ts, at, r: {reason: count}, c}`. Measured against the live Wuxia chat of 2026-08-20,
 * which carries eight reasons (`unknown-id 24, already-recorded 20, remove-unknown 15,
 * not-mentioned 13, no-change 12, unusable-steps 7, invariant:partition-contradiction 2,
 * already-held 1`), one mark serialises to roughly 280 bytes. That chat's blob is 127,765 B of
 * `store.js` `MAX_FOLD_BYTES` 131,072, 3,307 bytes of headroom, total. Five marks is ~1.4 KB, or
 * 42% of everything that chat has left.
 *
 * That is the whole argument for the number. Four spans is enough to see a trend across four
 * changes and stop; ten would be a comparison surface that pushes the chronicle out of the chat it
 * is measuring, which is the trade `store.js` `PRUNE_DIAGNOSTICS` exists to refuse.
 *
 * It is also why a mark stores the cap firings as ONE INTEGER rather than per rule. The caps
 * population is rendered in exactly one place, the "dropped by a cap, unasked" figure in the
 * rejections section, and never per rule, so per-rule baselines would be ~260 bytes a mark of
 * storage nothing reads. The cost is that a cap counter which goes DOWN cannot be floored per rule,
 * only in aggregate; see `ackSpans`.
 */
export const MAX_ACK_MARKS = 5;

/**
 * Mark keys in write order.
 *
 * Sorted on the KEY, and on its two halves as NUMBERS.
 *
 * A key is `<ms>:<seq>`, the same shape `log.js` uses. Lexicographic order is wrong for it the
 * moment `seq` reaches ten within one millisecond ('10' sorts before '9'), which is exactly what a
 * test that acknowledges in a loop produces, and a mark list in the wrong order silently turns
 * every span in the rate view into a subtraction between the wrong two points.
 *
 * The key rather than the stored `ts` because the key is what this module controls: a blob edited by
 * hand, or carried across a clock change, can hold a `ts` that disagrees with the order the marks
 * were actually written in, and a span is only meaningful in write order.
 *
 * @param {string[]} keys Mark keys.
 * @returns {string[]} The same keys, oldest first.
 */
export function sortAckKeys(keys) {
    const parts = (key) => {
        const [ts, seq] = String(key).split(':');
        return [Number(ts) || 0, Number(seq) || 0];
    };
    return [...(Array.isArray(keys) ? keys : [])].sort((a, b) => {
        const left = parts(a);
        const right = parts(b);
        return left[0] - right[0] || left[1] - right[1];
    });
}

/**
 * The keys past the bound, which a write drops to keep the list at `MAX_ACK_MARKS`.
 * @param {string[]} keys Mark keys, any order.
 * @returns {string[]} Keys to delete, oldest first.
 */
export function excessMarkKeys(keys) {
    const ordered = sortAckKeys(keys);
    return ordered.slice(0, Math.max(0, ordered.length - MAX_ACK_MARKS));
}

/**
 * The keys a budget pruner sheds, the oldest half of the HISTORY, never the watermark.
 *
 * Half at a time, and the newest never.
 *
 * Half rather than all of it, the same shape as `log.js`: a blob 200 bytes over budget must not cost
 * four comparisons to save 200, and repeated passes converge on one mark. Never the newest, because
 * that one is the whole feature, losing the history costs a comparison, losing the watermark costs
 * the reader the 94 they asked never to see again, and because no 128 KiB blob was ever rescued by
 * shedding one object smaller than a single chronicle event.
 *
 * @param {string[]} keys Mark keys, any order.
 * @returns {string[]} Keys to delete, oldest first. Empty when only the watermark remains.
 */
export function shedMarkKeys(keys) {
    const ordered = sortAckKeys(keys);
    if (ordered.length <= 1) {
        return [];
    }
    return ordered.slice(0, Math.ceil((ordered.length - 1) / 2));
}

/**
 * `[{reason, count}]` as `{reason: count}`, which is how a mark stores its baseline.
 * @param {Array<{reason: string, count: number}>} rows Reason groups.
 * @returns {Record<string, number>} The counts.
 */
export function countsOf(rows) {
    const out = {};
    for (const row of Array.isArray(rows) ? rows : []) {
        const reason = String(row?.reason ?? '');
        if (reason) out[reason] = Number(row?.count) || 0;
    }
    return out;
}

/**
 * `{reason: count}` back as rows, busiest first.
 * @param {Record<string, number>} counts A stored baseline.
 * @returns {Array<{reason: string, count: number}>} The rows.
 */
function rowsOf(counts) {
    return Object.entries(counts && typeof counts === 'object' ? counts : [])
        .map(([reason, count]) => ({ reason, count: Number(count) || 0 }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * What has been refused SINCE a baseline, per reason and floored at zero.
 *
 * Three properties, and none of them survive a single subtraction of totals.
 *
 * 1. PER REASON. The tally is cumulative and a total-minus-total would let one reason's genuine
 *    rise cancel another's fall. They are different populations with different fixes, `unknown-id`
 *    is an answer fold threw away, `already-recorded` is a guard doing its job, and netting them
 *    against each other produces a number that describes nothing.
 *
 * 2. FLOORED AT ZERO, per reason. A counter can legitimately go DOWN: `repairs.revertPass` restores
 *    a whole blob snapshot around these tables (`observe.js` `restore` argues the same case from the
 *    other side), and `store.js` pruners shed. A negative must not be allowed to subtract itself
 *    from an unrelated reason's real count.
 *
 * 3. A REASON WITH NO BASELINE COUNTS IN FULL. Absent from the mark means it had not happened yet,
 *    so all of it is new, which is exactly what the reader is asking about. The live corpus proves
 *    this is not hypothetical in either direction: the same Wuxia chat carries `unusable-steps 7`
 *    under a reason string no file in the extension raises any more, so reasons both appear and
 *    stop appearing over the life of a chat.
 *
 * @param {Array<{reason: string, count: number}>} now The current tally, as `state.snapshot()` gives it.
 * @param {Record<string, number>} [baseline] The counts at acknowledgement, or nothing.
 * @returns {Array<{reason: string, count: number}>} Only reasons with something new, busiest first.
 */
export function newRejects(now, baseline) {
    const base = baseline && typeof baseline === 'object' ? baseline : {};
    const out = [];
    for (const row of Array.isArray(now) ? now : []) {
        const reason = String(row?.reason ?? '');
        if (!reason) continue;
        const fresh = (Number(row?.count) || 0) - (Number(base[reason]) || 0);
        if (fresh > 0) out.push({ reason, count: fresh });
    }
    return out.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * Log entries written after a watermark.
 *
 * The log ROTATES, so a stored count would decay into a lie.
 *
 * `log.js` `LOG_LIMIT` is 120 and its pruner sheds the oldest half whenever the blob is over budget,
 * so "there were 7 extraction failures when I acknowledged" stops being subtractable the moment
 * those seven age out, the live count would fall below the stored baseline and the difference would
 * read as zero forever, or worse, a later rotation would make an old failure look new. A timestamp
 * has no such decay: an entry is either newer than the moment the reader looked or it is not, and
 * that stays true however many entries around it are shed.
 *
 * @param {Array<{t: number}>} entries Log entries.
 * @param {number} [since] Epoch milliseconds; anything at or before it was already seen.
 * @returns {Array<object>} The entries newer than the watermark.
 */
export function newerThan(entries, since) {
    const floor = Number(since) || 0;
    return (Array.isArray(entries) ? entries : []).filter(entry => (Number(entry?.t) || 0) > floor);
}

/**
 * A count as a rate, or `null` when the span cannot carry one.
 *
 * Turn spans of zero are ORDINARY, not exceptional: acknowledging twice without playing between is
 * one click and a second thought, and `entities.turn()` does not move for either. `null` rather than
 * `Infinity` or `0` because both of those are readable as measurements and neither is true, the
 * renderer prints a dash and the reader is told nothing rather than told something false.
 *
 * @param {number} count What happened.
 * @param {number} turns How long it had to happen in.
 * @returns {number|null} Events per turn, or null.
 */
export function perTurn(count, turns) {
    const span = Number(turns) || 0;
    return span > 0 ? (Number(count) || 0) / span : null;
}

/**
 * The spans between acknowledgements, newest first, the "is it getting better" view.
 *
 * Why a rate and not a delta.
 *
 * A raw delta between two marks is not comparable across marks: 41 refusals over 60 turns and 12
 * over 12 are the same reader looking twice, and the second is nearly twice as bad. Dividing by the
 * turns the span actually covered is the only form in which the numbers answer the question that
 * was asked, which is whether a change helped.
 *
 * Why the split rides along.
 *
 * `rejectClass` exists because guard and waste move for different reasons: a guard firing more often
 * is the model getting sloppier, waste firing more often is fold asking worse. A combined rate can
 * hold a waste regression steady under a guard improvement and show no change at all, so the class
 * counts travel with every span and the renderer can show waste on its own line.
 *
 * The origin point is turn 0 with empty counts, so the OLDEST span covers the whole chat up to the
 * first acknowledgement. That is the baseline everything after it is being compared against, and
 * dropping it would leave the first real comparison with nothing to be a comparison to.
 *
 * @param {Array<{ts: number, at: number, r: Record<string, number>, c: number}>} marks Oldest first.
 * @param {{ts: number, at: number, r: Record<string, number>, c: number}} live The counters as they
 *   stand now, shaped like a mark, the open span's endpoint.
 * @returns {Array<object>} Spans, newest first, each `{from, to, open, turns, split, reasons, dropped}`.
 */
export function ackSpans(marks, live) {
    const origin = { ts: 0, at: 0, r: {}, c: 0 };
    const points = [origin, ...(Array.isArray(marks) ? marks : []), live];
    const spans = [];
    for (let i = 1; i < points.length; i++) {
        const from = points[i - 1];
        const to = points[i];
        const fresh = newRejects(rowsOf(to.r), from.r);
        spans.push({
            from,
            to,
            open: i === points.length - 1,
            // Floored for the same reason the per-reason subtraction is: a restored blob can move
            // `entities.turn()` backwards, and a negative denominator would invert every rate.
            turns: Math.max(0, (Number(to.at) || 0) - (Number(from.at) || 0)),
            split: classifyRejects(fresh),
            reasons: fresh.length,
            // Aggregate rather than per rule, see MAX_ACK_MARKS for what that buys and what it costs.
            dropped: Math.max(0, (Number(to.c) || 0) - (Number(from.c) || 0)),
        });
    }
    return spans.reverse();
}

export function rejectHelp(reason) {
    return ({
        'unusable-name': 'name was empty or not a usable token, use a short noun phrase.',
        'no-change': 'proposed no actual change, report only real changes, never zero deltas.',
        'rate-limited': 'too many changes this pass, the per-pass budget is full; the model over-reported.',
        'not-mentioned': 'the window the model read does not name this, only record changes the excerpt actually shows.',
        'already-recorded': 'the ledger already covers this acquisition, it was shown in the pinned block; report only new changes.',
        'remove-unknown': 'removing something the ledger does not hold, you cannot remove what was never gained.',
        'already-held': 'this condition is already on the record, unchanged, restating it is not a change. Report a condition when it arrives, worsens, or clears.',
        'money:drift': 'the story stated a balance the ledger disagrees with, the gap is a transaction that went unrecorded, not a rounding error. The stated total was adopted.',
        'unknown-id': 'answered a line the block never posed, use the ids exactly as printed.',
        'duplicate-id': 'answered the same line twice, one answer per id.',
        'abilities-full': 'too many distinct capabilities, the list is at its cap.',
        'inventory-full': 'too many distinct items, the list is at its cap.',
        'implausible-delta': 'magnitude implausible for one turn, a change this large is a hallucination.',
        'clamped-underflow': 'the change would drive a count below zero, clamped instead of recorded.',
        'vitals-full': 'too many tracked vitals, the table is at its cap.',
        'implausible-max': 'a vital max moved by more than half in one turn, a hallucination, not a level-up.',
        'unknown-owner': 'named a person fold has never heard of, use a name from the people list, or leave "who" empty for the player.',
        'flags-full': 'too many conditions on one person, the top three are kept, the rest escalate or displace.',
        'unusable-steps': 'a standing agenda was judged to complete in under two steps, which is a scene rather than an arc. No longer raised, the answer is clamped to the two-step floor instead, so this count cannot grow.',
        'exposition': 'reads as background, not an open stake, phrase the unresolved part ("still unknown", "not yet") or leave it out.',
        'implausible-tick': 'a dial advanced by more than 3 in one turn, a tick measures pressure, not bodies.',
        'threads-full': 'too many open threads, close some, or drop it.',
        'entities-full': 'too many tracked people, the cast is at its cap.',
        'clock-reversed': 'a dial ticked the wrong way for its polarity.',
        // Gates that had no sentence here, and so rendered as the generic line.
        //
        // Every one of these is a real refusal in a live chat that the log could only describe as
        // "failed the corresponding validation gate". A precise refusal explained imprecisely is
        // worse than useless: it teaches the player that the reason column is noise.
        'parts-full': 'no room for another component, either this row is at its six, or the chat is at its twenty-four. Forget one before recording another.',
        'place-destroyed': 'that place no longer stands, so nothing can be put inside it. Rebuild the record first, or name a place that still exists.',
        'places-full': 'too many tracked places, the map is at its cap. The stalest leaves are archived to the cold store first.',
        'place-cycle': 'that parent would put a place inside itself, the place was kept and the parent dropped, not the other way round.',
        'flows-full': 'too many standing flows, the table is at its cap; end one before starting another.',
        'flow-unusable': 'the flow had no readable rate, a flow needs an amount and a period ("40 a week").',
        'block-shadow': 'the card wrote prose into a field that holds structure, it is kept verbatim under "Not parsed" rather than thrown away, but nothing reads it.',
        'review-unknown-id': 'the review answered a line the block never posed, use the ids exactly as printed.',
        'review-wrong-shape': 'the review filed an answer where a disposition belongs, answer the question that was asked, in the shape it was asked in.',
        'review-unreadable-amount': 'the review gave an amount nothing could read as a number.',
        'review-unmergeable': 'the two rows the review proposed merging cannot be merged, they are different kinds of thing.',
        'sheet-unnamed': 'a sheet field arrived with no label, a value with no name cannot be filed anywhere.',
        'sheet-unknown-kind': 'a sheet field arrived under a kind fold does not model.',
        // Invariants: nobody proposed anything, the ledger simply disagrees with itself.
        //
        // These do not come from a model at all (`state.js` `noteRejections` over `invariant-table`
        // witnesses), so the fix is never "prompt better", it is an earlier event that was never
        // recorded. Saying so is the difference between a diagnosis and an accusation.
        'invariant:overdraw': 'more was spent than was ever recorded arriving, the difference is income the ledger never saw, not a bad subtraction here.',
        'invariant:negative-quantity': 'a count went below zero, something was gained off the record before it was spent.',
        'invariant:unbacked-debit': 'something left the ledger that nothing was ever recorded putting into it.',
        'invariant:split-name': 'one thing is being tracked under two names, merge them, or the count is split across both.',
        'invariant:split-currency': 'one currency is being tracked under two tokens, pick one, or the money never adds up.',
        'invariant:partition-contradiction': 'two records put the same thing in two places at once.',
    })[reason] ?? 'the proposed change failed the corresponding validation gate, see the reason above.';
}
