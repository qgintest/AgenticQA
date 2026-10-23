#!/usr/bin/env bash
# Local demo of the self-heal pipeline, without an API key and without cost.
#
# On a throwaway branch it breaks the shared add-to-cart locator in the ProductPage page object
# (add-product-button -> add-bag-button), commits that, runs the regression suite (3 tests fail),
# then runs triage + self-heal with deterministic stand-ins for the model, including the real
# worktree validation against your running app. Afterwards it ALWAYS switches back to your branch
# and deletes the throwaway branch. Results stay in automation/reports/heal-dry-run/.
#
# Requirements: the app is running (see README Quick start), and tracked files have no
# uncommitted changes (untracked files are fine).
# Usage (from the repo root, in Git Bash on Windows):  sh scripts/demo-self-heal.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
FILE=automation/src/pages/product-page.ts
GOOD="getByTestId('add-product-button')"
BROKEN="getByTestId('add-bag-button')"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked files have uncommitted changes. Commit or stash them first (the demo switches branches)." >&2
  exit 1
fi
if ! grep -qF "$GOOD" "$FILE"; then
  echo "$FILE does not contain $GOOD; nothing to break." >&2
  exit 1
fi
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 http://localhost:8000/dk || true)" != "200" ]; then
  echo "The storefront is not reachable at http://localhost:8000. Start the app first (README Quick start)." >&2
  exit 1
fi

ORIG=$(git rev-parse --abbrev-ref HEAD)
BRANCH="demo/self-heal-$(date +%s)"
cleanup() {
  git checkout -q -f "$ORIG"
  git branch -q -D "$BRANCH" 2>/dev/null || true
  echo "Back on $ORIG; throwaway branch $BRANCH deleted."
}
trap cleanup EXIT

echo "== 1/4 Breaking the locator on throwaway branch $BRANCH"
git switch -q -c "$BRANCH"
sed -i "s/$GOOD/$BROKEN/" "$FILE"
grep -qF "$BROKEN" "$FILE"
git -c user.name="AgenticQA demo" -c user.email="demo@example.invalid" commit -q -am "demo: break the add-to-cart locator"

echo "== 2/4 Running the regression suite (3 failures expected)"
(cd automation && { [ -d node_modules ] || npm ci; } && npx playwright test) || true

echo "== 3/4 Triage + self-heal with deterministic stand-ins (no API calls)"
(cd agents/failure-triage && { [ -d node_modules ] || npm ci; } && npm run --silent heal:dry-run)

echo "== 4/4 Result"
node -e "
const r = require('./automation/reports/heal-dry-run/heal-result.json');
console.log('status: ' + r.status + ' - ' + r.reason);
if (r.edit) console.log('repair: ' + r.edit.oldLocator + '  ->  ' + r.edit.newLocator + '  (' + r.edit.file + ':' + r.edit.line + ')');
console.log('details: automation/reports/heal-dry-run/ (heal-summary.md, pr-body.md, repair.patch)');
"
