# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: storefront\product-browsing.spec.ts >> Product browsing >> product card opens the detail page with variant selection gating "Add to cart"
- Location: tests\storefront\product-browsing.spec.ts:57:7

# Error details

```
Error: expect(locator).toBeDisabled() failed

Locator: getByTestId('add-bag-button')
Expected: disabled
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeDisabled" getByTestId('add-bag-button') with timeout 15000ms
  - waiting for getByTestId('add-bag-button')

```

```yaml
- main:
  - navigation:
    - button "Menu"
    - link "Medusa Store":
      - /url: /dk
    - button "Search products":
      - img
    - link "Account":
      - /url: /dk/account
    - button "Cart (0)":
      - link "Cart (0)":
        - /url: /dk/cart
  - heading "AQA Product f80fa0-b8e1e872" [level=2]
  - paragraph: Created by the AgenticQA regression suite. Safe to delete.
  - heading "Product Information" [level=3]:
    - paragraph: Product Information
    - button
  - heading "Shipping & Returns" [level=3]:
    - paragraph: Shipping & Returns
    - button
  - text: Select Size
  - button "S"
  - button "M"
  - text: From €25.00
  - button "Select variant" [disabled]
  - text: Related products
  - paragraph: You might also want to check out these products.
  - list:
    - listitem:
      - link "Thumbnail Medusa Shorts €10.00":
        - /url: /dk/products/shorts
        - img "Thumbnail"
        - paragraph: Medusa Shorts
        - paragraph: €10.00
    - listitem:
      - link "Thumbnail Medusa Sweatshirt €10.00":
        - /url: /dk/products/sweatshirt
        - img "Thumbnail"
        - paragraph: Medusa Sweatshirt
        - paragraph: €10.00
    - listitem:
      - link "Thumbnail Medusa Sweatpants €10.00":
        - /url: /dk/products/sweatpants
        - img "Thumbnail"
        - paragraph: Medusa Sweatpants
        - paragraph: €10.00
    - listitem:
      - link "Thumbnail Medusa T-Shirt €10.00":
        - /url: /dk/products/t-shirt
        - img "Thumbnail"
        - paragraph: Medusa T-Shirt
        - paragraph: €10.00
    - listitem:
      - link "Thumbnail Essential Cotton Tee €80.00":
        - /url: /dk/products/demo-1-tee
        - img "Thumbnail"
        - paragraph: Essential Cotton Tee
        - paragraph: €80.00
    - listitem:
      - link "Thumbnail Lightweight Denim Joggers €63.00":
        - /url: /dk/products/demo-5-joggers
        - img "Thumbnail"
        - paragraph: Lightweight Denim Joggers
        - paragraph: €63.00
    - listitem:
      - link "Thumbnail Cropped Linen Shorts €14.00":
        - /url: /dk/products/demo-4-shorts
        - img "Thumbnail"
        - paragraph: Cropped Linen Shorts
        - paragraph: €14.00
    - listitem:
      - link "Thumbnail Lightweight Linen Overshirt €18.00":
        - /url: /dk/products/demo-6-overshirt
        - img "Thumbnail"
        - paragraph: Lightweight Linen Overshirt
        - paragraph: €18.00
    - listitem:
      - link "Thumbnail Heritage Fleece Sweatshirt €10.00":
        - /url: /dk/products/demo-3-sweatshirt
        - img "Thumbnail"
        - paragraph: Heritage Fleece Sweatshirt
        - paragraph: €10.00
    - listitem:
      - link "Thumbnail Relaxed Merino Hoodie €40.00":
        - /url: /dk/products/demo-2-hoodie
        - img "Thumbnail"
        - paragraph: Relaxed Merino Hoodie
        - paragraph: €40.00
    - listitem:
      - link "Thumbnail Essential Twill Tote €91.00":
        - /url: /dk/products/demo-9-tote
        - img "Thumbnail"
        - paragraph: Essential Twill Tote
        - paragraph: €91.00
    - listitem:
      - link "Thumbnail Cropped Fleece Socks €68.00":
        - /url: /dk/products/demo-8-socks
        - img "Thumbnail"
        - paragraph: Cropped Fleece Socks
        - paragraph: €68.00
  - link "Medusa Store":
    - /url: /dk
  - text: Categories
  - list:
    - listitem:
      - link "Shirts":
        - /url: /dk/categories/shirts
      - list
    - listitem:
      - link "Sweatshirts":
        - /url: /dk/categories/sweatshirts
      - list
    - listitem:
      - link "Pants":
        - /url: /dk/categories/pants
      - list
    - listitem:
      - link "Merch":
        - /url: /dk/categories/merch
      - list
  - text: Collections
  - list:
    - listitem:
      - link "Summer Essentials":
        - /url: /dk/collections/summer-essentials
    - listitem:
      - link "Winter Layers":
        - /url: /dk/collections/winter-layers
    - listitem:
      - link "Everyday Basics":
        - /url: /dk/collections/everyday-basics
    - listitem:
      - link "Limited Run":
        - /url: /dk/collections/limited-run
  - text: Medusa
  - list:
    - listitem:
      - link "GitHub":
        - /url: https://github.com/medusajs
    - listitem:
      - link "Documentation":
        - /url: https://docs.medusajs.com
    - listitem:
      - link "Source code":
        - /url: https://github.com/medusajs/dtc-starter
  - paragraph: © 2026 Medusa Store. All rights reserved.
  - paragraph:
    - text: Powered by
    - link:
      - /url: https://www.medusajs.com
      - img
    - text: "&"
    - link:
      - /url: https://nextjs.org
      - img
- alert: AQA Product f80fa0-b8e1e872 | Medusa Store
```

# Test source

