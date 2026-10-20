import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base-page';

/** /products/:handle — product detail page. */
export class ProductPage extends BasePage {
  // Scoped to the main product container: related-product cards reuse `product-title`/`product-price`.
  readonly container: Locator = this.page.getByTestId('product-container');
  readonly title: Locator = this.container.getByTestId('product-title');
  readonly description: Locator = this.container.getByTestId('product-description');
  readonly options: Locator = this.container.getByTestId('product-options');
  readonly price: Locator = this.container.getByTestId('product-price').first();
  readonly addToCartButton: Locator = this.page.getByTestId('add-bag-button');

  async goto(handle: string): Promise<void> {
    await this.page.goto(this.localized(`/products/${handle}`));
    await expect(this.title).toBeVisible();
  }

  optionButton(value: string): Locator {
    return this.options.getByTestId('option-button').filter({ hasText: new RegExp(`^${value}$`) });
  }

  async selectOption(value: string): Promise<void> {
    await this.optionButton(value).click();
    // Selection is reflected in the URL (?v_id=...) once a full variant is chosen.
    await expect(this.page).toHaveURL(/[?&]v_id=/);
  }

  /** Clicks "Add to cart" and waits until the request finishes (button leaves its loading state). */
  async addToCart(): Promise<void> {
    await expect(this.addToCartButton).toHaveText('Add to cart');
    await this.addToCartButton.click();
    // Adding is a server action (creates the cart on first add); allow for `next dev` latency.
    await expect(this.addToCartButton).toBeEnabled({ timeout: 45_000 });
  }
}
