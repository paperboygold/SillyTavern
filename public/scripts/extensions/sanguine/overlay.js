/**
 * sanguine/overlay.js: the one overlay every detail view becomes a tab in.
 *
 * Why there is an overlay at all.
 *
 * The tracker panel is 288px wide (`style.css` `#sanguineTracker.sanguine_open`) and 70vh tall at
 * most. That is a glance surface: it can say a person is here, wary, and owed money, and it cannot
 * say who they are, what they said three scenes ago, or which of the four things they want is the
 * one they will act on. Everything the panel shows is therefore a SUMMARY, and a summary is only
 * honest if the full record is one click away.
 *
 * That is the whole contract of this file: `open({ tab, focus })` opens the overlay already
 * standing on the record the player clicked. A summary row is allowed to omit nine columns
 * precisely because the row can hand its key to this function. If navigation-by-key is unreliable,
 * the panel has to stop summarising and start cramming, and the panel is 288px wide.
 *
 * Why the popup layer rather than a bespoke sheet.
 *
 * `callGenericPopup` is already used four times in this extension (audit.js:200, edit-form.js:103,
 * index.js:836, reconcile.js:190). SillyTavern's popup is a native `<dialog>` opened with
 * `showModal()`, which is where the accessibility comes from for free and correctly: the focus trap,
 * the inert background, Esc-to-close via the `cancel` event, and focus restoration on `close()`.
 * A hand-rolled div would have to reimplement all four, and would get the third one wrong.
 *
 * We construct the `Popup` directly instead of calling the `callGenericPopup` helper, for the same
 * reason `swipe-picker.js:353` does: the helper hands back a promise, and the shell needs the
 * dialog element itself to hang a sizing class and the ARIA attributes on.
 *
 * What this file is, and what it is not.
 *
 * This is the shell and its contract. It owns the frame, the tab rail, the keyboard model and the
 * navigation entry point. It owns none of the content: every tab body arrives through
 * `registerTab`, so the seven modules that will fill them can be written later and in any order,
 * without this file learning anything about them. Until a tab registers, it renders a placeholder
 * that says so.
 *
 * The stylesheet lives in `overlay.css` and is injected from here rather than declared in
 * `manifest.json`, because `addExtensionStyle` (extensions.js:781) reads `manifest.css` as a single
 * filename: an extension gets exactly one declared sheet, and `style.css` already holds it.
 */

// `t` is a template tag and `translate` is its plain-string form; the tab labels come out of a data
// table rather than out of source text, so they need the second one (i18n.js:81, 101).
import { t, translate } from '../../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../popup.js';

/** Class hung on the dialog so `overlay.css` can size and skin it without touching `.popup`. */
const POPUP_CLASS = 'sanguine_overlay_popup';

/** Id of the injected stylesheet link, so a second import does not stack a second sheet. */
const STYLE_ID = 'sanguine-overlay-css';

/**
 * @typedef {object} OverlayTab
 * @property {string} id Stable identifier. This is the `tab` value `open()` takes.
 * @property {string} label What the rail reads.
 * @property {string} icon A Font Awesome class. SillyTavern bundles the solid set already.
 * @property {string} blurb One line describing what the tab is for. Shown by the placeholder, so an
 *   unbuilt tab still tells the player what will eventually be there.
 */

/**
 * The tabs, in rail order.
 *
 * The order is the reading order of a session: who is here, what is unresolved, what happened, what
 * you carry, what you own, and, last, because they are machinery rather than story, what the
 * extension proposes to change about the record, and what the extension itself is doing.
 *
 * Adding a tab is a deliberate edit to this list. Registration cannot invent one, because a rail
 * whose order depends on module import order would reshuffle itself between reloads.
 *
 * @type {ReadonlyArray<OverlayTab>}
 */