```ts
  1   | import { test, expect } from '../../src/fixtures';
  2   | import { uniqueId } from '../../src/data/factories';
  3   | import { env } from '../../src/config/env';
  4   | 
  5   | /** The listing is search-backed and indexes products asynchronously after they are created. */
  6   | const INDEXING_TIMEOUT = 45_000;
  7   | 
  8   | test.describe('Product browsing', { tag: '@ui' }, () => {
  9   |   test('store listing renders product cards with a title and price', { tag: '@smoke' }, async ({ storePage }) => {
  10  |     await storePage.goto();
  11  | 
  12  |     await expect(storePage.productCards.first()).toBeVisible();
  13  |     const titles = await storePage.visibleTitles();
  14  |     const prices = await storePage.visiblePrices();
  15  | 
  16  |     expect(titles.length).toBeGreaterThan(0);
  17  |     expect(titles.every((t) => t.length > 0), `empty title in ${JSON.stringify(titles)}`).toBe(true);
  18  |     expect(prices).toHaveLength(titles.length);
  19  |     expect(prices.every((p) => p > 0), `non-positive price in ${JSON.stringify(prices)}`).toBe(true);
  20  |   });
  21  | 
  22  |   test('search finds a newly created product and nothing for an unknown term', async ({ storePage, testProduct }) => {
  23  |     await storePage.goto();
  24  | 
  25  |     await expect(async () => {
  26  |       await storePage.search(testProduct.title);
  27  |       await expect(storePage.card(testProduct.title)).toHaveCount(1, { timeout: 5_000 });
  28  |     }).toPass({ timeout: INDEXING_TIMEOUT });
  29  |     await expect(storePage.card(testProduct.title).getByTestId('product-price')).toHaveText('€25.00');
  30  | 
  31  |     await storePage.search(`zzz-no-such-product-${uniqueId()}`);
  32  |     await expect(storePage.noResults).toBeVisible();
  33  |     await expect(storePage.productCards).toHaveCount(0);
  34  |   });
  35  | 
  36  |   test('sorting by price orders results in both directions', async ({ storePage, testData }) => {
  37  |     const group = `AQA Sort ${uniqueId()}`;
  38  |     const cheap = await testData.createProduct({ title: `${group} Budget`, price: 3 });
  39  |     const pricey = await testData.createProduct({ title: `${group} Premium`, price: 300 });
  40  |     const mid = await testData.createProduct({ title: `${group} Standard`, price: 30 });
  41  | 
  42  |     await storePage.goto();
  43  |     await expect(async () => {
  44  |       await storePage.search(group);
  45  |       await expect(storePage.productCards).toHaveCount(3, { timeout: 5_000 });
  46  |     }).toPass({ timeout: INDEXING_TIMEOUT });
  47  | 
  48  |     await storePage.sortBy('Price: Low -> High');
  49  |     await expect(storePage.productCards.getByTestId('product-title')).toHaveText([cheap.title, mid.title, pricey.title]);
  50  |     expect(await storePage.visiblePrices()).toEqual([3, 30, 300]);
  51  | 
  52  |     await storePage.sortBy('Price: High -> Low');
  53  |     await expect(storePage.productCards.getByTestId('product-title')).toHaveText([pricey.title, mid.title, cheap.title]);
  54  |     expect(await storePage.visiblePrices()).toEqual([300, 30, 3]);
  55  |   });
  56  | 
  57  |   test('product card opens the detail page with variant selection gating "Add to cart"', async ({
  58  |     page,
  59  |     storePage,
  60  |     productPage,
  61  |     testProduct,
  62  |   }) => {
  63  |     await storePage.goto();
  64  |     await expect(async () => {
  65  |       await storePage.search(testProduct.title);
  66  |       await expect(storePage.card(testProduct.title)).toHaveCount(1, { timeout: 5_000 });
  67  |     }).toPass({ timeout: INDEXING_TIMEOUT });
  68  | 
  69  |     await storePage.card(testProduct.title).click();
  70  | 
  71  |     await expect(page).toHaveURL(new RegExp(`/${env.countryCode}/products/${testProduct.handle}$`));
  72  |     await expect(productPage.title).toHaveText(testProduct.title);
  73  |     await expect(productPage.optionButton('S')).toBeVisible();
  74  |     await expect(productPage.optionButton('M')).toBeVisible();
> 75  |     await expect(productPage.addToCartButton).toBeDisabled();
      |                                               ^ Error: expect(locator).toBeDisabled() failed
  76  |     await expect(productPage.addToCartButton).toHaveText('Select variant');
  77  | 
  78  |     await productPage.selectOption('M');
  79  | 
  80  |     await expect(productPage.addToCartButton).toBeEnabled();
  81  |     await expect(productPage.addToCartButton).toHaveText('Add to cart');
  82  |     await expect(productPage.price).toContainText('€25.00');
  83  |   });
  84  | 
  85  |   test('adding a variant to the cart updates the nav count and cart contents', async ({
  86  |     nav,
  87  |     productPage,
  88  |     cartPage,
  89  |     testProduct,
  90  |   }) => {
  91  |     await productPage.goto(testProduct.handle);
  92  |     await nav.expectCartCount(0);
  93  | 
  94  |     await productPage.selectOption('S');
  95  |     await productPage.addToCart();
  96  | 
  97  |     await nav.expectCartCount(1);
  98  |     await cartPage.goto();
  99  |     const row = cartPage.row(testProduct.title);
  100 |     await expect(row).toHaveCount(1);
  101 |     await expect(row.getByTestId('product-variant')).toContainText('S');
  102 |     await expect(cartPage.subtotal).toHaveAttribute('data-value', String(testProduct.price));
  103 |   });
  104 | });
  105 | 
```