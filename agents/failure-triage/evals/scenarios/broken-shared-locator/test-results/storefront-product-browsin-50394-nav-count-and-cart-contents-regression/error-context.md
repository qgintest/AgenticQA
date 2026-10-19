# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: storefront\product-browsing.spec.ts >> Product browsing >> adding a variant to the cart updates the nav count and cart contents
- Location: tests\storefront\product-browsing.spec.ts:85:7

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByTestId('add-bag-button')
Expected: "Add to cart"
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toHaveText" getByTestId('add-bag-button') with timeout 15000ms
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
  - heading "AQA Product f80fa0-6c34a3c0" [level=2]
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
  - text: €25.00
  - button "Add to cart"
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
- alert
```

# Test source

```ts
  1  | import { expect, type Locator } from '@playwright/test';
  2  | import { BasePage } from './base-page';
  3  | 
  4  | /** /products/:handle — product detail page. */
  5  | export class ProductPage extends BasePage {
  6  |   // Scoped to the main product container: related-product cards reuse `product-title`/`product-price`.
  7  |   readonly container: Locator = this.page.getByTestId('product-container');
  8  |   readonly title: Locator = this.container.getByTestId('product-title');
  9  |   readonly description: Locator = this.container.getByTestId('product-description');
  10 |   readonly options: Locator = this.container.getByTestId('product-options');
  11 |   readonly price: Locator = this.container.getByTestId('product-price').first();
  12 |   readonly addToCartButton: Locator = this.page.getByTestId('add-bag-button');
  13 | 
  14 |   async goto(handle: string): Promise<void> {
  15 |     await this.page.goto(this.localized(`/products/${handle}`));
  16 |     await expect(this.title).toBeVisible();
  17 |   }
  18 | 
  19 |   optionButton(value: string): Locator {
  20 |     return this.options.getByTestId('option-button').filter({ hasText: new RegExp(`^${value}$`) });
  21 |   }
  22 | 
  23 |   async selectOption(value: string): Promise<void> {
  24 |     await this.optionButton(value).click();
  25 |     // Selection is reflected in the URL (?v_id=...) once a full variant is chosen.
  26 |     await expect(this.page).toHaveURL(/[?&]v_id=/);
  27 |   }
  28 | 
  29 |   /** Clicks "Add to cart" and waits until the request finishes (button leaves its loading state). */
  30 |   async addToCart(): Promise<void> {
> 31 |     await expect(this.addToCartButton).toHaveText('Add to cart');
     |                                        ^ Error: expect(locator).toHaveText(expected) failed
  32 |     await this.addToCartButton.click();
  33 |     // Adding is a server action (creates the cart on first add); allow for `next dev` latency.
  34 |     await expect(this.addToCartButton).toBeEnabled({ timeout: 45_000 });
  35 |   }
  36 | }
  37 | 
```