import { describe, expect, test } from '@jest/globals';

import {
    CLOCK_STALE_AFTER,
    advanceClock,
    advanceSceneClock,
    clockAge,
    clockScalar,
    formatClock,
    formatDate,
    formatGap,
    MAX_SKIP,
    isClockStale,
    parseClock,
    skipClock,
    splitLocation,
    timeUntil,
} from '../public/scripts/extensions/fold/clock.js';

describe('parseClock', () => {
    test('reads a 12-hour time with a meridiem', () => {
        expect(parseClock('7:38 AM')).toBe(7 * 60 + 38);
        expect(parseClock('7:38 PM')).toBe(19 * 60 + 38);
        expect(parseClock('12:05 a.m.')).toBe(5);
        expect(parseClock('12:05 p.m.')).toBe(12 * 60 + 5);
    });

    test('reads a 24-hour time', () => {
        expect(parseClock('19:05')).toBe(19 * 60 + 5);
        expect(parseClock('00:00')).toBe(0);
    });

    test('reads a bare hour ONLY when a meridiem says it is one', () => {
        expect(parseClock('8 PM')).toBe(20 * 60);
        // Otherwise every "September 23" and "12 rounds" in an excerpt becomes a clock reading.
        expect(parseClock('September 23, 1998')).toBeNull();
        expect(parseClock('12 rounds and a spare magazine')).toBeNull();
    });

    test('named times are the model\'s job — fold only parses the numeric clock shape', () => {
        // "noon"/"midnight" are English words; reading them off prose is the model's job (the scene
        // probe reports clock_hour/clock_minute). A card writing "Time: noon" does not move the
        // clock — the safe failure — instead of fold guessing an English dictionary.
        expect(parseClock('around midnight')).toBeNull();
        expect(parseClock('noon')).toBeNull();
    });

    test('refuses rather than guesses', () => {
        expect(parseClock('')).toBeNull();
        expect(parseClock(null)).toBeNull();
        expect(parseClock('soon')).toBeNull();
        expect(parseClock('25:00')).toBeNull();
        expect(parseClock('7:99')).toBeNull();
        expect(parseClock('13:00 PM')).toBeNull();
    });
});

describe('formatClock', () => {
    test('pads to a 24-hour reading', () => {
        expect(formatClock(7 * 60 + 38)).toBe('07:38');
        expect(formatClock(0)).toBe('00:00');
        expect(formatClock(23 * 60 + 59)).toBe('23:59');
    });

    test('wraps rather than overflowing', () => {
        expect(formatClock(1440)).toBe('00:00');
        expect(formatClock(-60)).toBe('23:00');
    });

    test('is total over junk', () => {
        expect(formatClock(NaN)).toBe('');
        expect(formatClock(undefined)).toBe('');
    });
});

describe('timeUntil — the reading the panel exists to produce', () => {
    test('the twenty-two minutes that were already on screen', () => {
        // 07:38 now, systems offline at 08:00. Both facts were being printed, unconnected.
        expect(timeUntil(parseClock('7:38 AM'), parseClock('8:00 AM')))
            .toEqual({ minutes: 22, passed: false });
    });

    test('reports a recently missed deadline as passed', () => {
        expect(timeUntil(8 * 60 + 30, 8 * 60)).toEqual({ minutes: 30, passed: true });
    });

    test('drops a deadline too far in either direction to be about this scene', () => {
        // 11 hours out is not a deadline anyone is racing; it is usually a misparse.
        expect(timeUntil(9 * 60, 21 * 60 + 1)).toBeNull();
        // Long past is history, and claiming it as "in 20 hours" asserts a tomorrow nobody stated.
        expect(timeUntil(20 * 60, 8 * 60)).toBeNull();
    });

    test('is total over unparseable input', () => {
        expect(timeUntil(null, 480)).toBeNull();
        expect(timeUntil(480, null)).toBeNull();
    });
});