export const OVERLAY_TABS = Object.freeze([
    Object.freeze({ id: 'cast', label: 'Entities', icon: 'fa-users', blurb: 'Everyone the story has named, and what is known about them.' }),
    Object.freeze({ id: 'threads', label: 'Threads', icon: 'fa-diagram-project', blurb: 'Open fronts and clocks, and what settling each would take.' }),
    Object.freeze({ id: 'chronicle', label: 'Chronicle', icon: 'fa-book', blurb: 'The recorded events, and what recall is retrieving from them.' }),
    Object.freeze({ id: 'inventory', label: 'Inventory', icon: 'fa-box-open', blurb: 'What is carried, where the rest of it is, and who owns it.' }),
    Object.freeze({ id: 'assets', label: 'Assets', icon: 'fa-landmark', blurb: 'Standing holdings and the flows that feed or drain them.' }),
    // Machinery, so it sits after the five story tabs, and BEFORE Diagnostics, because a repair is
    // still a question about the record while a rejection count is a question about the extractor.
    Object.freeze({ id: 'repairs', label: 'Repairs', icon: 'fa-screwdriver-wrench', blurb: 'What the reconcile pass fixed, what it wants to ask, and what it has not yet checked.' }),
    Object.freeze({ id: 'audit', label: 'Audit', icon: 'fa-magnifying-glass-chart', blurb: 'The deep audit\'s exact findings, staleness, capacity, identity, conservation, answerable by hand, never in fiction.' }),
    Object.freeze({ id: 'prompts', label: 'Prompts', icon: 'fa-pen-ruler', blurb: 'Override what the injected block says, fragment by fragment, or suppress it outright.' }),
    Object.freeze({ id: 'diagnostics', label: 'Diagnostics', icon: 'fa-stethoscope', blurb: 'Extraction, rejections and the health of the record itself.' }),
]);

/** @type {ReadonlyArray<string>} Tab ids, in rail order. Handy for validating a `tab` argument. */
export const OVERLAY_TAB_IDS = Object.freeze(OVERLAY_TABS.map(tab => tab.id));

/**
 * A tab's renderer.
 *
 * Called with an EMPTY body element to fill. It may be async; the shell does not wait on it, so a
 * renderer that fetches should paint something first and fill in after.
 *
 * @callback TabRenderer
 * @param {HTMLElement} body The tab's panel element, emptied for you. Fill it with DOM.
 * @param {TabContext} context Everything the renderer is told about the request.
 * @returns {void|Promise<void>}
 */

/**
 * @typedef {object} TabContext
 * @property {string} tab The tab's own id. Passed so one function can serve two tabs.
 * @property {string} focus The record to stand on, or `''`. See the focus contract below.
 * @property {AbortSignal} signal Aborted when this render is superseded, the player switched tabs,
 *   navigated again, or closed the overlay. An async renderer MUST check it before touching `body`,
 *   because by then `body` may belong to a render that is no longer wanted.
 * @property {(request?: OpenRequest) => Promise<void>} open Navigate onward. A cast row linking to
 *   a thread calls `open({ tab: 'threads', focus: threadKey })` and the shell handles the rest.
 * @property {(element: HTMLElement) => void} reveal Mark an element as the focused record: scrolls
 *   it into view, highlights it, and moves keyboard focus to it. Call this once you have found the
 *   node matching `focus`.
 * @property {() => void} refresh Re-run this renderer with the same context. For a tab that edits
 *   something and wants to redraw.
 */

