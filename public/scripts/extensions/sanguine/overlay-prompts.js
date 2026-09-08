/**
 * sanguine/overlay-prompts.js: the Prompts tab.
 *
 * The editor for the W1 fragment overrides (`prompt-fragments.js`), Megumin's editable prompts
 * adapted: each fragment gets a customize toggle, a textarea, and a reset to default, all stored
 * in `extension_settings` (`prompt-overrides.js`). The semantics are the fragment layer's, not new
 * ones: customise off means the computed default renders, customise on replaces it verbatim with
 * an empty textarea suppressing it, and reset drops the override. Edits apply on the next
 * injection, the state block is built per generation.
 *
 * @cite ../Megumin-Suite/src/ui/promptEditor.js per-subsystem editable prompts
 */

import { t } from '../../i18n.js';
import { registerTab } from './overlay.js';
import { PROMPT_FRAGMENT_INFO } from './prompt-fragments.js';
import { loadPromptOverrides, savePromptOverrides } from './prompt-overrides.js';

/** Id of the injected stylesheet, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-prompts-css';

/**
 * Put `overlay-prompts.css` in the document head, once.
 *
 * Same shape and same reason as `overlay.js` `ensureStylesheet`: the manifest declares exactly one
 * sheet and `style.css` already holds it, so a second surface injects its own.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay-prompts.css', import.meta.url).href;
    document.head.appendChild(link);
}

ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. Static UI text only, never model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/**
 * @param {string} className Class list.
 * @param {string} [text] Label text.
 * @returns {HTMLButtonElement} A real button.
 */
function button(className, text = '') {
    const node = /** @type {HTMLButtonElement} */ (el('button', className, text));
    node.type = 'button';
    return node;
}

/**
 * Update one fragment's override, keeping the rest of the table.
 * @param {string} id The fragment id.
 * @param {{text: string}|null} next The override, or null to remove it.
 */
function setFragmentOverride(id, next) {
    const overrides = { ...loadPromptOverrides() };
    if (next) {
        overrides[id] = next;
    } else {
        delete overrides[id];
    }
    savePromptOverrides(overrides);
}

/**
 * One fragment's editor row.
 * @param {{id: string, label: string, hint: string}} info The fragment.
 * @returns {HTMLElement} The row.
 */
function fragmentRow(info) {
    const override = loadPromptOverrides()?.[info.id];
    const custom = !!override;
    const text = typeof override?.text === 'string' ? override.text : '';

    const row = el('div', 'sanguine_prompt_fragment');

    const head = el('div', 'sanguine_prompt_head');
    head.appendChild(el('span', 'sanguine_prompt_id', info.label));
    const customize = /** @type {HTMLInputElement} */ (el('input', 'sanguine_prompt_custom'));
    customize.type = 'checkbox';
    customize.checked = custom;
    const customizeLabel = el('label', 'sanguine_prompt_custom_label');
    customizeLabel.appendChild(customize);
    customizeLabel.appendChild(el('span', '', t`Customize`));
    head.appendChild(customizeLabel);
    row.appendChild(head);

    if (info.hint) {
        row.appendChild(el('p', 'sanguine_prompt_hint', info.hint));
    }

    const area = /** @type {HTMLTextAreaElement} */ (el('textarea', 'text_pole sanguine_prompt_textarea', ''));
    area.rows = 3;
    area.placeholder = custom ? t`Empty suppresses this fragment` : t`Default rendering is used`;
    area.value = custom ? text : '';
    area.disabled = !custom;
    row.appendChild(area);

    const actions = el('div', 'sanguine_prompt_actions');
    const reset = button('sanguine_prompt_reset', t`Reset to default`);
    reset.disabled = !custom;
    reset.title = t`Drop this override and use the computed value again`;
    reset.addEventListener('click', () => {
        setFragmentOverride(info.id, null);
        customize.checked = false;
        area.value = '';
        area.disabled = true;
        area.placeholder = t`Default rendering is used`;
        reset.disabled = true;
    });
    actions.appendChild(reset);
    row.appendChild(actions);

    customize.addEventListener('change', () => {
        if (customize.checked) {
            area.disabled = false;
            area.placeholder = t`Empty suppresses this fragment`;
            setFragmentOverride(info.id, { text: area.value });
        } else {
            area.disabled = true;
            area.value = '';
            area.placeholder = t`Default rendering is used`;
            reset.disabled = true;
            setFragmentOverride(info.id, null);
        }
    });

    area.addEventListener('input', () => {
        if (!customize.checked) return;
        reset.disabled = false;
        setFragmentOverride(info.id, { text: area.value });
    });

    return row;
}

/**
 * The tab.
 * @param {HTMLElement} body The panel element.
 */
function renderPrompts(body) {
    body.appendChild(el('h2', 'sanguine_prompt_title', t`Prompt fragments`));
    body.appendChild(el('p', 'sanguine_prompt_lede',
        t`The injected block under the reply is assembled from fragments. Each can be replaced verbatim or suppressed; an empty override suppresses. Edits apply to the next generation.`));

    const list = el('div', 'sanguine_prompt_list');
    for (const info of PROMPT_FRAGMENT_INFO) {
        list.appendChild(fragmentRow(info));
    }
    body.appendChild(list);
}

registerTab('prompts', renderPrompts);
