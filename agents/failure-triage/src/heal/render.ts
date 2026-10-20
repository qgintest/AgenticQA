import { codeSpan, fence, mdEscape, mdInline } from '../render';
import type { HealResult } from './result';

const STATUS: Record<HealResult['status'], string> = {
  not_eligible: '⏭️ Not eligible',
  refused: '🛑 Refused',
  rejected: '🚫 Proposal rejected by checks',
  error: '⚠️ Did not finish',
  proposed: '📝 Proposed (not validated)',
  validated: '✅ Validated: pull request will be prepared',
  failed_validation: '❌ Failed validation',
};

function checksTable(r: HealResult): string[] {
  if (!r.checks.length) return [];
  return ['| Check | Result | Detail |', '|---|---|---|', ...r.checks.map((c) => `| ${mdInline(c.name)} | ${c.passed ? '✅' : '❌'} | ${mdInline(c.detail, 300)} |`), ''];
}

function validationTable(r: HealResult): string[] {
  const phases = r.validation?.phases ?? [];
  if (!phases.length) return [];
  const out = ['| Phase | Passed | Failed | Skipped | Missing | Duration |', '|---|---|---|---|---|---|'];
  for (const p of phases) out.push(`| ${mdInline(p.name)} | ${p.passed} | ${p.failed} | ${p.skipped} | ${p.missing.length} | ${(p.durationMs / 1000).toFixed(0)} s |`);
  out.push('');
  for (const p of phases) {
    out.push(`<sub>${mdInline(p.name)} ran: ${p.targets.map((t) => mdInline(t, 120)).join(', ')}</sub>`, '');
    for (const f of p.failures.slice(0, 5)) out.push(`- ❌ ${mdInline(f.title, 160)}: ${mdInline(f.error, 300)}`);
    if (p.failures.length) out.push('');
  }
  return out;
}

function evidenceList(r: HealResult): string[] {
  if (!r.evidence.length) return [];
  const out = ['**Evidence**', ''];
  for (const e of r.evidence) {
    out.push(`- **${mdInline(e.evidenceId)}** · ${mdInline(e.source, 120)}: ${mdInline(e.observation, 400)}`);
    if (e.excerpt) out.push('', fence(e.excerpt.slice(0, 400)), '');
  }
  out.push('');
  return out;
}

/** Job-summary section for every outcome. */
export function renderHealSummary(r: HealResult): string {
  const out = ['## 🩹 Self-heal', '', `**${STATUS[r.status]}**: ${mdEscape(r.reason)}`, ''];
  if (r.plan) {
    out.push(
      `Broken locator ${codeSpan(r.plan.failingLocator, 160)} at ${codeSpan(`${r.plan.file}:${r.plan.line}`)}` +
        `${r.plan.property ? ` (property ${codeSpan(r.plan.property)})` : ''} · affected tests: ${r.plan.tests.map((t) => mdInline(t.id)).join(', ')}`,
      '',
    );
  }
  if (r.edit) out.push(`Proposed: ${codeSpan(r.edit.oldLocator, 160)} → ${codeSpan(r.edit.newLocator, 160)}`, '');
  if (r.proposal) out.push(`**Reason:** ${mdEscape(r.proposal.reason)}`, '');
  if (r.refusal) out.push(`**Refusal (${mdInline(r.refusal.category)}):** ${mdEscape(r.refusal.reason)}`, '');
  out.push(...checksTable(r), ...validationTable(r));
  if (r.notes.length) out.push('<details><summary>Gate notes</summary>', '', ...r.notes.map((n) => `- ${mdInline(n, 300)}`), '', '</details>', '');
  const a = r.agent;
  if (a) {
    out.push(
      `<sub>Agent: ${a.iterations} model turns · ${a.toolCalls.length} tool calls · ${a.usage.inputTokens.toLocaleString('en-US')} input / ${a.usage.outputTokens.toLocaleString('en-US')} output tokens` +
        `${a.costUsd !== undefined ? ` · ≈ $${a.costUsd.toFixed(2)}` : ''} · ${(a.durationMs / 1000).toFixed(1)} s${a.limitsHit.length ? ` · limits hit: ${mdInline(a.limitsHit.join(', '))}` : ''}</sub>`,
      '',
    );
  }
  out.push('<sub>Self-heal never changes the regression result. Repairs are proposed as draft pull requests for human review.</sub>', '');
  return out.join('\n');
}

/** Body of the draft pull request (only for validated repairs). */
export function renderPrBody(r: HealResult): string {
  if (r.status !== 'validated' || !r.edit || !r.plan || !r.proposal || !r.target) throw new Error('PR body requires a validated repair');
  const out = [
    '## 🩹 Automated locator repair (draft — needs human review)',
    '',
    `A regression run failed because ${codeSpan(r.edit.oldLocator, 160)} no longer finds its element. The self-heal agent proposes a one-line change of the test id only; it did not change assertions, test data or application code.`,
    '',
    '| | |',
    '|---|---|',
    `| File | ${codeSpan(`${r.edit.file}:${r.edit.line}`)} |`,
    `| Page-object property | ${r.plan.property ? codeSpan(r.plan.property) : 'n/a'} |`,
    `| Original locator | ${codeSpan(r.edit.oldLocator, 160)} |`,
    `| Proposed locator | ${codeSpan(r.edit.newLocator, 160)} |`,
    `| Target element | ${mdInline(`<${r.target.tag}> "${r.target.text}"`, 200)}${r.target.role ? ` (role ${mdInline(r.target.role)})` : ''} |`,
    `| Scope | ${r.plan.scope ? codeSpan(r.plan.scope) : 'page'} |`,
    `| Agent confidence | ${r.proposal.confidence.toFixed(2)} |`,
    '',
    '### Reason',
    '',
    mdEscape(r.proposal.reason),
    '',
    '### Diff',
    '',
    fence(r.validation?.patch ?? ''),
    '',
    '### Deterministic checks',
    '',
    ...checksTable(r),
    '### Validation (same AUT build and environment as the failed run)',
    '',
    ...validationTable(r),
    ...evidenceList(r),
    '### Originally failing tests',
    '',
    ...r.plan.tests.map((t) => `- ${mdInline(t.id)}: ${mdInline(t.title, 200)}`),
    '',
    '### Review checklist',
    '',
    '- [ ] The proposed test id belongs to the element the test intends to use (not just *an* element that makes it pass).',
    '- [ ] The original test id was renamed or removed on purpose in the application; it is not an application regression.',
    '- [ ] CI is green on this PR (PRs opened by the workflow token do not trigger CI automatically: re-run the Regression workflow on this branch, or close and reopen the PR).',
    '',
    `<sub>Generated by the AgenticQA self-heal agent${r.run.url ? ` from [this run](${r.run.url})` : ''}. The failed regression run stays failed. Never auto-merged.</sub>`,
    '',
  ];
  return out.join('\n');
}
