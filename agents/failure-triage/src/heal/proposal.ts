import type { DomIndex } from '../dom';
import type { EvidenceStore } from '../evidence';
import { checkTestIdCandidate, compatibleWithActions, compatibleWithTexts, type CandidateMatch } from './dom-check';
import type { HealPlan } from './gate';
import { onlyTestIdLiteralChanged, replaceTestId, TEST_ID_PATTERN } from './locators';

export const PROPOSE_TOOL = 'propose_repair';
export const REFUSE_TOOL = 'refuse_repair';
export const HEAL_MIN_CONFIDENCE = 0.7;

export const REFUSAL_CATEGORIES = ['ambiguous_target', 'element_missing', 'application_behaviour', 'not_a_locator_problem', 'insufficient_evidence', 'other'] as const;
export type RefusalCategory = (typeof REFUSAL_CATEGORIES)[number];

export interface Proposal {
  new_test_id: string;
  target_element: { tag: string; text: string };
  reason: string;
  confidence: number;
  evidence: Array<{ evidence_id: string; observation: string }>;
}

export interface Refusal {
  category: RefusalCategory;
  reason: string;
  evidence: Array<{ evidence_id: string; observation: string }>;
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RepairEdit {
  file: string;
  line: number;
  before: string;
  after: string;
  oldLocator: string;
  newLocator: string;
}

export interface CheckedProposal {
  proposal: Proposal;
  checks: Check[];
  edit: RepairEdit;
  /** The element the new locator resolves to (from the DOM snapshot that matched). */
  target: CandidateMatch;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function parseEvidence(v: unknown, errors: string[]): Array<{ evidence_id: string; observation: string }> {
  if (!Array.isArray(v) || v.some((e) => !isObj(e) || typeof e.evidence_id !== 'string' || typeof e.observation !== 'string')) {
    errors.push('evidence must be an array of {evidence_id, observation}');
    return [];
  }
  return (v as Array<{ evidence_id: string; observation: string }>).slice(0, 10).map((e) => ({ evidence_id: e.evidence_id.trim(), observation: clip(e.observation, 400) }));
}

export function parseRefusal(input: unknown): { ok: true; value: Refusal } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['input must be an object'] };
  if (!(REFUSAL_CATEGORIES as readonly unknown[]).includes(input.category)) errors.push(`category must be one of ${REFUSAL_CATEGORIES.join(', ')}`);
  if (typeof input.reason !== 'string' || !input.reason.trim()) errors.push('reason must be a non-empty string');
  const evidence = parseEvidence(input.evidence, errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { category: input.category as RefusalCategory, reason: clip((input.reason as string).trim(), 1500), evidence } };
}

export interface ProposalContext {
  plan: HealPlan;
  /** DOM snapshots of the affected tests (null where a trace had none). */
  snapshots: Array<{ testId: string; index: DomIndex | null }>;
  evidence: EvidenceStore;
  /** Candidates the agent verified with check_locator, by evidence id. */
  checkedCandidates: Map<string, string>;
}

/**
 * Structural + deterministic validation of a repair proposal. Every check must pass; failures are
 * returned to the model, which may correct the proposal or refuse.
 */
