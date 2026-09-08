#!/usr/bin/env node
/**
 * st-driver — drive a live SillyTavern from the command line.
 *
 * Opens a browser against a running SillyTavern, optionally wires it to a MockServer, then
 * evaluates whatever JavaScript you hand it inside the page and prints the result as JSON.
 * It is the ad-hoc counterpart to the Playwright suite: same setup, no test file.
 *
 * Usage:
 *   node tests/util/st-driver.mjs --eval "return (await import('./script.js')).chat.length"
 *   node tests/util/st-driver.mjs --file ./probe.js --headed --keep-open
 *
 * Options:
 *   --eval <js>     Body of an async function evaluated in the page. Use `return` to produce output.
 *   --file <path>   Read the function body from a file instead.
 *   --url <url>     SillyTavern base URL (default: the test instance on $ST_TEST_PORT, else 8100).
 *   --mock-port <n> Start a MockServer on this port and point SillyTavern at it (default 3399).
 *   --mock-reply <s> Make the mock always reply with this exact text instead of echoing.
 *   --no-mock       Do not start a MockServer or touch the API settings.
 *   --stream        Configure the mock backend for streaming responses.
 *   --headed        Show the browser.
 *   --keep-open     Leave the browser open until Enter is pressed.
 *   --channel <c>   Browser channel, e.g. chrome. Defaults to $PW_CHANNEL, else bundled Chromium.
 *   --force-url     Allow driving a non-test instance, accepting that its settings get overwritten.
 *
 * The page context has `ST` preloaded as the main script module, so short probes can use
 * `ST.chat`, `ST.getCurrentChatId()` and so on without importing anything.
 */

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import process from 'node:process';
import readline from 'node:readline';

import { MockServer } from './mock-server.js';

function parseArgs(argv) {
    // Defaults to the TEST port, never 8000. This driver rewrites API settings — completion
    // source, context size, max tokens — and pointing it at the instance a human is using
    // silently reconfigures their setup. Targeting anything else must be explicit.
    const args = { url: `http://127.0.0.1:${process.env.ST_TEST_PORT ?? 8100}`, mockPort: 3399 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--eval': args.eval = next(); break;
            case '--file': args.file = next(); break;
            case '--url': args.url = next(); break;
            case '--mock-port': args.mockPort = Number(next()); break;
            case '--mock-reply': args.mockReply = next(); break;
            case '--no-mock': args.noMock = true; break;
            case '--stream': args.stream = true; break;
            case '--headed': args.headed = true; break;
            case '--keep-open': args.keepOpen = true; break;
            case '--channel': args.channel = next(); break;
            case '--force-url': args.forceUrl = true; break;
            default: throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return args;
}

async function openApp(page, url) {
    await page.goto(url);
    const userSelect = page.locator('#userList .userSelect');
    try {
        await userSelect.first().waitFor({ state: 'visible', timeout: 3000 });
        await userSelect.last().click();
    } catch {
        // No user picker — already in the app.
    }
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120_000 });
}

/**
 * Refuse to reconfigure an instance this driver was not pointed at deliberately.
 *
 * A guard rather than a convenience: the mock wiring below overwrites the completion source and
 * token limits, and those changes are persisted by SillyTavern's own autosave.
 *
 * @param {string} url Target URL.
 * @param {boolean} forced Whether --force-url was given.
 */
function assertSafeTarget(url, forced) {
    const port = Number(new URL(url).port || 80);
    const testPort = Number(process.env.ST_TEST_PORT ?? 8100);
    if (port !== testPort && !forced) {
        console.error(
            `Refusing to drive ${url}: it is not the test instance (port ${testPort}).\n` +
            'This driver rewrites API settings and SillyTavern persists them. Start a disposable\n' +
            'instance instead:\n\n' +
            `  node server.js --port ${testPort} --listen false --dataRoot ./tests/.st-data\n\n` +
            'Pass --force-url only if you accept that the target\'s settings will be overwritten.');
        process.exit(2);
    }
}

async function wireMockBackend(page, { mockPort, stream }) {
    await page.evaluate(async ({ mockPort, stream }) => {
        const { setOnlineStatus } = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const { openPermanentAssistantChat } = await import('./scripts/welcome-screen.js');

        const mainApi = document.getElementById('main_api');
        mainApi.value = 'openai';
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));

        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = `http://127.0.0.1:${mockPort}/v1`;
        oai_settings.custom_model = 'mock-model';
        oai_settings.stream_openai = !!stream;
        oai_settings.openai_max_context = 4096;
        oai_settings.openai_max_tokens = 200;

        await openPermanentAssistantChat();
        setOnlineStatus('mock-model');
        await new Promise(resolve => setTimeout(resolve, 100));
    }, { mockPort, stream });
}

const args = parseArgs(process.argv.slice(2));
const body = args.file ? fs.readFileSync(args.file, 'utf8') : args.eval;

if (!body && !args.keepOpen) {
    console.error('Nothing to do: pass --eval, --file, or --keep-open. See the header for usage.');
    process.exit(2);
}

assertSafeTarget(args.url, !!args.forceUrl);

const mockServer = args.noMock ? null : new MockServer({ port: args.mockPort, host: '127.0.0.1' });
if (mockServer && args.mockReply !== undefined) {
    mockServer.setResponder(() => args.mockReply);
}
await mockServer?.start();

const channel = args.channel ?? process.env.PW_CHANNEL;
const browser = await chromium.launch({ headless: !args.headed, ...(channel ? { channel } : {}) });
const page = await browser.newPage();

const consoleLines = [];
page.on('console', msg => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
page.on('pageerror', err => consoleLines.push(`[pageerror] ${err.message}`));

try {
    await openApp(page, args.url);
    if (mockServer) {
        await wireMockBackend(page, { mockPort: args.mockPort, stream: args.stream });
    }

    if (body) {
        const result = await page.evaluate(async (src) => {
            const ST = await import('./script.js');
            // Also park it on window so a --keep-open session can poke at ST from devtools.
            window.ST = ST;
            const fn = new Function('ST', `return (async () => { ${src} })()`);
            return await fn(ST);
        }, body);
        console.log(JSON.stringify({ result, mockRequests: mockServer?.requests.length ?? 0 }, null, 2));
    }

    if (mockServer?.requests.length) {
        console.log('\n--- last prompt seen by the mock ---\n' + mockServer.lastPromptText());
    }

    if (consoleLines.length) {
        console.log('\n--- page console ---\n' + consoleLines.join('\n'));
    }

    if (args.keepOpen) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await new Promise(resolve => rl.question('Press Enter to close the browser… ', () => { rl.close(); resolve(undefined); }));
    }
} catch (error) {
    console.error('st-driver failed:', error?.message ?? error);
    if (consoleLines.length) {
        console.error('\n--- page console ---\n' + consoleLines.join('\n'));
    }
    process.exitCode = 1;
} finally {
    await browser.close();
    await mockServer?.stop();
}
