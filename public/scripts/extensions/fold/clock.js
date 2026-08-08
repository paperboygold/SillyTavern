/**
 * fold/clock.js — reading the time out of prose, so the panel can relate two facts instead of
 * printing them side by side.
 *
 * Pure, dependency-free, unit-testable.
 *
 * The panel already knew two things at once: that it was 7:38 AM, and that RPD contractor systems
 * were scheduled to go offline at 8:00 AM. It showed them four inches apart and drew no line
 * between them. Twenty-two minutes is not a new fact — it is the *only* interesting reading of the
 * two facts already present, and producing it needs nothing more than parsing a clock time.
 *
 * That is also the answer to "consequence without dice". A deadline is a constraint the fiction
 * asserted about itself; surfacing it costs no randomness and no mechanics, and it makes the
 * passage of time matter because the narrator already said it should.
 */

/** Minutes in a day. */
const DAY = 1440;

/**
 * How far past a stated time we still describe it as just-missed rather than ignoring it.
 *
 * Without a bound, "offline at 8:00 AM" read at 9:00 PM produces "in 11 hours", which asserts a
 * tomorrow the fiction never mentioned. Three hours is long enough to cover a scene, short enough
 * that a stale deadline drops off the panel rather than lying about the future.
 */
const RECENT_PAST = 180;

/** Named times cards actually write. */
const NAMED = new Map([
    ['midnight', 0],
    ['noon', 720],
    ['midday', 720],
]);

/**
 * Parse a clock time to minutes since midnight.
 *
 * Handles "7:38 AM", "07:38", "8 PM", "20:00", "noon", "midnight". Returns null rather than
 * guessing: a value that is not a time must not become one, because everything downstream treats
 * the result as authoritative.
 *
 * @param {string} text A time, or text containing one.
 * @returns {number|null} Minutes since midnight, or null.
 */
export function parseClock(text) {
    const source = String(text ?? '').toLowerCase();
    if (!source) {
        return null;
    }

    for (const [word, minutes] of NAMED) {
        if (source.includes(word)) {
            return minutes;
        }
    }

    // "7:38 am" / "19:05" — a colon makes it unambiguous, so this is tried first.
    const withColon = source.match(/\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/);
    if (withColon) {
        return toMinutes(Number(withColon[1]), Number(withColon[2]), withColon[3]);
    }

    // "8 pm" — a bare number is only a time when a meridiem says so. Without that guard every
    // "September 23" and "12 rounds" in the excerpt would parse as a clock reading.
    const bare = source.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/);
    if (bare) {
        return toMinutes(Number(bare[1]), 0, bare[2]);
    }

    return null;
}

/**
 * Combine hour, minute and meridiem into minutes since midnight.
 * @param {number} hour Hour as written.
 * @param {number} minute Minute as written.
 * @param {string} [meridiem] "am" / "pm", in any punctuation.
 * @returns {number|null} Minutes since midnight, or null if out of range.
 */
function toMinutes(hour, minute, meridiem) {
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) {
        return null;
    }
    const pm = /^p/.test(meridiem ?? '');
    const am = /^a/.test(meridiem ?? '');

    let h = hour;
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    // With a meridiem the hour must be 1-12; without one it is a 24-hour reading.
    if ((pm || am) ? hour < 1 || hour > 12 : h > 23) {
        return null;
    }
    return h * 60 + minute;
}

/**
 * Format minutes since midnight as a 24-hour reading.
 * @param {number} minutes Minutes since midnight.
 * @returns {string} "07:38", or '' if unusable.
 */
