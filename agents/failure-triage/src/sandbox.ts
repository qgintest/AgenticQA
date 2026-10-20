import fs from 'node:fs';
import path from 'node:path';
import type { Limits } from './config';

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

const ALLOWED_EXTENSIONS = new Set(['.json', '.md', '.txt', '.log', '.xml', '.png', '.jpg', '.jpeg', '.zip', '.diff']);

/**
 * The only way tools touch the filesystem. Read-only by construction (no write API), confined to
 * the artifact roots (after resolving symlinks), restricted to diagnostic file types, and metered
 * against per-file and per-run byte budgets.
 */
export class ArtifactSandbox {
  private readonly roots: string[];
  private bytesRead = 0;

  constructor(
    roots: string[],
    private readonly limits: Pick<Limits, 'maxFileBytes' | 'maxTotalReadBytes'> & Partial<Pick<Limits, 'maxTraceBytes'>>,
    private readonly testResultsDir?: string,
  ) {
    this.roots = roots.filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
  }

  get totalBytesRead(): number {
    return this.bytesRead;
  }

  /**
   * Resolve a path that came from an artifact (e.g. an attachment path in results.json, which is
   * absolute on the machine that ran the tests). Paths outside the roots are re-anchored on the
   * `test-results/` segment so a downloaded artifact still works; anything else is rejected.
   */
  resolve(candidate: string): string {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
      throw new SandboxError('invalid path');
    }
    let target = path.resolve(candidate);
    if (!this.isInsideRoots(target) && this.testResultsDir) {
      const parts = candidate.split(/[\\/]+/);
      const idx = parts.lastIndexOf('test-results');
      if (idx >= 0 && idx < parts.length - 1) target = path.resolve(this.testResultsDir, ...parts.slice(idx + 1));
    }
    if (!this.isInsideRoots(target)) throw new SandboxError('path is outside the artifact roots');

    const base = path.basename(target).toLowerCase();
    if (base === '.env' || base.startsWith('.env.') || base.endsWith('.env')) throw new SandboxError('env files are not readable');
    if (!ALLOWED_EXTENSIONS.has(path.extname(base))) throw new SandboxError(`file type not allowed: ${path.extname(base) || '(none)'}`);
    if (!fs.existsSync(target)) throw new SandboxError('file not found');

    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new SandboxError('symlinks are not followed');
    if (!stat.isFile()) throw new SandboxError('not a regular file');
    // Canonicalize to catch symlinked parent directories.
    const real = fs.realpathSync(target);
    if (!this.isInsideRoots(real)) throw new SandboxError('path resolves outside the artifact roots');
    return real;
  }

  exists(candidate: string): boolean {
    try {
      this.resolve(candidate);
      return true;
    } catch {
      return false;
    }
  }

  readBytes(candidate: string, maxBytes = this.limits.maxFileBytes): Buffer {
    const file = this.resolve(candidate);
    const size = fs.statSync(file).size;
    const cap = Math.min(maxBytes, this.limits.maxFileBytes);
    if (size > cap) throw new SandboxError(`file too large (${size} bytes > ${cap})`);
    this.charge(size);
    return fs.readFileSync(file);
  }

  /**
   * Trace archives are routinely larger than other artifacts (DOM snapshots, screencast frames), so
   * they get their own cap. Only .zip files; decompression is still metered by the zip-entry cap.
   */
  readTrace(candidate: string): Buffer {
    const file = this.resolve(candidate);
    if (path.extname(file).toLowerCase() !== '.zip') throw new SandboxError('traces must be .zip files');
    const size = fs.statSync(file).size;
    const cap = this.limits.maxTraceBytes ?? this.limits.maxFileBytes;
    if (size > cap) throw new SandboxError(`trace too large (${size} bytes > ${cap})`);
    this.charge(size);
    return fs.readFileSync(file);
  }

  /** Reads text, keeping only the last `maxBytes` of large files (the end of a log is what matters). */
  readTextTail(candidate: string, maxBytes = this.limits.maxFileBytes): { text: string; truncated: boolean; size: number } {
    const file = this.resolve(candidate);
    const size = fs.statSync(file).size;
    const take = Math.min(size, maxBytes, this.limits.maxFileBytes);
    this.charge(take);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, size - take);
      return { text: buf.toString('utf8'), truncated: take < size, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Reads text, keeping only the first `maxBytes` of large files (a diff is read from the top). */
  readTextHead(candidate: string, maxBytes = this.limits.maxFileBytes): { text: string; truncated: boolean; size: number } {
    const file = this.resolve(candidate);
    const size = fs.statSync(file).size;
    const take = Math.min(size, maxBytes, this.limits.maxFileBytes);
    this.charge(take);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, 0);
      return { text: buf.toString('utf8'), truncated: take < size, size };
    } finally {
      fs.closeSync(fd);
    }
  }

  readText(candidate: string, maxBytes?: number): string {
    return this.readBytes(candidate, maxBytes).toString('utf8');
  }

  /** Account for bytes produced by decompression as well as raw reads. */
  charge(bytes: number): void {
    if (this.bytesRead + bytes > this.limits.maxTotalReadBytes) {
      throw new SandboxError('run-wide read budget exhausted');
    }
    this.bytesRead += bytes;
  }

  private isInsideRoots(target: string): boolean {
    return this.roots.some((root) => {
      const rel = path.relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }
}
