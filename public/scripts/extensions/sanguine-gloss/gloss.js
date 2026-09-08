/**
 * sanguine-gloss/gloss.js — DOM processing, hover popovers, dialogs, and reading modes.
 *
 * Implements the sanguinehost.com-style interactive glossary:
 *   - .gloss: Highlighted token with dashed underline
 *   - .gloss-pop: Fixed position hover popover with term, pinyin, and concise meaning
 *   - .gloss-dialog / .gloss-card: Click modal with deep cultivation notes and lore
 *   - Reading modes: Hover, Ruby Pinyin, Ruby English, Full Interlinear
 */

import { getGlossEntry, segmentAndGloss } from './lexicon.js';
import { CJK_CHAR_REGEX } from './trie.js';

export const READING_MODES = Object.freeze({
    HOVER: 'hover',
    RUBY_PINYIN: 'ruby_pinyin',
    RUBY_ENGLISH: 'ruby_english',
    INTERLINEAR: 'interlinear',
});

let gpop = null;
let gdlg = null;

/**
 * Creates an HTML element with class, attributes, and text/children.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {string|HTMLElement[]|null} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = null) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    if (children) {
        if (typeof children === 'string') {
            node.textContent = children;
        } else if (Array.isArray(children)) {
            for (const child of children) {
                if (child) node.appendChild(child);
            }
        } else if (children instanceof Node) {
            node.appendChild(children);
        }
    }
    return node;
}

/**
 * Initialize the global hover popover and click dialog DOM elements.
 */
export function initGlossDom() {
    if (document.querySelector('.sanguine-gloss-pop')) {
        gpop = document.querySelector('.sanguine-gloss-pop');
        gdlg = document.querySelector('.sanguine-gloss-dialog');
        return;
    }

    gpop = el('div', { class: 'sanguine-gloss-pop gloss-pop' });
    gdlg = el('div', { class: 'sanguine-gloss-dialog gloss-dialog' });
    document.body.append(gpop, gdlg);

    // Event delegation on document body for hover popover
    document.addEventListener('mouseover', (ev) => {
        const target = ev.target?.closest?.('.sanguine-gloss-term, .gloss');
        if (!target) return;
        const term = target.getAttribute('data-term') || target.textContent;
        const entry = getGlossEntry(term);
        if (!entry) return;

        showPopover(target, term, entry);
    });

    document.addEventListener('mouseout', (ev) => {
        const target = ev.target?.closest?.('.sanguine-gloss-term, .gloss');
        if (!target) return;
        hidePopover();
    });

    // Event delegation on document body for click modal card
    document.addEventListener('click', (ev) => {
        const target = ev.target?.closest?.('.sanguine-gloss-term, .gloss');
        if (!target) return;
        ev.stopPropagation();
        const term = target.getAttribute('data-term') || target.textContent;
        const entry = getGlossEntry(term);
        if (!entry) return;

        hidePopover();
        showDialog(term, entry);
    });

    gdlg.addEventListener('click', (ev) => {
        if (ev.target === gdlg) {
            hideDialog();
        }
    });

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && gdlg.classList.contains('on')) {
            hideDialog();
        }
    });
}

/**
 * Positions and displays the floating hover popover.
 * @param {HTMLElement} target The hovered DOM node.
 * @param {string} term The Chinese term.
 * @param {object} entry The glossary entry.
 */
function showPopover(target, term, entry) {
    if (!gpop) return;

    gpop.innerHTML = '';
    const termSpan = el('span', { class: 'gp-term', text: term });
    gpop.appendChild(termSpan);

    if (entry.say) {
        const saySpan = el('span', { class: 'gp-say', text: `[${entry.say}]` });
        gpop.appendChild(saySpan);
    }

    const meanSpan = el('span', { class: 'gp-mean', text: entry.mean });
    gpop.appendChild(meanSpan);

    const r = target.getBoundingClientRect();
    const popWidth = 280;
    const left = Math.max(8, Math.min(window.innerWidth - popWidth - 12, r.left));
    const top = (r.bottom + 6 < window.innerHeight - 100)
        ? (r.bottom + 6)
        : (Math.max(8, r.top - 60));

    gpop.style.left = `${left}px`;
    gpop.style.top = `${top}px`;
    gpop.classList.add('on');
}

/**
 * Hides the floating hover popover.
 */
function hidePopover() {
    if (gpop) gpop.classList.remove('on');
}

/**
 * Displays the modal glossary dialog card with deep lore details.
 * @param {string} term
 * @param {object} entry
 */
