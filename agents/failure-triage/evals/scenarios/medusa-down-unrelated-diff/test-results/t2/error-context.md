# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: storefront\navigation.spec.ts >> Storefront navigation >> unknown product handle returns the 404 page
- Location: tests\storefront\navigation.spec.ts:51:7

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 404
Received: 500
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [active]:
    - generic [ref=e4]:
      - generic [ref=e5]:
        - navigation [ref=e7]:
          - button [disabled] [ref=e8]:
            - img "previous" [ref=e9]
          - generic [ref=e11]:
            - generic [ref=e12]: 1/
            - text: "1"
          - button [disabled] [ref=e13]:
            - img "next" [ref=e14]
        - link "Next.js 15.5.24 (outdated) Turbopack" [ref=e17] [cursor=pointer]:
          - /url: https://nextjs.org/docs/messages/version-staleness
          - generic "An outdated version detected (latest is 16.4.2), upgrade is highly recommended!" [ref=e20]: Next.js 15.5.24 (outdated)
          - generic [ref=e21]: Turbopack
      - dialog "Runtime TypeError" [ref=e23]:
        - generic [ref=e26]:
          - generic [ref=e27]:
            - generic [ref=e28]:
              - generic [ref=e29]:
                - generic [ref=e30]: Runtime TypeError
                - generic [ref=e31]: Server
              - generic [ref=e32]:
                - button "Copy Error Info" [ref=e33] [cursor=pointer]
                - button "No related documentation found" [disabled] [ref=e36]
                - link "Learn more about enabling Node.js inspector for server code with Chrome DevTools" [ref=e39] [cursor=pointer]:
                  - /url: https://nextjs.org/docs/app/building-your-application/configuring/debugging#server-side-code
            - paragraph [ref=e49]: fetch failed
          - generic [ref=e52]:
            - paragraph [ref=e53]:
              - text: Call Stack
              - generic [ref=e54]: "5"
            - button "Show 5 ignore-listed frame(s)" [ref=e55] [cursor=pointer]
        - generic [ref=e58]:
          - generic [ref=e59]: "1"
          - generic [ref=e60]: "2"
    - generic [ref=e65] [cursor=pointer]:
      - button "Open Next.js Dev Tools" [ref=e66]
      - generic [ref=e70]:
        - button "Open issues overlay" [ref=e71]:
          - generic [ref=e72]:
            - generic [aria-hidden] [ref=e73]: "0"
            - generic [ref=e74]: "1"
          - generic [ref=e75]: Issue
        - button "Collapse issues badge" [ref=e76]
  - generic [ref=e80]:
    - 'heading "Application error: a server-side exception has occurred while loading localhost (see the server logs for more information)." [level=2] [ref=e81]'
    - paragraph [ref=e82]: "Digest: 744148363"
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
  29 |     await expect(storePage.productCards.first()).toBeVisible();
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
> 54 |     expect(response?.status()).toBe(404);
     |                                ^ Error: expect(received).toBe(expected) // Object.is equality
  55 |     await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  56 |   });
  57 | });
  58 | 
```