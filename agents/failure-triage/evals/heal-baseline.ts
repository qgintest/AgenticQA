import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient, ModelRequest } from '../src/agent';
import { PROPOSE_TOOL, REFUSE_TOOL } from '../src/heal/proposal';

type Block = Anthropic.Beta.BetaContentBlock;

interface Wrapped {
  evidence_id?: string;
  data?: Record<string, unknown>;
}

/** Tool results of the latest user turn, in order, parsed from the untrusted-data wrapper. */
function latestResults(request: ModelRequest): Wrapped[] {
  const last = request.messages[request.messages.length - 1];
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
  const out: Wrapped[] = [];
  for (const b of last.content) {
    if (b.type !== 'tool_result') continue;
    const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => (x.type === 'text' ? x.text : '')).join('');
    try {
      out.push(JSON.parse(text) as Wrapped);
    } catch {
      out.push({});
    }
  }
  return out;
}

/**
 * Deterministic stand-in for the self-heal model (dry runs, local end-to-end checks, baseline score).
 * It drives the real heal loop and tools: reads the repair context, searches the failure's DOM
 * snapshot for the texts the tests assert on the element, and proposes a test id only when exactly
 * one test-id element carries that text; otherwise it refuses. No model reasoning is involved.
 */
export class HealBaselineModel implements ModelClient {
  readonly model = 'fake-model';
  private turn = 0;
  private seq = 0;
  private context: Wrapped = {};
  private find: Wrapped = {};
  private testId = '';

  async create(request: ModelRequest): Promise<Anthropic.Beta.BetaMessage> {
    this.turn++;
    if (this.turn === 1) return this.reply([this.use('get_repair_context', {})]);

    if (this.turn === 2) {
      this.context = latestResults(request)[0] ?? {};
      const d = this.context.data ?? {};
      const tests = (d.affected_tests as Array<{ test_id: string; has_dom_snapshot: boolean }>) ?? [];
      this.testId = tests.find((t) => t.has_dom_snapshot)?.test_id ?? tests[0]?.test_id ?? 'T1';
      const texts = ((d.usage as { asserted_texts?: string[] })?.asserted_texts ?? []).filter((t) => t.length >= 2);
      if (!texts.length) return this.refuse('insufficient_evidence', 'No asserted text to identify the intended element by.');
      return this.reply(texts.slice(0, 3).map((q) => this.use('find_in_dom_snapshot', { test_id: this.testId, query: q.slice(0, 100) })));
    }

    if (this.turn === 3) {
      const d = this.context.data ?? {};
      const texts = ((d.usage as { asserted_texts?: string[] })?.asserted_texts ?? []).map((t) => t.toLowerCase());
      const failing = String(d.failing_test_id ?? '');
      const results = latestResults(request);
      this.find = results.find((r) => r.evidence_id) ?? {};
      const candidates = new Set<string>();
      for (const r of results) {
        for (const el of (r.data?.elements as Array<{ test_id: string | null; text: string; tag: string }>) ?? []) {
          if (el.test_id && el.test_id !== failing && texts.some((t) => el.text.toLowerCase().includes(t)) && ['button', 'a', 'input'].includes(el.tag)) {
            candidates.add(el.test_id);
          }
        }
      }
      if (candidates.size !== 1) {
        return this.refuse(candidates.size === 0 ? 'element_missing' : 'ambiguous_target', `Found ${candidates.size} interactive test-id elements carrying the asserted text.`);
      }
      return this.reply([this.use('check_locator', { test_id: this.testId, candidate_test_id: [...candidates][0] })]);
    }

    const check = latestResults(request)[0] ?? {};
    const data = check.data ?? {};
    const el = ((data.elements as Array<{ tag: string; text: string }>) ?? [])[0];
    if (data.verdict !== 'unique' || !el) return this.refuse('ambiguous_target', `check_locator verdict: ${String(data.verdict)}`);
    return this.reply([
      this.use(PROPOSE_TOOL, {
        new_test_id: String(data.candidate),
        target_element: { tag: el.tag, text: el.text },
        reason: 'Baseline (deterministic): the only interactive test-id element whose text matches the asserted texts.',
        confidence: 0.8,
        evidence: [this.context, this.find, check]
          .filter((w) => w.evidence_id)
          .map((w) => ({ evidence_id: w.evidence_id!, observation: 'inspected by the baseline' })),
      }),
    ]);
  }

  private refuse(category: string, reason: string): Anthropic.Beta.BetaMessage {
    const ids = [this.context, this.find].filter((w) => w.evidence_id).map((w) => ({ evidence_id: w.evidence_id!, observation: 'inspected by the baseline' }));
    return this.reply([this.use(REFUSE_TOOL, { category, reason, evidence: ids })]);
  }

  private use(name: string, input: unknown): Block {
    return { type: 'tool_use', id: `toolu_heal_${++this.seq}`, name, input } as Block;
  }

  private reply(content: Block[]): Anthropic.Beta.BetaMessage {
    return {
      id: `msg_heal_${++this.seq}`,
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