describe('formatGap', () => {
    test('minutes below an hour', () => {
        expect(formatGap(22)).toBe('22 min');
        expect(formatGap(0)).toBe('0 min');
    });

    test('hours and minutes above one', () => {
        expect(formatGap(100)).toBe('1h 40m');
        expect(formatGap(180)).toBe('3h');
    });
});

describe('formatDate', () => {
    test('shows the date as the model wrote it, in any language', () => {
        // The date is the scene probe's free-text answer; the old English month/day compressor is
        // gone. The original string is the honest surface.
        expect(formatDate('Wednesday, September 23, 1998')).toBe('Wednesday, September 23, 1998');
        expect(formatDate('September 23')).toBe('September 23');
        expect(formatDate('the 3rd of autumn')).toBe('the 3rd of autumn');
    });

    test('is total over nothing', () => {
        expect(formatDate('')).toBe('');
        expect(formatDate(null)).toBe('');
    });
});

describe('splitLocation', () => {
    test('separates the place from where the place is', () => {
        expect(splitLocation('Solomon\'s apartment, fourth floor near Raccoon City centre'))
            .toEqual({ place: 'Solomon\'s apartment', qualifier: 'fourth floor near Raccoon City centre' });
    });

    test('a location with no qualifier keeps an empty one', () => {
        expect(splitLocation('city bus')).toEqual({ place: 'city bus', qualifier: '' });
    });
});

describe('advanceClock — the clock is a scalar under max, not a string under last-write', () => {
    /** A fresh clock. */
    const fresh = () => ({ day: 0, minutes: NaN, raw: '', date: '', seen: 0, moved: 0 });

    test('the first stated time establishes it', () => {
        const c = advanceClock(fresh(), { time: '7:38 AM', date: 'Wednesday, September 23, 1998' });
        expect(c).toMatchObject({ accepted: true, minutes: 458, day: 0, reason: 'established' });
    });

    test('a later time advances it', () => {
        const first = advanceClock(fresh(), { time: '7:38 AM', date: 'Wed 23 Sep' });
        const next = advanceClock(first, { time: '1:03 PM', date: 'Wed 23 Sep' });
        expect(next).toMatchObject({ accepted: true, minutes: 783, reason: 'advanced' });
    });

    test('an EARLIER time is refused — the story does not rewind', () => {
        // merge_B_order_matters: unversioned last-write would simply take it.
        const at1pm = advanceClock(advanceClock(fresh(), { time: '1:03 PM', date: 'Wed' }), { time: '1:03 PM', date: 'Wed' });
        const back = advanceClock(at1pm, { time: '7:38 AM', date: 'Wed' });
        expect(back.accepted).toBe(false);
        expect(back.reason).toBe('reversed');
        expect(back.minutes).toBe(783);
    });

    test('a changed date carries it over midnight', () => {
        const late = advanceClock(fresh(), { time: '11:50 PM', date: 'Wed 23 Sep' });
        const early = advanceClock(late, { time: '12:20 AM', date: 'Thu 24 Sep' });
        expect(early.accepted).toBe(true);
        expect(early.day).toBe(1);
        expect(clockScalar(early.day, early.minutes)).toBeGreaterThan(clockScalar(late.day, late.minutes));
    });

    test('order does not matter — max on a LinearOrder is a CRDT', () => {
        // sanguine/proof/Closures/Applied/OntologyClosure.lean:152 merge_max_converges.
        // Extraction is async, so two turns landing out of order is not hypothetical.
        const forward = advanceClock(advanceClock(fresh(), { time: '7:38 AM', date: 'Wed' }), { time: '1:03 PM', date: 'Wed' });
        const reversed = advanceClock(advanceClock(fresh(), { time: '1:03 PM', date: 'Wed' }), { time: '7:38 AM', date: 'Wed' });
        expect(clockScalar(forward.day, forward.minutes)).toBe(clockScalar(reversed.day, reversed.minutes));
    });

    test('a turn that states no time leaves the clock alone but counts as seen', () => {
        const set = advanceClock(fresh(), { time: '1:03 PM', date: 'Wed' });
        const quiet = advanceClock(set, {});
        expect(quiet.minutes).toBe(783);
        expect(quiet.accepted).toBe(false);
        expect(quiet.seen).toBe(set.seen + 1);
    });
});

