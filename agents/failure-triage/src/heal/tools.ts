import type Anthropic from '@anthropic-ai/sdk';
import type { Limits } from '../config';
import type { DomIndex } from '../dom';
import type { EvidenceStore } from '../evidence';
import type { Redactor } from '../redact';
import { obj, TOOL_DEFINITIONS, wrap, type ToolOutcome, type ToolRunner } from '../tools';
import { checkTestIdCandidate } from './dom-check';
import type { HealPlan } from './gate';
import { TEST_ID_PATTERN } from './locators';
import { PROPOSE_TOOL, REFUSAL_CATEGORIES, REFUSE_TOOL } from './proposal';
import { RepoSandboxError, type RepoSandbox } from './repo';

type ToolDef = Anthropic.Beta.BetaTool;

/** Triage tools the healer may reuse unchanged (all read-only artifact readers). */
const REUSED = ['get_failure_details', 'read_page_snapshot', 'view_screenshot', 'get_trace_summary', 'find_in_dom_snapshot', 'get_change_summary'];

const evidenceProp = {
  evidence: {
    type: 'array',
    items: obj({ evidence_id: { type: 'string' }, observation: { type: 'string' } }, ['evidence_id', 'observation']),
  },
};

export const HEAL_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: 'get_repair_context',
    description:
      'The broken locator: where it is defined (with surrounding source lines), its page-object property, the scope container, how the code uses it (actions, asserted texts and states, methods), the specs that exercise it, and the triage verdict. Start here.',
    input_schema: obj({}, []),
    strict: true,
  },
  {
    name: 'read_source',
    description: 'Read lines of a test source file (automation/src/** or automation/tests/**, .ts only). At most 150 lines per call.',
    input_schema: obj(
      { path: { type: 'string', description: 'Repo-relative path, e.g. automation/src/pages/product-page.ts' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      ['path', 'start_line', 'end_line'],
    ),
    strict: true,
  },
  {
    name: 'find_usages',
    description: 'Find where an identifier (e.g. a page-object property or method name) is used in the test sources. Whole-word, literal match; at most 40 results.',
    input_schema: obj({ identifier: { type: 'string' } }, ['identifier']),
    strict: true,
  },
  {
    name: 'check_locator',
    description:
      "Deterministically evaluate a candidate data-testid against the DOM snapshot recorded at one test's failure, inside the broken locator's scope container. Returns how many elements match and what they are. Every proposed repair must cite a check_locator result.",
    input_schema: obj({ test_id: { type: 'string', description: 'Failure id, e.g. "T1".' }, candidate_test_id: { type: 'string' } }, ['test_id', 'candidate_test_id']),
    strict: true,
  },
  ...TOOL_DEFINITIONS.filter((t) => REUSED.includes(t.name)),
  {
    name: PROPOSE_TOOL,
    description:
      'Propose the repair: the data-testid the broken locator should use. Only the test-id string changes; file, line and everything else stay as they are. Deterministic checks (uniqueness, fit with usage and asserted texts) run on it before it is accepted.',
    input_schema: obj(
      {
        new_test_id: { type: 'string' },
        target_element: obj({ tag: { type: 'string', description: 'e.g. "button"' }, text: { type: 'string', description: 'Visible text of the element' } }, ['tag', 'text']),
        reason: { type: 'string', description: 'Why this element is the one the locator was meant to find.' },
        confidence: { type: 'number', description: '0.0-1.0; at least 0.7 is required for a repair.' },
        ...evidenceProp,
      },
      ['new_test_id', 'target_element', 'reason', 'confidence', 'evidence'],
    ),
    strict: true,
  },
  {
    name: REFUSE_TOOL,
    description: 'Decline to repair, with the reason. Use whenever a repair would be a guess or could hide an application defect.',
    input_schema: obj({ category: { type: 'string', enum: [...REFUSAL_CATEGORIES] }, reason: { type: 'string' }, ...evidenceProp }, ['category', 'reason', 'evidence']),
    strict: true,
  },
];

export interface HealToolContext {
  plan: HealPlan;
  repo: RepoSandbox;
  triageTools: ToolRunner;
  snapshots: Map<string, DomIndex | null>;
  evidence: EvidenceStore;
  /** evidence id → candidate verified by check_locator */
  checkedCandidates: Map<string, string>;
  redactor: Redactor;
  limits: Limits;
  triageVerdict: Array<{ test_id: string; classification: string; confidence: number; rationale: string }>;
}

class InputError extends Error {}

const str = (input: Record<string, unknown>, key: string): string => {
  const v = input[key];
  if (typeof v !== 'string') throw new InputError(`"${key}" must be a string`);
  return v;
};
const int = (input: Record<string, unknown>, key: string): number => {
  const v = input[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new InputError(`"${key}" must be an integer`);
  return v;
};

export class HealToolRunner {
  constructor(private readonly ctx: HealToolContext) {}

  get definitions(): ToolDef[] {
    return HEAL_TOOL_DEFINITIONS;
  }

  async run(name: string, raw: unknown): Promise<ToolOutcome> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    try {
      switch (name) {
        case 'get_repair_context':
          return this.repairContext();
        case 'read_source':
          return this.readSource(str(input, 'path'), int(input, 'start_line'), int(input, 'end_line'));
        case 'find_usages':
          return this.findUsages(str(input, 'identifier'));
        case 'check_locator':
          return this.checkLocator(str(input, 'test_id'), str(input, 'candidate_test_id'));
        default:
          if (REUSED.includes(name)) return this.ctx.triageTools.run(name, raw);
          return this.error(`unknown tool "${name}"`);
      }
    } catch (e) {
      if (e instanceof InputError || e instanceof RepoSandboxError) return this.error(e.message);
      return this.error(`tool failed: ${(e as Error).message}`);
    }
  }

  private ok(tool: string, testId: string | null, source: string, data: unknown): ToolOutcome {
    const redacted = this.ctx.redactor.redactValue(data);
    const rec = this.ctx.evidence.add(tool, testId, source, typeof redacted === 'string' ? redacted : JSON.stringify(redacted));
    return { content: wrap(rec.id, source, redacted, this.ctx.limits.maxToolResultChars), isError: false, evidence: rec };
  }

  private error(message: string): ToolOutcome {
    return { content: `Error: ${this.ctx.redactor.redact(message)}`, isError: true, evidence: null };
  }

  private numbered(file: string, from: number, to: number): string {
    const lines = this.ctx.repo.read(file).split('\n');
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);
    return lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(4)} | ${l}`)
      .join('\n');
  }

  private repairContext(): ToolOutcome {
    const { plan } = this.ctx;
    return this.ok('get_repair_context', null, `repair context for getByTestId('${plan.failing.testId}')`, {
      failing_locator: plan.failing.chain,
      failing_test_id: plan.failing.testId,
      defined_at: `${plan.location.file}:${plan.location.line}`,
      source_excerpt: this.numbered(plan.location.file, plan.location.line - 12, plan.location.line + 12),
      page_object_property: plan.location.property,
      scope_container_test_id: plan.scope,
      usage: {
        methods_using_it: plan.usage.methods,
        actions: plan.usage.actions,
        asserted_texts: plan.usage.expectedTexts,
        asserted_states: plan.usage.states,
        related_specs: plan.usage.relatedSpecs,
      },
      affected_tests: plan.tests.map((t) => ({ test_id: t.id, title: t.title, file: t.file, has_dom_snapshot: !!this.ctx.snapshots.get(t.id) })),
      triage_verdict: this.ctx.triageVerdict,
      editable: 'Only the test-id string at defined_at.',
    });
  }

  private readSource(file: string, startLine: number, endLine: number): ToolOutcome {
    if (endLine < startLine) throw new InputError('end_line must be >= start_line');
    const to = Math.min(endLine, startLine + 149);
    return this.ok('read_source', null, `${file}:${startLine}-${to}`, this.numbered(file, startLine, to));
  }

  private findUsages(identifier: string): ToolOutcome {
    if (!/^[A-Za-z_$][\w$]{1,60}$/.test(identifier)) throw new InputError('identifier must be a plain name (letters, digits, _ or $; 2-61 chars)');
    const re = new RegExp(`(^|[^\\w$])${identifier.replace(/\$/g, '\\$')}(?![\\w$])`);
    const hits: string[] = [];
    let total = 0;
    for (const file of this.ctx.repo.list()) {
      this.ctx.repo
        .read(file)
        .split('\n')
        .forEach((line, i) => {
          if (!re.test(line)) return;
          total++;
          if (hits.length < 40) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
    }
    return this.ok('find_usages', null, `usages of ${identifier}`, { identifier, total, shown: hits.length, hits });
  }

  private checkLocator(testId: string, candidate: string): ToolOutcome {
    const c = candidate.trim();
    if (!TEST_ID_PATTERN.test(c)) throw new InputError('candidate_test_id must be a plain test id ([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})');
    const test = this.ctx.plan.tests.find((t) => t.id === testId);
    if (!test) throw new InputError(`test_id must be one of ${this.ctx.plan.tests.map((t) => t.id).join(', ')}`);
    const index = this.ctx.snapshots.get(testId);
    if (!index) throw new InputError(`no DOM snapshot for ${testId}`);
    const result = checkTestIdCandidate(index, c, this.ctx.plan.scope);
    const out = this.ok('check_locator', testId, `check_locator "${c}" in ${testId} snapshot`, {
      candidate: c,
      scope: result.scope,
      scope_present: result.scopePresent,
      matches_in_scope: result.inScope.length,
      matches_on_page: result.totalOnPage,
      elements: result.inScope.slice(0, 5),
      verdict: result.inScope.length === 1 ? 'unique' : result.inScope.length === 0 ? 'not found' : 'ambiguous',
    });
    if (out.evidence) this.ctx.checkedCandidates.set(out.evidence.id, c);
    return out;
  }
}