/**
 * THE FOCUS CONTRACT.
 *
 * `focus` is an opaque string that identifies ONE record inside ONE tab. It is not a selector, not
 * an index and not a display name, it is the key the owning module already stores that record
 * under, so a caller that has the record has the key without doing any work, and a key stays valid
 * across re-renders, re-orderings and renames in a way that an index or a name does not.
 *
 * Each tab owns its own key namespace. What the shell guarantees:
 *
 *   · The string is passed through untouched, including empty (`''` means "no particular record").
 *   · It reaches the renderer as `context.focus` on the render that the navigation triggered.
 *   · An unknown key is the TAB's problem, not the shell's. The shell cannot tell a stale key from
 *     a live one, so it opens the tab regardless; the renderer should show the tab and say the
 *     record was not found, rather than showing nothing.
 *
 * The namespaces, as they stand in the modules that own them today:
 *
 *   cast         An entity key, `entities.snapshot().people[].key` (entities.js:610).
 *   threads      A thread key, the map key from `clocks.view()` (clocks.js:88).
 *   chronicle    An event key, `chronicle.contentKey(text)` (chronicle.js:62), the same key
 *                `chronicle.forget`/`amend` take.
 *   inventory    An item key, `itemKey(name, place, who)` (state-table.js:163). Note this contains
 *                NUL separators; it is a string, and it survives being one, but never put it in a
 *                selector or an id attribute.
 *   assets       An item key in the assets place, same shape as inventory.
 *   diagnostics  A section name, defined by whoever builds that tab.
 *   repairs      An ASK key, `repair-table.js` `askKey(ask)`, or the record key that ask is
 *                about, since a caller holding a row should not have to know how a question is
 *                keyed to link to it. `'ledger'` and `pass:<id>` also answer.
 *
 * A tab that adds a namespace should document it here, beside the others.
 *
 * @typedef {object} OpenRequest
 * @property {string} [tab] Which tab. Omitted means "wherever the overlay was last", or Cast on a
 *   first open.
 * @property {string} [focus] Which record inside that tab. Omitted means none in particular.
 */

/** @type {Map<string, TabRenderer>} Tab id -> renderer, filled by the modules that own each tab. */
const renderers = new Map();

/**
 * The last tab the player stood on, so reopening the overlay lands where they left it.
 *
 * Deliberately module state and not a setting: this is a session convenience, and persisting it
 * would make the overlay open on Diagnostics a week after you last checked a rejection count.
 */
let lastTab = OVERLAY_TAB_IDS[0];

/**
 * The live overlay, or null when closed. One at a time, a second `open()` navigates the one that
 * is already up rather than stacking a second modal over it.
 *
 * @type {{
 *   popup: Popup,
 *   closed: Promise<any>,
 *   tab: string,
 *   focus: string,
 *   panels: Map<string, HTMLElement>,
 *   buttons: Map<string, HTMLButtonElement>,
 *   painted: Set<string>,
 *   controller: AbortController|null,
 *   opener: Element|null,
 * }|null}
 */
let live = null;

/**
 * Put `overlay.css` in the document head, once.
 *
 * The URL is derived from `import.meta.url` rather than hardcoded, so the sheet is found whether
 * the extension is loaded from `/scripts/extensions/sanguine/` or from a third-party path.
 */
function ensureStylesheet() {
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = new URL('./overlay.css', import.meta.url).href;
    document.head.appendChild(link);
}

// At import time, not at first open: a sheet that starts loading when the overlay is already on
// screen paints the shell unstyled for a frame or two.
ensureStylesheet();

/**
 * @param {string} tag Element name.
 * @param {string} [className] Class list.
 * @param {string} [text] Text content. Always set as text, never as HTML; most of what lands in
 *   this overlay is model output.
 * @returns {HTMLElement} The element.
 */
function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** @param {string} id A tab id. @returns {OverlayTab|null} Its definition. */
function tabDef(id) {
    return OVERLAY_TABS.find(tab => tab.id === id) ?? null;
}

/**
 * Register the renderer for a tab.
 *
 * Late registration is fine and expected, the tab modules are imported for their side effect, and
 * whichever of them loads first wins nothing. If the overlay happens to be open and showing that
 * tab's placeholder when its renderer arrives, the placeholder is replaced on the spot.
 *
 * Re-registering the same id replaces the renderer, so a module can be re-imported during
 * development without the page needing a reload.
 *
 * @param {string} id One of `OVERLAY_TAB_IDS`. Unknown ids are refused, not appended, see the note
 *   on `OVERLAY_TABS` about rail order.
 * @param {TabRenderer} renderer The renderer.
 * @returns {() => void} Unregister, restoring the placeholder.
 */