describe('clock staleness — the bug that lost an afternoon', () => {
    test('a clock restated unchanged for several turns reads as stale', () => {
        // The narrative moved from early afternoon to dark; the block kept saying 1:03 PM, and
        // fold kept injecting it as fact, so the model kept answering 1:03 PM.
        let clock = { day: 0, minutes: NaN, raw: '', date: '', seen: 0, moved: 0 };
        clock = advanceClock(clock, { time: '1:03 PM', date: 'Wed' });
        expect(isClockStale(clock)).toBe(false);

        for (let turn = 0; turn < CLOCK_STALE_AFTER; turn++) {
            clock = advanceClock(clock, { time: '1:03 PM', date: 'Wed' });
        }
        expect(clockAge(clock)).toBe(CLOCK_STALE_AFTER);
        expect(isClockStale(clock)).toBe(true);
    });

    test('advancing the clock clears staleness', () => {
        let clock = advanceClock({ day: 0, minutes: NaN, seen: 0, moved: 0, date: '', raw: '' }, { time: '1:03 PM', date: 'Wed' });
        for (let turn = 0; turn < 5; turn++) {
            clock = advanceClock(clock, { time: '1:03 PM', date: 'Wed' });
        }
        expect(isClockStale(clock)).toBe(true);
        clock = advanceClock(clock, { time: '4:20 PM', date: 'Wed' });
        expect(isClockStale(clock)).toBe(false);
        expect(clockAge(clock)).toBe(0);
    });

    test('a clock that was never established is not stale, merely absent', () => {
        expect(isClockStale({ day: 0, minutes: NaN, seen: 9, moved: 0 })).toBe(false);
    });
});

describe('parseElapsed is gone — the model reads the player\'s elision, not a regex', () => {
    test('there is no English time-phrase table any more', () => {
        // The player's "I spend the next several hours" used to be read by a regex that only
        // worked in English. The scene probe reads the same window on the next pass and answers
        // elapsed_days/elapsed_minutes structurally. `parseElapsed` no longer exists — importing
        // it fails — so the contract is enforced at the module boundary, not by a test.
        expect(typeof parseElapsed).toBe('undefined');
    });

    test('the structured elapsed fields are what the clock consumes', () => {
        const clock = advanceSceneClock({ day: 0, minutes: 9 * 60, raw: '09:00', seen: 0, moved: 0, date: '' }, {
            days: 1, minutes: 180, phase: '', clockHour: NaN, clockMinute: NaN, dateChanged: false,
        });
        expect(clock.accepted).toBe(true);
        // 1 day + 180 minutes from 09:00 → 12:00 the next day.
        expect(clock.day).toBe(1);
        expect(formatClock(clock.minutes)).toBe('12:00');
    });
});

describe('parseSceneElapsed is gone — the probe reports numbers, not phrases', () => {
    test('a week is 7 days straight from the model, with no phrase table', () => {
        const clock = advanceSceneClock({ day: 0, minutes: 9 * 60, raw: '09:00', seen: 0, moved: 0, date: '' }, {
            days: 7, minutes: 0, phase: '', clockHour: NaN, clockMinute: NaN, dateChanged: false,
        });
        expect(clock.accepted).toBe(true);
        expect(clock.day).toBe(7);
    });

    test('a transition marker is a phase the model reports, mapped to an hour by arithmetic', () => {
        // "come morning"/"overnight" → the model answers phase:"morning"; fold maps the enum value
        // to 06:00. No English marker regex survives.
        const clock = advanceSceneClock({ day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' }, {
            days: 1, minutes: 0, phase: 'morning', clockHour: NaN, clockMinute: NaN, dateChanged: false,
        });
        expect(clock.accepted).toBe(true);
        expect(clock.day).toBe(1);
        expect(formatClock(clock.minutes)).toBe('06:00');
    });

    test('a direct clock reading outranks the phase', () => {
        const clock = advanceSceneClock({ day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' }, {
            days: 1, minutes: 0, phase: 'morning', clockHour: 15, clockMinute: 15, dateChanged: false,
        });
        expect(clock.accepted).toBe(true);
        expect(clock.day).toBe(1);
        expect(formatClock(clock.minutes)).toBe('15:15');
    });

    test('nothing stated does not move the clock', () => {
        const clock = advanceSceneClock({ day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' }, {
            days: 0, minutes: 0, phase: '', clockHour: NaN, clockMinute: NaN, dateChanged: false,
        });
        expect(clock.accepted).toBe(false);
    });
});

