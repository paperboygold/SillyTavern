import { describe, expect, test } from '@jest/globals';

import {
    buildSteerTable,
    FOLD_STEER_DIRECTION,
    isSteered,
    normalizeSteer,
    renderSteerTemplate,
    STEER_FLOOR,
    steerForMessage,
    steerForSwipe,
} from '../public/scripts/extensions/sanguine/steer-table.js';

/**
 * Build a synthetic chat message. `steers` is one entry per swipe: a string means that swipe was
 * steered with that instruction, null means it was a plain swipe.
 * @param {(string|null)[]} steers One entry per swipe.
 * @returns {object} A chat message shaped like SillyTavern's.
 */
function message(steers) {
    return {
        mes: 'text',
        swipe_id: 0,
        swipes: steers.map((_, i) => `swipe ${i}`),
        swipe_info: steers.map(text => ({
            send_date: 0,
            extra: text
                ? { sanguine_steer: { text, direction: FOLD_STEER_DIRECTION.STEER, at: 1, source: 'ui' } }
                : {},
        })),
    };
}

describe('buildSteerTable, the Graph face over a chat', () => {
    test('keys by message id, one edge per swipe, in swipe order', () => {
        const chat = [
            message(['make her angrier', null, 'shorter']),
            message([null]),
        ];
        const table = buildSteerTable(chat);

        expect(table.get(0).map(s => s.text)).toEqual(['make her angrier', '', 'shorter']);
        expect(table.get(1).map(s => s.text)).toEqual(['']);
    });

    test('un-steered swipes materialise as the floor, not undefined', () => {
        const table = buildSteerTable([message([null, null])]);
        expect(table.get(0)).toEqual([STEER_FLOOR, STEER_FLOOR]);
    });

    test('messages without swipe_info contribute no key', () => {
        const chat = [
            { mes: 'a user message', is_user: true },
            message(['steered']),
            { mes: 'no swipes here', swipes: ['x'] },
        ];
        const table = buildSteerTable(chat);

        expect(table.has(0)).toBe(false);
        expect(table.has(2)).toBe(false);
        expect(table.get(1).map(s => s.text)).toEqual(['steered']);
    });

    test('an empty chat yields an empty table', () => {
        expect(buildSteerTable([]).size).toBe(0);
        expect(buildSteerTable(null).size).toBe(0);
    });
});

describe('steerForSwipe, total read off the table', () => {
    test('reads the record for a given message and swipe', () => {
        const table = buildSteerTable([message([null, 'be brief'])]);
        expect(steerForSwipe(table, 0, 1).text).toBe('be brief');
    });

    test('floors an absent message id and an out-of-range swipe id', () => {
        const table = buildSteerTable([message(['x'])]);
        expect(steerForSwipe(table, 99, 0)).toBe(STEER_FLOOR);
        expect(steerForSwipe(table, 0, 99)).toBe(STEER_FLOOR);
    });
});

describe('steerForMessage, the single-message shortcut', () => {
    test('agrees with the table read', () => {
        const msg = message([null, 'be brief']);
        const table = buildSteerTable([msg]);
        expect(steerForMessage(msg, 1)).toEqual(steerForSwipe(table, 0, 1));
    });

    test('floors missing messages and swipes', () => {
        expect(steerForMessage(undefined, 0)).toBe(STEER_FLOOR);
        expect(steerForMessage(message([null]), 5)).toBe(STEER_FLOOR);
    });
});

describe('normalizeSteer, chat files are user-editable and travel between installs', () => {
    test('degrades malformed records to the floor', () => {
        const malformed = {
            null: null,
            undefined: undefined,
            bareString: 'make her angrier',
            emptyText: { text: '', direction: 'steer' },
            whitespaceText: { text: '   ', direction: 'steer' },
            nonStringText: { text: 42, direction: 'steer' },
        };

        // Asserting the whole map at once so a failure names the case that broke.
        const normalized = Object.fromEntries(
            Object.entries(malformed).map(([label, value]) => [label, normalizeSteer(value)]));

        expect(normalized).toEqual(
            Object.fromEntries(Object.keys(malformed).map(label => [label, STEER_FLOOR])));
    });

    test('repairs an unknown direction rather than dropping the instruction', () => {
        const repaired = normalizeSteer({ text: 'hello', direction: 'nonsense' });
        expect(repaired.text).toBe('hello');
        expect(repaired.direction).toBe(FOLD_STEER_DIRECTION.STEER);
    });
});

describe('isSteered', () => {
    test('is true only for a steered record with real text', () => {
        expect(isSteered({ text: 'x', direction: FOLD_STEER_DIRECTION.STEER })).toBe(true);
        expect(isSteered(STEER_FLOOR)).toBe(false);
        expect(isSteered({ text: '', direction: FOLD_STEER_DIRECTION.STEER })).toBe(false);
        expect(isSteered({ text: 'x', direction: FOLD_STEER_DIRECTION.RETRY })).toBe(false);
        expect(isSteered(undefined)).toBe(false);
    });
});

describe('renderSteerTemplate', () => {
    test('substitutes the instruction', () => {
        expect(renderSteerTemplate('[Instruction: {{instruction}}]', 'be angrier'))
            .toBe('[Instruction: be angrier]');
    });

    test('substitutes every occurrence', () => {
        expect(renderSteerTemplate('{{instruction}} / {{instruction}}', 'x')).toBe('x / x');
    });

    test('never emits a bare template for an empty instruction', () => {
        expect(renderSteerTemplate('[Instruction: {{instruction}}]', '')).toBe('');
        expect(renderSteerTemplate('[Instruction: {{instruction}}]', '   ')).toBe('');
        expect(renderSteerTemplate('[Instruction: {{instruction}}]', null)).toBe('');
    });

    test('falls back to the raw instruction when the template lacks the placeholder', () => {
        expect(renderSteerTemplate('nonsense', 'be angrier')).toBe('be angrier');
        expect(renderSteerTemplate('', 'be angrier')).toBe('be angrier');
        expect(renderSteerTemplate(null, 'be angrier')).toBe('be angrier');
    });

    test('trims the instruction', () => {
        expect(renderSteerTemplate('{{instruction}}', '  be angrier  ')).toBe('be angrier');
    });
});
