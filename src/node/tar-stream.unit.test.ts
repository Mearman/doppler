import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readTarFiles, type TarFile } from './tar-stream';
import { BLOCK, TAR_END, tarEntry } from './test-support/tar';

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
    tarEntry('./heatmap/big.bin', Buffer.alloc(3000, 7)),
    tarEntry('./traces/ab/trace_full_abc123.json', Buffer.from('{"a":1}')),
    tarEntry('./traces/cd/trace_full_cd0001.json', Buffer.alloc(BLOCK, 0x61)),
    TAR_END,
  ]);

  it('yields only wanted regular files with their data', async () => {
    const files = await collect(chunked(archive, 1 << 16), (name) => name.includes('trace_full'));

    expect(files.map((file) => file.name)).toEqual(['./traces/ab/trace_full_abc123.json', './traces/cd/trace_full_cd0001.json']);
    expect(files[0]?.data.toString()).toBe('{"a":1}');
    expect(files[1]?.data).toHaveLength(BLOCK);
  });

  it('reads the same files however the stream is chunked, including one byte at a time', async () => {
    const whole = await collect(chunked(archive, 1 << 16), (name) => name.includes('trace_full'));
    const bytewise = await collect(chunked(archive, 1), (name) => name.includes('trace_full'));
    const oddChunks = await collect(chunked(archive, 333), (name) => name.includes('trace_full'));

    expect(bytewise).toEqual(whole);
    expect(oddChunks).toEqual(whole);
  });

  it('honours a GNU long name entry for the file that follows', async () => {
    const longName = `./traces/ab/${'x'.repeat(120)}.json`;
    const withLong = Buffer.concat([tarEntry('././@LongLink', Buffer.from(`${longName}\0`), 'L'), tarEntry('truncated', Buffer.from('data')), TAR_END]);
    const files = await collect(chunked(withLong, 700), () => true);

    expect(files.map((file) => file.name)).toEqual([longName]);
  });

  it('reads to the end of a stream that has no end-of-archive blocks', async () => {
    const files = await collect(chunked(archive.subarray(0, archive.length - BLOCK * 2), 4096), (name) => name.includes('abc123'));

    expect(files).toHaveLength(1);
  });

  it('fails loudly when the stream ends inside an entry', async () => {
    const truncated = archive.subarray(0, BLOCK * 2 + 100);

    await expect(collect(chunked(truncated, 4096), () => true)).rejects.toThrow('short');
  });
});
