import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    MAX_TRAIL,
    appendTrail,
    handTrailEntries,
} from '../public/scripts/extensions/sanguine/entity-table.js';

/*
 * Megumin's NPC diff, adapted: fold already field-merges the model's writes and records what each
 * replaced in the row's trail (`changesBetween`/`merge_entity`). The gap this closes is the hand
 * path: `entities.patch` wrote changed fields with no trail entry, so a hand edit or an undo was
 * invisible in the history. `handTrailEntries` gives the direct write the same shape, and
 * `appendTrail` applies the same bound, so the two paths cannot drift.
 */
describe('handTrailEntries: a hand write records its diff, nothing else', () => {
    test('a changed TRAILED field records {field, from, to, turn, mid: -1}', () => {
        const row = { wants: 'buy herbs', knows: 'the cellar door' };
        const entries = handTrailEntries(row, { wants: 'avoid the apothecary', looks: 'scowling' }, 14);
        expect(entries).toEqual([
            { field: 'wants', from: 'buy herbs', to: 'avoid the apothecary', turn: 14, mid: -1 },
        ]);
    });

    test('an unchanged field records nothing', () => {
        expect(handTrailEntries({ wants: 'x' }, { wants: 'x' }, 1)).toEqual([]);
    });

    test('a first reading records from: ""', () => {
        expect(handTrailEntries({}, { knows: 'the cellar door' }, 3))
            .toEqual([{ field: 'knows', from: '', to: 'the cellar door', turn: 3, mid: -1 }]);
    });

    test('an undo is just a hand write whose to is the value being reverted to', () => {
        const entries = handTrailEntries({ wants: 'avoid the apothecary' }, { wants: 'buy herbs' }, 15);
        expect(entries).toEqual([{ field: 'wants', from: 'avoid the apothecary', to: 'buy herbs', turn: 15, mid: -1 }]);
    });
});

describe('appendTrail: bounded like the merge path', () => {
    test('newest kept, oldest dropped past MAX_TRAIL', () => {
        let trail = [];
        for (let i = 0; i < MAX_TRAIL + 5; i++) {
            trail = appendTrail(trail, [{ field: 'wants', from: String(i), to: String(i + 1), turn: i, mid: -1 }]);
        }
        expect(trail.length).toBe(MAX_TRAIL);
        expect(trail[0].from).toBe(String(5));
        expect(trail[trail.length - 1].from).toBe(String(MAX_TRAIL + 4));
    });

    test('a row with no trail starts one', () => {
        expect(appendTrail(undefined, [{ field: 'wants', from: '', to: 'x', turn: 1, mid: -1 }]))
            .toHaveLength(1);
    });
});

/*
 * The undo control lives in the browser, so it is pinned by source rather than by execution, the
 * same instrument the player-persona and scene-header tests use.
 */
describe('the cast trail wires a per-line undo', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');
    const overlay = fs.readFileSync(path.join(FOLD, 'overlay-cast.js'), 'utf8');
    const edits = fs.readFileSync(path.join(FOLD, 'edits.js'), 'utf8');

    test('edits exposes undoCastChange and it reverts the field to `from`', () => {
        expect(edits).toContain('export function undoCastChange');
        expect(edits).toContain('entities.patch(key, { [field]: from }');
    });

    test('the trail row draws an undo button that calls it', () => {
        expect(overlay).toContain('edits.undoCastChange(key, change)');
        expect(overlay).toContain('sanguine_cast_change_undo');
    });
});
