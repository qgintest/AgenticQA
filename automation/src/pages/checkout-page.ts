import { expect, type Locator } from '@playwright/test';
import type { Address } from '../api/types';
import { BasePage } from './base-page';

/**
 * Each checkout step is a Next.js server action that round-trips to Medusa and re-renders the page.
 * The AUT storefront runs `next dev`, where a single action took ~15s under parallel load
 * (backend call ~1.5s, the rest dev-server rendering). This budget covers that latency only;
 * every step still asserts the same outcome.
 */
const SERVER_ACTION_TIMEOUT = 45_000;

/** /checkout — a single page that advances through ?step=address|delivery|payment|review. */
export class CheckoutPage extends BasePage {
  readonly firstName: Locator = this.page.getByTestId('shipping-first-name-input');
  readonly lastName: Locator = this.page.getByTestId('shipping-last-name-input');
  readonly address1: Locator = this.page.getByTestId('shipping-address-input');
  readonly postalCode: Locator = this.page.getByTestId('shipping-postal-code-input');
  readonly city: Locator = this.page.getByTestId('shipping-city-input');
  readonly country: Locator = this.page.getByTestId('shipping-country-select');
  readonly email: Locator = this.page.getByTestId('shipping-email-input');
  readonly submitAddress: Locator = this.page.getByTestId('submit-address-button');
  readonly shippingAddressSummary: Locator = this.page.getByTestId('shipping-address-summary');

  readonly deliveryOptions: Locator = this.page.getByTestId('delivery-option-radio');
  readonly submitDelivery: Locator = this.page.getByTestId('submit-delivery-option-button');

  readonly submitPayment: Locator = this.page.getByTestId('submit-payment-button');
  readonly placeOrderButton: Locator = this.page.getByTestId('submit-order-button');

  readonly cartTotal: Locator = this.page.getByTestId('cart-total');
  readonly cartShipping: Locator = this.page.getByTestId('cart-shipping');

  async expectStep(step: 'address' | 'delivery' | 'payment' | 'review'): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`[?&]step=${step}`), { timeout: SERVER_ACTION_TIMEOUT });
  }

  async fillAddress(address: Address, email: string): Promise<void> {
    await this.expectStep('address');
    await this.firstName.fill(address.first_name);
    await this.lastName.fill(address.last_name);
    await this.address1.fill(address.address_1);
    await this.postalCode.fill(address.postal_code);
    await this.city.fill(address.city);
    await this.country.selectOption(address.country_code);
    await this.email.fill(email);
    await this.submitAddress.click();
    await this.expectStep('delivery');
  }

  async chooseDelivery(optionName: string): Promise<void> {
    await this.deliveryOptions.filter({ hasText: optionName }).click();
    // Selecting persists the shipping method; continue only once it's applied to the totals.
    await expect(this.submitDelivery).toBeEnabled({ timeout: SERVER_ACTION_TIMEOUT });
    await this.submitDelivery.click();
    await this.expectStep('payment');
  }

  async choosePayment(providerTitle: string): Promise<void> {
    await this.page.getByRole('radio', { name: new RegExp(providerTitle) }).click();
    await this.submitPayment.click();
    await this.expectStep('review');
  }

  async placeOrder(): Promise<void> {
    await this.placeOrderButton.click();
    await expect(this.page).toHaveURL(/\/order\/[^/]+\/confirmed/, { timeout: SERVER_ACTION_TIMEOUT });
  }
}
