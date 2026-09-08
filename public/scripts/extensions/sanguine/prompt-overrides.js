/**
 * fold/prompt-overrides.js: the player's overrides for the prompt-fragment layer.
 *
 * The wired half of `prompt-fragments.js`: where the overrides live (`extension_settings`), how
 * they load and how they persist. Kept out of the pure module so the assembly stays unit-testable
 * in node, the same split as `state-table.js` (pure) vs `state.js` (wired).
 */

import { saveSettingsDebounced } from '../../../script.js';
import { extension_settings } from '../../extensions.js';

// The settings key, matching `index.js` `MODULE_NAME`. A second literal rather than an import,
// because importing `index.js` from here would pull the whole extension into the store.
const SETTINGS_KEY = 'sanguine';
const OVERRIDES_KEY = 'promptOverrides';

/**
 * The override table: `{ [fragmentId]: { enabled, text } }`. Absent means no overrides.
 * @returns {object} The current overrides.
 */
export function loadPromptOverrides() {
    const stored = extension_settings?.[SETTINGS_KEY]?.[OVERRIDES_KEY];
    return stored && typeof stored === 'object' ? stored : {};
}

/**
 * Replace the whole override table and schedule a save.
 * @param {object} overrides The new table.
 */
export function savePromptOverrides(overrides) {
    if (!extension_settings[SETTINGS_KEY] || typeof extension_settings[SETTINGS_KEY] !== 'object') {
        extension_settings[SETTINGS_KEY] = {};
    }
    extension_settings[SETTINGS_KEY][OVERRIDES_KEY] = overrides && typeof overrides === 'object' ? overrides : {};
    saveSettingsDebounced();
}
