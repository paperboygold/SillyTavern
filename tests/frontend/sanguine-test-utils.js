/**
 * Helpers for driving a real SillyTavern instance against a MockServer.
 *
 * The point of this harness is to make prompt-shaping features verifiable. Because the mock
 * records every request body it receives, a test can assert what actually reached the model
 * instead of inferring it from the reply — which is the only way to check a feature whose
 * whole job is to alter the prompt.
 */

/**
 * Point the running SillyTavern at a MockServer and open a chat with the built-in assistant.
 *
 * The assistant character is created on demand by SillyTavern itself, so this needs no
 * fixture files and leaves nothing behind but the isolated test data root.
 *
 * @param {import('@playwright/test').Page} page The page.
 * @param {object} options Options.
 * @param {number} options.mockPort Port the MockServer is listening on.
 * @param {boolean} [options.stream] Whether to use the streaming code path.
 * @returns {Promise<void>} Resolves once a chat is open and generation is possible.
 */
export async function useMockBackend(page, { mockPort, stream = false }) {
    await page.evaluate(async ({ mockPort, stream }) => {
        const { setOnlineStatus, eventSource, event_types } = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const { openPermanentAssistantChat } = await import('./scripts/welcome-screen.js');

        // Route through the OpenAI-compatible "custom" source, which is keyless.
        // A native change event reaches jQuery's handler, which binds with addEventListener.
        const mainApi = document.getElementById('main_api');
        mainApi.value = 'openai';
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));

        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = `http://127.0.0.1:${mockPort}/v1`;
        oai_settings.custom_model = 'mock-model';
        oai_settings.stream_openai = !!stream;
        // Keep prompts small and deterministic.
        oai_settings.openai_max_context = 4096;
        oai_settings.openai_max_tokens = 200;

        await openPermanentAssistantChat();

        // The #main_api change handler resets this to 'no_connection'; Generate() refuses to run
        // without a backend connection, so assert one now that the source is configured.
        setOnlineStatus('mock-model');

        // Settle any chat-load work before the test starts poking at `chat`.
        await new Promise(resolve => setTimeout(resolve, 100));
        void eventSource; void event_types;
    }, { mockPort, stream });
}

/**
 * Point the running SillyTavern at a real provider and open a chat with the built-in assistant.
 *
 * Requires the provider's key to already be in the instance's secret store — seed it with
 * `node tests/util/seed-secrets.mjs`. Used only by the opt-in live suite; everything else
 * runs against the MockServer so the default suite costs nothing and works offline.
 *
 * @param {import('@playwright/test').Page} page The page.
 * @param {object} options Options.
 * @param {string} options.source SillyTavern chat completion source, e.g. 'openai' | 'makersuite'.
 * @param {string} options.model Model id for that source.
 * @returns {Promise<void>} Resolves once a chat is open and generation is possible.
 */
export async function useLiveBackend(page, { source, model }) {
    await page.evaluate(async ({ source, model }) => {
        const { setOnlineStatus } = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const { openPermanentAssistantChat } = await import('./scripts/welcome-screen.js');

        const mainApi = document.getElementById('main_api');
        mainApi.value = 'openai';
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));

        oai_settings.chat_completion_source = source;
        oai_settings.openai_model = model;
        oai_settings.google_model = model;
        oai_settings.custom_model = model;
        oai_settings.openai_max_context = 8192;
        // Generous, because thinking models spend part of this budget before emitting any text.
        oai_settings.openai_max_tokens = 512;
        // Keeps thinking short so a short reply is not starved by reasoning tokens.
        oai_settings.reasoning_effort = 'min';
        oai_settings.stream_openai = false;

        await openPermanentAssistantChat();
        setOnlineStatus(model);
        await new Promise(resolve => setTimeout(resolve, 100));
    }, { source, model });
}

/**
 * The text of the last message's currently selected swipe.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<string>} The reply text.
 */
export async function lastMessageText(page) {
    return await page.evaluate(async () => {
        const { chat } = await import('./script.js');
        return String(chat[chat.length - 1]?.mes ?? '');
    });
}

