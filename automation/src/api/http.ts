import type { APIResponse } from '@playwright/test';

/** Error carrying the HTTP context needed to triage a failed API call from a report. */
export class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} → ${status}: ${body.slice(0, 500)}`);
    this.name = 'ApiError';
  }
}

export async function json<T>(res: APIResponse, method: string): Promise<T> {
  const body = await res.text();
  if (!res.ok()) throw new ApiError(method, res.url(), res.status(), body);
  return JSON.parse(body) as T;
}