export function registerTab(id, renderer) {
    if (!tabDef(id)) {
        console.error(`[sanguine] overlay: no such tab "${id}", known tabs are ${OVERLAY_TAB_IDS.join(', ')}`);
        return () => {};
    }
    if (typeof renderer !== 'function') {
        console.error(`[sanguine] overlay: renderer for "${id}" is not a function`);
        return () => {};
    }
    renderers.set(id, renderer);

    // A tab standing on its own placeholder should not have to be re-entered by hand to notice that
    // its renderer finally turned up.
    if (live && live.tab === id) {
        paint(id, live.focus);
    }

    return () => {
        if (renderers.get(id) === renderer) renderers.delete(id);
    };
}

/** @returns {boolean} True while the overlay is on screen. */
export function isOpen() {
    return live !== null;
}

/** @returns {{tab: string, focus: string}|null} Where the overlay is standing, or null if closed. */
export function current() {
    return live ? { tab: live.tab, focus: live.focus } : null;
}

/**
 * Close the overlay if it is open.
 *
 * @returns {Promise<void>} When it is gone.
 */
export async function close() {
    if (!live) return;
    await live.popup.complete(POPUP_RESULT.CANCELLED);
}

/**
 * Show an element as the record the player asked for.
 *
 * Three things, because the request came from three directions at once: the eye needs it in view,
 * the eye needs to know which one it is, and the keyboard needs to be standing on it. Screen reader
 * users get the third for free; without it, "open the overlay on this person" would announce the
 * tab and leave the person unread.
 *
 * @param {HTMLElement} element The node holding the focused record.
 */
function reveal(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return;

    const panel = element.closest('.sanguine_overlay_panel');
    for (const previous of panel?.querySelectorAll('.sanguine_overlay_hit') ?? []) {
        previous.classList.remove('sanguine_overlay_hit');
    }
    element.classList.add('sanguine_overlay_hit');

    // Instant, and centred, and both on purpose.
    //
    // `behavior: 'smooth'` was the first cut and it is wrong here: smooth scrolling is driven by the
    // compositor's animation clock, and a panel scrolled in the same task its rows were appended,
    // or scrolled while the tab is not the visible one, never advances. Measured in the running
    // app: the same call with `'smooth'` left `scrollTop` at 0, with `'auto'` it landed. A landing
    // that silently does not land breaks the one promise this module makes.
    //
    // `'center'` rather than `'nearest'` because this is a navigation, not a nudge: `'nearest'` does
    // nothing at all for a record taller than the panel that is already half in view, which leaves
    // the highlighted part off-screen. The cost is a small scroll when the record happened to be
    // visible already, which is the cheaper mistake.
    element.scrollIntoView({ block: 'center', behavior: 'auto' });

    // Programmatic focus needs a tabindex, and -1 is the right one: reachable by script, skipped by
    // Tab, so the record does not join the tab order permanently.
    if (!element.hasAttribute('tabindex')) element.tabIndex = -1;
    element.focus({ preventScroll: true });
}

/**
 * Render one tab's body.
 *
 * @param {string} id The tab.
 * @param {string} focus The focus key for this render.
 */