/**
 * Turn the chronicle on (or off) and set its knobs for a test.
 * @param {import('@playwright/test').Page} page The page.
 * @param {object} [options] Chronicle settings to override.
 * @returns {Promise<void>} Resolves when applied.
 */
export async function configureChronicle(page, options = {}) {
    await page.evaluate(async (options) => {
        const { foldSettings } = await import('./scripts/extensions/sanguine/index.js');
        Object.assign(foldSettings().chronicle, { enabled: true, ...options });
    }, options);
}

/**
 * Turn state tracking on or off.
 * @param {import('@playwright/test').Page} page The page.
 * @param {boolean} [enabled] Whether to enable it.
 * @returns {Promise<void>} Resolves when applied.
 */
export async function configureState(page, enabled = true) {
    await page.evaluate(async (enabled) => {
        const { foldSettings } = await import('./scripts/extensions/sanguine/index.js');
        foldSettings().state.enabled = enabled;
    }, enabled);
}

/**
 * Snapshot the derived state.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<object>} The snapshot.
 */
export async function stateSnapshot(page) {
    return await page.evaluate(async () => {
        const state = await import('./scripts/extensions/sanguine/state.js');
        return state.snapshot();
    });
}

/**
 * The state block that would be injected into the prompt.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<string>} The rendered block.
 */
export async function stateBlock(page) {
    return await page.evaluate(async () => {
        const state = await import('./scripts/extensions/sanguine/state.js');
        return state.render();
    });
}

/**
 * Run one extraction cycle synchronously and return what it did.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<object>} The runExtraction result.
 */
export async function extractNow(page) {
    return await page.evaluate(async () => {
        const { runExtraction } = await import('./scripts/extensions/sanguine/extract.js');
        const { foldSettings } = await import('./scripts/extensions/sanguine/index.js');
        const settings = foldSettings().chronicle;
        return await runExtraction({
            windowSize: settings.window,
            responseLength: settings.response_length,
            profileId: settings.profile,
        });
    });
}

/**
 * Create a Connection Manager profile and point the chronicle's extraction at it.
 *
 * Registers the profile directly in extension settings rather than driving the Connection
 * Manager UI, so a test can pin extraction to a specific cheap model in one call.
 *
 * @param {import('@playwright/test').Page} page The page.
 * @param {object} profile Profile fields.
 * @param {string} profile.name Display name.
 * @param {string} profile.api Chat completion source, e.g. 'openai' | 'makersuite'. CONNECT_API_MAP
 *   is keyed by source name, so this single field decides both the API family and the source.
 * @param {string} profile.model Model id.
 * @returns {Promise<string>} The created profile id.
 */
export async function useExtractionProfile(page, { name, api, model }) {
    return await page.evaluate(async ({ name, api, model }) => {
        const { extension_settings } = await import('./scripts/extensions.js');
        const { foldSettings } = await import('./scripts/extensions/sanguine/index.js');

        extension_settings.connectionManager = extension_settings.connectionManager ?? { profiles: [], selectedProfile: null };
        extension_settings.disabledExtensions = (extension_settings.disabledExtensions ?? [])
            .filter(x => x !== 'connection-manager');

        const id = `fold-test-${name}`;
        const profile = { id, mode: 'cc', name, api, 'api-url': '', model };

        extension_settings.connectionManager.profiles = extension_settings.connectionManager.profiles
            .filter(p => p.id !== id)
            .concat(profile);

        foldSettings().chronicle.profile = id;
        return id;
    }, { name, api, model });
}

/**
 * Create a World Info entry that activates on the given keyword, in a lorebook bound to this chat.
 * @param {import('@playwright/test').Page} page The page.
 * @param {object} entry The entry.
 * @param {string} entry.key Keyword that triggers it.
 * @param {string} entry.content Entry text.
 * @returns {Promise<void>} Resolves once the lorebook is saved and bound.
 */
