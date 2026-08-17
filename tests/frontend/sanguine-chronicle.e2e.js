import { expect, test } from '@playwright/test';

import { MockServer } from '../util/mock-server.js';
import { testSetup } from './frontent-test-utils.js';
import {
    addWorldInfoEntry,
    chronicleQuery,
    chronicleSnapshot,
    configureChronicle,
    configureState,
    extractNow,
    plainSwipeRight,
    recallBlock,
    reopenAssistantChat,
    saveChatNow,
    sendMessage,
    stateBlock,
    stateSnapshot,
    useMockBackend,
} from './sanguine-test-utils.js';

/**
 * End-to-end verification of the chronicle ledger (Pillar D).
 *
 * The mock plays two roles here: it answers ordinary chat turns by echoing the prompt, and it
 * answers the extraction call with scripted JSON. That lets the tests assert the whole loop —
 * extraction, dedup, branch-awareness, retrieval and injection — deterministically, without a
 * real model's variability sitting in the middle of every assertion.
 */
test.describe.configure({ mode: 'serial' });

/** Recognise the extraction call by its system prompt rather than by call ordering. */
function isExtractionRequest(body) {
    return (body?.messages ?? []).some(m => String(m?.content ?? '').includes('narrative archivist'));
}

/**
 * Make the mock answer extraction calls with a fixed set of events.
 * @param {MockServer} mockServer The mock.
 * @param {Array<{summary: string, keywords: string[]}>} events Events to return.
 */
/**
 * Monotonic across the whole file, not per-call. A counter reset by each scriptExtraction() call
 * would hand the same text to two different swipes, and identical text means an identical content
 * hash — which is exactly the identity the ledger keys on.
 */
let replyCounter = 0;

function scriptExtraction(mockServer, events) {
    mockServer.setResponder((body) => {
        if (isExtractionRequest(body)) {
            return JSON.stringify({ events });
        }
        // Contentless, so no earlier keyword leaks into the retrieval window the way the default
        // echo would — but distinct per call, because event identity is the content hash of the
        // swipe it came from, and two byte-identical swipes would share one key.
        return `Understood, quite so. (${++replyCounter})`;
    });
}

