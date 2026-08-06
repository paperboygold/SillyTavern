import { defineConfig } from '@playwright/test';

const ST_PORT = Number(process.env.ST_TEST_PORT ?? 8000);
const ST_URL = `http://127.0.0.1:${ST_PORT}`;

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL: ST_URL,
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
    webServer: {
        command: `node server.js --port ${ST_PORT} --listen false --browserLaunchEnabled false --dataRoot ./tests/.st-data`,
        cwd: '..',
        url: ST_URL,
        reuseExistingServer: true,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
