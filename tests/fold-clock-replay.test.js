import { describe, expect, test } from '@jest/globals';

import { advanceSceneClock, formatClock, parseClock } from '../public/scripts/extensions/fold/clock.js';

import fs from 'fs';

const CHAT = '../data/default-user/chats/Royal Succession/Royal Succession - 2026-08-09@01h05m18s297ms.jsonl';

// The transition markers the scene probe is told to report as a structured `phase`, and the one
// narrative pattern the clock previously failed on: a marker advances the DAY and sets the FACE,
// so the story's "come morning"/"first light" scenes land on a morning, never on a frozen 19:45.
// The model reads the prose and answers `{days: 1, phase: "morning"}`; fold maps the enum to an
// hour. This fixture names the markers the probe would translate — the chat proves they occur, the
// structured answer proves the clock lands on morning from them.
const MARKERS = [
    /come\s+(?:the\s+)?(?:next\s+)?morning\b/,
    /first\s+light\b/,
    /overnight\b/,
    /the\s+(?:next|following)\s+morning\b/,
    /the\s+early\s+morning\b/,
    /at\s+dawn\b/,
];

function markersIn(text) {
    const lower = String(text ?? '').toLowerCase();
    const found = [];
    for (const re of MARKERS) {
        const m = lower.match(re);
        if (m) found.push(m[0]);
    }
    return found;
}

describe('Royal Succession clock replay — the structured phase answer sets the face', () => {
    const lines = fs.readFileSync(CHAT, 'utf8').split('\n').filter(l => l.trim());

    test('the chat actually contains morning transitions', () => {
        let total = 0;
        for (const l of lines) {
            try { total += markersIn(JSON.parse(l).mes).length; } catch { /* header */ }
        }
        console.log('morning transitions in chat:', total);
        expect(total).toBeGreaterThan(5);
    });

    test('answering each morning transition as {days:1, phase:"morning"} lands the clock on a morning face', () => {
        // The probe reads the prose and answers the structured fields. Every morning transition in
        // the transcript is that answer; the clock rolls the day and lands at 06:00, never the old
        // 19:45 — the Royal Succession court assembled "at first light" and used to read a frozen
        // evening.
        let clock = { day: 1, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' };
        let markerCount = 0;
        for (const l of lines) {
            let text = '';
            try { text = JSON.parse(l).mes ?? ''; } catch { continue; }
            if (markersIn(text).length) {
                const after = advanceSceneClock(clock, {
                    days: 1, minutes: 0, phase: 'morning', clockHour: NaN, clockMinute: NaN, dateChanged: false,
                });
                if (after.accepted) {
                    clock = after;
                    markerCount++;
                }
            }
        }
        console.log(`markers applied: ${markerCount}; final clock: day ${clock.day}, ${formatClock(clock.minutes)}`);
        // The story is a court scene at first light / morning. With the fix, the face cannot be
        // frozen at the old 19:45: every morning transition lands at a morning hour.
        const finalMinutes = clock.minutes;
        expect(markerCount).toBeGreaterThan(5);
        expect(finalMinutes).toBeLessThan(12 * 60);
        expect(clock.day).toBeGreaterThan(1);
    });

    test('parseClock reads only the numeric clock shape the block path uses', () => {
        // The card's status block `Time:` field is parsed structurally (colon/meridiem shapes).
        // "just after dawn" is prose — the probe reports it as clock_hour 6, never a parser guess.
        expect(parseClock('just after dawn')).toBeNull();
        expect(parseClock('3:15 PM')).toBe(15 * 60 + 15);
    });
});
