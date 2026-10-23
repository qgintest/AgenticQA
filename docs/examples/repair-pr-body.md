## 🩹 Automated locator repair (needs human review)

A regression run failed because `getByTestId('add-bag-button')` no longer finds its element. The self-heal agent proposes a one-line change of the test id only; it did not change assertions, test data or application code.

| | |
|---|---|
| File | `automation/src/pages/product-page.ts:12` |
| Page-object property | `addToCartButton` |
| Original locator | `getByTestId('add-bag-button')` |
| Proposed locator | `getByTestId('add-product-button')` |
| Target element | &lt;button&gt; "Add to cart" (role button) |
| Scope | page |
| Agent confidence | 0.92 |

### Reason

addToCartButton is clicked in addToCart. Tests assert the texts "Add to cart" and "Select variant" and the states enabled and disabled. In all three failure snapshots, the only matching button inside product\-container has data\-testid 'add\-product\-button'. It reads "Add to cart", or is disabled with "Select variant" before a variant is chosen. 'add\-bag\-button' is not on the page. The page renders normally with no sign of an application defect, and no suspicious instructions were found in the evidence.

### Diff

```text
diff --git a/automation/src/pages/product-page.ts b/automation/src/pages/product-page.ts
index f1ea371..5291462 100644
--- a/automation/src/pages/product-page.ts
+++ b/automation/src/pages/product-page.ts
@@ -9,7 +9,7 @@ export class ProductPage extends BasePage {
   readonly description: Locator = this.container.getByTestId('product-description');
   readonly options: Locator = this.container.getByTestId('product-options');
   readonly price: Locator = this.container.getByTestId('product-price').first();
-  readonly addToCartButton: Locator = this.page.getByTestId('add-bag-button');
+  readonly addToCartButton: Locator = this.page.getByTestId('add-product-button');
 
   async goto(handle: string): Promise<void> {
     await this.page.goto(this.localized(`/products/${handle}`));

```

### Deterministic checks

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

### Validation (same AUT build and environment as the failed run)

| Phase | Passed | Failed | Skipped | Missing | Duration |
|---|---|---|---|---|---|
| failing\-tests | 3 | 0 | 0 | 0 | 33 s |
| related\-specs | 6 | 0 | 0 | 0 | 38 s |

<sub>failing\-tests ran: orders/guest\-checkout.ui.spec.ts:9, storefront/product\-browsing.spec.ts:57, storefront/product\-browsing.spec.ts:85</sub>

<sub>related\-specs ran: tests/orders/guest\-checkout.ui.spec.ts, tests/storefront/product\-browsing.spec.ts</sub>

**Evidence**

- **E1** · repair context for getByTestId\('add\-bag\-button'\): Locator is used for click, the texts 'Add to cart'/'Select variant' and the states toBeEnabled/toBeDisabled. Unscoped page locator.

```text
{"failing_locator":"getByTestId('add-bag-button')","failing_test_id":"add-bag-button","defined_at":"automation/src/pages/product-page.ts:12","source_excerpt":"   1 | import { expect, type Locator } from '@playwright/test';\n   2 | import { BasePage } from './base-page';\n   3 | \n   4 | /** /products/:handle — product detail page. */\n   5 | export class ProductPage extends BasePage {\n   6 |   //
```

- **E2** · trace.zip DOM snapshot of T1, search "button": The T1 DOM has a button with data\-testid add\-product\-button and text 'Add to cart' in product\-container. add\-bag\-button is absent from the page's test ids.

```text
{"snapshot":{"action":"Frame.expect","phase":"after","chosen":"\"after\" snapshot of the last failed action","selector_used":"internal:testid=[data-testid=\"add-bag-button\"s]","action_error":"Expect failed","url":"http://localhost:8000/dk/products/aqa-product-gh39614398147-1-94ce4a41?…"},"query":"button","total_matches":8,"shown":8,"elements":[{"tag":"button","test_id":"nav-menu-button","role":"b
```

- **E3** · check\_locator "add\-product\-button" in T1 snapshot: check\_locator T1: add\-product\-button matches 1 element, button 'Add to cart' \(unique\).

```text
{"candidate":"add-product-button","scope":null,"scope_present":true,"matches_in_scope":1,"matches_on_page":1,"elements":[{"tag":"button","role":"button","text":"Add to cart","attributes":{},"ancestors":["product-container"]}],"verdict":"unique"}
```

- **E4** · check\_locator "add\-product\-button" in T2 snapshot: check\_locator T2: matches 1 element, disabled button 'Select variant' \(unique\). This matches the gating assertion.

```text
{"candidate":"add-product-button","scope":null,"scope_present":true,"matches_in_scope":1,"matches_on_page":1,"elements":[{"tag":"button","role":"button","text":"Select variant","attributes":{"disabled":""},"ancestors":["product-container"]}],"verdict":"unique"}
```

- **E5** · check\_locator "add\-product\-button" in T3 snapshot: check\_locator T3: matches 1 element, button 'Add to cart' \(unique\).

```text
{"candidate":"add-product-button","scope":null,"scope_present":true,"matches_in_scope":1,"matches_on_page":1,"elements":[{"tag":"button","role":"button","text":"Add to cart","attributes":{},"ancestors":["product-container"]}],"verdict":"unique"}
```

- **E6** · changes.diff: Change summary is mostly CI/agent tooling. No sign of a storefront feature removal.

```text
{"range":{"base":"pull request base aabc78490dfcf53b170c6b705ec232824d45f2f3","head":"78b0644224aada9d6d4d16eac77c516ba61ae84b"},"files_changed":55,"files_listed":55,"diff_truncated":false,"hunks_skipped_for_size":57,"hunk_limits":"at most 3 hunks per file, 30 lines per hunk","files":[{"path":".github/workflows/regression.yml","status":"modified","added_lines":132,"removed_lines":1,"hunks":["@@ -2
```


### Originally failing tests

- T1: Guest checkout \(UI\) › guest places an order and the backend records it correctly
- T2: Product browsing › product card opens the detail page with variant selection gating "Add to cart"
- T3: Product browsing › adding a variant to the cart updates the nav count and cart contents

### Review checklist

- [ ] The proposed test id belongs to the element the test intends to use (not just *an* element that makes it pass).
- [ ] The original test id was renamed or removed on purpose in the application; it is not an application regression.
- [ ] The Regression workflow run on this branch (started automatically when this PR was opened) is green.

<sub>Generated by the AgenticQA self-heal agent from [this run](https://github.com/qgintest/AgenticQA/actions/runs/39614398147). The failed regression run stays failed. Never auto-merged.</sub>
