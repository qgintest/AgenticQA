import { expect, type Locator } from '@playwright/test';
import { BasePage, parsePrice } from './base-page';

export type SortOption = 'Price: Low -> High' | 'Price: High -> Low' | 'Latest Arrivals';

/** /store — the search-backed product listing. */
export class StorePage extends BasePage {
  readonly heading: Locator = this.page.getByTestId('store-page-title');
  readonly productList: Locator = this.page.getByTestId('products-list');
  readonly productCards: Locator = this.productList.getByTestId('product-wrapper');
  readonly searchInput: Locator = this.page.getByTestId('store-search-input');
  readonly sortGroup: Locator = this.page.getByTestId('sort-by-container');
  readonly noResults: Locator = this.page.getByTestId('no-products');

  async goto(): Promise<void> {
    await this.page.goto(this.localized('/store'));
    await expect(this.heading).toBeVisible();
  }

  card(title: string): Locator {
    return this.productCards.filter({
      has: this.page.getByTestId('product-title').getByText(title, { exact: true }),
    });
  }

  async search(text: string): Promise<void> {
    await this.searchInput.fill(text);
  }

  async sortBy(option: SortOption): Promise<void> {
    await this.sortGroup.getByText(option, { exact: true }).click();
  }

  async visibleTitles(): Promise<string[]> {
    return (await this.productCards.getByTestId('product-title').allTextContents()).map((t) => t.trim());
  }

  /** Lowest displayed price of each card in grid order. */
  async visiblePrices(): Promise<number[]> {
    const texts = await this.productCards.getByTestId('product-price').allInnerTexts();
    // A card may show "€10.00" or a range / strike-through; the last amount is the current minimum.
    return texts.map((t) => {
      const amounts = t.match(/[\d.,]+/g) ?? [];
      return parsePrice(amounts[amounts.length - 1] ?? t);
    });
  }
}
