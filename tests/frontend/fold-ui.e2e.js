import { expect, test } from '@playwright/test';

import { MockServer } from '../util/mock-server.js';
import { testSetup } from './frontent-test-utils.js';
import { useMockBackend } from './fold-test-utils.js';

/**
 * Phase F's three gate specs (FOLD-REDESIGN.md §10, Phase F): edit-commits-as-ledger-events, lock
 * round-trip with the `(fixed)` marker reaching the prompt, and the value→trail→message cause-link
 * jump. Each drives a real instance, writes a fold fixture, and asserts on the rendered surface —
 * the same pattern as fold-panel-threads.e2e.js.
 *
 * The inventory items these need are written as chronicle events keyed `k: 'usr'` (USER_ANCHOR), so
 * `liveEvents()` keeps them live without depending on the mock chat's content keys.
 */
test.describe.configure({ mode: 'serial' });

test.describe('fold — the three-altitude UI affordances', () => {
    /** @type {MockServer} */
    let mockServer;
    /** @type {number} */
    let mockPort;

    test.beforeAll(async ({}, testInfo) => {
        mockPort = 3220 + testInfo.parallelIndex;
        mockServer = new MockServer({ port: mockPort, host: '127.0.0.1' });
        await mockServer.start();
    });

    test.afterAll(async () => {
        await mockServer?.stop();
    });

    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await useMockBackend(page, { mockPort });
        // Dismiss whatever dialog SillyTavern raised (update notice, onboarding), or its `<dialog>`
        // intercepts pointer events and every click lands on the modal instead of the panel.
        await page.evaluate(() => {
            for (const dialog of document.querySelectorAll('dialog.popup[open]')) {
                dialog.close();
            }
        });
    });

    /** Write a fixture: one rope in the ledger, and render the panel. */
    async function renderRopeFixture(page, mid) {
        await page.evaluate(async (mid) => {
            const { chat_metadata } = await import('./script.js');
            const panel = await import('./scripts/extensions/sanguine/panel.js');
            chat_metadata.fold = {
                v: 2,
                state: {
                    turn: { n: 2 },
                    context: {
                        location: { v: 'the broker\'s shop', t: 1, src: 'narrative' },
                        pov: { v: 'Solomon', t: 1, src: 'narrative' },
                    },
                },
                chronicle: {
                    events: {
                        'fx:0': {
                            s: 'Found three coils of rope', kw: ['rope'], t: 1, mid,
                            src: 'llm', k: 'usr',
                            d: { inv: [{ item: 'rope', dq: 3 }] },
                        },
                    },
                    hits: {},
                },
            };
            panel.setVisible(true);
            panel.render();
        }, mid);
    }

    test('editing a quantity in place commits a ledger user event', async ({ page }) => {
        await renderRopeFixture(page, 1);
        const row = page.locator('#sanguineTracker .sanguine_tracker_body .sanguine_item').filter({ hasText: 'Rope' });
        await expect(row).toHaveCount(1);
        await expect(row.locator('.sanguine_editable')).toContainText('3');

        // Click the count, select all, type a new one, commit with Enter.
        const qty = row.locator('.sanguine_editable');
        // The moving-panel surface sits over the chat and Playwright's actionability check treats
        // it as intercepting the click; the handler fires fine, so force past the check.
        // eslint-disable-next-line playwright/no-force-option
        await qty.click({ force: true });
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.type('5');
        await page.keyboard.press('Enter');

        // The panel reflects the committed edit…
        await expect(row.locator('.sanguine_editable')).toContainText('5');

        // …and the chronicle gained a USER event carrying the +2 delta — the §8 edit-in-place
        // contract ("every commit is a user event in the ledger").
        const deltas = await page.evaluate(async () => {
            const { chat_metadata } = await import('./script.js');
            const events = chat_metadata.fold?.chronicle?.events ?? {};
            return Object.entries(events)
                .filter(([key]) => key.startsWith('usr:'))
                .map(([, event]) => event?.d?.inv ?? []);
        });
        expect(deltas.some(list => list.some(c => c.item === 'rope' && c.dq === 2))).toBe(true);
    });

    test('a locked scene field renders (fixed) in the injected block', async ({ page }) => {
        await page.evaluate(async () => {
            const { chat_metadata } = await import('./script.js');
            const state = await import('./scripts/extensions/sanguine/state.js');
            chat_metadata.fold = {
                v: 2,
                state: {
                    turn: { n: 2 },
                    context: {
                        location: { v: 'the broker\'s shop', t: 1, src: 'narrative' },
                        pov: { v: 'Solomon', t: 1, src: 'narrative' },
                    },
                },
                chronicle: { events: {}, hits: {} },
            };
            state.setLock('location', true);
        });

        const block = await page.evaluate(async () => {
            const state = await import('./scripts/extensions/sanguine/state.js');
            return state.render();
        });

        // The lock serialises into the prompt: the narrator is TOLD the field is pinned, so it stops
        // silently overriding it and left fighting the block (§8, Marinara's lockManager design).
        expect(block).toContain('Location: the broker\'s shop (fixed)');
    });

    test('clicking a contributor jumps to its causing message', async ({ page }) => {
        // A synthetic causing message gives the jump a real, observable target — the mock chat's own
        // lines are not guaranteed to render with a mesid, and the jump's contract is the selector
        // `.mes[mesid]` (FOLD-REDESIGN.md §8), which a synthetic node exercises exactly.
        const mid = 5;
        await page.evaluate(async (mid) => {
            const { chat_metadata } = await import('./script.js');
            const panel = await import('./scripts/extensions/sanguine/panel.js');
            const target = document.createElement('div');
            target.className = 'mes';
            target.setAttribute('mesid', String(mid));
            target.textContent = 'the message that caused the rope';
            (document.querySelector('#chat') ?? document.body).appendChild(target);

            chat_metadata.fold = {
                v: 2,
                state: {
                    turn: { n: 2 },
                    context: {
                        location: { v: 'the broker\'s shop', t: 1, src: 'narrative' },
                        pov: { v: 'Solomon', t: 1, src: 'narrative' },
                    },
                },
                chronicle: {
                    events: {
                        'fx:0': {
                            s: 'Found three coils of rope', kw: ['rope'], t: 1, mid,
                            src: 'llm', k: 'usr',
                            d: { inv: [{ item: 'rope', dq: 3 }] },
                        },
                    },
                    hits: {},
                },
            };
            panel.setVisible(true);
            panel.render();
        }, mid);

        const row = page.locator('#sanguineTracker .sanguine_tracker_body .sanguine_item').filter({ hasText: 'Rope' });
        await expect(row).toHaveCount(1);

        // Open the cause-link trail, click the contributor.
        await row.locator('.sanguine_item_head').click();
        const jump = row.locator('.sanguine_trail_row.sanguine_trail_jump');
        await expect(jump).toHaveCount(1);
        await jump.click();

        // The causing message received the jump-target flash — the scroll and highlight are the
        // observable side effect of `jumpToMessage` (§8, altitude 3).
        await expect(page.locator(`.mes[mesid="${mid}"].sanguine_jump_target`)).toHaveCount(1);
    });
});