export async function addWorldInfoEntry(page, { key, content }) {
    await page.evaluate(async ({ key, content }) => {
        const { createNewWorldInfo, loadWorldInfo, saveWorldInfo, setWorldInfoButtonClass } = await import('./scripts/world-info.js');
        const { chat_metadata, saveMetadata } = await import('./script.js');

        const name = 'fold-test-lore';
        await createNewWorldInfo(name, { interactive: false });
        const data = await loadWorldInfo(name);

        const uid = 0;
        data.entries[uid] = {
            uid,
            key: [key],
            keysecondary: [],
            comment: 'fold test',
            content,
            constant: false,
            selective: true,
            order: 100,
            position: 0,
            disable: false,
            addMemo: true,
            excludeRecursion: false,
            probability: 100,
            useProbability: true,
        };
        await saveWorldInfo(name, data, true);

        // Bind it to this chat so it participates in the scan without touching global settings.
        chat_metadata.world_info = name;
        setWorldInfoButtonClass(undefined, true);
        await saveMetadata();
        await new Promise(resolve => setTimeout(resolve, 200));
    }, { key, content });
}

/**
 * The recall block currently registered as an extension prompt.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<string>} The block text, or ''.
 */
export async function recallBlock(page) {
    return await page.evaluate(async () => {
        const { extension_prompts } = await import('./script.js');
        return String(extension_prompts?.['5_fold_recall']?.value ?? '');
    });
}

/**
 * Snapshot the chronicle ledger.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<{total: number, live: number, events: object[]}>} The snapshot.
 */
export async function chronicleSnapshot(page) {
    return await page.evaluate(async () => {
        const chronicle = await import('./scripts/extensions/sanguine/chronicle.js');
        return chronicle.snapshot();
    });
}

/**
 * Query the chronicle as the injection path would.
 * @param {import('@playwright/test').Page} page The page.
 * @param {string} queryText Query text.
 * @param {number} [topK] Maximum results.
 * @returns {Promise<string[]>} Summaries of the matching events, best first.
 */
export async function chronicleQuery(page, queryText, topK = 5) {
    return await page.evaluate(async ({ queryText, topK }) => {
        const chronicle = await import('./scripts/extensions/sanguine/chronicle.js');
        return chronicle.query(queryText, topK).map(r => r.event.s);
    }, { queryText, topK });
}

/**
 * Wait until SillyTavern is not generating and not mid-swipe.
 *
 * Steering and swiping both refuse to run while a generation is in flight, and they refuse
 * quietly — you get one fewer swipe rather than an error. Waiting for idle first turns those
 * races into deterministic behaviour.
 *
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<void>} Resolves once idle.
 */
