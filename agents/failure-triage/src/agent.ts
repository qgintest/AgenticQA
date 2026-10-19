import Anthropic from '@anthropic-ai/sdk';
import type { TriageConfig } from './config';
import { BUDGET_NUDGE, initialUserMessage, NO_SUBMIT_NUDGE, SYSTEM_PROMPT } from './prompts';
import type { Redactor } from './redact';
import { validateSubmission, type AgentTelemetry, type Submission, type ToolCallRecord } from './report';
import { SUBMIT_TOOL, type ToolContext, ToolRunner } from './tools';

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export interface ModelRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: MessageParam[];
  maxTokens: number;
}

/** Seam for tests: the real client calls the Messages API, tests script responses. */
export interface ModelClient {
  readonly model: string;
  create(request: ModelRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<Message>;
}

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    private readonly effort: TriageConfig['effort'],
    private readonly refusalFallbacks: boolean,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async create(request: ModelRequest, options: { signal: AbortSignal; timeoutMs: number }): Promise<Message> {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: request.tools,
      messages: request.messages,
      // Thinking is adaptive by default on current models; effort sets the depth.
      output_config: { effort: this.effort },
    };
    if (this.refusalFallbacks && FALLBACK_MODELS.has(this.model)) {
      // Server-side refusal fallback: a false-positive safety decline is retried on another model.
      params.betas = ['server-side-fallback-2026-07-01'];
      params.fallbacks = 'default';
    }
    return this.client.beta.messages.create(params, { signal: options.signal, timeout: options.timeoutMs });
  }
}

export interface AgentResult {
  submission: Submission | null;
  telemetry: AgentTelemetry;
  /** Set when the agent could not produce a usable report. */
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

export async function runAgent(
  client: ModelClient,
  config: Pick<TriageConfig, 'limits' | 'effort'>,
  ctx: ToolContext,
  redactor: Redactor,
  now: () => number = Date.now,
): Promise<AgentResult> {
  const { limits } = config;
  const started = now();
  const deadline = started + limits.timeoutMs;
  const runner = new ToolRunner(ctx);
  const knownIds = new Set(ctx.tests.map((t) => t.id));

  const telemetry: AgentTelemetry = {
    model: client.model,
    effort: config.effort,
    iterations: 0,
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
    stopReason: null,
    limitsHit: [],
    errors: [],
    durationMs: 0,
    bytesRead: 0,
  };

  const messages: MessageParam[] = [{ role: 'user', content: [{ type: 'text', text: initialUserMessage(ctx.parsed, ctx.tests, ctx.notAnalyzed.length) }] }];
  let submission: Submission | null = null;
  let corrections = 0;
  let nudgedForBudget = false;
  let failure: string | null = null;

  const appendToLastUser = (block: ContentBlockParam) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };

  while (!submission) {
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

    // Last chance to finish inside the limits: tell the model to submit now.
    const nearLimit =
      telemetry.iterations === limits.maxIterations - 1 ||
      telemetry.usage.inputTokens >= 0.8 * limits.maxInputTokens ||
      telemetry.usage.outputTokens >= 0.8 * limits.maxOutputTokens ||
      remaining <= 0.25 * limits.timeoutMs;
    if (nearLimit && !nudgedForBudget) {
      appendToLastUser({ type: 'text', text: BUDGET_NUDGE });
      nudgedForBudget = true;
    }

    telemetry.iterations++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let response: Message;
    try {
      response = await client.create(
        { system: SYSTEM_PROMPT, tools: runner.definitions, messages, maxTokens: limits.maxTokensPerResponse },
        { signal: controller.signal, timeoutMs: remaining },
      );
    } catch (e) {
      failure = redactor.redact(describeApiError(e));
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
      messages.push({ role: 'user', content: [{ type: 'text', text: NO_SUBMIT_NUDGE }] });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const record: ToolCallRecord = { iteration: telemetry.iterations, name: use.name, input: redactor.redact(summarizeInput(use.input)), ok: false, evidenceId: null, error: null };
      if (use.name === SUBMIT_TOOL) {
        const v = validateSubmission(use.input, knownIds);
        if (v.ok) {
          submission = v.value;
          record.ok = true;
          results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Report accepted.' });
        } else {
          corrections++;
          record.error = v.errors.join('; ').slice(0, 500);
          results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Report rejected. Fix and resubmit:\n- ${v.errors.join('\n- ')}` });
        }
      } else {
        const outcome = await runner.run(use.name, use.input);
        record.ok = !outcome.isError;
        record.evidenceId = outcome.evidence?.id ?? null;
        if (outcome.isError) record.error = typeof outcome.content === 'string' ? outcome.content.slice(0, 300) : 'error';
        results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.isError ? { is_error: true } : {}) });
      }
      telemetry.toolCalls.push(record);
    }
    // All results of one turn go back in a single user message.
    messages.push({ role: 'user', content: results });

    if (!submission && corrections > limits.maxReportCorrections) {
      failure = 'the model could not produce a valid report';
      telemetry.errors.push(failure);
      break;
    }
  }

  telemetry.durationMs = now() - started;
  telemetry.bytesRead = ctx.sandbox.totalBytesRead;
  if (!submission && !failure) failure = `no report within limits (${telemetry.limitsHit.join(', ') || 'unknown reason'})`;
  return { submission, telemetry, failure: submission ? null : failure };
}