function paint(id, focus) {
    if (!live) return;
    const body = live.panels.get(id);
    if (!body) return;

    // Whatever the previous render was still doing, it is doing it for a screen that no longer
    // exists. This is the only thing keeping a slow renderer from writing into a tab the player
    // arrowed past three tabs ago.
    live.controller?.abort();
    live.controller = new AbortController();
    const { signal } = live.controller;

    body.replaceChildren();
    live.painted.add(id);

    /** @type {TabContext} */
    const context = {
        tab: id,
        focus,
        signal,
        open: request => open(request),
        reveal,
        refresh: () => paint(id, focus),
    };

    const renderer = renderers.get(id);
    if (!renderer) {
        body.appendChild(placeholder(id, focus));
        return;
    }

    try {
        const result = renderer(body, context);
        // A renderer that throws asynchronously must not take the shell down with it, the rail and
        // the other five tabs are still usable.
        Promise.resolve(result).catch(error => {
            console.error(`[sanguine] overlay: tab "${id}" failed`, error);
            if (!signal.aborted) body.appendChild(failure(error));
        });
    } catch (error) {
        console.error(`[sanguine] overlay: tab "${id}" failed`, error);
        body.replaceChildren(failure(error));
    }
}

/**
 * The body of a tab whose module has not been written yet.
 *
 * It states plainly that it is a placeholder. A blank panel reads as a bug or as an empty campaign;
 * either reading costs the player time working out which.
 *
 * @param {string} id The tab.
 * @param {string} focus The focus key that was asked for, if any.
 * @returns {HTMLElement} The placeholder body.
 */
function placeholder(id, focus) {
    const def = tabDef(id);
    const wrap = el('div', 'sanguine_overlay_placeholder');

    wrap.appendChild(el('p', 'sanguine_overlay_placeholder_flag', t`Not built yet, this is a placeholder.`));
    wrap.appendChild(el('p', 'sanguine_overlay_placeholder_blurb', def ? translate(def.blurb) : ''));
    wrap.appendChild(el('p', 'sanguine_overlay_placeholder_how',
        t`The shell is live; the contents are not. A module claims this tab by calling registerTab with its id.`));

    // The two facts a later agent needs while wiring this tab up, set in the mono face because both
    // are machine keys rather than anything a narrator wrote.
    const keys = el('dl', 'sanguine_overlay_keys');
    keys.appendChild(el('dt', '', t`tab id`));
    keys.appendChild(el('dd', 'sanguine_overlay_key', id));
    if (focus) {
        keys.appendChild(el('dt', '', t`focus key`));
        // NUL separators are real in inventory keys (state-table.js:163) and invisible on screen;
        // shown as ␀ so a key that arrived intact does not look truncated.
        keys.appendChild(el('dd', 'sanguine_overlay_key', focus.replace(/\0/g, '␀')));
    }
    wrap.appendChild(keys);

    return wrap;
}

/**
 * @param {any} error What went wrong.
 * @returns {HTMLElement} A body saying so.
 */
function failure(error) {
    const wrap = el('div', 'sanguine_overlay_failed');
    wrap.appendChild(el('p', '', t`This tab could not be drawn.`));
    wrap.appendChild(el('pre', 'sanguine_overlay_key', String(error?.message ?? error)));
    return wrap;
}

/**
 * Move to a tab.
 *
 * @param {string} id The tab.
 * @param {string} focus The record inside it, or `''`.
 * @param {object} [options] Options.
 * @param {boolean} [options.repaint] Redraw even if the tab is already showing. True when the move
 *   came from `open()` (the focus may have changed); false when it came from the rail.
 * @param {boolean} [options.moveFocus] Move keyboard focus to the tab button. True for pointer and
 *   key activation on the rail, false when opening cold, the dialog's own autofocus has it.
 */
function select(id, focus, { repaint = true, moveFocus = false } = {}) {
    if (!live || !tabDef(id)) return;

    live.tab = id;
    live.focus = focus;
    lastTab = id;

    for (const [tabId, button] of live.buttons) {
        const on = tabId === id;
        button.setAttribute('aria-selected', String(on));
        button.classList.toggle('sanguine_overlay_tab_on', on);
        // Roving tabindex: exactly one tab in the tab order, arrows for the rest. This is what makes
        // the rail one stop rather than seven.
        button.tabIndex = on ? 0 : -1;
    }

    for (const [tabId, panel] of live.panels) {
        panel.hidden = tabId !== id;
    }

    if (moveFocus) live.buttons.get(id)?.focus();
    if (repaint || !live.painted.has(id)) paint(id, focus);
}

