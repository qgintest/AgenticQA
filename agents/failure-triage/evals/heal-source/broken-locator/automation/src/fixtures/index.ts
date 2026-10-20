import { test as base, expect } from '@playwright/test';
import { AdminClient, type CreateProductSpec } from '../api/admin-client';
import { StoreClient } from '../api/store-client';
import type { TestProduct } from '../api/types';
import { env, requireAdminCredentials } from '../config/env';
import { uniqueId } from '../data/factories';
import { CartPage } from '../pages/cart-page';
import { CheckoutPage } from '../pages/checkout-page';
import { NavBar } from '../pages/nav-bar';
import { OrderConfirmedPage } from '../pages/order-confirmed-page';
import { ProductPage } from '../pages/product-page';
import { StorePage } from '../pages/store-page';

/**
 * Owns everything a single test creates in the AUT and removes it afterwards, even when the test
 * fails. Teardown order matters: orders are cancelled first (releasing inventory reservations and
 * voiding payments), then products are deleted. Medusa cannot hard-delete orders, so cancelled
 * orders with `aqa-*` emails remain as an audit trail.
 */
export class TestDataManager {
  private readonly productIds: string[] = [];
  private readonly orderIds = new Set<string>();
  private readonly customerEmails = new Set<string>();

  constructor(private readonly admin: AdminClient) {}

  async createProduct(overrides: Partial<CreateProductSpec> = {}): Promise<TestProduct> {
    const id = uniqueId();
    const product = await this.admin.createProduct({
      title: `AQA Product ${id}`,
      handle: `aqa-product-${id}`,
      skuPrefix: `AQA-${id}`.toUpperCase(),
      price: 25,
      ...overrides,
    });
    this.productIds.push(product.id);
    return product;
  }

  /** Register an order created by the test so teardown cancels it. */
  trackOrder(orderId: string): void {
    this.orderIds.add(orderId);
  }

  /**
   * Register a checkout email. Teardown cancels every order placed with it — this covers UI flows
   * that fail after the order is placed but before the test could read its ID.
   */
  trackCustomerEmail(email: string): void {
    this.customerEmails.add(email);
  }

  async cleanup(): Promise<string[]> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        errors.push(`${what}: ${(e as Error).message}`);
      }
    };

    for (const email of this.customerEmails) {
      await attempt(`find orders for ${email}`, async () => {
        for (const order of await this.admin.ordersByEmail(email)) this.orderIds.add(order.id);
      });
    }
    for (const id of this.orderIds) await attempt(`cancel order ${id}`, () => this.admin.cancelOrder(id));
    for (const id of this.productIds) await attempt(`delete product ${id}`, () => this.admin.deleteProduct(id));
    return errors;
  }
}

type WorkerFixtures = {
  adminApi: AdminClient;
  publishableKey: string;
  storeApi: StoreClient;
};

type TestFixtures = {
  testData: TestDataManager;
  /** A fresh, stocked, two-variant product owned by this test. */
  testProduct: TestProduct;
  nav: NavBar;
  storePage: StorePage;
  productPage: ProductPage;
  cartPage: CartPage;
  checkoutPage: CheckoutPage;
  orderConfirmedPage: OrderConfirmedPage;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  adminApi: [
    async ({}, use) => {
      const { email, password } = requireAdminCredentials();
      const client = await AdminClient.login(env.backendUrl, email, password);
      await use(client);
      await client.dispose();
    },
    { scope: 'worker' },
  ],

  publishableKey: [async ({ adminApi }, use) => use(await adminApi.publishableKey()), { scope: 'worker' }],

  storeApi: [
    async ({ publishableKey }, use) => {
      const client = await StoreClient.create(env.backendUrl, publishableKey);
      await use(client);
      await client.dispose();
    },
    { scope: 'worker' },
  ],

  testData: async ({ adminApi }, use, testInfo) => {
    const manager = new TestDataManager(adminApi);
    await use(manager);
    const errors = await manager.cleanup();
    if (errors.length) {
      // Surface cleanup problems in the report without masking the test's own result.
      await testInfo.attach('test-data-cleanup-errors', { body: errors.join('\n'), contentType: 'text/plain' });
      if (testInfo.status === testInfo.expectedStatus) {
        throw new Error(`Test data cleanup failed:\n${errors.join('\n')}`);
      }
    }
  },

  testProduct: async ({ testData }, use) => use(await testData.createProduct()),

  nav: async ({ page }, use) => use(new NavBar(page)),
  storePage: async ({ page }, use) => use(new StorePage(page)),
  productPage: async ({ page }, use) => use(new ProductPage(page)),
  cartPage: async ({ page }, use) => use(new CartPage(page)),
  checkoutPage: async ({ page }, use) => use(new CheckoutPage(page)),
  orderConfirmedPage: async ({ page }, use) => use(new OrderConfirmedPage(page)),
});

export { expect };
