import fs from 'node:fs';
import path from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import { AdminClient } from '../src/api/admin-client';
import { env, requireAdminCredentials } from '../src/config/env';
import { RUN_ID } from '../src/data/factories';

const READY_TIMEOUT_MS = Number(process.env.AQA_READY_TIMEOUT_MS ?? 180_000);

async function waitFor(name: string, url: string, accept: (status: number) => boolean): Promise<void> {
  const ctx = await request.newContext();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no response';
  try {
    while (Date.now() < deadline) {
      try {
        const res = await ctx.get(url, { timeout: 60_000, maxRedirects: 5 });
        if (accept(res.status())) return;
        last = `HTTP ${res.status()}`;
      } catch (e) {
        last = (e as Error).message.split('\n')[0] ?? 'error';
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(
    `${name} not ready at ${url} after ${READY_TIMEOUT_MS / 1000}s (last: ${last}). ` +
      'Start the AUT first: see docs/setup.md (cd aut && docker compose up -d).',
  );
}

/**
 * Fails fast with an actionable message when the AUT is down, verifies admin credentials,
 * warms up Next.js dev-server routes, and records environment metadata for later triage.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  process.env.AQA_RUN_ID = RUN_ID; // share one run id with all workers

  await waitFor('Medusa backend', `${env.backendUrl}/health`, (s) => s === 200);
  await waitFor('Storefront', `${env.storefrontUrl}/${env.countryCode}`, (s) => s === 200);

  const { email, password } = requireAdminCredentials();
  const admin = await AdminClient.login(env.backendUrl, email, password);
  let publishableKeyPrefix = '';
  try {
    await admin.storeDefaults();
    publishableKeyPrefix = (await admin.publishableKey()).slice(0, 8);
  } finally {
    await admin.dispose();
  }

  // First hit of each route triggers compilation in `next dev`; do it once here, not inside tests.
  const warm = await request.newContext({ baseURL: env.storefrontUrl });
  try {
    for (const route of ['store', 'cart', 'products/__aqa-warmup__', 'checkout']) {
      await warm.get(`/${env.countryCode}/${route}`, { timeout: 120_000, failOnStatusCode: false });
    }
  } finally {
    await warm.dispose();
  }

  const reportsDir = path.resolve(__dirname, '..', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportsDir, 'environment.json'),
    JSON.stringify(
      {
        runId: RUN_ID,
        startedAt: new Date().toISOString(),
        storefrontUrl: env.storefrontUrl,
        backendUrl: env.backendUrl,
        countryCode: env.countryCode,
        publishableKeyPrefix,
        deliberateFailure: env.deliberateFailure,
        ci: env.isCI,
        commit: process.env.GITHUB_SHA ?? null,
      },
      null,
      2,
    ),
  );
}
