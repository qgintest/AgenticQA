import { test, expect } from '../../src/fixtures';
import { uniqueId } from '../../src/data/factories';
import { env } from '../../src/config/env';

/** The listing is search-backed and indexes products asynchronously after they are created. */
const INDEXING_TIMEOUT = 45_000;

test.describe('Product browsing', { tag: '@ui' }, () => {
  test('store listing renders product cards with a title and price', { tag: '@smoke' }, async ({ storePage }) => {
    await storePage.goto();

    await expect(storePage.productCards.first()).toBeVisible();
    const titles = await storePage.visibleTitles();
    const prices = await storePage.visiblePrices();

    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t.length > 0), `empty title in ${JSON.stringify(titles)}`).toBe(true);
    expect(prices).toHaveLength(titles.length);
    expect(prices.every((p) => p > 0), `non-positive price in ${JSON.stringify(prices)}`).toBe(true);
  });

  test('search finds a newly created product and nothing for an unknown term', async ({ storePage, testProduct }) => {
    await storePage.goto();

    await expect(async () => {
      await storePage.search(testProduct.title);
      await expect(storePage.card(testProduct.title)).toHaveCount(1, { timeout: 5_000 });
    }).toPass({ timeout: INDEXING_TIMEOUT });
    await expect(storePage.card(testProduct.title).getByTestId('product-price')).toHaveText('€25.00');

    await storePage.search(`zzz-no-such-product-${uniqueId()}`);
    await expect(storePage.noResults).toBeVisible();
    await expect(storePage.productCards).toHaveCount(0);
  });

  test('sorting by price orders results in both directions', async ({ storePage, testData }) => {
    const group = `AQA Sort ${uniqueId()}`;
    const cheap = await testData.createProduct({ title: `${group} Budget`, price: 3 });
    const pricey = await testData.createProduct({ title: `${group} Premium`, price: 300 });
    const mid = await testData.createProduct({ title: `${group} Standard`, price: 30 });

    await storePage.goto();
    await expect(async () => {
      await storePage.search(group);
      await expect(storePage.productCards).toHaveCount(3, { timeout: 5_000 });
    }).toPass({ timeout: INDEXING_TIMEOUT });

    await storePage.sortBy('Price: Low -> High');
    await expect(storePage.productCards.getByTestId('product-title')).toHaveText([cheap.title, mid.title, pricey.title]);
    expect(await storePage.visiblePrices()).toEqual([3, 30, 300]);

    await storePage.sortBy('Price: High -> Low');
    await expect(storePage.productCards.getByTestId('product-title')).toHaveText([pricey.title, mid.title, cheap.title]);
    expect(await storePage.visiblePrices()).toEqual([300, 30, 3]);
  });

  test('product card opens the detail page with variant selection gating "Add to cart"', async ({
    page,
    storePage,
    productPage,
    testProduct,
  }) => {
    await storePage.goto();
    await expect(async () => {
      await storePage.search(testProduct.title);
      await expect(storePage.card(testProduct.title)).toHaveCount(1, { timeout: 5_000 });
    }).toPass({ timeout: INDEXING_TIMEOUT });

    await storePage.card(testProduct.title).click();

    await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/products/${testProduct.handle}$`));
    await expect(productPage.title).toHaveText(testProduct.title);
    await expect(productPage.optionButton('S')).toBeVisible();
    await expect(productPage.optionButton('M')).toBeVisible();
    await expect(productPage.addToCartButton).toBeDisabled();
    await expect(productPage.addToCartButton).toHaveText('Select variant');

    await productPage.selectOption('M');

    await expect(productPage.addToCartButton).toBeEnabled();
    await expect(productPage.addToCartButton).toHaveText('Add to cart');
    await expect(productPage.price).toContainText('€25.00');
  });

  test('adding a variant to the cart updates the nav count and cart contents', async ({
    nav,
    productPage,
    cartPage,
    testProduct,
  }) => {
    await productPage.goto(testProduct.handle);
    await nav.expectCartCount(0);

    await productPage.selectOption('S');
    await productPage.addToCart();

    await nav.expectCartCount(1);
    await cartPage.goto();
    const row = cartPage.row(testProduct.title);
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('product-variant')).toContainText('S');
    await expect(cartPage.subtotal).toHaveAttribute('data-value', String(testProduct.price));
  });
});
