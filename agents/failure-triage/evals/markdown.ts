import type { EvalSummary, Rate, TrialScore } from './score';

export interface RunInfo {
  model: string;
  effort: string;
  dryRun: boolean;
  repeat: number;
  startedAt: string;
  ceilingUsd: number;
}

const pct = (r: Rate | number | null): string => {
  const v = typeof r === 'number' || r === null ? r : r.rate;
  return v === null ? '—' : `${(v * 100).toFixed(0)}%`;
};
const frac = (r: Rate): string => `${pct(r)} (${r.hits}/${r.n})`;
const num = (v: number | null, digits = 2): string => (v === null ? '—' : v.toFixed(digits));
const usd = (v: number): string => `$${v.toFixed(v < 1 ? 3 : 2)}`;
const secs = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
/** Table cells: no pipes or newlines from labels. */
const cell = (s: string): string => s.replace(/[|\r\n]+/g, ' ').trim();

export function renderSummary(summary: EvalSummary, trials: TrialScore[], info: RunInfo): string {
  const o = summary.overall;
  const lines: string[] = [];
  lines.push(`## Failure-triage eval${info.dryRun ? ' (dry run: scripted fake model, heuristic baseline)' : ''}`, '');
  lines.push(
    `Model \`${info.model}\` (effort ${info.effort}), ${info.repeat} run(s) per scenario, ${o.trials} trials, started ${info.startedAt}.`,
    '',
  );
  if (!info.dryRun && o.agentModeTrials < o.trials) {
    lines.push(`> ⚠️ ${o.trials - o.agentModeTrials} of ${o.trials} trials fell back to heuristics (see errors below); their answers are scored as given.`, '');
  }

  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Accuracy (expected or acceptable) | ${frac(o.accuracy)} |`);
  lines.push(`| Exact accuracy | ${frac(o.exact)} |`);
  lines.push(`| Macro accuracy (mean over scenarios) | ${pct(o.macroAccuracy)} |`);
  lines.push(`| Calibration: ECE / Brier | ${num(summary.calibration.ece)} / ${num(summary.calibration.brier)} |`);
  lines.push(`| Wrong-diff blame (unrelated diff blamed) | ${frac(summary.wrongDiffBlame)} |`);
  lines.push(`| Followed planted injection | ${frac(summary.injectionFollowed)} |`);
  lines.push(`| Answers with dropped evidence ids | ${frac(summary.grounding.answersWithDroppedIds)} (${summary.grounding.droppedEvidenceIds} ids) |`);
  lines.push(`| Answers capped as ungrounded | ${frac(summary.grounding.answersCappedUngrounded)} |`);
  lines.push(`| Cited every expected evidence kind | ${frac(summary.evidence.expectedKindsCovered)} |`);
  lines.push(`| Tokens in / out (cache read) | ${summary.tokens.input.toLocaleString('en-US')} / ${summary.tokens.output.toLocaleString('en-US')} (${summary.tokens.cacheRead.toLocaleString('en-US')}) |`);
  lines.push(`| Estimated cost (ceiling) | ${usd(summary.costUsd)} (${usd(info.ceilingUsd)}) |`);
  lines.push(`| Duration total / mean per trial | ${secs(summary.durationMs.total)} / ${secs(summary.durationMs.meanPerTrial)} |`);
  lines.push('');

  lines.push('### Per scenario', '');
  lines.push('| Scenario | Diff | Accuracy | Answers given | Consistency | Mean conf. | Cost | Mean time |', '|---|---|---|---|---|---|---|---|');
  for (const s of summary.scenarios) {
    const dist = Object.entries(s.distribution)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c} ×${n}`)
      .join(', ');
    lines.push(`| ${cell(s.scenario)} | ${s.diff} | ${frac(s.accuracy)} | ${cell(dist) || '—'} | ${pct(s.consistency)} | ${num(s.meanConfidence)} | ${usd(s.costUsd)} | ${secs(s.meanDurationMs)} |`);
  }
  lines.push('');

  lines.push('### Calibration (reported confidence vs. correctness)', '');
  lines.push('| Confidence | Answers | Mean confidence | Accuracy | Gap |', '|---|---|---|---|---|');
  for (const b of summary.calibration.buckets) {
    lines.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${num(b.meanConfidence)} | ${pct(b.accuracy)} | ${b.gap === null ? '—' : `${b.gap >= 0 ? '+' : ''}${b.gap.toFixed(2)}`} |`);
  }
  lines.push('', 'Negative gap = over-confident in that bucket.', '');

  const wrong = trials.flatMap((t) => t.tests.filter((a) => !a.correct).map((a) => ({ t, a })));
  if (wrong.length) {
    lines.push('### Wrong answers', '');
    lines.push('| Scenario | Trial | Test | Expected | Got | Confidence | Cited kinds |', '|---|---|---|---|---|---|---|');
    for (const { t, a } of wrong.slice(0, 40)) {
      lines.push(`| ${cell(t.scenario)} | ${t.trial} | ${cell(a.title).slice(0, 80)} | ${a.expected} | ${a.classification}${a.source === 'heuristic' ? ' (heuristic)' : ''} | ${a.confidence.toFixed(2)} | ${a.citedKinds.join(', ') || '—'} |`);
    }
    if (wrong.length > 40) lines.push('', `…and ${wrong.length - 40} more in results.json.`);
    lines.push('');
  }

  const missing = Object.entries(summary.evidence.missing);
  const problems = [
    ...missing.map(([k, n]) => `expected evidence kind \`${k}\` not cited in ${n} answer(s)`),
    ...Object.entries(summary.limitsHit).map(([k, n]) => `limit hit: ${cell(k)} ×${n}`),
    ...Object.entries(summary.errors).map(([k, n]) => `agent error: ${cell(k).slice(0, 200)} ×${n}`),
  ];
  if (problems.length) lines.push('### Notes', '', ...problems.map((p) => `- ${p}`), '');
  return `${lines.join('\n')}\n`;
}
