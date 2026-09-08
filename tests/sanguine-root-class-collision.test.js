import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The root-class collision gate.
 *
 * The panel's outermost element wears state classes: `panel.classList.add('sanguine_mounted',
 * 'sanguine_open')` in `panel.js`, plus `sanguine_dragging` while it is being moved. Those names
 * describe the PANEL. Every other class in the sheet describes something INSIDE the panel.
 *
 * When one name is used for both, a rule written for a 200px span silently applies to the whole
 * 288px column. That is not hypothetical, it shipped, and it survived two audits:
 *
 *   `.sanguine_open` was the panel's expanded-state class AND the class on a thread's unresolved
 *   question. The span rule set `opacity: var(--o-context)`, `font-size: var(--s-sub)`,
 *   `overflow: hidden` and a `::before { content: '? ' }`, and because `#sanguineTracker` happens
 *   not to declare opacity or font-size, all four went through onto the panel root. The whole panel
 *   rendered faded, which multiplies every one of the four opacity stops by a constant and
 *   flattens the exact hierarchy they exist to express, at the wrong base font size, with the
 *   collapse handle clipped by an `overflow` the root deliberately sets to `visible`, and with a
 *   bare question mark printed in the top-left corner.
 *
 *   `color` and `display` were the only declarations neutralised, by `#sanguineTracker
 *   .sanguine_mounted` winning on ID specificity. That is why a colour audit and a type audit both
 *   passed over it: the two properties an auditor would look at first were the two that were fine.
 *
 * The instance was a rename. The CLASS is that a root state class could be styled unscoped at all,
 * and this gate closes it: any rule whose selector mentions a root class must anchor that selector
 * to `#sanguineTracker`, so it cannot match anything else and cannot leak onto anything else.
 *
 * Structural, it reads selector text, never narrative. RULE 1 clean.
 */

const SANGUINE = path.join(process.cwd(), '..', 'public', 'scripts', 'extensions', 'sanguine');
const PANEL = fs.readFileSync(path.join(SANGUINE, 'panel.js'), 'utf8');

/** The element every panel state class lands on. */
const ROOT_SELECTOR = '#sanguineTracker';

/**
 * The classes `panel.js` puts on the panel root.
 *
 * Read out of the source rather than listed here, so a fourth state class added tomorrow is
 * governed by this gate without anyone remembering to come back and add it.
 */
function rootClasses() {
    const found = new Set();
    // `panel?.classList.add('sanguine_mounted', 'sanguine_open')`, `.remove('sanguine_open')`,
    // `.contains('sanguine_open')`, `.toggle('sanguine_dragging')`: on a `panel`/`PANEL_ID`
    // receiver, which is what distinguishes a root write from a row write.
    const calls = PANEL.matchAll(/(?:panel|PANEL_ID\)|getElementById\([A-Z_]+\))[^\n;]*?\.classList\s*\.\s*(?:add|remove|toggle|contains)\(([^)]*)\)/g);
    for (const call of calls) {
        for (const quoted of call[1].matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)) {
            found.add(quoted[1]);
        }
    }
    return found;
}

/** Every selector in the sheet, one per entry, comments and declaration blocks removed. */
function selectors() {
    const css = fs.readFileSync(path.join(SANGUINE, 'style.css'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '');
    const out = [];
    for (const block of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
        for (const one of block[1].split(',')) {
            const text = one.trim();
            // `@media`/`@supports` preludes are not selectors; their contents are matched separately
            // because the outer block's body contains the inner rules and this regex is not nested.
            if (text && !text.startsWith('@')) {
                out.push(text);
            }
        }
    }
    return out;
}

describe('panel root state classes cannot be styled unscoped', () => {
    test('panel.js is still writing root classes this gate can see', () => {
        const roots = rootClasses();
        // If this ever empties, the regex above stopped matching and the gate below is vacuous,
        // a silently-disabled gate is worse than no gate, so it fails loudly instead.
        expect(roots.size).toBeGreaterThan(0);
        expect(roots).toContain('sanguine_open');
        expect(roots).toContain('sanguine_mounted');
    });

    test.each([...rootClasses()])('every rule mentioning .%s is anchored to #sanguineTracker', (name) => {
        const offenders = selectors().filter(selector => {
            // The class, not a longer name that merely starts with it: `sanguine_open` must not
            // match `sanguine_open_link`, `sanguine_open_trail`, `sanguine_open_clamp` or
            // `sanguine_open_win`, all of which are ordinary content classes.
            if (!new RegExp(`\\.${name}(?![\\w-])`).test(selector)) {
                return false;
            }
            return !selector.includes(ROOT_SELECTOR);
        });
        expect(offenders).toEqual([]);
    });
});
