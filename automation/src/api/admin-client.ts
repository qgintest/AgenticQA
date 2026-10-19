import { request, type APIRequestContext } from '@playwright/test';
import { json, ApiError } from './http';
import type { InventoryLevel, Order, TestProduct } from './types';

interface StoreDefaults {
  shippingProfileId: string;
  salesChannelId: string;
  stockLocationId: string;
}

export interface CreateProductSpec {
  title: string;
  handle: string;
  skuPrefix: string;
  price: number;
  currency?: string;
  optionTitle?: string;
  optionValues?: string[];
  stockedQuantity?: number;
}

const ORDER_FIELDS = [
  'id', 'display_id', 'status', 'payment_status', 'fulfillment_status', 'email', 'currency_code',
  'total', 'item_subtotal', 'shipping_total',
  '*items', '*shipping_methods', '*shipping_address',
].join(',');

/**
 * Medusa Admin API client used for test-data setup, verification and cleanup.
 * Tests use it for arrangement and assertions on backend state — never to drive the flow under test.
 */
export class AdminClient {
  private defaults?: StoreDefaults;

  private constructor(private readonly api: APIRequestContext) {}

  static async login(baseURL: string, email: string, password: string): Promise<AdminClient> {
    const anon = await request.newContext({ baseURL });
    try {
      const { token } = await json<{ token: string }>(
        await anon.post('/auth/user/emailpass', { data: { email, password } }),
        'POST',
      );
      const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: { authorization: `Bearer ${token}` },
      });
      return new AdminClient(api);
    } finally {
      await anon.dispose();
    }
  }

  async dispose(): Promise<void> {
    await this.api.dispose();
  }

  private async get<T>(path: string): Promise<T> {
    return json<T>(await this.api.get(path), 'GET');
  }

  private async post<T>(path: string, data?: unknown): Promise<T> {
    return json<T>(await this.api.post(path, { data }), 'POST');
  }

  async publishableKey(): Promise<string> {
    const { api_keys } = await this.get<{ api_keys: Array<{ token: string; revoked_at: string | null }> }>(
      '/admin/api-keys?type=publishable',
    );
    const key = api_keys.find((k) => !k.revoked_at);
    if (!key) throw new Error('No active publishable API key found — is the AUT seeded?');
    return key.token;
  }

  /** IDs every test product needs: shipping profile, sales channel and the stock location serving it. */
  async storeDefaults(): Promise<StoreDefaults> {
    if (this.defaults) return this.defaults;
    const [{ shipping_profiles }, { sales_channels }, { stock_locations }] = await Promise.all([
      this.get<{ shipping_profiles: Array<{ id: string; type: string }> }>('/admin/shipping-profiles'),
      this.get<{ sales_channels: Array<{ id: string; name: string }> }>('/admin/sales-channels'),
      this.get<{ stock_locations: Array<{ id: string; sales_channels?: Array<{ id: string }> }> }>(
        '/admin/stock-locations?fields=id,*sales_channels',
      ),
    ]);
    const profile = shipping_profiles.find((p) => p.type === 'default') ?? shipping_profiles[0];
    const channel = sales_channels.find((c) => c.name === 'Default Sales Channel') ?? sales_channels[0];
    const location = stock_locations.find((l) => l.sales_channels?.some((s) => s.id === channel?.id));
    if (!profile || !channel || !location) {
      throw new Error('AUT is missing a shipping profile, sales channel or linked stock location — re-seed it.');
    }
    this.defaults = { shippingProfileId: profile.id, salesChannelId: channel.id, stockLocationId: location.id };
    return this.defaults;
  }

  /** Create a published product with stocked, inventory-managed variants. */
  async createProduct(spec: CreateProductSpec): Promise<TestProduct> {
    const d = await this.storeDefaults();
    const currency = spec.currency ?? 'eur';
    const optionTitle = spec.optionTitle ?? 'Size';
    const values = spec.optionValues ?? ['S', 'M'];

    const { product } = await this.post<{
      product: { id: string; variants: Array<{ id: string; title: string; sku: string }> };
    }>('/admin/products', {
      title: spec.title,
      handle: spec.handle,
      status: 'published',
      description: 'Created by the AgenticQA regression suite. Safe to delete.',
      shipping_profile_id: d.shippingProfileId,
      sales_channels: [{ id: d.salesChannelId }],
      options: [{ title: optionTitle, values }],
      variants: values.map((v) => ({
        title: v,
        sku: `${spec.skuPrefix}-${v}`,
        manage_inventory: true,
        options: { [optionTitle]: v },
        prices: [{ currency_code: currency, amount: spec.price }],
      })),
    });

    // Medusa creates one inventory item per managed variant; give each stock at the channel's location.
    const skuQuery = product.variants.map((v) => `sku[]=${encodeURIComponent(v.sku)}`).join('&');
    const { inventory_items } = await this.get<{ inventory_items: Array<{ id: string; sku: string }> }>(
      `/admin/inventory-items?${skuQuery}`,
    );
    await this.post('/admin/inventory-items/location-levels/batch', {
      create: inventory_items.map((i) => ({
        inventory_item_id: i.id,
        location_id: d.stockLocationId,
        stocked_quantity: spec.stockedQuantity ?? 10,
      })),
    });

    return {
      id: product.id,
      title: spec.title,
      handle: spec.handle,
      price: spec.price,
      currency,
      optionTitle,
      variants: product.variants.map((v) => {
        const item = inventory_items.find((i) => i.sku === v.sku);
        if (!item) throw new Error(`No inventory item created for ${v.sku}`);
        return { id: v.id, title: v.title, sku: v.sku, inventoryItemId: item.id };
      }),
    };
  }

  /** Soft-deletes the product; Medusa also removes its variants and inventory items. Idempotent. */
  async deleteProduct(id: string): Promise<void> {
    const res = await this.api.delete(`/admin/products/${id}`);
    if (!res.ok() && res.status() !== 404) {
      throw new ApiError('DELETE', res.url(), res.status(), await res.text());
    }
  }

  async inventoryLevel(inventoryItemId: string): Promise<InventoryLevel> {
    const d = await this.storeDefaults();
    const { inventory_levels } = await this.get<{ inventory_levels: Array<InventoryLevel & { location_id: string }> }>(
      `/admin/inventory-items/${inventoryItemId}/location-levels`,
    );
    const level = inventory_levels.find((l) => l.location_id === d.stockLocationId);
    if (!level) throw new Error(`No inventory level for ${inventoryItemId} at ${d.stockLocationId}`);
    return { stocked_quantity: level.stocked_quantity, reserved_quantity: level.reserved_quantity };
  }

  async getOrder(id: string): Promise<Order> {
    return (await this.get<{ order: Order }>(`/admin/orders/${id}?fields=${ORDER_FIELDS}`)).order;
  }

  async ordersByEmail(email: string): Promise<Order[]> {
    // `q` is a free-text search; filter exactly afterwards so other orders can never match.
    const { orders } = await this.get<{ orders: Order[] }>(
      `/admin/orders?q=${encodeURIComponent(email)}&fields=${ORDER_FIELDS}&limit=50`,
    );
    return orders.filter((o) => o.email === email);
  }

  /** Cancels the order (releasing reservations and voiding the authorized payment). Idempotent. */
  async cancelOrder(id: string): Promise<Order> {
    const current = await this.getOrder(id);
    if (current.status === 'canceled') return current;
    await this.post(`/admin/orders/${id}/cancel`);
    return this.getOrder(id);
  }
}
