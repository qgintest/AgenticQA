import { request, type APIRequestContext } from '@playwright/test';
import { json } from './http';
import type { Address, Cart, Order, Region, ShippingOption } from './types';

export type CompleteCartResult =
  | { type: 'order'; order: Order }
  | { type: 'cart'; cart: Cart; error: { message: string; name: string; type: string } };

/** Medusa Store API client — the same public surface the storefront uses. */
export class StoreClient {
  private constructor(private readonly api: APIRequestContext) {}

  static async create(baseURL: string, publishableKey: string): Promise<StoreClient> {
    const api = await request.newContext({
      baseURL,
      extraHTTPHeaders: { 'x-publishable-api-key': publishableKey },
    });
    return new StoreClient(api);
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  async regionForCountry(countryCode: string): Promise<Region> {
    const { regions } = await json<{ regions: Array<Region & { countries: Array<{ iso_2: string }> }> }>(
      await this.api.get('/store/regions?fields=id,name,currency_code,*countries'),
      'GET',
    );
    const region = regions.find((r) => r.countries.some((c) => c.iso_2 === countryCode));
    if (!region) throw new Error(`No region serves country "${countryCode}"`);
    return region;
  }

  async createCart(regionId: string): Promise<Cart> {
    return (await json<{ cart: Cart }>(await this.api.post('/store/carts', { data: { region_id: regionId } }), 'POST')).cart;
  }

  async addLineItem(cartId: string, variantId: string, quantity: number): Promise<Cart> {
    return (
      await json<{ cart: Cart }>(
        await this.api.post(`/store/carts/${cartId}/line-items`, { data: { variant_id: variantId, quantity } }),
        'POST',
      )
    ).cart;
  }

  async setContact(cartId: string, email: string, address: Address): Promise<Cart> {
    return (
      await json<{ cart: Cart }>(
        await this.api.post(`/store/carts/${cartId}`, {
          data: { email, shipping_address: address, billing_address: address },
        }),
        'POST',
      )
    ).cart;
  }

  async shippingOptions(cartId: string): Promise<ShippingOption[]> {
    return (
      await json<{ shipping_options: ShippingOption[] }>(
        await this.api.get(`/store/shipping-options?cart_id=${cartId}`),
        'GET',
      )
    ).shipping_options;
  }

  async addShippingMethod(cartId: string, optionId: string): Promise<Cart> {
    return (
      await json<{ cart: Cart }>(
        await this.api.post(`/store/carts/${cartId}/shipping-methods`, { data: { option_id: optionId } }),
        'POST',
      )
    ).cart;
  }

  /** Creates the cart's payment collection and a session with the given provider. */
  async initPayment(cartId: string, providerId: string): Promise<void> {
    const { payment_collection } = await json<{ payment_collection: { id: string } }>(
      await this.api.post('/store/payment-collections', { data: { cart_id: cartId } }),
      'POST',
    );
    await json(
      await this.api.post(`/store/payment-collections/${payment_collection.id}/payment-sessions`, {
        data: { provider_id: providerId },
      }),
      'POST',
    );
  }

  async completeCart(cartId: string): Promise<CompleteCartResult> {
    return json<CompleteCartResult>(await this.api.post(`/store/carts/${cartId}/complete`), 'POST');
  }
}
