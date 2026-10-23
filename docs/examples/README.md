# Example outputs

Real outputs from one CI run, not mock-ups: [Regression run 39614398147](https://github.com/qgintest/AgenticQA/actions/runs/39614398147),
where a page-object locator had been broken on purpose (`add-product-button` → `add-bag-button`).
Both agents ran on Claude Opus 5.5. The files are copied unchanged from the run's artifacts and were
scanned for secrets, tokens and personal data before committing (none found; the agents redact them anyway).

| File | Produced by | What it is |
|---|---|---|
| [`triage-report.md`](triage-report.md) | Triage agent | The human-readable report that was posted to the job summary |
| [`triage-report.json`](triage-report.json) | Triage agent | The same report as structured data (schema `1.0`) |
| [`heal-summary.md`](heal-summary.md) | Self-heal agent | The job-summary section: proposal, checks, validation |
| [`heal-result.json`](heal-result.json) | Self-heal agent | The full structured result: plan, proposal, checks, edit, evidence, validation |
| [`repair.patch`](repair.patch) | Validation step | The validated one-line diff that the PR job applied |
| [`repair-pr-body.md`](repair-pr-body.md) | PR job | The body of the repair pull request, [PR #4](https://github.com/qgintest/AgenticQA/pull/4) |

## What to look for

**Triage (`triage-report.json`)**
- **It investigated rather than guessed:** `agent.toolCalls` shows 13 read-only tool calls over 5 model
  turns (failure details for each test, DOM snapshots, the code diff), then a single
  `submit_triage_report`.
- **The evidence is grounded:** each failure cites evidence ids (`E4`, `E7`, …) that map to real tool
  results, with an excerpt of what each tool returned. Ids the agent never received would be dropped
  and listed under `issues`, which is empty here.
- **It's calibrated:** confidence is 0.75, not 0.95, because high confidence requires two independent
  kinds of evidence. `uncertainty` lists what the agent could not verify.
- **The cost is visible:** about 90k input and 3k output tokens, 41 s (≈ $0.43).

**Self-heal (`heal-result.json`)**
- **Plan (from the gate, no AI):** which locator broke, where (`product-page.ts:12`), how the code uses
  it (clicked; asserted to read "Add to cart" / "Select variant"), and which specs depend on it.
- **Proposal (from the model):** only the new test id, the target element and a reason. File and line
  come from the gate, so the model can't point the edit elsewhere.
- **Checks:** all 9 deterministic checks passed, for example *unique in DOM snapshot: T1: 1 in scope;
  T2: 1; T3: 1*, and *narrow one-line edit*.
- **Validation:** the 3 originally failing tests passed, then 6 related tests, against the same app build.
- **Cost:** 4 model turns, 7 tool calls (three `check_locator` calls, one per failure snapshot), ≈ $0.14.

The schemas are documented in [agents/failure-triage/README.md](../../agents/failure-triage/README.md#report).
