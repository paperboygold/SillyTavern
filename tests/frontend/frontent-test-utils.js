export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     *
     * Handles both shapes of a first page load: an install with a user picker (click through it)
     * and a single passwordless install, which drops straight into the app with no picker at all.
     *
     * The picker is detected by asking whether this IS the login page, rather than by waiting to
     * see whether one appears — a timeout that expires is indistinguishable from a slow render, and
     * it charged every no-picker run three seconds to learn nothing.
     *
     * The wait is on the PATHNAME only. Upstream compares the whole URL against a base read from
     * `ST_BASE_URL`/`PLAYWRIGHT_BASE_URL` and otherwise assumed port 8000; `playwright.config.js`
     * deliberately serves on 8100 so a test run can never reconfigure the developer's own instance,
     * so that comparison could never become true here and the wait would hang until the suite died.
     * Leaving `/login` is the actual condition, and it does not depend on the port.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        if (await testSetup.isLoginPage({ page })) {
            // eslint-disable-next-line playwright/no-networkidle
            await page.waitForLoadState('networkidle');
            // Try accounts from last to first: clicking a password-protected account stays on the login page
            const userSelects = page.locator('#userList .userSelect');
            const userCount = await userSelects.count();
            for (let i = userCount - 1; i >= 0; i--) {
                await userSelects.nth(i).click();
                const loggedIn = await page
                    .waitForURL(url => url.toString().startsWith(baseURL) && url.pathname !== '/login', { timeout: 3000 })
                    .then(() => true, () => false);
                if (loggedIn) {
                    break;
                }
            }
            if (await testSetup.isLoginPage({ page })) {
                throw new Error('Could not log into any account without a password.');
            }
            await page.waitForURL(url => !url.pathname.startsWith('/login'));
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },

    /**
     * Checks if the current page is the login page by looking for a body element with the class 'login'.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    isLoginPage: async ({ page }) => {
        return await page.locator('body.login').count() > 0;
    },
};
