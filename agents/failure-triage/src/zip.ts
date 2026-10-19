import zlib from 'node:zlib';

/**
 * Minimal read-only ZIP reader for Playwright trace archives (stored + deflate entries).
 * Avoids a dependency; enforces an uncompressed-size cap so a crafted archive cannot exhaust memory.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export class ZipReader {
  readonly entries: ZipEntry[];

  constructor(private readonly buf: Buffer) {
    this.entries = this.readCentralDirectory();
  }

  private readCentralDirectory(): ZipEntry[] {
    const buf = this.buf;
    const minEocd = 22;
    if (buf.length < minEocd) throw new ZipError('not a zip archive');
    let eocd = -1;
    for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - minEocd - 0xffff); i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('end of central directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new ZipError('zip64 archives are not supported');

    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError('corrupt central directory');
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const uncompressedSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const localHeaderOffset = buf.readUInt32LE(p + 42);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  find(predicate: (name: string) => boolean): ZipEntry[] {
    return this.entries.filter((e) => predicate(e.name));
  }

  read(entry: ZipEntry, maxUncompressed: number): Buffer {
    if (entry.uncompressedSize > maxUncompressed) {
      throw new ZipError(`entry ${entry.name} too large (${entry.uncompressedSize} > ${maxUncompressed})`);
    }
    const buf = this.buf;
    const p = entry.localHeaderOffset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) throw new ZipError('corrupt local header');
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipError('entry extends past end of archive');
    const data = buf.subarray(start, end);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) {
      try {
        // maxOutputLength guards against entries that lie about their uncompressed size.
        return zlib.inflateRawSync(data, { maxOutputLength: maxUncompressed });
      } catch (e) {
        throw new ZipError(`cannot inflate ${entry.name}: ${(e as Error).message}`);
      }
    }
    throw new ZipError(`unsupported compression method ${entry.method}`);
  }
}
