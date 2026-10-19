import { sanitizeUrl } from './trace';
import { ZipReader } from './zip';

/**
 * Read-only view of the DOM snapshots Playwright records in trace.zip (`frame-snapshot` events).
 * Snapshots are serialized as JSON node arrays and are only walked as data: nothing is parsed as
 * HTML, rendered or executed.
 *
 * Node format (Playwright snapshotter): a text node is a string; an element is
 * `[tagName, attributes?, ...children]`; `[[snapshotsAgo, nodeIndex]]` re-uses node `nodeIndex`
 * (post-order) of an earlier snapshot of the same frame, which is how unchanged subtrees are stored.
 */

export interface DomElement {
  tag: string;
  test_id: string | null;
  role: string | null;
  text: string;
  /** Nearest ancestor data-testid, to locate the element on the page. */
  within: string | null;
  attributes: Record<string, string>;
}

export interface DomSnapshotRef {
  callId: string;
  phase: string;
  /** The traced action this snapshot belongs to, e.g. "Frame.click". */
  action: string;
  selector: string | null;
  error: string | null;
  url: string;
  /** Why this snapshot was chosen. */
  chosen: string;
}

export interface DomIndex {
  snapshot: DomSnapshotRef;
  elements: DomElement[];
  /** parents[i]: index in `elements` of element i's parent element, or -1. */
  parents: number[];
  nodesScanned: number;
  nodeCapHit: boolean;
}

export const DOM_LIMITS = {
  /** Element and text nodes expanded from one snapshot (back-references can repeat subtrees). */
  maxNodes: 60_000,
  maxDepth: 200,
  maxTextChars: 100,
  maxAttrChars: 120,
  maxMatches: 25,
  maxTestIds: 80,
};

/** Attributes worth showing for locator work. Values are capped; `value` only for button-like inputs. */
const KEY_ATTRIBUTES = ['id', 'name', 'type', 'href', 'aria-label', 'aria-labelledby', 'placeholder', 'title', 'alt', 'for', 'disabled', 'aria-disabled', 'aria-expanded', 'aria-selected', 'aria-checked', 'data-active', 'data-state'];
const VALUE_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
const SKIP_CONTENT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: 'button',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  FORM: 'form',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  IMG: 'img',
  UL: 'list',
  OL: 'list',
  LI: 'listitem',
  TABLE: 'table',
  DIALOG: 'dialog',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
};
const INPUT_ROLES: Record<string, string> = { button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', search: 'searchbox' };

type Json = Record<string, unknown>;
type Node = unknown;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isElement = (n: Node): n is [string, ...unknown[]] => Array.isArray(n) && typeof n[0] === 'string';
const isRef = (n: Node): n is [[number, number]] => Array.isArray(n) && Array.isArray(n[0]);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

interface FrameSnapshot {
  callId: string;
  phase: string;
  frameId: string;
  isMainFrame: boolean;
  url: string;
  html: Node;
  timestamp: number;
  _nodes?: Node[];
}

interface Call {
  method: string;
  selector: string | null;
  error: string | null;
  endTime: number;
}

function* jsonLines(text: string): Generator<Json> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v: unknown = JSON.parse(line);
      if (isObj(v)) yield v;
    } catch {
      /* skip malformed lines */
    }
  }
}

/** Post-order node list of one snapshot, as Playwright indexes it for back-references. */
function postOrder(s: FrameSnapshot): Node[] {
  if (s._nodes) return s._nodes;
  const nodes: Node[] = [];
  const visit = (n: Node, depth: number) => {
    if (typeof n === 'string') nodes.push(n);
    else if (isElement(n) && depth < DOM_LIMITS.maxDepth) {
      for (let i = 2; i < n.length; i++) visit(n[i], depth + 1);
      nodes.push(n);
    }
  };
  visit(s.html, 0);
  s._nodes = nodes;
  return nodes;
}

function roleOf(tag: string, attrs: Json): string | null {
  if (typeof attrs.role === 'string' && attrs.role) return attrs.role.split(/\s+/)[0]!;
  if (tag === 'A') return typeof attrs.href === 'string' ? 'link' : null;
  if (tag === 'INPUT') return INPUT_ROLES[String(attrs.type ?? 'text').toLowerCase()] ?? 'textbox';
  return IMPLICIT_ROLES[tag] ?? null;
}

