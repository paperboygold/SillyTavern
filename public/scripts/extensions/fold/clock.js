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

/** Named times cards actually write. Kept empty: "noon"/"midnight" are English words, and the
 * model is the one that reads a time out of prose — fold only parses the numeric clock SHAPE, which
 * means the same thing in every language. A card writing "Time: noon" simply does not move the
 * clock, the safe failure. */
const NAMED = new Map();

/**
 * Parse a clock time to minutes since midnight.
 *
 * Handles "7:38 AM", "07:38", "8 PM", "20:00". Returns null rather than guessing: a value that is
 * not a time must not become one, because everything downstream treats the result as authoritative.
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
 * Render a written date for the panel.
 *
 * The date is the scene probe's free-text answer ("Wednesday, September 23, 1998", "the 3rd of
 * autumn") — display text the model already read from the prose, in any language. It is shown
 * as written. The old compressor recognised English month and day names to shorten it; that was
 * an English word-list judging a narrative-derived field, and a date in any other language came
 * back untouched anyway, so the compression was English-only sugar. The original string is the
 * honest surface.
 *
 * @param {string} text A written date.
 * @returns {string} The date, unchanged.
 */
export function formatDate(text) {
    return String(text ?? '').trim();
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
 * Minutes per unit, so an explicit span in any unit is one multiplication.
 */
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
 * The face (minutes since midnight) a scene-transition marker implies.
 *
 * ── Why a transition marker carries a phase, not just a day ──
 *
 * `skipClock` adds a minute count to the running clock and wraps the day, which is right for a
 * duration ("three hours") and wrong for a transition marker ("come morning", "first light").
 * Measured in the Royal Succession chat: a clock sat at 19:45, the story said "come morning", the
 * parse returned one DAY of minutes, and `skipClock` added it to 19:45 — producing 19:45 the NEXT
 * day. The day counter rolled and the FACE froze, so a court that assembled "at first light" was
 * reported at a quarter to eight in the evening. A transition to a part of a day is a statement
 * about which part of WHICH day the scene moved to; the face is half of that statement.
 *
  * The probe also reports the clock directly (`clockHour`/`clockMinute`), and a parseable clock
  * outranks a marker's implied phase — the model read the scene's clock directly. This is the
  * fallback when the narrative moved to a named part of a day without writing a clock time.
  */
const MORNING = 6 * 60;
const AFTERNOON = 13 * 60;
const EVENING = 18 * 60;
const NIGHT = 21 * 60;

/**
 * The face a protocol day-part implies, in minutes since midnight.
 *
 * This is fold's own vocabulary — the scene schema's `phase` enum — mapped to an hour by pure
 * arithmetic. The MODEL decides the phase from the narrative ("come morning" is `morning` in any
 * language); fold only turns the enum value into minutes, which is the same in every language.
 */
const PHASE_MINUTES = {
    morning: MORNING,
    afternoon: AFTERNOON,
    evening: EVENING,
    night: NIGHT,
};


/**
 * Advance the clock on the scene probe's own reading.
 *
 * ── One update, not two ──
 *
 * The scene probe reports `days` (whole days passed), `minutes` (sub-day minutes), `phase` (the
 * part of a day a transition marker landed on) and `clockHour`/`clockMinute` (the clock as it now
 * reads). All used to write the same clock through different paths on the same pass — `setContext`
 * folded `time` in absolutely (`advanceClock`) and `noteSceneElapsed` added `elapsed` on top
 * (`skipClock`) — so a pass that reported "a week" and "19:45" first set 19:45 and then added a
 * week to it. The correct reading is complementary, not additive:
 *
 *   · a parseable clock (`clockHour`/`clockMinute`) is the FACE — the model read the scene's clock
 *     directly;
 *   · a marker's implied `phase` is the face when no clock was read;
 *   · a duration's `minutes` are added to the running face;
 *   · `days` roll the day;
 *   · `dateChanged` rolls the day even when no duration or marker said so — a named day is the one
 *     unambiguous signal that a full day has passed.
 *
 * The clock outranks the marker's phase because a direct reading is more specific than an inference.
 *
 * Everything is the model's structured answer, never fold parsing prose: the probe reads the
 * narrative in any language and returns numbers.
 *
 * @param {object} current The stored clock.
 * @param {object} [stated] The probe's answers.
 * @param {number} [stated.days] Whole days passed.
 * @param {number} [stated.minutes] Sub-day minutes passed.
 * @param {string} [stated.phase] The part of a day a marker landed on: '' or a day part.
 * @param {number} [stated.clockHour] The hour the clock reads now, or NaN.
 * @param {number} [stated.clockMinute] The minute, or NaN.
 * @param {boolean} [stated.dateChanged] Whether a new day was named.
 * @returns {object} The new clock, with `accepted` and `reason`.
 */
export function advanceSceneClock(current, { days = 0, minutes = 0, phase = '', clockHour = NaN, clockMinute = NaN, dateChanged = false } = {}) {
    const seen = (current?.seen ?? 0) + 1;
    const kept = { ...current, seen };

    const spanDays = Math.max(0, Math.floor(Number(days) || 0));
    const spanMinutes = Math.max(0, Math.floor(Number(minutes) || 0));

    // The face, from the model's direct clock reading or the transition marker's phase. A bare
    // part of day is a protocol value the probe emits; the hour it means is pure arithmetic.
    //
    // ── Why the sentinel is refused here ──
    //
    // The scene schema tells the model to report `clock_hour`/`clock_minute` as -1 when the
    // narrative states no clock time. -1 IS finite, so a naive `Number.isFinite` read admits it as
    // a face: `((-1 % 24) * 60 + -1)` = -61, and `formatClock(-61)` = "22:59". Measured in the
    // Xianxia chat: the probe returned the -1/-1 sentinel on 53 of 57 passes, so every pass that
    // also reported a phase froze the face at 22:59 while the day rolled. The reading is only real
    // when the model reports actual clock digits; a negative value is the protocol's "no time".
    const hasClock = clockHour >= 0 && clockMinute >= 0
        && Number.isFinite(clockHour) && Number.isFinite(clockMinute);
    let face = hasClock
        ? ((Math.floor(clockHour) % 24) * 60 + Math.floor(clockMinute) % 60)
        : phase
            ? PHASE_MINUTES[phase] ?? null
            : null;

    // ── A restated phase is not a move ──
    //
    // `phase` is a move TO a part of a day ("come morning", "dusk"). When the narrative merely
    // restates the part of day the clock has already reached — the model reports `phase: "morning"`
    // on turn after turn of the same morning — the phase's fixed hour (06:00) sits EARLIER than the
    // running face once continuous time has advanced it (06:45). Applying it would compute
    // `after < before` and refuse the whole pass as `reversed`, freezing the clock all over again.
    // Restating where the story already is is not a move, so the phase face is dropped and the
    // duration path (which only moves forward) takes over. A real transition still sets the face: a
    // new day (`days`/`dateChanged`) always lands forward, and a later same-day phase (morning ->
    // afternoon) does not reverse.
    if (!hasClock && face !== null && !spanDays && !dateChanged
        && Number.isFinite(current?.minutes) && face <= current.minutes) {
        face = null;
    }

    if (!spanDays && !spanMinutes && face === null && !dateChanged) {
        return { ...kept, accepted: false, reason: 'unstated' };
    }

    let day = (current?.day ?? 0);
    let minuteOfDay;
    if (face !== null) {
        // The probe read the clock directly — that is the face. The elapsed still rolls the day.
        day += spanDays;
        minuteOfDay = face;
    } else {
        // A duration: add its sub-day minutes to the running face, rolling the day on overflow.
        const total = (current?.minutes ?? 0) + spanMinutes;
        day += spanDays + Math.floor(total / DAY);
        minuteOfDay = total % DAY;
    }

    if (dateChanged) {
        day += 1;
    }

    const next = {
        ...kept,
        day,
        minutes: minuteOfDay,
        raw: formatClock(minuteOfDay),
    };

    if (!Number.isFinite(current?.minutes)) {
        return { ...next, moved: seen, accepted: true, reason: 'established' };
    }

    const before = clockScalar(current.day, current.minutes);
    const after = clockScalar(day, minuteOfDay);
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
 * Longest single skip accepted.
 *
 * ── Why this is so large, and why it is not the cap it looks like ──
 *
 * The first version capped at twelve hours, which was the same genre bug as an absolute quantity
 * bound: a scenario that jumps a month between chapters is not a misparse, it is the premise. The
 * scene probe reports "a week" as 7 days and "the next three months" as 90; fold has no standing to
 * refuse the story's own skip. This only stops a runaway value turning a typo into a geological
 * era. Ten years.
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
