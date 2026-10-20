import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base-page';

/** /order/:id/confirmed */
export class OrderConfirmedPage extends BasePage {
  readonly container: Locator = this.page.getByTestId('order-complete-container');
  readonly heading: Locator = this.container.getByRole('heading', { level: 1 });
  readonly email: Locator = this.container.getByTestId('order-email');
  readonly displayId: Locator = this.container.getByTestId('order-id');
  readonly status: Locator = this.container.getByTestId('order-status');
  readonly rows: Locator = this.container.getByTestId('product-row');
  readonly total: Locator = this.container.getByTestId('cart-total');
  readonly shippingTotal: Locator = this.container.getByTestId('cart-shipping');

  /** Medusa order ID (order_...) taken from the confirmation URL. */
  orderId(): string {
    const match = new URL(this.page.url()).pathname.match(/\/order\/([^/]+)\/confirmed/);
    if (!match?.[1]) throw new Error(`Not on an order confirmation URL: ${this.page.url()}`);
    return match[1];
  }

  async expectLoaded(): Promise<void> {
    await expect(this.container).toBeVisible();
    await expect(this.heading).toContainText('Your order was placed successfully.');
  }
}