describe('advanceSceneClock — structured fields move the day and set the face, one update', () => {
    const fresh = () => ({ day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' });
    const none = { days: 0, minutes: 0, phase: '', clockHour: NaN, clockMinute: NaN, dateChanged: false };

    test('a transition marker moves to the next day at the marker\'s phase', () => {
        // The Royal Succession bug, end to end: the clock sat at 19:45, the story said "come
        // morning", and the clock must land on MORNING of the next day, not 19:45 again. The model
        // reports phase:"morning"; fold maps the enum to 06:00.
        const after = advanceSceneClock(fresh(), { ...none, days: 1, phase: 'morning' });
        expect(after.accepted).toBe(true);
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('06:00');
    });

    test('first light opens a new day at dawn', () => {
        const after = advanceSceneClock(fresh(), { ...none, days: 1, phase: 'morning' });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('06:00');
    });

    test('a duration keeps the running face and rolls the day', () => {
        const after = advanceSceneClock(fresh(), { ...none, minutes: 180 });
        expect(after.day).toBe(0);
        expect(formatClock(after.minutes)).toBe('22:45');
    });

    test('a long duration rolls into the next day', () => {
        const after = advanceSceneClock(fresh(), { ...none, days: 7 });
        expect(after.day).toBe(7);
        expect(after.minutes).toBe(fresh().minutes);
    });

    test('a direct clock reading outranks the marker\'s phase', () => {
        // The probe read the clock directly — 15:15 — which is more specific than the phase. The
        // model's direct read wins; the marker still moves the day.
        const after = advanceSceneClock(fresh(), { ...none, days: 1, phase: 'afternoon', clockHour: 15, clockMinute: 15 });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('15:15');
    });

    test('a clock alone sets the face without moving the day', () => {
        const after = advanceSceneClock(fresh(), { ...none, clockHour: 21, clockMinute: 30 });
        expect(after.day).toBe(0);
        expect(formatClock(after.minutes)).toBe('21:30');
    });

    test('the -1/-1 "no clock stated" sentinel is refused and falls back to the phase face', () => {
        // The scene schema tells the model to report clock_hour/clock_minute as -1 when the
        // narrative states no clock time. Measured in the Xianxia chat: that sentinel was re-admitted
        // as a real reading whenever a phase was also present, `((-1 % 24) * 60 + -1)` = -61, and
        // `formatClock(-61)` = "22:59" — the face froze at 22:59 while the day rolled. A marker's
        // phase must win when the model wrote no clock.
        const after = advanceSceneClock(fresh(), { ...none, days: 1, phase: 'morning', clockHour: -1, clockMinute: -1 });
        expect(after.accepted).toBe(true);
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('06:00');
    });

    test('the -1 sentinel alone, with no phase either, is a decline not a reversal', () => {
        const after = advanceSceneClock(fresh(), { ...none, clockHour: -1, clockMinute: -1 });
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('unstated');
    });

    test('a changed date rolls the day even with no duration', () => {
        const at = { day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 3, moved: 3, date: 'Wed' };
        const after = advanceSceneClock(at, { ...none, dateChanged: true });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('19:45');
    });

    test('an unchanged date does not roll the day', () => {
        const at = { day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 3, moved: 3, date: 'Wed' };
        const after = advanceSceneClock(at, { ...none, dateChanged: false, clockHour: 21, clockMinute: 30 });
        expect(after.day).toBe(0);
    });

    test('nothing stated is a decline, not a reversal', () => {
        const after = advanceSceneClock(fresh(), none);
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('unstated');
    });

    test('a clock that would go backwards is refused', () => {
        const after = advanceSceneClock(fresh(), { ...none, clockHour: 7, clockMinute: 38 });
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('reversed');
    });

    test('continuous time: dialogue after a phase restatement keeps the running face and advances it', () => {
        // The continuous-time instruction makes the clock advance during same-day dialogue, so a
        // clock that reached 06:45 must not be snapped back by the model re-reporting
        // `phase: "morning"` (its fixed face is 06:00) — that is a restatement, not a move, and it
        // used to refuse the whole pass as `reversed`, freezing the clock again. The restated phase
        // face is dropped and the duration path advances 06:45 -> 06:50.
        const at = { day: 0, minutes: 6 * 60 + 45, raw: '06:45', seen: 3, moved: 3, date: '' };
        const after = advanceSceneClock(at, { ...none, minutes: 5, phase: 'morning' });
        expect(after.accepted).toBe(true);
        expect(formatClock(after.minutes)).toBe('06:50');
    });

    test('continuous time: a restated phase alone, with no elapsed, is a decline not a reversal', () => {
        const at = { day: 0, minutes: 6 * 60 + 45, raw: '06:45', seen: 3, moved: 3, date: '' };
        const after = advanceSceneClock(at, { ...none, phase: 'morning' });
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('unstated');
    });

    test('a same-day transition to a LATER phase still sets the face', () => {
        // "morning" -> "afternoon" is a real move forward on the same day; the phase face must
        // apply, not be treated as a restatement.
        const at = { day: 0, minutes: 6 * 60 + 45, raw: '06:45', seen: 3, moved: 3, date: '' };
        const after = advanceSceneClock(at, { ...none, phase: 'afternoon' });
        expect(after.accepted).toBe(true);
        expect(formatClock(after.minutes)).toBe('13:00');
    });
});

describe('skipClock', () => {
    const at103 = { day: 0, minutes: 783, raw: '13:03', date: 'Wed', seen: 5, moved: 1 };

    test('the afternoon that went missing', () => {
        const after = skipClock(at103, 210);
        expect(after.accepted).toBe(true);
        expect(formatClock(after.minutes)).toBe('16:33');
    });

    test('crossing midnight rolls the day', () => {
        const late = skipClock({ ...at103, minutes: 1380 }, 120);
        expect(late.day).toBe(1);
        expect(formatClock(late.minutes)).toBe('01:00');
    });

    test('a skip clears staleness, because the clock genuinely moved', () => {
        expect(isClockStale(skipClock(at103, 210))).toBe(false);
    });

    test('a long skip is allowed — it is an assertion, not a misparse', () => {
        // "I spend the next three months rebuilding the fleet" is the premise of a scenario, not
        // an error. `skipClock` is the pure arithmetic that a declared duration (from the scene
        // probe's elapsed_minutes, or a calendar front's cadence) drives.
        expect(skipClock(at103, 3 * 1440 * 30).day).toBe(90);
        expect(skipClock(at103, 2 * 1440 * 7).day).toBe(14);
        expect(skipClock(at103, 1440).day).toBe(1);
    });

    test('a month-long skip rolls the day count, not just the clock', () => {
        const after = skipClock(at103, 30 * 1440);
        expect(after.day).toBe(30);
        expect(formatClock(after.minutes)).toBe('13:03');
    });

    test('only a runaway parse is capped', () => {
        expect(skipClock(at103, MAX_SKIP * 100).day).toBeLessThanOrEqual(365 * 10 + 1);
    });

    test('a clock never established is not advanced by a skip', () => {
        expect(skipClock({ day: 0, minutes: NaN, seen: 3, moved: 0 }, 60).accepted).toBe(false);
    });
});
