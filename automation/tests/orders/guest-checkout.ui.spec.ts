import { test, expect } from '../../src/fixtures';
import { env } from '../../src/config/env';
import { testAddress, testEmail } from '../../src/data/factories';

const SHIPPING_OPTION = 'Standard Shipping';
const PAYMENT_PROVIDER_TITLE = 'Manual Payment';

test.describe('Guest checkout (UI)', { tag: ['@ui', '@order', '@smoke'] }, () => {
  test('guest places an order and the backend records it correctly', async ({
    adminApi,
    storeApi,
    testData,
    testProduct,
    nav,
    productPage,
    cartPage,
    checkoutPage,
    orderConfirmedPage,
  }) => {
    // Full checkout = ~7 server actions; against `next dev` this exceeds the default 90s budget.
    test.slow();
    const email = testEmail('guest');
    const address = testAddress(env.countryCode, { first_name: 'Guest', last_name: 'Checkout' });
    const variant = testProduct.variants.find((v) => v.title === 'M')!;
    testData.trackCustomerEmail(email);

    const region = await storeApi.regionForCountry(env.countryCode);
    const before = await adminApi.inventoryLevel(variant.inventoryItemId);
    expect(before.reserved_quantity).toBe(0);

    await test.step('add product variant to cart', async () => {
      await productPage.goto(testProduct.handle);
      await productPage.selectOption('M');
      await productPage.addToCart();
      await nav.expectCartCount(1);
    });

    await test.step('review cart and start checkout', async () => {
      await cartPage.goto();
      await expect(cartPage.row(testProduct.title)).toHaveCount(1);
      await expect(cartPage.subtotal).toHaveAttribute('data-value', String(testProduct.price));
      await cartPage.proceedToCheckout();
    });

    let shippingAmount = 0;
    await test.step('enter address, delivery and payment', async () => {
      await checkoutPage.fillAddress(address, email);
      await expect(checkoutPage.shippingAddressSummary).toContainText(address.address_1);

      await checkoutPage.chooseDelivery(SHIPPING_OPTION);
      shippingAmount = Number(await checkoutPage.cartShipping.getAttribute('data-value'));
      expect(shippingAmount).toBeGreaterThan(0);

      await checkoutPage.choosePayment(PAYMENT_PROVIDER_TITLE);
      await expect(checkoutPage.cartTotal).toHaveAttribute('data-value', String(testProduct.price + shippingAmount));
    });

    await test.step('place order and see confirmation', async () => {
      await checkoutPage.placeOrder();
      testData.trackOrder(orderConfirmedPage.orderId());
      await orderConfirmedPage.expectLoaded();
      await expect(orderConfirmedPage.email).toHaveText(email);
      await expect(orderConfirmedPage.rows).toHaveCount(1);
      await expect(orderConfirmedPage.rows.getByTestId('product-name')).toHaveText(testProduct.title);
      await expect(orderConfirmedPage.total).toHaveAttribute('data-value', String(testProduct.price + shippingAmount));
    });

    await test.step('verify order, payment and inventory in the backend', async () => {
      const order = await adminApi.getOrder(orderConfirmedPage.orderId());

      await expect(orderConfirmedPage.displayId).toHaveText(String(order.display_id));
      expect(order).toMatchObject({
        email,
        status: 'pending',
        payment_status: 'authorized',
        fulfillment_status: 'not_fulfilled',
        currency_code: region.currency_code,
        item_subtotal: testProduct.price,
        shipping_total: shippingAmount,
        total: testProduct.price + shippingAmount,
      });
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({
        title: testProduct.title,
        variant_sku: variant.sku,
        unit_price: testProduct.price,
        quantity: 1,
      });
      expect(order.shipping_methods.map((m) => m.name)).toEqual([SHIPPING_OPTION]);
      expect(order.shipping_address).toMatchObject({
        first_name: address.first_name,
        last_name: address.last_name,
        address_1: address.address_1,
        postal_code: address.postal_code,
        city: address.city,
        country_code: address.country_code,
      });

      const after = await adminApi.inventoryLevel(variant.inventoryItemId);
      expect(after).toEqual({ stocked_quantity: before.stocked_quantity, reserved_quantity: 1 });
    });
  });
});
