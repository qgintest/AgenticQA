import { test, expect } from '../../src/fixtures';
import { ApiError } from '../../src/api/http';
import { env } from '../../src/config/env';
import { testAddress, testEmail } from '../../src/data/factories';

const MANUAL_PROVIDER = 'pp_system_default';

test.describe('Order lifecycle (Store + Admin API)', { tag: ['@api', '@order'] }, () => {
  test('order placed via Store API reserves stock; cancelling releases it', async ({
    adminApi,
    storeApi,
    testData,
    testProduct,
  }) => {
    const email = testEmail('api');
    const variant = testProduct.variants[0]!;
    const quantity = 2;
    testData.trackCustomerEmail(email);

    const region = await storeApi.regionForCountry(env.countryCode);
    const stockBefore = await adminApi.inventoryLevel(variant.inventoryItemId);

    const cartId = await test.step('build cart with items, contact and shipping', async () => {
      const cart = await storeApi.createCart(region.id);
      const withItem = await storeApi.addLineItem(cart.id, variant.id, quantity);
      expect(withItem.items).toHaveLength(1);
      expect(withItem.items[0]).toMatchObject({ variant_id: variant.id, quantity, unit_price: testProduct.price });

      await storeApi.setContact(cart.id, email, testAddress(env.countryCode));
      const options = await storeApi.shippingOptions(cart.id);
      const standard = options.find((o) => o.name === 'Standard Shipping');
      expect(standard, `shipping options: ${options.map((o) => o.name).join(', ')}`).toBeDefined();

      const priced = await storeApi.addShippingMethod(cart.id, standard!.id);
      expect(priced.item_subtotal).toBe(testProduct.price * quantity);
      expect(priced.shipping_total).toBe(standard!.amount);
      expect(priced.total).toBe(testProduct.price * quantity + standard!.amount);
      return cart.id;
    });

    const orderId = await test.step('pay and complete the cart', async () => {
      await storeApi.initPayment(cartId, MANUAL_PROVIDER);
      const result = await storeApi.completeCart(cartId);
      expect(result.type, JSON.stringify(result)).toBe('order');
      if (result.type !== 'order') throw new Error('unreachable');
      testData.trackOrder(result.order.id);
      return result.order.id;
    });

    await test.step('admin sees an authorized, unfulfilled order with reserved stock', async () => {
      const order = await adminApi.getOrder(orderId);
      expect(order).toMatchObject({
        email,
        status: 'pending',
        payment_status: 'authorized',
        fulfillment_status: 'not_fulfilled',
        item_subtotal: testProduct.price * quantity,
      });
      expect(order.items).toEqual([
        expect.objectContaining({ variant_sku: variant.sku, quantity, unit_price: testProduct.price }),
      ]);
      expect(await adminApi.inventoryLevel(variant.inventoryItemId)).toEqual({
        stocked_quantity: stockBefore.stocked_quantity,
        reserved_quantity: stockBefore.reserved_quantity + quantity,
      });
    });

    await test.step('cancelling the order releases the reservation', async () => {
      const canceled = await adminApi.cancelOrder(orderId);
      expect(canceled.status).toBe('canceled');
      expect(await adminApi.inventoryLevel(variant.inventoryItemId)).toEqual(stockBefore);
    });
  });

  test('adding more units than are in stock is rejected', async ({ storeApi, testData }) => {
    const product = await testData.createProduct({ optionValues: ['One'], stockedQuantity: 2 });
    const region = await storeApi.regionForCountry(env.countryCode);
    const cart = await storeApi.createCart(region.id);

    const error = await storeApi.addLineItem(cart.id, product.variants[0]!.id, 3).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).body).toMatch(/inventory/i);
  });
});
