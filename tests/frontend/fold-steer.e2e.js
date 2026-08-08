import { expect, test } from '@playwright/test';

import { MockServer } from '../util/mock-server.js';
import { testSetup } from './frontent-test-utils.js';
import {
    currentChatId,
    goToSwipe,
    lastMessageSwipeState,
    plainSwipeRight,
    reopenAssistantChat,
    saveChatNow,
    sendMessage,
    steerLastMessage,
    useMockBackend,
} from './fold-test-utils.js';

/**
 * End-to-end verification of fold's directed retry (Pillar C).
 *
 * These run against a real SillyTavern instance talking to a MockServer, so the assertions are
 * about what actually happened: what reached the model, and what ended up on disk. The mock
 * echoes the last prompt message back as the reply, which makes the prompt directly observable.
 *
 * Serial because each test drives one shared browser chat and one shared mock port.
 */
test.describe.configure({ mode: 'serial' });

test.describe('fold — directed retry', () => {
    /** @type {MockServer} */
    let mockServer;
    /** @type {number} */
    let mockPort;

    test.beforeAll(async ({}, testInfo) => {
        // One port per worker so a parallel run of the wider suite cannot collide.
        mockPort = 3100 + testInfo.parallelIndex;
        mockServer = new MockServer({ port: mockPort, host: '127.0.0.1' });
        await mockServer.start();
    });

    test.afterAll(async () => {
        await mockServer?.stop();
    });

    test.beforeEach(async ({ page }) => {
        mockServer.reset();
        await testSetup.awaitST({ page });
        await useMockBackend(page, { mockPort });
        await sendMessage(page, 'Hello there.');
    });

    test('the steering instruction reaches the prompt', async ({ page }) => {
        mockServer.reset();
        const started = await steerLastMessage(page, 'make her angrier');
        expect(started).toBe(true);

        // The assertion that matters: the rendered template was actually appended to the prompt.
        // Eyeballing whether a reply "sounds angrier" cannot establish this; reading the request can.
        expect(mockServer.requests.length).toBe(1);
        expect(mockServer.lastPromptText()).toContain('[Instruction for the next reply: make her angrier]');
    });

    test('a steered swipe is appended and the previous swipe is untouched', async ({ page }) => {
        const before = await lastMessageSwipeState(page);
        await steerLastMessage(page, 'be brief');
        const after = await lastMessageSwipeState(page);

        expect(after.swipeCount).toBe(before.swipeCount + 1);
        expect(after.swipeId).toBe(after.swipeCount - 1);
        // Every pre-existing swipe survives verbatim — this is why steering uses Generate('swipe')
        // and never Generate('regenerate'), which deletes the whole message first.
        expect(after.swipes.slice(0, before.swipeCount)).toEqual(before.swipes);
    });

    test('the instruction lands on the swipe it produced, not the previous one', async ({ page }) => {
        await steerLastMessage(page, 'be brief');
        const state = await lastMessageSwipeState(page);

        // The syncMesToSwipe trap: writing extra before swipe() runs would stamp the instruction
        // onto the swipe being navigated away from.
        expect(state.steers[state.swipeId]).toBe('be brief');
        expect(state.steers.slice(0, state.swipeId)).toEqual(
            new Array(state.swipeId).fill(null));
    });

    test('a plain overswipe after a steered one does not inherit the instruction', async ({ page }) => {
        await steerLastMessage(page, 'be brief');
        const steered = await lastMessageSwipeState(page);
        expect(steered.steers[steered.swipeId]).toBe('be brief');

        await plainSwipeRight(page);
        const plain = await lastMessageSwipeState(page);

        // Guards the `delete message.extra.fold_steer` line in clearMessageData: without it,
        // syncSwipeToMes restores the instruction and it silently rides onto the next swipe.
        expect(plain.swipeCount).toBe(steered.swipeCount + 1);
        expect(plain.steers[plain.swipeId]).toBeNull();
        expect(plain.steers[steered.swipeId]).toBe('be brief');
    });

    test('the plain overswipe prompt carries no instruction', async ({ page }) => {
        await steerLastMessage(page, 'mention the sword');
        mockServer.reset();
        await plainSwipeRight(page);

        expect(mockServer.requests.length).toBe(1);
        expect(mockServer.lastPromptText()).not.toContain('mention the sword');
    });

    test('steering from an earlier swipe appends at the end instead of overwriting', async ({ page }) => {
        await steerLastMessage(page, 'first instruction');
        await plainSwipeRight(page);

        const before = await lastMessageSwipeState(page);
        expect(before.swipeCount).toBeGreaterThanOrEqual(3);

        // Navigate back to the very first swipe, then steer from there.
        await goToSwipe(page, 0);
        expect((await lastMessageSwipeState(page)).swipeId).toBe(0);

        await steerLastMessage(page, 'second instruction');
        const after = await lastMessageSwipeState(page);

        // forceSwipeId: swipes.length is what guarantees this appends rather than replacing swipe 0.
        expect(after.swipeCount).toBe(before.swipeCount + 1);
        expect(after.swipeId).toBe(after.swipeCount - 1);
        expect(after.steers[after.swipeId]).toBe('second instruction');
        expect(after.steers[0]).toBeNull();
        expect(after.swipes[0]).toBe(before.swipes[0]);
    });

    test('instructions survive a reload', async ({ page }) => {
        await steerLastMessage(page, 'persist me');
        const before = await lastMessageSwipeState(page);
        const chatId = await currentChatId(page);
        await saveChatNow(page);

        await testSetup.awaitST({ page });
        await reopenAssistantChat(page);

        expect(await currentChatId(page)).toBe(chatId);
        const after = await lastMessageSwipeState(page);

        // Proves the round trip through the chat file on disk, not just in-memory state.
        expect(after.swipeCount).toBe(before.swipeCount);
        expect(after.steers).toEqual(before.steers);
    });

    test('the /steer slash command works and rejects an empty instruction', async ({ page }) => {
        const before = await lastMessageSwipeState(page);

        await page.evaluate(async () => {
            const { getContext } = await import('./scripts/extensions.js');
            const { eventSource, event_types } = await import('./script.js');
            const received = new Promise(resolve => eventSource.once(event_types.MESSAGE_RECEIVED, resolve));
            await getContext().executeSlashCommandsWithOptions('/steer await=true speak in riddles');
            await received;
            await new Promise(resolve => setTimeout(resolve, 200));
        });

        const after = await lastMessageSwipeState(page);
        expect(after.swipeCount).toBe(before.swipeCount + 1);
        expect(after.steers[after.swipeId]).toBe('speak in riddles');
        expect(mockServer.lastPromptText()).toContain('[Instruction for the next reply: speak in riddles]');

        // An empty instruction must not generate anything at all.
        mockServer.reset();
        const rejected = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            const { requestSteer } = await import('./scripts/extensions/fold/steer.js');
            return await requestSteer(chat.length - 1, '   ', { source: 'ui' });
        });
        expect(rejected).toBe(false);
        expect(mockServer.requests.length).toBe(0);
    });
});

test.describe('fold — directed retry over the streaming path', () => {
    /** @type {MockServer} */
    let mockServer;
    /** @type {number} */
    let mockPort;

    test.beforeAll(async ({}, testInfo) => {
        mockPort = 3200 + testInfo.parallelIndex;
        mockServer = new MockServer({ port: mockPort, host: '127.0.0.1' });
        await mockServer.start();
    });

    test.afterAll(async () => {
        await mockServer?.stop();
    });

    test('the instruction persists when the reply is streamed', async ({ page }) => {
        mockServer.reset();
        await testSetup.awaitST({ page });
        await useMockBackend(page, { mockPort, stream: true });
        await sendMessage(page, 'Hello there.');

        await steerLastMessage(page, 'whisper it');
        const state = await lastMessageSwipeState(page);

        // Streaming writes swipe_info in different places than the blocking path (onProgressStreaming
        // and finalizeIntermediaryMessage rather than saveReply's tail). Both must carry the record.
        expect(state.steers[state.swipeId]).toBe('whisper it');
        expect(mockServer.lastPromptText()).toContain('[Instruction for the next reply: whisper it]');
    });
});
