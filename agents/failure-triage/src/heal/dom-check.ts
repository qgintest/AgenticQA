import type { DomElement, DomIndex } from '../dom';

export interface CandidateMatch {
  tag: string;
  role: string | null;
  text: string;
  attributes: Record<string, string>;
  /** Test ids of the nearest ancestors (closest first). */
  ancestors: string[];
}

export interface CandidateCheck {
  candidate: string;
  scope: string | null;
  /** Elements with this test id anywhere on the page. */
  totalOnPage: number;
  /** Elements with this test id inside the scope (equal to totalOnPage when unscoped). */
  inScope: CandidateMatch[];
  /** Whether the scope container itself is on the page. */
  scopePresent: boolean;
}

function ancestorTestIds(index: DomIndex, i: number, max = 6): string[] {
  const out: string[] = [];
  for (let p = index.parents[i] ?? -1; p >= 0 && out.length < max; p = index.parents[p] ?? -1) {
    const id = index.elements[p]?.test_id;
    if (id) out.push(id);
  }
  return out;
}

function toMatch(index: DomIndex, i: number, el: DomElement): CandidateMatch {
  return { tag: el.tag, role: el.role, text: el.text, attributes: el.attributes, ancestors: ancestorTestIds(index, i, 50) };
}

/** Evaluate `scope?.getByTestId(candidate)` against a DOM snapshot, deterministically. */
export function checkTestIdCandidate(index: DomIndex, candidate: string, scope: string | null): CandidateCheck {
  const all: CandidateMatch[] = [];
  index.elements.forEach((el, i) => {
    if (el.test_id === candidate) all.push(toMatch(index, i, el));
  });
  const inScope = scope ? all.filter((m) => m.ancestors.includes(scope)) : all;
  return {
    candidate,
    scope,
    totalOnPage: all.length,
    inScope: inScope.map((m) => ({ ...m, ancestors: m.ancestors.slice(0, 6) })),
    scopePresent: scope ? index.elements.some((e) => e.test_id === scope) : true,
  };
}

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'option', 'label']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider']);
const FILLABLE = new Set(['input', 'textarea', 'select']);

/** Whether an element can plausibly receive the actions the code performs on it. */
export function compatibleWithActions(m: CandidateMatch, actions: string[]): { ok: boolean; reason: string } {
  if (actions.length === 0) return { ok: true, reason: 'no actions performed on the locator' };
  const fills = actions.some((a) => ['fill', 'type', 'selectOption', 'setInputFiles', 'check', 'uncheck'].includes(a));
  if (fills && !FILLABLE.has(m.tag) && m.role !== 'textbox' && m.role !== 'checkbox' && m.role !== 'combobox') {
    return { ok: false, reason: `code calls ${actions.join(', ')} but <${m.tag}> (role ${m.role ?? 'none'}) is not an input` };
  }
  const interactive = INTERACTIVE_TAGS.has(m.tag) || (m.role !== null && INTERACTIVE_ROLES.has(m.role));
  if (!interactive) return { ok: false, reason: `code calls ${actions.join(', ')} but <${m.tag}> (role ${m.role ?? 'none'}) is not interactive` };
  return { ok: true, reason: `<${m.tag}> (role ${m.role ?? 'none'}) supports ${actions.join(', ')}` };
}

/** Whether the element's text agrees with at least one text the code asserts it has. */
export function compatibleWithTexts(m: CandidateMatch, expectedTexts: string[]): { ok: boolean; reason: string } {
  if (expectedTexts.length === 0) return { ok: true, reason: 'no text assertions on the locator' };
  const t = m.text.toLowerCase();
  const hit = expectedTexts.find((e) => t.includes(e.toLowerCase()));
  return hit
    ? { ok: true, reason: `element text "${m.text}" matches asserted text "${hit}"` }
    : { ok: false, reason: `element text "${m.text}" matches none of the asserted texts (${expectedTexts.map((e) => `"${e}"`).join(', ')})` };
}