test.describe('fold — chronicle', () => {
    /** @type {MockServer} */
    let mockServer;
    /** @type {number} */
    let mockPort;

    test.beforeAll(async ({}, testInfo) => {
        mockPort = 3300 + testInfo.parallelIndex;
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
        // Extraction is driven explicitly by the tests. With a low interval the automatic pass
        // fires right after each reply, so the mock's *last* request would be the extraction call
        // rather than the chat prompt — which silently breaks any assertion about what the model
        // was told. The automatic trigger has its own test below.
        await configureChronicle(page, { interval: 999, window: 6, top_k: 3 });
        // Install the bland responder before the first turn. The mock's default is to echo the
        // prompt, which would put every earlier keyword into the assistant's reply and therefore
        // into the retrieval window — making a genuinely unrelated query impossible to write.
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'We travelled to the Dragon Keep and bought rope in town.');
    });

    test('extraction writes events into the ledger', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep', 'travel'] },
            { summary: 'The party bought rope in town', keywords: ['rope', 'town'] },
        ]);

        const result = await extractNow(page);
        expect(result.ok).toBe(true);
        expect(result.results.events.added).toBe(2);

        const snapshot = await chronicleSnapshot(page);
        expect(snapshot.total).toBe(2);
        expect(snapshot.events.map(e => e.summary)).toEqual(
            expect.arrayContaining(['The party travelled to the Dragon Keep', 'The party bought rope in town']));
    });

    test('a refusal writes nothing to the ledger', async ({ page }) => {
        mockServer.setResponder(() => 'I am terribly sorry, but I cannot comply with that request.');

        const result = await extractNow(page);

        // Nothing recoverable, so the cycle is abandoned rather than partially applied.
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('unparseable');
        expect((await chronicleSnapshot(page)).total).toBe(0);
    });

    test('prose containing a valid object is still recovered', async ({ page }) => {
        // Backends that ignore jsonSchema hand back prose; the parser's later tiers exist for them.
        mockServer.setResponder((body) => isExtractionRequest(body)
            ? 'Certainly!\n```json\n{"events":[{"summary":"A pact was sworn at dawn","keywords":["pact","dawn"]}]}\n```'
            : 'ok');

        const result = await extractNow(page);
        expect(result.ok).toBe(true);
        expect((await chronicleSnapshot(page)).events[0].summary).toBe('A pact was sworn at dawn');
    });

    test('re-extracting the same content does not duplicate events', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep'] },
        ]);

        await extractNow(page);
        const first = await chronicleSnapshot(page);
        await extractNow(page);
        const second = await chronicleSnapshot(page);

        // Same source content means the same key, and the Map merge overwrites in place.
        expect(first.total).toBe(1);
        expect(second.total).toBe(1);
    });

    test('retrieval ranks by keyword overlap and ignores unrelated events', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep'] },
            { summary: 'The party bought rope in town', keywords: ['rope', 'town'] },
        ]);
        await extractNow(page);

        expect(await chronicleQuery(page, 'tell me about the dragon')).toEqual(
            ['The party travelled to the Dragon Keep']);
        expect(await chronicleQuery(page, 'what about the rope?')).toEqual(
            ['The party bought rope in town']);
        expect(await chronicleQuery(page, 'completely unrelated topic')).toEqual([]);
    });

    test('retrieved events are injected into the next prompt', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep'] },
        ]);
        await extractNow(page);

        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'What do you remember about the dragon?');

        // The injected block reached the model, under the configured template.
        const prompt = mockServer.lastPromptText();
        expect(prompt).toContain('Relevant past events:');
        expect(prompt).toContain('The party travelled to the Dragon Keep');
    });

    test('nothing is injected when no event matches', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party bought rope in town', keywords: ['rope', 'town'] },
        ]);
        await extractNow(page);

        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'Describe the weather please.');

        // An empty header would spend tokens telling the model nothing.
        expect(mockServer.lastPromptText()).not.toContain('Relevant past events:');
    });

    test('events from an abandoned swipe leave the branch, and come back with it', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'A secret door was discovered behind the tapestry', keywords: ['door', 'tapestry', 'secret'] },
        ]);
        await extractNow(page);
        expect(await chronicleQuery(page, 'the secret door')).toHaveLength(1);

        // Generate a new swipe: the content the event was extracted from is no longer in the chat.
        mockServer.reset();
        scriptExtraction(mockServer, []);
        await plainSwipeRight(page);

        expect(await chronicleQuery(page, 'the secret door')).toEqual([]);

        // Retained, not destroyed — the snapshot still holds it, marked dead on this branch.
        const snapshot = await chronicleSnapshot(page);
        expect(snapshot.total).toBe(1);
        expect(snapshot.live).toBe(0);

        // Swipe back and it returns. This is the property a {messageId, swipeId} scheme cannot
        // give, because swipe indices shift underneath it.
        await page.evaluate(async () => {
            const { chat, swipe } = await import('./script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('./scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, message: chat[chat.length - 1] });
            await new Promise(resolve => setTimeout(resolve, 300));
        });

        expect(await chronicleQuery(page, 'the secret door')).toHaveLength(1);
    });

    test('the ledger survives a reload', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep'] },
        ]);
        await extractNow(page);
        await saveChatNow(page);

        const before = await chronicleSnapshot(page);
        expect(before.total).toBe(1);

        await testSetup.awaitST({ page });
        await reopenAssistantChat(page);

        const after = await chronicleSnapshot(page);
        expect(after.total).toBe(before.total);
        expect(after.events[0].summary).toBe(before.events[0].summary);

        // And it is still retrievable, which means the derived keyword index rebuilt correctly
        // from the persisted ledger rather than being stored and reloaded.
        await configureChronicle(page, { interval: 1 });
        expect(await chronicleQuery(page, 'dragon')).toHaveLength(1);
    });

    test('extraction fires automatically once the interval is reached', async ({ page }) => {
        await configureChronicle(page, { interval: 1 });
        scriptExtraction(mockServer, [
            { summary: 'A bargain was struck with the ferryman', keywords: ['bargain', 'ferryman'] },
        ]);

        await sendMessage(page, 'We strike a bargain with the ferryman.');

        // The pass is fire-and-forget by design — the reply must never wait on it — so poll
        // rather than assuming it has landed by the time sendMessage returns.
        await expect.poll(async () => (await chronicleSnapshot(page)).total, { timeout: 15_000 })
            .toBeGreaterThan(0);

        const snapshot = await chronicleSnapshot(page);
        expect(snapshot.events.some(e => e.summary.includes('ferryman'))).toBe(true);
    });

    test('evidence already covered by World Info is not repeated', async ({ page }) => {
        const lore = 'The Dragon Keep stands on the cliffs above the river crossing.';
        scriptExtraction(mockServer, [{ summary: lore, keywords: ['dragon', 'keep'] }]);
        await extractNow(page);
        expect((await chronicleSnapshot(page)).total).toBe(1);

        // Without a lorebook, the event is injected.
        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'Tell me about the dragon keep.');
        expect(await recallBlock(page)).toContain('Dragon Keep');

        // Add a lorebook entry saying the same thing, and it stops being worth the tokens.
        await addWorldInfoEntry(page, { key: 'dragon', content: lore });

        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'Remind me about the dragon keep again.');

        // World Info activates after generation interceptors run, so this only passes because the
        // block is re-selected on WORLD_INFO_ACTIVATED rather than left as the interceptor wrote it.
        expect(await recallBlock(page)).toBe('');
    });

    test('the injected block respects its token budget', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep in the north', keywords: ['dragon', 'keep'] },
            { summary: 'The party bought a long coil of rope in the river town', keywords: ['dragon', 'rope'] },
        ]);
        await extractNow(page);
        expect((await chronicleSnapshot(page)).total).toBe(2);

        const bulletCount = async () => (await recallBlock(page))
            .split('\n').filter(line => line.startsWith('- ')).length;

        // Generous budget: both events are worth injecting.
        await configureChronicle(page, { budget: 512, top_k: 5 });
        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'What do you remember about the dragon?');
        const generous = await bulletCount();
        expect(generous).toBe(2);

        // Tight budget: the block is trimmed rather than blowing past it. Asserting the relation
        // rather than an exact count keeps this independent of the active tokenizer.
        await configureChronicle(page, { budget: 8, top_k: 5 });
        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'What do you remember about the dragon?');
        expect(await bulletCount()).toBeLessThan(generous);
    });

    test('a delta on an event becomes inventory, and swiping the event away un-does it', async ({ page }) => {
        await configureState(page, true);
        mockServer.setResponder((body) => {
            if (isExtractionRequest(body)) {
                return JSON.stringify({
                    events: [{
                        summary: 'Paid the ferryman three silver coins for passage',
                        keywords: ['ferryman', 'coins'],
                        delta: { inv: [{ item: 'silver coin', dq: -3 }, { item: 'rope', dq: 1 }], vit: [], st: [] },
                    }],
                });
            }
            return `Understood, quite so. (${++replyCounter})`;
        });

        // The character has to have coins before spending them, or the delta is rejected as a
        // removal of something never held — which is itself the rule working.
        await page.evaluate(async () => {
            const chronicle = await import('./scripts/extensions/sanguine/chronicle.js');
            chronicle.recordUserEvent({
                summary: 'Started out with a purse of silver coins and no rope',
                keywords: ['silver', 'coins'],
                delta: { inv: [{ item: 'silver coin', dq: 9 }] },
            });
        });

        // The mention gate reads the narrative window, not the model's say-so, so the excerpt has
        // to actually contain the things being spent. Without this the deltas are rejected — which
        // is the rule working, but not what this test is checking.
        await sendMessage(page, 'I hand the ferryman three silver coins and coil the rope onto my pack.');

        await extractNow(page);

        const withDelta = await stateSnapshot(page);
        const coins = withDelta.inventory.find(i => i.name === 'silver coin');
        expect(coins.qty).toBe(6);
        expect(withDelta.inventory.some(i => i.name === 'rope')).toBe(true);

        // The audit trail: the quantity traces to the events that produced it.
        expect(coins.from.map(f => f.dq)).toEqual([9, -3]);

        // The block that would reach the model.
        expect(await stateBlock(page)).toContain('silver coin x6');

        // Swipe the turn away. The extracted event is no longer live, so the fold no longer
        // includes its delta — no separate bookkeeping, just fewer events in the fold.
        mockServer.reset();
        scriptExtraction(mockServer, []);
        await plainSwipeRight(page);

        const afterSwipe = await stateSnapshot(page);
        expect(afterSwipe.inventory.find(i => i.name === 'silver coin').qty).toBe(9);
        expect(afterSwipe.inventory.some(i => i.name === 'rope')).toBe(false);
    });

    test('a delta the narrative does not support never reaches the ledger', async ({ page }) => {
        await configureState(page, true);
        mockServer.setResponder((body) => {
            if (isExtractionRequest(body)) {
                return JSON.stringify({
                    events: [{
                        summary: 'The party walked on in silence',
                        keywords: ['walking'],
                        // Nothing in the excerpt mentions a dragon egg.
                        delta: { inv: [{ item: 'dragon egg', dq: 1 }], vit: [], st: [] },
                    }],
                });
            }
            return `Understood, quite so. (${++replyCounter})`;
        });

        await extractNow(page);

        const snapshot = await stateSnapshot(page);
        expect(snapshot.inventory.some(i => i.name === 'dragon egg')).toBe(false);
        // And the refusal is visible rather than silent.
        expect(snapshot.rejects.some(r => r.reason === 'not-mentioned' && r.count > 0)).toBe(true);
    });

    test('retrieval bumps the hit count, so useful events outlive unused ones', async ({ page }) => {
        scriptExtraction(mockServer, [
            { summary: 'The party travelled to the Dragon Keep', keywords: ['dragon', 'keep'] },
            { summary: 'The party bought rope in town', keywords: ['rope', 'town'] },
        ]);
        await extractNow(page);

        mockServer.reset();
        scriptExtraction(mockServer, []);
        await sendMessage(page, 'Tell me about the dragon again.');

        const snapshot = await chronicleSnapshot(page);
        const dragon = snapshot.events.find(e => e.summary.includes('Dragon Keep'));
        const rope = snapshot.events.find(e => e.summary.includes('rope'));
        expect(dragon.hits).toBeGreaterThan(0);
        expect(rope.hits).toBe(0);
    });
});
