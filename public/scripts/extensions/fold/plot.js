/**
 * fold/plot.js — the overall story direction.
 *
 * The per-message steer is gone the moment the reply is written. This is the thing that is NOT:
 * a persistent, user-authored guide to the arc the fiction is following, stored per chat, injected
 * into every narrator prompt. It answers the "steer gets forgotten immediately" failure with the
 * one mechanism steer never had — persistence. The user writes it once (from a synopsis, a scene
 * outline, or a hand-edited direction), and it stays until they change it; the AI director
 * (FOLD-REDESIGN.md §10 Phase G+ future) updates it in place.
 *
 * Three roles in one field:
 *   · scenario 1 — a real story being replayed closely: the guide is the arc outline, and the
 *     narrator is told these beats are canonical, not suggestions — but is also told the beats
 *     are KNOWN ONLY TO THE NARRATOR, never to the characters. A replayed plot must be followed
 *     without the people in it acting as if they have read it.
 *   · scenario 2 — a general direction prompt: the guide is whatever the user wants driving the
 *     story, edited without touching the scene/state machinery.
 *   · scenario 3 — the AI director's workspace: a future pass rewrites `fold.plot` to manage
 *     plot development and the off-screen world, and everything here already serves it.
 */

import { saveMetadataDebounced } from '../../extensions.js';
import { getFold } from './store.js';

/**
 * The plot guide for the current chat, or null when none has been set.
 * @returns {{text: string, source: string, updated: number}|null} The guide.
 */
export function load() {
    const plot = getFold()?.plot;
    return plot && String(plot.text ?? '').trim() ? plot : null;
}

/** @returns {string} The guide's text, or '' when none is set. */
export function text() {
    return load()?.text ?? '';
}

/**
 * Set or clear the plot guide.
 * @param {object} params The guide.
 * @param {string} params.text The direction text. Empty clears the guide.
 * @param {string} [params.source] Where it came from — a URL, "manual", a synopsis.
 */
export function set({ text: t = '', source = '' } = {}) {
    const fold = getFold();
    const clean = String(t ?? '').trim();
    if (clean) {
        fold.plot = { text: clean, source: String(source ?? ''), updated: Date.now() };
    } else {
        delete fold.plot;
    }
    saveMetadataDebounced();
}

/**
 * The injected block for the narrator.
 *
 * Framed as the hidden hand rather than as fact. The state block owns "what is true now" and it is
 * injected AFTER this block (plot rides depth 0, state depth 1), so the model first reads the
 * present — what the characters actually know — and then this direction. The direction is explicit
 * that the outline is known ONLY to the narrator: the characters know nothing beyond what the
 * conversation has shown them, and no beat may arrive because a character read the future.
 *
 * The metagaming failure this exists to prevent: a single model plays the narrator and every
 * character at once, so anything the outline states, the characters appear to know. The answer is
 * not to keep secrets from the model — the author must know the arc to steer toward it — but to
 * split knowledge: the narrator knows, the characters do not, and the characters' knowledge comes
 * only from the [Scene] and the conversation. The guide must be written accordingly (events, not
 * "X realizes Y"): solution language in the outline gets copied into character dialogue.
 *
 * @returns {string} The block, or '' when no guide is set.
 */
export function render() {
    const plot = load();
    if (!plot) {
        return '';
    }
    return [
        '[Author\'s direction — the characters do not know this]',
        plot.text,
        'The outline above is the story\'s true course. Only you, the narrator, know it. The characters in the scene know nothing beyond what this conversation has directly shown them — none of them has read this outline, and none can see the future of it. Let each beat arrive because the characters observe, react, and decide in-scene, never because they were told. No character may name, guess, plan for, or solve a beat before the scene has actually reached it. When a character states a fact, a rule, or a plan, it must be limited to what they personally saw or reasoned out in the present moment. Never narrate what no one present could know.',
    ].join('\n');
}
