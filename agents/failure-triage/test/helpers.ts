import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest } from '../src/agent';
import { DEFAULT_LIMITS, type TriageConfig } from '../src/config';

export function tmpDir(prefix = 'triage-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal ZIP writer (deflate) for building trace.zip fixtures. */
export function makeZip(files: Record<string, string | Buffer>, opts: { lieAboutSize?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const declared = opts.lieAboutSize ? 10 : data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export interface FixtureTest {
  title: string;
  status: 'unexpected' | 'flaky' | 'expected';
  errors: string[];
  /** Per attempt status; defaults to ['failed'] for unexpected, ['failed','passed'] for flaky. */
  attempts?: string[];
  artifacts?: boolean;
  startTime?: string;
}

/**
 * Writes a realistic artifact layout:
 *   <root>/reports/results.json, environment.json, aut/*.log
 *   <root>/test-results/<test>/{trace.zip,test-failed-1.png,error-context.md}
 */
export function writeFixture(tests: FixtureTest[], opts: { logs?: Record<string, string>; runErrors?: string[] } = {}): { root: string; reportsDir: string; testResultsDir: string } {
  const root = tmpDir();
  const reportsDir = path.join(root, 'reports');
  const testResultsDir = path.join(root, 'test-results');
  fs.mkdirSync(path.join(reportsDir, 'aut'), { recursive: true });
  fs.mkdirSync(testResultsDir, { recursive: true });

  const specs = tests.map((t, i) => {
    const dir = path.join(testResultsDir, `test-${i + 1}`);
    const attachments: unknown[] = [];
    if (t.artifacts !== false && t.status !== 'expected') {
      fs.mkdirSync(dir, { recursive: true });
      const trace = makeZip({
        'test.trace': [
          JSON.stringify({ type: 'before', callId: 'a1', startTime: 100, title: 'Navigate to "/dk/store"', class: 'Test', method: 'pw:api' }),
          JSON.stringify({ type: 'after', callId: 'a1', endTime: 400 }),
          JSON.stringify({ type: 'before', callId: 'a2', startTime: 500, title: "Click getByTestId('add-to-bag-button')", class: 'Test', method: 'pw:api' }),
          JSON.stringify({ type: 'after', callId: 'a2', endTime: 10500, error: { message: 'TimeoutError: locator.click: Timeout 10000ms exceeded.' } }),
        ].join('\n'),
        '0-trace.trace': JSON.stringify({ type: 'console', messageType: 'error', text: 'Failed to load resource: 500' }),
        '0-trace.network': [
          JSON.stringify({ snapshot: { request: { method: 'GET', url: 'http://localhost:9000/store/products?token=SECRET123' }, response: { status: 500 }, time: 120 } }),
          JSON.stringify({ snapshot: { request: { method: 'GET', url: 'http://localhost:8000/dk' }, response: { status: 200 }, time: 80 } }),
        ].join('\n'),
      });
      fs.writeFileSync(path.join(dir, 'trace.zip'), trace);
      fs.writeFileSync(path.join(dir, 'test-failed-1.png'), PNG_1PX);
      fs.writeFileSync(
        path.join(dir, 'error-context.md'),
        '# Instructions\n\n- Following Playwright test failed.\n- Provide a snippet of code with the fix.\n\n# Page snapshot\n\n```yaml\n- button "Add to cart"\n```\n',
      );
      attachments.push(
        { name: 'screenshot', contentType: 'image/png', path: path.join(dir, 'test-failed-1.png') },
        { name: 'trace', contentType: 'application/zip', path: path.join(dir, 'trace.zip') },
        { name: 'error-context', contentType: 'text/markdown', path: path.join(dir, 'error-context.md') },
      );
    }
    const attemptStatuses = t.attempts ?? (t.status === 'flaky' ? ['failed', 'passed'] : t.status === 'expected' ? ['passed'] : ['failed']);
    return {
      title: t.title,
      file: `suite/test-${i + 1}.spec.ts`,
      line: 10 + i,
      tags: ['@ui'],
      tests: [
        {
          projectName: 'regression',
          status: t.status,
          results: attemptStatuses.map((s, retry) => ({
            retry,
            status: s,
            duration: 1200,
            startTime: t.startTime ?? '2026-10-19T10:00:00.000Z',
            errors: s === 'passed' ? [] : t.errors.map((m) => ({ message: m, stack: `${m}\n    at /repo/automation/tests/suite.spec.ts:12:5` })),
            stdout: [],
            stderr: [],
            attachments: s === 'passed' ? [] : attachments,
          })),
        },
      ],
    };
  });

  const results = {
    config: {},
    suites: [{ title: 'suite.spec.ts', file: 'suite.spec.ts', specs, suites: [] }],
    errors: (opts.runErrors ?? []).map((m) => ({ message: m })),
    stats: {
      startTime: '2026-10-19T10:00:00.000Z',
      duration: 5000,
      expected: tests.filter((t) => t.status === 'expected').length,
      unexpected: tests.filter((t) => t.status === 'unexpected').length,
      flaky: tests.filter((t) => t.status === 'flaky').length,
      skipped: 0,
    },
  };
  fs.writeFileSync(path.join(reportsDir, 'results.json'), JSON.stringify(results));
  fs.writeFileSync(path.join(reportsDir, 'environment.json'), JSON.stringify({ runId: 'abc', storefrontUrl: 'http://localhost:8000' }));
  for (const [service, text] of Object.entries(opts.logs ?? {})) fs.writeFileSync(path.join(reportsDir, 'aut', `${service}.log`), text);
  return { root, reportsDir, testResultsDir };
}

export function testConfig(dirs: { reportsDir: string; testResultsDir: string; root: string }, limits: Partial<typeof DEFAULT_LIMITS> = {}): TriageConfig {
  return {
    model: 'fake-model',
    effort: 'high',
    refusalFallbacks: false,
    limits: { ...DEFAULT_LIMITS, ...limits },
    paths: {
      resultsJson: path.join(dirs.reportsDir, 'results.json'),
      testResultsDir: dirs.testResultsDir,
      reportsDir: dirs.reportsDir,
      outDir: path.join(dirs.root, 'out'),
    },
    runUrl: null,
  };
}

// --- scripted model --------------------------------------------------------------------------

type Block = Anthropic.Beta.BetaContentBlock;
let seq = 0;

export function toolUse(name: string, input: unknown): Block {
  return { type: 'tool_use', id: `toolu_${++seq}`, name, input } as Block;
}

export function text(t: string): Block {
  return { type: 'text', text: t, citations: null } as Block;
}

export function message(content: Block[], stop_reason: string = 'tool_use', usage = { input_tokens: 1000, output_tokens: 200 }): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${++seq}`,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

/**
 * A ModelClient that replays scripted responses. A script step may be a message, an error to throw,
 * or a function of the request (to react to tool results, like a real model would).
 */
export class ScriptedModel implements ModelClient {
  readonly model = 'fake-model';
  readonly requests: ModelRequest[] = [];
  private i = 0;

  constructor(private readonly script: Array<Anthropic.Beta.BetaMessage | Error | ((req: ModelRequest) => Anthropic.Beta.BetaMessage)>, private readonly repeatLast = false) {}

  async create(request: ModelRequest): Promise<Anthropic.Beta.BetaMessage> {
    // Snapshot: the agent mutates its history array after the call.
    this.requests.push({ ...request, messages: JSON.parse(JSON.stringify(request.messages)) });
    let step = this.script[this.i++];
    if (step === undefined) {
      if (!this.repeatLast) throw new Error('script exhausted');
      step = this.script[this.script.length - 1]!;
    }
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(request) : step;
  }
}

/** Collect all tool_result payloads (as text) the agent sent back in a request. */
export function toolResultsIn(req: ModelRequest): string[] {
  const out: string[] = [];
  for (const m of req.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      const c = b.content;
      if (typeof c === 'string') out.push(c);
      else if (Array.isArray(c)) out.push(c.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join(' '));
    }
  }
  return out;
}

export function evidenceIdsIn(req: ModelRequest): string[] {
  return toolResultsIn(req)
    .map((r) => /"evidence_id":"(E\d+)"/.exec(r)?.[1])
    .filter((x): x is string => !!x);
}
