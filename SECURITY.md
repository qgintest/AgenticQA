# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub:
**Security** tab → **Report a vulnerability**
([direct link](https://github.com/qgintest/AgenticQA/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. This is a personal portfolio
project maintained on a best-effort basis: expect an acknowledgement within a few days. Fixes go to the
`main` branch, the only supported version.

## Scope

In scope: the agents (`agents/`), the workflows (`.github/workflows/`), the test suite (`automation/`)
and the setup scripts. Examples:
- a way to make the agents follow instructions planted in logs, pages or source code;
- a path for fork pull requests to reach the `ANTHROPIC_API_KEY` secret or a write token;
- self-heal changing anything beyond a single `getByTestId` literal, or merging without review;
- secrets leaking into job summaries, artifacts or agent reports.

Out of scope: vulnerabilities in the Medusa application itself (`aut/` is an unmodified starter
used only as a test target; report those to [Medusa](https://github.com/medusajs/medusa/security)),
and findings that need a malicious maintainer of this repository.

## Security model (summary)

- The AI agents only have read-only tools, sandboxed to test artifacts and test sources; they cannot
  write files or run commands.
- The API key is exposed to two workflow steps only, and is never available to pull requests from forks.
- Only a separate job without AI or API key can push a branch or open a pull request, and it re-verifies
  the patch first. Nothing is merged automatically, and the regression result is never changed by the agents.
- Secrets are redacted from everything the agents read and write; all artifact content is treated as
  untrusted input.

Details: [agents/failure-triage/README.md](agents/failure-triage/README.md#safety-and-limits).
