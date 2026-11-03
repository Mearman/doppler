/** Bytes in a tar block: headers and the padding of entry data are multiples of it. */
const TAR_BLOCK_BYTES = 512;

/** Position of a fixed-width text field in a tar header. */
interface TarField {
  readonly offset: number;
  readonly length: number;
}

/** Offsets and lengths of the header fields this reader needs (POSIX ustar and GNU tar agree on them). */
const NAME_FIELD: TarField = { offset: 0, length: 100 };
const SIZE_FIELD: TarField = { offset: 124, length: 12 };
const TYPE_FIELD_OFFSET = 156;
const PREFIX_FIELD: TarField = { offset: 345, length: 155 };

/** A regular file read from a tar stream. */
export interface TarFile {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * Pulls exact byte counts from an async chunk source without holding more than the current chunk and the requested length.
 */
class ChunkReader {
  private readonly iterator: AsyncIterator<Uint8Array>;

  private current: Buffer = Buffer.alloc(0);

  constructor(source: Readonly<AsyncIterable<Uint8Array>>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async refill(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done === true) {
      return false;
    }
    this.current = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);

    return true;
  }

  /**
   * Reads exactly `length` bytes.
   * @returns The bytes, or `undefined` when the stream ended on a boundary before the first byte.
   * @throws When the stream ends part-way through the requested bytes.
   */
  async read(length: number): Promise<Buffer | undefined> {
    const parts: Buffer[] = [];
    let remaining = length;
    while (remaining > 0) {
      if (this.current.length === 0 && !(await this.refill())) {
        if (remaining === length) {
          return undefined;
        }
        throw new Error(`Tar stream ended ${String(remaining)} bytes short of a ${String(length)}-byte read`);
      }
      const taken = this.current.subarray(0, remaining);
      parts.push(taken);
      this.current = this.current.subarray(taken.length);
      remaining -= taken.length;
    }

    return Buffer.concat(parts);
  }

  /** Discards `length` bytes without buffering them. */
  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.current.length === 0 && !(await this.refill())) {
        throw new Error(`Tar stream ended ${String(remaining)} bytes short of a ${String(length)}-byte entry`);
      }
      const taken = Math.min(remaining, this.current.length);
      this.current = this.current.subarray(taken);
      remaining -= taken;
    }
  }
}

function field(header: Readonly<Buffer>, spec: Readonly<TarField>): string {
  const raw = header.subarray(spec.offset, spec.offset + spec.length);
  const end = raw.indexOf(0);

  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/**
 * Reads the regular files of a tar stream one at a time. Entries for which `wanted` is false are skipped without being buffered, which matters for archives that mix small files with very large ones.
 * Entry data is held in memory, so one entry must fit in memory. GNU long names (`L`) are honoured; other extension headers (`K`, pax `x` and `g`) are skipped, and directories, links and devices are ignored.
 * @param source - The tar bytes, for example a file or standard input stream.
 * @param wanted - Chooses by name which entries are read.
 * @returns A generator of each wanted regular file.
 * @throws When the stream ends inside a header or an entry.
 */
export async function* readTarFiles(source: Readonly<AsyncIterable<Uint8Array>>, wanted: (name: string) => boolean): AsyncGenerator<TarFile> {
  const reader = new ChunkReader(source);
  let longName: string | undefined;
  for (;;) {
    const header = await reader.read(TAR_BLOCK_BYTES);
    // The end of an archive is two zero blocks, or just the end of the stream.
    if (header === undefined || header.every((byte) => byte === 0)) {
      return;
    }
    const size = Number.parseInt(field(header, SIZE_FIELD).trim() || '0', 8);
    if (!Number.isFinite(size)) {
      throw new Error('Tar header has a size that is not an octal number');
    }
    const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    const type = String.fromCharCode(header[TYPE_FIELD_OFFSET] ?? 0);

    if (type === 'L') {
      longName = field((await reader.read(size)) ?? Buffer.alloc(0), { offset: 0, length: size });
      await reader.skip(padding);
      continue;
    }
    const prefix = field(header, PREFIX_FIELD);
    const name = longName ?? (prefix === '' ? field(header, NAME_FIELD) : `${prefix}/${field(header, NAME_FIELD)}`);
    longName = undefined;

    const isFile = type === '0' || type === '\0';
    if (isFile && wanted(name)) {
      const data = size === 0 ? Buffer.alloc(0) : await reader.read(size);
      if (data === undefined) {
        throw new Error(`Tar stream ended before the data of ${name}`);
      }
      await reader.skip(padding);
      yield { name, data };
    } else {
      await reader.skip(size + padding);
    }
  }
}
