import { stripAnsi } from './playwright-results';
import { ZipReader } from './zip';

/** Condensed, model-friendly view of a Playwright trace.zip. */

export interface TraceAction {
  name: string;
  durationMs: number | null;
  error: string | null;
}

export interface TraceRequest {
  method: string;
  url: string;
  status: number;
  durationMs: number | null;
}

export interface TraceConsole {
  kind: string;
  text: string;
}

export interface TraceSummary {
  actions: { total: number; failed: TraceAction[]; last: TraceAction[] };
  network: { total: number; failed: TraceRequest[]; slow: TraceRequest[] };
  console: { errors: TraceConsole[]; pageErrors: string[] };
}

const MAX_ITEMS = 30;
const SLOW_MS = 10_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function* jsonLines(text: string): Generator<Json> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObj(v)) yield v;
    } catch {
      /* skip malformed lines */
    }
  }
}

/** Strip query strings and fragments so URLs carry no tokens or ids. */
export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    return raw.split(/[?#]/)[0] ?? raw;
  }
}

export function summarizeTrace(zipBuf: Buffer, maxEntryBytes: number, charge: (bytes: number) => void): TraceSummary {
  const zip = new ZipReader(zipBuf);
  const begun = new Map<string, { name: string; start: number | null }>();
  const actions: TraceAction[] = [];
  const consoleErrors: TraceConsole[] = [];
  const pageErrors: string[] = [];
  const requests: TraceRequest[] = [];

  // `test.trace` holds the test-runner steps with readable titles; the numbered context traces repeat
  // the same actions at protocol level. Take actions from test.trace when present, console from all.
  const traceEntries = zip.find((n) => n.endsWith('.trace'));
  const hasTestTrace = traceEntries.some((e) => e.name === 'test.trace');
  for (const entry of traceEntries) {
    const buf = zip.read(entry, maxEntryBytes);
    charge(buf.length);
    const takeActions = !hasTestTrace || entry.name === 'test.trace';
    for (const ev of jsonLines(buf.toString('utf8'))) {
      if (!takeActions && (ev.type === 'before' || ev.type === 'after')) continue;
      if (ev.type === 'before' && typeof ev.callId === 'string') {
        const name =
          typeof ev.title === 'string' ? ev.title : typeof ev.apiName === 'string' ? ev.apiName : `${String(ev.class ?? '')}.${String(ev.method ?? '')}`;
        begun.set(ev.callId, { name, start: typeof ev.startTime === 'number' ? ev.startTime : null });
      } else if (ev.type === 'after' && typeof ev.callId === 'string') {
        const b = begun.get(ev.callId);
        const err = isObj(ev.error) ? (isObj(ev.error.error) ? ev.error.error : ev.error) : null;
        const end = typeof ev.endTime === 'number' ? ev.endTime : null;
        actions.push({
          name: b?.name ?? 'unknown',
          durationMs: b?.start != null && end != null ? Math.round(end - b.start) : null,
          error: err ? stripAnsi(String(err.message ?? 'error')).split('\n').slice(0, 6).join('\n') : null,
        });
      } else if (ev.type === 'console' && (ev.messageType === 'error' || ev.messageType === 'warning')) {
        consoleErrors.push({ kind: String(ev.messageType), text: String(ev.text ?? '').slice(0, 500) });
      } else if (ev.type === 'event' && ev.method === 'pageError') {
        pageErrors.push(JSON.stringify(ev.params ?? {}).slice(0, 500));
      }
    }
  }

  for (const entry of zip.find((n) => n.endsWith('.network'))) {
    const buf = zip.read(entry, maxEntryBytes);
    charge(buf.length);
    for (const ev of jsonLines(buf.toString('utf8'))) {
      const s = isObj(ev.snapshot) ? ev.snapshot : null;
      if (!s || !isObj(s.request)) continue;
      const status = isObj(s.response) && typeof s.response.status === 'number' ? s.response.status : -1;
      requests.push({
        method: String(s.request.method ?? 'GET'),
        url: sanitizeUrl(String(s.request.url ?? '')),
        status,
        durationMs: typeof s.time === 'number' && s.time >= 0 ? Math.round(s.time) : null,
      });
    }
  }

  return {
    actions: {
      total: actions.length,
      failed: actions.filter((a) => a.error).slice(-MAX_ITEMS),
      last: actions.slice(-12),
    },
    network: {
      total: requests.length,
      failed: requests.filter((r) => r.status < 0 || r.status >= 400).slice(0, MAX_ITEMS),
      slow: requests.filter((r) => (r.durationMs ?? 0) >= SLOW_MS).slice(0, MAX_ITEMS),
    },
    console: { errors: consoleErrors.slice(-MAX_ITEMS), pageErrors: pageErrors.slice(-MAX_ITEMS) },
  };
}