function showDialog(term, entry) {
    if (!gdlg) return;

    const closeBtn = el('button', { class: 'gloss-x', 'aria-label': 'Close', text: '×' });
    closeBtn.addEventListener('click', () => hideDialog());

    const card = el('div', { class: 'sanguine-gloss-card gloss-card' }, [
        closeBtn,
        el('div', { class: 'gloss-sym', text: term }),
        entry.say ? el('div', { class: 'gloss-row' }, [
            el('span', { class: 'gloss-lab', text: entry.say }),
        ]) : null,
        el('div', { class: 'gloss-row gloss-mean', text: entry.mean }),
        entry.more ? el('div', { class: 'gloss-row gloss-more', html: entry.more }) : null,
    ]);

    gdlg.replaceChildren(card);
    gdlg.classList.add('on');
}

/**
 * Hides the modal glossary dialog.
 */
function hideDialog() {
    if (gdlg) gdlg.classList.remove('on');
}

/**
 * Wraps segmented tokens into DOM nodes according to the selected reading mode.
 * @param {Array<{ type: 'gloss'|'text', text: string, entry?: object }>} tokens
 * @param {string} mode One of READING_MODES.
 * @returns {DocumentFragment}
 */
export function renderGlossTokens(tokens, mode = READING_MODES.HOVER) {
    const fragment = document.createDocumentFragment();

    for (const token of tokens) {
        if (token.type === 'text' || !token.entry) {
            fragment.appendChild(document.createTextNode(token.text));
            continue;
        }

        const { text, entry } = token;
        // ── A signal that marks everything marks nothing ──
        //
        // The per-character floor makes every ideograph hoverable, and painting all of them gold
        // would not be better reading — it would replace a signal ("this is a term worth knowing")
        // with wallpaper. A floor hit stays fully interactive and renders plainly; the curated and
        // context tiers keep the gold.
        const span = el('span', {
            class: entry?.floor
                ? 'sanguine-gloss-term gloss sanguine-gloss-floor'
                : 'sanguine-gloss-term gloss',
            'data-term': text,
        }, text);

        if (mode === READING_MODES.HOVER) {
            fragment.appendChild(span);
        } else if (mode === READING_MODES.RUBY_PINYIN) {
            const ruby = el('ruby', { class: 'sanguine-gloss-ruby gloss-ruby' });
            ruby.appendChild(span);
            ruby.appendChild(el('rt', { class: 'gloss-rt', text: entry.say || '' }));
            fragment.appendChild(ruby);
        } else if (mode === READING_MODES.RUBY_ENGLISH) {
            const ruby = el('ruby', { class: 'sanguine-gloss-ruby gloss-ruby' });
            ruby.appendChild(span);
            ruby.appendChild(el('rt', { class: 'gloss-rt gloss-rt-mean', text: entry.mean || '' }));
            fragment.appendChild(ruby);
        } else if (mode === READING_MODES.INTERLINEAR) {
            const ruby = el('ruby', { class: 'sanguine-gloss-ruby gloss-ruby' });
            ruby.appendChild(span);
            const label = entry.say ? `${entry.say} · ${entry.mean}` : entry.mean;
            ruby.appendChild(el('rt', { class: 'gloss-rt gloss-rt-full', text: label }));
            fragment.appendChild(ruby);
        }
    }

    return fragment;
}

/**
 * Walks all text nodes in a container and glosses any CJK text spans.
 * @param {HTMLElement} rootElement The message element (.mes_text) to process.
 * @param {string} [mode] The reading mode.
 */
export function glossElement(rootElement, mode = READING_MODES.HOVER) {
    if (!rootElement || !(rootElement instanceof Node)) return;

    // Check if already glossed
    if (rootElement.querySelector?.('.sanguine-gloss-term')) {
        return;
    }

    const walker = document.createTreeWalker(
        rootElement,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode(node) {
                // Do not gloss inside interactive controls or already processed spans
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                const tag = parent.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'input') {
                    return NodeFilter.FILTER_REJECT;
                }
                if (parent.closest('.sanguine-gloss-term, .gloss, .gloss-card, .gloss-pop, .sanguine_steer_bar, .sanguine_steer_bar')) {
                    return NodeFilter.FILTER_REJECT;
                }
                if (!CJK_CHAR_REGEX.test(node.nodeValue ?? '')) {
                    return NodeFilter.FILTER_SKIP;
                }
                return NodeFilter.FILTER_ACCEPT;
            },
        },
    );

    const nodesToReplace = [];
    let currentNode = walker.nextNode();
    while (currentNode) {
        nodesToReplace.push(currentNode);
        currentNode = walker.nextNode();
    }

    for (const textNode of nodesToReplace) {
        const text = textNode.nodeValue ?? '';
        if (!text) continue;
        const tokens = segmentAndGloss(text);
        const hasGloss = tokens.some(t => t.type === 'gloss');
        if (hasGloss) {
            const fragment = renderGlossTokens(tokens, mode);
            textNode.parentNode?.replaceChild(fragment, textNode);
        }
    }
}
