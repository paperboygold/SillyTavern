import { describe, expect, test } from '@jest/globals';

import { advanceSceneClock, formatClock, parseClock } from '../public/scripts/extensions/fold/clock.js';

import fs from 'fs';

const CHAT = '../data/default-user/chats/Royal Succession/Royal Succession - 2026-08-09@01h05m18s297ms.jsonl';

// The transition phrases the scene probe is told to read, and the one narrative pattern the
// clock previously failed on: a marker advances the DAY and sets the FACE, so the story's
// "come morning"/"first light" scenes land on a morning, never on a frozen 19:45.
const MARKERS = [
    /\bcome\s+(?:the\s+)?(?:next\s+)?(?:morning|afternoon|evening|night|day)\b/,
    /\bfirst\s+light\b/,
    /\bovernight\b/,
    /\bthe\s+(?:next|following)\s+(?:morning|afternoon|evening|night|day)\b/,
    /\bthe\s+early\s+morning\b/,
    /\bat\s+dawn\b/,
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

describe('Royal Succession clock replay — transition markers set the face', () => {
    const lines = fs.readFileSync(CHAT, 'utf8').split('\n').filter(l => l.trim());

    test('the chat actually contains transition markers', () => {
        let total = 0;
        for (const l of lines) {
            try { total += markersIn(JSON.parse(l).mes).length; } catch { /* header */ }
        }
        console.log('transition markers in chat:', total);
        expect(total).toBeGreaterThan(5);
    });

    test('walking the chat\'s markers from a 19:45 start lands the clock on a morning face', () => {
        let clock = { day: 1, minutes: 19 * 60 + 45, raw: '19:45', seen: 0, moved: 0, date: '' };
        let markerCount = 0;
        for (const l of lines) {
            let text = '';
            try { text = JSON.parse(l).mes ?? ''; } catch { continue; }
            for (const marker of markersIn(text)) {
                const after = advanceSceneClock(clock, { elapsed: marker });
                if (after.accepted) {
                    clock = after;
                    markerCount++;
                }
            }
        }
        console.log(`markers applied: ${markerCount}; final clock: day ${clock.day}, ${formatClock(clock.minutes)}`);
        // The story is a court scene at first light / morning. With the fix, the face cannot be
        // frozen at the old 19:45: the last markers move it to a morning hour.
        const finalMinutes = clock.minutes;
        expect(markerCount).toBeGreaterThan(10);
        expect(finalMinutes).toBeLessThan(12 * 60);
        expect(clock.day).toBeGreaterThan(1);
    });

    test('parseClock can read the times the narrative states', () => {
        // Sanity: the probe's `time` field outranks a marker, and the parser reads the hours the
        // story actually names.
        expect(parseClock('just after dawn')).toBeNull();
        expect(parseClock('3:15 PM')).toBe(15 * 60 + 15);
    });
});
