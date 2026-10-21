import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from './agent';
import type { Limits } from './config';
import { costOf, type Price } from './pricing';
import type { Redactor } from './redact';
import type { AgentTelemetry, ToolCallRecord } from './report';
import type { ToolOutcome } from './tools';

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

/** A tool that ends the loop when its input is accepted. */
export interface LoopTerminal<T> {
  name: string;
  accept(input: unknown): { ok: true; value: T; reply?: string } | { ok: false; errors: string[] };
}

export interface LoopOptions<T> {
  client: ModelClient;
  system: string;
  initialText: string;
  tools: Anthropic.Beta.BetaTool[];
  /** Executes a non-terminal tool. Must never throw for bad input; return an error outcome instead. */
  execute(name: string, input: unknown): Promise<ToolOutcome>;
  terminals: LoopTerminal<T>[];
  limits: Limits;
  effort: string;
  redactor: Redactor;
  bytesRead(): number;
  noSubmitNudge: string;
  budgetNudge: string;
  /** Optional dollar cap, computed from token usage at `price`. */
  cost?: { capUsd: number; price: Price };
  now?: () => number;
}

export interface LoopResult<T> {
  value: T | null;
  /** Name of the terminal tool that ended the loop. */
  terminal: string | null;
  telemetry: AgentTelemetry;
  failure: string | null;
}