export function formatClock(minutes) {
    if (!Number.isFinite(minutes)) {
        return '';
    }
    const total = ((Math.round(minutes) % DAY) + DAY) % DAY;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Find a deadline stated in a piece of text.
 *
 * Only times introduced by a scheduling preposition count. "The clinic closed at 6" is a deadline;
 * "she left at 6" is a fact about the past wearing the same clothes, and treating every time in
 * every lead as a countdown would fill the panel with expiring history.
 *
 * @param {string} text A lead, objective or note.
 * @returns {number|null} Minutes since midnight, or null if the text states no deadline.
 */
export function findDeadline(text) {
    const source = String(text ?? '').toLowerCase();
    // Everything from the preposition onward, so the time that follows is the one that is parsed.
    const scheduled = source.match(/\b(?:at|by|before|until|till|after)\s+(.{0,24})/);
    if (!scheduled) {
        return null;
    }
    return parseClock(scheduled[1]);
}

/**
 * How long until a deadline, given the current time.
 *
 * @param {number} now Minutes since midnight, now.
 * @param {number} deadline Minutes since midnight, the deadline.
 * @returns {{minutes: number, passed: boolean}|null} The gap, or null when it is too far either
 * way to be about this scene.
 */
export function timeUntil(now, deadline) {
    if (!Number.isFinite(now) || !Number.isFinite(deadline)) {
        return null;
    }
    const raw = deadline - now;
    if (raw >= 0) {
        // More than half a day out is not a deadline anyone is racing, and is more often a
        // misparse than a real constraint.
        return raw <= DAY / 2 ? { minutes: raw, passed: false } : null;
    }
    return raw >= -RECENT_PAST ? { minutes: -raw, passed: true } : null;
}

/**
 * Render a gap in minutes as something a person reads at a glance.
 * @param {number} minutes A duration in minutes.
 * @returns {string} "22 min", "1h 40m", "3h".
 */
export function formatGap(minutes) {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) {
        return `${total} min`;
    }
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Compress a written date to a scannable one.
 *
 * "Wednesday, September 23, 1998" is four lines in a 288px panel and one glance's worth of
 * information. Parsing is deliberately lenient and the fallback is the original string: a card may
 * be running a calendar that no date library has heard of, and mangling it is worse than leaving
 * it alone.
 *
 * @param {string} text A written date.
 * @returns {string} "Wed 23 Sep 1998", or the input unchanged.
 */
export function formatDate(text) {
    const source = String(text ?? '').trim();
    if (!source) {
        return '';
    }

    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const lower = source.toLowerCase();

    const month = MONTHS.findIndex(m => lower.includes(m));
    const day = lower.match(/\b(\d{1,2})\b(?!\s*:)/);
    const year = lower.match(/\b(\d{4})\b/);
    if (month === -1 || !day) {
        return source;
    }

    const weekday = DAYS.find(d => lower.includes(d));
    const parts = [
        weekday ? cap(weekday) : '',
        day[1],
        cap(MONTHS[month]),
        year?.[1] ?? '',
    ];
    return parts.filter(Boolean).join(' ');
}

/**
 * Uppercase the first letter.
 * @param {string} word A word.
 * @returns {string} The word, capitalised.
 */
function cap(word) {
    return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * Exchanges without the clock moving, after which it is reported as stale rather than as fact.
 *
 * Three is one scene's worth of lag. Below that a narrator that simply did not restate the time is
 * normal; above it, the clock has stopped while the story kept going.
 */
export const CLOCK_STALE_AFTER = 3;

/**
 * The narrative clock as a scalar on a linear order.
 *
 * @param {number} day Day number.
 * @param {number} minutes Minutes since midnight.
 * @returns {number} A comparable instant.
 */
export function clockScalar(day, minutes) {
    return (Number(day) || 0) * DAY + (Number(minutes) || 0);
}

/**
 * Fold a stated time into the clock, monotonically.
 *
 * ── Why `max` and not last-write ──
 *
 * The clock used to be a STRING under `merge_b`. Two failures follow, and both were visible in
 * play: a string has no order, so nothing could tell 1:03 PM from a later time; and unversioned
 * last-write is not convergent at all —
 * `sanguine/proof/Closures/Applied/OntologyClosure.lean:136 merge_B_order_matters` is the
 * counterexample, `[(0,1),(0,2)]` reads 1 and its permutation reads 2. Extraction here is async and
 * fire-and-forget, so permutations are not hypothetical.
 *
 * `merge_max_converges` (:152) closes it: `max` on any `LinearOrder` is a CRDT. Minutes-since-epoch
 * is a `LinearOrder`, so the clock merges under `max` and the order in which turns land stops
 * mattering. Scribe reached the same rule empirically —
 * `game_state_service.rs:462-472` clamps `total_seconds_elapsed` upward with a warning — and it is
 * the one part of Scribe's state handling that worked.
 *
 * A refusal is information, not an error: a narrator asserting an earlier time than the story has
 * already reached is contradicting itself, and the panel says so rather than quietly rewinding.
 *
 * @param {object} current The stored clock.
 * @param {object} stated What the block said.
 * @param {string} [stated.time] The stated time.
 * @param {string} [stated.date] The stated date.
 * @returns {object} The new clock, with `accepted` and `reason`.
 */
export function advanceClock(current, { time, date } = {}) {
    const seen = (current?.seen ?? 0) + 1;
    const kept = { ...current, seen };

    const minutes = parseClock(time);
    if (minutes === null) {
        return { ...kept, accepted: false, reason: 'unstated' };
    }

    // A changed date is the only evidence of a day boundary that does not require guessing. Without
    // it, a clock that appears to go backwards is treated as a contradiction rather than silently
    // assumed to be tomorrow — the conservative failure is a clock that sticks and says so.
    const stated = String(date ?? '').trim();
    const known = String(current?.date ?? '').trim();
    const day = (current?.day ?? 0) + (stated && known && stated !== known ? 1 : 0);

    const next = { day, minutes, raw: String(time), date: stated || known, seen };

    if (!Number.isFinite(current?.minutes)) {
        return { ...next, moved: seen, accepted: true, reason: 'established' };
    }

    const before = clockScalar(current.day, current.minutes);
    const after = clockScalar(day, minutes);
    if (after < before) {
        return { ...kept, accepted: false, reason: 'reversed' };
    }
    return {
        ...next,
        moved: after > before ? seen : (current.moved ?? seen),
        accepted: true,
        reason: after > before ? 'advanced' : 'unchanged',
    };
}

/**
 * Durations narrators and players actually write, in minutes.
 *
 * Deliberately coarse. "Several hours" is not four hours — it is a gesture at four hours, and
 * pretending to a precision the phrase does not carry would be the same defect as an unmeasured
 * constant. What matters is that the clock MOVES, and by roughly the right amount.
 */
const SPANS = [
    [/\bthe rest of the (?:day|afternoon)\b/, 300],
    [/\bthe rest of the (?:night|evening)\b/, 240],
    [/\b(?:several|a few|some) hours\b/, 210],
    [/\ba couple of hours\b/, 120],
    [/\ball (?:day|afternoon|evening|night)\b/, 300],
    [/\b(?:an|one|another) hour\b/, 60],
    [/\bhalf an hour\b/, 30],
    [/\b(?:several|a few|some) minutes\b/, 15],
    [/\ba (?:little )?while\b/, 45],
    [/\b(?:several|a few|some) (?:days|weeks)\b/, null],
    [/\b(\d{1,4})\s*(minutes?|hours?|days?|weeks?|months?|years?)\b/, null],
    [/\b(?:a|one|another) (day|week|month|year)\b/, null],
];

/** Minutes per unit, so an explicit span in any unit is one multiplication. */
const UNIT = {
    minute: 1, hour: 60, day: DAY, week: DAY * 7, month: DAY * 30, year: DAY * 365,
};

/**
 * How long a bare duration phrase is, in minutes.
 *
 * ── Why this is NOT `parseElapsed` ──
 *
 * `parseElapsed` below reads a NARRATIVE SENTENCE and has two gates that exist because it is
 * reading prose written by a person who was not thinking about clocks: the assertion gate ("for the
 * next", "spend", "continue") and the backward-looking gate ("an hour ago"). Both are exactly right
 * there and exactly wrong here, because this reads fold's own `per` field — a cadence somebody set
 * on a front, e.g. `per: "1 month"` on the residency window (FOLD-REDESIGN.md §7.3). A cadence is
 * not a claim about the past or the future; it is a unit. Running the assertion gate over it would
 * make `per: "1 month"` parse as null and the front would never tick, which is the whole defect §7.1
 * records: "a pure calendar condition that nothing in fold can tick".
 *
 * Rejected alternative: loosen `parseElapsed` with a flag. Two callers with opposite gating
 * requirements sharing one function is how a flag argument becomes a second function anyway, and the
 * live cost of getting it wrong is asymmetric — a loosened `parseElapsed` would advance the story's
 * clock off the word "yesterday".
 *
 * The unit table is shared, deliberately: a month is thirty days in both readings or the two
 * disagree about what a month is, and the front would tick against a calendar the panel does not
 * show.
 *
 * @param {string} text A duration phrase: "1 month", "two weeks", "day".
 * @returns {number|null} Minutes, or null when the phrase names no duration.
 */
export function parseSpan(text) {
    const said = String(text ?? '').toLowerCase().trim();
    if (!said) {
        return null;
    }
    const counted = said.match(/\b(\d{1,4})\s*(minute|hour|day|week|month|year)s?\b/);
    if (counted) {
        const count = Number(counted[1]);
        if (count > 0) {
            return Math.min(MAX_SKIP, count * UNIT[counted[2]]);
        }
    }
    // "a month", "every month", "month" — a bare unit is one of it. No count means one, which is
    // what every cadence in English means when it omits the number.
    const bare = said.match(/\b(minute|hour|day|week|month|year)s?\b/);
    return bare ? UNIT[bare[1]] : null;
}

/**
 * How much time a phrase says has passed.
 *
 * ── Why the PLAYER's message is the source ──
 *
 * Measured on a real chat: three of twenty-nine player turns skip time explicitly — "I continue
 * working for the next several hours" — and nothing in fold moved the clock for any of them. A
 * card's status block only reports the time when it feels like it, so the one reliable statement
 * about elapsed time is the one the player made. Neither Scribe nor Marinara advances a clock this
 * way; both wait for the model to say so.
 *
 * Only forward-looking phrasing counts. "An hour ago" is history, and advancing on it would run
 * the clock forward for a memory.
 *
 * @param {string} text A message.
 * @returns {number|null} Minutes elapsed, or null if the text claims none.
 */
export function parseElapsed(text) {
    const source = String(text ?? '').toLowerCase();
    if (!source || /\b(?:ago|earlier|last night|yesterday)\b/.test(source)) {
        return null;
    }
    // A skip has to be asserted, not merely mentioned: "for the next", "spend", "continue".
    if (!/\b(?:for the next|for another|over the next|spend|spends|spent|continue|continues|keeps? (?:at|working)|work(?:s|ed)? (?:on|through)|wait(?:s|ed)?|rest(?:s|ed)?|sleep(?:s|t)?)\b/.test(source)) {
        return null;
    }

    for (const [pattern, minutes] of SPANS) {
        const match = source.match(pattern);
        if (!match) continue;
        if (minutes !== null) return minutes;

        const unit = Object.keys(UNIT).find(u => new RegExp(`\\b${u}s?\\b`).test(match[0]));
        if (!unit) {
            // "several days" / "a few weeks" — vague, so the coarse reading, same as the hours row.
            const vague = /weeks/.test(match[0]) ? UNIT.week * 3 : UNIT.day * 3;
            return Math.min(MAX_SKIP, vague);
        }
        const count = Number(match[1]) || 1;
        if (count <= 0) continue;
        return Math.min(MAX_SKIP, count * UNIT[unit]);
    }
    return null;
}

/**
 * Longest single skip accepted.
 *
 * ── Why this is so large, and why it is not the cap it looks like ──
 *
 * The first version capped at twelve hours, which was the same genre bug as an absolute quantity
 * bound: a scenario that jumps a month between chapters is not a misparse, it is the premise. A
 * player writing "I spend the next three months rebuilding the fleet" has ASSERTED that, and fold
 * has no standing to refuse it.
 *
 * So the real guard is not this number — it is that a skip must be asserted at all
 * (`parseElapsed`'s preposition check) and must not be backwards-looking. This only stops a runaway
 * parse turning a typo into a geological era. Ten years.
 */
export const MAX_SKIP = DAY * 365 * 10;

/**
 * Advance the clock by an elapsed span, wrapping the day.
 * @param {object} current The stored clock.
 * @param {number} minutes Minutes to add.
 * @returns {object} The advanced clock.
 */
export function skipClock(current, minutes) {
    if (!Number.isFinite(current?.minutes) || !Number.isFinite(minutes) || minutes <= 0) {
        return { ...current, accepted: false, reason: 'no-skip' };
    }
    const total = current.minutes + Math.min(MAX_SKIP, minutes);
    return {
        ...current,
        day: (current.day ?? 0) + Math.floor(total / DAY),
        minutes: total % DAY,
        raw: formatClock(total % DAY),
        moved: current.seen ?? 0,
        accepted: true,
        reason: 'skipped',
    };
}

/**
 * How many exchanges since the clock last moved.
 * @param {object} clock The stored clock.
 * @returns {number} The age.
 */
export function clockAge(clock) {
    return Math.max(0, (clock?.seen ?? 0) - (clock?.moved ?? 0));
}

/**
 * Is the clock asserting a time the story has outrun?
 * @param {object} clock The stored clock.
 * @returns {boolean} True when it has stopped while the story continued.
 */
export function isClockStale(clock) {
    return Number.isFinite(clock?.minutes) && clockAge(clock) >= CLOCK_STALE_AFTER;
}

/**
 * Split a location into the place and its qualifier.
 *
 * "Solomon's apartment, fourth floor near Raccoon City centre" is one place and one description of
 * where that place is. Set at one weight it wraps to five lines and reads as a paragraph; split,
 * the place carries the line and the qualifier recedes to a caption.
 *
 * @param {string} text A location.
 * @returns {{place: string, qualifier: string}} The parts.
 */
export function splitLocation(text) {
    const source = String(text ?? '').trim();
    const comma = source.indexOf(',');
    if (comma === -1) {
        return { place: source, qualifier: '' };
    }
    return {
        place: source.slice(0, comma).trim(),
        qualifier: source.slice(comma + 1).trim(),
    };
}
