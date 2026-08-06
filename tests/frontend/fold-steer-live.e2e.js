import { expect, test } from '@playwright/test';

import { testSetup } from './frontent-test-utils.js';
import {
    chronicleQuery,
    chronicleSnapshot,
    configureChronicle,
    extractNow,
    lastMessageSwipeState,
    lastMessageText,
    sendMessage,
    steerLastMessage,
    useExtractionProfile,
    useLiveBackend,
} from './fold-test-utils.js';

/**
 * Directed retry against REAL models. Opt-in, because it costs money and needs network.
 *
 *   node tests/util/seed-secrets.mjs        # once, to load keys from .env into the test instance
 *   FOLD_LIVE=1 npm run test:e2e --prefix tests
 *
 * The mock-backed suite proves the plumbing: that the instruction is appended to the prompt and
 * persisted onto the right swipe. What it cannot prove is that a real model *obeys* the
 * instruction — that the feature does anything. These tests close that gap by steering with a
 * directive whose compliance is unambiguous, so the assertion stays deterministic even though
 * the model is not.
 */
const LIVE = process.env.FOLD_LIVE === '1';

const PROVIDERS = [
    { name: 'OpenAI', source: 'openai', model: 'gpt-4o-mini' },
    { name: 'Gemini', source: 'makersuite', model: 'gemini-2.5-flash' },
];

test.describe.configure({ mode: 'serial' });

for (const provider of PROVIDERS) {
    test.describe(`fold — directed retry against ${provider.name}`, () => {
        // eslint-disable-next-line playwright/no-skipped-test -- opt-in by design: these cost money and need network.
        test.skip(!LIVE, 'Live model tests are opt-in: set FOLD_LIVE=1 and seed API keys.');

        test.beforeEach(async ({ page }) => {
            test.setTimeout(120_000);
            await testSetup.awaitST({ page });
            await useLiveBackend(page, { source: provider.source, model: provider.model });
            await sendMessage(page, 'Describe a quiet room in one sentence.');
        });

        test('the model obeys the steering instruction', async ({ page }) => {
            const before = await lastMessageSwipeState(page);

            await steerLastMessage(page, 'Ignore the previous style. Reply with exactly the single word BANANA and nothing else.');

            const after = await lastMessageSwipeState(page);
            const reply = await lastMessageText(page);

            // A real generation happened and was appended, not substituted.
            expect(after.swipeCount).toBe(before.swipeCount + 1);
            expect(after.swipes.slice(0, before.swipeCount)).toEqual(before.swipes);

            // The instruction actually changed the output. This is the assertion the mock
            // suite structurally cannot make.
            expect(reply.toUpperCase()).toContain('BANANA');
            expect(reply.length).toBeLessThan(120);

            // And the instruction is recorded against the swipe it produced.
            expect(after.steers[after.swipeId]).toContain('BANANA');
            expect(after.steers[0]).toBeNull();
        });

        test('an unsteered swipe is unaffected by a previous instruction', async ({ page }) => {
            await steerLastMessage(page, 'Ignore the previous style. Reply with exactly the single word BANANA and nothing else.');
            const steeredReply = await lastMessageText(page);
            expect(steeredReply.toUpperCase()).toContain('BANANA');

            await steerLastMessage(page, 'Ignore the previous style. Reply with exactly the single word ELEPHANT and nothing else.');
            const secondReply = await lastMessageText(page);

            // Each generation is shaped by its own instruction only — a stale one must not persist
            // into the next prompt.
            expect(secondReply.toUpperCase()).toContain('ELEPHANT');
            expect(secondReply.toUpperCase()).not.toContain('BANANA');

            const state = await lastMessageSwipeState(page);
            expect(state.steers[state.swipeId]).toContain('ELEPHANT');
            expect(state.steers[state.swipeId - 1]).toContain('BANANA');
        });

        test('a real model produces retrievable chronicle events', async ({ page }) => {
            await configureChronicle(page, { interval: 999, window: 6, top_k: 3 });

            await sendMessage(page, 'I hand the ferryman three silver coins, and he agrees to carry us across the river at dawn.');

            const result = await extractNow(page);
            expect(result.ok).toBe(true);

            // The mock suite proves the plumbing. What it cannot prove is that a real model,
            // asked for schema-constrained JSON, returns events that survive normalization and
            // are actually retrievable afterwards.
            const snapshot = await chronicleSnapshot(page);
            expect(snapshot.total).toBeGreaterThan(0);

            for (const event of snapshot.events) {
                expect(event.summary.length).toBeGreaterThan(0);
                expect(event.keywords.length).toBeGreaterThan(0);
            }

            // And the keywords it chose are good enough to find the event again by topic.
            const hits = await chronicleQuery(page, 'what happened with the ferryman?');
            expect(hits.length).toBeGreaterThan(0);
        });
    });
}

/**
 * Extraction is mechanical summarization and has no business running on whichever large model
 * the user picked for roleplay. These check that a small model on a separate connection profile
 * does the job, while the conversation keeps its own model.
 */
const EXTRACTION_MODELS = [
    { name: 'gpt-5.6-luna', api: 'openai', model: 'gpt-5.6-luna' },
    { name: 'gemini-3.5-flash-lite', api: 'makersuite', model: 'gemini-3.5-flash-lite' },
];

for (const extractor of EXTRACTION_MODELS) {
    test.describe(`fold — chronicle extraction on ${extractor.name}`, () => {
        // eslint-disable-next-line playwright/no-skipped-test -- opt-in by design: these cost money and need network.
        test.skip(!LIVE, 'Live model tests are opt-in: set FOLD_LIVE=1 and seed API keys.');

        test('a small model on its own connection profile does the extraction', async ({ page }) => {
            test.setTimeout(180_000);
            await testSetup.awaitST({ page });

            // The conversation runs on one model...
            await useLiveBackend(page, { source: 'openai', model: 'gpt-4o-mini' });
            await configureChronicle(page, { interval: 999, window: 6, top_k: 3 });
            // ...while extraction runs on another, entirely separate one.
            await useExtractionProfile(page, extractor);

            await sendMessage(page, 'I hand the ferryman three silver coins, and he agrees to carry us across the river at dawn.');

            const result = await extractNow(page);
            expect(result.ok).toBe(true);

            const snapshot = await chronicleSnapshot(page);
            expect(snapshot.total).toBeGreaterThan(0);
            for (const event of snapshot.events) {
                expect(event.summary.length).toBeGreaterThan(0);
                expect(event.keywords.length).toBeGreaterThan(0);
            }

            expect((await chronicleQuery(page, 'what did we agree with the ferryman?')).length)
                .toBeGreaterThan(0);
        });
    });
}
