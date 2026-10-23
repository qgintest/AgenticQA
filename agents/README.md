# agents/

Agentic QA services. Agents must not import application code from `../aut` or test code from
`../automation`; they work from the AUT's public surfaces and from test artifacts.

| Agent | Purpose | Status |
|---|---|---|
| [`failure-triage/`](failure-triage) | Investigates failed Playwright runs with read-only tools and classifies each failure (Claude API tool-use loop). Runs in CI after a failed regression. | ✅ |
| [`failure-triage/`](failure-triage#self-heal-locator-repair) (self-heal) | Repairs stale `getByTestId` locators for AI-classified automation defects: validates in a worktree against the same AUT, opens a pull request for review and starts CI on it | ✅ |
