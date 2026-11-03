import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readTarFiles, type TarFile } from './tar-stream';
import { BLOCK, TAR_END, tarEntry } from './test-support/tar';

/** Bytes of the large entry that the reader must skip without buffering: several blocks, not a multiple of one. */
const BIG_ENTRY_BYTES = 3000;

/** Fill byte of the large entry. */
const BIG_ENTRY_FILL = 7;

/** Fill byte of the block-sized entry: the ASCII code of "a". */
const BLOCK_ENTRY_FILL = 0x61;

/** A chunk size above the whole archive, so the stream arrives in one chunk. */
const WHOLE_ARCHIVE_CHUNK_BYTES = 65536;

/** A chunk size that is not a divisor of the block size, so entries straddle chunks. */
const ODD_CHUNK_BYTES = 333;

/** A chunk size for streams that need no particular alignment. */
const TYPICAL_CHUNK_BYTES = 4096;

/** A chunk size that splits the long-name entry and its header across chunks. */
const LONG_NAME_CHUNK_BYTES = 700;

/** Characters in the long name: more than the 100 that fit in a ustar name field. */
const LONG_NAME_CHARACTERS = 120;

/** Bytes of the entry that remain when the truncation test cuts the archive part-way through the second entry's data. */
const TRUNCATED_DATA_BYTES = 100;

function chunked(bytes: Readonly<Buffer>, size: number): AsyncIterable<Uint8Array> {
  const chunks = Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => bytes.subarray(index * size, (index + 1) * size));

  return Readable.from(chunks, { objectMode: false });
}

async function collect(source: Readonly<AsyncIterable<Uint8Array>>, wanted: (name: string) => boolean): Promise<TarFile[]> {
  const files: TarFile[] = [];
  for await (const file of readTarFiles(source, wanted)) {
    files.push(file);
  }

  return files;
}

describe('readTarFiles', () => {
  const archive = Buffer.concat([
    tarEntry('./', Buffer.alloc(0), '5'),
    tarEntry('./heatmap/big.bin', Buffer.alloc(BIG_ENTRY_BYTES, BIG_ENTRY_FILL)),
    tarEntry('./traces/ab/trace_full_abc123.json', Buffer.from('{"a":1}')),
    tarEntry('./traces/cd/trace_full_cd0001.json', Buffer.alloc(BLOCK, BLOCK_ENTRY_FILL)),
    TAR_END,
  ]);

  it('yields only wanted regular files with their data', async () => {
    const files = await collect(chunked(archive, WHOLE_ARCHIVE_CHUNK_BYTES), (name) => name.includes('trace_full'));

    expect(files.map((file) => file.name)).toEqual(['./traces/ab/trace_full_abc123.json', './traces/cd/trace_full_cd0001.json']);
    expect(files[0]?.data.toString()).toBe('{"a":1}');
    expect(files[1]?.data).toHaveLength(BLOCK);
  });

  it('reads the same files however the stream is chunked, including one byte at a time', async () => {
    const whole = await collect(chunked(archive, WHOLE_ARCHIVE_CHUNK_BYTES), (name) => name.includes('trace_full'));
    const bytewise = await collect(chunked(archive, 1), (name) => name.includes('trace_full'));
    const oddChunks = await collect(chunked(archive, ODD_CHUNK_BYTES), (name) => name.includes('trace_full'));

    expect(bytewise).toEqual(whole);
    expect(oddChunks).toEqual(whole);
  });

  it('honours a GNU long name entry for the file that follows', async () => {
    const longName = `./traces/ab/${'x'.repeat(LONG_NAME_CHARACTERS)}.json`;
    const withLong = Buffer.concat([tarEntry('././@LongLink', Buffer.from(`${longName}\0`), 'L'), tarEntry('truncated', Buffer.from('data')), TAR_END]);
    const files = await collect(chunked(withLong, LONG_NAME_CHUNK_BYTES), () => true);

    expect(files.map((file) => file.name)).toEqual([longName]);
  });

  it('reads to the end of a stream that has no end-of-archive blocks', async () => {
    const files = await collect(chunked(archive.subarray(0, archive.length - BLOCK * 2), TYPICAL_CHUNK_BYTES), (name) => name.includes('abc123'));

    expect(files).toHaveLength(1);
  });

  it('fails loudly when the stream ends inside an entry', async () => {
    const truncated = archive.subarray(0, BLOCK * 2 + TRUNCATED_DATA_BYTES);

    await expect(collect(chunked(truncated, TYPICAL_CHUNK_BYTES), () => true)).rejects.toThrow('short');
  });

  it('fails before yielding a file whose block padding is cut short', async () => {
    const unpadded = tarEntry('./a.json', Buffer.from('{}')).subarray(0, BLOCK + 2);
    const files: TarFile[] = [];

    await expect(
      (async () => {
        for await (const file of readTarFiles(chunked(unpadded, TYPICAL_CHUNK_BYTES), () => true)) {
          files.push(file);
        }
      })(),
    ).rejects.toThrow('short');
    expect(files).toEqual([]);
  });
});
