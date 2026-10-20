import crypto from 'node:crypto';
import type { Address } from '../api/types';

/**
 * Unique, recognisable test data. Every entity a test creates carries the `aqa` prefix plus a
 * per-run and per-entity suffix, so parallel workers, reruns and concurrent CI jobs never collide
 * and leftovers are easy to find (`handle like 'aqa-%'`, `email like 'aqa-%@agenticqa.test'`).
 */

export const RUN_ID = process.env.AQA_RUN_ID ?? crypto.randomBytes(3).toString('hex');

export function uniqueId(): string {
  return `${RUN_ID}-${crypto.randomBytes(4).toString('hex')}`;
}

export function testEmail(label: string, id = uniqueId()): string {
  return `aqa-${label}-${id}@agenticqa.test`;
}

export function testAddress(countryCode: string, overrides: Partial<Address> = {}): Address {
  return {
    first_name: 'QA',
    last_name: 'Regression',
    address_1: 'Testvej 1',
    city: 'Copenhagen',
    postal_code: '2100',
    country_code: countryCode,
    ...overrides,
  };
}
