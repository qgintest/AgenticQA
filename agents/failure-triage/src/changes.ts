/**
 * Parses reports/changes.diff, which the CI workflow writes before triage (the agent never runs
 * git). Expected layout, all of it untrusted:
 *
 *   # base: <ref> <sha>            metadata lines ("# key: value")
 *   # head: <sha>
 *   # files:                       then `git diff --name-status` lines, each prefixed with "# "
 *   # M\tautomation/src/pages/product-page.ts
 *   diff --git a/... b/...         then the unified diff (possibly cut by the workflow's size cap)
 *
 * The name-status list keeps the file list complete even when the diff body was truncated.
 */

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: string[];
  hunksOmitted: number;
}

export interface ChangeSummary {
  meta: Record<string, string>;
  files: ChangedFile[];
}

export const CHANGE_LIMITS = {
  maxFiles: 200,
  maxHunksPerFile: 3,
  maxLinesPerHunk: 30,
  maxLineChars: 200,
  maxMetaChars: 200,
};

const STATUS_NAMES: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed' };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function parseChanges(text: string): ChangeSummary {
  const meta: Record<string, string> = {};
  const files = new Map<string, ChangedFile>();
  const fileFor = (p: string, status = 'modified'): ChangedFile => {
    let f = files.get(p);
    if (!f && files.size < CHANGE_LIMITS.maxFiles) {
      f = { path: p, status, additions: 0, deletions: 0, binary: false, hunks: [], hunksOmitted: 0 };
      files.set(p, f);
    }
    return f ?? { path: p, status, additions: 0, deletions: 0, binary: false, hunks: [], hunksOmitted: 0 };
  };

  let inFiles = false;
  let current: ChangedFile | null = null;
  let hunk: string[] | null = null;
  let hunkLines = 0;
  /** Past the first "@@" of the current file: "+++"/"---" lines are content, not file headers. */
  let inBody = false;
  const closeHunk = () => {
    if (current && hunk) {
      if (hunkLines > CHANGE_LIMITS.maxLinesPerHunk) hunk.push(`… ${hunkLines - CHANGE_LIMITS.maxLinesPerHunk} more lines`);
      current.hunks.push(hunk.join('\n'));
    }
    hunk = null;
    hunkLines = 0;
  };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!current && line.startsWith('# ')) {
      const body = line.slice(2);
      if (inFiles) {
        const m = /^([AMDRCT])\d*\t([^\t]+)(?:\t(.+))?$/.exec(body);
        if (m) fileFor(m[3] ?? m[2]!, STATUS_NAMES[m[1]!]);
        continue;
      }
      const kv = /^([a-z_]+):\s*(.*)$/i.exec(body);
      if (kv) {
        if (kv[1]!.toLowerCase() === 'files') inFiles = true;
        else meta[kv[1]!.toLowerCase()] = clip(kv[2]!, CHANGE_LIMITS.maxMetaChars);
      }
      continue;
    }
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      closeHunk();
      current = fileFor(header[2]!);
      inBody = false;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'deleted';
    else if (line.startsWith('rename from')) current.status = 'renamed';
    else if (line.startsWith('Binary files')) current.binary = true;
    else if (line.startsWith('@@')) {
      closeHunk();
      inBody = true;
      if (current.hunks.length >= CHANGE_LIMITS.maxHunksPerFile) current.hunksOmitted++;
      else hunk = [clip(line, CHANGE_LIMITS.maxLineChars)];
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      // Before the first hunk these are file headers; inside one they are content starting with "++" / "--".
      if (inBody) countAndKeep(line);
    } else if (inBody && /^[ +\-\\]/.test(line)) countAndKeep(line);
  }
  closeHunk();
  return { meta, files: [...files.values()] };

  function countAndKeep(line: string): void {
    if (!current) return;
    if (line.startsWith('+')) current.additions++;
    else if (line.startsWith('-')) current.deletions++;
    if (!hunk) return;
    hunkLines++;
    if (hunkLines <= CHANGE_LIMITS.maxLinesPerHunk) hunk.push(clip(line, CHANGE_LIMITS.maxLineChars));
  }
}
