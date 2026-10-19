import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest } from '../src/agent';
import { classifyHeuristically } from '../src/heuristics';
import type { FailedTest } from '../src/playwright-results';
import { SUBMIT_TOOL } from '../src/tools';

type Block = Anthropic.Beta.BetaContentBlock;

/**
 * Scripted stand-in for the model, used by `npm run eval -- --dry-run`. It drives the real agent
 * loop and the real tools over the scenario's artifacts, then answers with the deterministic
 * heuristics, so a dry run exercises everything except the model and doubles as a baseline score.
 */
export class HeuristicBaselineModel implements ModelClient {
  readonly model = 'fake-model';
  private turn = 0;
  private seq = 0;

  constructor(private readonly failures: FailedTest[], private readonly maxFailures: number) {}

  async create(request: ModelRequest): Promise<Anthropic.Beta.BetaMessage> {
    const tests = this.failures.slice(0, this.maxFailures);
    this.turn++;
    if (this.turn === 1) {
      return this.reply([
        this.use('list_failed_tests', {}),
        this.use('get_run_environment', {}),
        this.use('get_change_summary', { path_contains: '' }),
      ]);
    }
    if (this.turn === 2) {
      return this.reply(
        tests.flatMap((t) => [
          this.use('get_failure_details', { test_id: t.id }),
          this.use('get_trace_summary', { test_id: t.id, section: 'actions' }),
          this.use('read_page_snapshot', { test_id: t.id }),
          this.use('view_screenshot', { test_id: t.id }),
          this.use('find_in_dom_snapshot', { test_id: t.id, query: 'button' }),
          this.use('search_aut_logs', { service: 'medusa', query: 'error', around_test_id: t.id }),
        ]),
      );
    }
    const evidence = evidenceByTest(request);
    return this.reply([
      this.use(SUBMIT_TOOL, {
        summary: 'Heuristic baseline (dry run): classifications come from the deterministic error-pattern rules.',
        uncertainty: ['Dry run: no model reasoning was involved.'],
        failures: tests.map((t) => {
          const h = classifyHeuristically(t);
          const ids = [...(evidence.get(t.id) ?? []), ...(evidence.get('') ?? [])];
          return {
            test_id: t.id,
            classification: h.classification,
            confidence: h.confidence,
            rationale: h.rationale,
            evidence: ids.map((id) => ({ evidence_id: id, observation: 'inspected by the dry run' })),
            recommended_actions: [],
          };
        }),
      }),
    ]);
  }

  private use(name: string, input: unknown): Block {
    return { type: 'tool_use', id: `toolu_dry_${++this.seq}`, name, input } as Block;
  }

  private reply(content: Block[]): Anthropic.Beta.BetaMessage {
    return {
      id: `msg_dry_${++this.seq}`,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

/** Evidence ids returned so far, keyed by the test_id the tool was called with ("" for run-wide tools). */
function evidenceByTest(request: ModelRequest): Map<string, string[]> {
  const testOf = new Map<string, string>();
  for (const m of request.messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') testOf.set(b.id, String((b.input as { test_id?: unknown })?.test_id ?? ''));
    }
  }
  const out = new Map<string, string[]>();
  for (const m of request.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== 'tool_result' || b.is_error) continue;
      const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => (x.type === 'text' ? x.text : '')).join('');
      const id = /"evidence_id":"(E\d+)"/.exec(text)?.[1];
      if (!id) continue;
      const key = testOf.get(b.tool_use_id) ?? '';
      out.set(key, [...(out.get(key) ?? []), id]);
    }
  }
  return out;
}
