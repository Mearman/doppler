/** Builders for tar streams used by the reader's tests. */

/** Bytes in a tar block. */
export const BLOCK = 512;

/** Builds one tar entry: a 512-byte ustar header followed by the data padded to a block. */
export function tarEntry(name: string, data: Readonly<Uint8Array>, type = '0'): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name.length > 100 ? name.slice(0, 100) : name, 0, 'utf8');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write(type, 156, 'ascii');
  const padding = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);

  return Buffer.concat([header, Buffer.from(data), padding]);
}

/** Two zero blocks end an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2);

