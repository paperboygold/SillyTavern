import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
    PROMPT_FRAGMENT_INFO,
    STATE_FRAGMENT_IDS,
    assembleStateBlock,
} from '../public/scripts/extensions/sanguine/prompt-fragments.js';

/**
 * The exact assembly the inline builder in `state.js render()` produced before the fragment layer.
 *
 * `scene.context` here is the JOINED context string; the original spread the array, and joining an
 * array then filtering the single string is the same text, which is the byte-identity being locked.
 *
 * @param {object} f Fragment defaults.
 * @returns {string} The block the old builder would have returned.
 */
function legacyAssembly(f) {
    const scene = [f['scene.player'], f['scene.context'], f['scene.cast'], f['scene.stakes']]
        .filter(Boolean)
        .join('\n');
    const body = f['state.body'];
    if (!scene) {
        return body;
    }
    return [`[Scene]\n${scene}`, body].filter(Boolean).join('\n');
}

/** A full block, every fragment speaking. @param {object} [over] Per-fragment overrides. */
function fragments(over = {}) {
    return {
        'scene.header': '[Scene]',
        'scene.player': 'Player: Solomon',
        'scene.context': 'Location: the apartment\ntime: 08:18',
        'scene.cast': 'People: A.W. (reachable by email)',
        'scene.stakes': 'Threads: the missing shipment',
        'state.body': 'Carrying: ka-bar knife x1',
        ...over,
    };
}

describe('assembleStateBlock: byte-identical to the legacy inline assembly with no overrides', () => {
    test('every fragment speaking', () => {
        const f = fragments();
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('no player yet', () => {
        const f = fragments({ 'scene.player': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('no context fields', () => {
        const f = fragments({ 'scene.context': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('empty cast and stakes', () => {
        const f = fragments({ 'scene.cast': '', 'scene.stakes': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('player alone, the scene otherwise empty', () => {
        const f = fragments({ 'scene.context': '', 'scene.cast': '', 'scene.stakes': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('no state body', () => {
        const f = fragments({ 'state.body': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('empty scene, body only', () => {
        const f = fragments({ 'scene.player': '', 'scene.context': '', 'scene.cast': '', 'scene.stakes': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
    test('everything silent', () => {
        const f = fragments({ 'scene.player': '', 'scene.context': '', 'scene.cast': '', 'scene.stakes': '', 'state.body': '' });
        expect(assembleStateBlock(f)).toBe(legacyAssembly(f));
    });
});

describe('overrides', () => {
    test('an override replaces a fragment verbatim', () => {
        const out = assembleStateBlock(fragments(), {
            'scene.cast': { enabled: true, text: 'People: nobody new' },
        });
        expect(out).toContain('People: nobody new');
        expect(out).not.toContain('A.W.');
    });

    test('a disabled fragment is omitted, the rest stands', () => {
        const out = assembleStateBlock(fragments(), {
            'scene.context': { enabled: false },
        });
        expect(out).not.toContain('Location:');
        expect(out).toContain('Player: Solomon');
        expect(out).toContain('Carrying: ka-bar knife x1');
    });

    test('a suppressed fragment leaves no stray blank line', () => {
        const out = assembleStateBlock(fragments(), {
            'scene.context': { enabled: false },
        });
        expect(out).not.toMatch(/\n\n\n/);
    });

    test('the state body itself can be overridden or suppressed', () => {
        const replaced = assembleStateBlock(fragments(), {
            'state.body': { text: 'Carrying: nothing of note' },
        });
        expect(replaced).toContain('Carrying: nothing of note');
        expect(replaced).not.toContain('ka-bar');

        const suppressed = assembleStateBlock(fragments(), {
            'state.body': { enabled: false },
        });
        expect(suppressed).not.toContain('Carrying:');
        expect(suppressed).toContain('Location:');
    });

    test('the envelope marker can be replaced or dropped', () => {
        const replaced = assembleStateBlock(fragments(), {
            'scene.header': { text: '[State]' },
        });
        expect(replaced.startsWith('[State]\n')).toBe(true);

        const dropped = assembleStateBlock(fragments(), {
            'scene.header': { enabled: false },
        });
        expect(dropped.startsWith('[Scene]')).toBe(false);
        expect(dropped.startsWith('Player: Solomon')).toBe(true);
    });

    test('STATE_FRAGMENT_IDS lists every fragment, in assembly order', () => {
        expect(STATE_FRAGMENT_IDS).toEqual([
            'scene.header',
            'scene.player',
            'scene.context',
            'scene.cast',
            'scene.stakes',
            'state.body',
        ]);
    });
});

describe('the Prompts tab (W4)', () => {
    const FOLD = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');

    test('PROMPT_FRAGMENT_INFO covers exactly the fragment ids, in order', () => {
        expect(PROMPT_FRAGMENT_INFO.map(info => info.id)).toEqual([...STATE_FRAGMENT_IDS]);
    });

    test('the tab is registered in the shell and edits the override store', () => {
        const tab = fs.readFileSync(path.join(FOLD, 'overlay-prompts.js'), 'utf8');
        expect(tab).toContain('registerTab(\'prompts\', renderPrompts)');
        expect(tab).toContain('loadPromptOverrides()');
        expect(tab).toContain('savePromptOverrides(overrides)');
        const shell = fs.readFileSync(path.join(FOLD, 'overlay.js'), 'utf8');
        expect(shell).toContain('id: \'prompts\'');
        const panel = fs.readFileSync(path.join(FOLD, 'panel.js'), 'utf8');
        expect(panel).toContain('import \'./overlay-prompts.js\';');
    });
});
