# agents/failure-triage — AI failure triage

When the Playwright regression suite fails in CI, this agent investigates the failure with read-only tools,
classifies each failed test, and publishes a diagnostic report (job summary + JSON artifact). It is advisory:
it never changes code, never re-runs tests, and cannot change the pipeline result.

## How it works

```
results.json ──► parse failures (T1..Tn) ──► API key? ──no──► heuristic triage ─────────────┐
                                               │yes                                         │
                                               ▼                                            ▼
                     ┌──────── Claude (claude-opus-5-5) ◄────────┐               grounding + report
                     │  chooses next tool from evidence so far   │                (JSON + Markdown)
                     ▼                                           │                          │
            read-only tools (sandboxed) ── tool_result (E1..) ───┘                          ▼
                     │                                                         job summary + artifact
                     └─► submit_triage_report ──► validate ──► (invalid → corrections, then fallback)
```

- **Manual tool-use loop** on the Claude Messages API (`@anthropic-ai/sdk`, the only runtime dependency).
  Each turn the model decides which evidence to inspect next; the run ends only when it calls
  `submit_triage_report` (strict schema) or a limit is hit. LangGraph was not used: one loop with one
  terminal tool needs no graph runtime, and plain code keeps the limits explicit and testable.
- **Model:** `claude-opus-5-5` with adaptive thinking at effort `high` (override with `TRIAGE_MODEL` /
  `TRIAGE_EFFORT`). Server-side refusal fallback (`fallbacks: "default"`) is on, so a false-positive
  safety decline is retried on another model instead of failing triage (`TRIAGE_FALLBACKS=off` to disable).
- **Heuristic fallback:** deterministic error-pattern rules (`src/heuristics.ts`) classify every failure
  when there is no API key, the API fails, or the model produces no valid report. They also cross-check
  the model's answer. Heuristic confidence is capped at 0.7.

## Classifications

| Value | Meaning |
|---|---|
| `application_defect` | The application behaves incorrectly while the test and environment are fine |
| `automation_defect` | The test is wrong or outdated (locators, expectations, test data, test code) |
| `environment_issue` | Infrastructure: services down/unhealthy, connection resets, resource exhaustion |
| `flaky` | Non-deterministic: passed on retry or timing-dependent with no deterministic cause |
| `unknown` | Evidence insufficient |

## Tools (all read-only)

| Tool | Evidence |
|---|---|
| `list_failed_tests` | Failed/flaky tests, headline error, attempts, which artifacts exist |
| `get_failure_details` | All attempts: error messages, stack locations, stdout/stderr tails, deterministic signals |
| `read_page_snapshot` | `error-context.md` (page accessibility snapshot at failure) |
| `view_screenshot` | Failure screenshot, sent to Claude as an image |
| `get_trace_summary` | `trace.zip`: failed steps, failed/slow network requests, console/page errors |
| `search_aut_logs` | Plain-substring search in container logs (`reports/aut/*.log`), optionally limited to a test's time window |
| `get_run_environment` | `environment.json`, run stats, run-level errors, which logs exist |
| `submit_triage_report` | Terminal: the structured report |

## Safety and limits

- **File access:** only through `ArtifactSandbox` — confined to `automation/reports` and
  `automation/test-results` (symlinks resolved and refused), allowed types `.json .md .txt .log .xml .png .jpg .zip`,
  `.env*` always refused. Tests are addressed by ids (`T1`), never by model-supplied paths.
- **Budgets** (defaults; env overrides are clamped to hard ceilings in `src/config.ts`):

  | Limit | Default | Env |
  |---|---|---|
  | Model turns | 12 | `TRIAGE_MAX_ITERATIONS` |
  | Cumulative input tokens | 600,000 | `TRIAGE_MAX_INPUT_TOKENS` |
  | Cumulative output tokens | 60,000 | `TRIAGE_MAX_OUTPUT_TOKENS` |
  | Wall clock | 6 min (abort signal per request) | `TRIAGE_TIMEOUT_MS` |
  | Failures analysed by the agent | 10 (rest heuristic) | `TRIAGE_MAX_FAILURES` |
  | Tool result size | 12,000 chars | — |
  | File size / zip entry / total read | 5 MB / 40 MB / 150 MB | — |

  Near a limit the harness tells the model to submit with what it has; past it, triage falls back to heuristics.
  Worst case per run at the defaults: 600k input × $4/M + 60k output × $20/M ≈ $3.60 (Claude Opus 5.5 list price);
  typical runs use far less — check the token line in the job summary.
