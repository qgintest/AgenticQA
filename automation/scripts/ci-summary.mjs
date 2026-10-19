// Prints a Markdown summary of reports/results.json (Playwright JSON reporter) to stdout.
// Used for $GITHUB_STEP_SUMMARY; safe to run locally: `node scripts/ci-summary.mjs`.
import fs from 'node:fs';

const file = new URL('../reports/results.json', import.meta.url);
if (!fs.existsSync(file)) {
  console.log('## Regression\n\nNo `reports/results.json` — the suite did not run (see earlier steps).');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const { expected = 0, unexpected = 0, flaky = 0, skipped = 0, duration = 0 } = report.stats ?? {};

const failures = [];
const walk = (suite, trail) => {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests) {
      if (t.status === 'unexpected' || t.status === 'flaky') {
        const last = t.results.at(-1);
        const message = (last?.error?.message ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
        failures.push({ status: t.status, project: t.projectName, title: [...trail, spec.title].join(' › '), message });
      }
    }
  }
  for (const child of suite.suites ?? []) walk(child, [...trail, child.title]);
};
for (const s of report.suites ?? []) walk(s, [s.title]);

const icon = unexpected ? '❌' : flaky ? '⚠️' : '✅';
console.log(`## ${icon} Regression`);
console.log('');
console.log('| Passed | Failed | Flaky | Skipped | Duration |');
console.log('|---|---|---|---|---|');
console.log(`| ${expected} | ${unexpected} | ${flaky} | ${skipped} | ${(duration / 1000).toFixed(0)}s |`);
if (failures.length) {
  console.log('\n| Status | Project | Test | Error |\n|---|---|---|---|');
  for (const f of failures) {
    console.log(`| ${f.status} | ${f.project} | ${f.title.replace(/\|/g, '\\|')} | ${f.message.replace(/\|/g, '\\|').slice(0, 200)} |`);
  }
}
console.log('\nDownload the `playwright-reports-*` artifact and open `html/index.html`; traces are in `playwright-test-results-*`.');
