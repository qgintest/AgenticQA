import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Single source of truth for runtime configuration.
 *
 * Resolution order (first wins): process env → automation/.env → ../aut/.env (admin creds only).
 * Nothing here talks to the AUT; the publishable key is discovered at runtime via the Admin API.
 */

const automationRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(automationRoot, '.env'), quiet: true });

function readAutEnv(): Record<string, string> {
  const file = path.resolve(automationRoot, '..', 'aut', '.env');
  return fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
}

const autEnv = readAutEnv();

function value(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : fallback;
}

export type DeliberateFailureMode = 'off' | 'assertion' | 'locator';

function deliberateFailureMode(): DeliberateFailureMode {
  const raw = (value('AQA_DELIBERATE_FAILURE', 'off') ?? 'off').toLowerCase();
  if (raw === 'off' || raw === 'assertion' || raw === 'locator') return raw;
  throw new Error(`AQA_DELIBERATE_FAILURE must be off | assertion | locator (got "${raw}")`);
}

export const env = {
  storefrontUrl: value('AQA_STOREFRONT_URL', 'http://localhost:8000')!.replace(/\/$/, ''),
  backendUrl: value('AQA_BACKEND_URL', 'http://localhost:9000')!.replace(/\/$/, ''),
  countryCode: value('AQA_COUNTRY_CODE', 'dk')!,
  adminEmail: value('AQA_ADMIN_EMAIL', autEnv.ADMIN_EMAIL),
  adminPassword: value('AQA_ADMIN_PASSWORD', autEnv.ADMIN_PASSWORD),
  deliberateFailure: deliberateFailureMode(),
  isCI: !!process.env.CI,
} as const;

export function requireAdminCredentials(): { email: string; password: string } {
  if (!env.adminEmail || !env.adminPassword) {
    throw new Error(
      'Admin credentials missing. Set AQA_ADMIN_EMAIL / AQA_ADMIN_PASSWORD, ' +
        'or ADMIN_EMAIL / ADMIN_PASSWORD in ../aut/.env (created by aut/scripts/init-env.sh).',
    );
  }
  return { email: env.adminEmail, password: env.adminPassword };
}
