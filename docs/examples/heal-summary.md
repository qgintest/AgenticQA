## 🩹 Self-heal

**✅ Validated: pull request will be prepared**: getByTestId\('add\-bag\-button'\) → getByTestId\('add\-product\-button'\): 3 failing test\(s\) and 6 related test\(s\) passed

Broken locator `getByTestId('add-bag-button')` at `automation/src/pages/product-page.ts:12` (property `addToCartButton`) · affected tests: T1, T2, T3

Proposed: `getByTestId('add-bag-button')` → `getByTestId('add-product-button')`

**Reason:** addToCartButton is clicked in addToCart. Tests assert the texts "Add to cart" and "Select variant" and the states enabled and disabled. In all three failure snapshots, the only matching button inside product\-container has data\-testid 'add\-product\-button'. It reads "Add to cart", or is disabled with "Select variant" before a variant is chosen. 'add\-bag\-button' is not on the page. The page renders normally with no sign of an application defect, and no suspicious instructions were found in the evidence.

| Check | Result | Detail |
|---|---|---|
| test\-id syntax | ✅ | "add\-product\-button" is a plain test id |
| changes the locator | ✅ | "add\-bag\-button" → "add\-product\-button" |
| confidence | ✅ | 0.92 \(minimum 0.7\) |
| verified with check\_locator | ✅ | evidence cites a check\_locator result for this candidate |
| unique in DOM snapshot | ✅ | T1: 1 in scope \(1 on page\); T2: 1 in scope \(1 on page\); T3: 1 in scope \(1 on page\) |
| fits how the code uses it | ✅ | &lt;button&gt; \(role button\) supports click |
| fits asserted texts | ✅ | element text "Add to cart" matches asserted text "Add to cart" |
| target description matches DOM | ✅ | &lt;button&gt; "Add to cart" |
| narrow one\-line edit | ✅ | automation/src/pages/product\-page.ts:12 |

| Phase | Passed | Failed | Skipped | Missing | Duration |
|---|---|---|---|---|---|
| failing\-tests | 3 | 0 | 0 | 0 | 33 s |
| related\-specs | 6 | 0 | 0 | 0 | 38 s |

<sub>failing\-tests ran: orders/guest\-checkout.ui.spec.ts:9, storefront/product\-browsing.spec.ts:57, storefront/product\-browsing.spec.ts:85</sub>

<sub>related\-specs ran: tests/orders/guest\-checkout.ui.spec.ts, tests/storefront/product\-browsing.spec.ts</sub>

<sub>Agent: 4 model turns · 7 tool calls · 30,149 input / 1,155 output tokens · ≈ $0.14 · 16.2 s</sub>

<sub>Self-heal never changes the regression result. Repairs are proposed as pull requests that need human review; nothing is merged automatically.</sub>
