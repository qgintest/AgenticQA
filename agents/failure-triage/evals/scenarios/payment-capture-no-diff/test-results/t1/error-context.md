# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: diagnostics\deliberate-failure.spec.ts >> Deliberate failure >> payment is captured when the order is placed
- Location: tests\diagnostics\deliberate-failure.spec.ts:23:7

# Error details

```
Error: confirmation page reports the order as paid

expect(received).toBe(expected) // Object.is equality

Expected: "captured"
Received: "authorized"
```

# Test source

```ts
  1  | import { test, expect } from '../../src/fixtures';
  2  | import { env } from '../../src/config/env';
  3  | import { testAddress, testEmail } from '../../src/data/factories';
  4  | 
  5  | /**
  6  |  * DELIBERATELY FAILING scenarios — inputs for the future triage / self-healing agent.
  7  |  *
  8  |  * Only loaded by the `deliberate-failure` project, which exists only when
  9  |  * AQA_DELIBERATE_FAILURE=assertion|locator (see playwright.config.ts). The regression project
  10 |  * ignores this folder, so the normal suite is never affected.
  11 |  *
  12 |  *  - assertion: a *product-behaviour* mismatch. The storefront confirmation says the order was
  13 |  *    "paid", but checkout only authorizes the payment. The test asserts it was captured → fails
  14 |  *    with a clear expected/actual diff on backend state. Triage should classify: product/spec issue.
  15 |  *  - locator: a *test-maintenance* failure. Uses a stale test id (`add-to-bag-button`, as if the
  16 |  *    UI had renamed `add-product-button`). Fails with a locator timeout. Triage should classify:
  17 |  *    broken locator → candidate for self-healing.
  18 |  *
  19 |  * Keep hints out of what the triage agent can see: test titles, and the lines Playwright quotes
  20 |  * around the failing statement in its error message (no comments near the failing lines).
  21 |  */
  22 | test.describe('Deliberate failure', { tag: '@deliberate-failure' }, () => {
  23 |   test('payment is captured when the order is placed', async ({ adminApi, storeApi, testData, testProduct }) => {
  24 |     test.skip(env.deliberateFailure !== 'assertion', 'enable with AQA_DELIBERATE_FAILURE=assertion');
  25 | 
  26 |     const email = testEmail('deliberate');
  27 |     testData.trackCustomerEmail(email);
  28 |     const region = await storeApi.regionForCountry(env.countryCode);
  29 |     const cart = await storeApi.createCart(region.id);
  30 |     await storeApi.addLineItem(cart.id, testProduct.variants[0]!.id, 1);
  31 |     await storeApi.setContact(cart.id, email, testAddress(env.countryCode));
  32 |     const [option] = await storeApi.shippingOptions(cart.id);
  33 |     await storeApi.addShippingMethod(cart.id, option!.id);
  34 |     await storeApi.initPayment(cart.id, 'pp_system_default');
  35 |     const result = await storeApi.completeCart(cart.id);
  36 |     if (result.type !== 'order') throw new Error(`cart did not complete: ${JSON.stringify(result)}`);
  37 |     testData.trackOrder(result.order.id);
  38 | 
  39 |     const order = await adminApi.getOrder(result.order.id);
> 40 |     expect(order.payment_status, 'confirmation page reports the order as paid').toBe('captured');
     |                                                                                 ^ Error: confirmation page reports the order as paid
  41 |   });
  42 | 
  43 |   test('shopper adds a product to the cart', async ({ page, productPage, nav, testProduct }) => {
  44 |     test.skip(env.deliberateFailure !== 'locator', 'enable with AQA_DELIBERATE_FAILURE=locator');
  45 | 
  46 |     await productPage.goto(testProduct.handle);
  47 |     await productPage.selectOption('S');
  48 |     await page.getByTestId('add-to-bag-button').click({ timeout: 10_000 });
  49 |     await nav.expectCartCount(1);
  50 |   });
  51 | });
  52 | 
```