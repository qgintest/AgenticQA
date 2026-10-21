import { isEditablePath, type RepoSandbox } from './repo';

/**
 * Deterministic locator analysis for self-heal: which test-id locator failed, where it is defined,
 * how the code uses it, and which specs exercise it. Only `getByTestId(...)` locators are repairable.
 */

export interface LocatorStep {
  method: string;
  arg: string;
}

export interface FailingLocator {
  /** The locator chain as Playwright printed it, e.g. getByTestId('a').getByTestId('b'). */
  chain: string;
  steps: LocatorStep[];
  /** Value of the final getByTestId step (the element that was not found). */
  testId: string;
}

const STEP = /\.?(getByTestId|getByRole|getByText|getByLabel|getByPlaceholder|getByTitle|getByAltText|locator|first|last|nth|filter)\(((?:[^()]|\([^()]*\))*)\)/g;
const QUOTED = /^\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*$/;

/** Quoted string literal → value (no interpolation, no escapes beyond \' \" \`). */
export function literalValue(arg: string): string | null {
  const m = QUOTED.exec(arg);
  if (!m) return null;
  if (m[1] === '`' && m[2]!.includes('${')) return null;
  return m[2]!.replace(/\\(['"`\\])/g, '$1');
}

/**
 * Pull the failing locator out of a Playwright error message. Supports the two shapes Playwright
 * prints: "waiting for <locator>" (actions and expects) and "Locator: <locator>" (expect failures).
 */
export function extractFailingLocator(errorText: string): FailingLocator | null {
  const candidates: string[] = [];
  for (const re of [/waiting for ((?:getBy\w+|locator)\([^\n]*)/g, /Locator: ((?:getBy\w+|locator)\([^\n]*)/g]) {
    for (const m of errorText.matchAll(re)) candidates.push(m[1]!.trim());
  }
  for (const chain of candidates) {
    const steps: LocatorStep[] = [];
    let consumed = '';
    for (const m of chain.matchAll(STEP)) {
      steps.push({ method: m[1]!, arg: m[2]! });
      consumed += m[0];
    }
    const locatorSteps = steps.filter((s) => !['first', 'last', 'nth', 'filter'].includes(s.method));
    const last = locatorSteps[locatorSteps.length - 1];
    if (!last || last.method !== 'getByTestId') continue;
    const testId = literalValue(last.arg);
    if (!testId) continue;
    return { chain: consumed.replace(/^\./, ''), steps, testId };
  }
  return null;
}

export function isStrictModeViolation(errorText: string): boolean {
  return /strict mode violation/i.test(errorText);
}

export function isLocatorNotFound(errorText: string): boolean {
  return /element\(s\) not found/i.test(errorText) || /(locator\.\w+|page\.\w+): Timeout \d+ms exceeded[\s\S]{0,400}waiting for (getBy\w+|locator)\(/.test(errorText);
}

export interface SourceLocation {
  file: string;
  /** 1-based line number. */
  line: number;
  /** 0-based column of "getByTestId(". */
  column: number;
  lineText: string;
  quote: string;
  /** Expression before ".getByTestId", e.g. "this.page" or "this.container". */
  receiver: string;
  /** Page-object property declared on this line, e.g. "addToCartButton". */
  property: string | null;
  editable: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findTestIdInSource(repo: RepoSandbox, testId: string): SourceLocation[] {
  const re = new RegExp(`getByTestId\\(\\s*(['"\`])${escapeRe(testId)}\\1\\s*\\)`, 'g');
  const out: SourceLocation[] = [];
  for (const file of repo.list()) {
    const lines = repo.read(file).split('\n');
    lines.forEach((lineText, i) => {
      for (const m of lineText.matchAll(re)) {
        const before = lineText.slice(0, m.index);
        const receiver = /([\w$.]+)\.\s*$/.exec(before)?.[1] ?? '';
        out.push({
          file,
          line: i + 1,
          column: m.index!,
          lineText,
          quote: m[1]!,
          receiver,
          property: /readonly\s+(\w+)\s*(?::\s*Locator)?\s*=/.exec(lineText)?.[1] ?? null,
          editable: isEditablePath(file),
        });
      }
    });
  }
  return out;
}

/** For `this.container.getByTestId(...)`: the test id of `container` declared in the same file. */
export function scopeTestIdFor(repo: RepoSandbox, loc: SourceLocation): string | null {
  const m = /^this\.(\w+)$/.exec(loc.receiver);
  if (!m || m[1] === 'page') return null;
  const decl = new RegExp(`readonly\\s+${m[1]}\\s*(?::\\s*Locator)?\\s*=\\s*[\\w$.]*getByTestId\\(\\s*(['"\`])([^'"\`]+)\\1\\s*\\)`);
  return decl.exec(repo.read(loc.file))?.[2] ?? null;
}

export interface LocatorUsage {
  /** Page-object methods whose body references the property. */
  methods: string[];
  actions: string[];
  /** String literals the code asserts the element has (toHaveText / toContainText). */
  expectedTexts: string[];
  /** State assertions (toBeDisabled, toBeEnabled, toBeVisible, ...). */
  states: string[];
  /** Specs (repo-relative) that exercise the property or one of those methods. */
  relatedSpecs: string[];
}

const ACTIONS = ['click', 'dblclick', 'fill', 'check', 'uncheck', 'hover', 'press', 'selectOption', 'setInputFiles', 'type'];

export function usageOf(repo: RepoSandbox, loc: SourceLocation): LocatorUsage {
  const usage: LocatorUsage = { methods: [], actions: [], expectedTexts: [], states: [], relatedSpecs: [] };
  if (!loc.property) return usage;
  const prop = loc.property;
  const source = repo.read(loc.file);

  // Methods in the page object that reference this.<prop> (simple brace matching on method bodies).
  const methodRe = /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm;
  for (const m of source.matchAll(methodRe)) {
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(m[1]!)) continue;
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    if (new RegExp(`this\\.${prop}\\b`).test(source.slice(m.index!, end))) usage.methods.push(m[1]!);
  }

  const idents = [prop, ...usage.methods];
  const refRe = new RegExp(`\\.(${idents.map(escapeRe).join('|')})\\b`);
  const propExpr = `(?:this|[\\w$]+)\\.${escapeRe(prop)}`;
  const texts = new Set<string>();
  const states = new Set<string>();
  const actions = new Set<string>();
  for (const file of repo.list()) {
    if (file.startsWith('automation/tests/diagnostics/')) continue;
    const text = file === loc.file ? source : repo.read(file);
    if (file !== loc.file && !refRe.test(text)) continue;
    if (file.endsWith('.spec.ts') && file !== loc.file) usage.relatedSpecs.push(file);
    for (const m of text.matchAll(new RegExp(`expect\\(\\s*${propExpr}\\s*\\)\\.(?:not\\.)?(toHaveText|toContainText)\\(\\s*(['"\`])((?:(?!\\2).)*)\\2`, 'g'))) texts.add(m[3]!);
    for (const m of text.matchAll(new RegExp(`expect\\(\\s*${propExpr}\\s*\\)\\.(?:not\\.)?(toBe\\w+|toHaveAttribute|toHaveValue)\\b`, 'g'))) states.add(m[1]!);
    for (const m of text.matchAll(new RegExp(`${propExpr}\\.(${ACTIONS.join('|')})\\(`, 'g'))) actions.add(m[1]!);
  }
  usage.expectedTexts = [...texts];
  usage.states = [...states];
  usage.actions = [...actions];
  usage.relatedSpecs.sort();
  return usage;
}

/** Replace exactly the test-id literal at `loc`; throws unless the line contains it exactly once. */
export function replaceTestId(loc: SourceLocation, oldId: string, newId: string): string {
  const needle = `getByTestId(${loc.quote}${oldId}${loc.quote})`;
  const first = loc.lineText.indexOf(needle);
  if (first < 0 || loc.lineText.indexOf(needle, first + 1) >= 0) throw new Error('locator must appear exactly once on the line');
  return loc.lineText.slice(0, first) + `getByTestId(${loc.quote}${newId}${loc.quote})` + loc.lineText.slice(first + needle.length);
}

/** True when `after` differs from `before` only inside a getByTestId string literal. */
export function onlyTestIdLiteralChanged(before: string, after: string): boolean {
  const re = /getByTestId\(\s*(['"`])[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\1\s*\)/g;
  const mask = (s: string) => s.replace(re, 'getByTestId(<id>)');
  return before !== after && mask(before) === mask(after) && (before.match(re)?.length ?? 0) === (after.match(re)?.length ?? 0);
}

export const TEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
