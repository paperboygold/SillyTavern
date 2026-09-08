import { expect, test } from '@playwright/test';

import { MockServer } from '../util/mock-server.js';
import { testSetup } from './frontent-test-utils.js';
import { useMockBackend } from './fold-test-utils.js';

/**
 * The two honesty marks the second hand repair demanded, asserted on the rendered panel.
 *
 * The pure layer is unit-tested (`fold-thread-table.test.js`, `fold-entity-table.test.js`), and
 * those tests prove `castAt` keeps three values and `renderEntities` never asserts an UNPLACED
 * person plainly. They cannot prove the PANEL hedges, because the panel is DOM and imports
 * SillyTavern's own module graph. So this spec drives a real instance, writes a fold state by
 * hand into `chat_metadata`, repaints, and reads the markup:
 *
 *   · a person with no recorded place appears in Here, dimmed, saying "whereabouts unstated"
 *   · a doom dial draws as a segmented clock face under Pressure
 *   · a progress dial draws as a filling bar under Progress, and NEVER under Pressure
 *
 * FOLD-REDESIGN.md §0.1-1, §0.1-3, §8.
 */
test.describe.configure({ mode: 'serial' });

test.describe('fold — the panel, hedged and polarised', () => {
    /** @type {MockServer} */
    let mockServer;
    /** @type {number} */
    let mockPort;

    test.beforeAll(async ({}, testInfo) => {
        mockPort = 3160 + testInfo.parallelIndex;
        mockServer = new MockServer({ port: mockPort, host: '127.0.0.1' });
        await mockServer.start();
    });

    test.afterAll(async () => {
        await mockServer?.stop();
    });

    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await useMockBackend(page, { mockPort });

        // A v2 blob written directly, because the point of this spec is the RENDERING and going
        // through extraction would make the fixture depend on what a model happened to say.
        await page.evaluate(async () => {
            // The entity table separates kind from name with a NUL, so a name can never forge a kind
            // (`entity-table.js` KIND_SEP). A fixture that uses a space builds LEAD rows by accident.
            const NUL = '\u0000';
            const { chat_metadata } = await import('./script.js');
            const panel = await import('./scripts/extensions/sanguine/panel.js');
            chat_metadata.fold = {
                v: 2,
                state: {
                    turn: { n: 9 },
                    context: {
                        location: { v: 'the broker\'s shop', t: 9, src: 'narrative' },
                        pov: { v: 'Solomon', t: 9, src: 'narrative' },
                    },
                    cast: {
                        [`person${NUL}the scarred broker`]: {
                            kind: 'person', name: 'the scarred broker', place: 'the broker\'s shop',
                            status: 'present', turn: 9, first: 9,
                        },
                        [`person${NUL}kang min-seo`]: {
                            kind: 'person', name: 'Kang Min-seo', aka: 'Kang', place: '',
                            reach: 'phone number', status: 'remote', turn: 9, first: 9,
                        },
                    },
                    threads: {
                        'the residency window closes': {
                            name: 'The residency window closes', kind: 'doom', filled: 1, size: 8,
                            about: 'the sponsorship lapses', status: 'open', seen: 'open',
                            where: '', turn: 9, first: 9,
                        },
                        'residency in korea': {
                            name: 'Residency in Korea', kind: 'progress', filled: 1, size: 20,
                            about: 'Solomon completes 20 D-rank raids and gains residency',
                            status: 'open', seen: 'open', where: '', turn: 9, first: 9,
                        },
                    },
                },
                chronicle: { events: {}, hits: {} },
            };
            panel.setVisible(true);
            panel.render();
        });
    });

    test('an unplaced person is in Here, dimmed, and says so', async ({ page }) => {
        const here = page.locator('#sanguineTracker .sanguine_tracker_body .sanguine_row.sanguine_entity');
        await expect(here.filter({ hasText: 'the scarred broker' })).toHaveCount(1);

        const hedged = here.filter({ hasText: 'Kang Min-seo' });
        await expect(hedged).toHaveClass(/sanguine_unplaced/);
        await expect(hedged).toContainText('whereabouts unstated');
        // And the person the scene actually contains is NOT hedged.
        await expect(here.filter({ hasText: 'the scarred broker' })).not.toHaveClass(/sanguine_unplaced/);
    });

    test('reach rides the row rather than the inventory', async ({ page }) => {
        await expect(page.locator('#sanguineTracker .sanguine_tracker_body .sanguine_row.sanguine_entity').filter({ hasText: 'Kang Min-seo' }))
            .toContainText('phone number');
    });

    test('doom draws as a clock face; progress draws as a bar', async ({ page }) => {
        const panel = page.locator('#sanguineTracker .sanguine_tracker_body');
        await expect(panel).toContainText('Pressure');
        await expect(panel).toContainText('Progress');

        const doom = panel.locator('.sanguine_clock_row').filter({ hasText: 'residency window closes' });
        await expect(doom.locator('.sanguine_dial .sanguine_seg')).toHaveCount(8);
        await expect(doom.locator('.sanguine_track')).toHaveCount(0);

        const progress = panel.locator('.sanguine_clock_row').filter({ hasText: 'Residency in Korea' });
        await expect(progress).toHaveClass(/sanguine_progress_row/);
        await expect(progress.locator('.sanguine_track')).toHaveCount(1);
        await expect(progress.locator('.sanguine_dial')).toHaveCount(0);
    });

    test('the progress dial is never under the Pressure heading', async ({ page }) => {
        // The headings are siblings in document order, so "under Pressure" means "between the
        // Pressure heading and the next one". That is the actual claim §0.1-3 is about.
        const between = await page.evaluate(() => {
            const nodes = [...document.querySelectorAll('#sanguineTracker .sanguine_tracker_body > *')];
            const start = nodes.findIndex(node => node.textContent.trim().startsWith('Pressure'));
            const rest = nodes.slice(start + 1);
            const end = rest.findIndex(node => node.classList.contains('sanguine_sec'));
            return rest.slice(0, end === -1 ? rest.length : end).map(node => node.textContent).join(' ');
        });
        expect(between).toContain('residency window closes');
        expect(between).not.toContain('Residency in Korea');
        expect(between).not.toContain('gains residency');
    });
});