function keyAttributes(tag: string, attrs: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEY_ATTRIBUTES) {
    const v = attrs[name];
    if (typeof v !== 'string') continue;
    out[name] = clip(name === 'href' ? sanitizeUrl(v) : v, DOM_LIMITS.maxAttrChars);
  }
  if (tag === 'INPUT' && VALUE_INPUT_TYPES.has(String(attrs.type ?? '').toLowerCase()) && typeof attrs.value === 'string') {
    out.value = clip(attrs.value, DOM_LIMITS.maxAttrChars);
  }
  return out;
}

/** Expands one snapshot (resolving back-references) into a flat element list. */
function expand(frames: FrameSnapshot[], index: number): { elements: DomElement[]; parents: number[]; nodesScanned: number; capHit: boolean } {
  const elements: DomElement[] = [];
  const parents: number[] = [];
  let scanned = 0;
  let capHit = false;

  // Returns the (capped) text content of the subtree so parents can show their accessible text.
  const visit = (n: Node, snapIdx: number, depth: number, within: string | null, skip: boolean, parent: number): string => {
    if (scanned >= DOM_LIMITS.maxNodes || depth > DOM_LIMITS.maxDepth) {
      capHit = true;
      return '';
    }
    scanned++;
    if (typeof n === 'string') return skip ? '' : n;
    if (isRef(n)) {
      const [ago, nodeIdx] = n[0];
      const refIdx = snapIdx - ago;
      if (!Number.isInteger(ago) || ago < 0 || refIdx < 0 || refIdx > snapIdx) return '';
      const nodes = postOrder(frames[refIdx]!);
      // A reference to itself (ago 0) would loop; Playwright never emits one.
      if (ago === 0 || !Number.isInteger(nodeIdx) || nodeIdx < 0 || nodeIdx >= nodes.length) return '';
      return visit(nodes[nodeIdx], refIdx, depth, within, skip, parent);
    }
    if (!isElement(n)) return '';
    const tag = n[0].toUpperCase();
    const attrs = isObj(n[1]) ? n[1] : {};
    const testId = typeof attrs['data-testid'] === 'string' ? attrs['data-testid'] : null;
    const skipChildren = skip || SKIP_CONTENT.has(tag);
    let text = '';
    const slot = elements.length;
    if (!skipChildren) {
      elements.push(null as unknown as DomElement); // keep document order: parent before children
      parents.push(parent);
    }
    for (let i = 2; i < n.length; i++) {
      const t = visit(n[i], snapIdx, depth + 1, testId ?? within, skipChildren, skipChildren ? parent : slot);
      if (text.length < DOM_LIMITS.maxTextChars * 2) text += ` ${t}`;
    }
    text = collapse(text).slice(0, DOM_LIMITS.maxTextChars * 2);
    if (!skipChildren) {
      const label = typeof attrs['aria-label'] === 'string' ? attrs['aria-label'] : '';
      elements[slot] = {
        tag: tag.toLowerCase(),
        test_id: testId ? clip(testId, DOM_LIMITS.maxAttrChars) : null,
        role: roleOf(tag, attrs),
        text: clip(collapse(label) || text, DOM_LIMITS.maxTextChars),
        within: within ? clip(within, DOM_LIMITS.maxAttrChars) : null,
        attributes: keyAttributes(tag, attrs),
      };
    }
    return text;
  };

  visit(frames[index]!.html, index, 0, null, false, -1);
  return { elements, parents, nodesScanned: scanned, capHit };
}

/**
 * Picks the main-frame snapshot nearest the failure: "after" of the last failed action, else its
 * "before", else the last snapshot recorded. Returns null when the trace has no DOM snapshots.
 */
