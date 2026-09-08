/**
 * fold/prompt-fragments.js: the injected block as named, overridable fragments.
 *
 * The state block the model sees (`state.render`, injected at depth 1) is assembled here from an
 * ordered registry of named fragments, empty ones dropped so nothing leaks, each overridable or
 * suppressible by the player through `prompt-overrides.js`. With no overrides the assembly is
 * byte-identical to the inline builder it replaced, a regression lock rather than a coincidence,
 * because a fragment layer that silently reorders or re-labels the block would change what the
 * model reads on every existing chat. This is the pure half, the registry and the assembly; the
 * store and the builders are the wired half.
 *
 * @cite ../Megumin-Suite/data/slots.js single-source slots
 * @cite ../Megumin-Suite/src/engine/injection.js dict injection with empty-slot stripping
 */

/** The fragments that make up the injected block, in assembly order. */
export const STATE_FRAGMENT_IDS = Object.freeze([
    'scene.header',
    'scene.player',
    'scene.context',
    'scene.cast',
    'scene.stakes',
    'state.body',
]);

/**
 * The fragments' plain-English labels and hints, for the Prompts tab.
 * Kept beside the ids so the editor and the assembler cannot drift; a test pins the two together.
 */
export const PROMPT_FRAGMENT_INFO = Object.freeze([
    { id: 'scene.header', label: 'Scene marker', hint: 'The envelope line above the scene block.' },
    { id: 'scene.player', label: 'Player', hint: 'Who the story follows, stated outright.' },
    { id: 'scene.context', label: 'Scene fields', hint: 'Time, place, weather, point of view, and whatever the card reported.' },
    { id: 'scene.cast', label: 'Cast', hint: 'The people in the scene and what is known about them.' },
    { id: 'scene.stakes', label: 'Stakes', hint: 'Open threads and pressure dials.' },
    { id: 'state.body', label: 'State block', hint: 'Carrying, vitals, conditions and money.' },
]);

/**
 * What one fragment reads, given its default and any player override.
 *
 * An override is `{ enabled, text }`. Absent or `{}` keeps the default; `enabled: false` suppresses
 * the fragment entirely; `text` (a string) replaces it verbatim. `text: ''` is an override that
 * says nothing, which is the same as suppressing it.
 *
 * @param {string} defaultValue The fragment's normal rendering, '' when it has nothing to say.
 * @param {object} [override] The player's override for this fragment.
 * @returns {string} The fragment's final text.
 */
function applyFragment(defaultValue, override) {
    if (!override || typeof override !== 'object') {
        return defaultValue;
    }
    if (override.enabled === false) {
        return '';
    }
    if (typeof override.text === 'string') {
        return override.text;
    }
    return defaultValue;
}

/**
 * Assemble the injected block from its fragments.
 *
 * The scene half is the envelope: player, context, cast and stakes joined on newlines, with the
 * `[Scene]` marker above it. The state body sits after it. Any fragment that renders '' vanishes,
 * and nothing leaks an empty line. When the whole scene is silent the body stands alone, exactly
 * as the inline builder had it.
 *
 * @param {object} [fragments] The default fragment values, keyed by id.
 * @param {object} [overrides] Player overrides, keyed by id.
 * @returns {string} The block, or '' when every fragment is silent.
 */
export function assembleStateBlock(fragments = {}, overrides = {}) {
    const sceneBlock = ['scene.player', 'scene.context', 'scene.cast', 'scene.stakes']
        .map(id => applyFragment(String(fragments[id] ?? ''), overrides?.[id]))
        .filter(Boolean)
        .join('\n');
    const body = applyFragment(String(fragments['state.body'] ?? ''), overrides?.['state.body']);
    if (!sceneBlock) {
        return body;
    }
    const header = applyFragment(String(fragments['scene.header'] ?? ''), overrides?.['scene.header']);
    const sceneFull = header ? `${header}\n${sceneBlock}` : sceneBlock;
    return [sceneFull, body].filter(Boolean).join('\n');
}
