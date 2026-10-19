# automation/ — Playwright regression suite

Playwright + TypeScript regression tests for the Medusa AUT in [`../aut`](../aut). The suite talks to the
AUT only through its public surfaces — storefront UI, Store API and Admin API — and never imports AUT code.

## What is covered

| Spec | Tags | What it proves |
|---|---|---|
| `tests/storefront/navigation.spec.ts` | `@ui @smoke` | Country redirect, header shell, side-menu → store, cart link → empty cart, account → sign-in, unknown product → 404 |
| `tests/storefront/product-browsing.spec.ts` | `@ui` | Listing renders titles/prices; search finds a freshly created product and shows "no results" otherwise; price sort in both directions (exact order + prices); card → PDP; variant selection gates "Add to cart"; add-to-cart updates nav count and cart subtotal |
| `tests/orders/guest-checkout.ui.spec.ts` | `@ui @order @smoke` | Full guest checkout in the UI (cart → address → Standard Shipping → Manual Payment → place order), then verifies via Admin API: order status, payment `authorized`, totals, line item SKU/price, shipping method, address, and the inventory reservation |
| `tests/orders/order-lifecycle.api.spec.ts` | `@api @order` | Store-API checkout of 2 units reserves 2; admin sees the order; cancelling releases the reservation. Over-stock add-to-cart is rejected with 400 |
| `tests/diagnostics/deliberate-failure.spec.ts` | `@deliberate-failure` | **Off by default.** See [Deliberate failure](#deliberate-failure) |

## Layout

```
automation/
├── playwright.config.ts      # projects, reporters, artifacts, timeouts
├── src/
│   ├── config/env.ts         # all configuration (env vars + defaults)
│   ├── api/                  # AdminClient / StoreClient on Playwright's APIRequestContext
│   ├── fixtures/index.ts     # test fixtures: API clients, TestDataManager, page objects
│   ├── pages/                # page objects (data-testid based locators)
│   └── data/factories.ts     # unique ids, emails, addresses
├── tests/
│   ├── global-setup.ts       # AUT readiness check, admin login check, dev-server warm-up
│   ├── storefront/  orders/  diagnostics/
└── scripts/ci-summary.mjs    # Markdown summary of results.json for GitHub job summaries
```

## Design choices

- **Stable locators.** The storefront ships `data-testid`s on every relevant element; page objects use
  them (`getByTestId`), scoped to a container where a test id repeats (e.g. related-product cards reuse
  `product-title`). Role-based locators are used where there is no test id (payment radio by accessible name).
- **Isolation.** Each test that needs catalog data creates its own product through the Admin API
  (`testProduct` fixture / `testData.createProduct()`), with a unique handle, SKU and title, 10 units of stock
  at the sales channel's warehouse, and a known price. Tests never depend on, or modify, the seeded demo
  catalog, so they can run in parallel and in any order.
- **Cleanup.** `TestDataManager` runs after every test — pass or fail. It cancels every order placed by the
  test (tracked by order id and by the test's unique checkout email, so a UI test that dies after placing
  the order is still cleaned up), then deletes the products (Medusa also deletes their inventory items).
  Medusa cannot hard-delete orders, so cancelled orders with `aqa-*@agenticqa.test` emails remain as an
  audit trail. Cleanup errors are attached to the report and fail an otherwise passing test.
- **Backend verification.** UI flows assert on what the user sees *and* on backend state via the Admin API
  (exact totals, payment status, inventory reservations). Money is compared via the storefront's
  `data-value` attributes, not parsed currency strings.
- **No secrets in the repo.** Admin credentials are read from `AQA_ADMIN_EMAIL`/`AQA_ADMIN_PASSWORD` or,
  by default, from `../aut/.env` (generated, gitignored). The publishable key is discovered via the Admin API.

## Running locally

Prerequisite: the AUT is running (`cd ../aut && docker compose up -d`, see [docs/setup.md](../docs/setup.md)).

```bash
cd automation
npm ci
npx playwright install chromium
```

### Examples

All commands run from `automation/`.

```bash
# Full regression suite (13 tests)
npm test
# ...or call Playwright directly; any CLI flag works
npx playwright test

# Subsets by tag
npm run test:smoke                  # @smoke
npm run test:ui                     # @ui (browser tests)
npm run test:api                    # @api (Store/Admin API tests)
npx playwright test --grep @order   # any tag

# A single folder or file
npx playwright test tests/storefront
npx playwright test tests/orders/guest-checkout.ui.spec.ts

# A single test, by line number or by title
npx playwright test tests/storefront/navigation.spec.ts:32   # "cart link opens an empty cart..."
npx playwright test -g "sorting by price"

# Watch it run
npm run test:headed                                      # headed browser, 1 worker
npx playwright test --ui                                 # Playwright UI mode
npx playwright test -g "guest places an order" --debug   # step through with the inspector

# Check for flakiness
npx playwright test --repeat-each=3

# Open the HTML report of the last run
npm run report

# Open the trace of a failed test (path is printed in the test output)
npx playwright show-trace test-results/<test-folder>/trace.zip

# Typecheck the suite
npm run typecheck
```

Overriding settings with environment variables:

```bash
# Git Bash / macOS / Linux
AQA_WORKERS=1 npx playwright test
AQA_STOREFRONT_URL=http://localhost:8000 AQA_BACKEND_URL=http://localhost:9000 npx playwright test
```

```powershell
# PowerShell
$env:AQA_WORKERS = "1"; npx playwright test
```

Running the deliberately failing scenario (expected to fail, see [Deliberate failure](#deliberate-failure)):

```bash
npm run test:deliberate-failure            # assertion failure: payment "authorized" ≠ "captured"
npm run test:deliberate-failure:locator    # locator failure: stale data-testid
```

### Configuration

All optional; see `.env.example`, copy to `automation/.env`:

| Variable | Default | Purpose |
|---|---|---|
| `AQA_STOREFRONT_URL` | `http://localhost:8000` | Storefront base URL |
| `AQA_BACKEND_URL` | `http://localhost:9000` | Medusa API base URL |
| `AQA_COUNTRY_CODE` | `dk` | Storefront country route / region |
| `AQA_ADMIN_EMAIL` / `AQA_ADMIN_PASSWORD` | from `../aut/.env` | Admin API login for setup/cleanup |
| `AQA_WORKERS` | `2` | Parallel workers |
| `AQA_DELIBERATE_FAILURE` | `off` | `off` \| `assertion` \| `locator` |
| `AQA_READY_TIMEOUT_MS` | `180000` | How long global setup waits for the AUT |

## Reports and artifacts

| Path | Content |
|---|---|
| `reports/html/` | Playwright HTML report (`npm run report`) |
| `reports/results.json` | Machine-readable results (input for the future triage agent) |
| `reports/junit.xml` | JUnit XML |
| `reports/environment.json` | Run id, URLs, mode, commit — context for triage |
| `test-results/<test>/` | On failure only: `test-failed-*.png`, `trace.zip`, `video.webm`, `error-context.md` (page snapshot) |

Open a trace: `npx playwright show-trace test-results/<test>/trace.zip`.

## Deliberate failure

`tests/diagnostics/` is excluded from the `regression` project. A second project, `deliberate-failure`,
only exists when `AQA_DELIBERATE_FAILURE` is set to a mode, so the normal suite can never pick it up.

| Mode | Command | Failure it produces | Intended triage classification |
|---|---|---|---|
| `assertion` | `npm run test:deliberate-failure` | `payment_status` expected `captured`, received `authorized` (the confirmation page says "paid", checkout only authorizes) | Product/spec mismatch |
| `locator` | `npm run test:deliberate-failure:locator` | Timeout waiting for stale test id `add-to-bag-button` (real: `add-product-button`) | Broken locator → self-healing candidate |

Setting the variable and running plain `npx playwright test` runs the regression project *and* the
deliberate project: regression results are unaffected, the run exits non-zero because of the deliberate test.

## CI (GitHub Actions)

Workflow: [`.github/workflows/regression.yml`](../.github/workflows/regression.yml). Runs on push to `main`,
on pull requests, and manually (Actions → Regression → Run workflow, with a `deliberate_failure` choice).

It brings up a fresh AUT with the same compose stack and scripts used locally
(`init-env.sh` → `docker compose up --wait` → `create-admin.sh` → `get-publishable-key.sh` → storefront),
then `npm ci`, installs Chromium, typechecks and runs `npx playwright test`. Always uploaded:
`playwright-reports-<run>` (HTML/JSON/JUnit/environment + all AUT container logs). On failure also:
`playwright-test-results-<run>` (traces, screenshots, videos). A pass/fail table goes to the job summary.
The regression suite needs no repository secrets — AUT credentials are generated per run.

When the regression step fails, the [failure-triage agent](../agents/failure-triage) investigates the
artifacts and appends a classified diagnostic report to the job summary (artifact `failure-triage-<run>`).
It uses the Claude API only if the optional `ANTHROPIC_API_KEY` repository secret is set (paid per token);
otherwise it falls back to free deterministic heuristics. It never changes the job result.

## Known limitations

- **The AUT storefront runs `next dev`.** Routes compile on first hit and server actions are slow under load
  (one checkout step measured ~15 s with 3 workers; at 3 workers the dev server also reset a JS-chunk
  connection, leaving a page unhydrated). Hence: 2 workers, a warm-up in global setup, a 45 s budget for
  server-action / client-navigation steps, and `test.slow()` on the full UI checkout. Assertions are unchanged.
  Serving a production build (`next build && next start`) for test runs would remove most of this.
- **Search indexing is asynchronous.** Tests that look for a freshly created product in the listing poll
  (up to 45 s) until it is indexed.
- **Orders cannot be deleted** in Medusa; test orders are cancelled and left in place (`aqa-*` emails).
- Only Chromium is configured.