/**
 * Arrow-key movement along the rail.
 *
 * Activation follows focus. That is the WAI-ARIA default for tabs and the right call here because
 * every renderer is handed an `AbortSignal`: arrowing quickly past a tab that fetches cancels its
 * render rather than queueing seven of them.
 *
 * Both axes are bound because the rail is vertical on a desktop and horizontal along the bottom
 * below 1000px; the arrow that points along the rail should work at either size, and the player
 * should not have to notice which layout they are in.
 *
 * @param {KeyboardEvent} event The keydown on the rail.
 */
function onRailKey(event) {
    if (!live) return;
    const order = OVERLAY_TAB_IDS;
    const at = order.indexOf(live.tab);
    let next = -1;

    switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
            next = (at + 1) % order.length;
            break;
        case 'ArrowUp':
        case 'ArrowLeft':
            next = (at - 1 + order.length) % order.length;
            break;
        case 'Home':
            next = 0;
            break;
        case 'End':
            next = order.length - 1;
            break;
        default:
            return;
    }

    event.preventDefault();
    // The keystroke is a move between tabs, not a jump to a record: the focus key belongs to the
    // tab it was aimed at, and carrying it sideways would ask Threads to find a person.
    select(order[next], '', { repaint: true, moveFocus: true });
}

/**
 * Build the shell: rail on one side, seven panels on the other.
 *
 * @param {string} startTab Which tab the rail opens on.
 * @returns {{root: HTMLElement, buttons: Map<string, HTMLButtonElement>, panels: Map<string, HTMLElement>}} The shell.
 */
function build(startTab) {
    const root = el('div', 'sanguine_overlay');

    const rail = el('div', 'sanguine_overlay_rail');
    rail.setAttribute('role', 'tablist');
    // Announced as vertical even though the small-screen layout lays it out along the bottom: the
    // rail is a list of seven with a fixed order either way, and re-announcing orientation on a
    // resize would be noise.
    rail.setAttribute('aria-orientation', 'vertical');
    rail.setAttribute('aria-label', t`Sanguine sections`);
    rail.addEventListener('keydown', onRailKey);

    const stage = el('div', 'sanguine_overlay_stage');

    /** @type {Map<string, HTMLButtonElement>} */
    const buttons = new Map();
    /** @type {Map<string, HTMLElement>} */
    const panels = new Map();

    for (const tab of OVERLAY_TABS) {
        const on = tab.id === startTab;

        // A real <button>. Not a div with a click handler: Space and Enter, the focus ring, and the
        // "button" announcement all come from the element, and every one of them would have to be
        // reimplemented (and would be reimplemented worse) on anything else.
        const button = /** @type {HTMLButtonElement} */ (el('button', 'sanguine_overlay_tab'));
        button.type = 'button';
        button.id = `sanguine_overlay_tab_${tab.id}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(on));
        button.setAttribute('aria-controls', `sanguine_overlay_panel_${tab.id}`);
        button.tabIndex = on ? 0 : -1;
        button.title = translate(tab.blurb);
        if (on) button.classList.add('sanguine_overlay_tab_on');

        const icon = el('i', `fa-solid ${tab.icon} sanguine_overlay_tab_icon`);
        icon.setAttribute('aria-hidden', 'true');
        button.appendChild(icon);
        button.appendChild(el('span', 'sanguine_overlay_tab_label', translate(tab.label)));

        button.addEventListener('click', () => select(tab.id, '', { repaint: true, moveFocus: true }));

        const panel = el('div', 'sanguine_overlay_panel');
        panel.id = `sanguine_overlay_panel_${tab.id}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', button.id);
        // Focusable so the panel is reachable by Tab from the rail, and so its scrollbar answers to
        // the keyboard when nothing inside it is focusable.
        panel.tabIndex = 0;
        panel.hidden = !on;

        rail.appendChild(button);
        stage.appendChild(panel);
        buttons.set(tab.id, button);
        panels.set(tab.id, panel);
    }

    root.appendChild(rail);
    root.appendChild(stage);
    return { root, buttons, panels };
}

