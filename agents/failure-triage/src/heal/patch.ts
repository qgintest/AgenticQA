import { onlyTestIdLiteralChanged } from './locators';
import type { RepairEdit } from './proposal';
import { isEditablePath } from './repo';

/**
 * Independent check of a repair patch (run again by the PR job, which trusts nothing from the
 * validation job except this file): exactly one editable file, exactly one changed line, and the
 * change is confined to a getByTestId string literal — matching the recorded edit when given.
 */
export function verifyRepairPatch(patch: string, edit?: RepairEdit | null): string[] {
  const errors: string[] = [];
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const headers = lines.filter((l) => l.startsWith('diff --git '));
  if (headers.length !== 1) errors.push(`patch must touch exactly one file (found ${headers.length})`);
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(headers[0] ?? '');
  if (!m) errors.push('unrecognised diff header');
  else {
    if (m[1] !== m[2]) errors.push('renames are not allowed');
    if (!isEditablePath(m[1]!)) errors.push(`file is not editable by self-heal: ${m[1]}`);
    if (edit && m[1] !== edit.file) errors.push(`patch file ${m[1]} does not match the proposal (${edit.file})`);
  }
  if (lines.some((l) => /^(new file mode|deleted file mode|rename from|rename to|similarity index|old mode|new mode|Binary files|GIT binary patch)/.test(l))) {
    errors.push('file mode changes, renames, creations, deletions and binary changes are not allowed');
  }
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  if (removed.length !== 1 || added.length !== 1) errors.push(`patch must change exactly one line (removed ${removed.length}, added ${added.length})`);
  else {
    if (!onlyTestIdLiteralChanged(removed[0]!, added[0]!)) errors.push('the change is not confined to a getByTestId string literal');
    if (edit && (removed[0] !== edit.before || added[0] !== edit.after)) errors.push('patch content does not match the validated edit');
  }
  return errors;
}
