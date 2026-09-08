/**
 * fold/diag.js: shared pieces of the caret-level diagnostics record.
 *
 * Imports nothing, so any module can pull from here without a cycle (the validators already form
 * a dense web: `state-table` ↔ `entity-table` ↔ `thread-table`).
 */

/**
 * A readable excerpt of the narrative window, for a rejection's diagnostics record.
 *
 * The "source line" a caret report shows beside what was refused: the window the model was reading
 * when it proposed something fold declined. Collapsed to single spaces and bounded, so a rejection
 * record stays small in the metadata blob.
 *
 * @param {string} windowText The narrative window the validator read.
 * @returns {string} A bounded excerpt, or ''.
 */
export function windowSnippet(windowText) {
    return String(windowText ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
}
