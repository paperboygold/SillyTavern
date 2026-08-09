import { describe, expect, test } from '@jest/globals';

import {
    CLOCK_STALE_AFTER,
    advanceClock,
    advanceSceneClock,
    clockAge,
    clockScalar,
    findDeadline,
    formatClock,
    formatDate,
    formatGap,
    MAX_SKIP,
    isClockStale,
    parseClock,
    parseElapsed,
    parseSceneElapsed,
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

    test('reads named times', () => {
        expect(parseClock('around midnight')).toBe(0);
        expect(parseClock('noon')).toBe(720);
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

describe('findDeadline — a scheduled time, not merely a time', () => {
    test('finds the time the fiction scheduled', () => {
        expect(findDeadline('RPD contractor systems are scheduled to go offline at 8:00 AM'))
            .toBe(8 * 60);
        expect(findDeadline('the clinic locks up by 6 PM')).toBe(18 * 60);
    });

    test('a time with no scheduling preposition is history, not a countdown', () => {
        // Without this, every past event in a lead would render as something about to expire.
        expect(findDeadline('she was last seen 7:15 AM')).toBeNull();
        expect(findDeadline('the 8:00 AM bus was cancelled')).toBeNull();
    });

    test('is total over text with no time at all', () => {
        expect(findDeadline('Umbrella contractor access is suspended pending review')).toBeNull();
        expect(findDeadline('')).toBeNull();
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
    test('compresses a written date to a scannable one', () => {
        expect(formatDate('Wednesday, September 23, 1998')).toBe('Wed 23 Sep 1998');
    });

    test('copes without a weekday or a year', () => {
        expect(formatDate('September 23')).toBe('23 Sep');
    });

    test('leaves alone what it cannot parse', () => {
        // A card may be running a calendar no date library has heard of, and mangling that is
        // worse than showing it as written.
        expect(formatDate('the fourth day of the Long Dark')).toBe('the fourth day of the Long Dark');
        expect(formatDate('')).toBe('');
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

describe('parseElapsed — the player is the authority on their own time skips', () => {
    test('reads the phrasings actually used in play', () => {
        // Measured: 3 of 29 player turns skip time explicitly and nothing acted on any of them.
        expect(parseElapsed('I continue working for the next several hours.')).toBe(210);
        expect(parseElapsed('I spend a couple of hours on the compiler.')).toBe(120);
        expect(parseElapsed('I keep at it for another hour.')).toBe(60);
        expect(parseElapsed('I wait for a few minutes.')).toBe(15);
        expect(parseElapsed('I work on it for the rest of the day.')).toBe(300);
    });

    test('reads an explicit count', () => {
        expect(parseElapsed('I continue for 3 hours.')).toBe(180);
        expect(parseElapsed('I wait for 45 minutes.')).toBe(45);
    });

    test('a skip has to be ASSERTED, not merely mentioned', () => {
        expect(parseElapsed('It has been a strange few hours.')).toBeNull();
        expect(parseElapsed('She mentioned several hours of delays.')).toBeNull();
    });

    test('backwards phrasing never advances the clock', () => {
        expect(parseElapsed('I remember waiting for several hours yesterday.')).toBeNull();
        expect(parseElapsed('I spent an hour on it earlier.')).toBeNull();
    });

    test('is total over nothing', () => {
        expect(parseElapsed('')).toBeNull();
        expect(parseElapsed(null)).toBeNull();
        expect(parseElapsed('I frown a bit.')).toBeNull();
    });

    test('a narrator\'s scene transition moves the clock too', () => {
        // The Royal Succession chat: the narrator wrote "The week settles into a rhythm of early
        // mornings", "Come morning I rise early", "First light comes grey and cold", "the study is
        // cool in the early morning" — and the clock never advanced, because the old gate only
        // recognised a player's declarative "spend/continue/wait". A forward scene-break marker is
        // as unambiguous a claim as "spend": "come morning" and "first light" are a night's
        // passage, "the week settles" is the week it names.
        expect(parseElapsed('Come morning I rise early, and go to walk the grounds.')).toBe(1440);
        expect(parseElapsed('The next morning, assuming nobody kills me in the night, I rise.')).toBe(1440);
        expect(parseElapsed('First light comes grey and cold through the tower window.')).toBe(1440);
        expect(parseElapsed('The study is cool in the early morning, the fire laid but not yet lit.')).toBe(1440);
        expect(parseElapsed('The week settles into a rhythm of early mornings and quiet evenings.')).toBe(7 * 1440);
        expect(parseElapsed('A day passes by in the muster camp.')).toBe(1440);
        expect(parseElapsed('The month settles into a routine.')).toBe(30 * 1440);
    });

    test('"overnight" is the night that passed, not a backward reference', () => {
        // "the wind having died overnight" is the night just gone — a transition to the morning
        // that followed it. The old backward-gate rejected "overnight" like "last night", freezing
        // the clock on the new day's opening.
        expect(parseElapsed('First light comes grey and cold through the tower window, the wind having died overnight.')).toBe(1440);
    });

    test('backwards phrasings are still history', () => {
        expect(parseElapsed('It was last night that the courier died.')).toBeNull();
        expect(parseElapsed('I remember the week we spent in the capital yesterday.')).toBeNull();
    });

    test('the earliest transition in the text wins over a later detail', () => {
        // A message that opens with "The week settles" and later mentions "one day" skipped a
        // WEEK; the loop must not let the later, smaller mention win just because its span sits
        // earlier in the table.
        expect(parseElapsed('The week settles into a rhythm of early mornings. The election comes one day later.')).toBe(7 * 1440);
    });

    test('"a day\'s ride" is a distance, not a passage of time', () => {
        // The genitive 's marks a measurement ("a day's ride", "a week's wages"), never elapsed
        // time. Advancing the clock off it would run the story forward for a figure of speech.
        expect(parseElapsed('He will not march a day\'s ride to meet them.')).toBeNull();
        expect(parseElapsed('It was a week\'s journey to the capital.')).toBeNull();
    });
});

describe('parseSceneElapsed — the scene probe is the authority, not an English gate', () => {
    test('reads the durations the scene probe reports', () => {
        // The scene probe answers "how much time passed?" with the phrase the narrative used. No
        // assertion gate, because the model has already asserted it — the gate exists only to prove
        // a PLAYER's free-form message is not a memory.
        expect(parseSceneElapsed('a week')).toEqual({ days: 7, minutes: 0, phase: null });
        expect(parseSceneElapsed('3 hours')).toEqual({ days: 0, minutes: 180, phase: null });
        expect(parseSceneElapsed('three hours')).toEqual({ days: 0, minutes: 180, phase: null });
        expect(parseSceneElapsed('a couple of days')).toEqual({ days: 2, minutes: 0, phase: null });
    });

    test('scene-transition markers carry a phase, not just a day', () => {
        // "come morning" does NOT mean "add 24 hours to whatever time it is" — it means the scene
        // moved to the MORNING of the next day. The day rolls AND the face lands. This is the fix
        // for the Royal Succession court that assembled "at first light" and read 19:45.
        expect(parseSceneElapsed('overnight')).toEqual({ days: 1, minutes: 0, phase: 6 * 60 });
        expect(parseSceneElapsed('come morning')).toEqual({ days: 1, minutes: 0, phase: 6 * 60 });
        expect(parseSceneElapsed('the next morning')).toEqual({ days: 1, minutes: 0, phase: 6 * 60 });
        expect(parseSceneElapsed('the early morning')).toEqual({ days: 1, minutes: 0, phase: 6 * 60 });
        expect(parseSceneElapsed('first light')).toEqual({ days: 1, minutes: 0, phase: 6 * 60 });
        expect(parseSceneElapsed('come afternoon')).toEqual({ days: 1, minutes: 0, phase: 13 * 60 });
        expect(parseSceneElapsed('the next evening')).toEqual({ days: 1, minutes: 0, phase: 18 * 60 });
        expect(parseSceneElapsed('the next night')).toEqual({ days: 1, minutes: 0, phase: 21 * 60 });
        // A bare "the next day" carries no part of a day — the face keeps running, only the day moves.
        expect(parseSceneElapsed('the next day')).toEqual({ days: 1, minutes: 0, phase: null });
    });

    test('is empty-total and needs no assertion gate', () => {
        expect(parseSceneElapsed('')).toBeNull();
        expect(parseSceneElapsed(null)).toBeNull();
        expect(parseSceneElapsed('yesterday')).toBeNull();
        // The model reported the passage already; the phrase needs no "spend/continue" to be read.
        expect(parseSceneElapsed('passage of one week')).toEqual({ days: 7, minutes: 0, phase: null });
    });
});

describe('advanceSceneClock — elapsed moves the day, time sets the face, one update', () => {
    const fresh = () => ({ day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' });

    test('a transition marker moves to the next day at the marker\'s phase', () => {
        // The Royal Succession bug, end to end: the clock sat at 19:45, the story said "come
        // morning", and the clock must land on MORNING of the next day, not 19:45 again.
        const after = advanceSceneClock(fresh(), { elapsed: 'come morning' });
        expect(after.accepted).toBe(true);
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('06:00');
    });

    test('first light opens a new day at dawn', () => {
        const after = advanceSceneClock(fresh(), { elapsed: 'first light' });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('06:00');
    });

    test('a duration keeps the running face and rolls the day', () => {
        const after = advanceSceneClock(fresh(), { elapsed: 'three hours' });
        expect(after.day).toBe(0);
        expect(formatClock(after.minutes)).toBe('22:45');
    });

    test('a long duration rolls into the next day', () => {
        const after = advanceSceneClock(fresh(), { elapsed: 'a week' });
        expect(after.day).toBe(7);
        expect(after.minutes).toBe(fresh().minutes);
    });

    test('a parseable time outranks the marker\'s phase', () => {
        // The probe read the clock directly — "3:15 PM" — which is more specific than "the next
        // afternoon" (13:00). The model's direct read wins; the marker still moves the day.
        const after = advanceSceneClock(fresh(), { elapsed: 'come afternoon', time: '3:15 PM' });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('15:15');
    });

    test('a time alone sets the face without moving the day', () => {
        const after = advanceSceneClock(fresh(), { time: '9:30 PM' });
        expect(after.day).toBe(0);
        expect(formatClock(after.minutes)).toBe('21:30');
    });

    test('a changed date rolls the day even with no duration', () => {
        const at = { day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 3, moved: 3, date: 'Wed' };
        const after = advanceSceneClock(at, { date: 'Thu' });
        expect(after.day).toBe(1);
        expect(formatClock(after.minutes)).toBe('19:45');
        expect(after.date).toBe('Thu');
    });

    test('an unchanged date does not roll the day', () => {
        const at = { day: 0, minutes: 19 * 60 + 45, raw: '19:45', seen: 3, moved: 3, date: 'Wed' };
        const after = advanceSceneClock(at, { date: 'Wed', time: '9:30 PM' });
        expect(after.day).toBe(0);
    });

    test('neither elapsed nor a parseable time is a decline, not a reversal', () => {
        const after = advanceSceneClock(fresh(), { elapsed: '', time: 'just after dawn' });
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('unstated');
    });

    test('a clock that would go backwards is refused', () => {
        const after = advanceSceneClock(fresh(), { time: '7:38 AM' });
        expect(after.accepted).toBe(false);
        expect(after.reason).toBe('reversed');
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
        // an error. The guard is that a skip must be ASSERTED, not that it must be short.
        expect(parseElapsed('I spend the next three months rebuilding.')).toBeNull();
        expect(parseElapsed('I spend the next 3 months rebuilding.')).toBe(3 * 1440 * 30);
        expect(parseElapsed('I wait for 2 weeks.')).toBe(2 * 1440 * 7);
        expect(parseElapsed('I rest for a day.')).toBe(1440);
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
