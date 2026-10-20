import { test, expect } from '../../src/fixtures';
import { env } from '../../src/config/env';

/**
 * Client-side navigation fetches the target route's RSC payload; under `next dev` and parallel
 * workers that alone took 5-15s in local runs. Budget for it so only real breakage fails.
 */
const CLIENT_NAV = { timeout: 45_000 };

test.describe('Storefront navigation', { tag: ['@ui', '@smoke'] }, () => {
  test('root URL redirects to the configured country and renders the shell', async ({ page, nav }) => {
    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/?$`));
    await expect(nav.brandLink).toHaveText(/Medusa Store/i);
    await expect(nav.accountLink).toBeVisible();
    // A brand-new browser context has no cart.
    await nav.expectCartCount(0);
  });

  test('side menu navigates to the store listing', async ({ page, nav, storePage }) => {
    await page.goto(`/${env.countryCode}`);

    await nav.openFromMenu('Store');

    await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/store`), CLIENT_NAV);
    await expect(storePage.heading).toHaveText('All products');
    await expect(storePage.productCards.first()).toBeVisible();
  });

  test('cart link opens an empty cart for a new visitor', async ({ page, nav, cartPage }) => {
    await page.goto(`/${env.countryCode}/store`);

    await nav.cartLink.click();

    await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/cart`), CLIENT_NAV);
    await expect(cartPage.emptyMessage).toBeVisible();
    await expect(cartPage.rows).toHaveCount(0);
  });

  test('account link leads to the sign-in page for an anonymous visitor', async ({ page, nav }) => {
    await page.goto(`/${env.countryCode}`);

    await nav.accountLink.click();

    await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/account`), CLIENT_NAV);
    await expect(page.getByTestId('login-page')).toBeVisible();
  });

  test('unknown product handle returns the 404 page', async ({ page }) => {
    const response = await page.goto(`/${env.countryCode}/products/aqa-does-not-exist-${Date.now()}`);

    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
