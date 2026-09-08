import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The fold companion sometimes mistook another cast member for the player character, at
 * initialization (before the first scene probe had run, so `pov` was empty and the block said
 * nothing about who the reader is) and mid-game (a stretch narrated from another character's
 * shoulder). The persona is the ground truth for identity, so fold now states it outright in the
 * state block and feeds the name to the scene probe so `pov` anchors to the actual player.
 *
 * The block renderer lives in `state.js`, which imports `script.js` and cannot be unit-tested, so
 * this reads the source, the same instrument `fold-marks.test.js` uses for the scene header.
 */
describe('the player persona is stated, not inferred', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');
    const state = fs.readFileSync(path.join(FOLD, 'state.js'), 'utf8');
    const scene = fs.readFileSync(path.join(FOLD, 'scene.js'), 'utf8');
    const index = fs.readFileSync(path.join(FOLD, 'index.js'), 'utf8');
    const fragments = fs.readFileSync(path.join(FOLD, 'prompt-fragments.js'), 'utf8');

    test('the state block leads with a Player line, before anything the probe inferred', () => {
        expect(state).toContain('const playerLine = player ? `Player: ${player}` : \'\';');
        expect(state).toContain('\'scene.player\': playerLine');
        // The scene envelope assembles player first, then context, cast and stakes, so the persona
        // still leads everything the probe inferred.
        expect(fragments).toContain('[\'scene.player\', \'scene.context\', \'scene.cast\', \'scene.stakes\']');
    });

    test('the Player line survives even when the scene block is otherwise empty', () => {
        // At initialization there is no context and no cast, the block used to render nothing,
        // leaving the model to pick the reader from the people list. The player line is the first
        // scene fragment, so it is what the block says when there is nothing else.
        expect(fragments.indexOf('\'scene.player\'')).toBeLessThan(fragments.indexOf('\'scene.context\''));
    });

    test('the scene probe is told the player\'s name so pov anchors to it', () => {
        expect(index).toContain('instruction: () => scene.instruction({ player: personaFields().name })');
        expect(scene).toContain('The reader\'s character is');
        expect(scene).toContain('report that name exactly');
    });

    test('without a persona the probe guidance is unchanged', () => {
        // A fabricated player would bias `pov` toward a name the story never uses, so the guidance
        // only carries the name when the persona exists.
        expect(scene).toContain('? `For "pov", name the character the narration follows');
        expect(scene).toContain('when the excerpt follows the reader\'s character, report that name exactly.');
    });
});
