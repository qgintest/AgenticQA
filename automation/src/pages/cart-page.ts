import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base-page';

/** /cart */
export class CartPage extends BasePage {
  readonly container: Locator = this.page.getByTestId('cart-container');
  readonly emptyMessage: Locator = this.page.getByTestId('empty-cart-message');
  readonly rows: Locator = this.page.getByTestId('product-row');
  readonly subtotal: Locator = this.page.getByTestId('cart-subtotal');
  readonly total: Locator = this.page.getByTestId('cart-total');
  readonly checkoutButton: Locator = this.page.getByTestId('checkout-button');

  async goto(): Promise<void> {
    await this.page.goto(this.localized('/cart'));
    await expect(this.container).toBeVisible();
  }

  row(productTitle: string): Locator {
    return this.rows.filter({ has: this.page.getByTestId('product-title').getByText(productTitle, { exact: true }) });
  }

  async proceedToCheckout(): Promise<void> {
    await this.checkoutButton.click();
    await expect(this.page).toHaveURL(/\/checkout/);
  }
}