/**
 * Open the overlay, standing on a record.
 *
 * This is the entry point the panel's summary rows call. It is safe to call while the overlay is
 * already up: the second call navigates rather than stacking a modal on a modal.
 *
 * @param {OpenRequest} [request] Where to land. Both fields are optional; see the focus contract.
 * @returns {Promise<void>} Resolves when the overlay CLOSES, matching the popup layer's own
 *   semantics. Callers that only want to send the player somewhere can ignore it.
 *
 * @example
 * // A cast row's click handler, in the 288px panel:
 * overlay.open({ tab: 'cast', focus: person.key });
 */
export async function open({ tab = '', focus = '' } = {}) {
    ensureStylesheet();

    // A bad tab id still opens the overlay, refusing to open is a worse answer to a typo than
    // opening somewhere. The focus key does NOT come along, though: it was addressed to a namespace
    // that does not exist, and handing it to whichever tab we fell back to would ask Cast to find a
    // thread and then blame Cast for not finding it.
    const named = tabDef(tab) !== null;
    if (tab && !named) {
        console.warn(`[sanguine] overlay: no such tab "${tab}", opening ${lastTab} instead`);
    }
    const wanted = named ? tab : (tabDef(lastTab) ? lastTab : OVERLAY_TAB_IDS[0]);
    const key = (!tab || named) ? String(focus ?? '') : '';

    if (live) {
        select(wanted, key, { repaint: true, moveFocus: false });
        await live.closed;
        return;
    }

    const { root, buttons, panels } = build(wanted);

    // Native dialogs restore focus on close, but only to an element that is still around, and the
    // popup removes its own dialog from the DOM immediately afterwards (popup.js:827-835). Holding
    // the opener ourselves means a row that opened the overlay gets the focus ring back even if the
    // panel redrew underneath us in the meantime.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Autofocus lands on the active tab rather than the Close button. `setAutoFocus` runs inside the
    // Popup constructor and honours an existing `[autofocus]` in the content (popup.js:539, 705),
    // so it has to be set BEFORE the popup is built.
    buttons.get(wanted)?.setAttribute('autofocus', '');

    const popup = new Popup(root, POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        // The panels scroll themselves. Letting the popup body scroll as well would put a second
        // scrollbar around a surface that is already sized to the viewport.
        allowVerticalScrolling: false,
        leftAlign: true,
        onClose: () => {
            live?.controller?.abort();
            live = null;
            if (opener?.isConnected) opener.focus({ preventScroll: true });
        },
    });

    popup.dlg.classList.add(POPUP_CLASS);
    // A `<dialog>` opened with `showModal()` already carries the dialog role and modality
    // implicitly. Stated explicitly anyway: the polyfill path (popup.js:238) is a plain element for
    // browsers without `showModal`, and there the implicit semantics do not exist.
    popup.dlg.setAttribute('role', 'dialog');
    popup.dlg.setAttribute('aria-modal', 'true');
    popup.dlg.setAttribute('aria-label', t`Sanguine`);

    live = {
        popup,
        closed: null,
        tab: wanted,
        focus: key,
        panels,
        buttons,
        painted: new Set(),
        controller: null,
        opener,
    };

    // Shown BEFORE the first paint, and the order is load-bearing. `show()` appends the dialog to
    // the document synchronously (popup.js:680-685), and `reveal` needs the record to be in the
    // document to scroll to it or focus it, painted first, a cold `open({ tab, focus })` would
    // build the right tab and then quietly decline to go to the record, which is the one thing this
    // module exists to do. Nothing is painted to the screen in between: both happen in one task.
    const closed = popup.show().then(() => undefined);
    live.closed = closed;

    paint(wanted, key);

    await closed;
}