/** Translate SDK errors into safe, actionable messages (never includes request headers). */
export function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.APIUserAbortError) return 'request aborted (time budget exhausted)';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'request timed out';
  if (e instanceof Anthropic.APIConnectionError) return 'could not connect to the Anthropic API';
  if (e instanceof Anthropic.AuthenticationError) return 'authentication failed (401): check the ANTHROPIC_API_KEY secret';
  if (e instanceof Anthropic.PermissionDeniedError) return 'permission denied (403) for this API key or model';
  if (e instanceof Anthropic.NotFoundError) return 'model or endpoint not found (404): check TRIAGE_MODEL';
  if (e instanceof Anthropic.RateLimitError) return 'rate limited (429) after retries';
  if (e instanceof Anthropic.BadRequestError) return `request rejected (400): ${e.message}`;
  if (e instanceof Anthropic.InternalServerError) return `Anthropic API server error (${e.status})`;
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`;
  return `unexpected error: ${(e as Error)?.message ?? String(e)}`;
}

function summarizeInput(input: unknown): string {
  const s = JSON.stringify(input ?? {});
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

/**
 * The shared manual tool-use loop (triage and self-heal). Append-only history, every turn bounded by
 * iteration, token, time and optional cost budgets; a terminal tool whose input fails validation gets
 * the errors back and a limited number of corrections.
 */
export async function runToolLoop<T>(o: LoopOptions<T>): Promise<LoopResult<T>> {
  const { limits } = o;
  const now = o.now ?? Date.now;
  const started = now();
  const deadline = started + limits.timeoutMs;
  const terminals = new Map(o.terminals.map((t) => [t.name, t]));

  const telemetry: AgentTelemetry = {
    model: o.client.model,
    effort: o.effort,
    iterations: 0,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    stopReason: null,
    limitsHit: [],
    errors: [],
    durationMs: 0,
    bytesRead: 0,
  };
  const spent = () => (o.cost ? costOf(telemetry.usage, o.cost.price) : 0);

  const messages: MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: o.initialText }] }];
  let value: T | null = null;
  let terminal: string | null = null;
  let corrections = 0;
  let nudgedForBudget = false;
  let failure: string | null = null;

  const appendToLastUser = (block: ContentBlockParam) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };

  while (terminal === null) {
    if (telemetry.iterations >= limits.maxIterations) {
      telemetry.limitsHit.push(`max iterations (${limits.maxIterations})`);
      break;
    }
    const remaining = deadline - now();
    if (remaining <= 5_000) {
      telemetry.limitsHit.push(`time budget (${limits.timeoutMs} ms)`);
      break;
    }
    if (telemetry.usage.inputTokens >= limits.maxInputTokens || telemetry.usage.outputTokens >= limits.maxOutputTokens) {
      telemetry.limitsHit.push(`token budget (input ${telemetry.usage.inputTokens}/${limits.maxInputTokens}, output ${telemetry.usage.outputTokens}/${limits.maxOutputTokens})`);
      break;
    }
    if (o.cost && spent() >= o.cost.capUsd) {
      telemetry.limitsHit.push(`cost budget ($${spent().toFixed(2)}/$${o.cost.capUsd.toFixed(2)})`);
      break;
    }

    // Last chance to finish inside the limits: tell the model to submit now.
    const nearLimit =
      telemetry.iterations === limits.maxIterations - 1 ||
      telemetry.usage.inputTokens >= 0.8 * limits.maxInputTokens ||
      telemetry.usage.outputTokens >= 0.8 * limits.maxOutputTokens ||
      remaining <= 0.25 * limits.timeoutMs ||
      (o.cost !== undefined && spent() >= 0.8 * o.cost.capUsd);
    if (nearLimit && !nudgedForBudget) {
      appendToLastUser({ type: 'text', text: o.budgetNudge });
      nudgedForBudget = true;
    }

    telemetry.iterations++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Message;
    try {
      response = await o.client.create(
        { system: o.system, tools: o.tools, messages, maxTokens: limits.maxTokensPerResponse },
        { signal: controller.signal, timeoutMs: remaining },
      );
    } catch (e) {
      failure = o.redactor.redact(describeApiError(e));
      telemetry.errors.push(failure);
      break;
    } finally {
      clearTimeout(timer);
    }

    telemetry.usage.inputTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.cache_creation_input_tokens ?? 0) + (response.usage?.cache_read_input_tokens ?? 0);
    telemetry.usage.outputTokens += response.usage?.output_tokens ?? 0;
    telemetry.usage.cacheReadInputTokens += response.usage?.cache_read_input_tokens ?? 0;
    telemetry.stopReason = response.stop_reason ?? null;

    if (!Array.isArray(response.content)) {
      failure = 'malformed model response (no content array)';
      telemetry.errors.push(failure);
      break;
    }
    if (response.stop_reason === 'refusal') {
      failure = 'the model declined the request (refusal)';
      telemetry.errors.push(failure);
      break;
    }
    if (response.stop_reason === 'max_tokens') {
      // A tool input cut off at max_tokens may parse as a valid-looking partial object: never run it.
      failure = 'model response hit max_tokens before finishing';
      telemetry.errors.push(failure);
      break;
    }

    // Append the assistant turn unchanged (thinking blocks included) — the history is append-only.
    messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] });

    if (response.stop_reason === 'pause_turn') continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (++corrections > limits.maxReportCorrections) {
        failure = 'the model stopped without submitting a report';
        telemetry.errors.push(failure);
        break;
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: o.noSubmitNudge }] });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const record: ToolCallRecord = { iteration: telemetry.iterations, name: use.name, input: o.redactor.redact(summarizeInput(use.input)), ok: false, evidenceId: null, error: null };
      const term = terminals.get(use.name);
      if (term) {
        if (terminal !== null) {
          record.error = 'ignored: the loop already ended in this turn';
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'Ignored: a final answer was already accepted in this turn.' });
        } else {
          const v = term.accept(use.input);
          if (v.ok) {
            value = v.value;
            terminal = term.name;
            record.ok = true;
            results.push({ type: 'tool_result', tool_use_id: use.id, content: v.reply ?? 'Report accepted.' });
          } else {
            corrections++;
            record.error = v.errors.join('; ').slice(0, 500);
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Report rejected. Fix and resubmit:\n- ${v.errors.join('\n- ')}` });
          }
        }
      } else {
        const outcome = await o.execute(use.name, use.input);
        record.ok = !outcome.isError;
        record.evidenceId = outcome.evidence?.id ?? null;
        if (outcome.isError) record.error = typeof outcome.content === 'string' ? outcome.content.slice(0, 300) : 'error';
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      telemetry.toolCalls.push(record);
    }
    // All results of one turn go back in a single user message.
    messages.push({ role: 'user', content: results });

    if (terminal === null && corrections > limits.maxReportCorrections) {
      failure = 'the model could not produce a valid report';
      telemetry.errors.push(failure);
      break;
    }
  }

  telemetry.durationMs = now() - started;
  telemetry.bytesRead = o.bytesRead();
  if (o.cost) telemetry.costUsd = Number(spent().toFixed(4));
  if (terminal === null && !failure) failure = `no report within limits (${telemetry.limitsHit.join(', ') || 'unknown reason'})`;
  return { value, terminal, telemetry, failure: terminal !== null ? null : failure };
}
