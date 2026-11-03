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

/** Tar writes sizes as octal text. */
const OCTAL_RADIX = 8;

/** A regular file read from a tar stream. */
export interface TarFile {
  readonly name: string;
  readonly data: Buffer;
}

/** What a tar parser is waiting for. A `skip` carries the file whose data just completed, which is released once its block padding has been consumed. */
type State =
  | { readonly kind: 'header' }
  | { readonly kind: 'longName'; readonly padding: number }
  | { readonly kind: 'data'; readonly name: string; readonly padding: number }
  | { readonly kind: 'skip'; readonly file?: TarFile };

/** Words for the parser state in a truncation error. */
const STATE_LABELS: Readonly<Record<State['kind'], string>> = { header: 'header', longName: 'long name', data: 'entry', skip: 'entry' };

/**
 * A push-driven tar parser: it is fed chunks as they arrive and holds only the bytes of the current header or entry plus the unconsumed remainder of the current chunk.
 * It is a synchronous state machine, so the only suspension point of a reader is the `for await` over the source.
 */
class TarParser {
  private state: State = { kind: 'header' };

  /** Bytes still needed to finish the current state. */
  private need = TAR_BLOCK_BYTES;

  /** Bytes the current state asked for in total, for the truncation error. */
  private total = TAR_BLOCK_BYTES;

  /** Collected bytes of the current header, long name or file; skipped bytes are not kept. */
  private collected: Buffer[] = [];

  private longName: string | undefined;

  private ended = false;

  constructor(private readonly wanted: (name: string) => boolean) {}

  /** True once an end-of-archive block has been read: later bytes are ignored. */
  get isEnded(): boolean {
    return this.ended;
  }

  private begin(state: State, length: number): void {
    this.state = state;
    this.need = length;
    this.total = length;
    this.collected = [];
  }

  /**
   * Feeds one chunk of the stream.
   * @param chunk - The next bytes of the tar stream.
   * @returns The files completed by these bytes.
   * @throws When a header has a size that is not an octal number.
   */
  *push(chunk: Readonly<Buffer>): Generator<TarFile> {
    let rest = chunk;
    while (!this.ended) {
      if (this.need === 0) {
        yield* this.complete();
        continue;
      }
      if (rest.length === 0) {
        return;
      }
      const taken = rest.subarray(0, this.need);
      if (this.state.kind !== 'skip') {
        this.collected.push(taken);
      }
      this.need -= taken.length;
      rest = rest.subarray(taken.length);
    }
  }

  /**
   * Checks that the stream ended on an entry boundary.
   * @throws When the stream ended inside a header, a long name or an entry.
   */
  finish(): void {
    const onBoundary = this.state.kind === 'header' && this.need === this.total;
    if (!this.ended && !onBoundary) {
      throw new Error(`Tar stream ended ${String(this.need)} bytes short of a ${String(this.total)}-byte ${STATE_LABELS[this.state.kind]}`);
    }
  }

  private *complete(): Generator<TarFile> {
    const state = this.state;
    const bytes = Buffer.concat(this.collected);
    switch (state.kind) {
      case 'header':
        this.readHeader(bytes);
        break;
      case 'longName':
        this.longName = field(bytes, { offset: 0, length: bytes.length });
        this.begin({ kind: 'skip' }, state.padding);
        break;
      case 'data':
        this.begin({ kind: 'skip', file: { name: state.name, data: bytes } }, state.padding);
        break;
      case 'skip':
        this.begin({ kind: 'header' }, TAR_BLOCK_BYTES);
        if (state.file !== undefined) {
          yield state.file;
        }
        break;
    }
  }

  private readHeader(header: Readonly<Buffer>): void {
    // The end of an archive is two zero blocks, or just the end of the stream.
    if (header.every((byte) => byte === 0)) {
      this.ended = true;

      return;
    }
    const size = Number.parseInt(field(header, SIZE_FIELD).trim() || '0', OCTAL_RADIX);
    if (!Number.isFinite(size)) {
      throw new Error('Tar header has a size that is not an octal number');
    }
    const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    const type = String.fromCharCode(header[TYPE_FIELD_OFFSET] ?? 0);

    if (type === 'L') {
      this.begin({ kind: 'longName', padding }, size);

      return;
    }
    const prefix = field(header, PREFIX_FIELD);
    const name = this.longName ?? (prefix === '' ? field(header, NAME_FIELD) : `${prefix}/${field(header, NAME_FIELD)}`);
    this.longName = undefined;

    const isFile = type === '0' || type === '\0';
    if (isFile && this.wanted(name)) {
      this.begin({ kind: 'data', name, padding }, size);
    } else {
      this.begin({ kind: 'skip' }, size + padding);
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
  const parser = new TarParser(wanted);
  for await (const chunk of source) {
    yield* parser.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (parser.isEnded) {
      return;
    }
  }
  parser.finish();
}
