import { test, expect } from '../../src/fixtures';
import { env } from '../../src/config/env';
import { testAddress, testEmail } from '../../src/data/factories';

/**
 * DELIBERATELY FAILING scenarios — inputs for the future triage / self-healing agent.
 *
 * Only loaded by the `deliberate-failure` project, which exists only when
 * AQA_DELIBERATE_FAILURE=assertion|locator (see playwright.config.ts). The regression project
 * ignores this folder, so the normal suite is never affected.
 *
 *  - assertion: a *product-behaviour* mismatch. The storefront confirmation says the order was
 *    "paid", but checkout only authorizes the payment. The test asserts it was captured → fails
 *    with a clear expected/actual diff on backend state. Triage should classify: product/spec issue.
 *  - locator: a *test-maintenance* failure. Uses a stale test id (`add-to-bag-button`, as if the
 *    UI had renamed `add-product-button`). Fails with a locator timeout. Triage should classify:
 *    broken locator → candidate for self-healing.
 */
test.describe('Deliberate failure', { tag: '@deliberate-failure' }, () => {
  test('[assertion] payment is captured when the order is placed', async ({ adminApi, storeApi, testData, testProduct }) => {
    test.skip(env.deliberateFailure !== 'assertion', 'enable with AQA_DELIBERATE_FAILURE=assertion');

    const email = testEmail('deliberate');
    testData.trackCustomerEmail(email);
    const region = await storeApi.regionForCountry(env.countryCode);
    const cart = await storeApi.createCart(region.id);
    await storeApi.addLineItem(cart.id, testProduct.variants[0]!.id, 1);
    await storeApi.setContact(cart.id, email, testAddress(env.countryCode));
    const [option] = await storeApi.shippingOptions(cart.id);
    await storeApi.addShippingMethod(cart.id, option!.id);
    await storeApi.initPayment(cart.id, 'pp_system_default');
    const result = await storeApi.completeCart(cart.id);
    if (result.type !== 'order') throw new Error(`cart did not complete: ${JSON.stringify(result)}`);
    testData.trackOrder(result.order.id);

    const order = await adminApi.getOrder(result.order.id);
    expect(order.payment_status, 'confirmation page reports the order as paid').toBe('captured');
  });

  test('[locator] add a product to the cart', async ({ page, productPage, nav, testProduct }) => {
    test.skip(env.deliberateFailure !== 'locator', 'enable with AQA_DELIBERATE_FAILURE=locator');

    await productPage.goto(testProduct.handle);
    await productPage.selectOption('S');
    // Stale selector: the real test id is `add-product-button`.
    await page.getByTestId('add-to-bag-button').click({ timeout: 10_000 });
    await nav.expectCartCount(1);
  });
});
