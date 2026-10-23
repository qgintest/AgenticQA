# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: storefront\navigation.spec.ts >> Storefront navigation >> side menu navigates to the store listing
- Location: tests\storefront\navigation.spec.ts:22:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('products-list').getByTestId('product-wrapper').first()
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByTestId('products-list').getByTestId('product-wrapper').first() with timeout 15000ms
  - waiting for getByTestId('products-list').getByTestId('product-wrapper').first()

```

```yaml
- main:
  - navigation:
    - button "Menu"
    - link "Medusa Store":
      - /url: /dk
    - button "Search products":
      - img
    - link "Account":
      - /url: /dk/account
    - button "Cart (0)":
      - link "Cart (0)":
        - /url: /dk/cart
  - heading "All products" [level=1]
  - paragraph: Sort by
  - img
  - text: "Relevance Latest Arrivals Price: Low -> High Price: High -> Low Title: A -> Z Title: Z -> A"
  - img
  - searchbox "Search products"
  - list:
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
    - listitem
  - link "Medusa Store":
    - /url: /dk
  - text: Categories
  - list:
    - listitem:
      - link "Shirts":
        - /url: /dk/categories/shirts
      - list
    - listitem:
      - link "Sweatshirts":
        - /url: /dk/categories/sweatshirts
      - list
    - listitem:
      - link "Pants":
        - /url: /dk/categories/pants
      - list
    - listitem:
      - link "Merch":
        - /url: /dk/categories/merch
      - list
  - text: Collections
  - list:
    - listitem:
      - link "Summer Essentials":
        - /url: /dk/collections/summer-essentials
    - listitem:
      - link "Winter Layers":
        - /url: /dk/collections/winter-layers
    - listitem:
      - link "Everyday Basics":
        - /url: /dk/collections/everyday-basics
    - listitem:
      - link "Limited Run":
        - /url: /dk/collections/limited-run
  - text: Medusa
  - list:
    - listitem:
      - link "GitHub":
        - /url: https://github.com/medusajs
    - listitem:
      - link "Documentation":
        - /url: https://docs.medusajs.com
    - listitem:
      - link "Source code":
        - /url: https://github.com/medusajs/dtc-starter
  - paragraph: © 2026 Medusa Store. All rights reserved.
  - paragraph:
    - text: Powered by
    - link:
      - /url: https://www.medusajs.com
      - img
    - text: "&"
    - link:
      - /url: https://nextjs.org
      - img
- alert: Store
```

# Test source

```ts
  1  | import { test, expect } from '../../src/fixtures';
  2  | import { env } from '../../src/config/env';
  3  | 
  4  | /**
  5  |  * Client-side navigation fetches the target route's RSC payload; under `next dev` and parallel
  6  |  * workers that alone took 5-15s in local runs. Budget for it so only real breakage fails.
  7  |  */
  8  | const CLIENT_NAV = { timeout: 45_000 };
  9  | 
  10 | test.describe('Storefront navigation', { tag: ['@ui', '@smoke'] }, () => {
  11 |   test('root URL redirects to the configured country and renders the shell', async ({ page, nav }) => {
  12 |     const response = await page.goto('/');
  13 | 
  14 |     expect(response?.status()).toBe(200);
  15 |     await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/?$`));
  16 |     await expect(nav.brandLink).toHaveText(/Medusa Store/i);
  17 |     await expect(nav.accountLink).toBeVisible();
  18 |     // A brand-new browser context has no cart.
  19 |     await nav.expectCartCount(0);
  20 |   });
  21 | 
  22 |   test('side menu navigates to the store listing', async ({ page, nav, storePage }) => {
  23 |     await page.goto(`/${env.countryCode}`);
  24 | 
  25 |     await nav.openFromMenu('Store');
  26 | 
  27 |     await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/store`), CLIENT_NAV);
  28 |     await expect(storePage.heading).toHaveText('All products');
> 29 |     await expect(storePage.productCards.first()).toBeVisible();
     |                                                  ^ Error: expect(locator).toBeVisible() failed
  30 |   });
  31 | 
  32 |   test('cart link opens an empty cart for a new visitor', async ({ page, nav, cartPage }) => {
  33 |     await page.goto(`/${env.countryCode}/store`);
  34 | 
  35 |     await nav.cartLink.click();
  36 | 
  37 |     await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/cart`), CLIENT_NAV);
  38 |     await expect(cartPage.emptyMessage).toBeVisible();
  39 |     await expect(cartPage.rows).toHaveCount(0);
  40 |   });
  41 | 
  42 |   test('account link leads to the sign-in page for an anonymous visitor', async ({ page, nav }) => {
  43 |     await page.goto(`/${env.countryCode}`);
  44 | 
  45 |     await nav.accountLink.click();
  46 | 
  47 |     await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/account`), CLIENT_NAV);
  48 |     await expect(page.getByTestId('login-page')).toBeVisible();
  49 |   });
  50 | 
  51 |   test('unknown product handle returns the 404 page', async ({ page }) => {
  52 |     const response = await page.goto(`/${env.countryCode}/products/aqa-does-not-exist-${Date.now()}`);
  53 | 
  54 |     expect(response?.status()).toBe(404);
  55 |     await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  56 |   });
  57 | });
  58 | 
```