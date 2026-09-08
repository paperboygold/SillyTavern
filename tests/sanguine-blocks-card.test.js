import { describe, expect, test } from '@jest/globals';

import {
    MAX_CHOICES,
    clearChoices,
    lastChoices,
    normalizeChoices,
    setChoices,
} from '../public/scripts/extensions/sanguine/choices.js';
import { buildCardHtml } from '../public/scripts/extensions/sanguine/card-html.js';

const view = {
    scene: {
        time: '08:18',
        date: 'Wednesday, September 23, 1998',
        location: 'the apartment',
        weather: 'overcast, cool',
        pov: 'Solomon',
    },
    vitals: [{ name: 'hp', cur: 30, max: 40 }],
    conditions: [{ phrase: 'bruised ribs', severity: 'moderate' }],
    inventory: [
        { mine: true, place: 'carried', display: 'ka-bar knife', qty: 1 },
        { mine: true, place: 'car', display: 'food', qty: 5 },
        { mine: false, place: 'carried', display: 'Lee\'s jacket', qty: 1 },
    ],
    threads: {
        pressure: [{ name: 'goblin nest counterattacks', dial: { filled: 3, size: 4 } }],
        progress: [],
        open: [{ name: 'the missing shipment' }],
    },
    choices: ['Follow her out', 'Stay and finish the audit'],
};

describe('buildCardHtml: the state card renders the derived state', () => {
    test('scene chips, a vitals bar, condition chips, inventory by place, dials and choices', () => {
        const html = buildCardHtml(view);
        expect(html).toContain('ka-bar knife');
        expect(html).toContain('Stored (car)');
        expect(html).toContain('food x5');
        expect(html).toContain('hp');
        expect(html).toContain('30 / 40');
        expect(html).toContain('bruised ribs');
        expect(html).toContain('goblin nest counterattacks');
        expect(html).toContain('Follow her out');
    });

    test('a choice button carries its exact text for the fill action', () => {
        const html = buildCardHtml(view);
        const attrs = [...html.matchAll(/data-sanguine-choice="[^"]*"/g)].map(match => match[0]);
        expect(attrs).toEqual([
            'data-sanguine-choice="Follow her out"',
            'data-sanguine-choice="Stay and finish the audit"',
        ]);
    });

    test('someone else\'s belongings stay off the card', () => {
        expect(buildCardHtml(view)).not.toContain('Lee');
    });

    test('model output is escaped, never injected', () => {
        const html = buildCardHtml({ ...view, choices: ['<script>alert(1)</script>'] });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    test('an empty view renders nothing', () => {
        expect(buildCardHtml({})).toBe('');
    });
});

describe('normalizeChoices: the model\'s suggestions, bounded and deduped', () => {
    test('trims, drops empties, dedupes and caps at MAX_CHOICES', () => {
        expect(normalizeChoices(['  Follow her out ', '', 'follow her out', 'A', 'B', 'C', 'D', 'E']))
            .toEqual(['Follow her out', 'A', 'B', 'C']);
        expect(normalizeChoices('not an array')).toEqual([]);
        expect(normalizeChoices([null, 42])).toEqual(['42']);
    });

    test('the store holds the last pass only and clears', () => {
        setChoices(['one', 'two']);
        expect(lastChoices()).toEqual(['one', 'two']);
        clearChoices();
        expect(lastChoices()).toEqual([]);
        expect(MAX_CHOICES).toBe(4);
    });
});
