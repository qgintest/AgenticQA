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

Locator:  getByTestId('nav-cart-link')
Expected: "Cart (1)"
Received: "Cart (2)"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" getByTestId('nav-cart-link') with timeout 15000ms
  - waiting for getByTestId('nav-cart-link')
    5 × locator resolved to <a href="/dk/cart" data-testid="nav-cart-link" class="hover:text-ui-fg-base">Cart (0)</a>
      - unexpected value "Cart (0)"
    28 × locator resolved to <a href="/dk/cart" data-testid="nav-cart-link" class="hover:text-ui-fg-base">Cart (2)</a>
       - unexpected value "Cart (2)"

```

```yaml
- link "Cart (2)":
  - /url: /dk/cart
```

# Test source

```ts
  1  | import { expect, type Locator } from '@playwright/test';
  2  | import { BasePage } from './base-page';
  3  | 
  4  | export class NavBar extends BasePage {
  5  |   /** The "Medusa Store" brand link in the header (the footer repeats the text without a test id). */
  6  |   readonly brandLink: Locator = this.page.getByTestId('nav-store-link');
  7  |   readonly menuButton: Locator = this.page.getByTestId('nav-menu-button');
  8  |   readonly accountLink: Locator = this.page.getByTestId('nav-account-link');
  9  |   readonly cartLink: Locator = this.page.getByTestId('nav-cart-link');
  10 | 
  11 |   async cartCount(): Promise<number> {
  12 |     const text = (await this.cartLink.textContent()) ?? '';
  13 |     const match = text.match(/Cart \((\d+)\)/);
  14 |     if (!match) throw new Error(`Unexpected cart link text "${text}"`);
  15 |     return Number(match[1]);
  16 |   }
  17 | 
  18 |   async expectCartCount(count: number): Promise<void> {
> 19 |     await expect(this.cartLink).toHaveText(`Cart (${count})`);
     |                                 ^ Error: expect(locator).toHaveText(expected) failed
  20 |   }
  21 | 
  22 |   /** Opens the side menu and follows one of its links (Home, Store, Account, Cart). */
  23 |   async openFromMenu(name: 'Home' | 'Store' | 'Account' | 'Cart'): Promise<void> {
  24 |     await this.menuButton.click();
  25 |     const popup = this.page.getByTestId('nav-menu-popup');
  26 |     await expect(popup).toBeVisible();
  27 |     await popup.getByTestId(`${name.toLowerCase()}-link`).click();
  28 |   }
  29 | }
  30 | 
```