export function checkProposal(input: unknown, ctx: ProposalContext): { ok: true; value: CheckedProposal } | { ok: false; errors: string[]; checks: Check[] } {
  const errors: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ['input must be an object'], checks: [] };
  const { plan } = ctx;

  const newId = typeof input.new_test_id === 'string' ? input.new_test_id.trim() : '';
  const target = isObj(input.target_element) ? input.target_element : {};
  if (typeof target.tag !== 'string' || typeof target.text !== 'string') errors.push('target_element must be {tag, text}');
  if (typeof input.reason !== 'string' || !input.reason.trim()) errors.push('reason must be a non-empty string');
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) errors.push('confidence must be a number between 0 and 1');
  const evidence = parseEvidence(input.evidence, errors);
  if (errors.length) return { ok: false, errors, checks: [] };

  const proposal: Proposal = {
    new_test_id: newId,
    target_element: { tag: clip(String(target.tag).toLowerCase(), 40), text: clip(String(target.text), 200) },
    reason: clip((input.reason as string).trim(), 1500),
    confidence: input.confidence as number,
    evidence,
  };

  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add('test-id syntax', TEST_ID_PATTERN.test(newId), TEST_ID_PATTERN.test(newId) ? `"${newId}" is a plain test id` : 'new_test_id must match [A-Za-z0-9][A-Za-z0-9_.:-]{0,79} (no quotes, spaces or code)');
  add('changes the locator', newId !== plan.failing.testId, newId !== plan.failing.testId ? `"${plan.failing.testId}" → "${newId}"` : 'new_test_id equals the failing test id');
  add('confidence', proposal.confidence >= HEAL_MIN_CONFIDENCE, `${proposal.confidence.toFixed(2)} (minimum ${HEAL_MIN_CONFIDENCE})`);

  const cited = evidence.filter((e) => ctx.evidence.has(e.evidence_id));
  const verified = cited.some((e) => ctx.checkedCandidates.get(e.evidence_id) === newId);
  add('verified with check_locator', verified, verified ? 'evidence cites a check_locator result for this candidate' : `cite the evidence_id of a check_locator call for "${newId}"`);

  // DOM: unique within scope in every snapshot that contains it, and present in at least one.
  // Snapshots catch the element in different states (e.g. "Select variant" vs "Add to cart"), so
  // text-based checks accept a match in any snapshot; structure (tag, role) must hold in all.
  const matches: CandidateMatch[] = [];
  const perSnapshot: string[] = [];
  let ambiguous = false;
  for (const { testId, index } of ctx.snapshots) {
    if (!index) continue;
    const c = checkTestIdCandidate(index, newId, plan.scope);
    perSnapshot.push(`${testId}: ${c.inScope.length} in scope${plan.scope ? ` "${plan.scope}"` : ''} (${c.totalOnPage} on page)`);
    if (c.inScope.length > 1) ambiguous = true;
    if (c.inScope.length === 1) matches.push(c.inScope[0]!);
  }
  const matched = matches[0] ?? null;
  add('unique in DOM snapshot', !!matched && !ambiguous, `${perSnapshot.join('; ') || 'no snapshots'}${ambiguous ? ' — ambiguous' : matched ? '' : ' — not found'}`);

  if (matched) {
    const a = matches.map((m) => compatibleWithActions(m, plan.usage.actions)).find((r) => !r.ok) ?? compatibleWithActions(matched, plan.usage.actions);
    add('fits how the code uses it', a.ok, a.reason);
    const texts = matches.map((m) => compatibleWithTexts(m, plan.usage.expectedTexts));
    const t = texts.find((r) => r.ok) ?? texts[0]!;
    add('fits asserted texts', t.ok, t.reason);
    const want = proposal.target_element.text.toLowerCase().slice(0, 60);
    const describes = matches.some((m) => m.tag === proposal.target_element.tag && (!want || m.text.toLowerCase().includes(want)));
    add(
      'target description matches DOM',
      describes,
      describes
        ? `<${proposal.target_element.tag}> "${proposal.target_element.text}"`
        : `proposal describes <${proposal.target_element.tag}> "${proposal.target_element.text}" but the locator resolves to ${[...new Set(matches.map((m) => `<${m.tag}> "${m.text}"`))].join(' / ')}`,
    );
  }

  let edit: RepairEdit | null = null;
  if (TEST_ID_PATTERN.test(newId) && newId !== plan.failing.testId) {
    try {
      const after = replaceTestId(plan.location, plan.failing.testId, newId);
      const scoped = onlyTestIdLiteralChanged(plan.location.lineText, after);
      add('narrow one-line edit', scoped, scoped ? `${plan.location.file}:${plan.location.line}` : 'edit would change more than the test-id literal');
      if (scoped) {
        const q = plan.location.quote;
        edit = {
          file: plan.location.file,
          line: plan.location.line,
          before: plan.location.lineText,
          after,
          oldLocator: `getByTestId(${q}${plan.failing.testId}${q})`,
          newLocator: `getByTestId(${q}${newId}${q})`,
        };
      }
    } catch (e) {
      add('narrow one-line edit', false, (e as Error).message);
    }
  }

  const failed = checks.filter((c) => !c.passed);
  if (failed.length || !edit || !matched) {
    return { ok: false, errors: failed.map((c) => `${c.name}: ${c.detail}`), checks };
  }
  return { ok: true, value: { proposal, checks, edit, target: matched } };
}
