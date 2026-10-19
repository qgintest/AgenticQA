import type { Page } from '@playwright/test';
import { env } from '../config/env';

/** Storefront routes are prefixed with the country code (e.g. /dk/store). */
export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  protected localized(path: string): string {
    return `/${env.countryCode}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

/** Parse "€1,234.50" / "1.234,50 €" style text into a number, for display assertions only. */
export function parsePrice(text: string): number {
  const cleaned = text.replace(/[^\d.,-]/g, '');
  const normalized = /,\d{2}$/.test(cleaned)
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');
  const value = Number(normalized);
  if (Number.isNaN(value)) throw new Error(`Cannot parse price from "${text}"`);
  return value;
}