export async function waitForIdle(page) {
    await page.evaluate(async () => {
        const { isSwipingAllowed } = await import('./script.js');
        for (let i = 0; i < 200; i++) {
            if (isSwipingAllowed()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for SillyTavern to become idle.');
    });
}

/**
 * Send a user message and wait for the assistant reply to be committed.
 * @param {import('@playwright/test').Page} page The page.
 * @param {string} text The user message.
 * @returns {Promise<void>} Resolves when the reply has been received.
 */
export async function sendMessage(page, text) {
    await page.evaluate(async (text) => {
        const { eventSource, event_types } = await import('./script.js');
        const { getContext } = await import('./scripts/extensions.js');

        const received = new Promise(resolve => eventSource.once(event_types.MESSAGE_RECEIVED, resolve));
        await getContext().executeSlashCommandsWithOptions(`/send ${text} | /trigger`);
        await received;
        await new Promise(resolve => setTimeout(resolve, 150));
    }, text);
}

/**
 * Run a steering request and wait for the resulting swipe to be committed.
 * @param {import('@playwright/test').Page} page The page.
 * @param {string} instruction The steering instruction.
 * @returns {Promise<boolean>} Whether steering reported that it started a generation.
 */
export async function steerLastMessage(page, instruction) {
    await waitForIdle(page);
    return await page.evaluate(async (instruction) => {
        const { chat, eventSource, event_types } = await import('./script.js');
        const { requestSteer } = await import('./scripts/extensions/sanguine/steer.js');

        const received = new Promise(resolve => eventSource.once(event_types.MESSAGE_RECEIVED, resolve));
        const started = await requestSteer(chat.length - 1, instruction, { source: 'ui' });
        if (!started) {
            // Refusing silently would show up much later as "one fewer swipe than expected".
            throw new Error(`requestSteer refused to run for instruction: ${instruction}`);
        }
        await received;
        await new Promise(resolve => setTimeout(resolve, 200));
        return started;
    }, instruction);
}

/**
 * Perform a plain forward swipe (no instruction) and wait for the new swipe.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<void>} Resolves when the new swipe has been received.
 */
export async function plainSwipeRight(page) {
    await waitForIdle(page);
    await page.evaluate(async () => {
        const { chat, swipe, eventSource, event_types } = await import('./script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('./scripts/constants.js');

        const received = new Promise(resolve => eventSource.once(event_types.MESSAGE_RECEIVED, resolve));
        await swipe(null, SWIPE_DIRECTION.RIGHT, {
            source: SWIPE_SOURCE.SLASH_COMMAND,
            message: chat[chat.length - 1],
        });
        await received;
        await new Promise(resolve => setTimeout(resolve, 200));
    });
}

/**
 * Navigate to a specific swipe index without generating.
 * @param {import('@playwright/test').Page} page The page.
 * @param {number} swipeId Target swipe index.
 * @returns {Promise<void>} Resolves when navigation is complete.
 */
export async function goToSwipe(page, swipeId) {
    await waitForIdle(page);
    await page.evaluate(async (swipeId) => {
        const { chat, swipe } = await import('./script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('./scripts/constants.js');

        const message = chat[chat.length - 1];
        const direction = swipeId < (message.swipe_id ?? 0) ? SWIPE_DIRECTION.LEFT : SWIPE_DIRECTION.RIGHT;
        await swipe(null, direction, {
            source: SWIPE_SOURCE.SWIPE_PICKER,
            message,
            forceSwipeId: swipeId,
        });
        await new Promise(resolve => setTimeout(resolve, 150));
    }, swipeId);
}

/**
 * Snapshot the last message's swipe state, including each swipe's steering record.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<{swipeId: number, swipeCount: number, swipes: string[], steers: (string|null)[]}>} The snapshot.
 */
export async function lastMessageSwipeState(page) {
    return await page.evaluate(async () => {
        const { chat } = await import('./script.js');
        const message = chat[chat.length - 1];
        return {
            swipeId: message.swipe_id ?? 0,
            swipeCount: Array.isArray(message.swipes) ? message.swipes.length : 0,
            swipes: (message.swipes ?? []).map(String),
            steers: (message.swipe_info ?? []).map(info => info?.extra?.fold_steer?.text ?? null),
        };
    });
}

/**
 * Reopen the assistant's existing chat after a page reload, waiting for the character list and
 * the chat load to settle. Does NOT start a new chat, so the reloaded chat is the same one.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<void>} Resolves once a chat is open.
 */
export async function reopenAssistantChat(page) {
    await page.evaluate(async () => {
        const { getCurrentChatId, getCharacters } = await import('./script.js');
        const { openPermanentAssistantChat } = await import('./scripts/welcome-screen.js');

        // A bare page load leaves `characters` empty until something asks for it, and
        // openPermanentAssistantChat silently gives up when it cannot find the assistant.
        await getCharacters();
        await openPermanentAssistantChat({ tryCreate: false, created: true });

        for (let i = 0; i < 100 && !getCurrentChatId(); i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    });
}

/**
 * The id of the currently open chat, for reload assertions.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<string>} The chat id.
 */
export async function currentChatId(page) {
    return await page.evaluate(async () => {
        const { getCurrentChatId } = await import('./script.js');
        return String(getCurrentChatId());
    });
}

/**
 * Force a chat save and wait for it to land on disk.
 * @param {import('@playwright/test').Page} page The page.
 * @returns {Promise<void>} Resolves once saved.
 */
export async function saveChatNow(page) {
    await page.evaluate(async () => {
        const { saveChatConditional } = await import('./script.js');
        await saveChatConditional();
    });
}
