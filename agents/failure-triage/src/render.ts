import type { FailureTriage, TriageReport } from './report';

/**
 * Markdown for the GitHub job summary. Every model- or artifact-derived string is escaped so it
 * cannot inject markup, links or HTML; excerpts are placed in fences longer than any backtick run
 * they contain.
 */

export function mdEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+!|~-])/g, '\\$1')
    .replace(/\b(https?|ftp|file|javascript|data):/gi, '$1&#58;')
    .replace(/@/g, '&#64;');
}

/** Single-line escaped text, for table cells and headings. */
export function mdInline(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return mdEscape(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

/**
 * Text inside raw HTML blocks (e.g. a `<details><summary>` line): GitHub does not parse Markdown
 * there, so backslash escapes would show literally. Escape for HTML only.
 */
export function htmlInline(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return (flat.length > max ? `${flat.slice(0, max - 1)}…` : flat)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline code: content is literal (no escapes apply), so only backticks and newlines are removed. */
export function codeSpan(text: string, max = 100): string {
  const flat = text.replace(/[`\r\n]+/g, ' ').trim();
  return `\`${flat.length > max ? `${flat.slice(0, max - 1)}…` : flat}\``;
}

export function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

const LABEL: Record<string, string> = {
  application_defect: '🐞 Application defect',
  automation_defect: '🧪 Automation defect',
  environment_issue: '🏗️ Environment issue',
  flaky: '🎲 Flaky',
  unknown: '❔ Unknown',
  mixed: '🔀 Mixed',
};

function failureSection(f: FailureTriage): string {
  const lines: string[] = [];
  lines.push(`<details><summary><b>${htmlInline(f.testId)}</b> ${htmlInline(f.title, 120)}: ${LABEL[f.classification]} (${f.confidenceLabel}, ${f.confidence.toFixed(2)})</summary>`, '');
  lines.push(`**Failure:** ${mdInline(f.headline, 300)}`, '');
  lines.push(`**Where:** ${mdInline(f.file || '(none)')} · project ${mdInline(f.project)} · outcome ${mdInline(f.outcome)} · classified by ${f.source}`, '');
  lines.push(`**Rationale:** ${mdEscape(f.rationale)}`, '');
  if (f.evidence.length) {
    lines.push('**Evidence**', '');
    for (const e of f.evidence) {
      lines.push(`- **${mdInline(e.evidenceId)}** · ${mdInline(e.source, 120)}: ${mdInline(e.observation, 400)}`);
      if (e.excerpt) lines.push('', fence(e.excerpt.slice(0, 400)), '');
    }
    lines.push('');
  }
  if (f.recommendedActions.length) {
    lines.push('**Recommended next actions**', '', ...f.recommendedActions.map((a, i) => `${i + 1}. ${mdInline(a, 300)}`), '');
  }
  if (f.issues.length) lines.push('**Review notes**', '', ...f.issues.map((i) => `- ⚠️ ${mdInline(i, 300)}`), '');
  const h = f.heuristic;
  lines.push(
    `<sub>Deterministic signals: ${h.signals.length ? h.signals.map((s) => `${mdInline(s.description, 80)} → ${s.classification}`).join('; ') : 'none'} (heuristic verdict: ${h.classification}, ${h.confidence.toFixed(2)})</sub>`,
    '',
    '</details>',
    '',
  );
  return lines.join('\n');
}

export function renderMarkdown(report: TriageReport): string {
  const out: string[] = ['## 🤖 Failure triage', ''];
  if (report.mode === 'agent') {
    out.push(`> AI triage by ${codeSpan(report.agent?.model ?? 'unknown')}: evidence gathered with read-only tools. Advisory only: **the regression result is unchanged.**`);
  } else if (report.mode === 'heuristic') {
    out.push(`> ⚠️ **Heuristic triage only**: ${mdInline(report.modeReason ?? 'AI agent unavailable', 300)}. Classifications come from deterministic error-pattern rules. The regression result is unchanged.`);
  } else if (report.mode === 'no_results') {
    out.push(`> ⚠️ **No test results to triage**: ${mdInline(report.modeReason ?? 'results.json missing', 300)}`);
  } else {
    out.push('> ✅ No failed or flaky tests in this run.');
  }
  out.push('');

  if (report.failures.length) {
    out.push(`**Overall:** ${LABEL[report.overall.classification]} · regression status: ${codeSpan(report.regressionStatus)}`, '');
    out.push(mdEscape(report.overall.summary), '');
    out.push('| Test | Title | Classification | Confidence | By |', '|---|---|---|---|---|');
    for (const f of report.failures) {
      out.push(`| ${mdInline(f.testId)} | ${mdInline(f.title, 90)} | ${LABEL[f.classification]} | ${f.confidenceLabel} (${f.confidence.toFixed(2)}) | ${f.source} |`);
    }
    out.push('');
    for (const f of report.failures) out.push(failureSection(f));
  }

  if (report.uncertainty.length) {
    out.push('**Uncertainty**', '', ...report.uncertainty.map((u) => `- ${mdInline(u, 400)}`), '');
  }
  if (report.notes.length) out.push(...report.notes.map((n) => `- ${mdInline(n, 300)}`), '');

  const a = report.agent;
  if (a) {
    const tools = a.toolCalls.map((c) => c.name).reduce<Record<string, number>>((m, n) => ((m[n] = (m[n] ?? 0) + 1), m), {});
    out.push(
      `<sub>Agent: ${a.iterations} model turns · ${a.toolCalls.length} tool calls (${Object.entries(tools).map(([n, c]) => `${mdInline(n, 40)}×${c}`).join(', ') || 'none'}) · ` +
        `${a.usage.inputTokens.toLocaleString('en-US')} input / ${a.usage.outputTokens.toLocaleString('en-US')} output tokens · ${(a.durationMs / 1000).toFixed(1)} s · ` +
        `${(a.bytesRead / 1024).toFixed(0)} KiB read${a.limitsHit.length ? ` · limits hit: ${mdInline(a.limitsHit.join(', '))}` : ''}${a.errors.length ? ` · errors: ${mdInline(a.errors.join('; '), 300)}` : ''}</sub>`,
      '',
    );
  }
  out.push('<sub>Full report: <code>triage-report.json</code> in the <code>failure-triage-*</code> artifact.</sub>', '');
  return out.join('\n');
}
