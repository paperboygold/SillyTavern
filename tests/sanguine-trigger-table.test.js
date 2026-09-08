import { describe, expect, test } from '@jest/globals';

import {
    MAX_INTERVAL,
    MIN_INTERVAL,
    MIN_ATTEMPT_WORDS,
    looksLikeAttempt,
    nextInterval,
    sceneMayHaveMoved,
    shouldExtract,
    wordCount,
} from '../public/scripts/extensions/sanguine/trigger-table.js';

/*
 * A turn is not a quantity of change. One reply can cross a continent and skip a year; the next is
 * two lines in the same room. Measured on a live chat: the panel read "the hobgoblin's chamber"
 * three turns after the party had left it, because extraction was scheduled by turn count.
 */
describe('shouldExtract, the interval is a ceiling, not a schedule', () => {
    test('the ceiling still holds when nothing else fires', () => {
        expect(shouldExtract({ since: 4, interval: 4, text: 'they talk quietly' }))
            .toEqual({ run: true, why: 'interval' });
    });

    test('a declared time skip is the model\'s report, not a prose pre-filter', () => {
        // The cadence gate used to read "We rest for a week" with an English verb list. Time
        // passage is now the scene probe's comprehension answer (elapsed_days/elapsed_minutes),
        // reported on the extraction it triggers by interval. The gate must not guess it from prose.
        expect(shouldExtract({ since: 1, interval: 4, text: 'We rest for a week before setting out.' }))
            .toEqual({ run: false, why: 'waiting' });
    });

    test('travel language does NOT fire, it was measured and deleted', () => {
        // Built, then measured against a real 47-message chat: 23/24 narrator messages and 13/23
        // player messages matched. `head` is a body part, `reaches` is what you do to a dagger,
        // "the next" is far more often "the next chamber" than "the next morning". A signal that
        // fires on nearly every turn is a shorter interval wearing a heuristic's clothes.
        expect(shouldExtract({ since: 1, interval: 8, text: 'We head down into the next chamber.' }))
            .toEqual({ run: false, why: 'waiting' });
        expect(sceneMayHaveMoved('He reaches for the dagger and steps into the light.').moved).toBe(false);
    });

    test('the adaptive interval tightens on change and backs off on quiet', () => {
        expect(nextInterval({ current: 6, changed: true })).toBe(MIN_INTERVAL);
        expect(nextInterval({ current: MIN_INTERVAL, changed: false })).toBe(MIN_INTERVAL + 1);
        expect(nextInterval({ current: MAX_INTERVAL, changed: false })).toBe(MAX_INTERVAL);
        // Additive, not doubling: doubling reaches the ceiling in two steps and throws away the
        // resolution this exists to provide.
        expect(nextInterval({ current: 3, changed: false })).toBe(4);
    });

    test('a state block is a handover and fires immediately', () => {
        expect(shouldExtract({ since: 1, interval: 4, text: 'nothing moves', block: true }))
            .toEqual({ run: true, why: 'state block' });
    });

    test('an ordinary exchange waits', () => {
        expect(shouldExtract({ since: 2, interval: 4, text: 'She looks at him and says nothing.' }))
            .toEqual({ run: false, why: 'waiting' });
    });

    test('never twice for the same turn', () => {
        // Without this a movement signal re-fires on every repaint of an already-read reply.
        expect(shouldExtract({ since: 0, interval: 4, text: 'We travel to the capital.' }))
            .toEqual({ run: false, why: 'already current' });
    });

    test('an action inside a room is not a scene move', () => {
        // Otherwise every fight would trigger an extraction per swing.
        expect(sceneMayHaveMoved('He strikes the hobgoblin across the jaw.').moved).toBe(false);
    });

    test('a horizontal rule is a scene break, the one shape that is punctuation, not vocabulary', () => {
        expect(sceneMayHaveMoved('---').moved).toBe(true);
        expect(sceneMayHaveMoved('***\n').moved).toBe(true);
        // English time phrases are the model's report now, not a gate's guess.
        expect(sceneMayHaveMoved('The next morning, the camp stirs.').moved).toBe(false);
        expect(sceneMayHaveMoved('Hours later, the fire is out.').moved).toBe(false);
        expect(sceneMayHaveMoved('We push into the next chamber.').moved).toBe(false);
    });
});

/*
 * The gate was a list of English contested verbs. It ran ~50% precision on a real chat, and, far
 * worse, silently disabled the whole feature for anyone not writing in English. It is now
 * structural: shape and punctuation, which mean the same thing in every script, deciding only
 * whether to SPEND A CALL. Whether the outcome is in doubt is the classifier's `contested` field.
 */
describe('looksLikeAttempt, structural, so it works in any language', () => {
    test('narration outside quotes is worth a call, in any script', () => {
        for (const said of [
            'I climb the outer wall in daylight.',
            '我爬上外墙，试图翻过去。',
            'Я перелезаю через стену.',
            '성벽을 기어오른다.',
        ]) {
            expect(looksLikeAttempt(said).attempt).toBe(true);
        }
    });

    test('word counting is script-aware, not space-splitting', () => {
        // Spaces do not delimit words in Chinese; a space-splitter counts this as one.
        expect(wordCount('我爬上外墙，试图翻过去。')).toBeGreaterThan(MIN_ATTEMPT_WORDS);
        // And a CHARACTER count would punish it for being dense, a full sentence in 12 characters.
        expect('我爬上外墙，试图翻过去'.length).toBeLessThan(13);
    });

    test('pure dialogue is not an attempt, including CJK and guillemet quoting', () => {
        for (const said of ['"It is fine."', '「わかった」', '«Всё хорошо»', '『そうですね』']) {
            expect(looksLikeAttempt(said).attempt).toBe(false);
        }
    });

    test('acknowledgements are skipped in any language', () => {
        for (const said of ['ok', 'yes', '네.', '好', 'да']) {
            expect(looksLikeAttempt(said).attempt).toBe(false);
        }
    });

    test('out-of-character markers are punctuation, not vocabulary', () => {
        for (const said of ['((can we rewind that))', '[[skip ahead]]', '// stop', 'OOC: what rank is she?']) {
            expect(looksLikeAttempt(said).attempt).toBe(false);
        }
    });

    test('an action alongside speech still counts', () => {
        expect(looksLikeAttempt('"Stay back," I say, and I shove him into the wall.').attempt).toBe(true);
    });

    test('it does NOT try to judge whether the outcome is in doubt', () => {
        // "I look around the chamber" passes the gate and is then rejected by the classifier as
        // uncontested. That split is the design: structure here, comprehension there.
        expect(looksLikeAttempt('I look around the chamber.').attempt).toBe(true);
    });

    test('every decision carries a reason, so the counters can say why', () => {
        for (const said of ['', 'ok', '"hi"', 'I climb the wall carefully.']) {
            expect(looksLikeAttempt(said).why).toBeTruthy();
        }
    });
});