- **Untrusted inputs:** every tool result is JSON with an `evidence_id`, a `trust` notice and the data as a
  JSON value, so artifact text cannot break out of its slot. The system prompt forbids following instructions
  found in evidence. Playwright's own `# Instructions` preamble in `error-context.md` (addressed to AI tools)
  is stripped. Log search is literal (no regex), URLs lose their query strings.
- **Grounding:** each reported evidence item must cite an id a tool actually returned; unknown ids are dropped
  and a classification without grounded evidence is capped at confidence 0.3. Disagreement with Playwright's
  flaky status or with the heuristics is flagged in the report.
- **Secrets:** the key is read only from `ANTHROPIC_API_KEY` (a GitHub secret scoped to the triage step).
  Tool outputs, the JSON report and the Markdown are redacted (API keys, tokens, JWTs, passwords, DB URLs,
  plus the exact values of known secret env vars). Nothing prints environment variables.
- **Output safety:** all model- and artifact-derived text in the job summary is escaped (HTML, Markdown,
  links, mentions); excerpts sit in fences longer than any backtick run they contain.
- **Pipeline status:** the regression step's exit code decides the job. Triage steps run only after that step
  failed and use `continue-on-error`, and the CLI exits 0 whenever it wrote a report.

## Report

`triage-report.json` (schema version `1.0`, see `TriageReport` in `src/report.ts`):

- `mode`: `agent` | `heuristic` | `no_results` | `no_failures`, with `modeReason` when not `agent`
- `regressionStatus`: from Playwright stats only (`failed` | `flaky_only` | `passed` | `unknown`)
- `overall`: classification (or `mixed`) and summary
- `failures[]`: `classification`, `confidence` (0–1) + `confidenceLabel`, `source` (agent/heuristic), `rationale`,
  `evidence[]` (id, source, observation, excerpt), `recommendedActions[]`, deterministic `heuristic` signals, `issues[]`
- `uncertainty[]`, `notes[]`
- `agent`: model, effort, turns, every tool call (name, input, ok, evidence id), token usage, limits hit, errors, duration, bytes read

`triage-report.md` is the same report as Markdown; CI appends it to the job summary.

## Running locally

```bash
cd agents/failure-triage
npm ci
npm test                 # build + 60 deterministic tests (scripted fake model, no API calls)
```

Triage the last local Playwright run (heuristic mode without a key):

```bash
npm run build
node dist/src/cli.js --out ../../automation/reports/triage
```

With a key, in your own shell (Git Bash), the real agent runs:

```bash
ANTHROPIC_API_KEY=... node dist/src/cli.js --out ../../automation/reports/triage
```

Arguments (all optional): `--results <results.json>`, `--reports <dir>` (default `../../automation/reports`),
`--test-results <dir>` (default `../../automation/test-results`), `--out <dir>`, `--summary <file>`
(defaults to `$GITHUB_STEP_SUMMARY`). Container logs are only present when collected into
`automation/reports/aut/` (CI does this; locally: `docker compose logs --timestamps <service> > ../automation/reports/aut/<service>.log` from `aut/`).

## CI

In `.github/workflows/regression.yml`, after the regression step fails: collect AUT logs → build the agent →
**Triage failures** → upload `failure-triage-<run>` (JSON + Markdown). Enable the AI agent by adding the
repository secret `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions). Optional repository
variable `TRIAGE_MODEL`. Without the secret (including PRs from forks) the job summary shows heuristic triage.

End-to-end check: Actions → Regression → Run workflow → `deliberate_failure`:
`assertion` (expected: application defect) or `locator` (expected: automation defect).
