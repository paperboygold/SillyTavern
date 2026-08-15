import { defineConfig } from '@playwright/test';

// Deliberately NOT 8000. Tests mutate API settings — source, context size, max tokens — and an
// earlier version of this config reused whatever server was already listening on the default
// port. That meant a test run silently reconfigured the developer's own SillyTavern, resetting a
// 1M-context DeepSeek setup to a 4k mock. Never share a port with the instance a human is using.
const ST_PORT = Number(process.env.ST_TEST_PORT ?? 8100);
const ST_URL = `http://127.0.0.1:${ST_PORT}`;

// Upstream's override (staging), kept. Naming a base URL means "I have a server already, use it",
// so it also turns off the spawn below — booting an isolated instance and then pointing the tests
// somewhere else would start a server nothing talks to.
const override = process.env.ST_BASE_URL || process.env.PLAYWRIGHT_BASE_URL || '';
const baseURL = override || ST_URL;

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
        // Defaults to Playwright's bundled Chromium. Set PW_CHANNEL to borrow a browser that is
        // already on the machine instead of downloading one, e.g. PW_CHANNEL=chrome.
        ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    },
    workers: 4,
    fullyParallel: true,
    // Boot a SillyTavern instance against an isolated data root so a test run can never
    // touch real user data. If one is already listening on the port (the usual local
    // `npm start`), that one is reused instead and nothing new is spawned.
    ...(override ? {} : {
        webServer: {
            command: `node server.js --port ${ST_PORT} --listen false --browserLaunchEnabled false --dataRoot ./tests/.st-data`,
            cwd: '..',
            url: ST_URL,
            // Never adopt a server this config did not start. Reusing one cannot verify whose data
            // root it has, and the tests write settings.
            reuseExistingServer: false,
            timeout: 120_000,
            stdout: 'pipe',
            stderr: 'pipe',
        },
    }),
});