export function readDomSnapshot(zipBuf: Buffer, maxEntryBytes: number, charge: (bytes: number) => void): DomIndex | null {
  const zip = new ZipReader(zipBuf);
  const byFrame = new Map<string, FrameSnapshot[]>();
  const all: FrameSnapshot[] = [];
  const calls = new Map<string, Call>();

  // test.trace holds runner steps only; DOM snapshots live in the numbered context traces.
  for (const entry of zip.find((n) => n.endsWith('.trace') && n !== 'test.trace')) {
    const buf = zip.read(entry, maxEntryBytes);
    charge(buf.length);
    for (const ev of jsonLines(buf.toString('utf8'))) {
      if (ev.type === 'before' && typeof ev.callId === 'string') {
        const params = isObj(ev.params) ? ev.params : {};
        calls.set(ev.callId, {
          method: `${String(ev.class ?? '')}.${String(ev.method ?? '')}`,
          selector: typeof params.selector === 'string' ? params.selector : null,
          error: null,
          endTime: -1,
        });
      } else if (ev.type === 'after' && typeof ev.callId === 'string') {
        const c = calls.get(ev.callId);
        if (!c) continue;
        const err = isObj(ev.error) ? (isObj(ev.error.error) ? ev.error.error : ev.error) : null;
        if (err) c.error = String(err.message ?? 'error').split('\n')[0]!.slice(0, 300);
        c.endTime = typeof ev.endTime === 'number' ? ev.endTime : 0;
      } else if (ev.type === 'frame-snapshot' && isObj(ev.snapshot)) {
        const s = ev.snapshot;
        if (typeof s.frameId !== 'string' || typeof s.callId !== 'string') continue;
        const snap: FrameSnapshot = {
          callId: s.callId,
          phase: typeof s.phase === 'string' ? s.phase : '',
          frameId: s.frameId,
          isMainFrame: s.isMainFrame !== false,
          url: typeof s.frameUrl === 'string' ? sanitizeUrl(s.frameUrl) : '',
          html: s.html,
          timestamp: typeof s.timestamp === 'number' ? s.timestamp : 0,
        };
        // Back-references index into earlier snapshots of the same frame, in recording order.
        const list = byFrame.get(snap.frameId) ?? [];
        list.push(snap);
        byFrame.set(snap.frameId, list);
        all.push(snap);
      }
    }
  }
  const main = all.filter((s) => s.isMainFrame);
  if (!main.length) return null;

  const failed = [...calls.entries()].filter(([, c]) => c.error).sort((a, b) => a[1].endTime - b[1].endTime);
  let chosen: FrameSnapshot | undefined;
  let why = 'last snapshot in the trace (no failed action had a DOM snapshot)';
  for (const [callId] of failed.reverse()) {
    const forCall = main.filter((s) => s.callId === callId).reverse();
    chosen = forCall.find((s) => s.phase === 'after') ?? forCall.find((s) => s.phase === 'before') ?? forCall[0];
    if (chosen) {
      why = `"${chosen.phase || 'unknown'}" snapshot of the last failed action`;
      break;
    }
  }
  chosen ??= main[main.length - 1]!;

  const frames = byFrame.get(chosen.frameId)!;
  const { elements, parents, nodesScanned, capHit } = expand(frames, frames.indexOf(chosen));
  const call = calls.get(chosen.callId);
  return {
    snapshot: {
      callId: chosen.callId,
      phase: chosen.phase,
      action: call?.method ?? 'unknown',
      selector: call?.selector ? clip(call.selector, 300) : null,
      error: call?.error ?? null,
      url: chosen.url,
      chosen: why,
    },
    elements,
    parents,
    nodesScanned,
    nodeCapHit: capHit,
  };
}

/** Case-insensitive plain-substring match over tag, test id, role, text and key attribute values. */
export function queryDom(index: DomIndex, query: string): { total: number; matches: DomElement[]; testIds: string[]; testIdsTotal: number } {
  const needle = query.toLowerCase();
  // Rank: matched by test id / attribute / role / tag first, then text matches on identifiable
  // elements, then other text matches; last, ancestors that match only because a descendant's text does.
  const ids = new Set<string>();
  const rank = new Map<number, number>();
  index.elements.forEach((el, i) => {
    if (el.test_id) ids.add(el.test_id);
    const direct = [el.tag, el.test_id ?? '', el.role ?? '', ...Object.values(el.attributes)].join('\n').toLowerCase().includes(needle);
    if (direct) rank.set(i, 0);
    else if (el.text.toLowerCase().includes(needle)) rank.set(i, el.test_id || el.role ? 1 : 2);
  });
  for (const i of [...rank.keys()]) {
    for (let p = index.parents[i]!; p >= 0; p = index.parents[p]!) if ((rank.get(p) ?? 0) > 0) rank.set(p, 3);
  }
  const ranked = [...rank.entries()].map(([i, r]) => [r, index.elements[i]!] as const).sort((a, b) => a[0] - b[0]);
  const matches = ranked.slice(0, DOM_LIMITS.maxMatches).map(([, el]) => el);
  return { total: ranked.length, matches, testIds: [...ids].slice(0, DOM_LIMITS.maxTestIds), testIdsTotal: ids.size };
}
