import { expect, type Locator } from '@playwright/test';
import { BasePage } from './base-page';

export class NavBar extends BasePage {
  /** The "Medusa Store" brand link in the header (the footer repeats the text without a test id). */
  readonly brandLink: Locator = this.page.getByTestId('nav-store-link');
  readonly menuButton: Locator = this.page.getByTestId('nav-menu-button');
  readonly accountLink: Locator = this.page.getByTestId('nav-account-link');
  readonly cartLink: Locator = this.page.getByTestId('nav-cart-link');

  async cartCount(): Promise<number> {
    const text = (await this.cartLink.textContent()) ?? '';
    const match = text.match(/Cart \((\d+)\)/);
    if (!match) throw new Error(`Unexpected cart link text "${text}"`);
    return Number(match[1]);
  }

  async expectCartCount(count: number): Promise<void> {
    await expect(this.cartLink).toHaveText(`Cart (${count})`);
  }

  /** Opens the side menu and follows one of its links (Home, Store, Account, Cart). */
  async openFromMenu(name: 'Home' | 'Store' | 'Account' | 'Cart'): Promise<void> {
    await this.menuButton.click();
    const popup = this.page.getByTestId('nav-menu-popup');
    await expect(popup).toBeVisible();
    await popup.getByTestId(`${name.toLowerCase()}-link`).click();
  }
}
