/**
 * fold/card-html.js: the state card's renderer, pure.
 *
 * The pure half of `blocks-card.js`, with no browser dependency, so `buildCardHtml` is
 * unit-testable in node. Everything on the card is the model's words, so every string is
 * HTML-escaped here, and an empty view renders nothing.
 *
 * @cite ../Megumin-Suite/src/blocks/render.js the block card treatment
 */

/** HTML-escape model output. @param {unknown} value A model-written string. @returns {string} */
function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

/** The protocol place tokens, fold's own vocabulary. */
const PLACE_LABELS = { carried: 'Carrying', money: 'Money', assets: 'Property', abilities: 'Abilities' };

/** The scene as chips, time first. @param {object} scene Label -> value. @returns {string} */
function sceneChips(scene) {
    const order = ['time', 'date', 'location', 'weather', 'pov'];
    const chips = [];
    for (const key of order) {
        const value = String(scene?.[key] ?? '').trim();
        if (value) {
            chips.push(`<span class="sanguine_card_chip">${esc(key)}: ${esc(value)}</span>`);
        }
    }
    return chips.length ? `<div class="sanguine_card_chips">${chips.join('')}</div>` : '';
}

/** One bar per vital, an instrument face beside a fraction. @param {object[]} vitals. @returns {string} */
function vitalsHtml(vitals) {
    const rows = [];
    for (const vital of vitals || []) {
        const max = Number(vital?.max) || 0;
        const cur = Math.max(0, Number(vital?.cur ?? 0));
        const pct = max > 0 ? Math.round(Math.min(1, cur / max) * 100) : null;
        rows.push(
            '<div class="sanguine_card_row">'
            + `<span class="sanguine_card_k">${esc(vital?.name)}</span>`
            + (pct !== null ? `<span class="sanguine_card_bar"><span class="sanguine_card_fill" style="width:${pct}%"></span></span>` : '')
            + `<span class="sanguine_card_v">${cur}${max ? ` / ${max}` : ''}</span>`
            + '</div>',
        );
    }
    return rows.join('\n');
}

/** The pov's conditions as severity-coloured chips, reusing the panel's mark colours. @returns {string} */
function conditionsHtml(conditions) {
    const chips = [];
    for (const mark of conditions || []) {
        const phrase = String(mark?.phrase ?? '').trim();
        if (!phrase) continue;
        const severity = ['minor', 'moderate', 'severe'].includes(mark?.severity) ? mark.severity : 'moderate';
        chips.push(
            `<span class="sanguine_card_cond sanguine_mark_${severity}"`
            + ` title="${esc(phrase)}${severity !== 'minor' ? `, ${severity}` : ''}">${esc(phrase)}</span>`,
        );
    }
    return chips.length ? `<div class="sanguine_card_conds">${chips.join('')}</div>` : '';
}

/** The pov's own belongings, grouped by place. @param {object[]} inventory. @returns {string} */
function inventoryHtml(inventory) {
    const groups = new Map();
    for (const item of inventory || []) {
        if (!item?.mine) continue;
        const place = String(item.place ?? 'carried').toLowerCase();
        const label = Number(item.qty) > 1 ? `${item.display} x${item.qty}` : item.display;
        groups.set(place, [...(groups.get(place) ?? []), esc(label)]);
    }
    const rows = [];
    for (const [place, names] of groups) {
        const key = PLACE_LABELS[place] ?? `Stored (${esc(place)})`;
        rows.push(`<div class="sanguine_card_row"><span class="sanguine_card_k">${esc(key)}</span><span class="sanguine_card_v">${names.join(', ')}</span></div>`);
    }
    return rows.join('\n');
}

/** Thread dials as bars, open threads as a list. @param {object} threads. @returns {string} */
function threadsHtml(threads) {
    const rows = [];
    for (const thread of [...(threads?.pressure ?? []), ...(threads?.progress ?? [])]) {
        const size = Math.max(1, Number(thread?.dial?.size ?? 1));
        const filled = Math.max(0, Math.min(size, Number(thread?.dial?.filled ?? 0)));
        const pct = Math.round((filled / size) * 100);
        rows.push(
            '<div class="sanguine_card_row">'
            + `<span class="sanguine_card_k">${esc(thread?.name)}</span>`
            + `<span class="sanguine_card_bar"><span class="sanguine_card_fill" style="width:${pct}%"></span></span>`
            + `<span class="sanguine_card_v">${filled}/${size}</span>`
            + '</div>',
        );
    }
    const open = threads?.open ?? [];
    if (open.length) {
        rows.push(`<div class="sanguine_card_row"><span class="sanguine_card_k">Threads</span><span class="sanguine_card_v">${open.map(t => esc(t?.name)).join(', ')}</span></div>`);
    }
    return rows.join('\n');
}

/** The suggested next actions as real buttons. @param {string[]} choices. @returns {string} */
function choicesHtml(choices) {
    const buttons = [];
    for (const item of choices || []) {
        const text = String(item ?? '').trim();
        if (!text) continue;
        buttons.push(`<button type="button" class="sanguine_card_choice" data-sanguine-choice="${esc(text)}">${esc(text)}</button>`);
    }
    return buttons.length ? `<div class="sanguine_card_choices" role="group" aria-label="Suggested next actions">${buttons.join('')}</div>` : '';
}

/**
 * Render the card from a plain view.
 *
 * @param {object} [view] `{ scene, vitals, conditions, inventory, threads, choices }`.
 * @returns {string} The card HTML, or '' when there is nothing to draw.
 */
export function buildCardHtml(view = {}) {
    const sections = [
        sceneChips(view.scene),
        vitalsHtml(view.vitals),
        conditionsHtml(view.conditions),
        inventoryHtml(view.inventory),
        threadsHtml(view.threads),
        choicesHtml(view.choices),
    ].filter(Boolean);
    if (!sections.length) {
        return '';
    }
    return '<details class="sanguine_card" open>'
        + '<summary class="sanguine_card_head"><span class="sanguine_card_label">Record</span></summary>'
        + `<div class="sanguine_card_body">${sections.join('\n')}</div>`
        + '</details>';
}
