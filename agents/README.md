# agents/

Agentic QA services. Agents must not import application code from `../aut` or test code from
`../automation`; they work from the AUT's public surfaces and from test artifacts.

| Agent | Purpose | Status |
|---|---|---|
| [`failure-triage/`](failure-triage) | Investigates failed Playwright runs with read-only tools and classifies each failure (Claude API tool-use loop). Runs in CI after a failed regression. | ✅ |
| self-healing | Proposes fixes for automation defects | planned |
