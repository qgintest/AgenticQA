import fs from 'node:fs';
import path from 'node:path';

export class RepoSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoSandboxError';
  }
}

/** Repository paths the self-heal agent may read (posix, relative to the repo root). */
const READABLE = ['automation/src/', 'automation/tests/'];
/** Paths a repair may edit: page objects and spec files only. */
const EDITABLE = ['automation/src/pages/', 'automation/tests/'];
/** Intentionally broken scenarios (triage/heal evaluation inputs) are never repaired. */
const NEVER_EDIT = ['automation/tests/diagnostics/'];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 500;

/** Normalize a repo-relative path; rejects absolute paths, traversal and odd characters. */
export function normalizeRepoPath(p: string): string {
  if (typeof p !== 'string' || !p || p.length > 300 || p.includes('\0')) throw new RepoSandboxError('invalid path');
  const posix = p.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) throw new RepoSandboxError('absolute paths are not allowed');
  const parts = posix.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) throw new RepoSandboxError('path traversal is not allowed');
  if (!/^[\w./@-]+$/.test(posix)) throw new RepoSandboxError('unsupported characters in path');
  return posix;
}

export function isEditablePath(rel: string): boolean {
  let p: string;
  try {
    p = normalizeRepoPath(rel);
  } catch {
    return false;
  }
  return p.endsWith('.ts') && EDITABLE.some((e) => p.startsWith(e)) && !NEVER_EDIT.some((n) => p.startsWith(n));
}

/**
 * Read-only access to the test sources of the repository under test. Everything read is untrusted
 * input (it is repository content the agent must not take instructions from).
 */
export class RepoSandbox {
  private readonly root: string;
  private bytesRead = 0;

  constructor(
    root: string,
    private readonly charge: (bytes: number) => void = () => {},
  ) {
    if (!fs.existsSync(root)) throw new RepoSandboxError(`repository root not found: ${root}`);
    this.root = fs.realpathSync(root);
  }

  get totalBytesRead(): number {
    return this.bytesRead;
  }

  isReadable(rel: string): boolean {
    try {
      const p = normalizeRepoPath(rel);
      return p.endsWith('.ts') && READABLE.some((r) => p.startsWith(r));
    } catch {
      return false;
    }
  }

  private abs(rel: string): string {
    const p = normalizeRepoPath(rel);
    if (!this.isReadable(p)) throw new RepoSandboxError(`not readable by self-heal: ${p} (allowed: ${READABLE.join(', ')} *.ts)`);
    const full = path.join(this.root, ...p.split('/'));
    if (!fs.existsSync(full)) throw new RepoSandboxError(`file not found: ${p}`);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new RepoSandboxError('symlinks are not followed');
    if (!st.isFile()) throw new RepoSandboxError('not a regular file');
    const real = fs.realpathSync(full);
    const relReal = path.relative(this.root, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new RepoSandboxError('path resolves outside the repository');
    return real;
  }

  read(rel: string): string {
    const file = this.abs(rel);
    const size = fs.statSync(file).size;
    if (size > MAX_FILE_BYTES) throw new RepoSandboxError(`file too large (${size} bytes)`);
    this.charge(size);
    this.bytesRead += size;
    return fs.readFileSync(file, 'utf8');
  }

  /** All readable .ts files (posix, repo-relative), sorted. Directory symlinks are not followed. */
  list(): string[] {
    const out: string[] = [];
    const walk = (dirRel: string) => {
      const dir = path.join(this.root, ...dirRel.split('/'));
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_FILES) return;
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const rel = `${dirRel}${e.name}`;
        if (e.isDirectory()) walk(`${rel}/`);
        else if (e.isFile() && rel.endsWith('.ts')) out.push(rel);
      }
    };
    for (const r of READABLE) walk(r);
    return out.sort();
  }
}
