/** Minimal shapes of the Medusa 2.x API responses this suite relies on. */

export interface Address {
  first_name: string;
  last_name: string;
  address_1: string;
  city: string;
  postal_code: string;
  country_code: string;
}

export interface TestVariant {
  id: string;
  title: string;
  sku: string;
  inventoryItemId: string;
}

/** A product created for one test and deleted afterwards. */
export interface TestProduct {
  id: string;
  title: string;
  handle: string;
  /** Unit price in major units (EUR) — Medusa 2 stores amounts as decimals, not cents. */
  price: number;
  currency: string;
  optionTitle: string;
  variants: TestVariant[];
}

export interface InventoryLevel {
  stocked_quantity: number;
  reserved_quantity: number;
}

export interface Region {
  id: string;
  name: string;
  currency_code: string;
}

export interface Cart {
  id: string;
  email?: string;
  total: number;
  item_subtotal: number;
  shipping_total: number;
  items: Array<{ id: string; variant_id: string; quantity: number; unit_price: number }>;
}

export interface ShippingOption {
  id: string;
  name: string;
  amount: number;
}

export interface OrderLineItem {
  title: string;
  variant_sku: string;
  unit_price: number;
  quantity: number;
}

export interface Order {
  id: string;
  display_id: number;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  email: string;
  currency_code: string;
  total: number;
  item_subtotal: number;
  shipping_total: number;
  items: OrderLineItem[];
  shipping_methods: Array<{ name: string; amount: number }>;
  shipping_address: Partial<Address>;
}
