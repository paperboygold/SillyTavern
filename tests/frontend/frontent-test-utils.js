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
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');

        const userSelect = page.locator('#userList .userSelect');
        try {
            await userSelect.first().waitFor({ state: 'visible', timeout: 3000 });
            await userSelect.last().click();
            await page.waitForURL(url => !url.pathname.startsWith('/login'));
        } catch {
            // No user picker on this install — already in the app.
        }

        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },
};
