/**
 * fold/choices.js: the scene probe's "what could the player do next", transient.
 *
 * The CYOA surface: the model suggests a few plausible next actions for the point-of-view
 * character, and the state card renders them as buttons that fill the send box. The answer is
 * per-pass and deliberately not persisted, it describes a moment, not the record. Pure, with no
 * browser dependency, so the scene probe can write it and the card can read it without either
 * pulling the other's wired imports.
 *
 * @cite ../Megumin-Suite/src/blocks/render.js CYOA buttons
 */

/** How many suggestions the card may draw, the model is asked for 2-4 and never more are kept. */
export const MAX_CHOICES = 4;

/** The last pass's suggestions, in the order the model wrote them. */
let current = [];

/**
 * Normalise the model's answer into a bounded, deduped, displayable list.
 *
 * Structure only: each entry is trimmed, blanked entries are dropped, a duplicate phrase is kept
 * once, and the list stops at `MAX_CHOICES`. Nothing here reads the words.
 *
 * @param {unknown} raw The probe fragment's `choices`.
 * @returns {string[]} The suggestions.
 */
export function normalizeChoices(raw) {
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        const text = String(item ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!text) continue;
        // Case-folded dedup key: a restated spelling of the same suggestion is the same suggestion.
        // Folding case is structure, not reading the words.
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= MAX_CHOICES) {
            break;
        }
    }
    return out;
}

/** Store the latest pass's suggestions. @param {unknown} raw The probe's `choices`. */
export function setChoices(raw) {
    current = normalizeChoices(raw);
}

/** The latest pass's suggestions, for the state card. @returns {string[]} */
export function lastChoices() {
    return current;
}

/** Forget the suggestions, on a chat change. */
export function clearChoices() {
    current = [];
}
