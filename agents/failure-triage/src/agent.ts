import Anthropic from '@anthropic-ai/sdk';
import type { TriageConfig } from './config';
import { BUDGET_NUDGE, initialUserMessage, NO_SUBMIT_NUDGE, SYSTEM_PROMPT } from './prompts';
import { runToolLoop } from './loop';
import type { Redactor } from './redact';
import { validateSubmission, type AgentTelemetry, type Submission } from './report';
import { SUBMIT_TOOL, type ToolContext, ToolRunner } from './tools';

type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

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

export { describeApiError } from './loop';

export async function runAgent(
  client: ModelClient,
  config: Pick<TriageConfig, 'limits' | 'effort'>,
  ctx: ToolContext,
  redactor: Redactor,
  now: () => number = Date.now,
): Promise<AgentResult> {
  const runner = new ToolRunner(ctx);
  const knownIds = new Set(ctx.tests.map((t) => t.id));
  const result = await runToolLoop<Submission>({
    client,
    system: SYSTEM_PROMPT,
    initialText: initialUserMessage(ctx.parsed, ctx.tests, ctx.notAnalyzed.length),
    tools: runner.definitions,
    execute: (name, input) => runner.run(name, input),
    terminals: [{ name: SUBMIT_TOOL, accept: (input) => validateSubmission(input, knownIds) }],
    limits: config.limits,
    effort: config.effort,
    redactor,
    bytesRead: () => ctx.sandbox.totalBytesRead,
    noSubmitNudge: NO_SUBMIT_NUDGE,
    budgetNudge: BUDGET_NUDGE,
    now,
  });
  return { submission: result.value, telemetry: result.telemetry, failure: result.failure };
}
