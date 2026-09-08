import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    foldEntity,
    renderEntities,
} from '../public/scripts/extensions/sanguine/entity-table.js';

/*
 * The secret: what a person knows that the point-of-view character does not. Megumin's secrets-blur
 * adapted to fold's architecture. The model is told the secret (it wrote it, and it has to roleplay
 * around it), and the player-facing cast overlay renders it blurred until revealed. The blur is
 * purely the player's view; the injected block carries the secret plainly.
 */
describe('the secret field is stored and reaches the model', () => {
    test('foldEntity stores what the person knows that the PC does not', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: 'person', name: 'A.W.', secret: 'they are the one leaking Umbrella data', turn: 1 });
        expect(table.get(key).secret).toBe('they are the one leaking Umbrella data');
    });

    test('an empty secret is not stored', () => {
        const table = new Map();
        const key = foldEntity(table, { kind: 'person', name: 'A.W.', secret: '', turn: 1 });
        expect(String(table.get(key).secret ?? '')).toBe('');
    });

    test('renderEntities carries the secret to the model, labelled', () => {
        const table = new Map();
        foldEntity(table, { kind: 'person', name: 'A.W.', place: 'the apartment', secret: 'they leaked it', turn: 1 });
        const text = renderEntities(table, 2, { at: 'the apartment' });
        expect(text).toContain('secret: they leaked it');
    });
});

/*
 * The blur lives in the browser, so it is pinned by source rather than by execution, the same
 * instrument the cast-diff and prompt-fragments tests use for DOM-only features.
 */
describe('the secret renders blurred for the player', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');

    test('the cast overlay draws the secret blurred until revealed', () => {
        const overlay = fs.readFileSync(path.join(FOLD, 'overlay-cast.js'), 'utf8');
        const css = fs.readFileSync(path.join(FOLD, 'overlay-cast.css'), 'utf8');
        expect(overlay).toContain('prose(t`secret`, person.secret');
        expect(overlay).toContain('sanguine_cast_secret');
        expect(css).toContain('blur');
    });

    test('the entity schema asks the model for the secret', () => {
        const schema = fs.readFileSync(path.join(FOLD, 'entities.js'), 'utf8');
        expect(schema).toContain('secret: {');
        expect(schema).toContain('\'secret\'');
    });
});
